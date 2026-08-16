const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/authController');

const router = Router();

// Public
router.post('/register', asyncHandler(controller.register));
router.post('/login', asyncHandler(controller.login));

// Authenticated
router.get('/me', requireAuth, asyncHandler(controller.me));
router.post('/logout', requireAuth, asyncHandler(controller.logout));

module.exports = router;