/* The front door, and the smallest script on the site.
 *
 * Its only job is to put real numbers under the pitch. A landing page that
 * claims coverage without showing any is asking to be taken on faith, and the
 * export counts the figures on its way past -- so they cost one small fetch
 * and no backend at all. It reads landing.json rather than the export itself
 * because the front page needs three numbers and some words, not the corpus.
 *
 * If that fetch fails the em-dashes simply stay: the page is written to be
 * complete without them.
 */
'use strict';

const THEME_KEY = 'jooob.theme';

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

setTheme(localStorage.getItem(THEME_KEY)
  || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

document.querySelector('#theme-btn').addEventListener('click', () => setTheme(
  document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));

/** A number in the digits the reader uses. Persian has its own, and a Persian
 *  sentence with Latin digits in the middle of it reads as machine output --
 *  the same reason the Telegram feed spells its one number in Persian. */
function count(n) {
  const lang = (window.jooobI18n && window.jooobI18n.lang) || 'fa';
  return n.toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US');
}

/** How long ago, in the words a person would use, in their language. */
function when(stamp) {
  const t = (key, values) =>
    (window.jooobI18n ? window.jooobI18n.t(key, values) : String((values || {}).n ?? ''));
  const at = Date.parse(stamp);
  if (!at) return '—';
  const hours = Math.round((Date.now() - at) / 3_600_000);
  if (hours < 1) return t('landing.ago.now');
  if (hours < 24) return t('landing.ago.hours', { n: count(hours) });
  const days = Math.round(hours / 24);
  return days === 1 ? t('landing.ago.yesterday') : t('landing.ago.days', { n: count(days) });
}

(async () => {
  let data;
  try {
    data = await (await fetch('/data/landing.json')).json();
  } catch {
    return;                       // the placeholders stay; nothing else to do
  }

  // Counted by the export, not here. Three figures used to cost the whole
  // corpus -- 1.7 MB, and twelve thousand postings walked to find the live
  // ones -- so the page showed em-dashes until all of it had arrived.
  //
  // Only the values: the labels under them carry data-i18n and belong to the
  // catalogue, so writing them here would overwrite the translation with
  // English a moment after it landed.
  const values = () => [
    count(data.postings || 0),
    count(data.companies || 0),
    when(data.generated_at),
  ];

  // One control, not two. Somebody already signed in has no use for a sign-in
  // link, and somebody signed out has nothing to open -- so the header asks who
  // this is and shows the half that applies. The cookie is HttpOnly, which is
  // what makes this a request rather than a read: one call, only on the front
  // page, and only once the export says there is an API to call at all.
  const api = ((data.api && data.api.url) || '').replace(/\/$/, '');
  const dash = document.querySelector('#dash-btn');
  const signin = document.querySelector('#signin-btn');
  if (api && dash && signin) {
    let known = null;           // null is "could not ask", not "signed out"
    try {
      known = (await fetch(`${api}/me`, { credentials: 'include' })).ok;
    } catch { /* offline, or the API is having a day */ }
    signin.href = `/login?next=${encodeURIComponent(location.href)}`;
    if (known !== null) {
      dash.hidden = !known;
      signin.hidden = known;
      // The dashboard is not a public page any more, so a signed-out visitor is
      // sent to sign in rather than to a page that would only send them back.
      // Every link on the front page, not just the one in the bar: the hero
      // button and the cards all pointed at it too.
      if (!known) {
        const back = encodeURIComponent(new URL('/dashboard', location.href).href);
        for (const link of document.querySelectorAll('a[href="/dashboard"]')) {
          link.href = `/login?next=${back}`;
        }
      }
    }
  }

  const slots = document.querySelectorAll('#figures .lp-figure');
  const show = () => values().forEach((value, i) => {
    if (slots[i]) slots[i].querySelector('dt').textContent = value;
  });
  show();
  // the digits and "3 hours ago" are both language-dependent, so the figures
  // are written again whenever the switch is used
  document.addEventListener('i18n', show);
})();
