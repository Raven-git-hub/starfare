'use strict';

// prefecture-beacon-client.test.js — the CLIENT's claim-pending beacon (roadmap 2.5, the Prefecture / claims slice,
// client PR C; docs/territory-model.md §4, "AS-BUILT — client PR C").
//
// A Prefecture kit ferried into an unclaimed system lands idle there, waiting to be planted. The galaxy map now marks
// every such system with an animated ring beacon so the player can find the kit again. The beacon draws from ONE
// selector, the shell's pendingPrefectures, re-read every frame. The tripwires:
//   1. THE SET: a system is in it exactly when one of the guild's OWN idle Prefecture kits sits there and NO guild
//      holds the system — held to the engine's own state (its assets and `systemHolder`) over every system a kit or a
//      claim names, in each galaxy below. One row per system, at that system's centre hex.
//   2. NOT IN IT: a claimed system (the kit planted), a system we hold with a second kit there, a kit stranded in a
//      system a rival took, a kit at home, a kit of another kind, and a kit still aboard a heavy (loaded or in flight).
//   3. OWN-ONLY: a rival's idle kit in an unclaimed system is in the rival's set, never ours.
//   4. NOTHING KEPT BY HAND: re-reading the next snapshot drops the row the moment the kit is planted or a rival
//      claims the system.
//   5. THE RINGS: three hollow rings in the player accent, evenly spaced, each falling from the rim to the centre and
//      wrapping back to the rim — inward, never outward — fading in at the rim and out at the centre.
//
// The client has no DOM test harness, so — as prefecture-plant-client.test.js does — this cuts the page's OWN code
// out of game.html and runs it in a node:vm sandbox over real engine views. The drawn map is proved headless.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createGrantKitAction, createLoadKitAction } = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const { systemHolder } = require('../claims.js');
const { PREFECTURE_KIT_KIND } = require('../prefectures.js');
const { getBoard, getStarterSystems, getSystem } = require('../seed.js');
const P = require('./prefecture-fixtures.js');
const seed = require('../../data/seed.json');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(re, what) {
  const m = html.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// One column-0 function of the shell, by name, through its closing brace at column 0.
const fn = (name) => cut(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\{\\n[\\s\\S]*?\\n\\}\\n`), name);

const kitKindsSrc = cut(/<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
// The shell: the idle ground kits, the selector, and its window door.
const shellSrc = fn('myIdleGroundKits') + fn('pendingPrefectures')
  + cut(/\nwindow\.__pendingPrefectures = function\(\)\{\n[\s\S]*?\n\};\n/, 'window.__pendingPrefectures');
// applySnapshot's own reads of what the selector reads: the guild's assets, and who holds each system.
const assetsReadSrc = cut(/\n  LIVE\.myAssets = \(me && me\.assets\) \|\| \[\];\n/, 'the shell\'s assets read');
const claimsReadSrc = cut(/\n  LIVE\.systemClaims = \{\};\n[\s\S]*?\n  \}\);\n/, 'the shell\'s claims read');
// The map: the colours, the tilt, and the beacon's rings and draw.
const colourSrc = cut(/\n  const COLOR_RGB = [^\n]*\n  function col\(key, a\) [^\n]*\n/, 'COLOR_RGB / col');
const squashSrc = cut(/\n  const SQUASH = [^\n]*\n/, 'SQUASH');
const beaconSrc = cut(/\n  const BEACON_PERIOD_MS = [\s\S]*?\n  function drawClaimBeacon\(scr, rim, now\) \{[\s\S]*?\n  \}\n/, 'the beacon');

// The board the page loads from GET /board, crossed as JSON as it crosses the wire.
const BOARD = JSON.parse(JSON.stringify(getBoard()));

// page(state, guildId) -> the shell as it stands after applySnapshot read the guild's own fogged VIEW of `state`.
// `p.pending()` is what the map draws this frame; `p.read(next)` is the next poll.
function page(state, guildId = 'g1') {
  const sandbox = { window: {}, GAME: { guildId, galaxy: BOARD }, LIVE: { systemClaims: {}, myAssets: [] } };
  vm.createContext(sandbox);
  vm.runInContext(kitKindsSrc + shellSrc
    + `function applyRead(snap){ var me = (snap.guilds || []).filter(function(g){ return g.id === GAME.guildId; })[0] || null;`
    + assetsReadSrc + claimsReadSrc + '}', sandbox);
  const p = {
    read(s) { sandbox.applyRead(JSON.parse(JSON.stringify(buildSnapshot(s, guildId)))); return p; },
    pending: () => JSON.parse(JSON.stringify(sandbox.window.__pendingPrefectures())),
    ids: () => p.pending().map((row) => row.systemId),
  };
  return p.read(state);
}

// The engine's own answer, written out again from the STATE (not the view): the systems where `guildId` has an idle
// Prefecture kit in its inventory and no guild holds the system.
function engineReady(s, guildId) {
  const kits = (s.guilds.find((g) => g.id === guildId).assets || [])
    .filter((a) => a.kind === PREFECTURE_KIT_KIND && a.deployedToVentureId == null);
  return [...new Set(kits.map((a) => a.systemId))].filter((id) => systemHolder(s, id) == null).sort();
}
// Every system a kit or a claim names in `s` — the ones the beacon could be wrong about.
function namedSystems(s) {
  const ids = new Set(s.claims.filter((c) => c.landmarkKind === 'system').map((c) => c.landmarkId));
  s.guilds.forEach((g) => (g.assets || []).forEach((a) => ids.add(a.systemId)));
  return [...ids].sort();
}
// agree(s, what) -> the page's set, after checking it against the engine's for both guilds on every named system.
function agree(s, what) {
  for (const guildId of ['g1', 'g2']) {
    const shown = page(s, guildId).ids().sort();
    const ready = engineReady(s, guildId);
    for (const id of namedSystems(s)) {
      assert.equal(shown.includes(id), ready.includes(id),
        `${what}, ${guildId}, ${id}: the page ${shown.includes(id) ? 'marks' : 'does not mark'} it; the engine says `
        + `${ready.includes(id) ? 'an idle kit of ours waits in an unclaimed system' : `not ready (holder ${systemHolder(s, id)})`}`);
    }
    assert.deepEqual(shown, ready, `${what}, ${guildId}: nothing else is marked`);
  }
  return page(s, 'g1').pending();
}

// A second unclaimed system to put a kit in: not a starter and not one the fixtures already use (the first by id).
const STARTERS = new Set(getStarterSystems().map((s) => s.id));
const OTHER = seed.systems
  .filter((sys) => ![P.HOME.id, P.RIVAL, P.TARGET].includes(sys.id) && !STARTERS.has(sys.id))
  .sort((a, b) => a.id.localeCompare(b.id))[0].id;

// --- the galaxies (prefecture-plant-client.test.js's, plus the in-flight and two-system ones) ------------------------

function ready() {
  const { s, kitId } = P.ferried();
  return { s: P.survey(s, 'g1', P.PLANET_A), kitId };
}
function planted() {
  const { s, kitId } = ready();
  return P.accept(s, P.plant('g1', kitId, P.SLOT_A1));
}
function ownFirst() {
  return P.grantPrefectureKit(planted(), 'g1', P.TARGET).s;
}
function rivalFirst() {
  let { s } = ready();
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', P.TARGET));
  s = P.survey(s, 'g2', P.PLANET_A);
  return P.accept(s, P.plant('g2', kitId, P.SLOT_A1));
}
function atHome() {
  return P.grantPrefectureKit(P.kitGalaxy(), 'g1', P.HOME.id).s;
}
function spaceKitThere() {
  return P.accept(atHome(), createGrantKitAction({ guildId: 'g1', systemId: P.TARGET, kind: 'outpost' }));
}
function inFlight() {
  let { s } = P.laden({});
  s = P.accept(s, P.unloadRoute(P.AT_TARGET));
  return P.ticks(s, 5);
}

// --- 1 & 2. the set ------------------------------------------------------------------------------------------------

test('a kit ferried into an unclaimed system marks that system, once, on its centre hex', () => {
  const rows = agree(ready().s, 'the kit ferried into TARGET');
  assert.deepEqual(rows, [{ systemId: P.TARGET, q: getSystem(P.TARGET).coords.q, r: getSystem(P.TARGET).coords.r }]);
  // The survey is not part of the beacon's rule: the kit waits whether or not a planet there is surveyed yet.
  assert.deepEqual(agree(P.ferried().s, 'the kit ferried in, nothing surveyed'), rows);
});

test('no beacon where the kit cannot be planted: planted, held by us, taken by a rival, at home, or the wrong kind', () => {
  assert.deepEqual(agree(planted(), 'planted: the system is ours and the kit used up'), []);
  assert.deepEqual(agree(ownFirst(), 'held by us, a second kit there'), []);
  assert.deepEqual(agree(rivalFirst(), 'a rival planted first: our kit is stranded'), []);
  assert.deepEqual(agree(atHome(), 'the kit still at home'), []);
  assert.deepEqual(agree(spaceKitThere(), 'an Outpost kit in TARGET, the Prefecture kit at home'), []);
});

test('no beacon for a kit aboard a heavy — loaded at home, or in flight to the target', () => {
  let { s, kitId } = P.grantPrefectureKit(P.kitGalaxy(), 'g1', P.HOME.id);
  // Loaded, the kit is a good in the heavy's hold, no longer an asset in any system's inventory.
  s = P.accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: P.HEAVY, assetId: kitId }));
  assert.deepEqual(agree(s, 'loaded aboard the heavy'), []);
  const flying = inFlight();
  assert.equal(P.heavyOf(flying).status, 'inTransit', 'the heavy is between systems');
  assert.deepEqual(agree(flying, 'in flight to TARGET'), []);
});

test('one row per system however many kits wait there; one per system when kits wait in two', () => {
  let { s } = ready();
  ({ s } = P.grantPrefectureKit(s, 'g1', P.TARGET));
  assert.equal(engineReady(s, 'g1').length, 1);
  assert.equal((P.g1Of(s).assets || []).filter((a) => a.kind === PREFECTURE_KIT_KIND && a.systemId === P.TARGET).length, 2);
  assert.deepEqual(agree(s, 'two kits in TARGET').map((r) => r.systemId), [P.TARGET]);
  ({ s } = P.grantPrefectureKit(s, 'g1', OTHER));
  assert.deepEqual(agree(s, 'kits in TARGET and OTHER').map((r) => r.systemId).sort(), [P.TARGET, OTHER].sort());
});

// --- 3. own-only ---------------------------------------------------------------------------------------------------

test('own-only: a rival\'s kit waiting in an unclaimed system is in the rival\'s set and never in ours', () => {
  const { s } = P.grantPrefectureKit(P.kitGalaxy(), 'g2', P.TARGET);
  agree(s, 'the rival\'s kit in TARGET');
  assert.deepEqual(page(s, 'g1').ids(), [], 'not in ours');
  assert.deepEqual(page(s, 'g2').ids(), [P.TARGET], 'in the rival\'s own');
});

test('the selector reads only what it is handed: a kit in a system off the board, or a claimed one, gives no row', () => {
  const sandbox = { window: {}, GAME: {}, LIVE: {} };
  vm.createContext(sandbox);
  vm.runInContext(kitKindsSrc + shellSrc, sandbox);
  const systems = [{ id: 'a', coords: { q: 1, r: 2 } }, { id: 'b', coords: { q: 3, r: 4 } }];
  const kits = [{ id: 'k1', systemId: 'a' }, { id: 'k2', systemId: 'b' }, { id: 'k3', systemId: 'a' }, { id: 'k4', systemId: 'gone' }];
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pendingPrefectures(kits, {}, systems))),
    [{ systemId: 'a', q: 1, r: 2 }, { systemId: 'b', q: 3, r: 4 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pendingPrefectures(kits, { b: 'g2' }, systems))), [{ systemId: 'a', q: 1, r: 2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pendingPrefectures([], {}, systems))), []);
});

// --- 4. nothing kept by hand ---------------------------------------------------------------------------------------

test('the next snapshot clears the beacon: the kit planted, or the system claimed by a rival first', () => {
  const r = ready();
  const p = page(r.s);
  assert.deepEqual(p.ids(), [P.TARGET], 'before the plant');
  assert.deepEqual(p.read(P.accept(r.s, P.plant('g1', r.kitId, P.SLOT_A1))).ids(), [], 'after the plant: gone');

  const q = page(ready().s);
  assert.deepEqual(q.ids(), [P.TARGET], 'before the rival\'s plant');
  const taken = rivalFirst();
  assert.equal(P.g1Of(taken).assets.filter((a) => a.kind === PREFECTURE_KIT_KIND && a.systemId === P.TARGET).length, 1,
    'our kit still lies in TARGET');
  assert.deepEqual(q.read(taken).ids(), [], 'a rival took the system: gone (a stranded kit is not marked)');
});

// --- 5. the rings --------------------------------------------------------------------------------------------------

// rings() -> the map's beacon code over a stub canvas: every method call is recorded as [name, ...args], and every
// property set as ['=name', value].
function rings() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (...args) => calls.push([k, ...args]),
    set: (_, k, v) => { calls.push([`=${String(k)}`, v]); return true; },
  });
  const map = vm.runInNewContext(colourSrc + squashSrc + beaconSrc
    + ';({ beaconRings, drawClaimBeacon, BEACON_PERIOD_MS, BEACON_RINGS, BEACON_MIN_RIM_PX, SQUASH })', { ctx });
  return { calls, ...map };
}

test('the rings: three, evenly spaced between the centre and the rim, each falling inward and wrapping to the rim', () => {
  const b = rings();
  assert.equal(b.BEACON_RINGS, 3);
  const RIM = 30;
  const period = b.BEACON_PERIOD_MS;
  for (const t of [0, 1, period * 0.25, period * 0.5, period * 0.9, period * 7.3]) {
    const set = b.beaconRings(RIM, t);
    assert.equal(set.length, 3, `t=${t}: three rings`);
    set.forEach((ring) => assert.ok(ring.radius > 0 && ring.radius <= RIM, `t=${t}: inside the rim (${ring.radius})`));
    const radii = set.map((ring) => ring.radius).sort((x, y) => x - y);
    assert.ok(Math.abs(radii[1] - radii[0] - RIM / 3) < 1e-9 && Math.abs(radii[2] - radii[1] - RIM / 3) < 1e-9,
      `t=${t}: a third of the rim apart (${radii.join(', ')})`);
  }
  // Inward: within a cycle every ring is smaller a moment later; and the inner ring wraps back to the rim.
  const step = period / 50;
  for (let t = 0; t < period * 2; t += step) {
    const now = b.beaconRings(RIM, t), next = b.beaconRings(RIM, t + step / 10);
    now.forEach((ring, i) => {
      if (ring.radius > RIM / 10) assert.ok(next[i].radius < ring.radius, `t=${t}: ring ${i} moves inward`);
    });
  }
  const before = b.beaconRings(RIM, period - 1)[0], after = b.beaconRings(RIM, period)[0];
  assert.ok(before.radius < 0.01 * RIM && after.radius === RIM, 'a ring that reaches the centre reappears at the rim');
  assert.ok(before.alpha < 0.01 && after.alpha < 1e-9, 'faded out at the centre, faded in at the rim: nothing pops');
});

test('the draw: hollow rings in the player accent, centred on the hex and laid flat in the map\'s tilt', () => {
  const b = rings();
  b.drawClaimBeacon({ x: 200, y: 120 }, 30, b.BEACON_PERIOD_MS * 0.2);
  const names = b.calls.map((c) => c[0]);
  assert.deepEqual(b.calls.find((c) => c[0] === 'translate'), ['translate', 200, 120], 'centred on the hex');
  assert.deepEqual(b.calls.find((c) => c[0] === 'scale'), ['scale', 1, b.SQUASH], 'flat in the tilted plane');
  const arcs = b.calls.filter((c) => c[0] === 'arc');
  assert.equal(arcs.length, 3, 'three rings');
  arcs.forEach((a) => { assert.equal(a[1], 0); assert.equal(a[2], 0); assert.equal(a[4], 0); assert.equal(a[5], Math.PI * 2); });
  assert.ok(!names.includes('fill') && !names.includes('fillRect'), 'hollow: nothing filled, unlike a settled claim\'s territory');
  const accents = b.calls.filter((c) => c[0] === '=strokeStyle' && String(c[1]).startsWith('rgba(67,217,200,'));
  assert.equal(accents.length, 3, 'each ring stroked in the player accent (COLOR_RGB.player)');
  assert.equal(names[names.length - 1], 'restore', 'the canvas state is put back');
  assert.ok(b.BEACON_MIN_RIM_PX >= 10, 'big enough to read from the whole-galaxy view');
});
