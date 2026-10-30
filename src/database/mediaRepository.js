// All Prisma queries for MediaAsset live here. Controllers and services
// never import @prisma/client directly - they call these functions.

const prisma = require('../config/database');

function create({
  userId,
  type,
  storageKey,
  storageProvider,
  url,
  format,
  bytes,
  width,
  height,
  durationSec,
  originalName = null, // Rodada 19B
}) {
  return prisma.mediaAsset.create({
    data: {
      userId,
      type,
      storageKey,
      // Rely on the schema default (BACKBLAZE) when the caller omits this,
      // so old code paths that haven't been updated still create BACKBLAZE
      // rows — Cloudinary is legacy at this point.
      ...(storageProvider ? { storageProvider } : {}),
      url,
      format,
      bytes,
      width,
      height,
      durationSec,
      ...(originalName ? { originalName } : {}), // Rodada 19B
    },
  });
}

function findById(id) {
  return prisma.mediaAsset.findUnique({ where: { id } });
}

function findManyByIds(ids) {
  return prisma.mediaAsset.findMany({ where: { id: { in: ids } } });
}

function findAllByUserId(userId, { take = 50, skip = 0 } = {}) {
  return prisma.mediaAsset.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });
}

function deleteById(id) {
  return prisma.mediaAsset.delete({ where: { id } });
}

// --- Rodada 7: media library ---------------------------------------------

/**
 * Library listing.
 *   scope: 'all'      -> every media kept in the library
 *          'root'     -> library media without folder ("Sem pasta")
 *          'unsaved'  -> uploads from the composer not kept in the library
 *          'folder'   -> one folder (folderId)
 */
function buildLibraryWhere(userId, { scope = 'all', folderId, type } = {}) {
  const where = { userId };
  if (scope === 'unsaved') where.inLibrary = false;
  else where.inLibrary = true;
  if (scope === 'root') where.folderId = null;
  if (scope === 'folder') where.folderId = folderId;
  if (type === 'IMAGE' || type === 'VIDEO') where.type = type;
  return where;
}

async function findLibraryPage(userId, filters = {}, { take = 60, skip = 0 } = {}) {
  const where = buildLibraryWhere(userId, filters);
  const [items, total] = await prisma.$transaction([
    prisma.mediaAsset.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take, skip }),
    prisma.mediaAsset.count({ where }),
  ]);
  return { items, total };
}

async function getLibraryCounts(userId) {
  const [all, root, unsaved, perFolder] = await prisma.$transaction([
    prisma.mediaAsset.count({ where: { userId, inLibrary: true } }),
    prisma.mediaAsset.count({ where: { userId, inLibrary: true, folderId: null } }),
    prisma.mediaAsset.count({ where: { userId, inLibrary: false } }),
    prisma.mediaAsset.groupBy({
      by: ['folderId'],
      where: { userId, inLibrary: true, folderId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  return {
    all,
    root,
    unsaved,
    perFolder: Object.fromEntries(perFolder.map((r) => [r.folderId, r._count._all])),
  };
}

function findFoldersByUser(userId) {
  return prisma.mediaFolder.findMany({ where: { userId }, orderBy: { name: 'asc' } });
}

function findFolderById(id) {
  return prisma.mediaFolder.findUnique({ where: { id } });
}

function createFolder(userId, name) {
  return prisma.mediaFolder.create({ data: { userId, name } });
}

function renameFolder(id, name) {
  return prisma.mediaFolder.update({ where: { id }, data: { name } });
}

function deleteFolder(id) {
  return prisma.mediaFolder.delete({ where: { id } });
}

/** One sample thumbnail per folder (latest image, else latest video). */
async function findFolderPreviews(userId, folderIds) {
  if (folderIds.length === 0) return {};
  const rows = await prisma.mediaAsset.findMany({
    where: { userId, inLibrary: true, folderId: { in: folderIds } },
    orderBy: { createdAt: 'desc' },
    select: { folderId: true, url: true, type: true },
    take: 500,
  });
  const out = {};
  for (const r of rows) {
    const cur = out[r.folderId];
    if (!cur || (cur.type !== 'IMAGE' && r.type === 'IMAGE')) out[r.folderId] = { url: r.url, type: r.type };
  }
  return out;
}

function updateLibraryFields(ids, userId, data) {
  return prisma.mediaAsset.updateMany({ where: { id: { in: ids }, userId }, data });
}

function findManyByIdsForUser(ids, userId) {
  return prisma.mediaAsset.findMany({ where: { id: { in: ids }, userId } });
}

module.exports = {
  create,
  findById,
  findManyByIds,
  findAllByUserId,
  deleteById,
  // Rodada 7
  findLibraryPage,
  getLibraryCounts,
  findFoldersByUser,
  findFolderById,
  createFolder,
  renameFolder,
  deleteFolder,
  findFolderPreviews,
  updateLibraryFields,
  findManyByIdsForUser,
};