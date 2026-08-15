const crypto = require('crypto');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const logger = require('../../utils/logger');

// One in-memory store for OAuth `state` values, mapping state -> expiry.
// This is enough for a single-instance MVP to prevent CSRF on the callback.
// If the backend scales to multiple instances, move this to Redis/DB.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function createAuthorizationUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  logger.info('Instagram OAuth started', { state });
  return instagramApiClient.buildAuthorizationUrl(state);
}

function consumeState(state) {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(expiresAt) && expiresAt > Date.now();
}

async function completeOAuthFlow(code) {
  logger.info('Instagram token exchange started');

  const shortLived = await instagramApiClient.exchangeCodeForShortLivedToken(code);
  const longLived = await instagramApiClient.exchangeForLongLivedToken(shortLived.accessToken);

  const tokenExpiresAt = new Date(Date.now() + longLived.expiresInSeconds * 1000);

  return {
    instagramUserId: shortLived.instagramUserId,
    accessToken: longLived.accessToken,
    tokenExpiresAt,
    permissions: shortLived.permissions,
  };
}

module.exports = { createAuthorizationUrl, consumeState, completeOAuthFlow };
