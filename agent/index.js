#!/usr/bin/env node
import { DATA_DIR, LOG_DIR, WEB_DIR, DEFAULT_PORT } from './paths.js';
import { Store } from './core/store.js';
import { LogStore } from './core/logs.js';
import { Runner } from './core/runner.js';
import { createServer } from './core/server.js';
import { platform, autostartSupported } from './platform/index.js';

const args = process.argv.slice(2);
const autorun = !args.includes('--no-autorun');
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.BJOBS_PORT) || DEFAULT_PORT;

const store = new Store(DATA_DIR);
const logs = new LogStore(LOG_DIR);
const runner = new Runner({ store, logs, platform });
const server = createServer({ store, runner, logs, platform, autostartSupported, port, webDir: WEB_DIR });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another agent is already running (e.g. started at login); a second one must not start jobs again.
    console.error(`b_jobs: port ${port} is already in use. Is the agent already running?`);
    runner.shutdown();
    process.exit(0);
  }
  throw err;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`b_jobs agent: http://127.0.0.1:${port}`);
  runner.boot({ autorun });
});

function exit() {
  // Jobs are detached and keep running; the next agent adopts them.
  runner.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
