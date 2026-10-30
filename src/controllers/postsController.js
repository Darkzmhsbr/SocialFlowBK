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
// Rodada 4.1: also accepts &accountId=<instagramAccountId> and returns
// `total` (count with the same filters) for the pagination controls.
// Response stays backward compatible: { posts } + { total, take, skip }.
const listPosts = async (req, res) => {
  const take = Math.min(Number(req.query.take) || 50, 100);
  const skip = Number(req.query.skip) || 0;
  const status = req.query.status || undefined;
  const instagramAccountId = req.query.accountId || undefined;

  // Rodada 4.1: was postService.listPosts(req.userId, { status, take, skip })
  const { posts, total } = await postService.listPostsPage(req.userId, {
    status,
    instagramAccountId,
    take,
    skip,
  });
  return ok(res, { posts: posts.map(postService.toPublicShape), total, take, skip });
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

// GET /api/posts/batch/limits
// Rodada 4.1: limits + stagger defaults for the batch composer.
const getBatchLimits = async (req, res) => {
  return ok(res, { limits: postService.getBatchLimits() });
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
// Rodada 4.1
module.exports.getBatchLimits = getBatchLimits;

// --- Rodada 5: "Publicar agora" -------------------------------------------

// POST /api/posts/:id/publish-now
// Returns { post, notice } — notice explains a pause if the account has one.
const publishNow = async (req, res) => {
  const { post, notice } = await postService.publishNow(req.params.id, req.userId);
  return ok(res, { post: postService.toPublicShape(post), notice });
};

// POST /api/posts/batch/:batchId/publish-now
// Body (optional): { intervalMinutes?: number, windowMinutes?: number }
const publishBatchNow = async (req, res) => {
  const { intervalMinutes, windowMinutes } = req.body || {};
  const result = await postService.publishBatchNow(req.params.batchId, req.userId, {
    intervalMinutes,
    windowMinutes,
  });
  return ok(res, { requeued: result });
};

module.exports.publishNow = publishNow;
module.exports.publishBatchNow = publishBatchNow;

// --- Rodada 6: Agendamentos page ------------------------------------------

// GET /api/posts/query?status=&types=REEL,STORY&accountId=&q=&take=&skip=
// Returns { posts, total, take, skip }
const queryPosts = async (req, res) => {
  const take = Math.min(Number(req.query.take) || 50, 100);
  const skip = Number(req.query.skip) || 0;
  const { posts, total } = await postService.queryPosts(req.userId, req.query, { take, skip });
  return ok(res, { posts: posts.map(postService.toPublicShape), total, take, skip });
};

// GET /api/posts/overview?types=&accountId=&q=&status=
// Returns { byStatus, byType, nextScheduled }
const getPostsOverview = async (req, res) => {
  const overview = await postService.getPostsOverview(req.userId, req.query);
  return ok(res, overview);
};

// POST /api/posts/bulk
// Body: { action: 'delete'|'archive'|'publish-now', ids?: string[],
//         filter?: { status, types, accountId, q }, intervalMinutes?, windowMinutes? }
const bulkPosts = async (req, res) => {
  const result = await postService.bulkAction(req.userId, req.body || {});
  return ok(res, { result });
};

// GET /api/posts/calendar?from=AAAA-MM-DD&to=AAAA-MM-DD&tzOffset=180&folderId=&accountId=&types=&statuses=
// Rodada 15: per-day counters for the calendar page.
const getCalendar = async (req, res) => {
  const calendar = await postService.getCalendar(req.userId, req.query);
  return ok(res, { calendar });
};

module.exports.getCalendar = getCalendar;
module.exports.queryPosts = queryPosts;
module.exports.getPostsOverview = getPostsOverview;
module.exports.bulkPosts = bulkPosts;