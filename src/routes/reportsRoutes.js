// Rodada 19B: /api/reports/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/reportsController');

const router = Router();

router.use(requireAuth);

router.get('/weeks', asyncHandler(controller.weeks));
router.get('/weekly', asyncHandler(controller.weekly));

module.exports = router;