// Rodada 16: "Modelos" — reusable post structures.
//
// A template keeps: name, type (or any), default caption (spintax allowed in
// batch mode), a hashtag set and an optional destination folder. Applying
// it fills the composer; nothing is published from here.
//
// Hashtags are normalized (# added, duplicates removed, max 30 — Instagram's
// limit per post) and the caption + hashtags must fit in 2200 characters.

const prisma = require('../../config/database');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const VALID_TYPES = ['FEED_IMAGE', 'FEED_VIDEO', 'FEED_CAROUSEL', 'REEL', 'STORY'];
const NAME_MAX = 60;
const CAPTION_MAX = 2200;
const HASHTAGS_MAX = 30;
const TEMPLATES_MAX = 200;

const INCLUDE = {
  accountFolder: { select: { id: true, name: true, members: { select: { instagramAccountId: true } } } },
};

function invalid(message) {
  return new AppError(ErrorCodes.TEMPLATE_INVALID, message, 400);
}

/** "#memes humor, #memes  #viral" -> ['#memes', '#humor', '#viral'] */
function normalizeHashtags(input) {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input.join(' ') : String(input);
  const seen = new Set();
  const out = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const word = piece.replace(/^#+/, '').trim();
    if (!word) continue;
    if (!/^[\p{L}\p{N}_]+$/u.test(word)) {
      throw invalid(`Hashtag inválida: #${word}. Use só letras, números e _.`);
    }
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${word}`);
  }
  if (out.length > HASHTAGS_MAX) {
    throw invalid(`Máximo de ${HASHTAGS_MAX} hashtags (o Instagram não aceita mais que isso).`);
  }
  return out;
}

/** Final text the composer receives: caption + blank line + hashtags. */
function composeCaption(caption, hashtags) {
  const parts = [String(caption || '').trim(), String(hashtags || '').trim()].filter(Boolean);
  return parts.join('\n\n');
}

async function assertFolder(userId, folderId) {
  if (!folderId) return null;
  const folder = await prisma.accountFolder.findFirst({ where: { id: String(folderId), userId }, select: { id: true } });
  if (!folder) throw new AppError(ErrorCodes.ACCOUNT_FOLDER_NOT_FOUND, 'Pasta não encontrada.', 404);
  return folder.id;
}

async function buildData(userId, input, current = null) {
  const data = {};
  if (input.name !== undefined || !current) {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw invalid('Dê um nome ao modelo.');
    if (name.length > NAME_MAX) throw invalid(`Nome com no máximo ${NAME_MAX} caracteres.`);
    data.name = name;
  }
  if (input.type !== undefined) {
    if (input.type && !VALID_TYPES.includes(input.type)) throw invalid('Tipo de post inválido.');
    data.type = input.type || null;
  }
  if (input.caption !== undefined) {
    const caption = input.caption == null ? '' : String(input.caption).replace(/\r\n/g, '\n').trim();
    data.caption = caption || null;
  }
  if (input.hashtags !== undefined) {
    const tags = normalizeHashtags(input.hashtags);
    data.hashtags = tags.length ? tags.join(' ') : null;
  }
  if (input.accountFolderId !== undefined || input.folderId !== undefined) {
    data.accountFolderId = await assertFolder(userId, input.accountFolderId ?? input.folderId);
  }
  const caption = data.caption !== undefined ? data.caption : current?.caption;
  const hashtags = data.hashtags !== undefined ? data.hashtags : current?.hashtags;
  if (composeCaption(caption, hashtags).length > CAPTION_MAX) {
    throw invalid(`Legenda + hashtags passam de ${CAPTION_MAX} caracteres (limite do Instagram).`);
  }
  return data;
}

function duplicateName(err) {
  return err?.code === 'P2002' ? invalid('Já existe um modelo com esse nome.') : err;
}

function toPublicShape(t) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    caption: t.caption,
    hashtags: t.hashtags,
    hashtagCount: t.hashtags ? t.hashtags.split(' ').length : 0,
    finalCaption: composeCaption(t.caption, t.hashtags),
    folder: t.accountFolder
      ? {
          id: t.accountFolder.id,
          name: t.accountFolder.name,
          accountIds: (t.accountFolder.members || []).map((m) => m.instagramAccountId),
        }
      : null,
    usageCount: t.usageCount,
    lastUsedAt: t.lastUsedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function listTemplates(userId) {
  const rows = await prisma.postTemplate.findMany({
    where: { userId },
    include: INCLUDE,
    orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
  });
  return rows.map(toPublicShape);
}

async function getOwned(id, userId) {
  const row = await prisma.postTemplate.findFirst({ where: { id: String(id), userId }, include: INCLUDE });
  if (!row) throw new AppError(ErrorCodes.TEMPLATE_NOT_FOUND, 'Modelo não encontrado.', 404);
  return row;
}

async function createTemplate(userId, input = {}) {
  const count = await prisma.postTemplate.count({ where: { userId } });
  if (count >= TEMPLATES_MAX) throw invalid(`Máximo de ${TEMPLATES_MAX} modelos.`);
  const data = await buildData(userId, { type: null, caption: null, hashtags: null, ...input });
  try {
    const row = await prisma.postTemplate.create({ data: { userId, ...data }, include: INCLUDE });
    logger.info('Post template created', { userId, templateId: row.id });
    return toPublicShape(row);
  } catch (err) {
    throw duplicateName(err);
  }
}

async function updateTemplate(id, userId, input = {}) {
  const current = await getOwned(id, userId);
  const data = await buildData(userId, input, current);
  try {
    const row = await prisma.postTemplate.update({ where: { id: current.id }, data, include: INCLUDE });
    return toPublicShape(row);
  } catch (err) {
    throw duplicateName(err);
  }
}

async function deleteTemplate(id, userId) {
  const current = await getOwned(id, userId);
  await prisma.postTemplate.delete({ where: { id: current.id } });
  logger.info('Post template deleted', { userId, templateId: current.id });
  return { id: current.id };
}

/** Called when the user applies a template: usage counter + "recentes" order. */
async function markUsed(id, userId) {
  const current = await getOwned(id, userId);
  const row = await prisma.postTemplate.update({
    where: { id: current.id },
    data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
    include: INCLUDE,
  });
  return toPublicShape(row);
}

module.exports = {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  markUsed,
  toPublicShape,
  normalizeHashtags,
  composeCaption,
};