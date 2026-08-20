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

/** How long ago, in the words a person would use. */
function when(stamp) {
  const at = Date.parse(stamp);
  if (!at) return '—';
  const hours = Math.round((Date.now() - at) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
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
  const figures = [
    [(data.postings || 0).toLocaleString('en-US'), 'postings'],
    [(data.companies || 0).toLocaleString('en-US'), 'companies'],
    [when(data.generated_at), 'updated'],
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
  figures.forEach(([value, label], i) => {
    if (!slots[i]) return;
    slots[i].querySelector('dt').textContent = value;
    slots[i].querySelector('dd').textContent = label;
  });
})();
