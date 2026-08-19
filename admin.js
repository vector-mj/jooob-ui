/* The two things only one account may do: clear the queue, and read the numbers.
 *
 * The queue comes first because it is the one with consequences. Reviews,
 * employer claims and the jobs employers write all arrive at approved=0 and
 * stop there; nothing on this site publishes itself. Approving is what lets a
 * row cross into the store at the next refresh, and turning it down is what
 * keeps it out for good. That half needs only the admin session -- see the note
 * above the queue for why it is deliberately not behind the passphrase.
 *
 * The numbers are the other half. There is no analytics server and no query to
 * run: a scheduled job seals the figures with AES-256-GCM and drops the file in
 * R2; this page downloads that file and decrypts it here. The passphrase never
 * leaves the tab, so whoever serves this page cannot read the report they are
 * serving.
 *
 * Two halves, and neither is published:
 *   stats.bin   totals and cohorts, carrying no identity at all.
 *   people.bin  addresses against skills.
 *
 * Both sit in the private bucket and are fetched through the Worker, which
 * checks the admin flag in the signed session cookie. The aggregate half used
 * to sit at a public address on the argument that ciphertext without identity
 * is safe to publish -- but a published file can be fetched once and attacked
 * offline indefinitely, and its only reader has a session anyway.
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

const state = { api: '', pass: '', report: null, kind: 'search',
                queue: null, counts: {}, tab: 'reviews', touched: false };

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

function say(sel, message, bad = false) {
  const node = $(sel);
  node.textContent = message;
  node.classList.toggle('bad', Boolean(bad));
}

/* ── the queue ────────────────────────────────────────────────────────── */

/* Everything a person has to decide before it reaches the site.
 *
 * This half deliberately needs no passphrase. The passphrase protects the
 * sealed report, which is a different secret for a different job; making
 * moderation wait behind it would mean typing a 43-character key to turn down
 * one piece of spam, and a queue that is tiresome to open is a queue that does
 * not get cleared. The admin session is the whole check here, and the Worker
 * is what enforces it -- this page cannot grant itself anything.
 */

const QUEUES = [
  { key: 'reviews', kind: 'review', label: 'Reviews', id: (row) => row.id },
  { key: 'claims', kind: 'claim', label: 'Employers', id: (row) => row.handle },
  { key: 'postings', kind: 'posting', label: 'Postings', id: (row) => row.id },
];

const bits = (...parts) => parts.filter(Boolean).join(' · ');
const day = (iso) => String(iso || '').slice(0, 10);

/** A 1-5 rating as something readable at a glance, or nothing if unrated. */
const stars = (rating) => {
  const n = Number(rating);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? '★'.repeat(n) + '☆'.repeat(5 - n) : '';
};

const salary = (row) => {
  const low = Number(row.min_salary) || 0;
  const high = Number(row.max_salary) || 0;
  if (!low && !high) return '';
  return `${num(low || high)}${low && high && low !== high ? `–${num(high)}` : ''}`;
};

/** What one waiting thing looks like: enough to decide on without leaving. */
function describe(kind, row) {
  if (kind === 'review') {
    return {
      title: bits(stars(row.rating), row.slug),
      meta: bits(row.source, row.role, row.tenure, day(row.created_at)),
      body: row.body,
    };
  }
  if (kind === 'claim') {
    return {
      title: row.email || row.sub,
      meta: bits(`${row.source}/${row.slug}`,
                 row.domain ? `address at ${row.domain}` : 'no domain on the account',
                 day(row.created_at)),
      body: '',
    };
  }
  return {
    title: row.title,
    meta: bits(row.slug, row.city, row.work_type, row.is_remote ? 'remote' : '',
               row.seniority, salary(row), row.email, day(row.created_at)),
    body: row.description,
  };
}

/** How many are still undecided, across all three lists. */
const waiting = () => QUEUES.reduce((sum, q) => sum + (state.counts[q.kind] || 0), 0);

function tally() {
  const left = waiting();
  say('#queue-said', left
    ? `${num(left)} waiting on a decision.`
    : 'Nothing is waiting. Everything submitted has been decided.');
}

/** Say what a decision was, and offer the other one.
 *
 *  Nothing is removed from the list when it is decided. A row that vanishes on
 *  click leaves nowhere to go when you meant to press the other button, and
 *  since a decision is only a column it can simply be made again.
 */
function settle(node, kind, id, approved) {
  const actions = node.querySelector('.ui-row-actions');
  clear(actions);
  node.classList.add('decided');
  actions.append(el('span', {
    class: approved ? 'pill ok' : 'pill off',
    text: approved ? 'Approved' : 'Turned down',
  }));
  const flip = el('button', {
    class: 'btn ghost sm',
    text: approved ? 'Turn down instead' : 'Approve instead',
    attrs: { type: 'button' },
  });
  flip.addEventListener('click', () => send(node, kind, id, !approved));
  actions.append(flip);
}

/** Post one decision, and reflect it without reloading the list. */
async function send(node, kind, id, approved) {
  const actions = node.querySelector('.ui-row-actions');
  for (const button of actions.querySelectorAll('button')) button.disabled = true;
  try {
    const response = await fetch(`${state.api.replace(/\/$/, '')}/admin/decide`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ids: [id], approved }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // the count is how many are still undecided, so it drops on the first
    // decision about a row and not on changing one's mind about it afterwards
    if (!node.dataset.decided) {
      node.dataset.decided = '1';
      state.counts[kind] = Math.max(0, (state.counts[kind] || 1) - 1);
      renderTabs();
      tally();
    }
    settle(node, kind, id, approved);
  } catch (err) {
    say('#queue-said', `That did not go through: ${err.message}`, true);
    for (const button of actions.querySelectorAll('button')) button.disabled = false;
  }
}

function renderTabs() {
  const host = $('#queue-switch');
  clear(host);
  for (const queue of QUEUES) {
    const n = state.counts[queue.kind] || 0;
    const on = queue.key === state.tab;
    const button = el('button', {
      class: on ? 'seg-btn on' : 'seg-btn',
      text: n ? `${queue.label} ${n}` : queue.label,
      attrs: { type: 'button', 'aria-pressed': String(on) },
    });
    button.addEventListener('click', () => {
      state.tab = queue.key;
      state.touched = true;      // stop choosing a tab for someone who chose one
      renderTabs();
      renderQueue();
    });
    host.append(button);
  }
}

function renderQueue() {
  const list = $('#queue-list');
  clear(list);
  const queue = QUEUES.find((q) => q.key === state.tab) || QUEUES[0];
  const rows = (state.queue || {})[queue.key] || [];

  if (!rows.length) {
    list.append(el('li', { class: 'ui-empty', text: 'Nothing waiting here.' }));
    return;
  }

  for (const row of rows) {
    const id = queue.id(row);
    const { title, meta, body } = describe(queue.kind, row);
    const node = el('li', { class: 'ui-row queue-row' }, [
      el('div', { class: 'ui-row-main' }, [
        el('span', { class: 'ui-row-title bidi', text: title, attrs: { dir: 'auto' } }),
        el('span', { class: 'ui-row-meta', text: meta }),
        body ? el('p', { class: 'queue-body bidi', text: body, attrs: { dir: 'auto' } }) : null,
      ]),
      el('div', { class: 'ui-row-actions' }),
    ]);

    const actions = node.querySelector('.ui-row-actions');
    const yes = el('button', { class: 'btn primary sm', text: 'Approve',
                               attrs: { type: 'button' } });
    const no = el('button', { class: 'btn ghost sm', text: 'Turn down',
                              attrs: { type: 'button' } });
    yes.addEventListener('click', () => send(node, queue.kind, id, true));
    no.addEventListener('click', () => send(node, queue.kind, id, false));
    actions.append(yes, no);
    list.append(node);
  }
}

async function loadQueue() {
  const button = $('#queue-refresh');
  button.disabled = true;
  say('#queue-said', 'Checking…');
  try {
    const response = await fetch(`${state.api.replace(/\/$/, '')}/admin/queue`,
                                 { credentials: 'include' });
    // 401 is "this browser has no session" and signing in fixes it. 404 is what
    // the route says to everyone who is not an admin, because an endpoint that
    // answers "forbidden" has already admitted that it exists.
    if (response.status === 401) {
      location.replace(`/login?next=${encodeURIComponent(location.href)}`);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    state.queue = await response.json();
    state.counts = state.queue.counts || {};
    // open on the list that actually has something in it, so clearing the queue
    // does not begin with two clicks through empty tabs
    const busiest = QUEUES.find((q) => (state.counts[q.kind] || 0) > 0);
    if (busiest && !state.touched) state.tab = busiest.key;
    renderTabs();
    renderQueue();
    tally();
  } catch (err) {
    say('#queue-said', `Could not read the queue: ${err.message}`, true);
  }
  button.disabled = false;
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

/** A way out of the refusal, rather than a number to look up.
 *
 *  The passphrase alone is not enough for this half and is not meant to be: the
 *  private archive needs a session as well, so that reaching it takes both an
 *  admin account and a key only one person holds.
 */
function signInPrompt() {
  const host = $('#people-said');
  if (!host || host.querySelector('a')) return;
  const link = el('a', { class: 'btn ghost', text: 'Sign in',
    attrs: { href: `/login?next=${encodeURIComponent(location.href)}` } });
  host.append(document.createTextNode(' '), link);
}

async function loadPeople() {
  const button = $('#load-people');
  button.disabled = true;
  say('#people-said', 'Fetching…');
  try {
    const response = await fetch(`${state.api.replace(/\/$/, '')}/admin/archive`,
                                { credentials: 'include' });
    // Two different refusals, and the difference matters to whoever is reading
    // it. 401 is "this browser has no session at all", which a sign-in fixes.
    // 404 is what an admin endpoint says to everyone else -- an endpoint that
    // answers "forbidden" has just admitted it exists -- so it also covers an
    // archive that has not been written yet.
    if (response.status === 401) {
      const refused = new Error('not signed in on this browser');
      refused.offerSignIn = true;      // `say` rewrites the line, so the way
      throw refused;                   // out is offered after it, not before
    }
    if (!response.ok) {
      throw new Error(response.status === 404
        ? 'nothing to load: either this account is not an admin, or no archive '
          + 'has been sealed yet'
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
    if (err.offerSignIn) signInPrompt();
    button.disabled = false;
  }
}

/* ── boot ─────────────────────────────────────────────────────────────── */

/** Leave. The cookie is cleared by the Worker that signed it; going home rather
 *  than staying put matters because this page sends a stranger to the door and
 *  would otherwise bounce straight back to it. */
async function signOut() {
  try {
    await fetch(`${state.api.replace(/\/$/, '')}/auth/logout`,
                { method: 'POST', credentials: 'include' });
  } catch { /* already gone */ }
  location.replace('/');
}

async function unlock(event) {
  event.preventDefault();
  const button = $('#unlock');
  state.pass = $('#pass').value;
  if (!state.api) {
    say('#unlock-said', 'No API is configured for this deployment yet.', true);
    return;
  }
  button.disabled = true;
  say('#unlock-said', 'Downloading and opening…');
  try {
    // Behind the admin session, like the person-level half. It used to be a
    // public URL on the argument that ciphertext without identity is safe to
    // publish; but anyone could fetch it once and attack the passphrase offline
    // for as long as they liked, and its only reader has a session anyway.
    const response = await fetch(`${state.api.replace(/\/$/, '')}/admin/stats`,
                                 { credentials: 'include' });
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
  $('#queue-refresh').addEventListener('click', loadQueue);
  $('#signout').addEventListener('click', signOut);

  try {
    const data = await (await fetch('/data/jooob.json', { cache: 'no-cache' })).json();
    state.api = (data.api && data.api.url) || '';
  } catch { /* nothing configured; unlock() says so */ }

  if (!state.api) {
    say('#unlock-said', 'No API is configured for this deployment yet.');
    delete document.documentElement.dataset.gate;
    return;
  }

  // This page is for one account. It carries no secret itself -- the passphrase
  // is typed, never stored -- but leaving it open to everyone invites the one
  // attack the design cannot answer: unlimited guesses at the passphrase. So it
  // asks who this is before painting anything, and a stranger is sent to the
  // door rather than shown a box to guess into.
  let who = null;
  try {
    const response = await fetch(`${state.api.replace(/\/$/, '')}/me`,
                                 { credentials: 'include' });
    who = response.ok ? await response.json() : null;
    if (!who || !who.admin) {
      location.replace(`/login?next=${encodeURIComponent(location.href)}`);
      return;
    }
    // which account the page thinks you are, said out loud. Two Google accounts
    // in one browser is the ordinary case, and "why is the queue empty" and
    // "you are signed in as the other one" look identical without this.
    $('#me').textContent = who.email || '';
  } catch {
    // the API is unreachable, which is not an answer about who this is. There
    // is nothing to show without it either, so say so rather than guess.
    say('#unlock-said', 'Cannot reach the API to check who you are.', true);
  }
  delete document.documentElement.dataset.gate;
  // the queue needs the session that was just checked and nothing else, so
  // it loads straight away rather than waiting for a passphrase
  await loadQueue();
}

boot();
