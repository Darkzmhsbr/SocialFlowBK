// Rodada 13: /api/metrics/* — Dashboard metrics (Geral / pasta / perfil).
const metricsService = require('../services/metrics/metricsService');
const { ok } = require('../utils/apiResponse');

// GET /api/metrics/overview?scope=all|folder|account&id=...&days=7|30|90
const overview = async (req, res) => {
  const metrics = await metricsService.getOverview(req.userId, {
    scope: req.query.scope || 'all',
    id: req.query.id || null,
    days: req.query.days,
  });
  return ok(res, { metrics });
};

// POST /api/metrics/refresh -> collects the missing profiles now (background)
const refresh = async (req, res) => {
  const result = await metricsService.requestRefresh(req.userId);
  return ok(res, { refresh: result });
};

module.exports = { overview, refresh };
