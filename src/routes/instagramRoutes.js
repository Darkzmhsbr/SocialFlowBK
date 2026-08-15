const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const controller = require('../controllers/instagramController');

const router = Router();

// OAuth flow
router.get('/connect', controller.connect);
router.get('/callback', controller.callback); // registered as META_REDIRECT_URI in Meta App Dashboard

// Account management
router.get('/accounts', asyncHandler(controller.listAccounts));
router.get('/accounts/:id', asyncHandler(controller.getAccount));
router.delete('/accounts/:id', asyncHandler(controller.deleteAccount));

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
