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
  assert.deepEqual(item.data, { path: '\\', name: 'Local_AI_llama_cpp', admin: false });
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

test('admin-only tasks are flagged in the list and on the imported record', async () => {
  const { importer, fake, runner } = setup();
  fake.entries.set('task:\\Gate', { key: 'task:\\Gate', name: 'Gate', source: 'task', command: 'gate.exe', needsAdmin: true, highest: true });
  const before = (await importer.list()).items.find((i) => i.key === 'task:\\Gate');
  assert.equal(before.needsAdmin, true);
  assert.equal(before.highest, true);
  fake.disableStartupItem = async (item) => { fake.entries.delete(item.key); return { item, admin: true }; };
  await importer.import('task:\\Gate');
  assert.equal((await importer.list()).imported.find((i) => i.key === 'task:\\Gate').needsAdmin, true);
  runner.shutdown();
});

test('a cancelled UAC prompt leaves everything as it was', async () => {
  const { store, importer, fake, runner } = setup();
  fake.disableStartupItem = async () => { throw Object.assign(new Error('uac_cancelled'), { code: 'uac_cancelled' }); };
  await assert.rejects(importer.import('run:Steam'), { code: 'uac_cancelled' });
  assert.equal(store.jobs.length, 0);
  assert.equal((await importer.list()).imported.length, 0);
  assert.equal(fake.entries.has('run:Steam'), true);
  runner.shutdown();
});

test('taskToItem carries the admin flags', () => {
  const item = taskToItem({ path: '\\', name: 'T', needsAdmin: true, highest: false, actions: [{ exe: 'a.exe', args: '', cwd: '' }] });
  assert.equal(item.needsAdmin, true);
  assert.equal(item.highest, false);
  assert.equal(item.data.admin, true);
});

test('a /Library LaunchAgent needs admin and is marked as all-users', async () => {
  const { agentToItem } = await import('../agent/platform/darwin.js');
  const sys = agentToItem({ Label: 'com.vendor.helper', ProgramArguments: ['/Applications/Vendor.app/helper', '--bg'], RunAtLoad: true },
    '/Library/LaunchAgents/com.vendor.helper.plist', { system: true });
  assert.equal(sys.key, 'sysagent:com.vendor.helper.plist');
  assert.equal(sys.source, 'sysagent');
  assert.equal(sys.command, '/Applications/Vendor.app/helper --bg');
  assert.equal(sys.needsAdmin, true);
  assert.equal(sys.allUsers, true);
  assert.equal(sys.data.admin, true);

  const user = agentToItem({ Label: 'me.tool', Program: '/Users/me/My Tools/run', KeepAlive: true }, '/Users/me/Library/LaunchAgents/me.tool.plist');
  assert.equal(user.key, 'agent:me.tool.plist');
  assert.equal(user.command, "'/Users/me/My Tools/run'");
  assert.equal(user.needsAdmin, false);
});

test('LaunchAgents that do not start at login are left out', async () => {
  const { agentToItem } = await import('../agent/platform/darwin.js');
  assert.equal(agentToItem({ Label: 'a', Program: '/x', RunAtLoad: false }, '/L/a.plist'), null);
  assert.equal(agentToItem({ Label: 'b', Program: '/x', RunAtLoad: true, Disabled: true }, '/L/b.plist'), null);
  assert.equal(agentToItem({ Label: 'c', RunAtLoad: true }, '/L/c.plist'), null);
});

test('the list passes the all-users flag through', async () => {
  const { importer, fake, runner } = setup();
  fake.entries.set('sysagent:x.plist', { key: 'sysagent:x.plist', name: 'x', source: 'sysagent', command: '/x', needsAdmin: true, allUsers: true });
  const item = (await importer.list()).items.find((i) => i.key === 'sysagent:x.plist');
  assert.equal(item.allUsers, true);
  assert.equal(item.needsAdmin, true);
  runner.shutdown();
});

test('an agent inside an app becomes a manual item named after the app', async () => {
  const { appAgentToItem } = await import('../agent/platform/darwin.js');
  const item = appAgentToItem({ Label: 'com.docker.helper', BundleProgram: 'Contents/MacOS/helper', ProgramArguments: ['helper', '--quiet'] },
    '/Applications/Docker.app', '/Applications/Docker.app/Contents/Library/LaunchAgents/com.docker.helper.plist');
  assert.equal(item.key, 'appagent:com.docker.helper');
  assert.equal(item.name, 'Docker');
  assert.equal(item.manual, true);
  assert.match(item.command, /Docker\.app[\\/]Contents[\\/]MacOS[\\/]helper --quiet$/);
  assert.equal(appAgentToItem({ Label: 'x' }, '/Applications/X.app', '/f'), null);
});

test('a manual item imports only after the user switched it off, and undo says to switch it back on', async () => {
  const { store, importer, fake, runner } = setup();
  fake.entries.set('appagent:com.x', { key: 'appagent:com.x', name: 'X', source: 'appagent', command: '/x', manual: true });
  let stillOn = true;
  fake.disableStartupItem = async (item) => {
    if (stillOn) throw Object.assign(new Error('still_enabled'), { code: 'still_enabled' });
    return { kind: 'manual', item };
  };
  fake.restoreStartupItem = async () => ({ manual: true });

  assert.equal((await importer.list()).items.find((i) => i.key === 'appagent:com.x').manual, true);
  await assert.rejects(importer.import('appagent:com.x'), { code: 'still_enabled' });
  assert.equal(store.jobs.length, 0);

  stillOn = false;
  assert.equal((await importer.import('appagent:com.x')).job.name, 'X');
  assert.equal((await importer.list()).imported.find((i) => i.key === 'appagent:com.x').manual, true);

  const r = await importer.undo('appagent:com.x');
  assert.deepEqual(r, { ok: true, manual: true, name: 'X' });
  assert.equal(store.jobs.length, 0);
  runner.shutdown();
});

test('an older-style login helper inside an app is a manual item too', async () => {
  const { appHelperToItem } = await import('../agent/platform/darwin.js');
  const item = appHelperToItem('com.skitch.SkitchHelper', '/Applications/Skitch.app',
    '/Applications/Skitch.app/Contents/Library/LoginItems/Skitch Helper.app');
  assert.equal(item.key, 'apphelper:com.skitch.SkitchHelper');
  assert.equal(item.name, 'Skitch');
  assert.equal(item.source, 'appagent');
  assert.equal(item.manual, true);
  assert.equal(item.data.label, 'com.skitch.SkitchHelper');
  assert.equal(item.command, "open '/Applications/Skitch.app/Contents/Library/LoginItems/Skitch Helper.app'");
  assert.equal(appHelperToItem(undefined, '/Applications/X.app', '/h'), null);
});

test('launchd overrides are read in both old and new formats', async () => {
  const { parseLaunchdOverrides } = await import('../agent/platform/darwin.js');
  const { on, off } = parseLaunchdOverrides([
    'disabled services = {',
    '\t"J8RPQ294UB.com.skitch.SkitchHelper" => enabled',
    '\t"com.vendor.off" => disabled',
    '\t"com.old.on" => false',
    '\t"com.old.off" => true',
    '}',
  ].join('\n'));
  assert.deepEqual([...on].sort(), ['J8RPQ294UB.com.skitch.SkitchHelper', 'com.old.on']);
  assert.deepEqual([...off].sort(), ['com.old.off', 'com.vendor.off']);
});
