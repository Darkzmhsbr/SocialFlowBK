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

function bool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true';
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

  // Cloudinary hosts every uploaded image/video. The public HTTPS URL it
  // returns is what Instagram fetches at publish time. Only the backend
  // knows the api_secret - the frontend never sees it.
  cloudinary: {
    cloudName: required('CLOUDINARY_CLOUD_NAME'),
    apiKey: required('CLOUDINARY_API_KEY'),
    apiSecret: required('CLOUDINARY_API_SECRET'),
    // Folder where every asset gets nested. Individual users are further
    // separated by userId subfolder inside the service layer.
    rootFolder: process.env.CLOUDINARY_ROOT_FOLDER || 'socialflow',
  },

  // Upload limits enforced by multer + the media service. Kept conservative
  // to stay well under Instagram's own limits (8MB image, ~100MB video for
  // reels) and to avoid surprises on Railway's request timeout.
  uploads: {
    maxImageBytes: Number(process.env.UPLOAD_MAX_IMAGE_BYTES) || 10 * 1024 * 1024, // 10 MB
    maxVideoBytes: Number(process.env.UPLOAD_MAX_VIDEO_BYTES) || 100 * 1024 * 1024, // 100 MB
    allowedImageMimes: ['image/jpeg', 'image/jpg', 'image/png'],
    allowedVideoMimes: ['video/mp4', 'video/quicktime'],
  },

  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),

  // Temporary until real authentication exists (see README > Roadmap).
  defaultUserId: process.env.DEFAULT_USER_ID || 'temp-user-1',

  // Phase 2.2a - publish worker settings. The worker runs inside the same
  // Node process as the API (no separate service on Railway). WORKER_ENABLED
  // lets you turn it off in local dev to test manually.
  worker: {
    enabled: bool('WORKER_ENABLED', true),
    // How often the cron ticks. Set to 30s so a "publish at 10:00:00" post
    // goes out between 10:00:00 and 10:00:30 in the worst case.
    intervalSeconds: Number(process.env.WORKER_INTERVAL_SECONDS) || 30,
    // How many posts each tick tries to publish. Keep small so a slow batch
    // doesn't block the next tick for too long.
    batchSize: Number(process.env.WORKER_BATCH_SIZE) || 5,
    // How many times a single post retries on transient errors before giving
    // up and being marked FAILED.
    maxRetries: Number(process.env.WORKER_MAX_RETRIES) || 3,
    // Instagram video containers can take a while to process. Poll with a
    // hard cap so a stuck job doesn't hold a worker slot forever.
    pollTimeoutMs: Number(process.env.WORKER_POLL_TIMEOUT_MS) || 90 * 1000, // 90 s
    pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS) || 3000, // 3 s
  },
};

module.exports = env;