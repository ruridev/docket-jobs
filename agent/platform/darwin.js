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

/**
 * Parses `launchctl print-disabled` output into { on, off } label sets. Newer macOS prints
 * `=> enabled` / `=> disabled`; older prints `=> false` / `=> true` (true = disabled).
 */
export function parseLaunchdOverrides(text) {
  const on = new Set();
  const off = new Set();
  for (const m of String(text).matchAll(/"([^"]+)"\s*=>\s*(\w+)/g)) {
    if (m[2] === 'disabled' || m[2] === 'true') off.add(m[1]);
    else if (m[2] === 'enabled' || m[2] === 'false') on.add(m[1]);
  }
  return { on, off };
}

async function launchdOverrides() {
  try {
    const { stdout } = await run('launchctl', ['print-disabled', `gui/${process.getuid()}`]);
    return parseLaunchdOverrides(stdout);
  } catch {
    return { on: new Set(), off: new Set() };
  }
}

async function disabledLabels() {
  return (await launchdOverrides()).off;
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

/* Agents that apps keep inside their bundle and register with SMAppService. Their on/off
 * switch lives in macOS's background-items database (root only), and Apple lets only the
 * user change it in System Settings. b_jobs can list them and take over once the user has
 * switched them off there ("manual" items). */

const APP_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')];
const LOGIN_ITEMS_SETTINGS = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

/** Labels launchd has loaded for this user. An app agent switched off in Settings is not loaded. */
async function loadedLabels() {
  try {
    const { stdout } = await run('launchctl', ['list']);
    return new Set(stdout.split('\n').slice(1).map((l) => l.split('\t')[2]).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Turns an agent plist found inside an app bundle into a startup item, or null. */
export function appAgentToItem(p, appPath, plistFile) {
  if (!p || !p.Label) return null;
  const rest = Array.isArray(p.ProgramArguments) ? p.ProgramArguments.slice(1) : [];
  let argv;
  if (p.BundleProgram) argv = [path.posix.join(appPath, p.BundleProgram), ...rest];
  else if (p.Program) argv = [p.Program, ...rest];
  else if (Array.isArray(p.ProgramArguments) && p.ProgramArguments.length) argv = p.ProgramArguments;
  else return null;
  const app = path.posix.basename(appPath, '.app');
  return {
    key: `appagent:${p.Label}`, name: app, label: p.Label, source: 'appagent',
    command: argv.map(shq).join(' '), cwd: '', manual: true,
    data: { label: p.Label, app, file: plistFile },
  };
}

/**
 * Older-style login helper: a small app in Contents/Library/LoginItems that the main app
 * switches on with SMLoginItemSetEnabled. launchd loads it under its bundle id.
 * Same manual flow as app agents: the user switches it off in System Settings.
 */
export function appHelperToItem(bundleId, appPath, helperPath) {
  if (!bundleId) return null;
  const app = path.posix.basename(appPath, '.app');
  return {
    key: `apphelper:${bundleId}`, name: app, label: bundleId, source: 'appagent',
    command: `open ${shq(helperPath)}`, cwd: '', manual: true,
    data: { label: bundleId, app, file: helperPath },
  };
}

async function readPlistJson(file) {
  return JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', file])).stdout);
}

function listDir(dir, ext) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return []; }
}

async function scanAppAgents(includeInactive) {
  const loaded = await loadedLabels();
  const overrides = await launchdOverrides();
  const items = [];
  // Only items that are surely on are listed: loaded in launchd right now. A launchd override
  // of `=> enabled` is NOT enough: the System Settings switch is kept in a root-only database
  // and doesn't change it (checked on a Mac: switched-off helpers still say enabled). So a
  // login helper that starts its app and exits (e.g. Skitch) may be missing; the UI says to
  // add such an app by hand.
  const isOn = (label) => !overrides.off.has(label) && loaded.has(label);
  const keep = (item) => { if (item && (includeInactive || isOn(item.label))) items.push(item); };
  for (const dir of APP_DIRS) {
    for (const a of listDir(dir, '.app')) {
      const appPath = path.join(dir, a);
      const agentDir = path.join(appPath, 'Contents', 'Library', 'LaunchAgents');
      for (const f of listDir(agentDir, '.plist')) {
        const file = path.join(agentDir, f);
        try { keep(appAgentToItem(await readPlistJson(file), appPath, file)); } catch { /* unreadable plist */ }
      }
      const helperDir = path.join(appPath, 'Contents', 'Library', 'LoginItems');
      for (const h of listDir(helperDir, '.app')) {
        const helperPath = path.join(helperDir, h);
        try {
          const info = await readPlistJson(path.join(helperPath, 'Contents', 'Info.plist'));
          keep(appHelperToItem(info.CFBundleIdentifier, appPath, helperPath));
        } catch { /* no Info.plist */ }
      }
    }
  }
  // One app with several agents: tell them apart by label.
  const count = {};
  for (const i of items) count[i.name] = (count[i.name] || 0) + 1;
  for (const i of items) if (count[i.name] > 1) i.name = `${i.name} · ${i.label}`;
  return items;
}

export async function openStartupSettings() {
  await run('open', [LOGIN_ITEMS_SETTINGS]);
}

/**
 * What b_jobs can read: "Open at Login" apps (via System Events), the user's LaunchAgents,
 * /Library/LaunchAgents (admin password to change) and agents inside apps (switched off by
 * the user in System Settings). LaunchDaemons are left out on purpose.
 * `all` also returns app agents that are switched off, so an import can find the item
 * right after the user has turned it off.
 */
export async function scanStartup({ all = false } = {}) {
  const notes = ['macPartial'];
  let login = [];
  try { login = await scanLoginItems(); } catch { notes.unshift('loginPermission'); }
  return { items: [...login, ...(await scanLaunchAgents()), ...(await scanAppAgents(all))], notes };
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
  if (item.source === 'appagent') {
    // b_jobs can't switch it off; the user does that in System Settings first.
    if ((await loadedLabels()).has(item.data.label)) {
      throw Object.assign(new Error('still_enabled'), { code: 'still_enabled' });
    }
    return { kind: 'manual', label: item.data.label, app: item.data.app };
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
  if (backup.kind === 'manual') {
    // Only the user can switch it back on in System Settings; the UI tells them so.
    return { manual: true };
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
