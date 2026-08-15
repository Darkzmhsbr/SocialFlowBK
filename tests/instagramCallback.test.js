const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');

test('GET /api/instagram/callback without code/state redirects to dashboard with error status', async () => {
  const response = await request(app).get('/api/instagram/callback');
  assert.strictEqual(response.status, 302);
  const location = new URL(response.headers.location);
  assert.strictEqual(location.pathname, '/dashboard');
  assert.strictEqual(location.searchParams.get('instagram'), 'error');
});

test('GET /api/instagram/callback with error=access_denied redirects with denied status', async () => {
  const response = await request(app).get('/api/instagram/callback?error=access_denied&error_reason=user_denied');
  assert.strictEqual(response.status, 302);
  const location = new URL(response.headers.location);
  assert.strictEqual(location.searchParams.get('instagram'), 'denied');
});

test('GET /api/instagram/connect redirects to Meta authorization URL', async () => {
  const response = await request(app).get('/api/instagram/connect');
  assert.strictEqual(response.status, 302);
  assert.match(response.headers.location, /^https:\/\/api\.instagram\.com\/oauth\/authorize/);
});
