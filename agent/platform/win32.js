import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_ENTRY } from '../paths.js';

const LAUNCHER = fileURLToPath(new URL('./win-launcher.js', import.meta.url));

/**
 * Starts a job detached (outside the agent's job object, so it survives an agent restart)
 * through win-launcher.js; see that file for why. The returned pid is the launcher's;
 * killTree() takes the whole tree down from there.
 */
export function spawnJob(command, { cwd, hidden, stdio }) {
  return spawn(process.execPath, [LAUNCHER], {
    cwd,
    detached: true,
    windowsHide: true,
    stdio,
    env: { ...process.env, BJOBS_COMMAND: command, BJOBS_HIDE: hidden ? '1' : '0' },
  });
}

// HKCU Run works without admin rights, unlike a logon task in Task Scheduler.
const RUN_KEY = process.env.BJOBS_RUN_KEY || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = process.env.BJOBS_AUTOSTART_NAME || 'b_jobs';

function reg(args) {
  return spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' });
}

export function autostartCommand() {
  // conhost --headless runs node without any console window.
  const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
  return `"${conhost}" --headless "${process.execPath}" "${AGENT_ENTRY}"`;
}

export function isAutostartEnabled() {
  return reg(['query', RUN_KEY, '/v', VALUE_NAME]).status === 0;
}

export function enableAutostart() {
  const res = reg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', autostartCommand(), '/f']);
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'reg add failed').trim());
}

export function disableAutostart() {
  if (!isAutostartEnabled()) return;
  const res = reg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'reg delete failed').trim());
}

export function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const CODEPAGES = { 949: 'euc-kr', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 1252: 'windows-1252', 65001: 'utf-8' };

/** Console programs write in the OEM code page; decode UTF-8 first, then fall back to it. */
export function outputDecoder() {
  let fallback = null;
  try {
    const out = spawnSync('cmd', ['/d', '/c', 'chcp'], { windowsHide: true, encoding: 'latin1' }).stdout || '';
    const cp = Number((out.match(/(\d+)\s*$/) || [])[1]);
    if (CODEPAGES[cp] && CODEPAGES[cp] !== 'utf-8') fallback = new TextDecoder(CODEPAGES[cp]);
  } catch { /* keep utf-8 only */ }
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const lenient = new TextDecoder('utf-8');
  return (buf) => {
    try { return utf8.decode(buf); } catch { return (fallback || lenient).decode(buf); }
  };
}

/* ---------- other programs' startup items ---------- */

const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
const STARTUP_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
let decode = null;

/** Parses `reg query <key>` output into [{ name, type, value }]. */
export function parseRegQuery(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/) || line.match(/^ {4}(.+?) {4}(REG_[A-Z_]+)$/);
    if (m) out.push({ name: m[1], type: m[2], value: m[3] ?? '' });
  }
  return out;
}

function regValues(key) {
  const res = spawnSync('reg', ['query', key], { windowsHide: true });
  if (res.status !== 0) return [];
  decode ||= outputDecoder();
  return parseRegQuery(decode(res.stdout));
}

/** Names that Task Manager's Startup tab has switched off (odd first byte). */
function disabledByTaskManager(sub) {
  const off = new Set();
  for (const v of regValues(`${APPROVED_KEY}\\${sub}`)) {
    if (v.type === 'REG_BINARY' && (Number.parseInt(v.value.slice(0, 2), 16) & 1) === 1) off.add(v.name);
  }
  return off;
}

/**
 * Startup items b_jobs can take over without admin rights: the user's Run key and
 * Startup folder. Items already disabled in Task Manager are left out.
 */
export function scanStartup() {
  const items = [];
  const runOff = disabledByTaskManager('Run');
  for (const v of regValues(RUN_KEY)) {
    if (v.name === VALUE_NAME || runOff.has(v.name)) continue;
    if (v.type !== 'REG_SZ' && v.type !== 'REG_EXPAND_SZ') continue;
    items.push({ key: `run:${v.name}`, name: v.name, source: 'run', command: v.value, data: v });
  }
  const folderOff = disabledByTaskManager('StartupFolder');
  let files = [];
  try { files = fs.readdirSync(STARTUP_DIR); } catch { /* no folder */ }
  for (const file of files) {
    if (file.toLowerCase() === 'desktop.ini' || folderOff.has(file)) continue;
    const full = path.join(STARTUP_DIR, file);
    if (!fs.statSync(full).isFile()) continue;
    items.push({
      key: `folder:${file}`, name: path.parse(file).name, source: 'folder',
      command: `start "" "${full}"`, data: { file: full },
    });
  }
  return { items, notes: [] };
}

/** Turns the original entry off and returns what is needed to put it back. */
export function disableStartupItem(item, backupDir) {
  if (item.source === 'run') {
    const { name, type, value } = item.data;
    const res = reg(['delete', RUN_KEY, '/v', name, '/f']);
    if (res.status !== 0) throw new Error((res.stderr || 'reg delete failed').trim());
    return { kind: 'run', name, type, value };
  }
  if (item.source === 'folder') {
    fs.mkdirSync(backupDir, { recursive: true });
    let dest = path.join(backupDir, path.basename(item.data.file));
    if (fs.existsSync(dest)) dest = path.join(backupDir, `${Date.now()}-${path.basename(item.data.file)}`);
    fs.renameSync(item.data.file, dest);
    return { kind: 'folder', from: item.data.file, to: dest };
  }
  throw new Error(`unknown source ${item.source}`);
}

export function restoreStartupItem(backup) {
  if (backup.kind === 'run') {
    const res = reg(['add', RUN_KEY, '/v', backup.name, '/t', backup.type, '/d', backup.value, '/f']);
    if (res.status !== 0) throw new Error((res.stderr || 'reg add failed').trim());
    return;
  }
  if (backup.kind === 'folder') {
    if (fs.existsSync(backup.from)) throw new Error('A file with the same name is already there');
    fs.mkdirSync(path.dirname(backup.from), { recursive: true });
    fs.renameSync(backup.to, backup.from);
    return;
  }
  throw new Error(`unknown backup ${backup.kind}`);
}
