// Rodada 18: "Desempenho" — results of each post + best times to publish.
//
// Collector (worker process, every 5 min): reads the metrics of every post
// published by SocialFlow at fixed checkpoints after publishing:
//   24h (Stories: ~20h, before Meta deletes them) · 3d · 7d · 30d
// A checkpoint is only collected inside a short window after it is due, so
// "24h" really means ~24h. Posts already published when this started get one
// 'now' snapshot (current total). The first collection also stores the
// Instagram link and a thumbnail, so the post still shows after a cleanup.
//
// Every snapshot updates the post's result vs THE PROFILE'S OWN AVERAGE
// (same checkpoint, same kind of metric, last 90 days, at least 5 posts):
//   ratio 2.1 = 2.1x the average. Videos/Reels use views, others reach.
// A 24h result >= VIRAL_RATIO creates the "Post viral" alert (bell+Telegram).
//
// Never pauses or takes a profile down: a Meta rate limit stops the
// collector for 15 min; no permission / deleted post = snapshot with
// ok=false (not retried); other errors retry that post one hour later.

const prisma = require('../../config/database');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const { METRICS_BY_TYPE } = require('../instagram/instagramInsightsService');
const { classifyMetaError } = require('../instagram/accountHealthService');
const notificationService = require('../notifications/notificationService');
const { decryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SP_OFFSET_MS = 3 * HOUR; // America/Sao_Paulo (UTC-3)

// key, due after publishing, collection window after due
const CHECKPOINTS = [
  { key: '24h', due: DAY, grace: 6 * HOUR },
  { key: '3d', due: 3 * DAY, grace: 12 * HOUR },
  { key: '7d', due: 7 * DAY, grace: DAY },
  { key: '30d', due: 30 * DAY, grace: 2 * DAY },
];
const STORY_CHECKPOINT = { key: '24h', due: 20 * HOUR, grace: 4 * HOUR };
const ORDER = { now: 0, '24h': 1, '3d': 2, '7d': 3, '30d': 4 };
const BACKFILL_DAYS = 30;
const VIDEO_TYPES = new Set(['REEL', 'FEED_VIDEO']);

const BASELINE_DAYS = 90;
const BASELINE_MIN = 5;
const VIRAL_RATIO = Number(process.env.PERFORMANCE_VIRAL_RATIO) || 3;
const ABOVE = 1.3;
const BELOW = 0.7;

const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 4 * 60 * 1000;
const SLICE_MS = 40 * 1000;
const POSTS_PER_TICK = 80;
const CALL_GAP_MS = 200;
const RETRY_POST_MS = HOUR;
const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;

const BEST_MIN_SAMPLE = 5;
const BLOCK_HOURS = 3;
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function primaryMetric(type) {
  return VIDEO_TYPES.has(type) ? 'views' : 'reach';
}

function kindOf(type) {
  return VIDEO_TYPES.has(type) ? 'video' : 'other';
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

const retryAfter = new Map(); // postId -> timestamp
let pausedUntil = 0;
let running = false;
let timer = null;
let firstTimer = null;

class RateLimited extends Error {}

function isPermissionError(err) {
  const meta = err instanceof AppError ? err.debug || {} : {};
  const code = Number(meta.code) || null;
  return code === 10 || code === 190 || (code >= 200 && code <= 299) || err?.status === 403;
}

function isInvalidRequest(err) {
  const meta = err instanceof AppError ? err.debug || {} : {};
  return Number(meta.code) === 100;
}

const POST_SELECT = {
  id: true,
  userId: true,
  type: true,
  publishedAt: true,
  instagramMediaId: true,
  instagramAccountId: true,
  permalink: true,
  mediaThumbnailUrl: true,
  instagramAccount: { select: { id: true, username: true, status: true, accessTokenEncrypted: true } },
};

function skipIds() {
  const now = Date.now();
  return [...retryAfter.entries()].filter(([, t]) => t > now).map(([id]) => id);
}

/** Posts due for a checkpoint now, plus 'now' backfill. */
async function findDueTasks(now, { userId = null, limit = POSTS_PER_TICK } = {}) {
  const base = {
    status: 'PUBLISHED',
    instagramMediaId: { not: null },
    instagramAccount: { status: 'ACTIVE' },
    ...(userId ? { userId } : {}),
  };
  const skip = skipIds();
  if (skip.length) base.id = { notIn: skip };
  const tasks = [];
  const seen = new Set();
  const push = (post, checkpoint) => {
    if (tasks.length >= limit || seen.has(post.id)) return;
    seen.add(post.id);
    tasks.push({ post, checkpoint });
  };

  for (const cp of [STORY_CHECKPOINT, ...CHECKPOINTS]) {
    const isStory = cp === STORY_CHECKPOINT;
    const posts = await prisma.scheduledPost.findMany({
      where: {
        ...base,
        type: isStory ? 'STORY' : { not: 'STORY' },
        publishedAt: { gte: new Date(now - cp.due - cp.grace), lte: new Date(now - cp.due) },
        postInsightSnapshots: { none: { checkpoint: cp.key } },
      },
      select: POST_SELECT,
      orderBy: { publishedAt: 'asc' },
      take: limit,
    });
    posts.forEach((p) => push(p, cp.key));
  }

  // Backfill: published before the collection existed (or missed): one
  // 'now' snapshot. Stories past 24h have nothing left on Meta.
  if (tasks.length < limit) {
    const posts = await prisma.scheduledPost.findMany({
      where: {
        ...base,
        publishedAt: { gte: new Date(now - BACKFILL_DAYS * DAY), lte: new Date(now - DAY) },
        postInsightSnapshots: { none: {} },
      },
      select: POST_SELECT,
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });
    for (const p of posts) {
      const age = now - p.publishedAt.getTime();
      const inWindow = p.type !== 'STORY' && CHECKPOINTS.some((cp) => age >= cp.due && age <= cp.due + cp.grace);
      if (!inWindow) push(p, 'now');
    }
  }
  return tasks;
}

function metricsFor(type, extended) {
  const list = [...(METRICS_BY_TYPE[type] || METRICS_BY_TYPE.FEED_IMAGE)];
  if (extended && type === 'REEL') list.push('ig_reels_avg_watch_time');
  return list;
}

async function fetchMetrics(post, token) {
  try {
    return { ok: true, raw: await instagramApiClient.fetchMediaInsights(post.instagramMediaId, token, metricsFor(post.type, true)) };
  } catch (err) {
    if (classifyMetaError(err).kind === 'RATE_LIMIT') throw new RateLimited();
    if (isPermissionError(err)) return { ok: false };
    if (!(isInvalidRequest(err) && post.type === 'REEL')) {
      if (isInvalidRequest(err)) return { ok: false }; // media deleted on Instagram
      throw err;
    }
  }
  // Extended metric not accepted: plain list.
  try {
    return { ok: true, raw: await instagramApiClient.fetchMediaInsights(post.instagramMediaId, token, metricsFor(post.type, false)) };
  } catch (err) {
    if (classifyMetaError(err).kind === 'RATE_LIMIT') throw new RateLimited();
    if (isPermissionError(err) || isInvalidRequest(err)) return { ok: false };
    throw err;
  }
}

function columnsFrom(raw) {
  const n = (k) => (typeof raw?.[k] === 'number' ? Math.round(raw[k]) : null);
  return {
    reach: n('reach'),
    views: n('views'),
    likes: n('likes'),
    comments: n('comments'),
    saves: n('saved'),
    shares: n('shares'),
    totalInteractions: n('total_interactions'),
    avgWatchTimeMs: n('ig_reels_avg_watch_time'),
    replies: n('replies'),
    follows: n('follows'),
    profileVisits: n('profile_visits'),
  };
}

/** Average of the profile for this checkpoint/kind, excluding the post itself. */
async function baselineFor({ accountId, checkpoint, type, excludePostId, before }) {
  const metric = primaryMetric(type);
  const rows = await prisma.postInsightSnapshot.findMany({
    where: {
      instagramAccountId: accountId,
      checkpoint,
      ok: true,
      postId: { not: excludePostId },
      postType: VIDEO_TYPES.has(type) ? { in: [...VIDEO_TYPES] } : { notIn: [...VIDEO_TYPES] },
      publishedAt: { gte: new Date(before.getTime() - BASELINE_DAYS * DAY) },
      [metric]: { not: null },
    },
    select: { [metric]: true },
  });
  if (rows.length < BASELINE_MIN) return null;
  const avg = rows.reduce((s, r) => s + r[metric], 0) / rows.length;
  return avg > 0 ? { avg, n: rows.length, metric } : null;
}

async function updatePostPerformance(post, checkpoint, cols) {
  const current = await prisma.scheduledPost.findUnique({
    where: { id: post.id },
    select: { performanceCheckpoint: true },
  });
  if (current?.performanceCheckpoint && ORDER[current.performanceCheckpoint] > ORDER[checkpoint]) return null;
  const metric = primaryMetric(post.type);
  const value = cols[metric];
  if (value == null) return null;
  const base = await baselineFor({
    accountId: post.instagramAccountId,
    checkpoint,
    type: post.type,
    excludePostId: post.id,
    before: post.publishedAt,
  });
  const ratio = base ? Math.round((value / base.avg) * 100) / 100 : null;
  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { performanceRatio: ratio, performanceValue: value, performanceMetric: metric, performanceCheckpoint: checkpoint },
  });
  return { ratio, value, metric, baseline: base };
}

async function collectPost(post, checkpoint) {
  // Story past its 24h on a backfill: Meta has nothing left.
  if (checkpoint === 'now' && post.type === 'STORY') {
    await saveSnapshot(post, checkpoint, { ok: false });
    return { collected: false };
  }
  let token;
  try {
    token = decryptToken(post.instagramAccount.accessTokenEncrypted);
  } catch {
    retryAfter.set(post.id, Date.now() + RETRY_POST_MS);
    return { collected: false };
  }

  const result = await fetchMetrics(post, token);
  if (!result.ok) {
    await saveSnapshot(post, checkpoint, { ok: false });
    return { collected: false };
  }
  const cols = columnsFrom(result.raw);
  await saveSnapshot(post, checkpoint, { ok: true, ...cols });

  // Same data feeds the "Métricas" modal cache (no extra call there).
  const postUpdate = { insightsData: result.raw, insightsUpdatedAt: new Date() };
  if (!post.permalink) {
    await sleep(CALL_GAP_MS);
    try {
      const info = await instagramApiClient.fetchMediaInfo(post.instagramMediaId, token);
      postUpdate.permalink = info.permalink;
      postUpdate.mediaThumbnailUrl = info.thumbnailUrl;
    } catch (err) {
      if (classifyMetaError(err).kind === 'RATE_LIMIT') throw new RateLimited();
    }
  }
  await prisma.scheduledPost.update({ where: { id: post.id }, data: postUpdate });

  const perf = await updatePostPerformance(post, checkpoint, cols);
  if (checkpoint === '24h' && perf?.ratio && perf.ratio >= VIRAL_RATIO) {
    const label = perf.metric === 'views' ? 'visualizações' : 'contas alcançadas';
    await notificationService.notify({
      userId: post.userId,
      type: 'POST_VIRAL',
      severity: 'success',
      title: `🚀 Post viral em @${post.instagramAccount.username}`,
      message: `${perf.value.toLocaleString('pt-BR')} ${label} em 24h: ${String(perf.ratio).replace('.', ',')}× a média do perfil.`,
      instagramAccountId: post.instagramAccountId,
      postId: post.id,
      dedupeKey: `viral:${post.id}`,
      dedupeWindowMinutes: 30 * 24 * 60,
    });
  }
  return { collected: true };
}

async function saveSnapshot(post, checkpoint, data) {
  await prisma.postInsightSnapshot.upsert({
    where: { postId_checkpoint: { postId: post.id, checkpoint } },
    create: {
      userId: post.userId,
      postId: post.id,
      instagramAccountId: post.instagramAccountId,
      checkpoint,
      postType: post.type,
      publishedAt: post.publishedAt,
      ...data,
    },
    update: { ...data, collectedAt: new Date() },
  });
}

async function collectTick({ now = Date.now(), userId = null } = {}) {
  if (running || Date.now() < pausedUntil) return { collected: 0, tasks: 0 };
  running = true;
  const startedAt = Date.now();
  let collected = 0;
  let tasks = [];
  try {
    tasks = await findDueTasks(now, { userId });
    for (const { post, checkpoint } of tasks) {
      if (Date.now() - startedAt > SLICE_MS) break;
      try {
        const r = await collectPost(post, checkpoint);
        if (r.collected) collected += 1;
      } catch (err) {
        if (err instanceof RateLimited) {
          pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
          logger.warn('Performance: Meta rate limit — collector paused 15 min');
          break;
        }
        retryAfter.set(post.id, Date.now() + RETRY_POST_MS);
        logger.warn('Performance: post collection failed (retry in 1h)', { postId: post.id, error: err.message });
      }
      await sleep(CALL_GAP_MS);
    }
    if (collected) logger.info('Post metrics collected', { collected, due: tasks.length });
  } catch (err) {
    logger.error('Performance collector tick failed', { error: err.message });
  } finally {
    running = false;
  }
  return { collected, tasks: tasks.length };
}

function startCollector() {
  if (timer) return;
  timer = setInterval(() => collectTick(), TICK_MS);
  firstTimer = setTimeout(() => collectTick(), FIRST_TICK_MS);
  timer.unref?.();
  firstTimer.unref?.();
  logger.info('Post performance collector started', { everyMinutes: TICK_MS / 60000 });
}

function stopCollector() {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
}

// ---------------------------------------------------------------------------
// Queries for the page
// ---------------------------------------------------------------------------

function invalid(message) {
  return new AppError(ErrorCodes.PERFORMANCE_INVALID, message, 400);
}

async function resolveAccountIds(userId, { scope = 'all', id = null, ids = null } = {}) {
  if (scope === 'folder') {
    if (!id) throw invalid('Informe a pasta.');
    const folder = await prisma.accountFolder.findFirst({ where: { id, userId }, select: { name: true } });
    if (!folder) throw new AppError(ErrorCodes.ACCOUNT_FOLDER_NOT_FOUND, 'Pasta não encontrada.', 404);
    const rows = await prisma.instagramAccount.findMany({
      where: { userId, folderMemberships: { some: { folderId: id } } },
      select: { id: true },
    });
    return { ids: rows.map((r) => r.id), label: folder.name };
  }
  if (scope === 'account') {
    if (!id) throw invalid('Informe o perfil.');
    const acc = await prisma.instagramAccount.findFirst({ where: { id, userId }, select: { id: true, username: true } });
    if (!acc) throw new AppError(ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND, 'Perfil não encontrado.', 404);
    return { ids: [acc.id], label: `@${acc.username}` };
  }
  if (scope === 'accounts') {
    const list = (Array.isArray(ids) ? ids : String(ids || '').split(',')).map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const rows = await prisma.instagramAccount.findMany({ where: { userId, id: { in: list } }, select: { id: true } });
    return { ids: rows.map((r) => r.id), label: `${rows.length} perfil(is)` };
  }
  if (scope !== 'all') throw invalid('Escopo inválido.');
  const rows = await prisma.instagramAccount.findMany({ where: { userId }, select: { id: true } });
  return { ids: rows.map((r) => r.id), label: 'Geral' };
}

const SORTS = ['ratio', 'views', 'reach', 'engagement', 'shares', 'saves', 'likes', 'comments', 'publishedAt'];
const TYPES = ['REEL', 'FEED_VIDEO', 'FEED_IMAGE', 'FEED_CAROUSEL', 'STORY'];
const CHECKPOINT_FILTERS = ['24h', '3d', '7d', '30d', 'latest'];
const MAX_POSTS = 5000;

function rating(ratio) {
  if (ratio == null) return null;
  if (ratio >= ABOVE) return 'above';
  if (ratio <= BELOW) return 'below';
  return 'average';
}

function avg(list) {
  const vals = list.filter((v) => typeof v === 'number');
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/**
 * Ranking + highlights + formats.
 * opts: scope, id, ids, days (7|30|90), type, checkpoint ('24h'|'3d'|'7d'|'30d'|'latest'), sort, take, skip
 */
async function getPosts(userId, opts = {}) {
  const days = [7, 30, 90].includes(Number(opts.days)) ? Number(opts.days) : 30;
  const checkpoint = CHECKPOINT_FILTERS.includes(opts.checkpoint) ? opts.checkpoint : 'latest';
  const sort = SORTS.includes(opts.sort) ? opts.sort : 'ratio';
  const take = Math.min(Math.max(Number(opts.take) || 50, 1), 2000);
  const skip = Math.max(Number(opts.skip) || 0, 0);
  if (opts.type && !TYPES.includes(opts.type)) throw invalid('Tipo inválido.');
  const { ids, label } = await resolveAccountIds(userId, opts);
  const now = Date.now();
  const since = new Date(now - days * DAY);

  const empty = {
    label,
    days,
    checkpoint,
    totals: { posts: 0, withData: 0, waiting: 0, noPermission: 0 },
    rows: [],
    total: 0,
    highlights: { top: [], mostShared: null, mostSaved: null, belowCount: 0 },
    formats: [],
  };
  if (ids.length === 0) return empty;

  const posts = await prisma.scheduledPost.findMany({
    where: {
      userId,
      instagramAccountId: { in: ids },
      status: 'PUBLISHED',
      publishedAt: { gte: since },
      ...(opts.type ? { type: opts.type } : {}),
    },
    select: {
      id: true,
      type: true,
      caption: true,
      publishedAt: true,
      permalink: true,
      mediaThumbnailUrl: true,
      instagramAccountId: true,
      instagramAccount: { select: { id: true, username: true, profilePictureUrl: true } },
      medias: {
        orderBy: { order: 'asc' },
        take: 1,
        select: { mediaAsset: { select: { url: true, type: true, purgedAt: true } } },
      },
      coverMediaAsset: { select: { url: true, purgedAt: true } },
      postInsightSnapshots: true,
    },
    orderBy: { publishedAt: 'desc' },
    take: MAX_POSTS,
  });

  // Baselines per account + checkpoint + kind (videos vs others).
  const baseRows = await prisma.postInsightSnapshot.findMany({
    where: { instagramAccountId: { in: ids }, ok: true, publishedAt: { gte: new Date(now - (days + BASELINE_DAYS) * DAY) } },
    select: { postId: true, instagramAccountId: true, checkpoint: true, postType: true, views: true, reach: true },
  });
  const baseMap = new Map();
  for (const r of baseRows) {
    const metric = primaryMetric(r.postType);
    if (r[metric] == null) continue;
    const key = `${r.instagramAccountId}|${r.checkpoint}|${kindOf(r.postType)}`;
    if (!baseMap.has(key)) baseMap.set(key, []);
    baseMap.get(key).push({ postId: r.postId, v: r[metric] });
  }
  const ratioFor = (post, snap) => {
    const metric = primaryMetric(post.type);
    const value = snap[metric];
    if (value == null) return null;
    const list = (baseMap.get(`${post.instagramAccountId}|${snap.checkpoint}|${kindOf(post.type)}`) || []).filter((x) => x.postId !== post.id);
    if (list.length < BASELINE_MIN) return null;
    const mean = list.reduce((s, x) => s + x.v, 0) / list.length;
    return mean > 0 ? Math.round((value / mean) * 100) / 100 : null;
  };

  const totals = { posts: posts.length, withData: 0, waiting: 0, noPermission: 0 };
  const rows = [];
  for (const p of posts) {
    const snaps = p.postInsightSnapshots || [];
    let snap;
    if (checkpoint === 'latest') snap = [...snaps].sort((a, b) => ORDER[b.checkpoint] - ORDER[a.checkpoint])[0];
    else snap = snaps.find((s) => s.checkpoint === checkpoint);
    if (!snap) {
      totals.waiting += 1;
      continue;
    }
    if (!snap.ok) {
      totals.noPermission += 1;
      continue;
    }
    totals.withData += 1;
    const ratio = ratioFor(p, snap);
    const media = p.medias?.[0]?.mediaAsset;
    const ownThumb =
      (p.coverMediaAsset && !p.coverMediaAsset.purgedAt && p.coverMediaAsset.url) ||
      (media && !media.purgedAt && media.type === 'IMAGE' ? media.url : null);
    rows.push({
      post: {
        id: p.id,
        type: p.type,
        caption: p.caption ? p.caption.slice(0, 120) : null,
        publishedAt: p.publishedAt,
        permalink: p.permalink,
        thumbnailUrl: p.mediaThumbnailUrl || ownThumb || null,
        videoUrl: !p.mediaThumbnailUrl && !ownThumb && media && !media.purgedAt && media.type === 'VIDEO' ? media.url : null,
      },
      account: p.instagramAccount,
      checkpoint: snap.checkpoint,
      metrics: {
        views: snap.views,
        reach: snap.reach,
        likes: snap.likes,
        comments: snap.comments,
        saves: snap.saves,
        shares: snap.shares,
        totalInteractions: snap.totalInteractions,
        avgWatchTimeMs: snap.avgWatchTimeMs,
      },
      engagementRate: snap.reach ? Math.round(((snap.totalInteractions || 0) / snap.reach) * 1000) / 10 : null,
      primaryMetric: primaryMetric(p.type),
      ratio,
      rating: rating(ratio),
    });
  }

  const sortValue = (r) => {
    if (sort === 'publishedAt') return new Date(r.post.publishedAt).getTime();
    if (sort === 'ratio') return r.ratio ?? -1;
    if (sort === 'engagement') return r.engagementRate ?? -1;
    return r.metrics[sort] ?? -1;
  };
  rows.sort((a, b) => sortValue(b) - sortValue(a));

  const byViews = rows.filter((r) => r.metrics.views != null).sort((a, b) => b.metrics.views - a.metrics.views);
  const top = (byViews.length ? byViews : [...rows].sort((a, b) => (b.metrics.reach || 0) - (a.metrics.reach || 0))).slice(0, 5);
  const best = (key) => rows.filter((r) => r.metrics[key]).sort((a, b) => b.metrics[key] - a.metrics[key])[0] || null;

  const formats = TYPES.map((type) => {
    const list = rows.filter((r) => r.post.type === type);
    if (!list.length) return null;
    const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
    return {
      type,
      posts: list.length,
      avgViews: VIDEO_TYPES.has(type) ? round(avg(list.map((r) => r.metrics.views))) : null,
      avgReach: round(avg(list.map((r) => r.metrics.reach))),
      avgEngagementRate: round(avg(list.map((r) => r.engagementRate)), 1),
      avgShares: round(avg(list.map((r) => r.metrics.shares)), 1),
      avgSaves: round(avg(list.map((r) => r.metrics.saves)), 1),
      avgRatio: round(avg(list.map((r) => r.ratio)), 2),
    };
  }).filter(Boolean);

  return {
    label,
    days,
    checkpoint,
    totals,
    rows: rows.slice(skip, skip + take),
    total: rows.length,
    highlights: {
      top,
      mostShared: best('shares'),
      mostSaved: best('saves'),
      belowCount: rows.filter((r) => r.rating === 'below').length,
    },
    formats,
  };
}

function spSlot(date) {
  const d = new Date(new Date(date).getTime() - SP_OFFSET_MS);
  return { weekday: d.getUTCDay(), block: Math.floor(d.getUTCHours() / BLOCK_HOURS) };
}

function blockLabel(block) {
  const from = block * BLOCK_HOURS;
  return `${String(from).padStart(2, '0')}–${String(from + BLOCK_HOURS).padStart(2, '0')}h`;
}

/**
 * Heatmap weekday x 3h block (Brasília). Each post counts with its result
 * vs its own profile average, so profiles of different sizes mix fairly.
 * A cell needs BEST_MIN_SAMPLE posts to be shown.
 */
async function getBestTimes(userId, opts = {}) {
  const days = [30, 60, 90, 180].includes(Number(opts.days)) ? Number(opts.days) : 90;
  const { ids, label } = await resolveAccountIds(userId, opts);
  const blocks = 24 / BLOCK_HOURS;
  const cells = [];
  for (let w = 0; w < 7; w += 1) for (let b = 0; b < blocks; b += 1) cells.push({ weekday: w, block: b, n: 0, sum: 0 });
  const rows = WEEKDAYS.map((_, w) => ({ weekday: w, n: 0, sum: 0 }));
  const cols = Array.from({ length: blocks }, (_, b) => ({ block: b, n: 0, sum: 0 }));

  const posts = ids.length
    ? await prisma.scheduledPost.findMany({
        where: {
          userId,
          instagramAccountId: { in: ids },
          status: 'PUBLISHED',
          publishedAt: { gte: new Date(Date.now() - days * DAY) },
          performanceRatio: { not: null },
          ...(opts.type && TYPES.includes(opts.type) ? { type: opts.type } : {}),
        },
        select: { publishedAt: true, performanceRatio: true },
        take: 20000,
      })
    : [];
  for (const p of posts) {
    const { weekday, block } = spSlot(p.publishedAt);
    const r = Math.min(p.performanceRatio, 10); // one huge viral post can't paint a whole cell
    const cell = cells[weekday * blocks + block];
    cell.n += 1;
    cell.sum += r;
    rows[weekday].n += 1;
    rows[weekday].sum += r;
    cols[block].n += 1;
    cols[block].sum += r;
  }
  const finish = (c) => ({
    ...c,
    sum: undefined,
    avgRatio: c.n >= BEST_MIN_SAMPLE ? Math.round((c.sum / c.n) * 100) / 100 : null,
  });
  const outCells = cells.map(finish);
  const best = outCells
    .filter((c) => c.avgRatio != null && c.avgRatio > 1)
    .sort((a, b) => b.avgRatio - a.avgRatio)
    .slice(0, 3)
    .map((c) => ({ ...c, label: `${WEEKDAYS[c.weekday]} ${blockLabel(c.block)}` }));
  const summary = best.length
    ? `Melhores janelas: ${best.map((b) => `${b.label} (${b.avgRatio >= 1 ? '+' : ''}${Math.round((b.avgRatio - 1) * 100)}%)`).join(', ')} — baseado em ${posts.length} post(s).`
    : posts.length
    ? `Ainda sem padrão claro (${posts.length} post(s) com resultado). Cada faixa precisa de ${BEST_MIN_SAMPLE} posts.`
    : 'Ainda não há posts com resultado medido.';

  return {
    label,
    days,
    blockHours: BLOCK_HOURS,
    minSample: BEST_MIN_SAMPLE,
    totalPosts: posts.length,
    weekdays: WEEKDAYS,
    blocks: Array.from({ length: blocks }, (_, b) => blockLabel(b)),
    cells: outCells,
    rows: rows.map(finish),
    cols: cols.map(finish),
    best,
    summary,
  };
}

/** For the "Métricas" modal: evolution + comparison of one post. */
async function postHistory(postId) {
  const [snaps, post] = await Promise.all([
    prisma.postInsightSnapshot.findMany({ where: { postId, ok: true } }),
    prisma.scheduledPost.findUnique({
      where: { id: postId },
      select: { performanceRatio: true, performanceValue: true, performanceMetric: true, performanceCheckpoint: true, permalink: true },
    }),
  ]);
  return {
    history: snaps
      .sort((a, b) => ORDER[a.checkpoint] - ORDER[b.checkpoint])
      .map((s) => ({
        checkpoint: s.checkpoint,
        collectedAt: s.collectedAt,
        views: s.views,
        reach: s.reach,
        likes: s.likes,
        comments: s.comments,
        saves: s.saves,
        shares: s.shares,
        totalInteractions: s.totalInteractions,
      })),
    performance: post?.performanceCheckpoint
      ? {
          ratio: post.performanceRatio,
          value: post.performanceValue,
          metric: post.performanceMetric,
          checkpoint: post.performanceCheckpoint,
          rating: rating(post.performanceRatio),
        }
      : null,
    permalink: post?.permalink || null,
  };
}

module.exports = {
  collectTick,
  findDueTasks,
  startCollector,
  stopCollector,
  getPosts,
  getBestTimes,
  postHistory,
  rating,
  VIRAL_RATIO,
  _reset() {
    retryAfter.clear();
    pausedUntil = 0;
  },
};