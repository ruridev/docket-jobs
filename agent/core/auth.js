// Sign-in for the one owner of this app: a name and a password, no email (nothing is ever sent
// out, and a forgotten password is reset on this PC). The account is in a 0600 JSON file; a session
// is a cookie signed with a secret from that file, so restarting the server keeps you signed in.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;
const MAX_NAME = 64;
const SESSION_SECONDS = 30 * 86400;
const FREE_TRIES = 5;

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
});
// Compares without leaking where the strings differ (hashing first makes the lengths equal).
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function credentials(body) {
  const name = String(body?.name ?? '').trim();
  const password = String(body?.password ?? '');
  if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) return { error: 'name' };
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return { error: 'password' };
  return { name, password };
}

/**
 * file:   where the account is kept (data/auth.json)
 * cookie: the session cookie name. Browsers share localhost cookies across ports, so each app
 *         needs its own name.
 */
export function createAuth({ file, cookie }) {
  let cached = null;
  let cachedAt = -1;
  let fails = 0;
  let lockedUntil = 0;

  // Re-read when the file changes, so a reset from the command line applies to a running server.
  function account() {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* no account yet */ }
    if (mtime !== cachedAt) {
      cachedAt = mtime;
      try {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'));
        cached = a && a.name && a.salt && a.hash && a.secret ? a : null;
      } catch { cached = null; }
    }
    return cached;
  }

  function save(a) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const mac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

  function issue(res, a) {
    const body = `${Buffer.from(a.name).toString('base64url')}.${Date.now() + SESSION_SECONDS * 1000}`;
    res.setHeader('Set-Cookie', `${cookie}=${body}.${mac(a.secret, body)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
  }

  /** The signed-in name, or null. */
  function user(req) {
    const a = account();
    const token = a && cookies(req)[cookie];
    if (!token) return null;
    const i = token.lastIndexOf('.');
    const body = token.slice(0, i);
    if (i < 0 || !same(token.slice(i + 1), mac(a.secret, body))) return null;
    const [name, exp] = body.split('.');
    if (!(Number(exp) > Date.now())) return null;
    return Buffer.from(name, 'base64url').toString() === a.name ? a.name : null;
  }

  async function setup(res, body) {
    if (account()) return { status: 409, body: { error: 'exists' } };
    const c = credentials(body);
    if (c.error) return { status: 400, body: { error: c.error } };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(c.password, salt);
    if (account()) return { status: 409, body: { error: 'exists' } }; // another setup finished first
    const a = { name: c.name, salt, hash, secret: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
    save(a);
    cachedAt = -1;
    issue(res, a);
    return { status: 200, body: { user: a.name } };
  }

  async function login(res, body) {
    const a = account();
    if (!a) return { status: 409, body: { error: 'no_account' } };
    const wait = lockedUntil - Date.now();
    if (wait > 0) return { status: 429, body: { error: 'wait', seconds: Math.ceil(wait / 1000) } };
    const name = String(body?.name ?? '').trim();
    const password = String(body?.password ?? '').slice(0, MAX_PASSWORD);
    const hash = await scrypt(password, a.salt);
    // Check both, always, so a wrong name takes as long as a wrong password.
    const ok = [same(hash, a.hash), same(name, a.name)].every(Boolean);
    if (!ok) {
      fails += 1;
      if (fails >= FREE_TRIES) lockedUntil = Date.now() + Math.min(60_000, 1000 * 2 ** (fails - FREE_TRIES));
      return { status: 401, body: { error: 'wrong' } };
    }
    fails = 0;
    lockedUntil = 0;
    issue(res, a);
    return { status: 200, body: { user: a.name } };
  }

  /**
   * Handles /api/auth and /api/auth/{setup,login,logout}. Returns { status, body } (any cookie is
   * already set on res), or null for other paths. readBody() reads the JSON request body.
   */
  async function route(req, res, pathname, readBody) {
    if (pathname === '/api/auth' && req.method === 'GET') return { status: 200, body: { account: !!account(), user: user(req) } };
    if (req.method !== 'POST') return null;
    if (pathname === '/api/auth/setup') return setup(res, await readBody());
    if (pathname === '/api/auth/login') return login(res, await readBody());
    if (pathname === '/api/auth/logout') {
      res.setHeader('Set-Cookie', `${cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return { status: 200, body: { ok: true } };
    }
    return null;
  }

  /** Removes the account (for a forgotten password): the next visit asks to create it again. */
  function reset() {
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  return { user, route, reset, hasAccount: () => !!account() };
}
