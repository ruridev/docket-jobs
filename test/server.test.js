import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../agent/core/store.js';
import { LogStore } from '../agent/core/logs.js';
import { Runner } from '../agent/core/runner.js';
import { createServer } from '../agent/core/server.js';
import { createAuth } from '../agent/core/auth.js';
import { platform } from '../agent/platform/index.js';
import { WEB_DIR } from '../agent/paths.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-srv-'));
const store = new Store(dir);
const logs = new LogStore(path.join(dir, 'logs'));
const runner = new Runner({ store, logs, platform });
// autostartSupported: false keeps the test away from the real login items.
const port = 18765 + Math.floor(Math.random() * 1000);
const signIn = createAuth({ file: path.join(dir, 'auth.json'), cookie: 'docket_jobs_session' });
const server = createServer({ store, runner, logs, platform, autostartSupported: false, port, webDir: WEB_DIR, auth: signIn });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
after(() => { runner.shutdown(); server.close(); });

const base = `http://127.0.0.1:${port}`;
const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'X-Docket-Jobs': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: 'correct horse' }) });
const session = setup.headers.get('set-cookie').split(';')[0];
const auth = { 'X-Docket-Jobs': '1', Cookie: session };
const json = { 'Content-Type': 'application/json', ...auth };

test('serves the UI when signed in, and the sign-in page when not', async () => {
  const res = await fetch(`${base}/`, { headers: { Cookie: session } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>docket-jobs<\/title>/);
  assert.match(html, /app\.js/);
  assert.match(await (await fetch(`${base}/`)).text(), /login\.js/);
});

test('signed out, the API answers 401; the account cannot be created twice', async () => {
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'X-Docket-Jobs': '1' } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'X-Docket-Jobs': '1', Cookie: 'docket_jobs_session=YWxpY2U.9999999999999.forged' } })).status, 401);
  const again = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'X-Docket-Jobs': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mallory', password: 'something long' }) });
  assert.equal(again.status, 409);
});

test('lets only the docket portal frame the UI', async () => {
  const res = await fetch(`${base}/`);
  const fa = /frame-ancestors([^;]*)/.exec(res.headers.get('content-security-policy'))[1].trim();
  assert.equal(fa, "'self' http://localhost:4600 http://127.0.0.1:4600");
  assert.equal(res.headers.get('x-frame-options'), null);
});

test('rejects changes without the X-Docket-Jobs header', async () => {
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"a","command":"b"}' });
  assert.equal(res.status, 403);
  assert.equal(store.jobs.length, 0);
});

test('rejects reads without the X-Docket-Jobs header', async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 403);
});

test('accepts API requests with the X-Docket-Jobs header and the session', async () => {
  assert.equal((await fetch(`${base}/api/state`, { headers: auth })).status, 200);
});

test('rejects changes from another origin', async () => {
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{"name":"a","command":"b"}' });
  assert.equal(res.status, 403);
});

test('rejects a foreign Host header', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { ...auth, Host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test('creates, edits and deletes a job', async () => {
  let res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'demo', command: 'echo hi' }) });
  assert.equal(res.status, 201);
  const { job } = await res.json();

  res = await fetch(`${base}/api/jobs/${job.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ enabled: false }) });
  assert.equal((await res.json()).job.enabled, false);

  res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: json, body: JSON.stringify({ name: '' , command: 'x' }) });
  assert.equal(res.status, 400);

  res = await fetch(`${base}/api/state`, { headers: auth });
  const state = await res.json();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.settings.autoStartSupported, false);

  res = await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE', headers: json });
  assert.equal(res.status, 200);
  assert.equal(store.jobs.length, 0);
});

test('server settings hold only autostart; language and theme live in the browser', async () => {
  const res = await fetch(`${base}/api/settings`, { method: 'PUT', headers: json, body: JSON.stringify({ lang: 'ja', theme: 'g6' }) });
  assert.deepEqual((await res.json()).settings, { autoStart: false, autoStartSupported: false });
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
});

test('serves the theme script and pixel font', async () => {
  assert.equal((await fetch(`${base}/theme.js`)).status, 200);
  assert.equal((await fetch(`${base}/fonts/pixel.ttf`)).headers.get('content-type'), 'font/ttf');
});

test('the frame-ancestors list can be changed with DOCKET_FRAME_ANCESTORS', async () => {
  process.env.DOCKET_FRAME_ANCESTORS = 'http://localhost:9999';
  const p = port + 1000;
  const srv = createServer({ store, runner, logs, platform, autostartSupported: false, port: p, webDir: WEB_DIR, auth: signIn });
  delete process.env.DOCKET_FRAME_ANCESTORS;
  await new Promise((r) => srv.listen(p, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${p}/`);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors http:\/\/localhost:9999$/);
  } finally {
    srv.close();
  }
});

test('the data folder and its files are owner-only', { skip: process.platform === 'win32' && 'POSIX modes only' }, async () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-data-')), 'data');
  fs.mkdirSync(d, { mode: 0o755 });
  new Store(d).saveJobs();
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(d, 'jobs.json')).mode & 0o777, 0o600);
});
