import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** A command's output, or '' when it fails with no output. Never throws. */
export function runText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** An error whose code the UI can explain (see server.js). */
export function codeError(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

/** The user-level backup folder; refused if it is a symlink (it could point anywhere). */
export function userBackupDir(backupDir) {
  try {
    if (fs.lstatSync(backupDir).isSymbolicLink()) throw new Error('startup-backup is a symlink');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  return backupDir;
}

/** Where to move a file into backupDir without overwriting an earlier backup of the same name. */
export function backupPath(backupDir, file) {
  let dest = path.join(backupDir, path.basename(file));
  if (fs.existsSync(dest)) dest = path.join(backupDir, `${Date.now()}-${path.basename(file)}`);
  return dest;
}
