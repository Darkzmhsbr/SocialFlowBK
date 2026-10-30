// Rodada 11: /api/admin/* — tells the frontend whether the logged-in user
// is a platform admin (to show the "Convites" menu). The real protection
// is requireAdmin on the admin endpoints themselves.
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const { isAdminEmail } = require('../middleware/requireAdmin');
const { ok } = require('../utils/apiResponse');

const router = Router();

router.use(requireAuth);

// GET /api/admin/me -> { isAdmin }
router.get(
  '/me',
  asyncHandler(async (req, res) => ok(res, { isAdmin: isAdminEmail(req.user?.email) }))
);

module.exports = router;