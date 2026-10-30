// Rodada 19B: weekly report (Monday to Sunday, Brasília time).
//
// Every Monday from 08:00 each user with profiles gets the previous week's
// summary in the header bell and on Telegram (alert type WEEKLY_REPORT):
// published, failures, followers gained, views/reach, top 5 profiles and
// top 5 posts. The same report (any of the last 12 weeks) can be opened
// and downloaded on the "Relatórios" page.

const prisma = require('../../config/database');
const notificationService = require('../notifications/notificationService');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // Brasília (UTC-3)
const DAY = 24 * 60 * 60 * 1000;
const SEND_FROM_HOUR = 8;
const WEEKS_LISTED = 12;
const VIDEO_TYPES = new Set(['REEL', 'FEED_VIDEO']);
const ORDER = { now: 0, '24h': 1, '3d': 2, '7d': 3, '30d': 4 };

const nf = new Intl.NumberFormat('pt-BR');
const nfc = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const num = (v) => (Math.abs(v) >= 100000 ? nfc.format(v) : nf.format(v));
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v))}`;

function spParts(date) {
  const d = new Date(date.getTime() - SP_OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), hour: d.getUTCHours() };
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD, Brasília) of the week that contains `date`. */
function mondayOf(date) {
  const { day, weekday } = spParts(date);
  return addDays(day, -((weekday + 6) % 7));
}

/** Monday of the last COMPLETE week. */
function lastCompleteWeek(now = new Date()) {
  return addDays(mondayOf(now), -7);
}

function startOf(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + SP_OFFSET_MS);
}

function shortDay(day) {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

function listWeeks(now = new Date()) {
  const last = lastCompleteWeek(now);
  return Array.from({ length: WEEKS_LISTED }, (_, i) => {
    const start = addDays(last, -7 * i);
    return { week: start, label: `${shortDay(start)} a ${shortDay(addDays(start, 6))}` };
  });
}

async function buildWeeklyReport(userId, week) {
  const weekStart = week || lastCompleteWeek();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || mondayOf(startOf(weekStart)) !== weekStart) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Semana inválida (use a segunda-feira, AAAA-MM-DD).', 400);
  }
  const weekEnd = addDays(weekStart, 6);
  const from = startOf(weekStart);
  const to = startOf(addDays(weekStart, 7));

  const accounts = await prisma.instagramAccount.findMany({
    where: { userId },
    select: { id: true, username: true, status: true },
  });
  const ids = accounts.map((a) => a.id);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const [published, failed, nextWeek, snaps, followerSnaps, posts] = await Promise.all([
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { userId, status: 'PUBLISHED', publishedAt: { gte: from, lt: to } },
      _count: { _all: true },
    }),
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { userId, status: 'FAILED', updatedAt: { gte: from, lt: to } },
      _count: { _all: true },
    }),
    prisma.scheduledPost.count({
      where: {
        userId,
        status: { in: ['SCHEDULED', 'QUEUED'] },
        scheduledFor: { gte: to, lt: new Date(to.getTime() + 7 * DAY) },
      },
    }),
    ids.length
      ? prisma.accountInsightSnapshot.findMany({
          where: {
            instagramAccountId: { in: ids },
            date: { gte: new Date(`${weekStart}T00:00:00Z`), lte: new Date(`${weekEnd}T00:00:00Z`) },
          },
          select: { instagramAccountId: true, views: true, reach: true },
        })
      : [],
    ids.length
      ? prisma.accountInsightSnapshot.findMany({
          where: {
            instagramAccountId: { in: ids },
            followersCount: { not: null },
            date: { gte: new Date(`${addDays(weekStart, -1)}T00:00:00Z`), lte: new Date(`${weekEnd}T00:00:00Z`) },
          },
          orderBy: { date: 'asc' },
          select: { instagramAccountId: true, followersCount: true },
        })
      : [],
    prisma.scheduledPost.findMany({
      where: { userId, status: 'PUBLISHED', publishedAt: { gte: from, lt: to } },
      select: {
        id: true,
        type: true,
        caption: true,
        publishedAt: true,
        permalink: true,
        instagramAccountId: true,
        performanceRatio: true,
        postInsightSnapshots: { where: { ok: true }, select: { checkpoint: true, views: true, reach: true } },
      },
      take: 5000,
    }),
  ]);

  const rows = new Map(
    accounts.map((a) => [a.id, { account: a, published: 0, failed: 0, views: 0, reach: 0, followersDelta: 0, followers: null }])
  );
  published.forEach((g) => rows.has(g.instagramAccountId) && (rows.get(g.instagramAccountId).published = g._count._all));
  failed.forEach((g) => rows.has(g.instagramAccountId) && (rows.get(g.instagramAccountId).failed = g._count._all));
  for (const s of snaps) {
    const r = rows.get(s.instagramAccountId);
    if (!r) continue;
    r.views += s.views || 0;
    r.reach += s.reach || 0;
  }
  const firstLast = new Map();
  for (const s of followerSnaps) {
    const fl = firstLast.get(s.instagramAccountId) || { first: s.followersCount, last: s.followersCount };
    fl.last = s.followersCount;
    firstLast.set(s.instagramAccountId, fl);
  }
  for (const [accId, fl] of firstLast) {
    const r = rows.get(accId);
    if (!r) continue;
    r.followersDelta = fl.last - fl.first;
    r.followers = fl.last;
  }
  const profiles = [...rows.values()];
  const sum = (k) => profiles.reduce((s, r) => s + (r[k] || 0), 0);

  const topProfiles = [...profiles]
    .filter((r) => r.views || r.published || r.followersDelta)
    .sort((a, b) => b.views - a.views || b.followersDelta - a.followersDelta || b.published - a.published)
    .slice(0, 5);

  const topPosts = posts
    .map((p) => {
      const snap = [...p.postInsightSnapshots].sort((a, b) => ORDER[b.checkpoint] - ORDER[a.checkpoint])[0];
      if (!snap) return null;
      const metric = VIDEO_TYPES.has(p.type) ? 'views' : 'reach';
      const value = snap[metric];
      if (value == null) return null;
      return {
        id: p.id,
        username: byId.get(p.instagramAccountId)?.username || '',
        type: p.type,
        caption: p.caption ? p.caption.slice(0, 100) : null,
        publishedAt: p.publishedAt,
        permalink: p.permalink,
        metric,
        value,
        ratio: p.performanceRatio,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const totalPublished = sum('published');
  const totalFailed = sum('failed');
  return {
    week: weekStart,
    weekEnd,
    label: `${shortDay(weekStart)} a ${shortDay(weekEnd)}`,
    totals: {
      accounts: accounts.length,
      published: totalPublished,
      failed: totalFailed,
      successRate: totalPublished + totalFailed ? Math.round((totalPublished / (totalPublished + totalFailed)) * 1000) / 10 : null,
      followersDelta: sum('followersDelta'),
      views: sum('views'),
      reach: sum('reach'),
      scheduledNextWeek: nextWeek,
      accountsDown: accounts.filter((a) => a.status !== 'ACTIVE').length,
    },
    profiles: profiles.sort((a, b) => b.views - a.views || b.published - a.published),
    topProfiles,
    topPosts,
  };
}

function reportText(r) {
  const t = r.totals;
  const lines = [
    `✅ ${num(t.published)} publicado(s)${t.failed ? ` · ❌ ${num(t.failed)} falha(s)` : ''}${t.successRate != null ? ` · ${String(t.successRate).replace('.', ',')}% de sucesso` : ''}`,
  ];
  if (t.followersDelta || t.views || t.reach) {
    lines.push(`📈 ${signed(t.followersDelta)} seguidores · ▶ ${num(t.views)} visualizações · 👁 ${num(t.reach)} alcance`);
  }
  if (r.topProfiles.length) {
    lines.push(
      `🏆 Top perfis: ${r.topProfiles
        .slice(0, 5)
        .map((p) => `@${p.account.username}${p.views ? ` (${num(p.views)})` : ''}`)
        .join(', ')}`
    );
  }
  if (r.topPosts.length) {
    const p = r.topPosts[0];
    lines.push(`🔥 Melhor post: @${p.username} — ${num(p.value)} ${p.metric === 'views' ? 'visualizações' : 'alcance'}`);
  }
  lines.push(`🗓 ${num(t.scheduledNextWeek)} post(s) agendado(s) para esta semana${t.accountsDown ? ` · 🔴 ${t.accountsDown} perfil(is) com problema` : ''}`);
  lines.push('Detalhes e planilha: menu Relatórios.');
  return lines.join('\n');
}

/** Monday from 08:00: one report per user per week. Called by the monitor (every 30 min). */
async function weeklyTick(now = Date.now()) {
  const date = new Date(now);
  const { weekday, hour } = spParts(date);
  if (weekday !== 1 || hour < SEND_FROM_HOUR) return 0;
  const week = lastCompleteWeek(date);
  const users = await prisma.instagramAccount.findMany({ distinct: ['userId'], select: { userId: true } });
  let sent = 0;
  for (const { userId } of users) {
    const dedupeKey = `weekly:${userId}:${week}`;
    const exists = await prisma.notification.findFirst({ where: { userId, dedupeKey }, select: { id: true } });
    if (exists) continue;
    try {
      const report = await buildWeeklyReport(userId, week);
      await notificationService.notify({
        userId,
        type: 'WEEKLY_REPORT',
        severity: 'info',
        title: `📊 Relatório semanal — ${report.label}`,
        message: reportText(report),
        dedupeKey,
        dedupeWindowMinutes: 8 * 24 * 60,
      });
      sent += 1;
    } catch (err) {
      logger.warn('Weekly report failed', { userId, error: err.message });
    }
  }
  if (sent) logger.info('Weekly reports sent', { week, sent });
  return sent;
}

module.exports = { buildWeeklyReport, reportText, weeklyTick, listWeeks, lastCompleteWeek, mondayOf };