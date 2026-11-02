// Rodada 21: /api/storage — the user's own storage usage.
const storageService = require('../services/storage/storageService');
const { ok } = require('../utils/apiResponse');

// GET /api/storage -> { storage: { usedBytes, quotaBytes, unlimited, percent, quotaSource, breakdown, orphanSweepHours } }
const getUsage = async (req, res) => {
  const storage = await storageService.getUsage(req.userId);
  return ok(res, { storage });
};

module.exports = { getUsage };