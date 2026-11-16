import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = 'http://127.0.0.1:4100';

let server;

test.before(async () => {
  const { createServer } = await import('./simple-auth-server.js');
  server = createServer();
  await new Promise((resolve) => server.once('listening', resolve));
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test('simple auth accepts valid login and rejects invalid credentials', async () => {
  const validResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123' }),
  });

  assert.equal(validResponse.status, 200);

  const validBody = await validResponse.json();
  assert.equal(validBody.user.username, 'admin');
  assert.ok(validBody.token);

  const invalidResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
  });

  assert.equal(invalidResponse.status, 401);
});
