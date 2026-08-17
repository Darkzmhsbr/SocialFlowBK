// Publish orchestration. This is the top-level "publish one post" function
// the worker calls. It handles:
//   - decrypting the account token
//   - dispatching to the right container flow based on post.type
//   - persisting status transitions (PUBLISHING -> PUBLISHED / FAILED / retry)
//   - deciding whether an error is worth retrying
//
// Rodada 2a: worker now supports ALL post types (FEED_IMAGE, FEED_VIDEO,
// REEL, FEED_CAROUSEL, STORY). Custom Reel/Video cover images (cover_url)
// are still 2b — Meta picks a frame automatically for now.
//
// Not implemented (out of scope, tracked in roadmap):
//   - Rodada 2b: cover_url for videos/reels, requires DB migration
//   - Rodada 3:  post-publish metrics fetch (Insights API)
//   - Rodada 4:  visual Story editor (canvas + text/stickers baked in)

const instagramMediaService = require('./instagramMediaService');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const scheduledPostRepository = require('../../database/scheduledPostRepository');
const { decryptToken } = require('../../utils/crypto');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

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
    const mediaId = await publishByType(post, accessToken);

    const finalPost = await scheduledPostRepository.markPublished(post.id, mediaId);
    logger.info('Post published', {
      postId: post.id,
      instagramMediaId: mediaId,
    });
    return finalPost;
  } catch (error) {
    return handlePublishFailure(post, error);
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

  const { creationId } = await instagramMediaService.ensureVideoContainerReady({
    igUserId,
    videoUrl: media.url,
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

async function publishReel(post, igUserId, caption, accessToken) {
  const media = post.medias?.[0]?.mediaAsset;
  if (!media || media.type !== 'VIDEO') {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      'REEL precisa de exatamente uma mídia do tipo VIDEO.',
      400
    );
  }

  const { creationId } = await instagramMediaService.ensureReelContainerReady({
    igUserId,
    videoUrl: media.url,
    caption,
    accessToken,
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

module.exports = { publishPost };