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
};

module.exports = env;