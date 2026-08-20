/* The support page.
 *
 * Two jobs, both small: keep the theme button working the way it does
 * everywhere else, and let somebody take an address without selecting 42
 * characters of base58 by hand on a phone.
 *
 * No QR codes. Encoding one correctly is a few hundred lines, and a wallet
 * address is the last string on this site to hand to code written in an
 * afternoon -- `user-select: all` on the address plus a copy button covers the
 * phone case, which is the one that matters.
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

/** Put `text` on the clipboard, however this browser allows it.
 *
 *  The async API needs a secure context and a permission some in-app browsers
 *  refuse outright -- and a donation link is opened inside Telegram about as
 *  often as in a real browser -- so the old selection trick stays as the
 *  fallback rather than leaving those visitors with a dead button.
 */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }

  const slot = document.createElement('textarea');
  slot.value = text;
  slot.setAttribute('readonly', '');
  // off-screen rather than hidden: a display:none element cannot be selected,
  // and scrolling the page under the visitor to reach it is worse than either
  slot.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(slot);
  slot.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  slot.remove();
  return ok;
}

for (const button of document.querySelectorAll('.dn-copy')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const done = await copy(source.textContent.trim());

    // The button says what happened rather than a toast saying it elsewhere:
    // the answer belongs next to the thing that was copied.
    const said = button.textContent;
    button.textContent = done ? 'Copied' : 'Select it and copy';
    if (done) button.dataset.done = '';
    setTimeout(() => {
      button.textContent = said;
      delete button.dataset.done;
    }, 1800);
  });
}
