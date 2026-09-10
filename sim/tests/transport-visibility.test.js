'use strict';

// transport-visibility.test.js — the ENGINE half of the transport-visibility
// slice (docs/transport-model.md §2.3/§3/§6, Phase 2). The game already runs the
// Syndicate tier but the snapshot could not yet show an in-flight delivery as a
// craft sliding along its leg. This pins what the snapshot now surfaces on each
// in-flight shipment so the client (the FOLLOWING slice) can draw the leg and
// tween the craft's position along it:
//
//   - the leg's START endpoint — `originOutpostId` / `originCoords`, the nearest
//     waystation (the destination endpoint is the already-present
//     `destinationSystemId`, whose coords the client resolves like any system);
//   - `departureTick` — the second of §2.3's two ticks (`arrivalTick` is already
//     surfaced), so the two together recover `legProgress` at any tick.
//
// All three are DERIVED on read from `destinationSystemId` + `arrivalTick` + the
// seed geometry — no stored byte on `state.shipments` (§15.5). The engine
// publishes endpoints + the two ticks, NOT a progress fraction; §6 rules the
// client re-derives the smooth position for rendering. So this test computes the
// §2.3 formula itself, to pin the exact contract the client will implement.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createBuyFromSyndicateAction, validateAction, applyAction,
} = require('../actions.js');

// A starter home a small even distance from its nearest waystation — the same
// DERIVED fixture buy.test.js uses, so the arrival tick stays cheap and the
// origin is a real seed waystation rather than a pinned id.
const DEST_HOME = starterHomeAtDistance(6);
const DEST = DEST_HOME.id;
const DEST_HOME_PLANET = DEST_HOME.homePlanet;
const GOOD = 'titanium';

// A guild homed on DEST, funded so invariant 2 starts balanced and fuelled above
// the route burn — mirrors buy.test.js's buyState, trimmed to what this file needs.
function buyState() {
  return createState({
    guilds: [{
      id: 'g1',
      credits: 100000,
      fuelHoard: GUILD_STARTING_FUEL,
      homeSystemId: DEST,
      homePlanetId: DEST_HOME_PLANET,
      stockpiles: {},
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -100000 },
    claims: [{
      claimId: 'claim_home_g1',
      ownerGuildId: 'g1',
      landmarkId: DEST,
      landmarkKind: 'system',
      claimedAtTick: 0,
      contested: false,
    }],
  });
}

function placeBuy(state) {
  const action = createBuyFromSyndicateAction({ guildId: 'g1', good: GOOD, qty: 5, destinationSystemId: DEST });
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected the BUY to be accepted, got: ${reason}`);
  return applyAction(state, action);
}

// The §2.3 contract, recomputed here so the test pins the formula the client
// must implement off the two surfaced ticks — not re-imported from anywhere.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const legProgress = (T, departureTick, arrivalTick) =>
  clamp01((T - departureTick) / (arrivalTick - departureTick));

test('a placed BUY shipment surfaces its leg origin and departureTick (transport-model §2.3/§6)', () => {
  const after = placeBuy(buyState());
  const snap = buildSnapshot(after);

  assert.equal(snap.shipments.length, 1);
  const row = snap.shipments[0];

  // The leg's START endpoint is the nearest waystation — id and coords straight
  // from the engine's own `nearestWaystation`, the single source the client
  // cannot compute for itself.
  const near = nearestWaystation(DEST);
  assert.equal(row.originOutpostId, near.outpost.id);
  assert.deepEqual(row.originCoords, near.outpost.coords);

  // departureTick is the second of §2.3's two ticks: arrivalTick minus the leg's
  // DURATION (`arrivalTickFor(0, distance)` = `legTicks`). The pair brackets the
  // flight.
  assert.equal(row.departureTick, row.arrivalTick - arrivalTickFor(0, near.distance));
  assert.ok(row.departureTick <= row.arrivalTick, 'the craft departs no later than it arrives');

  // The already-present fields are untouched — the destination endpoint the
  // client resolves itself, and the one counter derive.
  assert.equal(row.destinationSystemId, DEST);
  assert.equal(row.ticksRemaining, Math.max(0, row.arrivalTick - snap.tick));
});

test('the two ticks pin legProgress to the §2.3 endpoints: 0 at departure, 1 at arrival', () => {
  const after = placeBuy(buyState());
  const near = nearestWaystation(DEST);
  const departureTick = after.shipments[0].arrivalTick - arrivalTickFor(0, near.distance);
  const { arrivalTick } = after.shipments[0];

  // A degenerate leg (origin === destination, zero duration) would make the
  // client's clamp01 divide by zero — the fixture's even distance rules that out,
  // and we assert the flight really has length so the endpoint contract is meaningful.
  assert.ok(arrivalTick > departureTick, 'the fixture flight has non-zero duration');

  // At departure the craft is AT the origin (legProgress 0); at arrival it is AT
  // the destination (legProgress 1) — computed off the SAME two ticks the snapshot
  // surfaces, at the matching snapshot tick.
  for (const [T, expected] of [[departureTick, 0], [arrivalTick, 1]]) {
    const snap = buildSnapshot({ ...after, tick: T });
    const row = snap.shipments[0];
    assert.equal(legProgress(snap.tick, row.departureTick, row.arrivalTick), expected);
  }

  // And a tick in between interpolates strictly between the endpoints — the
  // tween the client draws each frame.
  const mid = Math.floor((departureTick + arrivalTick) / 2);
  const f = legProgress(mid, departureTick, arrivalTick);
  assert.ok(f > 0 && f < 1, 'a mid-flight tick sits strictly between the endpoints');
});

test('ticksRemaining is unchanged by the leg fields — still arrivalTick − tick, floored at 0', () => {
  const after = placeBuy(buyState());
  const { arrivalTick } = after.shipments[0];

  // Mid-flight: the counter counts down.
  const mid = Math.floor(arrivalTick / 2);
  assert.equal(buildSnapshot({ ...after, tick: mid }).shipments[0].ticksRemaining, arrivalTick - mid);

  // Past the arrival tick: floored at 0, never negative (the pre-slice rule).
  assert.equal(buildSnapshot({ ...after, tick: arrivalTick + 50 }).shipments[0].ticksRemaining, 0);
});

test('defensive: a shipment whose nearestWaystation is null omits the three leg fields but still surfaces', () => {
  // A hand-built in-flight shipment to a destination the seed does not resolve
  // (`nearestWaystation` → null). This should not happen for a real BUY — the
  // action gates on a held, resolvable system — but the snapshot must degrade
  // gracefully rather than throw, keeping the row's cargo + ticks.
  const state = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: null, homePlanetId: null, stockpiles: {} }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    shipments: [{
      ownerGuildId: 'g1',
      cargo: { [GOOD]: 3 },
      destinationSystemId: 'no_such_system_id',
      arrivalTick: 1234,
    }],
  });
  assert.equal(nearestWaystation('no_such_system_id'), null);

  const row = buildSnapshot(state).shipments[0];

  // The row still surfaces with its cargo + both counter/schedule fields.
  assert.equal(row.ownerGuildId, 'g1');
  assert.deepEqual(row.cargo, { [GOOD]: 3 });
  assert.equal(row.destinationSystemId, 'no_such_system_id');
  assert.equal(row.arrivalTick, 1234);
  assert.equal(row.ticksRemaining, Math.max(0, 1234 - state.tick));

  // But the three leg fields are OMITTED, not present-and-null — there is no leg
  // to draw.
  assert.equal('originOutpostId' in row, false);
  assert.equal('originCoords' in row, false);
  assert.equal('departureTick' in row, false);
});
