// Rodada 5: header notifications (bell).
const notificationService = require('../services/notifications/notificationService');
const { ok } = require('../utils/apiResponse');

// GET /api/notifications?unreadOnly=true&take=30&skip=0
// Returns { notifications, unreadCount }
const listNotifications = async (req, res) => {
  const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
  const result = await notificationService.list(req.userId, {
    unreadOnly,
    take: req.query.take,
    skip: req.query.skip,
  });
  return ok(res, result);
};

// GET /api/notifications/unread-count  -> { unreadCount }
const getUnreadCount = async (req, res) => {
  const unreadCount = await notificationService.unreadCount(req.userId);
  return ok(res, { unreadCount });
};

// POST /api/notifications/:id/read
const markRead = async (req, res) => {
  const result = await notificationService.markRead(req.params.id, req.userId);
  return ok(res, { read: result });
};

// POST /api/notifications/read-all
const markAllRead = async (req, res) => {
  const result = await notificationService.markAllRead(req.userId);
  return ok(res, { read: result });
};

module.exports = { listNotifications, getUnreadCount, markRead, markAllRead };