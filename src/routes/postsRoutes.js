const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/postsController');

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(controller.createPost));
router.get('/', asyncHandler(controller.listPosts));
router.get('/:id', asyncHandler(controller.getPost));
router.patch('/:id', asyncHandler(controller.updatePost));
router.post('/:id/archive', asyncHandler(controller.archivePost));
router.delete('/:id', asyncHandler(controller.deletePost));

module.exports = router;