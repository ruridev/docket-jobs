// Sign-in: account setup, signed session cookies, wrong passwords and the reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../agent/core/auth.js';

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-auth-')), 'auth.json');
  return { file, auth: createAuth({ file, cookie: 'sid' }) };
}
// Just enough of a response to collect the Set-Cookie header.
const fakeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } });
const req = (method, cookie = '') => ({ method, headers: { cookie } });
const cookieOf = (res) => res.headers['set-cookie'].split(';')[0];

async function call(auth, pathname, body, cookie) {
  const res = fakeRes();
  const r = await auth.route(req(body ? 'POST' : 'GET', cookie), res, pathname, async () => body);
  return { ...r, res };
}

test('setup creates the one account; a second setup is refused', async () => {
  const { auth, file } = fresh();
  assert.deepEqual((await call(auth, '/api/auth')).body, { account: false, user: null });
  assert.equal((await call(auth, '/api/auth/setup', { name: 'alice', password: 'short' })).body.error, 'password');
  assert.equal((await call(auth, '/api/auth/setup', { name: ' ', password: 'long enough' })).body.error, 'name');
  const ok = await call(auth, '/api/auth/setup', { name: ' alice ', password: 'long enough' });
  assert.equal(ok.status, 200);
  assert.match(ok.res.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.equal(auth.user(req('GET', cookieOf(ok.res))), 'alice');
  assert.equal((await call(auth, '/api/auth/setup', { name: 'mallory', password: 'long enough' })).status, 409);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.name, 'alice');
  assert.ok(!JSON.stringify(saved).includes('long enough'), 'the password is not stored');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a forged, tampered or expired cookie is not a session', async () => {
  const { auth } = fresh();
  const ok = await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough' });
  const [name, value] = cookieOf(ok.res).split('=');
  const [who, exp, sig] = value.split('.');
  const bad = [
    '',
    `${name}=${who}.${exp}.${'A'.repeat(sig.length)}`,
    `${name}=${who}.${Number(exp) + 1000}.${sig}`,
    `${name}=${Buffer.from('mallory').toString('base64url')}.${exp}.${sig}`,
    `${name}=garbage`,
    `other=${value}`,
  ];
  for (const c of bad) assert.equal(auth.user(req('GET', c)), null, c);
});

test('wrong passwords fail, then make you wait', async () => {
  const { auth } = fresh();
  await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough' });
  assert.equal((await call(auth, '/api/auth/login', { name: 'alice', password: 'long enough' })).status, 200);
  assert.equal((await call(auth, '/api/auth/login', { name: 'bob', password: 'long enough' })).status, 401);
  for (let i = 0; i < 4; i += 1) assert.equal((await call(auth, '/api/auth/login', { name: 'alice', password: 'wrong one' })).status, 401);
  const locked = await call(auth, '/api/auth/login', { name: 'alice', password: 'long enough' });
  assert.equal(locked.status, 429);
  assert.ok(locked.body.seconds >= 1);
});

test('logout clears the cookie; reset removes the account even for a running server', async () => {
  const { auth } = fresh();
  const ok = await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough' });
  const out = await call(auth, '/api/auth/logout', {});
  assert.match(out.res.headers['set-cookie'], /Max-Age=0/);
  assert.equal(auth.reset(), true);
  assert.equal(auth.user(req('GET', cookieOf(ok.res))), null);
  assert.deepEqual((await call(auth, '/api/auth')).body, { account: false, user: null });
  assert.equal((await call(auth, '/api/auth/setup', { name: 'alice', password: 'new password' })).status, 200);
  assert.equal(auth.reset(), true);
  assert.equal(auth.reset(), false);
});
