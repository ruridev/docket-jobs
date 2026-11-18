import { I18N, LANGS, detectLang } from './i18n.js';

const POLL_MS = 2000;
const state = {
  jobs: [],
  settings: { autoStart: false, autoStartSupported: true },
  online: true,
  view: 'list', // list | detail | settings
  curId: null,
  menuId: null,
  logs: [],
  editId: null,
  delId: null,
  settingsError: false,
  user: '', // the signed-in name, shown in the settings
  // manualKey: the macOS app agent whose "switch it off in System Settings" steps are open.
  // notice: name of an item that was undone but must be switched back on by the user.
  startup: { loading: false, items: [], imported: [], notes: [], error: false, busy: null, manualKey: null, notice: null },
};

// Reading startup items on macOS may wait for a permission prompt.
const STARTUP_TIMEOUT_MS = 45000;
// Import/undo may wait for someone to answer a UAC prompt.
const STARTUP_ACTION_TIMEOUT_MS = 190000;

async function loadStartup() {
  state.startup.loading = true;
  render();
  try {
    const d = await api('GET', '/api/startup', undefined, STARTUP_TIMEOUT_MS);
    Object.assign(state.startup, { items: d.items, imported: d.imported, notes: d.notes, error: false });
  } catch {
    state.startup.error = true;
  }
  state.startup.loading = false;
}

async function startupAction(kind, key) {
  state.startup.busy = key;
  state.startup.error = false;
  state.startup.notice = null;
  render();
  try {
    const r = await api('POST', `/api/startup/${kind}`, { key }, STARTUP_ACTION_TIMEOUT_MS);
    if (kind === 'import') state.startup.manualKey = null;
    if (kind === 'undo' && r.manual) state.startup.notice = r.name;
  } catch (err) {
    // error holds the server's reason code when there is one, so the message can say why.
    state.startup.error = err.data?.error || true;
  }
  state.startup.busy = null;
  const hadError = state.startup.error;
  await loadStartup();
  state.startup.error = hadError || state.startup.error;
}

const $ = (sel) => document.querySelector(sel);
// Display language and theme are kept in this browser only (like docket).
const LANG_KEY = 'docket-jobs-lang';
function savedLang() {
  try {
    const l = localStorage.getItem(LANG_KEY);
    return I18N[l] ? l : null;
  } catch { return null; }
}
let chosenLang = savedLang();
const lang = () => chosenLang || detectLang();
const t = () => I18N[lang()] || I18N.en;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The API token from sign-in, kept in this origin's storage (cookies alone are shared with every localhost port)
const apiToken = () => { try { return localStorage.getItem('docket-token') || '1'; } catch { return '1'; } };
// Signed out, or the cookie is valid but this browser has no token: drop the cookie so the page shows the sign-in form
const signedOut = (header) => fetch('/api/auth/logout', { method: 'POST', headers: { [header]: '1' } }).catch(() => {}).then(() => { location.reload(); return new Promise(() => {}); });

async function api(method, url, body, timeoutMs = 5000) {
  const headers = { 'X-Docket-Jobs': apiToken() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // Without a timeout a hung connection would leave the page showing "Active" forever.
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Signed out (or the session ran out): reloading shows the sign-in page.
  if (res.status === 401) return signedOut('X-Docket-Jobs');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || String(res.status)), { data });
  return data;
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const d = await api('GET', '/api/state');
    state.jobs = d.jobs;
    state.settings = d.settings;
    state.online = true;
    if (state.view === 'detail' && state.curId) {
      if (!state.jobs.some((j) => j.id === state.curId)) state.view = 'list';
      else state.logs = (await api('GET', `/api/jobs/${state.curId}/logs?limit=200`)).entries;
    }
  } catch {
    state.online = false;
  } finally {
    refreshing = false;
  }
  render();
}

/* ---------- rendering ---------- */

const ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
const ICON_BACK = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 2L4 7l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const ICON_DOTS = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="3.5" r="1.6" fill="currentColor"></circle><circle cx="9" cy="9" r="1.6" fill="currentColor"></circle><circle cx="9" cy="14.5" r="1.6" fill="currentColor"></circle></svg>';

function switchBtn(on, label, action, id = '') {
  return `<button class="switch" aria-pressed="${on}" aria-label="${esc(label)}" data-action="${action}" data-id="${esc(id)}"><span class="track"><span class="knob"></span></span></button>`;
}

function runButton(job) {
  const T = t();
  if (job.status === 'running') return `<button class="btn" data-action="stop" data-id="${esc(job.id)}">${esc(T.stop)}</button>`;
  const label = job.status === 'done' || job.status === 'failed' ? T.rerun : T.run;
  return `<button class="btn" data-action="run" data-id="${esc(job.id)}">${esc(label)}</button>`;
}

function statusLine(job, big = false) {
  return `<div class="status ${esc(job.status)}${big ? ' big' : ''}">${esc(t().st[job.status] || job.status)}</div>`;
}

function renderList() {
  const T = t();
  const rows = state.jobs.map((j) => `
    <div class="row">
      ${switchBtn(j.enabled, T.toggleLabel(j.name), 'toggle', j.id)}
      <button class="row-main${j.enabled ? '' : ' off'}" data-action="open" data-id="${esc(j.id)}">
        <div class="row-name">${esc(j.name)}</div>
        ${statusLine(j)}
      </button>
      ${runButton(j)}
      <button class="icon-btn" data-action="menu" data-id="${esc(j.id)}" aria-label="${esc(T.more(j.name))}" aria-expanded="${state.menuId === j.id}">${ICON_DOTS}</button>
      ${state.menuId === j.id ? `<div class="menu" role="menu">
        <button role="menuitem" data-action="edit" data-id="${esc(j.id)}">${esc(T.edit)}</button>
        <button role="menuitem" class="danger" data-action="delete" data-id="${esc(j.id)}">${esc(T.del)}</button>
      </div>` : ''}
    </div>`).join('');

  return `
    <div class="page-head">
      <div><h1>${esc(T.title)}</h1><p class="sub">${esc(T.subtitle)}</p></div>
      <button class="btn primary" data-action="add">${ICON_PLUS}${esc(T.add)}</button>
    </div>
    <div class="card">
      ${rows || `<div class="empty"><div>${esc(T.empty)}</div><button class="btn" data-action="add">${esc(T.emptyAdd)}</button></div>`}
    </div>
    <button class="link-btn" data-action="import">${esc(T.importLink)}</button>`;
}

function renderImport() {
  const T = t();
  const s = state.startup;
  const busy = (key) => (s.busy === key ? ' disabled' : '');
  const nameBlock = (name, hints) => `<div class="grow">
      <div class="row-name">${esc(name)}</div>
      ${hints.length ? `<div class="row-sub">${esc(hints.join(' · '))}</div>` : ''}
    </div>`;
  // macOS app agents: the user switches them off in System Settings, then docket-jobs takes over.
  const manualSteps = (i) => `<div class="manual-steps">
      <p class="note">${esc(T.manualSteps(i.name))}</p>
      <div class="manual-actions">
        <button class="btn" data-action="openLoginSettings">${esc(T.openSettings)}</button>
        <button class="btn primary" data-action="importItem" data-id="${esc(i.key)}"${busy(i.key)}>${esc(T.manualDone)}</button>
        <button class="link-btn" data-action="manualCancel">${esc(T.cancel)}</button>
      </div>
    </div>`;
  const rows = [
    ...s.items.map((i) => {
      const open = i.manual && s.manualKey === i.key;
      const hints = [i.needsAdmin && T.needsAdmin, i.highest && T.losesAdmin, i.allUsers && T.allUsers, i.manual && T.manualHint].filter(Boolean);
      const action = i.manual ? 'manualStart' : 'importItem';
      return `<div class="row">
      ${nameBlock(i.name, hints)}
      ${open ? '' : `<button class="btn" data-action="${action}" data-id="${esc(i.key)}"${busy(i.key)}>${esc(T.importBtn)}</button>`}
    </div>${open ? manualSteps(i) : ''}`;
    }),
    ...s.imported.map((i) => `<div class="row">
      ${nameBlock(i.name, i.needsAdmin ? [T.undoNeedsAdmin] : i.manual ? [T.undoManualHint] : [])}
      <span class="done-label">${esc(T.imported)}</span>
      <button class="link-btn" data-action="undoItem" data-id="${esc(i.key)}"${busy(i.key)}>${esc(T.undo)}</button>
    </div>`),
  ].join('');
  const body = s.loading && !rows
    ? `<div class="empty">${esc(T.loading)}</div>`
    : rows || `<div class="empty">${esc(T.importEmpty)}</div>`;
  const notes = s.notes.map((n) => T.notes[n]).filter(Boolean)
    .map((n) => `<p class="note">${esc(n)}</p>`).join('');
  return `
    <button class="link-btn" data-action="back">${ICON_BACK}${esc(T.back)}</button>
    <div><h1>${esc(T.importTitle)}</h1><p class="sub">${esc(T.importDesc)}</p></div>
    ${s.error ? `<p class="form-error" role="alert">${esc(T.startupErrors[s.error] || T.importError)}</p>` : ''}
    ${s.notice ? `<p class="notice" role="status">${esc(T.undoManual(s.notice))}</p>` : ''}
    <div class="card" aria-busy="${s.loading}">${body}</div>
    ${notes}`;
}

function timeLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString() ? hms : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hms}`;
}

function logText(e) {
  if (!e.k) return e.msg || '';
  const m = t().log[e.k];
  if (typeof m === 'function') return m(...(e.a || []));
  return m || e.k;
}

function renderDetail() {
  const T = t();
  const j = state.jobs.find((x) => x.id === state.curId);
  if (!j) return renderList();
  const info = [[T.kCmd, j.command, true]];
  if (j.cwd) info.push([T.kCwd, j.cwd, true]);
  if (j.delay > 0) info.push([T.kDelay, T.delayV(j.delay)]);
  if (j.restart === '3') info.push([T.kRestart, T.r3]);
  if (j.restart === 'always') info.push([T.kRestart, T.rAlways]);
  if (!j.hidden) info.push([T.kWindow, T.windowShown]);

  const lines = state.logs.map((e) =>
    `<div class="log-line ${esc(e.lvl)}"><span class="t">${esc(timeLabel(e.t))}</span><span class="m">${esc(logText(e))}</span></div>`).join('');

  return `
    <button class="link-btn" data-action="back">${ICON_BACK}${esc(T.back)}</button>
    <div class="detail-head">
      <div><h1>${esc(j.name)}</h1>${statusLine(j, true)}</div>
      ${runButton(j)}
      <button class="btn" data-action="edit" data-id="${esc(j.id)}">${esc(T.edit)}</button>
    </div>
    <dl class="card info">
      ${info.map(([k, v, mono]) => `<div class="info-row"><dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${esc(v)}</dd></div>`).join('')}
    </dl>
    <h2>${esc(T.recentLog)}</h2>
    <div class="log" id="log" tabindex="0">${lines || `<div class="none">${esc(T.noLog)}</div>`}</div>
    <button class="link-btn danger" data-action="delete" data-id="${esc(j.id)}">${esc(T.deleteThis)}</button>`;
}

function renderSettings() {
  const T = t();
  const s = state.settings;
  const langBtns = LANGS.map((l) =>
    `<button lang="${l.code}" aria-pressed="${lang() === l.code}" data-action="lang" data-id="${l.code}">${esc(l.label)}</button>`).join('');
  return `
    <button class="link-btn" data-action="back">${ICON_BACK}${esc(T.back)}</button>
    <h1>${esc(T.settings)}</h1>
    <div class="card">
      <div class="setting">
        <div class="setting-label"><div class="name">${esc(T.language)}</div></div>
        <div class="segmented" role="group" aria-label="${esc(T.language)}">${langBtns}</div>
      </div>
      <div class="setting">
        <div class="setting-label">
          <div class="name">${esc(T.autoStart)}</div>
          <div class="desc">${esc(s.autoStartSupported ? T.autoStartDesc : T.autoStartUnsupported)}</div>
        </div>
        ${s.autoStartSupported ? switchBtn(s.autoStart, T.autoStart, 'autostart') : ''}
      </div>
      ${state.settingsError ? `<p class="inline-error" role="alert">${esc(T.errAutostart)}</p>` : ''}
      <div class="setting stack">
        <div class="setting-label">
          <div class="name" id="themeLabel">${esc(T.theme)}</div>
          <div class="desc">${esc(T.themeDesc)}</div>
        </div>
        <div class="theme-grid" role="radiogroup" aria-labelledby="themeLabel">${themeCards()}</div>
      </div>
      <div class="setting">
        <div class="setting-label">
          <div class="name">${esc(T.account)}</div>
          <div class="desc">${esc(T.signedInAs.replace('{name}', state.user))}</div>
          <div class="desc">${esc(T.resetHelp)} <code>node agent/index.js --reset-password</code></div>
        </div>
        <button class="btn" data-action="signOut">${esc(T.signOut)}</button>
      </div>
    </div>`;
}

const THEME_SAMPLE = { light: 'docket-jobs', dark: 'docket-jobs', green: 'DOCKET-JOBS', g6: '[docket-jobs]' };

function themeCards() {
  const T = t();
  const current = document.documentElement.dataset.theme || '';
  // The system card is split in two halves, too narrow for the full name.
  const part = (k, _, all) => `<span class="tp-part tp-${k}"><span class="tp-bar">${all.length > 1 ? 'docket' : THEME_SAMPLE[k]}</span><span class="tp-body"><span class="tp-ln"><span class="tp-cd"></span><span class="tp-cd"></span></span><span class="tp-pn"><span class="tp-t1"></span><span class="tp-t2"></span><span class="tp-bt"></span></span></span></span>`;
  return [['', ['light', 'dark']], ...window.docketJobsTheme.THEMES.map((k) => [k, [k]])].map(([id, parts]) =>
    `<button class="theme-card" role="radio" aria-checked="${current === id}" data-action="theme" data-id="${id}">
      <span class="tp" aria-hidden="true">${parts.map(part).join('')}</span>
      <span class="tname">${esc(T.themeNames[id || 'auto'])}</span>
    </button>`).join('');
}

let lastHtml = '';
function render() {
  const T = t();
  document.documentElement.lang = lang();
  const status = $('#agentStatus');
  const statusText = state.online ? T.agentRunning : T.agentOffline;
  status.querySelector('.label').textContent = statusText;
  status.title = statusText;
  status.classList.toggle('offline', !state.online);
  document.querySelector('[data-action="settings"]').setAttribute('aria-label', T.settings);

  const html = state.view === 'detail' ? renderDetail()
    : state.view === 'settings' ? renderSettings()
    : state.view === 'import' ? renderImport()
    : renderList();
  if (html !== lastHtml) {
    const view = $('#view');
    const log = $('#log');
    const stick = log && log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    const focusKey = document.activeElement?.closest('#view [data-action]');
    const fk = focusKey ? `${focusKey.dataset.action}|${focusKey.dataset.id || ''}` : null;
    view.innerHTML = html;
    lastHtml = html;
    const newLog = $('#log');
    if (newLog && (stick || !log)) newLog.scrollTop = newLog.scrollHeight;
    if (fk) {
      const [a, id] = fk.split('|');
      const el = [...view.querySelectorAll(`[data-action="${a}"]`)].find((e) => (e.dataset.id || '') === id);
      el?.focus();
    }
  }
}

function applyStaticText() {
  const T = t();
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = T[el.dataset.i18n]; });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = T[el.dataset.i18nPh]; });
}

/* ---------- dialogs ---------- */

function openJobDialog(job) {
  const T = t();
  applyStaticText();
  state.editId = job ? job.id : null;
  const f = $('#jobForm');
  $('#jobDialogTitle').textContent = job ? T.editTitle : T.addTitle;
  f.name.value = job?.name || '';
  f.command.value = job?.command || '';
  f.cwd.value = job?.cwd || '';
  f.delay.value = job?.delay ?? 0;
  f.restart.value = job?.restart || '0';
  f.hidden.checked = job ? job.hidden : true;
  setAdv(false);
  resetPortPicker(!job);
  $('#jobFormError').hidden = true;
  $('#jobDialog').showModal();
  f.name.focus();
}

function setAdv(open) {
  $('#advFields').hidden = !open;
  document.querySelector('[data-action="toggleAdv"]').setAttribute('aria-expanded', String(open));
}

/* Filling a new job from a server that is already running on this PC. */
const ports = { servers: [], seq: 0, autoName: '' };
// Reading the process table goes through PowerShell on Windows, which can take a few seconds.
const PORTS_TIMEOUT_MS = 30000;

function resetPortPicker(show) {
  ports.seq++;
  ports.servers = [];
  ports.autoName = '';
  $('#fromPort').hidden = !show;
  setPortList(false);
  portNote('');
}

function setPortList(open, html = '') {
  const list = $('#portList');
  list.hidden = !open;
  list.innerHTML = html;
  document.querySelector('[data-action="scanPorts"]').setAttribute('aria-expanded', String(open));
}

function portNote(text) {
  const note = $('#portNote');
  note.hidden = !text;
  note.textContent = text;
}

async function scanPorts() {
  const T = t();
  if (!$('#portList').hidden) return setPortList(false);
  const seq = ++ports.seq;
  portNote('');
  setPortList(true, `<p class="note">${esc(T.scanning)}</p>`);
  let servers;
  try {
    servers = (await api('GET', '/api/ports', undefined, PORTS_TIMEOUT_MS)).servers;
  } catch {
    if (seq === ports.seq) setPortList(true, `<p class="note">${esc(T.scanError)}</p>`);
    return;
  }
  if (seq !== ports.seq) return;
  ports.servers = servers;
  setPortList(true, servers.length
    ? servers.map((d, i) => `<button type="button" class="port-pick" data-action="pickPort" data-id="${i}">
        <span class="port mono">:${d.port}</span>
        <span class="ttl">${esc(d.title || T.untitled)}</span>
        <span class="sub2">${esc(d.job ? T.portJob(d.job) : d.proc)}</span>
      </button>`).join('')
    : `<p class="note">${esc(T.noPorts)}</p>`);
}

async function pickPort(i) {
  const T = t();
  const d = ports.servers[Number(i)];
  if (!d) return;
  const f = $('#jobForm');
  const seq = ++ports.seq;
  setPortList(false);
  portNote(T.guessing(d.port));
  let g;
  try {
    g = await api('GET', `/api/ports/${d.port}`, undefined, PORTS_TIMEOUT_MS);
  } catch {
    if (seq === ports.seq) portNote(T.scanError);
    return;
  }
  if (seq !== ports.seq) return;
  if (g.off) return portNote(T.guessOff(d.port));
  // Fill the name only when it is empty or was filled in here before.
  const name = d.title || (g.cwd ? g.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || `:${d.port}`;
  if (!f.name.value.trim() || f.name.value === ports.autoName) { f.name.value = name; ports.autoName = name; }
  if (g.command) f.command.value = g.command;
  if (g.cwd) { f.cwd.value = g.cwd; setAdv(true); }
  const proc = g.proc || d.proc || '?';
  portNote(g.cwd ? T.guessOk(d.port, proc) : T.guessNoCwd(d.port, proc));
}

async function saveJob(e) {
  e.preventDefault();
  const f = $('#jobForm');
  const body = {
    name: f.name.value, command: f.command.value, cwd: f.cwd.value,
    delay: f.delay.value, restart: f.restart.value, hidden: f.hidden.checked,
  };
  const err = $('#jobFormError');
  if (!body.name.trim() || !body.command.trim()) {
    err.textContent = t().errRequired;
    err.hidden = false;
    return;
  }
  try {
    if (state.editId) await api('PUT', `/api/jobs/${state.editId}`, body);
    else await api('POST', '/api/jobs', body);
    $('#jobDialog').close();
    await refresh();
  } catch (ex) {
    err.textContent = ex.data?.error === 'required' ? t().errRequired : t().errGeneric;
    err.hidden = false;
  }
}

function openDeleteDialog(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  applyStaticText();
  state.delId = id;
  $('#delQuestion').textContent = t().delQ(job.name);
  $('#delDialog').showModal();
}

/* ---------- actions ---------- */

const actions = {
  home: (_, e) => { e.preventDefault(); state.view = 'list'; },
  add: () => openJobDialog(null),
  open: (id) => { state.view = 'detail'; state.curId = id; state.logs = []; },
  back: () => { state.view = 'list'; },
  settings: () => {
    state.view = 'settings';
    state.settingsError = false;
    api('GET', '/api/auth').then((d) => { state.user = d.user || ''; render(); }, () => {});
  },
  signOut: async () => { await api('POST', '/api/auth/logout'); location.reload(); },
  import: () => {
    state.view = 'import';
    state.startup.error = false;
    loadStartup().then(render);
  },
  importItem: (key) => startupAction('import', key),
  manualStart: (key) => { state.startup.manualKey = key; state.startup.error = false; state.startup.notice = null; },
  manualCancel: () => { state.startup.manualKey = null; state.startup.error = false; },
  openLoginSettings: () => api('POST', '/api/startup/open-settings'),
  undoItem: (key) => startupAction('undo', key),
  menu: (id) => { state.menuId = state.menuId === id ? null : id; },
  edit: (id) => openJobDialog(state.jobs.find((j) => j.id === id)),
  delete: (id) => openDeleteDialog(id),
  toggleAdv: () => setAdv($('#advFields').hidden),
  scanPorts: () => scanPorts(),
  pickPort: (i) => pickPort(i),
  closeDialog: (_, e) => e.target.closest('dialog').close(),
  toggle: async (id) => {
    const job = state.jobs.find((j) => j.id === id);
    if (job) await api('PUT', `/api/jobs/${id}`, { enabled: !job.enabled });
  },
  run: (id) => api('POST', `/api/jobs/${id}/run`),
  stop: (id) => api('POST', `/api/jobs/${id}/stop`),
  confirmDelete: async () => {
    const id = state.delId;
    $('#delDialog').close();
    if (id) await api('DELETE', `/api/jobs/${id}`);
    if (state.curId === id) state.view = 'list';
  },
  lang: (code) => {
    if (!I18N[code]) return;
    chosenLang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch { /* still applies for this page */ }
  },
  theme: (id = '') => window.docketJobsTheme.apply(id),
  autostart: async () => {
    try {
      const d = await api('PUT', '/api/settings', { autoStart: !state.settings.autoStart });
      state.settings = d.settings;
      state.settingsError = false;
    } catch {
      state.settingsError = true;
    }
  },
};

// Actions that only change this page; after any other one the state is read again.
const LOCAL_ACTIONS = new Set(['add', 'edit', 'delete', 'toggleAdv', 'scanPorts', 'pickPort', 'closeDialog', 'menu', 'home', 'back', 'settings', 'import']);

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (state.menuId && !e.target.closest('.menu')) { state.menuId = null; render(); }
    return;
  }
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  if (name !== 'menu') state.menuId = null;
  try {
    await fn(el.dataset.id, e);
  } catch {
    /* the next refresh shows the real state */
  }
  render();
  if (!LOCAL_ACTIONS.has(name)) await refresh();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.menuId) { state.menuId = null; render(); }
});

$('#jobForm').addEventListener('submit', saveJob);

refresh();
setInterval(refresh, POLL_MS);
