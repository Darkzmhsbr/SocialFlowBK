const authService = require('../services/auth/authService');
const { ok } = require('../utils/apiResponse');

// POST /api/auth/register
// Body: { email, password, name?, inviteCode }
const register = async (req, res) => {
  const { email, password, name, inviteCode } = req.body || {};
  const result = await authService.register({ email, password, name, inviteCode });
  return ok(res, result); // { user, token }
};

// POST /api/auth/login
// Body: { email, password }
const login = async (req, res) => {
  const { email, password } = req.body || {};
  const result = await authService.login({ email, password });
  return ok(res, result); // { user, token }
};

// GET /api/auth/me - requires auth
const me = async (req, res) => {
  const user = await authService.getMe(req.userId);
  return ok(res, { user });
};

// POST /api/auth/logout - stateless on the backend for JWT MVP.
// The client just drops its stored token. Kept here so the frontend has a
// canonical endpoint to call; also gives us a place to plug in token
// blacklisting later without a URL change.
const logout = async (req, res) => {
  return ok(res, { message: 'Logged out.' });
};

module.exports = { register, login, me, logout };