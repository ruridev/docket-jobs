import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../agent/core/store.js';
import { LogStore } from '../agent/core/logs.js';
import { Runner } from '../agent/core/runner.js';
import { createServer } from '../agent/core/server.js';
import { platform } from '../agent/platform/index.js';
import { WEB_DIR } from '../agent/paths.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-srv-'));
const store = new Store(dir);
const logs = new LogStore(path.join(dir, 'logs'));
const runner = new Runner({ store, logs, platform });
// autostartSupported: false keeps the test away from the real login items.
const port = 18765 + Math.floor(Math.random() * 1000);
const server = createServer({ store, runner, logs, platform, autostartSupported: false, port, webDir: WEB_DIR });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
after(() => { runner.shutdown(); server.close(); });

const base = `http://127.0.0.1:${port}`;
const json = { 'Content-Type': 'application/json', 'X-Docket-Jobs': '1' };

test('serves the UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>docket-jobs<\/title>/);
});

test('lets only local pages frame the UI', async () => {
  const res = await fetch(`${base}/`);
  const fa = /frame-ancestors([^;]*)/.exec(res.headers.get('content-security-policy'))[1].trim();
  assert.equal(fa, 'http://localhost:* http://127.0.0.1:*');
  assert.equal(res.headers.get('x-frame-options'), null);
});

test('rejects changes without the X-Docket-Jobs header', async () => {
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"a","command":"b"}' });
  assert.equal(res.status, 403);
  assert.equal(store.jobs.length, 0);
});

test('rejects changes from another origin', async () => {
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{"name":"a","command":"b"}' });
  assert.equal(res.status, 403);
});

test('rejects a foreign Host header', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode));
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

  res = await fetch(`${base}/api/state`);
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
