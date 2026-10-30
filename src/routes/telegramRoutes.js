// Rodada 17: /api/telegram/*
// The webhook is public (Telegram calls it, protected by a secret header);
// everything else requires login and is scoped to req.userId.
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/telegramController');

const router = Router();

router.post('/webhook', asyncHandler(controller.webhook));

router.get('/status', requireAuth, asyncHandler(controller.status));
router.post('/link-code', requireAuth, asyncHandler(controller.linkCode));
router.post('/connect', requireAuth, asyncHandler(controller.connect));
router.post('/confirm', requireAuth, asyncHandler(controller.confirm));
router.put('/alerts', requireAuth, asyncHandler(controller.setAlerts));
router.post('/test', requireAuth, asyncHandler(controller.test));
router.delete('/link', requireAuth, asyncHandler(controller.disconnect));

module.exports = router;