// Aggregate queries used by the dashboard. Kept separate from the
// per-entity repositories because these cross tables (posts + accounts +
// media) and are read-only summary shapes, not entity CRUD.

const prisma = require('../config/database');

// Correção de fuso: the server runs in UTC, but "today" / "this month" are
// counted in Brasília time (UTC-3, no daylight saving since 2019). Without
// this, posts created after 21:00 showed up on the next day.
const SP_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Brasília calendar day (YYYY-MM-DD) of an instant.
function spDay(date) {
  return new Date(date.getTime() - SP_OFFSET_MS).toISOString().slice(0, 10);
}

// Real instant (UTC) when a Brasília calendar day starts (00:00 in Brasília).
function spDayStart(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + SP_OFFSET_MS);
}

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
  // Correção de fuso: day 1 of the current month at 00:00 Brasília time
  // (was midnight of the server, i.e. 21:00 of the previous day in Brasília).
  const startOfMonth = spDayStart(`${spDay(new Date()).slice(0, 7)}-01`);
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
  // Correção de fuso: days are Brasília days. "createdAt" is stored in UTC,
  // so we subtract 3 hours before taking the date, and the window starts at
  // 00:00 (Brasília) of the first day shown in the chart.
  const todayKey = spDay(new Date());
  const firstDay = new Date(Date.parse(`${todayKey}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const windowStart = spDayStart(firstDay);
  const raw = await prisma.$queryRaw`
    SELECT
      TO_CHAR(DATE("createdAt" - INTERVAL '3 hours'), 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS count
    FROM "scheduled_posts"
    WHERE "userId" = ${userId}
      AND "createdAt" >= ${windowStart}
    GROUP BY DATE("createdAt" - INTERVAL '3 hours')
    ORDER BY DATE("createdAt" - INTERVAL '3 hours') ASC
  `;

  // Zero-fill the days that had no posts so the chart shows a full window
  // instead of collapsing gaps.
  const byDate = new Map(raw.map((row) => [row.date, row.count]));
  const filled = [];
  // Correção de fuso: walk the Brasília days (was the server's day).
  const today = new Date(`${todayKey}T00:00:00Z`);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
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