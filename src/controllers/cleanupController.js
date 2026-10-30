// Rodada 12: /api/cleanup/* — background cleanup + reports + automatic rules.
const cleanupService = require('../services/cleanup/cleanupService');
const { ok } = require('../utils/apiResponse');

// POST /api/cleanup/preview  { action, filter } -> counts + estimated bytes
const preview = async (req, res) => {
  const result = await cleanupService.preview(req.userId, req.body || {});
  return ok(res, { preview: result });
};

// POST /api/cleanup/jobs  { action, filter } -> starts a background cleanup
const createJob = async (req, res) => {
  const job = await cleanupService.createJob(req.userId, req.body || {});
  return ok(res, { job: cleanupService.toPublicShape(job) });
};

// GET /api/cleanup/jobs?scope=active|done|all&take=50
const listJobs = async (req, res) => {
  const jobs = await cleanupService.listJobs(req.userId, { scope: req.query.scope, take: req.query.take });
  return ok(res, { jobs: jobs.map(cleanupService.toPublicShape) });
};

// POST /api/cleanup/jobs/:id/cancel
const cancelJob = async (req, res) => {
  const job = await cleanupService.cancelJob(req.params.id, req.userId);
  return ok(res, { job: cleanupService.toPublicShape(job) });
};

// GET /api/cleanup/settings
const getSettings = async (req, res) => {
  const settings = await cleanupService.getSettings(req.userId);
  return ok(res, { settings });
};

// PUT /api/cleanup/settings  { freeStorageAfterDays, archiveFailedAfterDays } (null = off)
const saveSettings = async (req, res) => {
  const settings = await cleanupService.saveSettings(req.userId, req.body || {});
  return ok(res, { settings });
};

module.exports = { preview, createJob, listJobs, cancelJob, getSettings, saveSettings };
