// Auth middleware. Rejects requests without a valid Bearer token, and
// injects req.userId + req.user for downstream handlers when authenticated.
//
// Not attached to any existing route in Phase 3.1 - only auth's own /me
// endpoint uses it. Phase 3.3 will apply it globally to /api/instagram,
// /api/media, /api/posts, /api/dashboard once the composer no longer
// relies on env.defaultUserId.

const jwt = require('../utils/jwt');
const userRepository = require('../database/userRepository');
const { AppError, ErrorCodes } = require('../utils/errors');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Sessão não encontrada.', 401);
    }

    const token = match[1].trim();
    const { userId } = jwt.verify(token); // throws AppError on invalid/expired

    // Optional but cheap: confirm the user still exists. Handles cases
    // where the account was deleted but a valid-looking token remained.
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new AppError(ErrorCodes.UNAUTHORIZED, 'Usuário não encontrado.', 401);
    }

    req.userId = user.id;
    req.user = { id: user.id, email: user.email, name: user.name };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAuth;