const env = require('../config/env');
const dashboardService = require('../services/dashboard/dashboardService');
const { ok } = require('../utils/apiResponse');

// GET /api/dashboard/stats
const getStats = async (req, res) => {
  const stats = await dashboardService.getStats(env.defaultUserId);
  return ok(res, stats);
};

module.exports = { getStats };