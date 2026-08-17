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

  // Cloudinary section KEPT so legacy MediaAsset rows (storageProvider =
  // CLOUDINARY) continue to work — mainly for delete calls issued by
  // deleteIfOrphan on old media. No new uploads go here anymore.
  cloudinary: {
    cloudName: required('CLOUDINARY_CLOUD_NAME'),
    apiKey: required('CLOUDINARY_API_KEY'),
    apiSecret: required('CLOUDINARY_API_SECRET'),
    // Folder where every asset gets nested. Individual users are further
    // separated by userId subfolder inside the service layer.
    rootFolder: process.env.CLOUDINARY_ROOT_FOLDER || 'socialflow',
  },

  // Backblaze B2 via its S3-compatible API. Every new MediaAsset lands
  // here from this migration onward. Public bucket + friendly URL means
  // Meta can fetch image_url / video_url / cover_url directly with no
  // signing overhead per publish.
  //
  // publicBaseUrl format is https://f<NNN>.backblazeb2.com — the NNN
  // maps to the region (e.g. f005 for us-east-005). If you migrate to
  // another region, change this env, not the code.
  backblaze: {
    endpoint: required('B2_ENDPOINT'),               // e.g. https://s3.us-east-005.backblazeb2.com
    region: required('B2_REGION'),                   // e.g. us-east-005
    keyId: required('B2_KEY_ID'),                    // Application Key keyID
    applicationKey: required('B2_APPLICATION_KEY'),  // Application Key applicationKey (secret)
    bucketName: required('B2_BUCKET_NAME'),          // e.g. socialflow-media-zenyx
    bucketId: required('B2_BUCKET_ID'),              // stored for future analytics / native B2 calls
    // Public base URL used to build the URL we save on MediaAsset.url.
    // Full URL becomes: {publicBaseUrl}/file/{bucketName}/{objectKey}
    publicBaseUrl: required('B2_PUBLIC_BASE_URL'),   // e.g. https://f005.backblazeb2.com
    // Prefix for every object key we upload. Individual users are further
    // separated by userId subfolder inside the service layer.
    rootFolder: process.env.B2_ROOT_FOLDER || 'socialflow',
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

  // Phase 3.1 - authentication. jwtSecret should be a long random string;
  // rotating it invalidates every issued token, which is fine during beta
  // but requires a "everyone logs in again" migration later.
  auth: {
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 10,
  },
};

module.exports = env;