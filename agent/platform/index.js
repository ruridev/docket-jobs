import * as win32 from './win32.js';
import * as darwin from './darwin.js';

const unsupported = {
  ...darwin,
  isAutostartEnabled: () => false,
  enableAutostart: () => { throw new Error(`Autostart is not supported on ${process.platform} yet`); },
  disableAutostart: () => {},
  syncAutostart: () => false,
  scanStartup: async () => ({ items: [], notes: ['unsupported'] }),
  // The rest of darwin's startup functions run macOS commands (open, osascript, launchctl)
  openStartupSettings: undefined,
  disableStartupItem: undefined,
  restoreStartupItem: undefined,
};

export const platform = process.platform === 'win32' ? win32
  : process.platform === 'darwin' ? darwin
  : unsupported;

export const autostartSupported = process.platform === 'win32' || process.platform === 'darwin';
