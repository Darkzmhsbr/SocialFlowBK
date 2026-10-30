// Rodada 11: platform admin guard. Use AFTER requireAuth (needs req.user).
// Admins are the e-mails in ADMIN_EMAILS (env.admin.emails).
const env = require('../config/env');
const { AppError, ErrorCodes } = require('../utils/errors');

function isAdminEmail(email) {
  return Boolean(email) && env.admin.emails.includes(String(email).toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!isAdminEmail(req.user?.email)) {
    return next(new AppError(ErrorCodes.FORBIDDEN, 'Acesso restrito ao administrador da plataforma.', 403));
  }
  return next();
}

module.exports = requireAdmin;
module.exports.isAdminEmail = isAdminEmail;