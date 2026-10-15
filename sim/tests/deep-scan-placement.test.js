'use strict';

// deep-scan-placement.test.js — roadmap 2.5 slice 15: the Deep Scan Array's placement, REVISED 15-10-26
// (docs/exploration-model.md §5 "Deploy placement"; sim/actions.js `attachedPlacement`, which asks the one
// control helper, sim/claims.js `controlNear`). An array may go INSIDE the guild's own control, or on open space
// sharing an edge with it, and NEVER inside a rival's control. One test per failure mode the slice named:
//
//   1. INSIDE THE OWN DISK: every bare hex 1 ≤ d ≤ claimRadius deploys, anchored to the system; the centre is
//      still 'not-bare-hex', and a disk hex holding the guild's own Outpost or array is still 'occupied'.
//   2. BETWEEN TWO GUILDS: a hex one ring outside BOTH disks is nobody's and touches both — legal for both; a hex
//      on A's ring but inside B's disk is refused for A as 'rival-territory'; a hex inside BOTH disks is refused
//      for both (the seniority rule that would split an overlap is not built).
//   3. A RIVAL'S OUTPOST beside A's territory: refused 'occupied' — the one-structure check runs before the
//      placement check (order unchanged), though the placement alone says 'rival-territory'.
//   4. ARRIVAL: an array kit in flight whose target becomes a rival's control (a rival guild founds on the system
//      whose disk covers it) fails on arrival — 'rival-territory', retreat, kit aboard, the notice. A rival
//      Outpost planted ON the target reads 'occupied' instead.
//   5. NOT RETROACTIVE: a standing array whose hex later falls inside a rival's control stays, and every
//      invariant holds, tick after tick.
//   6. THE LANE equals the independent oracle over the whole galaxy, for both guilds, and holds no hex inside a
//      rival's disk.
//   7. controlNear itself: who controls a hex, in which order, and a broken seed halts.
// "A rival's array is never in a guild's view" is pinned with the rest of the fog: fog.test.js, "rival DEEP-SCAN
// ARRAYS are in the view NOWHERE" and "a rival's array deploy moves NOT ONE BYTE of the viewer's view".

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { controlNear } = require('../claims.js');
const { DEEP_SCAN_KIT } = require('../resources.js');
const { DEPLOY_FAILED_REASONS } = require('../outposts.js');
const { hexDistance } = require('../transport.js');
const {
  getSystem, getClaimRadius, getStarterSystems, getTerranHomeworld, isHexInBounds, seedLandmarkAtHex, setSeed,
} = require('../seed.js');
const seed = require('../../data/seed.json');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const { attachedByRule } = require('./attached-hexes-oracle.js');
const {
  validateAction, applyAction, attachedPlacement,
  createSpawnVehicleAction, createSpawnOutpostAction, createDeployAssetAction,
  createDispatchRouteWithActionsAction, createFoundGuildAction,
} = require('../actions.js');

const HOME = starterHomeAtDistance(6);   // a real starter system g1 holds
const HOME_HEX = getSystem(HOME.id).coords;
const RIVAL = getStarterSystems().map((s) => s.id).find((id) => hexDistance(getSystem(id).coords, HOME_HEX) > 20);
const DEPLOY_ARRAY = { type: 'deploy', kind: 'deepScan' };

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});
const keyOf = (h) => `${h.q},${h.r}`;
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
const radiusOf = (systemId) => getClaimRadius(systemId);
const centreOf = (systemId) => getSystem(systemId).coords;

// hexesAt(from, d) -> every hex exactly `d` from `from`, in a fixed scan order (so a regenerated seed carries this).
function hexesAt(from, d) {
  const out = [];
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      if (hexDistance({ q, r }, from) === d) out.push({ q, r });
    }
  }
  return out;
}

// galaxy({ g1Extra, g2Extra, fuelHoard }) -> g1 at HOME and g2 at RIVAL, each holding its home plus the extra
// systems listed. The homes are real starter systems, so the guild-home invariant holds.
function galaxy({ g1Extra = [], g2Extra = [], fuelHoard = 0 } = {}) {
  return createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: RIVAL, homePlanetId: getTerranHomeworld(RIVAL) },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [
      claimOf('g1', HOME.id), ...g1Extra.map((id) => claimOf('g1', id)),
      claimOf('g2', RIVAL), ...g2Extra.map((id) => claimOf('g2', id)),
    ],
  });
}

const guildOf = (s, guildId) => s.guilds.find((g) => g.id === guildId);
const spawnOutpost = (s, guildId, anchorSystemId, coords) => accept(s, createSpawnOutpostAction({ guildId, anchorSystemId, coords }));

// armed(state, guildId, hex) -> { s, craftId }: a fresh heavy of `guildId`, spawned at its home, an array kit
// granted and loaded there, then PLACED on `hex` — the stand-in for a flight (kit-fixtures.js).
function armed(state, guildId, hex) {
  const home = guildOf(state, guildId).homeSystemId;
  let s = accept(state, createSpawnVehicleAction({ guildId, class: HEAVY_TRANSPORT, location: { landmarkKind: 'system', landmarkId: home } }));
  const vehicles = guildOf(s, guildId).vehicles;
  const craftId = vehicles[vehicles.length - 1].id;
  s = placeCraft(kitAboard(s, guildId, craftId, 'deepScan'), guildId, craftId, hex);
  return { s, craftId };
}
// verdict(state, guildId, hex) -> deployAsset's answer for that armed heavy; deployed(...) -> the state after it.
function verdict(state, guildId, hex) {
  const { s, craftId } = armed(state, guildId, hex);
  return validateAction(s, createDeployAssetAction({ guildId, vehicleId: craftId }));
}
function deployed(state, guildId, hex) {
  const { s, craftId } = armed(state, guildId, hex);
  return accept(s, createDeployAssetAction({ guildId, vehicleId: craftId }));
}

// Two seed systems whose geometry the slice names, found by scanning the seed (so a regen carries the tests):
// `gap` — a system pair whose control disks are ONE ring apart, and the free hex X on both rings;
// `edge` — a pair whose disks touch, and a free hex Y on A's ring but inside B's disk;
// `shared` — a pair whose disks OVERLAP, and a free hex Z inside both.
function findPair(want) {
  for (const a of seed.systems) {
    for (const b of seed.systems) {
      if (a.id === b.id || [a.id, b.id].some((id) => id === HOME.id || id === RIVAL)) continue;
      const hex = want(a.id, b.id);
      if (hex) return { a: a.id, b: b.id, hex };
    }
  }
  throw new Error('the seed has no system pair of the shape this test needs');
}
const ringOf = (id) => hexesAt(centreOf(id), radiusOf(id) + 1);
const gap = findPair((a, b) => hexDistance(centreOf(a), centreOf(b)) === radiusOf(a) + radiusOf(b) + 2
  && ringOf(a).find((h) => isFree(h) && hexDistance(h, centreOf(b)) === radiusOf(b) + 1));
const edge = findPair((a, b) => ringOf(a).find((h) => isFree(h) && hexDistance(h, centreOf(b)) <= radiusOf(b)));
const shared = findPair((a, b) => hexesAt(centreOf(a), 1).find((h) => isFree(h)
  && hexDistance(h, centreOf(a)) <= radiusOf(a) && hexDistance(h, centreOf(b)) <= radiusOf(b)));

// --- 1. inside the guild's own disk ---------------------------------------------------------------------

test('INSIDE THE OWN DISK: every bare hex 1 ≤ d ≤ claimRadius deploys, anchored to the system it is inside', () => {
  const inside = [];
  for (let d = 1; d <= radiusOf(HOME.id); d += 1) inside.push(...hexesAt(HOME_HEX, d).filter(isFree));
  assert.ok(inside.length > 0, 'home\'s disk has bare hexes');
  for (const hex of inside) {
    const s = deployed(galaxy(), 'g1', hex);
    assert.equal(s.deepScanArrays.length, 1);
    assert.deepEqual(s.deepScanArrays[0].coords, hex);
    assert.equal(s.deepScanArrays[0].anchorSystemId, HOME.id);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

test('INSIDE THE OWN DISK, still refused: the centre (not-bare-hex), and a disk hex under the guild\'s own Outpost or array (occupied)', () => {
  // The centre: a craft at the system is berthed at the landmark, so the bare-hex check refuses it first.
  const { s: atHome, craftId } = armed(galaxy(), 'g1', { landmarkKind: 'system', landmarkId: HOME.id });
  assert.match(validateAction(atHome, createDeployAssetAction({ guildId: 'g1', vehicleId: craftId })).reason,
    /berthed at a landmark .* — a Deep Scan Array deploys on a bare hex/);
  // A disk hex carrying g1's own Outpost.
  const [first, second] = hexesAt(HOME_HEX, 1).filter(isFree);
  const withOutpost = spawnOutpost(galaxy(), 'g1', HOME.id, first);
  assert.match(verdict(withOutpost, 'g1', first).reason, /already occupied by outpost "outpost_g1_01" — one structure per hex/);
  // A disk hex carrying g1's own array.
  const withArray = deployed(galaxy(), 'g1', second);
  assert.match(verdict(withArray, 'g1', second).reason, /already occupied by deepScanArray "deepScanArray_g1_01"/);
});

// --- 2. between two guilds ------------------------------------------------------------------------------

test('BETWEEN TWO GUILDS, one ring apart: the hex on both rings is nobody\'s and touches both — legal for BOTH', () => {
  const s = galaxy({ g1Extra: [gap.a], g2Extra: [gap.b] });
  assert.deepEqual(controlNear(s, gap.hex, 0), [], 'nobody controls it');
  for (const [guildId, anchor] of [['g1', gap.a], ['g2', gap.b]]) {
    const after = deployed(s, guildId, gap.hex);
    assert.equal(after.deepScanArrays[0].ownerGuildId, guildId);
    assert.equal(after.deepScanArrays[0].anchorSystemId, anchor, `${guildId} anchors to its own system`);
    assert.deepEqual(checkInvariants(after, after.tick), []);
  }
});

test('BETWEEN TWO GUILDS, disks touching: a hex on A\'s ring but inside B\'s disk is refused for A as rival-territory — and is B\'s to use', () => {
  const s = galaxy({ g1Extra: [edge.a], g2Extra: [edge.b] });
  assert.equal(hexDistance(edge.hex, centreOf(edge.a)), radiusOf(edge.a) + 1, 'it touches g1\'s territory');
  const forA = attachedPlacement(s, 'g1', edge.hex);
  assert.equal(forA.ok, false);
  assert.equal(forA.failure, 'rival-territory');
  assert.ok(DEPLOY_FAILED_REASONS.includes('rival-territory'), 'a reason a failed arrival can carry');
  assert.match(verdict(s, 'g1', edge.hex).reason,
    new RegExp(`is inside guild "g2"'s territory \\(its system "${edge.b}"\\) — a Deep Scan Array never deploys inside a rival's control`));
  // For g2 the same hex is inside its OWN disk: legal.
  assert.equal(verdict(s, 'g2', edge.hex).valid, true);
});

test('BETWEEN TWO GUILDS, disks overlapping: a hex inside BOTH disks is refused for BOTH — no seniority is built', () => {
  const s = galaxy({ g1Extra: [shared.a], g2Extra: [shared.b] });
  assert.deepEqual(controlNear(s, shared.hex, 0).map((f) => f.guildId).sort(), ['g1', 'g2'], 'both disks cover it');
  assert.equal(attachedPlacement(s, 'g1', shared.hex).failure, 'rival-territory');
  assert.equal(attachedPlacement(s, 'g2', shared.hex).failure, 'rival-territory');
});

// --- 3. a rival's Outpost beside the guild's territory -------------------------------------------------

test('A RIVAL\'S OUTPOST on a hex beside g1\'s territory: refused as occupied — the order is unchanged; placement alone says rival-territory', () => {
  const ringHex = hexesAt(HOME_HEX, radiusOf(HOME.id) + 1).find(isFree);
  const s = spawnOutpost(galaxy(), 'g2', RIVAL, ringHex);
  assert.equal(attachedPlacement(s, 'g1', ringHex).failure, 'rival-territory', 'the Outpost\'s hex is g2\'s control');
  assert.match(verdict(s, 'g1', ringHex).reason, /already occupied by outpost "outpost_g2_01" — one structure per hex/);
  // The hexes BESIDE g2's Outpost are nobody's (an Outpost has no aura yet): one that also sits on g1's ring
  // is still g1's to use.
  const besideBoth = hexesAt(ringHex, 1).find((h) => isFree(h) && hexDistance(h, HOME_HEX) === radiusOf(HOME.id) + 1);
  assert.ok(besideBoth, 'the ring continues past the Outpost');
  assert.equal(verdict(s, 'g1', besideBoth).valid, true);
});

// --- 4. arrival -------------------------------------------------------------------------------------------

// The arrival fixture: a starter system S near home that nobody holds yet; g1 plants an Outpost two hexes from
// S's centre, and the target is the free hex between them — beside g1's Outpost, inside nobody's control. When a
// new guild founds on S, S's disk takes the target.
const S = getStarterSystems().map((x) => x.id).filter((id) => id !== HOME.id && id !== RIVAL)
  .sort((x, y) => hexDistance(centreOf(x), HOME_HEX) - hexDistance(centreOf(y), HOME_HEX) || (x < y ? -1 : 1))[0];
const S_HEX = centreOf(S);
const OUTPOST_HEX = hexesAt(S_HEX, radiusOf(S) + 1).find((o) => isFree(o)
  && hexesAt(o, 1).some((t) => isFree(t) && hexDistance(t, S_HEX) === radiusOf(S)));
const TARGET = hexesAt(OUTPOST_HEX, 1).find((t) => isFree(t) && hexDistance(t, S_HEX) === radiusOf(S));
const foundRivalOnS = (s) => accept(s, createFoundGuildAction({ guildId: 'g3', name: 'Rival Three', isBot: true, credits: 0, homeSystemId: S }));

function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (guildOf(s, 'g1').vehicles.every((v) => v.status === 'idle')) return s;
    s = tick(s, []);
  }
  throw new Error('a craft never landed');
}
// flyingTo(target) -> g1, with its Outpost beside the target, has dispatched a heavy carrying an array kit to it.
function flyingTo(target) {
  let s = spawnOutpost(galaxy({ fuelHoard: 100_000 }), 'g1', HOME.id, OUTPOST_HEX);
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: { landmarkKind: 'system', landmarkId: HOME.id } }));
  const craftId = guildOf(s, 'g1').vehicles[0].id;
  s = kitAboard(s, 'g1', craftId, 'deepScan');
  return accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: craftId, waypoints: [{ anchor: target, action: DEPLOY_ARRAY }] }));
}

test('ARRIVAL: the target becomes a rival\'s control in flight (a guild founds on the system) → rival-territory, retreat, kit aboard, notice', () => {
  let s = flyingTo(TARGET);   // legal at dispatch: beside g1's Outpost, nobody's control
  const craftId = guildOf(s, 'g1').vehicles[0].id;
  const arrivalTick = guildOf(s, 'g1').vehicles[0].trip.arrivalTick;
  s = foundRivalOnS(s);       // …then S is held by g3, and its disk covers the target
  assert.equal(attachedPlacement(s, 'g1', TARGET).failure, 'rival-territory');
  s = tickToIdle(s);

  const craft = guildOf(s, 'g1').vehicles[0];
  assert.equal(s.deepScanArrays, undefined, 'nothing was placed');
  assert.deepEqual(craft.cargo, { [DEEP_SCAN_KIT]: 1 }, 'the kit is still aboard');
  assert.deepEqual(craft.deployFailed, { reason: 'rival-territory', tick: arrivalTick });
  assert.notDeepEqual(craft.location, TARGET, 'it pulled back off the rival\'s hex');
  const notice = guildOf(s, 'g1').events.find((e) => e.type === 'deploy_failed');
  assert.equal(notice.tick, arrivalTick);
  assert.deepEqual(
    { cause: notice.payload.cause, kind: notice.payload.kind, targetHex: notice.payload.targetHex, craftId: notice.payload.craftId, retreatSystemId: notice.payload.retreatSystemId },
    { cause: 'rival-territory', kind: 'deepScan', targetHex: TARGET, craftId, retreatSystemId: HOME.id },
  );
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('ARRIVAL: a rival Outpost planted ON the target in flight → occupied (the one-structure check runs first)', () => {
  let s = flyingTo(TARGET);
  const arrivalTick = guildOf(s, 'g1').vehicles[0].trip.arrivalTick;
  s = spawnOutpost(s, 'g2', RIVAL, TARGET);
  s = tickToIdle(s);
  const craft = guildOf(s, 'g1').vehicles[0];
  assert.deepEqual(craft.cargo, { [DEEP_SCAN_KIT]: 1 });
  assert.deepEqual(craft.deployFailed, { reason: 'occupied', tick: arrivalTick });
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. not retroactive ---------------------------------------------------------------------------------

test('NOT RETROACTIVE: a standing array whose hex falls inside a rival\'s control STAYS, and every invariant holds', () => {
  let s = spawnOutpost(galaxy(), 'g1', HOME.id, OUTPOST_HEX);
  s = deployed(s, 'g1', TARGET);
  const array = structuredClone(s.deepScanArrays[0]);
  s = foundRivalOnS(s);
  assert.equal(attachedPlacement(s, 'g1', TARGET).failure, 'rival-territory', 'the hex IS a rival\'s control now');
  for (let i = 0; i < 5; i += 1) {
    s = tick(s, []);
    assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
  }
  assert.deepEqual(s.deepScanArrays, [array], 'the array stands, unchanged');
  // …and it is still in its owner's view, and only there.
  assert.deepEqual(buildSnapshot(s, 'g1').deepScanArrays.map((a) => a.id), [array.id]);
  assert.equal('deepScanArrays' in buildSnapshot(s, 'g3'), false, 'the rival on whose ground it now sits does not see it');
});

// --- 6. the lane ---------------------------------------------------------------------------------------

const laneOf = (s, guildId) => {
  const row = buildSnapshot(s).guilds.find((g) => g.id === guildId);
  return row.deployRange.deepScan.hexes;
};

test('THE LANE equals the independent oracle over the whole galaxy, for both guilds, and holds no hex inside a rival\'s disk', () => {
  for (const pair of [gap, edge, shared]) {
    const s = galaxy({ g1Extra: [pair.a], g2Extra: [pair.b] });
    for (const [guildId, rivalSystems] of [['g1', [pair.b, RIVAL]], ['g2', [pair.a, HOME.id]]]) {
      const lane = laneOf(s, guildId);
      assert.deepEqual(lane, attachedByRule(s, guildId), `${guildId}'s lane, around ${pair.a} / ${pair.b}`);
      for (const sys of rivalSystems) {
        assert.equal(lane.some((h) => hexDistance(h, centreOf(sys)) <= radiusOf(sys)), false, `${guildId}'s lane reaches into ${sys}'s disk`);
      }
    }
  }
  // Not vacuous: the touching pair's hex Y is on g1's ring and off its lane, and in g2's.
  const s = galaxy({ g1Extra: [edge.a], g2Extra: [edge.b] });
  assert.equal(laneOf(s, 'g1').some((h) => keyOf(h) === keyOf(edge.hex)), false);
  assert.equal(laneOf(s, 'g2').some((h) => keyOf(h) === keyOf(edge.hex)), true);
});

// --- 7. the control helper --------------------------------------------------------------------------------

test('controlNear: within 0 is who controls the hex; within 1 adds the footprints beside it; systems first, then Outposts, each by id', () => {
  let s = galaxy({ g1Extra: [gap.a], g2Extra: [gap.b] });
  assert.deepEqual(controlNear(s, HOME_HEX, 0), [{ guildId: 'g1', kind: 'system', id: HOME.id, anchorSystemId: HOME.id }], 'the centre is in the disk');
  assert.deepEqual(controlNear(s, gap.hex, 0), [], 'the gap hex is nobody\'s');
  assert.deepEqual(controlNear(s, gap.hex, 1).map((f) => f.id), [gap.a, gap.b].sort(), 'but it is beside both disks');
  // An Outpost controls its own hex only (no aura yet): an Outpost row follows the systems.
  s = spawnOutpost(s, 'g2', HOME.id, gap.hex);
  assert.deepEqual(controlNear(s, gap.hex, 0), [{ guildId: 'g2', kind: 'outpost', id: 'outpost_g2_01', anchorSystemId: HOME.id }]);
  assert.deepEqual(controlNear(s, gap.hex, 1).map((f) => f.kind), ['system', 'system', 'outpost']);
  assert.deepEqual(controlNear(s, hexesAt(gap.hex, 2).find(isFree), 0).filter((f) => f.kind === 'outpost'), [], 'two hexes off, the Outpost controls nothing');
});

test('controlNear: a claimed system whose seed row has no claimRadius HALTS, naming it — a rival\'s as much as the guild\'s own', () => {
  const broken = structuredClone(seed);
  delete broken.systems.find((x) => x.id === RIVAL).claimRadius;
  setSeed(broken);
  try {
    assert.throws(() => attachedPlacement(galaxy(), 'g1', hexesAt(HOME_HEX, 1).find(isFree)),
      new RegExp(`hex control: guild "g2" holds system "${RIVAL}", whose seed row carries no whole-number claimRadius`));
  } finally {
    setSeed(null);   // back to the committed seed for every other test
  }
});
