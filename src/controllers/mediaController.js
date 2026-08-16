const mediaService = require('../services/media/mediaService');
const { ok } = require('../utils/apiResponse');

// POST /api/media/upload      (multipart/form-data, field name: "file")
const uploadMedia = async (req, res) => {
  const asset = await mediaService.uploadFile({
    userId: req.userId,
    file: req.file,
  });
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