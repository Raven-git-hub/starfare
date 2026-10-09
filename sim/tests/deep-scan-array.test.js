'use strict';

// deep-scan-array.test.js — roadmap 2.5 (b1): the Deep Scan Array as a deployable structure
// (docs/exploration-model.md §5 "Form" + "Deploy placement = attached"; docs/territory-model.md §5, the
// deploy pipeline it rides). No scanning — that is (b2). The tripwires:
//
//   1. VOCABULARY: 'deepScan' is a kit kind whose good is `deep_scan_array_kit` — off-market, a whole heavy
//      hold, and NOT dockyard-buildable; every kit kind has a deploy rule of its own.
//   2. ATTACHED: a bare hex exactly claimRadius + 1 from a held system's centre, or 1 from an owned
//      Outpost, deploys; every other hex is refused — the centre as 'not-bare-hex', a hex inside the disk
//      or further out as 'not-attached', and a rival's territory never counts. The anchor: a held system
//      first (lowest id), else the lowest-id owned Outpost's own anchor system.
//   3. ONE STRUCTURE PER HEX across both kinds, and the waypoint's kind must match the kit aboard.
//   4. ON ARRIVAL: a route ending in an array deploy plants it on the arrival tick; a route whose
//      attachment is lost in flight retreats, the kit aboard, flagged 'not-attached', with a notice; an
//      arrival that must retreat with no held system to retreat to HALTS.
//   5. INVARIANTS: a malformed array row fails loudly.
//   6. DETERMINISM (invariant 9): omit-when-empty (no array, no key — in state and in the god's-eye
//      lens); two runs identical; save → restore byte-identical, and the serial survives.
//   7. THE OUTPOST PATH IS BYTE-IDENTICAL to main before this slice — hashes recorded on a60d98e.
// The per-guild view (a rival's array hidden) is tested with the rest of the fog, in fog.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const {
  DEPLOYABLE_KITS, DEEP_SCAN_KIT, OUTPOST_KIT, isDeployableGood, isStockpileGood, kitGoodFor, kindForKit,
} = require('../resources.js');
const { PRICED_GOODS } = require('../prices.js');
const { volumeOf, ASSET_CARGO_VOLUME } = require('../fuel.js');
const { isKitAssetKind, isAssetKind } = require('../assets.js');
const { BUILDABLE_KINDS, assetBill } = require('../asset-recipes.js');
const { DEPLOY_FAILED_REASONS, DEPLOY_RETREAT_HEXES } = require('../outposts.js');
const { hexDistance } = require('../transport.js');
const {
  getSystem, getClaimRadius, getStarterSystems, getTerranHomeworld, isHexInBounds, seedLandmarkAtHex,
} = require('../seed.js');
const seed = require('../../data/seed.json');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft, assertKitsMoved } = require('./kit-fixtures.js');
const { outpostDeployScript } = require('./outpost-deploy-script.js');
const { withoutRecordSlots } = require('./slot-strip.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createGrantKitAction, createLoadKitAction, createUnloadKitAction,
  createDeployAssetAction, createDispatchRouteWithActionsAction, createDispatchVehicleAction,
  createSpawnOutpostAction, createRemoveOutpostAction,
} = require('../actions.js');

const HOME = starterHomeAtDistance(6); // a real starter system g1 holds
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;
const TOUCHING = getClaimRadius(HOME.id) + 1; // the ring of hexes touching home's footprint
const RIVAL = getStarterSystems().map((s) => s.id).find((id) => hexDistance(getSystem(id).coords, HOME_HEX) > 20);
const DEPLOY_ARRAY = { type: 'deploy', kind: 'deepScan' };

const sha = (text) => createHash('sha256').update(text).digest('hex');
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected refused');
  return reason;
};

// Hex geometry, derived from the seed (so a regen carries the tests): the six axial directions, a hex
// k steps along one, and the free (in-bounds, no seed landmark) hexes at an exact distance.
const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const along = (from, dir, k) => ({ q: from.q + k * dir.q, r: from.r + k * dir.r });
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
function freeDirection(from, ks) {
  const dir = DIRS.find((d) => ks.every((k) => isFree(along(from, d, k))));
  if (!dir) throw new Error(`no direction from ${JSON.stringify(from)} with free hexes at ${ks.join(', ')} on this seed`);
  return dir;
}
function hexesAround(from, maxD) {
  const out = [];
  for (let q = from.q - maxD; q <= from.q + maxD; q += 1) {
    for (let r = from.r - maxD; r <= from.r + maxD; r += 1) {
      if (hexDistance({ q, r }, from) <= maxD && isHexInBounds(q, r)) out.push({ q, r });
    }
  }
  return out;
}

const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});
// g2 — a rival holding its own starter far from g1's home.
const RIVAL_GUILD = { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: RIVAL, homePlanetId: getTerranHomeworld(RIVAL) };

// g1 HOLDS home and has one idle heavy there; g2 holds RIVAL. `extraClaims` adds systems g1 holds too.
function arrayState({ fuelHoard = 0, extraClaims = [], holdsHome = true } = {}) {
  const g1 = holdsHome
    ? { id: 'g1', credits: 0, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet }
    : { id: 'g1', credits: 0, fuelHoard };
  let s = createState({
    guilds: [g1, RIVAL_GUILD],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [...(holdsHome ? [claimOf('g1', HOME.id)] : []), claimOf('g2', RIVAL), ...extraClaims],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  return s;
}
const craftOf = (s) => s.guilds[0].vehicles[0];
const g1Of = (s) => s.guilds[0];
// The array kit, the asset-initiated way: granted at home and loaded onto the heavy there.
const withArrayKit = (s) => kitAboard(s, 'g1', craftOf(s).id, 'deepScan');
// …then PLACED on `location` — the stand-in for a flight (kit-fixtures.js); the real flights are below.
const arrayKitAt = (location, opts) => {
  const s = withArrayKit(arrayState(opts));
  return placeCraft(s, 'g1', craftOf(s).id, location);
};
const deploy = (s) => createDeployAssetAction({ guildId: 'g1', vehicleId: craftOf(s).id });
const dispatch = (s, waypoints) => createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: craftOf(s).id, waypoints });
const spawnOutpost = (s, guildId, anchorSystemId, coords) => accept(s, createSpawnOutpostAction({ guildId, anchorSystemId, coords }));
function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds[0].vehicles.every((v) => v.status === 'idle')) return s;
    s = tick(s, []);
  }
  throw new Error('a craft never landed');
}

// --- 1. vocabulary ----------------------------------------------------------------------------------

test('vocabulary: deepScan is a kit kind packing deep_scan_array_kit — off-market, a whole heavy hold, NOT buildable', () => {
  assert.equal(DEEP_SCAN_KIT, 'deep_scan_array_kit');
  assert.equal(kitGoodFor('deepScan'), DEEP_SCAN_KIT);
  assert.equal(kindForKit(DEEP_SCAN_KIT), 'deepScan');
  assert.deepEqual(DEPLOYABLE_KITS, { outpost: OUTPOST_KIT, deepScan: DEEP_SCAN_KIT });
  assert.equal(isDeployableGood(DEEP_SCAN_KIT), true);
  assert.equal(isStockpileGood(DEEP_SCAN_KIT), false, 'never a stockpile key, so never in supply');
  assert.equal(PRICED_GOODS.includes(DEEP_SCAN_KIT), false, 'never priced');
  assert.equal(volumeOf(DEEP_SCAN_KIT), ASSET_CARGO_VOLUME, 'a whole heavy hold, like the outpost kit');
  assert.equal(isKitAssetKind('deepScan'), true);
  assert.equal(isAssetKind('deepScan'), false, 'so no venture can ever name an array kit');
  // NO dockyard build path this slice (asset-recipes.js: the installation bills are data only).
  for (const kind of ['deepScan', 'deep_scan_array']) assert.equal(BUILDABLE_KINDS.includes(kind), false, kind);
  assert.equal(assetBill('deep_scan_array'), null);
});

test('every kit kind has a deploy rule of its own — none throws, and each judges placement its own way', () => {
  // A bare hex 3 from home: within an Outpost's range, but NOT touching home's footprint (that ring is 2).
  const hex = along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING + 1]), TOUCHING + 1);
  const answers = {};
  for (const kind of Object.keys(DEPLOYABLE_KITS)) {
    let s = kitAboard(arrayState(), 'g1', craftOf(arrayState()).id, kind);
    s = placeCraft(s, 'g1', craftOf(s).id, hex);
    answers[kind] = validateAction(s, deploy(s)); // a kind with no rule would THROW here
  }
  assert.deepEqual(answers.outpost, { valid: true });
  assert.equal(answers.deepScan.valid, false);
  assert.match(answers.deepScan.reason, /touches no footprint guild "g1" holds — a Deep Scan Array deploys attached/);
});

test('seed: every system carries a whole-number claimRadius — the footprint the attached rule measures', () => {
  for (const sys of seed.systems) assert.ok(getClaimRadius(sys.id) !== null, `${sys.id} has no claimRadius`);
  assert.equal(getClaimRadius('sys_nope'), null);
  assert.equal('claimRadius' in getSystem(HOME.id), false, 'the claim-row landmark is unwidened (snapshot bytes)');
});

// --- 2. attached ------------------------------------------------------------------------------------

test('ATTACHED to a held system: an array kit on a bare hex claimRadius + 1 from home deploys', () => {
  const hex = along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING]), TOUCHING);
  const before = arrayKitAt(hex);
  const supplyBefore = JSON.stringify(computeGalacticSupply(before));
  const after = accept(before, deploy(before));
  assertKitsMoved(before, after, 'g1', -1, 'the array deploy');

  assert.deepEqual(after.deepScanArrays, [{
    id: 'deepScanArray_g1_01', ownerGuildId: 'g1', coords: hex, anchorSystemId: HOME.id, createdAtTick: after.tick,
  }]);
  assert.equal(g1Of(after).deepScanArraySerial, 1);
  assert.equal(craftOf(after).cargo, undefined, 'the kit was the whole hold, and it is consumed');
  assert.deepEqual(craftOf(after).location, hex, 'the craft idles on the array\'s hex');
  assert.equal(craftOf(after).updatedAtTick, after.tick);
  assert.equal(after.outposts, undefined, 'an array is not an Outpost');
  // Nothing else moves: no credits, fuel or supply, and no claim row.
  assert.equal(g1Of(after).credits, g1Of(before).credits);
  assert.equal(g1Of(after).fuelHoard, g1Of(before).fuelHoard);
  assert.equal(JSON.stringify(computeGalacticSupply(after)), supplyBefore);
  assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('ATTACHED, swept: around home, ONLY the bare claimRadius + 1 ring deploys; the centre, the disk and beyond refuse', () => {
  const base = withArrayKit(arrayState());
  let ring = 0;
  for (const hex of hexesAround(HOME_HEX, TOUCHING + 2)) {
    const s = placeCraft(JSON.parse(JSON.stringify(base)), 'g1', craftOf(base).id, hex);
    const d = hexDistance(hex, HOME_HEX);
    const { valid, reason } = validateAction(s, deploy(s));
    const where = `hex ${JSON.stringify(hex)}, ${d} from home`;
    if (d === 0) {
      // INSIDE, the centre: placing the craft "at" the system's hex as a bare hex — the hex is the system's,
      // so 'occupied' (a craft truly AT home is berthed at the landmark: 'not-bare-hex', the next test).
      assert.match(reason, /already occupied by system/, where);
    } else if (seedLandmarkAtHex(hex.q, hex.r)) {
      assert.match(reason, /already occupied by/, where);
    } else if (d === TOUCHING) {
      assert.equal(valid, true, `${where}: ${reason}`);
      ring += 1;
    } else {
      // INSIDE the disk (d ≤ claimRadius) or beyond the ring: refused by the attached rule itself.
      assert.match(reason, /touches no footprint guild "g1" holds/, where);
    }
  }
  assert.ok(ring >= 6, 'the ring has bare hexes to deploy on');
});

test('NOT ATTACHED: two hexes outside the footprint, inside it, at the system, or touching only RIVAL ground', () => {
  const dir = freeDirection(HOME_HEX, [1, TOUCHING + 1]);
  // Two hexes outside the footprint (one beyond the touching ring) — the attached rule refuses.
  const far = arrayKitAt(along(HOME_HEX, dir, TOUCHING + 1));
  assert.match(refuse(far, deploy(far)), /touches no footprint guild "g1" holds — a Deep Scan Array deploys attached to its guild's territory/);
  // Inside the footprint, on a bare hex of the disk — refused by the attached rule (it is IN the
  // footprint, not touching it), NOT by an existing check: the hex is bare and free.
  const inside = arrayKitAt(along(HOME_HEX, dir, 1));
  assert.match(refuse(inside, deploy(inside)), /touches no footprint guild "g1" holds/);
  // At the system itself — berthed at the landmark: the existing 'not-bare-hex' check, naming the array.
  const atHome = withArrayKit(arrayState());
  assert.match(refuse(atHome, deploy(atHome)), /berthed at a landmark .* — a Deep Scan Array deploys on a bare hex/);
  // Rival ground never counts: the ring around g2's system, and the hex beside g2's Outpost.
  const rivalHex = getSystem(RIVAL).coords;
  const besideRival = arrayKitAt(along(rivalHex, freeDirection(rivalHex, [TOUCHING]), TOUCHING));
  assert.match(refuse(besideRival, deploy(besideRival)), /touches no footprint guild "g1" holds/);
  const rDir = freeDirection(rivalHex, [5, 6]);
  let nearRivalOutpost = arrayKitAt(along(rivalHex, rDir, 6));
  nearRivalOutpost = spawnOutpost(nearRivalOutpost, 'g2', RIVAL, along(rivalHex, rDir, 5));
  assert.match(refuse(nearRivalOutpost, deploy(nearRivalOutpost)), /touches no footprint guild "g1" holds/);
});

test('ATTACHED to an owned Outpost: a hex beside it deploys, and the array takes THAT Outpost\'s anchor system', () => {
  // An Outpost of g1's well out from home, anchored (operator lever) to RIVAL's system id — any real
  // system — so the anchor the array inherits is unmistakably the Outpost's, not home.
  const dir = freeDirection(HOME_HEX, [8, 9]);
  const outpostHex = along(HOME_HEX, dir, 8);
  const besideOutpost = along(HOME_HEX, dir, 9);
  let s = arrayKitAt(besideOutpost);
  assert.match(refuse(s, deploy(s)), /touches no footprint/, 'nothing to attach to yet');
  s = spawnOutpost(s, 'g1', RIVAL, outpostHex);
  s = accept(s, deploy(s));
  assert.equal(s.deepScanArrays[0].anchorSystemId, RIVAL);
  assert.deepEqual(s.deepScanArrays[0].coords, besideOutpost);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('ANCHOR: a held system beats an Outpost; two systems → the lower id; two Outposts → the lower Outpost id', () => {
  // (a) Touching home's ring AND beside an Outpost anchored elsewhere → home.
  const dir = freeDirection(HOME_HEX, [TOUCHING, TOUCHING + 1]);
  let s = arrayKitAt(along(HOME_HEX, dir, TOUCHING));
  s = spawnOutpost(s, 'g1', RIVAL, along(HOME_HEX, dir, TOUCHING + 1));
  s = accept(s, deploy(s));
  assert.equal(s.deepScanArrays[0].anchorSystemId, HOME.id, 'a held system first');

  // (b) Two held systems whose touching rings meet on a free hex → the lower id.
  let pair = null;
  for (const a of seed.systems) {
    for (const b of seed.systems) {
      if (a.id >= b.id || hexDistance(a.coords, b.coords) > 2 * TOUCHING) continue;
      const hex = hexesAround(a.coords, TOUCHING).find((h) => isFree(h)
        && hexDistance(h, a.coords) === getClaimRadius(a.id) + 1 && hexDistance(h, b.coords) === getClaimRadius(b.id) + 1);
      if (hex) { pair = { a: a.id, b: b.id, hex }; break; }
    }
    if (pair) break;
  }
  assert.ok(pair, 'the seed has two systems whose touching rings meet');
  s = arrayKitAt(pair.hex, { extraClaims: [claimOf('g1', pair.b), claimOf('g1', pair.a)] });
  s = accept(s, deploy(s));
  assert.equal(s.deepScanArrays[0].anchorSystemId, pair.a, `the lower of ${pair.a} / ${pair.b}`);

  // (c) Two owned Outposts beside one hex, far from home: the LOWER OUTPOST ID wins — even though it is
  //     anchored to the HIGHER system id — and the array takes its anchor.
  const d2 = freeDirection(HOME_HEX, [9]);
  const target = along(HOME_HEX, d2, 9);
  const [n1, n2] = DIRS.map((d) => along(target, d, 1)).filter(isFree)
    .filter((h) => hexDistance(h, HOME_HEX) > TOUCHING + 1);
  const [lowSys, highSys] = [HOME.id, RIVAL].sort();
  s = arrayKitAt(target);
  s = spawnOutpost(s, 'g1', highSys, n1); // outpost_g1_01
  s = spawnOutpost(s, 'g1', lowSys, n2);  // outpost_g1_02
  s = accept(s, deploy(s));
  assert.equal(s.deepScanArrays[0].anchorSystemId, highSys, 'outpost_g1_01\'s anchor');
});

// --- 3. one structure per hex; the kind must match ----------------------------------------------------

test('ONE STRUCTURE PER HEX spans both kinds — no array on an Outpost, no Outpost on an array, no two arrays', () => {
  const dir = freeDirection(HOME_HEX, [TOUCHING]);
  const hex = along(HOME_HEX, dir, TOUCHING);
  // An array onto an Outpost's hex.
  let s = spawnOutpost(arrayKitAt(hex), 'g1', HOME.id, hex);
  assert.match(refuse(s, deploy(s)), /already occupied by outpost "outpost_g1_01" — one structure per hex/);
  // An array placed; then an Outpost kit onto its hex, and the operator's spawnOutpost onto it.
  s = arrayKitAt(hex);
  s = accept(s, deploy(s));
  const withOutpostKit = placeCraft(kitAboard(placeCraft(s, 'g1', craftOf(s).id, AT_HOME), 'g1', craftOf(s).id), 'g1', craftOf(s).id, hex);
  assert.match(refuse(withOutpostKit, deploy(withOutpostKit)), /already occupied by deepScanArray "deepScanArray_g1_01"/);
  assert.match(refuse(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: hex })), /deepScanArray/);
  // A second array onto the first's hex.
  const second = placeCraft(withArrayKit(placeCraft(s, 'g1', craftOf(s).id, AT_HOME)), 'g1', craftOf(s).id, hex);
  assert.match(refuse(second, deploy(second)), /already occupied by deepScanArray "deepScanArray_g1_01"/);
});

test('THE KIND MUST MATCH: a deploy waypoint naming the other kind is refused up front, either way round', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING]), TOUCHING);
  const arrayKit = withArrayKit(arrayState({ fuelHoard: 10_000 }));
  assert.match(refuse(arrayKit, dispatch(arrayKit, [{ anchor: target, action: { type: 'deploy', kind: 'outpost' } }])),
    /would fail now — .*must carry exactly one outpost_kit and nothing else to deploy — its hold is \{"deep_scan_array_kit":1\}/);
  const outpostKit = kitAboard(arrayState({ fuelHoard: 10_000 }), 'g1', craftOf(arrayState()).id);
  assert.match(refuse(outpostKit, dispatch(outpostKit, [{ anchor: target, action: DEPLOY_ARRAY }])),
    /would fail now — .*must carry exactly one deep_scan_array_kit and nothing else to deploy — its hold is \{"outpost_kit":1\}/);
  assert.match(refuse(arrayKit, dispatch(arrayKit, [{ anchor: AT_HOME, action: DEPLOY_ARRAY }])),
    /the deploy waypoint 0 is a landmark .* — a Deep Scan Array deploys on a bare hex/);
});

// --- 4. on arrival ----------------------------------------------------------------------------------

test('ON ARRIVAL: a route ending in an array deploy plants it on the arrival tick; a doomed one is never fuelled', () => {
  const dir = freeDirection(HOME_HEX, [TOUCHING, TOUCHING + 1]);
  const s0 = withArrayKit(arrayState({ fuelHoard: 10_000 }));
  // Doomed: one hex past the ring. Refused whole, up front — no fuel burns.
  const reason = refuse(s0, dispatch(s0, [{ anchor: along(HOME_HEX, dir, TOUCHING + 1), action: DEPLOY_ARRAY }]));
  assert.match(reason, /the deploy at waypoint 0 would fail now — .*touches no footprint/);
  // Attached: flies, and deploys the moment it lands.
  const target = along(HOME_HEX, dir, TOUCHING);
  const flying = accept(s0, dispatch(s0, [{ anchor: target, action: DEPLOY_ARRAY }]));
  const arrivalTick = craftOf(flying).trip.arrivalTick;
  assert.ok(g1Of(flying).fuelHoard < 10_000, 'the real trip is fuelled');
  const s = tickToIdle(flying);
  assert.equal(s.deepScanArrays.length, 1);
  assert.deepEqual(s.deepScanArrays[0], {
    id: 'deepScanArray_g1_01', ownerGuildId: 'g1', coords: target, anchorSystemId: HOME.id, createdAtTick: arrivalTick,
  });
  assert.equal(craftOf(s).cargo, undefined);
  assert.equal(craftOf(s).route, undefined, 'the one-shot run ended');
  assert.deepEqual(craftOf(s).location, target);
  assert.equal(craftOf(s).deployFailed, undefined);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('ON ARRIVAL, attachment LOST in flight: the Outpost it touched is gone → retreat, kit aboard, not-attached, notice', () => {
  assert.ok(DEPLOY_FAILED_REASONS.includes('not-attached'));
  const dir = freeDirection(HOME_HEX, [7, 8]);
  const outpostHex = along(HOME_HEX, dir, 7);
  const target = along(HOME_HEX, dir, 8);
  let s = withArrayKit(arrayState({ fuelHoard: 10_000 }));
  s = spawnOutpost(s, 'g1', HOME.id, outpostHex);
  s = accept(s, dispatch(s, [{ anchor: target, action: DEPLOY_ARRAY }])); // attached NOW, via the Outpost
  const arrivalTick = craftOf(s).trip.arrivalTick;
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' })); // …then gone
  s = tickToIdle(s);

  assert.equal(s.deepScanArrays, undefined, 'nothing was placed');
  assert.deepEqual(craftOf(s).cargo, { [DEEP_SCAN_KIT]: 1 }, 'the kit is still aboard');
  assert.deepEqual(craftOf(s).deployFailed, { reason: 'not-attached', tick: arrivalTick });
  // The existing retreat rule, unchanged: DEPLOY_RETREAT_HEXES straight back toward home.
  assert.deepEqual(craftOf(s).location, along(HOME_HEX, dir, 8 - DEPLOY_RETREAT_HEXES));
  const notice = g1Of(s).events.find((e) => e.type === 'deploy_failed');
  assert.equal(notice.tick, arrivalTick);
  assert.deepEqual(
    { cause: notice.payload.cause, kind: notice.payload.kind, targetHex: notice.payload.targetHex, retreatSystemId: notice.payload.retreatSystemId },
    { cause: 'not-attached', kind: 'deepScan', targetHex: target, retreatSystemId: HOME.id },
  );
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('HALT: an array arrival that must retreat, by a guild holding no system to retreat toward, throws with the tick', () => {
  // A guild that holds NO system (the shape deploy-asset.test.js uses) but owns an Outpost: the array
  // attaches to the Outpost alone; the Outpost goes in flight; the retreat has nowhere to go. A guild
  // never loses its home system, so this state is corrupt — and the arrival must say so, not guess.
  const dir = freeDirection(HOME_HEX, [4, 5]);
  let s = withArrayKit(arrayState({ fuelHoard: 10_000, holdsHome: false }));
  s = spawnOutpost(s, 'g1', HOME.id, along(HOME_HEX, dir, 4));
  s = accept(s, dispatch(s, [{ anchor: along(HOME_HEX, dir, 5), action: DEPLOY_ARRAY }]));
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.throws(() => tickToIdle(s), /deploy on arrival, tick \d+: .*"not-attached" check and must retreat, but its guild holds no system to retreat toward/);
});

test('the kit lifecycle is kind-general: grant +1, load 0, deploy −1; an array kit unloads back into inventory', () => {
  let s = arrayState();
  const g = accept(s, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'deepScan' }));
  assertKitsMoved(s, g, 'g1', +1, 'the grant');
  assert.deepEqual(g1Of(g).assets, [{ id: 'asset_g1_deepScan_01', kind: 'deepScan', systemId: HOME.id, maintenanceCondition: 1 }]);
  const l = accept(g, createLoadKitAction({ guildId: 'g1', vehicleId: craftOf(g).id, assetId: 'asset_g1_deepScan_01' }));
  assertKitsMoved(g, l, 'g1', 0, 'the load');
  assert.deepEqual(craftOf(l).cargo, { [DEEP_SCAN_KIT]: 1 });
  const u = accept(l, createUnloadKitAction({ guildId: 'g1', vehicleId: craftOf(l).id }));
  assertKitsMoved(l, u, 'g1', 0, 'the unload');
  assert.deepEqual(g1Of(u).assets.map((a) => [a.id, a.kind]), [['asset_g1_deepScan_02', 'deepScan']], 'a fresh id from the one kit serial');
  s = placeCraft(accept(u, createLoadKitAction({ guildId: 'g1', vehicleId: craftOf(u).id, assetId: 'asset_g1_deepScan_02' })),
    'g1', craftOf(u).id, along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING]), TOUCHING));
  assertKitsMoved(s, accept(s, deploy(s)), 'g1', -1, 'the deploy');
});

// --- 5. invariants ----------------------------------------------------------------------------------

test('INVARIANTS: a malformed array row, list or serial fails loudly', () => {
  const hex = along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING]), TOUCHING);
  let s = arrayKitAt(hex);
  s = accept(s, deploy(s));
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const rules = (mutate) => {
    const bad = JSON.parse(JSON.stringify(s));
    mutate(bad);
    return checkInvariants(bad, bad.tick).map((v) => v.rule);
  };
  const row = (b) => b.deepScanArrays[0];
  assert.ok(rules((b) => { b.deepScanArrays = []; }).includes('deepScanArrays-is-a-non-empty-array (omit-when-empty)'));
  assert.ok(rules((b) => { row(b).ownerGuildId = 'nobody'; }).includes('deepScanArray-owner-exists'));
  assert.ok(rules((b) => { row(b).ownerGuildId = 'g2'; }).includes('deepScanArray-id-names-its-owner (deep-scan-arrays.js)'));
  assert.ok(rules((b) => { row(b).anchorSystemId = 'sys_nope'; }).includes('deepScanArray-anchor-is-a-system (seed.js)'));
  assert.ok(rules((b) => { row(b).createdAtTick = b.tick + 1; }).includes('deepScanArray-createdAtTick-is-a-past-tick (§15.2)'));
  assert.ok(rules((b) => { row(b).createdAtTick = 1.5; }).includes('deepScanArray-createdAtTick-is-a-past-tick (§15.2)'));
  assert.ok(rules((b) => { row(b).coords = { q: 99999, r: 0 }; }).includes('deepScanArray-coords-in-bounds (seed.js)'));
  assert.ok(rules((b) => { row(b).coords = { ...HOME_HEX }; }).includes('deepScanArray-hex-unoccupied-by-seed (§4)'));
  assert.ok(rules((b) => { b.outposts = [{ id: 'outpost_g1_01', ownerGuildId: 'g1', coords: { ...hex }, anchorSystemId: HOME.id, capacity: 0, dockCapacity: 0, createdAtTick: 0 }]; b.guilds[0].outpostSerial = 1; })
    .includes('deepScanArray-hex-unoccupied-by-outpost (§4)'));
  assert.ok(rules((b) => { b.deepScanArrays.push({ ...row(b), id: 'deepScanArray_g1_02' }); b.guilds[0].deepScanArraySerial = 2; })
    .includes('deepScanArray-hex-unique (§4)'));
  assert.ok(rules((b) => { b.deepScanArrays.push({ ...row(b) }); }).includes('deepScanArray-id-unique'));
  assert.ok(rules((b) => { delete b.guilds[0].deepScanArraySerial; }).includes('deepScanArray-serial-monotonic'));
});

// --- 6. determinism ---------------------------------------------------------------------------------

// grant → load → dispatch → arrive → deploy, from scratch.
function arrayRun() {
  let s = withArrayKit(arrayState({ fuelHoard: 10_000 }));
  s = accept(s, dispatch(s, [{ anchor: along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING]), TOUCHING), action: DEPLOY_ARRAY }]));
  return tickToIdle(s);
}

test('OMIT-WHEN-EMPTY: no array → no key, in state and in the god\'s-eye lens; createState copies a handed-in list', () => {
  const none = withArrayKit(arrayState());
  assert.equal('deepScanArrays' in none, false);
  assert.equal('deepScanArrays' in buildSnapshot(none), false);
  assert.equal('deepScanArraySerial' in g1Of(none), false);
  const s = arrayRun();
  assert.deepEqual(buildSnapshot(s).deepScanArrays, [{ id: 'deepScanArray_g1_01', ownerGuildId: 'g1', coords: s.deepScanArrays[0].coords, anchorSystemId: HOME.id }]);
  const handed = s.deepScanArrays;
  const rebuilt = createState({ guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, deepScanArraySerial: 1 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, deepScanArrays: handed });
  assert.deepEqual(rebuilt.deepScanArrays, handed);
  assert.notEqual(rebuilt.deepScanArrays[0].coords, handed[0].coords, 'deep-copied, never aliased');
  assert.equal(rebuilt.guilds[0].deepScanArraySerial, 1);
  assert.equal('deepScanArrays' in createState({ guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, deepScanArrays: [] }), false);
});

test('DETERMINISM: two runs are byte-identical; save → restore is byte-identical and the serial survives', (t) => {
  const a = arrayRun();
  assert.equal(hashState(arrayRun()), hashState(a));
  assert.equal(sha(JSON.stringify(buildSnapshot(arrayRun()))), sha(JSON.stringify(buildSnapshot(a))));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-dsa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(a, dir);
  const restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
  assert.equal(hashState(restored), hashState(a));
  // The next array mints _02 on the restored state too — the stored serial survived.
  const next = placeCraft(withArrayKit(placeCraft(restored, 'g1', craftOf(restored).id, AT_HOME)), 'g1', craftOf(restored).id,
    along(HOME_HEX, DIRS.find((d) => isFree(along(HOME_HEX, d, TOUCHING)) && hexDistance(along(HOME_HEX, d, TOUCHING), a.deepScanArrays[0].coords) > 0), TOUCHING));
  assert.equal(accept(next, deploy(next)).deepScanArrays[1].id, 'deepScanArray_g1_02');

  // Journalled grant + load + manual deploy against a saved state replay to the same bytes.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-dsa-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  let s = arrayState();
  saveState(s, dir2);
  const ring = along(HOME_HEX, freeDirection(HOME_HEX, [TOUCHING]), TOUCHING);
  for (const action of [
    createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'deepScan' }),
    createLoadKitAction({ guildId: 'g1', vehicleId: craftOf(s).id, assetId: 'asset_g1_deepScan_01' }),
  ]) { s = accept(s, action); appendJournal(s.tick, action, dir2); }
  const replayed = loadOrInit(dir2, () => { throw new Error('should restore'); });
  assert.equal(hashState(replayed), hashState(s));
  const placedA = placeCraft(s, 'g1', craftOf(s).id, ring);
  const placedB = placeCraft(replayed, 'g1', craftOf(replayed).id, ring);
  assert.equal(hashState(accept(placedB, deploy(placedB))), hashState(accept(placedA, deploy(placedA))));
});

// --- 7. the outpost path, byte-identical to main --------------------------------------------------------

// Recorded on main at a60d98e — BEFORE this slice's code existed — by copying tests/outpost-deploy-script.js
// into a checkout of that commit and hashing each step's state (hashState) and god's-eye lens
// (JSON.stringify(buildSnapshot(state))), and the JSON of every refusal the outpost rule gave. The script
// drives the outpost deploy end to end: the manual deploy, the on-arrival deploy, the on-arrival failure
// and retreat, and the range / landmark / occupied refusals of both triggers. If one of these moves, the
// generalisation changed the outpost path: find out why before re-pinning.
const OUTPOST_PATH_ON_MAIN = {
  manualDeploy: { state: 'd2312910ea5b53917a09b32670fd2ffdcb6a80877cbc73ac195075bcd9aad00e', godsEye: '477796de578938cd31319b05340dcb1956b946bf15720c0d0763c78416cd8ec4' },
  arrivalDeploy: { state: '6ad198ad0ab410f886895a3b7ad64b2d3fdc8359ad316707494e039b413eaa13', godsEye: '30b5cc916626c41dbaef7eed3b2b7d6c468ba54dc112f2c744a504218545c494' },
  arrivalRetreat: { state: 'c8896430255af5bc6ffb6b477a06b9d44918a488e477992cd40657dc582518f5', godsEye: '8e5a2dca89e214555deadc25e7ad3f0afa4e4e6ff5c3126c1771968e079ea563' },
  reasons: '73debece18be90a63c6876e2b67908ee3de8c72b86fce6f20b4a744cc4dd2df8',
};
// ⤳ 09-10-26 (roadmap 2.5, the settlement-surface engine slice): founding now records the home system's
// settlement slots too, and every record entry carries a `slots` map, so the three STATE hashes moved. The
// a60d98e state pins above are KEPT and asserted with the slots stripped (tests/slot-strip.js) — the proof
// that the slots are the only thing that moved; the full states are re-pinned here. The god's-eye pins and
// the refusals did not move (the lens carries no record).
const OUTPOST_PATH_STATE_WITH_SLOTS = {
  manualDeploy: 'ec4d7bb5f0907c0723096b299005157f5458933d5eff7b6d33dfe5bf05250838',
  arrivalDeploy: '780bd5b0b6bd36de7d53e6ff54cbbd3bdaf7d828069cd2eff99a0f76cad33514',
  arrivalRetreat: '14abae29093c152036bd39da69be8a3cbcd53dc7ca4a4b41ff566922b5b09ef3',
};

test('THE OUTPOST PATH IS BYTE-IDENTICAL to main before the array: same placements, anchors, retreat and refusals', () => {
  const { steps, reasons } = outpostDeployScript();
  for (const name of ['manualDeploy', 'arrivalDeploy', 'arrivalRetreat']) {
    assert.equal(hashState(steps[name]), OUTPOST_PATH_STATE_WITH_SLOTS[name], `the state moved at "${name}"`);
    const { state: noSlots, count } = withoutRecordSlots(steps[name]);
    assert.ok(count > 0, 'the founding really recorded settlement slots, so the strip proves something');
    assert.equal(hashState(noSlots), OUTPOST_PATH_ON_MAIN[name].state, `"${name}" moved outside the record's slots`);
    assert.equal(sha(JSON.stringify(buildSnapshot(steps[name]))), OUTPOST_PATH_ON_MAIN[name].godsEye, `the god's-eye lens moved at "${name}"`);
  }
  assert.equal(sha(JSON.stringify(reasons)), OUTPOST_PATH_ON_MAIN.reasons, 'an outpost refusal moved');
  // The script really did exercise each branch, so the hashes are guarding something.
  const { arrivalRetreat: r } = steps;
  assert.deepEqual(r.outposts.map((o) => o.id), ['outpost_player-guild_01', 'outpost_player-guild_02', 'outpost_player-guild_03']);
  assert.equal(r.guilds[0].vehicles[0].deployFailed.reason, 'occupied');
  assert.equal('deepScanArrays' in r, false);
  assert.deepEqual(Object.values(reasons).map((x) => x.valid), [false, false, true, false, false, false, true, false]);
});
