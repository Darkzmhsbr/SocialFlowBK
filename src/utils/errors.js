// A single error type carries an HTTP status, a stable machine-readable
// code (used by the frontend and in logs), and a user-safe message.
// Internal details (stack, Meta's raw error) travel separately in `debug`
// and are only ever written to logs, never sent to the client.

class AppError extends Error {
  constructor(code, message, status = 400, debug = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.debug = debug;
  }
}

const ErrorCodes = {
  OAUTH_CANCELLED: 'OAUTH_CANCELLED',
  OAUTH_DENIED: 'OAUTH_DENIED',
  INVALID_CODE: 'INVALID_CODE',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  ACCOUNT_NOT_AUTHORIZED: 'ACCOUNT_NOT_AUTHORIZED',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  ACCOUNT_NOT_PROFESSIONAL: 'ACCOUNT_NOT_PROFESSIONAL',
  META_API_ERROR: 'META_API_ERROR',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  INSTAGRAM_AUTH_FAILED: 'INSTAGRAM_AUTH_FAILED',
};

module.exports = { AppError, ErrorCodes };
