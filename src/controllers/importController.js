// Rodada 19B: /api/imports/* — spreadsheet import.
const importService = require('../services/imports/importService');
const { ok } = require('../utils/apiResponse');

// POST /api/imports/preview  { rows: [{ line, profile, files, caption, date, time, type, cover }] }
const preview = async (req, res) => {
  const result = await importService.preview(req.userId, (req.body || {}).rows);
  return ok(res, { preview: result });
};

// POST /api/imports/commit  { rows, batchId? } -> creates the posts of the valid rows
const commit = async (req, res) => {
  const body = req.body || {};
  const result = await importService.commit(req.userId, body.rows, { batchId: body.batchId || null });
  return ok(res, { import: result });
};

// GET /api/imports/media -> names usable in the "arquivo" column
const media = async (req, res) => {
  const items = await importService.listMediaNames(req.userId);
  return ok(res, { media: items });
};

module.exports = { preview, commit, media };