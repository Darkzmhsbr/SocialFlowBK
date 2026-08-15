const { AppError, ErrorCodes } = require('../utils/errors');
const { fail } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// Every route handler in this project either throws an AppError or lets an
// unexpected exception bubble up - both land here. The response to the
// client is always sanitized; full detail (Meta error codes, stack traces)
// only goes to the log.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isAppError = err instanceof AppError;

  logger.error('Request failed', {
    requestId: req.requestId,
    endpoint: `${req.method} ${req.originalUrl}`,
    code: isAppError ? err.code : ErrorCodes.INTERNAL_ERROR,
    message: err.message,
    debug: isAppError ? err.debug : undefined,
    stack: err.stack,
  });

  if (isAppError) {
    return fail(res, { status: err.status, code: err.code, message: err.message });
  }

  return fail(res, {
    status: 500,
    code: ErrorCodes.INTERNAL_ERROR,
    message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
  });
}

module.exports = errorHandler;
