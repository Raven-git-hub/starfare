'use strict';

// deploy-range-deep-scan.test.js — the `deployRange.deepScan` lane (roadmap 2.5, slice 14b; docs/territory-model.md
// §5 "Painting the range (the snapshot contract)"; docs/exploration-model.md §5 "Deploy placement = attached").
//
// A Deep Scan Array is not placed within a radius: it goes on a hex "attached" to the guild's territory — one
// hex outside a held system's control disk, or beside one of its Outposts (sim/actions.js `attachedPlacement`).
// So the snapshot publishes the HEXES, on each guild row:
//
//     deployRange: { outpost?: { radius, anchors }, deepScan?: { hexes: [ { q, r } ] } }
//
// The snapshot finds them fast by asking the rule only about hexes near the guild's footprints. The danger is
// that this shortcut and the rule drift apart, so the main tripwire compares the lane to the rule asked about
// EVERY hex in the galaxy (attached-hexes-oracle.js). The tests:
//   1. the oracle really scans the whole galaxy;
//   2. EXACT — on a held system, with an Outpost, with an Outpost alone, and holding nothing (lane omitted);
//   3. a rival's territory never counts;
//   4. SORTED q then r, no duplicates, byte-identical across builds and insertion orders;
//   5. DERIVED, NOT STALE — an Outpost placed or removed shows in the very next snapshot;
//   6. PURE — no state moves, and the published list does not alias state;
//   7. THE PAINT AGREES WITH THE DEPLOY — every lane hex deploys an array; the hexes beside the lane do not;
//   8. GUIDANCE — occupancy is ignored (deployCheck refuses an occupied lane hex);
//   9. the per-guild view carries only the viewer's own lane;
//  10. a held system with no claimRadius HALTS the snapshot rather than publishing a lane that skipped it.
// The "is this the only snapshot change" proof is the strip in tests/deep-scan-lane-strip.js, used by the goldens.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { hashState } = require('../serialize.js');
const { hexDistance } = require('../transport.js');
const {
  getSystem, getClaimRadius, getStarterSystems, getTerranHomeworld, isHexInBounds, seedLandmarkAtHex, setSeed,
} = require('../seed.js');
const seed = require('../../data/seed.json');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const { latticeIsWhole, attachedByRule } = require('./attached-hexes-oracle.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createSpawnOutpostAction, createRemoveOutpostAction, createDeployAssetAction,
} = require('../actions.js');

const HOME = starterHomeAtDistance(6);   // a real starter system g1 holds
const HOME_HEX = getSystem(HOME.id).coords;
const TOUCHING = getClaimRadius(HOME.id) + 1;   // the ring just outside home's control disk
const RIVAL = getStarterSystems().map((s) => s.id).find((id) => hexDistance(getSystem(id).coords, HOME_HEX) > 20);

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

// galaxy({ g1Holds, g2Holds }) -> g1 and g2, each holding the systems listed (by default: g1 home, g2 the rival).
function galaxy({ g1Holds = [HOME.id], g2Holds = [RIVAL] } = {}) {
  return createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: RIVAL, homePlanetId: getTerranHomeworld(RIVAL) },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [...g1Holds.map((id) => claimOf('g1', id)), ...g2Holds.map((id) => claimOf('g2', id))],
  });
}

const rowOf = (snap, guildId) => snap.guilds.find((g) => g.id === guildId);
const laneOf = (state, guildId) => {
  const row = rowOf(buildSnapshot(state), guildId);
  return row.deployRange ? row.deployRange.deepScan : undefined;
};
const keyOf = (h) => `${h.q},${h.r}`;
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
// A free hex exactly `d` hexes from `from`, the first in a fixed scan order (so a regenerated seed carries this).
function freeHexAt(from, d) {
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      if (hexDistance({ q, r }, from) === d && isFree({ q, r })) return { q, r };
    }
  }
  throw new Error(`no free hex ${d} from ${JSON.stringify(from)} on this seed`);
}
const spawnOutpost = (s, guildId, anchorSystemId, coords) => accept(s, createSpawnOutpostAction({ guildId, anchorSystemId, coords }));

// --- 1. the oracle ------------------------------------------------------------------------------------

test('the oracle scans the whole galaxy: its lattice has exactly the seed\'s totalHexesInGalaxy hexes', () => {
  assert.equal(latticeIsWhole(), true, 'the brute-force box missed part of the galaxy, so the EXACT tests below would prove less than they say');
});

// --- 2. exact ------------------------------------------------------------------------------------------

test('EXACT on a held system: the lane is every hex the deploy rule accepts — asked of every hex in the galaxy', () => {
  const s = galaxy();
  const lane = laneOf(s, 'g1');
  assert.deepEqual(Object.keys(lane), ['hexes'], 'the lane is { hexes } and nothing else');
  assert.deepEqual(lane.hexes, attachedByRule(s, 'g1'));
  // Not vacuous: a held system's lane is the ring of free hexes just outside its control disk.
  assert.ok(lane.hexes.length > 0);
  assert.ok(lane.hexes.every((h) => hexDistance(h, HOME_HEX) === TOUCHING), 'today, every hex is on that ring');
  // The outpost lane beside it is unchanged by this slice.
  assert.deepEqual(rowOf(buildSnapshot(s), 'g1').deployRange.outpost.anchors, [HOME.id]);
});

test('EXACT with an Outpost: the hexes beside an owned Outpost join the lane, each once', () => {
  // An Outpost well clear of home's ring, and a second one ON the ring's edge, so their neighbours overlap
  // the ring's hexes (the dedupe case).
  const far = freeHexAt(HOME_HEX, TOUCHING + 4);
  const onEdge = freeHexAt(HOME_HEX, TOUCHING + 1);
  let s = spawnOutpost(galaxy(), 'g1', HOME.id, far);
  s = spawnOutpost(s, 'g1', HOME.id, onEdge);
  const lane = laneOf(s, 'g1');
  assert.deepEqual(lane.hexes, attachedByRule(s, 'g1'));
  const keys = lane.hexes.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, 'no hex is listed twice, even one near two footprints');
  const besideFar = lane.hexes.filter((h) => hexDistance(h, far) === 1);
  assert.ok(besideFar.length > 0, 'the far Outpost\'s neighbours are in the lane');
  assert.ok(lane.hexes.some((h) => hexDistance(h, onEdge) === 1 && hexDistance(h, HOME_HEX) === TOUCHING),
    'a hex beside the edge Outpost AND on the ring is there, once');
});

test('EXACT with an Outpost alone (no held system): the deepScan lane stands alone, with no outpost lane', () => {
  // An operator can place an Outpost for a guild that holds nothing (spawnOutpost places freely); the rule
  // then accepts the hexes beside it, so the lane is honest about them.
  const hex = freeHexAt(HOME_HEX, TOUCHING + 4);
  const s = spawnOutpost(galaxy({ g1Holds: [] }), 'g1', HOME.id, hex);
  const range = rowOf(buildSnapshot(s), 'g1').deployRange;
  assert.deepEqual(Object.keys(range), ['deepScan'], 'holding no system, it has no outpost lane');
  assert.deepEqual(range.deepScan.hexes, attachedByRule(s, 'g1'));
  assert.ok(range.deepScan.hexes.every((h) => hexDistance(h, hex) === 1));
});

test('EXACT holding nothing: no deepScan lane — and with no outpost lane either, no deployRange key at all', () => {
  const s = galaxy({ g1Holds: [] });
  assert.deepEqual(attachedByRule(s, 'g1'), [], 'the rule accepts nothing for a guild that holds nothing');
  assert.equal('deployRange' in rowOf(buildSnapshot(s), 'g1'), false);
  assert.ok(laneOf(s, 'g2'), 'while its neighbour, which holds a system, has one');
});

// --- 3. a rival's territory never counts ---------------------------------------------------------------

test('a rival\'s systems and Outposts add nothing to the guild\'s lane', () => {
  const alone = laneOf(galaxy({ g2Holds: [] }), 'g1');
  // g2 holds its own system, plus an Outpost right beside g1's ring.
  const s = spawnOutpost(galaxy(), 'g2', RIVAL, freeHexAt(HOME_HEX, TOUCHING + 1));
  assert.deepEqual(laneOf(s, 'g1'), alone, 'g1\'s lane is the same with or without g2');
  assert.deepEqual(laneOf(s, 'g1').hexes, attachedByRule(s, 'g1'));
  assert.deepEqual(laneOf(s, 'g2').hexes, attachedByRule(s, 'g2'));
});

// --- 4. sorted, deterministic --------------------------------------------------------------------------

test('SORTED by q then r, and byte-identical across builds and across claim insertion orders', () => {
  const second = getStarterSystems().map((x) => x.id).find((id) => id !== HOME.id && id !== RIVAL);
  const s = spawnOutpost(galaxy({ g1Holds: [second, HOME.id] }), 'g1', HOME.id, freeHexAt(HOME_HEX, TOUCHING + 4));
  const { hexes } = laneOf(s, 'g1');
  for (let i = 1; i < hexes.length; i += 1) {
    const [a, b] = [hexes[i - 1], hexes[i]];
    assert.ok(a.q < b.q || (a.q === b.q && a.r < b.r), `out of order (or a duplicate) at ${i}: ${keyOf(a)} then ${keyOf(b)}`);
  }
  assert.equal(JSON.stringify(buildSnapshot(s)), JSON.stringify(buildSnapshot(s)), 'same state, same bytes');
  const reordered = spawnOutpost(galaxy({ g1Holds: [HOME.id, second] }), 'g1', HOME.id, freeHexAt(HOME_HEX, TOUCHING + 4));
  assert.equal(JSON.stringify(laneOf(reordered, 'g1')), JSON.stringify(laneOf(s, 'g1')));
});

// --- 5. derived, not stale -----------------------------------------------------------------------------

test('DERIVED, NOT STALE: an Outpost placed or removed shows in the very next snapshot', () => {
  let s = galaxy();
  const before = laneOf(s, 'g1').hexes;
  s = spawnOutpost(s, 'g1', HOME.id, freeHexAt(HOME_HEX, TOUCHING + 4));
  const withOutpost = laneOf(s, 'g1').hexes;
  assert.ok(withOutpost.length > before.length, 'placing an Outpost adds the hexes beside it');
  assert.deepEqual(withOutpost, attachedByRule(s, 'g1'));
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: s.outposts[0].id }));
  assert.deepEqual(laneOf(s, 'g1').hexes, before, 'removing it takes them away again');
});

// --- 6. pure ---------------------------------------------------------------------------------------------

test('PURE: building the lane moves no state, and the published hexes do not alias it', () => {
  const s = spawnOutpost(galaxy(), 'g1', HOME.id, freeHexAt(HOME_HEX, TOUCHING + 4));
  const before = hashState(s);
  const first = buildSnapshot(s);
  assert.equal(hashState(s), before, 'building the snapshot changed no engine state');
  const lane = rowOf(first, 'g1').deployRange.deepScan;
  lane.hexes[0].q += 1000;   // a consumer scribbling on its copy
  lane.hexes.length = 0;
  assert.equal(hashState(s), before, 'the scribble did not reach state');
  assert.deepEqual(laneOf(s, 'g1').hexes, attachedByRule(s, 'g1'));
  assert.equal(s.outposts[0].coords.q, freeHexAt(HOME_HEX, TOUCHING + 4).q, 'an Outpost\'s coords were not handed out');
});

// --- 7. the paint agrees with the deploy -----------------------------------------------------------------

// verdictAt(state, hex) -> deployAsset's answer for g1's heavy, carrying an array kit, sitting on `hex`. The
// kit is granted and loaded at home and the heavy placed on the hex (kit-fixtures.js — the stand-in for a flight).
function verdictAt(state, hex) {
  let s = accept(state, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: { landmarkKind: 'system', landmarkId: HOME.id } }));
  const craftId = s.guilds[0].vehicles[s.guilds[0].vehicles.length - 1].id;
  s = placeCraft(kitAboard(s, 'g1', craftId, 'deepScan'), 'g1', craftId, hex);
  return validateAction(s, createDeployAssetAction({ guildId: 'g1', vehicleId: craftId }));
}

test('THE PAINT AGREES WITH THE DEPLOY: every lane hex deploys an array; the free hexes just inside and outside it do not', () => {
  const s = galaxy();
  const lane = laneOf(s, 'g1').hexes;
  for (const hex of lane) {
    const v = verdictAt(s, hex);
    assert.equal(v.valid, true, `lane hex ${keyOf(hex)} must deploy, got: ${v.reason}`);
  }
  const listed = new Set(lane.map(keyOf));
  for (const d of [TOUCHING - 1, TOUCHING + 1]) {
    const hex = freeHexAt(HOME_HEX, d);
    assert.equal(listed.has(keyOf(hex)), false);
    const v = verdictAt(s, hex);
    assert.equal(v.valid, false, `a hex ${d} from home is not in the lane, and must not deploy`);
    assert.match(v.reason, /touches no footprint guild "g1" holds/);
  }
});

// --- 8. guidance: occupancy is ignored ----------------------------------------------------------------

test('GUIDANCE: a structure on a lane hex leaves it in the lane — deployCheck is what refuses it, as occupied', () => {
  const ringHex = laneOf(galaxy(), 'g1').hexes[0];
  const s = spawnOutpost(galaxy(), 'g2', RIVAL, ringHex);   // a rival's Outpost, right on g1's ring
  assert.ok(laneOf(s, 'g1').hexes.some((h) => keyOf(h) === keyOf(ringHex)), 'still painted — the lane ignores occupancy');
  const v = verdictAt(s, ringHex);
  assert.equal(v.valid, false);
  assert.match(v.reason, /already occupied by outpost/);
});

// --- 9. the per-guild view -------------------------------------------------------------------------------

test('the per-guild view: the viewer\'s own row carries its lane, a rival\'s row carries none', () => {
  const s = galaxy();
  const view = buildSnapshot(s, 'g1');
  assert.deepEqual(rowOf(view, 'g1').deployRange.deepScan.hexes, attachedByRule(s, 'g1'));
  assert.equal('deployRange' in rowOf(view, 'g2'), false, 'a rival\'s territory shape is not in the view');
});

// --- 10. a broken seed halts ----------------------------------------------------------------------------

test('a held system with no claimRadius HALTS the snapshot, naming it — never a lane that quietly skipped it', () => {
  const broken = structuredClone(seed);
  delete broken.systems.find((x) => x.id === HOME.id).claimRadius;
  setSeed(broken);
  try {
    assert.throws(() => buildSnapshot(galaxy()), new RegExp(`holds system "${HOME.id}", whose seed row carries no whole-number claimRadius`));
  } finally {
    setSeed(null);   // back to the committed seed for every other test
  }
});
