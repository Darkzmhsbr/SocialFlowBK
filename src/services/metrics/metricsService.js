// Rodada 13: Dashboard metrics.
//
// Collector — once a day, for every ACTIVE profile, stores one row in
// account_insight_snapshots for the last complete day (São Paulo calendar):
//   - followers / follows / media counters (basic scope)
//   - the day's reach, views, accounts engaged, interactions, likes,
//     comments, shares, saves (scope instagram_business_manage_insights)
// The first time a profile is collected, the previous 6 days of insights are
// backfilled too, so the charts aren't empty on day one. Meta doesn't give
// past follower counts, so the followers line starts on the first collection.
//
// Safety: this never pauses or takes a profile down. A permission error on
// insights just stores the counters with insightsOk=false (the Dashboard
// asks to reconnect that profile); a Meta rate limit stops the collector for
// 15 minutes; any other failure retries that profile one hour later.
//
// Overview — aggregates the snapshots for the Dashboard: Geral (all
// profiles), one folder, or one profile, over 7/30/90 days, with the
// previous period for comparison, a daily series and a ranking.

const prisma = require('../../config/database');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const { classifyMetaError } = require('../instagram/accountHealthService');
const { decryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // America/Sao_Paulo = UTC-3 (no DST since 2019)
const DAY_MS = 24 * 60 * 60 * 1000;
// A day is collected from 06:00 (São Paulo) of the next day on, when Meta
// has finished consolidating it.
const SETTLE_MS = 30 * 60 * 60 * 1000;

const FULL_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves'];
const CORE_METRICS = ['reach', 'accounts_engaged', 'total_interactions'];
const BACKFILL_DAYS = 6;
const RANGE_DAYS = [7, 30, 90];
const RETENTION_DAYS = 400;

const TICK_MS = 5 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;
const SLICE_MS = 45 * 1000;
const ACCOUNTS_PER_TICK = 40;
const CALL_GAP_MS = 250;
const RETRY_ACCOUNT_MS = 60 * 60 * 1000;
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;
const MANUAL_REFRESH_EVERY_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Day helpers ('YYYY-MM-DD' strings, São Paulo calendar)
// ---------------------------------------------------------------------------

function spDay(date) {
  return new Date(date.getTime() - SP_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// Midnight of `day` in São Paulo, as a real instant.
function dayStart(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + SP_OFFSET_MS);
}

// Value stored in the DATE column.
function dbDate(day) {
  return new Date(`${day}T00:00:00Z`);
}

function dayOf(dbValue) {
  return new Date(dbValue).toISOString().slice(0, 10);
}

function lastCompleteDay(now = new Date()) {
  return spDay(new Date(now.getTime() - SETTLE_MS));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

const retryAfter = new Map(); // accountId -> timestamp
let pausedUntil = 0;
let timer = null;
let firstRun = null;
const running = new Set(); // 'global' | userId
const manualRefreshAt = new Map(); // userId -> timestamp

class RateLimited extends Error {}

function isPermissionError(err) {
  const meta = err instanceof AppError ? err.debug || {} : {};
  const code = Number(meta.code) || null;
  const msg = String(meta.message || '').toLowerCase();
  return code === 10 || code === 200 || (code >= 200 && code <= 299) || msg.includes('permission');
}

function isInvalidMetricError(err) {
  const meta = err instanceof AppError ? err.debug || {} : {};
  return Number(meta.code) === 100 && !isPermissionError(err);
}

async function fetchDayInsights(account, token, day) {
  const range = {
    since: Math.floor(dayStart(day).getTime() / 1000),
    until: Math.floor(dayStart(addDays(day, 1)).getTime() / 1000),
  };
  try {
    return { ok: true, values: await instagramApiClient.fetchAccountInsights(account.instagramUserId, token, { metrics: FULL_METRICS, ...range }) };
  } catch (err) {
    if (classifyMetaError(err).kind === 'RATE_LIMIT') throw new RateLimited();
    if (isPermissionError(err)) return { ok: false };
    if (!isInvalidMetricError(err)) throw err;
  }
  // Some metric not available for this account/version: try the core set.
  try {
    return { ok: true, values: await instagramApiClient.fetchAccountInsights(account.instagramUserId, token, { metrics: CORE_METRICS, ...range }) };
  } catch (err) {
    if (classifyMetaError(err).kind === 'RATE_LIMIT') throw new RateLimited();
    if (isPermissionError(err) || isInvalidMetricError(err)) return { ok: false };
    throw err;
  }
}

function insightColumns(result) {
  if (!result.ok) {
    return { insightsOk: false };
  }
  const v = result.values;
  const n = (key) => (typeof v[key] === 'number' ? Math.round(v[key]) : null);
  return {
    insightsOk: true,
    reach: n('reach'),
    views: n('views'),
    accountsEngaged: n('accounts_engaged'),
    totalInteractions: n('total_interactions'),
    likes: n('likes'),
    comments: n('comments'),
    shares: n('shares'),
    saves: n('saves'),
  };
}

async function saveDay(account, day, data) {
  await prisma.accountInsightSnapshot.upsert({
    where: { instagramAccountId_date: { instagramAccountId: account.id, date: dbDate(day) } },
    create: { userId: account.userId, instagramAccountId: account.id, date: dbDate(day), ...data },
    update: data,
  });
}

/**
 * Collect `day` (and the backfill on first run) for one profile.
 * Throws RateLimited; any other error is logged and retried later.
 */
async function collectAccount(account, day) {
  let token;
  try {
    token = decryptToken(account.accessTokenEncrypted);
  } catch (err) {
    retryAfter.set(account.id, Date.now() + RETRY_ACCOUNT_MS);
    return { collected: false };
  }

  try {
    const stats = await instagramApiClient.fetchAccountStats(account.instagramUserId, token);
    await sleep(CALL_GAP_MS);
    const insights = await fetchDayInsights(account, token, day);
    await saveDay(account, day, { ...stats, ...insightColumns(insights) });

    // First collection of this profile: backfill the previous days.
    const known = await prisma.accountInsightSnapshot.count({ where: { instagramAccountId: account.id } });
    if (known === 1 && insights.ok) {
      for (let i = 1; i <= BACKFILL_DAYS; i += 1) {
        await sleep(CALL_GAP_MS);
        const past = addDays(day, -i);
        const r = await fetchDayInsights(account, token, past);
        if (!r.ok) break;
        await saveDay(account, past, insightColumns(r));
      }
    }
    retryAfter.delete(account.id);
    return { collected: true };
  } catch (err) {
    if (err instanceof RateLimited) throw err;
    retryAfter.set(account.id, Date.now() + RETRY_ACCOUNT_MS);
    logger.warn('Metrics: profile collection failed (retry in 1h)', { accountId: account.id, error: err.message });
    return { collected: false };
  }
}

/**
 * One collector pass. `userId` limits it to one user (manual refresh).
 * @returns {Promise<{ day: string, collected: number, pending: number }>}
 */
async function collectTick({ userId = null, now = new Date() } = {}) {
  const key = userId || 'global';
  const day = lastCompleteDay(now);
  if (running.has(key) || Date.now() < pausedUntil) return { day, collected: 0, pending: 0 };
  running.add(key);
  const startedAt = Date.now();
  let collected = 0;
  try {
    const nowMs = Date.now();
    const skip = [...retryAfter.entries()].filter(([, t]) => t > nowMs).map(([id]) => id);
    const where = {
      status: 'ACTIVE',
      ...(userId ? { userId } : {}),
      ...(skip.length ? { id: { notIn: skip } } : {}),
      insightSnapshots: { none: { date: dbDate(day) } },
    };
    const accounts = await prisma.instagramAccount.findMany({
      where,
      select: { id: true, userId: true, instagramUserId: true, accessTokenEncrypted: true },
      orderBy: { createdAt: 'asc' },
      take: ACCOUNTS_PER_TICK,
    });

    for (const account of accounts) {
      if (Date.now() - startedAt > SLICE_MS) break;
      try {
        const r = await collectAccount(account, day);
        if (r.collected) collected += 1;
      } catch (err) {
        if (err instanceof RateLimited) {
          pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          logger.warn('Metrics: Meta rate limit — collector paused 15 min');
          break;
        }
        throw err;
      }
      await sleep(CALL_GAP_MS);
    }

    const pending = await prisma.instagramAccount.count({ where });
    if (collected > 0) logger.info('Metrics collected', { day, collected, pending, userId });
    return { day, collected, pending };
  } catch (err) {
    logger.error('Metrics collector tick failed', { error: err.message });
    return { day, collected, pending: 0 };
  } finally {
    running.delete(key);
  }
}

let lastRetentionDay = null;
async function retention(now = new Date()) {
  const today = spDay(now);
  if (lastRetentionDay === today) return;
  lastRetentionDay = today;
  try {
    await prisma.accountInsightSnapshot.deleteMany({ where: { date: { lt: dbDate(addDays(today, -RETENTION_DAYS)) } } });
  } catch (err) {
    logger.warn('Metrics retention failed', { error: err.message });
  }
}

async function runnerTick() {
  await collectTick();
  await retention();
}

function startCollector() {
  if (timer) return;
  timer = setInterval(runnerTick, TICK_MS);
  firstRun = setTimeout(runnerTick, FIRST_RUN_MS);
  timer.unref?.();
  firstRun.unref?.();
  logger.info('Metrics collector started', { everyMinutes: TICK_MS / 60000 });
}

function stopCollector() {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = null;
  firstRun = null;
}

/**
 * "Atualizar agora": collects this user's missing profiles in the
 * background. At most once every 15 minutes per user.
 */
async function requestRefresh(userId) {
  const day = lastCompleteDay();
  const where = { userId, status: 'ACTIVE', insightSnapshots: { none: { date: dbDate(day) } } };
  const pending = await prisma.instagramAccount.count({ where });
  if (pending === 0) return { started: false, pending: 0, day };
  const last = manualRefreshAt.get(userId) || 0;
  if (Date.now() - last < MANUAL_REFRESH_EVERY_MS) {
    return { started: false, pending, day, retryInMinutes: Math.ceil((MANUAL_REFRESH_EVERY_MS - (Date.now() - last)) / 60000) };
  }
  manualRefreshAt.set(userId, Date.now());
  // Clear the 1h retry for this user's profiles: the user is asking now.
  const ids = await prisma.instagramAccount.findMany({ where: { userId }, select: { id: true } });
  ids.forEach(({ id }) => retryAfter.delete(id));
  collectTick({ userId }).catch(() => {});
  return { started: true, pending, day };
}

// ---------------------------------------------------------------------------
// Overview (Dashboard)
// ---------------------------------------------------------------------------

const SUM_KEYS = ['reach', 'views', 'totalInteractions', 'accountsEngaged', 'likes', 'comments', 'shares', 'saves'];

function emptySums() {
  return Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
}

function addSnap(sums, snap) {
  for (const k of SUM_KEYS) sums[k] += snap[k] || 0;
}

async function resolveAccounts(userId, scope, id) {
  const select = {
    id: true,
    username: true,
    profilePictureUrl: true,
    status: true,
    folderMemberships: { select: { folderId: true } },
  };
  if (scope === 'folder') {
    const folder = await prisma.accountFolder.findFirst({ where: { id, userId }, select: { id: true, name: true } });
    if (!folder) throw new AppError(ErrorCodes.ACCOUNT_FOLDER_NOT_FOUND, 'Pasta não encontrada.', 404);
    const accounts = await prisma.instagramAccount.findMany({
      where: { userId, folderMemberships: { some: { folderId: id } } },
      select,
      orderBy: { username: 'asc' },
    });
    return { accounts, label: folder.name };
  }
  if (scope === 'account') {
    const account = await prisma.instagramAccount.findFirst({ where: { id, userId }, select });
    if (!account) throw new AppError(ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND, 'Perfil não encontrado.', 404);
    return { accounts: [account], label: `@${account.username}` };
  }
  const accounts = await prisma.instagramAccount.findMany({ where: { userId }, select, orderBy: { username: 'asc' } });
  return { accounts, label: 'Geral' };
}

/**
 * @param {string} userId
 * @param {{ scope?: 'all'|'folder'|'account', id?: string, days?: number }} opts
 */
async function getOverview(userId, { scope = 'all', id = null, days = 30 } = {}) {
  if (!['all', 'folder', 'account'].includes(scope)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Escopo inválido.', 400);
  }
  if (scope !== 'all' && !id) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Informe a pasta ou o perfil.', 400);
  const nDays = RANGE_DAYS.includes(Number(days)) ? Number(days) : 30;

  const to = lastCompleteDay();
  const from = addDays(to, -(nDays - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -nDays);
  const dates = Array.from({ length: nDays }, (_, i) => addDays(from, i));

  const { accounts, label } = await resolveAccounts(userId, scope, id);
  const ids = accounts.map((a) => a.id);

  const base = {
    scope,
    id: scope === 'all' ? null : id,
    label,
    range: { from, to, days: nDays, previousFrom: prevFrom, previousTo: prevTo },
  };

  if (ids.length === 0) {
    return {
      ...base,
      totals: { followers: 0, followersDelta: 0, published: 0, ...emptySums() },
      previous: { published: 0, ...emptySums() },
      series: dates.map((date) => ({ date, hasData: false, followers: null, ...emptySums() })),
      ranking: [],
      folders: [],
      coverage: { accounts: 0, withData: 0, noInsights: [] },
      lastCollectedAt: null,
    };
  }

  const [snaps, latest, publishedNow, publishedPrev, publishedByAccount] = await Promise.all([
    prisma.accountInsightSnapshot.findMany({
      where: { instagramAccountId: { in: ids }, date: { gte: dbDate(prevFrom), lte: dbDate(to) } },
      orderBy: { date: 'asc' },
    }),
    prisma.accountInsightSnapshot.findMany({
      where: { instagramAccountId: { in: ids }, followersCount: { not: null } },
      orderBy: [{ instagramAccountId: 'asc' }, { date: 'desc' }],
      distinct: ['instagramAccountId'],
    }),
    prisma.scheduledPost.count({
      where: { userId, instagramAccountId: { in: ids }, status: 'PUBLISHED', publishedAt: { gte: dayStart(from), lt: dayStart(addDays(to, 1)) } },
    }),
    prisma.scheduledPost.count({
      where: { userId, instagramAccountId: { in: ids }, status: 'PUBLISHED', publishedAt: { gte: dayStart(prevFrom), lt: dayStart(from) } },
    }),
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { userId, instagramAccountId: { in: ids }, status: 'PUBLISHED', publishedAt: { gte: dayStart(from), lt: dayStart(addDays(to, 1)) } },
      _count: { _all: true },
    }),
  ]);

  const latestBy = new Map(latest.map((s) => [s.instagramAccountId, s]));
  const publishedBy = new Map(publishedByAccount.map((g) => [g.instagramAccountId, g._count._all]));

  // Per-account maps for the current range.
  const perAccount = new Map(ids.map((aid) => [aid, { byDate: new Map(), sums: emptySums(), firstF: null, lastF: null }]));
  const previous = emptySums();
  for (const s of snaps) {
    const d = dayOf(s.date);
    const acc = perAccount.get(s.instagramAccountId);
    if (d < from) {
      addSnap(previous, s);
      continue;
    }
    acc.byDate.set(d, s);
    addSnap(acc.sums, s);
    if (s.followersCount != null) {
      if (acc.firstF == null) acc.firstF = s.followersCount;
      acc.lastF = s.followersCount;
    }
  }

  // Daily series. Followers: each profile's value carried forward (and back
  // to the start of the range), so profiles never create fake jumps.
  const series = dates.map((date) => ({ date, hasData: false, followers: null, ...emptySums() }));
  for (const acc of perAccount.values()) {
    let carried = acc.firstF;
    dates.forEach((date, i) => {
      const s = acc.byDate.get(date);
      if (s) {
        series[i].hasData = true;
        addSnap(series[i], s);
        if (s.followersCount != null) carried = s.followersCount;
      }
      if (carried != null) series[i].followers = (series[i].followers || 0) + carried;
    });
  }

  const totals = emptySums();
  let followersDelta = 0;
  for (const acc of perAccount.values()) {
    for (const k of SUM_KEYS) totals[k] += acc.sums[k];
    if (acc.firstF != null && acc.lastF != null) followersDelta += acc.lastF - acc.firstF;
  }
  const followers = latest.reduce((sum, s) => sum + (s.followersCount || 0), 0);

  const rowFor = (acc, a) => ({
    followers: latestBy.get(a.id)?.followersCount ?? null,
    followersDelta: acc.firstF != null && acc.lastF != null ? acc.lastF - acc.firstF : 0,
    reach: acc.sums.reach,
    views: acc.sums.views,
    interactions: acc.sums.totalInteractions,
    published: publishedBy.get(a.id) || 0,
  });

  const ranking = accounts.map((a) => ({
    account: { id: a.id, username: a.username, profilePictureUrl: a.profilePictureUrl, status: a.status },
    ...rowFor(perAccount.get(a.id), a),
  }));

  let folders = [];
  if (scope === 'all') {
    const userFolders = await prisma.accountFolder.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    folders = userFolders.map((f) => {
      const members = accounts.filter((a) => a.folderMemberships.some((m) => m.folderId === f.id));
      const row = { folder: f, accounts: members.length, followers: 0, followersDelta: 0, reach: 0, views: 0, interactions: 0, published: 0 };
      for (const a of members) {
        const r = rowFor(perAccount.get(a.id), a);
        row.followers += r.followers || 0;
        row.followersDelta += r.followersDelta;
        row.reach += r.reach;
        row.views += r.views;
        row.interactions += r.interactions;
        row.published += r.published;
      }
      return row;
    });
  }

  const noInsights = accounts
    .filter((a) => latestBy.get(a.id) && latestBy.get(a.id).insightsOk === false)
    .map((a) => ({ id: a.id, username: a.username }));
  const withData = [...perAccount.values()].filter((acc) => acc.byDate.size > 0).length;
  const lastCollectedAt = latest.reduce((max, s) => (!max || s.updatedAt > max ? s.updatedAt : max), null);

  return {
    ...base,
    totals: { followers, followersDelta, published: publishedNow, ...totals },
    previous: { published: publishedPrev, ...previous },
    series,
    ranking,
    folders,
    coverage: { accounts: accounts.length, withData, noInsights },
    lastCollectedAt,
  };
}

module.exports = {
  getOverview,
  requestRefresh,
  collectTick,
  collectAccount,
  startCollector,
  stopCollector,
  // exported for tests
  lastCompleteDay,
  spDay,
  addDays,
  dayStart,
  _reset() {
    retryAfter.clear();
    manualRefreshAt.clear();
    pausedUntil = 0;
  },
};
