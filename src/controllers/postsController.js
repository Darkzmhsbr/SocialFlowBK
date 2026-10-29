const postService = require('../services/posts/scheduledPostService');
const insightsService = require('../services/instagram/instagramInsightsService');
const { ok } = require('../utils/apiResponse');
const { AppError, ErrorCodes } = require('../utils/errors');

// POST /api/posts
// Body:
//   {
//     instagramAccountId: string,
//     type: "FEED_IMAGE" | "FEED_VIDEO" | "FEED_CAROUSEL" | "REEL" | "STORY",
//     caption?: string,
//     mediaIds: string[],         // ordered
//     scheduledFor?: string,      // ISO; omit to save as DRAFT
//     coverMediaAssetId?: string  // Rodada 2b: optional custom cover for FEED_VIDEO/REEL
//                                 // (must be an IMAGE the user owns)
//   }
const createPost = async (req, res) => {
  const { instagramAccountId, type, caption, mediaIds, scheduledFor, coverMediaAssetId } = req.body || {};

  if (!instagramAccountId || !type || !mediaIds) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Campos obrigatórios: instagramAccountId, type, mediaIds.',
      400
    );
  }

  const post = await postService.createPost({
    userId: req.userId,
    instagramAccountId,
    type,
    caption,
    mediaIds,
    scheduledFor,
    coverMediaAssetId,
  });

  return ok(res, { post: postService.toPublicShape(post) });
};

// GET /api/posts?status=DRAFT&take=50&skip=0
const listPosts = async (req, res) => {
  const take = Math.min(Number(req.query.take) || 50, 100);
  const skip = Number(req.query.skip) || 0;
  const status = req.query.status || undefined;

  const posts = await postService.listPosts(req.userId, { status, take, skip });
  return ok(res, { posts: posts.map(postService.toPublicShape) });
};

// GET /api/posts/:id
const getPost = async (req, res) => {
  const post = await postService.getPost(req.params.id, req.userId);
  return ok(res, { post: postService.toPublicShape(post) });
};

// PATCH /api/posts/:id
// Body accepts any subset of: caption, type, mediaIds, scheduledFor, coverMediaAssetId
// Rodada 2b: coverMediaAssetId semantics — undefined omits, null clears, string sets.
const updatePost = async (req, res) => {
  const post = await postService.updatePost(req.params.id, req.userId, req.body || {});
  return ok(res, { post: postService.toPublicShape(post) });
};

// POST /api/posts/:id/archive
const archivePost = async (req, res) => {
  const post = await postService.archivePost(req.params.id, req.userId);
  return ok(res, { post: postService.toPublicShape(post) });
};

// DELETE /api/posts/:id
// Rodada 1 relaxed this to accept any status except QUEUED/PUBLISHING.
const deletePost = async (req, res) => {
  const result = await postService.deletePost(req.params.id, req.userId);
  return ok(res, { deleted: result });
};

// GET /api/posts/:id/insights?refresh=true
// Rodada 3: fetch Instagram metrics for a published post.
// Uses a 1h cache by default; ?refresh=true forces a re-fetch from Meta.
// Returns { insights, cachedAt, isStale, notice? }.
const getPostInsights = async (req, res) => {
  const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';

  const result = await insightsService.getInsights({
    postId: req.params.id,
    userId: req.userId,
    forceRefresh,
  });

  return ok(res, result);
};

// --- Rodada 4: multi-profile batch posting ------------------------------

// POST /api/posts/batch
// Body:
//   {
//     instagramAccountIds: string[],          // target profiles (ACTIVE)
//     type: "FEED_IMAGE" | "FEED_VIDEO" | "FEED_CAROUSEL" | "REEL" | "STORY",
//     items: [                                // 1..20 — one post per account each
//       { mediaIds: string[], caption?: string, coverMediaAssetId?: string|null }
//     ],
//     caption?: string,                       // shared caption, spintax {a|b} allowed
//     coverMediaAssetId?: string,             // shared cover (FEED_VIDEO/REEL)
//     scheduledFor?: string,                  // ISO base date; omit = all DRAFT
//     stagger?: { enabled?: boolean, windowMinutes?: number, itemIntervalMinutes?: number },
//     useSpintax?: boolean                    // default true
//   }
const createBatch = async (req, res) => {
  const {
    instagramAccountIds,
    type,
    items,
    caption,
    coverMediaAssetId,
    scheduledFor,
    stagger,
    useSpintax,
  } = req.body || {};

  if (!Array.isArray(instagramAccountIds) || !type || !Array.isArray(items)) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Campos obrigatórios: instagramAccountIds (lista), type, items (lista).',
      400
    );
  }

  const { batchId, posts } = await postService.createBatch({
    userId: req.userId,
    instagramAccountIds,
    type,
    items,
    caption,
    coverMediaAssetId,
    scheduledFor,
    stagger,
    useSpintax,
  });

  return ok(res, { batch: postService.summarizeBatch(batchId, posts) });
};

// GET /api/posts/batch/:batchId
const getBatch = async (req, res) => {
  const posts = await postService.getBatch(req.params.batchId, req.userId);
  return ok(res, {
    batch: postService.summarizeBatch(req.params.batchId, posts),
    posts: posts.map(postService.toPublicShape),
  });
};

// POST /api/posts/batch/:batchId/archive
const archiveBatch = async (req, res) => {
  const result = await postService.archiveBatch(req.params.batchId, req.userId);
  return ok(res, { archived: result });
};

// DELETE /api/posts/batch/:batchId
// Skips QUEUED/PUBLISHING posts; PUBLISHED ones stay live on Instagram.
const deleteBatch = async (req, res) => {
  const result = await postService.deleteBatch(req.params.batchId, req.userId);
  return ok(res, { deleted: result });
};

module.exports = { createPost, listPosts, getPost, updatePost, archivePost, deletePost, getPostInsights };

// Rodada 4: appended so the original export line stays untouched.
module.exports.createBatch = createBatch;
module.exports.getBatch = getBatch;
module.exports.archiveBatch = archiveBatch;
module.exports.deleteBatch = deleteBatch;