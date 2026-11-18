import fs from 'node:fs';
import os from 'node:os';

const MAX_OUT_BYTES = 5 * 1024 * 1024;
const STABLE_RUN_MS = 60 * 1000;
// Saved pids are only trusted from the same boot, and when the process started when the job did.
const BOOT_SLACK_MS = 60 * 1000;
const START_SLACK_MS = 10 * 1000;

const bootTime = () => Date.now() - os.uptime() * 1000;

function maxRestarts(policy) {
  if (policy === 'always') return Infinity;
  if (policy === '3') return 3;
  return 0;
}

/**
 * Starts, watches and stops job processes.
 *
 * Processes are detached and write straight to a file, so they keep running when the
 * agent restarts. On start the agent re-adopts them from the saved pids.
 */
export class Runner {
  constructor({ store, logs, platform, restartDelayMs = 5000, pollMs = 500 }) {
    this.store = store;
    this.logs = logs;
    this.platform = platform;
    this.restartDelayMs = restartDelayMs;
    this.recs = new Map();
    this.decoder = platform.outputDecoder ? platform.outputDecoder() : (buf) => buf.toString('utf8');
    this.interval = setInterval(() => this.tick(), pollMs);
    this.interval.unref();
  }

  rec(id) {
    let r = this.recs.get(id);
    if (!r) {
      r = { status: 'stopped', pid: null, exitCode: null, startedAt: null, restarts: 0,
        stopping: false, timer: null, child: null, adopted: false, outOffset: 0, carry: Buffer.alloc(0) };
      this.recs.set(id, r);
    }
    return r;
  }

  status(id) {
    const r = this.recs.get(id);
    if (!r) return { status: 'stopped', pid: null, exitCode: null, startedAt: null };
    return { status: r.status, pid: r.pid, exitCode: r.exitCode, startedAt: r.startedAt };
  }

  /**
   * Whether pid is still the job's process and not another one that got the pid after it ended.
   * Where the start time cannot be read, a live pid from this boot is trusted.
   */
  isJobProcess(pid, startedAt) {
    if (!pid || !this.platform.isAlive(pid)) return false;
    const started = this.platform.processStartTime ? this.platform.processStartTime(pid) : null;
    const expected = Date.parse(startedAt);
    if (started === null || !Number.isFinite(expected)) return true;
    return Math.abs(started - expected) <= START_SLACK_MS;
  }

  /** Re-adopts processes from a previous agent run, then starts enabled jobs. */
  boot({ autorun = true } = {}) {
    const raw = this.store.loadRunState();
    // Older state.json files are just { id: { pid, startedAt } } with no boot time.
    const saved = raw.bootTime === undefined ? raw
      : Math.abs(raw.bootTime - bootTime()) <= BOOT_SLACK_MS ? raw.jobs || {} : {};
    for (const job of this.store.jobs) {
      const s = saved[job.id];
      if (s?.pid && this.isJobProcess(s.pid, s.startedAt)) {
        const r = this.rec(job.id);
        Object.assign(r, { status: 'running', pid: s.pid, startedAt: s.startedAt || null, adopted: true });
        try { r.outOffset = fs.statSync(this.logs.outFile(job.id)).size; } catch { r.outOffset = 0; }
        this.logs.sys(job.id, 'adopted', [s.pid]);
      }
    }
    this.persist();
    if (!autorun) return;
    for (const job of this.store.jobs) {
      if (job.enabled && this.rec(job.id).status !== 'running') this.schedule(job);
    }
  }

  schedule(job) {
    const r = this.rec(job.id);
    if (job.delay > 0) {
      clearTimeout(r.timer);
      r.status = 'waiting';
      this.logs.sys(job.id, 'waitDelay', [job.delay]);
      r.timer = setTimeout(() => {
        r.timer = null;
        const current = this.store.getJob(job.id);
        if (current) this.start(current, 'boot');
      }, job.delay * 1000);
    } else {
      this.start(job, 'boot');
    }
  }

  start(job, reason = 'manual') {
    const r = this.rec(job.id);
    if (r.status === 'running') return { error: 'running' };
    clearTimeout(r.timer);
    r.timer = null;
    if (reason !== 'restart') r.restarts = 0;

    const cwd = job.cwd || os.homedir();
    if (!fs.existsSync(cwd)) {
      this.fail(job.id, r, 'cwdMissing', cwd);
      return { error: 'cwd_missing' };
    }

    const outFile = this.logs.outFile(job.id);
    try {
      if (fs.statSync(outFile).size > MAX_OUT_BYTES) fs.renameSync(outFile, `${outFile}.old`);
    } catch { /* new file */ }
    const fd = fs.openSync(outFile, 'a', 0o600);
    r.outOffset = fs.fstatSync(fd).size;
    r.carry = Buffer.alloc(0);

    let child;
    try {
      child = this.platform.spawnJob(job.command, { cwd, hidden: job.hidden, stdio: ['ignore', fd, fd] });
    } catch (err) {
      fs.closeSync(fd);
      this.fail(job.id, r, 'spawnError', String(err.message));
      return { error: 'spawn_failed' };
    }
    fs.closeSync(fd);
    child.unref();

    Object.assign(r, { child, pid: child.pid, status: 'running', exitCode: null,
      startedAt: new Date().toISOString(), stopping: false, adopted: false });
    const key = reason === 'manual' ? 'manual' : reason === 'restart' ? 'restarted' : 'started';
    this.logs.sys(job.id, key, [child.pid]);

    child.once('error', (err) => {
      if (r.child !== child) return;
      this.fail(job.id, r, 'spawnError', String(err.message));
      this.persist();
    });
    child.once('exit', (code, signal) => this.onExit(job.id, child, code, signal));
    this.persist();
    return { ok: true };
  }

  fail(id, r, k, arg) {
    Object.assign(r, { child: null, pid: null, status: 'failed', exitCode: null });
    this.logs.append(id, { lvl: 'ERR', k, a: [arg] });
  }

  onExit(id, child, code, signal) {
    const r = this.rec(id);
    if (r.child !== child) return;
    this.readOutput(id, r, true);
    const ranMs = r.startedAt ? Date.now() - Date.parse(r.startedAt) : 0;
    r.child = null;
    r.pid = null;

    if (r.stopping) {
      r.stopping = false;
      r.status = 'stopped';
      this.logs.sys(id, 'stopped');
      this.persist();
      return;
    }

    r.exitCode = code ?? null;
    r.status = code === 0 ? 'done' : 'failed';
    if (code === 0) this.logs.sys(id, 'ok');
    else this.logs.sys(id, 'err', [code ?? signal ?? '?']);

    const job = this.store.getJob(id);
    if (job) {
      if (ranMs >= STABLE_RUN_MS) r.restarts = 0;
      const max = maxRestarts(job.restart);
      if (r.restarts < max) {
        r.restarts += 1;
        r.status = 'waiting';
        this.logs.sys(id, 'restartIn', [Math.round(this.restartDelayMs / 1000), r.restarts, max === Infinity ? null : max]);
        r.timer = setTimeout(() => {
          r.timer = null;
          const current = this.store.getJob(id);
          if (current && r.status === 'waiting') this.start(current, 'restart');
        }, this.restartDelayMs);
      }
    }
    this.persist();
  }

  stop(id) {
    const r = this.recs.get(id);
    if (!r) return { ok: true };
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = null;
      if (r.status === 'waiting') {
        r.status = 'stopped';
        this.logs.sys(id, 'stopped');
      }
    }
    if (r.status !== 'running' || !r.pid) return { ok: true };

    if (r.child) {
      r.stopping = true;
      this.platform.killTree(r.pid);
    } else {
      // Adopted from a previous agent run: there is no exit event to wait for. The pid may
      // belong to another program by now, which must not be killed.
      if (this.isJobProcess(r.pid, r.startedAt)) this.platform.killTree(r.pid);
      Object.assign(r, { status: 'stopped', pid: null, adopted: false });
      this.logs.sys(id, 'stopped');
      this.persist();
    }
    return { ok: true };
  }

  /** Stops the job and deletes it with its logs. */
  removeJob(id) {
    this.stop(id);
    const r = this.recs.get(id);
    if (r) clearTimeout(r.timer);
    this.recs.delete(id);
    this.persist();
    this.store.removeJob(id);
    this.logs.remove(id);
  }

  tick() {
    for (const [id, r] of this.recs) {
      if (r.status !== 'running') continue;
      this.readOutput(id, r, false);
      if (r.adopted && r.pid && !this.platform.isAlive(r.pid)) {
        Object.assign(r, { status: 'stopped', pid: null, adopted: false });
        this.logs.sys(id, 'gone');
        this.persist();
      }
    }
  }

  readOutput(id, r, flush) {
    const file = this.logs.outFile(id);
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < r.outOffset) r.outOffset = 0;
    if (size > r.outOffset) {
      const len = Math.min(size - r.outOffset, 1024 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, r.outOffset); } finally { fs.closeSync(fd); }
      r.outOffset += len;
      r.carry = Buffer.concat([r.carry, buf]);
    }
    let nl;
    while ((nl = r.carry.indexOf(10)) >= 0) {
      const line = r.carry.subarray(0, nl);
      r.carry = r.carry.subarray(nl + 1);
      this.emitLine(id, line);
    }
    if (flush && r.carry.length) {
      this.emitLine(id, r.carry);
      r.carry = Buffer.alloc(0);
    }
  }

  emitLine(id, bytes) {
    const text = this.decoder(bytes).replace(/\r$/, '');
    if (text.trim()) this.logs.append(id, { lvl: 'OUT', msg: text });
  }

  persist() {
    const jobs = {};
    for (const [id, r] of this.recs) {
      if (r.status === 'running' && r.pid) jobs[id] = { pid: r.pid, startedAt: r.startedAt };
    }
    try { this.store.saveRunState({ bootTime: bootTime(), jobs }); } catch { /* best effort */ }
  }

  shutdown() {
    clearInterval(this.interval);
    for (const r of this.recs.values()) clearTimeout(r.timer);
    for (const [id, r] of this.recs) if (r.status === 'running') this.readOutput(id, r, true);
    this.persist();
  }
}
