// Rodada 5: /api/notifications/* — always authenticated, always scoped to
// req.userId (a user never sees another user's notifications).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/notificationsController');

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(controller.listNotifications));
router.get('/unread-count', asyncHandler(controller.getUnreadCount));
// Declared before /:id/read so "read-all" is never taken as an id.
router.post('/read-all', asyncHandler(controller.markAllRead));
router.post('/:id/read', asyncHandler(controller.markRead));

module.exports = router;