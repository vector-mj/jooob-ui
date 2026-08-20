/* Arithmetic check for the dashboard's derivations, run against the real export.
 *
 * The charts are all counted in the browser now, so a silent mistake here shows
 * up as a confident wrong number rather than an error. This runs in CI before
 * the deploy: `node docs/check.mjs`. No framework, no dependencies.
 */
import fs from 'node:fs';

const root = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(`${root}app.js`, 'utf8');
const data = JSON.parse(fs.readFileSync(`${root}data/jooob.json`, 'utf8'));

// A DOM thin enough to evaluate app.js and thick enough to render into. The
// renderers must actually run here: a ReferenceError inside one of them is
// invisible to `node --check` and to any test that only calls the derivations,
// and it takes down every panel after it.
const painted = new Map();
function fakeEl(tag = 'div') {
  const el = {
    tag, children: [], style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    textContent: '', hidden: false, disabled: false, value: '',
    append(...kids) { el.children.push(...kids); }, appendChild(k) { el.children.push(k); },
    // the review form puts the Turnstile widget before the send button, and
    // that branch only runs once a site key is configured -- so this was
    // missing until the first export that carried one
    insertBefore(node, before) {
      const at = el.children.indexOf(before);
      if (at < 0) el.children.push(node); else el.children.splice(at, 0, node);
      return node;
    },
    replaceChildren() { el.children = []; }, removeChild() { el.children.shift(); },
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    get firstChild() { return el.children[0] || null; },
  };
  return el;
}
const nodes = new Map();
const nodeFor = (sel) => {
  if (!nodes.has(sel)) {
    const el = fakeEl();
    el.id = sel;                 // so a painted chart is identifiable by selector
    nodes.set(sel, el);
  }
  return nodes.get(sel);
};
globalThis.document = {
  addEventListener() {}, createElement: (t) => fakeEl(t),
  createTextNode: (t) => ({ text: t }),
  querySelector: nodeFor, querySelectorAll: () => [],
  documentElement: { dataset: {} }, head: fakeEl(),
};
const chartStub = (id) => ({
  setOption(o) { painted.set(id, o); }, dispose() {}, on() {}, resize() {},
  getOption: () => painted.get(id),
});
globalThis.echarts = {
  init: (n) => chartStub(n.id),
  graphic: { LinearGradient: class {} },
};
globalThis.G6 = { Graph: class { data() {} render() {} on() {} destroy() {} changeSize() {} } };
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.localStorage = { getItem: () => null, setItem() {} };
// the page listens for pagehide to send its one analytics beacon; nothing here
// fires it, but the listener has to be attachable for the file to evaluate
globalThis.addEventListener = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000' });
globalThis.location = { search: '', pathname: '/' };
globalThis.history = { replaceState() {} };

const app = new Function(`${src.replace("'use strict';", '')}
  ; return { state, scopedJobs, rank, overview, timeline, termCounts, techMatrix,
             techPairs, toolTrend, coverage, haystack, fold, renderAll, setFilter,
             distinctive, queryTokens, sortJobs, companyKey, withCompanyKeys,
             match, gaps, similar, requirements, ageDays, posted, jobKey,
             loadMe, saveMe, addTypedSkill, toggleSkill, applyView,
             recordSearch, SEARCH_HISTORY, drawerReviews, reviewsFor, stars,
             mergeProfile, counted,
             JOB_COLUMNS, CHART_IDS, FRESH_DEFAULT };`)();
app.state.data = data;
app.withCompanyKeys(data.jobs);
const jobs = data.jobs;

let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`);
};

// --- shape ---------------------------------------------------------------
ok('export carries terms, concepts and seniority_level',
   jobs.every((j) => Array.isArray(j.terms) && Array.isArray(j.concepts)
                     && 'seniority_level' in j));
ok('export carries no per-job words', jobs.every((j) => !('words' in j)));
ok('seniority levels are ordered', Array.isArray(data.seniority_levels),
   data.seniority_levels.join(' < '));

// --- counting ------------------------------------------------------------
const tools = app.termCounts(jobs, 'terms');
ok('tool share never exceeds 100%', tools.terms.every((t) => t.pct <= 100 && t.jobs <= tools.scanned),
   `top ${tools.terms[0].term} ${tools.terms[0].jobs} (${tools.terms[0].pct}%)`);
const concepts = app.termCounts(jobs, 'concepts');
ok('concepts reach more postings than tools', concepts.matched > tools.matched,
   `${concepts.matched} vs ${tools.matched} of ${jobs.length}`);

const cities = app.rank(jobs, 'city', { min: 2 });
const cityTotal = cities.reduce((sum, r) => sum + r.jobs, 0);
const cityRaw = jobs.filter((j) => j.city).length;
ok('grouping the long tail preserves the total', cityTotal === cityRaw,
   `${cityTotal} of ${cityRaw}, ${cities.length} rows`);

// --- matrices ------------------------------------------------------------
const dept = app.techMatrix(jobs, 'family');
ok('field matrix indices stay in range',
   dept.cells.every(([r, c]) => r >= 0 && r < dept.rows.length && c >= 0 && c < dept.cols.length),
   `${dept.rows.length}x${dept.cols.length}`);
ok('matrix rows survive the key round-trip',
   dept.rows.every((r) => jobs.some((j) => j.family === r)),
   `e.g. "${dept.rows.find((r) => r.includes(' ')) || dept.rows[0]}"`);

const level = app.techMatrix(jobs, 'seniority_level',
                             { rowOrder: data.seniority_levels, share: true });
ok('seniority rows follow the ladder, not frequency',
   level.rows.every((r, i) => i === 0
     || data.seniority_levels.indexOf(level.rows[i - 1]) < data.seniority_levels.indexOf(r)),
   level.rows.join(' < '));
ok('share cells are percentages', level.cells.every(([, , v]) => v >= 0 && v <= 100));

// --- trend ---------------------------------------------------------------
const trend = app.toolTrend(jobs);
ok('quarters ascend', trend.quarters.every((q, i) => !i || trend.quarters[i - 1].q < q.q),
   trend.quarters.map((q) => `${q.q}:${q.n}`).join(' '));
ok('every trend quarter clears the minimum', trend.quarters.every((q) => q.n >= 5));
ok('trend shares are percentages',
   trend.series.every((s) => s.share.every((v) => v >= 0 && v <= 100)));

// --- coverage ------------------------------------------------------------
const cov = app.coverage();
ok('coverage counts what the board claims against what we stored',
   cov.stored <= cov.claimed && cov.rows.length === cov.live,
   `${cov.stored}/${cov.claimed} across ${cov.live} live, ${cov.empty} empty`);
ok('worst gap leads the table', cov.rows.every((r, i) => !i || cov.rows[i - 1].gap >= r.gap),
   `${cov.rows[0].name}: ${cov.rows[0].stored}/${cov.rows[0].claimed}`);
// the panel used to print a row per live company -- a thousand lines, heading
// for five thousand -- which buried the handful that need attention
ok('coverage lists shortfalls, not every company',
   cov.problems.length <= cov.rows.length
   && cov.problems.every((r) => r.status !== 'complete' || r.gap > 0),
   `${cov.problems.length} shortfalls, ${cov.complete} complete and not listed`);
ok('every company is either a shortfall or counted as complete',
   cov.problems.length + cov.complete === cov.rows.length,
   `${cov.problems.length} + ${cov.complete} vs ${cov.rows.length}`);

// --- filters -------------------------------------------------------------
const tool = tools.terms[0].term;
app.state.filters.tool = tool;
const scoped = app.scopedJobs();
ok('tool filter narrows to postings naming it',
   scoped.length > 0 && scoped.length < jobs.length && scoped.every((j) => j.terms.includes(tool)),
   `${tool}: ${scoped.length} of ${jobs.length}`);
app.state.filters.tool = '';
app.state.filters.concept = concepts.terms[0].term;
ok('concept filter narrows too', app.scopedJobs().length < jobs.length);
app.state.filters.concept = '';

// --- search --------------------------------------------------------------
const withTerm = jobs.find((j) => j.terms.length);
ok('search reaches extracted tools', app.haystack(withTerm).includes(app.fold(withTerm.terms[0])));
const zwnj = String.fromCharCode(0x645, 0x6cc, 0x200c, 0x634, 0x648, 0x62f);
const plain = String.fromCharCode(0x645, 0x6cc, 0x634, 0x648, 0x62f);
ok('search folds persian orthography', app.fold(zwnj) === app.fold(plain));

// --- relations ------------------------------------------------------------
// Ranking pairs by raw count only re-states which terms are common. These
// assert the ranking is by lift, which is the whole point of the panel.
const pairs = app.techPairs(jobs);
ok('every pairing clears both floors',
   pairs.links.every((l) => l.value >= pairs.minShared && l.lift >= pairs.minLift),
   `${pairs.links.length} of ${pairs.considered} pairs kept`);
ok('pairings are ranked by lift, not by raw count',
   pairs.links.every((l, i) => i === 0 || pairs.links[i - 1].lift >= l.lift));
{
  // a specific pair that is rarer but far more surprising must outrank a
  // generic one that co-occurs more often
  const fake = [
    ...Array.from({ length: 40 }, () => ({ terms: [], concepts: ['Management', 'Reporting'] })),
    ...Array.from({ length: 5 }, () => ({ terms: ['ArgoCD', 'Kubernetes'], concepts: [] })),
    ...Array.from({ length: 20 }, () => ({ terms: [], concepts: ['Management'] })),
  ];
  const top = app.techPairs(fake, { minShared: 4, minLift: 1 }).links[0];
  ok('lift puts a rare specific pair above a common generic one',
     top && top.source === 'ArgoCD' && top.target === 'Kubernetes',
     top ? `${top.source}+${top.target} ${top.lift}x` : 'no links');
}

// --- distinctiveness ------------------------------------------------------
const dist = app.distinctive(jobs, 'department');
ok('no group below the minimum is characterised',
   dist.rows.every((r) => r.n >= dist.min), `${dist.shown} of ${dist.considered} groups`);
ok('every distinctive term beats the corpus rate',
   dist.rows.every((r) => r.terms.every((t) => t.lift > 1 && t.jobs >= 2)));
ok('a distinctive term is really in its group',
   dist.rows.every((r) => r.terms.every((t) =>
     jobs.filter((j) => j.department === r.group
                        && [...j.terms, ...j.concepts].includes(t.term)).length === t.jobs)));

// --- multi-term search ----------------------------------------------------
{
  const withTools = jobs.filter((j) => j.terms.length >= 2)[0];
  const [a, b] = withTools ? withTools.terms : ['Python', 'SQL'];
  app.state.jobs.q = `${a} ${b}`;
  app.state.jobs.mode = 'all';
  const all = app.scopedJobs();
  app.state.jobs.mode = 'any';
  const any = app.scopedJobs();
  ok('matching all terms is a subset of matching any',
     all.length <= any.length && all.every((j) => any.includes(j)),
     `all ${all.length} <= any ${any.length}`);
  ok('every ALL result really carries every term',
     all.every((j) => [...j.terms, ...j.concepts].includes(a)
                   && [...j.terms, ...j.concepts].includes(b)));

  // An alias and its canonical must select the same postings, or the search box
  // is lying about what it looked for. Checked over every alias of every term
  // actually used, not just one sampled term -- the single-word case passed for
  // months while no multi-word alias resolved at all.
  app.state.jobs.mode = 'all';
  const byCanonical = new Map();
  const wrong = [];
  for (const [alias, canonical] of Object.entries(data.vocabulary)) {
    if (!byCanonical.has(canonical)) {
      app.state.jobs.q = canonical;
      byCanonical.set(canonical, app.scopedJobs().length);
    }
    const expected = byCanonical.get(canonical);
    if (!expected) continue;                  // nothing uses this term here
    app.state.jobs.q = alias;
    if (app.scopedJobs().length !== expected) wrong.push(`${alias} -> ${canonical}`);
  }
  ok('every alias selects exactly what its canonical does',
     wrong.length === 0,
     wrong.length ? `${wrong.length} wrong, e.g. ${wrong.slice(0, 2).join('; ')}`
                  : `${byCanonical.size} terms checked`);
  const phrases = Object.keys(data.vocabulary).filter((k) => k.includes(' ')).length;
  ok('the vocabulary really does contain multi-word aliases', phrases > 20, `${phrases} phrases`);

  app.state.jobs.q = 'zzzznotaterm';
  ok('an unresolved token is reported, not silently ignored',
     app.queryTokens()[0].canonical === '' && app.scopedJobs().length === 0);

  // the regression this whole change exists to prevent: the query used to be
  // applied in the jobs table alone, so every other panel counted the
  // unsearched set
  app.state.jobs.q = a;
  const searched = app.scopedJobs();
  ok('the search scopes every panel, not just the table',
     searched.length < jobs.length
     && app.termCounts(searched, 'terms').scanned === searched.length,
     `${a}: ${searched.length} of ${jobs.length}`);
  app.state.jobs.q = '';
  app.state.jobs.mode = 'all';
}

// --- categories and exact spellings ---------------------------------------
ok('every concept has a category',
   Object.keys(data.concept_categories).length > 0
   && jobs.every((j) => j.concepts.every((c) => data.concept_categories[c])));
{
  const cat = [...new Set(Object.values(data.concept_categories))][0];
  const whole = app.termCounts(jobs, 'concepts');
  const part = app.termCounts(jobs, 'concepts', { category: cat });
  ok('a category is a subset of all concepts',
     part.terms.length < whole.terms.length && part.terms.length > 0,
     `${cat}: ${part.terms.length} of ${whole.terms.length}`);
  ok('a category only returns its own concepts',
     part.terms.every((t) => data.concept_categories[t.term] === cat));
}
ok('found never claims a term the posting was not credited with',
   jobs.every((j) => {
     const credited = new Set([...j.terms, ...j.concepts].map(app.fold));
     return (j.found || []).every((f) => credited.has(app.fold(f))
       || credited.has(app.fold(data.vocabulary[app.fold(f)] || '')));
   }));
// A label the posting does not contain is a guess about the role, not a fact
// about the advert: a data-centre maintenance job came back tagged Site
// reliability, so a search for "sre" returned it. Every label must be traceable
// to a spelling the posting actually uses.
{
  const unevidenced = [];
  for (const job of jobs) {
    const stated = new Set((job.found || []).map((f) => data.vocabulary[app.fold(f)] || f));
    for (const label of [...job.terms, ...job.concepts]) {
      if (!stated.has(label)) unevidenced.push(`${label} in ${job.slug}#${job.id}`);
    }
  }
  ok('every label is backed by words in the posting', unevidenced.length === 0,
     unevidenced.length ? `${unevidenced.length} unbacked, e.g. ${unevidenced[0]}`
                        : `${jobs.length} postings checked`);
}

ok('a posting with no requirements has no spellings',
   jobs.every((j) => (j.terms.length || j.concepts.length) || !(j.found || []).length));

// --- sorting --------------------------------------------------------------
{
  const sorted = (key, dir) => {
    app.state.jobs.sort = key; app.state.jobs.dir = dir;
    return app.sortJobs(jobs);
  };
  const ordered = (rows, get) => rows.map(get).filter((v) => v !== null && v !== undefined && v !== '');

  const desc = ordered(sorted('create_time', 'desc'), (j) => j.create_time);
  ok('newest first is the default order',
     desc.every((v, i) => i === 0 || desc[i - 1] >= v), `${desc[0]} … ${desc[desc.length - 1]}`);
  const asc = ordered(sorted('create_time', 'asc'), (j) => j.create_time);
  ok('reversing the direction reverses the order',
     asc.every((v, i) => i === 0 || asc[i - 1] <= v));

  const counts = ordered(sorted('found', 'desc'), (j) => (j.found || []).length);
  ok('a numeric column sorts numerically, not as text',
     counts.every((v, i) => i === 0 || counts[i - 1] >= v), `${counts[0]} … ${counts[counts.length - 1]}`);

  const titles = sorted('title', 'asc');
  ok('sorting keeps every posting', titles.length === jobs.length);
  ok('text sorts by Persian collation',
     (() => {
       const names = titles.map((j) => j.title);
       return names.every((v, i) => i === 0 || names[i - 1].localeCompare(v, 'fa') <= 0);
     })());

  // No column in the current export has a missing value, so the empty-last rule
  // is asserted against a fixture: a vacuous pass would read as coverage it does
  // not have, and would stay green if the rule were deleted.
  {
    const real = app.state.data.jobs;
    app.state.data.jobs = [
      { title: 'B', slug: 'x', family: '', city: 'Tehran', create_time: '2026-01-01', terms: [], concepts: [], found: ['a'] },
      { title: 'A', slug: 'x', family: 'Sales', city: 'Tehran', create_time: '2026-01-02', terms: [], concepts: [], found: [] },
      { title: 'C', slug: 'x', family: null, city: 'Tehran', create_time: '2026-01-03', terms: [], concepts: [], found: ['a', 'b'] },
    ];
    const fixture = app.state.data.jobs;
    for (const dir of ['asc', 'desc']) {
      app.state.jobs.sort = 'family'; app.state.jobs.dir = dir;
      const flags = app.sortJobs(fixture).map((j) => !j.family);
      const first = flags.indexOf(true);
      ok(`missing values sort last (${dir})`,
         first !== -1 && flags.slice(first).every(Boolean) && flags.filter(Boolean).length === 2,
         flags.map((f) => (f ? '-' : 'x')).join(''));
    }
    app.state.data.jobs = real;
  }

  // sorting must order the whole result before it is paged, or page 1 is the
  // top of an arbitrary slice rather than the top of the table
  const keys = app.JOB_COLUMNS.map((c) => c.key);
  ok('every column is declared once and can produce its own value',
     new Set(keys).size === keys.length
     && app.JOB_COLUMNS.every((c) => typeof c.get === 'function'),
     keys.join(', '));
  app.state.jobs.sort = 'create_time'; app.state.jobs.dir = 'desc';
}

// --- the renderers actually run ------------------------------------------
// echarts is stubbed, so this asserts the panels build their options without
// throwing -- not how they look. It is what catches a typo'd variable in one
// renderer silently blanking every panel below it.
app.state.loaded = { g6: true };
// give every panel something to draw before asserting that they all draw. The
// seeker view deliberately narrows to 30 days, which leaves the quarterly trend
// with one quarter and the gap list with nothing to compare against -- both are
// correct empty states, and neither would prove the renderers work.
app.state.jobs.fresh = 0;
const seeded = app.termCounts(jobs, 'terms').terms.slice(0, 5).map((t) => t.term);
app.state.me = { skills: seeded, saved: [], applied: [], hidden: [], seen: '' };
app.state.mine = new Set(seeded);
let rendered = true;
try {
  app.renderAll();
} catch (err) {
  rendered = false;
  console.log(`     renderAll threw: ${err.message}`);
}
ok('renderAll paints every panel without throwing', rendered);
if (rendered) {
  // the network graph is drawn by G6, not echarts, so it never lands in `painted`
  const expected = app.CHART_IDS.filter((id) => id !== '#chart-network');
  const missing = expected.filter((id) => !painted.has(id));
  ok('every echarts panel drew', missing.length === 0,
     missing.length ? `missing: ${missing.join(', ')}` : `${expected.length} panels`);
}

// A formatted numeric column ("8.3x") used to reach Intl and render as NaN in
// every row, which reads as data rather than as a bug. Nothing on screen may
// say NaN.
if (rendered) {
  const text = (node) => (node && typeof node === 'object'
    ? [node.textContent || '', node.text || '', ...(node.children || []).map(text)].join(' ')
    : String(node ?? ''));
  const painted_text = [...nodes.entries()].map(([sel, node]) => [sel, text(node)]);
  const nan = painted_text.filter(([, t]) => /\bNaN\b/.test(t)).map(([sel]) => sel);
  ok('no panel renders NaN', nan.length === 0, nan.length ? nan.join(', ') : '');
}

// --- the seeker's arithmetic ---------------------------------------------

// one spelling per value. The city chart used to draw Tehran twice, as "تهران"
// and "Tehran", and undercount the capital by a quarter.
const latin = [...new Set(jobs.map((j) => j.city).filter(Boolean))]
  .filter((city) => /^[\x20-\x7e]+$/.test(city) && city !== 'Abroad');
ok('no city is left in two scripts', latin.length === 0,
   latin.length ? latin.join(', ') : `${new Set(jobs.map((j) => j.city)).size} distinct cities`);

// the shared grouping axis has to reach more of the corpus than the per-board
// field it replaced, or the swap made the panels worse
const withFamily = jobs.filter((j) => j.family).length;
const withDept = jobs.filter((j) => j.department).length;
ok('job family covers more postings than department did', withFamily > withDept,
   `${withFamily} vs ${withDept} of ${jobs.length}`);
ok('every family is one the export declares',
   jobs.every((j) => !j.family || data.families.includes(j.family)));
ok('no salary is exported', jobs.every((j) => !('min_salary' in j) && !('max_salary' in j)));

// match is a share of what a posting asks for, so it cannot exceed 100, and it
// must be null rather than 0 when there is nothing to compare
app.state.me = { skills: [], saved: [], applied: [], hidden: [], seen: '' };
app.state.mine = new Set();
ok('match is unknown, not zero, before any skill is entered',
   jobs.every((j) => app.match(j) === null));

const popular = app.termCounts(jobs, 'terms').terms.slice(0, 5).map((t) => t.term);
app.state.me.skills = popular;
app.state.mine = new Set(popular);
const scored = jobs.map((j) => app.match(j)).filter(Boolean);
ok('match never exceeds 100%', scored.every((m) => m.pct >= 0 && m.pct <= 100),
   `${scored.length} postings scored on ${popular.length} skills`);
ok('match counts only requirements the posting names',
   scored.every((m) => m.have + m.missing.length === m.need));
const unlabelled = jobs.filter((j) => !j.terms.length && !j.concepts.length);
ok('a posting with no requirements scores unknown, not zero',
   unlabelled.every((j) => app.match(j) === null), `${unlabelled.length} unlabelled`);

// the gap list must be about the seeker, not a second copy of the popularity
// ranking: every row is something they lack, and it only counts postings that
// already share a skill with them
const gap = app.gaps(jobs);
ok('nothing you already have appears in the gap list',
   gap.rows.every((row) => !app.state.mine.has(row.key)),
   `${gap.rows.length} rows over ${gap.considered} partly-matching postings`);
ok('no gap row claims more postings than were considered',
   gap.rows.every((row) => row.jobs <= gap.considered));
const partly = jobs.filter((j) => {
  const m = app.match(j);
  return m && m.have > 0;
}).length;
ok('the gap list counts exactly the postings that share a skill',
   gap.considered === partly, `${gap.considered} vs ${partly}`);

// freshness: a window means a window. An undated posting is not evidence of
// being recent, and 13% of what the boards list is over six months old.
app.state.jobs.fresh = 30;
const recent = app.scopedJobs();
ok('a 30-day window admits nothing older, and nothing undated',
   recent.every((j) => { const age = app.ageDays(j); return age !== null && age <= 30; }),
   `${recent.length} of ${jobs.length} postings`);
app.state.jobs.fresh = 0;
ok('"any time" widens the scope rather than narrowing it',
   app.scopedJobs().length >= recent.length,
   `${app.scopedJobs().length} vs ${recent.length}`);

// asserted against a fixture, because every posting collected so far happens to
// carry a date: on the real corpus the rule about undated postings cannot fail,
// so a check phrased over it would stay green with the rule deleted
{
  const real = app.state.data.jobs;
  app.state.data.jobs = [
    { source: 's', slug: 'x', id: 1, title: 'dated', create_time: new Date().toISOString(),
      terms: [], concepts: [], found: [] },
    { source: 's', slug: 'x', id: 2, title: 'undated', create_time: null,
      terms: [], concepts: [], found: [] },
  ];
  app.withCompanyKeys(app.state.data.jobs);
  app.state.jobs.fresh = 30;
  const windowed = app.scopedJobs();
  ok('an undated posting is not admitted by a freshness window',
     windowed.length === 1 && windowed[0].title === 'dated',
     windowed.map((j) => j.title).join(', ') || 'nothing');
  app.state.jobs.fresh = 0;
  ok('...but "any time" still shows it', app.scopedJobs().length === 2);
  app.state.data.jobs = real;
  app.withCompanyKeys(app.state.data.jobs);
}
ok('a posting over six months old is marked stale',
   jobs.filter((j) => (app.ageDays(j) ?? 0) > 180).every((j) => app.posted(j).stale));

// saved and hidden are the visitor's own marks, and must actually filter
const someKey = app.jobKey(jobs[0]);
app.state.me.saved = [someKey];
app.state.jobs.only = 'saved';
const savedOnly = app.scopedJobs();
ok('"saved only" shows exactly what was saved',
   savedOnly.length === 1 && app.jobKey(savedOnly[0]) === someKey);
app.state.jobs.only = '';
app.state.me.hidden = [someKey];
ok('a hidden posting is gone from the normal list',
   !app.scopedJobs().some((j) => app.jobKey(j) === someKey));
app.state.jobs.only = 'hidden';
ok('...but reachable again through "hidden only"',
   app.scopedJobs().some((j) => app.jobKey(j) === someKey));
app.state.me.hidden = [];
app.state.me.saved = [];
app.state.jobs.only = '';

// a typed skill has to resolve to something countable: a skill list full of
// spellings the data does not use would score every posting at zero
const resolved = app.addTypedSkill('k8s');
ok('a typed alias resolves to its canonical skill', resolved === 'Kubernetes', String(resolved));
ok('an unknown skill is refused rather than stored',
   app.addTypedSkill('definitely not a real tool') === null);

// "postings like this one" must share requirements and never include itself
const withTerms = jobs.find((j) => app.requirements(j).length >= 3);
if (withTerms) {
  const like = app.similar(withTerms);
  ok('similar postings share requirements and exclude the posting itself',
     like.every((row) => row.shared > 0 && app.jobKey(row.job) !== app.jobKey(withTerms)),
     `${like.length} similar to "${String(withTerms.title).slice(0, 30)}"`);
  ok('similar postings are ranked by how much they share',
     like.every((row, i) => i === 0 || like[i - 1].shared >= row.shared));
}

// every column renders through the same list the headers come from, so a new
// column can never shift the values one place left
ok('the actions column is not sortable',
   app.JOB_COLUMNS.filter((c) => c.sortable === false).every((c) => c.key === 'mark'));
ok('every column has a label or is explicitly unsortable',
   app.JOB_COLUMNS.every((c) => c.label || c.sortable === false));


// --- mining recall --------------------------------------------------------
// The floor that a model-only pipeline fails. When a cached model answer
// replaced alias matching instead of joining it, this sat at 88%: the model
// simply did not mention most of what the postings said.
const reach = data.extracted / (data.described || 1);
ok('extraction reaches almost every described posting', reach >= 0.95,
   `${data.extracted} of ${data.described} (${(100 * reach).toFixed(1)}%)`);
// A cached model answer used to replace alias matching rather than joining it,
// so anything the model overlooked was lost even though the words were in the
// posting. Every label must now be one the text actually spells.
const spelled = new Set(Object.keys(data.vocabulary || {}));
const unspellable = jobs.filter((j) => (j.terms.length || j.concepts.length) && !j.found.length);
ok('a posting with labels also has the spellings behind them',
   unspellable.length === 0,
   unspellable.length ? `${unspellable.length} e.g. ${unspellable[0].title}` : '');
ok('every spelling resolves to a canonical term we know',
   jobs.every((j) => (j.found || []).every((f) => spelled.has(app.fold(f)))),
   `${spelled.size} spellings in the index`);
// the drawer shows every spelling; the table cell caps at six and says so
const richest = jobs.slice().sort((a, b) => b.found.length - a.found.length)[0];
ok('a rich posting keeps all its spellings, not a capped sample',
   richest.found.length > 10,
   `${richest.found.length} spellings on "${String(richest.title).slice(0, 34)}"`);

// --- the visitor's own search history -------------------------------------
// Stored in localStorage and never sent anywhere, but it is still the most
// sensitive thing this page keeps, so the rules that bound it are asserted.
{
  const seen = [];
  app.recordSearch('k', seen);
  ok('a single letter is not a search', seen.length === 0);
  app.recordSearch('kubernetes', seen);
  app.recordSearch('python', seen);
  ok('the newest search comes first', seen[0] === 'python', seen.join(', '));
  app.recordSearch('KUBERNETES', seen);
  ok('re-searching promotes instead of duplicating',
     seen[0] === 'KUBERNETES' && seen.length === 2, seen.join(', '));
  for (let i = 0; i < app.SEARCH_HISTORY + 10; i += 1) app.recordSearch(`term${i}`, seen);
  ok('the history is capped, so it stays a shortcut and not a record',
     seen.length === app.SEARCH_HISTORY, `${seen.length} kept, cap ${app.SEARCH_HISTORY}`);
}

// --- company reviews -------------------------------------------------------
// The drawer is only built on a click, so nothing above would notice a
// ReferenceError in here. Render it for real against a synthetic review.
{
  ok('a rating renders as five glyphs', app.stars(4) === '\u2605\u2605\u2605\u2605\u2606',
     app.stars(4));
  ok('a rating out of range is clamped rather than repeated negatively',
     app.stars(99).length === 5 && app.stars(-3).length === 5);

  const company = data.companies[0];
  const key = app.companyKey(company);
  const mine = { source: company.source, slug: company.slug, rating: 5, role: 'SRE',
                 tenure: '2 years', body: 'Synthetic review, for the checker only.',
                 created_at: '2026-08-19T00:00:00+00:00' };
  const theirs = { ...mine, source: 'candoo', slug: '\u0000nobody-else\u0000', body: 'Other.' };
  app.state.data.reviews = [mine, theirs];

  ok('reviews are matched to their own company only',
     app.reviewsFor(key).length === 1, `${app.reviewsFor(key).length} matched`);

  const host = document.createElement('div');
  app.drawerReviews(host, key);
  ok('the reviews section renders without throwing', host.children.length > 0,
     `${host.children.length} nodes`);
  app.state.data.reviews = [];
  const empty = document.createElement('div');
  app.drawerReviews(empty, key);
  ok('a company with no reviews still renders a section', empty.children.length > 0);

  // The submission form only appears once an API is configured, and the
  // Turnstile widget only once a site key is. Both branches went unrun until
  // the first export that carried them, and the second one threw when it did.
  app.state.data.api = { url: 'https://api.example.invalid', turnstile: '' };
  const noKey = document.createElement('div');
  app.drawerReviews(noKey, key);
  ok('the form renders when an API is configured', noKey.children.length > 0);

  app.state.data.api = { url: 'https://api.example.invalid', turnstile: '0xSITEKEY' };
  let threw = '';
  const withKey = document.createElement('div');
  try { app.drawerReviews(withKey, key); } catch (err) { threw = err.message; }
  ok('...and still renders once a Turnstile key is set', !threw, threw);
  app.state.data.api = undefined;
}

// --- syncing a list between devices ----------------------------------------
// Signing in on a second device is the case that must not lose anything: this
// browser has skills, the account has others, and picking a winner would be the
// worst possible answer to "make my things follow me".
{
  app.state.me = { skills: ['Python'], saved: ['a'], applied: [], hidden: [],
                   searches: ['devops'], seen: '' };
  app.mergeProfile({ skills: ['Kubernetes', 'python'], saved: ['b'],
                     searches: ['sre'], hidden: ['x'] });

  ok('what the account knew is added', app.state.me.skills.includes('Kubernetes'));
  ok('what this browser knew is kept', app.state.me.skills.includes('Python'));
  ok('the same skill in a different case is not duplicated',
     app.state.me.skills.filter((s) => s.toLowerCase() === 'python').length === 1,
     app.state.me.skills.join(','));
  ok('every list merges, not just the first',
     app.state.me.saved.length === 2 && app.state.me.hidden.length === 1
     && app.state.me.searches.length === 2);

  // a remote list that is nonsense must not take the dashboard down on boot
  app.mergeProfile(null);
  app.mergeProfile({ skills: 'not-an-array', saved: [1, 2, null] });
  ok('a malformed profile is ignored rather than fatal',
     app.state.me.skills.includes('Python') && app.state.me.saved.length === 2);

  // and the search history stays bounded however much arrives
  app.mergeProfile({ searches: Array.from({ length: 50 }, (_, i) => `term${i}`) });
  ok('a merged history is still capped',
     app.state.me.searches.length === app.SEARCH_HISTORY,
     `${app.state.me.searches.length} kept`);
}

// --- the two languages say the same things --------------------------------
// The Persian copy is written and revised by hand, and the failure that costs
// the most is the quiet one: a key dropped in translation renders as whatever
// English happened to be in the markup, on one page, in one language, which
// nobody who reads the other language will ever see.
{
  const load = (code) => JSON.parse(fs.readFileSync(`${root}lang/${code}.json`, 'utf8'));
  const en = load('en');
  const fa = load('fa');

  const paths = (node, prefix = '') => Object.entries(node).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? paths(v, key) : [key];
  });
  const at = (o, k) => k.split('.').reduce((a, s) => a[s], o);

  const inEn = paths(en);
  const inFa = paths(fa);
  const missing = inEn.filter((k) => !inFa.includes(k));
  const extra = inFa.filter((k) => !inEn.includes(k));

  ok('every English key has a Persian one', missing.length === 0, missing.join(', '));
  ok('...and Persian invents none of its own', extra.length === 0, extra.join(', '));
  ok('no string was left empty',
     !inEn.some((k) => !String(at(en, k)).trim())
       && !inFa.some((k) => !String(at(fa, k)).trim()));
  // the direction is data, not a guess made in the stylesheet
  ok('Persian is right-to-left and English is not',
     fa.meta.dir === 'rtl' && en.meta.dir === 'ltr',
     `${fa.meta.dir} / ${en.meta.dir}`);
  // a translated sentence that drops its {n} renders the placeholder to nobody
  ok('both catalogues carry the same placeholders',
     inEn.filter((k) => inFa.includes(k)).every((k) => {
       const slots = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
       return slots(at(en, k)) === slots(at(fa, k));
     }));
  console.log(`     ${inEn.length} keys in each catalogue`);

  // ...and every key the markup asks for exists. A typo here is invisible in
  // testing -- the element simply keeps whatever was already in the HTML, which
  // is the other language, on one page, for the readers least able to report it.
  const pages = ['index.html', 'donate/index.html', 'login/index.html',
                 'employer/index.html', 'dashboard/index.html'];
  const asked = new Set();
  for (const page of pages) {
    let html;
    try { html = fs.readFileSync(`${root}${page}`, 'utf8'); } catch { continue; }
    for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) asked.add(key);
    for (const [, spec] of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of spec.split(';')) {
        const key = pair.split(':')[1];
        if (key) asked.add(key.trim());
      }
    }
  }
  // the scripts ask for keys too, by `t('a.b.c', 'English')`
  for (const script of ['app.js', 'landing.js', 'donate.js']) {
    let js;
    try { js = fs.readFileSync(`${root}${script}`, 'utf8'); } catch { continue; }
    for (const [, key] of js.matchAll(/\bt\(\s*'([a-z][\w.]+)'/gi)) asked.add(key);
  }

  const unknown = [...asked].filter((k) => !inEn.includes(k));
  ok('every key the markup asks for is in the catalogue',
     unknown.length === 0, unknown.join(', '));
  // and nothing in the catalogue is dead weight nobody renders
  const unused = inEn.filter((k) => !asked.has(k) && !k.startsWith('meta.'));
  console.log(`     ${asked.size} keys used by the markup, ${unused.length} not yet wired`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
