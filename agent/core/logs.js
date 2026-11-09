import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE = 2000;

/**
 * Per-job log, stored as JSON lines so agent messages can be shown in the UI language.
 * Entry: { t: ISO time, lvl: 'SYS'|'OUT'|'ERR', k?: message key, a?: args, msg?: raw text }
 */
export class LogStore {
  constructor(dir, keep = 500) {
    this.dir = dir;
    this.keep = keep;
    this.buffers = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  outFile(id) {
    return path.join(this.dir, `${id}.out.log`);
  }

  load(id) {
    if (this.buffers.has(id)) return this.buffers.get(id);
    let entries = [];
    try {
      const text = fs.readFileSync(this.file(id), 'utf8');
      entries = text.split('\n').filter(Boolean).slice(-this.keep).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { /* no log yet */ }
    this.buffers.set(id, entries);
    return entries;
  }

  append(id, entry) {
    const e = { t: new Date().toISOString(), ...entry };
    if (typeof e.msg === 'string' && e.msg.length > MAX_LINE) e.msg = e.msg.slice(0, MAX_LINE) + '…';
    const buf = this.load(id);
    buf.push(e);
    if (buf.length > this.keep) buf.splice(0, buf.length - this.keep);
    const file = this.file(id);
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.old`);
    } catch { /* first write */ }
    fs.appendFileSync(file, JSON.stringify(e) + '\n');
    return e;
  }

  sys(id, k, a) {
    return this.append(id, a === undefined ? { lvl: 'SYS', k } : { lvl: 'SYS', k, a });
  }

  tail(id, limit = 200) {
    return this.load(id).slice(-limit);
  }

  remove(id) {
    this.buffers.delete(id);
    for (const f of [this.file(id), `${this.file(id)}.old`, this.outFile(id), `${this.outFile(id)}.old`]) {
      try { fs.unlinkSync(f); } catch { /* missing */ }
    }
  }
}
