const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const controller = require('../controllers/dashboardController');

const router = Router();

router.get('/stats', asyncHandler(controller.getStats));

module.exports = router;