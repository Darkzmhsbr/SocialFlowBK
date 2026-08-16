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
router.get('/accounts/:id', requireAuth, asyncHandler(controller.getAccount));
router.delete('/accounts/:id', requireAuth, asyncHandler(controller.disconnectAccount));

// Webhook placeholders - not implemented in this MVP, see README > Roadmap.
router.get('/webhook', (req, res) => {
  res.status(501).json({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Webhook verification not implemented yet.' },
  });
});
router.post('/webhook', (req, res) => {
  res.status(501).json({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Webhook processing not implemented yet.' },
  });
});

module.exports = router;