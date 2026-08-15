// All Prisma queries for InstagramAccount live here. Controllers and
// services never import @prisma/client directly - they call these
// functions, which keeps persistence details in one place.

const prisma = require('../config/database');

function upsertByInstagramUserId({
  userId,
  instagramUserId,
  username,
  name,
  profilePictureUrl,
  accountType,
  accessTokenEncrypted,
  tokenExpiresAt,
}) {
  return prisma.instagramAccount.upsert({
    where: { instagramUserId },
    update: {
      username,
      name,
      profilePictureUrl,
      accountType,
      accessTokenEncrypted,
      tokenExpiresAt,
      status: 'ACTIVE',
      lastSyncAt: new Date(),
    },
    create: {
      userId,
      instagramUserId,
      username,
      name,
      profilePictureUrl,
      accountType,
      accessTokenEncrypted,
      tokenExpiresAt,
      lastSyncAt: new Date(),
    },
  });
}

function findAllByUserId(userId) {
  return prisma.instagramAccount.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

function findById(id) {
  return prisma.instagramAccount.findUnique({ where: { id } });
}

function deleteById(id) {
  return prisma.instagramAccount.delete({ where: { id } });
}

module.exports = {
  upsertByInstagramUserId,
  findAllByUserId,
  findById,
  deleteById,
};
