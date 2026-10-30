// Rodada 16: /api/templates/* (always authenticated, scoped to req.userId).
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/templatesController');

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(controller.listTemplates));
router.post('/', asyncHandler(controller.createTemplate));
router.patch('/:id', asyncHandler(controller.updateTemplate));
router.delete('/:id', asyncHandler(controller.deleteTemplate));
router.post('/:id/use', asyncHandler(controller.useTemplate));

module.exports = router;