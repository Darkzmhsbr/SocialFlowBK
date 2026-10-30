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
  metaAppCredentialId = null, // Rodada 10
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
      // Rodada 5: reconnecting clears any pause / error. Posts that were
      // waiting in the queue resume automatically (spaced by the minimum
      // gap between publishes).
      publishPausedUntil: null,
      pauseReason: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      lastHealthCheckAt: new Date(),
      // Rodada 10: reconnecting through another app switches the profile to it
      metaAppCredentialId,
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
      metaAppCredentialId, // Rodada 10
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