// Rodada 16: /api/templates/* — "Modelos".
const templateService = require('../services/templates/templateService');
const { ok } = require('../utils/apiResponse');

// GET /api/templates
const listTemplates = async (req, res) => {
  const templates = await templateService.listTemplates(req.userId);
  return ok(res, { templates });
};

// POST /api/templates  { name, type?, caption?, hashtags?, accountFolderId? }
const createTemplate = async (req, res) => {
  const template = await templateService.createTemplate(req.userId, req.body || {});
  return ok(res, { template });
};

// PATCH /api/templates/:id  (any subset of the fields above)
const updateTemplate = async (req, res) => {
  const template = await templateService.updateTemplate(req.params.id, req.userId, req.body || {});
  return ok(res, { template });
};

// DELETE /api/templates/:id
const deleteTemplate = async (req, res) => {
  const deleted = await templateService.deleteTemplate(req.params.id, req.userId);
  return ok(res, { deleted });
};

// POST /api/templates/:id/use  -> usage counter (most used / recent first)
const useTemplate = async (req, res) => {
  const template = await templateService.markUsed(req.params.id, req.userId);
  return ok(res, { template });
};

module.exports = { listTemplates, createTemplate, updateTemplate, deleteTemplate, useTemplate };