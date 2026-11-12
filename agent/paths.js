import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_ENTRY = path.join(ROOT, 'agent', 'index.js');
export const WEB_DIR = path.join(ROOT, 'web');

/**
 * Where data lives by default: outside the clone, because imports keep the only copy of the original
 * startup entries there, and deleting or re-cloning the folder must not lose them.
 * A data/ folder already in the clone (older versions) keeps being used.
 */
export function defaultDataDir({ root = ROOT, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const legacy = path.join(root, 'data');
  if (fs.existsSync(legacy)) return legacy;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'docket-jobs');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'docket-jobs');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'docket-jobs');
}

export const DATA_DIR = process.env.DOCKET_JOBS_DATA_DIR ? path.resolve(process.env.DOCKET_JOBS_DATA_DIR) : defaultDataDir();
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const DEFAULT_PORT = 8765;
