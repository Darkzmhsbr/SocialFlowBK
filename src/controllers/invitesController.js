const inviteService = require('../services/invites/inviteService');
const { ok } = require('../utils/apiResponse');

// POST /api/invites  (requires auth)
// Body: { expiresInDays?: number, note?: string }
const create = async (req, res) => {
  const { expiresInDays, note } = req.body || {};
  const invite = await inviteService.createInvite({
    createdById: req.userId,
    expiresInDays: expiresInDays ? Number(expiresInDays) : null,
    note: note || null,
  });
  return ok(res, { invite: inviteService.toPublicShape(invite) });
};

// GET /api/invites  (requires auth) - lists invites I created
const list = async (req, res) => {
  const invites = await inviteService.listByCreator(req.userId);
  return ok(res, { invites: invites.map(inviteService.toPublicShape) });
};

module.exports = { create, list };