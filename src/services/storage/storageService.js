// Rodada 21: storage limits ("Armazenamento").
//
//   Usage      : every file still stored (Backblaze/Cloudinary) = media rows
//                with purgedAt = null. Split in 4 groups:
//                  library   - kept in the Biblioteca (never auto-deleted)
//                  pending   - used by a post not published yet
//                  published - only used by published/archived posts
//                              (what "Liberar armazenamento" can delete)
//                  orphan    - not used by any post and not in the Biblioteca
//                              (deleted by the sweep after N hours)
//   Quota      : User.storageQuotaMb (null = platform default, -1 = unlimited).
//                Admins (ADMIN_EMAILS) are unlimited when the platform says
//                so and no individual quota was set.
//   Upload     : assertCanUpload() runs BEFORE sending to storage, so a
//                refused upload costs nothing.
//   Sweep      : sweepOrphans() runs every hour (cleanup runner).
//   Settings   : one row in platform_settings (id "default"), edited by the
//                admin on the "Usuários" page. Cached for 30 s.

const prisma = require('../../config/database');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { isAdminEmail } = require('../../middleware/requireAdmin');

const MB = 1024 * 1024;
const SETTINGS_ID = 'default';
const SETTINGS_TTL_MS = 30 * 1000;
const SWEEP_BATCH = 200;
const UNLIMITED = -1;

const DEFAULTS = {
  defaultQuotaMb: 5120,
  defaultFreeStorageDays: 7,
  maxFreeStorageDays: null,
  orphanSweepHours: 24,
  adminsUnlimited: true,
};

let settingsCache = { value: null, at: 0 };

// ---------------------------------------------------------------------------
// platform settings
// ---------------------------------------------------------------------------

function pickSettings(row) {
  const s = { ...DEFAULTS };
  if (row) {
    for (const key of Object.keys(DEFAULTS)) if (row[key] !== undefined) s[key] = row[key];
  }
  return s;
}

async function getPlatformSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache.value && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  let row = null;
  try {
    row = await prisma.platformSetting.findUnique({ where: { id: SETTINGS_ID } });
  } catch (err) {
    // Table missing (migration not run yet): work with the defaults.
    logger.warn('Platform settings unavailable, using defaults', { error: err.message });
  }
  const value = pickSettings(row);
  settingsCache = { value, at: Date.now() };
  return value;
}

function intOrNull(value, { min, max, label }) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `${label}: use um número de ${min} a ${max}.`, 400);
  }
  return Math.floor(n);
}

async function savePlatformSettings(body = {}) {
  const current = await getPlatformSettings({ fresh: true });
  const data = { ...current };
  if (body.defaultQuotaMb !== undefined) {
    data.defaultQuotaMb = intOrNull(body.defaultQuotaMb, { min: 1, max: 10 * 1024 * 1024, label: 'Cota padrão (MB)' });
    if (data.defaultQuotaMb === null) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Informe a cota padrão.', 400);
    }
  }
  if (body.defaultFreeStorageDays !== undefined) {
    data.defaultFreeStorageDays = intOrNull(body.defaultFreeStorageDays, { min: 1, max: 3650, label: 'Limpeza padrão (dias)' });
  }
  if (body.maxFreeStorageDays !== undefined) {
    data.maxFreeStorageDays = intOrNull(body.maxFreeStorageDays, { min: 1, max: 3650, label: 'Limpeza obrigatória (dias)' });
  }
  if (body.orphanSweepHours !== undefined) {
    data.orphanSweepHours = intOrNull(body.orphanSweepHours, { min: 1, max: 24 * 90, label: 'Faxina (horas)' });
    if (data.orphanSweepHours === null) data.orphanSweepHours = DEFAULTS.orphanSweepHours;
  }
  if (body.adminsUnlimited !== undefined) data.adminsUnlimited = Boolean(body.adminsUnlimited);
  if (data.maxFreeStorageDays && data.defaultFreeStorageDays && data.defaultFreeStorageDays > data.maxFreeStorageDays) {
    data.defaultFreeStorageDays = data.maxFreeStorageDays;
  }

  const row = await prisma.platformSetting.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
  settingsCache = { value: pickSettings(row), at: Date.now() };
  logger.info('Platform storage settings saved', settingsCache.value);
  return settingsCache.value;
}

// ---------------------------------------------------------------------------
// quota + usage
// ---------------------------------------------------------------------------

/** Effective quota of a user in bytes (null = unlimited). */
function resolveQuotaBytes(user, settings) {
  const own = user?.storageQuotaMb;
  if (own === UNLIMITED) return null;
  if (own !== null && own !== undefined) return own * MB;
  if (settings.adminsUnlimited && isAdminEmail(user?.email)) return null;
  return settings.defaultQuotaMb * MB;
}

function quotaSource(user, settings) {
  const own = user?.storageQuotaMb;
  if (own === UNLIMITED) return 'unlimited';
  if (own !== null && own !== undefined) return 'custom';
  if (settings.adminsUnlimited && isAdminEmail(user?.email)) return 'admin';
  return 'default';
}

async function getUsedBytes(userId) {
  const agg = await prisma.mediaAsset.aggregate({
    where: { userId, purgedAt: null },
    _sum: { bytes: true },
  });
  return Number(agg._sum.bytes) || 0;
}

/** Usage per group: library | pending | published | orphan. */
async function getBreakdown(userId) {
  const rows = await prisma.$queryRaw`
    SELECT
      CASE
        WHEN m."inLibrary" THEN 'library'
        WHEN EXISTS (
          SELECT 1 FROM "post_media" pm JOIN "scheduled_posts" p ON p."id" = pm."postId"
          WHERE pm."mediaAssetId" = m."id" AND p."status"::text NOT IN ('PUBLISHED', 'ARCHIVED')
        ) OR EXISTS (
          SELECT 1 FROM "scheduled_posts" p
          WHERE p."coverMediaAssetId" = m."id" AND p."status"::text NOT IN ('PUBLISHED', 'ARCHIVED')
        ) THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM "post_media" pm WHERE pm."mediaAssetId" = m."id")
          OR EXISTS (SELECT 1 FROM "scheduled_posts" p WHERE p."coverMediaAssetId" = m."id") THEN 'published'
        ELSE 'orphan'
      END AS "bucket",
      COUNT(*)::int AS "count",
      COALESCE(SUM(m."bytes"), 0)::float8 AS "bytes"
    FROM "media_assets" m
    WHERE m."userId" = ${userId} AND m."purgedAt" IS NULL
    GROUP BY 1
  `;
  const out = {
    library: { count: 0, bytes: 0 },
    pending: { count: 0, bytes: 0 },
    published: { count: 0, bytes: 0 },
    orphan: { count: 0, bytes: 0 },
  };
  for (const r of rows) {
    if (out[r.bucket]) out[r.bucket] = { count: Number(r.count) || 0, bytes: Number(r.bytes) || 0 };
  }
  return out;
}

/** GET /api/storage — what the "Armazenamento" page and the Biblioteca bar show. */
async function getUsage(userId) {
  const [user, settings, breakdown] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, storageQuotaMb: true } }),
    getPlatformSettings(),
    getBreakdown(userId),
  ]);
  const usedBytes = Object.values(breakdown).reduce((s, b) => s + b.bytes, 0);
  const quotaBytes = resolveQuotaBytes(user, settings);
  return {
    usedBytes,
    quotaBytes,
    unlimited: quotaBytes === null,
    percent: quotaBytes ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : null,
    quotaSource: quotaSource(user, settings),
    breakdown,
    orphanSweepHours: settings.orphanSweepHours,
  };
}

function formatSize(bytes) {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1).replace('.', ',')} GB`;
  return `${Math.max(0, Math.round(bytes / MB))} MB`;
}

/**
 * Called by mediaService.uploadFile BEFORE the file goes to storage.
 * Throws STORAGE_QUOTA_EXCEEDED when used + size > quota.
 */
async function assertCanUpload(userId, sizeBytes) {
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, storageQuotaMb: true } }),
    getPlatformSettings(),
  ]);
  const quotaBytes = resolveQuotaBytes(user, settings);
  if (quotaBytes === null) return;
  const used = await getUsedBytes(userId);
  if (used + (Number(sizeBytes) || 0) <= quotaBytes) return;
  const free = Math.max(0, quotaBytes - used);
  throw new AppError(
    ErrorCodes.STORAGE_QUOTA_EXCEEDED,
    `Seu espaço acabou (${formatSize(used)} de ${formatSize(quotaBytes)}; livre: ${formatSize(free)}). ` +
      'Libere espaço na página Armazenamento ou na Limpeza.',
    413
  );
}

// ---------------------------------------------------------------------------
// abandoned uploads
// ---------------------------------------------------------------------------

let sweeping = false;

/**
 * Deletes files that no post uses, that are not in the Biblioteca and that
 * were uploaded more than N hours ago (N = orphanSweepHours). Safe: posts
 * (any status) and the Biblioteca are never touched.
 */
async function sweepOrphans(now = Date.now()) {
  if (sweeping) return { deleted: 0, bytes: 0 };
  sweeping = true;
  // Lazy require: mediaService also requires this file.
  // eslint-disable-next-line global-require
  const mediaService = require('../media/mediaService');
  let deleted = 0;
  let bytes = 0;
  try {
    const settings = await getPlatformSettings();
    const cutoff = new Date(now - settings.orphanSweepHours * 60 * 60 * 1000);
    const candidates = await prisma.mediaAsset.findMany({
      where: {
        inLibrary: false,
        purgedAt: null,
        createdAt: { lt: cutoff },
        postMedias: { none: {} },
        postCovers: { none: {} },
      },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
    });
    for (const asset of candidates) {
      try {
        // Re-check right before deleting (a post may have just used it).
        const [pm, cover, fresh] = await Promise.all([
          prisma.postMedia.count({ where: { mediaAssetId: asset.id } }),
          prisma.scheduledPost.count({ where: { coverMediaAssetId: asset.id } }),
          prisma.mediaAsset.findUnique({ where: { id: asset.id }, select: { inLibrary: true } }),
        ]);
        if (pm + cover > 0 || !fresh || fresh.inLibrary) continue;
        await mediaService.deleteFromStorage(asset);
        await prisma.mediaAsset.delete({ where: { id: asset.id } });
        deleted += 1;
        bytes += asset.bytes || 0;
      } catch (err) {
        logger.warn('Orphan sweep: file not deleted', { mediaId: asset.id, error: err.message });
      }
    }
    if (deleted) logger.info('Abandoned uploads deleted', { deleted, bytes, olderThanHours: settings.orphanSweepHours });
  } catch (err) {
    logger.error('Orphan sweep failed', { error: err.message });
  } finally {
    sweeping = false;
  }
  return { deleted, bytes };
}

// ---------------------------------------------------------------------------
// admin: users
// ---------------------------------------------------------------------------

async function listUsersWithUsage() {
  const [users, usage, accounts, settings] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, name: true, createdAt: true, storageQuotaMb: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.mediaAsset.groupBy({ by: ['userId'], where: { purgedAt: null }, _sum: { bytes: true }, _count: { _all: true } }),
    prisma.instagramAccount.groupBy({ by: ['userId'], _count: { _all: true } }),
    getPlatformSettings(),
  ]);
  const usageBy = new Map(usage.map((u) => [u.userId, { bytes: Number(u._sum.bytes) || 0, files: u._count._all }]));
  const accountsBy = new Map(accounts.map((a) => [a.userId, a._count._all]));
  return {
    settings,
    users: users.map((u) => {
      const used = usageBy.get(u.id) || { bytes: 0, files: 0 };
      const quotaBytes = resolveQuotaBytes(u, settings);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        isAdmin: isAdminEmail(u.email),
        accounts: accountsBy.get(u.id) || 0,
        usedBytes: used.bytes,
        files: used.files,
        storageQuotaMb: u.storageQuotaMb,
        quotaBytes,
        quotaSource: quotaSource(u, settings),
        percent: quotaBytes ? Math.min(100, Math.round((used.bytes / quotaBytes) * 1000) / 10) : null,
      };
    }),
  };
}

/** quotaMb: null = platform default, -1 = unlimited, number = MB. */
async function setUserQuota(userId, quotaMb) {
  let value = null;
  if (quotaMb !== null && quotaMb !== undefined && quotaMb !== '') {
    const n = Number(quotaMb);
    if (n === UNLIMITED) value = UNLIMITED;
    else {
      value = intOrNull(n, { min: 1, max: 10 * 1024 * 1024, label: 'Cota (MB)' });
    }
  }
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) throw new AppError(ErrorCodes.NOT_FOUND, 'Usuário não encontrado.', 404);
  await prisma.user.update({ where: { id: userId }, data: { storageQuotaMb: value } });
  logger.info('User storage quota changed', { userId, storageQuotaMb: value });
  const { users } = await listUsersWithUsage();
  return users.find((u) => u.id === userId);
}

module.exports = {
  getPlatformSettings,
  savePlatformSettings,
  getUsage,
  getUsedBytes,
  assertCanUpload,
  sweepOrphans,
  listUsersWithUsage,
  setUserQuota,
  resolveQuotaBytes,
  UNLIMITED,
};