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
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

// Which post types accept how many media items, and which media types
// are valid for each. Enforced on both create and update.
const POST_TYPE_RULES = {
  FEED_IMAGE:    { min: 1, max: 1,  allowed: ['IMAGE'] },
  FEED_VIDEO:    { min: 1, max: 1,  allowed: ['VIDEO'] },
  FEED_CAROUSEL: { min: 2, max: 10, allowed: ['IMAGE', 'VIDEO'] },
  REEL:          { min: 1, max: 1,  allowed: ['VIDEO'] },
  STORY:         { min: 1, max: 1,  allowed: ['IMAGE', 'VIDEO'] },
};

const VALID_TYPES = Object.keys(POST_TYPE_RULES);

// Posts can only be edited by the user in these states. Once queued/publishing/
// published, the API rejects edits (the user can archive and clone instead).
const EDITABLE_STATUSES = new Set(['DRAFT', 'SCHEDULED', 'FAILED']);

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
 * @returns {Promise<ScheduledPost>}
 */
async function createPost({ userId, instagramAccountId, type, caption, mediaIds, scheduledFor }) {
  assertValidType(type);
  await assertAccountBelongsToUser({ instagramAccountId, userId });

  const orderedMedias = await resolveAndValidateMedias({
    userId,
    type,
    mediaIds,
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
  });

  logger.info('Scheduled post created', {
    userId,
    postId: post.id,
    status: post.status,
    type: post.type,
    mediaCount: orderedMedias.length,
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

async function deletePost(id, userId) {
  const post = await getPost(id, userId);
  // Only DRAFT is hard-deletable to avoid losing history of things that
  // interacted with Instagram (or are about to).
  if (post.status !== 'DRAFT') {
    throw new AppError(
      ErrorCodes.POST_INVALID_STATE,
      'Apenas rascunhos podem ser excluídos. Use arquivar para outros estados.',
      409
    );
  }
  await postRepository.deleteById(id);
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