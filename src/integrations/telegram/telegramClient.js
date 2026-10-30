// Rodada 17: the ONLY file that talks to the Telegram Bot API.
// The token comes from TELEGRAM_BOT_TOKEN (Railway) and never leaves the
// server. Every call returns Telegram's `result` or throws a TelegramError
// with Telegram's error_code / description.

const axios = require('axios');
const env = require('../../config/env');

class TelegramError extends Error {
  constructor(message, { code = null, description = '', retryAfter = null } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.code = code; // HTTP-like error_code from Telegram (400, 403, 429...)
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

function isConfigured() {
  return Boolean(env.telegram.botToken);
}

async function call(method, params = {}) {
  if (!isConfigured()) throw new TelegramError('Bot do Telegram não configurado.', { code: 0 });
  try {
    const { data } = await axios.post(`${env.telegram.apiBaseUrl}/bot${env.telegram.botToken}/${method}`, params, {
      timeout: 15000,
    });
    if (!data?.ok) {
      throw new TelegramError(data?.description || 'Telegram recusou a chamada.', {
        code: data?.error_code ?? null,
        description: data?.description || '',
      });
    }
    return data.result;
  } catch (err) {
    if (err instanceof TelegramError) throw err;
    const body = err.response?.data;
    throw new TelegramError(body?.description || 'Não foi possível falar com o Telegram.', {
      code: body?.error_code ?? err.response?.status ?? null,
      description: body?.description || err.message,
      retryAfter: body?.parameters?.retry_after ?? null,
    });
  }
}

let meCache = null;
/** Bot identity ({ id, username, first_name }), cached after the first call. */
async function getMe() {
  if (!meCache) meCache = await call('getMe');
  return meCache;
}

function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

function deleteMessage(chatId, messageId) {
  return call('deleteMessage', { chat_id: chatId, message_id: messageId });
}

function getChat(chatId) {
  return call('getChat', { chat_id: chatId });
}

function getChatMember(chatId, userId) {
  return call('getChatMember', { chat_id: chatId, user_id: userId });
}

function setWebhook(url, secretToken) {
  return call('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'channel_post', 'my_chat_member'],
    drop_pending_updates: false,
  });
}

/**
 * The chat is gone for good for this bot (kicked, chat deleted, no rights).
 * 429/5xx/network errors are temporary and must not break the link.
 */
function isPermanentChatError(err) {
  if (!(err instanceof TelegramError)) return false;
  if (err.code === 403) return true;
  const d = String(err.description || '').toLowerCase();
  return (
    err.code === 400 &&
    (d.includes('chat not found') ||
      d.includes('not enough rights') ||
      d.includes('need administrator rights') ||
      d.includes('have no rights') ||
      d.includes('chat_write_forbidden') ||
      d.includes('bot was kicked') ||
      d.includes('group chat was upgraded'))
  );
}

module.exports = {
  TelegramError,
  isConfigured,
  call,
  getMe,
  sendMessage,
  deleteMessage,
  getChat,
  getChatMember,
  setWebhook,
  isPermanentChatError,
  _resetCache() {
    meCache = null;
  },
};