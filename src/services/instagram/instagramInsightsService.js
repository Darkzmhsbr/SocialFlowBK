// Insights service — fetch, cache and normalize Instagram metrics for a
// published post. This is the single entry point the controller calls.
//
// Cache strategy (hybrid on-demand):
//   1. User opens metrics modal → controller calls getInsights(postId, userId)
//   2. Service checks insightsUpdatedAt on the row. If < CACHE_TTL_MS old
//      and ?refresh=true wasn't sent, returns the cached Json immediately.
//   3. Otherwise: decrypts token, calls Meta, normalizes, persists the
//      result on insightsData + insightsUpdatedAt, returns.
//
// This avoids hammering Meta on repeated modal opens while keeping the
// data fresh enough to be useful (1h TTL). F5 is free. Force-refresh is
// available via ?refresh=true for when the user just published and wants
// to see initial numbers (though they'll often still be 0 for ~30 min).

const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const scheduledPostRepository = require('../../database/scheduledPostRepository');
const { decryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Metrics requested from Meta, keyed by ScheduledPost.type. Instagram
// exposes different sets per media type. Notable:
//   - `impressions` deprecated July 2024 — not requested anywhere
//   - `views` only for VIDEO-based types (FEED_VIDEO, REEL)
//   - STORY insights expire 24h after publishing — endpoint returns
//     empty data after that, which we handle gracefully
//   - FEED_CAROUSEL does NOT support `views` even if it contains videos
const METRICS_BY_TYPE = {
  FEED_IMAGE:    ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  FEED_VIDEO:    ['reach', 'likes', 'comments', 'saved', 'shares', 'views', 'total_interactions'],
  REEL:          ['reach', 'likes', 'comments', 'saved', 'shares', 'views', 'total_interactions'],
  FEED_CAROUSEL: ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  STORY:         ['reach', 'replies', 'follows', 'profile_visits'],
};

// All metric names we might return to the frontend, with human labels
// (Portuguese) and display order. Unknown metrics from Meta are ignored.
const METRIC_META = {
  reach:              { label: 'Alcance',         icon: '👁️',  order: 1 },
  views:              { label: 'Visualizações',   icon: '▶️',  order: 2 },
  likes:              { label: 'Curtidas',        icon: '❤️',  order: 3 },
  comments:           { label: 'Comentários',     icon: '💬',  order: 4 },
  saved:              { label: 'Salvos',          icon: '🔖',  order: 5 },
  shares:             { label: 'Compartilhamentos', icon: '🔁', order: 6 },
  total_interactions: { label: 'Interações totais', icon: '📊', order: 7 },
  replies:            { label: 'Respostas',       icon: '↩️',  order: 8 },
  follows:            { label: 'Seguidores novos', icon: '➕', order: 9 },
  profile_visits:     { label: 'Visitas ao perfil', icon: '👤', order: 10 },
};

/**
 * Main entry point. Returns cached insights or fetches fresh from Meta.
 *
 * @param {object} args
 * @param {string} args.postId
 * @param {string} args.userId
 * @param {boolean} [args.forceRefresh=false] - bypass cache TTL
 * @returns {Promise<{ insights: object, cachedAt: string|null, isStale: boolean }>}
 */
async function getInsights({ postId, userId, forceRefresh = false }) {
  const post = await scheduledPostRepository.findById(postId);
  if (!post || post.userId !== userId) {
    throw new AppError(ErrorCodes.POST_NOT_FOUND, 'Post não encontrado.', 404);
  }

  if (post.status !== 'PUBLISHED' || !post.instagramMediaId) {
    throw new AppError(
      ErrorCodes.INSIGHTS_UNAVAILABLE,
      'Métricas só estão disponíveis para posts publicados no Instagram.',
      400
    );
  }

  if (!post.instagramAccount) {
    throw new AppError(
      ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND,
      'Conta Instagram vinculada não encontrada — pode ter sido desconectada.',
      404
    );
  }

  // Cache hit?
  if (!forceRefresh && isCacheFresh(post.insightsUpdatedAt)) {
    logger.info('Insights cache hit', { postId, cachedAt: post.insightsUpdatedAt });
    return {
      insights: toPublicInsights(post.insightsData, post.type),
      cachedAt: post.insightsUpdatedAt?.toISOString() ?? null,
      isStale: false,
    };
  }

  // Cache miss or forced refresh — call Meta.
  const accessToken = decryptToken(post.instagramAccount.accessTokenEncrypted);
  const metrics = METRICS_BY_TYPE[post.type] || METRICS_BY_TYPE.FEED_IMAGE;

  let raw;
  try {
    raw = await instagramApiClient.fetchMediaInsights(
      post.instagramMediaId,
      accessToken,
      metrics
    );
  } catch (err) {
    return handleFetchError(err, post);
  }

  // Check if Meta returned all zeros AND the post was published < 30 min ago.
  // This is normal behavior — Instagram populates metrics with a delay.
  const allZero = Object.values(raw).every((v) => v === 0);
  const ageMs = post.publishedAt ? Date.now() - new Date(post.publishedAt).getTime() : Infinity;
  const isVeryRecent = ageMs < 30 * 60 * 1000;

  // Persist to cache even if all zeros — avoids hammering Meta on rapid
  // reopens of the modal. The TTL ensures we re-fetch later.
  const now = new Date();
  await scheduledPostRepository.saveInsightsCache(postId, raw, now);

  logger.info('Insights fetched from Meta', {
    postId,
    metrics: Object.keys(raw),
    allZero,
    isVeryRecent,
  });

  return {
    insights: toPublicInsights(raw, post.type),
    cachedAt: now.toISOString(),
    isStale: false,
    ...(allZero && isVeryRecent ? { notice: 'INSIGHTS_NOT_YET_READY' } : {}),
  };
}

function isCacheFresh(updatedAt) {
  if (!updatedAt) return false;
  return Date.now() - new Date(updatedAt).getTime() < CACHE_TTL_MS;
}

/**
 * Transforms the flat { reach: 42, likes: 5, ... } into a structured
 * array the frontend renders directly, with labels, icons, and order.
 * Unknown keys (in case Meta adds more in the future) are silently
 * dropped so the UI doesn't render a "undefined" tile.
 */
function toPublicInsights(raw, postType) {
  if (!raw || typeof raw !== 'object') return [];

  const relevant = METRICS_BY_TYPE[postType] || [];

  return relevant
    .map((name) => {
      const meta = METRIC_META[name];
      if (!meta) return null;
      return {
        name,
        label: meta.label,
        icon: meta.icon,
        value: typeof raw[name] === 'number' ? raw[name] : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (METRIC_META[a.name]?.order ?? 99) - (METRIC_META[b.name]?.order ?? 99));
}

/**
 * Translates Meta API errors into user-friendly responses. Certain error
 * codes signal scope issues (user must reconnect), others signal the post
 * was deleted on Instagram, etc.
 *
 * We NEVER let these bubble as 500s — insights being unavailable is an
 * expected state, not a crash.
 */
function handleFetchError(err, post) {
  const metaCode = err.debug?.code;
  const metaSubcode = err.debug?.error_subcode;
  const httpStatus = err.status;

  // OAuthException code 200: permissions issue (scope missing or revoked)
  // This is the most common "expected" failure — user connected before
  // instagram_business_manage_insights was in the scope list.
  if (metaCode === 200 || metaCode === 190 || httpStatus === 403) {
    logger.warn('Insights fetch failed: likely scope missing', {
      postId: post.id,
      metaCode,
      metaSubcode,
    });
    throw new AppError(
      ErrorCodes.INSIGHTS_SCOPE_MISSING,
      'A conta Instagram precisa ser reconectada para habilitar métricas. Vá até a página da conta e clique em "Reconectar".',
      403
    );
  }

  // Media ID not found — post was probably deleted on Instagram
  if (httpStatus === 400 && metaCode === 100) {
    logger.warn('Insights fetch failed: media not found on Instagram', {
      postId: post.id,
      instagramMediaId: post.instagramMediaId,
    });
    throw new AppError(
      ErrorCodes.INSIGHTS_UNAVAILABLE,
      'Este post pode ter sido removido do Instagram — as métricas não estão disponíveis.',
      404
    );
  }

  // Story expired (>24h) — Meta returns empty data, not an error, but
  // if it does error it'll be a generic one. We catch it as UNAVAILABLE.
  if (post.type === 'STORY') {
    logger.warn('Insights fetch failed for Story — may be expired', {
      postId: post.id,
      message: err.message,
    });
    throw new AppError(
      ErrorCodes.INSIGHTS_UNAVAILABLE,
      'Métricas de Stories ficam disponíveis apenas por 24 horas após a publicação.',
      410
    );
  }

  // Anything else: log and re-throw as generic unavailable, never 500.
  logger.error('Insights fetch failed unexpectedly', {
    postId: post.id,
    message: err.message,
    metaCode,
    metaSubcode,
    httpStatus,
  });
  throw new AppError(
    ErrorCodes.INSIGHTS_UNAVAILABLE,
    'Não foi possível carregar as métricas neste momento. Tente novamente mais tarde.',
    502
  );
}

module.exports = { getInsights };