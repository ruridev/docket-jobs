import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything points at temp folders before darwin.js reads its paths: never the real
// ~/Library/LaunchAgents, /Library/LaunchAgents or /Library/Application Support.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-darwin-')));
const sysAgents = path.join(root, 'sys-agents');
const sysBackup = path.join(root, 'sys-backup');
const backupDir = path.join(root, 'data', 'startup-backup');
process.env.HOME = path.join(root, 'home');
process.env.DOCKET_JOBS_SYSTEM_AGENTS_DIR = sysAgents;
process.env.DOCKET_JOBS_SYSTEM_BACKUP_DIR = sysBackup;
const userAgents = path.join(root, 'home', 'Library', 'LaunchAgents');
for (const d of [sysAgents, sysBackup, backupDir, userAgents]) fs.mkdirSync(d, { recursive: true });
const darwin = await import('../agent/platform/darwin.js');
const { agentRestorePaths } = darwin;

test('admin undo paths come from the fixed folders, not from the record', () => {
  const p = agentRestorePaths({ kind: 'agent', admin: true, from: path.join(sysAgents, 'com.x.plist'), to: path.join(sysBackup, '17-com.x.plist') },
    'sysagent:com.x.plist', backupDir);
  assert.deepEqual(p, { from: path.join(sysBackup, '17-com.x.plist'), to: path.join(sysAgents, 'com.x.plist'), admin: true });

  // A tampered "from" folder is ignored: only its file name is used.
  const q = agentRestorePaths({ kind: 'agent', admin: true, from: '/etc/sudoers.d/com.x.plist', to: path.join(sysBackup, 'com.x.plist') },
    'sysagent:com.x.plist', backupDir);
  assert.equal(q.to, path.join(sysAgents, 'com.x.plist'));
});

test('admin undo refuses names that do not fit, or do not match the key', () => {
  const rec = (from, to) => ({ kind: 'agent', admin: true, from, to: path.join(sysBackup, to) });
  assert.throws(() => agentRestorePaths(rec('/L/com.x.plist', 'com.x.plist'), 'sysagent:com.y.plist', backupDir));
  assert.throws(() => agentRestorePaths(rec("/L/a'b.plist", "a'b.plist"), "sysagent:a'b.plist", backupDir));
  assert.throws(() => agentRestorePaths(rec('/L/a b.plist', 'a b.plist'), 'sysagent:a b.plist', backupDir));
  assert.throws(() => agentRestorePaths(rec('/L/com.x.plist', 'other.plist'), 'sysagent:com.x.plist', backupDir));
  assert.throws(() => agentRestorePaths(rec('/L/com.x.plist', 'x-com.x.plist'), 'sysagent:com.x.plist', backupDir));
  assert.throws(() => agentRestorePaths({ ...rec('/L/com.x.plist', 'com.x.plist'), admin: false }, 'sysagent:com.x.plist', backupDir));
});

test('admin undo refuses a backup outside the root-owned folder', () => {
  // data/startup-backup is writable by the user, so root must never install a plist from it.
  fs.writeFileSync(path.join(backupDir, 'com.old.plist'), '<plist/>');
  assert.throws(() => agentRestorePaths({ kind: 'agent', admin: true, from: '/Library/LaunchAgents/com.old.plist', to: path.join(backupDir, 'com.old.plist') },
    'sysagent:com.old.plist', backupDir), /root-owned/);
});

test('user-level import and undo move the plist and refuse a symlinked backup folder', async () => {
  assert.equal(os.homedir(), path.join(root, 'home'));
  const file = path.join(userAgents, 'me tool.plist');
  fs.writeFileSync(file, '<plist/>');
  const item = { key: 'agent:me tool.plist', source: 'agent', data: { file, admin: false } };
  const backup = await darwin.disableStartupItem(item, backupDir);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(backup.to), true);
  await darwin.restoreStartupItem(backup, item.key, backupDir);
  assert.equal(fs.existsSync(file), true);

  const linked = path.join(root, 'data2', 'startup-backup');
  fs.mkdirSync(path.dirname(linked));
  fs.symlinkSync(path.join(root, 'elsewhere'), linked);
  await assert.rejects(darwin.disableStartupItem(item, linked), /symlink/);
  assert.equal(fs.existsSync(file), true);
});

test('import refuses an item whose file is not in its LaunchAgents folder', async () => {
  const file = path.join(root, 'stray.plist');
  fs.writeFileSync(file, '<plist/>');
  await assert.rejects(darwin.disableStartupItem({ key: 'sysagent:stray.plist', source: 'sysagent', data: { file, admin: true } }, backupDir));
  await assert.rejects(darwin.disableStartupItem({ key: 'agent:stray.plist', source: 'agent', data: { file, admin: false } }, backupDir));
  assert.equal(fs.existsSync(file), true);
});
