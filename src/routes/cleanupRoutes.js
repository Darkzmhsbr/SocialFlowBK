// Rodada 12: /api/cleanup/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/cleanupController');

const router = Router();

router.use(requireAuth);

router.post('/preview', asyncHandler(controller.preview));
router.get('/jobs', asyncHandler(controller.listJobs));
router.post('/jobs', asyncHandler(controller.createJob));
router.post('/jobs/:id/cancel', asyncHandler(controller.cancelJob));
router.get('/settings', asyncHandler(controller.getSettings));
router.put('/settings', asyncHandler(controller.saveSettings));

module.exports = router;
