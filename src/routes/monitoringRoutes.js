// Rodada 17: /api/monitoring/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/monitoringController');

const router = Router();

router.use(requireAuth);

router.get('/overview', asyncHandler(controller.overview));

module.exports = router;