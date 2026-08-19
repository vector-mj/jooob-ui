/* Sign-in, for both kinds of visitor.
 *
 * There is only one credential in this system -- a Google account -- so this
 * page is mostly explanation. The part worth reading is `nextTarget()`: it
 * decides where somebody lands afterwards, and it will only ever send them to a
 * page on this site.
 */
'use strict';

const THEME_KEY = 'jooob.theme';
const DATA_URL = 'data/jooob.json';

const $ = (sel) => document.querySelector(sel);

const state = { api: '', me: null };

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

function say(message, bad = false) {
  const node = $('#said');
  node.textContent = message || '';
  node.classList.toggle('bad', Boolean(bad));
}

/** Where to go after signing in.
 *
 *  `?next=` comes out of the URL, so it is attacker-controlled: it is resolved
 *  against this origin and rejected if it lands anywhere else. An open redirect
 *  on a sign-in page is exactly how a convincing phishing link gets built.
 */
function nextTarget() {
  const asked = new URLSearchParams(location.search).get('next');
  if (!asked) return 'dashboard.html';
  try {
    const url = new URL(asked, location.href);
    return url.origin === location.origin ? url.href : 'dashboard.html';
  } catch {
    return 'dashboard.html';
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${state.api.replace(/\/$/, '')}${path}`,
                               { credentials: 'include', ...options });
  if (response.status === 204) return {};
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function show() {
  const on = Boolean(state.api);
  $('#offline').hidden = on;
  $('#signed-out').hidden = !on || Boolean(state.me);
  $('#signed-in').hidden = !on || !state.me;
  if (state.me) {
    $('#who-email').textContent = state.me.email;
    const target = nextTarget();
    $('#continue').href = target;
    // somebody with a company claimed came here to post, not to job-hunt
    const employer = (state.me.employers || []).length > 0;
    if (employer && target.endsWith('dashboard.html')) $('#continue').href = 'employer.html';
  }
}

async function boot() {
  setTheme(localStorage.getItem(THEME_KEY)
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  $('#theme-btn').addEventListener('click', () => setTheme(
    document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

  $('#sign-in').addEventListener('click', () => {
    window.location.href = `${state.api.replace(/\/$/, '')}/auth/google`
      + `?next=${encodeURIComponent(nextTarget())}`;
  });

  $('#sign-out').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
    state.me = null;
    say('Signed out.');
    show();
  });

  try {
    const data = await (await fetch(DATA_URL, { cache: 'no-cache' })).json();
    state.api = (data.api && data.api.url) || '';
  } catch {
    state.api = '';
  }

  if (state.api) {
    try {
      state.me = await api('/me');
    } catch {
      state.me = null;                   // not signed in, which is not an error
    }
  }
  show();
}

boot();
