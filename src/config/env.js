// Single place that reads process.env. Nothing else in the codebase should
// call process.env directly - this keeps every configurable value (URLs,
// API versions, secrets) swappable without touching business logic.

require('dotenv').config();

function required(name, { onlyInProduction = false } = {}) {
  const value = process.env[name];
  if (!value && (onlyInProduction ? process.env.NODE_ENV === 'production' : true)) {
    // eslint-disable-next-line no-console
    console.warn(`[config] Missing environment variable: ${name}`);
  }
  return value;
}

const env = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  frontendUrl: required('FRONTEND_URL'),
  backendUrl: required('BACKEND_URL'),

  databaseUrl: required('DATABASE_URL'),

  meta: {
    appId: required('META_APP_ID'),
    appSecret: required('META_APP_SECRET'),
    redirectUri: required('META_REDIRECT_URI'),
  },

  instagram: {
    apiVersion: process.env.INSTAGRAM_API_VERSION || 'v25.0',
    apiBaseUrl: process.env.INSTAGRAM_API_BASE_URL || 'https://graph.instagram.com',
    oauthAuthorizeUrl:
      process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL || 'https://api.instagram.com/oauth/authorize',
    oauthTokenUrl:
      process.env.INSTAGRAM_OAUTH_TOKEN_URL || 'https://api.instagram.com/oauth/access_token',
    scopes:
      process.env.INSTAGRAM_OAUTH_SCOPES ||
      'instagram_business_basic,instagram_business_content_publish',
  },

  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),

  // Temporary until real authentication exists (see README > Roadmap).
  defaultUserId: process.env.DEFAULT_USER_ID || 'temp-user-1',
};

module.exports = env;
