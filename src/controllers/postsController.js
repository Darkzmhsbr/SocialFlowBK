const postService = require('../services/posts/scheduledPostService');
const { ok } = require('../utils/apiResponse');
const { AppError, ErrorCodes } = require('../utils/errors');

// POST /api/posts
// Body:
//   {
//     instagramAccountId: string,
//     type: "FEED_IMAGE" | "FEED_VIDEO" | "FEED_CAROUSEL" | "REEL" | "STORY",
//     caption?: string,
//     mediaIds: string[],     // ordered
//     scheduledFor?: string   // ISO; omit to save as DRAFT
//   }
const createPost = async (req, res) => {
  const { instagramAccountId, type, caption, mediaIds, scheduledFor } = req.body || {};

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
// Body accepts any subset of: caption, type, mediaIds, scheduledFor
const updatePost = async (req, res) => {
  const post = await postService.updatePost(req.params.id, req.userId, req.body || {});
  return ok(res, { post: postService.toPublicShape(post) });
};

// POST /api/posts/:id/archive
const archivePost = async (req, res) => {
  const post = await postService.archivePost(req.params.id, req.userId);
  return ok(res, { post: postService.toPublicShape(post) });
};

// DELETE /api/posts/:id  (only for DRAFT; other states must be archived)
const deletePost = async (req, res) => {
  const result = await postService.deletePost(req.params.id, req.userId);
  return ok(res, { deleted: result });
};

module.exports = { createPost, listPosts, getPost, updatePost, archivePost, deletePost };