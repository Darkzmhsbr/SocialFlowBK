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

// --- Rodada 11: admin page ------------------------------------------------

// GET /api/invites/all -> every invite of the platform, newest first, with
// a computed status: PENDING | USED | EXPIRED
const listAll = async (req, res) => {
  const invites = await inviteService.listAll();
  return ok(res, {
    invites: invites.map((invite) => ({
      ...inviteService.toPublicShape(invite),
      status: inviteService.statusOf(invite),
      createdBy: invite.createdBy ? { id: invite.createdBy.id, email: invite.createdBy.email } : null,
    })),
  });
};

// DELETE /api/invites/:id -> revoke an unused invite (used ones are history)
const revoke = async (req, res) => {
  const result = await inviteService.revoke(req.params.id);
  return ok(res, { revoked: result });
};

module.exports = { create, list };

// Rodada 11: appended so the original export line stays untouched.
module.exports.listAll = listAll;
module.exports.revoke = revoke;