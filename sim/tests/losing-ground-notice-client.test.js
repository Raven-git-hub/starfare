'use strict';

// losing-ground-notice-client.test.js — losing ground, client slice 1: the notices (roadmap 2.5; docs/event-log.md
// §13–§15). The engine already wrote four notices the player client had no words for, so each fell through to the
// wrong card: `system_lost`, `assets_inherited` and `assets_swept` read "Licence lapsed — Venture", and a scan voided
// because its ARRAY went dark (`reason: 'anchor-lost'`) read as a rival's claim. This slice gives each its words and
// facts, and the three territory notices Show on map to the system. Client only.
//
// The client has no DOM test harness, so — as scan-notice-client.test.js does — this cuts the page's OWN notice code
// (and its kit-kinds table, which names a kit) out of game.html and runs it in a node:vm sandbox with a stub DOM,
// against REAL engine output, each guild's view exactly as GET /snapshot?guild= sends it:
//   - sweep-script.js: g1 abandons TARGET with a position there (two ventures, machines, a kit, goods), then g2 plants
//     there and its claim sweeps g1's stranded machines. So g1 holds a real `system_lost` and `assets_swept`, and g2 a
//     real `assets_inherited`;
//   - eviction-reach-script.js: g1 abandons TARGET while a Deep Scan Array that hung off it alone is mid-scan — a real
//     `anchor-lost` void — with nothing else of g1's there, so that `system_lost` lists nothing;
//   - scan-notice-script.js: a real rival void, which carries no `reason`.
// The live popups in the browser are the Playwright harness's, outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem, getSite } = require('../seed.js');
const { scanTargetName } = require('../deep-scan-arrays.js');
const { createAbandonPrefectureAction } = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const R = require('./eviction-reach-script.js');
const { scanNoticeScript } = require('./scan-notice-script.js');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// The Syndicate's words, verbatim from game.html (docs/event-log.md §14 / §15 quote them). Draft copy, to be tuned.
const SYSTEM_LOST_ABANDONED = 'You abandoned this Prefecture, and it has been destroyed. The system is unclaimed again.';
const SYSTEM_LOST_DESTROYED = 'Your Prefecture here has been destroyed. The system is unclaimed again.';
const SYSTEM_LOST_AFTERMATH = 'Any ventures you ran there are closed, and any goods you held there are forfeit. Any machines you left behind are stranded in the system, awaiting salvage. Your exploration record of it is kept.';
const INHERITED_LINES = [
  'Your claim on this system came with machines another guild left stranded here. They are yours now: idle, and ready to put to work.',
  'The ground may come spoiled, though. Where the old ventures held licences, their nodes stay locked out until the terms clear, so you may not be able to put the machines on them yet.',
];
const SWEPT_AFTERMATH = 'They are gone from your inventory. There is nothing left there to salvage.';
// The scout's second line on a dark array (§13).
const DARK_LINE = 'It lost its footing: it no longer touches any ground you hold. It can take a new survey once your control reaches it again.';

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
assert.ok(guildScript.length < html.length, 'the Guild Hall script is found');
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
const guildHelpersSrc = cut(guildScript, /\n  function el\(id\)\{[\s\S]*?(?=\n  function pad4\()/, 'the Guild Hall helpers (el … esc)');
const prettyGoodSrc = cut(guildScript, /\n  function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood');
const noticeSrc = cut(guildScript, /\n  \/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n  function centreFor\()/, 'the notice code (Notices … centreFor)');

// ---- real engine output ------------------------------------------------------------------------------------

const { TARGET } = P;
const TARGET_NAME = getSystem(TARGET).name;
const TARGET_HEX = getSystem(TARGET).coords;
const RIVAL_NAME = 'Vantor Combine';

// swept() -> sweep-script.js's fallow(), then g2 — named, as a founded guild is — plants in TARGET and sweeps g1's
// four stranded assets (a miner, two factories, an Outpost kit).
function swept() {
  const f = S.fallow();
  let s = structuredClone(f.s);
  S.guildOf(s, 'g2').name = RIVAL_NAME;
  let rivalKit;
  ({ s, rivalKit } = S.rivalReady(s));
  return { ...f, s: P.accept(s, S.rivalPlant(rivalKit)) };
}
const SWEPT = swept();
// darkened() -> the eviction-reach galaxy, abandoned: g1's array that hung off TARGET alone goes dark mid-scan.
const DARKENED = (() => {
  const { s, arrays } = R.reachGalaxy();
  return { s: P.accept(s, createAbandonPrefectureAction({ guildId: 'g1', prefectureId: S.PREFECTURE })), arrays };
})();
const SCANS = scanNoticeScript();

// The view exactly as the browser receives it.
const viewOf = (s, guildId) => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId) => snap.guilds.find((g) => g.id === guildId);
const rowOf = (snap, guildId, type) => meOf(snap, guildId).events.find((e) => e.type === type);

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const plain = (x) => JSON.parse(JSON.stringify(x));
const titleCase = (good) => good.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function stubNode(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', style: {},
    hidden: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].includes(id),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
  };
}
// noticePage(snapshot, guildId) -> the page's notice code running against `snapshot` for the player `guildId`, on a
// stub DOM. The shell bridges it reads are given the seed's own answers: __boardSystem the board row (its centre hex),
// __planetDesignation the engine's designation ("Nyx IV"). `sent` records every action posted, `flown` every __flyTo.
function noticePage(snapshot, guildId) {
  const nodes = {};
  const sent = [];
  const flown = [];
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stubNode(id)) },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => snapshot,
      __sendAction: (a) => { sent.push(a); return Promise.resolve({ accepted: true }); },
      __refreshNow: () => Promise.resolve(),
      __flyTo: (q, r, z) => { flown.push([q, r, z]); },
      __outpostName: (id) => (id === 'outpost_g1_02' ? 'Nyx Outpost' : id),
      __boardSystem: (id) => getSystem(id),
      __planetDesignation: (planetId) => scanTargetName({ level: 'L2', targetPlanetId: planetId }),
    },
  };
  vm.runInNewContext(kitKindsSrc + guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const node = (id) => sandbox.document.getElementById(id);
  // What the player sees on the card right now.
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
  return { page: sandbox, sent, flown, view };
}

// ---- 1. the rows -------------------------------------------------------------------------------------------

test('rows and titles: each territory notice names its system, and none falls back to the licence lapse', () => {
  const g1 = viewOf(SWEPT.s, 'g1');
  const g2 = viewOf(SWEPT.s, 'g2');
  const { page } = noticePage(g1, 'g1');
  const cases = [
    [rowOf(g1, 'g1', 'system_lost'), 'System lost'],
    [rowOf(g1, 'g1', 'assets_swept'), 'Machines taken'],
    [rowOf(g2, 'g2', 'assets_inherited'), 'Machines inherited'],
  ];
  for (const [n, prefix] of cases) {
    assert.ok(n, `premise: the ${prefix} row reached the player's own view`);
    assert.equal(n.payload.systemName, TARGET_NAME, 'premise: the engine wrote the seed name');
    assert.equal(page.noticeTitle(n), `${prefix} — ${TARGET_NAME}`);
    assert.equal(page.noticeRowTitle(n), `${prefix} &mdash; <span class="who">${TARGET_NAME}</span>`);
    assert.doesNotMatch(page.noticeRowTitle(n) + page.noticeTitle(n), /Licence|lapsed|Venture/);
    assert.equal(page.isTerritoryNotice(n), true);
    assert.equal(page.isDeliveryNotice(n) || page.isScanNotice(n), false, 'not a Trader or scout notice');
  }
});

test('the inbox, newest first: g1 sees the taking above the loss, and the loss above its evicted ventures\' closures', () => {
  const g1 = viewOf(SWEPT.s, 'g1');
  const { page } = noticePage(g1, 'g1');
  const events = meOf(g1, 'g1').events;
  assert.deepEqual(events.map((e) => e.type), ['assets_swept', 'system_lost', 'venture_closed', 'venture_closed']);
  // The closures still take the shared Syndicate branch, unchanged by this slice.
  for (const e of events.slice(2)) assert.match(page.noticeRowTitle(e), /^Venture closed &mdash; <span class="who">.+ (Mine|Refinery)<\/span>$/);
  // Every one is born unread, so every one lights the badge — g2's one row lights g2's.
  assert.deepEqual(page.myUnreadNotices(g1).map((n) => n.type).sort(), ['assets_swept', 'system_lost', 'venture_closed', 'venture_closed']);
  const g2 = viewOf(SWEPT.s, 'g2');
  assert.deepEqual(noticePage(g2, 'g2').page.myUnreadNotices(g2).map((n) => n.type), ['assets_inherited']);
});

// ---- 2. system_lost ----------------------------------------------------------------------------------------

test('popup, system_lost (abandoned): the Syndicate adviser, the abandon words, the facts off the payload, and Show on map', () => {
  const snap = viewOf(SWEPT.s, 'g1');
  const n = rowOf(snap, 'g1', 'system_lost');
  const p = n.payload;
  assert.equal(p.cause, 'abandoned', 'premise: the owner abandoned it');
  const goods = Object.entries(p.goodsForfeit);
  assert.equal(goods.length, 1, 'premise: one good in the forfeited pool (the licensed mine\'s output)');
  const { page, view } = noticePage(snap, 'g1');
  page.openNotice(n.id);
  assert.deepEqual(view(), {
    open: true,
    eyebrow: 'Syndicate Notice',
    art: "url('assets/characters/advisor.jpg')",
    title: `System lost — ${TARGET_NAME}`,
    paragraphs: [SYSTEM_LOST_ABANDONED, SYSTEM_LOST_AFTERMATH],
    facts: [
      // The site named exactly as the engine names it ("HAL-3910 I · Slot 1", sim/seed.js siteName).
      ['Prefecture', getSite(p.slotId).name],
      ['Ventures closed', '2'],
      // g1's miner, refinery factory, idle factory and idle Outpost kit, read off the stranded ids.
      ['Machines stranded', '1 Miner, 2 Factories, 1 Outpost kit'],
      ['Goods forfeit', `${goods[0][1].toLocaleString('en-US')} ${titleCase(goods[0][0])}`],
      ['Lost', `Day ${n.whenDay}`],
    ],
    buttons: ['noticeShowMap'],
    note: '',
  });
});

test('popup, system_lost: another cause blames no one; an empty system reads "None"; nothing reads "null"', () => {
  // A cause other than 'abandoned' (the storyteller's, when it is built) gets the neutral first line.
  const snap = viewOf(SWEPT.s, 'g1');
  const n = rowOf(snap, 'g1', 'system_lost');
  n.payload.cause = 'storyteller';
  let p = noticePage(snap, 'g1');
  p.page.openNotice(n.id);
  assert.deepEqual(p.view().paragraphs, [SYSTEM_LOST_DESTROYED, SYSTEM_LOST_AFTERMATH]);

  // The darkened galaxy: g1 had nothing of its own in TARGET — no venture, no machine, no goods.
  const empty = viewOf(DARKENED.s, 'g1');
  const e = rowOf(empty, 'g1', 'system_lost');
  assert.deepEqual([e.payload.ventureIds, e.payload.strandedAssetIds, e.payload.goodsForfeit], [[], [], {}], 'premise: nothing there');
  p = noticePage(empty, 'g1');
  p.page.openNotice(e.id);
  assert.deepEqual(p.view().facts.slice(1, 4), [['Ventures closed', 'None'], ['Machines stranded', 'None'], ['Goods forfeit', 'None']]);

  // A payload with its names missing degrades to the ids, then to plain words — never "null", "undefined" or a bare dash.
  e.payload = { cause: 'abandoned', systemId: TARGET };
  p.page.openNotice(e.id);
  let v = p.view();
  assert.equal(v.title, `System lost — ${TARGET}`);
  assert.deepEqual(v.facts.slice(0, 4), [['Prefecture', '—'], ['Ventures closed', 'None'], ['Machines stranded', 'None'], ['Goods forfeit', 'None']]);
  e.payload = {};
  p.page.openNotice(e.id);
  v = p.view();
  assert.equal(v.title, 'System lost — Unknown system');
  assert.doesNotMatch(JSON.stringify(v), /null|undefined|NaN/);
});

// ---- 3. the sweep ------------------------------------------------------------------------------------------

test('popup, assets_inherited: g2 is told what its claim brought, and that the ground may be spoiled; Show on map goes to the system', () => {
  const snap = viewOf(SWEPT.s, 'g2');
  const n = rowOf(snap, 'g2', 'assets_inherited');
  // The ids are g2's own now and live in its view, so the kinds read off them can be checked against the rows.
  const live = meOf(snap, 'g2').assets;
  for (const id of n.payload.inheritedAssetIds) assert.ok(live.some((a) => a.id === id && a.systemId === TARGET), `${id} is g2's, in TARGET`);
  const { page, view, flown } = noticePage(snap, 'g2');
  for (const id of n.payload.inheritedAssetIds) assert.equal(page.assetKindOfId(id), live.find((a) => a.id === id).kind, `the kind read off ${id}`);
  page.openNotice(n.id);
  const v = view();
  assert.deepEqual(v, {
    open: true,
    eyebrow: 'Syndicate Notice',
    art: "url('assets/characters/advisor.jpg')",
    title: `Machines inherited — ${TARGET_NAME}`,
    paragraphs: INHERITED_LINES,
    facts: [
      ['System', TARGET_NAME],
      ['Machines gained', '1 Miner, 2 Factories, 1 Outpost kit'],
      ['Claimed', `Day ${n.whenDay}`],
    ],
    buttons: ['noticeShowMap'],
    note: '',
  });
  assert.equal(JSON.stringify(v).includes('g1'), false, 'the card names no former owner (§15: the planter learns only what it now owns)');
  page.noticeShowMap();
  assert.equal(view().open, false, 'the popup closes');
  assert.deepEqual(flown, [[TARGET_HEX.q, TARGET_HEX.r, 9]], 'to the claimed system\'s centre hex, at the Dispatch popup\'s zoom');
});

test('popup, assets_swept: g1 is told who claimed its fallow system and what it lost there; Show on map goes to the system', () => {
  const snap = viewOf(SWEPT.s, 'g1');
  const n = rowOf(snap, 'g1', 'assets_swept');
  assert.equal(n.payload.byGuildName, RIVAL_NAME, 'premise: the engine named the new holder');
  // The swept ids no longer exist in g1's view, so the card reads the kinds off the ids, never off a live row.
  assert.deepEqual(n.payload.sweptAssetIds, [SWEPT.factory, SWEPT.idleFactory, SWEPT.miner, SWEPT.outpostKit].sort());
  for (const id of n.payload.sweptAssetIds) assert.equal((meOf(snap, 'g1').assets || []).some((a) => a.id === id), false, `${id} is gone`);
  const { page, view, flown } = noticePage(snap, 'g1');
  page.openNotice(n.id);
  assert.deepEqual(view(), {
    open: true,
    eyebrow: 'Syndicate Notice',
    art: "url('assets/characters/advisor.jpg')",
    title: `Machines taken — ${TARGET_NAME}`,
    paragraphs: [`${RIVAL_NAME} has claimed the system you lost, and its claim took every machine you still had stranded there.`, SWEPT_AFTERMATH],
    facts: [
      ['System', TARGET_NAME],
      ['Claimed by', RIVAL_NAME],
      ['Machines taken', '1 Miner, 2 Factories, 1 Outpost kit'],
      ['Taken', `Day ${n.whenDay}`],
    ],
    buttons: ['noticeShowMap'],
    note: '',
  });
  page.noticeShowMap();
  assert.deepEqual(flown, [[TARGET_HEX.q, TARGET_HEX.r, 9]], 'to the system, now the rival\'s');
  // Without a name the rival reads as its id, then as "A rival guild" — the sentence still starts with a capital.
  n.payload.byGuildName = undefined;
  page.openNotice(n.id);
  assert.match(view().paragraphs[0], /^g2 has claimed/);
  assert.deepEqual(view().facts[1], ['Claimed by', 'g2']);
  n.payload.byGuildId = undefined;
  page.openNotice(n.id);
  assert.match(view().paragraphs[0], /^A rival guild has claimed/);
  assert.deepEqual(view().facts[1], ['Claimed by', '—']);
});

test('the kinds label: counted per kind, machines first then the rest by kind, plural where it should be; an odd id reads "Machine"', () => {
  const { page } = noticePage(viewOf(SWEPT.s, 'g1'), 'g1');
  assert.equal(page.assetKindsLabel(['asset_g1_miner_01']), '1 Miner');
  assert.equal(page.assetKindsLabel(['asset_g1_deepScan_04', 'asset_g1_factory_02', 'asset_g1_prefecture_05', 'asset_g1_miner_07', 'asset_g1_miner_09']),
    '2 Miners, 1 Factory, 1 Deep Scan Array kit, 1 Prefecture kit');
  assert.equal(page.assetKindsLabel(['asset_third-guild_x_outpost_01', 'asset_third-guild_x_outpost_02']), '2 Outpost kits', 'an underscore in the guild id does not move the kind');
  assert.equal(page.assetKindsLabel(['not-an-asset']), '1 Machine');
  assert.equal(page.assetKindsLabel([]), 'None');
  assert.equal(page.assetKindsLabel(undefined), 'None');
});

test('Show on map, a system the board does not hold: the popup closes and the map stays put', () => {
  const snap = viewOf(SWEPT.s, 'g1');
  const n = rowOf(snap, 'g1', 'system_lost');
  n.payload.systemId = 'sys_not_on_this_board';
  const { page, view, flown } = noticePage(snap, 'g1');
  page.openNotice(n.id);
  page.noticeShowMap();
  assert.equal(view().open, false);
  assert.deepEqual(flown, []);
});

// ---- 4. the scan_voided split ------------------------------------------------------------------------------

test('scan_voided: an anchor-lost void reads as a dark array, a rival void keeps the rival\'s words — two distinct cards', () => {
  // The dark array: g1's, running an L1 when TARGET went fallow.
  const darkSnap = viewOf(DARKENED.s, 'g1');
  const dark = rowOf(darkSnap, 'g1', 'scan_voided');
  assert.equal(dark.payload.reason, 'anchor-lost', 'premise: the eviction voided it as a dark array');
  assert.equal(dark.payload.arrayId, DARKENED.arrays.dark);
  assert.equal('byGuildName' in dark.payload, false, 'premise: no rival is involved');
  const darkArray = `Deep Scan Array ${dark.payload.arrayId.split('_').slice(-1)[0]}`;
  const d = noticePage(darkSnap, 'g1');
  assert.equal(d.page.noticeRowTitle(dark), `Survey voided &mdash; <span class="who">${dark.payload.targetName}</span>`);
  d.page.openNotice(dark.id);
  const darkView = d.view();
  assert.deepEqual(darkView, {
    open: true,
    eyebrow: 'Guild Scout',
    art: "url('assets/characters/spy.jpg')",
    title: 'Survey voided',
    paragraphs: [`${darkArray} — survey of ${dark.payload.targetName} voided; the array went dark.`, DARK_LINE],
    facts: [
      ['Array', darkArray],
      ['Target', dark.payload.targetName],
      ['Survey', 'System survey'],
      ['Reason', 'Array went dark'],
      ['Voided', `Day ${dark.whenDay}`],
    ],
    buttons: [],
    note: '',
  });

  // The rival void: the scan-notice script's, where a third guild founded on the target mid-scan.
  const rivalSnap = viewOf(SCANS.steps.voided, SCANS.A);
  const rival = rowOf(rivalSnap, SCANS.A, 'scan_voided');
  assert.equal('reason' in rival.payload, false, 'premise: a rival void carries no reason');
  const rivalArray = `Deep Scan Array ${rival.payload.arrayId.split('_').slice(-1)[0]}`;
  const r = noticePage(rivalSnap, SCANS.A);
  r.page.openNotice(rival.id);
  const rivalView = r.view();
  assert.deepEqual(rivalView.paragraphs, [`${rivalArray} — survey of ${rival.payload.targetName} voided; Third claimed it before it finished.`]);
  assert.deepEqual(rivalView.facts[3], ['Claimed by', 'Third']);

  // Distinct, both ways: the dark card names no claimant, the rival's says nothing of the dark.
  assert.doesNotMatch(darkView.paragraphs.join(' '), /claimed/);
  assert.equal(darkView.facts.some((f) => f[0] === 'Claimed by'), false);
  assert.doesNotMatch(rivalView.paragraphs.join(' '), /dark/);
  assert.equal(rivalView.facts.some((f) => f[0] === 'Reason'), false);
  assert.equal(r.page.isDarkVoid(rival), false);
  assert.equal(d.page.isDarkVoid(dark), true);
});

// ---- 5. the eight existing notice types, unchanged -------------------------------------------------------

// The eight types MESSAGES already rendered, each in its published shape (event-log.md §2, §10–§13), and what main's
// own notice block showed for each at e56799c — before this slice — pinned. A regression in the shared code (a branch
// stealing a type, a body or a button changed) moves one of these.
const EXISTING = [
  { id: 101, type: 'venture_closed', tick: 0, whenDay: 3, unlockDay: 7, readTick: 0, payload: {
    cause: 'teardown', good: 'titanium', ventureType: 'mining', ventureName: 'Nyx IV · Node 1', lockoutUntilTick: 9000 } },
  { id: 102, type: 'licence_lapsed', tick: 0, whenDay: 4, readTick: 0, payload: {
    cause: 'timeout', good: 'copper', ventureType: 'mining', ventureName: 'Nyx IV · Node 2' } },
  { id: 103, type: 'deploy_failed', tick: 0, whenDay: 5, readTick: 0, payload: {
    cause: 'occupied', kind: 'outpost', targetHex: { q: 1, r: 2 }, craftId: 'vehicle_g1_heavyTransport_01',
    craftClass: 'heavyTransport', retreatSystemId: 'sys_0001', retreatSystemName: 'Nyx' } },
  { id: 104, type: 'delivery_space_warning', tick: 0, whenDay: 6, readTick: 0, payload: {
    guildId: 'g1', outpostId: 'outpost_g1_02', cargo: { iron: 30, titanium: 10 }, units: 40, space: 40, freeSpace: 25,
    shortfall: 15, arrivalTick: 999 } },
  { id: 105, type: 'delivery_turned_back', tick: 0, whenDay: 7, readTick: 0, payload: {
    guildId: 'g1', outpostId: 'outpost_g1_09', cause: 'outpost-gone', cargo: { iron: 30 }, units: 30, space: 30 } },
  { id: 106, type: 'outpost_packed', tick: 0, whenDay: 8, readTick: 0, payload: {
    outpostId: 'outpost_g1_01', anchorSystemId: 'sys_0001', anchorSystemName: 'Nyx', hex: { q: 3, r: 4 },
    craftId: 'vehicle_g1_heavyTransport_02', craftClass: 'heavyTransport' } },
  { id: 107, type: 'scan_complete', tick: 0, whenDay: 9, readTick: 0, payload: {
    arrayId: 'deepScanArray_g1_03', level: 'L1', targetSystemId: 'sys_0002', targetName: 'Vel', newFacts: 4 } },
  { id: 108, type: 'scan_voided', tick: 0, whenDay: 10, readTick: 0, payload: {
    arrayId: 'deepScanArray_g1_03', level: 'L2', targetPlanetId: 'pl_00009', targetName: 'Vel II',
    byGuildId: 'g9', byGuildName: 'Rival Co' } },
];
const SYNDICATE = ['Syndicate Notice', "url('assets/characters/advisor.jpg')"];
const PILOT = ['Fleet — Dispatch', "url('assets/characters/pilot.jpg')"];
const TRADER = ['Trade — Syndicate', "url('assets/mission/Trader.jpg')"];
const SCOUT = ['Guild Scout', "url('assets/characters/spy.jpg')"];
const AS_ON_MAIN = {
  venture_closed: {
    row: 'Venture closed &mdash; <span class="who">Titanium Mine</span>', title: 'Venture closed — Titanium Mine', dress: SYNDICATE,
    paragraphs: ["You closed this venture. Its node stays held under the Syndicate's lockout — no one may re-establish there until the term clears."],
    facts: [['Location', 'Nyx IV · Node 1'], ['Closed', 'Day 3'], ['Node held until', 'Day 7']], buttons: [] },
  licence_lapsed: {
    row: 'Licence lapsed &mdash; <span class="who">Copper Mine</span>', title: 'Licence lapsed — Copper Mine', dress: SYNDICATE,
    paragraphs: ["The Syndicate's renegotiation window closed without an answer, so the licence lapsed. The venture reverts to unlicensed — it keeps running, but has forfeited its standing (RP). You can sign a fresh licence later."],
    facts: [['Location', 'Nyx IV · Node 2'], ['Lapsed', 'Day 4']], buttons: [] },
  deploy_failed: {
    row: 'Deployment Failed &mdash; <span class="who">Outpost</span>', title: 'Deployment Failed — Outpost', dress: PILOT,
    paragraphs: [
      'Right, so, we flew the asset out here where you wanted and... well... long story short, it’s going to need to go somewhere else. I pulled back to a safe spot for now.',
      'I hate to pester you like this, Guildmaster, but we can’t float around out here forever. We need a decision from you.',
    ],
    facts: [['Craft', 'Heavy Transport · #01'], ['Target', 'hex 1, 2'], ['Reason', 'Hex taken'], ['Pulled back to', 'Nyx'], ['Failed', 'Day 5']],
    buttons: ['noticeRedeploy', 'noticeReturn'] },
  delivery_space_warning: {
    row: 'No room at the outpost &mdash; <span class="who">Nyx Outpost</span>', title: 'No room at the outpost', dress: TRADER,
    paragraphs: [
      "Guildmaster, I just saw the manifest for your latest order from the Syndicate and I just need to let you know that we don't currently have enough space at the outpost.",
      "You'll have to tell me what you want to do with the units we have on hand, otherwise - if the Syndicate can't unload - they'll just turn back with everything with no refund.",
      'What would you like me to do?',
    ],
    facts: [['Outpost', 'Nyx Outpost'], ['Consignment', '40 u / 2 goods'], ['Room short', '15 space'], ['Free space', '25 space'], ['Ordered', 'Day 6']],
    buttons: [] },
  delivery_turned_back: {
    row: 'Delivery turned back &mdash; <span class="who">a dismantled outpost</span>', title: 'Delivery turned back', dress: TRADER,
    paragraphs: ["Guildmaster — the Syndicate carried your order out to the outpost, but it wasn't there to receive it. They've turned back with the lot. No refund."],
    facts: [['Outpost', 'a dismantled outpost'], ['Consignment', '30 u / 1 good'], ['Reason', 'Outpost gone'], ['Turned back', 'Day 7']], buttons: [] },
  outpost_packed: {
    row: 'Outpost packed up &mdash; <span class="who">Nyx Outpost</span>', title: 'Outpost packed up', dress: PILOT,
    paragraphs: ['The outpost has been packed up, ready to be deployed, Guildmaster. Where do you want me to take it?'],
    facts: [['Craft', 'Heavy Transport · #02'], ['Packed at', 'Nyx · hex 3, 4'], ['When', 'Day 8']], buttons: ['noticeShowMap'] },
  scan_complete: {
    row: 'Survey complete &mdash; <span class="who">Vel</span>', title: 'Survey complete', dress: SCOUT,
    paragraphs: ['Deep Scan Array 03 — survey of Vel complete.', '4 readings logged.'],
    facts: [['Array', 'Deep Scan Array 03'], ['Target', 'Vel'], ['Survey', 'System survey'], ['New readings', '4'], ['Completed', 'Day 9']], buttons: [] },
  scan_voided: {
    row: 'Survey voided &mdash; <span class="who">Vel II</span>', title: 'Survey voided', dress: SCOUT,
    paragraphs: ['Deep Scan Array 03 — survey of Vel II voided; Rival Co claimed it before it finished.'],
    facts: [['Array', 'Deep Scan Array 03'], ['Target', 'Vel II'], ['Survey', 'Planet survey'], ['Claimed by', 'Rival Co'], ['Voided', 'Day 10']], buttons: [] },
};

// It touches nothing this slice added, so it passes on main's game.html as well as on this one.
test('the eight existing notice types render exactly as main rendered them — row, title, speaker, words, facts, buttons', () => {
  const snap = { guilds: [{ id: 'g1', events: plain(EXISTING) }], attention: { notices: [] } };
  const { page, view } = noticePage(snap, 'g1');
  assert.deepEqual(Object.keys(AS_ON_MAIN).sort(), EXISTING.map((e) => e.type).sort(), 'one pin per existing type');
  for (const n of EXISTING) {
    page.openNotice(n.id);
    const v = view();
    const want = AS_ON_MAIN[n.type];
    assert.deepEqual({ row: page.noticeRowTitle(n), title: v.title, dress: [v.eyebrow, v.art], paragraphs: v.paragraphs, facts: v.facts, buttons: v.buttons },
      want, `${n.type} renders as it did on main`);
  }
});

test('the shared card is re-dressed on every open: territory → pilot → territory → scout → Syndicate, nothing carried over', () => {
  const snap = viewOf(SWEPT.s, 'g1');
  const lost = rowOf(snap, 'g1', 'system_lost');
  meOf(snap, 'g1').events.push(...plain(EXISTING.filter((e) => ['deploy_failed', 'scan_complete', 'licence_lapsed'].includes(e.type))));
  const { page, view } = noticePage(snap, 'g1');
  for (const n of EXISTING) assert.equal(page.isTerritoryNotice(n), false, `${n.type} is not a territory notice`);
  const dress = () => { const v = view(); return [v.eyebrow, v.art, v.buttons]; };
  page.openNotice(lost.id);
  assert.deepEqual(dress(), [...SYNDICATE, ['noticeShowMap']]);
  page.openNotice(103);
  assert.deepEqual(dress(), [...PILOT, ['noticeRedeploy', 'noticeReturn']], 'the forks, and Show on map hidden again');
  page.openNotice(lost.id);
  assert.deepEqual(dress(), [...SYNDICATE, ['noticeShowMap']], 'the forks hidden again, the adviser back');
  page.openNotice(107);
  assert.deepEqual(dress(), [...SCOUT, []]);
  page.openNotice(102);
  assert.deepEqual(dress(), [...SYNDICATE, []], 'a Syndicate notice that is not a territory one: Dismiss alone');
});

// ---- 6. read-on-open, and the wiring --------------------------------------------------------------------

test('read-on-open is unchanged: an unread territory notice sends one acknowledgeEvent by numeric id; a reopen of a read one sends none', () => {
  const snap = viewOf(SWEPT.s, 'g1');
  const n = rowOf(snap, 'g1', 'system_lost');
  assert.equal(n.readTick, undefined, 'premise: born unread');
  const { page, sent } = noticePage(snap, 'g1');
  page.openNotice(n.id);
  assert.deepEqual(plain(sent), [{ type: 'acknowledgeEvent', guildId: 'g1', eventId: n.id }]);
  assert.equal(typeof sent[0].eventId, 'number');
  n.readTick = n.tick;   // as the next poll would show it
  page.openNotice(n.id);
  assert.equal(sent.length, 1);
});

test('wiring: Show on map is gated on the packed and territory notices, and the two shell bridges the sandbox stands in for are real', () => {
  assert.match(noticeSrc, /el\('noticeShowMap'\)\.hidden = !\(packed \|\| territory\);/);
  assert.match(noticeSrc, /var hex = isTerritoryNotice\(n\) \? territorySystemHex\(p\) : packedCraftHex\(p\);/);
  // __boardSystem hands back the board's own system row, whose centre hex the map is drawn from.
  assert.match(html, /window\.__boardSystem = function\(id\)\{ return systemById\(id\); \};/);
  assert.match(html, /function systemById\(id\)\{\n\s+if \(!id \|\| !GAME\.galaxy\) return null;\n\s+return GAME\.galaxy\.systems\.filter/);
  // __planetDesignation names a planet "Nyx IV" off the board, the name the sandbox gives it from the engine.
  assert.match(html, /window\.__planetDesignation = function\(planetId\)\{[\s\S]*?return p \? row\.name \+ ' ' \+ toRoman\(p\.order\) : planetId;/);
});
