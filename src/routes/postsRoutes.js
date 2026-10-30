const { Router } = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const requireAuth = require('../middleware/requireAuth');
const controller = require('../controllers/postsController');

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(controller.createPost));
router.get('/', asyncHandler(controller.listPosts));

// Rodada 4: batch routes. Declared before the /:id routes for the same
// reason as /:id/insights below — keeps "batch" from ever being read as
// a post id.
router.post('/batch', asyncHandler(controller.createBatch));
// Rodada 4.1: must come BEFORE /batch/:batchId ("limits" isn't a batch id).
router.get('/batch/limits', asyncHandler(controller.getBatchLimits));
router.get('/batch/:batchId', asyncHandler(controller.getBatch));
router.post('/batch/:batchId/archive', asyncHandler(controller.archiveBatch));
// Rodada 5: publish every pending post of the batch now (re-staggered).
router.post('/batch/:batchId/publish-now', asyncHandler(controller.publishBatchNow));
router.delete('/batch/:batchId', asyncHandler(controller.deleteBatch));

// Rodada 6: Agendamentos page. Declared before /:id so "query"/"overview"
// are never read as post ids.
router.get('/query', asyncHandler(controller.queryPosts));
router.get('/overview', asyncHandler(controller.getPostsOverview));
router.post('/bulk', asyncHandler(controller.bulkPosts));

// NOTE: /:id/insights must be declared BEFORE the bare /:id route, or
// Express would match ":id" with the literal string "insights" as the id.
// Same ordering issue we solved in instagramRoutes for /accounts/:id/status.
router.get('/:id/insights', asyncHandler(controller.getPostInsights));

router.get('/:id', asyncHandler(controller.getPost));
router.patch('/:id', asyncHandler(controller.updatePost));
router.post('/:id/archive', asyncHandler(controller.archivePost));
// Rodada 5: "Publicar agora" for a single post.
router.post('/:id/publish-now', asyncHandler(controller.publishNow));
router.delete('/:id', asyncHandler(controller.deletePost));

module.exports = router;