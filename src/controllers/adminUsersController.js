// Rodada 21: /api/admin/users + /api/admin/settings (admin only).
// Users with their storage usage and quota, and the platform storage rules.
const storageService = require('../services/storage/storageService');
const { ok } = require('../utils/apiResponse');

// GET /api/admin/users -> { users, settings }
const listUsers = async (req, res) => {
  const result = await storageService.listUsersWithUsage();
  return ok(res, result);
};

// PATCH /api/admin/users/:id/quota  { quotaMb: null | -1 | number }
//   null = platform default, -1 = unlimited, number = quota in MB
const setQuota = async (req, res) => {
  const user = await storageService.setUserQuota(req.params.id, (req.body || {}).quotaMb);
  return ok(res, { user });
};

// GET /api/admin/settings -> { settings }
const getSettings = async (req, res) => {
  const settings = await storageService.getPlatformSettings({ fresh: true });
  return ok(res, { settings });
};

// PUT /api/admin/settings  { defaultQuotaMb, defaultFreeStorageDays, maxFreeStorageDays, orphanSweepHours, adminsUnlimited }
const saveSettings = async (req, res) => {
  const settings = await storageService.savePlatformSettings(req.body || {});
  return ok(res, { settings });
};

module.exports = { listUsers, setQuota, getSettings, saveSettings };