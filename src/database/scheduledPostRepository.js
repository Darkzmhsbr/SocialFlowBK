// All Prisma queries for ScheduledPost + PostMedia live here. Includes the
// full media graph on every read so services never need to worry about
// missing joins.

const prisma = require('../config/database');

// Always attached to reads so callers get { medias: [{ order, mediaAsset }] }.
// Rodada 2b: also includes coverMediaAsset (optional custom cover art for
// videos/reels) so the publish service can pull cover.url without a
// second query.
const POST_INCLUDE = {
  medias: {
    include: { mediaAsset: true },
    orderBy: { order: 'asc' },
  },
  coverMediaAsset: true,
  instagramAccount: {
    select: {
      id: true,
      username: true,
      name: true,
      profilePictureUrl: true,
      accountType: true,
      instagramUserId: true,
      accessTokenEncrypted: true,
      tokenExpiresAt: true,
      status: true,
    },
  },
};

/**
 * @param {object} data
 * @param {string} data.userId
 * @param {string} data.instagramAccountId
 * @param {'FEED_IMAGE'|'FEED_VIDEO'|'FEED_CAROUSEL'|'REEL'|'STORY'} data.type
 * @param {string|null} data.caption
 * @param {'DRAFT'|'SCHEDULED'} data.status
 * @param {Date|null} data.scheduledFor
 * @param {Array<{ mediaAssetId: string, order: number }>} data.medias
 * @param {string|null} [data.coverMediaAssetId] - optional cover for VIDEO/REEL
 */
function create(data) {
  return prisma.scheduledPost.create({
    data: {
      userId: data.userId,
      instagramAccountId: data.instagramAccountId,
      type: data.type,
      caption: data.caption,
      status: data.status,
      scheduledFor: data.scheduledFor,
      coverMediaAssetId: data.coverMediaAssetId ?? null,
      medias: {
        create: data.medias.map((m) => ({
          order: m.order,
          mediaAsset: { connect: { id: m.mediaAssetId } },
        })),
      },
    },
    include: POST_INCLUDE,
  });
}

function findById(id) {
  return prisma.scheduledPost.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
}

function findAllByUserId(userId, { status, take = 50, skip = 0 } = {}) {
  return prisma.scheduledPost.findMany({
    where: {
      userId,
      ...(status ? { status } : {}),
    },
    orderBy: [
      // Scheduled first (soonest first), then by creation date desc for the rest.
      { scheduledFor: 'asc' },
      { createdAt: 'desc' },
    ],
    take,
    skip,
    include: POST_INCLUDE,
  });
}

/**
 * Updates fields the user may edit while a post is still editable. Media
 * replacement (if provided) wipes all existing PostMedia rows and recreates
 * them - safer than diffing when the whole set changes.
 *
 * Rodada 2b: coverMediaAssetId in `patch` follows the standard three-state
 * convention. undefined = don't touch. null = clear cover. string = set/replace.
 * The service layer validates the string case (ownership, IMAGE type,
 * type-allows-cover) before we get here.
 */
function updateEditable(id, patch) {
  const { caption, scheduledFor, status, type, medias, coverMediaAssetId } = patch;

  return prisma.$transaction(async (tx) => {
    if (medias) {
      await tx.postMedia.deleteMany({ where: { postId: id } });
      await tx.postMedia.createMany({
        data: medias.map((m) => ({
          postId: id,
          mediaAssetId: m.mediaAssetId,
          order: m.order,
        })),
      });
    }

    return tx.scheduledPost.update({
      where: { id },
      data: {
        ...(caption !== undefined ? { caption } : {}),
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(coverMediaAssetId !== undefined ? { coverMediaAssetId } : {}),
      },
      include: POST_INCLUDE,
    });
  });
}

function updateStatus(id, status, extras = {}) {
  return prisma.scheduledPost.update({
    where: { id },
    data: { status, ...extras },
    include: POST_INCLUDE,
  });
}

function deleteById(id) {
  return prisma.scheduledPost.delete({ where: { id } });
}

// --- Phase 2.2a: worker helpers ------------------------------------------

/**
 * Atomically claim up to `limit` posts that are due for publishing.
 *
 * Uses Postgres's SELECT ... FOR UPDATE SKIP LOCKED so if two workers run
 * at the same time (or a Railway restart overlaps with the previous
 * process), they never pick the same row. Each claimed row is flipped from
 * SCHEDULED to QUEUED in the same transaction, so it disappears from the
 * "due" query as soon as we own it.
 *
 * Returns the full post objects (with medias + account) ready to publish.
 */
async function claimDuePosts(limit = 5) {
  return prisma.$transaction(async (tx) => {
    // The RETURNING clause of an UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
    // SKIP LOCKED) is the idiomatic way to claim a batch on Postgres.
    const claimed = await tx.$queryRaw`
      UPDATE "scheduled_posts"
      SET "status" = 'QUEUED', "updatedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "scheduled_posts"
        WHERE "status" = 'SCHEDULED'
          AND "scheduledFor" <= NOW()
        ORDER BY "scheduledFor" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `;

    const ids = claimed.map((row) => row.id);
    if (ids.length === 0) return [];

    return tx.scheduledPost.findMany({
      where: { id: { in: ids } },
      include: POST_INCLUDE,
    });
  });
}

/**
 * Called by the worker mid-publish (right before hitting Meta's publish
 * endpoint) so the UI can show "Publicando..." while it's happening.
 */
function markPublishing(id) {
  return prisma.scheduledPost.update({
    where: { id },
    data: { status: 'PUBLISHING' },
    include: POST_INCLUDE,
  });
}

/**
 * Final state on success: store the Instagram media id (used later by
 * analytics) and stamp publishedAt. Also clears failureReason in case this
 * was a retry succeeding after a previous failure.
 */
function markPublished(id, instagramMediaId) {
  return prisma.scheduledPost.update({
    where: { id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      instagramMediaId,
      failureReason: null,
    },
    include: POST_INCLUDE,
  });
}

/**
 * Terminal failure: no more retries will happen. Frontend surfaces the
 * failureReason so the user can decide whether to fix and reschedule.
 */
function markFailed(id, failureReason) {
  return prisma.scheduledPost.update({
    where: { id },
    data: {
      status: 'FAILED',
      failureReason: (failureReason || '').slice(0, 500),
    },
    include: POST_INCLUDE,
  });
}

/**
 * Transient failure: keep the post in play. Push scheduledFor forward by
 * `delayMs` and put status back to SCHEDULED so the next worker tick picks
 * it up. Increments retryCount so we eventually stop retrying.
 */
function rescheduleForRetry(id, delayMs, failureReason) {
  const nextAttemptAt = new Date(Date.now() + delayMs);
  return prisma.scheduledPost.update({
    where: { id },
    data: {
      status: 'SCHEDULED',
      scheduledFor: nextAttemptAt,
      retryCount: { increment: 1 },
      failureReason: (failureReason || '').slice(0, 500),
    },
    include: POST_INCLUDE,
  });
}

// --- Rodada 3: insights cache -------------------------------------------

/**
 * Persist the fetched insights data alongside a timestamp so the service
 * can check TTL on subsequent requests. Intentionally doesn't touch any
 * other field on the row (status, caption, etc are the user's domain).
 *
 * @param {string} postId
 * @param {object} insightsData - flat { reach: N, likes: N, ... } object
 * @param {Date} updatedAt
 */
function saveInsightsCache(postId, insightsData, updatedAt) {
  return prisma.scheduledPost.update({
    where: { id: postId },
    data: {
      insightsData,
      insightsUpdatedAt: updatedAt,
    },
  });
}

module.exports = {
  create,
  findById,
  findAllByUserId,
  updateEditable,
  updateStatus,
  deleteById,
  claimDuePosts,
  markPublishing,
  markPublished,
  markFailed,
  rescheduleForRetry,
  saveInsightsCache,
};