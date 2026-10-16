'use strict';

// deep-scan-centre.test.js — roadmap 2.5 slice 16: a Deep Scan Array on its own system's CENTRE hex
// (docs/exploration-model.md §5, "AMENDED 15-10-26 — the centre hex too"; docs/territory-model.md §5). The ONE
// exception to "a deploy lands on a bare hex", for arrays only: a craft berthed AT a system its guild holds plants
// the array on that system's centre, anchored to it (sim/actions.js `deployCheck`, `claimedCentreAt`). The tests,
// one per failure mode the slice named:
//
//   1. OWN CENTRE — manual (deployAsset), act-in-place (a dispatch whose one stop is the home the heavy sits at),
//      and flown (accepted at dispatch, re-checked on arrival, minted on the arrival tick): the array's coords are
//      the centre, its anchor the system, and the heavy is left idle, berthed at the system.
//   2. ONE STRUCTURE PER HEX — a second array on the same centre is 'occupied': by hand, at dispatch, and on
//      arrival, where the unchanged retreat rule lands the craft AT the very system it berthed at.
//   3. STILL REFUSED — an Outpost kit at a centre (its old words, unchanged); a rival's centre ('rival-territory');
//      a system nobody holds, even one inside the guild's own disk ('not-bare-hex' — the slice's decision); a
//      waystation ('not-bare-hex'); the Citadel (not a berth at all; as a bare hex, 'occupied'); and a bare hex
//      that merely shares a held system's coordinates ('occupied' — a centre is reached berthed at the system).
//   4. IN FLIGHT — reachable only on a galaxy created BEFORE roadmap 2.5 slice 17's starter-spacing repair
//      (territory-model.md §6), whose persisted seed can hold two starters side by side: a rival founding next
//      door puts the guild's own centre inside a rival's disk while the craft flies → 'rival-territory', retreat
//      AT the home, kit aboard, notice. Covered on a hand-edited seed (setSeed); on the committed seed — like every
//      new galaxy — the founding next door is refused. And the path no play reaches (the guild LOSES the system)
//      halts on arrival, naming the tick.
//   5. INVARIANTS — every one holds with an array on a centre, tick after tick; the two widened rules are widened
//      to exactly this case (an array on its OWN anchor system's centre; a deepScan deploy stopping at a system).
//   6. THE LANE — publishes each held centre, never an unheld, rival, waystation or Citadel hex, and equals the
//      independent oracle over the whole galaxy.
//   7. NO-OP + DETERMINISM — a galaxy with no array on a centre serializes byte-identically to main before this
//      slice, and its god's-eye lens differs only by the centres the lanes gained (hashes recorded on 8795070);
//      two runs are identical; save → restore is byte-identical.

// ⤳ 16-10-26 (roadmap 2.5, the Prefecture / claims slice): digests pinned below were RE-PINNED. The slice
// re-banded two Tier-3 modules the Prefecture bill uses (claim_beacon → 3-2, habitation_module → 3-3;
// docs/phase-1-tuning.md), which moves their seeded price rows (prices, price history, the quote ring, and the
// snapshot's price fields) in every state and view. With those two goods' keys deleted, every digest this file
// computes is the one 79807db computed, line for line (checked over all of them at the re-pin); scripted runs
// keep that proof standing in tests/rebanded-goods-delta.test.js. Where a test below says "byte-identical to
// main" or "the pre-slice engine", read: apart from those two goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { checkInvariants } = require('../invariants.js');
const { DEEP_SCAN_KIT } = require('../resources.js');
const { CENTRE_KIND } = require('../deep-scan-arrays.js');
const { hexDistance } = require('../transport.js');
const {
  getSystem, getClaimRadius, getStarterSystems, getTerranHomeworld, getCitadel, getOutpost, isHexInBounds,
  seedLandmarkAtHex, setSeed,
} = require('../seed.js');
const seed = require('../../data/seed.json');
const { mulberry32, generateResourceNodes, generateSettlementSlots } = require('../../tools/generate_seed.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const { attachedByRule } = require('./attached-hexes-oracle.js');
const {
  validateAction, applyAction, quoteDispatch,
  createSpawnVehicleAction, createDeployAssetAction, createDispatchRouteWithActionsAction, createFoundGuildAction,
} = require('../actions.js');

const HOME = starterHomeAtDistance(6);   // a real starter system g1 holds
const HOME_HEX = getSystem(HOME.id).coords;
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const RIVAL = getStarterSystems().map((s) => s.id).find((id) => hexDistance(getSystem(id).coords, HOME_HEX) > 20);
const DEPLOY_ARRAY = { type: 'deploy', kind: 'deepScan' };
const DEPLOY_OUTPOST = { type: 'deploy', kind: 'outpost' };
const at = (systemId) => ({ landmarkKind: 'system', landmarkId: systemId });
const centreOf = (systemId) => getSystem(systemId).coords;
const keyOf = (h) => `${h.q},${h.r}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, `expected a refusal, but ${action.type} was accepted`);
  return reason;
};
const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});
const guildOf = (s, guildId) => s.guilds.find((g) => g.id === guildId);

// galaxy({ home, extra, fuelHoard }) -> g1 at `home` (HOME by default), holding it plus the `extra` systems, and g2
// at RIVAL. The homes are real starter systems, so the guild-home invariant holds.
function galaxy({ home = HOME.id, extra = [], fuelHoard = 0 } = {}) {
  return createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard, homeSystemId: home, homePlanetId: getTerranHomeworld(home) },
      { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: RIVAL, homePlanetId: getTerranHomeworld(RIVAL) },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', home), ...extra.map((id) => claimOf('g1', id)), claimOf('g2', RIVAL)],
  });
}

// armed(state, guildId, where, kind) -> { s, craftId }: a fresh heavy of `guildId` (g1 by default), spawned at its
// home, a kit of `kind` granted and loaded there, then PLACED at `where` (a landmark or a bare hex — the stand-in
// for a flight, kit-fixtures.js). `where` defaults to the home berth itself, where the kit was loaded.
function armed(state, guildId = 'g1', where = null, kind = 'deepScan') {
  const home = guildOf(state, guildId).homeSystemId;
  let s = accept(state, createSpawnVehicleAction({ guildId, class: HEAVY_TRANSPORT, location: at(home) }));
  const vehicles = guildOf(s, guildId).vehicles;
  const craftId = vehicles[vehicles.length - 1].id;
  s = kitAboard(s, guildId, craftId, kind);
  if (where) s = placeCraft(s, guildId, craftId, where);
  return { s, craftId };
}
const deployAsset = (guildId, craftId) => createDeployAssetAction({ guildId, vehicleId: craftId });
const dispatch = (guildId, craftId, waypoints) => createDispatchRouteWithActionsAction({ guildId, vehicleId: craftId, waypoints });
const craftById = (s, guildId, craftId) => guildOf(s, guildId).vehicles.find((v) => v.id === craftId);

function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds.every((g) => (g.vehicles || []).every((v) => v.status === 'idle'))) return s;
    s = tick(s, []);
  }
  throw new Error('a craft never landed');
}

// hexesAt(from, d) -> every hex exactly `d` from `from`, in a fixed scan order.
function hexesAt(from, d) {
  const out = [];
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      if (hexDistance({ q, r }, from) === d) out.push({ q, r });
    }
  }
  return out;
}
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
// A free bare hex a few hexes out from home, for a heavy to fly home FROM.
const OUT_THERE = hexesAt(HOME_HEX, 3).find(isFree);

// INSIDE_DISK — a starter system `a` and another system `b` so close that each centre is inside the other's disk.
// On the committed seed `b` is NOT a starter: since roadmap 2.5 slice 17's starter-spacing repair
// (territory-model.md §6) no two starters' disks overlap, but other systems still crowd a starter freely (§2:
// overlap is a feature). Found by scanning, so a regenerated seed carries the test — or fails it loudly here.
const inEachOthersDisk = (x, y) => hexDistance(centreOf(x), centreOf(y)) <= Math.min(getClaimRadius(x), getClaimRadius(y));
const INSIDE_DISK = (() => {
  for (const { id: a } of getStarterSystems()) {
    const b = seed.systems.find((x) => x.id !== a && inEachOthersDisk(a, x.id));
    if (a !== RIVAL && b) return { a, b: b.id };
  }
  throw new Error('the seed has no starter system with another system inside its disk');
})();

// nextDoorSeed() -> the committed seed with ONE hand edit: INSIDE_DISK's `b` made a starter (its first planet turned
// Terran, with a Terran's nodes and slots, as the generator makes one). Two starters' disks then overlap — what
// the starter-spacing repair keeps out of every NEW galaxy, but what a galaxy created before it can still hold (a
// persisted seed is never regenerated). The seniority control map is unbuilt, so "refused for both" is live engine
// code for such a galaxy, and it stays covered here, through the setSeed seam. (mulberry32(1) only fills the three
// random Terran nodes; it is a fixture stream, not a game number.)
function nextDoorSeed() {
  const edited = structuredClone(seed);
  const b = edited.systems.find((x) => x.id === INSIDE_DISK.b);
  const planet = b.planets[0];
  planet.archetype = 'terran';
  planet.resourceNodes = generateResourceNodes('terran', mulberry32(1), planet.id);
  planet.settlementSlots = generateSettlementSlots('terran', mulberry32(1), planet.id);
  b.starterEligible = true;
  return edited;
}
// onNextDoorSeed(fn) — run `fn` with that seed active, and always put the committed seed back afterwards.
function onNextDoorSeed(fn) {
  setSeed(nextDoorSeed());
  try {
    return fn();
  } finally {
    setSeed(null);   // back to the committed seed for every other test
  }
}

// --- 1. the guild's own centre -------------------------------------------------------------------------

test('OWN CENTRE, by hand: a heavy berthed at its own held home plants the array ON the centre, anchored home, and stays berthed there', () => {
  const { s, craftId } = armed(galaxy());
  const after = accept(s, deployAsset('g1', craftId));
  assert.deepEqual(after.deepScanArrays, [
    { id: 'deepScanArray_g1_01', ownerGuildId: 'g1', coords: HOME_HEX, anchorSystemId: HOME.id, createdAtTick: s.tick },
  ]);
  const craft = craftById(after, 'g1', craftId);
  assert.deepEqual(craft.location, AT_HOME, 'idle and berthed at the system, as at any berth');
  assert.equal(craft.status, 'idle');
  assert.equal(craft.cargo, undefined, 'the kit is consumed');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('OWN CENTRE, in place: a dispatch whose one stop is the home the heavy sits at deploys at once, burning nothing — the client\'s flow', () => {
  const { s, craftId } = armed(galaxy());
  const route = [{ anchor: AT_HOME, action: DEPLOY_ARRAY }];
  // The quote the deploy map and popup ask for (POST /vehicle/quote reads the anchors only): an act-in-place route.
  const quote = quoteDispatch(s, { guildId: 'g1', vehicleId: craftId, waypoints: route.map((wp) => wp.anchor) });
  assert.equal(quote.ok, true, `the planner can quote it: ${quote.reason}`);
  assert.deepEqual({ legs: quote.legs, totalTicks: quote.totalTicks, totalUnits: quote.totalUnits }, { legs: [], totalTicks: 0, totalUnits: 0 });
  const after = accept(s, dispatch('g1', craftId, route));
  assert.equal(after.deepScanArrays[0].createdAtTick, s.tick, 'planted on the dispatch tick (act in place, §11.9)');
  assert.deepEqual(after.deepScanArrays[0].coords, HOME_HEX);
  assert.equal(guildOf(after, 'g1').fuelHoard, guildOf(s, 'g1').fuelHoard, 'no leg, no fuel');
  const craft = craftById(after, 'g1', craftId);
  assert.deepEqual(craft.location, AT_HOME);
  assert.equal(craft.route, undefined, 'the one-shot route ended');
  assert.equal(craft.status, 'idle');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('OWN CENTRE, flown: accepted at dispatch, the leg ends berthed AT home, and the array is minted on the arrival tick', () => {
  const { s: laden, craftId } = armed(galaxy({ fuelHoard: 100_000 }), 'g1', OUT_THERE);
  let s = accept(laden, dispatch('g1', craftId, [{ anchor: AT_HOME, action: DEPLOY_ARRAY }]));
  const trip = craftById(s, 'g1', craftId).trip;
  assert.deepEqual(trip.legs[trip.legs.length - 1].to, AT_HOME, 'the deploy leg ends at the system landmark');
  assert.equal(s.deepScanArrays, undefined, 'nothing placed before it lands');
  s = tickToIdle(s);
  assert.deepEqual(s.deepScanArrays, [
    { id: 'deepScanArray_g1_01', ownerGuildId: 'g1', coords: HOME_HEX, anchorSystemId: HOME.id, createdAtTick: trip.arrivalTick },
  ]);
  const craft = craftById(s, 'g1', craftId);
  assert.deepEqual(craft.location, AT_HOME, 'left idle, berthed at the system');
  assert.equal(craft.cargo, undefined);
  assert.equal(craft.deployFailed, undefined);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. one structure per hex --------------------------------------------------------------------------------

test('A SECOND ARRAY on the same centre is refused "occupied" — by hand and at dispatch', () => {
  const first = armed(galaxy());
  const s1 = accept(first.s, deployAsset('g1', first.craftId));
  const { s, craftId } = armed(s1);
  assert.match(refuse(s, deployAsset('g1', craftId)), /already occupied by deepScanArray "deepScanArray_g1_01" — one structure per hex/);
  assert.match(refuse(s, dispatch('g1', craftId, [{ anchor: AT_HOME, action: DEPLOY_ARRAY }])),
    /the deploy at waypoint 0 would fail now — .*already occupied by deepScanArray "deepScanArray_g1_01"/);
});

test('RE-CHECKED ON ARRIVAL: the centre taken in flight → "occupied"; the unchanged retreat lands the craft AT that same system, kit aboard, notice', () => {
  const { s: laden, craftId } = armed(galaxy({ fuelHoard: 100_000 }), 'g1', OUT_THERE);
  let s = accept(laden, dispatch('g1', craftId, [{ anchor: AT_HOME, action: DEPLOY_ARRAY }]));
  const arrivalTick = craftById(s, 'g1', craftId).trip.arrivalTick;
  // While it flies, a second heavy plants an array on the centre by hand.
  const other = armed(s);
  s = accept(other.s, deployAsset('g1', other.craftId));
  s = tickToIdle(s);
  assert.equal(s.deepScanArrays.length, 1, 'the second array was not placed');
  const craft = craftById(s, 'g1', craftId);
  assert.deepEqual(craft.deployFailed, { reason: 'occupied', tick: arrivalTick });
  assert.deepEqual(craft.cargo, { [DEEP_SCAN_KIT]: 1 }, 'the kit is still aboard');
  // The retreat rule, unchanged: S (the nearest held system) is the system itself, 0 hexes away — "that close or
  // closer" — so the craft lands AT S. From a system berth it does not move.
  assert.deepEqual(craft.location, AT_HOME);
  const notice = guildOf(s, 'g1').events.find((e) => e.type === 'deploy_failed');
  assert.deepEqual(
    { tick: notice.tick, cause: notice.payload.cause, kind: notice.payload.kind, targetHex: notice.payload.targetHex, retreatSystemId: notice.payload.retreatSystemId },
    { tick: arrivalTick, cause: 'occupied', kind: 'deepScan', targetHex: HOME_HEX, retreatSystemId: HOME.id },
  );
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. still refused ------------------------------------------------------------------------------------

test('AN OUTPOST KIT at a centre is still refused, in its old words — the exception is for arrays only', () => {
  const { s, craftId } = armed(galaxy(), 'g1', null, 'outpost');
  const manual = refuse(s, deployAsset('g1', craftId));
  assert.match(manual, /berthed at a landmark .* — an Outpost deploys on a bare hex; fly the craft to open space first$/);
  const routed = refuse(s, dispatch('g1', craftId, [{ anchor: AT_HOME, action: DEPLOY_OUTPOST }]));
  assert.match(routed, /^the deploy waypoint 0 is a landmark .* — an Outpost deploys on a bare hex \{ q, r \}$/);
});

test('A RIVAL\'S CENTRE is "rival-territory" — by hand and at dispatch', () => {
  const { s, craftId } = armed(galaxy({ fuelHoard: 100_000 }), 'g1', at(RIVAL));
  const words = new RegExp(`inside guild "g2"'s territory \\(its system "${RIVAL}"\\) — a Deep Scan Array never deploys inside a rival's control`);
  assert.match(refuse(s, deployAsset('g1', craftId)), words);
  const fromHome = armed(galaxy({ fuelHoard: 100_000 }));
  assert.match(refuse(fromHome.s, dispatch('g1', fromHome.craftId, [{ anchor: at(RIVAL), action: DEPLOY_ARRAY }])), words);
});

test('AN UNHELD CENTRE is "not-bare-hex" — even one INSIDE the guild\'s own disk, which the placement rule alone would take', () => {
  // g1 holds A; B, a system whose centre lies inside A's disk, is held by nobody.
  const { a, b } = INSIDE_DISK;
  assert.ok(hexDistance(centreOf(b), centreOf(a)) <= getClaimRadius(a), 'B\'s centre is inside g1\'s own disk');
  const { s, craftId } = armed(galaxy({ home: a, fuelHoard: 100_000 }), 'g1', at(b));
  assert.match(refuse(s, deployAsset('g1', craftId)),
    /berthed at a landmark .* — a Deep Scan Array deploys on a bare hex, or on the centre of a system its guild holds; fly the craft to open space first$/);
  const fromHome = armed(galaxy({ home: a, fuelHoard: 100_000 }));
  assert.match(refuse(fromHome.s, dispatch('g1', fromHome.craftId, [{ anchor: at(b), action: DEPLOY_ARRAY }])),
    /^the deploy waypoint 0 is a landmark .* — a Deep Scan Array deploys on a bare hex \{ q, r \}, or on the centre of a system its guild holds$/);
});

test('A WAYSTATION, the CITADEL, and a bare hex on a held centre\'s coordinates are all still refused', () => {
  // A waystation berth (a seed outpost landmark): 'not-bare-hex'.
  const waystation = armed(galaxy(), 'g1', { landmarkKind: 'outpost', landmarkId: HOME.waystation });
  assert.match(refuse(waystation.s, deployAsset('g1', waystation.craftId)), /berthed at a landmark .* — a Deep Scan Array deploys on a bare hex, or on the centre/);
  // The Citadel is not a berth at all — a route cannot even name it — and its hex, as a bare hex, is occupied.
  const citadel = getCitadel();
  const fromHome = armed(galaxy());
  assert.match(refuse(fromHome.s, dispatch('g1', fromHome.craftId, [{ anchor: { landmarkKind: 'citadel', landmarkId: citadel.id }, action: DEPLOY_ARRAY }])),
    /waypoint 0 does not resolve to a valid anchor/);
  const onCitadel = armed(galaxy(), 'g1', citadel.coords);
  assert.match(refuse(onCitadel.s, deployAsset('g1', onCitadel.craftId)), /already occupied by citadel/);
  // A bare hex that shares the home's coordinates is not a berth at the system: the system occupies it.
  const bare = armed(galaxy(), 'g1', { q: HOME_HEX.q, r: HOME_HEX.r });
  assert.match(refuse(bare.s, deployAsset('g1', bare.craftId)), new RegExp(`already occupied by system "${HOME.id}"`));
});

// --- 4. in flight -----------------------------------------------------------------------------------------

test('IN FLIGHT, on a NEW galaxy: no rival can found inside a home disk — no starter lies in another\'s, and the system beside one is refused', () => {
  // A founding next door is the only way a home centre becomes a rival's while a craft flies (foundGuild is the one
  // claim writer). On the committed seed — like every galaxy generated since slice 17 — no starter can do it.
  const starters = getStarterSystems().map((s) => s.id);
  for (const x of starters) {
    const inside = starters.find((y) => y !== x && inEachOthersDisk(x, y));
    assert.equal(inside, undefined, `starter ${inside} lies inside starter ${x}'s disk`);
  }
  const { a, b } = INSIDE_DISK;
  assert.match(refuse(galaxy({ home: a }), createFoundGuildAction({ guildId: 'g3', name: 'Next Door', isBot: true, credits: 0, homeSystemId: b })),
    new RegExp(`homeSystemId "${b}" is not a starter-eligible system`));
});

test('IN FLIGHT, REACHABLE on a galaxy created before the spacing repair: a rival founds on the starter next door → "rival-territory", retreat AT home, kit aboard', () => onNextDoorSeed(() => {
  const { a, b } = INSIDE_DISK;
  const start = hexesAt(centreOf(a), 3).find(isFree);
  const { s: laden, craftId } = armed(galaxy({ home: a, fuelHoard: 100_000 }), 'g1', start);
  let s = accept(laden, dispatch('g1', craftId, [{ anchor: at(a), action: DEPLOY_ARRAY }]));   // legal at dispatch
  const arrivalTick = craftById(s, 'g1', craftId).trip.arrivalTick;
  s = accept(s, createFoundGuildAction({ guildId: 'g3', name: 'Next Door', isBot: true, credits: 0, homeSystemId: b }));
  s = tickToIdle(s);
  assert.equal(s.deepScanArrays, undefined, 'nothing was placed: the overlap is refused for both (no seniority yet)');
  const craft = craftById(s, 'g1', craftId);
  assert.deepEqual(craft.deployFailed, { reason: 'rival-territory', tick: arrivalTick });
  assert.deepEqual(craft.cargo, { [DEEP_SCAN_KIT]: 1 });
  assert.deepEqual(craft.location, at(a), 'S is the home itself, 0 hexes away: it lands AT S');
  const notice = guildOf(s, 'g1').events.find((e) => e.type === 'deploy_failed');
  assert.deepEqual({ cause: notice.payload.cause, targetHex: notice.payload.targetHex, retreatSystemId: notice.payload.retreatSystemId },
    { cause: 'rival-territory', targetHex: centreOf(a), retreatSystemId: a });
  assert.deepEqual(checkInvariants(s, s.tick), []);
}));

test('IN FLIGHT, UNREACHABLE: if the guild LOST the system (no play path does), the arrival HALTS, naming the tick', () => {
  // g1 holds a second system X; the craft flies to X's centre; X's claim is then removed by hand.
  const x = INSIDE_DISK.b;
  const { s: laden, craftId } = armed(galaxy({ extra: [x], fuelHoard: 100_000 }), 'g1', hexesAt(centreOf(x), 3).find(isFree));
  let s = accept(laden, dispatch('g1', craftId, [{ anchor: at(x), action: DEPLOY_ARRAY }]));
  s.claims = s.claims.filter((c) => c.landmarkId !== x);
  assert.throws(() => tickToIdle(s), /deploy on arrival, tick \d+: guild "g1" vehicle .* failed the "not-bare-hex" check, which the dispatch gate rules out/);
});

// --- 5. invariants ------------------------------------------------------------------------------------------

test('INVARIANTS hold with an array on a centre, tick after tick', () => {
  const { s: start, craftId } = armed(galaxy());
  let s = accept(start, deployAsset('g1', craftId));
  for (let i = 0; i < 5; i += 1) {
    s = tick(s, []);
    assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
  }
  assert.deepEqual(s.deepScanArrays[0].coords, HOME_HEX);
});

test('INVARIANTS, widened to EXACTLY this case: an array may share a hex only with its own anchor system; a deepScan deploy may stop at a system', () => {
  const { s: start, craftId } = armed(galaxy());
  const s = accept(start, deployAsset('g1', craftId));
  const rules = (mutate) => {
    const bad = structuredClone(s);
    mutate(bad);
    return checkInvariants(bad, bad.tick).map((v) => v.rule);
  };
  const SEED_RULE = 'deepScanArray-hex-unoccupied-by-seed (§4)';
  const row = (b) => b.deepScanArrays[0];
  assert.ok(rules((b) => { row(b).anchorSystemId = RIVAL; }).includes(SEED_RULE), 'on a centre it does not hang off');
  assert.ok(rules((b) => { row(b).coords = { ...getOutpost(HOME.waystation).coords }; }).includes(SEED_RULE), 'on a waystation');
  assert.ok(rules((b) => { row(b).coords = { ...getCitadel().coords }; }).includes(SEED_RULE), 'on the Citadel');
  assert.ok(rules((b) => { b.deepScanArrays.push({ ...row(b), id: 'deepScanArray_g1_02' }); b.guilds[0].deepScanArraySerial = 2; })
    .includes('deepScanArray-hex-unique (§4)'), 'two arrays on one centre');
  // The route rule: a craft in flight carries its route; only a deepScan deploy may stop at a system.
  const routeRules = (waypoints) => rules((b) => {
    const craft = b.guilds[0].vehicles.find((v) => v.id === craftId);
    craft.status = 'inTransit';
    craft.trip = { legs: [{ from: { ...OUT_THERE }, to: { ...waypoints[0].anchor }, isToll: false, departureTick: 0, arrivalTick: 900 }], dispatchTick: 0, arrivalTick: 900 };
    craft.cargo = { [DEEP_SCAN_KIT]: 1 };
    delete craft.location;
    craft.route = { waypoints, cursor: 0 };
  }).filter((r) => /route/.test(r));
  assert.deepEqual(routeRules([{ anchor: AT_HOME, action: DEPLOY_ARRAY }]), [], 'a deepScan deploy stopping at a system is legal');
  assert.notDeepEqual(routeRules([{ anchor: AT_HOME, action: DEPLOY_OUTPOST }]), [], 'an outpost deploy stopping at a system is not');
  assert.notDeepEqual(routeRules([{ anchor: { landmarkKind: 'outpost', landmarkId: HOME.waystation }, action: DEPLOY_ARRAY }]), [], 'nor a deepScan deploy at a waystation');
});

test('THE ONE KIND: the exception names the Deep Scan Array\'s own kit kind', () => {
  assert.equal(CENTRE_KIND, 'deepScan');
});

// --- 6. the lane --------------------------------------------------------------------------------------------

const laneOf = (s, guildId) => {
  const row = buildSnapshot(s).guilds.find((g) => g.id === guildId);
  return (row.deployRange && row.deployRange.deepScan && row.deployRange.deepScan.hexes) || [];
};

test('THE LANE publishes each held centre (and only held ones), stays occupancy-blind there, and equals the oracle', () => {
  const s = galaxy();
  const mine = laneOf(s, 'g1').map(keyOf);
  const theirs = laneOf(s, 'g2').map(keyOf);
  assert.ok(mine.includes(keyOf(HOME_HEX)), 'g1\'s own centre');
  assert.ok(theirs.includes(keyOf(centreOf(RIVAL))), 'g2\'s own centre');
  assert.ok(!mine.includes(keyOf(centreOf(RIVAL))) && !theirs.includes(keyOf(HOME_HEX)), 'never a rival\'s centre');
  assert.deepEqual(laneOf(s, 'g1'), attachedByRule(s, 'g1'));
  assert.deepEqual(laneOf(s, 'g2'), attachedByRule(s, 'g2'));
  // Occupancy-blind, as everywhere on the lane: an array on the centre leaves it listed; deployCheck refuses it.
  const first = armed(s);
  const withArray = accept(first.s, deployAsset('g1', first.craftId));
  assert.ok(laneOf(withArray, 'g1').map(keyOf).includes(keyOf(HOME_HEX)));
  assert.deepEqual(laneOf(withArray, 'g1'), attachedByRule(withArray, 'g1'));
  // No waystation and no Citadel hex is ever in a lane.
  const banned = new Set([...seed.outposts.map((o) => keyOf(o.coords)), keyOf(getCitadel().coords)]);
  assert.ok([...mine, ...theirs].every((k) => !banned.has(k)));
});

test('THE LANE, next door: an unheld centre inside the disk is left out', () => {
  const { a, b } = INSIDE_DISK;
  const s = galaxy({ home: a });
  assert.ok(laneOf(s, 'g1').map(keyOf).includes(keyOf(centreOf(a))));
  assert.ok(!laneOf(s, 'g1').map(keyOf).includes(keyOf(centreOf(b))), 'B is held by nobody: its centre is not ground');
  assert.deepEqual(laneOf(s, 'g1'), attachedByRule(s, 'g1'));
});

test('THE LANE, next door, on a galaxy created before the spacing repair: once a rival holds B, BOTH home centres drop out (refused for both)', () => onNextDoorSeed(() => {
  const { a, b } = INSIDE_DISK;
  let s = galaxy({ home: a });
  assert.ok(laneOf(s, 'g1').map(keyOf).includes(keyOf(centreOf(a))));
  s = accept(s, createFoundGuildAction({ guildId: 'g3', name: 'Next Door', isBot: true, credits: 0, homeSystemId: b }));
  assert.ok(!laneOf(s, 'g1').map(keyOf).includes(keyOf(centreOf(a))), 'g1\'s centre is inside g3\'s disk now');
  assert.ok(!laneOf(s, 'g3').map(keyOf).includes(keyOf(centreOf(b))), 'and g3\'s own centre is inside g1\'s disk');
  assert.deepEqual(laneOf(s, 'g1'), attachedByRule(s, 'g1'));
  assert.deepEqual(laneOf(s, 'g3'), attachedByRule(s, 'g3'));
}));

// --- 7. no-op + determinism ---------------------------------------------------------------------------------

// Recorded on main at 8795070 — BEFORE this slice — by running this file's `galaxy()` (and the same galaxy with one
// array deployed by hand on the first free hex of home's ring, in hexesAt's scan order) and hashing its state
// (hashState) and its god's-eye lens (JSON.stringify(buildSnapshot(state))). No array stands on a centre in either.
const ON_MAIN = {
  bare: { state: 'a844d99281849245152c2cffb1876db803b8820c764f904b717972c76af29466', godsEye: '7976ec8ffb128fb1074c7515ddb575ddf2c2e800a3c50e71d97bd598193aaf5a' },
  ringArray: { state: '9b3739fe11391149a1f9dfd505354eb045304e6d26cb581eb3228e4dad927d68', godsEye: '6f96a2efa223a62f03d97d946f66feea89606a5eadc436050a08fee2a6f73186' },
};

// withoutHeldCentres(snapshot) -> the lens with each guild's held centres taken back out of its deepScan lane —
// the only bytes this slice should have moved. It refuses to be vacuous: every guild row holding a system must
// have had its centre in the lane to remove.
function withoutHeldCentres(snapshot, state) {
  const out = structuredClone(snapshot);
  for (const row of out.guilds) {
    const held = state.claims.filter((c) => c.ownerGuildId === row.id && c.landmarkKind === 'system').map((c) => keyOf(centreOf(c.landmarkId)));
    if (held.length === 0) continue;
    const lane = row.deployRange.deepScan;
    const before = lane.hexes.length;
    lane.hexes = lane.hexes.filter((h) => !held.includes(keyOf(h)));
    assert.equal(lane.hexes.length, before - held.length, `guild ${row.id}'s lane carried each of its held centres`);
  }
  return out;
}

test('NO-OP: with no array on a centre the STATE is byte-identical to main, and the lens differs ONLY by the centres the lanes gained', () => {
  const bare = galaxy();
  const ringHex = hexesAt(HOME_HEX, getClaimRadius(HOME.id) + 1).find(isFree);
  const placed = armed(galaxy(), 'g1', ringHex);
  const ringArray = accept(placed.s, deployAsset('g1', placed.craftId));
  for (const [name, s] of [['bare', bare], ['ringArray', ringArray]]) {
    assert.equal(hashState(s), ON_MAIN[name].state, `"${name}": a serialized byte moved`);
    // ⤳ 16-10-26 (the Prefecture / claims slice, engine PR 2): and through the control-map strip (tests/control-map-strip.js)
    // — every snapshot and view gained the public `controlMap` and nothing else moved, so the pins still stand.
    const lens = withoutControlMap(buildSnapshot(s));
    assert.notEqual(sha(JSON.stringify(lens)), ON_MAIN[name].godsEye, `"${name}": the lens should carry the new centres`);
    assert.equal(sha(JSON.stringify(withoutHeldCentres(lens, s))), ON_MAIN[name].godsEye, `"${name}": the lens moved by more than the centres`);
  }
});

// centreRun() -> grant → load → fly home → deploy on the centre, from scratch.
function centreRun() {
  const { s, craftId } = armed(galaxy({ fuelHoard: 100_000 }), 'g1', OUT_THERE);
  return tickToIdle(accept(s, dispatch('g1', craftId, [{ anchor: AT_HOME, action: DEPLOY_ARRAY }])));
}

test('DETERMINISM: two centre runs are byte-identical; save → restore is byte-identical', (t) => {
  const a = centreRun();
  assert.equal(hashState(centreRun()), hashState(a));
  assert.equal(sha(JSON.stringify(buildSnapshot(centreRun()))), sha(JSON.stringify(buildSnapshot(a))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-centre-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(a, dir);
  const restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
  assert.equal(hashState(restored), hashState(a));
  assert.deepEqual(restored.deepScanArrays, a.deepScanArrays);
});
