// Rodada 18: /api/performance/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/performanceController');

const router = Router();

router.use(requireAuth);

router.get('/posts', asyncHandler(controller.posts));
router.get('/best-times', asyncHandler(controller.bestTimes));

module.exports = router;