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
//
// Rodada 4 (multi-profile batch): new concurrent mode, used whenever
// WORKER_CONCURRENCY > 1 (default 3). Each tick:
//   1. Recovers stale QUEUED/PUBLISHING rows (process died mid-publish).
//   2. Claims only as many posts as there are free slots, via
//      claimDuePostsFair (max one in-flight post per Instagram account,
//      round-robin between users).
//   3. Starts each publish WITHOUT awaiting it, so a slow Reel never blocks
//      the next tick — free slots are refilled every interval.
// WORKER_CONCURRENCY=1 keeps the original sequential tick() untouched.
// waitForIdle() lets server.js wait for in-flight publishes on shutdown.
//
// Rodada 5: after every publish attempt, notificationService.onPostSettled
// creates "posts failed" / "batch finished" alerts; start() also starts the
// periodic account health check (accountHealthService).

const cron = require('node-cron');
const scheduledPostRepository = require('../database/scheduledPostRepository');
const publishService = require('../services/instagram/instagramPublishService');
const env = require('../config/env');
const logger = require('../utils/logger');
// Rodada 5: notifications + account health check.
const notificationService = require('../services/notifications/notificationService');
const accountHealthService = require('../services/instagram/accountHealthService');
// Rodada 12: background cleanup jobs + daily automatic rules.
const cleanupService = require('../services/cleanup/cleanupService');
// Rodada 13: daily metrics collection for the Dashboard.
const metricsService = require('../services/metrics/metricsService');
// Rodada 17: Monitoramento (alerts) + official Telegram alerts bot.
const monitoringService = require('../services/monitoring/monitoringService');
const telegramService = require('../services/telegram/telegramService');

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
      // Rodada 5: never throws.
      await notificationService.onPostSettled(post);
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

// --- Rodada 4: concurrent mode ---------------------------------------------

const inFlight = new Set();
let isClaiming = false;

async function tickConcurrent() {
  if (isClaiming) return;
  isClaiming = true;

  try {
    await recoverStale();

    const freeSlots = env.worker.concurrency - inFlight.size;
    if (freeSlots <= 0) return;

    const posts = await scheduledPostRepository.claimDuePostsFair(freeSlots);
    if (posts.length === 0) return;

    logger.info('Publish worker tick (concurrent)', {
      claimed: posts.length,
      inFlightBefore: inFlight.size,
      concurrency: env.worker.concurrency,
    });

    for (const post of posts) {
      // publishPost never throws (outcomes are persisted on the row); the
      // catch is defense in depth so one rejection can't leak a slot.
      const job = publishService
        .publishPost(post)
        // Rodada 5: alerts for failures / finished batches (never throws).
        .then(() => notificationService.onPostSettled(post))
        .catch((error) => {
          logger.error('Publish job rejected unexpectedly', {
            postId: post.id,
            message: error.message,
            stack: error.stack,
          });
        })
        .finally(() => {
          inFlight.delete(job);
        });
      inFlight.add(job);
    }
  } catch (error) {
    logger.error('Publish worker concurrent tick failed unexpectedly', {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    isClaiming = false;
  }
}

async function recoverStale() {
  const now = Date.now();
  const staleMs = env.worker.staleMinutes * 60 * 1000;
  // A carousel waits for children AND parent; copies add a little more.
  // Never call a post "dead" before it could reasonably have finished.
  const publishingStaleMs = Math.max(staleMs, env.worker.pollTimeoutMs * 3 + 5 * 60 * 1000);

  const result = await scheduledPostRepository.recoverStalePosts({
    queuedBefore: new Date(now - staleMs),
    publishingBefore: new Date(now - publishingStaleMs),
  });

  if (result.requeued > 0 || result.failed > 0) {
    logger.warn('Recovered stale posts', result);
  }
}

/**
 * Resolves once nothing is publishing (either mode) or the timeout hits.
 * Returns true when idle. Used by server.js before process.exit().
 */
async function waitForIdle(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while ((inFlight.size > 0 || isTicking || isClaiming) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const idle = inFlight.size === 0 && !isTicking && !isClaiming;
  if (idle) {
    logger.info('Publish worker idle');
  } else {
    logger.warn('Publish worker still busy at shutdown deadline', { inFlight: inFlight.size });
  }
  return idle;
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

  // Rodada 4: concurrent mode by default; WORKER_CONCURRENCY=1 = original tick.
  const handler = env.worker.concurrency > 1 ? tickConcurrent : tick;

  task = cron.schedule(pattern, handler, {
    scheduled: true,
    timezone: 'UTC',
  });

  logger.info('Publish worker started', {
    intervalSeconds: seconds,
    batchSize: env.worker.batchSize,
    maxRetries: env.worker.maxRetries,
    // Rodada 4
    mode: env.worker.concurrency > 1 ? 'concurrent' : 'sequential',
    concurrency: env.worker.concurrency,
  });

  // Rodada 5: periodic account health check + token refresh.
  accountHealthService.startHealthChecks();
  // Rodada 12
  cleanupService.startRunner();
  // Rodada 13
  metricsService.startCollector();
  // Rodada 17
  monitoringService.startMonitor();
  telegramService.start().catch(() => {});
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('Publish worker stopped');
  }
  // Rodada 5
  accountHealthService.stopHealthChecks();
  // Rodada 12
  cleanupService.stopRunner();
  // Rodada 13
  metricsService.stopCollector();
  // Rodada 17
  monitoringService.stopMonitor();
  telegramService.stop();
}

module.exports = { start, stop, tick };

// Rodada 4: appended so the original export line stays untouched.
module.exports.tickConcurrent = tickConcurrent;
module.exports.waitForIdle = waitForIdle;