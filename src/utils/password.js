// Thin wrapper around bcryptjs. Rounds come from env so we can bump the
// cost factor without a code change. hash() and compare() are the only
// two operations the rest of the code needs.

const bcrypt = require('bcryptjs');
const env = require('../config/env');

async function hash(plain) {
  return bcrypt.hash(plain, env.auth.bcryptRounds);
}

async function compare(plain, storedHash) {
  if (!storedHash) return false;
  return bcrypt.compare(plain, storedHash);
}

module.exports = { hash, compare };