// Rodada 12: background cleanup ("Limpeza") + reports + automatic rules.
//
// Actions:
//   DELETE_POSTS  - remove posts from SocialFlow (never from Instagram — the
//                   official API can't delete published media). Files no
//                   longer used by any post are deleted from storage, except
//                   media kept in the Biblioteca.
//   ARCHIVE_POSTS - archive posts (reversible history, nothing deleted).
//   FREE_STORAGE  - for PUBLISHED posts: delete the video/image FILE from
//                   storage (Backblaze/Cloudinary) and keep the post, its
//                   metrics and history. Skips Biblioteca media and files
//                   still used by a pending post.
//
// Jobs run in the background inside the worker process: a few hundred
// posts at a time, with a cursor so a restart/deploy resumes where it
// stopped. Each job keeps a report (counters, freed bytes, skip reasons).

const prisma = require('../../config/database');
const mediaService = require('../media/mediaService');
const notificationService = require('../notifications/notificationService');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const ACTIONS = ['DELETE_POSTS', 'ARCHIVE_POSTS', 'FREE_STORAGE'];
const STATUSES = ['DRAFT', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'ARCHIVED'];
const TYPES = ['FEED_IMAGE', 'FEED_VIDEO', 'FEED_CAROUSEL', 'REEL', 'STORY'];
const IN_FLIGHT = ['QUEUED', 'PUBLISHING'];

const DEFAULT_STATUSES = {
  DELETE_POSTS: ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'ARCHIVED'],
  ARCHIVE_POSTS: ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'FAILED'],
  FREE_STORAGE: ['PUBLISHED'],
};

const CHUNK_SIZE = 100;
const MAX_POSTS_PER_JOB = 20000;
const SLICE_MS = 20 * 1000; // max work per runner tick (lets cancel/other users in)
const RUNNER_TICK_MS = 5 * 1000;
const AUTO_CHECK_MS = 60 * 60 * 1000;
const AUTO_EVERY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

function normalizeFilter(action, raw = {}) {
  if (!ACTIONS.includes(action)) {
    throw new AppError(ErrorCodes.CLEANUP_INVALID, `Ação de limpeza inválida: ${action}.`, 400);
  }
  let status = raw.status || null;
  if (status && !STATUSES.includes(status)) {
    throw new AppError(ErrorCodes.CLEANUP_INVALID, `Status inválido: ${status}.`, 400);
  }
  if (action === 'FREE_STORAGE') status = 'PUBLISHED';
  if (status && IN_FLIGHT.includes(status)) {
    throw new AppError(
      ErrorCodes.CLEANUP_INVALID,
      'Posts na fila ou em publicação não podem ser limpos. Aguarde terminarem.',
      400
    );
  }
  if (action === 'ARCHIVE_POSTS' && status === 'ARCHIVED') {
    throw new AppError(ErrorCodes.CLEANUP_INVALID, 'Esses posts já estão arquivados.', 400);
  }
  const typesInput = Array.isArray(raw.types) ? raw.types : String(raw.types || '').split(',');
  const types = typesInput.map((t) => String(t).trim()).filter((t) => TYPES.includes(t));
  const days = Number(raw.olderThanDays);
  return {
    status,
    accountId: raw.accountId || null,
    folderId: raw.folderId || null,
    batchId: raw.batchId || null,
    types: types.length ? types : null,
    olderThanDays: Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : null,
  };
}

function buildWhere(userId, action, f) {
  const statuses = f.status ? [f.status] : DEFAULT_STATUSES[action];
  const where = { userId, status: { in: statuses } };
  if (f.accountId) where.instagramAccountId = f.accountId;
  if (f.folderId) where.instagramAccount = { folderMemberships: { some: { folderId: f.folderId } } };
  if (f.batchId) where.batchId = f.batchId;
  if (f.types) where.type = { in: f.types };
  if (f.olderThanDays) {
    const cutoff = new Date(Date.now() - f.olderThanDays * 24 * 60 * 60 * 1000);
    // Published posts age from the publish date; everything else from creation.
    if (statuses.length === 1 && statuses[0] === 'PUBLISHED') where.publishedAt = { lt: cutoff };
    else where.createdAt = { lt: cutoff };
  }
  return where;
}

function inFlightWhere(userId, f) {
  const where = buildWhere(userId, 'DELETE_POSTS', { ...f, status: null });
  where.status = { in: IN_FLIGHT };
  delete where.createdAt;
  return where;
}

// ---------------------------------------------------------------------------
// preview / create / list / cancel / settings
// ---------------------------------------------------------------------------

async function preview(userId, { action, filter } = {}) {
  const f = normalizeFilter(action, filter);
  const where = buildWhere(userId, action, f);
  const [matched, inFlight] = await Promise.all([
    prisma.scheduledPost.count({ where }),
    action === 'FREE_STORAGE' ? Promise.resolve(0) : prisma.scheduledPost.count({ where: inFlightWhere(userId, f) }),
  ]);

  // File estimate: unique, not-kept, not-yet-purged files of the first 5000
  // matching posts (an estimate — shared files are checked when running).
  let estimatedFiles = 0;
  let estimatedBytes = 0;
  if (action !== 'ARCHIVE_POSTS' && matched > 0) {
    const rows = await prisma.scheduledPost.findMany({
      where,
      take: 5000,
      select: {
        medias: { select: { mediaAsset: { select: { id: true, bytes: true, inLibrary: true, purgedAt: true } } } },
        coverMediaAsset: { select: { id: true, bytes: true, inLibrary: true, purgedAt: true } },
      },
    });
    const seen = new Map();
    for (const row of rows) {
      const assets = [...row.medias.map((m) => m.mediaAsset), row.coverMediaAsset].filter(Boolean);
      for (const a of assets) {
        if (!a.inLibrary && !a.purgedAt && !seen.has(a.id)) seen.set(a.id, a.bytes || 0);
      }
    }
    estimatedFiles = seen.size;
    estimatedBytes = [...seen.values()].reduce((s, b) => s + b, 0);
  }

  return {
    action,
    filter: f,
    matched: Math.min(matched, MAX_POSTS_PER_JOB),
    overLimit: matched > MAX_POSTS_PER_JOB,
    inFlightSkipped: inFlight,
    estimatedFiles,
    estimatedBytes,
  };
}

async function createJob(userId, { action, filter } = {}, kind = 'MANUAL') {
  const p = await preview(userId, { action, filter });
  if (p.matched === 0) {
    throw new AppError(ErrorCodes.CLEANUP_INVALID, 'Nenhum post encontrado com esses filtros.', 400);
  }
  const job = await prisma.cleanupJob.create({
    data: {
      userId,
      kind,
      action,
      status: 'QUEUED',
      filter: p.filter,
      matched: p.matched,
      skippedReasons: p.inFlightSkipped ? { 'na fila ou em publicação': p.inFlightSkipped } : undefined,
      skipped: p.inFlightSkipped || 0,
    },
  });
  logger.info('Cleanup job created', { userId, jobId: job.id, action, kind, matched: p.matched });
  return job;
}

function listJobs(userId, { scope = 'all', take = 50 } = {}) {
  const where = { userId };
  if (scope === 'active') where.status = { in: ['QUEUED', 'RUNNING'] };
  if (scope === 'done') where.status = { in: ['DONE', 'FAILED', 'CANCELED'] };
  return prisma.cleanupJob.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(take) || 50, 1), 200),
  });
}

async function cancelJob(id, userId) {
  const job = await prisma.cleanupJob.findFirst({ where: { id, userId } });
  if (!job) throw new AppError(ErrorCodes.CLEANUP_JOB_NOT_FOUND, 'Limpeza não encontrada.', 404);
  if (job.status === 'QUEUED') {
    return prisma.cleanupJob.update({
      where: { id },
      data: { status: 'CANCELED', finishedAt: new Date() },
    });
  }
  if (job.status === 'RUNNING') {
    return prisma.cleanupJob.update({ where: { id }, data: { cancelRequested: true } });
  }
  return job;
}

async function getSettings(userId) {
  const s = await prisma.cleanupSetting.findUnique({ where: { userId } });
  return {
    freeStorageAfterDays: s?.freeStorageAfterDays ?? null,
    archiveFailedAfterDays: s?.archiveFailedAfterDays ?? null,
    lastAutoRunAt: s?.lastAutoRunAt ?? null,
  };
}

function cleanDays(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 3650) {
    throw new AppError(ErrorCodes.CLEANUP_INVALID, 'Número de dias inválido (1 a 3650).', 400);
  }
  return Math.floor(n);
}

async function saveSettings(userId, body = {}) {
  const data = {
    freeStorageAfterDays: cleanDays(body.freeStorageAfterDays),
    archiveFailedAfterDays: cleanDays(body.archiveFailedAfterDays),
  };
  await prisma.cleanupSetting.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return getSettings(userId);
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let runnerTimer = null;
let autoTimer = null;
let running = false;

async function runnerTick() {
  if (running) return;
  running = true;
  try {
    // Resume an interrupted job first, then the oldest queued one.
    const job =
      (await prisma.cleanupJob.findFirst({ where: { status: 'RUNNING' }, orderBy: { createdAt: 'asc' } })) ||
      (await prisma.cleanupJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } }));
    if (job) await processJob(job);
  } catch (err) {
    logger.error('Cleanup runner tick failed', { error: err.message });
  } finally {
    running = false;
  }
}

async function processJob(job) {
  const startedSlice = Date.now();
  if (job.status === 'QUEUED') {
    job = await prisma.cleanupJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt: job.startedAt || new Date() },
    });
    logger.info('Cleanup job started', { jobId: job.id, action: job.action });
  }

  const f = job.filter || {};
  const baseWhere = buildWhere(job.userId, job.action, f);

  try {
    while (Date.now() - startedSlice < SLICE_MS) {
      const fresh = await prisma.cleanupJob.findUnique({
        where: { id: job.id },
        select: { cancelRequested: true, processed: true, cursor: true },
      });
      if (!fresh) return;
      if (fresh.cancelRequested) {
        await finish(job.id, 'CANCELED');
        return;
      }
      if (fresh.processed >= MAX_POSTS_PER_JOB) {
        await finish(job.id, 'DONE');
        return;
      }

      const where = fresh.cursor ? { ...baseWhere, id: { gt: fresh.cursor } } : baseWhere;
      const posts = await prisma.scheduledPost.findMany({
        where,
        orderBy: { id: 'asc' },
        take: CHUNK_SIZE,
        include: { medias: { include: { mediaAsset: true } }, coverMediaAsset: true },
      });

      if (posts.length === 0) {
        await finish(job.id, 'DONE');
        return;
      }

      const result = await applyChunk(job, posts);
      const lastId = posts[posts.length - 1].id;

      const current = await prisma.cleanupJob.findUnique({ where: { id: job.id }, select: { skippedReasons: true } });
      const reasons = { ...(current?.skippedReasons || {}) };
      for (const [k, v] of Object.entries(result.reasons)) reasons[k] = (reasons[k] || 0) + v;

      await prisma.cleanupJob.update({
        where: { id: job.id },
        data: {
          cursor: lastId,
          processed: { increment: posts.length },
          affected: { increment: result.affected },
          skipped: { increment: result.skipped },
          mediaDeleted: { increment: result.mediaDeleted },
          bytesFreed: { increment: result.bytesFreed },
          skippedReasons: reasons,
        },
      });
    }
    // Slice used up: the next tick continues from the cursor.
  } catch (err) {
    logger.error('Cleanup job failed', { jobId: job.id, error: err.message });
    await prisma.cleanupJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', errorMessage: String(err.message).slice(0, 1000), finishedAt: new Date() },
    });
    await notifyFinished(job.id);
  }
}

function addReason(reasons, key) {
  reasons[key] = (reasons[key] || 0) + 1;
}

/** Delete a file that no post uses anymore (Biblioteca media is kept). */
async function purgeOrphan(assetId) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.inLibrary) return 0;
  const [pm, cover] = await Promise.all([
    prisma.postMedia.count({ where: { mediaAssetId: assetId } }),
    prisma.scheduledPost.count({ where: { coverMediaAssetId: assetId } }),
  ]);
  if (pm + cover > 0) return 0;
  if (!asset.purgedAt) await mediaService.deleteFromStorage(asset);
  await prisma.mediaAsset.delete({ where: { id: assetId } });
  return asset.purgedAt ? 1e-9 : asset.bytes || 0; // counted as deleted file
}

async function applyChunk(job, posts) {
  const out = { affected: 0, skipped: 0, mediaDeleted: 0, bytesFreed: 0, reasons: {} };
  const ids = posts.map((p) => p.id);

  if (job.action === 'ARCHIVE_POSTS') {
    const { count } = await prisma.scheduledPost.updateMany({
      where: { id: { in: ids }, status: { notIn: [...IN_FLIGHT, 'ARCHIVED'] } },
      data: { status: 'ARCHIVED' },
    });
    out.affected = count;
    out.skipped = ids.length - count;
    if (out.skipped) out.reasons['entraram em publicação'] = out.skipped;
    return out;
  }

  if (job.action === 'DELETE_POSTS') {
    const assetIds = new Set();
    for (const p of posts) {
      p.medias.forEach((m) => assetIds.add(m.mediaAssetId));
      if (p.coverMediaAssetId) assetIds.add(p.coverMediaAssetId);
    }
    const { count } = await prisma.scheduledPost.deleteMany({
      where: { id: { in: ids }, status: { notIn: IN_FLIGHT } },
    });
    out.affected = count;
    out.skipped = ids.length - count;
    if (out.skipped) out.reasons['entraram em publicação'] = out.skipped;
    for (const assetId of assetIds) {
      try {
        const bytes = await purgeOrphan(assetId);
        if (bytes > 0) {
          out.mediaDeleted += 1;
          out.bytesFreed += Math.round(bytes);
        }
      } catch (err) {
        addReason(out.reasons, 'arquivo não pôde ser apagado');
        logger.warn('Cleanup: file delete failed', { assetId, error: err.message });
      }
    }
    return out;
  }

  // FREE_STORAGE — published posts only (already guaranteed by the WHERE).
  for (const p of posts) {
    let freedHere = 0;
    const assets = [...p.medias.map((m) => m.mediaAsset), p.coverMediaAsset].filter(Boolean);
    for (const a of assets) {
      if (a.purgedAt) continue;
      if (a.inLibrary) {
        addReason(out.reasons, 'guardado na Biblioteca');
        continue;
      }
      // Never touch a file still needed by a post that hasn't been published.
      const pendingUse = await prisma.scheduledPost.count({
        where: {
          status: { notIn: ['PUBLISHED', 'ARCHIVED'] },
          OR: [{ medias: { some: { mediaAssetId: a.id } } }, { coverMediaAssetId: a.id }],
        },
      });
      if (pendingUse > 0) {
        addReason(out.reasons, 'usado em post ainda não publicado');
        continue;
      }
      try {
        await mediaService.deleteFromStorage(a);
        await prisma.mediaAsset.update({ where: { id: a.id }, data: { purgedAt: new Date() } });
        out.mediaDeleted += 1;
        out.bytesFreed += a.bytes || 0;
        freedHere += 1;
      } catch (err) {
        addReason(out.reasons, 'arquivo não pôde ser apagado');
        logger.warn('Cleanup: free storage failed', { assetId: a.id, error: err.message });
      }
    }
    if (freedHere > 0) out.affected += 1;
    else out.skipped += 1;
  }
  return out;
}

async function finish(jobId, status) {
  await prisma.cleanupJob.update({
    where: { id: jobId },
    data: { status, finishedAt: new Date(), cancelRequested: false },
  });
  logger.info('Cleanup job finished', { jobId, status });
  await notifyFinished(jobId);
}

const ACTION_DONE_TEXT = {
  DELETE_POSTS: 'excluído(s)',
  ARCHIVE_POSTS: 'arquivado(s)',
  FREE_STORAGE: 'com arquivos liberados',
};

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

async function notifyFinished(jobId) {
  try {
    const job = await prisma.cleanupJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    const label = job.kind === 'AUTO' ? 'Limpeza automática' : 'Limpeza';
    let title;
    let severity = 'success';
    if (job.status === 'DONE') title = `${label} concluída`;
    else if (job.status === 'CANCELED') {
      title = `${label} cancelada`;
      severity = 'info';
    } else {
      title = `${label} falhou`;
      severity = 'error';
    }
    const parts = [`${job.affected} post(s) ${ACTION_DONE_TEXT[job.action] || 'processados'}`];
    if (job.mediaDeleted) parts.push(`${job.mediaDeleted} arquivo(s) apagado(s), ${formatBytes(job.bytesFreed)} liberados`);
    if (job.skipped) parts.push(`${job.skipped} ignorado(s)`);
    await notificationService.notify({
      userId: job.userId,
      type: 'CLEANUP_FINISHED',
      severity,
      title,
      message: `${parts.join(' · ')}.${job.errorMessage ? ` Erro: ${job.errorMessage}` : ''} Veja em Limpeza › Relatórios.`,
      dedupeKey: `cleanup:${job.id}`,
      dedupeWindowMinutes: 7 * 24 * 60,
    });
  } catch (err) {
    logger.warn('Cleanup notify failed', { jobId, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// automatic rules (once a day per user)
// ---------------------------------------------------------------------------

async function autoTick() {
  try {
    const dueBefore = new Date(Date.now() - AUTO_EVERY_MS);
    const settings = await prisma.cleanupSetting.findMany({
      where: {
        OR: [{ freeStorageAfterDays: { not: null } }, { archiveFailedAfterDays: { not: null } }],
        AND: [{ OR: [{ lastAutoRunAt: null }, { lastAutoRunAt: { lt: dueBefore } }] }],
      },
      take: 50,
    });
    for (const s of settings) {
      const rules = [];
      if (s.freeStorageAfterDays) {
        rules.push({ action: 'FREE_STORAGE', filter: { olderThanDays: s.freeStorageAfterDays } });
      }
      if (s.archiveFailedAfterDays) {
        rules.push({ action: 'ARCHIVE_POSTS', filter: { status: 'FAILED', olderThanDays: s.archiveFailedAfterDays } });
      }
      for (const rule of rules) {
        try {
          const p = await preview(s.userId, rule);
          if (p.matched > 0) await createJob(s.userId, rule, 'AUTO');
        } catch (err) {
          logger.warn('Auto cleanup rule skipped', { userId: s.userId, action: rule.action, error: err.message });
        }
      }
      await prisma.cleanupSetting.update({ where: { userId: s.userId }, data: { lastAutoRunAt: new Date() } });
    }
  } catch (err) {
    logger.error('Auto cleanup tick failed', { error: err.message });
  }
}

function startRunner() {
  if (runnerTimer) return;
  runnerTimer = setInterval(runnerTick, RUNNER_TICK_MS);
  autoTimer = setInterval(autoTick, AUTO_CHECK_MS);
  setTimeout(autoTick, 2 * 60 * 1000).unref?.();
  logger.info('Cleanup runner started');
}

function stopRunner() {
  if (runnerTimer) clearInterval(runnerTimer);
  if (autoTimer) clearInterval(autoTimer);
  runnerTimer = null;
  autoTimer = null;
}

function toPublicShape(job) {
  return {
    id: job.id,
    kind: job.kind,
    action: job.action,
    status: job.status,
    filter: job.filter || {},
    matched: job.matched,
    processed: job.processed,
    affected: job.affected,
    skipped: job.skipped,
    mediaDeleted: job.mediaDeleted,
    bytesFreed: job.bytesFreed,
    skippedReasons: job.skippedReasons || {},
    cancelRequested: job.cancelRequested,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
  };
}

module.exports = {
  preview,
  createJob,
  listJobs,
  cancelJob,
  getSettings,
  saveSettings,
  startRunner,
  stopRunner,
  toPublicShape,
  // exported for tests / manual runs
  runnerTick,
  autoTick,
};
