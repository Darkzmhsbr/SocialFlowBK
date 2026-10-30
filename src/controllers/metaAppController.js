// Rodada 10: /api/instagram/meta-app — user's own Instagram app.
const metaAppService = require('../services/instagram/metaAppService');
const { ok } = require('../utils/apiResponse');

// GET /api/instagram/meta-app
// -> { credential: { appId, secretLast4, status, ... } | null, redirectUri, usingOwnApp, accounts }
const getStatus = async (req, res) => {
  const status = await metaAppService.getStatus(req.userId);
  return ok(res, status);
};

// PUT /api/instagram/meta-app  { appId, appSecret? }
const saveCredentials = async (req, res) => {
  const credential = await metaAppService.saveCredentials(req.userId, req.body || {});
  return ok(res, { credential });
};

// DELETE /api/instagram/meta-app  -> back to the default app
const removeCredentials = async (req, res) => {
  const result = await metaAppService.removeCredentials(req.userId);
  return ok(res, result);
};

module.exports = { getStatus, saveCredentials, removeCredentials };