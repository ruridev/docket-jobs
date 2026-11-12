// Servers already running on this PC: which local ports answer HTTP, which process owns each,
// and a guess at how it was started (folder + command), so a job can be made from it.
// Ports are read from the OS table (netstat / lsof), and each listening local port gets one GET /
// to see whether it is a web server.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const PROCINFO = fileURLToPath(new URL('./procinfo.ps1', import.meta.url));

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

/** Parses `netstat -ano` output into listening sockets. A listening TCP row has a foreign address of *:0. */
export function parseNetstat(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue;
    const [, local, foreign] = cols;
    if (!/^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign)) continue;
    const i = local.lastIndexOf(':');
    const port = Number(local.slice(i + 1));
    const host = local.slice(0, i).replace(/^\[|\]$/g, '');
    const pid = Number(cols[cols.length - 1]);
    if (port && Number.isInteger(pid)) out.push({ host, port, pid });
  }
  return out;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pn` output (macOS / Linux). */
export function parseLsof(text) {
  const out = [];
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const addr = line.slice(1);
      const i = addr.lastIndexOf(':');
      const port = Number(addr.slice(i + 1));
      const host = addr.slice(0, i).replace(/^\[|\]$/g, '');
      if (port && pid) out.push({ host: host === '*' ? '0.0.0.0' : host, port, pid });
    }
  }
  return out;
}

export async function listListening() {
  return IS_WIN
    ? parseNetstat(await run('netstat', ['-ano']))
    : parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']));
}

/** All processes as [{ pid, ppid, name, cmd, cwd }]; cwd is filled only for the pids in withCwd. */
export async function processTable(withCwd = []) {
  if (IS_WIN) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROCINFO, '-All', '-Ids', withCwd.join(',') || '0']);
    try { return JSON.parse(out.trim() || '[]'); } catch { return []; }
  }
  const rows = [];
  // Other users' command lines can hold their secrets, so only this user's are kept
  const me = process.getuid?.();
  for (const line of (await run('ps', ['-axo', 'pid=,ppid=,uid=,comm=,args='])).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[4].split('/').pop(), cmd: Number(m[3]) === me ? m[5] : '', cwd: null });
  }
  for (const r of rows) {
    if (!withCwd.includes(r.pid)) continue;
    const n = (await run('lsof', ['-a', '-p', String(r.pid), '-d', 'cwd', '-Fn'])).split('\n').find((l) => l.startsWith('n'));
    if (n) r.cwd = n.slice(1);
  }
  return rows;
}

/** pid and every process started under it. */
export function descendants(table, pid) {
  const kids = new Map();
  for (const p of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const seen = new Set([pid]);
  const stack = [pid];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) || []) {
      if (!seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return seen;
}

/** Answers whether an HTTP server answers at url (any status counts), with the start of the page. */
export function probe(url, timeout = 900) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout, headers: { accept: 'text/html,*/*' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) res.destroy(); });
      const done = () => resolve({ ok: true, body });
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
  });
}

export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  if (!m) return '';
  return m[1].replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e])
    .replace(/\s+/g, ' ').trim().slice(0, 100);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/**
 * Local ports that answer HTTP, with the owning process and page title.
 * jobPids maps a running job's pid to its name; a server started by that job is marked with it.
 */
export async function scanServers({ exclude = [], jobPids = new Map() } = {}) {
  const [rows, table] = await Promise.all([listListening(), processTable()]);
  const byPort = new Map();
  for (const r of rows) {
    if (exclude.includes(r.port) || byPort.has(r.port)) continue;
    if (!/^(0\.0\.0\.0|127\.0\.0\.1|::|::1)$/.test(r.host)) continue; // reachable from this PC
    byPort.set(r.port, r);
  }
  const names = new Map(table.map((p) => [p.pid, p.name]));
  const owner = new Map();
  for (const [pid, name] of jobPids) for (const d of descendants(table, pid)) owner.set(d, name);

  const list = [...byPort.values()].sort((a, b) => a.port - b.port);
  const found = await pool(list, 24, async (r) => {
    const res = await probe(`http://${r.host === '::1' ? '[::1]' : '127.0.0.1'}:${r.port}/`);
    if (!res.ok) return null;
    return { port: r.port, pid: r.pid, proc: names.get(r.pid) || '', title: titleOf(res.body), job: owner.get(r.pid) || null };
  });
  return found.filter(Boolean);
}

/** The nearest folder at or above dir that looks like a project root. */
export function projectRoot(dir) {
  if (!dir) return '';
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    for (const marker of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', '.git']) {
      if (fs.existsSync(path.join(cur, marker))) return cur;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(dir);
}

const RUNNERS = [
  [/npm-cli\.js"?\s+(.+)$/i, 'npm'],
  [/npx-cli\.js"?\s+(.+)$/i, 'npx'],
  [/yarn(?:\.js|\.cjs)?"?\s+(.+)$/i, 'yarn'],
  [/pnpm(?:\.cjs|\.js)?"?\s+(.+)$/i, 'pnpm'],
  [/(?:^|[\\/"])bun(?:\.exe)?"?\s+(.+)$/i, 'bun'],
];

/** Turns a raw command line into something to type: `"C:\...\node.exe" a.js` -> `node a.js`. */
export function simplifyCommand(cmd) {
  const s = String(cmd || '').trim();
  const m = /^("([^"]+)"|(\S+))\s*(.*)$/.exec(s);
  if (!m) return s;
  const exe = path.win32.basename(path.posix.basename(m[2] || m[3])).replace(/\.exe$/i, '');
  return `${exe}${m[4] ? ' ' + m[4] : ''}`.trim();
}

/**
 * Guesses how a running server was started: its project folder and command.
 * Walks up from the process to the package manager that launched it (npm/yarn/pnpm/bun).
 */
export function guessLaunch(table, pid) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const self = byPid.get(pid);
  if (!self) return null;
  let command = '';
  let p = self;
  for (let i = 0; i < 5 && p && !command; i++) {
    for (const [re, name] of RUNNERS) {
      const m = re.exec(p.cmd || '');
      if (m) { command = `${name} ${m[1].trim()}`; break; }
    }
    p = byPid.get(p.ppid);
  }
  if (!command) command = simplifyCommand(self.cmd);
  return { pid, proc: self.name || '', cwd: projectRoot(self.cwd || ''), command };
}

/** How the server on port was started, or { off: true } when nothing listens there anymore. */
export async function guessServer(port) {
  const row = (await listListening()).find((r) => r.port === port);
  if (!row) return { port, off: true };
  const g = guessLaunch(await processTable([row.pid]), row.pid);
  return { port, off: false, pid: row.pid, proc: g?.proc || '', cwd: g?.cwd || '', command: g?.command || '' };
}
