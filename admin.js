/* The numbers, opened in your own browser.
 *
 * There is no analytics server and no admin API to query. A scheduled job seals
 * the figures with AES-256-GCM and drops the file in R2; this page downloads
 * that file and decrypts it here. The passphrase never leaves the tab, so
 * whoever serves this page cannot read the report they are serving.
 *
 * Two halves, and the difference matters:
 *   stats.bin   totals and cohorts, no identity. Public URL, useless without
 *               the passphrase.
 *   people.bin  addresses against skills. Never published: private bucket,
 *               fetched through the Worker, which checks the admin flag.
 *
 * The format is written by jooob/analytics.py and read here, so it is stated in
 * both files in the same words:
 *
 *     "JOOOB1" | salt(16) | iterations(uint32 big-endian) | iv(12) | ciphertext
 */
'use strict';

const THEME_KEY = 'jooob.theme';
const MAGIC = 'JOOOB1';

const $ = (sel) => document.querySelector(sel);

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);   // never innerHTML
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
const num = (n) => Number(n || 0).toLocaleString('en-US');

const state = { api: '', stats: '', pass: '', report: null, kind: 'search' };

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

function say(sel, message, bad = false) {
  const node = $(sel);
  node.textContent = message;
  node.classList.toggle('bad', Boolean(bad));
}

/* ── opening a sealed file ────────────────────────────────────────────── */

/** Decrypt one blob, or throw. GCM authenticates, so a wrong passphrase fails
 *  here rather than handing back plausible rubbish. */
async function unseal(buffer, passphrase) {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.slice(0, MAGIC.length)) !== MAGIC) {
    throw new Error('that file is not a jooob report');
  }

  let at = MAGIC.length;
  const salt = bytes.slice(at, at + 16); at += 16;
  const iterations = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false);
  at += 4;
  const iv = bytes.slice(at, at + 12); at += 12;

  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  // 600,000 rounds takes a visible moment here -- which is the point: the same
  // moment costs anyone who steals the file 600,000 rounds per guess.
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(at));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ── drawing it ───────────────────────────────────────────────────────── */

const LABELS = {
  users: 'accounts', approved_employers: 'employers', pending_employers: 'employers waiting',
  live_postings: 'live postings', pending_postings: 'postings waiting',
  published_reviews: 'reviews live', pending_reviews: 'reviews waiting',
};

function renderTotals(report) {
  const host = $('#totals');
  clear(host);
  for (const [key, label] of Object.entries(LABELS)) {
    const value = (report.totals || {})[key];
    if (value === undefined) continue;
    const waiting = key.includes('pending') && value > 0;
    host.append(el('div', { class: 'stat' }, [
      el('span', { class: `stat-n${waiting ? ' warn' : ''}`, text: num(value) }),
      el('span', { class: 'stat-label', text: label }),
    ]));
  }
  $('#built').textContent = report.generated_at
    ? `Sealed ${String(report.generated_at).replace('T', ' ').slice(0, 16)} UTC` : '';
}

function renderVisits(report) {
  const host = $('#visits');
  clear(host);
  const days = Object.entries(report.visits_by_day || {});
  if (!days.length) {
    host.append(el('p', { class: 'ui-sub', text: 'No visits recorded yet.' }));
    return;
  }
  const peak = Math.max(...days.map(([, n]) => n)) || 1;
  for (const [day, n] of days.slice(-45)) {
    const bar = el('div', { class: 'bar', attrs: { title: `${day}: ${num(n)}` } });
    // an inline height is the one thing that cannot come from the stylesheet:
    // it is the datum itself, not a style choice
    bar.style.height = `${Math.max(3, Math.round((n / peak) * 100))}%`;
    host.append(el('div', { class: 'bar-slot' }, [bar]));
  }
}

function renderTop(report) {
  const kinds = Object.keys(report.top || {}).filter((k) => k !== 'visit');
  const host = $('#top-switch');
  clear(host);
  // with nothing to switch between, the empty control still drew as a stray
  // pill beside the heading
  host.hidden = kinds.length < 2;
  if (!kinds.includes(state.kind)) state.kind = kinds[0] || 'search';
  for (const kind of kinds) {
    const on = kind === state.kind;
    const button = el('button', {
      class: on ? 'seg-btn on' : 'seg-btn', text: kind,
      attrs: { type: 'button', 'aria-pressed': String(on) } });
    button.addEventListener('click', () => { state.kind = kind; renderTop(report); });
    host.append(button);
  }

  const list = $('#top-list');
  clear(list);
  const rows = (report.top || {})[state.kind] || [];
  if (!rows.length) {
    list.append(el('li', { class: 'ui-empty', text: 'Nothing counted yet.' }));
    return;
  }
  const peak = rows[0][1] || 1;
  for (const [key, n] of rows.slice(0, 40)) {
    const fill = el('span', { class: 'rank-fill' });
    fill.style.width = `${Math.round((n / peak) * 100)}%`;
    list.append(el('li', { class: 'rank-row' }, [
      el('span', { class: 'rank-key bidi', text: key, attrs: { dir: 'auto' } }),
      el('span', { class: 'rank-bar' }, [fill]),
      el('span', { class: 'rank-n', text: num(n) }),
    ]));
  }
}

function renderReport(report) {
  state.report = report;
  $('#report').hidden = false;
  $('#unlock-card').hidden = true;
  renderTotals(report);
  renderVisits(report);
  renderTop(report);
}

/* ── the private half ─────────────────────────────────────────────────── */

async function loadPeople() {
  const button = $('#load-people');
  button.disabled = true;
  say('#people-said', 'Fetching…');
  try {
    const response = await fetch(`${state.api.replace(/\/$/, '')}/admin/archive`,
                                { credentials: 'include' });
    // the Worker answers 404 to anyone who is not an admin, so there is no
    // separate "forbidden" to tell apart here
    if (!response.ok) {
      throw new Error(response.status === 404
        ? 'not available — sign in on this browser with an admin account first'
        : `HTTP ${response.status}`);
    }
    const report = await unseal(await response.arrayBuffer(), state.pass);
    const list = $('#people-list');
    clear(list);
    for (const person of report.people || []) {
      list.append(el('li', { class: 'ui-row' }, [
        el('div', { class: 'ui-row-main' }, [
          el('span', { class: 'ui-row-title', text: person.email }),
          el('span', { class: 'ui-row-meta',
                       text: `skills: ${(person.skills || []).join(', ') || '—'}` }),
          el('span', { class: 'ui-row-meta',
                       text: `searched: ${(person.searches || []).join(', ') || '—'}` }),
        ]),
        el('span', { class: 'ui-row-meta',
                     text: String(person.updated_at || '').slice(0, 10) }),
      ]));
    }
    say('#people-said', `${(report.people || []).length} account(s).`);
  } catch (err) {
    say('#people-said', err.message, true);
    button.disabled = false;
  }
}

/* ── boot ─────────────────────────────────────────────────────────────── */

async function unlock(event) {
  event.preventDefault();
  const button = $('#unlock');
  state.pass = $('#pass').value;
  if (!state.stats) {
    say('#unlock-said', 'No sealed report is configured for this deployment yet.', true);
    return;
  }
  button.disabled = true;
  say('#unlock-said', 'Downloading and opening…');
  try {
    const response = await fetch(state.stats, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`could not fetch the report (HTTP ${response.status})`);
    renderReport(await unseal(await response.arrayBuffer(), state.pass));
  } catch (err) {
    // A failed decrypt is overwhelmingly a typo. WebCrypto reports it as an
    // OperationError carrying an *empty* message, so matching on the text alone
    // left the box blank -- the one moment the reader needs to be told anything.
    const wrongKey = err.name === 'OperationError' || !err.message
      || /operation|decrypt/i.test(err.message);
    say('#unlock-said', wrongKey
      ? 'That passphrase did not open the file.' : err.message, true);
    button.disabled = false;
  }
}

async function boot() {
  setTheme(localStorage.getItem(THEME_KEY)
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  $('#theme-btn').addEventListener('click', () => setTheme(
    document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('#unlock-form').addEventListener('submit', unlock);
  $('#load-people').addEventListener('click', loadPeople);

  try {
    const data = await (await fetch('data/jooob.json', { cache: 'no-cache' })).json();
    state.api = (data.api && data.api.url) || '';
    state.stats = (data.api && data.api.stats) || '';
  } catch { /* nothing configured; unlock() says so */ }

  if (!state.stats) {
    say('#unlock-said', 'No sealed report is configured for this deployment yet.');
  }
}

boot();
