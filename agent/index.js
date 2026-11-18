#!/usr/bin/env node
import path from 'node:path';
import { DATA_DIR, LOG_DIR, WEB_DIR, DEFAULT_PORT } from './paths.js';
import { Store } from './core/store.js';
import { LogStore } from './core/logs.js';
import { Runner } from './core/runner.js';
import { createServer } from './core/server.js';
import { StartupImporter } from './core/startup.js';
import { platform, autostartSupported } from './platform/index.js';
import { createAuth } from './core/auth.js';

const args = process.argv.slice(2);
const auth = createAuth({ file: path.join(DATA_DIR, 'auth.json'), cookie: 'docket_jobs_session', header: 'x-docket-jobs' });
if (args.includes('--reset-password')) {
  console.log(auth.reset() ? 'Removed the account. Open docket-jobs and create it again with setup code ' + auth.setupCode() + '.' : 'There is no account.');
  process.exit(0);
}
const autorun = !args.includes('--no-autorun');
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.DOCKET_JOBS_PORT) || DEFAULT_PORT;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`docket-jobs: not a valid port: ${portArg ? portArg.split('=')[1] : process.env.DOCKET_JOBS_PORT}`);
  process.exit(1);
}

if (autostartSupported) {
  try {
    if (platform.syncAutostart()) console.log('docket-jobs: updated the login entry to this copy of the agent');
  } catch (err) {
    console.error(`docket-jobs: could not update the login entry: ${err.message}`);
  }
}

const store = new Store(DATA_DIR);
const logs = new LogStore(LOG_DIR);
const runner = new Runner({ store, logs, platform });
const importer = new StartupImporter({ store, runner, platform, dataDir: DATA_DIR });
const server = createServer({ store, runner, logs, platform, autostartSupported, port, webDir: WEB_DIR, auth, importer });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another agent is already running (e.g. started at login); a second one must not start jobs again.
    console.error(`docket-jobs: port ${port} is already in use. Is the agent already running?`);
    runner.shutdown();
    process.exit(0);
  }
  throw err;
});

server.listen(port, '127.0.0.1', () => {
  // Make the setup code before announcing the server, so it exists once the address is printed
  const code = !auth.hasAccount() && auth.setupCode();
  console.log(`docket-jobs agent: http://127.0.0.1:${port}`);
  console.log(`Data: ${DATA_DIR}`);
  if (code) console.log(`Create the account: http://127.0.0.1:${port}/?setup=${code}`);
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
