const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');

test('GET /api/health returns online status', async () => {
  const response = await request(app).get('/api/health');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.success, true);
  assert.strictEqual(response.body.status, 'online');
  assert.strictEqual(response.body.service, 'socialflow-api');
});
