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

  // Rodada 19B: keep the file's own name (unique per user) for the import.
  const originalName = await uniqueMediaName(userId, file.originalname, uploaded.format).catch(() => null);

  const asset = await mediaRepository.create({
    originalName, // Rodada 19B
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

// --- Rodada 19B: original file names -------------------------------------

/** "Meu Vídeo.MP4" stays "Meu Vídeo.MP4"; a repeated name becomes "Meu Vídeo (2).MP4". */
async function uniqueMediaName(userId, rawName, format) {
  // multer reads the file name as latin1: "vídeo.mp4" arrives as "vÃ­deo.mp4".
  let fixedName = String(rawName || '');
  try {
    const utf8 = Buffer.from(fixedName, 'latin1').toString('utf8');
    if (utf8 !== fixedName && !utf8.includes('\uFFFD')) fixedName = utf8;
  } catch {
    // keep as received
  }
  let name = fixedName
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-120);
  if (!name) name = `midia.${format || 'bin'}`;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const taken = await prisma.mediaAsset.findMany({
    where: { userId, originalName: { startsWith: stem, mode: 'insensitive' } },
    select: { originalName: true },
  });
  const used = new Set(taken.map((t) => String(t.originalName).toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
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
    // Rodada 7: media kept in the library is never auto-deleted — the user
    // removes it explicitly in the Biblioteca page.
    if (asset.inLibrary) {
      logger.info('deleteIfOrphan: media kept in library, skipping', { mediaId });
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
    // Rodada 7: library info
    inLibrary: Boolean(asset.inLibrary),
    folderId: asset.folderId ?? null,
    // Rodada 12: file freed by a cleanup
    purged: Boolean(asset.purgedAt),
    // Rodada 19B: name used by the spreadsheet import
    originalName: asset.originalName ?? null,
  };
}

// --- Rodada 7: media library ---------------------------------------------

const FOLDER_NAME_MAX = 60;
const LIBRARY_BULK_MAX = 500;

function normalizeFolderName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Dê um nome para a pasta.', 400);
  }
  if (clean.length > FOLDER_NAME_MAX) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Nome da pasta: no máximo ${FOLDER_NAME_MAX} caracteres.`, 400);
  }
  return clean;
}

async function getOwnedFolder(folderId, userId) {
  const folder = await mediaRepository.findFolderById(folderId);
  if (!folder || folder.userId !== userId) {
    throw new AppError(ErrorCodes.FOLDER_NOT_FOUND, 'Pasta não encontrada.', 404);
  }
  return folder;
}

function isUniqueViolation(err) {
  return err && err.code === 'P2002';
}

async function listFolders(userId) {
  const [folders, counts] = await Promise.all([
    mediaRepository.findFoldersByUser(userId),
    mediaRepository.getLibraryCounts(userId),
  ]);
  const previews = await mediaRepository.findFolderPreviews(
    userId,
    folders.map((f) => f.id)
  );
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      count: counts.perFolder[f.id] || 0,
      preview: previews[f.id] || null,
      createdAt: f.createdAt,
    })),
    counts: { all: counts.all, root: counts.root, unsaved: counts.unsaved },
  };
}

async function createFolder(userId, name) {
  const clean = normalizeFolderName(name);
  try {
    return await mediaRepository.createFolder(userId, clean);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(ErrorCodes.FOLDER_NAME_TAKEN, `Você já tem uma pasta chamada "${clean}".`, 409);
    }
    throw err;
  }
}

async function renameFolder(folderId, userId, name) {
  await getOwnedFolder(folderId, userId);
  const clean = normalizeFolderName(name);
  try {
    return await mediaRepository.renameFolder(folderId, clean);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(ErrorCodes.FOLDER_NAME_TAKEN, `Você já tem uma pasta chamada "${clean}".`, 409);
    }
    throw err;
  }
}

/**
 * Delete a folder.
 *   mode 'keep'   (default): its media stay in the library, "Sem pasta"
 *   mode 'delete': its media are removed too (same rules as removeFromLibrary)
 */
async function deleteFolder(folderId, userId, { mode = 'keep' } = {}) {
  await getOwnedFolder(folderId, userId);
  let mediaResult = null;
  if (mode === 'delete') {
    const { items } = await mediaRepository.findLibraryPage(
      userId,
      { scope: 'folder', folderId },
      { take: 5000, skip: 0 }
    );
    mediaResult = await removeFromLibrary(items.map((m) => m.id), userId);
  }
  await mediaRepository.deleteFolder(folderId);
  logger.info('Media folder deleted', { userId, folderId, mode });
  return { id: folderId, mode, media: mediaResult };
}

async function listLibrary(userId, { scope = 'all', folderId, type, take = 60, skip = 0 } = {}) {
  if (scope === 'folder') await getOwnedFolder(folderId, userId);
  const { items, total } = await mediaRepository.findLibraryPage(
    userId,
    { scope, folderId, type },
    { take, skip }
  );
  return { items, total };
}

/**
 * Keep media in the library (optionally inside a folder). Used by the
 * Biblioteca upload, by "Guardar na biblioteca" and by the cover picker.
 * folderId: undefined = don't touch, null = "Sem pasta", string = that folder.
 */
async function saveToLibrary(ids, userId, { folderId } = {}) {
  const list = [...new Set((ids || []).map(String))].slice(0, LIBRARY_BULK_MAX);
  if (list.length === 0) return { updated: 0 };
  if (folderId) await getOwnedFolder(folderId, userId);
  const data = { inLibrary: true };
  if (folderId !== undefined) data.folderId = folderId || null;
  const { count } = await mediaRepository.updateLibraryFields(list, userId, data);
  return { updated: count };
}

/**
 * Remove media from the library. A file still used by any post (any
 * status) is NOT deleted — it just leaves the library, and the normal
 * orphan cleanup deletes it once those posts are gone. Unused files are
 * deleted from storage and from the DB right away.
 */
async function removeFromLibrary(ids, userId) {
  const list = [...new Set((ids || []).map(String))].slice(0, LIBRARY_BULK_MAX);
  const assets = await mediaRepository.findManyByIdsForUser(list, userId);
  let deleted = 0;
  let keptInUse = 0;

  for (const asset of assets) {
    const [postMediaCount, coverCount] = await Promise.all([
      prisma.postMedia.count({ where: { mediaAssetId: asset.id } }),
      prisma.scheduledPost.count({ where: { coverMediaAssetId: asset.id } }),
    ]);
    if (postMediaCount + coverCount > 0) {
      await mediaRepository.updateLibraryFields([asset.id], userId, { inLibrary: false, folderId: null });
      keptInUse += 1;
      continue;
    }
    await deleteFromStorage(asset);
    await mediaRepository.deleteById(asset.id);
    deleted += 1;
  }

  logger.info('Library media removed', { userId, requested: list.length, deleted, keptInUse });
  return { deleted, keptInUse };
}

module.exports = { uploadFile, listByUser, getById, deleteById, deleteIfOrphan, toPublicShape };

// Rodada 7: appended so the original export line stays untouched.
Object.assign(module.exports, {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  listLibrary,
  saveToLibrary,
  removeFromLibrary,
  // Rodada 12: used by the cleanup service
  deleteFromStorage,
});