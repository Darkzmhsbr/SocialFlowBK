const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/instagramController');
// Rodada 8: profile folders
const foldersController = require('../controllers/accountFoldersController');
// Rodada 10: own Meta app
const metaAppController = require('../controllers/metaAppController');

const router = Router();

// Public - Meta redirects here, no Bearer token available.
router.get('/callback', asyncHandler(controller.handleCallback));

// Everything below requires a logged-in user.
router.get('/authorize-url', requireAuth, asyncHandler(controller.getAuthorizeUrl));
router.get('/accounts', requireAuth, asyncHandler(controller.listAccounts));

// Rodada 10: own Meta app (/api/instagram/meta-app)
router.get('/meta-app', requireAuth, asyncHandler(metaAppController.getStatus));
router.put('/meta-app', requireAuth, asyncHandler(metaAppController.saveCredentials));
router.delete('/meta-app', requireAuth, asyncHandler(metaAppController.removeCredentials));

// Rodada 8: profile folders (/api/instagram/folders/*)
router.get('/folders', requireAuth, asyncHandler(foldersController.listFolders));
router.post('/folders', requireAuth, asyncHandler(foldersController.createFolder));
router.patch('/folders/:id', requireAuth, asyncHandler(foldersController.renameFolder));
router.delete('/folders/:id', requireAuth, asyncHandler(foldersController.deleteFolder));
router.put('/folders/:id/members', requireAuth, asyncHandler(foldersController.setMembers));
router.post('/folders/:id/members', requireAuth, asyncHandler(foldersController.addMembers));
router.delete('/folders/:id/members', requireAuth, asyncHandler(foldersController.removeMembers));

// NOTE: /accounts/:id/status must be declared BEFORE /accounts/:id, or
// Express would match ":id" first with id = ":id/status". Express does
// route matching in declaration order and doesn't do longest-prefix.
router.get('/accounts/:id/status', requireAuth, asyncHandler(controller.getAccountStatus));

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