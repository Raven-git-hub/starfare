'use strict';

// deploy-range.test.js — the deploy pipeline slice 3, roadmap 2.2 (docs/territory-model.md §5, "Painting the
// range (the snapshot contract)"). Each guild row in the snapshot carries a lane-keyed `deployRange`:
//
//     deployRange: { outpost: { radius: OUTPOST_DEPLOY_RANGE, anchors: heldSystemIds(state, guildId) } }
//
// omitted entirely when the guild holds no system. It is what lets the client paint the legal deploy range
// without computing a game number (§18). It is DERIVED telemetry, so the danger is DRIFT: a field that
// quietly stops agreeing with the state it mirrors. The tripwires:
//   - SHAPE: a guild holding N systems gets `{ outpost: { radius, anchors } }` — the engine's constant and
//     `heldSystemIds` verbatim; a guild holding none carries NO key (omit-when-empty);
//   - ONLY ITS OWN SYSTEMS anchor — not a rival's, not a non-system claim, not the guild's Outposts;
//   - DERIVED, NOT STALE: a claim gained or lost shows in the very next snapshot, through the real
//     `foundGuild` apply as well as a hand-edited claim list;
//   - DETERMINISM (invariant 9): two snapshots of one state are byte-identical, and anchors follow
//     `heldSystemIds` order (sorted, deduped), never claim-insertion order;
//   - PURE: building it mutates no state, and the published array does not alias engine state;
//   - THE PAINT AGREES WITH THE RULE: a hex exactly `radius` from the published anchor passes deployAsset's
//     range check, and one hex further is refused out-of-range;
//   - THE TRIPWIRE itself (`assertDeployRange`) fires loudly — tick and offending values — on every kind
//     of drift, and holds on every tick of a founded galaxy.
//
// Why the tripwire lives here and not in sim/invariants.js: those checks read STATE every tick, and
// `deployRange` is not state — it exists only in the snapshot. So it is a snapshot-shape assertion, kept
// beside the tests, in the invariants' own violation shape ({ rule, where, detail }).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const { buildSnapshot } = require('../snapshot.js');
const { hashState } = require('../serialize.js');
const { guildHolds, heldSystemIds } = require('../claims.js');
const { OUTPOST_DEPLOY_RANGE } = require('../outposts.js');
const { hexDistance } = require('../transport.js');
const { getSystem, getStarterSystems, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const {
  validateAction, applyAction,
  createFoundGuildAction, createSpawnVehicleAction, createGrantKitAction, createDeployAssetAction,
} = require('../actions.js');

// --- the tripwire ------------------------------------------------------------------------------------

// deployRangeViolations(state, snap) -> [ { rule, where, detail } ]. Every guild row is checked against the
// state it was built from: the field must be ABSENT when the guild holds nothing, and otherwise exactly
// `{ outpost: { radius, anchors } }` with the engine's radius and every anchor a system the guild holds, in
// `heldSystemIds` order.
function deployRangeViolations(state, snap) {
  const out = [];
  for (const row of snap.guilds) {
    const where = `guild:${row.id}.deployRange`;
    const held = heldSystemIds(state, row.id);
    const present = Object.prototype.hasOwnProperty.call(row, 'deployRange');
    if (held.length === 0) {
      if (present) out.push({ rule: 'deploy-range-omit-when-empty', where, detail: { deployRange: row.deployRange } });
      continue;
    }
    if (!present) {
      out.push({ rule: 'deploy-range-present-when-held', where, detail: { held } });
      continue;
    }
    // Only the outpost lane is built. When `tollGate` / `deepScan` land, their checks join this function —
    // until then a new key fails here rather than riding along unchecked.
    const lanes = Object.keys(row.deployRange);
    if (lanes.length !== 1 || lanes[0] !== 'outpost') {
      out.push({ rule: 'deploy-range-lanes', where, detail: { lanes } });
    }
    const lane = row.deployRange.outpost || {};
    // radius + anchors and nothing else: the "fat" enumerated-hex shape was ruled OUT (territory-model.md §5).
    const keys = Object.keys(lane);
    if (keys.length !== 2 || !keys.includes('radius') || !keys.includes('anchors')) {
      out.push({ rule: 'deploy-range-outpost-keys', where: `${where}.outpost`, detail: { keys } });
    }
    if (lane.radius !== OUTPOST_DEPLOY_RANGE) {
      out.push({ rule: 'deploy-range-radius', where: `${where}.outpost.radius`, detail: { radius: lane.radius, expected: OUTPOST_DEPLOY_RANGE } });
    }
    const anchors = Array.isArray(lane.anchors) ? lane.anchors : null;
    // guildHolds is the independent singular predicate — each anchor must be a system this guild holds.
    const notHeld = anchors ? anchors.filter((id) => !guildHolds(state, row.id, id)) : [];
    if (!anchors || notHeld.length > 0) {
      out.push({ rule: 'deploy-range-anchor-held', where: `${where}.outpost.anchors`, detail: { anchors: lane.anchors, notHeld } });
    }
    if (anchors && JSON.stringify(anchors) !== JSON.stringify(held)) {
      out.push({ rule: 'deploy-range-anchors-match-held', where: `${where}.outpost.anchors`, detail: { anchors, expected: held } });
    }
  }
  return out;
}

// Halt loudly, with the tick and the offending values — a silent drift is worse than a crash.
function assertDeployRange(state, snap) {
  const violations = deployRangeViolations(state, snap);
  if (violations.length > 0) {
    throw new Error(`deployRange drifted from its source at tick ${state.tick}:\n${JSON.stringify(violations, null, 2)}`);
  }
}

// --- fixtures ----------------------------------------------------------------------------------------

// Real seed systems (the starter list is id-sorted), so a regenerated seed carries these tests along.
const [SYS_A, SYS_B, SYS_C, SYS_D] = getStarterSystems().map((s) => s.id);

const systemClaim = (guildId, systemId, n) => ({
  claimId: `claim_${guildId}_${n}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

// A galaxy of guilds with no home fields (these tests are about claims alone), holding what `claims` says,
// plus any guild `outposts` (createState builds each through createOutpost).
function galaxy(guildIds, claims, outposts = []) {
  return createState({
    guilds: guildIds.map((id) => ({ id, name: id, credits: 0, fuelHoard: 0 })),
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims,
    outposts,
  });
}

// Every engine action goes through validate first, so a fixture can never skip a gate the game enforces.
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};

const rowOf = (snap, guildId) => snap.guilds.find((g) => g.id === guildId);
const hasRange = (row) => Object.prototype.hasOwnProperty.call(row, 'deployRange');

// --- the shape ---------------------------------------------------------------------------------------

test('a guild holding N systems: anchors are heldSystemIds verbatim, radius is OUTPOST_DEPLOY_RANGE', () => {
  const s = galaxy(['g1'], [systemClaim('g1', SYS_C, 1), systemClaim('g1', SYS_A, 2), systemClaim('g1', SYS_B, 3)]);
  const snap = buildSnapshot(s);
  const { deployRange } = rowOf(snap, 'g1');
  assert.deepEqual(deployRange, { outpost: { radius: OUTPOST_DEPLOY_RANGE, anchors: heldSystemIds(s, 'g1') } });
  assert.equal(deployRange.outpost.anchors.length, 3, 'all three held systems anchor');
  assert.equal(deployRange.outpost.radius, OUTPOST_DEPLOY_RANGE, 'the engine constant, not a literal');
  assertDeployRange(s, snap);
});

test('a guild holding no system carries NO deployRange key (omit-when-empty)', () => {
  const s = galaxy(['g1', 'g2'], [systemClaim('g1', SYS_A, 1)]);
  const snap = buildSnapshot(s);
  assert.equal(hasRange(rowOf(snap, 'g2')), false, 'holds nothing -> can deploy nowhere -> no key at all');
  assert.equal(hasRange(rowOf(snap, 'g1')), true, 'while its neighbour, which holds a system, has one');
  // A galaxy where nobody holds anything carries the key on no row.
  const bare = buildSnapshot(galaxy(['g1', 'g2'], []));
  assert.equal(bare.guilds.some(hasRange), false);
  assertDeployRange(s, snap);
});

test('only the guild\'s OWN SYSTEM claims anchor — not a rival\'s, not a non-system claim, not its Outposts', () => {
  const s = galaxy(['g1', 'g2'], [
    systemClaim('g1', SYS_A, 1),
    systemClaim('g2', SYS_B, 1),
    // A non-system claim row owned by g1 — the outpost lane measures to SYSTEMS only (§5 "Deploy ranges").
    { claimId: 'claim_g1_citadel', ownerGuildId: 'g1', landmarkId: 'citadel', landmarkKind: 'citadel', claimedAtTick: 0, contested: false },
  ], [
    // An Outpost g1 owns is NOT an outpost-lane anchor (outposts anchor the later tollGate / deepScan lanes).
    { id: 'outpost_g1_01', ownerGuildId: 'g1', coords: { q: 0, r: 0 }, anchorSystemId: SYS_A, createdAtTick: 0 },
  ]);
  assert.equal(s.outposts.length, 1, 'the Outpost is really in state');
  const snap = buildSnapshot(s);
  assert.deepEqual(rowOf(snap, 'g1').deployRange.outpost.anchors, [SYS_A]);
  assert.deepEqual(rowOf(snap, 'g2').deployRange.outpost.anchors, [SYS_B]);
  assertDeployRange(s, snap);
});

// --- derived, not stale ------------------------------------------------------------------------------

test('derived, not stale: a claim gained or lost shows in the very next snapshot', () => {
  const s = galaxy(['g1'], [systemClaim('g1', SYS_B, 1)]);
  const anchorsNow = () => {
    const snap = buildSnapshot(s);
    assertDeployRange(s, snap);
    const row = rowOf(snap, 'g1');
    return hasRange(row) ? row.deployRange.outpost.anchors : undefined;
  };
  assert.deepEqual(anchorsNow(), [SYS_B]);

  s.claims.push(systemClaim('g1', SYS_A, 2));   // gain a system
  assert.deepEqual(anchorsNow(), [SYS_A, SYS_B], 'the new system anchors at once, in sorted place');

  s.claims = s.claims.filter((c) => c.landmarkId !== SYS_B);   // lose one
  assert.deepEqual(anchorsNow(), [SYS_A], 'the lost system stops anchoring at once');

  s.claims = [];   // lose them all
  assert.equal(anchorsNow(), undefined, 'holding nothing, the key is gone');
});

test('derived, not stale: a guild founded through the real foundGuild apply anchors on its home', () => {
  let s = createZeroState();
  assert.equal(buildSnapshot(s).guilds.length, 0);
  s = accept(s, createFoundGuildAction({ guildId: 'g1', name: 'G1', credits: 100, homeSystemId: SYS_A }));
  const snap = buildSnapshot(s);
  assert.deepEqual(rowOf(snap, 'g1').deployRange, { outpost: { radius: OUTPOST_DEPLOY_RANGE, anchors: [SYS_A] } });
  assertDeployRange(s, snap);
});

// --- determinism + purity ----------------------------------------------------------------------------

test('determinism: byte-identical snapshots, anchors in heldSystemIds order (not insertion order)', () => {
  // Claims inserted in REVERSE order, with a duplicate row on one system.
  const scrambled = [SYS_D, SYS_C, SYS_B, SYS_A, SYS_C].map((sys, i) => systemClaim('g1', sys, i));
  const s = galaxy(['g1'], scrambled);
  const anchors = rowOf(buildSnapshot(s), 'g1').deployRange.outpost.anchors;
  assert.deepEqual(anchors, heldSystemIds(s, 'g1'), 'the source order — sorted and deduped');
  assert.deepEqual(anchors, [SYS_A, SYS_B, SYS_C, SYS_D]);
  assert.notDeepEqual(anchors, scrambled.map((c) => c.landmarkId), 'never the claim-insertion order');

  assert.equal(JSON.stringify(buildSnapshot(s)), JSON.stringify(buildSnapshot(s)), 'same state, same bytes');
  // The same holdings reached in another insertion order publish the same bytes.
  const sorted = galaxy(['g1'], [SYS_A, SYS_B, SYS_C, SYS_D].map((sys, i) => systemClaim('g1', sys, i)));
  assert.equal(
    JSON.stringify(rowOf(buildSnapshot(sorted), 'g1').deployRange),
    JSON.stringify(rowOf(buildSnapshot(s), 'g1').deployRange),
  );
});

test('pure: building it mutates no state, and the published anchors do not alias engine state', () => {
  const s = galaxy(['g1'], [systemClaim('g1', SYS_A, 1), systemClaim('g1', SYS_B, 2)]);
  const before = hashState(s);
  const first = buildSnapshot(s);
  assert.equal(hashState(s), before, 'building the snapshot changed no engine state');

  first.guilds[0].deployRange.outpost.anchors.push('sys_bogus');   // a consumer scribbling on its copy
  first.guilds[0].deployRange.outpost.radius = 99;
  assert.equal(hashState(s), before, 'the scribble did not reach state');
  const second = buildSnapshot(s);
  assert.deepEqual(rowOf(second, 'g1').deployRange, { outpost: { radius: OUTPOST_DEPLOY_RANGE, anchors: [SYS_A, SYS_B] } });
  assertDeployRange(s, second);
});

// --- the paint agrees with the rule ------------------------------------------------------------------

// freeHexAtDistance(d, from) -> the first in-bounds hex EXACTLY `d` hexes from `from` with no seed landmark
// on it, in a fixed scan order (the deploy-asset.test.js helper), so a regenerated seed carries the test.
function freeHexAtDistance(d, from) {
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      if (hexDistance({ q, r }, from) === d && isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) return { q, r };
    }
  }
  throw new Error(`no free hex at distance ${d} from ${JSON.stringify(from)} on this seed`);
}

test('the painted disk agrees with deployCheck at its edge: exactly radius passes, one further is refused', () => {
  const s = galaxy(['g1'], [systemClaim('g1', SYS_A, 1)]);
  // Read the range the way the client will: from the snapshot, not from the engine constant.
  const { radius, anchors } = rowOf(buildSnapshot(s), 'g1').deployRange.outpost;
  const anchorHex = getSystem(anchors[0]).coords;

  // A heavy with a kit, idle on hex `hex` — then ask deployAsset's validate, which runs deployCheck.
  const verdictAt = (hex) => {
    let t = JSON.parse(JSON.stringify(s));
    t = accept(t, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: hex }));
    const craftId = t.guilds[0].vehicles[0].id;
    t = accept(t, createGrantKitAction({ guildId: 'g1', vehicleId: craftId, kind: 'outpost' }));
    return validateAction(t, createDeployAssetAction({ guildId: 'g1', vehicleId: craftId }));
  };

  const edge = verdictAt(freeHexAtDistance(radius, anchorHex));
  assert.equal(edge.valid, true, `a hex inside the painted disk must be deployable, got: ${edge.reason}`);
  const beyond = verdictAt(freeHexAtDistance(radius + 1, anchorHex));
  assert.equal(beyond.valid, false, 'a hex outside the painted disk must be refused');
  assert.match(beyond.reason, new RegExp(`is ${radius + 1} hexes from the nearest system guild "g1" holds`));
});

// --- the tripwire fires ------------------------------------------------------------------------------

test('the tripwire fires loudly — tick and offending values — on every kind of drift', () => {
  const s = galaxy(['g1', 'g2'], [systemClaim('g1', SYS_A, 1), systemClaim('g1', SYS_B, 2)]);
  s.tick = 7;
  const good = buildSnapshot(s);
  assert.doesNotThrow(() => assertDeployRange(s, good), 'the real snapshot passes');

  // Each case breaks exactly one thing in a copy of the good snapshot, and names the rule it must trip.
  const drift = (rule, mutate) => {
    const bad = JSON.parse(JSON.stringify(good));
    mutate(rowOf(bad, 'g1'), rowOf(bad, 'g2'));
    assert.throws(() => assertDeployRange(s, bad), (err) => {
      assert.match(err.message, /deployRange drifted from its source at tick 7/);
      assert.match(err.message, new RegExp(`"rule": "${rule}"`));
      return true;
    }, rule);
  };
  drift('deploy-range-radius', (g1) => { g1.deployRange.outpost.radius = OUTPOST_DEPLOY_RANGE + 1; });
  drift('deploy-range-anchors-match-held', (g1) => { g1.deployRange.outpost.anchors.reverse(); });
  drift('deploy-range-anchor-held', (g1) => { g1.deployRange.outpost.anchors.push(SYS_C); });
  drift('deploy-range-anchors-match-held', (g1) => { g1.deployRange.outpost.anchors.pop(); });
  drift('deploy-range-omit-when-empty', (g1, g2) => { g2.deployRange = { outpost: { radius: OUTPOST_DEPLOY_RANGE, anchors: [] } }; });
  drift('deploy-range-present-when-held', (g1) => { delete g1.deployRange; });
  drift('deploy-range-lanes', (g1) => { g1.deployRange.tollGate = { radius: 1, anchors: [] }; });
  drift('deploy-range-outpost-keys', (g1) => { g1.deployRange.outpost.hexes = [{ q: 0, r: 0 }]; });
});

test('the tripwire holds on every tick of a founded galaxy', () => {
  let s = createZeroState();
  s = accept(s, createFoundGuildAction({ guildId: 'g1', name: 'G1', credits: 100, homeSystemId: SYS_A }));
  s = accept(s, createFoundGuildAction({ guildId: 'g2', name: 'G2', isBot: true, credits: 100, homeSystemId: SYS_B }));
  for (let i = 0; i < 20; i += 1) {
    const snap = buildSnapshot(s);
    assertDeployRange(s, snap);
    assert.deepEqual(rowOf(snap, 'g1').deployRange.outpost.anchors, [SYS_A]);
    assert.deepEqual(rowOf(snap, 'g2').deployRange.outpost.anchors, [SYS_B]);
    s = advance(s, []).state;
  }
});
