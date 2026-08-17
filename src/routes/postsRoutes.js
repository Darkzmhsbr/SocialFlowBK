const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/postsController');

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(controller.createPost));
router.get('/', asyncHandler(controller.listPosts));

// NOTE: /:id/insights must be declared BEFORE the bare /:id route, or
// Express would match ":id" with the literal string "insights" as the id.
// Same ordering issue we solved in instagramRoutes for /accounts/:id/status.
router.get('/:id/insights', asyncHandler(controller.getPostInsights));

router.get('/:id', asyncHandler(controller.getPost));
router.patch('/:id', asyncHandler(controller.updatePost));
router.post('/:id/archive', asyncHandler(controller.archivePost));
router.delete('/:id', asyncHandler(controller.deletePost));

module.exports = router;