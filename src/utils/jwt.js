// Thin wrapper around jsonwebtoken. Every place that signs or verifies a
// token goes through here so JWT_SECRET stays in one file and the rest of
// the codebase talks in { sign, verify } terms.
//
// Tokens carry { sub: userId, iat, exp } - nothing else. Extra claims
// invite bugs (stale name, stale email) and hurt token size.

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AppError, ErrorCodes } = require('./errors');

function sign(userId) {
  return jwt.sign({ sub: userId }, env.auth.jwtSecret, {
    expiresIn: env.auth.jwtExpiresIn,
  });
}

function verify(token) {
  try {
    const payload = jwt.verify(token, env.auth.jwtSecret);
    if (!payload?.sub) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Token inválido.', 401);
    }
    return { userId: payload.sub };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === 'TokenExpiredError') {
      throw new AppError(ErrorCodes.TOKEN_EXPIRED, 'Sessão expirada, faça login novamente.', 401);
    }
    throw new AppError(ErrorCodes.UNAUTHORIZED, 'Token inválido.', 401);
  }
}

module.exports = { sign, verify };