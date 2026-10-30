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
      // Rodada 13: + instagram_business_manage_insights (Dashboard metrics).
      'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights',
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
    // Rodada 4 - how many posts publish AT THE SAME TIME. The fair claim
    // in scheduledPostRepository guarantees at most one in-flight post per
    // Instagram account, so parallelism only happens across different
    // accounts. Set WORKER_CONCURRENCY=1 to fall back to the original
    // sequential tick (rollback lever — no code change needed).
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 3),
    // Rodada 4 - posts stuck in QUEUED / PUBLISHING longer than this are
    // recovered (process died mid-publish: deploy, crash, OOM). PUBLISHING
    // uses max(this, 3x pollTimeout + 5min) so a slow carousel is never
    // mistaken for a dead one.
    staleMinutes: Number(process.env.WORKER_STALE_MINUTES) || 15,
    // Rodada 4 - before each publish, copy the media to a temporary
    // Backblaze key so every account receives a different URL. The copy
    // is deleted right after publishing. Set to false to always send the
    // original URL.
    uniqueMediaUrlPerAccount: bool('UNIQUE_MEDIA_URL_PER_ACCOUNT', true),
    // Rodada 5 - minimum gap (minutes) between two publishes on the SAME
    // account, enforced by the claim even if many posts are due at once
    // (unstaggered batch, "Publicar agora", queue released after a pause).
    // 0 disables.
    accountMinGapMinutes: Number(process.env.ACCOUNT_MIN_GAP_MINUTES ?? 3),
    // Rodada 5 - how long an account is paused after each kind of Meta
    // limit. Its posts stay SCHEDULED and resume automatically.
    rateLimitPauseMinutes: Number(process.env.RATE_LIMIT_PAUSE_MINUTES) || 30,
    publishLimitPauseMinutes: Number(process.env.PUBLISH_LIMIT_PAUSE_MINUTES) || 120,
    actionBlockPauseMinutes: Number(process.env.ACTION_BLOCK_PAUSE_MINUTES) || 360,
    // Rodada 5 - ask Meta for the account's remaining daily publish quota
    // before publishing (cached per account, ~1 call every 15 min).
    checkPublishingLimit: bool('CHECK_PUBLISHING_LIMIT', true),
  },

  // Rodada 11 - platform administrators (comma-separated e-mails). Only
  // they see/use the "Convites" page. Default keeps the owner as admin
  // even before ADMIN_EMAILS is created on Railway.
  admin: {
    emails: String(process.env.ADMIN_EMAILS || 'dark@zenyxvips.com')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  },

  // Rodada 5 - periodic account health check (detects banned/restricted
  // accounts and expired tokens even with nothing scheduled) + automatic
  // long-lived token refresh before it expires.
  // Rodada 17 - official alerts bot (one bot for the whole platform; each
  // user links their own chat/group/channel). Empty token = alerts off.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    // Optional: forces the webhook secret (default: derived from the token).
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || null,
    apiBaseUrl: process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org',
  },

  health: {
    enabled: bool('ACCOUNT_HEALTH_ENABLED', true),
    runEveryMinutes: Number(process.env.ACCOUNT_HEALTH_RUN_MINUTES) || 5,
    checkEachAccountEveryMinutes: Number(process.env.ACCOUNT_HEALTH_CHECK_MINUTES) || 30,
    accountsPerRun: Number(process.env.ACCOUNT_HEALTH_PER_RUN) || 10,
    refreshTokenDaysBeforeExpiry: Number(process.env.TOKEN_REFRESH_DAYS_BEFORE) || 10,
  },

  // Rodada 4 - multi-profile batch composer limits and stagger defaults.
  // One batch = N media items x M accounts posts.
  // Rodada 4.1: defaults raised (were 20 / 30 / 300). The frontend reads
  // these values from GET /api/posts/batch/limits, so changing the env
  // vars on Railway is enough — no frontend deploy needed.
  batch: {
    maxItems: Number(process.env.BATCH_MAX_ITEMS) || 50,
    maxAccounts: Number(process.env.BATCH_MAX_ACCOUNTS) || 50,
    maxPosts: Number(process.env.BATCH_MAX_POSTS) || 2500,
    // Window (minutes) over which the accounts of ONE item are spread.
    defaultWindowMinutes: Number(process.env.BATCH_DEFAULT_WINDOW_MINUTES) || 30,
    // Gap (minutes) between consecutive items on the SAME account.
    defaultItemIntervalMinutes: Number(process.env.BATCH_DEFAULT_ITEM_INTERVAL_MINUTES) || 30,
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