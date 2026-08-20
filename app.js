/* jooob dashboard — static, no API, no sign-in.
 *
 * Three rules run through this file:
 *   1. All data comes from one file: data/jooob.json, written by the
 *      scraper. Every chart is derived from it in the browser, so a filtered
 *      view is the same computation as the unfiltered one.
 *   2. Values are written with textContent, never innerHTML.
 *   3. Nothing is invented. Every number on screen is counted from postings
 *      that were actually collected, and anything capped says so.
 */
'use strict';

const DATA_URL = '/data/jooob.json';

const CDN = {
  g6:        { src: 'https://cdn.jsdelivr.net/npm/@antv/g6@4.8.24/dist/g6.min.js',
               sri: 'sha384-iYoticlq+TpD6YYL4Lx7pZ8jM+Loq+EKfAbFtWUe0d3639XqCkVreQ57oSygxMD1' },
};

const THEME_KEY = 'jooob.theme';
const PAGE_SIZE = 25;
const TOP_N = 50;          // rows in a ranked category list
const HEATMAP_N = 12;      // per heatmap axis; wider grids read as noise
const PAIR_N = 120;        // edges in the co-occurrence graph
const TREND_TOOLS = 8;     // series on the quarterly chart
const TREND_MIN_N = 5;     // a quarter thinner than this swings on one posting
const CITY_MIN_N = 2;      // 40% of cities have exactly one posting
const PAIR_MIN_SUPPORT = 4; // postings a pair needs before it is a pattern
const PAIR_MIN_LIFT = 2;    // ...and how much more often than chance
const DISTINCT_MIN_N = 6;   // a group smaller than this cannot be characterised
const DISTINCT_TERMS = 5;   // terms shown per group
//: joins two values into one map key. NUL can never occur inside either; a
//: space can, and would split "Product Management" in the wrong place.
const SEP = '\u0000';

//: filters the user can reach only by clicking a chart, so each needs a chip
const CLICK_FILTERS = ['tool', 'concept', 'city'];

const ME_KEY = 'jooob.me';
//: how many past searches to keep. Long enough to be a shortcut, short
//: enough that it stays a convenience rather than a record of a job hunt.
const SEARCH_HISTORY = 12;
const DAY = 86400000;
//: 13% of listed postings are more than six months old and the oldest is four
//: years old, because the boards keep them listed. A seeker who finds those
//: stops trusting the rest, so the seeker view defaults to a window.
const FRESH_DEFAULT = 30;
const FRESH_CHOICES = [7, 30, 90, 0];
const GAP_TERMS = 12;      // rows in the skill-gap list
const SIMILAR_N = 6;       // "postings like this one"
const DRAWER_ROWS = 8;     // rows per drawer section

const state = {
  data: null,
  view: 'me',
  filters: { slug: '', family: '', tool: '', concept: '', city: '' },
  jobs: { offset: 0, q: '', mode: 'all', sort: 'create_time', dir: 'desc',
          fresh: FRESH_DEFAULT, remote: false, only: '' },
  //: what the visitor told us about themselves. Kept in localStorage and sent
  //: nowhere -- this site has no backend to send it to, which is also why there
  //: is no account to lose.
  me: { skills: [], saved: [], applied: [], hidden: [], searches: [], seen: '' },
  mine: new Set(),
  conceptCategory: '',
  charts: new Map(),
  graph: null,
  loaded: { g6: false },
};

/* ── tiny helpers ──────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const nf = new Intl.NumberFormat('en');
const num = (n) => nf.format(n ?? 0);

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);   // never innerHTML
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** Persian and Latin in one line reorder unless each run is isolated. */
function bidi(text, cls = 'bidi') {
  return el('span', { class: cls, text: text ?? '—', attrs: { dir: 'auto' } });
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function loadScript({ src, sri }) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    if (sri && !sri.startsWith('SRI_')) { tag.integrity = sri; tag.crossOrigin = 'anonymous'; }
    tag.onload = resolve;
    tag.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(tag);
  });
}

/** The same fold the exporter applies, so the search box matches what was
 *  indexed: Persian has interchangeable code points (arabic vs persian yeh and
 *  kaf) and splits words with a zero-width non-joiner. */
function fold(text) {
  return (text || '').toLowerCase()
    .replace(/\u064a/g, '\u06cc').replace(/\u0643/g, '\u06a9').replace(/\u200c/g, '');
}

/* ── theme ─────────────────────────────────────────────────────────────── */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return {
    text: cssVar('--text'), muted: cssVar('--text-muted'), faint: cssVar('--text-faint'),
    line: cssVar('--line'), surface: cssVar('--surface'), accent: cssVar('--accent'),
    accent2: cssVar('--accent-2'),
    ramp: [0, 1, 2, 3, 4, 5].map((i) => cssVar(`--ramp-${i}`)),
  };
}

function chartBase() {
  const p = palette();
  return {
    textStyle: { fontFamily: 'Vazirmatn, system-ui, sans-serif', color: p.muted },
    animationDuration: prefersReducedMotion() ? 0 : 600,
    animationEasing: 'cubicOut',
    tooltip: {
      backgroundColor: p.surface, borderColor: p.line,
      textStyle: { color: p.text, fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 32px rgba(0,0,0,.32); border-radius: 10px;',
    },
  };
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  $('#theme-toggle').setAttribute('aria-label',
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  // ECharts bakes colours into the instance, so a theme swap means a re-render
  if (state.data) renderAll();
}

/* ── deriving the numbers ──────────────────────────────────── */

/** The search box as resolved tokens. "K8s Python ICS" becomes three of these.
 *
 *  A token that names something we know resolves to its canonical term through
 *  the exported alias index, so "k8s" and "Kubernetes" select the same
 *  postings. A token we do not know still searches, over titles and the exact
 *  spellings each posting used -- and is reported as unresolved, because an
 *  unrecognised term is a gap in the vocabulary rather than an empty result. */
function queryTokens() {
  const vocabulary = state.data.vocabulary || {};
  const words = (state.jobs.q || '').split(/[\s,]+/).filter(Boolean);
  // Many aliases are phrases -- "power bi", "google docs", "high performance
  // liquid chromatography". Resolving word by word can never reach them, and
  // worse, it half-resolves: "Power BI" used to drop "power" and match "bi" as
  // Business intelligence. So take the longest phrase that resolves, then fall
  // back to the single word.
  if (state.vocabPhrase === undefined) {
    state.vocabPhrase = Object.keys(vocabulary)
      .reduce((most, key) => Math.max(most, key.split(' ').length), 1);
  }
  const tokens = [];
  for (let i = 0; i < words.length;) {
    let taken = null;
    for (let n = Math.min(state.vocabPhrase, words.length - i); n >= 1 && !taken; n -= 1) {
      const phrase = words.slice(i, i + n).join(' ');
      const canonical = vocabulary[fold(phrase)];
      if (canonical) { taken = { token: phrase, canonical, words: n }; }
    }
    if (!taken) taken = { token: words[i], canonical: '', words: 1 };
    i += taken.words;
    tokens.push({ token: taken.token, canonical: taken.canonical });
  }
  return tokens;
}

/* ── the visitor ───────────────────────────────────────────────────────────
 *
 * Everything here is one person's own data: the skills they claim, the postings
 * they shortlisted, the ones they never want to see again. It lives in
 * localStorage because there is nowhere else for it to live -- this is a static
 * site -- and that turns out to be the right answer anyway: no sign-in, no
 * server holding a job hunt nobody wants held.
 */

const EMPTY_ME = { skills: [], saved: [], applied: [], hidden: [], searches: [], seen: '' };

function loadMe() {
  try {
    const stored = JSON.parse(localStorage.getItem(ME_KEY) || '{}');
    // trust the shape, not the file: a hand-edited or half-written value must
    // not take the whole dashboard down on boot
    const lists = ['skills', 'saved', 'applied', 'hidden', 'searches'];
    const me = { ...EMPTY_ME };
    for (const key of lists) {
      if (Array.isArray(stored[key])) me[key] = stored[key].filter((v) => typeof v === 'string');
    }
    if (typeof stored.seen === 'string') me.seen = stored.seen;
    // a hand-edited store must not hand the datalist a thousand options
    me.searches = me.searches.slice(0, SEARCH_HISTORY);
    return me;
  } catch {
    return { ...EMPTY_ME };
  }
}

function saveMe() {
  state.mine = new Set(state.me.skills);
  pushProfile();
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(state.me));
  } catch {
    // a full or blocked store is not a reason to stop working; the session
    // keeps its skills in memory and simply forgets them next visit
  }
}

/** Remember a search once it settles, not once per keystroke.

 *  The search box redraws on a 250ms debounce, so recording there would store
 *  "p", "py", "pyt" on the way to "python". A second, longer wait means only
 *  what someone actually stopped on is kept.
 */
const rememberSearch = debounce((term) => {
  if (!recordSearch(term)) return;
  counted('search', term.toLowerCase());
  saveMe();
  renderSearchHistory();
}, 1500);

/** Fold one term into the recent list. Newest first, no duplicates, capped.
 *
 *  Separate from the debounce so the rule is testable without waiting on a
 *  timer: `docs/check.mjs` asserts it directly.
 */
function recordSearch(term, seen = state.me.searches) {
  if (term.length < 2) return false;        // a single letter is a keystroke, not a search
  const at = seen.findIndex((s) => s.toLowerCase() === term.toLowerCase());
  if (at >= 0) seen.splice(at, 1);          // re-searching promotes, never duplicates
  seen.unshift(term);
  seen.length = Math.min(seen.length, SEARCH_HISTORY);
  return true;
}

/** Past searches as native autocomplete, and a way to throw them away.

 *  A <datalist> is the browser's own dropdown: no popup to build, no keyboard
 *  handling to get wrong, and it disappears on browsers that do not support it.
 */
function renderSearchHistory() {
  const list = $('#recent-searches');
  const button = $('#clear-searches');
  if (!list) return;
  clear(list);
  for (const term of state.me.searches) {
    list.append(el('option', { attrs: { value: term } }));
  }
  if (button) button.hidden = !state.me.searches.length;
}


/** A posting's identity, stable across renders and exports. */
function jobKey(job) { return `${job.source}${SEP}${job.slug}${SEP}${job.id}`; }

/** Days since the posting went up, or null when it never said. */
function ageDays(job, now = Date.now()) {
  if (!job.create_time) return null;
  const at = Date.parse(job.create_time);
  return Number.isNaN(at) ? null : Math.floor((now - at) / DAY);
}

/** Everything a posting asks for, tools and concepts alike.
 *
 *  One list, because a seeker does not care which of our two vocabularies a
 *  requirement came out of -- "Kubernetes" and "High availability" are both
 *  things the advert wants.
 */
function requirements(job) { return [...(job.terms || []), ...(job.concepts || [])]; }

/** How much of a posting the visitor already covers, or null if unknowable.
 *
 *  Null rather than zero when the posting names no requirement at all: 12% of
 *  postings have no description we could read, and scoring those 0% would rank
 *  a silent advert below one that genuinely wants nothing you have. "Unknown"
 *  is the honest cell, and the table sorts it last in both directions.
 */
function match(job) {
  const need = requirements(job);
  if (!need.length || !state.mine.size) return null;
  const have = need.filter((term) => state.mine.has(term));
  const missing = need.filter((term) => !state.mine.has(term));
  return { have: have.length, need: need.length, missing,
           pct: Math.round((100 * have.length) / need.length) };
}

/** What to learn next, ranked by how many more postings it would open up.
 *
 *  Only postings the visitor already partly matches are counted. Without that
 *  restriction this is just "most demanded requirement" again, recommending
 *  Sales to a backend engineer because Sales leads the corpus; with it, the
 *  answer is scoped to the jobs they could plausibly get.
 */
function gaps(jobs, { top = GAP_TERMS } = {}) {
  const counts = new Map();
  let considered = 0;
  for (const job of jobs) {
    const scored = match(job);
    if (!scored || !scored.have) continue;
    considered += 1;
    for (const term of scored.missing) counts.set(term, (counts.get(term) || 0) + 1);
  }
  return { considered,
           rows: tally(counts).slice(0, top).map(([key, n]) => ({ key, jobs: n })) };
}

/** Postings that ask for the most of the same things as this one. */
function similar(job, { limit = SIMILAR_N } = {}) {
  const want = new Set(requirements(job));
  if (!want.size) return [];
  const self = jobKey(job);
  const scored = [];
  for (const other of state.data.jobs) {
    if (jobKey(other) === self) continue;
    const shared = requirements(other).filter((term) => want.has(term)).length;
    if (shared) scored.push({ job: other, shared });
  }
  return scored
    .sort((a, b) => b.shared - a.shared
                    || String(a.job.title).localeCompare(String(b.job.title), 'fa'))
    .slice(0, limit);
}

function tokenMatches(job, { token, canonical }) {
  if (canonical) return job.terms.includes(canonical) || job.concepts.includes(canonical);
  return haystack(job).includes(fold(token));
}

/** Postings the current filters select. Every panel counts over this, so a
 *  filtered dashboard is never a mix of scoped and unscoped figures -- which is
 *  why the search box is applied here and not in the jobs table alone. */
function scopedJobs(tokens = queryTokens(), mode = state.jobs.mode) {
  const company = state.filters.slug;
  const { family, tool, concept, city } = state.filters;
  const { fresh, remote, only } = state.jobs;
  const saved = new Set(state.me.saved);
  const applied = new Set(state.me.applied);
  const hidden = new Set(state.me.hidden);
  const now = Date.now();
  const test = mode === 'any'
    ? (job) => tokens.some((t) => tokenMatches(job, t))
    : (job) => tokens.every((t) => tokenMatches(job, t));
  return state.data.jobs.filter((job) => {
    const key = jobKey(job);
    // a posting the visitor dismissed stays gone -- except in the lists where
    // they went looking for their own marks, or it would be unrecoverable
    if (hidden.has(key) && only !== 'hidden') return false;
    if (only === 'saved' && !saved.has(key)) return false;
    if (only === 'applied' && !applied.has(key)) return false;
    if (only === 'hidden' && !hidden.has(key)) return false;
    if (fresh) {
      const age = ageDays(job, now);
      // an undated posting is not evidence of being recent; a window means a
      // window, so it is excluded rather than given the benefit of the doubt
      if (age === null || age > fresh) return false;
    }
    if (remote && !job.is_remote) return false;
    return (!company || companyKey(job) === company)
      && (!family || job.family === family)
      && (!city || job.city === city)
      && (!tool || job.terms.includes(tool))
      && (!concept || job.concepts.includes(concept))
      && (!tokens.length || test(job));
  });
}

/** A count map as [key, n] pairs, most frequent first. Ties break by name so
 *  the order cannot wobble between renders. */
function tally(counts) {
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function rank(jobs, field, { limit = TOP_N, min = 0 } = {}) {
  const counts = new Map();
  for (const job of jobs) {
    const value = job[field];
    if (value === null || value === undefined || value === '') continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const ranked = tally(counts);
  if (!min) return ranked.slice(0, limit).map(([key, n]) => ({ key, jobs: n }));
  // 40% of cities have a single posting. Ranking them is noise, but dropping
  // them would quietly shrink the total, so the tail is collapsed, not cut.
  const kept = ranked.filter(([, n]) => n >= min).slice(0, limit);
  // the tail is everything not kept, which is not the same as everything below
  // `min`: once more than `limit` values clear the minimum, the slice drops the
  // rest, and a tail defined by `min` alone would silently lose them
  const shown = new Set(kept.map(([key]) => key));
  const tail = ranked.filter(([key]) => !shown.has(key));
  const rows = kept.map(([key, n]) => ({ key, jobs: n }));
  if (tail.length) {
    rows.push({ key: `Other (${num(tail.length)})`,
                jobs: tail.reduce((sum, [, n]) => sum + n, 0), unclickable: true });
  }
  return rows;
}

function overview(jobs) {
  const { companies } = state.data;
  const distinct = (field) => new Set(jobs.map((j) => j[field]).filter(Boolean)).size;
  // companyKey folds case, and a company row carries the same source and slug a
  // posting does, so one key works for both sides of the comparison
  const withPostings = new Set(state.data.jobs.map(companyKey));
  const live = new Set(companies.filter((c) => c.live).map(companyKey));
  return {
    jobs: jobs.length,
    companies_known: companies.length,
    companies_live: live.size,
    // coverage describes the whole store, not the current filter
    companies_scraped: withPostings.size,
    // A company scraped while it was live and since dropped from the board's
    // listing keeps the postings already collected, so "has postings" and "is
    // live now" are different populations -- 41 companies deep, at the last
    // count. Dividing one by the other read as 101% coverage, so the coverage
    // figure compares live against live and the retired ones are said out loud.
    companies_live_with_postings: [...live].filter((key) => withPostings.has(key)).length,
    companies_retired: [...withPostings].filter((key) => !live.has(key)).length,
    cities: distinct('city'),
    families: distinct('family'),
    newest: jobs.reduce((max, j) => (j.create_time > max ? j.create_time : max), ''),
  };
}

function bucketDates(jobs, length) {
  const buckets = new Map();
  for (const job of jobs) {
    if (!job.create_time) continue;
    const key = job.create_time.slice(0, length);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function timeline(jobs) {
  return bucketDates(jobs, 7).map(([month, n]) => ({ month, jobs: n }));
}

/** Counts over an extracted list -- `terms` (tools) or `concepts`. `matched` is
 *  the denominator for the rate: postings where extraction found anything at
 *  all, so the share is of postings we could read, not of postings we have. */
function termCounts(jobs, field, { category = '' } = {}) {
  const cats = state.data.concept_categories || {};
  // "Communication" is true of nearly every posting and says nothing; a category
  // lets the standards be read without hiding the soft skills
  const keep = (term) => !category || (cats[term] || 'other') === category;
  const counts = new Map();
  let matchedJobs = 0;
  for (const job of jobs) {
    const terms = job[field].filter(keep);
    if (terms.length) matchedJobs += 1;
    for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  }
  return {
    scanned: jobs.length,
    matched: matchedJobs,
    terms: tally(counts).map(([term, n]) => ({
      term, jobs: n, pct: jobs.length ? Math.round((1000 * n) / jobs.length) / 10 : 0 })),
  };
}

function techMatrix(jobs, field,
                    { limit = HEATMAP_N, rowOrder, share,
                      fields = ['terms', 'concepts'] } = {}) {
  const cells = new Map();
  const groupTotals = new Map();
  const groupHits = new Map();
  const termTotals = new Map();
  for (const job of jobs) {
    const group = job[field];
    if (!group) continue;
    groupTotals.set(group, (groupTotals.get(group) || 0) + 1);
    // tools alone are named by under a third of postings, which left most of
    // this grid empty; concepts are what the other two thirds talk about
    for (const term of new Set(fields.flatMap((f) => job[f] || []))) {
      const key = group + SEP + term;
      cells.set(key, (cells.get(key) || 0) + 1);
      groupHits.set(group, (groupHits.get(group) || 0) + 1);
      termTotals.set(term, (termTotals.get(term) || 0) + 1);
    }
  }
  // rank both axes by demand, then cap: 83 departments x 76 tools is unreadable.
  // groups rank by tool mentions, not headcount -- a large department with no
  // tooling in its ads would otherwise occupy a row of zeros
  // a fixed rowOrder (the seniority ladder) beats ranking by frequency: reading
  // down the ladder is the whole point of that panel
  const rows = rowOrder
    ? rowOrder.filter((group) => groupTotals.has(group)).slice(0, limit)
    : tally(groupHits).slice(0, limit).map(([group]) => group);
  const cols = tally(termTotals).slice(0, limit).map(([term]) => term);
  const rowIndex = new Map(rows.map((group, i) => [group, i]));
  const colIndex = new Map(cols.map((term, i) => [term, i]));
  const matrix = [];
  for (const [key, n] of cells) {
    const [group, term] = key.split(SEP);
    if (rowIndex.has(group) && colIndex.has(term)) {
      // levels run from 95 postings down to 9, so a raw count would only
      // re-state which level is common. Share is comparable across rows.
      const value = share ? Math.round((100 * n) / groupTotals.get(group)) : n;
      matrix.push([rowIndex.get(group), colIndex.get(term), value]);
    }
  }
  return { rows, cols, cells: matrix,
           row_totals: rows.map((group) => groupTotals.get(group)),
           truncated: groupTotals.size > rows.length || termTotals.size > cols.length };
}

/** Which requirements genuinely go together.
 *
 *  Ranking pairs by how often they co-occur just re-states which terms are
 *  common: the top edges were Communication+Reporting and Management+Reporting,
 *  which is true of almost every posting and tells you nothing. Lift asks a
 *  better question -- how much more often than chance -- and answers it with
 *  ArgoCD+Container orchestration and Kafka+RabbitMQ. The support floor is what
 *  stops two terms that appear once, together, from scoring infinitely.
 */
function techPairs(jobs, { minShared = PAIR_MIN_SUPPORT, minLift = PAIR_MIN_LIFT,
                           top = PAIR_N } = {}) {
  const pairs = new Map();
  const nodes = new Map();
  const total = jobs.length || 1;
  for (const job of jobs) {
    const present = [...new Set([...job.terms, ...job.concepts])].sort();
    for (const term of present) nodes.set(term, (nodes.get(term) || 0) + 1);
    for (let a = 0; a < present.length; a += 1) {
      for (let b = a + 1; b < present.length; b += 1) {
        const key = present[a] + SEP + present[b];
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  const scored = [];
  for (const [key, n] of pairs) {
    if (n < minShared) continue;
    const [source, target] = key.split(SEP);
    const lift = (n * total) / ((nodes.get(source) || 1) * (nodes.get(target) || 1));
    if (lift < minLift) continue;
    scored.push({ source, target, value: n, lift: Math.round(lift * 10) / 10 });
  }
  scored.sort((a, b) => b.lift - a.lift || b.value - a.value);
  const links = scored.slice(0, top);
  const linked = new Set();
  for (const link of links) { linked.add(link.source); linked.add(link.target); }
  return { nodes: tally(nodes).filter(([term]) => linked.has(term))
                              .map(([term, n]) => ({ term, jobs: n })),
           links,
           considered: pairs.size,
           dropped: pairs.size - links.length,
           minShared,
           minLift,
           truncated: scored.length > links.length };
}

/** What sets each group apart, rather than what it has most of.
 *
 *  Every department's top requirement is Management or Communication, so a
 *  ranked count compares nothing. This ranks by lift against the whole scoped
 *  corpus, which is how "Technology" comes back as Microservices and Prometheus
 *  instead of Reporting. Terms appearing in a single posting are excluded: one
 *  posting is an anecdote, not a characteristic.
 */
function distinctive(jobs, field, { min = DISTINCT_MIN_N, top = DISTINCT_TERMS,
                                    groups = 8, order = null } = {}) {
  const overall = new Map();
  const byGroup = new Map();
  for (const job of jobs) {
    const terms = new Set([...job.terms, ...job.concepts]);
    for (const term of terms) overall.set(term, (overall.get(term) || 0) + 1);
    const group = job[field];
    if (!group) continue;
    if (!byGroup.has(group)) byGroup.set(group, { n: 0, counts: new Map() });
    const bucket = byGroup.get(group);
    bucket.n += 1;
    for (const term of terms) bucket.counts.set(term, (bucket.counts.get(term) || 0) + 1);
  }
  const total = jobs.length || 1;
  const rows = [];
  for (const [group, bucket] of byGroup) {
    if (bucket.n < min) continue;
    const scored = [];
    for (const [term, n] of bucket.counts) {
      if (n < 2) continue;
      // round first, then judge: a raw 1.04 shown as "1.0x" claims no
      // distinctiveness, so filtering on the raw value puts bars on the chart
      // that their own label contradicts
      const lift = Math.round(((n / bucket.n) / ((overall.get(term) || 1) / total)) * 10) / 10;
      if (lift <= 1) continue;
      scored.push({ term, jobs: n, lift });
    }
    scored.sort((a, b) => b.lift - a.lift || b.jobs - a.jobs);
    if (scored.length) rows.push({ group, n: bucket.n, terms: scored.slice(0, top) });
  }
  // by size, unless the caller has a meaning for the order. A seniority ladder
  // sorted by how many postings each level has is a ranking of the job market;
  // sorted by the ladder it is a description of a career.
  if (order) {
    const place = new Map(order.map((name, at) => [name, at]));
    rows.sort((a, b) => (place.get(a.group) ?? order.length) - (place.get(b.group) ?? order.length)
                        || b.n - a.n);
  } else {
    rows.sort((a, b) => b.n - a.n);
  }
  return { rows: rows.slice(0, groups), considered: byGroup.size,
           shown: Math.min(rows.length, groups), min };
}

/** Share of each quarter's postings naming each of the leading tools.
 *
 *  This is the only view that shows change rather than a snapshot, so it has to
 *  be honest about its edges: thin quarters are dropped, the quarter in progress
 *  is incomplete, and postings deleted before we first scraped are simply absent,
 *  which makes early quarters understate.
 */
function toolTrend(jobs, { tools = TREND_TOOLS, minPostings = TREND_MIN_N } = {}) {
  const byQuarter = new Map();
  for (const job of jobs) {
    if (!job.create_time) continue;
    const quarter = Math.floor((Number(job.create_time.slice(5, 7)) - 1) / 3) + 1;
    const key = `${job.create_time.slice(0, 4)}-Q${quarter}`;
    if (!byQuarter.has(key)) byQuarter.set(key, { q: key, n: 0, counts: new Map() });
    const bucket = byQuarter.get(key);
    bucket.n += 1;
    for (const term of job.terms) bucket.counts.set(term, (bucket.counts.get(term) || 0) + 1);
  }
  const all = [...byQuarter.values()].sort((a, b) => (a.q < b.q ? -1 : 1));
  const quarters = all.filter((b) => b.n >= minPostings);
  const top = termCounts(jobs, 'terms').terms.slice(0, tools).map((t) => t.term);
  return {
    quarters,
    dropped: all.length - quarters.length,
    series: top.map((term) => ({
      term,
      share: quarters.map((b) => Math.round((1000 * (b.counts.get(term) || 0)) / b.n) / 10),
    })),
  };
}

/** Claimed vs stored per company.
 *
 *  The board reports a job count per tenant; we store what we managed to fetch.
 *  The gap is the honest measure of this dataset, and it is large: most live
 *  tenants currently return nothing at all.
 */
function coverage() {
  const stored = new Map();
  for (const job of state.data.jobs) {
    // a posting the board no longer lists is history, not something we hold
    // against what it currently advertises
    if (job.active === 0) continue;
    const key = companyKey(job);
    stored.set(key, (stored.get(key) || 0) + 1);
  }
  const rows = state.data.companies.filter((c) => c.live).map((c) => {
    const have = stored.get(companyKey(c)) || 0;
    const claimed = c.job_count || 0;
    let status = 'complete';
    if (!c.scraped_at) status = 'never scraped';
    else if (!have) status = 'empty';
    else if (have < claimed) status = 'partial';
    return { slug: c.slug, source: c.source, key: companyKey(c),
             name: c.name || c.slug, claimed, stored: have,
             gap: Math.max(0, claimed - have), scraped_at: c.scraped_at, status };
  });
  rows.sort((a, b) => b.gap - a.gap || b.claimed - a.claimed);
  // the panel exists to show where collection is falling short, so it lists the
  // shortfalls. Printing a row per live company was a table of a thousand lines
  // -- and growing, since discovery knows of 5,000 -- in which the handful that
  // actually need attention were invisible.
  const problems = rows.filter((r) => r.status !== 'complete' || r.gap > 0);
  return {
    rows,
    problems,
    claimed: rows.reduce((sum, r) => sum + r.claimed, 0),
    stored: rows.reduce((sum, r) => sum + r.stored, 0),
    empty: rows.filter((r) => r.status === 'empty').length,
    complete: rows.length - problems.length,
    live: rows.length,
  };
}

let nameBySlug = new Map();

/** A company's identity, which is (source, slug) and never slug alone.
 *
 *  The store learned this the hard way -- two boards can issue the same slug,
 *  and keying on less merges two companies into one with no error. Now that a
 *  second board is scraped, the dashboard has to hold the same line: "digipay"
 *  on jobinja is not "digipay" on candoo. */
const COMPANY_SEP = ':';   // a source name and a slug can never contain one, and
                           // unlike NUL it survives a URL without becoming %00
function companyKey(row) {
  return `${row.source}${COMPANY_SEP}${(row.slug || '').toLowerCase()}`;
}
function companyName(key) {
  const known = nameBySlug.get(key);
  if (known) return known;
  const slug = String(key).split(COMPANY_SEP).pop();
  return slug || key;
}

/** Everything a posting can be searched by, folded once and cached on the
 *  record. Descriptions are not in the export, so the tools found in one stand
 *  in for it -- and the placeholder says so rather than implying full text. */
/** Cache the composite company key on each posting once, so it can be ranked
 *  and grouped like any other field. */
function withCompanyKeys(jobs) {
  for (const job of jobs) job.company = companyKey(job);
  return jobs;
}

function haystack(job) {
  if (job.hay === undefined) {
    job.hay = fold([job.title, job.slug, companyName(companyKey(job)), job.department, job.city,
                    job.seniority_level, job.work_type, ...job.terms, ...job.concepts,
                    ...(job.found || [])].filter(Boolean).join(' '));
  }
  return job.hay;
}

/* ── chart plumbing ───────────────────────────────────────── */

function chartOn(id) {
  const node = $(id);
  node.classList.remove('skeleton');
  let instance = state.charts.get(id);
  if (instance) { instance.dispose(); }
  instance = echarts.init(node, null, { renderer: 'canvas' });
  state.charts.set(id, instance);
  return instance;
}

function chartMessage(id, message, isError = false) {
  const node = $(id);
  const existing = state.charts.get(id);
  if (existing) { existing.dispose(); state.charts.delete(id); }
  node.classList.remove('skeleton');
  clear(node);
  node.append(el('div', { class: isError ? 'error-box' : 'empty', text: message }));
}

const resizeAll = debounce(() => {
  for (const chart of state.charts.values()) chart.resize();
  if (state.graph) {
    const box = $('#chart-network');
    state.graph.changeSize(box.clientWidth, box.clientHeight);
  }
}, 160);

/* ── rendering: tables ─────────────────────────────────────────────────── */

function simpleTable(target, columns, rows) {
  const host = $(target);
  clear(host);
  if (!rows.length) { host.append(el('p', { class: 'card-sub', text: 'No data.' })); return; }
  const table = el('table');
  const head = el('tr');
  for (const col of columns) {
    head.append(el('th', { class: col.num ? 'num' : '', text: col.label }));
  }
  table.append(el('thead', {}, head));
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const col of columns) {
      const value = col.get(row);
      // a numeric column may hand over an already-formatted string ("8.3x"),
      // which Intl would turn into NaN. Only actual numbers get formatted.
      const cell = col.num
        ? el('span', { text: typeof value === 'number' ? num(value) : String(value ?? '—') })
        : bidi(value);
      tr.append(el('td', { class: col.num ? 'num' : '' }, cell));
    }
    body.append(tr);
  }
  table.append(body);
  host.append(el('div', { class: 'table-wrap' }, table));
}

/* ── sections ──────────────────────────────────────────────────────────── */

/* ── the visitor's own panels ─────────────────────────────────────────────── */

/** Canonical names the visitor could claim, for the skills box. */
function skillNames() {
  if (!state.skillList) {
    state.skillList = [...new Set(Object.values(state.data.vocabulary || {}))].sort();
  }
  return state.skillList;
}

function toggleSkill(name) {
  const at = state.me.skills.indexOf(name);
  if (at >= 0) state.me.skills.splice(at, 1);
  else { state.me.skills.push(name); counted('skill', name); }
  state.me.skills.sort();
  saveMe();
  skeletons();
  renderAll();
}

/** Resolve what was typed to a canonical requirement, the same way search does.
 *  Typing "k8s" must add Kubernetes, not a skill called "k8s" that matches
 *  nothing -- a skill list that silently matches nothing is worse than empty. */
function addTypedSkill(text) {
  const wanted = fold(String(text || '').trim());
  if (!wanted) return null;
  const canonical = (state.data.vocabulary || {})[wanted];
  if (canonical) {
    if (!state.mine.has(canonical)) toggleSkill(canonical);
    return canonical;
  }
  return null;
}

function renderSkills() {
  const host = $('#my-skills');
  if (!host) return;
  clear(host);
  if (!state.me.skills.length) {
    host.append(el('span', { class: 'card-sub',
      text: 'No skills yet — add a few and every panel below re-scopes to you.' }));
    return;
  }
  for (const name of state.me.skills) {
    const chip = el('button', { class: 'term-chip skill-chip', attrs: { type: 'button' } },
                     [bidi(name)]);
    chip.setAttribute('title', `Remove ${name}`);
    chip.append(el('span', { class: 'chip-x', attrs: { 'aria-hidden': 'true' }, text: '×' }));
    chip.setAttribute('aria-label', `Remove ${name} from your skills`);
    chip.addEventListener('click', () => toggleSkill(name));
    host.append(chip);
  }
  const clearAll = el('button', { class: 'link-btn', text: 'clear all',
                                  attrs: { type: 'button' } });
  clearAll.addEventListener('click', () => {
    state.me.skills = [];
    saveMe();
    skeletons();
    renderAll();
  });
  host.append(clearAll);
}

/** The seeker's own figures. Deliberately not the market's: "1,899 postings in
 *  Tehran" is trivia to someone deciding what to apply for tonight. */
function renderMine(jobs) {
  const host = $('#my-kpis');
  if (!host) return;
  clear(host);
  const scored = jobs.map((job) => match(job)).filter(Boolean);
  const strong = scored.filter((m) => m.pct >= 50).length;
  const fresh = jobs.filter((job) => {
    const age = ageDays(job);
    return age !== null && age <= 7;
  }).length;
  const since = state.me.seen
    ? jobs.filter((job) => (job.create_time || '') > state.me.seen).length : null;
  const cells = [
    { value: num(jobs.length), label: 'Postings in scope' },
    { value: state.mine.size ? num(strong) : '—',
      label: state.mine.size ? 'Match half or more' : 'Add skills to match' },
    { value: num(fresh), label: 'Posted this week' },
    { value: num(state.me.saved.length), label: 'Saved' },
  ];
  if (since !== null) cells.push({ value: num(since), label: 'New since your last visit' });
  for (const cell of cells) {
    const box = el('div', { class: 'kpi' });
    box.append(el('div', { class: 'kpi-value', text: cell.value }));
    box.append(el('div', { class: 'kpi-label', text: cell.label }));
    host.append(box);
  }
}

/** What to learn next. The one thing this corpus can tell a person that no
 *  single job advert can. */
function renderGap(jobs) {
  const chart = '#chart-gap';
  const sub = $('#sub-gap');
  if (!state.mine.size) {
    chartMessage(chart, 'Add your skills above, and this ranks what to learn next.');
    if (sub) sub.textContent = 'Needs your skills first.';
    clear($('#table-gap'));
    return;
  }
  const found = gaps(jobs);
  if (!found.rows.length) {
    chartMessage(chart, found.considered
      ? 'Nothing missing — every posting you partly match asks only for what you have.'
      : 'No posting in scope asks for anything you listed. Try widening the filters.');
    if (sub) sub.textContent = `${num(found.considered)} postings partly match you.`;
    clear($('#table-gap'));
    return;
  }
  const p = palette();
  barChart(chart, found.rows.map((row) => ({ term: row.key, jobs: row.jobs })), {
    labelKey: 'term', valueKey: 'jobs', colorPair: [p.accent, p.accent2],
    filter: null });
  const chartRef = state.charts.get(chart);
  if (chartRef && chartRef.on) {
    chartRef.on('click', (event) => { if (event.name) openTerm(event.name); });
  }
  if (sub) {
    sub.textContent = `postings you already partly match, that also ask for this · `
      + `counted over the ${num(found.considered)} postings in scope sharing at least `
      + `one of your skills`;
  }
  simpleTable('#table-gap', [
    { label: 'Missing requirement', get: (r) => r.key },
    { label: 'Postings it would open', num: true, get: (r) => r.jobs },
  ], found.rows);
}

function renderKpis(stats) {
  const host = $('#kpis');
  clear(host);
  // No percentage here. The fraction already says what share is covered, and
  // 3,838 of 3,853 rounds to "100%", which would claim a completeness the
  // numbers do not have -- the same overstatement in the other direction.
  const retired = stats.companies_retired;
  const cards = [
    { value: num(stats.jobs), label: 'Postings stored' },
    { value: num(stats.companies_live), label: 'Live companies',
      note: `${num(stats.companies_known)} known in total` },
    { value: `${num(stats.companies_live_with_postings)}/${num(stats.companies_live)}`,
      label: 'Companies with postings',
      note: retired
        ? `live tenants · ${num(retired)} more delisted since we collected theirs`
        : 'live tenants' },
    { value: num(stats.families), label: 'Job families' },
    { value: num(stats.cities), label: 'Cities' },
    { value: stats.newest ? stats.newest.slice(0, 10) : '—', label: 'Newest posting' },
  ];
  cards.forEach((card, i) => {
    const node = el('div', { class: 'kpi' }, [
      el('div', { class: 'kpi-value', text: card.value }),
      el('div', { class: 'kpi-label', text: card.label }),
      card.note ? el('div', { class: 'kpi-note', text: card.note }) : null,
    ]);
    node.style.animationDelay = `${i * 40}ms`;
    host.append(node);
  });
}

function barChart(id, rows, { labelKey, valueKey, colorPair, filter }) {
  if (!rows.length) { chartMessage(id, 'Nothing to show yet.'); return; }
  const p = palette();
  const data = rows.slice().reverse();              // ECharts draws category axis bottom-up
  chartOn(id).setOption({
    ...chartBase(),
    grid: { left: 8, right: 28, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.faint } },
    yAxis: {
      type: 'category',
      data: data.map((r) => String(r[labelKey] ?? '—')),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: p.muted, width: 150, overflow: 'truncate' },
    },
    tooltip: { ...chartBase().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
    series: [{
      type: 'bar',
      data: data.map((r) => r[valueKey]),
      barMaxWidth: 18,
      itemStyle: {
        borderRadius: [0, 6, 6, 0],
        color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
          { offset: 0, color: colorPair[0] }, { offset: 1, color: colorPair[1] },
        ]),
      },
      label: { show: true, position: 'right', color: p.faint, fontSize: 11,
               formatter: (d) => num(d.value) },
    }],
  });
  if (!filter) return;
  // the label is not the filter value -- company bars are labelled by name and
  // filtered by slug -- so resolve through the row, never through params.name
  state.charts.get(id).on('click', (params) => {
    const row = data[params.dataIndex];
    if (!row || row.unclickable) return;
    setFilter(filter, String(row.key ?? row[labelKey]));
  });
}

function renderExtracted(kind, data, { chart, table, sub, label, colorPair, filter }) {
  const rate = data.scanned ? Math.round((100 * data.matched) / data.scanned) : 0;
  $(sub).textContent =
    `${num(data.terms.length)} ${kind} found in ${num(data.matched)} of `
    + `${num(data.scanned)} postings (${rate}%)`;
  barChart(chart, data.terms.slice(0, 14),
           { labelKey: 'term', valueKey: 'jobs', colorPair, filter });
  simpleTable(table, [
    { label, get: (r) => r.term },
    { label: 'Postings', num: true, get: (r) => r.jobs },
    { label: 'Share %', num: true, get: (r) => r.pct },
  ], data.terms.slice(0, 40));
}

function renderCompanies(byCompany) {
  const rows = byCompany.slice(0, 14)
    .map((r) => ({ label: companyName(r.key), key: r.key, jobs: r.jobs }));
  $('#sub-company').textContent = `${num(byCompany.length)} companies with postings`;
  const p = palette();
  barChart('#chart-company', rows, { labelKey: 'label', valueKey: 'jobs',
                                     colorPair: [p.accent, p.accent2], filter: 'slug' });
  simpleTable('#table-company', [
    { label: 'Company', get: (r) => r.label },
    { label: 'Postings', num: true, get: (r) => r.jobs },
  ], rows);
}

function renderCity(byCity) {
  const p = palette();
  const tail = byCity.find((r) => r.unclickable);
  $('#sub-city').textContent = tail
    ? `${num(byCity.length - 1)} cities shown, the rest grouped`
    : `${num(byCity.length)} cities`;
  barChart('#chart-city', byCity.slice(0, 12), { labelKey: 'key', valueKey: 'jobs',
                                                 colorPair: [p.ramp[2], p.ramp[4]],
                                                 filter: 'city' });
}

function renderTimeline(timeline) {
  if (!timeline.length) { chartMessage('#chart-timeline', 'No dated postings.'); return; }
  const p = palette();
  chartOn('#chart-timeline').setOption({
    ...chartBase(),
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: { ...chartBase().tooltip, trigger: 'axis' },
    xAxis: { type: 'category', data: timeline.map((r) => r.month), boundaryGap: false,
             axisLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.faint } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.faint } },
    series: [{
      type: 'line', smooth: true, symbolSize: 6,
      data: timeline.map((r) => r.jobs),
      lineStyle: { width: 3, color: p.accent },
      itemStyle: { color: p.accent },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: p.accent + '55' }, { offset: 1, color: p.accent + '00' },
        ]),
      },
    }],
  });
}

function renderTrend(trend) {
  if (trend.quarters.length < 2) {
    chartMessage('#chart-trend', 'Not enough dated postings yet to show a trend.');
    return;
  }
  const p = palette();
  const last = trend.quarters[trend.quarters.length - 1];
  const stamp = state.data.generated_at;
  const current = `${stamp.slice(0, 4)}-Q${Math.floor((Number(stamp.slice(5, 7)) - 1) / 3) + 1}`;
  const partial = last.q === current;
  $('#sub-trend').textContent =
    'share of each quarter\u2019s postings naming the tool · n per quarter: '
    + trend.quarters.map((b) => `${b.q} ${num(b.n)}`).join(', ')
    + (trend.dropped ? ` · ${num(trend.dropped)} thinner quarters dropped` : '')
    + (partial ? ` · ${current} still in progress` : '')
    + ' · postings removed before we first scraped are absent, so early quarters understate';
  chartOn('#chart-trend').setOption({
    ...chartBase(),
    grid: { left: 8, right: 24, top: 34, bottom: 8, containLabel: true },
    tooltip: { ...chartBase().tooltip, trigger: 'axis', valueFormatter: (v) => `${v}%` },
    legend: { type: 'scroll', left: 0, top: 0,
              textStyle: { color: p.muted, fontSize: 11 }, inactiveColor: p.faint },
    xAxis: { type: 'category', data: trend.quarters.map((b) => b.q), boundaryGap: false,
             axisLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.faint } },
    yAxis: { type: 'value', axisLabel: { color: p.faint, formatter: '{value}%' },
             splitLine: { lineStyle: { color: p.line } } },
    series: trend.series.map((line, i) => ({
      type: 'line', name: line.term, data: line.share, smooth: true, symbolSize: 5,
      lineStyle: { width: 2, color: p.ramp[(i % 5) + 1] },
      itemStyle: { color: p.ramp[(i % 5) + 1] },
      // shade the quarter in progress: it is not comparable to the finished ones
      markArea: partial && i === 0
        ? { silent: true, itemStyle: { color: p.line, opacity: .45 },
            data: [[{ xAxis: last.q }, { xAxis: last.q }]] }
        : undefined,
    })),
  });
}

function renderHeatmap(matrix, { chart, table, rowLabel }) {
  if (!matrix.cells.length) {
    chartMessage(chart, 'Nothing extracted to group here yet.');
    return;
  }
  const p = palette();
  const peak = Math.max(...matrix.cells.map((c) => c[2]));
  const unit = matrix.share ? '%' : '';
  const label = (i) => `${matrix.rows[i]} (${num(matrix.row_totals[i])})`;
  chartOn(chart).setOption({
    ...chartBase(),
    grid: { left: 8, right: 12, top: 8, bottom: 60, containLabel: true },
    tooltip: { ...chartBase().tooltip,
      formatter: (d) =>
        `${label(d.value[1])}<br>${matrix.cols[d.value[0]]}: <b>${num(d.value[2])}${unit}</b>` },
    xAxis: { type: 'category', data: matrix.cols, splitArea: { show: false },
             axisLabel: { color: p.faint, rotate: 45, fontSize: 10 }, axisLine: { lineStyle: { color: p.line } } },
    yAxis: { type: 'category', data: matrix.rows.map((_, i) => label(i)),
             splitArea: { show: false },
             axisLabel: { color: p.muted, width: 130, overflow: 'truncate', fontSize: 11 },
             axisLine: { lineStyle: { color: p.line } } },
    visualMap: { min: 0, max: peak, calculable: true, orient: 'horizontal',
                 left: 'center', bottom: 0, itemHeight: 90,
                 textStyle: { color: p.faint }, inRange: { color: p.ramp } },
    series: [{
      type: 'heatmap',
      data: matrix.cells.map(([r, c, v]) => [c, r, v]),
      label: { show: true, color: p.text, fontSize: 10,
               formatter: (d) => (d.value[2] ? d.value[2] + unit : '') },
      itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,.4)' } },
    }],
  });
  const rowTable = matrix.rows.map((name, i) => ({ name, jobs: matrix.row_totals[i] }));
  simpleTable(table, [
    { label: rowLabel, get: (r) => r.name },
    { label: 'Postings', num: true, get: (r) => r.jobs },
  ], rowTable);
}

/** Lift by group, as one bar per group/term pair.
 *
 *  Lift is labelled "×" and never as a count, because it is a ratio: 8.3× means
 *  Technology postings name Microservices 8.3 times as often as postings in
 *  general, not that 8 of them do. The posting count rides along on the tooltip
 *  and the table so the ratio can always be checked against its denominator. */
function renderDistinctive(data, {
  chart: chartId = '#chart-distinctive',
  table = '#table-distinctive', sub = '#sub-distinctive',
  noun = 'group', empty = 'Not enough postings per group yet.',
} = {}) {
  const rows = [];
  for (const group of data.rows) {
    for (const term of group.terms) {
      rows.push({ group: group.group, groupN: group.n, term: term.term,
                  label: `${group.group} · ${term.term}`, lift: term.lift, jobs: term.jobs });
    }
  }
  simpleTable(table, [
    { label: noun === 'group' ? 'Group' : 'Level', get: (r) => r.group },
    { label: 'Requirement', get: (r) => r.term },
    { label: 'Postings', num: true, get: (r) => r.jobs },
    { label: 'vs corpus', num: true, get: (r) => `${r.lift}×` },
  ], rows);

  $(sub).textContent = data.rows.length
    ? `how much more often than average each ${noun} asks for a requirement · `
      + `${num(data.shown)} of ${num(data.considered)} ${noun}s with at least `
      + `${data.min} postings · n shown on each label`
    : `no ${noun} has enough postings yet to characterise`;
  if (!rows.length) { chartMessage(chartId, empty); return; }

  const p = palette();
  const groups = [...new Set(rows.map((r) => r.group))];
  const colour = (g) => p.ramp[(groups.indexOf(g) % (p.ramp.length - 1)) + 1];
  const data2 = rows.slice().reverse();
  // chartOn disposes and re-creates, so it is called once and held: calling it
  // again would throw away the options just set
  const chart = chartOn(chartId);
  chart.setOption({
    ...chartBase(),
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...chartBase().tooltip, trigger: 'item',
      formatter: (i) => {
        const r = data2[i.dataIndex];
        return `${r.group} (n=${num(r.groupN)})<br/>${r.term}: ${num(r.jobs)} postings`
             + `<br/><b>${r.lift}×</b> the corpus rate`;
      } },
    xAxis: { type: 'value', name: '× vs corpus', nameLocation: 'end',
             nameTextStyle: { color: p.faint },
             splitLine: { lineStyle: { color: p.line } },
             axisLabel: { color: p.faint, formatter: (v) => `${v}×` } },
    yAxis: { type: 'category',
             data: data2.map((r) => `${r.label} (n=${r.jobs})`),
             axisLine: { show: false }, axisTick: { show: false },
             axisLabel: { color: p.muted, width: 230, overflow: 'truncate' } },
    series: [{ type: 'bar', data: data2.map((r) => r.lift),
               itemStyle: { color: (i) => colour(data2[i.dataIndex].group),
                            borderRadius: [0, 4, 4, 0] },
               barMaxWidth: 16 }],
  }, true);
  chart.on('click', (params) => {
    const row = data2[params.dataIndex];
    if (row) setFilter(field2Filter(row.term), row.term);
  });
}

/** A term belongs to whichever vocabulary claims it; tools filter as tools. */
function field2Filter(term) {
  return state.data.jobs.some((j) => j.terms.includes(term)) ? 'tool' : 'concept';
}

/** The category chip row above the concepts chart. */
function renderCategories(jobs) {
  const host = $('#concept-categories');
  if (!host) return;
  clear(host);
  const cats = state.data.concept_categories || {};
  const counts = new Map();
  for (const job of jobs) {
    for (const term of new Set(job.concepts)) {
      const cat = cats[term] || 'other';
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
  }
  const options = [['', 'All'], ...tally(counts).map(([c]) => [c, c])];
  for (const [value, label] of options) {
    const on = state.conceptCategory === value;
    const chip = el('button', {
      class: on ? 'cat-chip cat-on' : 'cat-chip',
      attrs: { type: 'button', 'aria-pressed': String(on) },
      text: value ? `${label} (${num(counts.get(value) || 0)})` : label });
    chip.addEventListener('click', () => setCategory(value));
    host.append(chip);
  }
}

async function renderNetwork(graph) {
  simpleTable('#table-network', [
    { label: 'Requirement', get: (r) => r.source },
    { label: 'Paired with', get: (r) => r.target },
    { label: 'Shared postings', num: true, get: (r) => r.value },
    { label: 'vs chance', num: true, get: (r) => `${r.lift}×` },
  ], graph.links.slice(0, 60));

  const host = $('#chart-network');
  if (!graph.links.length) { chartMessage('#chart-network', 'Not enough co-occurrence yet.'); return; }
  $('#sub-network').textContent =
    `${num(graph.nodes.length)} requirements · ${num(graph.links.length)} pairings, `
    + 'ranked by how much more often than chance they appear together · '
    + `needs ${graph.minShared}+ shared postings and ${graph.minLift}× lift, `
    + `which drops ${num(graph.dropped)} of ${num(graph.considered)} pairs`
    + (graph.truncated ? ' (strongest shown)' : '') + ' · drag to explore';

  if (!state.loaded.g6) {
    try { await loadScript(CDN.g6); state.loaded.g6 = true; }
    catch { chartMessage('#chart-network', 'Graph library unavailable — see the table below.', true); return; }
  }

  host.classList.remove('skeleton');
  // destroy before clearing: G6 removes its own canvas from the container, and
  // emptying it first leaves destroy() with nothing to detach
  if (state.graph) { state.graph.destroy(); state.graph = null; }
  clear(host);

  const p = palette();
  const maxJobs = Math.max(...graph.nodes.map((n) => n.jobs));
  const maxLink = Math.max(...graph.links.map((l) => l.value));
  const data = {
    nodes: graph.nodes.map((n) => ({
      id: n.term, label: n.term, jobs: n.jobs,
      size: 16 + (n.jobs / maxJobs) * 40,
    })),
    edges: graph.links.map((l) => ({
      source: l.source, target: l.target, value: l.value,
      size: 0.6 + (l.value / maxLink) * 4,
    })),
  };

  state.graph = new G6.Graph({
    container: host,
    width: host.clientWidth,
    height: host.clientHeight,
    fitView: true,
    fitViewPadding: 24,
    layout: {
      type: 'force', preventOverlap: true, nodeSpacing: 18,
      linkDistance: (e) => 220 - (e.value / maxLink) * 130,   // tighter when shared more often
      edgeStrength: 0.4, nodeStrength: -90, alphaDecay: 0.03,
    },
    modes: { default: ['drag-canvas', 'zoom-canvas', 'drag-node'] },
    defaultNode: {
      type: 'circle',
      style: { fill: p.accent + '26', stroke: p.accent, lineWidth: 1.6 },
      labelCfg: { style: { fill: p.text, fontSize: 12, fontFamily: 'Vazirmatn, sans-serif' } },
    },
    defaultEdge: {
      type: 'line',
      style: { stroke: p.line, opacity: .75, endArrow: false },
    },
    nodeStateStyles: { hover: { fill: p.accent + '55', lineWidth: 2.4 } },
  });
  state.graph.data(data);
  state.graph.render();
  state.graph.on('node:mouseenter', (e) => state.graph.setItemState(e.item, 'hover', true));
  state.graph.on('node:mouseleave', (e) => state.graph.setItemState(e.item, 'hover', false));
  state.graph.on('node:click', (e) => setFilter('tool', e.item.getModel().id));
}

/* ── jobs table ────────────────────────────────────────────────────────── */

/** The postings table's columns, in order.
 *
 *  `get` is both what the cell shows and what the column sorts by, so a column
 *  can never sort by something other than what it displays. `text: false` marks
 *  a numeric sort; everything else compares as Persian-collated text, since
 *  most titles, departments and cities are Persian.
 */
const JOB_COLUMNS = [
  // match leads, because "which of these should I read" is the only question a
  // seeker brings. It is null until skills are entered, and sorts last then.
  { key: 'match', label: 'Match', text: false, get: (j) => (match(j) || {}).pct ?? null },
  { key: 'title', label: 'Title', get: (j) => j.title },
  { key: 'company', label: 'Company', get: (j) => companyName(companyKey(j)) },
  { key: 'family', label: 'Field', get: (j) => j.family },
  { key: 'city', label: 'City', get: (j) => j.city },
  { key: 'found', label: 'Asks for', text: false, get: (j) => (j.found || []).length },
  { key: 'create_time', label: 'Posted', get: (j) => j.create_time },
  // not a value, so not sortable: a column that looks sortable and sorts by
  // nothing is worse than one that plainly is not
  { key: 'mark', label: '', sortable: false, get: () => null },
];

/** Sort a page of postings by the active column.
 *
 *  Missing values sort last in both directions: a posting with no city is not
 *  "before A" or "after Z", it is simply unknown, and burying it at the top
 *  would push real rows off the first page.
 */
function sortJobs(jobs) {
  const column = JOB_COLUMNS.find((c) => c.key === state.jobs.sort);
  if (!column) return jobs;
  const sign = state.jobs.dir === 'asc' ? 1 : -1;
  const empty = (v) => v === null || v === undefined || v === '';
  return jobs.slice().sort((a, b) => {
    const x = column.get(a);
    const y = column.get(b);
    if (empty(x) || empty(y)) return empty(x) && empty(y) ? 0 : (empty(x) ? 1 : -1);
    if (column.text === false) return sign * (x - y);
    return sign * String(x).localeCompare(String(y), 'fa');
  });
}

/** Clicking a header sorts by it; clicking the active one reverses it. */
function setSort(key) {
  if (state.jobs.sort === key) {
    state.jobs.dir = state.jobs.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.jobs.sort = key;
    // dates read newest-first by default, names read A-Z
    state.jobs.dir = (key === 'create_time' || key === 'found') ? 'desc' : 'asc';
  }
  state.jobs.offset = 0;
  writeUrl();
  loadJobs();
}

/** The exact spellings a posting used, as filter chips.
 *
 *  The canonical name is what every chart counts, but it is not what the
 *  posting says — "k8s", "کوبرنتیز" and "Kubernetes" are one bar and none of
 *  them is the other two. Showing the literal text is how a reader checks what
 *  a count was built from. */
function termChips(job) {
  const cell = el('span', { class: 'term-chips' });
  const vocabulary = state.data.vocabulary || {};
  const spellings = job.found || [];
  for (const spelling of spellings.slice(0, 6)) {
    const canonical = vocabulary[fold(spelling)] || '';
    const chip = el('button', { class: 'term-chip', attrs: { type: 'button' } },
                    [bidi(spelling)]);
    if (canonical) {
      chip.title = `Filter by ${canonical}`;
      chip.addEventListener('click',
        () => setFilter(job.terms.includes(canonical) ? 'tool' : 'concept', canonical));
    } else {
      chip.disabled = true;
    }
    cell.append(chip);
  }
  if (spellings.length > 6) {
    cell.append(el('span', { class: 'term-more', text: `+${num(spellings.length - 6)}` }));
  }
  if (!spellings.length) cell.append(el('span', { class: 'term-more', text: '—' }));
  return cell;
}

function loadJobs() {
  // sort the whole result, then page it: paging first would sort one page of an
  // arbitrary slice and call it the top of the table
  const matching = sortJobs(scopedJobs());
  if (state.jobs.offset >= matching.length) state.jobs.offset = 0;
  renderJobs(matching.slice(state.jobs.offset, state.jobs.offset + PAGE_SIZE), matching.length);
}

function renderJobs(items, total) {
  const host = $('#jobs-table');
  clear(host);
  $('#jobs-count').textContent = `${num(total)} matching`;
  if (!items.length) {
    const tokens = queryTokens();
    const empty = el('div', { class: 'empty' });
    // five ANDed terms are usually empty; a dead end that names the alternative
    // is a result, one that just says "no matches" is a wall
    if (tokens.length > 1 && state.jobs.mode === 'all') {
      const any = scopedJobs(tokens, 'any').length;
      empty.append(el('span', { text: `No posting asks for all ${tokens.length} terms. ` }));
      const link = el('button', { class: 'link-btn', attrs: { type: 'button' },
                                  text: `${num(any)} ask for at least one — switch to Any` });
      link.addEventListener('click', () => setMode('any'));
      empty.append(link);
    } else {
      empty.append(el('span', { text: 'No postings match these filters.' }));
    }
    host.append(empty);
    $('#jobs-pager').replaceChildren();
    return;
  }
  const table = el('table');
  const head = el('tr');
  for (const column of JOB_COLUMNS) {
    const active = state.jobs.sort === column.key;
    const ascending = state.jobs.dir === 'asc';
    const th = el('th', { class: column.text === false ? 'num' : '' });
    if (column.sortable === false) {
      th.append(el('span', { class: 'sr-only', text: 'Actions' }));
      head.append(th);
      continue;
    }
    // a real button, so the table is sortable by keyboard and announced as such
    const button = el('button', {
      class: active ? 'sort-btn sort-on' : 'sort-btn',
      attrs: { type: 'button' },
    }, [
      el('span', { text: column.label }),
      el('span', { class: 'sort-mark', attrs: { 'aria-hidden': 'true' },
                   text: active ? (ascending ? '▲' : '▼') : '' }),
    ]);
    button.setAttribute('aria-label',
      `Sort by ${column.label}${active && ascending ? ', descending' : ', ascending'}`);
    th.setAttribute('aria-sort', active ? (ascending ? 'ascending' : 'descending') : 'none');
    button.addEventListener('click', () => setSort(column.key));
    th.append(button);
    head.append(th);
  }
  table.append(el('thead', {}, head));

  const body = el('tbody');
  for (const job of items) {
    const tr = el('tr');
    // built by column, not by position: appending cells in a fixed order meant
    // adding a column silently shifted every value one place left
    for (const column of JOB_COLUMNS) tr.append(jobCell(job, column));
    body.append(tr);
  }
  table.append(body);
  host.append(table);
  renderPager(total);
}

/** How old a posting is, in words a seeker reads faster than a date. */
function posted(job) {
  const age = ageDays(job);
  if (age === null) return { label: '—', stale: false };
  if (age <= 0) return { label: 'today', stale: false };
  if (age === 1) return { label: 'yesterday', stale: false };
  if (age < 30) return { label: `${age} days ago`, stale: false };
  const months = Math.round(age / 30);
  // said plainly rather than dressed as a date: the boards keep four-year-old
  // adverts listed, and "2022-05-01" in a table of fresh rows reads as a typo
  return { label: months < 12 ? `${months} months ago` : `over a year ago`, stale: age > 180 };
}

/** One cell. Kept beside JOB_COLUMNS so the two cannot drift apart. */
function jobCell(job, column) {
  const cell = el('td', { class: column.text === false ? 'num' : '' });
  if (column.key === 'title') {
    if (job.url) {
      const link = el('a', { text: job.title || '—',
        attrs: { href: job.url, target: '_blank', rel: 'noopener noreferrer', dir: 'auto' } });
      link.classList.add('bidi');
      cell.append(link);
    } else {
      cell.append(bidi(job.title));
    }
    // A posting the employer wrote is a different kind of claim from one we
    // scraped off a board, so it says so rather than blending in.
    if (job.source === 'jooob') {
      cell.append(el('span', { class: 'tag direct', text: 'direct',
                               attrs: { title: 'Posted by the employer on jooob' } }));
    }
    const more = el('button', { class: 'row-btn', text: 'details',
                                attrs: { type: 'button' } });
    more.setAttribute('aria-label', `Details for ${job.title || 'this posting'}`);
    more.addEventListener('click', () => openJob(job));
    cell.append(more);
    return cell;
  }
  if (column.key === 'match') {
    const scored = match(job);
    if (!scored) {
      // no skills entered, or nothing to compare against. "—" and a reason,
      // never a 0% that reads as "you are not qualified"
      cell.append(el('span', { class: 'term-more', text: '—' }));
      cell.setAttribute('title', state.mine.size
        ? 'This posting lists no requirement we could read'
        : 'Add your skills to see how well you match');
      return cell;
    }
    const bar = el('span', { class: 'match' });
    bar.append(el('span', { class: 'match-fill' }));
    bar.firstChild.style.width = `${scored.pct}%`;
    cell.append(bar);
    cell.append(el('span', { class: 'match-num', text: `${scored.pct}%` }));
    cell.setAttribute('title',
      `${scored.have} of ${scored.need} requirements you listed`);
    return cell;
  }
  if (column.key === 'company') {
    const name = companyName(companyKey(job)) || job.slug;
    const button = el('button', { class: 'link-btn', attrs: { type: 'button' } },
                      [bidi(name)]);
    button.addEventListener('click', () => openCompany(companyKey(job)));
    cell.append(button);
    return cell;
  }
  if (column.key === 'family') { cell.append(bidi(job.family)); return cell; }
  if (column.key === 'city') { cell.append(bidi(job.city)); return cell; }
  if (column.key === 'found') { cell.append(termChips(job)); return cell; }
  if (column.key === 'create_time') {
    const when = posted(job);
    cell.append(el('span', { class: when.stale ? 'ltr stale' : 'ltr', text: when.label }));
    cell.setAttribute('title', (job.create_time || '').slice(0, 10) || 'no date given');
    return cell;
  }
  if (column.key === 'mark') { cell.append(marks(job)); return cell; }
  cell.append(bidi(String(column.get(job) ?? '')));
  return cell;
}

/** Save / applied / hide, the three things a seeker does to a row. */
function marks(job) {
  const wrap = el('span', { class: 'marks' });
  const key = jobKey(job);
  const buttons = [
    ['saved', '★', 'Save', 'Saved'],
    ['applied', '✓', 'Mark as applied', 'Applied'],
    ['hidden', '✕', 'Hide', 'Hidden'],
  ];
  for (const [list, glyph, off, on] of buttons) {
    const held = state.me[list].includes(key);
    const button = el('button', { class: held ? 'mark-btn mark-on' : 'mark-btn',
                                  text: glyph, attrs: { type: 'button' } });
    button.setAttribute('aria-pressed', held ? 'true' : 'false');
    button.setAttribute('aria-label', held ? on : off);
    button.setAttribute('title', held ? `${on} — click to undo` : off);
    button.addEventListener('click', () => toggleMark(list, key));
    wrap.append(button);
  }
  return wrap;
}

function toggleMark(list, key) {
  const held = state.me[list].indexOf(key);
  if (held >= 0) state.me[list].splice(held, 1);
  else state.me[list].push(key);
  // saving and hiding the same posting is a contradiction; the newer wins
  if (held < 0 && list === 'hidden') {
    state.me.saved = state.me.saved.filter((k) => k !== key);
  }
  if (held < 0 && list === 'saved') {
    state.me.hidden = state.me.hidden.filter((k) => k !== key);
  }
  saveMe();
  skeletons();
  renderAll();
}

/* ── drawers ───────────────────────────────────────────────────────────────
 *
 * Clicking a term used to do one thing: set a filter. That answers "show me
 * these postings" and nothing else -- not who wants it, not what it goes with,
 * not whether it is growing. A drawer answers those without leaving the page,
 * using a native <dialog> so focus handling and Escape come for free.
 */

function drawer() { return document.querySelector('#drawer'); }

function openDrawer(title, build) {
  const box = drawer();
  if (!box) return;
  clear(box.querySelector('#drawer-body'));
  box.querySelector('#drawer-title').replaceChildren(bidi(title));
  build(box.querySelector('#drawer-body'));
  if (box.showModal) box.showModal();
}

function closeDrawer() {
  const box = drawer();
  if (box && box.close) box.close();
}

/** A labelled block of rows inside a drawer. */
function drawerSection(host, heading, rows, { onPick } = {}) {
  host.append(el('h3', { class: 'drawer-h', text: heading }));
  if (!rows.length) {
    host.append(el('p', { class: 'card-sub', text: 'Nothing to show.' }));
    return;
  }
  const list = el('ul', { class: 'drawer-list' });
  for (const row of rows.slice(0, DRAWER_ROWS)) {
    const item = el('li');
    if (onPick) {
      const button = el('button', { class: 'link-btn', attrs: { type: 'button' } },
                        [bidi(row.label)]);
      button.addEventListener('click', () => { closeDrawer(); onPick(row); });
      item.append(button);
    } else {
      item.append(bidi(row.label));
    }
    if (row.note !== undefined) item.append(el('span', { class: 'drawer-note', text: row.note }));
    list.append(item);
  }
  host.append(list);
}

/** One posting: what it wants, what you are missing, and what looks like it. */
function openJob(job) {
  counted('job', jobKey(job));
  openDrawer(job.title || 'Posting', (host) => {
    const scored = match(job);
    const name = companyName(companyKey(job)) || job.slug;
    const when = posted(job);
    host.append(el('p', { class: 'card-sub' },
                   [bidi(`${name} · ${job.city || 'city not stated'} · ${when.label}`)]));
    if (when.stale) {
      host.append(el('p', { class: 'warn',
        text: 'This advert is more than six months old. It is still listed on the '
              + 'board, but a listing that old often is not being filled.' }));
    }
    if (job.url) {
      host.append(el('a', { class: 'cta', text: 'Open the advert',
        attrs: { href: job.url, target: '_blank', rel: 'noopener noreferrer' } }));
    }
    if (scored) {
      host.append(el('p', { class: 'drawer-score',
        text: `${scored.pct}% match — you listed ${scored.have} of the `
              + `${scored.need} things this posting asks for.` }));
      drawerSection(host, 'You already have', requirements(job)
        .filter((term) => state.mine.has(term))
        .map((term) => ({ label: term })));
      drawerSection(host, 'You are missing', scored.missing.map((term) => ({ label: term })),
                    { onPick: (row) => openTerm(row.label) });
    } else {
      drawerSection(host, 'Asks for', requirements(job).map((term) => ({ label: term })),
                    { onPick: (row) => openTerm(row.label) });
    }
    const spellings = job.found || [];
    if (spellings.length) {
      host.append(el('h3', { class: 'drawer-h', text: 'In its own words' }));
      const chips = el('p', { class: 'term-chips' });
      for (const spelling of spellings) chips.append(el('span', { class: 'term-chip' },
                                                       [bidi(spelling)]));
      host.append(chips);
    }
    drawerSection(host, 'Postings like this one',
      similar(job).map(({ job: other, shared }) => ({
        label: other.title || other.slug,
        note: `${shared} shared`,
      })), { onPick: (row) => {
        const found = state.data.jobs.find((j) => (j.title || j.slug) === row.label);
        if (found) openJob(found);
      } });
  });
}

/* ── the same list on your other device ────────────────────────────────────
 *
 * Stage 5, and deliberately the smallest possible version of it. localStorage
 * stays the source of truth: the site works signed out, offline, and with the
 * API down, exactly as it did before any of this existed. Signing in only adds
 * a copy on the server so a phone and a laptop can agree.
 *
 * Merging is a union rather than a replace. Somebody who signs in on a second
 * device has skills in two places, and quietly discarding one set would be the
 * worst possible answer to "make my things follow me".
 */
let signedIn = false;

const apiBase = () => (((state.data || {}).api || {}).url || '').replace(/\/$/, '');

async function apiCall(path, options = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  if (response.status === 204) return {};
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

/** Fold what the account remembers into what this browser remembers. */
function mergeProfile(remote) {
  if (!remote || typeof remote !== 'object') return;
  for (const key of ['skills', 'saved', 'applied', 'hidden', 'searches']) {
    const mine = state.me[key];
    const seen = new Set(mine.map((v) => String(v).toLowerCase()));
    for (const value of (remote[key] || [])) {
      if (typeof value !== 'string') continue;
      if (seen.has(value.toLowerCase())) continue;
      mine.push(value);
      seen.add(value.toLowerCase());
    }
  }
  state.me.searches.length = Math.min(state.me.searches.length, SEARCH_HISTORY);
  saveMe();
}

// A save happens on every chip and every settled search, so the upload waits
// for things to go quiet rather than following each keystroke to the server.
const pushProfile = debounce(async () => {
  if (!signedIn) return;
  try {
    await apiCall('/profile', { method: 'PUT', body: JSON.stringify(state.me) });
  } catch {
    // a failed sync is not worth interrupting anyone over: the browser still
    // has everything, and the next save tries again
  }
}, 4000);

/** Show the page. Everything that is not a refusal ends up here. */
function admit() {
  delete document.documentElement.dataset.gate;
}

async function startSync() {
  if (!apiBase()) { admit(); return; }   // no API in the export: it stands alone
  let who;
  try {
    who = await apiCall('/me');
  } catch (err) {
    signedIn = false;
    renderAccount(null);
    // The dashboard is not a public page: it is what signing in is for. A 401
    // is a definite answer, so it sends the visitor to the door -- and the page
    // stays hidden while it does, because a redirect that happens after the
    // paint has already shown what it was meant to withhold. A network failure
    // is not a definite answer, so that reveals instead: locking everybody out
    // because the API blinked would be much the worse of the two mistakes.
    if (String(err.message) === 'HTTP 401') {
      location.replace(`/login?next=${encodeURIComponent(location.href)}`);
      return;
    }
    admit();
    return;
  }
  signedIn = true;
  admit();
  renderAccount(who);
  try {
    const body = await apiCall('/profile');
    if (body.profile) {
      mergeProfile(body.profile);
      renderAll();
    }
    pushProfile();                  // whatever this browser had that the account did not
  } catch {
    // the account is there, its profile simply did not load: the browser copy
    // is still the source of truth, so there is nothing to interrupt anyone for
  }
}

/** One control in the header: who you are, or a way to become someone. */
function renderAccount(who) {
  const host = $('#account');
  if (!host) return;
  clear(host);
  if (!apiBase()) return;
  if (who) {
    host.append(el('span', { class: 'account-email', text: who.email }));
    const out = el('button', { class: 'ghost-btn text', text: 'Sign out',
                               attrs: { type: 'button' } });
    out.addEventListener('click', async () => {
      try { await apiCall('/auth/logout', { method: 'POST' }); } catch { /* gone */ }
      signedIn = false;
      // and off the page: leaving it on screen after signing out shows exactly
      // what signing out was meant to put away
      location.replace('/');
    });
    host.append(out);
  } else {
    host.append(el('a', { class: 'ghost-btn text', text: 'Sync my list',
      attrs: { href: `/login?next=${encodeURIComponent(location.href)}`,
               title: 'Optional: keeps your skills on your other devices' } }));
  }
}


/* ── what happened this visit ──────────────────────────────────────────────
 *
 * Counted here, in memory, and sent once when the tab goes away. One request
 * and one database row per visit rather than per click, which is the whole
 * reason this fits in a free tier: the budget is spent per session.
 *
 * Nothing identifying goes with it. There is no client id, no cookie and no
 * address -- if the visitor happens to be signed in the Worker attaches their
 * account, and if they are not there is simply nothing to attach.
 */
const visit = { search: {}, skill: {}, job: {}, filter: {} };

function counted(kind, key) {
  if (!key || !visit[kind]) return;
  const name = String(key).slice(0, 80);
  visit[kind][name] = (visit[kind][name] || 0) + 1;
}

function sendVisit() {
  const api = ((state.data || {}).api || {}).url;
  if (!api || !navigator.sendBeacon) return;
  if (!Object.values(visit).some((bucket) => Object.keys(bucket).length)) return;
  // text/plain on purpose: sendBeacon cannot set a JSON content-type without
  // provoking a preflight it is unable to perform, and the Worker parses the
  // body either way. The cost is that this one route loses the content-type
  // check the others rely on -- acceptable, because the worst a forged beacon
  // achieves is a wrong number in a private report.
  navigator.sendBeacon(`${api.replace(/\/$/, '')}/events`,
                       new Blob([JSON.stringify(visit)], { type: 'text/plain' }));
  for (const bucket of Object.values(visit)) {
    for (const name of Object.keys(bucket)) delete bucket[name];
  }
}

// pagehide rather than unload: it is the one that fires on mobile Safari and on
// a backgrounded Android tab, which is where most of these visits end
addEventListener('pagehide', sendVisit);


/* -- company reviews -------------------------------------------------------
 *
 * The only words on this site that somebody else wrote. Everything else is
 * counted out of postings; this is a person saying what it was actually like to
 * work somewhere, which no amount of scraping can produce.
 *
 * Nothing here identifies the author, because nothing on the path does -- not
 * this form, not the Worker, not the table it writes to. And nothing appears
 * until a person has read it: the export only ever carries approved reviews, so
 * an unmoderated one cannot reach this page even by mistake.
 */

/** Approved reviews for one company. The export already sorts them, newest first. */
function reviewsFor(key) {
  return (state.data.reviews || []).filter((row) => companyKey(row) === key);
}

/** A rating as text: no icon font to load, and it survives copy-paste. */
function stars(rating) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
}

function drawerReviews(host, key) {
  const rows = reviewsFor(key);
  host.append(el('h3', { class: 'drawer-h', text: 'What people who worked there said' }));
  if (!rows.length) {
    host.append(el('p', { class: 'card-sub',
                          text: 'Nobody has written about this company yet.' }));
  }
  for (const row of rows) {
    const meta = [row.role, row.tenure, (row.created_at || '').slice(0, 10)].filter(Boolean);
    host.append(el('article', { class: 'review' }, [
      el('div', { class: 'review-head' }, [
        el('span', { class: 'review-stars', text: stars(row.rating),
                     attrs: { 'aria-label': `${row.rating} out of 5` } }),
        el('span', { class: 'card-sub', text: meta.join(' \u00b7 ') }),
      ]),
      bidi(row.body, 'review-body'),
    ]));
  }
  reviewForm(host, key);
}

/** The form, shown only when a Worker is actually deployed to receive it.
 *
 *  With no API configured the export says so and this returns immediately, so
 *  the site stays what it was before any of this existed: static files that
 *  need no backend to be useful.
 */
function reviewForm(host, key) {
  const api = ((state.data || {}).api || {}).url;
  if (!api) return;
  const site = ((state.data || {}).api || {}).turnstile;
  const [source, slug] = String(key).split(COMPANY_SEP);
  let token = '';

  const rating = el('select', { class: 'select' });
  for (const n of [5, 4, 3, 2, 1]) {
    rating.append(el('option', { text: `${stars(n)}  ${n}/5`, attrs: { value: String(n) } }));
  }
  const role = el('input', { class: 'search', attrs: {
    type: 'text', maxlength: '80', placeholder: 'What you did there (optional)' } });
  const tenure = el('input', { class: 'search', attrs: {
    type: 'text', maxlength: '80', placeholder: 'How long you stayed (optional)' } });
  const body = el('textarea', { class: 'search review-write', attrs: {
    rows: '5', minlength: '40', maxlength: '2000', required: 'required',
    placeholder: 'What was it actually like? Pay, hours, management, how people are treated.' } });
  const send = el('button', { class: 'cta', text: 'Send for review', attrs: { type: 'submit' } });
  const said = el('p', { class: 'card-sub', attrs: { role: 'status' } });

  const form = el('form', { class: 'review-form' }, [
    el('p', { class: 'card-sub', text: 'Posted anonymously. The database has no field '
      + 'for your name, your email or your address, so none is asked for and none is '
      + 'kept. A person reads it before it appears.' }),
    rating, role, tenure, body, send, said,
  ]);

  if (site) {
    const box = el('div');
    form.insertBefore(box, send);
    loadScript({ src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' })
      .then(() => window.turnstile
        && window.turnstile.render(box, { sitekey: site, callback: (t) => { token = t; } }))
      .catch(() => {});          // a blocked widget must not take the form down with it
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    send.disabled = true;
    said.textContent = 'Sending\u2026';
    try {
      const response = await fetch(`${api.replace(/\/$/, '')}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source, slug, rating: Number(rating.value), role: role.value,
          tenure: tenure.value, body: body.value, turnstile: token }),
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(answer.error || `HTTP ${response.status}`);
      // deliberately not "published": it is in a queue, and saying otherwise
      // would leave someone refreshing a page that is not going to change yet
      said.textContent = 'Thank you. A person will read it before it appears.';
      form.reset();
    } catch (err) {
      said.textContent = `Not sent: ${err.message}`;
      send.disabled = false;
    }
  });

  host.append(el('details', { class: 'review-ask' }, [
    el('summary', { text: 'Worked here? Say what it was like' }), form]));
}


/** One employer: what they are hiring for and what they run. */
function openCompany(key) {
  const rows = state.data.jobs.filter((job) => companyKey(job) === key);
  const company = state.data.companies.find((c) => companyKey(c) === key);
  openDrawer(companyName(key) || key, (host) => {
    const live = rows.filter((job) => !ageDays(job) || ageDays(job) <= 30).length;
    host.append(el('p', { class: 'card-sub',
      text: `${num(rows.length)} postings collected, ${num(live)} from the last 30 days`
            + (company && company.scraped_at
               ? ` · last checked ${company.scraped_at.slice(0, 10)}` : '') }));
    if (company && company.website) {
      host.append(el('a', { class: 'cta', text: company.website,
        attrs: { href: `https://${String(company.website).replace(/^https?:\/\//, '')}`,
                 target: '_blank', rel: 'noopener noreferrer' } }));
    }
    drawerSection(host, 'What they run',
      rank(rows, 'family').slice(0, DRAWER_ROWS)
        .map((row) => ({ label: row.key, note: num(row.jobs) })));
    drawerSection(host, 'Most asked for',
      termCounts(rows, 'terms').terms.slice(0, DRAWER_ROWS)
        .map((row) => ({ label: row.term, note: num(row.jobs) })),
      { onPick: (row) => openTerm(row.label) });
    drawerSection(host, 'Open postings', rows.slice(0, DRAWER_ROWS).map((job) => ({
      label: job.title || job.slug, note: posted(job).label })),
      { onPick: (row) => {
        const found = rows.find((j) => (j.title || j.slug) === row.label);
        if (found) openJob(found);
      } });
    drawerReviews(host, key);
    const filter = el('button', { class: 'cta ghost-btn', text: 'Filter the dashboard to this company',
                                  attrs: { type: 'button' } });
    filter.addEventListener('click', () => { closeDrawer(); setFilter('slug', key); });
    host.append(filter);
  });
}

/** One requirement: who wants it, what it travels with, where it is growing. */
function openTerm(term) {
  const isTool = state.data.jobs.some((job) => (job.terms || []).includes(term));
  const rows = state.data.jobs.filter((job) => requirements(job).includes(term));
  openDrawer(term, (host) => {
    const share = state.data.jobs.length
      ? Math.round((1000 * rows.length) / state.data.jobs.length) / 10 : 0;
    host.append(el('p', { class: 'card-sub',
      text: `${num(rows.length)} postings ask for it — ${share}% of everything collected` }));
    if (state.mine.size) {
      const held = state.mine.has(term);
      const toggle = el('button', { class: 'cta',
        text: held ? 'Remove from your skills' : 'Add to your skills',
        attrs: { type: 'button' } });
      toggle.addEventListener('click', () => { closeDrawer(); toggleSkill(term); });
      host.append(toggle);
    }
    drawerSection(host, 'Who asks for it',
      rank(rows, 'company').slice(0, DRAWER_ROWS)
        .map((row) => ({ label: companyName(row.key) || row.key, note: num(row.jobs) })));
    drawerSection(host, 'Which fields',
      rank(rows, 'family').slice(0, DRAWER_ROWS)
        .map((row) => ({ label: row.key, note: num(row.jobs) })));
    // pairs are lift-ranked, so this is "what it genuinely travels with" rather
    // than "what is popular in the same postings"
    const pairs = techPairs(state.data.jobs, { top: 600 })
      .links.filter((link) => link.source === term || link.target === term)
      .map((link) => ({ label: link.source === term ? link.target : link.source,
                        note: `${link.lift}×` }));
    drawerSection(host, 'Goes together with', pairs, { onPick: (row) => openTerm(row.label) });
    const filter = el('button', { class: 'cta ghost-btn', text: 'Filter the dashboard to it',
                                  attrs: { type: 'button' } });
    filter.addEventListener('click', () => {
      closeDrawer();
      setFilter(isTool ? 'tool' : 'concept', term);
    });
    host.append(filter);
  });
}

function renderPager(total) {
  const pager = $('#jobs-pager');
  clear(pager);
  const { offset } = state.jobs;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const prev = el('button', { text: '← Previous', attrs: { type: 'button' } });
  prev.disabled = offset === 0;
  prev.addEventListener('click', () => {
    state.jobs.offset = Math.max(0, offset - PAGE_SIZE);
    loadJobs();
  });

  const next = el('button', { text: 'Next →', attrs: { type: 'button' } });
  next.disabled = offset + PAGE_SIZE >= total;
  next.addEventListener('click', () => { state.jobs.offset = offset + PAGE_SIZE; loadJobs(); });

  pager.append(prev,
               el('span', { class: 'page-info', text: `Page ${num(page)} of ${num(pages)}` }),
               next);
}

/* ── filters, shareable through the URL ──────────────────── */

function fillFilters(families) {
  // only name the board when there is more than one, so a single-board install
  // reads exactly as it did before
  state.sources = new Set(state.data.companies.map((c) => c.source)).size;
  const companySelect = $('#filter-company');
  for (const company of state.data.companies.filter((c) => c.live)) {
    // the option's value is the composite key, its label the readable name; two
    // boards may both have a "digipay" and they are different companies
    const label = company.name || company.slug;
    companySelect.append(el('option', {
      text: state.sources > 1 ? `${label} (${company.source})` : label,
      attrs: { value: companyKey(company) },
    }));
  }
  const familySelect = $('#filter-family');
  for (const group of families) {
    familySelect.append(el('option', { text: `${group.key} (${num(group.jobs)})`,
                                       attrs: { value: group.key } }));
  }
  // a shared link may already carry filters; reflect them in the controls
  companySelect.value = state.filters.slug;
  familySelect.value = state.filters.family;
  $('#jobs-search').value = state.jobs.q;
  $('#search-mode').value = state.jobs.mode;
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.filters.slug = params.get('company') || '';
  state.filters.family = params.get('family') || '';
  state.filters.tool = params.get('tool') || '';
  state.filters.concept = params.get('concept') || '';
  state.filters.city = params.get('city') || '';
  state.jobs.q = params.get('q') || '';
  state.jobs.mode = params.get('qmode') === 'any' ? 'any' : 'all';
  state.view = params.get('view') === 'market' ? 'market' : 'me';
  const fresh = Number(params.get('fresh'));
  state.jobs.fresh = FRESH_CHOICES.includes(fresh) ? fresh : FRESH_DEFAULT;
  state.jobs.remote = params.get('remote') === '1';
  state.jobs.only = ['saved', 'applied', 'hidden'].includes(params.get('only'))
    ? params.get('only') : '';
  const sort = params.get('sort');
  // a column with nothing to sort by must not become the sort, however the URL
  // was arrived at
  if (JOB_COLUMNS.some((c) => c.key === sort && c.sortable !== false)) state.jobs.sort = sort;
  state.jobs.dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  state.conceptCategory = params.get('category') || '';
}

/** A filtered dashboard has to be linkable, so the filters live in the URL. */
function writeUrl() {
  const params = new URLSearchParams();
  const named = { company: state.filters.slug, family: state.filters.family,
                  tool: state.filters.tool, concept: state.filters.concept,
                  city: state.filters.city, q: state.jobs.q,
                  qmode: state.jobs.mode === 'any' ? 'any' : '',
                  sort: state.jobs.sort === 'create_time' ? '' : state.jobs.sort,
                  dir: state.jobs.dir === 'desc' ? '' : state.jobs.dir,
                  category: state.conceptCategory,
                  view: state.view === 'market' ? 'market' : '',
                  fresh: state.jobs.fresh === FRESH_DEFAULT ? '' : String(state.jobs.fresh),
                  remote: state.jobs.remote ? '1' : '',
                  only: state.jobs.only };
  for (const [key, value] of Object.entries(named)) if (value) params.set(key, value);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

/** Set one filter and redraw. Clicking the value that is already active clears
 *  it, so a chart is a toggle rather than a one-way trip. */
function setFilter(name, value) {
  if (value && state.filters[name] !== value) counted('filter', `${name}:${value}`);
  state.filters[name] = state.filters[name] === value ? '' : value;
  if (name === 'slug') $('#filter-company').value = state.filters.slug;
  if (name === 'family') $('#filter-family').value = state.filters.family;
  state.jobs.offset = 0;
  writeUrl();
  skeletons();
  renderAll();
}

/** ALL means every term must appear, ANY means at least one. */
function setMode(mode) {
  state.jobs.mode = mode === 'any' ? 'any' : 'all';
  state.jobs.offset = 0;
  const toggle = $('#search-mode');
  if (toggle) toggle.value = state.jobs.mode;
  writeUrl();
  skeletons();
  renderAll();
}

function setCategory(category) {
  state.conceptCategory = state.conceptCategory === category ? '' : category;
  writeUrl();
  renderAll();
}

/** Tool, concept and city are reachable only by clicking a chart, so without a
 *  chip a user cannot see what is applied or undo it. */
function renderChips() {
  const host = $('#filter-chips');
  clear(host);
  const active = [
    ['slug', 'Company', companyName(state.filters.slug || '')],
    ['family', 'Field', state.filters.family],
    ...CLICK_FILTERS.map((name) => [name, name[0].toUpperCase() + name.slice(1),
                                    state.filters[name]]),
  ].filter(([name]) => state.filters[name]);
  host.hidden = !active.length;
  for (const [name, label, shown] of active) {
    const chip = el('button', { class: 'chip', attrs: { type: 'button' } }, [
      el('span', { class: 'chip-label', text: `${label}: ` }),
      bidi(shown),
      el('span', { class: 'chip-x', text: '×', attrs: { 'aria-hidden': 'true' } }),
    ]);
    chip.setAttribute('aria-label', `Remove ${label} filter ${shown}`);
    chip.addEventListener('click', () => setFilter(name, state.filters[name]));
    host.append(chip);
  }

  // one chip per search term, saying what it resolved to. A term we do not
  // know is marked rather than silently searched as text: it is a gap in the
  // vocabulary, and the reader is the only one who can tell us that.
  const tokens = queryTokens();
  for (const { token, canonical } of tokens) {
    const chip = el('span', { class: canonical ? 'chip chip-term' : 'chip chip-unknown' }, [
      el('span', { class: 'chip-label', text: canonical ? 'Term: ' : 'Not in vocabulary: ' }),
      bidi(canonical || token),
    ]);
    if (canonical && fold(canonical) !== fold(token)) {
      chip.append(el('span', { class: 'chip-note', text: ` (${token})` }));
    }
    host.append(chip);
  }
  if (tokens.length > 1) {
    host.append(el('span', { class: 'chip chip-mode',
      text: state.jobs.mode === 'any' ? 'matching any term' : 'matching all terms' }));
  }
  host.hidden = !active.length && !tokens.length;
}

/* ── orchestration ─────────────────────────────────────────────────────── */

const CHART_IDS = ['#chart-gap', '#chart-tech', '#chart-concepts', '#chart-company', '#chart-city',
                   '#chart-trend', '#chart-seniority', '#chart-heatmap', '#chart-distinctive',
                   '#chart-ladder', '#chart-network', '#chart-timeline'];

function skeletons() {
  // the graph owns a canvas inside its container, so it must be torn down
  // before anything empties that container
  if (state.graph) { state.graph.destroy(); state.graph = null; }
  for (const id of CHART_IDS) {
    const node = $(id);
    const chart = state.charts.get(id);
    if (chart) { chart.dispose(); state.charts.delete(id); }
    clear(node);
    node.classList.add('skeleton');
  }
}

/** Show the panels this view is for.
 *
 *  Two audiences, one dataset. A seeker wants to know what to apply for; an
 *  analyst wants to know what the market is doing. The old page answered only
 *  the second question and buried the postings table under ten charts, so the
 *  panels now declare who they are for and the toggle decides. Nothing is
 *  recomputed differently -- the same filters feed both.
 */
function applyView() {
  const view = state.view === 'market' ? 'market' : 'me';
  for (const section of document.querySelectorAll('[data-view]')) {
    const wanted = section.dataset.view;
    section.hidden = wanted !== 'both' && wanted !== view;
  }
  for (const button of document.querySelectorAll('[data-view-btn]')) {
    const on = button.dataset.viewBtn === view;
    button.classList[on ? 'add' : 'remove']('on');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const grid = document.querySelector('#grid');
  if (grid) grid.classList[view === 'me' ? 'add' : 'remove']('grid-me');
}

function setView(view) {
  state.view = view === 'market' ? 'market' : 'me';
  writeUrl();
  applyView();
  skeletons();
  renderAll();
}

function renderAll() {
  applyView();
  const jobs = scopedJobs();
  const stats = overview(jobs);
  const p = palette();
  renderChips();
  renderSkills();
  renderMine(jobs);
  renderGap(jobs);
  renderKpis(stats);
  renderExtracted('tools', termCounts(jobs, 'terms'), {
    chart: '#chart-tech', table: '#table-tech', sub: '#sub-tech', label: 'Tool',
    colorPair: [p.accent2, p.accent], filter: 'tool' });
  renderCategories(jobs);
  renderExtracted('concepts', termCounts(jobs, 'concepts',
                                         { category: state.conceptCategory }), {
    chart: '#chart-concepts', table: '#table-concepts', sub: '#sub-concepts',
    label: 'Concept', colorPair: [p.ramp[3], p.ramp[5]], filter: 'concept' });
  renderCompanies(rank(jobs, 'company'));
  renderCity(rank(jobs, 'city', { min: CITY_MIN_N }));
  renderTrend(toolTrend(jobs));
  renderHeatmap(techMatrix(jobs, 'seniority_level',
                           { rowOrder: state.data.seniority_levels, share: true }),
                { chart: '#chart-seniority', table: '#table-seniority', rowLabel: 'Level' });
  renderHeatmap(techMatrix(jobs, 'family'),
                { chart: '#chart-heatmap', table: '#table-heatmap', rowLabel: 'Department' });
  renderTimeline(timeline(jobs));
  renderDistinctive(distinctive(jobs, 'family'));
  // the same contrast, down the ladder instead of across fields: what a Manager
  // posting asks for that a Specialist one does not is the closest this data
  // comes to describing a career step
  renderDistinctive(distinctive(jobs, 'seniority_level',
                                { order: state.data.seniority_levels }),
                    { chart: '#chart-ladder', table: '#table-ladder', sub: '#sub-ladder',
                      noun: 'level',
                      empty: 'Not enough postings state a level yet.' });
  renderNetwork(techPairs(jobs));
  loadJobs();

  $('#sub-seniority').textContent =
    `% of each level's postings naming the requirement · level stated on `
    + `${num(jobs.filter((j) => j.seniority_level).length)} of ${num(jobs.length)} postings`;
  $('#sub-heatmap').textContent =
    `tool and concept mentions per job family · top ${num(HEATMAP_N)} of each axis`;

  const stamp = (state.data.generated_at || '').slice(0, 10);
  $('#foot-note').textContent =
    `${num(state.data.jobs.length)} postings from ${num(state.data.companies.length)} companies, `
    + `last collected ${stamp || 'unknown'}. Requirements were extracted from `
    + `${num(state.data.extracted)} of ${num(state.data.described)} postings that had a `
    + 'description; every figure is counted from these postings only.'
    + (state.data.labelled_by
       ? ` ${num(state.data.labelled_by.model || 0)} were labelled by a language model`
         + ` and ${num(state.data.labelled_by.regex || 0)} by alias matching.`
       : '');
}

/** One file means one failure mode: name the file and what happened, and offer
 *  a retry -- empty charts would read as "no jobs found". */
function showLoadError(err) {
  const box = $('#load-error');
  box.hidden = false;
  clear(box);
  box.append(el('strong', { text: 'Could not load the dataset. ' }));
  box.append(document.createTextNode(`${err.message} `));
  const retry = el('button', { class: 'ghost-btn text', text: 'Retry',
                               attrs: { type: 'button' } });
  retry.addEventListener('click', () => location.reload());
  box.append(retry);
  for (const id of CHART_IDS) chartMessage(id, 'No data loaded.', true);
  clear($('#jobs-table'));
}

/* ── boot ─────────────────────────────────────────────────── */

function wire() {
  $('#theme-toggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const onFilter = () => {
    state.filters.slug = $('#filter-company').value;
    state.filters.family = $('#filter-family').value;
    state.jobs.offset = 0;
    writeUrl();
    skeletons();
    renderAll();
  };
  $('#filter-company').addEventListener('change', onFilter);
  $('#filter-family').addEventListener('change', onFilter);
  $('#filter-reset').addEventListener('click', () => {
    for (const name of Object.keys(state.filters)) state.filters[name] = '';
    $('#filter-company').value = '';
    $('#filter-family').value = '';
    $('#jobs-search').value = '';
    state.jobs.q = '';
    state.jobs.mode = 'all';
    $('#search-mode').value = 'all';
    state.conceptCategory = '';
    state.jobs.sort = 'create_time';
    state.jobs.dir = 'desc';
    state.jobs.offset = 0;
    // the seeker's scope resets too, but never their own data: a Reset that
    // wiped the skills you typed and the jobs you saved would be a trap
    state.jobs.fresh = FRESH_DEFAULT;
    state.jobs.remote = false;
    state.jobs.only = '';
    syncControls();
    writeUrl();
    skeletons();
    renderAll();
  });

  $('#jobs-search').addEventListener('input', debounce((e) => {
    state.jobs.q = e.target.value.trim();
    rememberSearch(state.jobs.q);
    state.jobs.offset = 0;
    writeUrl();
    skeletons();
    renderAll();
  }, 250));

  $('#search-mode').addEventListener('change', (e) => setMode(e.target.value));

  // searches are the one thing here a person might not want kept, so throwing
  // them away is one click and does not touch skills or shortlists
  $('#clear-searches')?.addEventListener('click', () => {
    state.me.searches = [];
    saveMe();
    renderSearchHistory();
  });

  for (const button of document.querySelectorAll('[data-view-btn]')) {
    button.addEventListener('click', () => setView(button.dataset.viewBtn));
  }

  const rescope = (mutate) => (event) => {
    mutate(event);
    state.jobs.offset = 0;
    writeUrl();
    skeletons();
    renderAll();
  };
  const freshSelect = $('#filter-fresh');
  if (freshSelect) {
    freshSelect.addEventListener('change', rescope((e) => {
      state.jobs.fresh = Number(e.target.value) || 0;
    }));
  }
  const remoteBox = $('#filter-remote');
  if (remoteBox) {
    remoteBox.addEventListener('change', rescope((e) => {
      state.jobs.remote = Boolean(e.target.checked);
    }));
  }
  const onlySelect = $('#filter-only');
  if (onlySelect) {
    onlySelect.addEventListener('change', rescope((e) => { state.jobs.only = e.target.value; }));
  }

  const skillInput = $('#skill-input');
  if (skillInput) {
    const submit = () => {
      const added = addTypedSkill(skillInput.value);
      if (added) skillInput.value = '';
      const note = $('#skill-note');
      if (note) {
        // an unresolved skill is feedback about the vocabulary, not a failure to
        // scold the visitor with
        note.textContent = added ? `Added ${added}.`
          : (skillInput.value.trim()
             ? `"${skillInput.value.trim()}" is not in the vocabulary yet — try another spelling.`
             : '');
      }
    };
    skillInput.addEventListener('change', submit);
    skillInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  const close = $('#drawer-close');
  if (close) close.addEventListener('click', closeDrawer);

  window.addEventListener('resize', resizeAll);
}

/** Push state back into the controls, for a shared link or a reset. */
function syncControls() {
  const set = (sel, value) => { const node = $(sel); if (node) node.value = value; };
  set('#filter-company', state.filters.slug);
  set('#filter-family', state.filters.family);
  set('#jobs-search', state.jobs.q);
  set('#search-mode', state.jobs.mode);
  set('#filter-fresh', String(state.jobs.fresh));
  set('#filter-only', state.jobs.only);
  const remoteBox = $('#filter-remote');
  if (remoteBox) remoteBox.checked = state.jobs.remote;
}

async function boot() {
  setTheme(localStorage.getItem(THEME_KEY)
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  state.me = loadMe();
  state.mine = new Set(state.me.skills);
  wire();
  readUrl();
  syncControls();
  renderSearchHistory();
  applyView();
  skeletons();

  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    // A 5xx is the server saying the fault is its own, and there is a page that
    // says so properly. Anything else -- a 404, malformed JSON, a connection
    // that died -- keeps the visitor here, where the message can name what went
    // wrong and offer a retry that costs them nothing.
    if (response.status >= 500) { location.replace('/500'); return; }
    if (!response.ok) throw new Error(`${DATA_URL} returned HTTP ${response.status}.`);
    state.data = await response.json();
  } catch (err) {
    showLoadError(err);
    return;
  }

  withCompanyKeys(state.data.jobs);
  nameBySlug = new Map(state.data.companies
    .filter((c) => c.name).map((c) => [companyKey(c), c.name]));
  fillFilters(rank(state.data.jobs, 'family'));
  fillSkillOptions();
  renderAll();
  // stamped after the render that used it, so "new since your last visit"
  // reports this visit's news rather than resetting to zero before showing it
  state.me.seen = state.data.generated_at || new Date().toISOString();
  saveMe();
  // last, and never blocking: the dashboard is complete without an account
  startSync();
}

/** Offer the vocabulary as suggestions, so a typed skill resolves to something
 *  the data can actually count. */
function fillSkillOptions() {
  const list = $('#skill-options');
  if (!list) return;
  clear(list);
  for (const name of skillNames()) {
    list.append(el('option', { attrs: { value: name } }));
  }
}

document.addEventListener('DOMContentLoaded', boot);
