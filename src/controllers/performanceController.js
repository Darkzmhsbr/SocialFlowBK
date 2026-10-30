// Rodada 18: /api/performance/* — "Desempenho".
const performanceService = require('../services/performance/performanceService');
const { ok } = require('../utils/apiResponse');

// GET /api/performance/posts?scope=all|folder|account|accounts&id=&ids=&days=7|30|90&type=&checkpoint=24h|3d|7d|30d|latest&sort=&take=&skip=
const posts = async (req, res) => {
  const performance = await performanceService.getPosts(req.userId, req.query);
  return ok(res, { performance });
};

// GET /api/performance/best-times?scope=...&id=&ids=&days=30|60|90|180&type=
const bestTimes = async (req, res) => {
  const bestTimes = await performanceService.getBestTimes(req.userId, req.query);
  return ok(res, { bestTimes });
};

module.exports = { posts, bestTimes };