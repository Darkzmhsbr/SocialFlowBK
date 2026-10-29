// Rodada 5: header notifications (bell). Creating a notification must NEVER
// break the flow that triggered it (publish, health check), so notify()
// swallows its own errors and only logs them.
//
// Dedupe: callers pass a dedupeKey (e.g. "paused:<accountId>:<until>").
// If an UNREAD notification with the same key exists inside the window,
// nothing new is created — one alert per event, not one per post.

const prisma = require('../../config/database');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const DEFAULT_DEDUPE_WINDOW_MINUTES = 12 * 60;

/**
 * @param {object} n
 * @param {string} n.userId
 * @param {string} n.type        - ACCOUNT_DOWN | ACCOUNT_PAUSED | BATCH_COMPLETED | POSTS_FAILED | ...
 * @param {'info'|'success'|'warning'|'error'} [n.severity]
 * @param {string} n.title
 * @param {string} [n.message]
 * @param {string} [n.instagramAccountId]
 * @param {string} [n.postId]
 * @param {string} [n.batchId]
 * @param {string} [n.dedupeKey]
 * @param {number} [n.dedupeWindowMinutes]
 */
async function notify(n) {
  try {
    if (n.dedupeKey) {
      const windowMs = (n.dedupeWindowMinutes ?? DEFAULT_DEDUPE_WINDOW_MINUTES) * 60 * 1000;
      const existing = await prisma.notification.findFirst({
        where: {
          userId: n.userId,
          dedupeKey: n.dedupeKey,
          readAt: null,
          createdAt: { gte: new Date(Date.now() - windowMs) },
        },
        select: { id: true },
      });
      if (existing) return null;
    }

    const created = await prisma.notification.create({
      data: {
        userId: n.userId,
        type: n.type,
        severity: n.severity || 'info',
        title: String(n.title || '').slice(0, 200),
        message: n.message ? String(n.message).slice(0, 2000) : null,
        instagramAccountId: n.instagramAccountId ?? null,
        postId: n.postId ?? null,
        batchId: n.batchId ?? null,
        dedupeKey: n.dedupeKey ?? null,
      },
    });
    logger.info('Notification created', { userId: n.userId, type: n.type, notificationId: created.id });
    return created;
  } catch (err) {
    logger.warn('Notification create failed (ignored)', { type: n?.type, error: err.message });
    return null;
  }
}

async function list(userId, { unreadOnly = false, take = 30, skip = 0 } = {}) {
  const where = { userId, ...(unreadOnly ? { readAt: null } : {}) };
  const [items, unreadCount] = await prisma.$transaction([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: Math.min(Math.max(Number(take) || 30, 1), 100),
      skip: Math.max(Number(skip) || 0, 0),
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { notifications: items.map(toPublicShape), unreadCount };
}

async function unreadCount(userId) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

async function markRead(id, userId) {
  const found = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
  if (!found) {
    throw new AppError(ErrorCodes.NOTIFICATION_NOT_FOUND, 'Notificação não encontrada.', 404);
  }
  await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  return { id };
}

async function markAllRead(userId) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: count };
}

// ---------------------------------------------------------------------------
// Hook called by the publish worker after EVERY publish attempt (success,
// final failure, retry or pause). Reads the post's current state and:
//   - final FAILED (not a pause) -> one "posts failed" alert per account/hour
//   - post belongs to a batch and the batch has nothing left pending ->
//     "batch finished" summary (once per batch)
// Never throws.
// ---------------------------------------------------------------------------
async function onPostSettled(postRef) {
  try {
    const post = await prisma.scheduledPost.findUnique({
      where: { id: postRef.id },
      select: {
        id: true,
        userId: true,
        status: true,
        batchId: true,
        failureReason: true,
        instagramAccountId: true,
        instagramAccount: { select: { username: true } },
      },
    });
    if (!post) return;

    if (post.status === 'FAILED') {
      const hourKey = new Date().toISOString().slice(0, 13);
      await notify({
        userId: post.userId,
        type: 'POSTS_FAILED',
        severity: 'error',
        title: `Falha ao publicar em @${post.instagramAccount?.username || 'perfil'}`,
        message: `${post.failureReason || 'O Instagram recusou a publicação.'} Abra Posts → Falhou para tentar de novo com "Publicar agora".`,
        instagramAccountId: post.instagramAccountId,
        postId: post.id,
        dedupeKey: `posts-failed:${post.instagramAccountId}:${hourKey}`,
        dedupeWindowMinutes: 60,
      });
    }

    if (post.batchId && (post.status === 'PUBLISHED' || post.status === 'FAILED')) {
      const groups = await prisma.scheduledPost.groupBy({
        by: ['status'],
        where: { batchId: post.batchId, userId: post.userId },
        _count: { _all: true },
      });
      const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
      const pending = (counts.SCHEDULED || 0) + (counts.QUEUED || 0) + (counts.PUBLISHING || 0);
      if (pending === 0) {
        const published = counts.PUBLISHED || 0;
        const failed = counts.FAILED || 0;
        await notify({
          userId: post.userId,
          type: 'BATCH_COMPLETED',
          severity: failed > 0 ? 'warning' : 'success',
          title: failed > 0 ? 'Lote concluído com falhas' : 'Lote concluído',
          message: `${published} publicado(s)${failed > 0 ? `, ${failed} com falha` : ''}.`,
          batchId: post.batchId,
          dedupeKey: `batch-done:${post.batchId}`,
          dedupeWindowMinutes: 7 * 24 * 60,
        });
      }
    }
  } catch (err) {
    logger.warn('onPostSettled failed (ignored)', { postId: postRef?.id, error: err.message });
  }
}

function toPublicShape(n) {
  return {
    id: n.id,
    type: n.type,
    severity: n.severity,
    title: n.title,
    message: n.message,
    instagramAccountId: n.instagramAccountId,
    postId: n.postId,
    batchId: n.batchId,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

module.exports = { notify, list, unreadCount, markRead, markAllRead, onPostSettled, toPublicShape };