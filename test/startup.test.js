import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../agent/core/store.js';
import { LogStore } from '../agent/core/logs.js';
import { Runner } from '../agent/core/runner.js';
import { StartupImporter } from '../agent/core/startup.js';
import { platform } from '../agent/platform/index.js';
import { parseRegQuery, taskToItem, isoDurationSeconds } from '../agent/platform/win32.js';
import { AGENT_ENTRY } from '../agent/paths.js';

/** Stands in for the OS: a list of entries that can be switched off and back on. */
function fakePlatform() {
  const entries = new Map([
    ['run:Steam', { key: 'run:Steam', name: 'Steam', source: 'run', command: '"C:\\Steam\\steam.exe" -silent' }],
    ['run:Discord', { key: 'run:Discord', name: 'Discord', source: 'run', command: 'Discord.exe' }],
  ]);
  return {
    ...platform,
    entries,
    scanStartup: async () => ({ items: [...entries.values()], notes: ['macPartial'] }),
    disableStartupItem: async (item) => { entries.delete(item.key); return { item }; },
    restoreStartupItem: async (backup) => { entries.set(backup.item.key, backup.item); },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjobs-startup-'));
  const store = new Store(dir);
  const logs = new LogStore(path.join(dir, 'logs'));
  const fake = fakePlatform();
  const runner = new Runner({ store, logs, platform: fake });
  const importer = new StartupImporter({ store, runner, logs, platform: fake, dataDir: dir });
  return { dir, store, logs, runner, importer, fake };
}

test('importing turns the original off and adds an enabled job', async () => {
  const { store, importer, fake, runner } = setup();
  const r = await importer.import('run:Steam');
  assert.equal(r.job.name, 'Steam');
  assert.equal(r.job.command, '"C:\\Steam\\steam.exe" -silent');
  assert.equal(r.job.enabled, true);
  assert.equal(fake.entries.has('run:Steam'), false);
  assert.equal(store.jobs.length, 1);

  const list = await importer.list();
  assert.deepEqual(list.items.map((i) => i.key), ['run:Discord']);
  assert.deepEqual(list.imported.map((i) => i.key), ['run:Steam']);
  assert.deepEqual(list.notes, ['macPartial']);
  runner.shutdown();
});

test('undo restores the original and removes the job', async () => {
  const { store, importer, fake, runner } = setup();
  await importer.import('run:Steam');
  const r = await importer.undo('run:Steam');
  assert.equal(r.ok, true);
  assert.equal(fake.entries.has('run:Steam'), true);
  assert.equal(store.jobs.length, 0);
  assert.equal((await importer.list()).imported.length, 0);
  runner.shutdown();
});

test('imports survive an agent restart', async () => {
  const { dir, logs, importer, fake, runner } = setup();
  await importer.import('run:Discord');
  const store2 = new Store(dir);
  const importer2 = new StartupImporter({ store: store2, runner, logs, platform: fake, dataDir: dir });
  assert.deepEqual((await importer2.list()).imported.map((i) => i.key), ['run:Discord']);
  assert.equal((await importer2.undo('run:Discord')).ok, true);
  assert.equal(fake.entries.has('run:Discord'), true);
  runner.shutdown();
});

test('importing something unknown or twice is refused', async () => {
  const { importer, runner } = setup();
  assert.equal((await importer.import('run:Nope')).error, 'not_found');
  await importer.import('run:Steam');
  assert.equal((await importer.import('run:Steam')).error, 'already_imported');
  assert.equal((await importer.undo('run:Nope')).error, 'not_found');
  runner.shutdown();
});

test('a logon task becomes a job with its command, folder and delay', () => {
  const item = taskToItem({
    path: '\\', name: 'Local_AI_llama_cpp', delay: 'PT1M30S',
    actions: [{ exe: 'C:\\Program Files\\PowerShell\\pwsh.exe', args: '-File "C:\\AI\\start.ps1"', cwd: 'C:\\AI' }],
  });
  assert.equal(item.key, 'task:\\Local_AI_llama_cpp');
  assert.equal(item.command, '"C:\\Program Files\\PowerShell\\pwsh.exe" -File "C:\\AI\\start.ps1"');
  assert.equal(item.cwd, 'C:\\AI');
  assert.equal(item.delay, 90);
  assert.deepEqual(item.data, { path: '\\', name: 'Local_AI_llama_cpp' });
});

test('tasks b_jobs cannot run, or b_jobs itself, are left out', () => {
  assert.equal(taskToItem({ path: '\\', name: 'com', actions: [{ exe: '' }] }), null);
  assert.equal(taskToItem({ path: '\\', name: 'none', actions: [] }), null);
  assert.equal(taskToItem({ path: '\\', name: 'self', actions: [{ exe: 'node.exe', args: `"${AGENT_ENTRY}"` }] }), null);
});

test('isoDurationSeconds reads Task Scheduler delays', () => {
  assert.equal(isoDurationSeconds('PT30S'), 30);
  assert.equal(isoDurationSeconds('PT1H2M3S'), 3723);
  assert.equal(isoDurationSeconds('P1DT1S'), 86401);
  assert.equal(isoDurationSeconds(''), 0);
  assert.equal(isoDurationSeconds('junk'), 0);
});

test('parseRegQuery reads names with spaces and empty values', () => {
  const text = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '    Steam    REG_SZ    "C:\\Program Files (x86)\\Steam\\steam.exe" -silent',
    '    Docker Desktop    REG_SZ    C:\\Docker\\Docker Desktop.exe',
    '    Tool    REG_EXPAND_SZ    %LOCALAPPDATA%\\tool.exe',
    '    Empty    REG_SZ',
    '    Approved    REG_BINARY    030000000000000000000000',
    '',
  ].join('\r\n');
  assert.deepEqual(parseRegQuery(text), [
    { name: 'Steam', type: 'REG_SZ', value: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent' },
    { name: 'Docker Desktop', type: 'REG_SZ', value: 'C:\\Docker\\Docker Desktop.exe' },
    { name: 'Tool', type: 'REG_EXPAND_SZ', value: '%LOCALAPPDATA%\\tool.exe' },
    { name: 'Empty', type: 'REG_SZ', value: '' },
    { name: 'Approved', type: 'REG_BINARY', value: '030000000000000000000000' },
  ]);
});
