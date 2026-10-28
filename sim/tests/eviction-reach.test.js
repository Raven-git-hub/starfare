'use strict';

// eviction-reach.test.js — LOSING GROUND, engine PR 3: THE EVICTION'S REACH (design.md §19 #67, SETTLED 19-10-26;
// docs/territory-model.md §4 "AS-BUILT — losing ground, engine PR 3"; transport-model.md §11.6; exploration-model.md
// §5). A lost system now reaches past the evicted guild's own position there:
//
//   1. LANES END — EVERY guild's. A lane with a stop at the lost system (a waypoint anchored at it, with an action or
//      without) ends `system-lost`, the craft flagged and stamped and left where it stopped, its hold untouched. A
//      lane that only crosses the footprint, or stops at a bare hex inside it, runs on.
//   2. ARRAYS GO DARK — the evicting guild's. An array that touched only the lost system's control has its running
//      scan voided (`scan_voided`, reason 'anchor-lost'), stands on, and takes no job while dark; one still touching
//      other held ground keeps its scan and its queue; a rival's is untouched. Dark is derived, so re-holding the
//      ground wakes it. The same rule holds when an Outpost leaves the map (reclaim / remove) — the other way an
//      array loses its attachment.
//   3. OUTPOSTS ARE UNTOUCHED — an Outpost in the lost system's disk stands, and can still be packed up.
//   4. THE TRIPWIRE BITES — a running scan on a dark array turns the invariant red, and the tick loop halts on it.
//   5. BYTE-IDENTITY — a galaxy that never abandons hashes exactly as it did on `main` (pinned goldens), and an
//      abandon replays and repeats to the same bytes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { hashState } = require('../serialize.js');
const { createDeepScanArray } = require('../state.js');
const { advance } = require('../run.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { getSystem, getClaimRadius, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT } = require('../vehicles.js');
const { LANE_END_REASONS, endLane } = require('../routes.js');
const { isArrayAttached, SCAN_VOID_ANCHOR_LOST, SCAN_TICKS } = require('../deep-scan-arrays.js');
const {
  applyAction, createAbandonPrefectureAction, createQueueScanAction, createReclaimOutpostAction,
  createRemoveOutpostAction, createSpawnOutpostAction, createDispatchVehicleAction, createDispatchRouteWithActionsAction,
  createGrantAssetAction, createGrantKitAction, createLoadKitAction, createLoadAssetAction, createUnloadAssetAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const R = require('./eviction-reach-script.js');

const { accept, refuse, ticks, tickUntil, g1Of, HOME, AT_HOME, HOME_HEX, TARGET, AT_TARGET, SLOT_A1 } = P;
const { reachGalaxy, planted, deployArray, spawn, scanL1, lane, SCAN_TARGETS, OUTPOST_HEX } = R;

const abandon = (prefectureId = 'prefecture_g1_01') => createAbandonPrefectureAction({ guildId: 'g1', prefectureId });
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const craftOf = (s, guildId, id) => guildOf(s, guildId).vehicles.find((v) => v.id === id);
const arrayOf = (s, id) => s.deepScanArrays.find((a) => a.id === id);
const eventsOf = (s, guildId, type) => (guildOf(s, guildId).events || []).filter((e) => e.type === type);
const queue = (guildId, arrayId, target) => createQueueScanAction({ guildId, arrayId, level: 'L1', targetSystemId: target });
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const darkReason = (array) => `Deep Scan Array "${array.id}" is dark — its hex { q: ${array.coords.q}, r: ${array.coords.r} } is no longer in or beside any territory guild "g1" holds; it takes no scan until the guild's control reaches it again`;

// evicted() -> reachGalaxy() and then g1 abandons TARGET's Prefecture, on the same tick. `before` is the galaxy the
// abandon was applied to.
function evicted() {
  const g = reachGalaxy();
  return { ...g, before: g.s, s: accept(g.s, abandon()) };
}

// --- 1. lanes ---------------------------------------------------------------------------------------------------------

test('LANES END — every guild\'s: g1\'s lane (a dock at the lost system) and g2\'s (a mere turning point there) both end `system-lost`, flagged and stamped with the tick; nothing else about the craft moves', () => {
  assert.ok(LANE_END_REASONS.includes('system-lost'));
  const { before, s, craft } = evicted();
  for (const [guildId, id] of [['g1', craft.stop], ['g2', craft.rivalStop]]) {
    const was = craftOf(before, guildId, id);
    const now = craftOf(s, guildId, id);
    assert.ok(was.route, `${id} was running a lane`);
    assert.equal(now.route, undefined, `${id}'s lane is dropped`);
    assert.deepEqual(now.laneEnded, { reason: 'system-lost', tick: s.tick });
    assert.equal(now.updatedAtTick, s.tick, 'the mutation records its tick (§15.2)');
    // Ending a lane drops the route, never anything else: the status, the leg in flight, and the hold are as they were.
    assert.deepEqual(without(now, 'laneEnded', 'updatedAtTick'), without(was, 'route', 'updatedAtTick'));
  }
  assert.deepEqual(craftOf(s, 'g1', craft.stop).cargo, { titanium: 10 }, 'the goods aboard stay aboard');
});

test('LANES END — each craft is left where it stopped: in flight, it finishes the leg it is on and lands idle at its end — then stays there, an ordinary idle craft a dispatch re-tasks', () => {
  let { s, craft } = evicted();
  const both = [['g1', craft.stop], ['g2', craft.rivalStop]];
  // Both were flying their first leg, toward the lost system, when the lane ended.
  for (const [g, id] of both) assert.deepEqual(craftOf(s, g, id).trip.legs.slice(-1)[0].to, AT_TARGET);
  s = tickUntil(s, (x) => both.every(([g, id]) => craftOf(x, g, id).status === 'idle'));
  const landedAt = s.tick;
  s = ticks(s, 30); // and nothing moves them on
  for (const [g, id] of both) {
    const v = craftOf(s, g, id);
    assert.deepEqual(v.location, AT_TARGET);
    assert.equal(v.status, 'idle');
    assert.equal(v.route, undefined);
    assert.equal(v.laneEnded.reason, 'system-lost', `the flag stays on ${id} until it is re-dispatched`);
  }
  assert.ok(s.tick > landedAt);
  // No dock ran at the lost system: the lane that would have loaded there was gone before it landed.
  assert.deepEqual(craftOf(s, 'g1', craft.stop).cargo, { titanium: 10 });
  // An ordinary idle craft: a plain dispatch takes it, and clears the flag.
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: craft.stop, waypoints: [AT_HOME] }));
  assert.equal(craftOf(s, 'g1', craft.stop).laneEnded, undefined);
});

test('LANES RUN ON — a lane that only CROSSES the lost system\'s footprint, and one that stops at a bare hex INSIDE it, are not stops at the system: untouched, and still flying laps', () => {
  const { before, s: after, craft } = evicted();
  for (const id of [craft.transit, craft.inside]) {
    assert.deepEqual(craftOf(after, 'g1', id), craftOf(before, 'g1', id), `${id} is byte-for-byte as it was`);
  }
  // The transit leg really does run through the footprint: its two stops lie either side of TARGET's centre, just
  // outside its disk; the inside stop really is in the disk.
  const r = getClaimRadius(TARGET);
  const centre = getSystem(TARGET).coords;
  const dist = (h) => Math.max(Math.abs(h.q - centre.q), Math.abs(h.r - centre.r), Math.abs((h.q + h.r) - (centre.q + centre.r)));
  assert.deepEqual([R.CROSS_A, R.CROSS_B].map(dist), [r + 1, r + 1]);
  assert.equal(R.CROSS_A.q + R.CROSS_B.q, 2 * centre.q);
  assert.equal(R.CROSS_A.r + R.CROSS_B.r, 2 * centre.r);
  assert.ok(dist(R.INSIDE) <= r);
  // They keep going: every invariant holds each tick, and each lane finishes a lap and starts the next.
  const lapped = (x, id) => craftOf(x, 'g1', id).route && craftOf(x, 'g1', id).route.lapsDone >= 1;
  const s = tickUntil(after, (x) => lapped(x, craft.transit) && lapped(x, craft.inside));
  for (const id of [craft.transit, craft.inside]) assert.equal(craftOf(s, 'g1', id).laneEnded, undefined);
});

test('LANES END — what is aboard stays aboard: a salvaged MACHINE on a heavy whose route stops at the lost system, and a KIT on another, ride on in their holds', () => {
  // A machine in hand: g1 abandons TARGET with a miner there (stranded), loads it onto its heavy at TARGET (the
  // salvage run's pickup), then re-claims TARGET and sends the laden heavy out and back — a one-shot route of
  // turning points with a stop at TARGET — and abandons TARGET again.
  let s = planted();
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'miner', systemId: TARGET }));
  const miner = g1Of(s).assets.filter((a) => a.kind === 'miner').slice(-1)[0].id;
  s = accept(s, abandon());
  s = accept(s, createLoadAssetAction({ guildId: 'g1', vehicleId: P.HEAVY, assetId: miner }));
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: P.HEAVY, waypoints: [{ anchor: AT_HOME }, { anchor: AT_TARGET }] }));
  // A kit in hand: a second heavy loads an Outpost kit at HOME and flies a turning-point route to TARGET.
  let kitHeavy;
  ({ s, id: kitHeavy } = spawn(s, 'g1', HEAVY_TRANSPORT, AT_HOME));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'outpost' }));
  const outpostKit = g1Of(s).assets.filter((a) => a.kind === 'outpost').slice(-1)[0].id;
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: kitHeavy, assetId: outpostKit }));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: kitHeavy, waypoints: [{ anchor: AT_TARGET }] }));

  s = accept(s, abandon('prefecture_g1_02'));
  for (const id of [P.HEAVY, kitHeavy]) {
    assert.equal(craftOf(s, 'g1', id).route, undefined);
    assert.deepEqual(craftOf(s, 'g1', id).laneEnded, { reason: 'system-lost', tick: s.tick });
  }
  assert.equal(craftOf(s, 'g1', P.HEAVY).carryingAssetId, miner, 'the machine is still aboard');
  assert.equal('stranded' in g1Of(s).assets.find((a) => a.id === miner), false, 'in the hold, not left in the system');
  assert.deepEqual(craftOf(s, 'g1', kitHeavy).cargo, { outpost_kit: 1 }, 'the kit is still aboard');
  // The machine's heavy was flying its first leg, home: it lands there and unloads the machine as salvage always does.
  s = tickUntil(s, (x) => craftOf(x, 'g1', P.HEAVY).status === 'idle');
  assert.deepEqual(craftOf(s, 'g1', P.HEAVY).location, AT_HOME);
  s = accept(s, createUnloadAssetAction({ guildId: 'g1', vehicleId: P.HEAVY }));
  assert.equal(g1Of(s).assets.find((a) => a.id === miner).systemId, HOME.id);
});

test('LANES END — a craft mid-turnaround in an Outpost dock finishes the transfer there and stays parked', () => {
  let { s } = reachGalaxy();
  let docker;
  ({ s, id: docker } = spawn(s, 'g1', LIGHT_TRANSPORT, OUTPOST_HEX));
  // A lane whose first stop is the Outpost the craft sits on (it docks in place) and whose second is TARGET.
  s = accept(s, lane('g1', docker, [
    { anchor: OUTPOST_HEX, action: { type: 'dock', manifest: [{ dir: 'load', good: 'titanium', max: true }] } },
    { anchor: AT_TARGET },
  ]));
  s = tickUntil(s, (x) => craftOf(x, 'g1', docker).status === 'loading');
  s = accept(s, abandon());
  assert.equal(craftOf(s, 'g1', docker).route, undefined);
  assert.equal(craftOf(s, 'g1', docker).status, 'loading', 'the turnaround under way is not cut short');
  s = tickUntil(s, (x) => craftOf(x, 'g1', docker).status === 'idle');
  s = ticks(s, 10);
  assert.deepEqual(craftOf(s, 'g1', docker).location, OUTPOST_HEX, 'parked at the Outpost, not sent on to TARGET');
  assert.equal(craftOf(s, 'g1', docker).laneEnded.reason, 'system-lost');
});

// --- 2. arrays --------------------------------------------------------------------------------------------------------

test('ARRAYS GO DARK — the array that touched only the lost system: its scan voided (`scan_voided`, reason `anchor-lost`, before the `system_lost`), the array standing and stamped; an idle one there is left as it was', () => {
  const { before, s, arrays: { dark, idleDark } } = evicted();
  const was = arrayOf(before, dark);
  assert.ok(was.scan, 'it was scanning');
  assert.deepEqual(arrayOf(s, dark), { ...without(was, 'scan'), updatedAtTick: s.tick }, 'standing, its job gone, the void stamped');
  assert.equal(isArrayAttached(s, arrayOf(s, dark)), false);
  // ONE notice, self-contained, the completion notices' description of the job plus the reason.
  assert.deepEqual(eventsOf(s, 'g1', 'scan_voided').map((e) => ({ tick: e.tick, payload: e.payload })), [{
    tick: s.tick,
    payload: { arrayId: dark, level: 'L1', targetSystemId: SCAN_TARGETS[0], targetName: getSystem(SCAN_TARGETS[0]).name, reason: SCAN_VOID_ANCHOR_LOST },
  }]);
  assert.equal(SCAN_VOID_ANCHOR_LOST, 'anchor-lost');
  // The loss is the newest notice; the dark array's void sits just beneath it.
  assert.deepEqual(g1Of(s).events.slice(-2).map((e) => e.type), ['scan_voided', 'system_lost']);
  // The idle dark array had nothing to void: no notice, no stamp — the row exactly as it was.
  assert.deepEqual(arrayOf(s, idleDark), arrayOf(before, idleDark));
  assert.equal(isArrayAttached(s, arrayOf(s, idleDark)), false);
  // Nothing was revealed: the voided target is not in the record.
  assert.deepEqual(g1Of(s).exploration, g1Of(before).exploration);
});

test('ARRAYS GO DARK — a dark array takes no new job: queueScan refuses it, in its own words (the idle one too)', () => {
  const { s, arrays: { dark, idleDark } } = evicted();
  for (const id of [dark, idleDark]) {
    assert.equal(refuse(s, queue('g1', id, SCAN_TARGETS[3])), darkReason(arrayOf(s, id)));
  }
});

test('ARRAYS STAY LIT — an array that also touches another held system keeps its scan, finishes it, and takes the next; a RIVAL\'s array is untouched', () => {
  const { before, s: after, arrays: { lit, rival } } = evicted();
  assert.deepEqual(arrayOf(after, lit), arrayOf(before, lit), 'its scan intact, no stamp');
  assert.equal(isArrayAttached(after, arrayOf(after, lit)), true);
  assert.deepEqual(arrayOf(after, rival), arrayOf(before, rival));
  assert.deepEqual(guildOf(after, 'g2').events, guildOf(before, 'g2').events, 'g2 is told nothing');
  // Run the lit scan home (every invariant every tick) — it completes as any scan does — and queue the next.
  let s = tickUntil(after, (x) => !arrayOf(x, lit).scan);
  assert.equal(s.tick, arrayOf(before, lit).scan.completeTick);
  assert.deepEqual(eventsOf(s, 'g1', 'scan_complete').map((e) => e.payload.arrayId), [lit]);
  s = accept(s, queue('g1', lit, SCAN_TARGETS[3]));
  assert.equal(arrayOf(s, lit).scan.completeTick, s.tick + SCAN_TICKS.L1);
});

test('DARK IS DERIVED, SO IT LIFTS: once g1 holds TARGET again the dark arrays take jobs — nothing stored to clear, no notice', () => {
  let { s, arrays: { dark, idleDark } } = evicted();
  const logLength = g1Of(s).events.length;
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  assert.equal(isArrayAttached(s, arrayOf(s, dark)), true);
  s = accept(s, queue('g1', dark, SCAN_TARGETS[0]));
  s = accept(s, queue('g1', idleDark, SCAN_TARGETS[3]));
  assert.equal(g1Of(s).events.length, logLength, 'waking writes nothing');
  // The stamp records voids only: waking writes nothing to the row, and the new job carries its own startedTick.
  // (All of this ran on the abandon's tick, so the void's stamp is this tick.)
  assert.equal(arrayOf(s, dark).updatedAtTick, s.tick);
  s = ticks(s, 5);
});

// outpostGalaxy() -> g1 holding HOME only, with an Outpost three hexes out and two arrays beside it, each scanning:
// `alone` on the far side (it touches the Outpost and nothing else) and `homeSide` between it and HOME (it touches
// HOME's control too). An empty heavy is parked on the Outpost, ready to pack it.
function outpostGalaxy() {
  const ring = getClaimRadius(HOME.id);
  const at = (d, n) => ({ q: HOME_HEX.q + n * d.q, r: HOME_HEX.r + n * d.r });
  const bare = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
  const d = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }]
    .find((x) => [ring + 1, ring + 2, ring + 3].every((n) => bare(at(x, n))));
  let s = P.kitGalaxy({ fuelHoard: 5_000 });
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: at(d, ring + 2) }));
  let alone; let homeSide; let packer;
  ({ s, id: alone } = deployArray(s, 'g1', HOME.id, at(d, ring + 3)));
  ({ s, id: homeSide } = deployArray(s, 'g1', HOME.id, at(d, ring + 1)));
  s = accept(s, scanL1('g1', alone, SCAN_TARGETS[0]));
  s = accept(s, scanL1('g1', homeSide, SCAN_TARGETS[1]));
  ({ s, id: packer } = spawn(s, 'g1', HEAVY_TRANSPORT, at(d, ring + 2)));
  return { s, alone, homeSide, packer, outpost: s.outposts[0].id };
}

test('THE SAME RULE WHEN AN OUTPOST GOES — packing up (or the operator removing) the Outpost an array touched alone darkens it: its scan voided `anchor-lost`; the array also touching HOME keeps its scan', () => {
  const g = outpostGalaxy();
  // The player's reclaim: the void is written first, then the reclaim's own `outpost_packed`, the newest.
  let s = accept(g.s, createReclaimOutpostAction({ guildId: 'g1', outpostId: g.outpost }));
  assert.equal(arrayOf(s, g.alone).scan, undefined);
  assert.equal(arrayOf(s, g.alone).updatedAtTick, s.tick);
  assert.deepEqual(arrayOf(s, g.homeSide), arrayOf(g.s, g.homeSide));
  assert.deepEqual(g1Of(s).events.slice(-2).map((e) => [e.type, e.payload.reason || e.payload.outpostId]), [
    ['scan_voided', 'anchor-lost'], ['outpost_packed', g.outpost],
  ]);
  assert.equal(refuse(s, queue('g1', g.alone, SCAN_TARGETS[3])), darkReason(arrayOf(s, g.alone)));
  s = ticks(s, 5);
  // The operator's remove: the same void.
  s = accept(g.s, createRemoveOutpostAction({ guildId: 'g1', outpostId: g.outpost }));
  assert.equal(arrayOf(s, g.alone).scan, undefined);
  assert.deepEqual(eventsOf(s, 'g1', 'scan_voided').map((e) => e.payload.reason), ['anchor-lost']);
  assert.deepEqual(arrayOf(s, g.homeSide), arrayOf(g.s, g.homeSide));
  s = ticks(s, 5);
});

// --- 3. outposts ------------------------------------------------------------------------------------------------------

test('OUTPOSTS ARE UNTOUCHED — an Outpost inside the lost system\'s disk, anchored to it, stands exactly as it was, and can still be packed up', () => {
  const { before, s: after, outpost } = evicted();
  const row = (x) => x.outposts.find((o) => o.id === outpost);
  assert.equal(row(before).anchorSystemId, TARGET);
  assert.deepEqual(row(after), row(before), 'the row is byte-for-byte as it was');
  // Still reclaimable: park an empty heavy on it and pack it into the heavy's hold.
  let s = after;
  let packer;
  ({ s, id: packer } = spawn(s, 'g1', HEAVY_TRANSPORT, OUTPOST_HEX));
  s = accept(s, createReclaimOutpostAction({ guildId: 'g1', outpostId: outpost }));
  assert.equal((s.outposts || []).some((o) => o.id === outpost), false);
  assert.deepEqual(craftOf(s, 'g1', packer).cargo, { outpost_kit: 1 });
});

// --- 4. the tripwire --------------------------------------------------------------------------------------------------

test('THE TRIPWIRE BITES — a running scan on a dark array is red: an eviction that skipped the void, or a queueScan forced past its gate', () => {
  const RULE = 'deepScanArray-scan-only-while-attached (exploration-model.md §5; design.md §19 #67)';
  const { before, arrays: { dark, idleDark } } = evicted();
  // An eviction that unclaimed TARGET but voided nothing: the dark array is left holding its job.
  const skipped = structuredClone(before);
  const prefecture = skipped.prefectures.find((p) => p.id === 'prefecture_g1_01');
  skipped.claims = skipped.claims.filter((c) => c.claimId !== prefecture.claimId);
  skipped.prefectures = skipped.prefectures.filter((p) => p.id !== prefecture.id);
  if (skipped.prefectures.length === 0) delete skipped.prefectures;
  assert.deepEqual(checkInvariants(skipped, skipped.tick).map((v) => [v.rule, v.where]), [[RULE, `deepScanArray:${dark}.scan`]]);
  // The tick loop halts on it, naming the tick and the rule, rather than carry on.
  assert.throws(() => advance(skipped, []), (err) => /Invariant violation at tick \d+/.test(err.message) && err.message.includes(RULE));
  // A queueScan forced past the gate (applyAction does not validate) onto the idle dark array: red the same way.
  const { s } = evicted();
  const forced = applyAction(s, queue('g1', idleDark, SCAN_TARGETS[3]));
  assert.deepEqual(checkInvariants(forced, forced.tick).map((v) => [v.rule, v.where]), [[RULE, `deepScanArray:${idleDark}.scan`]]);
  // And clean on the real thing.
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('THE TRIPWIRE BITES — the void\'s stamp is a tick in the array\'s life; an unknown lane-end reason halts at once', () => {
  const RULE = 'deepScanArray-updatedAtTick-in-the-array-lifetime (§15.2)';
  const { s, arrays: { dark } } = evicted();
  for (const bad of [s.tick + 1, -1, 1.5, '450']) {
    const x = structuredClone(s);
    arrayOf(x, dark).updatedAtTick = bad;
    assert.deepEqual(checkInvariants(x, x.tick).map((v) => v.rule), [RULE], `updatedAtTick ${JSON.stringify(bad)}`);
  }
  assert.throws(() => endLane({ id: 'v1', route: {} }, 'lost', 7), /endLane, tick 7: vehicle "v1" given an unknown reason "lost"/);
});

// --- 5. byte-identity, persistence, determinism ----------------------------------------------------------------------

// The hashes `main` gave at 291df19 for reachGalaxy() — on one tick, and after 760 more (the scans complete and the
// lanes fly several laps) — with no abandon: computed by running tests/eviction-reach-script.js on that commit.
const GOLDEN_NO_ABANDON = {
  launched: {
    tick: 450,
    state: '7cb864d85b94f6573ec6094865c17c08fb445b87f34ed2ff0d0f9a2bd9de2b65',
    god: 'e1c90f32da15d3a9c9d8051c5117cff9515e65eecb6b6198c84813b7747ee52e',
    own: 'f9d1f40680b5b11f61636a003cf10fe8ca133b1233b5e9c78c9b5a6122b6cd10',
    rival: '2456dc158ced7261c717ad3c2087cc981b1e22beef8abb9a553a5ef9a47717e1',
  },
  ticked: {
    tick: 1210,
    state: '7d59048bc92dc6bd2250060507602db2829e8643c87e2a3121cb22cf98e64c53',
    god: 'feec6e2bb4e1c2dee7f982360a6fb1b95eed200768f62b1bd54fb55c98a89bb7',
    own: '910997b2c437e33ad92f7b80f47587124f7889a042d6e027a99845bc5b60d264',
    rival: '7cc0380adbb38665dc0aba2ec72c0a45d870b8c1e85b39532ed306e3559a7a3a',
  },
};

test('BYTE-IDENTICAL: a galaxy with lanes, scanning arrays and an Outpost around a held system, that never abandons, serializes exactly as on `main` (state and every view)', () => {
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const digest = (s) => ({ tick: s.tick, state: hashState(s), god: sha(buildSnapshot(s)), own: sha(buildSnapshot(s, 'g1')), rival: sha(buildSnapshot(s, 'g2')) });
  const { s } = reachGalaxy();
  assert.deepEqual(digest(s), GOLDEN_NO_ABANDON.launched);
  assert.deepEqual(digest(ticks(s, 760)), GOLDEN_NO_ABANDON.ticked);
});

test('PERSISTENCE: a journalled abandon replays to the same bytes, and ticks on identically; a saved dark array keeps its stamp, and the row constructor copies it', () => {
  const { s: held, arrays: { dark } } = reachGalaxy();
  const direct = accept(held, abandon());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eviction-reach-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eviction-reach-'));
  try {
    saveState(held, dir);
    appendJournal(held.tick, abandon(), dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct));
    assert.equal(hashState(ticks(replayed, 20)), hashState(ticks(direct, 20)));
    saveState(direct, dir2);
    const reloaded = loadOrInit(dir2, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(reloaded), hashState(direct));
    assert.equal(arrayOf(reloaded, dark).updatedAtTick, direct.tick);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  // A createState hand-in builds each array through createDeepScanArray, which keeps the stamp (and omits it when absent).
  const row = arrayOf(direct, dark);
  assert.deepEqual(createDeepScanArray(row), row);
  assert.equal('updatedAtTick' in createDeepScanArray(without(row, 'updatedAtTick')), false);
});

test('DETERMINISM: the same galaxy and the same abandon give the same bytes, and every invariant holds for 800 ticks after it', () => {
  const a = evicted().s;
  const b = evicted().s;
  assert.equal(hashState(a), hashState(b));
  assert.equal(hashState(ticks(a, 800)), hashState(ticks(b, 800)));
});
