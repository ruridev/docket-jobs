import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const RESTART_POLICIES = ['0', '3', 'always'];

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A broken file must not be silently overwritten: keep a copy before falling back.
    try { fs.copyFileSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // Owner-only: the files hold commands to run and paths to restore.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// File modes do nothing on Windows: give the folder an ACL for this user only (its files inherit it).
function windowsOwnerOnly(dir) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  try {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
  } catch {
    console.warn(`Could not limit ${path.basename(dir)}/ to this user with icacls`);
  }
}

/** Creates the data folder readable by this user only, and tightens an existing one. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not supported (Windows) */ }
  windowsOwnerOnly(dir);
}


/**
 * Validates job input from the API. `base` is the existing job when editing.
 * Returns { job } or { error, field }.
 */
export function normalizeJob(input, base = null) {
  if (!input || typeof input !== 'object') return { error: 'invalid' };
  const src = { ...(base || {}), ...input };

  const name = typeof src.name === 'string' ? src.name.trim() : '';
  if (!name) return { error: 'required', field: 'name' };
  if (name.length > 100) return { error: 'too_long', field: 'name' };

  const command = typeof src.command === 'string' ? src.command.trim() : '';
  if (!command) return { error: 'required', field: 'command' };
  if (command.length > 4000) return { error: 'too_long', field: 'command' };

  const cwd = typeof src.cwd === 'string' ? src.cwd.trim() : '';

  let delay = Number.parseInt(src.delay ?? 0, 10);
  if (!Number.isFinite(delay) || delay < 0) delay = 0;
  if (delay > 3600) delay = 3600;

  const restart = RESTART_POLICIES.includes(String(src.restart)) ? String(src.restart) : '0';

  return {
    job: {
      id: base?.id || crypto.randomUUID().slice(0, 8),
      name,
      command,
      cwd,
      delay,
      restart,
      hidden: src.hidden === undefined ? true : Boolean(src.hidden),
      enabled: src.enabled === undefined ? true : Boolean(src.enabled),
    },
  };
}

export class Store {
  constructor(dataDir) {
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.stateFile = path.join(dataDir, 'state.json');
    ensurePrivateDir(dataDir);

    const raw = readJson(this.jobsFile, { jobs: [] });
    this.jobs = (Array.isArray(raw.jobs) ? raw.jobs : [])
      .map((j) => normalizeJob(j, j?.id ? { id: String(j.id) } : null).job)
      .filter(Boolean);
  }

  getJob(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  addJob(input) {
    const res = normalizeJob(input);
    if (res.error) return res;
    this.jobs.push(res.job);
    this.saveJobs();
    return res;
  }

  updateJob(id, input) {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return { error: 'not_found' };
    const res = normalizeJob({ ...input, id }, this.jobs[idx]);
    if (res.error) return res;
    this.jobs[idx] = res.job;
    this.saveJobs();
    return res;
  }

  removeJob(id) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length !== before) this.saveJobs();
    return this.jobs.length !== before;
  }

  saveJobs() {
    writeJsonAtomic(this.jobsFile, { jobs: this.jobs });
  }

  /** Running processes survive an agent restart; their pids are kept here. */
  loadRunState() {
    return readJson(this.stateFile, {});
  }

  saveRunState(state) {
    writeJsonAtomic(this.stateFile, state);
  }
}
