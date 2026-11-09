import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
