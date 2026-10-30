// All Prisma queries for ScheduledPost + PostMedia live here. Includes the
// full media graph on every read so services never need to worry about
// missing joins.

const prisma = require('../config/database');
// Rodada 4.1: ids for bulk inserts (createMany doesn't return rows).
const crypto = require('crypto');
// Rodada 5: minimum gap between publishes on the same account (claim).
const env = require('../config/env');

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
      // Rodada 5: lets the UI explain why a scheduled post is waiting.
      publishPausedUntil: true,
      pauseReason: true,
      lastErrorMessage: true,
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
 * @param {string|null} [data.batchId] - Rodada 4: groups posts created by the batch composer
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
      // Rodada 4: null for posts created by the single composer.
      batchId: data.batchId ?? null,
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

// --- Rodada 4: multi-profile batch posting ------------------------------

/**
 * Create every post of a batch atomically. Reuses create() (each call
 * returns a lazy PrismaPromise), so all posts are inserted in ONE
 * transaction: either the whole batch exists or none of it does.
 *
 * @param {Array<object>} postsData - same shape accepted by create()
 */
function createBatch(postsData) {
  return prisma.$transaction(postsData.map((data) => create(data)));
}

/**
 * Every post of a batch, scoped to its owner (never leaks another user's
 * rows even if a batchId is guessed).
 */
function findAllByBatchId(batchId, userId) {
  return prisma.scheduledPost.findMany({
    where: { batchId, userId },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
    include: POST_INCLUDE,
  });
}

/**
 * Bulk delete. The status filter is a second safety net: a post the worker
 * claimed between the service read and this call (QUEUED/PUBLISHING) is
 * simply skipped instead of being deleted mid-publish.
 */
function deleteManyByIds(ids) {
  return prisma.scheduledPost.deleteMany({
    where: {
      id: { in: ids },
      status: { notIn: ['QUEUED', 'PUBLISHING'] },
    },
  });
}

/**
 * Bulk archive with the same race protection as deleteManyByIds.
 */
function archiveManyByIds(ids) {
  return prisma.scheduledPost.updateMany({
    where: {
      id: { in: ids },
      status: { notIn: ['QUEUED', 'PUBLISHING', 'ARCHIVED'] },
    },
    data: { status: 'ARCHIVED' },
  });
}

/**
 * Fair claim used by the concurrent worker (Rodada 4). Same atomic
 * UPDATE ... FOR UPDATE SKIP LOCKED pattern as claimDuePosts, plus:
 *
 *   1. At most ONE due post per Instagram account (DISTINCT ON), and
 *      none at all for an account that already has a post QUEUED or
 *      PUBLISHING. Two containers for the same account never run at
 *      the same time.
 *   2. Round-robin between users (ROW_NUMBER per userId). A user with a
 *      300-post batch can't starve another user's single post.
 *
 * claimDuePosts above is kept untouched — the worker still uses it when
 * WORKER_CONCURRENCY=1 (original sequential mode).
 */
async function claimDuePostsFair(limit = 3) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw`
      UPDATE "scheduled_posts"
      SET "status" = 'QUEUED', "updatedAt" = NOW()
      WHERE "id" IN (
        SELECT sp."id"
        FROM "scheduled_posts" sp
        JOIN (
          SELECT c."id",
                 ROW_NUMBER() OVER (PARTITION BY c."userId" ORDER BY c."scheduledFor" ASC) AS user_rank
          FROM (
            SELECT DISTINCT ON ("instagramAccountId") "id", "userId", "scheduledFor"
            FROM "scheduled_posts"
            WHERE "status" = 'SCHEDULED'
              AND "scheduledFor" <= NOW()
              AND "instagramAccountId" NOT IN (
                SELECT "instagramAccountId" FROM "scheduled_posts"
                WHERE "status" IN ('QUEUED', 'PUBLISHING')
              )
              -- Rodada 5: skip accounts that are down or paused (Meta limits)
              AND "instagramAccountId" NOT IN (
                SELECT "id" FROM "instagram_accounts"
                WHERE "status" <> 'ACTIVE'
                   OR ("publishPausedUntil" IS NOT NULL AND "publishPausedUntil" > NOW())
              )
              -- Rodada 5: minimum gap since the account's last publish
              AND "instagramAccountId" NOT IN (
                SELECT "instagramAccountId" FROM "scheduled_posts"
                WHERE "status" = 'PUBLISHED'
                  AND "publishedAt" > ${minGapCutoff()}
              )
            ORDER BY "instagramAccountId", "scheduledFor" ASC
          ) c
        ) ranked ON ranked."id" = sp."id"
        WHERE sp."status" = 'SCHEDULED'
        ORDER BY ranked.user_rank ASC, sp."scheduledFor" ASC
        LIMIT ${limit}
        FOR UPDATE OF sp SKIP LOCKED
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
 * Recover posts left behind by a process that died mid-publish.
 *
 *   - QUEUED older than `queuedBefore`: never reached Meta (the concurrent
 *     worker flips to PUBLISHING immediately after claiming). Safe to put
 *     back to SCHEDULED — the next tick republishes it.
 *   - PUBLISHING older than `publishingBefore`: Meta MAY have published it
 *     already. Re-publishing could duplicate the post on the profile, so
 *     it becomes FAILED with an explicit message and the user decides.
 *
 * Before Rodada 4 these rows stayed stuck forever (and couldn't even be
 * deleted, since QUEUED/PUBLISHING are undeletable).
 *
 * @returns {Promise<{ requeued: number, failed: number }>}
 */
async function recoverStalePosts({ queuedBefore, publishingBefore }) {
  const [requeued, failed] = await prisma.$transaction([
    prisma.scheduledPost.updateMany({
      where: { status: 'QUEUED', updatedAt: { lt: queuedBefore } },
      data: { status: 'SCHEDULED' },
    }),
    prisma.scheduledPost.updateMany({
      where: { status: 'PUBLISHING', updatedAt: { lt: publishingBefore } },
      data: {
        status: 'FAILED',
        failureReason:
          'Publicação interrompida (o servidor reiniciou durante o envio). Verifique no perfil do Instagram se o post saiu antes de reagendar.',
      },
    }),
  ]);
  return { requeued: requeued.count, failed: failed.count };
}

// --- Rodada 4.1: pagination + bulk batch insert -------------------------

/**
 * One page of posts + the total matching the same filters (for the
 * pagination controls). `id` is the last tie-breaker: posts created by a
 * batch share createdAt (same INSERT) and often scheduledFor, and without
 * a unique tie-breaker Postgres may return them in a different order on
 * each page — items would repeat or vanish between pages.
 */
async function findPageByUserId(userId, { status, instagramAccountId, take = 50, skip = 0 } = {}) {
  const where = {
    userId,
    ...(status ? { status } : {}),
    ...(instagramAccountId ? { instagramAccountId } : {}),
  };

  const [posts, total] = await prisma.$transaction([
    prisma.scheduledPost.findMany({
      where,
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take,
      skip,
      include: POST_INCLUDE,
    }),
    prisma.scheduledPost.count({ where }),
  ]);

  return { posts, total };
}

// Rows per INSERT. Keeps every statement far below Postgres's 65535 bind
// parameter limit (posts have ~10 columns, post_media 4).
const BULK_CHUNK_SIZE = 500;

/**
 * Fast path for big batches (up to thousands of posts). createBatch above
 * runs one nested create per post (~4 queries each) — fine for dozens,
 * slow for 2500. This one does chunked createMany for posts and for their
 * PostMedia rows, all inside ONE transaction (all-or-nothing, same as
 * createBatch). Ids are generated here so the media rows can reference
 * their post. Returns the inserted post rows (scalar fields only — the
 * caller only needs status/account/date for the batch summary).
 *
 * @param {Array<object>} postsData - same shape accepted by create()
 */
async function createBatchBulk(postsData) {
  const postRows = postsData.map((data) => ({
    id: crypto.randomUUID(),
    userId: data.userId,
    instagramAccountId: data.instagramAccountId,
    type: data.type,
    caption: data.caption ?? null,
    status: data.status,
    scheduledFor: data.scheduledFor ?? null,
    coverMediaAssetId: data.coverMediaAssetId ?? null,
    batchId: data.batchId ?? null,
  }));

  const mediaRows = [];
  postRows.forEach((row, index) => {
    for (const m of postsData[index].medias || []) {
      mediaRows.push({
        id: crypto.randomUUID(),
        postId: row.id,
        mediaAssetId: m.mediaAssetId,
        order: m.order,
      });
    }
  });

  const operations = [];
  for (let i = 0; i < postRows.length; i += BULK_CHUNK_SIZE) {
    operations.push(prisma.scheduledPost.createMany({ data: postRows.slice(i, i + BULK_CHUNK_SIZE) }));
  }
  for (let i = 0; i < mediaRows.length; i += BULK_CHUNK_SIZE) {
    operations.push(prisma.postMedia.createMany({ data: mediaRows.slice(i, i + BULK_CHUNK_SIZE) }));
  }

  await prisma.$transaction(operations);
  return postRows;
}

// --- Rodada 5: pause / publish now ----------------------------------------

// Cutoff for the minimum gap between two publishes on the same account.
// With ACCOUNT_MIN_GAP_MINUTES=0 the cutoff is "now", which excludes nothing.
function minGapCutoff() {
  const minutes = Math.max(0, Number(env.worker.accountMinGapMinutes) || 0);
  return new Date(Date.now() - minutes * 60 * 1000);
}

/**
 * Put a post back in the queue after an ACCOUNT-level problem (Meta limit,
 * account down). Keeps scheduledFor (preserves order) and retryCount (the
 * attempt didn't count). The claim skips the account until it's usable.
 */
function deferPost(id) {
  return prisma.scheduledPost.update({
    where: { id },
    data: { status: 'SCHEDULED' },
    include: POST_INCLUDE,
  });
}

// Statuses that "Publicar agora" accepts. The status filter in the WHERE
// protects against a race with the worker claiming the post meanwhile.
const REQUEUE_STATUSES = ['DRAFT', 'SCHEDULED', 'FAILED'];

/**
 * "Publicar agora": due immediately, fresh retry budget, old error cleared.
 * Returns how many rows changed (0 = the worker took it in the meantime).
 */
async function requeueNow(id, at = new Date()) {
  const { count } = await prisma.scheduledPost.updateMany({
    where: { id, status: { in: REQUEUE_STATUSES } },
    data: { status: 'SCHEDULED', scheduledFor: at, retryCount: 0, failureReason: null },
  });
  return count;
}

/**
 * Batch version: [{ id, scheduledFor }] in one transaction.
 */
async function requeueMany(entries) {
  const results = await prisma.$transaction(
    entries.map((e) =>
      prisma.scheduledPost.updateMany({
        where: { id: e.id, status: { in: REQUEUE_STATUSES } },
        data: { status: 'SCHEDULED', scheduledFor: e.scheduledFor, retryCount: 0, failureReason: null },
      })
    )
  );
  return results.reduce((sum, r) => sum + r.count, 0);
}

// --- Rodada 6: Agendamentos page (search, counters, bulk actions) --------

/**
 * Shared WHERE for the Agendamentos page. Always scoped to userId.
 *   status / statuses   - one status or a list
 *   instagramAccountId  - one profile
 *   types               - list of ScheduledPostType
 *   q                   - text in the caption OR in the @username
 */
// Rodada 8: accountFolderId -> only posts of profiles in that folder.
// Rodada 15: from/to (Date) -> calendar date range: publishedAt for
// published posts, scheduledFor for everything else.
function buildPostFilterWhere(userId, { status, statuses, instagramAccountId, types, q, accountFolderId, from, to } = {}) {
  const where = { userId };
  if (from && to) {
    where.AND = [
      {
        OR: [
          { status: 'PUBLISHED', publishedAt: { gte: from, lt: to } },
          { status: { not: 'PUBLISHED' }, scheduledFor: { gte: from, lt: to } },
        ],
      },
    ];
  }
  if (accountFolderId) {
    where.instagramAccount = { folderMemberships: { some: { folderId: accountFolderId } } };
  }
  if (status) where.status = status;
  else if (Array.isArray(statuses) && statuses.length > 0) where.status = { in: statuses };
  if (instagramAccountId) where.instagramAccountId = instagramAccountId;
  if (Array.isArray(types) && types.length > 0) where.type = { in: types };
  const term = String(q || '').trim().replace(/^@/, '');
  if (term) {
    where.OR = [
      { caption: { contains: term, mode: 'insensitive' } },
      { instagramAccount: { username: { contains: term, mode: 'insensitive' } } },
    ];
  }
  return where;
}

// Published: newest first. Failed/archived: most recently changed first.
// Everything else: next to publish first (Postgres puts NULL dates last on ASC).
function orderForStatus(status) {
  if (status === 'PUBLISHED') return [{ publishedAt: 'desc' }, { id: 'asc' }];
  if (status === 'FAILED' || status === 'ARCHIVED') return [{ updatedAt: 'desc' }, { id: 'asc' }];
  return [{ scheduledFor: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }];
}

// Rodada 15: calendar lists (date range) go in time order.
const CALENDAR_ORDER = [{ scheduledFor: 'asc' }, { publishedAt: 'asc' }, { id: 'asc' }];

async function findPageFiltered(userId, filters = {}, { take = 50, skip = 0 } = {}) {
  const where = buildPostFilterWhere(userId, filters);
  const [posts, total] = await prisma.$transaction([
    prisma.scheduledPost.findMany({
      where,
      orderBy: filters.from ? CALENDAR_ORDER : orderForStatus(filters.status), // Rodada 15: was orderForStatus(filters.status)
      take,
      skip,
      include: POST_INCLUDE,
    }),
    prisma.scheduledPost.count({ where }),
  ]);
  return { posts, total };
}

/**
 * Counters for the filter chips + the next scheduled post.
 *   byStatus: counts with every filter EXCEPT status
 *   byType:   counts with every filter EXCEPT type
 */
async function getOverview(userId, filters = {}) {
  const whereNoStatus = buildPostFilterWhere(userId, { ...filters, status: undefined, statuses: undefined });
  const whereNoType = buildPostFilterWhere(userId, { ...filters, types: undefined });
  const whereNext = {
    ...buildPostFilterWhere(userId, { ...filters, status: 'SCHEDULED', statuses: undefined }),
    scheduledFor: { gte: new Date() },
  };

  const [byStatusRows, byTypeRows, next] = await Promise.all([
    prisma.scheduledPost.groupBy({ by: ['status'], where: whereNoStatus, _count: { _all: true } }),
    prisma.scheduledPost.groupBy({ by: ['type'], where: whereNoType, _count: { _all: true } }),
    prisma.scheduledPost.findFirst({
      where: whereNext,
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        scheduledFor: true,
        type: true,
        instagramAccount: { select: { id: true, username: true } },
      },
    }),
  ]);

  return {
    byStatus: Object.fromEntries(byStatusRows.map((r) => [r.status, r._count._all])),
    byType: Object.fromEntries(byTypeRows.map((r) => [r.type, r._count._all])),
    nextScheduled: next
      ? {
          postId: next.id,
          scheduledFor: next.scheduledFor,
          type: next.type,
          username: next.instagramAccount?.username || null,
          instagramAccountId: next.instagramAccount?.id || null,
        }
      : null,
  };
}

/**
 * Rodada 15: minimal rows for the calendar summary (counted per day by the
 * service). `limit` protects memory on very large operations.
 */
function findCalendarRows(userId, filters = {}, limit = 60000) {
  return prisma.scheduledPost.findMany({
    where: buildPostFilterWhere(userId, filters),
    select: { status: true, type: true, instagramAccountId: true, scheduledFor: true, publishedAt: true },
    take: limit,
  });
}

/** Ids matching a filter ("selecionar todos os filtrados"), capped. */
async function findIdsByFilter(userId, filters = {}, limit = 2000) {
  const rows = await prisma.scheduledPost.findMany({
    where: buildPostFilterWhere(userId, filters),
    orderBy: orderForStatus(filters.status),
    take: limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Full rows for a bulk action — never returns another user's posts. */
function findManyByIdsForUser(ids, userId) {
  return prisma.scheduledPost.findMany({
    where: { id: { in: ids }, userId },
    include: POST_INCLUDE,
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
  // Rodada 4
  createBatch,
  findAllByBatchId,
  deleteManyByIds,
  archiveManyByIds,
  claimDuePostsFair,
  recoverStalePosts,
  // Rodada 4.1
  findPageByUserId,
  createBatchBulk,
  // Rodada 5
  deferPost,
  requeueNow,
  requeueMany,
  // Rodada 6
  findPageFiltered,
  getOverview,
  findIdsByFilter,
  findManyByIdsForUser,
  // Rodada 15
  findCalendarRows,
};