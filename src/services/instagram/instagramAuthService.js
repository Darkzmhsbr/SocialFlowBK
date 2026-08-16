// Owns the OAuth handshake with Instagram. Two entry points:
//   startOAuthFlow(userId) - front asks for the authorize URL; we make one
//     and stash the corresponding `state` value in memory tied to the user
//     who initiated it. Meta redirects the browser to that URL.
//   consumeState(state)    - Meta redirects back to our /callback with the
//     same state; we verify + look up which user started it. Meta doesn't
//     send our JWT (no Bearer on that redirect), so the state itself is
//     the vehicle that carries the userId across the OAuth boundary.
//   completeOAuthFlow(code) - exchanges the auth code for a long-lived
//     token and returns the pieces the controller needs to persist an
//     InstagramAccount for the right user.
//
// pendingStates is in-memory. In a multi-instance setup we'd move it to
// Redis, but Railway's single instance model makes this safe for now.

const crypto = require('crypto');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

// state -> { userId, expiresAt }
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Kick off an OAuth flow for a specific user. Returns the URL the browser
 * should be redirected to. Callers MUST pass the id of the user who
 * initiated the flow (typically req.userId from requireAuth) - it's what
 * the callback uses to know whose InstagramAccount to create.
 */
function startOAuthFlow(userId) {
  if (!userId) {
    throw new AppError(
      ErrorCodes.UNAUTHORIZED,
      'Sessão necessária para iniciar conexão com Instagram.',
      401
    );
  }

  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, {
    userId,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  // Opportunistic cleanup so the Map doesn't grow forever if a user
  // abandons the flow. Cheap - runs on every start.
  purgeExpiredStates();

  const url = instagramApiClient.buildAuthorizationUrl(state);
  logger.info('Instagram OAuth started', { userId, state });
  return { url, state };
}

/**
 * Called by the /callback handler. Returns the userId that started this
 * flow (so we know where to save the resulting InstagramAccount), or
 * throws if the state is missing, expired, or reused.
 */
function consumeState(state) {
  if (!state) {
    throw new AppError(ErrorCodes.INVALID_TOKEN, 'Parâmetro state ausente no callback.', 400);
  }
  const entry = pendingStates.get(state);
  pendingStates.delete(state);

  if (!entry) {
    throw new AppError(ErrorCodes.INVALID_TOKEN, 'State inválido ou já utilizado.', 400);
  }
  if (entry.expiresAt <= Date.now()) {
    throw new AppError(
      ErrorCodes.TOKEN_EXPIRED,
      'Tempo para completar a autenticação expirou. Tente novamente.',
      400
    );
  }
  return { userId: entry.userId };
}

function purgeExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates.entries()) {
    if (entry.expiresAt <= now) pendingStates.delete(state);
  }
}

/**
 * Exchange the auth code from the callback for a long-lived access token
 * and the profile metadata we need to store the InstagramAccount.
 */
async function completeOAuthFlow(code) {
  logger.info('Instagram token exchange started');
  const shortLived = await instagramApiClient.exchangeCodeForShortLivedToken(code);
  const longLived = await instagramApiClient.exchangeForLongLivedToken(shortLived.accessToken);
  const profile = await instagramApiClient.fetchAuthorizedProfile(longLived.accessToken);
  const tokenExpiresAt = new Date(Date.now() + longLived.expiresInSeconds * 1000);

  logger.info('Instagram account retrieved', {
    instagramUserId: profile.id,
    username: profile.username,
  });

  return {
    accessToken: longLived.accessToken,
    tokenExpiresAt,
    profile,
  };
}

module.exports = { startOAuthFlow, consumeState, completeOAuthFlow };