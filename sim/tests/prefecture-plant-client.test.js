'use strict';

// prefecture-plant-client.test.js — the CLIENT half of the Prefecture's PLANT (roadmap 2.5, the Prefecture / claims
// slice, client PR B2; docs/territory-model.md §4 "The plant action (the claim act)").
//
// The engine half is engine PR 1 (prefecture-plant.test.js): `plantPrefecture { guildId, assetId, slotId }` plants an
// idle Prefecture kit on a settlement slot of the system it sits in, if the guild has surveyed that planet, the slot is
// free and NOBODY holds the system — and writes the claim. This PR lets a player do that from the planet manifest. The
// tripwires:
//   1. THE GATE: a vacant settlement slot offers Plant exactly when the engine would accept the plant — checked against
//      the engine itself, slot by slot, over real galaxies (unclaimed; a rival planted first; we planted already; the
//      kit still at home; our own home system).
//   2. THE ROW: a plantable slot reads Plant Prefecture and its click opens the plant's confirm, never the factory
//      Establish popup; every other slot keeps its old click — Establish (held, or unheld with no kit), VM, the overlay.
//   3. THE CONFIRM AND THE SEND: the confirm names the kit, the slot and the whole-system claim; Confirm sends exactly
//      the engine's action; a refusal (the rival-claims-first race) and an unreachable server are shown, never hidden;
//      one plant is sent however often the player clicks.
//   4. THE REPAINT: after the plant the re-read view shows the slot as the player's PREFECTURE and offers no more
//      plants; a rival's Prefecture reads as taken, by that guild's name.
//
// The client has no DOM test harness, so — as prefecture-ferry-client.test.js does — this cuts the page's OWN code out
// of game.html and runs it in a node:vm sandbox on stubs. The live page is driven headless (the PR's proof).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { validateAction, applyAction, createGrantKitAction } = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const { getSystem, getSystemLayout } = require('../seed.js');
const P = require('./prefecture-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// One top-level function of a column-0 script (or IIFE body), by name: a one-liner whole, or a longer one through
// its closing brace at column 0. (The first in the page — the planet manifest's script comes before the shell's.)
const fn = (name, prefix = '') => {
  const head = `\\n${prefix}function ${name}\\([^)]*\\) ?\\{`;
  const oneLine = html.match(new RegExp(`${head}[^\\n]*\\}\\n`));
  return oneLine ? oneLine[0] : cut(html, new RegExp(`${head}\\n[\\s\\S]*?\\n\\}\\n`), name);
};

const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
// The shell's reads: a Prefecture's site row, the idle ground kits and the two claim lookups. (The one applySnapshot line
// that files every planted Prefecture under its slot is cut out below, and run on each view as the page runs it.)
const shellSrc = fn('prefectureSite') + fn('myIdleGroundKits')
  + cut(html, /\nwindow\.__myIdleGroundKitsIn = function\(systemId\)\{[\s\S]*?\n\};\n/, '__myIdleGroundKitsIn')
  + cut(html, /\nwindow\.__isClaimed = [^\n]*\n/, '__isClaimed')
  + cut(html, /\nwindow\.__isMine = [^\n]*\n/, '__isMine');
// The planet manifest's pieces: the site state and badge, the slot row, the plant, and the Establish hand-off.
const viewSrc = ['esc', 'siteState', 'myGuildName', 'siteBadge', 'siteBadgeHtml', 'isOwnSite', 'planetDesignation',
  'settlementRow', 'plantKitFor', 'openPlantFor', 'openEstablishFor', 'openNodeOverlay'].map((name) => fn(name)).join('')
  + cut(html, /\nlet plantInFlight = false;\n/, 'plantInFlight') + fn('sendPlant', 'async ');

// page(state, opts) -> the planet manifest for player `guildId`, on the system `systemId`, reading the engine's own
// fogged VIEW of `state` exactly as applySnapshot files it. `log` records every popup and action, in order;
// `send` answers a sent action (default: the real engine, validate then apply). `p.state` is the galaxy as it stands.
function page(state, { guildId = 'g1', systemId = P.TARGET, send } = {}) {
  const log = [];
  const nodes = {};
  const element = () => {
    const node = { className: '', innerHTML: '', textContent: '', on: {}, style: {},
      addEventListener(type, f) { node.on[type] = f; } };
    const classes = new Set();
    node.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
    return node;
  };
  const p = { state, log };
  const sandbox = {
    GAME: { guildId },
    LIVE: null,
    SYSTEM: { id: systemId, name: getSystem(systemId).name },
    ARCHETYPE_LABEL: new Proxy({}, { get: (_, k) => String(k) }),
    el: { overlay: element(), overlayTitle: element(), overlayCopy: element() },
    document: { createElement: element, getElementById: (id) => nodes[id] || (nodes[id] = element()) },
    window: {
      __player: () => ({ guildId, guildName: `Guild ${guildId}` }),
      __adviserConfirm: (opts) => log.push(['confirm', opts]),
      __sendAction: async (action) => {
        log.push(['send', JSON.parse(JSON.stringify(action))]);
        if (send) return send(action);
        const verdict = validateAction(p.state, action);
        if (!verdict.valid) return { accepted: false, reason: verdict.reason };
        p.state = applyAction(p.state, action);
        return { accepted: true };
      },
      __refreshNow: async () => { log.push(['refresh']); read(); },
      openEstablish: (site) => log.push(['establish', { siteId: site.siteId, mine: site.mine }]),
      __openVentureManagement: (id) => log.push(['vm', id]),
    },
  };
  sandbox.window.__siteInfo = (id) => sandbox.LIVE.siteInfo[id] || null;
  sandbox.window.__occupancy = (id) => sandbox.LIVE.occupancy[id] || null;
  vm.runInNewContext(kitKindsSrc + shellSrc + viewSrc + 'var __filePrefectures = function(snap){' +
    cut(html, /\n  \(snap\.prefectures \|\| \[\]\)\.forEach\([^\n]*\n/, 'the prefectures line') + '};', sandbox);
  // read() — the view as applySnapshot files it: own assets, every system claim, occupancy, guild names, and every
  // planted Prefecture under its slot. (A venture's siteInfo is not needed here: no slot this test reads holds one.)
  function read() {
    const view = buildSnapshot(p.state, guildId);
    const claims = {};
    view.claims.forEach((c) => { if (c.landmarkKind === 'system') claims[c.landmarkId] = c.ownerGuildId; });
    sandbox.LIVE = {
      myAssets: view.guilds.find((g) => g.id === guildId).assets || [],
      systemClaims: claims, occupancy: view.occupancy || {}, siteInfo: {},
      guildNameById: Object.fromEntries(view.guilds.map((g) => [g.id, g.name || g.id])),
    };
    sandbox.__filePrefectures(view);
    p.view = view;
  }
  read();
  // The planet as the manifest adapts it: its slots are exactly the ones the guild's view lists (geography.known).
  p.planet = (planetId) => {
    const order = getSystemLayout(systemId).planets.findIndex((x) => x.id === planetId) + 1;
    const k = ((p.view.geography.known || {})[systemId] || {})[planetId];
    return { id: planetId, roman: String(order), archetype: k ? k.archetype : null,
      slots: k ? Object.keys(k.slots).map((id) => ({ id })) : [] };
  };
  p.row = (planetId, slotId) => {
    const planet = p.planet(planetId);
    const i = planet.slots.findIndex((s) => s.id === slotId);
    assert.ok(i >= 0, `${slotId} is listed on ${planetId} in the view`);
    return sandbox.settlementRow(planet.slots[i], i, planet);
  };
  p.click = (planetId, slotId) => p.row(planetId, slotId).on.click();
  p.offeredKit = (slotId) => sandbox.plantKitFor(sandbox.siteState(slotId));
  p.confirm = async () => { const last = log.filter((e) => e[0] === 'confirm').slice(-1)[0]; await last[1].onConfirm(); };
  p.sandbox = sandbox;
  return p;
}

const kitsOf = (s, guildId) => (s.guilds.find((g) => g.id === guildId).assets || [])
  .filter((a) => a.kind === 'prefecture' && a.deployedToVentureId == null);
const allSlots = (systemId) => getSystemLayout(systemId).planets.flatMap((pl) => pl.settlementSlots.map((sl) => ({ planetId: pl.id, slotId: sl.id })));

// --- the galaxies --------------------------------------------------------------------------------------------------

// ready() -> g1's Prefecture kit ferried into the unclaimed TARGET, and PLANET_A (not PLANET_B) surveyed: the plant's
// own starting point.
function ready() {
  const { s, kitId } = P.ferried();
  return { s: P.survey(s, 'g1', P.PLANET_A), kitId };
}
// rivalFirst() -> ready(), then g2 plants its own Prefecture on SLOT_A1 first: TARGET is a rival's.
function rivalFirst() {
  let { s } = ready();
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', P.TARGET));
  s = P.survey(s, 'g2', P.PLANET_A);
  return P.accept(s, P.plant('g2', kitId, P.SLOT_A1));
}
// ownFirst() -> ready(), g1 plants on SLOT_A1, and a second kit of g1's is granted into TARGET: TARGET is ours.
function ownFirst() {
  const r = ready();
  let s = P.accept(r.s, P.plant('g1', r.kitId, P.SLOT_A1));
  ({ s } = P.grantPrefectureKit(s, 'g1', P.TARGET));
  return s;
}
// atHome() -> g1's kit granted at HOME, never ferried; TARGET surveyed and unclaimed all the same.
function atHome() {
  let { s } = P.grantPrefectureKit(P.kitGalaxy(), 'g1', P.HOME.id);
  return P.survey(s, 'g1', P.PLANET_A);
}
// spaceKitThere() -> atHome(), plus an Outpost kit (a SPACE kit, not a Prefecture) granted idle into TARGET: a kit
// sits there, but not one a plant can use.
function spaceKitThere() {
  return P.accept(atHome(), createGrantKitAction({ guildId: 'g1', systemId: P.TARGET, kind: 'outpost' }));
}

// --- 1. the gate ---------------------------------------------------------------------------------------------------

// The ORACLE: for every settlement slot of the system, the page offers Plant (on a slot it lists) exactly when the
// engine would plant one of the guild's idle Prefecture kits there — and the kit it offers is one the engine takes.
// A slot the view does not list (an unsurveyed planet) is never offered, and the engine must refuse it.
function agreeWithEngine(s, systemId, what) {
  const p = page(s, { systemId });
  let offers = 0;
  for (const { planetId, slotId } of allSlots(systemId)) {
    const listed = p.planet(planetId).slots.some((x) => x.id === slotId);
    const kit = listed ? p.offeredKit(slotId) : null;
    const engine = kitsOf(s, 'g1').map((k) => validateAction(s, P.plant('g1', k.id, slotId)));
    const engineTakes = engine.some((v) => v.valid);
    assert.equal(!!kit, engineTakes,
      `${what}, ${slotId}: the page ${kit ? 'offers' : 'does not offer'} Plant; the engine ${engineTakes ? 'accepts' : `refuses (${engine.map((v) => v.reason).join(' / ') || 'no kit'})`}`);
    if (kit) {
      assert.equal(validateAction(s, P.plant('g1', kit.id, slotId)).valid, true, `${what}, ${slotId}: the offered kit is one the engine plants`);
      assert.match(p.row(planetId, slotId).innerHTML, /<span class="plant-btn">Plant Prefecture<\/span>/);
      offers += 1;
    }
    if (listed && !kit) assert.doesNotMatch(p.row(planetId, slotId).innerHTML, /plant-btn/, `${what}, ${slotId}: no Plant`);
  }
  return offers;
}

test('the gate agrees with the engine on every slot: offered only in an unclaimed system, with a kit there, on a surveyed, vacant slot', () => {
  const plantable = agreeWithEngine(ready().s, P.TARGET, 'unclaimed, the kit ferried in');
  assert.equal(plantable, getSystemLayout(P.TARGET).planets.find((x) => x.id === P.PLANET_A).settlementSlots.length,
    'every slot of the surveyed planet, and no slot of the unsurveyed one');
  assert.equal(agreeWithEngine(rivalFirst(), P.TARGET, 'a rival planted first'), 0);
  assert.equal(agreeWithEngine(ownFirst(), P.TARGET, 'we hold it already, a second kit there'), 0);
  assert.equal(agreeWithEngine(atHome(), P.TARGET, 'the kit still at home'), 0);
  assert.equal(agreeWithEngine(spaceKitThere(), P.TARGET, 'an Outpost kit there, the Prefecture kit at home'), 0);
  assert.equal(agreeWithEngine(atHome(), P.HOME.id, 'our own home system, the kit there'), 0);
});

test('the gate: an unsurveyed planet lists no slot at all — the survey gate is the tab\'s own L2 rule', () => {
  const { s } = ready();
  const p = page(s);
  assert.deepEqual(p.planet(P.PLANET_B).slots, [], 'PLANET_B is not in the record, so the view lists none of its slots');
  assert.match(validateAction(s, P.plant('g1', kitsOf(s, 'g1')[0].id, P.SLOT_B1)).reason, /has not surveyed planet/);
});

test('the gate: an occupied slot is never offered, whoever holds it', () => {
  const { s } = ready();
  const p = page(s);
  assert.ok(p.offeredKit(P.SLOT_A1), 'vacant: offered');
  assert.equal(p.sandbox.plantKitFor({ kind: 'other', ownerName: 'g2' }), null);
  assert.equal(p.sandbox.plantKitFor({ kind: 'prefecture', prefectureId: 'prefecture_g1_01' }), null);
  assert.equal(p.sandbox.plantKitFor({ kind: 'mine', ventureId: 'v1' }), null);
});

// --- 2. the row ----------------------------------------------------------------------------------------------------

test('the row: a plantable slot\'s click opens the plant\'s confirm — never the factory Establish popup', () => {
  const { s, kitId } = ready();
  const p = page(s);
  assert.match(p.row(P.PLANET_A, P.SLOT_A1).innerHTML,
    /Settlement<\/span><\/span><span class="plant-btn">Plant Prefecture<\/span><span class="venture-btn vacant"><span class="sb-act">VACANT<\/span>/,
    'the Plant button sits between the slot\'s name and its VACANT badge');
  p.click(P.PLANET_A, P.SLOT_A1);
  assert.deepEqual(p.log.map((e) => e[0]), ['confirm'], 'the plant confirm, and nothing else');
  const opts = p.log[0][1];
  assert.equal(opts.title, 'Plant the Prefecture?');
  assert.equal(opts.confirmLabel, 'Plant Prefecture ▸');
  assert.equal(opts.singleButton, undefined, 'Cancel / Confirm');
  const body = opts.body;
  assert.ok(body.includes(`Prefecture kit #${kitId.split('_').slice(-1)[0]}`), `the kit by its number: ${body}`);
  assert.ok(body.includes('Settlement Slot 1'), 'the slot');
  assert.ok(body.includes(`${getSystem(P.TARGET).name} `), 'the planet\'s designation names the system');
  assert.ok(body.includes('claims the <em>whole system</em>'), 'what it does');
  assert.ok(body.includes('Guild g1’s ground'), 'for whom');
  assert.ok(body.includes('cannot yet be taken down'), 'that it cannot be undone yet (§19 #67)');
});

test('the row: every other slot keeps its old click — Establish where we hold the system or have no kit, the overlay on a rival\'s', () => {
  // Held by us (a second kit there): no Plant — the factory Establish flow, with the territory gate open.
  let p = page(ownFirst());
  p.click(P.PLANET_A, P.SLOT_A2);
  assert.deepEqual(p.log, [['establish', { siteId: P.SLOT_A2, mine: true }]]);
  // Unheld, no kit there: the Establish popup, gated off — exactly as before this PR.
  p = page(atHome());
  p.click(P.PLANET_A, P.SLOT_A1);
  assert.deepEqual(p.log, [['establish', { siteId: P.SLOT_A1, mine: false }]]);
  // A rival planted first: its slot opens the read-only overlay; the vacant one the gated Establish, no Plant.
  p = page(rivalFirst());
  p.click(P.PLANET_A, P.SLOT_A1);
  assert.equal(p.sandbox.el.overlay.classList.contains('open'), true);
  assert.equal(p.sandbox.el.overlayCopy.textContent,
    `Settlement slot — ${P.SLOT_A1}. g2’s Prefecture stands here: it holds ${getSystem(P.TARGET).name}.`);
  p.click(P.PLANET_A, P.SLOT_A2);
  assert.deepEqual(p.log, [['establish', { siteId: P.SLOT_A2, mine: false }]]);
});

// --- 3. the confirm and the send -----------------------------------------------------------------------------------

test('Confirm sends exactly the engine\'s action, then re-reads; the claim is written, the kit used up, and no popup follows', async () => {
  const { s, kitId } = ready();
  const p = page(s);
  p.click(P.PLANET_A, P.SLOT_A1);
  await p.confirm();
  assert.deepEqual(p.log.slice(1), [
    ['send', { type: 'plantPrefecture', guildId: 'g1', assetId: kitId, slotId: P.SLOT_A1 }],
    ['refresh'],
  ], 'one action, the re-read, and no refusal popup');
  assert.equal(P.held(p.state, 'g1', P.TARGET), true, 'the engine wrote the claim');
  assert.deepEqual(kitsOf(p.state, 'g1'), [], 'the kit is used up');
});

test('the race: a rival claims the system between the offer and Confirm — the engine refuses, and the page says so in its words', async () => {
  const { s } = ready();
  const p = page(s);
  p.click(P.PLANET_A, P.SLOT_A2);              // the offer, read while TARGET was unclaimed
  let kitId;
  ({ s: p.state, kitId } = P.grantPrefectureKit(p.state, 'g2', P.TARGET));
  p.state = P.survey(p.state, 'g2', P.PLANET_A);
  p.state = P.accept(p.state, P.plant('g2', kitId, P.SLOT_A1));   // ...and the rival plants first
  await p.confirm();
  const refusal = p.log[p.log.length - 1];
  assert.equal(refusal[0], 'confirm', 'a second popup: the refusal');
  assert.equal(refusal[1].title, 'The Prefecture was not planted');
  assert.equal(refusal[1].singleButton, true);
  assert.equal(refusal[1].confirmLabel, 'Close');
  assert.equal(refusal[1].body, `<p>Refused: system &quot;${P.TARGET}&quot; is already held by guild &quot;g2&quot; — a Prefecture plants only in an unclaimed system</p>`);
  assert.equal(P.held(p.state, 'g1', P.TARGET), false, 'nothing was pretended');
  assert.equal(kitsOf(p.state, 'g1').length, 1, 'the kit is still ours, idle in TARGET');
  // The re-read view no longer offers Plant anywhere there.
  for (const id of [P.SLOT_A1, P.SLOT_A2]) assert.equal(p.offeredKit(id), null, `${id}: no Plant once the rival holds it`);
});

test('an unreachable server is shown, not swallowed; a refusal with no reason still reads as refused', async () => {
  let p = page(ready().s, { send: () => { throw new Error('HTTP 502'); } });
  p.click(P.PLANET_A, P.SLOT_A1);
  await p.confirm();
  assert.equal(p.log[p.log.length - 1][1].body, '<p>The Syndicate could not be reached: HTTP 502</p>');
  p = page(ready().s, { send: () => ({ accepted: false }) });
  p.click(P.PLANET_A, P.SLOT_A1);
  await p.confirm();
  assert.equal(p.log[p.log.length - 1][1].body, '<p>Refused: the Syndicate declined</p>');
});

test('one plant is sent however often the player confirms while the first is in flight', async () => {
  const answers = [];
  const p = page(ready().s, { send: () => new Promise((resolve) => answers.push(() => resolve({ accepted: true }))) });
  p.click(P.PLANET_A, P.SLOT_A1);
  const first = p.confirm();
  const second = p.confirm();                   // a second Confirm while the first is still waiting on the engine
  answers.forEach((answer) => answer());
  await Promise.all([first, second]);
  assert.equal(p.log.filter((e) => e[0] === 'send').length, 1);
});

// --- 4. the repaint ------------------------------------------------------------------------------------------------

test('after the plant the re-read view shows the slot as our PREFECTURE, offers no more plants, and its click explains it', async () => {
  const { s } = ready();
  const p = page(s);
  p.click(P.PLANET_A, P.SLOT_A1);
  await p.confirm();
  const prefectureId = p.view.prefectures[0].id;
  assert.deepEqual({ ...p.sandbox.siteState(P.SLOT_A1) }, { kind: 'prefecture', prefectureId });
  assert.match(p.row(P.PLANET_A, P.SLOT_A1).innerHTML,
    /<span class="venture-btn own stacked"><span class="sb-act">PREFECTURE<\/span><span class="sb-guild">Guild g1<\/span><\/span>/);
  for (const { slotId } of allSlots(P.TARGET).filter((x) => x.planetId === P.PLANET_A)) {
    assert.doesNotMatch(p.row(P.PLANET_A, slotId).innerHTML, /plant-btn/, `${slotId}: TARGET is ours now`);
  }
  p.log.length = 0;
  p.click(P.PLANET_A, P.SLOT_A1);
  assert.deepEqual(p.log, [], 'not VM (a Prefecture is no venture), not a plant, not Establish');
  assert.equal(p.sandbox.el.overlayCopy.textContent,
    `Settlement slot — ${P.SLOT_A1}. Your Prefecture ${prefectureId} stands here: it holds ${getSystem(P.TARGET).name} for your guild.`);
  // The vacant slot beside it now opens the factory Establish flow, the territory gate open (Gate 3).
  p.click(P.PLANET_A, P.SLOT_A2);
  assert.deepEqual(p.log, [['establish', { siteId: P.SLOT_A2, mine: true }]]);
});

// (The fixture's guilds carry no name, so the view names g2 by its id — applySnapshot's own fallback.)
test('a rival\'s Prefecture reads as taken, by that guild\'s name — the neutral badge, never ours', () => {
  const p = page(rivalFirst());
  assert.equal(p.view.prefectures.length, 1, 'the rival\'s Prefecture is public in our view');
  assert.match(p.row(P.PLANET_A, P.SLOT_A1).innerHTML,
    /<span class="venture-btn rival stacked"><span class="sb-act">IN USE<\/span><span class="sb-guild">g2<\/span><\/span>/);
});
