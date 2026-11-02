// Rodada 21: /api/storage — storage usage of the logged-in user.
const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/storageController');

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(controller.getUsage));

module.exports = router;