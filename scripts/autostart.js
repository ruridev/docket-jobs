#!/usr/bin/env node
// Usage: node scripts/autostart.js on|off|status
import { platform, autostartSupported } from '../agent/platform/index.js';

const cmd = process.argv[2] || 'status';
if (!autostartSupported) {
  console.error(`Autostart is not supported on ${process.platform}.`);
  process.exit(1);
}
if (cmd === 'on') platform.enableAutostart();
else if (cmd === 'off') platform.disableAutostart();
else if (cmd !== 'status') {
  console.error('Usage: node scripts/autostart.js on|off|status');
  process.exit(1);
}
console.log(`Start b_jobs at login: ${platform.isAutostartEnabled() ? 'on' : 'off'}`);
