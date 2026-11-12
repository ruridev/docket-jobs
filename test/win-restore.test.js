// Undoing a Startup-folder import on Windows: the paths come from the fixed folders, not the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-appdata-'));
process.env.APPDATA = appData;
const { restoreStartupItem } = await import('../agent/platform/win32.js');
const startup = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

test('a tampered record cannot move files outside the backup and Startup folders', async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-backup-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-elsewhere-'));
  fs.writeFileSync(path.join(backupDir, 'app.lnk'), 'shortcut');
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'keep me');
  await restoreStartupItem({ kind: 'folder', from: path.join(elsewhere, 'app.lnk'), to: path.join(elsewhere, '..', path.basename(backupDir), 'app.lnk') }, 'folder:app.lnk', backupDir);
  assert.equal(fs.readFileSync(path.join(startup, 'app.lnk'), 'utf8'), 'shortcut');
  assert.equal(fs.existsSync(path.join(elsewhere, 'app.lnk')), false);
  // A record pointing "to" at some other file only names a file in the backup folder, which is not there
  await assert.rejects(restoreStartupItem({ kind: 'folder', from: path.join(startup, 'x.txt'), to: path.join(elsewhere, 'secret.txt') }, 'folder:x', backupDir));
  assert.equal(fs.readFileSync(path.join(elsewhere, 'secret.txt'), 'utf8'), 'keep me');
});
