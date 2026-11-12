import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runAsync = promisify(execFile);
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
    env: { ...process.env, DOCKET_JOBS_COMMAND: command, DOCKET_JOBS_HIDE: hidden ? '1' : '0' },
  });
}

// HKCU Run works without admin rights, unlike a logon task in Task Scheduler.
const RUN_KEY = process.env.DOCKET_JOBS_RUN_KEY || 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = process.env.DOCKET_JOBS_AUTOSTART_NAME || 'docket-jobs';

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

/**
 * Keeps the login entry pointing at this copy of the agent: rewrites one whose path is stale
 * (the folder was moved).
 * Returns true if anything changed. With a custom entry name (tests), real entries are left alone.
 */
export function syncAutostart() {
  if (process.env.DOCKET_JOBS_AUTOSTART_NAME) return false;
  const current = regValues(RUN_KEY).find((v) => v.name === VALUE_NAME);
  if (!current || current.value.includes(AGENT_ENTRY)) return false;
  enableAutostart();
  return true;
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

/** When the process started (ms), or null if unknown. Tells a reused pid apart from our job. */
export function processStartTime(pid) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
  { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  const t = Date.parse((res.stdout || '').trim());
  return res.status === 0 && Number.isFinite(t) ? t : null;
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

/* Task Scheduler: only tasks the user registered (run as this user, start at logon). */

function powershell(script, env = {}, timeout = 30000) {
  return runAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`],
  { windowsHide: true, timeout, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
}

// needsAdmin: the task file only lets Administrators write, which happens when an installer
// registered the task from an elevated process. The non-elevated token can't change it.
const LIST_TASKS = `
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$ids = @($me.Name, $env:USERNAME, $me.User.Value)
# Groups leaves out deny-only groups, so a filtered admin token does not count as Administrators.
$sids = @($me.User.Value) + @($me.Groups | ForEach-Object { $_.Value })
$write = [Security.AccessControl.FileSystemRights]::Write
# DJ_ALL=1: disabled tasks too (an imported task is disabled; undo looks it up again).
$all = $env:DJ_ALL -eq '1'
$out = @(Get-ScheduledTask | Where-Object {
  $_.TaskPath -notlike '\\Microsoft\\*' -and ($all -or $_.State -ne 'Disabled') -and
  ($ids -contains $_.Principal.UserId) -and
  @($_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled }).Count -gt 0
} | ForEach-Object {
  $file = Join-Path "$env:SystemRoot\\System32\\Tasks" ($_.TaskPath.TrimStart('\\') + $_.TaskName)
  $canWrite = $false
  try {
    foreach ($r in (Get-Acl -LiteralPath $file).Access) {
      $sid = try { $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $null }
      if ($r.AccessControlType -eq 'Allow' -and ($sids -contains $sid) -and (($r.FileSystemRights -band $write) -eq $write)) { $canWrite = $true }
    }
  } catch { $canWrite = $true }
  [pscustomobject]@{
    path = $_.TaskPath; name = $_.TaskName
    needsAdmin = -not $canWrite
    highest = ($_.Principal.RunLevel -eq 'Highest')
    actions = @($_.Actions | ForEach-Object { [pscustomobject]@{ exe = $_.Execute; args = $_.Arguments; cwd = $_.WorkingDirectory } })
    delay = @($_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' } | ForEach-Object { $_.Delay }) -join ''
  }
})
ConvertTo-Json -InputObject $out -Depth 4 -Compress`;

/** "PT1M30S" -> 90 */
export function isoDurationSeconds(d) {
  const m = String(d || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, days, h, min, s] = m.map((x) => Number(x) || 0);
  return days * 86400 + h * 3600 + min * 60 + s;
}

function expandEnv(s) {
  return String(s || '').replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
}

/** Turns a task from LIST_TASKS into a startup item, or null if docket-jobs can't run it (e.g. a COM action). */
export function taskToItem(task) {
  const actions = (task.actions || []).filter((a) => a && a.exe);
  if (!actions.length || actions.length !== (task.actions || []).length) return null;
  // The job runs through cmd.exe: unquoted & | < > ^ would become operators, and a job has one working folder
  if (actions.some((a) => /[&|<>^]/.test(String(a.args || '').replace(/"[^"]*"/g, '')))) return null;
  if (new Set(actions.map((a) => a.cwd || '')).size > 1) return null;
  const cmd = actions.map((a) => {
    const exe = /^".*"$/.test(a.exe) || !/\s/.test(a.exe) ? a.exe : `"${a.exe}"`;
    return a.args ? `${exe} ${a.args}` : exe;
  }).join(' && ');
  if (cmd.includes(AGENT_ENTRY)) return null;
  return {
    key: `task:${task.path}${task.name}`, name: task.name, source: 'task', command: cmd,
    cwd: expandEnv(actions[0].cwd), delay: isoDurationSeconds(task.delay),
    needsAdmin: Boolean(task.needsAdmin), highest: Boolean(task.highest),
    data: { path: task.path, name: task.name, admin: Boolean(task.needsAdmin) },
  };
}

async function scanTasks({ all = false } = {}) {
  const { stdout } = await powershell(LIST_TASKS, { DJ_ALL: all ? '1' : '0' });
  const list = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(list) ? list : [list]).map(taskToItem).filter(Boolean);
}

/** A single-quoted PowerShell literal. PowerShell also reads U+2018-U+201B as single quotes. */
export const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;

/** A PowerShell expression for the string, passed as base64 UTF-8 so no character of it is ever parsed. */
export const psString = (s) =>
  `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(Buffer.from(String(s), 'utf8').toString('base64'))})))`;
const UAC_WAIT_MS = 180000;

function startupError(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

async function setTaskEnabled(path_, name, enabled, admin = false) {
  const verb = enabled ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask';
  if (!admin) {
    // Names go through env vars so nothing in them is read as PowerShell code.
    try {
      await powershell(`${verb} -TaskPath $env:DJ_TASK_PATH -TaskName $env:DJ_TASK_NAME | Out-Null`,
        { DJ_TASK_PATH: path_, DJ_TASK_NAME: name });
    } catch (err) {
      throw startupError('change_failed', err);
    }
    return;
  }

  // Elevated: Windows shows the UAC prompt for this one command. An elevated process does
  // not get our environment, so the names go in as base64 inside an -EncodedCommand and are
  // decoded there; PowerShell never reads them as code.
  const inner = `try { ${verb} -TaskPath ${psString(path_)} -TaskName ${psString(name)} -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `try {
  $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$env:DJ_ENC
} catch {
  $e = $_.Exception
  while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 3 }; $e = $e.InnerException }
  exit 4
}
exit $p.ExitCode`;
  try {
    await powershell(outer, { DJ_ENC: encoded }, UAC_WAIT_MS);
  } catch (err) {
    // 3 = the user said No on the UAC prompt (ERROR_CANCELLED).
    throw startupError(err.code === 3 ? 'uac_cancelled' : 'admin_failed', err);
  }
}

/**
 * Startup items docket-jobs can take over without admin rights: the user's Run key, Startup
 * folder and their own logon tasks in Task Scheduler. Items already disabled in Task
 * Manager are left out.
 */
export async function scanStartup() {
  const notes = [];
  let tasks = [];
  try { tasks = await scanTasks(); } catch { notes.push('tasksUnreadable'); }
  return { items: [...scanRunAndFolder(), ...tasks], notes };
}

function scanRunAndFolder() {
  const items = [];
  const runOff = disabledByTaskManager('Run');
  for (const v of regValues(RUN_KEY)) {
    // Skip docket-jobs itself, whatever name it was registered under.
    if (v.name === VALUE_NAME || v.value.includes(AGENT_ENTRY) || runOff.has(v.name)) continue;
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
  return items;
}

/**
 * The task behind a startup item key, read again from Task Scheduler. Whether it needs admin,
 * its path and its name are never taken from imports.json, which the user's programs can edit.
 */
async function findTask(key) {
  const item = (await scanTasks({ all: true })).find((i) => i.key === key);
  if (!item) throw new Error('task not found');
  return item.data;
}

/** Turns the original entry off and returns what is needed to put it back. */
export async function disableStartupItem(item, backupDir) {
  if (item.source === 'task') {
    // item comes from the scan the import has just made, not from imports.json.
    // The task is only disabled, never deleted, so its other settings stay as they were.
    await setTaskEnabled(item.data.path, item.data.name, false, item.data.admin);
    return { kind: 'task', path: item.data.path, name: item.data.name, admin: item.data.admin };
  }
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

export async function restoreStartupItem(backup, key, backupDir) {
  if (backup.kind === 'task') {
    const task = await findTask(key);
    await setTaskEnabled(task.path, task.name, true, task.admin);
    return;
  }
  if (backup.kind === 'run') {
    const res = reg(['add', RUN_KEY, '/v', backup.name, '/t', backup.type, '/d', backup.value, '/f']);
    if (res.status !== 0) throw new Error((res.stderr || 'reg add failed').trim());
    return;
  }
  if (backup.kind === 'folder') {
    // Both paths are rebuilt from the fixed folders: only the file names come from the record.
    const from = path.join(backupDir, path.basename(String(backup.to)));
    const to = path.join(STARTUP_DIR, path.basename(String(backup.from)));
    if (fs.existsSync(to)) throw new Error('A file with the same name is already there');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return;
  }
  throw new Error(`unknown backup ${backup.kind}`);
}
