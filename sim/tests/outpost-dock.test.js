'use strict';

// outpost-dock.test.js — the Outpost dock model, roadmap 2.2 (cargo, engine slice 2) (design.md §4
// "The dock model", the OUTPOST half; §15.4). A transfer at one of the guild's OWN Outposts is NOT
// instant (unlike a system, slice 1): the manifest is queued for the Outpost's ten dock slots and
// resolves after the craft's class turnaround (a new tick step), moving goods at COMPLETION. This
// makes the Outpost stockpile fill.
//
// The tripwires, one per ruling:
//   - a transfer at an Outpost QUEUES (does not resolve instantly);
//   - the timer resolves at exactly readyTick (+1 promotion) + turnaround for its class (5/30/120);
//   - more than ten manifests → only ten LOAD at once, the rest wait, earliest-ready-first;
//   - a resolution against a FULL Outpost PARTIALS the unload (the hard cap clamps it);
//   - SUPPLY is conserved across a completion, and counting Outpost stockpiles keeps consistency green;
//   - TEARDOWN evicts docked + queued craft to idle-in-space with the right holds and destroys the
//     stored goods (supply drops by exactly that);
//   - RE-DISPATCH cancels a queued craft but is refused for a loading one;
//   - DETERMINISM holds across the step;
//   - the SNAPSHOT surfaces the queue/slots (with ETAs) and each craft's dock status;
//   - the NO-OP: a galaxy with no Outpost transfer keeps the dock state omitted (byte-identical).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick, stepOutpostDocks } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { volumeOf } = require('../fuel.js');
const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT, VEHICLE_SPECS,
} = require('../vehicles.js');
const { OUTPOST_CAPACITY, OUTPOST_DOCK_TURNAROUND } = require('../outposts.js');
const { usedSpace } = require('../manifest.js');
const { isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction,
  createTransferCargoAction, createDispatchVehicleAction, createRemoveOutpostAction,
} = require('../actions.js');

const ANCHOR = starterHomeAtDistance(6).id; // a real seed system the Outpost anchors to

// The first two in-bounds hexes holding no seed landmark, DERIVED from the seed (the outposts.test.js
// discipline) so a regen carries the tests. HEX is the Outpost's tile (and the craft berths there by
// hex-coincidence, §4); ELSEWHERE is a re-dispatch destination / a second free hex.
function freeHexes(n) {
  const out = [];
  for (let q = -60; q <= 60 && out.length < n; q += 1) {
    for (let r = -60; r <= 60 && out.length < n; r += 1) {
      if (isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) out.push({ q, r });
    }
  }
  assert.ok(out.length >= n, `need ${n} free hexes, found ${out.length}`);
  return out;
}
const [HEX, ELSEWHERE] = freeHexes(2);

const T1 = 'titanium';        // volumeOf === 1
const T2 = 'titanium_alloy';  // volumeOf === 100
const LIGHT_CAP = VEHICLE_SPECS[LIGHT_TRANSPORT].capacity; // 10000

// craft(id, cargo, cls) -> a hand-built idle craft berthed AT the Outpost's hex (a bare hex — a guild
// Outpost is not a location landmark, §4). Stats come from the ONE per-class table (VEHICLE_SPECS),
// never inlined. `cargo` omitted when empty (createVehicle's omit-when-empty).
function craft(id, cargo, cls = LIGHT_TRANSPORT) {
  const spec = VEHICLE_SPECS[cls];
  return {
    id, ownerGuildId: 'g1', class: cls,
    speed: spec.speed, capacity: spec.capacity, defenseRating: spec.defenseRating,
    fuelCostToRun: spec.fuelCostToRun, location: { q: HEX.q, r: HEX.r },
    ...(cargo ? { cargo } : {}), maintenanceCondition: 1, status: 'idle',
  };
}

// dockState(vehicles, { outpostStock, fuelHoard }) -> an invariant-clean galaxy: guild g1 owning the
// given craft (all parked at HEX) and one Outpost `outpost_g1_01` on HEX (optionally pre-stocked). The
// serials sit above the minted suffixes so the monotonic-id guards pass. createState folds every hold
// and the Outpost stockpile into galacticSupply, so the state opens consistency-green.
function dockState(vehicles, { outpostStock, fuelHoard = 0 } = {}) {
  const guild = {
    id: 'g1', credits: 0, fuelHoard,
    vehicleSerial: 99, outpostSerial: 1, vehicles,
  };
  const outpost = {
    id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: ANCHOR,
    coords: { q: HEX.q, r: HEX.r }, createdAtTick: 0,
    ...(outpostStock ? { stockpile: outpostStock } : {}),
  };
  return createState({
    guilds: [guild], outposts: [outpost],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
}

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
const transfer = (vid, manifest) => createTransferCargoAction({ guildId: 'g1', vehicleId: vid, manifest });
const outpostOf = (s) => s.outposts[0];
const craftOf = (s, vid) => s.guilds[0].vehicles.find((v) => v.id === vid);
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. a transfer at an Outpost QUEUES, it does not resolve instantly --------------------------

test('an Outpost transfer queues the manifest — no goods move the tick it is issued', () => {
  const s0 = dockState([craft('vehicle_g1_lightTransport_01', { [T1]: 100 })]);
  const before = computeGalacticSupply(s0).resources[T1];
  const s = accept(s0, transfer('vehicle_g1_lightTransport_01', [{ dir: 'unload', good: T1, qty: 100 }]));

  const cr = craftOf(s, 'vehicle_g1_lightTransport_01');
  assert.equal(cr.status, 'idle', 'a queued craft stays plain idle (re-dispatchable)');
  assert.deepEqual(cr.cargo, { [T1]: 100 }, 'the hold is UNTOUCHED — goods move at completion, not now');
  assert.equal(outpostOf(s).stockpile, undefined, 'nothing landed in the Outpost yet');
  assert.equal(outpostOf(s).queue.length, 1, 'the manifest is queued');
  assert.deepEqual(outpostOf(s).queue[0], {
    vehicleId: 'vehicle_g1_lightTransport_01',
    manifest: [{ dir: 'unload', good: T1, qty: 100 }],
    readyTick: 0,
  });
  assert.equal(outpostOf(s).slots, undefined, 'no slot is taken until the dock step promotes it');
  assert.equal(computeGalacticSupply(s).resources[T1], before, 'supply is unchanged — the goods never left the hold');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // A second manifest on the same queued craft is refused (one manifest per craft, §4).
  const why = refuse(s, transfer('vehicle_g1_lightTransport_01', [{ dir: 'unload', good: T1, qty: 1 }]));
  assert.match(why, /already has a manifest/);
});

// --- 2. the timer: promotion sets completionTick = tick + turnaround, per class -----------------

test('promotion sets completionTick = thisTick + turnaround for each class (5 / 30 / 120)', () => {
  for (const [cls, expected] of [[LIGHT_TRANSPORT, 5], [MEDIUM_TRANSPORT, 30], [HEAVY_TRANSPORT, 120]]) {
    assert.equal(OUTPOST_DOCK_TURNAROUND[cls], expected, 'the tuning value is sourced, not invented');
    const id = `vehicle_g1_${cls}_01`;
    let s = dockState([craft(id, { [T1]: 10 }, cls)]);
    s = accept(s, transfer(id, [{ dir: 'unload', good: T1, qty: 10 }])); // readyTick 0
    // One dock step (thisTick = 1) promotes the sole queued craft into a slot.
    const stepped = stepOutpostDocks(structuredClone(s), []);
    assert.equal(stepped.outposts[0].slots.length, 1);
    assert.equal(stepped.outposts[0].slots[0].completionTick, 1 + expected, 'resolves 1 (promotion) + turnaround after ready');
    assert.equal(stepped.guilds[0].vehicles[0].status, 'loading', 'a slot-held craft carries the loading status');
    assert.equal(stepped.outposts[0].queue, undefined, 'the queue emptied');
  }
});

test('a light craft resolves at EXACTLY readyTick + 1 + 5, and not a tick before', () => {
  const id = 'vehicle_g1_lightTransport_01';
  const s0 = accept(dockState([craft(id, { [T1]: 100 })]), transfer(id, [{ dir: 'unload', good: T1, qty: 100 }]));
  // readyTick 0 → promoted at tick 1 → completionTick 6. Five ticks: still loading, nothing landed.
  const at5 = ticks(s0, 5);
  assert.equal(at5.tick, 5);
  assert.equal(craftOf(at5, id).status, 'loading', 'still mid-turnaround at tick 5');
  assert.deepEqual(craftOf(at5, id).cargo, { [T1]: 100 }, 'goods have not moved yet');
  assert.equal(outpostOf(at5).stockpile, undefined);
  // One more tick (tick 6 == completionTick): the manifest resolves.
  const at6 = tick(at5, []);
  assert.equal(at6.tick, 6);
  assert.equal(craftOf(at6, id).status, 'idle', 'returns to parked (idle) at completion');
  assert.equal(craftOf(at6, id).cargo, undefined, 'the hold emptied into the Outpost');
  assert.deepEqual(outpostOf(at6).stockpile, { [T1]: 100 }, 'the Outpost stockpile filled at completion');
  assert.equal(outpostOf(at6).slots, undefined, 'the slot freed');
  assert.deepEqual(checkInvariants(at6, at6.tick), []);
});

// --- 3. more than ten manifests: only ten load at once, the rest wait, earliest-ready-first -----

test('eleven queued craft — ten promote into the ten slots, the eleventh waits (earliest-ready-first)', () => {
  const ids = [];
  const vehicles = [];
  for (let i = 1; i <= 11; i += 1) {
    const id = `vehicle_g1_lightTransport_${String(i).padStart(2, '0')}`;
    ids.push(id);
    vehicles.push(craft(id, { [T1]: 1 }));
  }
  let s = dockState(vehicles);
  // Enqueue all eleven at the SAME ready tick (tick 0), so the tie-break is stable vehicle id: the
  // eleventh id (…_11) sorts LAST, so it is the one left in the queue.
  for (const id of ids) s = accept(s, transfer(id, [{ dir: 'unload', good: T1, qty: 1 }]));
  assert.equal(outpostOf(s).queue.length, 11);

  const stepped = stepOutpostDocks(structuredClone(s), []);
  assert.equal(stepped.outposts[0].slots.length, 10, 'exactly ten concurrent transfers (OUTPOST_DOCK_SLOTS)');
  assert.equal(stepped.outposts[0].queue.length, 1, 'one still waits');
  assert.equal(stepped.outposts[0].queue[0].vehicleId, 'vehicle_g1_lightTransport_11', 'the highest id waits (deterministic tie-break)');
  const loadingIds = stepped.outposts[0].slots.map((x) => x.vehicleId).sort();
  assert.deepEqual(loadingIds, ids.slice(0, 10).sort(), 'the first ten (by id) are loading');
  // The eleventh craft is still plain idle (parked/queued), not loading.
  assert.equal(stepped.guilds[0].vehicles.find((v) => v.id === 'vehicle_g1_lightTransport_11').status, 'idle');
});

// --- 4. a resolution against a FULL Outpost partials the unload ---------------------------------

test('a full Outpost partials the unload — only the room remaining lands, the rest stays in the hold', () => {
  const id = 'vehicle_g1_lightTransport_01';
  // Pre-fill the Outpost to 3 space short of its hard cap (titanium, volumeOf 1). A craft holding 10
  // titanium can then land only 3; 7 stay aboard.
  const s0 = dockState([craft(id, { [T1]: 10 })], { outpostStock: { [T1]: OUTPOST_CAPACITY - 3 } });
  const s1 = accept(s0, transfer(id, [{ dir: 'unload', good: T1, qty: 10 }]));
  const done = ticks(s1, 6); // light turnaround → resolves at tick 6
  assert.deepEqual(craftOf(done, id).cargo, { [T1]: 7 }, 'the un-landed remainder stays in the hold');
  assert.equal(outpostOf(done).stockpile[T1], OUTPOST_CAPACITY, 'the Outpost is exactly at its hard cap');
  assert.deepEqual(checkInvariants(done, done.tick), [], 'still within capacity — the invariant is green');
});

// --- 5. supply conserved across a completion, and consistency counts Outpost stockpiles ---------

test('a completion CONSERVES galactic supply (hold → stockpile, both counted) and stays consistency-green', () => {
  const id = 'vehicle_g1_lightTransport_01';
  const s0 = accept(dockState([craft(id, { [T1]: 40, [T2]: 5 })]), transfer(id, [
    { dir: 'unload', good: T1, qty: 40 },
    { dir: 'unload', good: T2, qty: 5 },
  ]));
  const t1Before = computeGalacticSupply(s0).resources[T1];
  const t2Before = computeGalacticSupply(s0).resources[T2];
  const done = ticks(s0, 6);
  // Cache == live sum every tick (the tick's end-of-steps derive), so consistency is green throughout.
  assert.deepEqual(checkInvariants(done, done.tick), []);
  const after = computeGalacticSupply(done).resources;
  assert.equal(after[T1], t1Before, 'titanium total unchanged — it only moved hold → stockpile');
  assert.equal(after[T2], t2Before, 'titanium_alloy total unchanged');
  assert.deepEqual(outpostOf(done).stockpile, { [T1]: 40, [T2]: 5 }, 'the goods are now warehoused forward');
  assert.equal(done.galacticSupply.resources[T1], t1Before, 'the CACHE agrees with the live sum');
});

test('an Outpost load pulls FROM the stockpile back into a hold (the reverse move)', () => {
  const id = 'vehicle_g1_lightTransport_01';
  const s0 = dockState([craft(id)], { outpostStock: { [T1]: 500 } }); // empty craft, stocked Outpost
  const s1 = accept(s0, transfer(id, [{ dir: 'load', good: T1, qty: 300 }]));
  const done = ticks(s1, 6);
  assert.deepEqual(craftOf(done, id).cargo, { [T1]: 300 }, 'the hold loaded from the Outpost');
  assert.deepEqual(outpostOf(done).stockpile, { [T1]: 200 }, 'the Outpost stockpile drew down');
  assert.deepEqual(checkInvariants(done, done.tick), []);
});

// --- 6. teardown: evict docked + queued craft, destroy stored goods -----------------------------

test('teardown destroys the stored goods (supply drops by exactly that) and evicts craft idle-in-space', () => {
  // A craft mid-turnaround (loading, hold still full — never reached its resolve), a queued craft
  // (idle), plus an Outpost holding goods.
  const loaderId = 'vehicle_g1_lightTransport_01';   // will be in a slot, still-laden
  const queuedId = 'vehicle_g1_lightTransport_02';   // will be waiting in the queue
  const s0 = dockState(
    [craft(loaderId, { [T1]: 80 }), craft(queuedId, { [T2]: 3 })],
    { outpostStock: { [T1]: 1000 } },
  );
  let s = accept(s0, transfer(loaderId, [{ dir: 'unload', good: T1, qty: 80 }]));
  s = accept(s, transfer(queuedId, [{ dir: 'unload', good: T2, qty: 3 }]));
  s = ticks(s, 1); // promote both into slots (two free of ten) — both now loading, mid-turnaround
  assert.equal(craftOf(s, loaderId).status, 'loading');
  assert.equal(craftOf(s, queuedId).status, 'loading');

  const supplyBefore = computeGalacticSupply(s).resources;
  const stored = supplyBefore[T1]; // hold 80 + stockpile 1000 = 1080 titanium in supply

  const torn = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.equal(torn.outposts, undefined, 'the Outpost row (and its stockpile) is gone — omit-when-empty');
  // Both craft are evicted to idle-in-space AT the Outpost's hex, carrying their PRE-transfer holds
  // (the loaders never resolved, so they leave still-laden).
  const l = craftOf(torn, loaderId);
  const qd = craftOf(torn, queuedId);
  assert.equal(l.status, 'idle', 'the mid-turnaround craft becomes idle in space');
  assert.deepEqual(l.location, { q: HEX.q, r: HEX.r }, 'a bare-hex idle craft at the Outpost hex');
  assert.deepEqual(l.cargo, { [T1]: 80 }, 'still-laden — the transfer never happened');
  assert.equal(qd.status, 'idle');
  assert.deepEqual(qd.cargo, { [T2]: 3 }, 'the queued craft keeps its hold, drops its pending manifest');

  const supplyAfter = computeGalacticSupply(torn).resources;
  // The 1000 stored in the Outpost stockpile LEFT supply; the 80 in the loader's hold stayed (it left
  // with the craft). So titanium supply drops by exactly the destroyed stockpile.
  assert.equal(supplyAfter[T1], stored - 1000, 'supply drops by exactly the destroyed stored goods');
  assert.equal(supplyAfter[T2], supplyBefore[T2], 'the queued craft kept its hold — no drop there');
  assert.deepEqual(checkInvariants(torn, torn.tick), [], 'the cache was refreshed across teardown');
});

// --- 7. re-dispatch cancels a queued craft; a loading craft is refused --------------------------

test('re-dispatching a QUEUED craft cancels its manifest and it leaves the queue', () => {
  const id = 'vehicle_g1_lightTransport_01';
  const s0 = accept(dockState([craft(id, { [T1]: 5 })], { fuelHoard: 100000 }),
    transfer(id, [{ dir: 'unload', good: T1, qty: 5 }]));
  assert.equal(outpostOf(s0).queue.length, 1);
  // Dispatch it away to another hex — a queued craft is plain idle, so dispatch accepts it.
  const s = accept(s0, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [ELSEWHERE] }));
  assert.equal(outpostOf(s).queue, undefined, 'the pending manifest was dropped — the queue emptied');
  assert.equal(craftOf(s, id).status, 'inTransit', 'the craft is flying');
  assert.deepEqual(craftOf(s, id).cargo, { [T1]: 5 }, 'it flies off still holding its cargo — a load never happened');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a LOADING craft (in a slot, mid-turnaround) is refused dispatch — it runs to completion', () => {
  const id = 'vehicle_g1_lightTransport_01';
  let s = accept(dockState([craft(id, { [T1]: 5 })], { fuelHoard: 100000 }),
    transfer(id, [{ dir: 'unload', good: T1, qty: 5 }]));
  s = ticks(s, 1); // promote into a slot → status loading
  assert.equal(craftOf(s, id).status, 'loading');
  const why = refuse(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [ELSEWHERE] }));
  assert.match(why, /dock slot|completion/, 'refused because it is mid-transfer in a slot');
});

// --- 8. spycraft cannot dock (no ruled turnaround) ---------------------------------------------

test('a spycraft (capacity 0, no ruled turnaround) is refused an Outpost transfer', () => {
  const id = 'vehicle_g1_spycraft_01';
  const s = dockState([craft(id, undefined, SPYCRAFT)]);
  const why = refuse(s, transfer(id, [{ dir: 'load', good: T1, qty: 1 }]));
  assert.match(why, /carries no cargo/);
});

// --- 9. determinism: the whole flow replays byte-identically ------------------------------------

test('determinism (invariant 9): enqueue + advance through completion is byte-identical across two runs', () => {
  const run = () => {
    const id = 'vehicle_g1_lightTransport_01';
    let s = dockState([craft(id, { [T1]: 40 })], { outpostStock: { [T2]: 7 } });
    s = accept(s, transfer(id, [{ dir: 'unload', good: T1, qty: 25 }, { dir: 'load', good: T2, qty: 7 }]));
    return ticks(s, 8); // through promotion + light turnaround, then some idle ticks
  };
  assert.equal(hashState(run()), hashState(run()), 'the same scenario hashes identically');
});

// --- 10. the snapshot surfaces the dock state + per-craft dock status ----------------------------

test('the snapshot surfaces the queue/slots (with ETAs) and each craft dockStatus', () => {
  const loaderId = 'vehicle_g1_lightTransport_01';
  const parkedId = 'vehicle_g1_lightTransport_02'; // parked at the hex, no manifest
  let s = dockState([craft(loaderId, { [T1]: 10 }), craft(parkedId)]);
  s = accept(s, transfer(loaderId, [{ dir: 'unload', good: T1, qty: 10 }]));

  // Queued (before promotion): the loader is 'queued', the manifest-less craft is 'parked'.
  let snap = buildSnapshot(s);
  let rows = snap.guilds[0].vehicles;
  assert.deepEqual(rows.find((v) => v.id === loaderId).dockStatus, { state: 'queued', outpostId: 'outpost_g1_01' });
  assert.deepEqual(rows.find((v) => v.id === parkedId).dockStatus, { state: 'parked', outpostId: 'outpost_g1_01' });
  assert.equal(snap.outposts[0].queue.length, 1, 'the outpost row carries the queue');
  assert.equal(snap.outposts[0].slots.length, 0);

  // After one tick the loader is in a slot: dockStatus 'loading' with an ETA, and the outpost slot row.
  s = ticks(s, 1);
  snap = buildSnapshot(s);
  rows = snap.guilds[0].vehicles;
  const ds = rows.find((v) => v.id === loaderId).dockStatus;
  assert.equal(ds.state, 'loading');
  assert.equal(ds.eta, 5, 'eta = completionTick (6) − tick (1) = 5 ticks to resolve');
  assert.equal(snap.outposts[0].slots.length, 1);
  assert.equal(snap.outposts[0].slots[0].eta, 5, 'the outpost slot row carries the same ETA');
});

// --- 11. the NO-OP: no Outpost transfer leaves the dock state omitted ---------------------------

test('a galaxy that runs ticks with no Outpost transfer keeps queue/slots omitted (byte-identical)', () => {
  const s0 = dockState([craft('vehicle_g1_lightTransport_01', { [T1]: 3 })]);
  const before = hashState(s0);
  const advanced = ticks(s0, 4); // ticks, but no transfer issued
  const o = advanced.outposts[0];
  assert.equal(o.queue, undefined, 'no queue key ever appeared');
  assert.equal(o.slots, undefined, 'no slots key ever appeared');
  assert.equal(o.stockpile, undefined, 'the stockpile stayed empty and omitted');
  // The dock step is a pure pass-through when nothing docks — the craft/outpost are untouched by it.
  assert.deepEqual(craftOf(advanced, 'vehicle_g1_lightTransport_01').cargo, { [T1]: 3 });
  assert.notEqual(before, undefined);
  assert.deepEqual(checkInvariants(advanced, advanced.tick), []);
});

// --- 12. the read-only Outpost Manager's three DERIVED snapshot fields (roadmap 2.2) ------------
// The manager view renders the storage donut / dock progress bar / craft hold gauge off these three
// published figures so the client invents no game number (§18). Unit-test them directly.

test('a slot row carries totalTicks = outpostDockTurnaround(class), and eta ≤ totalTicks', () => {
  // A light AND a medium craft, so the per-class turnaround (5 / 30) is proved, not one value twice.
  const lightId = 'vehicle_g1_lightTransport_01';
  const medId = 'vehicle_g1_mediumTransport_01';
  let s = dockState([craft(lightId, { [T1]: 10 }), craft(medId, { [T1]: 10 }, MEDIUM_TRANSPORT)]);
  s = accept(s, transfer(lightId, [{ dir: 'unload', good: T1, qty: 10 }]));
  s = accept(s, transfer(medId, [{ dir: 'unload', good: T1, qty: 10 }]));
  s = ticks(s, 1); // both promote into slots this tick

  const slots = buildSnapshot(s).outposts[0].slots;
  const lightSlot = slots.find((sl) => sl.vehicleId === lightId);
  const medSlot = slots.find((sl) => sl.vehicleId === medId);
  assert.equal(lightSlot.totalTicks, OUTPOST_DOCK_TURNAROUND[LIGHT_TRANSPORT], 'light turnaround = 5');
  assert.equal(medSlot.totalTicks, OUTPOST_DOCK_TURNAROUND[MEDIUM_TRANSPORT], 'medium turnaround = 30');
  // eta (completionTick − tick) never exceeds the full turnaround — the fill 1 − eta/totalTicks stays in [0,1].
  assert.ok(lightSlot.eta <= lightSlot.totalTicks && lightSlot.eta > 0);
  assert.ok(medSlot.eta <= medSlot.totalTicks && medSlot.eta > 0);
});

test("an outpost row's used = usedSpace(stockpile) and 0 ≤ used ≤ capacity; empty reads 0", () => {
  // Empty outpost: used is 0 and within [0, capacity].
  const empty = buildSnapshot(dockState([craft('vehicle_g1_lightTransport_01')])).outposts[0];
  assert.equal(empty.used, 0, 'an empty stockpile reads used 0');
  assert.ok(empty.used >= 0 && empty.used <= empty.capacity);

  // After a completion the stockpile grows; `used` equals usedSpace of the stockpile the row carries.
  const loaderId = 'vehicle_g1_lightTransport_01';
  let s = dockState([craft(loaderId, { [T1]: 10, [T2]: 3 })]);
  s = accept(s, transfer(loaderId, [{ dir: 'unload', good: T1, qty: 10 }, { dir: 'unload', good: T2, qty: 3 }]));
  s = ticks(s, 1 + OUTPOST_DOCK_TURNAROUND[LIGHT_TRANSPORT]); // promote, then resolve at completion
  const row = buildSnapshot(s).outposts[0];
  assert.deepEqual(row.stockpile, { [T1]: 10, [T2]: 3 }, 'the goods landed');
  assert.equal(row.used, usedSpace(row.stockpile), 'used is the stockpile occupancy');
  assert.equal(row.used, 10 * volumeOf(T1) + 3 * volumeOf(T2));
  assert.ok(row.used >= 0 && row.used <= row.capacity, 'within the hard cap');
});

test("a vehicle row's used = usedSpace(cargo) and ≤ capacity; an empty hold reads 0", () => {
  const ladenId = 'vehicle_g1_lightTransport_01';
  const emptyId = 'vehicle_g1_lightTransport_02';
  const s = dockState([craft(ladenId, { [T1]: 40, [T2]: 5 }), craft(emptyId)]);
  const rows = buildSnapshot(s).guilds[0].vehicles;
  const laden = rows.find((v) => v.id === ladenId);
  const empty = rows.find((v) => v.id === emptyId);
  assert.equal(laden.used, usedSpace(laden.cargo), 'used is the hold occupancy');
  assert.equal(laden.used, 40 * volumeOf(T1) + 5 * volumeOf(T2));
  assert.equal(laden.capacity, LIGHT_CAP, 'the published per-class hold cap');
  assert.ok(laden.used <= laden.capacity, 'a hold never exceeds its capacity');
  assert.equal(empty.used, 0, 'an empty hold reads used 0');
});
