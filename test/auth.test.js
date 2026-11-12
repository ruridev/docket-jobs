// Sign-in: account setup, signed session cookies, wrong passwords and the reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../agent/core/auth.js';

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-auth-')), 'auth.json');
  return { file, auth: createAuth({ file, cookie: 'sid', header: 'x-token' }) };
}
// Just enough of a response to collect the Set-Cookie header.
const fakeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } });
const req = (method, cookie = '', token) => ({ method, headers: { cookie, ...(token !== undefined && { 'x-token': token }) } });
const cookieOf = (res) => res.headers['set-cookie'].split(';')[0];

// Setup gets the right setup code unless the test passes its own.
async function call(auth, pathname, body, cookie) {
  const res = fakeRes();
  const sent = pathname === '/api/auth/setup' && body && !('code' in body) ? { ...body, code: auth.setupCode() } : body;
  const r = await auth.route(req(body ? 'POST' : 'GET', cookie), res, pathname, async () => sent);
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

test('parallel wrong passwords cannot get past the lock', async () => {
  const { auth } = fresh();
  await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough' });
  const tries = await Promise.all(Array.from({ length: 20 }, () => call(auth, '/api/auth/login', { name: 'alice', password: 'wrong one' })));
  assert.ok(tries.filter((r) => r.status === 401).length <= 5);
  assert.ok(tries.filter((r) => r.status === 429).length >= 15);
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

test('setup needs the setup code from the data folder, which goes away once the account exists', async () => {
  const { auth, file } = fresh();
  const code = auth.setupCode();
  assert.match(code, /^[0-9a-f]{12}$/);
  assert.equal(auth.setupCode(), code, 'the code stays the same until it is used');
  const codeFile = path.join(path.dirname(file), 'setup-code');
  if (process.platform !== 'win32') assert.equal(fs.statSync(codeFile).mode & 0o777, 0o600);
  for (const wrong of [undefined, '', 'nope', code.slice(1)]) {
    assert.equal((await call(auth, '/api/auth/setup', { name: 'mallory', password: 'long enough', code: wrong })).status, 403, String(wrong));
  }
  assert.equal(auth.hasAccount(), false);
  assert.equal((await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough', code: ` ${code.toUpperCase()} ` })).status, 200);
  assert.equal(fs.existsSync(codeFile), false);
});

test('the API needs the token that came with the cookie, not the cookie alone', async () => {
  const { auth } = fresh();
  const ok = await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough' });
  const cookie = cookieOf(ok.res);
  assert.match(ok.body.token, /^[\w-]{20,}$/);
  assert.equal(auth.apiUser(req('GET', cookie, ok.body.token)), 'alice');
  for (const bad of [undefined, '', '1', ok.body.token.slice(1)]) assert.equal(auth.apiUser(req('GET', cookie, bad)), null, String(bad));
  assert.equal(auth.apiUser(req('GET', '', ok.body.token)), null);
  // A new sign-in gets its own token; the old token does not fit the new cookie
  const again = await call(auth, '/api/auth/login', { name: 'alice', password: 'long enough' });
  assert.equal(auth.apiUser(req('GET', cookieOf(again.res), again.body.token)), 'alice');
  if (cookieOf(again.res) !== cookie) assert.equal(auth.apiUser(req('GET', cookieOf(again.res), ok.body.token)), null);
});

test('signing out with the token ends every session; without it only the cookie is dropped', async () => {
  const { auth } = fresh();
  const ok = await call(auth, '/api/auth/setup', { name: 'alice', password: 'long enough' });
  const other = await call(auth, '/api/auth/login', { name: 'alice', password: 'long enough' });
  const res = fakeRes();
  // A replayed cookie without the token cannot sign anyone out
  await auth.route(req('POST', cookieOf(ok.res)), res, '/api/auth/logout', async () => ({}));
  assert.equal(auth.apiUser(req('GET', cookieOf(ok.res), ok.body.token)), 'alice');
  await new Promise((r) => setTimeout(r, 5));
  await auth.route(req('POST', cookieOf(ok.res), ok.body.token), fakeRes(), '/api/auth/logout', async () => ({}));
  assert.equal(auth.user(req('GET', cookieOf(ok.res))), null);
  assert.equal(auth.user(req('GET', cookieOf(other.res))), null, 'the other browser is signed out too');
  await new Promise((r) => setTimeout(r, 5));
  const again = await call(auth, '/api/auth/login', { name: 'alice', password: 'long enough' });
  assert.equal(auth.apiUser(req('GET', cookieOf(again.res), again.body.token)), 'alice');
});
