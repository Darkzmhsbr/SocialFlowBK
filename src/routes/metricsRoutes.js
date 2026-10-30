// Rodada 13: /api/metrics/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/metricsController');

const router = Router();

router.use(requireAuth);

router.get('/overview', asyncHandler(controller.overview));
router.post('/refresh', asyncHandler(controller.refresh));

module.exports = router;
