// Encrypts Instagram access tokens before they touch the database.
// Algorithm: AES-256-GCM (authenticated encryption - tamper-evident, not just obfuscated).
//
// TOKEN_ENCRYPTION_KEY must be a 32-byte key, provided as a 64-char hex string.
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

function getKey() {
  const key = env.tokenEncryptionKey;
  if (!key) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  }
  const buffer = Buffer.from(key, 'hex');
  if (buffer.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters)');
  }
  return buffer;
}

/**
 * @param {string} plainText - raw access token
 * @returns {string} iv:authTag:ciphertext, all hex-encoded, joined with ':'
 */
function encryptToken(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * @param {string} payload - value produced by encryptToken
 * @returns {string} the original plain text token
 */
function decryptToken(payload) {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Invalid encrypted token payload');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
