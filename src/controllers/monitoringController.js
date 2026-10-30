// Rodada 17: /api/monitoring/* — "Monitoramento".
const monitoringService = require('../services/monitoring/monitoringService');
const { ok } = require('../utils/apiResponse');

// GET /api/monitoring/overview
const overview = async (req, res) => {
  const monitoring = await monitoringService.getOverview(req.userId);
  return ok(res, { monitoring });
};

module.exports = { overview };