// Business logic for scheduled posts. Enforces every rule Instagram itself
// would enforce at publish time - but earlier, so the user gets clear
// feedback in the composer instead of a cryptic Meta error 3 hours later.
//
// This file does NOT talk to Instagram. Publishing lives in Phase 2.2
// (see instagramPublishService.js placeholder). All this file does is
// validate + persist + expose posts in editable states.

const postRepository = require('../../database/scheduledPostRepository');
const mediaRepository = require('../../database/mediaRepository');
const accountRepository = require('../../database/instagramAccountRepository');
const mediaService = require('../media/mediaService');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

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

module.exports = {
  createPost,
  listPosts,
  getPost,
  updatePost,
  archivePost,
  deletePost,
  toPublicShape,
};