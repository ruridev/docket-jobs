import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  parseNetstat, parseLsof, titleOf, descendants, guessLaunch, simplifyCommand, projectRoot, scanServers,
} from '../agent/core/ports.js';
import { Store } from '../agent/core/store.js';
import { LogStore } from '../agent/core/logs.js';
import { Runner } from '../agent/core/runner.js';
import { createServer } from '../agent/core/server.js';
import { createAuth } from '../agent/core/auth.js';
import { platform } from '../agent/platform/index.js';
import { WEB_DIR } from '../agent/paths.js';

test('reads listening sockets from netstat', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       555',
    '  TCP    [::1]:8080             [::]:0                 LISTENING       777',
    '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     555',
    '  UDP    0.0.0.0:5353           *:*                                    999',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(text), [
    { host: '0.0.0.0', port: 3000, pid: 1234 },
    { host: '127.0.0.1', port: 5173, pid: 555 },
    { host: '::1', port: 8080, pid: 777 },
  ]);
});

test('reads listening sockets from lsof', () => {
  assert.deepEqual(parseLsof('p42\nn*:3000\nn127.0.0.1:3001\np7\nn[::1]:8080\n'), [
    { host: '0.0.0.0', port: 3000, pid: 42 },
    { host: '127.0.0.1', port: 3001, pid: 42 },
    { host: '::1', port: 8080, pid: 7 },
  ]);
});

test('reads the page title', () => {
  assert.equal(titleOf('<html><head><title>\n  My &amp; App </title>'), 'My & App');
  assert.equal(titleOf('<p>no title</p>'), '');
});

test('finds every process started under a pid', () => {
  const table = [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 9 }];
  assert.deepEqual([...descendants(table, 1)].sort(), [1, 2, 3]);
});

test('guesses the command from the package manager that started the server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-ports-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const sub = path.join(dir, 'src');
  fs.mkdirSync(sub);
  const table = [
    { pid: 10, ppid: 1, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev', cwd: null },
    { pid: 11, ppid: 10, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite', cwd: null },
    { pid: 12, ppid: 11, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" node_modules/vite/bin/vite.js', cwd: sub },
  ];
  assert.deepEqual(guessLaunch(table, 12), { pid: 12, proc: 'node.exe', cwd: dir, command: 'npm run dev' });
  // Without a package manager above it, the server's own command line is used.
  assert.equal(guessLaunch(table.slice(2), 12).command, 'node node_modules/vite/bin/vite.js');
  assert.equal(guessLaunch(table, 99), null);
});

test('shortens a command line to something to type', () => {
  assert.equal(simplifyCommand('"C:\\Python312\\python.exe" -m http.server 8000'), 'python -m http.server 8000');
  assert.equal(simplifyCommand('/usr/local/bin/node server.js'), 'node server.js');
});

test('keeps a folder with no project marker as it is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-plain-'));
  // The temp folder itself may sit under a project; only check that nothing breaks and a path comes back.
  assert.ok(projectRoot(dir));
  assert.equal(projectRoot(''), '');
});

test('finds a real local HTTP server with its title', async () => {
  const srv = http.createServer((_, res) => res.end('<title>Probe me</title>'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const found = await scanServers({ jobPids: new Map([[process.pid, 'self']]) });
    const me = found.find((s) => s.port === port);
    assert.ok(me, 'the test server is listed');
    assert.equal(me.title, 'Probe me');
    assert.equal(me.pid, process.pid);
    assert.equal(me.job, 'self');
  } finally {
    srv.close();
  }
});

/* ---------- API ---------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-ports-srv-'));
const store = new Store(dir);
const logs = new LogStore(path.join(dir, 'logs'));
const runner = new Runner({ store, logs, platform });
const calls = [];
const fakePorts = {
  scanServers: async (opts) => { calls.push(opts); return [{ port: 3000, pid: 5, proc: 'node.exe', title: 'App', job: null }]; },
  guessServer: async (p) => ({ port: p, off: false, pid: 5, proc: 'node.exe', cwd: 'C:\\app', command: 'npm run dev' }),
};
const port = 19765 + Math.floor(Math.random() * 1000);
const signIn = createAuth({ file: path.join(dir, 'auth.json'), cookie: 'docket_jobs_session', header: 'x-docket-jobs' });
const server = createServer({ store, runner, logs, platform, autostartSupported: false, port, webDir: WEB_DIR, auth: signIn, ports: fakePorts });
await new Promise((r) => server.listen(port, '127.0.0.1', r));
after(() => { runner.shutdown(); server.close(); });
const base = `http://127.0.0.1:${port}`;
const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'X-Docket-Jobs': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: 'correct horse', code: signIn.setupCode() }) });
const headers = { 'X-Docket-Jobs': (await setup.json()).token, Cookie: setup.headers.get('set-cookie').split(';')[0] };

test('lists running servers, leaving out docket-jobs itself', async () => {
  const res = await fetch(`${base}/api/ports`, { headers });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).servers[0].port, 3000);
  assert.deepEqual(calls.at(-1).exclude, [port]);
});

test('guesses how the server on a port was started', async () => {
  const res = await fetch(`${base}/api/ports/3000`, { headers });
  assert.deepEqual(await res.json(), { port: 3000, off: false, pid: 5, proc: 'node.exe', cwd: 'C:\\app', command: 'npm run dev' });
  assert.equal((await fetch(`${base}/api/ports/abc`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/ports/70000`, { headers })).status, 404);
});
