import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * Takes other programs' startup items over into docket-jobs, and puts them back on undo.
 * Each import is recorded with what is needed to restore the original entry.
 */
export class StartupImporter {
  constructor({ store, runner, logs, platform, dataDir }) {
    this.store = store;
    this.runner = runner;
    this.logs = logs;
    this.platform = platform;
    this.file = path.join(dataDir, 'imports.json');
    this.backupDir = path.join(dataDir, 'startup-backup');
    const raw = readJson(this.file, { imports: [] });
    this.records = Array.isArray(raw.imports) ? raw.imports : [];
  }

  save() {
    writeJsonAtomic(this.file, { imports: this.records });
  }

  async list() {
    const scan = await this.platform.scanStartup();
    const taken = new Set(this.records.map((r) => r.key));
    return {
      items: scan.items.filter((i) => !taken.has(i.key)).map(({ key, name, source, needsAdmin, highest, allUsers, manual }) =>
        ({ key, name, source, needsAdmin: Boolean(needsAdmin), highest: Boolean(highest), allUsers: Boolean(allUsers), manual: Boolean(manual) })),
      imported: this.records.map(({ key, name, source, jobId, backup }) =>
        ({ key, name, source, jobId, needsAdmin: Boolean(backup?.admin), manual: backup?.kind === 'manual' })),
      notes: scan.notes || [],
    };
  }

  async import(key) {
    if (this.records.some((r) => r.key === key)) return { error: 'already_imported' };
    // all: also items the user has just switched off in System Settings (macOS app agents).
    const { items } = await this.platform.scanStartup({ all: true });
    const item = items.find((i) => i.key === key);
    if (!item) return { error: 'not_found' };

    const backup = await this.platform.disableStartupItem(item, this.backupDir);
    const res = this.store.addJob({ name: item.name, command: item.command, cwd: item.cwd || '', delay: item.delay || 0, hidden: true });
    if (res.error) {
      await this.platform.restoreStartupItem(backup, key, this.backupDir);
      return res;
    }
    this.records.push({ key, name: item.name, source: item.source, backup, jobId: res.job.id, at: new Date().toISOString() });
    this.save();
    return { job: res.job };
  }

  async undo(key) {
    const rec = this.records.find((r) => r.key === key);
    if (!rec) return { error: 'not_found' };
    const restored = await this.platform.restoreStartupItem(rec.backup, rec.key, this.backupDir);
    if (this.store.getJob(rec.jobId)) {
      this.runner.forget(rec.jobId);
      this.store.removeJob(rec.jobId);
      this.logs.remove(rec.jobId);
    }
    this.records = this.records.filter((r) => r.key !== key);
    this.save();
    // manual: the original has to be switched back on by the user (macOS app agents).
    return { ok: true, manual: Boolean(restored?.manual), name: rec.name };
  }
}
