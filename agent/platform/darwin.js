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

// LaunchAgents for every user. Readable by anyone, but owned by root, so turning one off
// takes an administrator password. (LaunchDaemons are left out on purpose: they run as
// root before login, which b_jobs, running as the user, can't stand in for.)
const SYSTEM_AGENTS = process.env.BJOBS_SYSTEM_AGENTS_DIR || '/Library/LaunchAgents';

/** Turns a LaunchAgent plist (as JSON) into a startup item, or null if it doesn't start at login. */
export function agentToItem(p, full, { system = false } = {}) {
  if (!p || p.Disabled || !(p.RunAtLoad || p.KeepAlive)) return null;
  const argv = Array.isArray(p.ProgramArguments) && p.ProgramArguments.length ? p.ProgramArguments : p.Program ? [p.Program] : null;
  if (!argv || argv.includes(AGENT_ENTRY)) return null; // b_jobs itself
  const file = path.basename(full);
  return {
    key: `${system ? 'sysagent' : 'agent'}:${file}`, name: p.Label || path.parse(file).name,
    source: system ? 'sysagent' : 'agent',
    command: argv.map(shq).join(' '), cwd: p.WorkingDirectory || '',
    needsAdmin: system, allUsers: system,
    data: { file: full, admin: system },
  };
}

async function scanAgentDir(dir, off, opts) {
  const items = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.plist')); } catch { return items; }
  for (const file of files) {
    const full = path.join(dir, file);
    if (full === PLIST) continue;
    let p;
    try { p = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', full])).stdout); } catch { continue; }
    if (off.has(p.Label)) continue;
    const item = agentToItem(p, full, opts);
    if (item) items.push(item);
  }
  return items;
}

async function scanLaunchAgents() {
  const off = await disabledLabels();
  return [
    ...(await scanAgentDir(USER_AGENTS, off, { system: false })),
    ...(await scanAgentDir(SYSTEM_AGENTS, off, { system: true })),
  ];
}

function adminError(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

/**
 * Runs one shell command as root behind macOS's administrator password prompt.
 * The command goes in as an osascript argument, so no AppleScript string escaping is involved.
 */
async function runAsAdmin(shellCommand) {
  const script = 'function run(a){const app=Application.currentApplication();app.includeStandardAdditions=true;app.doShellScript(a[0],{administratorPrivileges:true})}';
  try {
    await jxa(script, [shellCommand], 180000);
  } catch (err) {
    // -128 = the user pressed Cancel on the password prompt.
    throw adminError(/-128/.test(String(err.stderr || err.message)) ? 'uac_cancelled' : 'admin_failed', err);
  }
}

/** Moves a plist away (or back) so it stops (or starts) loading at the next login. */
async function movePlist(from, to, admin) {
  if (fs.existsSync(to)) throw new Error('A file with the same name is already there');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (admin) await runAsAdmin(`/bin/mv -n ${shq(from)} ${shq(to)}`);
  else fs.renameSync(from, to);
}

function backupPath(backupDir, file) {
  let dest = path.join(backupDir, path.basename(file));
  if (fs.existsSync(dest)) dest = path.join(backupDir, `${Date.now()}-${path.basename(file)}`);
  return dest;
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
 * What b_jobs can read: "Open at Login" apps (via System Events), the user's LaunchAgents
 * and /Library/LaunchAgents (admin password to change). Items that apps register themselves (SMAppService) are kept by macOS
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
  if (item.source === 'agent' || item.source === 'sysagent') {
    const dest = backupPath(backupDir, item.data.file);
    await movePlist(item.data.file, dest, item.data.admin);
    return { kind: 'agent', from: item.data.file, to: dest, admin: Boolean(item.data.admin) };
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
    await movePlist(backup.to, backup.from, Boolean(backup.admin));
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
