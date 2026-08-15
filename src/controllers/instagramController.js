const env = require('../config/env');
const authService = require('../services/instagram/instagramAuthService');
const accountService = require('../services/instagram/instagramAccountService');
const { ok } = require('../utils/apiResponse');
const { AppError, ErrorCodes } = require('../utils/errors');
const logger = require('../utils/logger');

// GET /api/instagram/connect
// Starts the official Meta/Instagram login flow. The frontend never builds
// this URL itself - it just redirects the browser here.
function connect(req, res) {
  const authorizationUrl = authService.createAuthorizationUrl();
  return res.redirect(authorizationUrl);
}

// GET /api/instagram/callback
// This is the URL registered in Meta App Dashboard as the Redirect URI.
// Meta sends the user's browser here after they approve (or deny) access.
async function callback(req, res, next) {
  const { code, state, error, error_reason: errorReason } = req.query;

  try {
    if (error) {
      logger.warn('Instagram OAuth denied or cancelled', { error, errorReason, requestId: req.requestId });
      return redirectWithStatus(res, 'denied');
    }

    if (!code || !state) {
      throw new AppError(ErrorCodes.INVALID_CODE, 'Retorno de autorização inválido.', 400);
    }

    if (!authService.consumeState(state)) {
      throw new AppError(ErrorCodes.INVALID_TOKEN, 'Sessão de autorização expirada ou inválida.', 400);
    }

    logger.info('Instagram OAuth callback received', { requestId: req.requestId });

    const { instagramUserId, accessToken, tokenExpiresAt } = await authService.completeOAuthFlow(code);

    await accountService.connectAndStoreAccount({
      userId: env.defaultUserId,
      instagramUserId,
      accessToken,
      tokenExpiresAt,
    });

    return redirectWithStatus(res, 'connected');
  } catch (err) {
    logger.error('Instagram token exchange failed', {
      requestId: req.requestId,
      message: err.message,
    });
    // User-facing failures still redirect to the dashboard (with an error
    // flag) instead of showing a raw JSON error or Meta's own error page.
    return redirectWithStatus(res, 'error');
  }
}

function redirectWithStatus(res, status) {
  const url = new URL('/dashboard', env.frontendUrl);
  url.searchParams.set('instagram', status);
  return res.redirect(url.toString());
}

// GET /api/instagram/accounts
const listAccounts = async (req, res) => {
  const accounts = await accountService.listAccounts(env.defaultUserId);
  return ok(res, { accounts: accounts.map(accountService.toPublicShape) });
};

// GET /api/instagram/accounts/:id
const getAccount = async (req, res) => {
  const account = await accountService.getAccount(req.params.id);
  return ok(res, { account: accountService.toPublicShape(account) });
};

// DELETE /api/instagram/accounts/:id
const deleteAccount = async (req, res) => {
  await accountService.disconnectAccount(req.params.id);
  return ok(res, { message: 'Conta desconectada com sucesso.' });
};

module.exports = { connect, callback, listAccounts, getAccount, deleteAccount };
