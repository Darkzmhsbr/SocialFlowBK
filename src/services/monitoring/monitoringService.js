// Rodada 17: "Monitoramento" — health of the whole operation in one place.
//
// Overview (page): per-profile problems with cause + suggested action,
// counters (healthy / with problems / paused / tokens expiring / empty
// queue), publish success rate of the last 7 days, failures of the last
// 24h and the Telegram status.
//
// Monitor (every 30 min, in the worker process) creates the alerts that
// nothing else creates — they go to the header bell AND to Telegram:
//   TOKEN_EXPIRING  authorization expiring in <= 3 days (1x/day per profile)
//   QUEUE_EMPTY     from 18h: active profiles that were posting in the last
//                   7 days and have nothing scheduled for the next 24h
//                   (1 message per user per day)
//   DAILY_SUMMARY   from 21h, Telegram only, for users who enabled it

const prisma = require('../../config/database');
const notificationService = require('../notifications/notificationService');
const telegramService = require('../telegram/telegramService');
const logger = require('../../utils/logger');

const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // America/Sao_Paulo (UTC-3)
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TOKEN_WARN_DAYS = 7; // shown on the page
const TOKEN_ALERT_DAYS = 3; // alert (bell/Telegram)
const QUEUE_WINDOW_HOURS = 24;
const ACTIVE_WINDOW_DAYS = 7;
const QUEUE_ALERT_FROM_HOUR = 18;
const SUMMARY_FROM_HOUR = 21;
const TICK_MS = 30 * 60 * 1000;
const FIRST_TICK_MS = 3 * 60 * 1000;

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function spDay(date = new Date()) {
  return new Date(date.getTime() - SP_OFFSET_MS).toISOString().slice(0, 10);
}

function spHour(date = new Date()) {
  return new Date(date.getTime() - SP_OFFSET_MS).getUTCHours();
}

function spDayStart(date = new Date()) {
  return new Date(Date.parse(`${spDay(date)}T00:00:00Z`) + SP_OFFSET_MS);
}

function formatTime(date) {
  const d = new Date(new Date(date).getTime() - SP_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(
    d.getUTCHours()
  ).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function issuesFor(account, ctx, now) {
  const issues = [];
  if (account.status !== 'ACTIVE') {
    issues.push({
      key: 'down',
      severity: 'critical',
      title: 'Perfil desconectado',
      cause: account.lastErrorMessage || 'A autorização do Instagram não vale mais (senha trocada, conta restrita ou acesso removido).',
      action: { label: 'Reconectar em Contas', to: '/accounts' },
    });
  }
  if (account.publishPausedUntil && account.publishPausedUntil.getTime() > now) {
    issues.push({
      key: 'paused',
      severity: 'warning',
      title: `Pausado até ${formatTime(account.publishPausedUntil)}`,
      cause: account.pauseReason || 'Limite da Meta atingido.',
      action: { label: 'Nada a fazer: volta sozinho', to: null },
    });
  }
  if (account.status === 'ACTIVE' && account.tokenExpiresAt) {
    const days = Math.ceil((account.tokenExpiresAt.getTime() - now) / DAY);
    if (days <= TOKEN_WARN_DAYS) {
      issues.push({
        key: 'token',
        severity: days <= TOKEN_ALERT_DAYS ? 'warning' : 'info',
        title: days <= 0 ? 'Autorização vencida' : `Autorização vence em ${days} dia(s)`,
        cause: 'O SocialFlow tenta renovar sozinho. Se não conseguir, reconectar resolve.',
        action: { label: 'Reconectar em Contas', to: '/accounts' },
      });
    }
  }
  const failed = ctx.failed24h.get(account.id) || 0;
  if (failed > 0) {
    issues.push({
      key: 'failed',
      severity: 'warning',
      title: `${failed} falha(s) nas últimas 24h`,
      cause: ctx.lastFailure.get(account.id) || 'O Instagram recusou a publicação.',
      action: { label: 'Ver falhas', to: '/posts' },
    });
  }
  if (account.status === 'ACTIVE' && ctx.recentlyActive.has(account.id) && !ctx.upcoming.has(account.id)) {
    issues.push({
      key: 'queue',
      severity: 'info',
      title: `Sem posts nas próximas ${QUEUE_WINDOW_HOURS}h`,
      cause: 'O perfil vinha publicando, mas a fila acabou.',
      action: { label: 'Agendar posts', to: '/posts/new' },
    });
  }
  if (account.status === 'ACTIVE' && ctx.noInsights.has(account.id)) {
    issues.push({
      key: 'insights',
      severity: 'info',
      title: 'Sem permissão de métricas',
      cause: 'Conectado antes da permissão de métricas existir: alcance e visualizações não aparecem no Dashboard.',
      action: { label: 'Reconectar em Contas', to: '/accounts' },
    });
  }
  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

async function getOverview(userId, now = Date.now()) {
  const nowDate = new Date(now);
  const accounts = await prisma.instagramAccount.findMany({
    where: { userId },
    select: {
      id: true,
      username: true,
      profilePictureUrl: true,
      status: true,
      publishPausedUntil: true,
      pauseReason: true,
      lastErrorMessage: true,
      lastErrorAt: true,
      tokenExpiresAt: true,
      lastHealthCheckAt: true,
    },
    orderBy: { username: 'asc' },
  });
  const ids = accounts.map((a) => a.id);
  const since7d = new Date(now - ACTIVE_WINDOW_DAYS * DAY);

  const [failedRows, lastFailures, upcomingRows, activeRows, published7d, failed7d, latestSnaps, telegram] = await Promise.all([
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { userId, status: 'FAILED', updatedAt: { gte: new Date(now - DAY) } },
      _count: { _all: true },
    }),
    prisma.scheduledPost.findMany({
      where: { userId, status: 'FAILED', updatedAt: { gte: new Date(now - DAY) } },
      orderBy: { updatedAt: 'desc' },
      distinct: ['instagramAccountId'],
      select: { instagramAccountId: true, failureReason: true },
    }),
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: {
        userId,
        status: { in: ['SCHEDULED', 'QUEUED', 'PUBLISHING'] },
        scheduledFor: { lte: new Date(now + QUEUE_WINDOW_HOURS * HOUR) },
      },
      _count: { _all: true },
    }),
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { userId, OR: [{ publishedAt: { gte: since7d } }, { scheduledFor: { gte: since7d, lte: nowDate } }] },
      _count: { _all: true },
    }),
    prisma.scheduledPost.count({ where: { userId, status: 'PUBLISHED', publishedAt: { gte: since7d } } }),
    prisma.scheduledPost.count({ where: { userId, status: 'FAILED', updatedAt: { gte: since7d } } }),
    ids.length
      ? prisma.accountInsightSnapshot.findMany({
          where: { instagramAccountId: { in: ids } },
          orderBy: [{ instagramAccountId: 'asc' }, { date: 'desc' }],
          distinct: ['instagramAccountId'],
          select: { instagramAccountId: true, insightsOk: true },
        })
      : [],
    telegramService.getStatus(userId),
  ]);

  const ctx = {
    failed24h: new Map(failedRows.map((r) => [r.instagramAccountId, r._count._all])),
    lastFailure: new Map(lastFailures.map((r) => [r.instagramAccountId, r.failureReason])),
    upcoming: new Set(upcomingRows.map((r) => r.instagramAccountId)),
    recentlyActive: new Set(activeRows.map((r) => r.instagramAccountId)),
    noInsights: new Set(latestSnaps.filter((s) => s.insightsOk === false).map((s) => s.instagramAccountId)),
  };

  const rows = accounts.map((a) => {
    const issues = issuesFor(a, ctx, now);
    const worst = issues[0]?.severity || null;
    return {
      account: { id: a.id, username: a.username, profilePictureUrl: a.profilePictureUrl, status: a.status },
      health: worst === 'critical' ? 'critical' : worst === 'warning' ? 'warning' : worst === 'info' ? 'attention' : 'ok',
      issues,
      lastHealthCheckAt: a.lastHealthCheckAt,
      scheduledNext24h: ctx.upcoming.has(a.id),
    };
  });
  const healthOrder = { critical: 0, warning: 1, attention: 2, ok: 3 };
  rows.sort((x, y) => healthOrder[x.health] - healthOrder[y.health] || x.account.username.localeCompare(y.account.username));

  const has = (row, key) => row.issues.some((i) => i.key === key);
  const finished = published7d + failed7d;
  return {
    summary: {
      accounts: accounts.length,
      healthy: rows.filter((r) => r.health === 'ok' || r.health === 'attention').length,
      critical: rows.filter((r) => r.health === 'critical').length,
      warning: rows.filter((r) => r.health === 'warning').length,
      paused: rows.filter((r) => has(r, 'paused')).length,
      tokensExpiring: rows.filter((r) => has(r, 'token')).length,
      emptyQueue: rows.filter((r) => has(r, 'queue')).length,
      noInsights: rows.filter((r) => has(r, 'insights')).length,
      failures24h: [...ctx.failed24h.values()].reduce((s, n) => s + n, 0),
      published7d,
      failed7d,
      successRate7d: finished ? Math.round((published7d / finished) * 1000) / 10 : null,
    },
    accounts: rows,
    telegram,
    generatedAt: nowDate,
  };
}

// ---------------------------------------------------------------------------
// Monitor (alerts nothing else creates)
// ---------------------------------------------------------------------------

async function alreadyNotified(userId, dedupeKey) {
  const found = await prisma.notification.findFirst({ where: { userId, dedupeKey }, select: { id: true } });
  return Boolean(found);
}

async function checkTokens(now) {
  const accounts = await prisma.instagramAccount.findMany({
    where: { status: 'ACTIVE', tokenExpiresAt: { gt: new Date(now), lte: new Date(now + TOKEN_ALERT_DAYS * DAY) } },
    select: { id: true, userId: true, username: true, tokenExpiresAt: true },
  });
  const day = spDay(new Date(now));
  let created = 0;
  for (const a of accounts) {
    const key = `token-exp:${a.id}:${day}`;
    if (await alreadyNotified(a.userId, key)) continue;
    const days = Math.max(1, Math.ceil((a.tokenExpiresAt.getTime() - now) / DAY));
    await notificationService.notify({
      userId: a.userId,
      type: 'TOKEN_EXPIRING',
      severity: 'warning',
      title: `Autorização de @${a.username} vence em ${days} dia(s)`,
      message: 'O SocialFlow tenta renovar sozinho. Se não conseguir, reconecte o perfil em Contas para as publicações não pararem.',
      instagramAccountId: a.id,
      dedupeKey: key,
      dedupeWindowMinutes: 24 * 60,
    });
    created += 1;
  }
  return created;
}

async function checkEmptyQueues(now) {
  if (spHour(new Date(now)) < QUEUE_ALERT_FROM_HOUR) return 0;
  const since = new Date(now - ACTIVE_WINDOW_DAYS * DAY);
  const [activeRows, upcomingRows] = await Promise.all([
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { OR: [{ publishedAt: { gte: since } }, { scheduledFor: { gte: since, lte: new Date(now) } }] },
      _count: { _all: true },
    }),
    prisma.scheduledPost.groupBy({
      by: ['instagramAccountId'],
      where: { status: { in: ['SCHEDULED', 'QUEUED', 'PUBLISHING'] }, scheduledFor: { lte: new Date(now + QUEUE_WINDOW_HOURS * HOUR) } },
      _count: { _all: true },
    }),
  ]);
  const upcoming = new Set(upcomingRows.map((r) => r.instagramAccountId));
  const candidates = activeRows.map((r) => r.instagramAccountId).filter((id) => !upcoming.has(id));
  if (candidates.length === 0) return 0;
  const accounts = await prisma.instagramAccount.findMany({
    where: { id: { in: candidates }, status: 'ACTIVE' },
    select: { id: true, userId: true, username: true },
    orderBy: { username: 'asc' },
  });
  const byUser = new Map();
  for (const a of accounts) byUser.set(a.userId, [...(byUser.get(a.userId) || []), a.username]);
  const day = spDay(new Date(now));
  let created = 0;
  for (const [userId, names] of byUser) {
    const key = `queue-empty:${userId}:${day}`;
    if (await alreadyNotified(userId, key)) continue;
    const list = names.slice(0, 20).map((n) => `@${n}`).join(', ');
    await notificationService.notify({
      userId,
      type: 'QUEUE_EMPTY',
      severity: 'info',
      title: `${names.length} perfil(is) sem posts agendados para as próximas ${QUEUE_WINDOW_HOURS}h`,
      message: `${list}${names.length > 20 ? ` e mais ${names.length - 20}` : ''}.`,
      dedupeKey: key,
      dedupeWindowMinutes: 24 * 60,
    });
    created += 1;
  }
  return created;
}

async function dailySummaries(now) {
  const nowDate = new Date(now);
  if (spHour(nowDate) < SUMMARY_FROM_HOUR) return 0;
  const dayStart = spDayStart(nowDate);
  const links = await prisma.telegramLink.findMany({
    where: { status: 'ACTIVE', OR: [{ lastDailySummaryAt: null }, { lastDailySummaryAt: { lt: dayStart } }] },
  });
  let sent = 0;
  for (const link of links) {
    const types = Array.isArray(link.alertTypes) ? link.alertTypes : [];
    if (!types.includes('DAILY_SUMMARY')) continue;
    const userId = link.userId;
    const [published, failed, tomorrow, down, paused] = await Promise.all([
      prisma.scheduledPost.count({ where: { userId, status: 'PUBLISHED', publishedAt: { gte: dayStart } } }),
      prisma.scheduledPost.count({ where: { userId, status: 'FAILED', updatedAt: { gte: dayStart } } }),
      prisma.scheduledPost.count({
        where: {
          userId,
          status: { in: ['SCHEDULED', 'QUEUED'] },
          scheduledFor: { gte: new Date(dayStart.getTime() + DAY), lt: new Date(dayStart.getTime() + 2 * DAY) },
        },
      }),
      prisma.instagramAccount.count({ where: { userId, status: { not: 'ACTIVE' } } }),
      prisma.instagramAccount.count({ where: { userId, publishPausedUntil: { gt: nowDate } } }),
    ]);
    const text =
      `📊 <b>Resumo do dia — SocialFlow</b>\n\n` +
      `✅ Publicados hoje: <b>${published}</b>\n` +
      `${failed ? '❌' : '✔️'} Falhas hoje: <b>${failed}</b>\n` +
      `🗓 Agendados para amanhã: <b>${tomorrow}</b>\n` +
      `${down ? '🔴' : '🟢'} Perfis desconectados: <b>${down}</b>` +
      (paused ? `\n⏸ Perfis pausados agora: <b>${paused}</b>` : '');
    try {
      const ok = await telegramService.sendToUser(userId, text);
      if (ok) sent += 1;
    } catch (err) {
      logger.warn('Daily summary failed', { userId, error: err.message });
    }
    await prisma.telegramLink.update({ where: { userId }, data: { lastDailySummaryAt: nowDate } }).catch(() => {});
  }
  return sent;
}

let timer = null;
let firstTimer = null;
let running = false;

async function monitorTick(now = Date.now()) {
  if (running) return null;
  running = true;
  try {
    const tokens = await checkTokens(now);
    const queues = await checkEmptyQueues(now);
    const summaries = await dailySummaries(now);
    if (tokens || queues || summaries) logger.info('Monitor alerts', { tokens, queues, summaries });
    return { tokens, queues, summaries };
  } catch (err) {
    logger.error('Monitor tick failed', { error: err.message });
    return null;
  } finally {
    running = false;
  }
}

function startMonitor() {
  if (timer) return;
  timer = setInterval(() => monitorTick(), TICK_MS);
  firstTimer = setTimeout(() => monitorTick(), FIRST_TICK_MS);
  timer.unref?.();
  firstTimer.unref?.();
  logger.info('Monitor started', { everyMinutes: TICK_MS / 60000 });
}

function stopMonitor() {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
}

module.exports = { getOverview, monitorTick, startMonitor, stopMonitor, spDay, spHour };