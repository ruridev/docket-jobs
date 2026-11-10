import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, normalizeJob } from '../agent/core/store.js';
import { LogStore } from '../agent/core/logs.js';
import { Runner } from '../agent/core/runner.js';
import { platform } from '../agent/platform/index.js';

const NODE = `"${process.execPath}"`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jobs-test-'));
  const store = new Store(dir);
  const logs = new LogStore(path.join(dir, 'logs'));
  const runner = new Runner({ store, logs, platform, restartDelayMs: 100, pollMs: 50 });
  return { dir, store, logs, runner };
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

test('normalizeJob requires name and command and clamps values', () => {
  assert.equal(normalizeJob({ command: 'x' }).field, 'name');
  assert.equal(normalizeJob({ name: 'a' }).field, 'command');
  const { job } = normalizeJob({ name: ' a ', command: ' b ', delay: '-5', restart: 'weird' });
  assert.equal(job.name, 'a');
  assert.equal(job.command, 'b');
  assert.equal(job.delay, 0);
  assert.equal(job.restart, '0');
  assert.equal(job.hidden, true);
  assert.equal(job.enabled, true);
});

test('a job that exits 0 is done and its output is logged', async () => {
  const { store, logs, runner } = setup();
  const { job } = store.addJob({ name: 'hello', command: `${NODE} -e "console.log('hello from job')"` });
  runner.start(job);
  await until(() => runner.status(job.id).status === 'done');
  await until(() => logs.tail(job.id).some((e) => e.msg === 'hello from job'));
  assert.equal(runner.status(job.id).exitCode, 0);
  assert.ok(logs.tail(job.id).some((e) => e.k === 'ok'));
  runner.shutdown();
});

test('a failing job restarts up to 3 times, then stays failed', async () => {
  const { store, logs, runner } = setup();
  const { job } = store.addJob({ name: 'fail', command: `${NODE} -e "process.exit(3)"`, restart: '3' });
  runner.start(job);
  await until(() => logs.tail(job.id).filter((e) => e.k === 'err').length === 4);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(runner.status(job.id).status, 'failed');
  assert.equal(runner.status(job.id).exitCode, 3);
  assert.equal(logs.tail(job.id).filter((e) => e.k === 'restarted').length, 3);
  runner.shutdown();
});

test('stopping a running job marks it stopped and does not restart it', async () => {
  const { store, logs, runner } = setup();
  const { job } = store.addJob({ name: 'long', command: `${NODE} -e "setInterval(() => {}, 1000)"`, restart: 'always' });
  runner.start(job);
  await until(() => runner.status(job.id).status === 'running');
  const pid = runner.status(job.id).pid;
  runner.stop(job.id);
  await until(() => runner.status(job.id).status === 'stopped');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(runner.status(job.id).status, 'stopped');
  assert.equal(platform.isAlive(pid), false);
  assert.ok(logs.tail(job.id).some((e) => e.k === 'stopped'));
  runner.shutdown();
});

test('a new agent adopts a job that is still running', async () => {
  const { dir, store, logs, runner } = setup();
  const { job } = store.addJob({ name: 'keep', command: `${NODE} -e "setInterval(() => {}, 1000)"` });
  runner.start(job);
  await until(() => runner.status(job.id).status === 'running');
  runner.shutdown();

  const store2 = new Store(dir);
  const runner2 = new Runner({ store: store2, logs, platform, restartDelayMs: 100, pollMs: 50 });
  runner2.boot({ autorun: true });
  assert.equal(runner2.status(job.id).status, 'running');
  assert.ok(logs.tail(job.id).some((e) => e.k === 'adopted'));
  runner2.stop(job.id);
  await until(() => runner2.status(job.id).status === 'stopped');
  runner2.shutdown();
});

test('boot waits for the start delay', async () => {
  const { store, runner } = setup();
  const { job } = store.addJob({ name: 'later', command: `${NODE} -e "0"`, delay: 1 });
  runner.boot({ autorun: true });
  assert.equal(runner.status(job.id).status, 'waiting');
  await until(() => runner.status(job.id).status === 'done', 5000);
  runner.shutdown();
});

test('a missing working folder fails without spawning', () => {
  const { store, logs, runner } = setup();
  const { job } = store.addJob({ name: 'nowhere', command: 'echo hi', cwd: path.join(os.tmpdir(), 'no-such-dir-docket-jobs') });
  assert.equal(runner.start(job).error, 'cwd_missing');
  assert.equal(runner.status(job.id).status, 'failed');
  assert.ok(logs.tail(job.id).some((e) => e.k === 'cwdMissing'));
  runner.shutdown();
});

test('saved pids from another boot, or of a process that started later, are not adopted', async () => {
  const { spawn } = await import('node:child_process');
  // A live process that is not the job: stands in for a pid that was reused.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const { dir, store, logs } = setup();
    const { job } = store.addJob({ name: 'old', command: 'echo hi', enabled: false });
    const boot = Date.now() - os.uptime() * 1000;
    const startedAt = new Date().toISOString();
    const states = [
      { bootTime: boot - 3600 * 1000, jobs: { [job.id]: { pid: other.pid, startedAt } } },
      { bootTime: boot, jobs: { [job.id]: { pid: other.pid, startedAt: new Date(Date.now() - 3600 * 1000).toISOString() } } },
    ];
    for (const state of states) {
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
      const runner = new Runner({ store, logs, platform, restartDelayMs: 100, pollMs: 50 });
      runner.boot({ autorun: false });
      assert.equal(runner.status(job.id).status, 'stopped');
      runner.shutdown();
    }
    // Same boot and start time: adopted.
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bootTime: boot, jobs: { [job.id]: { pid: other.pid, startedAt } } }));
    const runner = new Runner({ store, logs, platform, restartDelayMs: 100, pollMs: 50 });
    runner.boot({ autorun: false });
    assert.equal(runner.status(job.id).status, 'running');
    runner.shutdown();
  } finally {
    other.kill();
  }
});

test('stopping an adopted job does not kill a process that reused its pid', async () => {
  const { spawn } = await import('node:child_process');
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const { store, logs } = setup();
    const { job } = store.addJob({ name: 'old', command: 'echo hi', enabled: false });
    const runner = new Runner({ store, logs, platform, restartDelayMs: 100, pollMs: 50 });
    Object.assign(runner.rec(job.id), { status: 'running', pid: other.pid, adopted: true,
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    runner.stop(job.id);
    assert.equal(runner.status(job.id).status, 'stopped');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(platform.isAlive(other.pid), true);
    runner.shutdown();
  } finally {
    other.kill();
  }
});
