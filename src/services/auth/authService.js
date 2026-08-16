// Business logic for authentication. Handles register (with invite),
// login (email + password), and "who am I" lookups. Never returns
// passwordHash to any caller - toPublicShape sanitizes.

const prisma = require('../../config/database');
const userRepository = require('../../database/userRepository');
const inviteRepository = require('../../database/inviteRepository');
const inviteService = require('../invites/inviteService');
const password = require('../../utils/password');
const jwt = require('../../utils/jwt');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const MIN_PASSWORD_LENGTH = 8;

/**
 * Register a new account. Requires a valid, unused, unexpired invite code.
 * All writes happen in a transaction so a mid-flight failure (say, the DB
 * hiccups after creating the user) doesn't leave an orphan account without
 * the invite consumed.
 *
 * @param {object} args
 * @param {string} args.email
 * @param {string} args.password
 * @param {string} [args.name]
 * @param {string} args.inviteCode
 * @returns {Promise<{ user, token }>}
 */
async function register({ email, password: plainPassword, name, inviteCode }) {
  assertValidEmail(email);
  assertStrongPassword(plainPassword);

  // Verify invite up-front so we fail fast without hashing the password
  // for a request that was never going to succeed.
  const invite = await inviteService.assertValidCode(inviteCode);

  const existing = await userRepository.findByEmail(email);
  if (existing) {
    throw new AppError(
      ErrorCodes.EMAIL_ALREADY_REGISTERED,
      'Esse email já está cadastrado. Faça login ou use outro.',
      409
    );
  }

  const passwordHash = await password.hash(plainPassword);

  // Both writes in one transaction. If markUsed fails, the user creation
  // rolls back and the invite is still available for retry.
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: userRepository.normalizeEmail(email),
        passwordHash,
        name: name || null,
      },
    });

    await tx.inviteCode.update({
      where: { id: invite.id },
      data: { usedById: created.id, usedAt: new Date() },
    });

    return created;
  });

  const token = jwt.sign(user.id);
  logger.info('User registered', { userId: user.id, email: user.email });

  return { user: toPublicShape(user), token };
}

/**
 * Login with email + password. Returns a fresh JWT on success.
 * Uses the same generic error for "user not found" and "bad password" so
 * an attacker can't probe which emails are registered.
 */
async function login({ email, password: plainPassword }) {
  if (!email || !plainPassword) {
    throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Email ou senha inválidos.', 401);
  }

  const user = await userRepository.findByEmail(email);
  if (!user || !user.passwordHash) {
    // Uses the same message on purpose - see above.
    throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Email ou senha inválidos.', 401);
  }

  const ok = await password.compare(plainPassword, user.passwordHash);
  if (!ok) {
    throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Email ou senha inválidos.', 401);
  }

  const token = jwt.sign(user.id);
  logger.info('User logged in', { userId: user.id });

  return { user: toPublicShape(user), token };
}

async function getMe(userId) {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'Usuário não encontrado.', 404);
  }
  return toPublicShape(user);
}

// --- validators ---

function assertValidEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Email é obrigatório.', 400);
  }
  // Deliberately loose regex - real validation happens by "can we send an
  // email to it later". A stricter regex just excludes valid addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Email inválido.', 400);
  }
}

function assertStrongPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      ErrorCodes.WEAK_PASSWORD,
      `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      400
    );
  }
}

function toPublicShape(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

module.exports = { register, login, getMe, toPublicShape };