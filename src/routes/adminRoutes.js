// Rodada 11: /api/admin/* — tells the frontend whether the logged-in user
// is a platform admin (to show the "Convites" menu). The real protection
// is requireAdmin on the admin endpoints themselves.
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const { isAdminEmail } = require('../middleware/requireAdmin');
// Rodada 21: users + storage limits (admin only)
const requireAdmin = require('../middleware/requireAdmin');
const adminUsersController = require('../controllers/adminUsersController');
const { ok } = require('../utils/apiResponse');

const router = Router();

router.use(requireAuth);

// GET /api/admin/me -> { isAdmin }
router.get(
  '/me',
  asyncHandler(async (req, res) => ok(res, { isAdmin: isAdminEmail(req.user?.email) }))
);

// Rodada 21: page "Usuários" — storage usage, quotas and platform rules.
router.get('/users', requireAdmin, asyncHandler(adminUsersController.listUsers));
router.patch('/users/:id/quota', requireAdmin, asyncHandler(adminUsersController.setQuota));
router.get('/settings', requireAdmin, asyncHandler(adminUsersController.getSettings));
router.put('/settings', requireAdmin, asyncHandler(adminUsersController.saveSettings));

module.exports = router;