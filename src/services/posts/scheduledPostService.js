// Business logic for scheduled posts. Enforces every rule Instagram itself
// would enforce at publish time - but earlier, so the user gets clear
// feedback in the composer instead of a cryptic Meta error 3 hours later.
//
// This file does NOT talk to Instagram. Publishing lives in Phase 2.2
// (see instagramPublishService.js placeholder). All this file does is
// validate + persist + expose posts in editable states.
//
// Rodada 4: createBatch() turns N media items x M Instagram accounts into
// N*M independent posts sharing a batchId. Each post is a normal row —
// worker, metrics, edit and delete keep working unchanged. Staggering is
// just a different scheduledFor per post, and spintax captions are
// resolved here, so every post already stores its final caption.

const postRepository = require('../../database/scheduledPostRepository');
const mediaRepository = require('../../database/mediaRepository');
const accountRepository = require('../../database/instagramAccountRepository');
const mediaService = require('../media/mediaService');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');
// Rodada 4: batch ids + limits/stagger defaults.
const crypto = require('crypto');
const env = require('../../config/env');

// Which post types accept how many media items, and which media types
// are valid for each. Enforced on both create and update.
//
// Rodada 2b: `allowsCover` marks the types that accept a custom cover
// image via cover_url. Meta accepts cover_url only for FEED_VIDEO and REEL
// containers — carousels and stories ignore it, images don't have the
// concept.
const POST_TYPE_RULES = {
  FEED_IMAGE:    { min: 1, max: 1,  allowed: ['IMAGE'],           allowsCover: false },
  FEED_VIDEO:    { min: 1, max: 1,  allowed: ['VIDEO'],           allowsCover: true  },
  FEED_CAROUSEL: { min: 2, max: 10, allowed: ['IMAGE', 'VIDEO'],  allowsCover: false },
  REEL:          { min: 1, max: 1,  allowed: ['VIDEO'],           allowsCover: true  },
  STORY:         { min: 1, max: 1,  allowed: ['IMAGE', 'VIDEO'],  allowsCover: false },
};

const VALID_TYPES = Object.keys(POST_TYPE_RULES);

// Posts can only be edited by the user in these states. Once queued/publishing/
// published, the API rejects edits (the user can archive and clone instead).
const EDITABLE_STATUSES = new Set(['DRAFT', 'SCHEDULED', 'FAILED']);

// The worker owns these states — deleting mid-publish causes duplicated
// posts on Instagram or dangling PostMedia rows. Everything else is fair
// game to delete (Rodada 1 relaxed this from DRAFT-only).
const UNDELETABLE_STATUSES = new Set(['QUEUED', 'PUBLISHING']);

/**
 * Create a new draft or scheduled post.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.instagramAccountId
 * @param {string} args.type
 * @param {string} [args.caption]
 * @param {Array<string>} args.mediaIds - ordered list of MediaAsset ids
 * @param {string|Date} [args.scheduledFor] - ISO string or Date; omit for DRAFT
 * @param {string|null} [args.coverMediaAssetId] - optional cover for VIDEO/REEL
 * @returns {Promise<ScheduledPost>}
 */
async function createPost({ userId, instagramAccountId, type, caption, mediaIds, scheduledFor, coverMediaAssetId }) {
  assertValidType(type);
  await assertAccountBelongsToUser({ instagramAccountId, userId });

  const orderedMedias = await resolveAndValidateMedias({
    userId,
    type,
    mediaIds,
  });

  const resolvedCoverId = await resolveAndValidateCover({
    userId,
    type,
    coverMediaAssetId,
  });

  const scheduleDate = normalizeScheduledFor(scheduledFor);
  const status = scheduleDate ? 'SCHEDULED' : 'DRAFT';

  const post = await postRepository.create({
    userId,
    instagramAccountId,
    type,
    caption: caption ?? null,
    status,
    scheduledFor: scheduleDate,
    medias: orderedMedias,
    coverMediaAssetId: resolvedCoverId,
  });

  logger.info('Scheduled post created', {
    userId,
    postId: post.id,
    status: post.status,
    type: post.type,
    mediaCount: orderedMedias.length,
    hasCover: Boolean(resolvedCoverId),
    scheduledFor: post.scheduledFor,
  });

  return post;
}

async function listPosts(userId, { status, take = 50, skip = 0 } = {}) {
  if (status && !isValidStatus(status)) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Filtro de status inválido: ${status}.`,
      400
    );
  }
  return postRepository.findAllByUserId(userId, { status, take, skip });
}

async function getPost(id, userId) {
  const post = await postRepository.findById(id);
  if (!post || post.userId !== userId) {
    throw new AppError(ErrorCodes.POST_NOT_FOUND, 'Post não encontrado.', 404);
  }
  return post;
}

/**
 * Update fields on a post that is still editable. Media replacement is
 * all-or-nothing: if `mediaIds` is provided, the entire ordered list is
 * replaced (this matches how carousel editors typically work).
 *
 * Rodada 2b: coverMediaAssetId follows the standard three-state convention:
 *   - undefined: don't touch the current cover
 *   - null:      clear the cover (Meta will pick a frame at publish time)
 *   - string:    validate and set/replace
 * The `type` may change in the same patch — cover validation always uses
 * the post-patch type, so switching REEL -> FEED_IMAGE with a cover set
 * fails cleanly instead of silently keeping a now-invalid cover.
 */
async function updatePost(id, userId, patch) {
  const post = await getPost(id, userId);
  if (!EDITABLE_STATUSES.has(post.status)) {
    throw new AppError(
      ErrorCodes.POST_NOT_EDITABLE,
      `Este post não pode mais ser editado (status: ${post.status}).`,
      409
    );
  }

  const nextType = patch.type ?? post.type;
  if (patch.type) assertValidType(patch.type);

  const patchToApply = {};

  if (patch.caption !== undefined) patchToApply.caption = patch.caption;
  if (patch.type !== undefined) patchToApply.type = patch.type;

  if (patch.mediaIds !== undefined) {
    patchToApply.medias = await resolveAndValidateMedias({
      userId,
      type: nextType,
      mediaIds: patch.mediaIds,
    });
  } else if (patch.type !== undefined) {
    // Type changed but media list didn't - re-validate current media
    // against the new type's rules.
    const currentMediaIds = post.medias.map((m) => m.mediaAssetId);
    await resolveAndValidateMedias({
      userId,
      type: nextType,
      mediaIds: currentMediaIds,
    });
  }

  // Cover handling. If the user is switching to a type that doesn't allow
  // cover and they didn't explicitly touch cover in the patch, we auto-clear
  // — anything else would leave a coverMediaAssetId on a type where it's
  // invalid, and the client would have no way to spot that.
  if (patch.coverMediaAssetId !== undefined) {
    patchToApply.coverMediaAssetId = await resolveAndValidateCover({
      userId,
      type: nextType,
      coverMediaAssetId: patch.coverMediaAssetId,
    });
  } else if (patch.type !== undefined && !POST_TYPE_RULES[nextType].allowsCover && post.coverMediaAssetId) {
    logger.info('Auto-clearing cover on type change', {
      postId: id,
      previousType: post.type,
      newType: nextType,
    });
    patchToApply.coverMediaAssetId = null;
  }

  if (patch.scheduledFor !== undefined) {
    const scheduleDate = normalizeScheduledFor(patch.scheduledFor);
    patchToApply.scheduledFor = scheduleDate;
    patchToApply.status = scheduleDate ? 'SCHEDULED' : 'DRAFT';
  }

  const updated = await postRepository.updateEditable(id, patchToApply);
  logger.info('Scheduled post updated', {
    userId,
    postId: id,
    changedKeys: Object.keys(patchToApply),
  });
  return updated;
}

async function archivePost(id, userId) {
  const post = await getPost(id, userId);
  if (post.status === 'ARCHIVED') return post;
  if (post.status === 'PUBLISHING') {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      'Não é possível arquivar um post em publicação.',
      409
    );
  }
  const archived = await postRepository.updateStatus(id, 'ARCHIVED');
  logger.info('Scheduled post archived', { userId, postId: id });
  return archived;
}

/**
 * Deletes a scheduled post from the DB.
 *
 * IMPORTANT: for PUBLISHED posts this does NOT delete the actual post
 * from Instagram — Meta's API doesn't expose a reliable delete endpoint
 * for content published via the Content Publishing API, and even if it
 * did, the user's mental model of "remove from SocialFlow" ≠ "remove from
 * the world". The frontend confirm must make this explicit.
 *
 * QUEUED and PUBLISHING are refused because the worker is actively
 * touching those rows; deleting mid-flight causes duplicated Instagram
 * posts or orphaned PostMedia.
 *
 * After the post row is gone, we fire-and-forget an orphan check on each
 * MediaAsset it referenced — including the cover, if any — if no other
 * post uses that media, we free Cloudinary storage. Failures there never
 * bubble up (silent by design).
 */
async function deletePost(id, userId) {
  const post = await getPost(id, userId);

  if (UNDELETABLE_STATUSES.has(post.status)) {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      'Não é possível excluir um post que está na fila ou em publicação. Aguarde alguns instantes e tente novamente.',
      409
    );
  }

  // Snapshot the media IDs before deleting the post (deleteById will cascade
  // the PostMedia join rows, and we need those IDs for orphan cleanup after).
  const mediaAssetIds = (post.medias || [])
    .map((pm) => pm.mediaAssetId ?? pm.mediaAsset?.id)
    .filter(Boolean);

  // Rodada 2b: cover is a separate direct FK, not a PostMedia join. It also
  // deserves an orphan check — a user who deletes their only reel deletes
  // the last thing keeping that cover image around.
  if (post.coverMediaAssetId) {
    mediaAssetIds.push(post.coverMediaAssetId);
  }

  await postRepository.deleteById(id);

  logger.info('Scheduled post deleted', {
    userId,
    postId: id,
    previousStatus: post.status,
    mediaAssetCount: mediaAssetIds.length,
  });

  // Fire-and-forget: don't block the HTTP response on Cloudinary cleanup.
  // deleteIfOrphan is silent — internal failures are logged, never thrown.
  // De-dupe via Set: an id can't be both a PostMedia entry and the cover
  // for the same post in practice, but the Set is cheap insurance.
  for (const mediaId of new Set(mediaAssetIds)) {
    mediaService.deleteIfOrphan(mediaId, userId).catch((err) => {
      logger.warn('Orphan media cleanup rejected unexpectedly', {
        mediaId,
        userId,
        error: err.message,
      });
    });
  }

  return { id };
}

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

function assertValidType(type) {
  if (!VALID_TYPES.includes(type)) {
    throw new AppError(
      ErrorCodes.INVALID_POST_TYPE,
      `Tipo de post inválido: ${type}. Válidos: ${VALID_TYPES.join(', ')}.`,
      400
    );
  }
}

function isValidStatus(status) {
  return [
    'DRAFT',
    'SCHEDULED',
    'QUEUED',
    'PUBLISHING',
    'PUBLISHED',
    'FAILED',
    'ARCHIVED',
  ].includes(status);
}

async function assertAccountBelongsToUser({ instagramAccountId, userId }) {
  const account = await accountRepository.findById(instagramAccountId);
  if (!account || account.userId !== userId) {
    throw new AppError(
      ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND,
      'Conta do Instagram não encontrada ou não pertence a este usuário.',
      404
    );
  }
  return account;
}

/**
 * Loads MediaAssets by id, checks ownership, checks the count and types
 * against the post rules, and returns [{ mediaAssetId, order }] ready
 * for the repository.
 */
async function resolveAndValidateMedias({ userId, type, mediaIds }) {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_COUNT,
      'Envie pelo menos uma mídia.',
      400
    );
  }

  const rules = POST_TYPE_RULES[type];
  if (mediaIds.length < rules.min || mediaIds.length > rules.max) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_COUNT,
      `Um post do tipo ${type} aceita entre ${rules.min} e ${rules.max} mídia(s). Recebido: ${mediaIds.length}.`,
      400
    );
  }

  // Reject duplicates in the same post - reordering the same file across
  // slots is almost always a UI bug on the caller side.
  const unique = new Set(mediaIds);
  if (unique.size !== mediaIds.length) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_COUNT,
      'Uma mesma mídia foi enviada mais de uma vez para o mesmo post.',
      400
    );
  }

  const assets = await mediaRepository.findManyByIds(mediaIds);
  if (assets.length !== mediaIds.length) {
    throw new AppError(
      ErrorCodes.MEDIA_NOT_FOUND,
      'Uma ou mais mídias não foram encontradas.',
      404
    );
  }

  for (const asset of assets) {
    if (asset.userId !== userId) {
      throw new AppError(
        ErrorCodes.MEDIA_NOT_FOUND,
        'Uma ou mais mídias não pertencem a este usuário.',
        404
      );
    }
    if (!rules.allowed.includes(asset.type)) {
      throw new AppError(
        ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
        `A mídia ${asset.id} (${asset.type}) não é permitida em um post do tipo ${type}.`,
        400
      );
    }
  }

  // Preserve the client-supplied order (mediaIds order). Return the shape
  // expected by the repository's create/updateEditable.
  return mediaIds.map((mediaAssetId, index) => ({ mediaAssetId, order: index }));
}

/**
 * Rodada 2b: normalize + validate an optional cover media id.
 *
 * Returns:
 *   - null when the input is null/undefined/empty (no cover — Meta picks a
 *     frame at publish time)
 *   - the same id string when it passes all checks
 *
 * Throws AppError when:
 *   - the post type doesn't accept a custom cover (only FEED_VIDEO and REEL do)
 *   - the media id doesn't exist or belongs to a different user
 *   - the media isn't an IMAGE (Meta requires a still image URL for cover_url)
 */
async function resolveAndValidateCover({ userId, type, coverMediaAssetId }) {
  if (coverMediaAssetId === null || coverMediaAssetId === undefined || coverMediaAssetId === '') {
    return null;
  }

  if (!POST_TYPE_RULES[type]?.allowsCover) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      `Posts do tipo ${type} não aceitam capa customizada.`,
      400
    );
  }

  const cover = await mediaRepository.findById(coverMediaAssetId);
  if (!cover || cover.userId !== userId) {
    throw new AppError(
      ErrorCodes.MEDIA_NOT_FOUND,
      'Mídia da capa não encontrada.',
      404
    );
  }
  if (cover.type !== 'IMAGE') {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      'A capa precisa ser uma imagem (JPG ou PNG).',
      400
    );
  }

  return coverMediaAssetId;
}

/**
 * Accepts an ISO string or Date. Returns:
 *   - null if omitted (post stays DRAFT)
 *   - Date if valid and in the future (>= now + 1 minute cushion)
 *   - throws AppError if invalid or in the past
 */
function normalizeScheduledFor(input) {
  if (input === undefined || input === null || input === '') return null;

  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(
      ErrorCodes.INVALID_SCHEDULE_TIME,
      'Data/hora de agendamento inválida.',
      400
    );
  }

  const oneMinuteFromNow = new Date(Date.now() + 60 * 1000);
  if (date < oneMinuteFromNow) {
    throw new AppError(
      ErrorCodes.INVALID_SCHEDULE_TIME,
      'A data de agendamento deve estar pelo menos 1 minuto no futuro.',
      400
    );
  }

  return date;
}

// Stable public shape returned to the frontend. Hides Prisma-specific fields
// and the internal ordering of medias.
//
// Rodada 2b: exposes the cover as `cover` — same nested shape as the
// entries in `medias`, so the frontend can render it with the same
// thumbnail component. Null when the post has no custom cover.
//
// Rodada 3: exposes instagramMediaId so the frontend can decide whether
// to show the "Métricas" button (only for PUBLISHED posts with a valid
// media id returned by Meta's /media_publish).
function toPublicShape(post) {
  return {
    id: post.id,
    type: post.type,
    status: post.status,
    caption: post.caption,
    scheduledFor: post.scheduledFor,
    publishedAt: post.publishedAt,
    failureReason: post.failureReason,
    retryCount: post.retryCount,
    instagramMediaId: post.instagramMediaId,
    // Rodada 4: null for single posts; same uuid for every post of a batch.
    batchId: post.batchId ?? null,
    instagramAccount: post.instagramAccount,
    medias: (post.medias || []).map((pm) => ({
      order: pm.order,
      id: pm.mediaAsset.id,
      type: pm.mediaAsset.type,
      url: pm.mediaAsset.url,
      width: pm.mediaAsset.width,
      height: pm.mediaAsset.height,
      durationSec: pm.mediaAsset.durationSec,
    })),
    cover: post.coverMediaAsset
      ? {
          id: post.coverMediaAsset.id,
          type: post.coverMediaAsset.type,
          url: post.coverMediaAsset.url,
          width: post.coverMediaAsset.width,
          height: post.coverMediaAsset.height,
        }
      : null,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

// -----------------------------------------------------------------------
// Rodada 4: multi-profile batch posting
// -----------------------------------------------------------------------

// Instagram's caption ceiling (mirrors CAPTION_MAX_LENGTH on the frontend).
// Checked after spintax resolution, since a resolved caption can be longer
// or shorter than its template.
const BATCH_CAPTION_MAX_LENGTH = 2200;

/**
 * Create a batch: every item is published on every selected account.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {Array<string>} args.instagramAccountIds - target accounts (ACTIVE, owned by user)
 * @param {string} args.type - same type for every item
 * @param {Array<{ mediaIds: string[], caption?: string, coverMediaAssetId?: string|null }>} args.items
 *        One item = one post per account. For single-media types each item
 *        has one media; a carousel item has 2-10. Item caption/cover
 *        override the shared ones (cover: null explicitly = no cover).
 * @param {string} [args.caption] - shared caption (spintax allowed)
 * @param {string|null} [args.coverMediaAssetId] - shared cover (FEED_VIDEO/REEL)
 * @param {string|Date} [args.scheduledFor] - base date; omit to save all as DRAFT
 * @param {{ enabled?: boolean, windowMinutes?: number, itemIntervalMinutes?: number }} [args.stagger]
 * @param {boolean} [args.useSpintax=true] - resolve {a|b|c} per post
 * @returns {Promise<{ batchId: string, posts: ScheduledPost[] }>}
 */
async function createBatch({
  userId,
  instagramAccountIds,
  type,
  items,
  caption,
  coverMediaAssetId,
  scheduledFor,
  stagger,
  useSpintax = true,
}) {
  assertValidType(type);
  const limits = env.batch;

  // --- accounts ----------------------------------------------------------
  if (!Array.isArray(instagramAccountIds) || instagramAccountIds.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Selecione pelo menos um perfil.', 400);
  }
  const accountIds = [...new Set(instagramAccountIds.filter(Boolean).map(String))];
  if (accountIds.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Selecione pelo menos um perfil.', 400);
  }
  if (accountIds.length > limits.maxAccounts) {
    throw new AppError(
      ErrorCodes.BATCH_LIMIT_EXCEEDED,
      `Máximo de ${limits.maxAccounts} perfis por lote. Selecionados: ${accountIds.length}.`,
      400
    );
  }
  for (const accountId of accountIds) {
    const account = await assertAccountBelongsToUser({ instagramAccountId: accountId, userId });
    if (account.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCodes.INSTAGRAM_ACCOUNT_INACTIVE,
        `A conta @${account.username} não está ativa (status: ${account.status}). Reconecte-a ou remova da seleção.`,
        409
      );
    }
  }

  // --- items -------------------------------------------------------------
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(ErrorCodes.INVALID_MEDIA_COUNT, 'Envie pelo menos uma mídia para o lote.', 400);
  }
  if (items.length > limits.maxItems) {
    throw new AppError(
      ErrorCodes.BATCH_LIMIT_EXCEEDED,
      `Máximo de ${limits.maxItems} mídias por lote. Recebido: ${items.length}.`,
      400
    );
  }
  const totalPosts = items.length * accountIds.length;
  if (totalPosts > limits.maxPosts) {
    throw new AppError(
      ErrorCodes.BATCH_LIMIT_EXCEEDED,
      `Este lote geraria ${totalPosts} posts (máximo ${limits.maxPosts}). Reduza mídias ou perfis.`,
      400
    );
  }

  const sharedCoverId = await resolveAndValidateCover({ userId, type, coverMediaAssetId });

  const resolvedItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    try {
      const medias = await resolveAndValidateMedias({ userId, type, mediaIds: item.mediaIds });
      const itemCoverId =
        item.coverMediaAssetId !== undefined
          ? await resolveAndValidateCover({ userId, type, coverMediaAssetId: item.coverMediaAssetId })
          : sharedCoverId;
      const captionTemplate =
        typeof item.caption === 'string' && item.caption.trim() !== '' ? item.caption : caption ?? null;
      resolvedItems.push({ medias, coverMediaAssetId: itemCoverId, captionTemplate });
    } catch (err) {
      // Prefix the item number so the user knows which upload to fix.
      if (err instanceof AppError) {
        throw new AppError(err.code, `Mídia ${i + 1}: ${err.message}`, err.status, err.debug);
      }
      throw err;
    }
  }

  // --- schedule ----------------------------------------------------------
  const baseDate = normalizeScheduledFor(scheduledFor);
  const status = baseDate ? 'SCHEDULED' : 'DRAFT';
  const staggerConfig = normalizeStagger(stagger);
  const plan = buildStaggerPlan({
    itemCount: resolvedItems.length,
    accountIds,
    baseDate,
    stagger: staggerConfig,
  });

  // --- build rows --------------------------------------------------------
  const batchId = crypto.randomUUID();
  const postsData = [];
  plan.forEach((entries, itemIndex) => {
    const item = resolvedItems[itemIndex];
    for (const entry of entries) {
      const finalCaption =
        item.captionTemplate && useSpintax !== false
          ? resolveSpintax(item.captionTemplate)
          : item.captionTemplate;
      if (finalCaption && finalCaption.length > BATCH_CAPTION_MAX_LENGTH) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Mídia ${itemIndex + 1}: a legenda passa de ${BATCH_CAPTION_MAX_LENGTH} caracteres.`,
          400
        );
      }
      postsData.push({
        userId,
        instagramAccountId: entry.accountId,
        type,
        caption: finalCaption ?? null,
        status,
        scheduledFor: entry.scheduledFor,
        medias: item.medias,
        coverMediaAssetId: item.coverMediaAssetId,
        batchId,
      });
    }
  });

  // Rodada 4.1: bulk insert (was postRepository.createBatch(postsData) —
  // one nested create per post, too slow for batches with thousands of posts).
  const posts = await postRepository.createBatchBulk(postsData);

  logger.info('Scheduled post batch created', {
    userId,
    batchId,
    type,
    items: resolvedItems.length,
    accounts: accountIds.length,
    posts: posts.length,
    status,
    stagger: staggerConfig,
  });

  return { batchId, posts };
}

async function getBatch(batchId, userId) {
  const posts = await postRepository.findAllByBatchId(batchId, userId);
  if (!posts || posts.length === 0) {
    throw new AppError(ErrorCodes.BATCH_NOT_FOUND, 'Lote não encontrado.', 404);
  }
  return posts;
}

/**
 * Delete every post of the batch that is not QUEUED/PUBLISHING. Unlike
 * calling deletePost N times, the orphan check runs ONCE per media after
 * all rows are gone (no concurrent checks racing on the same file).
 * Same Instagram caveat as deletePost: PUBLISHED posts stay on the profile.
 */
async function deleteBatch(batchId, userId) {
  const posts = await getBatch(batchId, userId);
  const deletable = posts.filter((p) => !UNDELETABLE_STATUSES.has(p.status));

  if (deletable.length === 0) {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      'Todos os posts restantes deste lote estão na fila ou em publicação. Aguarde alguns instantes e tente novamente.',
      409
    );
  }

  const mediaAssetIds = new Set();
  for (const post of deletable) {
    for (const pm of post.medias || []) {
      const mediaId = pm.mediaAssetId ?? pm.mediaAsset?.id;
      if (mediaId) mediaAssetIds.add(mediaId);
    }
    if (post.coverMediaAssetId) mediaAssetIds.add(post.coverMediaAssetId);
  }

  const { count } = await postRepository.deleteManyByIds(deletable.map((p) => p.id));

  logger.info('Scheduled post batch deleted', {
    userId,
    batchId,
    deleted: count,
    skipped: posts.length - count,
    mediaAssetCount: mediaAssetIds.size,
  });

  for (const mediaId of mediaAssetIds) {
    mediaService.deleteIfOrphan(mediaId, userId).catch((err) => {
      logger.warn('Orphan media cleanup rejected unexpectedly', {
        mediaId,
        userId,
        error: err.message,
      });
    });
  }

  return { batchId, deleted: count, skipped: posts.length - count };
}

/**
 * Archive every post of the batch that the worker isn't touching.
 */
async function archiveBatch(batchId, userId) {
  const posts = await getBatch(batchId, userId);
  const ids = posts
    .filter((p) => !['QUEUED', 'PUBLISHING', 'ARCHIVED'].includes(p.status))
    .map((p) => p.id);

  if (ids.length === 0) {
    return { batchId, archived: 0, skipped: posts.length };
  }

  const { count } = await postRepository.archiveManyByIds(ids);
  logger.info('Scheduled post batch archived', { userId, batchId, archived: count });
  return { batchId, archived: count, skipped: posts.length - count };
}

/**
 * Compact summary for the UI: totals per status, accounts involved and
 * the scheduling span.
 */
function summarizeBatch(batchId, posts) {
  const byStatus = {};
  const accountIds = new Set();
  let firstScheduledFor = null;
  let lastScheduledFor = null;

  for (const post of posts || []) {
    byStatus[post.status] = (byStatus[post.status] || 0) + 1;
    accountIds.add(post.instagramAccountId);
    if (post.scheduledFor) {
      const date = new Date(post.scheduledFor);
      if (!firstScheduledFor || date < firstScheduledFor) firstScheduledFor = date;
      if (!lastScheduledFor || date > lastScheduledFor) lastScheduledFor = date;
    }
  }

  return {
    batchId,
    total: (posts || []).length,
    accounts: accountIds.size,
    byStatus,
    firstScheduledFor,
    lastScheduledFor,
  };
}

/**
 * Resolve spintax: "{Oi|Olá|E aí}" -> one random option. Nested groups
 * work ("{a|{b|c}}"), innermost first. Braces WITHOUT a "|" inside are
 * left untouched, so a normal caption containing "{texto}" never changes.
 */
const SPINTAX_GROUP = /\{([^{}]*\|[^{}]*)\}/;
function resolveSpintax(text) {
  if (typeof text !== 'string' || !text.includes('|')) return text;
  let out = text;
  let guard = 0;
  while (SPINTAX_GROUP.test(out) && guard < 500) {
    out = out.replace(SPINTAX_GROUP, (_, group) => {
      const options = group.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    guard += 1;
  }
  return out;
}

function normalizeStagger(stagger) {
  const s = stagger || {};
  return {
    enabled: s.enabled !== undefined ? Boolean(s.enabled) : true,
    windowMinutes: clampNumber(s.windowMinutes, 0, 720, env.batch.defaultWindowMinutes),
    itemIntervalMinutes: clampNumber(s.itemIntervalMinutes, 0, 1440, env.batch.defaultItemIntervalMinutes),
  };
}

function clampNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Returns plan[itemIndex] = [{ accountId, scheduledFor }].
 *
 * With stagger enabled:
 *   - item i starts at base + i * itemIntervalMinutes
 *   - the accounts of that item are spread over windowMinutes, one slot
 *     each, with random jitter inside the slot
 *   - account order is shuffled per item, so the same profile isn't
 *     always the first one to post
 * Disabled: every post at the base date. No base date: DRAFT (null).
 */
function buildStaggerPlan({ itemCount, accountIds, baseDate, stagger }) {
  const plan = [];
  const slotMs = accountIds.length > 0 ? (stagger.windowMinutes * 60 * 1000) / accountIds.length : 0;

  for (let i = 0; i < itemCount; i++) {
    const order = stagger.enabled ? shuffle(accountIds) : [...accountIds];
    const itemOffsetMs = stagger.enabled ? i * stagger.itemIntervalMinutes * 60 * 1000 : 0;

    plan.push(
      order.map((accountId, k) => {
        if (!baseDate) return { accountId, scheduledFor: null };
        if (!stagger.enabled) return { accountId, scheduledFor: new Date(baseDate.getTime()) };
        const jitterMs = Math.floor(Math.random() * slotMs * 0.8);
        const ms = baseDate.getTime() + itemOffsetMs + Math.floor(k * slotMs) + jitterMs;
        return { accountId, scheduledFor: new Date(Math.floor(ms / 1000) * 1000) };
      })
    );
  }
  return plan;
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// -----------------------------------------------------------------------
// Rodada 4.1: pagination / account filter on the posts list + batch limits
// -----------------------------------------------------------------------

/**
 * Same validation as listPosts, plus an optional account filter and the
 * total count. The account filter is always combined with userId in the
 * query, so passing another user's account id simply returns nothing.
 */
async function listPostsPage(userId, { status, instagramAccountId, take = 50, skip = 0 } = {}) {
  if (status && !isValidStatus(status)) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Filtro de status inválido: ${status}.`,
      400
    );
  }
  return postRepository.findPageByUserId(userId, { status, instagramAccountId, take, skip });
}

/**
 * Limits/defaults the batch composer must respect. Exposed to the
 * frontend so raising a limit is just a Railway env change.
 */
function getBatchLimits() {
  return {
    maxItems: env.batch.maxItems,
    maxAccounts: env.batch.maxAccounts,
    maxPosts: env.batch.maxPosts,
    defaultWindowMinutes: env.batch.defaultWindowMinutes,
    defaultItemIntervalMinutes: env.batch.defaultItemIntervalMinutes,
  };
}

// -----------------------------------------------------------------------
// Rodada 5: "Publicar agora"
// -----------------------------------------------------------------------

const PUBLISH_NOW_STATUSES = new Set(['DRAFT', 'SCHEDULED', 'FAILED']);

function pauseNotice(account) {
  if (!account?.publishPausedUntil) return null;
  const until = new Date(account.publishPausedUntil);
  if (until <= new Date()) return null;
  const when = until.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `@${account.username} está em pausa até ${when}${
    account.pauseReason ? ` (${account.pauseReason})` : ''
  }. O post sai assim que a pausa terminar.`;
}

/**
 * Make one post due right now. DRAFT, SCHEDULED and FAILED are accepted
 * (FAILED gets a fresh retry budget). The worker picks it up on the next
 * tick (~30s), still respecting the account pause and minimum gap.
 */
async function publishNow(id, userId) {
  const post = await getPost(id, userId);

  if (!PUBLISH_NOW_STATUSES.has(post.status)) {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      `Este post não pode ser publicado agora (status: ${post.status}).`,
      409
    );
  }

  const account = post.instagramAccount;
  if (!account || account.status !== 'ACTIVE') {
    throw new AppError(
      ErrorCodes.INSTAGRAM_ACCOUNT_INACTIVE,
      `A conta @${account?.username || ''} está com problema (status: ${account?.status || 'desconhecido'}). Reconecte o perfil antes de publicar.`,
      409
    );
  }

  const changed = await postRepository.requeueNow(id, new Date());
  if (changed === 0) {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      'O post acabou de entrar em publicação. Aguarde alguns instantes.',
      409
    );
  }

  const updated = await postRepository.findById(id);
  logger.info('Post requeued to publish now', { userId, postId: id, previousStatus: post.status });

  return {
    post: updated,
    notice: pauseNotice(account) || 'Post na fila: sai em até 1 minuto.',
  };
}

/**
 * Publish every pending post (DRAFT/SCHEDULED/FAILED) of a batch starting
 * now, re-staggered so profiles don't all post the same second:
 *   - profiles spread over windowMinutes, in random order
 *   - posts of the same profile spaced by intervalMinutes (original order kept)
 * Posts of accounts that are down are left untouched (reported as skipped).
 */
async function publishBatchNow(batchId, userId, { intervalMinutes, windowMinutes } = {}) {
  const posts = await getBatch(batchId, userId);
  const pending = posts.filter((p) => PUBLISH_NOW_STATUSES.has(p.status));
  const eligible = pending.filter((p) => p.instagramAccount?.status === 'ACTIVE');
  const skippedInactive = pending.length - eligible.length;

  if (eligible.length === 0) {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      skippedInactive > 0
        ? 'Os posts pendentes deste lote são de perfis com problema. Reconecte os perfis primeiro.'
        : 'Nenhum post pendente para publicar neste lote.',
      409
    );
  }

  const interval = clampNumber(intervalMinutes, 0, 1440, env.batch.defaultItemIntervalMinutes);
  const window = clampNumber(windowMinutes, 0, 720, 10);

  const byAccount = new Map();
  for (const post of eligible) {
    if (!byAccount.has(post.instagramAccountId)) byAccount.set(post.instagramAccountId, []);
    byAccount.get(post.instagramAccountId).push(post);
  }

  const accountIds = shuffle([...byAccount.keys()]);
  const slotMs = accountIds.length > 0 ? (window * 60 * 1000) / accountIds.length : 0;
  const startMs = Date.now() + 5000;
  const entries = [];

  accountIds.forEach((accountId, k) => {
    const list = byAccount.get(accountId).sort((a, b) => {
      const ta = a.scheduledFor ? new Date(a.scheduledFor).getTime() : 0;
      const tb = b.scheduledFor ? new Date(b.scheduledFor).getTime() : 0;
      return ta - tb || new Date(a.createdAt) - new Date(b.createdAt);
    });
    const baseMs = startMs + Math.floor(k * slotMs) + Math.floor(Math.random() * slotMs * 0.8);
    list.forEach((post, j) => {
      entries.push({ id: post.id, scheduledFor: new Date(baseMs + j * interval * 60 * 1000) });
    });
  });

  const requeued = await postRepository.requeueMany(entries);
  const times = entries.map((e) => e.scheduledFor.getTime());

  logger.info('Batch requeued to publish now', {
    userId,
    batchId,
    requeued,
    skippedInactive,
    intervalMinutes: interval,
    windowMinutes: window,
  });

  return {
    batchId,
    requeued,
    skippedInactive,
    firstAt: new Date(Math.min(...times)),
    lastAt: new Date(Math.max(...times)),
  };
}

module.exports = {
  createPost,
  listPosts,
  getPost,
  updatePost,
  archivePost,
  deletePost,
  toPublicShape,
  // Rodada 4
  createBatch,
  getBatch,
  deleteBatch,
  archiveBatch,
  summarizeBatch,
  resolveSpintax,
  // Rodada 4.1
  listPostsPage,
  getBatchLimits,
  // Rodada 5
  publishNow,
  publishBatchNow,
};