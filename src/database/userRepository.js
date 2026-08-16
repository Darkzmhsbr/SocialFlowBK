// All Prisma queries for User live here. Passwords always come in already
// hashed - this file never touches plaintext.

const prisma = require('../config/database');

function findById(id) {
  return prisma.user.findUnique({ where: { id } });
}

function findByEmail(email) {
  if (!email) return null;
  return prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
}

function createWithPassword({ email, passwordHash, name }) {
  return prisma.user.create({
    data: {
      email: normalizeEmail(email),
      passwordHash,
      name: name || null,
    },
  });
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

module.exports = { findById, findByEmail, createWithPassword, normalizeEmail };