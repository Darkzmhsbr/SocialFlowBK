// Business logic for media uploads. Sits between the controller (which
// only cares about HTTP) and the storage provider + Prisma. Every rule
// that decides "is this file allowed?" lives here.

const cloudinaryClient = require('../../integrations/cloudinary/cloudinaryClient');
const b2Client = require('../../integrations/backblaze/b2Client');
const mediaRepository = require('../../database/mediaRepository');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

// Direct Prisma access — used only by deleteIfOrphan to count references
// from PostMedia AND from ScheduledPost.coverMediaAssetId (Rodada 2b).
// Kept here rather than growing new repository methods just for these two
// counts. If more direct-count queries accumulate, promote to a repo helper.
// Note: config/database exports prisma DIRECTLY (module.exports = prisma),
// NOT as a named export — same pattern used by scheduledPostRepository.js.
const prisma = require('../../config/database');

const IMAGE_MIMES = new Set(env.uploads.allowedImageMimes);
const VIDEO_MIMES = new Set(env.uploads.allowedVideoMimes);

// Provider used for every NEW upload from this migration onward.
// Legacy rows keep their original provider on MediaAsset.storageProvider.
const DEFAULT_PROVIDER = 'BACKBLAZE';

/**
 * Handle a fresh upload: validate, push to storage, save the row.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {{ buffer: Buffer, mimetype: string, size: number, originalname: string }} args.file - req.file from multer
 * @returns {Promise<MediaAsset>}
 */
async function uploadFile({ userId, file }) {
  if (!file || !file.buffer) {
    throw new AppError(ErrorCodes.NO_FILE_UPLOADED, 'Nenhum arquivo enviado.', 400);
  }

  const { type, resourceType } = classifyMime(file.mimetype);
  enforceSizeLimit(type, file.size);

  logger.info('Media upload starting', {
    userId,
    filename: file.originalname,
    mimetype: file.mimetype,
    bytes: file.size,
    type,
    provider: DEFAULT_PROVIDER,
  });

  // New uploads always go to Backblaze. Cloudinary is kept only for
  // deleting legacy rows via deleteAsset below.
  const uploaded = await b2Client.uploadBuffer(file.buffer, {
    userId,
    resourceType,
    mimetype: file.mimetype,
    filename: file.originalname,
  });

  const asset = await mediaRepository.create({
    userId,
    type,
    storageKey: uploaded.storageKey,
    storageProvider: DEFAULT_PROVIDER,
    url: uploaded.url,
    format: uploaded.format,
    bytes: uploaded.bytes,
    width: uploaded.width || null,
    height: uploaded.height || null,
    durationSec: uploaded.durationSec || null,
  });

  logger.info('Media upload saved', {
    userId,
    mediaId: asset.id,
    storageKey: asset.storageKey,
    storageProvider: asset.storageProvider,
    type: asset.type,
  });

  return asset;
}

function classifyMime(mimetype) {
  if (IMAGE_MIMES.has(mimetype)) return { type: 'IMAGE', resourceType: 'image' };
  if (VIDEO_MIMES.has(mimetype)) return { type: 'VIDEO', resourceType: 'video' };
  throw new AppError(
    ErrorCodes.INVALID_MEDIA_TYPE,
    `Tipo de arquivo não suportado (${mimetype}).`,
    400
  );
}

function enforceSizeLimit(type, sizeBytes) {
  const limit = type === 'IMAGE' ? env.uploads.maxImageBytes : env.uploads.maxVideoBytes;
  if (sizeBytes > limit) {
    const limitMb = Math.floor(limit / (1024 * 1024));
    throw new AppError(
      ErrorCodes.MEDIA_TOO_LARGE,
      `Arquivo maior que o limite permitido (${limitMb} MB para ${type === 'IMAGE' ? 'imagens' : 'vídeos'}).`,
      413
    );
  }
}

function listByUser(userId, pagination) {
  return mediaRepository.findAllByUserId(userId, pagination);
}

async function getById(id, userId) {
  const asset = await mediaRepository.findById(id);
  if (!asset || asset.userId !== userId) {
    throw new AppError(ErrorCodes.MEDIA_NOT_FOUND, 'Mídia não encontrada.', 404);
  }
  return asset;
}

async function deleteById(id, userId) {
  const asset = await getById(id, userId);

  // Route to the correct storage client based on where the asset lives.
  // Legacy Cloudinary media stays reachable forever — we don't force a
  // migration; we just delete from the right place when the user removes it.
  await deleteFromStorage(asset);
  await mediaRepository.deleteById(id);
  return { id };
}

/**
 * Silent orphan cleanup: if this media is no longer referenced by any
 * ScheduledPost — neither via PostMedia nor as a coverMediaAssetId —
 * delete it from its storage provider and from the DB. Anything unexpected
 * is logged and swallowed — callers are typically running this
 * fire-and-forget after deletePost and must not have their HTTP
 * response gated on storage latency.
 *
 * Ownership is enforced: we won't touch another user's media, even if a
 * caller passes the wrong id (defense in depth).
 *
 * @param {string} mediaId
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function deleteIfOrphan(mediaId, userId) {
  try {
    const asset = await mediaRepository.findById(mediaId);
    if (!asset) return; // Already gone — nothing to do.
    if (asset.userId !== userId) {
      logger.warn('deleteIfOrphan skipped: ownership mismatch', {
        mediaId,
        requestedBy: userId,
      });
      return;
    }

    const [postMediaCount, coverCount] = await Promise.all([
      prisma.postMedia.count({ where: { mediaAssetId: mediaId } }),
      prisma.scheduledPost.count({ where: { coverMediaAssetId: mediaId } }),
    ]);
    const totalRefs = postMediaCount + coverCount;

    if (totalRefs > 0) {
      logger.info('deleteIfOrphan: media still referenced, keeping', {
        mediaId,
        postMediaCount,
        coverCount,
      });
      return;
    }

    await deleteFromStorage(asset);
    await mediaRepository.deleteById(mediaId);

    logger.info('Orphan media cleaned up', {
      mediaId,
      userId,
      storageKey: asset.storageKey,
      storageProvider: asset.storageProvider,
    });
  } catch (err) {
    // Silent by contract. Never bubbles up.
    logger.warn('deleteIfOrphan failed silently', {
      mediaId,
      userId,
      error: err.message,
    });
  }
}

/**
 * Dispatches to the right client based on where the asset is stored.
 * Never throws — both clients handle their own errors (log + return null).
 * Kept internal to this file so the switch lives in exactly one place.
 */
async function deleteFromStorage(asset) {
  const resourceType = asset.type === 'VIDEO' ? 'video' : 'image';
  if (asset.storageProvider === 'CLOUDINARY') {
    return cloudinaryClient.deleteAsset(asset.storageKey, resourceType);
  }
  // Default (and future) provider is BACKBLAZE. Guards against an unknown
  // enum value by logging rather than throwing — the DB delete continues
  // and the object becomes orphan storage (small cost, easy to audit later).
  if (asset.storageProvider !== 'BACKBLAZE') {
    logger.warn('deleteFromStorage: unknown storageProvider, skipping', {
      mediaId: asset.id,
      storageProvider: asset.storageProvider,
    });
    return null;
  }
  return b2Client.deleteAsset(asset.storageKey, resourceType);
}

// Strips storage-specific internals before returning to the frontend. The
// public shape is stable regardless of which provider hosts the file.
function toPublicShape(asset) {
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    format: asset.format,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    createdAt: asset.createdAt,
  };
}

module.exports = { uploadFile, listByUser, getById, deleteById, deleteIfOrphan, toPublicShape };