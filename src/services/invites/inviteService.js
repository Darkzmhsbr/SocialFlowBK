// Business logic for invite codes. Creating one is trivial; validating one
// is where the interesting checks live (exists, not used, not expired).

const crypto = require('crypto');
const inviteRepository = require('../../database/inviteRepository');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

// Alphabet excludes similar-looking chars (0/O, 1/I/L) so codes stay easy
// to read out loud without confusion.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Create a new invite. `createdById` is optional so the bootstrap setup
 * route can generate the very first invite before any user exists.
 *
 * @param {object} opts
 * @param {string|null} opts.createdById
 * @param {number|null} opts.expiresInDays - null = never expires
 * @param {string|null} opts.note
 */
async function createInvite({ createdById = null, expiresInDays = null, note = null } = {}) {
  const code = generateCode();
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const invite = await inviteRepository.create({
    code,
    createdById,
    expiresAt,
    note,
  });

  logger.info('Invite code created', {
    inviteId: invite.id,
    createdById,
    expiresAt,
  });

  return invite;
}

/**
 * Verify a code without marking it used. Throws if invalid. Used by the
 * auth service during registration so validation errors bubble up before
 * we try to create the user.
 */
async function assertValidCode(code) {
  if (!code) {
    throw new AppError(
      ErrorCodes.INVITE_REQUIRED,
      'Um código de convite é obrigatório para se registrar.',
      403
    );
  }

  const invite = await inviteRepository.findByCode(code);
  if (!invite) {
    throw new AppError(ErrorCodes.INVITE_INVALID, 'Código de convite inválido.', 403);
  }
  if (invite.usedById) {
    throw new AppError(ErrorCodes.INVITE_ALREADY_USED, 'Este código já foi utilizado.', 403);
  }
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    throw new AppError(ErrorCodes.INVITE_EXPIRED, 'Este código de convite expirou.', 403);
  }
  return invite;
}

function markUsed(inviteId, userId) {
  return inviteRepository.markUsed(inviteId, userId);
}

function listByCreator(userId) {
  return inviteRepository.findAllByCreator(userId);
}

function toPublicShape(invite) {
  return {
    id: invite.id,
    code: invite.code,
    note: invite.note,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    usedBy: invite.usedBy
      ? { id: invite.usedBy.id, email: invite.usedBy.email, name: invite.usedBy.name }
      : null,
  };
}

module.exports = {
  createInvite,
  assertValidCode,
  markUsed,
  listByCreator,
  toPublicShape,
};