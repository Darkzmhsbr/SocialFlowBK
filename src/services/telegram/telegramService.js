// Rodada 17: alerts on Telegram through ONE official bot.
//
// Each user links their own destination (private chat, group or channel):
//   - Código : "SF-XXXXXX" (15 min, single use) sent as /start in the
//              private chat / group, or published in the channel.
//   - ID     : the user types the channel/group id (or @username); the bot
//              posts a 6-digit code INSIDE that chat and the user types it in
//              the panel. Proves the user really controls that chat — nobody
//              can point their alerts at someone else's channel.
//
// Alerts come from the same notifications as the header bell
// (notificationService.notify -> enqueue). They are buffered for a few
// seconds per user, so 30 profiles falling together = 1 message.
// A failure here never breaks the flow that created the notification.

const crypto = require('crypto');
const prisma = require('../../config/database');
const env = require('../../config/env');
const telegram = require('../../integrations/telegram/telegramClient');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const ALERT_TYPES = [
  { key: 'ACCOUNT_DOWN', label: 'Perfil caiu / precisa reconectar', default: true },
  { key: 'ACCOUNT_PAUSED', label: 'Perfil pausado por limite da Meta', default: true },
  // Rodada 19A
  { key: 'ACCOUNT_RECOVERED', label: 'Perfil voltou / reconectado', default: true },
  { key: 'POSTS_FAILED', label: 'Falha ao publicar', default: true },
  { key: 'TOKEN_EXPIRING', label: 'Autorização de perfil perto de vencer', default: true },
  { key: 'QUEUE_EMPTY', label: 'Perfis ativos sem posts agendados (fim da tarde)', default: true },
  { key: 'BATCH_COMPLETED', label: 'Lote concluído', default: true },
  // Rodada 18
  { key: 'POST_VIRAL', label: 'Post viral (muito acima da média do perfil em 24h)', default: true },
  { key: 'CLEANUP_FINISHED', label: 'Limpeza concluída', default: false },
  { key: 'DAILY_SUMMARY', label: 'Resumo do dia (21h)', default: false },
];
const ALERT_KEYS = new Set(ALERT_TYPES.map((a) => a.key));
const DEFAULT_ALERTS = ALERT_TYPES.filter((a) => a.default).map((a) => a.key);

const LINK_CODE_MINUTES = 15;
const VERIFY_MINUTES = 10;
const VERIFY_MAX_ATTEMPTS = 5;
const FLUSH_MS = 15 * 1000;
const MAX_ITEM_AGE_MS = 30 * 60 * 1000;
const GROUP_LIST_MAX = 15;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_CODE_RE = /\b(SF-[A-Z0-9]{6})\b/i;
const START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?/i;

function notConfigured() {
  return new AppError(
    ErrorCodes.TELEGRAM_NOT_CONFIGURED,
    'O bot de alertas ainda não foi configurado no servidor (TELEGRAM_BOT_TOKEN).',
    503
  );
}

function invalid(message, status = 400) {
  return new AppError(ErrorCodes.TELEGRAM_INVALID, message, status);
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function randomCode() {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `SF-${out}`;
}

function enabledTypes(link) {
  return Array.isArray(link?.alertTypes) ? link.alertTypes.filter((k) => ALERT_KEYS.has(k)) : DEFAULT_ALERTS;
}

function webhookSecret() {
  if (env.telegram.webhookSecret) return env.telegram.webhookSecret;
  if (!env.telegram.botToken) return null;
  return crypto.createHash('sha256').update(`sf-webhook:${env.telegram.botToken}`).digest('hex').slice(0, 48);
}

function chatTypeLabel(type) {
  return { channel: 'Canal', group: 'Grupo', supergroup: 'Grupo', private: 'Chat privado' }[type] || type || '';
}

// ---------------------------------------------------------------------------
// Status / linking (panel)
// ---------------------------------------------------------------------------

async function botInfo() {
  if (!telegram.isConfigured()) return null;
  try {
    const me = await telegram.getMe();
    return { id: me.id, username: me.username, name: me.first_name };
  } catch (err) {
    logger.warn('Telegram getMe failed', { error: err.message });
    return null;
  }
}

function toPublicShape(link, bot) {
  if (!link) return null;
  const now = Date.now();
  const codeValid = link.linkCode && link.linkCodeExpiresAt && link.linkCodeExpiresAt.getTime() > now;
  const verifying = link.pendingChatId && link.verifyExpiresAt && link.verifyExpiresAt.getTime() > now;
  return {
    status: link.status,
    chatType: link.chatType,
    chatTypeLabel: chatTypeLabel(link.chatType),
    title: link.title,
    chatUsername: link.chatUsername,
    lastSentAt: link.lastSentAt,
    lastError: link.lastError,
    lastErrorAt: link.lastErrorAt,
    code: codeValid
      ? {
          code: link.linkCode,
          expiresAt: link.linkCodeExpiresAt,
          privateLink: bot?.username ? `https://t.me/${bot.username}?start=${link.linkCode}` : null,
          groupLink: bot?.username ? `https://t.me/${bot.username}?startgroup=${link.linkCode}` : null,
        }
      : null,
    pending: verifying
      ? {
          title: link.pendingTitle,
          chatType: link.pendingType,
          chatTypeLabel: chatTypeLabel(link.pendingType),
          expiresAt: link.verifyExpiresAt,
          attemptsLeft: Math.max(0, VERIFY_MAX_ATTEMPTS - link.verifyAttempts),
        }
      : null,
  };
}

async function getStatus(userId) {
  const [bot, link] = await Promise.all([botInfo(), prisma.telegramLink.findUnique({ where: { userId } })]);
  const enabled = enabledTypes(link);
  return {
    configured: telegram.isConfigured(),
    bot: bot ? { username: bot.username, name: bot.name } : null,
    link: toPublicShape(link, bot),
    alertTypes: ALERT_TYPES.map((a) => ({ key: a.key, label: a.label, enabled: enabled.includes(a.key) })),
  };
}

/** New "SF-XXXXXX" code (replaces the previous one). Current destination keeps working. */
async function createLinkCode(userId) {
  if (!telegram.isConfigured()) throw notConfigured();
  const expiresAt = new Date(Date.now() + LINK_CODE_MINUTES * 60 * 1000);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    try {
      await prisma.telegramLink.upsert({
        where: { userId },
        create: { userId, status: 'PENDING', linkCode: code, linkCodeExpiresAt: expiresAt },
        update: { linkCode: code, linkCodeExpiresAt: expiresAt },
      });
      return getStatus(userId);
    } catch (err) {
      if (err?.code !== 'P2002') throw err; // same code drawn twice: try another
    }
  }
  throw new Error('Could not generate a unique Telegram link code');
}

function normalizeChatRef(input) {
  const raw = String(input || '').trim();
  if (/^-?\d{1,20}$/.test(raw)) return raw;
  const m = raw.match(/^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})$/);
  if (m) return `@${m[1]}`;
  throw invalid('Informe o ID (ex.: -1001234567890) ou o @ do canal/grupo.');
}

/**
 * Step 1 of "conectar pelo ID": checks the chat and the bot's permission,
 * then posts a 6-digit code there.
 */
async function connectById(userId, chatRef) {
  if (!telegram.isConfigured()) throw notConfigured();
  const ref = normalizeChatRef(chatRef);
  let chat;
  try {
    chat = await telegram.getChat(ref);
  } catch (err) {
    throw invalid(
      'Não encontrei esse canal/grupo. Confira o ID e se o bot oficial já foi adicionado como administrador.'
    );
  }
  if (chat.type === 'private') {
    throw invalid('Esse ID é de um chat privado. Para receber no privado, use a opção "Chat privado".');
  }
  const me = await telegram.getMe();
  let member;
  try {
    member = await telegram.getChatMember(chat.id, me.id);
  } catch (err) {
    throw invalid('O bot oficial não está nesse canal/grupo. Adicione-o como administrador e tente de novo.');
  }
  if (chat.type === 'channel') {
    if (member.status !== 'administrator' || member.can_post_messages === false) {
      throw invalid('No canal, o bot precisa ser administrador com a permissão "Publicar mensagens".');
    }
  } else if (!['administrator', 'member', 'creator'].includes(member.status) || member.can_send_messages === false) {
    throw invalid('O bot precisa estar no grupo e poder enviar mensagens.');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  let sent;
  try {
    sent = await telegram.sendMessage(
      chat.id,
      `🔐 <b>Código de confirmação do SocialFlow: ${code}</b>\n` +
        `Digite este código no painel (Monitoramento → Telegram) para conectar ${chat.type === 'channel' ? 'este canal' : 'este grupo'}.\n` +
        `Válido por ${VERIFY_MINUTES} minutos. Se não foi você, ignore.`
    );
  } catch (err) {
    throw invalid('O bot não conseguiu publicar aí. Confira a permissão "Publicar mensagens".');
  }

  const data = {
    pendingChatId: String(chat.id),
    pendingTitle: chat.title || chat.username || String(chat.id),
    pendingType: chat.type,
    pendingUsername: chat.username || null,
    verifyCode: code,
    verifyMessageId: sent?.message_id ?? null,
    verifyExpiresAt: new Date(Date.now() + VERIFY_MINUTES * 60 * 1000),
    verifyAttempts: 0,
  };
  const existing = await prisma.telegramLink.findUnique({ where: { userId } });
  await prisma.telegramLink.upsert({
    where: { userId },
    create: { userId, status: 'VERIFYING', ...data },
    update: { ...data, ...(existing?.status === 'ACTIVE' ? {} : { status: 'VERIFYING' }) },
  });
  logger.info('Telegram link verification started', { userId, chatType: chat.type });
  return getStatus(userId);
}

async function displayName(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name ? esc(user.name) : 'sua conta';
}

async function activate(userId, chat, extra = {}) {
  await prisma.telegramLink.update({
    where: { userId },
    data: {
      status: 'ACTIVE',
      chatId: String(chat.id),
      chatType: chat.type,
      title: chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id),
      chatUsername: chat.username || null,
      linkCode: null,
      linkCodeExpiresAt: null,
      pendingChatId: null,
      pendingTitle: null,
      pendingType: null,
      pendingUsername: null,
      verifyCode: null,
      verifyMessageId: null,
      verifyExpiresAt: null,
      verifyAttempts: 0,
      lastError: null,
      lastErrorAt: null,
      ...extra,
    },
  });
  const name = await displayName(userId);
  telegram
    .sendMessage(
      chat.id,
      `✅ <b>Conectado ao SocialFlow</b>\nOs alertas de ${name} vão chegar aqui.\n` +
        `Escolha quais alertas receber em Monitoramento → Telegram.`
    )
    .catch(() => {});
  logger.info('Telegram link active', { userId, chatType: chat.type });
}

/** Step 2 of "conectar pelo ID": the 6-digit code the bot posted. */
async function confirmById(userId, code) {
  const link = await prisma.telegramLink.findUnique({ where: { userId } });
  if (!link?.pendingChatId || !link.verifyCode) throw invalid('Nenhuma conexão aguardando código. Clique em "Conectar" de novo.');
  if (!link.verifyExpiresAt || link.verifyExpiresAt.getTime() < Date.now()) {
    throw invalid('O código expirou. Clique em "Conectar" para receber outro.');
  }
  const typed = String(code || '').replace(/\D/g, '');
  const ok =
    typed.length === 6 &&
    crypto.timingSafeEqual(Buffer.from(typed.padEnd(6, '0')), Buffer.from(link.verifyCode.padEnd(6, '0')));
  if (!ok) {
    const attempts = link.verifyAttempts + 1;
    if (attempts >= VERIFY_MAX_ATTEMPTS) {
      await prisma.telegramLink.update({
        where: { userId },
        data: {
          pendingChatId: null,
          verifyCode: null,
          verifyExpiresAt: null,
          verifyAttempts: 0,
          ...(link.status === 'VERIFYING' ? { status: 'PENDING' } : {}),
        },
      });
      throw invalid('Código incorreto muitas vezes. Clique em "Conectar" para gerar outro.');
    }
    await prisma.telegramLink.update({ where: { userId }, data: { verifyAttempts: attempts } });
    throw invalid(`Código incorreto. ${VERIFY_MAX_ATTEMPTS - attempts} tentativa(s) restante(s).`);
  }
  const chat = {
    id: link.pendingChatId,
    type: link.pendingType,
    title: link.pendingTitle,
    username: link.pendingUsername,
  };
  if (link.verifyMessageId) telegram.deleteMessage(link.pendingChatId, link.verifyMessageId).catch(() => {});
  await activate(userId, chat);
  return getStatus(userId);
}

async function setAlertTypes(userId, types) {
  if (!Array.isArray(types)) throw invalid('Envie a lista de alertas.');
  const clean = [...new Set(types.map(String))].filter((k) => ALERT_KEYS.has(k));
  const link = await prisma.telegramLink.findUnique({ where: { userId } });
  if (!link) throw invalid('Conecte o Telegram primeiro.');
  await prisma.telegramLink.update({ where: { userId }, data: { alertTypes: clean } });
  return getStatus(userId);
}

async function sendTest(userId) {
  if (!telegram.isConfigured()) throw notConfigured();
  const link = await prisma.telegramLink.findUnique({ where: { userId } });
  if (!link || link.status !== 'ACTIVE') throw invalid('Conecte o Telegram primeiro.');
  try {
    await telegram.sendMessage(
      link.chatId,
      `🔔 <b>Teste do SocialFlow</b>\nTudo certo: os alertas de ${await displayName(userId)} chegam aqui.`
    );
    await prisma.telegramLink.update({ where: { userId }, data: { lastSentAt: new Date(), lastError: null, lastErrorAt: null } });
  } catch (err) {
    if (telegram.isPermanentChatError(err)) {
      await markBroken(userId, err.description || err.message);
      throw invalid('O bot não consegue mais enviar para esse destino (removido ou sem permissão). Conecte de novo.', 409);
    }
    throw invalid(`O Telegram recusou o envio: ${err.description || err.message}`, 502);
  }
  return getStatus(userId);
}

async function disconnect(userId) {
  const link = await prisma.telegramLink.findUnique({ where: { userId } });
  if (!link) return { disconnected: false };
  if (link.status === 'ACTIVE' && link.chatId && telegram.isConfigured()) {
    telegram.sendMessage(link.chatId, '🔕 Alertas do SocialFlow desconectados deste chat.').catch(() => {});
  }
  await prisma.telegramLink.delete({ where: { userId } });
  logger.info('Telegram link removed', { userId });
  return { disconnected: true };
}

async function markBroken(userId, reason) {
  await prisma.telegramLink
    .updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'BROKEN', lastError: String(reason || '').slice(0, 500), lastErrorAt: new Date() },
    })
    .catch(() => {});
  // Bell only: the link is BROKEN, so this one is not sent to Telegram.
  require('../notifications/notificationService')
    .notify({
      userId,
      type: 'TELEGRAM_BROKEN',
      severity: 'warning',
      title: 'Alertas do Telegram desconectados',
      message: 'O bot oficial foi removido ou perdeu a permissão de publicar. Conecte de novo em Monitoramento → Telegram.',
      dedupeKey: `telegram-broken:${userId}`,
      dedupeWindowMinutes: 24 * 60,
    })
    .catch(() => {});
  logger.warn('Telegram link broken', { userId, reason });
}

// ---------------------------------------------------------------------------
// Webhook (Telegram -> us)
// ---------------------------------------------------------------------------

function isValidWebhookSecret(header) {
  const expected = webhookSecret();
  if (!expected || !header) return false;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function linkByCode(code, chat, { messageId = null, isChannelPost = false } = {}) {
  const link = await prisma.telegramLink.findUnique({ where: { linkCode: code.toUpperCase() } });
  if (!link || !link.linkCodeExpiresAt || link.linkCodeExpiresAt.getTime() < Date.now()) return false;
  if (isChannelPost && messageId) telegram.deleteMessage(chat.id, messageId).catch(() => {});
  await activate(link.userId, chat);
  return true;
}

async function handleUpdate(update) {
  try {
    if (update?.my_chat_member) {
      const { chat, new_chat_member: nm } = update.my_chat_member;
      const lost =
        ['left', 'kicked'].includes(nm?.status) ||
        (chat.type === 'channel' && (nm?.status !== 'administrator' || nm?.can_post_messages === false)) ||
        (nm?.status === 'restricted' && nm?.can_send_messages === false);
      const links = await prisma.telegramLink.findMany({ where: { chatId: String(chat.id) } });
      for (const link of links) {
        if (lost && link.status === 'ACTIVE') await markBroken(link.userId, 'O bot foi removido ou perdeu a permissão de publicar.');
        if (!lost && link.status === 'BROKEN') {
          await prisma.telegramLink.update({ where: { userId: link.userId }, data: { status: 'ACTIVE', lastError: null, lastErrorAt: null } });
        }
      }
      return;
    }

    const msg = update?.message || update?.channel_post;
    if (!msg?.chat) return;

    // Group upgraded to supergroup: the chat id changes.
    if (msg.migrate_to_chat_id) {
      await prisma.telegramLink.updateMany({
        where: { chatId: String(msg.chat.id) },
        data: { chatId: String(msg.migrate_to_chat_id), chatType: 'supergroup' },
      });
      return;
    }

    const text = String(msg.text || msg.caption || '');
    if (!text) return;
    const isChannelPost = Boolean(update.channel_post);
    const start = text.match(START_RE);

    let code = null;
    if (start) code = start[1] && LINK_CODE_RE.test(start[1]) ? start[1].match(LINK_CODE_RE)[1] : null;
    else if (isChannelPost || msg.chat.type !== 'private') code = (text.match(LINK_CODE_RE) || [])[1] || null;
    else code = (text.match(LINK_CODE_RE) || [])[1] || null;

    if (code) {
      const linked = await linkByCode(code, msg.chat, { messageId: msg.message_id, isChannelPost });
      if (!linked && (start || msg.chat.type === 'private')) {
        await telegram
          .sendMessage(msg.chat.id, '⚠️ Código inválido ou expirado. Gere um novo no SocialFlow (Monitoramento → Telegram).')
          .catch(() => {});
      }
      return;
    }

    if (start && msg.chat.type === 'private') {
      await telegram
        .sendMessage(
          msg.chat.id,
          '👋 Este é o bot oficial de alertas do <b>SocialFlow</b>.\n' +
            'Para receber os alertas dos seus perfis, abra o SocialFlow → Monitoramento → Telegram e siga as instruções.'
        )
        .catch(() => {});
    }
  } catch (err) {
    logger.warn('Telegram update handling failed (ignored)', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Dispatch (notifications -> Telegram), grouped per user
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI = { error: '🔴', warning: '⚠️', success: '✅', info: 'ℹ️' };
const buffer = new Map(); // userId -> [{ type, severity, title, message, at }]
let flushTimer = null;
let flushing = false;

/** Called by notificationService.notify for every NEW notification. Never throws. */
function enqueue(notification) {
  try {
    if (!telegram.isConfigured() || !notification?.userId) return;
    if (!ALERT_KEYS.has(notification.type)) return;
    const list = buffer.get(notification.userId) || [];
    list.push({
      type: notification.type,
      severity: notification.severity || 'info',
      title: notification.title,
      message: notification.message,
      at: Date.now(),
    });
    buffer.set(notification.userId, list);
  } catch (err) {
    logger.warn('Telegram enqueue failed (ignored)', { error: err.message });
  }
}

function openLink() {
  return env.frontendUrl ? `\n\n<a href="${esc(env.frontendUrl)}/monitoring">Abrir o SocialFlow</a>` : '';
}

function formatAlerts(items) {
  if (items.length === 1) {
    const it = items[0];
    return `${SEVERITY_EMOJI[it.severity] || '🔔'} <b>${esc(it.title)}</b>${it.message ? `\n${esc(it.message)}` : ''}${openLink()}`;
  }
  const lines = items
    .slice(0, GROUP_LIST_MAX)
    .map((it) => `${SEVERITY_EMOJI[it.severity] || '•'} ${esc(it.title)}`);
  const more = items.length > GROUP_LIST_MAX ? `\n… e mais ${items.length - GROUP_LIST_MAX}` : '';
  return `🔔 <b>${items.length} alertas do SocialFlow</b>\n\n${lines.join('\n')}${more}${openLink()}`.slice(0, 4000);
}

/** Sends text to the user's destination. Returns true when delivered. */
async function sendToUser(userId, text) {
  const link = await prisma.telegramLink.findUnique({ where: { userId } });
  if (!link || link.status !== 'ACTIVE' || !link.chatId) return false;
  try {
    await telegram.sendMessage(link.chatId, text);
    await prisma.telegramLink.update({ where: { userId }, data: { lastSentAt: new Date() } });
    return true;
  } catch (err) {
    if (telegram.isPermanentChatError(err)) await markBroken(userId, err.description || err.message);
    throw err;
  }
}

async function flush() {
  if (flushing || buffer.size === 0) return;
  flushing = true;
  try {
    const entries = [...buffer.entries()];
    buffer.clear();
    for (const [userId, items] of entries) {
      const link = await prisma.telegramLink.findUnique({ where: { userId } });
      if (!link || link.status !== 'ACTIVE') continue;
      const allowed = new Set(enabledTypes(link));
      const toSend = items.filter((it) => allowed.has(it.type));
      if (toSend.length === 0) continue;
      try {
        await sendToUser(userId, formatAlerts(toSend));
      } catch (err) {
        if (!telegram.isPermanentChatError(err)) {
          // Temporary (429 / network): try again on the next flush.
          const keep = toSend.filter((it) => Date.now() - it.at < MAX_ITEM_AGE_MS);
          if (keep.length) buffer.set(userId, [...keep, ...(buffer.get(userId) || [])]);
          logger.warn('Telegram send failed, will retry', { userId, error: err.message });
        }
      }
    }
  } finally {
    flushing = false;
  }
}

async function start() {
  if (!telegram.isConfigured()) {
    logger.info('Telegram alerts disabled (no TELEGRAM_BOT_TOKEN)');
    return;
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => flush().catch(() => {}), FLUSH_MS);
    flushTimer.unref?.();
  }
  try {
    const me = await telegram.getMe();
    if (env.backendUrl) {
      await telegram.setWebhook(`${String(env.backendUrl).replace(/\/+$/, '')}/api/telegram/webhook`, webhookSecret());
    }
    logger.info('Telegram alerts bot ready', { bot: me.username });
  } catch (err) {
    logger.error('Telegram bot setup failed (alerts will retry on demand)', { error: err.message });
  }
}

function stop() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

module.exports = {
  ALERT_TYPES,
  getStatus,
  createLinkCode,
  connectById,
  confirmById,
  setAlertTypes,
  sendTest,
  disconnect,
  handleUpdate,
  isValidWebhookSecret,
  enqueue,
  flush,
  sendToUser,
  formatAlerts,
  start,
  stop,
  // tests
  _buffer: buffer,
  _webhookSecret: webhookSecret,
};