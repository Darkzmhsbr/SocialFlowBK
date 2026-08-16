// Publish worker. Runs inside the same Node process as the API - not a
// separate Railway service - so no infra changes are needed to enable it.
//
// Every tick (WORKER_INTERVAL_SECONDS, default 30s) it:
//   1. Claims up to WORKER_BATCH_SIZE posts whose scheduledFor <= now
//      (atomic via FOR UPDATE SKIP LOCKED in the repository).
//   2. Publishes them sequentially. Sequential (not parallel) so a slow
//      Meta call can't tie up more than one slot at a time.
//   3. Never throws to the caller - each post's outcome is persisted on
//      its own row by the publish service.
//
// A boolean `isTicking` guard prevents overlap if a tick runs longer than
// the interval - the next scheduled tick just no-ops.

const cron = require('node-cron');
const scheduledPostRepository = require('../database/scheduledPostRepository');
const publishService = require('../services/instagram/instagramPublishService');
const env = require('../config/env');
const logger = require('../utils/logger');

let isTicking = false;
let task = null;

async function tick() {
  if (isTicking) {
    logger.warn('Publish worker tick skipped (previous tick still running)');
    return;
  }
  isTicking = true;
  const startedAt = Date.now();

  try {
    const posts = await scheduledPostRepository.claimDuePosts(env.worker.batchSize);

    if (posts.length === 0) {
      isTicking = false;
      return;
    }

    logger.info('Publish worker tick', { claimed: posts.length });

    for (const post of posts) {
      // publishPost swallows its own errors and persists them - so we can
      // safely await in a loop without a try/catch here.
      await publishService.publishPost(post);
    }

    logger.info('Publish worker tick done', {
      processed: posts.length,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Only reaches here on unexpected repository / DB errors. The next
    // tick will try again in WORKER_INTERVAL_SECONDS.
    logger.error('Publish worker tick failed unexpectedly', {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    isTicking = false;
  }
}

function start() {
  if (!env.worker.enabled) {
    logger.info('Publish worker disabled by WORKER_ENABLED=false');
    return;
  }
  if (task) {
    logger.warn('Publish worker already started');
    return;
  }

  // node-cron uses standard cron syntax. Convert intervalSeconds to a
  // pattern: "*/N * * * * *" (every N seconds). Also require valid ranges
  // to avoid an invalid pattern crashing the process.
  const seconds = Math.max(5, Math.min(59, env.worker.intervalSeconds));
  const pattern = `*/${seconds} * * * * *`;

  task = cron.schedule(pattern, tick, {
    scheduled: true,
    timezone: 'UTC',
  });

  logger.info('Publish worker started', {
    intervalSeconds: seconds,
    batchSize: env.worker.batchSize,
    maxRetries: env.worker.maxRetries,
  });
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('Publish worker stopped');
  }
}

module.exports = { start, stop, tick };