const { ok } = require('../utils/apiResponse');

function getHealth(req, res) {
  return ok(res, { service: 'socialflow-api', status: 'online' });
}

module.exports = { getHealth };
