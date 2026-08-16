// Aggregate queries used by the dashboard. Kept separate from the
// per-entity repositories because these cross tables (posts + accounts +
// media) and are read-only summary shapes, not entity CRUD.

const prisma = require('../config/database');

function countConnectedAccounts(userId) {
  return prisma.instagramAccount.count({
    where: { userId, status: 'ACTIVE' },
  });
}

function countPostsByStatus(userId, statuses) {
  return prisma.scheduledPost.count({
    where: { userId, status: { in: statuses } },
  });
}

function countPublishedThisMonth(userId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return prisma.scheduledPost.count({
    where: {
      userId,
      status: 'PUBLISHED',
      publishedAt: { gte: startOfMonth },
    },
  });
}

/**
 * Posts per day for the last `days` days. Uses a raw query because grouping
 * by DATE(...) portably through Prisma's groupBy is awkward (it groups by
 * exact timestamp).
 *
 * Returns [{ date: 'YYYY-MM-DD', count: number }] with every day in the
 * window present (zero-filled for days with no posts).
 */
async function getDailyActivity(userId, days = 14) {
  const raw = await prisma.$queryRaw`
    SELECT
      TO_CHAR(DATE("createdAt"), 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS count
    FROM "scheduled_posts"
    WHERE "userId" = ${userId}
      AND "createdAt" >= NOW() - (${days}::int || ' days')::interval
    GROUP BY DATE("createdAt")
    ORDER BY DATE("createdAt") ASC
  `;

  // Zero-fill the days that had no posts so the chart shows a full window
  // instead of collapsing gaps.
  const byDate = new Map(raw.map((row) => [row.date, row.count]));
  const filled = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    filled.push({ date: key, count: byDate.get(key) || 0 });
  }

  return filled;
}

/**
 * Next scheduled posts (SCHEDULED status, soonest first) with the media +
 * account graph included so the dashboard can render a preview.
 */
function getUpcomingPosts(userId, limit = 5) {
  return prisma.scheduledPost.findMany({
    where: {
      userId,
      status: 'SCHEDULED',
      scheduledFor: { gte: new Date() },
    },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
    include: {
      medias: {
        include: { mediaAsset: true },
        orderBy: { order: 'asc' },
        take: 1, // dashboard only shows the first media as thumbnail
      },
      instagramAccount: {
        select: { id: true, username: true, profilePictureUrl: true },
      },
    },
  });
}

module.exports = {
  countConnectedAccounts,
  countPostsByStatus,
  countPublishedThisMonth,
  getDailyActivity,
  getUpcomingPosts,
};