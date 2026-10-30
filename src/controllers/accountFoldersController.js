// Rodada 8: /api/instagram/folders/* — profile folders.
const folderService = require('../services/instagram/accountFolderService');
const { ok } = require('../utils/apiResponse');

// GET /api/instagram/folders -> { folders: [{ id, name, accountIds, count }] }
const listFolders = async (req, res) => {
  const folders = await folderService.listFolders(req.userId);
  return ok(res, { folders });
};

// POST /api/instagram/folders  { name, accountIds? }
const createFolder = async (req, res) => {
  const folder = await folderService.createFolder(req.userId, req.body || {});
  return ok(res, { folder });
};

// PATCH /api/instagram/folders/:id  { name }
const renameFolder = async (req, res) => {
  const folder = await folderService.renameFolder(req.params.id, req.userId, req.body?.name);
  return ok(res, { folder });
};

// DELETE /api/instagram/folders/:id
const deleteFolder = async (req, res) => {
  const result = await folderService.deleteFolder(req.params.id, req.userId);
  return ok(res, { deleted: result });
};

// PUT /api/instagram/folders/:id/members  { accountIds } — replaces the list
const setMembers = async (req, res) => {
  const folder = await folderService.setMembers(req.params.id, req.userId, req.body?.accountIds);
  return ok(res, { folder });
};

// POST /api/instagram/folders/:id/members  { accountIds } — adds
const addMembers = async (req, res) => {
  const result = await folderService.addMembers(req.params.id, req.userId, req.body?.accountIds);
  return ok(res, { result });
};

// DELETE /api/instagram/folders/:id/members  { accountIds } — removes
const removeMembers = async (req, res) => {
  const result = await folderService.removeMembers(req.params.id, req.userId, req.body?.accountIds);
  return ok(res, { result });
};

module.exports = { listFolders, createFolder, renameFolder, deleteFolder, setMembers, addMembers, removeMembers };