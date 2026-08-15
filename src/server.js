const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');

app.listen(env.port, () => {
  logger.info(`SocialFlow API listening on port ${env.port}`, { nodeEnv: env.nodeEnv });
});
