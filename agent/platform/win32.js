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
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
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
