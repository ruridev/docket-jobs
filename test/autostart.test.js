import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AGENT_ENTRY } from '../agent/paths.js';

// Runs against a throwaway registry key, never the real Run key.
const KEY = String.raw`HKCU\Software\docket-jobs-test-` + process.pid;
const reg = (...args) => spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' });
const query = (name) => reg('query', KEY, '/v', name);

test('an entry under the old b_jobs name moves to docket-jobs with the current path', { skip: process.platform !== 'win32' }, async (t) => {
  process.env.DOCKET_JOBS_RUN_KEY = KEY;
  t.after(() => { reg('delete', KEY, '/f'); delete process.env.DOCKET_JOBS_RUN_KEY; });
  const win32 = await import('../agent/platform/win32.js');

  reg('add', KEY, '/v', 'other', '/t', 'REG_SZ', '/d', 'other.exe', '/f');
  assert.equal(win32.syncAutostart(), false, 'nothing to do without a docket-jobs entry');
  assert.equal(win32.isAutostartEnabled(), false);

  reg('add', KEY, '/v', 'b_jobs', '/t', 'REG_SZ', '/d', String.raw`"node.exe" "C:\old\b_jobs\agent\index.js"`, '/f');
  assert.deepEqual((await win32.scanStartup()).items.map((i) => i.name), ['other'], 'the old entry is not offered for import');
  assert.equal(win32.syncAutostart(), true);
  assert.notEqual(query('b_jobs').status, 0, 'old entry removed');
  assert.ok(query('docket-jobs').stdout.includes(AGENT_ENTRY), 'new entry points at this copy');
  assert.equal(win32.syncAutostart(), false, 'already up to date');

  reg('add', KEY, '/v', 'docket-jobs', '/t', 'REG_SZ', '/d', String.raw`"node.exe" "C:\moved\agent\index.js"`, '/f');
  assert.equal(win32.syncAutostart(), true, 'a stale path is rewritten');
  assert.ok(query('docket-jobs').stdout.includes(AGENT_ENTRY));
  assert.ok(query('other').stdout.includes('other.exe'), 'other entries are untouched');
});
