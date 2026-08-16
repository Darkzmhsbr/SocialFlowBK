const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/dashboardController');

const router = Router();

router.use(requireAuth);

router.get('/stats', asyncHandler(controller.getStats));

module.exports = router;