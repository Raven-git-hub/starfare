'use strict';

// craft-maintenance.test.js — roadmap 2.6 (maintenance), slice 3 of 6: spacecraft WEAR in flight and the guild's
// craft MAINTENANCE POOL (docs/maintenance.md §2 / §3; sim/craft-maintenance.js).
//
// The tripwires, in the order of the slice's proof list:
//   A. THE NUMBERS: the derived scale (483,840 — computed, never typed) and the eight whole rates.
//   B. THE LIVES: per class, an always-covered craft flies exactly its maintained life to 0 and an always-uncovered
//      one exactly its unmaintained life; the starter heavy (0.5) reaches 0 after exactly half of each.
//   C. EXACTNESS through the real tick: a single leg, a multi-leg trip, and a route that pauses at an Outpost dock
//      wear exactly their flight ticks — never L ± 1, never while docked.
//   D. IDLE NEVER WEARS, across many cycles.
//   E. THE DRAIN: lowest condition first, id tie-break; skip-and-continue; a 0% craft never charged; an empty pool
//      covers nothing; a 0% craft keeps flying at 0.
//   F. THE POOL: refill = min(budget, credits), never negative; carry-forward; the boundary order.
//   G. THE ACTIONS: budget and top-up, every refusal, the journal tick, no withdrawal path.
//   H. CONSERVATION AND NEUTRALITY: invariant 2 every tick of a funded run; nothing but credits / pool / ledger /
//      condition moves.
//   I. THE READOUT: ceiling, nextRefillTick, flight ticks left, the covered flag; fogged from a rival.
//   J. THE NOTICE: once per cycle at most; only for a flying craft above 0 left uncovered; never for an opted-out guild.
//   K. NO-OP: a galaxy with an idle craft and no pool hashes exactly as main did, across a cycle boundary.
//   L. DETERMINISM: two runs identical; save → restore → continue identical to an unbroken run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState, createVehicle } = require('../state.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { saveState, appendJournal, loadOrInit, journalPath } = require('../persist.js');
const { hexDistance, legTicks } = require('../transport.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT, VEHICLE_CLASSES, VEHICLE_SPECS,
} = require('../vehicles.js');
const { STARTER_HEAVY_CONDITION } = require('../starter-package.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  CRAFT_LIFE_TICKS, CRAFT_MAINTENANCE_RATE, CRAFT_WEAR_SCALE, craftWearPerTick, conditionUnits,
  stepCraftMaintenance, readCraftMaintenance,
} = require('../craft-maintenance.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createDispatchVehicleAction, createDispatchRouteWithActionsAction,
  createSetCraftMaintenanceBudgetAction, createTopUpCraftMaintenancePoolAction,
} = require('../actions.js');

const DAY = 1440;
const units = (v) => conditionUnits(v.maintenanceCondition);

// ── helpers: the bare step (fast, for lives and triage) ──────────────────────────────────────────────────

// craft(id, cls, condition, status) -> a vehicle row. The step reads only class, condition, status and id.
function craft(id, cls, condition = 1, status = 'inTransit') {
  const spec = VEHICLE_SPECS[cls];
  return {
    ...createVehicle({ id, ownerGuildId: 'g1', class: cls, ...spec, location: { q: 0, r: 0 }, maintenanceCondition: condition }),
    status,
  };
}
// world(vehicles, { pool, budget, credits }) -> the smallest state the step reads: a ledger, a cycle, one guild.
function world(vehicles, { pool = 0, budget = 0, credits = 0, windowN = DAY } = {}) {
  const guild = { id: 'g1', credits, vehicles };
  if (pool || budget) guild.craftMaintenance = { ...(pool ? { pool } : {}), ...(budget ? { budget } : {}) };
  return { tick: 0, windowN, dayAnchorTick: 0, syndicate: { ledger: 0 }, guilds: [guild] };
}
// step(state, boundary) — run the step for the next tick, as stepVehicleArrivals does, then advance the clock.
function step(state, boundary = false) {
  stepCraftMaintenance(state, state.guilds[0], state.tick + 1, boundary);
  state.tick += 1;
}

// ── helpers: the real engine ─────────────────────────────────────────────────────────────────────────────

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected ${action.type} accepted, got: ${reason}`);
  const next = applyAction(state, action);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, `expected ${action.type} refused: ${JSON.stringify(action)}`);
  return reason;
};
// run(s, n) — n ticks through advance(), which asserts EVERY invariant (invariant 2 included) after each one.
function run(s, n) {
  let x = s;
  for (let i = 0; i < n; i += 1) x = advance(x).state;
  return x;
}
const g1Of = (s) => s.guilds.find((g) => g.id === 'g1');
const vehicleOf = (s, id) => g1Of(s).vehicles.find((v) => v.id === id);
const LIGHT_ID = 'vehicle_g1_lightTransport_01';
const budget = (b, guildId = 'g1') => createSetCraftMaintenanceBudgetAction({ guildId, budget: b });
const topUp = (amount, guildId = 'g1') => createTopUpCraftMaintenancePoolAction({ guildId, amount });

// engineGalaxy({ credits, cls, condition }) -> g1 with one idle craft on open space at (0, 0), and a rival g2.
function engineGalaxy({ credits = 1_000_000, cls = LIGHT_TRANSPORT, condition, tick = 0 } = {}) {
  let s = createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 1_000_000 }, { id: 'g2', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s.tick = tick;
  s = accept(s, createSpawnVehicleAction({
    guildId: 'g1', class: cls, location: { q: 0, r: 0 }, ...(condition === undefined ? {} : { condition }),
  }));
  return s;
}
// flyUntilLanded(s, id) -> { s, flown } — tick until the craft is no longer in transit, counting the ticks it
// was in transit at the start of (the ticks the step sees it flying).
function flyUntilLanded(s, id) {
  let x = s;
  let flown = 0;
  while (vehicleOf(x, id).status === 'inTransit') {
    x = advance(x).state;
    flown += 1;
    assert.ok(flown < 100_000, 'runaway flight');
  }
  return { s: x, flown };
}

// ── A. the numbers ───────────────────────────────────────────────────────────────────────────────────────

test('numbers: the lives and rates are the ruled ones; the scale is their LCM, 483,840, and every wear rate is whole', () => {
  assert.deepEqual(CRAFT_LIFE_TICKS, {
    [LIGHT_TRANSPORT]: { unmaintained: 80_640, maintained: 161_280 },
    [MEDIUM_TRANSPORT]: { unmaintained: 60_480, maintained: 120_960 },
    [HEAVY_TRANSPORT]: { unmaintained: 40_320, maintained: 80_640 },
    [SPYCRAFT]: { unmaintained: 10_080, maintained: 20_160 },
  });
  assert.deepEqual(CRAFT_MAINTENANCE_RATE, {
    [LIGHT_TRANSPORT]: 1, [MEDIUM_TRANSPORT]: 2, [HEAVY_TRANSPORT]: 5, [SPYCRAFT]: 10,
  });
  assert.equal(CRAFT_WEAR_SCALE, 483_840);
  const rates = Object.fromEntries(VEHICLE_CLASSES.map((c) => [c, [craftWearPerTick(c, false), craftWearPerTick(c, true)]]));
  assert.deepEqual(rates, {
    [LIGHT_TRANSPORT]: [6, 3], [MEDIUM_TRANSPORT]: [8, 4], [HEAVY_TRANSPORT]: [12, 6], [SPYCRAFT]: [48, 24],
  });
  for (const life of Object.values(CRAFT_LIFE_TICKS)) {
    assert.equal(CRAFT_WEAR_SCALE % life.unmaintained, 0);
    assert.equal(CRAFT_WEAR_SCALE % life.maintained, 0);
  }
  assert.equal(conditionUnits(STARTER_HEAVY_CONDITION), 241_920, 'the starter heavy\'s 0.5 is exactly half the scale');
});

// ── B. the lives ─────────────────────────────────────────────────────────────────────────────────────────

// ticksToZero(cls, condition, covered) -> how many flight ticks until the craft reaches exactly 0, checking it is
// above 0 on every tick before that. `covered` keeps the pool topped up so it is paid every tick.
function ticksToZero(cls, condition, covered) {
  const v = craft('vehicle_g1_x_01', cls, condition);
  const s = world([v]);
  let n = 0;
  while (v.maintenanceCondition > 0) {
    if (covered) s.guilds[0].craftMaintenance = { pool: CRAFT_MAINTENANCE_RATE[cls] };
    step(s);
    n += 1;
    assert.equal(v.maintenanceCovered === true, covered, `covered on every tick (${cls}, tick ${n})`);
  }
  return n;
}

for (const cls of VEHICLE_CLASSES) {
  test(`lives: a ${cls} flies EXACTLY its maintained life covered and its unmaintained life uncovered`, () => {
    assert.equal(ticksToZero(cls, 1, true), CRAFT_LIFE_TICKS[cls].maintained);
    assert.equal(ticksToZero(cls, 1, false), CRAFT_LIFE_TICKS[cls].unmaintained);
    // "An unfunded fleet wears twice as fast as a funded one."
    assert.equal(CRAFT_LIFE_TICKS[cls].maintained, 2 * CRAFT_LIFE_TICKS[cls].unmaintained);
  });
}

test('lives: the starter heavy (0.5) reaches 0 after exactly half of each life — 40,320 maintained, 20,160 not', () => {
  assert.equal(ticksToZero(HEAVY_TRANSPORT, STARTER_HEAVY_CONDITION, true), 40_320);
  assert.equal(ticksToZero(HEAVY_TRANSPORT, STARTER_HEAVY_CONDITION, false), 20_160);
});

// ── C. exactness through the real tick ───────────────────────────────────────────────────────────────────

test('exactness: a single leg of L ticks wears exactly L ticks — the arrival tick is charged, the departure tick is not', () => {
  let s = engineGalaxy();
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: LIGHT_ID, waypoints: [{ q: 2, r: 0 }] }));
  const leg = vehicleOf(s, LIGHT_ID).trip.legs[0];
  const L = leg.arrivalTick - leg.departureTick;
  assert.equal(L, legTicks(2, VEHICLE_SPECS[LIGHT_TRANSPORT].speed, false));
  const { s: landed, flown } = flyUntilLanded(s, LIGHT_ID);
  assert.equal(flown, L);
  assert.equal(landed.tick, leg.arrivalTick, 'landed on its arrival tick');
  assert.equal(CRAFT_WEAR_SCALE - units(vehicleOf(landed, LIGHT_ID)), L * 6, 'L ticks at the unmaintained 6 — not L ± 1');
  // And it stops there: the berth does not wear.
  assert.equal(units(vehicleOf(run(landed, 50), LIGHT_ID)), units(vehicleOf(landed, LIGHT_ID)));
});

test('exactness: a multi-leg trip wears exactly Σ its legs — contiguous legs never share or skip a tick', () => {
  let s = engineGalaxy();
  s = accept(s, createDispatchVehicleAction({
    guildId: 'g1', vehicleId: LIGHT_ID, waypoints: [{ q: 1, r: 0 }, { q: 1, r: 2 }, { q: 3, r: 1 }],
  }));
  const legs = vehicleOf(s, LIGHT_ID).trip.legs;
  assert.equal(legs.length, 3);
  const total = legs.reduce((sum, l) => sum + (l.arrivalTick - l.departureTick), 0);
  const { s: landed, flown } = flyUntilLanded(s, LIGHT_ID);
  assert.equal(flown, total);
  assert.equal(CRAFT_WEAR_SCALE - units(vehicleOf(landed, LIGHT_ID)), total * 6);
});

// The Outpost dock fixture (route-actions.test.js's): a real seed system A, the free hexes nearest it, and an
// Outpost of g1's on one of them, so a route can pause in its dock.
const SYS_A = starterHomeAtDistance(6).id;
const A_COORDS = getSystem(SYS_A).coords;
function freeHexesNear(center, n) {
  const found = [];
  for (let q = -100; q <= 100; q += 1) {
    for (let r = -100; r <= 100; r += 1) {
      if (!isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      found.push({ q, r, d: hexDistance({ q, r }, center) });
    }
  }
  found.sort((a, b) => (a.d - b.d) || (a.q - b.q) || (a.r - b.r));
  return found.slice(0, n).map(({ q, r }) => ({ q, r }));
}
const [ORIGIN, HEX_B] = freeHexesNear(A_COORDS, 2);

test('exactness: a route that PAUSES in an Outpost dock wears only its flight ticks — nothing while docked', () => {
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 1_000_000, outpostSerial: 1, stockpiles: { [SYS_A]: { titanium: 400 } } }],
    outposts: [{ id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: SYS_A, coords: { ...HEX_B }, createdAtTick: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location: { ...ORIGIN } }));
  const dock = (manifest) => ({ type: 'dock', manifest });
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: LIGHT_ID, waypoints: [
      { anchor: { landmarkKind: 'system', landmarkId: SYS_A }, action: dock([{ dir: 'load', good: 'titanium', qty: 400 }]) },
      { anchor: { ...HEX_B }, action: dock([{ dir: 'unload', good: 'titanium', qty: 400 }]) },
      { anchor: { ...ORIGIN } },
    ],
  }));
  const speed = VEHICLE_SPECS[LIGHT_TRANSPORT].speed;
  const flightTicks = legTicks(hexDistance(ORIGIN, A_COORDS), speed, false)
    + legTicks(hexDistance(A_COORDS, HEX_B), speed, false)
    + legTicks(hexDistance(HEX_B, ORIGIN), speed, false);
  // Tick until the route is done, counting the ticks in flight and checking the docked ticks change nothing.
  let flown = 0;
  let docked = 0;
  let elapsed = 0;
  while (vehicleOf(s, LIGHT_ID).route || vehicleOf(s, LIGHT_ID).status !== 'idle') {
    const before = vehicleOf(s, LIGHT_ID);
    const wasFlying = before.status === 'inTransit';
    const unitsBefore = units(before);
    s = advance(s).state;
    elapsed += 1;
    if (wasFlying) flown += 1;
    else {
      docked += 1;
      assert.equal(units(vehicleOf(s, LIGHT_ID)), unitsBefore, `no wear at tick ${s.tick} while ${before.status}`);
    }
    assert.ok(elapsed < 20_000, 'runaway route');
  }
  assert.ok(docked > 0, 'the route really did pause in the dock');
  assert.equal(flown, flightTicks);
  assert.equal(CRAFT_WEAR_SCALE - units(vehicleOf(s, LIGHT_ID)), flightTicks * 6, 'Σ legs, exactly');
  assert.equal(s.outposts[0].stockpile.titanium, 400, 'the dock turnaround really ran');
});

// ── D. idle never wears ──────────────────────────────────────────────────────────────────────────────────

test('idle: a craft berthed across many cycles — with a funded pool refilling — keeps its condition to the unit', () => {
  let s = engineGalaxy({ condition: 0.75 });
  s.windowN = 10;  // a short cycle, so a short run crosses many boundaries
  s = accept(s, budget(7));
  s = accept(s, topUp(3));
  s = run(s, 125);
  assert.equal(vehicleOf(s, LIGHT_ID).maintenanceCondition, 0.75);
  const rec = readCraftMaintenance(g1Of(s));
  assert.equal(rec.pool, 3 + 12 * 7, 'twelve refills landed and nothing was spent — idle craft cost nothing');
  assert.equal(rec.spentLastCycle, 0);
});

// ── E. the drain ─────────────────────────────────────────────────────────────────────────────────────────

test('drain: lowest condition first, id breaks a tie — a pool for two lights covers the two most worn', () => {
  const a = craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 0.5);
  const b = craft('vehicle_g1_lightTransport_02', LIGHT_TRANSPORT, 0.25);
  const c = craft('vehicle_g1_lightTransport_03', LIGHT_TRANSPORT, 0.5);
  const s = world([a, b, c], { pool: 2 });
  step(s);
  assert.equal(b.maintenanceCovered, true, 'the most worn first');
  assert.equal(a.maintenanceCovered, true, '01 beats 03 on the tie');
  assert.equal(c.maintenanceCovered, undefined);
  assert.equal(CRAFT_WEAR_SCALE / 2 - units(a), 3);
  assert.equal(CRAFT_WEAR_SCALE / 2 - units(c), 6);
  assert.equal(s.syndicate.ledger, 2);
  assert.equal(s.guilds[0].craftMaintenance.pool, undefined, 'the pool is spent (and omitted at 0)');
});

test('drain: skip-and-continue — an expensive craft the pool cannot pay is skipped, a cheaper one after it is covered', () => {
  const heavy = craft('vehicle_g1_heavyTransport_01', HEAVY_TRANSPORT, 0.4);   // first in order, costs 5
  const light = craft('vehicle_g1_lightTransport_02', LIGHT_TRANSPORT, 0.9);   // later, costs 1
  const s = world([heavy, light], { pool: 4, budget: 100 });
  step(s);
  assert.equal(heavy.maintenanceCovered, undefined, 'skipped: 4 < 5');
  assert.equal(light.maintenanceCovered, true, 'covered after the skip');
  assert.equal(s.guilds[0].craftMaintenance.pool, 3);
  assert.equal(s.syndicate.ledger, 1);
  assert.equal(conditionUnits(0.4) - units(heavy), 12, 'the skipped heavy wore unmaintained');
});

test('drain: a craft at 0% is never charged, keeps flying, and stays at 0 — the pool goes to a craft it can help', () => {
  const dead = craft('vehicle_g1_heavyTransport_01', HEAVY_TRANSPORT, 0);
  const light = craft('vehicle_g1_lightTransport_02', LIGHT_TRANSPORT, 0.9);
  const s = world([dead, light], { pool: 5 });
  for (let i = 0; i < 3; i += 1) step(s);
  assert.equal(dead.maintenanceCondition, 0);
  assert.equal(dead.maintenanceCovered, undefined);
  assert.equal(dead.status, 'inTransit', 'no consequence yet — deep maintenance is slice 4');
  assert.equal(light.maintenanceCovered, true);
  assert.equal(s.syndicate.ledger, 3, 'three ticks of the light, nothing for the heavy at 0');
  assert.equal(s.guilds[0].craftMaintenance.pool, 2);
});

test('drain: a covered craft with fewer units than its rate pays the full rate and lands on 0 (no pro-rating)', () => {
  const v = craft('vehicle_g1_heavyTransport_01', HEAVY_TRANSPORT, 2 / CRAFT_WEAR_SCALE);   // 2 units < 6
  const s = world([v], { pool: 5 });
  step(s);
  assert.equal(v.maintenanceCondition, 0);
  assert.equal(s.syndicate.ledger, 5);
});

test('drain: an empty pool covers nothing — every flying craft wears unmaintained; an idle craft is not in the drain', () => {
  const flying = craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 1);
  const idle = craft('vehicle_g1_lightTransport_02', LIGHT_TRANSPORT, 1, 'idle');
  const docked = craft('vehicle_g1_lightTransport_03', LIGHT_TRANSPORT, 1, 'loading');
  const s = world([flying, idle, docked]);
  step(s);
  assert.equal(CRAFT_WEAR_SCALE - units(flying), 6);
  assert.equal(idle.maintenanceCondition, 1);
  assert.equal(docked.maintenanceCondition, 1);
  assert.equal(s.syndicate.ledger, 0);
  assert.equal(s.guilds[0].craftMaintenance, undefined, 'nothing stored for a guild that never funded');
});

test('drain: wear does not re-stamp updatedAtTick, and changes nothing but the condition', () => {
  const v = craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 1);
  v.updatedAtTick = 7;
  const before = structuredClone(v);
  const s = world([v]);
  step(s);
  const after = { ...v };
  delete after.maintenanceCondition;
  delete before.maintenanceCondition;
  assert.deepEqual(after, before, 'speed, fuel, capacity, status and the stamp are untouched');
});

// ── F. the pool ──────────────────────────────────────────────────────────────────────────────────────────

test('refill: at the boundary min(budget, credits) moves in; a budget above the credits takes what is there; negative credits give 0', () => {
  for (const [credits, budgetSet, expectPool, expectCredits] of [[100, 30, 30, 70], [20, 30, 20, 0], [-50, 30, 0, -50]]) {
    const s = world([], { budget: budgetSet, credits });
    step(s, true);
    assert.equal(readCraftMaintenance(s.guilds[0]).pool, expectPool, `credits ${credits}, budget ${budgetSet}`);
    assert.equal(s.guilds[0].credits, expectCredits);
  }
});

test('refill: unspent pool carries forward, no cap', () => {
  const s = world([], { budget: 10, credits: 1_000, pool: 4 });
  step(s, true);
  step(s);
  step(s, true);
  assert.equal(readCraftMaintenance(s.guilds[0]).pool, 24);
});

test('boundary order: the boundary tick drains FIRST at the pool as it stands, THEN rolls spent, THEN refills', () => {
  const v = craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 1);
  const s = world([v], { budget: 50, credits: 1_000 });   // pool empty going into the boundary
  step(s);                                               // an ordinary tick: nothing to pay with
  assert.equal(v.maintenanceCovered, undefined);
  step(s, true);                                         // the boundary: drained at pool 0 — not covered
  assert.equal(v.maintenanceCovered, undefined, 'the refill did not pay for its own boundary tick');
  let rec = readCraftMaintenance(s.guilds[0]);
  assert.equal(rec.pool, 50, 'then the refill landed');
  assert.equal(rec.spentLastCycle, 0);
  step(s);                                               // first tick of the new cycle: covered
  assert.equal(v.maintenanceCovered, true);
  for (let i = 0; i < 5; i += 1) step(s);
  step(s, true);                                         // the next boundary pays (pool 44 → 43), then rolls 7
  rec = readCraftMaintenance(s.guilds[0]);
  assert.equal(rec.spentLastCycle, 7, '"spent last cycle" includes the boundary tick that closed it');
  assert.equal(rec.spentThisCycle, 0);
  assert.equal(rec.pool, 43 + 50);
});

test('pool: in the engine, the refill lands on the cycle boundary tick and is read off the guild\'s credits', () => {
  let s = engineGalaxy({ credits: 500, tick: DAY - 3 });
  s = accept(s, budget(120));
  s = run(s, 2);
  assert.equal(readCraftMaintenance(g1Of(s)).pool, 0, 'not before the boundary');
  s = run(s, 1);
  assert.equal(s.tick, DAY);
  assert.equal(readCraftMaintenance(g1Of(s)).pool, 120);
  assert.equal(g1Of(s).credits, 380);
});

// ── G. the actions ───────────────────────────────────────────────────────────────────────────────────────

test('actions: the budget is stored (0 clears it, byte-identical); a top-up moves credits into the pool at once', () => {
  const s0 = engineGalaxy({ credits: 1_000 });
  const s1 = accept(s0, budget(250));
  assert.deepEqual(g1Of(s1).craftMaintenance, { budget: 250 });
  assert.equal(g1Of(s1).credits, 1_000, 'setting a budget moves no credit');
  assert.equal(hashState(accept(s1, budget(0))), hashState(s0), 'cleared back to the default: no key left');
  const s2 = accept(s1, topUp(400));
  assert.deepEqual(g1Of(s2).craftMaintenance, { budget: 250, pool: 400 });
  assert.equal(g1Of(s2).credits, 600);
  assert.equal(s2.syndicate.ledger, s1.syndicate.ledger, 'the ledger does not move — it is still the guild\'s money');
  assert.equal(hashState(accept(s2, topUp(600))), hashState(accept(accept(s1, topUp(1_000)), budget(250))),
    'the whole balance may go in');
});

test('actions: refusals — unknown guild, non-whole or out-of-range values, a top-up above the credits', () => {
  const s = engineGalaxy({ credits: 100 });
  assert.match(refuse(s, budget(10, 'gX')), /no guild with id "gX"/);
  assert.match(refuse(s, topUp(10, 'gX')), /no guild with id "gX"/);
  for (const bad of [-1, 2.5, '3', NaN, null, Infinity]) {
    assert.match(refuse(s, budget(bad)), /budget must be a whole number of credits ≥ 0/);
    assert.match(refuse(s, topUp(bad)), /amount must be a whole number of credits ≥ 1/);
  }
  assert.match(refuse(s, topUp(0)), /amount must be a whole number of credits ≥ 1/);
  assert.match(refuse(s, topUp(101)), /has 100 credits/);
  assert.equal(validateAction(s, topUp(100)).valid, true);
  const broke = structuredClone(s);
  g1Of(broke).credits = -5;
  assert.match(refuse(broke, topUp(1)), /has -5 credits/, 'a guild in debt cannot top up');
  assert.equal(validateAction(s, budget(1_000_000)).valid, true, 'a budget above the credits is legal');
});

test('actions: there is no withdrawal — no action takes credits back out of the pool', () => {
  const s = accept(engineGalaxy({ credits: 100 }), topUp(50));
  for (const type of ['withdrawCraftMaintenancePool', 'withdrawMaintenancePool']) {
    assert.equal(validateAction(s, { type, guildId: 'g1', amount: 10 }).valid, false);
  }
  assert.equal(validateAction(s, topUp(-10)).valid, false, 'a negative top-up is not a back door');
  assert.equal(validateAction(s, budget(-10)).valid, false);
});

test('actions (§15.2): the journal line records the tick, and replays both actions to the same bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-maintenance-'));
  try {
    let s = engineGalaxy({ credits: 900, tick: 4_321 });
    saveState(s, dir);
    for (const action of [budget(70), topUp(30)]) {
      assert.equal(validateAction(s, action).valid, true);
      appendJournal(s.tick, action, dir);   // the server's validate → journal → apply path
      s = applyAction(s, action);
    }
    const lines = fs.readFileSync(journalPath(dir), 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ tick: 4_321, action: budget(70) }, { tick: 4_321, action: topUp(30) }]);
    const recovered = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
    assert.equal(hashState(recovered), hashState(s));
    assert.deepEqual(g1Of(recovered).craftMaintenance, { budget: 70, pool: 30 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── H. conservation and neutrality ───────────────────────────────────────────────────────────────────────

// fundedRun(funded) — the same flight, with or without a pool. advance() asserts invariant 2 every tick.
function fundedRun(funded) {
  let s = engineGalaxy({ credits: 10_000, tick: DAY - 40 });
  s.windowN = DAY;
  if (funded) {
    s = accept(s, budget(100));
    s = accept(s, topUp(1_000));   // enough for the whole 630-tick flight, so the pool never runs dry
  }
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: LIGHT_ID, waypoints: [{ q: 3, r: 0 }, { q: 0, r: 0 }] }));
  return run(s, 700);
}

test('conservation: a funded run crosses a refill with invariant 2 green every tick; the paid credits are in the ledger', () => {
  const s = fundedRun(true);
  const rec = readCraftMaintenance(g1Of(s));
  const paid = s.syndicate.ledger - fundedRun(false).syndicate.ledger;
  assert.ok(paid > 0);
  assert.equal(g1Of(s).credits + rec.pool + paid, 10_000, 'credits + pool + what the ledger received = what we started with');
  assert.equal(rec.spentLastCycle + rec.spentThisCycle, paid);
});

test('neutrality: funding maintenance moves credits, the pool, the ledger and condition — and nothing else', () => {
  const strip = (state) => {
    const x = structuredClone(state);
    for (const g of x.guilds) {
      delete g.credits;
      delete g.craftMaintenance;
      for (const v of g.vehicles || []) { delete v.maintenanceCondition; delete v.maintenanceCovered; }
    }
    delete x.syndicate.ledger;
    return x;
  };
  const funded = fundedRun(true);
  const unfunded = fundedRun(false);
  assert.notEqual(vehicleOf(funded, LIGHT_ID).maintenanceCondition, vehicleOf(unfunded, LIGHT_ID).maintenanceCondition);
  assert.equal(hashState(strip(funded)), hashState(strip(unfunded)),
    'no GP, RP, modifier, fuel, licence, fee, event or price moved');
});

// ── I. the readout ───────────────────────────────────────────────────────────────────────────────────────

test('readout: pool, budget, ceiling, spentLastCycle, nextRefillTick; per craft the flight ticks left and the covered flag', () => {
  let s = engineGalaxy({ credits: 10_000, tick: 100 });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: { q: 0, r: 0 }, condition: 0.5 }));
  s = accept(s, budget(300));
  s = accept(s, topUp(40));
  let row = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1');
  assert.deepEqual(row.craftMaintenance, {
    pool: 40, budget: 300, ceiling: (1 + 5) * DAY, spentLastCycle: 0, nextRefillTick: DAY,
  });
  const heavyRow = row.vehicles.find((v) => v.class === HEAVY_TRANSPORT);
  assert.deepEqual(heavyRow.craftMaintenance, {
    flightTicksLeftMaintained: 40_320, flightTicksLeftUnmaintained: 20_160, earlyMaintenanceAllowed: false, // slice 4's flag
  }, 'no covered flag while not flying');
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: LIGHT_ID, waypoints: [{ q: 3, r: 0 }] }));
  assert.equal(buildSnapshot(s, 'g1').guilds[0].vehicles.find((v) => v.id === LIGHT_ID).craftMaintenance.covered, false,
    'not yet drained: false until its first flight tick');
  s = run(s, 2);
  row = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1');
  const light = row.vehicles.find((v) => v.id === LIGHT_ID);
  assert.deepEqual(light.craftMaintenance, {
    flightTicksLeftMaintained: Math.ceil((CRAFT_WEAR_SCALE - 6) / 3),
    flightTicksLeftUnmaintained: Math.ceil((CRAFT_WEAR_SCALE - 6) / 6),
    covered: true,
    earlyMaintenanceAllowed: false, // maintenance slice 4: in flight, so not now
  });
  assert.equal(row.craftMaintenance.pool, 38);
  // The rival sees none of it — not the pool, not a craft.
  const rivalView = buildSnapshot(s, 'g2').guilds.find((g) => g.id === 'g1');
  assert.equal(rivalView.craftMaintenance, undefined);
  assert.equal(rivalView.vehicles, undefined);
  assert.equal(JSON.stringify(buildSnapshot(s, 'g2')).includes('flightTicksLeft'), false);
});

test('readout: a guild with no craft and no pool carries no craftMaintenance block', () => {
  const s = createState({ guilds: [{ id: 'g1', credits: 5, fuelHoard: 0 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  assert.equal(buildSnapshot(s, 'g1').guilds[0].craftMaintenance, undefined);
});

// ── J. the notice ────────────────────────────────────────────────────────────────────────────────────────

const dryNotices = (s) => (s.guilds[0].events || []).filter((e) => e.type === 'maintenance_pool_dry');

test('notice: written once per cycle at most — the first tick a craft above 0% goes uncovered — and again next cycle', () => {
  const v = craft('vehicle_g1_heavyTransport_01', HEAVY_TRANSPORT, 1);
  const s = world([v], { pool: 12, windowN: 10 });
  step(s); step(s);   // ticks 1–2 covered (12 → 2)
  assert.equal(dryNotices(s).length, 0);
  step(s);            // tick 3: 2 < 5
  assert.deepEqual(dryNotices(s).map((e) => [e.tick, e.payload]), [[3, { pool: 2, vehicleIds: [v.id], nextRefillTick: 10 }]]);
  for (let t = 4; t <= 9; t += 1) step(s);
  step(s, true);      // tick 10, the boundary: still dry, but this cycle was already told
  assert.equal(dryNotices(s).length, 1);
  step(s);            // tick 11, a new cycle: the pool (still 2, budget 0) is told again — once
  step(s);
  assert.deepEqual(dryNotices(s).map((e) => e.tick), [3, 11]);
});

test('notice: never for a guild that has not opted in, never for a craft at 0%, never when everyone is covered', () => {
  const unfunded = world([craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 1)]);
  for (let i = 0; i < 5; i += 1) step(unfunded);
  assert.equal(dryNotices(unfunded).length, 0, 'budget 0 and an empty pool is "unmaintained", not "ran dry"');
  const deadOnly = world([craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 0)], { pool: 0, budget: 10 });
  step(deadOnly);
  assert.equal(dryNotices(deadOnly).length, 0, 'a craft at 0% is not in the drain');
  const covered = world([craft('vehicle_g1_lightTransport_01', LIGHT_TRANSPORT, 1)], { pool: 5 });
  for (let i = 0; i < 5; i += 1) step(covered);
  assert.equal(dryNotices(covered).length, 0);
  step(covered);      // the sixth tick: the pool emptied on the fifth, so it is now dry
  assert.equal(dryNotices(covered).length, 1, 'a pool that held credits this cycle and ran out is told');
});

// ── K. the no-op ─────────────────────────────────────────────────────────────────────────────────────────

// The script below, run on main at bb1a9c5 (before this slice): an idle light berthed across the tick-1,440 cycle
// boundary, no pool. The state must not move by a byte. (The SNAPSHOT gains the additive readout keys, so its pin is
// checked with exactly those keys removed.)
const NOOP_GOLDEN = {
  state: '42ad88f3b38a87f5362771a07c1085819636959eb1ae177e4e238a220f9ed565',
  snapshot: '67e3988b6f65421049cb07339c4cf79db3e10c4d77760c1461c7f5bb0a30530e',
};
test('no-op: a galaxy where nothing flies and no pool exists hashes exactly as before this slice, across a boundary', () => {
  let s = engineGalaxy({ tick: DAY - 20 });
  s = run(s, 40);
  assert.equal(s.tick, DAY + 20);
  const snap = buildSnapshot(s, 'g1');
  for (const g of snap.guilds) {
    delete g.craftMaintenance;
    for (const v of g.vehicles || []) delete v.craftMaintenance;
  }
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.deepEqual({ state: hashState(s), snapshot: sha(snap) }, NOOP_GOLDEN);
});

// ── L. determinism ───────────────────────────────────────────────────────────────────────────────────────

test('determinism: two runs are identical; save → restore → continue matches an unbroken run', () => {
  assert.equal(hashState(fundedRun(true)), hashState(fundedRun(true)));
  let s = engineGalaxy({ credits: 10_000, tick: DAY - 40 });
  s = accept(s, budget(100));
  s = accept(s, topUp(15));
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: LIGHT_ID, waypoints: [{ q: 3, r: 0 }, { q: 0, r: 0 }] }));
  s = run(s, 10);   // mid-flight, mid-cycle, the pool still paying (it covers ticks 1,401 … 1,415)
  assert.equal(vehicleOf(s, LIGHT_ID).maintenanceCovered, true);
  const unbroken = run(s, 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-maintenance-restore-'));
  try {
    saveState(s, dir);
    const restored = run(loadOrInit(dir, () => { throw new Error('should restore, not init'); }), 400);
    assert.equal(hashState(restored), hashState(unbroken));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 15 credits run dry at tick 1,416; the tick-1,440 refill pays 100 more ticks and runs dry again in the new cycle.
  assert.deepEqual(dryNotices(unbroken).map((e) => e.tick), [DAY - 24, DAY + 101], 'one dry spell per cycle, across a refill');
});
