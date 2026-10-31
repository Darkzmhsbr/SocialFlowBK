const env = require('../config/env');
const authService = require('../services/instagram/instagramAuthService');
const accountService = require('../services/instagram/instagramAccountService');
const accountStatusService = require('../services/instagram/accountStatusService');
const { ok, fail } = require('../utils/apiResponse');
const { AppError, ErrorCodes } = require('../utils/errors');
const logger = require('../utils/logger');
// Rodada 10: own Meta app per user.
const metaAppService = require('../services/instagram/metaAppService');

// GET /api/instagram/authorize-url  (requires auth)
// Returns { url } for the frontend to redirect to. Replaces the old
// GET /connect that used to redirect directly - that pattern doesn't
// work anymore because the browser navigation drops the Bearer token,
// so the server had no way to know who started the flow.
// Rodada 20: ?mode=external -> link to copy and open in another browser
// (Dolphin/multilogin). It expires in 5 minutes and, at the end, shows the
// public page /connected instead of the dashboard.
const getAuthorizeUrl = async (req, res) => {
  const external = req.query.mode === 'external'; // Rodada 20
  const { url, expiresAt } = await authService.startOAuthFlow(req.userId, { external }); // Rodada 10: now async
  return ok(res, { url, expiresAt, external }); // Rodada 20: + expiresAt, external
};

// Rodada 20: where the browser goes after the callback.
//   external link  -> public page /connected (works without being logged in)
//   same tab       -> dashboard, exactly as before
function callbackRedirect(external, status, username) {
  if (external) {
    const q = new URLSearchParams({ status });
    if (username) q.set('username', username);
    return `${env.frontendUrl}/connected?${q.toString()}`;
  }
  return `${env.frontendUrl}/dashboard?instagram=${status}`;
}

// GET /api/instagram/callback?code=...&state=...
// Public route (Meta calls it with no Authorization header). The user is
// recovered from the pending state map keyed by the `state` we generated.
// Registered as META_REDIRECT_URI in Meta App Dashboard.
const handleCallback = async (req, res) => {
  const { code, state, error, error_reason: errorReason, error_description: errorDescription } = req.query;

  if (error) {
    // User denied on Meta's screen. Bounce them back with a query param
    // the dashboard already knows how to render.
    logger.warn('Instagram OAuth denied or cancelled', {
      error,
      errorReason,
      errorDescription,
      requestId: req.requestId,
    });
    const discarded = authService.discardState(state); // Rodada 20
    return res.redirect(callbackRedirect(discarded?.external, 'denied')); // Rodada 20: was `${env.frontendUrl}/dashboard?instagram=denied`
  }

  // Rodada 10: which app started this flow (null = default app).
  let stateInfo = null;
  try {
    stateInfo = authService.consumeState(state); // Rodada 10: was const { userId } = ...
    const { userId } = stateInfo;
    if (!code) {
      throw new AppError(ErrorCodes.INVALID_CODE, 'Código de autorização ausente.', 400);
    }

    logger.info('Instagram OAuth callback received', { requestId: req.requestId });

    const { accessToken, tokenExpiresAt } = await authService.completeOAuthFlow(code, {
      metaAppCredentialId: stateInfo.metaAppCredentialId,
    }); // Rodada 10: was completeOAuthFlow(code)
    const connected = await accountService.connectAndStoreAccount({ // Rodada 20: keeps the result (username)
      userId,
      accessToken,
      tokenExpiresAt,
      metaAppCredentialId: stateInfo.metaAppCredentialId,
    }); // Rodada 10: + metaAppCredentialId
    // Rodada 10: first successful connection proves the user's app works.
    if (stateInfo.metaAppCredentialId) {
      await metaAppService.markVerified(stateInfo.metaAppCredentialId);
    }

    return res.redirect(callbackRedirect(stateInfo.external, 'connected', connected?.username)); // Rodada 20: was `${env.frontendUrl}/dashboard?instagram=connected`
  } catch (err) {
    // Instead of returning a JSON error (Meta redirected the browser here,
    // so the user is watching), send them back to the dashboard with an
    // error marker. Full details are logged server-side.
    logger.error('Instagram token exchange failed', {
      requestId: req.requestId,
      message: err.message,
    });
    // Rodada 10: show the failure on the App Meta page of that user.
    if (stateInfo?.metaAppCredentialId) {
      await metaAppService.recordError(stateInfo.metaAppCredentialId, err).catch(() => {});
    }
    // Rodada 20: link expired/already used -> public page explains it
    // (works in any browser, logged in or not).
    if (!stateInfo) {
      return res.redirect(`${env.frontendUrl}/connected?status=expired`);
    }
    return res.redirect(callbackRedirect(stateInfo.external, 'error')); // Rodada 20: was `${env.frontendUrl}/dashboard?instagram=error`
  }
};

// GET /api/instagram/accounts  (requires auth)
const listAccounts = async (req, res) => {
  const accounts = await accountService.listAccounts(req.userId);
  return ok(res, { accounts: accounts.map(accountService.toPublicShape) });
};

// GET /api/instagram/accounts/:id  (requires auth)
const getAccount = async (req, res) => {
  // Rodada 14: only the owner can read the account.
  const account = await accountService.getAccount(req.params.id, req.userId);
  return ok(res, { account: accountService.toPublicShape(account) });
};

// GET /api/instagram/accounts/:id/status  (requires auth)
// Everything the frontend "Status da conta" page needs in one shot:
// identity, counters, last published preview, and best-effort live
// Meta metrics (which may be null if the token/scope can't fetch them).
const getAccountStatus = async (req, res) => {
  const status = await accountStatusService.getAccountStatus({
    accountId: req.params.id,
    userId: req.userId,
  });
  return ok(res, status);
};

// DELETE /api/instagram/accounts/:id  (requires auth)
const disconnectAccount = async (req, res) => {
  await accountService.disconnectAccount({
    accountId: req.params.id,
    userId: req.userId,
  });
  return ok(res, { disconnected: true });
};

module.exports = {
  getAuthorizeUrl,
  handleCallback,
  listAccounts,
  getAccount,
  getAccountStatus,
  disconnectAccount,
};