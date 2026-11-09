import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { AGENT_ENTRY, LOG_DIR, ROOT } from '../paths.js';

/** Own process group (detached), so it survives an agent restart and killTree reaches all of it. */
export function spawnJob(command, { cwd, stdio }) {
  return spawn(command, [], { cwd, shell: true, detached: true, stdio, env: process.env });
}

const LABEL = process.env.BJOBS_AUTOSTART_NAME || 'com.ruridev.bjobs';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plistPath() {
  return PLIST;
}

export function plistContent() {
  const agentLog = path.join(LOG_DIR, 'agent.log');
  // launchd starts with a minimal PATH; keep the one from install time so node/npm/python resolve.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(AGENT_ENTRY)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(agentLog)}</string>
  <key>StandardErrorPath</key><string>${xml(agentLog)}</string>
</dict>
</plist>
`;
}

export function isAutostartEnabled() {
  return fs.existsSync(PLIST);
}

/** Takes effect at the next login; the running agent is left alone. */
export function enableAutostart() {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST, plistContent());
}

export function disableAutostart() {
  try { fs.unlinkSync(PLIST); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/* ---------- other programs' startup items ---------- */

const USER_AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');

function shq(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function jxa(script, args = [], timeout = 30000) {
  // The first call may show macOS's "allow to control System Events" prompt, hence the long timeout.
  return run('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout });
}

async function disabledLabels() {
  const off = new Set();
  try {
    const { stdout } = await run('launchctl', ['print-disabled', `gui/${process.getuid()}`]);
    for (const m of stdout.matchAll(/"([^"]+)"\s*=>\s*(\w+)/g)) {
      if (m[2] === 'disabled' || m[2] === 'true') off.add(m[1]);
    }
  } catch { /* treat all as enabled */ }
  return off;
}

async function scanLaunchAgents() {
  const items = [];
  let files = [];
  try { files = fs.readdirSync(USER_AGENTS).filter((f) => f.endsWith('.plist')); } catch { return items; }
  const off = await disabledLabels();
  for (const file of files) {
    const full = path.join(USER_AGENTS, file);
    if (full === PLIST) continue;
    let p;
    try { p = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', full])).stdout); } catch { continue; }
    if (p.Disabled || off.has(p.Label) || !(p.RunAtLoad || p.KeepAlive)) continue;
    const argv = Array.isArray(p.ProgramArguments) && p.ProgramArguments.length ? p.ProgramArguments : p.Program ? [p.Program] : null;
    if (!argv) continue;
    items.push({
      key: `agent:${file}`, name: p.Label || path.parse(file).name, source: 'agent',
      command: argv.map(shq).join(' '), cwd: p.WorkingDirectory || '', data: { file: full },
    });
  }
  return items;
}

async function scanLoginItems() {
  const script = 'function run(){const se=Application("System Events");return JSON.stringify(se.loginItems().map(i=>({name:i.name(),path:i.path(),hidden:i.hidden()})))}';
  const { stdout } = await jxa(script);
  return JSON.parse(stdout).filter((i) => i.path).map((i) => ({
    key: `login:${i.name}`, name: i.name, source: 'login',
    command: `open ${i.hidden ? '-j ' : ''}-a ${shq(i.path)}`, data: i,
  }));
}

/**
 * What b_jobs can read: "Open at Login" apps (via System Events) and the user's
 * LaunchAgents. Items that apps register themselves (SMAppService) are kept by macOS
 * where a normal process can't read them, so the UI says some may be missing.
 */
export async function scanStartup() {
  const notes = ['macPartial'];
  let login = [];
  try { login = await scanLoginItems(); } catch { notes.unshift('loginPermission'); }
  return { items: [...login, ...(await scanLaunchAgents())], notes };
}

export async function disableStartupItem(item, backupDir) {
  if (item.source === 'login') {
    await jxa('function run(a){Application("System Events").loginItems.byName(a[0]).delete()}', [item.data.name]);
    return { kind: 'login', name: item.data.name, path: item.data.path, hidden: !!item.data.hidden };
  }
  if (item.source === 'agent') {
    // Moving the plist away stops it from loading at the next login.
    fs.mkdirSync(backupDir, { recursive: true });
    let dest = path.join(backupDir, path.basename(item.data.file));
    if (fs.existsSync(dest)) dest = path.join(backupDir, `${Date.now()}-${path.basename(item.data.file)}`);
    fs.renameSync(item.data.file, dest);
    return { kind: 'agent', from: item.data.file, to: dest };
  }
  throw new Error(`unknown source ${item.source}`);
}

export async function restoreStartupItem(backup) {
  if (backup.kind === 'login') {
    await jxa('function run(a){const se=Application("System Events");se.loginItems.push(se.LoginItem({path:a[0],hidden:a[1]==="1"}))}',
      [backup.path, backup.hidden ? '1' : '0']);
    return;
  }
  if (backup.kind === 'agent') {
    if (fs.existsSync(backup.from)) throw new Error('A file with the same name is already there');
    fs.renameSync(backup.to, backup.from);
    return;
  }
  throw new Error(`unknown backup ${backup.kind}`);
}

/** Jobs run detached in their own process group, so the whole group is signalled. */
export function killTree(pid) {
  const send = (sig) => {
    try { process.kill(-pid, sig); } catch {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  };
  send('SIGTERM');
  const t = setTimeout(() => { if (isAlive(pid)) send('SIGKILL'); }, 5000);
  t.unref();
}
