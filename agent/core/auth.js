// Sign-in for the one owner of this app: a name and a password, no email (nothing is ever sent
// out, and a forgotten password is reset on this PC). The account is in a 0600 JSON file; a session
// is a cookie signed with a secret from that file, so restarting the server keeps you signed in.
// Browsers send localhost cookies to every port, so the cookie alone is not enough for the API: each
// request also carries a token that the sign-in response gave this page (kept in its own origin's
// localStorage). Creating the account needs a setup code that only this PC's user can read.
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
 * file:   where the account is kept (data/auth.json). The setup code is kept next to it.
 * cookie: the session cookie name. Browsers share localhost cookies across ports, so each app
 *         needs its own name.
 * header: the request header that carries the API token (lower case).
 */
export function createAuth({ file, cookie, header }) {
  const codeFile = path.join(path.dirname(file), 'setup-code');
  let cached = null;
  let cachedAt = -1;
  let fails = 0;
  let trying = false;
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
  const apiToken = (a, session) => mac(a.secret, `api.${session}`);

  /** Sets the session cookie and returns the API token that goes with it. */
  function issue(res, a) {
    const body = `${Buffer.from(a.name).toString('base64url')}.${Date.now() + SESSION_SECONDS * 1000}`;
    const session = `${body}.${mac(a.secret, body)}`;
    res.setHeader('Set-Cookie', `${cookie}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
    return apiToken(a, session);
  }

  // The account and the session cookie value when the cookie is valid, or null.
  function session(req) {
    const a = account();
    const token = a && cookies(req)[cookie];
    if (!token) return null;
    const i = token.lastIndexOf('.');
    const body = token.slice(0, i);
    if (i < 0 || !same(token.slice(i + 1), mac(a.secret, body))) return null;
    const [name, exp] = body.split('.');
    if (!(Number(exp) > Date.now())) return null;
    // Signing out ends every session issued before it
    if (Number(exp) - SESSION_SECONDS * 1000 <= (a.signedOutAt || 0)) return null;
    return Buffer.from(name, 'base64url').toString() === a.name ? { a, token } : null;
  }

  /** The signed-in name from the cookie alone, or null. Enough to pick which page to send. */
  function user(req) {
    return session(req)?.a.name ?? null;
  }

  /** The signed-in name when the request has both the cookie and its API token, or null. */
  function apiUser(req) {
    const s = session(req);
    return s && same(req.headers[header] || '', apiToken(s.a, s.token)) ? s.a.name : null;
  }

  /** The code needed to create the account. Made on first use and kept (0600) until the account exists. */
  function setupCode() {
    try { return fs.readFileSync(codeFile, 'utf8').trim(); } catch { /* not made yet */ }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(codeFile, crypto.randomBytes(6).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // another process made it first
    }
    return fs.readFileSync(codeFile, 'utf8').trim();
  }

  async function setup(res, body) {
    if (account()) return { status: 409, body: { error: 'exists' } };
    if (!same(String(body?.code ?? '').trim().toLowerCase(), setupCode())) return { status: 403, body: { error: 'code' } };
    const c = credentials(body);
    if (c.error) return { status: 400, body: { error: c.error } };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(c.password, salt);
    if (account()) return { status: 409, body: { error: 'exists' } }; // another setup finished first
    const a = { name: c.name, salt, hash, secret: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
    save(a);
    cachedAt = -1;
    try { fs.unlinkSync(codeFile); } catch { /* already gone */ }
    return { status: 200, body: { user: a.name, token: issue(res, a) } };
  }

  async function login(res, body) {
    const a = account();
    if (!a) return { status: 409, body: { error: 'no_account' } };
    const wait = lockedUntil - Date.now();
    if (wait > 0) return { status: 429, body: { error: 'wait', seconds: Math.ceil(wait / 1000) } };
    // One try at a time: tries sent in parallel would all pass the lock check before any of them fails.
    if (trying) return { status: 429, body: { error: 'wait', seconds: 1 } };
    const name = String(body?.name ?? '').trim();
    const password = String(body?.password ?? '').slice(0, MAX_PASSWORD);
    trying = true;
    let hash;
    try {
      hash = await scrypt(password, a.salt);
    } finally {
      trying = false;
    }
    // Check both, always, so a wrong name takes as long as a wrong password.
    const ok = [same(hash, a.hash), same(name, a.name)].every(Boolean);
    if (!ok) {
      fails += 1;
      if (fails >= FREE_TRIES) lockedUntil = Date.now() + Math.min(60_000, 1000 * 2 ** (fails - FREE_TRIES));
      return { status: 401, body: { error: 'wrong' } };
    }
    fails = 0;
    lockedUntil = 0;
    return { status: 200, body: { user: a.name, token: issue(res, a) } };
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
      // With the API token this is you signing out: end every session, not just this cookie.
      // Without it (another port replaying the cookie, or a page that lost its token) only drop the cookie.
      const a = apiUser(req) && account();
      if (a) {
        save({ ...a, signedOutAt: Date.now() });
        cachedAt = -1;
      }
      res.setHeader('Set-Cookie', `${cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return { status: 200, body: { ok: true } };
    }
    return null;
  }

  /** Removes the account (for a forgotten password): the next visit asks to create it again. */
  function reset() {
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  return { user, apiUser, route, reset, setupCode, hasAccount: () => !!account() };
}
