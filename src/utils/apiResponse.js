// Keeps every endpoint responding with the same shape, so the frontend
// never has to guess whether it's dealing with success or error payloads.

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, ...data });
}

function fail(res, { status = 500, code = 'INTERNAL_ERROR', message = 'Unexpected error.' }) {
  return res.status(status).json({
    success: false,
    error: { code, message },
  });
}

module.exports = { ok, fail };
