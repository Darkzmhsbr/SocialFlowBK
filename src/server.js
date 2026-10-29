const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const publishWorker = require('./workers/publishWorker');

const server = app.listen(env.port, () => {
  logger.info(`SocialFlow API listening on port ${env.port}`, { nodeEnv: env.nodeEnv });
  // Start the publish worker once the HTTP server is up. If disabled by
  // env, publishWorker.start() logs a message and no-ops.
  publishWorker.start();
});

// Graceful shutdown: stop the worker cron so no new tick fires while the
// HTTP server drains. Railway sends SIGTERM ~30s before killing the container.
//
// Rodada 4: before exiting, wait (up to SHUTDOWN_WORKER_WAIT_MS) for the
// posts already publishing to finish, so a deploy in the middle of a batch
// doesn't cut a Meta upload in half. Anything still running at the
// deadline is recovered by the worker on the next boot.
const SHUTDOWN_WORKER_WAIT_MS = 20000;
const SHUTDOWN_HARD_TIMEOUT_MS = 25000;

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  publishWorker.stop();
  server.close(() => {
    logger.info('HTTP server closed, exiting');
    // Rodada 4: was process.exit(0) right away.
    publishWorker.waitForIdle(SHUTDOWN_WORKER_WAIT_MS).then(() => process.exit(0));
  });
  // Hard-exit fallback if close() hangs.
  setTimeout(() => {
    logger.error(`Shutdown timed out after ${SHUTDOWN_HARD_TIMEOUT_MS / 1000}s, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS).unref(); // Rodada 4: was 10000
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));