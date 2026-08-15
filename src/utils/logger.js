// Minimal structured logger. Swap this for pino/winston later without
// touching any call site - everything goes through log.info/error/etc.
//
// Hard rule: never pass access tokens, App Secret, or passwords into `meta`.
// Callers are responsible for that; this module just formats/prints.

const REDACTED_KEYS = ['accessToken', 'access_token', 'appSecret', 'app_secret', 'password', 'token'];

function sanitize(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const clean = { ...meta };
  for (const key of Object.keys(clean)) {
    if (REDACTED_KEYS.includes(key)) {
      clean[key] = '[REDACTED]';
    }
  }
  return clean;
}

function write(level, message, meta) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(meta ? sanitize(meta) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
