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
//
// Rodada 10: if the user registered his own Instagram app (App Meta page),
// the whole flow (authorize URL + token exchanges) uses HIS app. The state
// remembers which app started the flow, so the callback finishes it with
// the same app.

const crypto = require('crypto');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');
// Rodada 10: user's own Meta app.
const metaAppService = require('./metaAppService');

// state -> { userId, expiresAt }
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Rodada 20: copied link (multilogin, opened in another browser) lives 5 min.
const EXTERNAL_STATE_TTL_MS = 5 * 60 * 1000;

/**
 * Kick off an OAuth flow for a specific user. Returns the URL the browser
 * should be redirected to. Callers MUST pass the id of the user who
 * initiated the flow (typically req.userId from requireAuth) - it's what
 * the callback uses to know whose InstagramAccount to create.
 */
// Rodada 10: now async (looks up the user's own app). Callers await it.
// Rodada 20: options.external = link copied to be opened in another browser
// (Dolphin/multilogin). The callback then shows a public "done" page
// instead of the dashboard (that browser is not logged in the panel).
async function startOAuthFlow(userId, { external = false } = {}) {
  if (!userId) {
    throw new AppError(
      ErrorCodes.UNAUTHORIZED,
      'Sessão necessária para iniciar conexão com Instagram.',
      401
    );
  }

  const state = crypto.randomBytes(24).toString('hex');
  // Rodada 10: own app, if configured (null = default app).
  const ownApp = await metaAppService.getAppForUser(userId);
  const expiresAt = Date.now() + (external ? EXTERNAL_STATE_TTL_MS : STATE_TTL_MS); // Rodada 20
  pendingStates.set(state, {
    userId,
    expiresAt, // Rodada 20: was Date.now() + STATE_TTL_MS
    metaAppCredentialId: ownApp?.credentialId || null,
    external: Boolean(external), // Rodada 20
  });

  // Opportunistic cleanup so the Map doesn't grow forever if a user
  // abandons the flow. Cheap - runs on every start.
  purgeExpiredStates();

  const url = instagramApiClient.buildAuthorizationUrl(state, ownApp); // Rodada 10: was (state)
  logger.info('Instagram OAuth started', { userId, state, ownApp: Boolean(ownApp), external: Boolean(external) });
  return { url, state, expiresAt: new Date(expiresAt) }; // Rodada 20: + expiresAt
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
    const expired = new AppError(
      ErrorCodes.TOKEN_EXPIRED,
      'Tempo para completar a autenticação expirou. Tente novamente.',
      400
    );
    expired.external = Boolean(entry.external); // Rodada 20
    throw expired;
  }
  // Rodada 10: also returns which app started the flow.
  // Rodada 20: + external (copied link)
  return {
    userId: entry.userId,
    metaAppCredentialId: entry.metaAppCredentialId || null,
    external: Boolean(entry.external),
  };
}

/**
 * Rodada 20: the user cancelled on Meta's screen. Throws the state away and
 * tells the callback whether it was a copied (external) link.
 */
function discardState(state) {
  if (!state) return null;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  return entry ? { external: Boolean(entry.external) } : null;
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
async function completeOAuthFlow(code, { metaAppCredentialId = null } = {}) { // Rodada 10: was (code)
  logger.info('Instagram token exchange started', { ownApp: Boolean(metaAppCredentialId) });
  // Rodada 10: finish with the same app that started the flow.
  const app = metaAppCredentialId ? await metaAppService.getAppByCredentialId(metaAppCredentialId) : null;
  if (metaAppCredentialId && !app) {
    throw new AppError(
      ErrorCodes.META_APP_INVALID,
      'O app Meta usado nesta conexão foi removido. Tente conectar de novo.',
      400
    );
  }
  const shortLived = await instagramApiClient.exchangeCodeForShortLivedToken(code, app); // Rodada 10: + app
  const longLived = await instagramApiClient.exchangeForLongLivedToken(shortLived.accessToken, app); // Rodada 10: + app
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

module.exports = { startOAuthFlow, consumeState, completeOAuthFlow, discardState }; // Rodada 20: + discardState