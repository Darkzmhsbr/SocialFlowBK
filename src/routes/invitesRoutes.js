const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/invitesController');
// Rodada 11: invites are admin-only (ADMIN_EMAILS).
const requireAdmin = require('../middleware/requireAdmin');

const router = Router();

router.use(requireAuth); // all invite endpoints are authenticated
router.use(requireAdmin); // Rodada 11: and restricted to platform admins

// Rodada 11: every invite of the platform (incl. bootstrap ones) + revoke.
// Declared before any /:id route.
router.get('/all', asyncHandler(controller.listAll));
router.delete('/:id', asyncHandler(controller.revoke));

router.post('/', asyncHandler(controller.create));
router.get('/', asyncHandler(controller.list));

module.exports = router;