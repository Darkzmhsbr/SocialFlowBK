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
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  publishWorker.stop();
  server.close(() => {
    logger.info('HTTP server closed, exiting');
    process.exit(0);
  });
  // Hard-exit fallback if close() hangs.
  setTimeout(() => {
    logger.error('Shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));