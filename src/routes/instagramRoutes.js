const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/instagramController');

const router = Router();

// Public - Meta redirects here, no Bearer token available.
router.get('/callback', asyncHandler(controller.handleCallback));

// Everything below requires a logged-in user.
router.get('/authorize-url', requireAuth, asyncHandler(controller.getAuthorizeUrl));
router.get('/accounts', requireAuth, asyncHandler(controller.listAccounts));
router.delete('/accounts/:id', requireAuth, asyncHandler(controller.disconnectAccount));

module.exports = router;