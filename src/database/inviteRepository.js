// Prisma queries for InviteCode. Codes are stored uppercase to keep
// lookups case-insensitive from the user's perspective (JOAO123 == joao123).

const prisma = require('../config/database');

function findByCode(code) {
  if (!code) return null;
  return prisma.inviteCode.findUnique({ where: { code: normalizeCode(code) } });
}

function create({ code, createdById = null, expiresAt = null, note = null }) {
  return prisma.inviteCode.create({
    data: {
      code: normalizeCode(code),
      createdById,
      expiresAt,
      note,
    },
  });
}

function markUsed(id, usedById) {
  return prisma.inviteCode.update({
    where: { id },
    data: { usedById, usedAt: new Date() },
  });
}

function findAllByCreator(userId) {
  return prisma.inviteCode.findMany({
    where: { createdById: userId },
    orderBy: { createdAt: 'desc' },
    include: {
      usedBy: { select: { id: true, email: true, name: true } },
    },
  });
}

function normalizeCode(code) {
  return String(code).trim().toUpperCase();
}

module.exports = { findByCode, create, markUsed, findAllByCreator, normalizeCode };