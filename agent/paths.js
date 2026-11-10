import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_ENTRY = path.join(ROOT, 'agent', 'index.js');
export const WEB_DIR = path.join(ROOT, 'web');
export const DATA_DIR = process.env.DOCKET_JOBS_DATA_DIR
  ? path.resolve(process.env.DOCKET_JOBS_DATA_DIR)
  : path.join(ROOT, 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const DEFAULT_PORT = 8765;
