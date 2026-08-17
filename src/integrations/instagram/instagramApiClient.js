// This is the ONLY file in the project that knows Meta's actual URLs.
// Every service that needs to talk to Instagram goes through here.
// If Meta changes an endpoint, a scope name, or a version, this is the one
// place to fix it - controllers, routes and the frontend stay untouched.
//
// Flow implemented (per Meta's official "Instagram API with Instagram Login"
// / Business Login docs, verified Aug 2026):
//   1. Build authorization URL          -> www.instagram.com/oauth/authorize
//   2. Exchange code for short-lived token -> api.instagram.com/oauth/access_token
//   3. Exchange short-lived for long-lived -> graph.instagram.com/access_token
//   4. Refresh a long-lived token        -> graph.instagram.com/refresh_access_token
//   5. Fetch the authorized account's profile -> graph.instagram.com/me
//   6. Create media container            -> graph.instagram.com/{version}/{ig-user-id}/media
//   7. Poll container status             -> graph.instagram.com/{version}/{creation-id}?fields=status_code
//   8. Publish the container             -> graph.instagram.com/{version}/{ig-user-id}/media_publish
//   9. Fetch media insights (Rodada 3)   -> graph.instagram.com/{version}/{media-id}/insights
//
// Data-plane calls use graph.instagram.com (Instagram Login flow host).
// The old graph.facebook.com host belongs to the separate "Facebook Login
// for Business" flow and is intentionally not used here.
//
// IMPORTANT: the token exchange endpoint REQUIRES multipart/form-data (as
// shown in Meta's own curl -F example). Sending application/x-www-form-urlencoded
// makes the endpoint return a misleading "Error validating verification code.
// Please make sure your redirect_uri is identical..." even when the redirect_uri
// is byte-for-byte correct. Use FormData and let axios set the Content-Type
// with the proper multipart boundary.

const axios = require('axios');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const { instagram: igConfig, meta: metaConfig } = env;

// Publishing / container endpoints require a versioned base. The older
// OAuth / profile calls have worked without a version so we don't touch
// them, but every new publish endpoint below goes through apiBase().
function apiBase() {
  return igConfig.apiVersion
    ? `${igConfig.apiBaseUrl}/${igConfig.apiVersion}`
    : igConfig.apiBaseUrl;
}

function buildAuthorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: metaConfig.appId,
    redirect_uri: metaConfig.redirectUri,
    response_type: 'code',
    scope: igConfig.scopes,
    state,
  });
  const url = `${igConfig.oauthAuthorizeUrl}?${params.toString()}`;
  console.log('========== INSTAGRAM AUTHORIZE URL ==========');
  console.log('AUTHORIZE HOST:', igConfig.oauthAuthorizeUrl);
  console.log('REDIRECT URI IN AUTHORIZE:', metaConfig.redirectUri);
  console.log('=============================================');
  return url;
}

async function exchangeCodeForShortLivedToken(code) {
  try {
    // Meta's token endpoint expects multipart/form-data, NOT
    // application/x-www-form-urlencoded. See the comment at the top of this
    // file for the (poorly documented) reason.
    const form = new FormData();
    form.append('client_id', metaConfig.appId);
    form.append('client_secret', metaConfig.appSecret);
    form.append('grant_type', 'authorization_code');
    form.append('redirect_uri', metaConfig.redirectUri);
    form.append('code', code);

    const { data } = await axios.post(igConfig.oauthTokenUrl, form, {
      // No Content-Type header on purpose: axios sets it to
      // "multipart/form-data; boundary=..." automatically when the body is a
      // FormData instance. Setting it manually here would strip the boundary
      // and break the request.
      timeout: 10000,
    });

    // Meta returns { data: [{ access_token, user_id, permissions }] } or
    // { access_token, user_id } depending on flow variant - normalize both.
    const payload = Array.isArray(data?.data) ? data.data[0] : data;
    return {
      accessToken: payload.access_token,
      instagramUserId: String(payload.user_id),
      permissions: payload.permissions || [],
    };
  } catch (error) {
    console.error('========== INSTAGRAM TOKEN EXCHANGE ERROR ==========');
    console.error('HTTP STATUS:', error.response?.status);
    console.error('META RESPONSE:', JSON.stringify(error.response?.data, null, 2));
    console.error('ERROR MESSAGE:', error.message);
    console.error('REQUEST URL:', igConfig.oauthTokenUrl);
    console.error('REDIRECT URI SENT:', metaConfig.redirectUri);
    console.error('CLIENT ID SENT:', metaConfig.appId);
    console.error('CLIENT SECRET LENGTH:', metaConfig.appSecret?.length);
    console.error('CODE LENGTH:', code?.length, 'CODE TAIL:', code?.slice(-6));
    console.error('====================================================');
    throw toAppError(error, 'Failed to exchange authorization code for token');
  }
}

async function exchangeForLongLivedToken(shortLivedToken) {
  try {
    const { data } = await axios.get(`${igConfig.apiBaseUrl}/access_token`, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: metaConfig.appSecret,
        access_token: shortLivedToken,
      },
      timeout: 10000,
    });

    return {
      accessToken: data.access_token,
      expiresInSeconds: data.expires_in, // ~60 days
    };
  } catch (error) {
    throw toAppError(error, 'Failed to exchange short-lived token for long-lived token');
  }
}

async function refreshLongLivedToken(currentToken) {
  try {
    const { data } = await axios.get(`${igConfig.apiBaseUrl}/refresh_access_token`, {
      params: {
        grant_type: 'ig_refresh_token',
        access_token: currentToken,
      },
      timeout: 10000,
    });

    return {
      accessToken: data.access_token,
      expiresInSeconds: data.expires_in,
    };
  } catch (error) {
    throw toAppError(error, 'Failed to refresh long-lived token');
  }
}

async function fetchAuthorizedProfile(accessToken) {
  try {
    const { data } = await axios.get(`${igConfig.apiBaseUrl}/me`, {
      params: {
        fields: 'id,username,name,account_type,profile_picture_url',
        access_token: accessToken,
      },
      timeout: 10000,
    });

    return data;
  } catch (error) {
    throw toAppError(error, 'Failed to fetch Instagram profile');
  }
}

// --- Phase 2.2a: Content Publishing --------------------------------------

/**
 * Create a media container. This is step 1 of Instagram's publish flow.
 * The container is just a "recipe" that references the media URL; it isn't
 * live on the profile yet. Returns the creation id used to poll status
 * and, eventually, to publish.
 *
 * @param {string} igUserId     - InstagramAccount.instagramUserId
 * @param {object} params       - { image_url?, video_url?, caption?, media_type?, is_carousel_item?, children? }
 * @param {string} accessToken  - decrypted long-lived token for the account
 * @returns {Promise<{ creationId: string }>}
 */
async function createMediaContainer(igUserId, params, accessToken) {
  try {
    const { data } = await axios.post(
      `${apiBase()}/${igUserId}/media`,
      null,
      {
        params: { ...params, access_token: accessToken },
        timeout: 30000,
      }
    );

    if (!data?.id) {
      throw new AppError(
        ErrorCodes.INSTAGRAM_MEDIA_ERROR,
        'Instagram não retornou id de container.',
        502,
        { response: data }
      );
    }

    return { creationId: String(data.id) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw toAppError(error, 'Failed to create Instagram media container');
  }
}

/**
 * Poll a container's status. Instagram processes uploads async; images are
 * usually FINISHED within a second, videos can take a while. Callers wrap
 * this in a poll loop with a timeout (see instagramMediaService).
 *
 * Possible status codes:
 *   - IN_PROGRESS  : still processing (keep polling)
 *   - FINISHED     : ready to publish
 *   - ERROR        : Meta rejected the media (aspect ratio, format, ...)
 *   - EXPIRED      : the container aged out and can no longer be published
 *   - PUBLISHED    : already published (should not normally see this)
 */
async function getMediaContainerStatus(creationId, accessToken) {
  try {
    const { data } = await axios.get(`${apiBase()}/${creationId}`, {
      params: {
        fields: 'status_code,status',
        access_token: accessToken,
      },
      timeout: 15000,
    });

    return {
      statusCode: data.status_code,
      statusMessage: data.status || null,
    };
  } catch (error) {
    throw toAppError(error, 'Failed to fetch Instagram media container status');
  }
}

/**
 * Publish a container that finished processing. On success Instagram
 * returns the id of the actual live post, which we store as
 * ScheduledPost.instagramMediaId for later analytics fetching.
 */
async function publishMediaContainer(igUserId, creationId, accessToken) {
  try {
    const { data } = await axios.post(
      `${apiBase()}/${igUserId}/media_publish`,
      null,
      {
        params: { creation_id: creationId, access_token: accessToken },
        timeout: 30000,
      }
    );

    if (!data?.id) {
      throw new AppError(
        ErrorCodes.INSTAGRAM_PUBLISH_FAILED,
        'Instagram não retornou id do post publicado.',
        502,
        { response: data }
      );
    }

    return { mediaId: String(data.id) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw toAppError(error, 'Failed to publish Instagram media container');
  }
}

// --- Rodada 3: Insights / Metrics ----------------------------------------

/**
 * Fetch insights (metrics) for a single published media.
 *
 * Meta's /{media-id}/insights endpoint returns an array of metric objects:
 *   { data: [{ name: "reach", values: [{ value: 42 }] }, ...] }
 *
 * Quirks/notes:
 *   - `impressions` was deprecated July 2024 — DO NOT request it.
 *   - `views` is only available for VIDEO/REEL, not IMAGE/CAROUSEL.
 *   - Story insights are only available for 24h after publishing.
 *   - Metrics for very new posts (<30 min) often return all zeros.
 *   - Requires scope `instagram_business_manage_insights`.
 *
 * @param {string} mediaId       - ScheduledPost.instagramMediaId
 * @param {string} accessToken   - decrypted long-lived token
 * @param {string[]} metrics     - list of metric names to request
 * @returns {Promise<Object<string, number>>}  e.g. { reach: 42, likes: 5 }
 */
async function fetchMediaInsights(mediaId, accessToken, metrics) {
  try {
    const { data } = await axios.get(`${apiBase()}/${mediaId}/insights`, {
      params: {
        metric: metrics.join(','),
        access_token: accessToken,
      },
      timeout: 15000,
    });

    // Normalize Meta's verbose { data: [{ name, values: [{value}] }] }
    // into a flat { metricName: number } object for easy consumption.
    const result = {};
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        const value = item.values?.[0]?.value;
        result[item.name] = typeof value === 'number' ? value : 0;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw toAppError(error, 'Failed to fetch Instagram media insights');
  }
}

function toAppError(error, contextMessage) {
  const metaError = error.response?.data?.error;

  logger.error(contextMessage, {
    metaErrorCode: metaError?.code,
    metaErrorType: metaError?.type,
    metaErrorMessage: metaError?.message,
    httpStatus: error.response?.status,
  });

  if (error.code === 'ECONNABORTED') {
    return new AppError(ErrorCodes.TIMEOUT, 'A comunicação com o Instagram excedeu o tempo limite.', 504);
  }

  if (metaError) {
    return new AppError(
      ErrorCodes.META_API_ERROR,
      'O Instagram recusou a solicitação.',
      error.response.status || 502,
      metaError
    );
  }

  return new AppError(ErrorCodes.META_API_ERROR, 'Não foi possível comunicar com o Instagram.', 502);
}

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  refreshLongLivedToken,
  fetchAuthorizedProfile,
  createMediaContainer,
  getMediaContainerStatus,
  publishMediaContainer,
  fetchMediaInsights,
};