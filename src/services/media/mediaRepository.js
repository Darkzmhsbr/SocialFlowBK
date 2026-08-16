// All Prisma queries for MediaAsset live here. Controllers and services
// never import @prisma/client directly - they call these functions.

const prisma = require('../config/database');

function create({
  userId,
  type,
  cloudinaryPublicId,
  url,
  format,
  bytes,
  width,
  height,
  durationSec,
}) {
  return prisma.mediaAsset.create({
    data: {
      userId,
      type,
      cloudinaryPublicId,
      url,
      format,
      bytes,
      width,
      height,
      durationSec,
    },
  });
}

function findById(id) {
  return prisma.mediaAsset.findUnique({ where: { id } });
}

function findManyByIds(ids) {
  return prisma.mediaAsset.findMany({ where: { id: { in: ids } } });
}

function findAllByUserId(userId, { take = 50, skip = 0 } = {}) {
  return prisma.mediaAsset.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });
}

function deleteById(id) {
  return prisma.mediaAsset.delete({ where: { id } });
}

module.exports = {
  create,
  findById,
  findManyByIds,
  findAllByUserId,
  deleteById,
};