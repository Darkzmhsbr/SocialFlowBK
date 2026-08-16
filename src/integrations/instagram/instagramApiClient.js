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
};