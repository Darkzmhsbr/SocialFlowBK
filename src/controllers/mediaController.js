const mediaService = require('../services/media/mediaService');
const { ok } = require('../utils/apiResponse');

// POST /api/media/upload      (multipart/form-data, field name: "file")
const uploadMedia = async (req, res) => {
  const asset = await mediaService.uploadFile({
    userId: req.userId,
    file: req.file,
  });
  // Rodada 7: multipart fields "library=1" (+ optional "folderId") keep the
  // upload in the library (Biblioteca page and cover picker).
  const keep = req.body?.library === '1' || req.body?.library === 'true';
  if (keep) {
    const folderId = req.body?.folderId ? String(req.body.folderId) : null;
    await mediaService.saveToLibrary([asset.id], req.userId, { folderId });
    Object.assign(asset, { inLibrary: true, folderId });
  }
  return ok(res, { media: mediaService.toPublicShape(asset) });
};

// GET /api/media
const listMedia = async (req, res) => {
  const take = Math.min(Number(req.query.take) || 50, 100);
  const skip = Number(req.query.skip) || 0;
  const assets = await mediaService.listByUser(req.userId, { take, skip });
  return ok(res, { media: assets.map(mediaService.toPublicShape) });
};

// GET /api/media/:id
const getMedia = async (req, res) => {
  const asset = await mediaService.getById(req.params.id, req.userId);
  return ok(res, { media: mediaService.toPublicShape(asset) });
};

// DELETE /api/media/:id
const deleteMedia = async (req, res) => {
  const result = await mediaService.deleteById(req.params.id, req.userId);
  return ok(res, { deleted: result });
};

module.exports = { uploadMedia, listMedia, getMedia, deleteMedia };

// --- Rodada 7: media library ------------------------------------------------

const { AppError, ErrorCodes } = require('../utils/errors');

// GET /api/media/folders -> { folders, counts: { all, root, unsaved } }
const listFolders = async (req, res) => {
  const result = await mediaService.listFolders(req.userId);
  return ok(res, result);
};

// POST /api/media/folders  { name }
const createFolder = async (req, res) => {
  const folder = await mediaService.createFolder(req.userId, req.body?.name);
  return ok(res, { folder: { id: folder.id, name: folder.name, count: 0, preview: null } });
};

// PATCH /api/media/folders/:id  { name }
const renameFolder = async (req, res) => {
  const folder = await mediaService.renameFolder(req.params.id, req.userId, req.body?.name);
  return ok(res, { folder: { id: folder.id, name: folder.name } });
};

// DELETE /api/media/folders/:id?mode=keep|delete
const deleteFolder = async (req, res) => {
  const mode = req.query.mode === 'delete' ? 'delete' : 'keep';
  const result = await mediaService.deleteFolder(req.params.id, req.userId, { mode });
  return ok(res, { deleted: result });
};

// GET /api/media/library?scope=all|root|unsaved|folder&folderId=&type=IMAGE|VIDEO&take=&skip=
// -> { media, total, take, skip }
const listLibrary = async (req, res) => {
  const take = Math.min(Number(req.query.take) || 60, 200);
  const skip = Number(req.query.skip) || 0;
  const scope = ['all', 'root', 'unsaved', 'folder'].includes(req.query.scope) ? req.query.scope : 'all';
  const { items, total } = await mediaService.listLibrary(req.userId, {
    scope,
    folderId: req.query.folderId || undefined,
    type: req.query.type || undefined,
    take,
    skip,
  });
  return ok(res, { media: items.map(mediaService.toPublicShape), total, take, skip });
};

// POST /api/media/library/bulk
// { action: 'save' | 'move' | 'remove', ids: string[], folderId?: string|null }
//   save   -> keep in library (folderId optional)
//   move   -> move to folderId (null = "Sem pasta"); also keeps in library
//   remove -> remove from library (deletes unused files)
const libraryBulk = async (req, res) => {
  const { action, ids, folderId } = req.body || {};
  let result;
  if (action === 'remove') result = await mediaService.removeFromLibrary(ids, req.userId);
  else if (action === 'move') result = await mediaService.saveToLibrary(ids, req.userId, { folderId: folderId || null });
  else if (action === 'save') result = await mediaService.saveToLibrary(ids, req.userId, { folderId });
  else {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Ação inválida: ${action}.`, 400);
  }
  return ok(res, { result });
};

module.exports.listFolders = listFolders;
module.exports.createFolder = createFolder;
module.exports.renameFolder = renameFolder;
module.exports.deleteFolder = deleteFolder;
module.exports.listLibrary = listLibrary;
module.exports.libraryBulk = libraryBulk;