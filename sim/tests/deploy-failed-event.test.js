'use strict';

// deploy-failed-event.test.js — the `deploy_failed` NOTICE, roadmap 2.2 deploy pipeline (ENGINE + the write,
// no client). The spec is docs/event-log.md §10: when an on-arrival deploy fails and the craft RETREATS
// (docs/territory-model.md §5), the retreat records a `deploy_failed` row on its guild's event log, at the
// same tick and in the same place it flags the craft `deployFailed`.
//
// The tripwires:
//   1. A retreat writes EXACTLY ONE row, on the retreating guild only, with the full self-contained payload
//      (cause, kind, targetHex, craftId + craftClass, retreatSystemId + its seed name) — for each of the two
//      causes, 'occupied' and 'out-of-range'. The row and the craft flag agree on reason and tick.
//   2. The retreat system is the LIVE nearest held system — the one the craft actually moved toward — not
//      a fixed "home": with a nearer second system held, the craft and the notice both go there.
//   3. A SUCCESSFUL deploy writes nothing, and a galaxy with no deploy carries no `events` key at all.
//   4. DETERMINISM (invariant 9): the written row is identical across a save/restore of the same retreat.
//   5. The row rides the existing log machinery unchanged: surfaced in the snapshot with `whenDay`, counted
//      unread in `attention.notices`, acknowledged and aged out exactly as the other two types.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hexDistance } = require('../transport.js');
const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { dayOf } = require('../calendar.js');
const { DEFAULT_WINDOW_N } = require('../windows.js');
const { RETENTION_UNREAD_TICKS, RETENTION_READ_TICKS, isEventLive, recordEvent } = require('../events.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { OUTPOST_DEPLOY_RANGE, DEPLOY_RETREAT_HEXES } = require('../outposts.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const seed = require('../../data/seed.json');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const {
  validateAction, applyAction, intake,
  createSpawnVehicleAction, createDispatchRouteWithActionsAction,
  createDispatchVehicleAction, createSpawnOutpostAction, createAcknowledgeEventAction,
} = require('../actions.js');

// --- fixtures (the deploy-on-arrival.test.js set, trimmed to what these tests need) ----------------

const HOME = starterHomeAtDistance(6); // a real starter system the guild holds
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;
const DEPLOY = { type: 'deploy', kind: 'outpost' };

// Along one of the six axial directions every hex between two points lies on the straight line, so a
// retreat's landing there is hand-computable. Derived from the seed, so a regen carries the tests.
const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const along = (from, dir, k) => ({ q: from.q + k * dir.q, r: from.r + k * dir.r });
const isFree = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
function freeDirection(from, ks) {
  const dir = DIRS.find((d) => ks.every((k) => isFree(along(from, d, k))));
  if (!dir) throw new Error(`no direction from ${JSON.stringify(from)} with free hexes at ${ks.join(', ')} on this seed`);
  return dir;
}

const claimOf = (guildId, systemId, n) => ({
  claimId: `claim_${guildId}_${n}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};

// g1 holds its home (plus `extraClaims`) and has heavies at `location`, each with one outpost kit aboard;
// g2 is a rival that holds nothing — it places the Outposts that take g1's target hexes. Each kit comes the
// asset-initiated way (design.md §4): granted into home's inventory and loaded onto the heavy berthed there
// (kit-fixtures.js); the laden heavy is then PLACED at `location`, the stand-in for a flight.
function kitAt(location, { extraClaims = [], craft = 1 } = {}) {
  let s = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 10_000, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0 },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', HOME.id, 'home'), ...extraClaims],
  });
  for (let i = 0; i < craft; i += 1) {
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
    const vid = s.guilds[0].vehicles[i].id;
    s = placeCraft(kitAboard(s, 'g1', vid), 'g1', vid, location);
  }
  return s;
}
const craftOf = (s, i = 0) => s.guilds[0].vehicles[i];
const deployTo = (s, target, i = 0) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: craftOf(s, i).id, waypoints: [{ anchor: target, action: DEPLOY }],
});
const occupy = (s, hex) => accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: hex }));

function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds[0].vehicles.every((v) => v.status === 'idle')) return s;
    s = tick(s, []);
  }
  throw new Error('a craft never landed');
}

// A heavy one hex beyond a target `k` hexes out from home along one axis, dispatched to deploy there; the
// rival then takes the target, so the deploy fails 'occupied' on arrival.
function occupiedRun(k) {
  const dir = freeDirection(HOME_HEX, [k, k + 1, Math.max(k - DEPLOY_RETREAT_HEXES, 1)]);
  const target = along(HOME_HEX, dir, k);
  let s = kitAt(along(HOME_HEX, dir, k + 1));
  s = accept(s, deployTo(s, target));
  s = occupy(s, target);
  return { s, dir, target, arrivalTick: craftOf(s).trip.arrivalTick };
}

// A second system B and a target T on an axis line from home, OUT of home's deploy range but WITHIN B's —
// so B is the nearer held system while g1 holds it. (The deploy-on-arrival.test.js search, same order.)
function twoSystemCase() {
  const others = seed.systems.filter((sys) => sys.id !== HOME.id).sort((a, b) => a.id.localeCompare(b.id));
  for (let k = OUTPOST_DEPLOY_RANGE + 1; k <= OUTPOST_DEPLOY_RANGE + 10; k += 1) {
    for (const dir of DIRS) {
      const target = along(HOME_HEX, dir, k);
      if (!isFree(target) || !isFree(along(HOME_HEX, dir, k - 1)) || !isFree(along(HOME_HEX, dir, k - DEPLOY_RETREAT_HEXES))) continue;
      const b = others.find((sys) => hexDistance(sys.coords, target) <= OUTPOST_DEPLOY_RANGE);
      if (b) return { b: b.id, dir, k, target };
    }
  }
  throw new Error('no two-system case on this seed');
}

// The payload the retreat must write for `craft` failing on `target` for `cause`, pulled toward `systemId`
// — spelled out field by field from docs/event-log.md §10.
const expectedPayload = (craft, target, cause, systemId) => ({
  cause,
  kind: 'outpost',
  targetHex: { q: target.q, r: target.r },
  craftId: craft.id,
  craftClass: HEAVY_TRANSPORT,
  retreatSystemId: systemId,
  retreatSystemName: getSystem(systemId).name,
});

// --- 1. a retreat writes exactly one row, with the full payload -------------------------------------

test('retreat on OCCUPIED: exactly one deploy_failed row, on the retreating guild, with the full payload', () => {
  const { s: flying, target, arrivalTick } = occupiedRun(8);
  assert.equal(flying.guilds[0].events, undefined, 'nothing is written at dispatch — only on arrival');
  const s = tickToIdle(flying);
  const g1 = s.guilds[0];
  const craft = craftOf(s);

  assert.equal(g1.events.length, 1, 'exactly one notice');
  assert.equal(g1.eventSeq, 1, 'one id taken from the guild counter');
  const row = g1.events[0];
  assert.deepEqual(row, {
    id: 0,
    tick: arrivalTick,
    type: 'deploy_failed',
    payload: expectedPayload(craft, target, 'occupied', HOME.id),
  }, 'born unread (no readTick), at the arrival tick, with the §10 payload');
  assert.ok(typeof row.payload.retreatSystemName === 'string' && row.payload.retreatSystemName !== HOME.id,
    'the retreat system is named by its SEED name, not its id');

  // ONE writer: the notice and the craft flag say the same thing, at the same tick.
  assert.deepEqual(craft.deployFailed, { reason: row.payload.cause, tick: row.tick });
  // targetHex is the hex it could NOT deploy on — not where it ended up — and is its own object.
  assert.notDeepEqual(craft.location, row.payload.targetHex, 'the craft was snapped off the target');
  assert.notEqual(row.payload.targetHex, craft.location);

  // The rival whose Outpost took the hex is told nothing — the notice is the retreating guild's own.
  assert.equal(s.guilds[1].events, undefined);
  assert.equal(s.guilds[1].eventSeq, undefined);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('retreat on OUT-OF-RANGE: cause "out-of-range", and the retreat system is the one still held', () => {
  const { b, dir, k, target } = twoSystemCase();
  let s = kitAt(along(HOME_HEX, dir, k - 1), { extraClaims: [claimOf('g1', b, 2)] });
  s = accept(s, deployTo(s, target)); // legal now: B holds the target in range
  const arrivalTick = craftOf(s).trip.arrivalTick;
  s.claims = s.claims.filter((c) => c.landmarkId !== b); // B is lost while the craft flies
  s = tickToIdle(s);

  assert.equal(s.guilds[0].events.length, 1);
  const row = s.guilds[0].events[0];
  assert.equal(row.tick, arrivalTick);
  assert.deepEqual(row.payload, expectedPayload(craftOf(s), target, 'out-of-range', HOME.id),
    'pulled back toward home — the only system left — not toward the lost B');
  assert.deepEqual(craftOf(s).deployFailed, { reason: 'out-of-range', tick: arrivalTick });
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. the retreat system is the one the craft actually moved toward --------------------------------

test('retreat system: with a NEARER second system held, the craft and the notice both go there', () => {
  const { b, dir, k, target } = twoSystemCase();
  assert.ok(hexDistance(getSystem(b).coords, target) < hexDistance(HOME_HEX, target), 'B is the nearer held system');
  let s = kitAt(along(HOME_HEX, dir, k - 1), { extraClaims: [claimOf('g1', b, 2)] });
  s = accept(s, deployTo(s, target));
  s = occupy(s, target); // B is kept this time; the hex is taken instead
  s = tickToIdle(s);

  const row = s.guilds[0].events[0];
  assert.deepEqual(row.payload, expectedPayload(craftOf(s), target, 'occupied', b));
  // The craft's landing is on the straight line from the target to the NAMED system (or at it): the notice
  // names the system the retreat really pulled toward.
  const landed = craftOf(s).location;
  const bHex = getSystem(b).coords;
  if (landed.landmarkKind === 'system') {
    assert.equal(landed.landmarkId, row.payload.retreatSystemId);
  } else {
    assert.equal(hexDistance(target, landed) + hexDistance(landed, bHex), hexDistance(target, bHex),
      `landed ${JSON.stringify(landed)} is on the line from ${JSON.stringify(target)} to ${b}`);
  }
});

test('retreat system: the CLAMP case lands AT the system the notice names', () => {
  for (const k of [DEPLOY_RETREAT_HEXES, 1]) {
    const { s: flying, target } = occupiedRun(k);
    const s = tickToIdle(flying);
    const row = s.guilds[0].events[0];
    assert.deepEqual(craftOf(s).location, { landmarkKind: 'system', landmarkId: row.payload.retreatSystemId },
      `${k} hexes out: parked at the named system`);
    assert.deepEqual(row.payload.targetHex, target);
  }
});

// --- 3. no retreat, no row ----------------------------------------------------------------------------

test('a SUCCESSFUL deploy writes no notice — the guild carries no events key at all', () => {
  const target = along(HOME_HEX, freeDirection(HOME_HEX, [3]), 3);
  let s = kitAt(AT_HOME);
  s = tickToIdle(accept(s, deployTo(s, target)));
  assert.equal(s.outposts.length, 1, 'the Outpost was placed');
  for (const g of s.guilds) {
    assert.ok(!('events' in g) && !('eventSeq' in g), `${g.id}: omit-when-empty — byte-identical to pre-slice`);
  }
});

test('two heavies on one hex in one tick: the lower id deploys, ONLY the other writes a row', () => {
  const dir = freeDirection(HOME_HEX, [6, 7, 3]);
  const target = along(HOME_HEX, dir, 6);
  let s = kitAt(along(HOME_HEX, dir, 7), { craft: 2 });
  s = accept(s, deployTo(s, target, 1));
  s = accept(s, deployTo(s, target, 0));
  s = tickToIdle(s);
  assert.equal(s.outposts.length, 1);
  assert.equal(s.guilds[0].events.length, 1, 'one retreat, one notice');
  assert.equal(s.guilds[0].events[0].payload.craftId, craftOf(s, 1).id, 'naming the craft that retreated');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a craft that flies with no deploy action never writes one', () => {
  const dir = freeDirection(HOME_HEX, [1, 2]);
  let s = kitAt(AT_HOME);
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: craftOf(s).id, waypoints: [along(HOME_HEX, dir, 2)] }));
  s = tickToIdle(s);
  assert.ok(!('events' in s.guilds[0]) && !('eventSeq' in s.guilds[0]));
});

// --- 4. determinism -------------------------------------------------------------------------------------

test('determinism: the written row is identical across a save/restore of the same retreat', () => {
  const direct = tickToIdle(occupiedRun(7).s);

  // Saved MID-FLIGHT, restored, flown on: the same row, the same bytes.
  let mid = occupiedRun(7).s;
  for (let i = 0; i < 100; i += 1) mid = tick(mid, []);
  assert.equal(mid.guilds[0].events, undefined, 'still in flight at the save — nothing written yet');
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-deploy-failed-'));
  try {
    saveState(mid, dirA);
    const restored = tickToIdle(loadOrInit(dirA, () => { throw new Error('expected the saved state to load'); }));
    assert.deepEqual(restored.guilds[0].events, direct.guilds[0].events);
    assert.equal(restored.guilds[0].eventSeq, direct.guilds[0].eventSeq);
    assert.equal(hashState(restored), hashState(direct));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
  }

  // Saved AFTER the retreat and restored: the row survives the round trip byte for byte.
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-deploy-failed-'));
  try {
    saveState(direct, dirB);
    const restored = loadOrInit(dirB, () => { throw new Error('expected the saved state to load'); });
    assert.deepEqual(restored.guilds[0].events, direct.guilds[0].events);
    assert.equal(hashState(restored), hashState(direct));
  } finally {
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

// --- 5. it rides the existing log machinery -------------------------------------------------------------

test('snapshot: the row surfaces in guilds[].events with whenDay (no unlockDay) and counts as unread', () => {
  const s = tickToIdle(occupiedRun(6).s);
  const stored = s.guilds[0].events[0];
  const snap = buildSnapshot(s);
  const surfaced = snap.guilds.find((g) => g.id === 'g1').events;
  assert.equal(surfaced.length, 1);
  // The cadence/anchor the snapshot derives days over — its own fallbacks (sim/snapshot.js), not re-chosen here.
  const windowN = s.windowN == null ? DEFAULT_WINDOW_N : s.windowN;
  const anchor = s.dayAnchorTick == null ? 0 : s.dayAnchorTick;
  assert.deepEqual(surfaced[0], { ...stored, whenDay: dayOf(stored.tick, windowN, anchor) },
    'the stored row verbatim plus the derived whenDay — no new field, no unlockDay (no node is held)');
  assert.deepEqual(snap.attention.notices, [{ guildId: 'g1', id: 0, tick: stored.tick, type: 'deploy_failed', payload: stored.payload }],
    'unread, so it lights the Messages badge');
});

test('acknowledge + retention: a deploy_failed row is read and aged out exactly as the other two types', () => {
  let s = tickToIdle(occupiedRun(6).s);
  const row = s.guilds[0].events[0];

  // Unread retention: live to RETENTION_UNREAD_TICKS from its tick, gone one tick later.
  assert.ok(isEventLive(row, row.tick + RETENTION_UNREAD_TICKS));
  assert.ok(!isEventLive(row, row.tick + RETENTION_UNREAD_TICKS + 1));

  // Acknowledge stamps readTick = now, once; a second ack does not re-stamp.
  s.tick += 10;
  const readAt = s.tick;
  ({ state: s } = intake(s, [createAcknowledgeEventAction({ guildId: 'g1', eventId: row.id })]));
  assert.equal(s.guilds[0].events[0].readTick, readAt);
  s.tick += 5;
  ({ state: s } = intake(s, [createAcknowledgeEventAction({ guildId: 'g1', eventId: row.id })]));
  assert.equal(s.guilds[0].events[0].readTick, readAt, 'idempotent');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assert.deepEqual(buildSnapshot(s).attention.notices, [], 'read — no longer counted unread');

  // Read retention: the snapshot drops it RETENTION_READ_TICKS after the read...
  s.tick = readAt + RETENTION_READ_TICKS + 1;
  assert.deepEqual(buildSnapshot(s).guilds.find((g) => g.id === 'g1').events, []);
  // ...and the next write prunes it from the stored log (the same shared predicate), its id never reused.
  recordEvent(s.guilds[0], s.tick, 'deploy_failed', { cause: 'occupied' });
  assert.deepEqual(s.guilds[0].events.map((e) => e.id), [1]);
});
