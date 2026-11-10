import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as realPorts from './ports.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * Local API + static UI. The API can start arbitrary commands, so requests from
 * other web pages must never get through:
 *  - only listens on 127.0.0.1
 *  - Host must be 127.0.0.1/localhost (blocks DNS rebinding)
 *  - every API request needs the X-Docket-Jobs header, which a cross-site page cannot send
 *    without a CORS preflight that this server never approves, and a matching Origin when one is sent
 *  - every other API request needs the owner's session (auth: see auth.js); signed out, the
 *    page is the sign-in page
 */
export function createServer({ store, runner, logs, platform, autostartSupported, port, webDir, auth, importer = null, ports = realPorts }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  // The docket portal embeds this UI; nothing else may frame it.
  const frameAncestors = process.env.DOCKET_FRAME_ANCESTORS || "'self' http://localhost:4600 http://127.0.0.1:4600";

  const jobView = (job) => ({ ...job, ...runner.status(job.id) });
  // Display language and theme are kept in the browser; the only server-side setting is
  // whether the OS starts docket-jobs at login.
  const settingsView = () => ({
    autoStart: autostartSupported ? platform.isAutostartEnabled() : false,
    autoStartSupported: autostartSupported,
  });

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const method = req.method;

    if (method === 'GET' && parts[0] === 'state' && parts.length === 1) {
      return send(res, 200, { jobs: store.jobs.map(jobView), settings: settingsView(), platform: process.platform });
    }

    if (parts[0] === 'jobs') {
      if (parts.length === 1 && method === 'POST') {
        const r = store.addJob(await readBody(req));
        if (r.error) return send(res, 400, r);
        return send(res, 201, { job: jobView(r.job) });
      }
      const id = parts[1];
      const job = id && store.getJob(id);
      if (!job) return send(res, 404, { error: 'not_found' });

      if (parts.length === 2 && method === 'PUT') {
        const r = store.updateJob(id, await readBody(req));
        if (r.error) return send(res, 400, r);
        return send(res, 200, { job: jobView(r.job) });
      }
      if (parts.length === 2 && method === 'DELETE') {
        runner.forget(id);
        store.removeJob(id);
        logs.remove(id);
        return send(res, 200, { ok: true });
      }
      if (parts.length === 3 && parts[2] === 'run' && method === 'POST') {
        const r = runner.start(job, 'manual');
        return send(res, r.error && r.error !== 'cwd_missing' ? 409 : 200, { ...r, job: jobView(job) });
      }
      if (parts.length === 3 && parts[2] === 'stop' && method === 'POST') {
        runner.stop(id);
        return send(res, 200, { job: jobView(job) });
      }
      if (parts.length === 3 && parts[2] === 'logs' && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
        return send(res, 200, { entries: logs.tail(id, limit) });
      }
    }

    if (parts[0] === 'startup' && importer) {
      try {
        if (parts.length === 1 && method === 'GET') return send(res, 200, await importer.list());
        if (parts.length === 2 && parts[1] === 'open-settings' && method === 'POST') {
          if (!platform.openStartupSettings) return send(res, 400, { error: 'unsupported' });
          await platform.openStartupSettings();
          return send(res, 200, { ok: true });
        }
        if (parts.length === 2 && method === 'POST' && (parts[1] === 'import' || parts[1] === 'undo')) {
          const { key } = await readBody(req);
          if (typeof key !== 'string') return send(res, 400, { error: 'invalid' });
          const r = parts[1] === 'import' ? await importer.import(key) : await importer.undo(key);
          return send(res, r.error ? (r.error === 'not_found' ? 404 : 409) : 200, r);
        }
      } catch (err) {
        if (err.status) throw err;
        // Known reasons the UI can explain; anything else is reported as a generic failure.
        if (['uac_cancelled', 'admin_failed', 'change_failed', 'still_enabled'].includes(err.code)) return send(res, 409, { error: err.code });
        return send(res, 500, { error: 'startup_failed', detail: String(err.message) });
      }
    }

    // Servers already running on this PC, to make a job from one of them.
    if (parts[0] === 'ports' && method === 'GET') {
      if (parts.length === 1) {
        const jobPids = new Map();
        for (const job of store.jobs) {
          const { pid } = runner.status(job.id);
          if (pid) jobPids.set(pid, job.name);
        }
        return send(res, 200, { servers: await ports.scanServers({ exclude: [port], jobPids }) });
      }
      const p = Number(parts[1]);
      if (parts.length === 2 && Number.isInteger(p) && p > 0 && p < 65536) return send(res, 200, await ports.guessServer(p));
    }

    if (parts[0] === 'settings' && parts.length === 1 && method === 'PUT') {
      const body = await readBody(req);
      if (body.autoStart !== undefined) {
        if (!autostartSupported) return send(res, 400, { error: 'unsupported' });
        try {
          if (body.autoStart) platform.enableAutostart();
          else platform.disableAutostart();
        } catch (err) {
          return send(res, 500, { error: 'autostart_failed', detail: String(err.message) });
        }
      }
      return send(res, 200, { settings: settingsView() });
    }

    return send(res, 404, { error: 'not_found' });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    // Signed out, the app page is the sign-in page (its files are public; the API is not).
    if (rel === '/index.html' && !auth.user(req)) rel = '/login.html';
    const file = path.resolve(webDir, '.' + rel);
    if (!file.startsWith(path.resolve(webDir) + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors ${frameAncestors}`,
      });
      res.end(data);
    });
  }

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden host'); }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.headers['x-docket-jobs'] !== '1' || (origin && !allowedOrigins.has(origin))) {
          return send(res, 403, { error: 'forbidden' });
        }
        const signIn = await auth.route(req, res, url.pathname, () => readBody(req));
        if (signIn) return send(res, signIn.status, signIn.body);
        if (!auth.user(req)) return send(res, 401, { error: 'signin' });
        return await api(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? 'bad_request' : 'internal', detail: String(err.message) });
    }
  });
}
