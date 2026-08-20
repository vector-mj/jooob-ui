/* Two languages, one catalogue per language, no build step.
 *
 * Farsi is the default and the site's first language: a visitor who has never
 * chosen gets `fa`, whatever their browser advertises. Only an explicit choice
 * from the header switch is remembered, because the alternative -- guessing
 * from Accept-Language -- gets it wrong for exactly the people this site is
 * for, who very often run an English browser and read Persian.
 *
 * The catalogue shape is vue-i18n's, so the same two JSON files carry into the
 * Vue rewrite without being rewritten: nested namespaces, dotted keys, `{n}`
 * for interpolation.
 *
 * Markup contract, both attributes taking a dotted key:
 *   data-i18n="landing.heading"                  -> element's text
 *   data-i18n-attr="content:landing.docTitle"    -> one attribute
 *   data-i18n-attr="aria-label:nav.theme; title:nav.theme"   -> several
 *
 * The HTML ships with English in it, so a page still says something if this
 * script never runs -- but Farsi is what almost everyone sees, so the English
 * in the file is a fallback rather than the design. When the Persian copy is
 * final the baseline should be flipped to Farsi and English become the swap;
 * that removes the one flash of the wrong language on a slow first load.
 */
'use strict';

const LANG_KEY = 'jooob.lang';
const DEFAULT_LANG = 'fa';
const LANGS = ['fa', 'en'];

const cache = new Map();

/** The chosen language, or Farsi. An unknown stored value is not trusted. */
function current() {
  let stored = null;
  try { stored = localStorage.getItem(LANG_KEY); } catch { /* private mode */ }
  return LANGS.includes(stored) ? stored : DEFAULT_LANG;
}

async function catalogue(lang) {
  if (cache.has(lang)) return cache.get(lang);
  const messages = await (await fetch(`/lang/${lang}.json`)).json();
  cache.set(lang, messages);
  return messages;
}

/** `a.b.c` out of a nested object, or null if any step is missing. */
function lookup(messages, key) {
  let at = messages;
  for (const step of key.split('.')) {
    if (at === null || typeof at !== 'object' || !(step in at)) return null;
    at = at[step];
  }
  return typeof at === 'string' ? at : null;
}

/** One string, with `{n}`-style placeholders filled in. */
function translate(messages, key, values) {
  const line = lookup(messages, key);
  if (line === null) return null;
  if (!values) return line;
  return line.replace(/\{(\w+)\}/g, (whole, name) =>
    (name in values ? String(values[name]) : whole));
}

function paint(root, messages) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const line = translate(messages, node.dataset.i18n);
    // a missing key leaves the markup alone rather than blanking it: an
    // untranslated sentence is readable, an empty one is a broken page
    if (line !== null) node.textContent = line;
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) continue;
      const line = translate(messages, key);
      if (line !== null) node.setAttribute(attr, line);
    }
  }
}

/** Everything the page needs to know it is in this language. */
async function apply(lang) {
  const messages = await catalogue(lang);
  const dir = (messages.meta && messages.meta.dir) || 'ltr';
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
  paint(document, messages);

  // the switch offers the language you are not in, which is the only one
  // worth a click, so it is labelled with that one's own name
  const other = LANGS.find((code) => code !== lang);
  const otherName = (await catalogue(other)).meta.name;
  for (const button of document.querySelectorAll('[data-lang-switch]')) {
    button.textContent = otherName;
    button.setAttribute('lang', other);
    button.setAttribute('aria-label', translate(messages, 'nav.language') || 'Switch language');
  }

  window.jooobI18n = {
    lang,
    dir,
    t: (key, values) => translate(messages, key, values) ?? key,
    set,
  };
  document.dispatchEvent(new CustomEvent('i18n', { detail: window.jooobI18n }));
  return window.jooobI18n;
}

async function set(lang) {
  if (!LANGS.includes(lang)) return;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode */ }
  await apply(lang);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-lang-switch]');
  if (!button) return;
  set(LANGS.find((code) => code !== current()));
});

apply(current());
