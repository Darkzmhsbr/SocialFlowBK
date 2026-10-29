// Publish orchestration. This is the top-level "publish one post" function
// the worker calls. It handles:
//   - decrypting the account token
//   - dispatching to the right container flow based on post.type
//   - persisting status transitions (PUBLISHING -> PUBLISHED / FAILED / retry)
//   - deciding whether an error is worth retrying
//
// Rodada 2a: worker now supports ALL post types (FEED_IMAGE, FEED_VIDEO,
// REEL, FEED_CAROUSEL, STORY).
//
// Rodada 2b: FEED_VIDEO and REEL now forward the post's custom cover URL
// (post.coverMediaAsset.url) to Meta as cover_url. When absent — either
// the user didn't pick one, or the cover MediaAsset was deleted (SetNull
// on the FK) — we send no cover_url and Meta picks a frame automatically.
//
// Not implemented (out of scope, tracked in roadmap):
//   - Rodada 3:  post-publish metrics fetch (Insights API)
//   - Rodada 4:  visual Story editor (canvas + text/stickers baked in)
//
// Rodada 4 (multi-profile batch): before publishing, every Backblaze media
// of the post (including the cover) is copied server-side to a temporary
// key, so each Instagram account fetches the file from a DIFFERENT URL.
// The temp copies are deleted right after the publish attempt (success or
// failure) — Meta already downloaded the file when the container reached
// FINISHED. If a copy fails, that media falls back to its original URL and
// the publish goes on. Toggle with UNIQUE_MEDIA_URL_PER_ACCOUNT.
//
// Rodada 5 (Meta limits + account health):
//   - Before publishing, the account's daily publish quota is checked
//     (content_publishing_limit, cached ~15 min per account).
//   - Rate limit / daily limit / action block -> the ACCOUNT is paused
//     (publishPausedUntil) and the post goes back to SCHEDULED without
//     spending a retry. It resumes automatically after the pause.
//   - Account restricted/disabled/token invalid -> account marked ERROR /
//     TOKEN_EXPIRED, post goes back to SCHEDULED and waits for reconnect.
//   Both cases create a notification (accountHealthService).

const instagramMediaService = require('./instagramMediaService');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const scheduledPostRepository = require('../../database/scheduledPostRepository');
const { decryptToken } = require('../../utils/crypto');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');
// Rodada 4: temp copies for per-account unique URLs.
const b2Client = require('../../integrations/backblaze/b2Client');
// Rodada 5: Meta limits / account problems.
const accountHealthService = require('./accountHealthService');

// Backoff schedule for retries. Index = retryCount BEFORE the retry.
// So a post that just failed for the first time (retryCount was 0, becomes
// 1) gets rescheduled 60s out. Subsequent failures back off further.
const RETRY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

/**
 * Publish a single post. Assumes the post has already been claimed
 * (status is QUEUED) - the worker takes care of that upstream.
 *
 * Never throws - all outcomes are persisted in the DB. Returns the final
 * post shape so the worker can log a summary line.
 */
async function publishPost(post) {
  logger.info('Publishing post', {
    postId: post.id,
    type: post.type,
    accountId: post.instagramAccountId,
    retryCount: post.retryCount,
  });

  // Rodada 4: temp object keys created for this attempt, removed in finally.
  const tempKeys = [];

  try {
    if (!post.instagramAccount) {
      throw new AppError(
        ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND,
        'Conta do Instagram vinculada ao post não existe mais.',
        404
      );
    }
    if (post.instagramAccount.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCodes.INSTAGRAM_AUTH_FAILED,
        `Conta @${post.instagramAccount.username} não está ativa (status: ${post.instagramAccount.status}).`,
        409
      );
    }

    await scheduledPostRepository.markPublishing(post.id);

    const accessToken = decryptToken(post.instagramAccount.accessTokenEncrypted);
    // Rodada 5: stop BEFORE Meta rejects the publish for the daily quota.
    await assertPublishingQuota(post, accessToken);
    // Rodada 4: same post, but media/cover URLs swapped for temp copies.
    const publishView = await prepareUniqueMediaUrls(post, tempKeys);
    const mediaId = await publishByType(publishView, accessToken);

    const finalPost = await scheduledPostRepository.markPublished(post.id, mediaId);
    // Rodada 5: keep the cached quota in sync without another Meta call.
    notePublishedForQuota(post.instagramAccountId);
    logger.info('Post published', {
      postId: post.id,
      instagramMediaId: mediaId,
    });
    return finalPost;
  } catch (error) {
    return handlePublishFailure(post, error);
  } finally {
    // Rodada 4: fire-and-forget — never delays or breaks the publish result.
    cleanupTempMedia(tempKeys, post.id);
  }
}

/**
 * Route to the right flow based on post type. Every branch ends by
 * calling publishMediaContainer with the creationId that came out of
 * ensureXContainerReady.
 */
async function publishByType(post, accessToken) {
  const igUserId = post.instagramAccount.instagramUserId;
  const caption = post.caption || '';

  switch (post.type) {
    case 'FEED_IMAGE':
      return publishFeedImage(post, igUserId, caption, accessToken);

    case 'FEED_VIDEO':
      return publishFeedVideo(post, igUserId, caption, accessToken);

    case 'REEL':
      return publishReel(post, igUserId, caption, accessToken);

    case 'STORY':
      return publishStory(post, igUserId, accessToken);

    case 'FEED_CAROUSEL':
      return publishCarousel(post, igUserId, caption, accessToken);

    default:
      throw new AppError(
        ErrorCodes.INVALID_POST_TYPE,
        `Tipo de post desconhecido: ${post.type}.`,
        400
      );
  }
}

async function publishFeedImage(post, igUserId, caption, accessToken) {
  const media = post.medias?.[0]?.mediaAsset;
  if (!media || media.type !== 'IMAGE') {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      'Post FEED_IMAGE precisa de exatamente uma mídia do tipo IMAGE.',
      400
    );
  }

  const { creationId } = await instagramMediaService.ensureImageContainerReady({
    igUserId,
    imageUrl: media.url,
    caption,
    accessToken,
  });

  const { mediaId } = await instagramApiClient.publishMediaContainer(
    igUserId,
    creationId,
    accessToken
  );

  return mediaId;
}

async function publishFeedVideo(post, igUserId, caption, accessToken) {
  const media = post.medias?.[0]?.mediaAsset;
  if (!media || media.type !== 'VIDEO') {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      'Post FEED_VIDEO precisa de exatamente uma mídia do tipo VIDEO.',
      400
    );
  }

  // Rodada 2b: coverMediaAsset may be null (user didn't pick one, or the
  // cover MediaAsset was deleted after being assigned — schema.prisma uses
  // onDelete: SetNull on that FK). Either way, undefined coverUrl means
  // "let Meta pick a frame".
  const coverUrl = post.coverMediaAsset?.url || undefined;

  const { creationId } = await instagramMediaService.ensureVideoContainerReady({
    igUserId,
    videoUrl: media.url,
    caption,
    accessToken,
    coverUrl,
  });

  const { mediaId } = await instagramApiClient.publishMediaContainer(
    igUserId,
    creationId,
    accessToken
  );

  return mediaId;
}

async function publishReel(post, igUserId, caption, accessToken) {
  const media = post.medias?.[0]?.mediaAsset;
  if (!media || media.type !== 'VIDEO') {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      'REEL precisa de exatamente uma mídia do tipo VIDEO.',
      400
    );
  }

  const coverUrl = post.coverMediaAsset?.url || undefined;

  const { creationId } = await instagramMediaService.ensureReelContainerReady({
    igUserId,
    videoUrl: media.url,
    caption,
    accessToken,
    coverUrl,
    // shareToFeed defaults to true inside the helper — Instagram's own
    // default when posting a Reel from the app. Rodada 2b or later can
    // expose this as a per-post option in the composer.
  });

  const { mediaId } = await instagramApiClient.publishMediaContainer(
    igUserId,
    creationId,
    accessToken
  );

  return mediaId;
}

async function publishStory(post, igUserId, accessToken) {
  const media = post.medias?.[0]?.mediaAsset;
  if (!media) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      'STORY precisa de exatamente uma mídia (imagem ou vídeo).',
      400
    );
  }

  // Note: caption intentionally NOT forwarded — see instagramMediaService
  // for the reasoning (Instagram Stories don't render captions the way
  // feed posts do, and users expect text-on-image, which is Rodada 4).
  const { creationId } = await instagramMediaService.ensureStoryContainerReady({
    igUserId,
    mediaAsset: media,
    accessToken,
  });

  const { mediaId } = await instagramApiClient.publishMediaContainer(
    igUserId,
    creationId,
    accessToken
  );

  return mediaId;
}

async function publishCarousel(post, igUserId, caption, accessToken) {
  const mediaAssets = (post.medias || [])
    .map((pm) => pm.mediaAsset)
    .filter(Boolean);

  if (mediaAssets.length < 2 || mediaAssets.length > 10) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      `FEED_CAROUSEL precisa de 2 a 10 mídias. Recebido: ${mediaAssets.length}.`,
      400
    );
  }

  // Each media must be IMAGE or VIDEO — validated by the composer already,
  // but the worker re-validates because posts can sit in the queue for
  // hours and we don't want a container call to fail cryptically on Meta.
  for (const asset of mediaAssets) {
    if (asset.type !== 'IMAGE' && asset.type !== 'VIDEO') {
      throw new AppError(
        ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
        `FEED_CAROUSEL não aceita mídia do tipo ${asset.type}.`,
        400
      );
    }
  }

  const { creationId } = await instagramMediaService.ensureCarouselContainerReady({
    igUserId,
    mediaAssets,
    caption,
    accessToken,
  });

  const { mediaId } = await instagramApiClient.publishMediaContainer(
    igUserId,
    creationId,
    accessToken
  );

  return mediaId;
}

/**
 * Decide whether to retry or give up. A failure is retryable when:
 *   - it wasn't a definitive Meta rejection (INSTAGRAM_MEDIA_ERROR is final)
 *   - it wasn't a configuration/auth problem the user must fix
 *   - the post hasn't exceeded worker.maxRetries yet
 *
 * Otherwise we mark it FAILED and stop.
 */
async function handlePublishFailure(post, error) {
  const isAppError = error instanceof AppError;
  const code = isAppError ? error.code : 'INTERNAL_ERROR';
  const message = error.message || 'Falha desconhecida ao publicar.';

  logger.error('Post publish failed', {
    postId: post.id,
    code,
    message,
    retryCount: post.retryCount,
    stack: error.stack,
  });

  // Rodada 5: Meta limits and account problems are about the ACCOUNT, not
  // this post. Pause/flag the account and put the post back in the queue
  // without spending a retry — it resumes on its own.
  const accountOutcome = await accountHealthService
    .handleAccountError(post.instagramAccountId, error, { context: 'publish' })
    .catch((err) => {
      logger.warn('handleAccountError failed (falling back to normal retry rules)', {
        postId: post.id,
        error: err.message,
      });
      return { handled: false };
    });
  if (accountOutcome.handled) {
    logger.warn('Post deferred because of an account-level problem', {
      postId: post.id,
      accountId: post.instagramAccountId,
      kind: accountOutcome.kind,
      resumeAt: accountOutcome.resumeAt,
    });
    return scheduledPostRepository.deferPost(post.id);
  }

  const nonRetryableCodes = new Set([
    ErrorCodes.INSTAGRAM_MEDIA_ERROR,
    ErrorCodes.INSTAGRAM_AUTH_FAILED,
    ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND,
    ErrorCodes.UNSUPPORTED_POST_TYPE,
    ErrorCodes.INVALID_POST_TYPE,
    ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
    ErrorCodes.TOKEN_EXPIRED,
    ErrorCodes.ACCOUNT_NOT_AUTHORIZED,
    ErrorCodes.INSUFFICIENT_PERMISSIONS,
  ]);

  const isRetryable =
    !nonRetryableCodes.has(code) && post.retryCount < env.worker.maxRetries;

  if (!isRetryable) {
    return scheduledPostRepository.markFailed(post.id, message);
  }

  const delayIndex = Math.min(post.retryCount, RETRY_BACKOFF_MS.length - 1);
  const delayMs = RETRY_BACKOFF_MS[delayIndex];
  const nextTry = new Date(Date.now() + delayMs);

  logger.warn('Post publish will retry', {
    postId: post.id,
    nextTry,
    attemptNumber: post.retryCount + 1,
    maxRetries: env.worker.maxRetries,
  });

  return scheduledPostRepository.rescheduleForRetry(post.id, delayMs, message);
}

// --- Rodada 4: per-account unique media URLs ----------------------------

/**
 * Returns a shallow copy of `post` whose Backblaze media (and cover) point
 * to freshly copied temp objects. Every created key is pushed into
 * `tempKeysOut` so publishPost can clean them up. Legacy CLOUDINARY assets
 * and any failed copy keep their original URL. The DB row is never touched.
 */
async function prepareUniqueMediaUrls(post, tempKeysOut) {
  if (!env.worker.uniqueMediaUrlPerAccount) return post;

  const assets = [
    ...(post.medias || []).map((pm) => pm.mediaAsset),
    post.coverMediaAsset,
  ].filter(Boolean);

  const urlByAssetId = new Map();
  for (const asset of assets) {
    if (urlByAssetId.has(asset.id)) continue;
    if (asset.storageProvider !== 'BACKBLAZE' || !asset.storageKey) continue;
    try {
      const copy = await b2Client.copyToTempKey(asset.storageKey, {
        userId: post.userId,
        tag: String(post.id).slice(0, 8),
      });
      tempKeysOut.push(copy.storageKey);
      urlByAssetId.set(asset.id, copy.url);
    } catch (err) {
      logger.warn('Unique media URL unavailable, using original URL', {
        postId: post.id,
        mediaId: asset.id,
        error: err.message,
      });
    }
  }

  if (urlByAssetId.size === 0) return post;

  const swap = (asset) =>
    asset && urlByAssetId.has(asset.id) ? { ...asset, url: urlByAssetId.get(asset.id) } : asset;

  logger.info('Publishing with unique media URLs', {
    postId: post.id,
    accountId: post.instagramAccountId,
    copies: urlByAssetId.size,
  });

  return {
    ...post,
    medias: (post.medias || []).map((pm) => ({ ...pm, mediaAsset: swap(pm.mediaAsset) })),
    coverMediaAsset: swap(post.coverMediaAsset),
  };
}

function cleanupTempMedia(tempKeys, postId) {
  for (const key of tempKeys) {
    Promise.resolve(b2Client.deleteAsset(key, null)).catch((err) => {
      logger.warn('Temp media cleanup failed', { postId, key, error: err.message });
    });
  }
}

// --- Rodada 5: daily publish quota ----------------------------------------

// accountId -> { remaining, checkedAt }. In-memory on purpose: losing it on
// restart only costs one extra Meta call per account.
const quotaCache = new Map();
const QUOTA_CACHE_MS = 15 * 60 * 1000;

async function assertPublishingQuota(post, accessToken) {
  if (!env.worker.checkPublishingLimit) return;

  const key = post.instagramAccountId;
  const cached = quotaCache.get(key);
  if (cached && Date.now() - cached.checkedAt < QUOTA_CACHE_MS && cached.remaining > 1) return;

  let quota;
  try {
    quota = await instagramApiClient.fetchContentPublishingLimit(
      post.instagramAccount.instagramUserId,
      accessToken
    );
  } catch (err) {
    // Limits / account problems must bubble up (they pause or flag the
    // account). Anything else: the check is best-effort, publish anyway.
    const { kind } = accountHealthService.classifyMetaError(err, { context: 'publish' });
    if (kind !== 'OTHER') throw err;
    logger.warn('Publishing quota check failed, publishing anyway', { postId: post.id, error: err.message });
    return;
  }

  if (quota.quotaUsage === null || quota.quotaTotal === null) return;
  const remaining = quota.quotaTotal - quota.quotaUsage;
  quotaCache.set(key, { remaining, checkedAt: Date.now() });

  if (remaining <= 0) {
    throw new AppError(
      ErrorCodes.INSTAGRAM_PUBLISH_LIMIT_REACHED,
      `Limite diário de publicações do Instagram atingido (${quota.quotaUsage}/${quota.quotaTotal} nas últimas 24h).`,
      429,
      { quotaUsage: quota.quotaUsage, quotaTotal: quota.quotaTotal }
    );
  }
}

function notePublishedForQuota(accountId) {
  const cached = quotaCache.get(accountId);
  if (cached) cached.remaining -= 1;
}

module.exports = { publishPost };