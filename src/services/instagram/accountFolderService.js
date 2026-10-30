// Rodada 8: profile folders ("Memes", "Contas novas"...). A profile can be
// in several folders. Every operation is scoped to the logged-in user:
// folders and profiles of another user are treated as "not found".

const prisma = require('../../config/database');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const NAME_MAX = 60;
const MEMBERS_MAX = 500;

function normalizeName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Dê um nome para a pasta.', 400);
  if (clean.length > NAME_MAX) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Nome da pasta: no máximo ${NAME_MAX} caracteres.`, 400);
  }
  return clean;
}

function nameTaken(clean) {
  return new AppError(ErrorCodes.FOLDER_NAME_TAKEN, `Você já tem uma pasta chamada "${clean}".`, 409);
}

async function getOwnedFolder(id, userId) {
  const folder = await prisma.accountFolder.findUnique({ where: { id } });
  if (!folder || folder.userId !== userId) {
    throw new AppError(ErrorCodes.ACCOUNT_FOLDER_NOT_FOUND, 'Pasta não encontrada.', 404);
  }
  return folder;
}

/** Keeps only ids of profiles that belong to the user. */
async function ownedAccountIds(accountIds, userId) {
  const list = [...new Set((accountIds || []).map(String))].slice(0, MEMBERS_MAX);
  if (list.length === 0) return [];
  const rows = await prisma.instagramAccount.findMany({
    where: { id: { in: list }, userId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Folders with their member ids (the frontend joins with the accounts list). */
async function listFolders(userId) {
  const folders = await prisma.accountFolder.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
    include: { members: { select: { instagramAccountId: true } } },
  });
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    accountIds: f.members.map((m) => m.instagramAccountId),
    count: f.members.length,
    createdAt: f.createdAt,
  }));
}

async function createFolder(userId, { name, accountIds } = {}) {
  const clean = normalizeName(name);
  const ids = await ownedAccountIds(accountIds, userId);
  try {
    const folder = await prisma.accountFolder.create({
      data: {
        userId,
        name: clean,
        members: { create: ids.map((instagramAccountId) => ({ instagramAccountId })) },
      },
    });
    logger.info('Account folder created', { userId, folderId: folder.id, members: ids.length });
    return { id: folder.id, name: folder.name, accountIds: ids, count: ids.length };
  } catch (err) {
    if (err.code === 'P2002') throw nameTaken(clean);
    throw err;
  }
}

async function renameFolder(id, userId, name) {
  await getOwnedFolder(id, userId);
  const clean = normalizeName(name);
  try {
    const folder = await prisma.accountFolder.update({ where: { id }, data: { name: clean } });
    return { id: folder.id, name: folder.name };
  } catch (err) {
    if (err.code === 'P2002') throw nameTaken(clean);
    throw err;
  }
}

/** Deleting a folder never disconnects or deletes profiles. */
async function deleteFolder(id, userId) {
  await getOwnedFolder(id, userId);
  await prisma.accountFolder.delete({ where: { id } });
  logger.info('Account folder deleted', { userId, folderId: id });
  return { id };
}

/** Replace the whole member list (the "edit profiles" checklist). */
async function setMembers(id, userId, accountIds) {
  await getOwnedFolder(id, userId);
  const ids = await ownedAccountIds(accountIds, userId);
  await prisma.$transaction([
    prisma.accountFolderMember.deleteMany({ where: { folderId: id } }),
    prisma.accountFolderMember.createMany({
      data: ids.map((instagramAccountId) => ({ folderId: id, instagramAccountId })),
      skipDuplicates: true,
    }),
  ]);
  return { id, accountIds: ids, count: ids.length };
}

async function addMembers(id, userId, accountIds) {
  await getOwnedFolder(id, userId);
  const ids = await ownedAccountIds(accountIds, userId);
  const { count } = await prisma.accountFolderMember.createMany({
    data: ids.map((instagramAccountId) => ({ folderId: id, instagramAccountId })),
    skipDuplicates: true,
  });
  return { id, added: count };
}

async function removeMembers(id, userId, accountIds) {
  await getOwnedFolder(id, userId);
  const list = [...new Set((accountIds || []).map(String))];
  const { count } = await prisma.accountFolderMember.deleteMany({
    where: { folderId: id, instagramAccountId: { in: list } },
  });
  return { id, removed: count };
}

module.exports = {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  setMembers,
  addMembers,
  removeMembers,
};