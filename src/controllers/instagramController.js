const env = require('../config/env');
const authService = require('../services/instagram/instagramAuthService');
const accountService = require('../services/instagram/instagramAccountService');
const { ok, fail } = require('../utils/apiResponse');
const { AppError, ErrorCodes } = require('../utils/errors');

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
const handleCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    // User denied on Meta's screen. Bounce them back with a query param
    // the dashboard already knows how to render.
    return res.redirect(`${env.frontendUrl}/dashboard?instagram=denied`);
  }

  try {
    const { userId } = authService.consumeState(state);
    if (!code) {
      throw new AppError(ErrorCodes.INVALID_CODE, 'Código de autorização ausente.', 400);
    }

    const { accessToken, tokenExpiresAt } = await authService.completeOAuthFlow(code);
    await accountService.connectAndStoreAccount({ userId, accessToken, tokenExpiresAt });

    return res.redirect(`${env.frontendUrl}/dashboard?instagram=connected`);
  } catch (err) {
    // Instead of returning a JSON error (Meta redirected the browser here,
    // so the user is watching), send them back to the dashboard with an
    // error marker. Full details are logged server-side.
    // eslint-disable-next-line no-console
    console.error('[instagram/callback] failed', err);
    return res.redirect(`${env.frontendUrl}/dashboard?instagram=error`);
  }
};

// GET /api/instagram/accounts  (requires auth)
const listAccounts = async (req, res) => {
  const accounts = await accountService.listAccounts(req.userId);
  return ok(res, { accounts: accounts.map(accountService.toPublicShape) });
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
  disconnectAccount,
};