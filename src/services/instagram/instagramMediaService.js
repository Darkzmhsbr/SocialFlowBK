// Media container helpers for the publish flow. Wraps the raw client calls
// with retry-safe polling so the publish service just says
// "ensureXContainerReady()" and gets a creationId back that's guaranteed
// to be in FINISHED state.
//
// Meta's publish flow is intentionally two-step: create a container that
// references the media URL, wait until the container is ready, then call
// /media_publish. We can't skip the poll - Meta needs time to fetch the
// asset from Cloudinary and validate it.
//
// Rodada 2a expanded this beyond FEED_IMAGE:
//   - ensureImageContainerReady    -> FEED_IMAGE
//   - ensureVideoContainerReady    -> FEED_VIDEO  (media_type=VIDEO)
//   - ensureReelContainerReady     -> REEL        (media_type=REELS)
//   - ensureStoryContainerReady    -> STORY       (media_type=STORIES)
//   - ensureCarouselContainerReady -> FEED_CAROUSEL (two-phase: children + parent)
//
// waitForContainerReady is shared by all of them and unchanged.

const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const TERMINAL_OK = 'FINISHED';
const TERMINAL_BAD = new Set(['ERROR', 'EXPIRED']);

/**
 * Create a container for a single feed image and wait until it's ready.
 * Returns the creationId that should be passed to publishMediaContainer.
 *
 * Throws AppError on:
 *   - INSTAGRAM_MEDIA_ERROR when Meta rejects the media (bad aspect ratio,
 *     unreachable URL, wrong format). Non-retryable.
 *   - INSTAGRAM_MEDIA_TIMEOUT if Meta never marks it FINISHED within the
 *     configured window. Non-retryable in the same batch, but the outer
 *     publish service may retry the whole post later.
 */
async function ensureImageContainerReady({ igUserId, imageUrl, caption, accessToken }) {
  const { creationId } = await instagramApiClient.createMediaContainer(
    igUserId,
    {
      image_url: imageUrl,
      caption: caption || undefined,
    },
    accessToken
  );

  logger.info('Instagram image container created', { igUserId, creationId });

  await waitForContainerReady({ creationId, accessToken });
  return { creationId };
}

/**
 * Feed video (non-Reel). Meta's Content Publishing docs use media_type=VIDEO
 * for this. Note: Meta has been gradually converting long-form feed videos
 * into Reels automatically — if Meta reshapes it on their side, the container
 * still finishes as FINISHED and publishes successfully, it just shows up as
 * a Reel in the profile.
 *
 * Video containers take longer to reach FINISHED than image containers
 * (Meta transcodes). If pollTimeoutMs is too tight for real user videos,
 * bump WORKER_POLL_TIMEOUT_MS in Railway env — no code change needed.
 */
async function ensureVideoContainerReady({ igUserId, videoUrl, caption, accessToken }) {
  const { creationId } = await instagramApiClient.createMediaContainer(
    igUserId,
    {
      media_type: 'VIDEO',
      video_url: videoUrl,
      caption: caption || undefined,
    },
    accessToken
  );

  logger.info('Instagram feed video container created', { igUserId, creationId });

  await waitForContainerReady({ creationId, accessToken });
  return { creationId };
}

/**
 * Reel. media_type=REELS is the current (v25) type. share_to_feed=true is
 * the default we want (Reel appears both in Reels tab AND in the feed),
 * matching Instagram's own default when you post a Reel from the app.
 *
 * Custom cover is out of scope in Rodada 2a — coming in 2b via cover_url.
 * Without it, Meta picks a frame automatically (usually near the start).
 */
async function ensureReelContainerReady({ igUserId, videoUrl, caption, accessToken, shareToFeed = true }) {
  const { creationId } = await instagramApiClient.createMediaContainer(
    igUserId,
    {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption || undefined,
      share_to_feed: shareToFeed,
    },
    accessToken
  );

  logger.info('Instagram reel container created', { igUserId, creationId });

  await waitForContainerReady({ creationId, accessToken });
  return { creationId };
}

/**
 * Story. Accepts either an image or a video — Meta uses different fields
 * for each. STORIES containers do accept caption in the params, but the
 * caption is not visible in the published Story (Instagram Stories don't
 * render captions the way feed posts do). We intentionally do NOT forward
 * post.caption here to avoid confusing the user who thinks their text will
 * appear on the Story — that's Rodada 4 territory (visual editor).
 *
 * Story link stickers require 10k+ followers OR a verified badge via API
 * (Meta restriction). Also out of scope for 2a.
 */
async function ensureStoryContainerReady({ igUserId, mediaAsset, accessToken }) {
  const params = { media_type: 'STORIES' };

  if (mediaAsset.type === 'IMAGE') {
    params.image_url = mediaAsset.url;
  } else if (mediaAsset.type === 'VIDEO') {
    params.video_url = mediaAsset.url;
  } else {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      `Story não aceita mídia do tipo ${mediaAsset.type}.`,
      400
    );
  }

  const { creationId } = await instagramApiClient.createMediaContainer(
    igUserId,
    params,
    accessToken
  );

  logger.info('Instagram story container created', {
    igUserId,
    creationId,
    mediaType: mediaAsset.type,
  });

  await waitForContainerReady({ creationId, accessToken });
  return { creationId };
}

/**
 * Feed carousel (2–10 images/videos). Two-phase flow:
 *   Phase 1: create one child container per media asset (in parallel).
 *            Each child gets is_carousel_item=true and no caption.
 *   Phase 2: wait for ALL children to reach FINISHED (in parallel).
 *   Phase 3: create the parent container with media_type=CAROUSEL and
 *            children=<comma-separated child ids> and the post caption.
 *   Phase 4: wait for the parent to reach FINISHED.
 *
 * Parallelism matters: a serial version of this takes N * transcoding_time
 * for a video carousel, which easily blows past the poll timeout on a
 * 3-video carousel. In parallel the total time is (slowest child) + parent.
 *
 * If any single child fails (INSTAGRAM_MEDIA_ERROR), Promise.all rejects
 * and the whole carousel fails — which is what we want: users don't want
 * a partial carousel published, and Meta doesn't let us "fix" one slot
 * later. Non-retryable, user must edit the offending media and retry.
 */
async function ensureCarouselContainerReady({ igUserId, mediaAssets, caption, accessToken }) {
  if (!Array.isArray(mediaAssets) || mediaAssets.length < 2 || mediaAssets.length > 10) {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      `Carrossel precisa de 2 a 10 mídias. Recebido: ${mediaAssets?.length ?? 0}.`,
      400
    );
  }

  // Phase 1: create children (parallel).
  const childResults = await Promise.all(
    mediaAssets.map((asset) => createCarouselChildContainer({ igUserId, asset, accessToken }))
  );
  const childIds = childResults.map((r) => r.creationId);

  logger.info('Instagram carousel children created', {
    igUserId,
    count: childIds.length,
    childIds,
  });

  // Phase 2: wait for children (parallel).
  await Promise.all(
    childIds.map((creationId) => waitForContainerReady({ creationId, accessToken }))
  );

  logger.info('Instagram carousel children all FINISHED', { igUserId, count: childIds.length });

  // Phase 3: create parent. Meta wants `children` as a comma-separated
  // string of ids, not a JSON array. Passing an array via axios params
  // would url-encode it in a way Meta doesn't accept.
  const { creationId: parentId } = await instagramApiClient.createMediaContainer(
    igUserId,
    {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: caption || undefined,
    },
    accessToken
  );

  logger.info('Instagram carousel parent container created', { igUserId, parentId });

  // Phase 4: wait for parent.
  await waitForContainerReady({ creationId: parentId, accessToken });
  return { creationId: parentId };
}

/**
 * Internal helper: create one child container. Not exported because callers
 * always go through ensureCarouselContainerReady.
 */
async function createCarouselChildContainer({ igUserId, asset, accessToken }) {
  const params = { is_carousel_item: true };

  if (asset.type === 'IMAGE') {
    params.image_url = asset.url;
  } else if (asset.type === 'VIDEO') {
    // For videos inside carousels, media_type=VIDEO is required. REELS
    // is NOT valid as a child type — that's for standalone Reels only.
    params.media_type = 'VIDEO';
    params.video_url = asset.url;
  } else {
    throw new AppError(
      ErrorCodes.INVALID_MEDIA_FOR_POST_TYPE,
      `Carrossel não aceita mídia do tipo ${asset.type}.`,
      400
    );
  }

  return instagramApiClient.createMediaContainer(igUserId, params, accessToken);
}

/**
 * Polls a container until it hits FINISHED, ERROR, or EXPIRED - whichever
 * comes first. Respects pollTimeoutMs / pollIntervalMs from env.
 */
async function waitForContainerReady({ creationId, accessToken }) {
  const startedAt = Date.now();
  const timeout = env.worker.pollTimeoutMs;
  const interval = env.worker.pollIntervalMs;

  // First poll happens immediately - images usually finish very fast so we
  // often skip the wait entirely on the first try.
  while (true) {
    const { statusCode, statusMessage } = await instagramApiClient.getMediaContainerStatus(
      creationId,
      accessToken
    );

    if (statusCode === TERMINAL_OK) {
      logger.info('Instagram container ready', {
        creationId,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    if (TERMINAL_BAD.has(statusCode)) {
      throw new AppError(
        ErrorCodes.INSTAGRAM_MEDIA_ERROR,
        `Instagram rejeitou a mídia (${statusCode}${statusMessage ? `: ${statusMessage}` : ''}).`,
        422,
        { creationId, statusCode, statusMessage }
      );
    }

    // IN_PROGRESS (or any unknown status): keep polling until timeout.
    if (Date.now() - startedAt > timeout) {
      throw new AppError(
        ErrorCodes.INSTAGRAM_MEDIA_TIMEOUT,
        `A mídia demorou mais que ${Math.round(timeout / 1000)}s para ser processada pelo Instagram.`,
        504,
        { creationId, lastStatus: statusCode }
      );
    }

    await sleep(interval);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ensureImageContainerReady,
  ensureVideoContainerReady,
  ensureReelContainerReady,
  ensureStoryContainerReady,
  ensureCarouselContainerReady,
  waitForContainerReady,
};