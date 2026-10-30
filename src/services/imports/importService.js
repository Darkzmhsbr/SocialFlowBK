// Rodada 19B: create scheduled posts from a spreadsheet (CSV / XLSX).
//
// The browser reads the file and sends the rows as JSON; this service
// validates every row (preview) and, after the user confirms, creates the
// posts (commit). Nothing is created by the preview.
//
// Columns (header names are matched without accents/case on the frontend):
//   perfil   @username of a connected profile
//   arquivo  name of a media of the Biblioteca ("video01.mp4"); several
//            separated by | make a carousel
//   legenda  optional; {a|b} variations work like in the batch composer
//   data     dd/mm/aaaa (or aaaa-mm-dd); empty data + hora = draft
//   hora     HH:MM (Brasília)
//   tipo     optional: reels, foto, video, carrossel, story (guessed if empty)
//   capa     optional image name used as cover (Reels / video)
//
// All imported posts of one import share a batchId, so the existing
// "Gerenciar lote" (archive / delete / publish now) works on them.

const crypto = require('crypto');
const prisma = require('../../config/database');
const postService = require('../posts/scheduledPostService');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const MAX_ROWS = 500;
const CAPTION_MAX = 2200;
const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // Brasília (UTC-3)
const MIN_LEAD_MS = 2 * 60 * 1000;

const TYPE_ALIASES = {
  reel: 'REEL',
  reels: 'REEL',
  foto: 'FEED_IMAGE',
  imagem: 'FEED_IMAGE',
  image: 'FEED_IMAGE',
  feed: 'FEED_IMAGE',
  feed_image: 'FEED_IMAGE',
  video: 'FEED_VIDEO',
  feed_video: 'FEED_VIDEO',
  carrossel: 'FEED_CAROUSEL',
  carousel: 'FEED_CAROUSEL',
  feed_carousel: 'FEED_CAROUSEL',
  story: 'STORY',
  stories: 'STORY',
};
const TYPE_LABELS = {
  REEL: 'Reels',
  FEED_IMAGE: 'Foto no feed',
  FEED_VIDEO: 'Vídeo no feed',
  FEED_CAROUSEL: 'Carrossel',
  STORY: 'Story',
};
// Same rules as the composer (postConstants / scheduledPostService).
const RULES = {
  FEED_IMAGE: { min: 1, max: 1, allowed: ['IMAGE'], cover: false },
  FEED_VIDEO: { min: 1, max: 1, allowed: ['VIDEO'], cover: true },
  FEED_CAROUSEL: { min: 2, max: 10, allowed: ['IMAGE', 'VIDEO'], cover: false },
  REEL: { min: 1, max: 1, allowed: ['VIDEO'], cover: true },
  STORY: { min: 1, max: 1, allowed: ['IMAGE', 'VIDEO'], cover: false },
};

function invalid(message) {
  return new AppError(ErrorCodes.IMPORT_INVALID, message, 400);
}

function plain(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/** "dd/mm/aaaa", "dd/mm/aa", "aaaa-mm-dd", "dd-mm-aaaa", "dd.mm.aaaa" or an Excel serial. */
function parseDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return { y, mo: +m[2], d: +m[1] };
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    // Excel serial date (days since 1899-12-30)
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  return undefined; // present but unreadable
}

/** "20:00", "8:05", "20:00:00", "20h", "20h30" or an Excel fraction of a day. */
function parseTime(raw) {
  const s = plain(raw);
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) m = s.match(/^(\d{1,2})h(\d{2})?$/);
  if (m) {
    const t = { h: +m[1], mi: m[2] ? +m[2] : 0 };
    return t.h > 23 || t.mi > 59 ? undefined : t;
  }
  if (/^0?\.\d+$/.test(s)) {
    const total = Math.round(Number(s) * 24 * 60);
    return { h: Math.floor(total / 60) % 24, mi: total % 60 };
  }
  return undefined;
}

function brasiliaToUtc({ y, mo, d }, { h, mi }) {
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi) + SP_OFFSET_MS);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return date;
}

function splitFiles(raw) {
  return String(raw ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function longestCaption(template) {
  if (!template || !template.includes('|')) return template || '';
  let longest = '';
  for (let i = 0; i < 8; i += 1) {
    const r = postService.resolveSpintax(template);
    if (r.length > longest.length) longest = r;
  }
  return longest;
}

async function loadContext(userId) {
  const [accounts, medias] = await Promise.all([
    prisma.instagramAccount.findMany({
      where: { userId },
      select: { id: true, username: true, status: true },
    }),
    prisma.mediaAsset.findMany({
      where: { userId, originalName: { not: null }, purgedAt: null },
      select: { id: true, originalName: true, type: true, inLibrary: true },
      orderBy: [{ inLibrary: 'desc' }, { createdAt: 'desc' }],
    }),
  ]);
  const accountByName = new Map(accounts.map((a) => [a.username.toLowerCase(), a]));
  const mediaByName = new Map();
  for (const m of medias) {
    const key = m.originalName.toLowerCase();
    if (!mediaByName.has(key)) mediaByName.set(key, m); // library first
  }
  return { accountByName, mediaByName };
}

function validateRow(raw, index, ctx, now) {
  const line = Number(raw?.line) || index + 2; // header = line 1
  const errors = [];
  const warnings = [];

  // perfil
  const username = String(raw?.profile ?? '').trim().replace(/^@/, '');
  const account = username ? ctx.accountByName.get(username.toLowerCase()) : null;
  if (!username) errors.push('Perfil vazio.');
  else if (!account) errors.push(`Perfil @${username} não está conectado nesta conta.`);
  else if (account.status !== 'ACTIVE') warnings.push(`@${account.username} está com problema: o post fica esperando até o perfil voltar.`);

  // arquivos
  const names = splitFiles(raw?.files);
  const files = [];
  if (names.length === 0) errors.push('Coluna "arquivo" vazia.');
  for (const name of names) {
    const media = ctx.mediaByName.get(name.toLowerCase());
    if (!media) errors.push(`Arquivo "${name}" não encontrado na Biblioteca.`);
    else files.push({ name: media.originalName, id: media.id, type: media.type });
  }

  // tipo
  let type = null;
  const typeRaw = plain(raw?.type).replace(/\s+/g, '_');
  if (typeRaw) {
    type = TYPE_ALIASES[typeRaw] || null;
    if (!type) errors.push(`Tipo "${raw.type}" não reconhecido (use reels, foto, video, carrossel ou story).`);
  } else if (files.length > 1) type = 'FEED_CAROUSEL';
  else if (files.length === 1) type = files[0].type === 'VIDEO' ? 'REEL' : 'FEED_IMAGE';

  if (type && files.length === names.length && files.length > 0) {
    const r = RULES[type];
    if (files.length < r.min || files.length > r.max) {
      errors.push(`${TYPE_LABELS[type]} aceita ${r.min === r.max ? r.min : `${r.min} a ${r.max}`} arquivo(s); a linha tem ${files.length}.`);
    }
    const wrong = files.find((f) => !r.allowed.includes(f.type));
    if (wrong) errors.push(`"${wrong.name}" é ${wrong.type === 'VIDEO' ? 'vídeo' : 'imagem'} e não serve para ${TYPE_LABELS[type]}.`);
  }

  // capa
  let cover = null;
  const coverName = String(raw?.cover ?? '').trim();
  if (coverName) {
    const media = ctx.mediaByName.get(coverName.toLowerCase());
    if (!media) errors.push(`Capa "${coverName}" não encontrada na Biblioteca.`);
    else if (media.type !== 'IMAGE') errors.push('A capa precisa ser uma imagem.');
    else if (type && !RULES[type].cover) warnings.push(`${TYPE_LABELS[type]} não usa capa: a coluna "capa" será ignorada.`);
    else cover = { name: media.originalName, id: media.id };
  }

  // legenda
  const caption = String(raw?.caption ?? '').replace(/\r\n/g, '\n').trim();
  if (caption && longestCaption(caption).length > CAPTION_MAX) {
    errors.push(`Legenda passa de ${CAPTION_MAX} caracteres (limite do Instagram).`);
  }

  // data + hora
  let scheduledFor = null;
  const date = parseDate(raw?.date);
  const time = parseTime(raw?.time);
  if (date === undefined) errors.push(`Data "${raw.date}" inválida (use dd/mm/aaaa).`);
  if (time === undefined) errors.push(`Hora "${raw.time}" inválida (use HH:MM).`);
  if (date && time) {
    scheduledFor = brasiliaToUtc(date, time);
    if (!scheduledFor) errors.push('Data ou hora não existe no calendário.');
    else if (scheduledFor.getTime() < now + MIN_LEAD_MS) errors.push('Data e hora já passaram (ou faltam menos de 2 minutos).');
  } else if (date && time === null) errors.push('Falta a hora.');
  else if (time && date === null) errors.push('Falta a data.');
  else if (date === null && time === null) warnings.push('Sem data e hora: o post será criado como rascunho.');

  return {
    line,
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    errors,
    warnings,
    resolved: {
      username: account?.username || (username || null),
      accountId: account?.id || null,
      type,
      typeLabel: type ? TYPE_LABELS[type] : null,
      files,
      cover,
      scheduledFor,
      caption,
      captionPreview: caption ? postService.resolveSpintax(caption).slice(0, 140) : null,
    },
  };
}

function checkRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw invalid('A planilha não tem linhas para importar.');
  if (rows.length > MAX_ROWS) throw invalid(`Máximo de ${MAX_ROWS} linhas por importação. Divida a planilha.`);
}

/** Validates every row. Creates nothing. */
async function preview(userId, rows, now = Date.now()) {
  checkRows(rows);
  const ctx = await loadContext(userId);
  const result = rows.map((raw, i) => validateRow(raw, i, ctx, now));

  // Same profile + same files + same time twice = probably a copy/paste slip.
  const seen = new Map();
  for (const r of result) {
    if (r.status === 'error' || !r.resolved.scheduledFor) continue;
    const key = `${r.resolved.accountId}|${r.resolved.files.map((f) => f.id).join(',')}|${r.resolved.scheduledFor.getTime()}`;
    if (seen.has(key)) {
      r.warnings.push(`Igual à linha ${seen.get(key)} (mesmo perfil, arquivo e horário).`);
      if (r.status === 'ok') r.status = 'warning';
    } else seen.set(key, r.line);
  }

  return {
    rows: result,
    summary: {
      total: result.length,
      ok: result.filter((r) => r.status === 'ok').length,
      warnings: result.filter((r) => r.status === 'warning').length,
      errors: result.filter((r) => r.status === 'error').length,
      drafts: result.filter((r) => r.status !== 'error' && !r.resolved.scheduledFor).length,
      profiles: new Set(result.filter((r) => r.status !== 'error').map((r) => r.resolved.accountId)).size,
    },
  };
}

/**
 * Creates the posts of the valid rows (rows with errors are skipped).
 * The browser sends big spreadsheets in parts: the 2nd part onwards passes
 * the batchId returned by the 1st, so the whole import stays one batch.
 * Returns { created, skipped, failed: [{ line, error }], batchId }.
 */
async function commit(userId, rows, { batchId: continueBatch = null } = {}) {
  const { rows: checked } = await preview(userId, rows);
  const valid = checked.filter((r) => r.status !== 'error');
  if (valid.length === 0) {
    if (continueBatch) return { created: 0, skipped: checked.length, failed: [], batchId: continueBatch };
    throw invalid('Nenhuma linha válida para importar. Corrija os erros da prévia.');
  }

  let batchId = crypto.randomUUID();
  if (continueBatch && /^[0-9a-f-]{36}$/i.test(String(continueBatch))) {
    const foreign = await prisma.scheduledPost.count({ where: { batchId: continueBatch, userId: { not: userId } } });
    if (!foreign) batchId = continueBatch;
  }
  const createdIds = [];
  const failed = [];
  for (const r of valid) {
    try {
      const post = await postService.createPost({
        userId,
        instagramAccountId: r.resolved.accountId,
        type: r.resolved.type,
        caption: r.resolved.caption ? postService.resolveSpintax(r.resolved.caption) : null,
        mediaIds: r.resolved.files.map((f) => f.id),
        scheduledFor: r.resolved.scheduledFor ? r.resolved.scheduledFor.toISOString() : null,
        coverMediaAssetId: r.resolved.cover?.id || undefined,
      });
      createdIds.push(post.id);
    } catch (err) {
      failed.push({ line: r.line, error: err.message });
    }
  }
  if (createdIds.length) {
    await prisma.scheduledPost.updateMany({ where: { id: { in: createdIds }, userId }, data: { batchId } });
  }
  logger.info('Spreadsheet import', { userId, created: createdIds.length, failed: failed.length, skipped: checked.length - valid.length });
  return {
    created: createdIds.length,
    skipped: checked.length - valid.length,
    failed,
    batchId: createdIds.length ? batchId : null,
  };
}

/** Names the user can put in the "arquivo" column (Biblioteca first). */
async function listMediaNames(userId) {
  const rows = await prisma.mediaAsset.findMany({
    where: { userId, originalName: { not: null }, purgedAt: null },
    select: {
      originalName: true,
      type: true,
      inLibrary: true,
      createdAt: true,
      folder: { select: { name: true } },
    },
    orderBy: [{ inLibrary: 'desc' }, { createdAt: 'desc' }],
    take: 5000,
  });
  return rows.map((m) => ({
    name: m.originalName,
    type: m.type,
    inLibrary: m.inLibrary,
    folder: m.folder?.name || null,
    createdAt: m.createdAt,
  }));
}

module.exports = { preview, commit, listMediaNames, parseDate, parseTime, MAX_ROWS };