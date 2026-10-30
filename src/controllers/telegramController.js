// Rodada 17: /api/telegram/* — official alerts bot.
const telegramService = require('../services/telegram/telegramService');
const { ok } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// POST /api/telegram/webhook  (called by Telegram, NOT by the frontend)
// Checked with the X-Telegram-Bot-Api-Secret-Token header set by setWebhook.
// Always answers 200 fast; the update is processed right after.
const webhook = async (req, res) => {
  if (!telegramService.isValidWebhookSecret(req.get('X-Telegram-Bot-Api-Secret-Token'))) {
    logger.warn('Telegram webhook with invalid secret ignored');
    return res.status(401).json({ success: false });
  }
  res.status(200).json({ success: true });
  telegramService.handleUpdate(req.body).catch(() => {});
  return undefined;
};

// GET /api/telegram/status
const status = async (req, res) => {
  const telegram = await telegramService.getStatus(req.userId);
  return ok(res, { telegram });
};

// POST /api/telegram/link-code  -> "SF-XXXXXX" (private chat, group or channel post)
const linkCode = async (req, res) => {
  const telegram = await telegramService.createLinkCode(req.userId);
  return ok(res, { telegram });
};

// POST /api/telegram/connect  { chatId }  -> bot posts a 6-digit code there
const connect = async (req, res) => {
  const telegram = await telegramService.connectById(req.userId, (req.body || {}).chatId);
  return ok(res, { telegram });
};

// POST /api/telegram/confirm  { code }
const confirm = async (req, res) => {
  const telegram = await telegramService.confirmById(req.userId, (req.body || {}).code);
  return ok(res, { telegram });
};

// PUT /api/telegram/alerts  { alertTypes: [...] }
const setAlerts = async (req, res) => {
  const telegram = await telegramService.setAlertTypes(req.userId, (req.body || {}).alertTypes);
  return ok(res, { telegram });
};

// POST /api/telegram/test
const test = async (req, res) => {
  const telegram = await telegramService.sendTest(req.userId);
  return ok(res, { telegram });
};

// DELETE /api/telegram/link
const disconnect = async (req, res) => {
  const result = await telegramService.disconnect(req.userId);
  return ok(res, result);
};

module.exports = { webhook, status, linkCode, connect, confirm, setAlerts, test, disconnect };