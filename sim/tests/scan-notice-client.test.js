'use strict';

// scan-notice-client.test.js — the CLIENT half of the scan notices (roadmap 2.5, ruling 12 slice-3b checklist
// item 9(a); docs/event-log.md §13): the `scan_complete` / `scan_voided` rows in MESSAGES and their popup on the
// shared #notice-overlay card, in the scout's voice, passive (Dismiss alone).
//
// The client has no DOM test harness, so — as outpost-teardown-client.test.js does — this cuts the page's OWN
// notice code out of game.html and runs it in a node:vm sandbox with a stub DOM, against REAL engine output:
// the per-guild view of a guild whose scans really completed and really were voided (tests/scan-notice-script.js).
// The live page is driven end to end by the Playwright harness outside the repo (the roadmap's 3a item 8(c)).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem } = require('../seed.js');
const { scanNoticeScript } = require('./scan-notice-script.js');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
assert.ok(guildScript.length < html.length, 'the Guild Hall script is found');
const guildHelpersSrc = cut(guildScript, /\n  function el\(id\)\{[\s\S]*?(?=\n  function pad4\()/, 'the Guild Hall helpers (el … esc)');
const prettyGoodSrc = cut(guildScript, /\n  function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood');
const noticeSrc = cut(guildScript, /\n  \/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n  function centreFor\()/, 'the notice code (Notices … centreFor)');

// ---- real engine output ------------------------------------------------------------------------------------

const { steps, A, ARRAY, TARGET, CONTESTED, SURFACED } = scanNoticeScript();
const TARGET_NAME = getSystem(TARGET).name;
const CONTESTED_NAME = getSystem(CONTESTED).name;
const ARRAY_LABEL = `Deep Scan Array ${ARRAY.split('_').slice(-1)[0]}`;   // "Deep Scan Array 01"

// The view exactly as the browser receives it from GET /snapshot?guild=<A>: A's three completions (an L1 with
// every archetype new, an L2, the same L1 again with nothing new), plus the voided row from the other timeline
// (re-numbered clear of the engine's counter), plus a read deploy_failed in its published shape — so the card
// can be shown to hand the pilot and its forks back.
const VOIDED_ID = 50;
const DEPLOY_FAILED_ID = 51;
function viewSnapshot() {
  const snap = JSON.parse(JSON.stringify(buildSnapshot(steps.repeatDone, A)));
  const me = snap.guilds.find((g) => g.id === A);
  const voidedRow = JSON.parse(JSON.stringify(buildSnapshot(steps.voided, A))).guilds.find((g) => g.id === A).events[0];
  me.events.unshift(
    { ...voidedRow, id: VOIDED_ID },
    { id: DEPLOY_FAILED_ID, type: 'deploy_failed', tick: 0, whenDay: 0, readTick: 0, payload: {
      cause: 'occupied', kind: 'outpost', targetHex: { q: 1, r: 2 }, craftId: `vehicle_${A}_heavyTransport_01`,
      craftClass: 'heavyTransport', retreatSystemId: TARGET, retreatSystemName: TARGET_NAME } },
  );
  snap.attention.notices.unshift({ guildId: A, id: VOIDED_ID, tick: voidedRow.tick, type: voidedRow.type, payload: voidedRow.payload });
  return snap;
}
const rowOf = (snap, pick) => snap.guilds.find((g) => g.id === A).events.find(pick);
const l1Row = (snap) => rowOf(snap, (e) => e.type === 'scan_complete' && e.payload.level === 'L1' && e.payload.newFacts > 0);
const l2Row = (snap) => rowOf(snap, (e) => e.type === 'scan_complete' && e.payload.level === 'L2');
const repeatRow = (snap) => rowOf(snap, (e) => e.type === 'scan_complete' && e.payload.newFacts === 0);
const voidedRowOf = (snap) => rowOf(snap, (e) => e.id === VOIDED_ID);

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const plain = (x) => JSON.parse(JSON.stringify(x));

function stubNode(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', style: {},
    hidden: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].includes(id),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
  };
}
// noticePage(snapshot) -> the page's notice code running against `snapshot` for the player A, on a stub DOM.
function noticePage(snapshot) {
  const nodes = {};
  const sent = [];
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stubNode(id)) },
    window: {
      __player: () => ({ guildId: A }),
      __snapshot: () => snapshot,
      __sendAction: (a) => { sent.push(a); return Promise.resolve({ accepted: true }); },
      __refreshNow: () => Promise.resolve(),
      __outpostName: (id) => id,
    },
  };
  vm.runInNewContext(guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const node = (id) => sandbox.document.getElementById(id);
  const view = () => ({
    open: node('notice-overlay').classList.contains('open'),
    eyebrow: node('noticeEyebrow').textContent,
    art: node('noticeArt').style.backgroundImage,
    title: node('noticeTitle').textContent,
    paragraphs: [...node('noticeBody').innerHTML.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => unescape(m[1])),
    facts: [...node('noticeFacts').innerHTML.matchAll(/<span class="k">([^<]*)<\/span><span class="v[^"]*">([^<]*)<\/span>/g)]
      .map((m) => [unescape(m[1]), unescape(m[2])]),
    buttons: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].filter((id) => !node(id).hidden),
    note: node('noticeNote').textContent,
  });
  return { page: sandbox, sent, view };
}

// ---- the rows ----------------------------------------------------------------------------------------------

test('rows and titles: "Survey complete — <target>" / "Survey voided — <target>", never the licence-lapse fallback', () => {
  const snap = viewSnapshot();
  const { page } = noticePage(snap);
  const done = l1Row(snap);
  const voided = voidedRowOf(snap);
  assert.equal(page.noticeTitle(done), 'Survey complete');
  assert.equal(page.noticeTitle(voided), 'Survey voided');
  assert.equal(page.noticeRowTitle(done), `Survey complete &mdash; <span class="who">${TARGET_NAME}</span>`);
  assert.equal(page.noticeRowTitle(voided), `Survey voided &mdash; <span class="who">${CONTESTED_NAME}</span>`);
  assert.equal(page.noticeRowTitle(l2Row(snap)), `Survey complete &mdash; <span class="who">${l2Row(snap).payload.targetName}</span>`);
  for (const n of [done, voided]) {
    assert.doesNotMatch(page.noticeRowTitle(n) + page.noticeTitle(n), /Licence|lapsed/);
    assert.equal(page.isScanNotice(n), true);
    assert.equal(page.isDeliveryNotice(n), false);
  }
});

test('the unread count: unread scan notices light the Messages badge like any notice', () => {
  const snap = viewSnapshot();
  const { page } = noticePage(snap);
  const unread = page.myUnreadNotices(snap).map((n) => n.type).sort();
  assert.deepEqual(unread, ['scan_complete', 'scan_complete', 'scan_complete', 'scan_voided']);
});

// ---- the popup -------------------------------------------------------------------------------------------

test('popup, complete: the scout reports the array, the target and the readings logged; Dismiss alone', () => {
  const snap = viewSnapshot();
  const n = l1Row(snap);
  const { page, view } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(view(), {
    open: true,
    eyebrow: 'Guild Scout',
    art: "url('assets/characters/spy.jpg')",
    title: 'Survey complete',
    paragraphs: [`${ARRAY_LABEL} — survey of ${TARGET_NAME} complete.`, `${n.payload.newFacts} readings logged.`],
    facts: [
      ['Array', ARRAY_LABEL],
      ['Target', TARGET_NAME],
      ['Survey', 'System survey'],
      ['New readings', String(n.payload.newFacts)],
      ['Completed', `Day ${n.whenDay}`],
    ],
    buttons: [],
    note: '',
  });
});

test('popup, complete with nothing new: "already charted", and 0 readings in the facts', () => {
  const snap = viewSnapshot();
  const n = repeatRow(snap);
  const { page, view } = noticePage(snap);
  page.openNotice(n.id);
  const v = view();
  assert.deepEqual(v.paragraphs, [`${ARRAY_LABEL} — survey of ${TARGET_NAME} complete.`, 'Nothing new — already charted.']);
  assert.deepEqual(v.facts.find((f) => f[0] === 'New readings'), ['New readings', '0']);
});

test('popup, an L2: the planet\'s designation and "Planet survey"; one reading reads singular', () => {
  const snap = viewSnapshot();
  const n = l2Row(snap);
  assert.equal(n.payload.targetPlanetId, SURFACED);
  const { page, view } = noticePage(snap);
  page.openNotice(n.id);
  let v = view();
  assert.equal(v.paragraphs[0], `${ARRAY_LABEL} — survey of ${n.payload.targetName} complete.`);
  assert.deepEqual(v.facts.slice(1, 3), [['Target', n.payload.targetName], ['Survey', 'Planet survey']]);
  // The engine's count is worded, never computed: 1 is "reading", the rest "readings".
  n.payload.newFacts = 1;
  page.openNotice(n.id);
  v = view();
  assert.equal(v.paragraphs[1], '1 reading logged.');
});

test('popup, voided: the scout names the guild that claimed the target first; Dismiss alone', () => {
  const snap = viewSnapshot();
  const n = voidedRowOf(snap);
  const { page, view } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(view(), {
    open: true,
    eyebrow: 'Guild Scout',
    art: "url('assets/characters/spy.jpg')",
    title: 'Survey voided',
    paragraphs: [`${ARRAY_LABEL} — survey of ${CONTESTED_NAME} voided; Third claimed it before it finished.`],
    facts: [
      ['Array', ARRAY_LABEL],
      ['Target', CONTESTED_NAME],
      ['Survey', 'System survey'],
      ['Claimed by', 'Third'],
      ['Voided', `Day ${n.whenDay}`],
    ],
    buttons: [],
    note: '',
  });
});

test('the shared card is re-dressed on every open: pilot → scout → Syndicate → scout, nothing carried over', () => {
  const snap = viewSnapshot();
  const { page, view } = noticePage(snap);
  page.openNotice(DEPLOY_FAILED_ID);
  assert.deepEqual([view().eyebrow, view().buttons], ['Fleet — Dispatch', ['noticeRedeploy', 'noticeReturn']]);
  page.openNotice(l1Row(snap).id);
  assert.deepEqual([view().eyebrow, view().art, view().buttons], ['Guild Scout', "url('assets/characters/spy.jpg')", []], 'the forks are hidden again');
  // A Syndicate notice after the scout gets the adviser back.
  snap.guilds.find((g) => g.id === A).events.push({ id: 52, type: 'venture_closed', tick: 0, whenDay: 0, readTick: 0,
    payload: { cause: 'teardown', good: 'titanium', ventureType: 'mining', ventureName: 'Somewhere · Node 1' } });
  page.openNotice(52);
  assert.deepEqual([view().eyebrow, view().art], ['Syndicate Notice', "url('assets/characters/advisor.jpg')"]);
  page.openNotice(VOIDED_ID);
  assert.deepEqual([view().eyebrow, view().art, view().buttons], ['Guild Scout', "url('assets/characters/spy.jpg')", []]);
});

test('read-on-open is unchanged: an unread scan notice sends one acknowledgeEvent by numeric id; a reopen of a read one sends none', () => {
  const snap = viewSnapshot();
  const n = l1Row(snap);
  assert.equal(n.readTick, undefined, 'premise: born unread');
  const { page, sent } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(plain(sent), [{ type: 'acknowledgeEvent', guildId: A, eventId: n.id }]);
  assert.equal(typeof sent[0].eventId, 'number');
  page.openNotice(DEPLOY_FAILED_ID);   // already read
  assert.equal(sent.length, 1);
});

test('wiring: the scout portrait the card swaps in is the survey popup\'s own asset, and it exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'client', 'assets', 'characters', 'spy.jpg')));
  assert.match(html, /id="survey-overlay"[\s\S]*?assets\/characters\/spy\.jpg/, 'the survey popup wears the same scout');
});
