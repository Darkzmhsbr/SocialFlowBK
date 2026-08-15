// Wraps an async route handler so a rejected promise is forwarded to
// errorHandler.js via next(err) instead of crashing the process.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
