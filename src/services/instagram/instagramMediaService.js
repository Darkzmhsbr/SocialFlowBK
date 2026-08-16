// Media container helpers for the publish flow. Wraps the raw client calls
// with retry-safe polling so the publish service just says
// "ensureImageContainerReady()" and gets a creationId back that's guaranteed
// to be in FINISHED state.
//
// Meta's publish flow is intentionally two-step: create a container that
// references the media URL, wait until the container is ready, then call
// /media_publish. We can't skip the poll - Meta needs time to fetch the
// asset from Cloudinary and validate it.

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

module.exports = { ensureImageContainerReady, waitForContainerReady };