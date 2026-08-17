const env = require('../config/env');
const authService = require('../services/instagram/instagramAuthService');
const accountService = require('../services/instagram/instagramAccountService');
const accountStatusService = require('../services/instagram/accountStatusService');
const { ok, fail } = require('../utils/apiResponse');
const { AppError, ErrorCodes } = require('../utils/errors');
const logger = require('../utils/logger');

// GET /api/instagram/authorize-url  (requires auth)
// Returns { url } for the frontend to redirect to. Replaces the old
// GET /connect that used to redirect directly - that pattern doesn't
// work anymore because the browser navigation drops the Bearer token,
// so the server had no way to know who started the flow.
const getAuthorizeUrl = async (req, res) => {
  const { url } = authService.startOAuthFlow(req.userId);
  return ok(res, { url });
};

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
    return res.redirect(`${env.frontendUrl}/dashboard?instagram=denied`);
  }

  try {
    const { userId } = authService.consumeState(state);
    if (!code) {
      throw new AppError(ErrorCodes.INVALID_CODE, 'Código de autorização ausente.', 400);
    }

    logger.info('Instagram OAuth callback received', { requestId: req.requestId });

    const { accessToken, tokenExpiresAt } = await authService.completeOAuthFlow(code);
    await accountService.connectAndStoreAccount({ userId, accessToken, tokenExpiresAt });

    return res.redirect(`${env.frontendUrl}/dashboard?instagram=connected`);
  } catch (err) {
    // Instead of returning a JSON error (Meta redirected the browser here,
    // so the user is watching), send them back to the dashboard with an
    // error marker. Full details are logged server-side.
    logger.error('Instagram token exchange failed', {
      requestId: req.requestId,
      message: err.message,
    });
    return res.redirect(`${env.frontendUrl}/dashboard?instagram=error`);
  }
};

// GET /api/instagram/accounts  (requires auth)
const listAccounts = async (req, res) => {
  const accounts = await accountService.listAccounts(req.userId);
  return ok(res, { accounts: accounts.map(accountService.toPublicShape) });
};

// GET /api/instagram/accounts/:id  (requires auth)
const getAccount = async (req, res) => {
  const account = await accountService.getAccount(req.params.id);
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