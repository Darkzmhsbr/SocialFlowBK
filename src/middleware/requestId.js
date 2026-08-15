const crypto = require('crypto');

// Tags every request with an ID so a single log line can be traced across
// controller -> service -> integration when debugging an OAuth failure.
function requestId(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

module.exports = requestId;
