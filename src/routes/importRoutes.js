// Rodada 19B: /api/imports/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/importController');

const router = Router();

router.use(requireAuth);

router.post('/preview', asyncHandler(controller.preview));
router.post('/commit', asyncHandler(controller.commit));
router.get('/media', asyncHandler(controller.media));

module.exports = router;