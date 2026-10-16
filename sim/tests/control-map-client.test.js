'use strict';

// control-map-client.test.js — the CLIENT render of the seniority control map (roadmap 2.5, the Prefecture / claims
// slice, client PR A; docs/territory-model.md §2, "AS-BUILT — client PR A").
//
// The engine resolves who controls each hex of two overlapping footprints and sends it as the snapshot's
// `controlMap` (engine PR 2). The client's `computeTerritoryMap` paints those rows and nothing else for the system
// layer (design.md §18): no disk expansion, and no pass that lets the player's own guild win an overlap.
//
// The tripwires:
//   1. EVERY ROW, AS SENT: each controlMap row is one map entry, in its guild's colour (the player's accent, or the
//      one rival colour) and labelled with its name — in both guilds' views of a real Prefecture plant.
//   2. SENIORITY, RIVAL OVER OWN: the junior guild's view paints the contested hexes — inside its own disk — in the
//      senior rival's colour. The pre-PR own-last pass painted them in the player's accent.
//   3. THE OWN-CENTRE OVERRIDE: two adjacent held systems — the junior's centre shows the junior, though the
//      senior's disk covers it; the senior shows on the other 3 shared hexes.
//   4. ONLY controlMap PAINTS SYSTEMS: a snapshot whose map is empty paints no system territory, though its
//      claims still list held systems; and the code reads no claim geometry.
//   5. THE SINGLE-HEX TILES ARE UNCHANGED: Syndicate waystations, guild Outposts and toll gates keep their sources
//      and their places in the paint order (an Outpost or gate over the system layer, a waystation under it).
//   6. THE CONTRACT: the map is still "q,r" -> { r, g, b, label } (+ isGate), and its three readers are untouched.
//
// The client has no DOM test harness, so — as outpost-teardown-client.test.js does — these tests cut the page's OWN
// code out of game.html (the shell's territory read and its call into the map, and the map's loadClaims,
// __setLiveTerritory and computeTerritoryMap) and run it in a node:vm sandbox against REAL engine output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { getBoard, getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { createSpawnOutpostAction } = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const seed = require('../../data/seed.json');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

// ---- the page's own code, cut out of game.html -----------------------------------------------------------------

// cut(re, what) -> the first match of `re` in game.html, or a loud failure naming what went missing.
function cut(re, what) {
  const m = html.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
const playerGuildSrc = cut(/\n  const PLAYER_GUILD = \{[^\n]*\n/, 'PLAYER_GUILD');
const rivalRgbSrc = cut(/\n  const RIVAL_RGB = \{[^\n]*\n/, 'RIVAL_RGB');
const hexesInRadiusSrc = cut(/\n  function hexesInRadius\(center, radius\) \{[\s\S]*?\n  \}\n/, 'hexesInRadius');
const computeSrc = cut(/\n  function computeTerritoryMap\(\) \{[\s\S]*?\n    return map;\n  \}\n/, 'computeTerritoryMap');
const loadClaimsSrc = cut(/\n  function loadClaims\(parsed\) \{[\s\S]*?\n  \}\n(?=\n  function loadGalaxy)/, 'loadClaims');
const setLiveSrc = cut(/\n  window\.__setLiveTerritory = function \(live\) \{[\s\S]*?\n  \};\n/, 'window.__setLiveTerritory');
// The shell (applySnapshot): its territory read, from systemClaims to controlMap, and its call into the map.
const shellReadSrc = cut(/\n  LIVE\.systemClaims = \{\};[\s\S]*?\n  LIVE\.controlMap = [^\n]*\n/, 'the shell\'s territory read');
const shellCallSrc = cut(/\n  if \(window\.__setLiveTerritory\)\{\n    window\.__setLiveTerritory\(\{[\s\S]*?\n    \}\);\n  \}\n/, 'the shell\'s __setLiveTerritory call');

// client(board, view, myGuildId) -> the map as the page would build it from this snapshot. One sandbox per call:
// the shell's read and call, then the map's own code, over the seed board the client loads from GET /board.
function client(board, view, myGuildId) {
  const me = view.guilds.find((g) => g.id === myGuildId);
  // The board and the view cross into the sandbox as JSON, as they cross the wire.
  const sandbox = {
    window: {}, document: { getElementById: () => ({}) },
    BOARD: JSON.parse(JSON.stringify(board)), SNAP: JSON.parse(JSON.stringify(view)),
  };
  vm.createContext(sandbox);
  return vm.runInContext(`
    let galaxy = null, claimsData = null, selected = null, selectedType = null;
    let systemById = new Map(), guildById = new Map(), systemToGuild = new Map();
    let guildOutpostByKey = new Map(), guildOutpostById = new Map(), gateByKey = new Map();
    ${playerGuildSrc}${rivalRgbSrc}${hexesInRadiusSrc}${computeSrc}${loadClaimsSrc}${setLiveSrc}
    var GAME = { guildId: ${JSON.stringify(myGuildId)}, guildName: ${JSON.stringify(me.name || me.id)} };
    var LIVE = { systemClaims: {}, controlMap: [] };
    function applyTerritory(snap) {${shellReadSrc}${shellCallSrc}}
    galaxy = BOARD;
    systemById = new Map(galaxy.systems.map((s) => [s.id, s]));
    applyTerritory(SNAP);
    ({
      territory: () => computeTerritoryMap(),
      addTollGate: (gt) => claimsData.tollGates.push(gt),
      LIVE,
    });
  `, sandbox);
}

// The colours, as the page defines them (PRESENTATION, not game numbers): read off the cut source, not retyped.
const ACCENT = { r: 67, g: 217, b: 200 };
const RIVAL = { ...vm.runInNewContext(`(${rivalRgbSrc.match(/\{[^}]*\}/)[0]})`) };
const SYNDICATE = { r: 232, g: 185, b: 58, label: 'Syndicate' };
test('the colours: the accent __setLiveTerritory gives the player, the one RIVAL_RGB, and the Syndicate gold', () => {
  assert.match(setLiveSrc, /color: g\.id === live\.myGuildId \? \{ r: 67, g: 217, b: 200 \} : RIVAL_RGB/);
  assert.deepEqual(RIVAL, { r: 255, g: 92, b: 170 });
  assert.match(computeSrc, /\{ r:232, g:185, b:58, label: 'Syndicate' \}/);
});

const keyOf = (h) => `${h.q},${h.r}`;
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const centreOf = (systemId) => getSystem(systemId).coords;
const diskOf = (systemId) => [...seedDisk(centreOf(systemId))];
function* seedDisk(c) {
  for (let dq = -1; dq <= 1; dq += 1) for (let dr = -1; dr <= 1; dr += 1) if (dist({ q: 0, r: 0 }, { q: dq, r: dr }) <= 1) yield { q: c.q + dq, r: c.r + dr };
}
const BOARD = getBoard();
const nameOf = (view, guildId) => { const g = view.guilds.find((x) => x.id === guildId); return g.name || g.id; };
// paint(view, me, guildId) -> the entry a hex controlled by `guildId` must carry in `me`'s view.
const paint = (view, me, guildId) => ({ ...(guildId === me ? ACCENT : RIVAL), label: nameOf(view, guildId) });

// ---- the galaxies ------------------------------------------------------------------------------------------------

// planted() -> the merged PR 1 fixture after g2 — a RIVAL — plants a Prefecture on TARGET, 2 hexes from g1's home,
// 5 ticks in: g1's home claim (tick 0) is the senior, g2's the junior (control-map.test.js's `planted`).
function planted() {
  let s = P.ticks(P.kitGalaxy({ fuelHoard: 5_000 }), 5);
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', P.TARGET));
  s = P.survey(s, 'g2', P.PLANET_A);
  return P.accept(s, P.plant('g2', kitId, P.SLOT_A1));
}
const PLANTED = planted();
const HOME_DISK = diskOf(P.HOME.id);
const TARGET_DISK = diskOf(P.TARGET);
const CONTESTED = HOME_DISK.filter((h) => TARGET_DISK.some((t) => keyOf(t) === keyOf(h)));

// ADJ_A, ADJ_B — the first two seed systems (in id order) side by side, each centre inside the other's disk. Held by
// g1 (ADJ_A, tick 1 — the senior) and g2 (ADJ_B, tick 5), in a minimal legal galaxy (control-map.test.js's
// `galaxyOf`: homeless guilds, checked clean by every invariant).
const [ADJ_A, ADJ_B] = (() => {
  const ids = seed.systems.map((x) => x.id).sort();
  for (const a of ids) {
    const b = ids.find((id) => id > a && dist(centreOf(a), centreOf(id)) === 1);
    if (b) return [a, b];
  }
  throw new Error('control-map-client test: no two adjacent systems on this seed');
})();
function adjacent() {
  const claim = (guildId, systemId, tick) => ({
    claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system', claimedAtTick: tick, contested: false,
  });
  const s = createState({
    guilds: ['g1', 'g2'].map((id) => ({ id, credits: 0, fuelHoard: 0 })),
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claim('g1', ADJ_A, 1), claim('g2', ADJ_B, 5)],
  });
  s.tick = 10;
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the hand-built galaxy is legal');
  return s;
}
const SHARED_AB = diskOf(ADJ_A).filter((h) => dist(h, centreOf(ADJ_B)) <= 1);

// ---- 1. every row, as sent ---------------------------------------------------------------------------------------

test('EVERY ROW, AS SENT: each controlMap row paints its hex in its guild\'s colour and name, in both guilds\' views', () => {
  for (const me of ['g1', 'g2']) {
    const view = buildSnapshot(PLANTED, me);
    assert.ok(view.controlMap.length > 0, 'the view carries the map');
    const map = client(BOARD, view, me).territory();
    for (const row of view.controlMap) {
      assert.deepEqual({ ...map.get(keyOf(row)) }, paint(view, me, row.guildId), `${me}'s view of ${keyOf(row)} (${row.guildId}'s)`);
    }
    // Nothing else is system territory: every other entry is a single-hex tile (a waystation here — no Outposts).
    const rows = new Set(view.controlMap.map(keyOf));
    const waystations = new Set(BOARD.outposts.map((o) => keyOf(o.coords)));
    for (const [key, entry] of map) {
      if (!rows.has(key)) assert.ok(waystations.has(key) && entry.label === 'Syndicate', `${key} is a row or a waystation`);
    }
  }
});

// ---- 2. seniority, rival over own --------------------------------------------------------------------------------

test('SENIORITY, RIVAL OVER OWN: g2 (the junior) sees its contested hexes in g1\'s colour, though its own disk reaches them', () => {
  assert.ok(CONTESTED.length >= 1, 'the two footprints really overlap, so this test can fail');
  const view = buildSnapshot(PLANTED, 'g2');
  const rows = new Map(view.controlMap.map((row) => [keyOf(row), row]));
  const map = client(BOARD, view, 'g2').territory();
  for (const h of CONTESTED) {
    assert.equal(rows.get(keyOf(h)).guildId, 'g1', `the engine gave ${keyOf(h)} to the senior`);
    assert.deepEqual({ ...map.get(keyOf(h)) }, { ...RIVAL, label: nameOf(view, 'g1') }, `${keyOf(h)} paints in the rival's colour`);
  }
  assert.deepEqual({ ...map.get(keyOf(centreOf(P.TARGET))) }, { ...ACCENT, label: nameOf(view, 'g2') }, 'g2 still shows on its own centre');
  // And the senior's own view of the same hexes: its accent.
  const senior = client(BOARD, buildSnapshot(PLANTED, 'g1'), 'g1').territory();
  for (const h of CONTESTED) assert.deepEqual({ ...senior.get(keyOf(h)) }, { ...ACCENT, label: nameOf(view, 'g1') });
});

// ---- 3. the own-centre override ----------------------------------------------------------------------------------

test('THE OWN-CENTRE OVERRIDE: on two adjacent systems the junior shows on its own centre, the senior on the other 3 shared hexes', () => {
  assert.equal(SHARED_AB.length, 4, 'two touching disks share both centres and the two ring hexes beside both');
  const s = adjacent();
  for (const me of ['g1', 'g2']) {
    const view = buildSnapshot(s, me);
    const map = client(BOARD, view, me).territory();
    const junior = keyOf(centreOf(ADJ_B));
    assert.deepEqual({ ...map.get(junior) }, paint(view, me, 'g2'), `${me}'s view: ADJ_B's centre is g2's, inside g1's disk`);
    const senior = SHARED_AB.filter((h) => keyOf(h) !== junior);
    assert.equal(senior.length, 3);
    for (const h of senior) assert.deepEqual({ ...map.get(keyOf(h)) }, paint(view, me, 'g1'), `${me}'s view: shared ${keyOf(h)} is g1's`);
  }
});

// ---- 4. only controlMap paints systems ---------------------------------------------------------------------------

test('ONLY controlMap PAINTS SYSTEMS: with the map emptied, no system territory paints, though the claims still list the holds', () => {
  const view = buildSnapshot(PLANTED, 'g2');
  const page = client(BOARD, { ...view, controlMap: [] }, 'g2');
  assert.ok(view.claims.filter((c) => c.landmarkKind === 'system').length >= 3, 'g1\'s home, g2\'s home and g2\'s Prefecture are held');
  const waystations = new Set(BOARD.outposts.map((o) => keyOf(o.coords)));
  for (const [key, entry] of page.territory()) assert.ok(waystations.has(key) && entry.label === 'Syndicate', `${key} is a waystation`);
  // And the code: the territory map reads no claim and casts no disk — those were the client-side expansion.
  for (const word of ['hexesInRadius', 'claimRadius', 'ownedSystemIds', 'systemToGuild', 'systemById']) {
    assert.equal(computeSrc.includes(word), false, `computeTerritoryMap does not read ${word}`);
  }
  assert.match(computeSrc, /claimsData\.controlMap\.forEach\(/);
});

test('THE THREAD: the shell keeps the snapshot\'s controlMap verbatim and hands it to the map', () => {
  const view = buildSnapshot(PLANTED, 'g1');
  const page = client(BOARD, view, 'g1');
  assert.deepEqual(page.LIVE.controlMap, view.controlMap, 'LIVE.controlMap is the snapshot\'s');
  assert.match(shellCallSrc, /controlMap: LIVE\.controlMap,/);
  assert.match(setLiveSrc, /controlMap: live\.controlMap \|\| \[\]/);
});

// ---- 5. the single-hex tiles are unchanged -----------------------------------------------------------------------

test('THE SINGLE-HEX TILES: an Outpost paints its owner over the system layer, a toll gate is a hollow gate over it, a waystation stays gold', () => {
  // g1 places an Outpost on a bare hex of g2's Prefecture disk that only g2 controls (the operator places freely).
  const inG2 = TARGET_DISK.find((h) => !CONTESTED.some((c) => keyOf(c) === keyOf(h)) && isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r));
  assert.ok(inG2, 'a bare hex inside g2\'s disk alone');
  const s = P.accept(PLANTED, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: P.HOME.id, coords: inG2 }));
  for (const me of ['g1', 'g2']) {
    const view = buildSnapshot(s, me);
    assert.equal(view.controlMap.find((row) => keyOf(row) === keyOf(inG2)).guildId, 'g2', 'the engine gives the hex to g2\'s system');
    const page = client(BOARD, view, me);
    assert.deepEqual({ ...page.territory().get(keyOf(inG2)) }, paint(view, me, 'g1'), `${me}'s view: the Outpost shows its owner, g1`);
    // A toll gate (the engine has none yet, so it is pushed straight into the map's gate list): its own hex, isGate.
    const gateHex = CONTESTED[0];
    page.addTollGate({ id: 'gate_test', guildId: 'g2', coords: gateHex });
    assert.deepEqual({ ...page.territory().get(keyOf(gateHex)) }, { ...paint(view, me, 'g2'), isGate: true }, `${me}'s view: the gate over g1's hex`);
  }
  // Every waystation no held disk reaches keeps the gold Syndicate tile.
  const view = buildSnapshot(s, 'g1');
  const rows = new Set(view.controlMap.map(keyOf));
  const map = client(BOARD, view, 'g1').territory();
  const outside = BOARD.outposts.filter((o) => !rows.has(keyOf(o.coords)));
  assert.ok(outside.length > 0);
  for (const o of outside) assert.deepEqual({ ...map.get(keyOf(o.coords)) }, SYNDICATE, `waystation ${o.id}`);
});

// ---- 6. the contract ---------------------------------------------------------------------------------------------

test('THE CONTRACT: "q,r" -> { r, g, b, label } (+ isGate on a gate), read by the fill pass, the vector layer and pickHex', () => {
  const page = client(BOARD, buildSnapshot(PLANTED, 'g2'), 'g2');
  page.addTollGate({ id: 'gate_test', guildId: 'g1', coords: CONTESTED[0] });
  for (const [key, entry] of page.territory()) {
    assert.match(key, /^-?\d+,-?\d+$/);
    const keys = Object.keys(entry).sort().join(',');
    assert.ok(keys === 'b,g,label,r' || keys === 'b,g,isGate,label,r', `${key} carries ${keys}`);
  }
  // The three readers are as they were: the fill pass and the vector layer read one map per frame, pickHex one per click.
  assert.equal(html.split('const territoryMap = computeTerritoryMap();').length - 1, 2, 'render and pickHex each build the map');
  assert.match(html, /territoryMap\.forEach\(\(owner, key\) => \{/);
  assert.match(html, /const owner = territoryMap\.get\(key\);/);
  assert.match(html, /if \(!hit && territoryMap\.has\(key\)\) \{ hit = \{ coords: ax, owner: territoryMap\.get\(key\) \}; type = 'territory'; \}/);
});
