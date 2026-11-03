'use strict';

// droid-decay.test.js — roadmap 2.6, droid engine slice 5: DECAY, the weekly droid_components UPKEEP, and
// DESTRUCTION AT ZERO (docs/droids.md §5/§9/§10; the numbers docs/phase-1-tuning.md §Droids).
//
// The tripwires, in order:
//   1. THE NUMBERS: the lives, the upkeep, the default reserve and the week, typed from the doc.
//   2. NO-OP BYTE-IDENTICAL: a galaxy with no DEPLOYED droid hashes exactly as it did at 8ffbd21.
//   3. DECAY: a deployed droid wears to exactly 0 in exactly its ruled life — guild 4 wk / 8 wk, Syndicate
//      2 wk / 4 wk (uncovered / covered); idle droids never wear; decay only goes down.
//   4. DESTROY AT ZERO: the droid is removed the tick it reaches 0, the loss is recorded, its id is never
//      reissued (even the TOP-numbered one), the boost drops, and its cap slot frees.
//   5. UPKEEP: each week boundary draws 1 (guild) / 2 (Syndicate) droid_components per deployed droid from
//      the droid's OWN system, lowest-condition-first when short, never below the reserve floor; a droid
//      deployed mid-week is unmaintained until the next boundary; unassign clears coverage.
//   6. NEUTRALITY: wear and upkeep move nothing but the droids, droid_components and the notice — no GP, no
//      mean line, no fee, no credit, no fuel.
//   7. DETERMINISM (invariant 9): two runs, and a save/restore, are byte-identical.
//   8. SNAPSHOT: maintained flags and the per-system upkeep row; omitted when absent; fogged from rivals.
//   9. THE NEW INVARIANTS bite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { stepDroidUpkeep } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints } = require('../points.js');
const { issuanceModifier, expectedReputation } = require('../meanline.js');
const {
  DROID_WEEK_TICKS, DROID_COMPONENTS, DROID_LIFE_TICKS, DROID_UPKEEP_PER_WEEK, DROID_COMPONENT_RESERVE_DEFAULT,
  DROID_WEAR_SCALE, wearPerTick, decayedCondition, decayDroidsIn, fundDroidUpkeep, mintDroid, assignedDroidCount,
} = require('../droids.js');
const {
  validateAction, applyAction, createAssignDroidAction, createUnassignDroidAction, createApplyForLicenceAction, intake,
} = require('../actions.js');
const { droidlessDecayScript } = require('./droid-decay-noop-script.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const WEEK = 10_080;
const droidIdFor = (n) => `asset_g1_droid_${String(n).padStart(2, '0')}`;

// droid(n, source, extra) -> a droid row DEPLOYED to venture 'm' at tick 0 (pass { idle: true } for an idle one).
function droid(n, source = 'guild', { condition = 1, idle = false, maintained, systemId = SYS, ventureId = 'm' } = {}) {
  return {
    id: droidIdFor(n), systemId, source, condition, updatedAtTick: 0,
    ...(idle ? {} : { assignedToVentureId: ventureId, deployedAtTick: 0 }),
    ...(maintained ? { maintained: true } : {}),
  };
}
const mine = (id, good = 'titanium', productionRate = 5, systemId = SYS) => (
  { id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: good, productionRate }
);

// galaxy({ droids, stock, ventures, tick, reserve }) -> one guild, every invariant checked before it is returned.
// `tick` puts the galaxy at that tick, so a test can sit just before a week boundary without running 10,080 ticks.
function galaxy({ droids = [], stock = {}, ventures = [mine('m')], tick = 0, reserve, extraGuilds = [] } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 100_000, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures,
      ...(droids.length ? { droids, droidSerial: Math.max(...droids.map((d) => Number(d.id.split('_').pop()))) } : {}),
      ...(reserve ? { droidComponentReserve: reserve } : {}),
    }, ...extraGuilds],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  s.tick = tick;
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fixture itself is legal');
  return s;
}
// run(s, n) — advance() asserts EVERY invariant on EVERY tick and throws naming the tick, so every run below is
// also the "integer goods, galactic supply and the droid rules hold every tick" proof.
function run(s, n) {
  let out = s;
  for (let i = 0; i < n; i += 1) out = advance(out).state;
  return out;
}
const g1Of = (s) => s.guilds[0];
const droidOf = (s, id) => (g1Of(s).droids || []).find((d) => d.id === id);
const held = (s, good, sys = SYS) => ((g1Of(s).stockpiles || {})[sys] || {})[good] || 0;
const units = (condition) => Math.round(condition * DROID_WEAR_SCALE);
function accept(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected ${action.type} accepted, got: ${reason}`);
  const next = applyAction(s, action);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
}

// --- 1. the numbers -----------------------------------------------------------------------------------------

test('numbers: the ruled lives, upkeep, reserve default and week — typed from docs/phase-1-tuning.md §Droids', () => {
  // Retune there and here together.
  assert.equal(DROID_WEEK_TICKS, WEEK, 'the maintenance week is the Tier-3 week, 10,080 ticks');
  assert.deepEqual(DROID_LIFE_TICKS, {
    guild: { uncovered: 4 * WEEK, covered: 8 * WEEK },
    syndicate: { uncovered: 2 * WEEK, covered: 4 * WEEK },
  });
  assert.deepEqual(DROID_UPKEEP_PER_WEEK, { guild: 1, syndicate: 2 });
  assert.equal(DROID_COMPONENT_RESERVE_DEFAULT, 0);
  assert.equal(DROID_COMPONENTS, 'droid_components');
  // The wear scale is DERIVED (the least common multiple of the lives), and every rate is a whole number of it.
  assert.equal(DROID_WEAR_SCALE, 80_640);
  assert.equal(wearPerTick('guild', false), 2);
  assert.equal(wearPerTick('guild', true), 1, 'maintenance halves the wear');
  assert.equal(wearPerTick('syndicate', false), 4);
  assert.equal(wearPerTick('syndicate', true), 2);
  assert.throws(() => wearPerTick('pirate', false), /unknown droid source/);
});

test('decayedCondition: whole-unit steps, never below 0, ALWAYS strictly down — even off the grid', () => {
  assert.equal(decayedCondition(1, 2), (80_640 - 2) / 80_640);
  assert.equal(decayedCondition(2 / 80_640, 2), 0, 'lands on exactly 0');
  assert.equal(decayedCondition(1 / 80_640, 2), 0, 'clamped at 0, never negative');
  assert.equal(decayedCondition(0, 1), 0);
  // A hand-built condition that is not a whole number of units still only goes down.
  for (const c of [0.3, 0.123456789, 1e-7, 0.99999999]) {
    for (const w of [1, 2, 4]) assert.ok(decayedCondition(c, w) < c, `${c} - ${w} units goes down`);
  }
});

// --- 2. no-op byte-identical --------------------------------------------------------------------------------

// RECORDED AT 8ffbd21 (main, before this slice's code existed) by running droid-decay-noop-script.js there: two
// idle droids (one per source) beside 30 droid_components, a droidless second guild, production running, and the
// run crossing the tick-10,080 week boundary.
const DROIDLESS_GOLDEN_8FFBD21 = '041dcf19b17f93692aea28346209c46e2d4fc78b74b59166db556d8730c518e0';

test('no-op: a galaxy with no DEPLOYED droid is byte-identical to 8ffbd21 — idle droids neither wear nor draw', () => {
  const s = droidlessDecayScript();
  assert.ok(s.tick > WEEK, 'the run crossed the week boundary, where upkeep would draw');
  assert.equal(droidOf(s, droidIdFor(1)).condition, 1, 'the idle guild droid did not wear');
  assert.equal(droidOf(s, droidIdFor(2)).condition, 0.75, 'the idle Syndicate droid did not wear');
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined, 'an idle droid is never maintained');
  assert.equal(held(s, DROID_COMPONENTS), 30, 'no component was drawn');
  assert.equal(hashState(s), DROIDLESS_GOLDEN_8FFBD21);
});

// --- 3. decay: the ruled lives ------------------------------------------------------------------------------

// lifeOf(source, covered) -> the producing tick a NEW deployed droid is destroyed on, driving the real per-system
// step (stepDroidUpkeep) tick by tick over a bare state — the whole life without 80,000 full ticks. With `covered`
// the droid starts maintained on a week boundary and the system holds enough components for every boundary after.
function lifeOf(source, covered) {
  const start = covered ? WEEK : 0; // a covered droid starts the tick after a boundary, already paid for
  const guild = {
    id: 'g1', droidSerial: 1,
    droids: [droid(1, source, { maintained: covered })],
    stockpiles: { [SYS]: { [DROID_COMPONENTS]: covered ? 100 : 0 } },
  };
  const state = { tick: start, dayAnchorTick: 0, guilds: [guild] };
  let destroyedOn = null;
  let last = 1;
  while (destroyedOn === null) {
    stepDroidUpkeep(state, guild, SYS);
    state.tick += 1;
    const d = (guild.droids || [])[0];
    if (!d) { destroyedOn = state.tick; break; }
    assert.ok(d.condition < last, 'decay is monotonic: down every deployed tick');
    if (covered) assert.equal(d.maintained, true, `still maintained at tick ${state.tick}`);
    last = d.condition;
    if (state.tick > start + 9 * WEEK) throw new Error('never wore out');
  }
  return { ticks: destroyedOn - start, guild };
}

test('decay: a deployed GUILD droid wears out in exactly 4 weeks unmaintained, 8 weeks maintained', () => {
  assert.equal(lifeOf('guild', false).ticks, 4 * WEEK);
  const covered = lifeOf('guild', true);
  assert.equal(covered.ticks, 8 * WEEK);
  // Paid on each of the 7 boundaries it lived through after its first (pre-paid) week, 1 a week: 100 - 7.
  assert.equal(covered.guild.stockpiles[SYS][DROID_COMPONENTS], 93);
});

test('decay: a deployed SYNDICATE droid wears out in exactly 2 weeks unmaintained, 4 weeks maintained', () => {
  assert.equal(lifeOf('syndicate', false).ticks, 2 * WEEK);
  const covered = lifeOf('syndicate', true);
  assert.equal(covered.ticks, 4 * WEEK);
  // 3 boundaries after the pre-paid week, 2 a week: 100 - 6.
  assert.equal(covered.guild.stockpiles[SYS][DROID_COMPONENTS], 94);
});

test('decay through the real tick: one tick of wear per deployed droid, idle droids untouched, no restamp', () => {
  let s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'syndicate'), droid(3, 'guild', { idle: true, condition: 0.5 })],
  });
  s = run(s, 25);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), 80_640 - 25 * 2, 'guild: 2 units a tick');
  assert.equal(units(droidOf(s, droidIdFor(2)).condition), 80_640 - 25 * 4, 'Syndicate: 4 units a tick');
  assert.equal(droidOf(s, droidIdFor(3)).condition, 0.5, 'idle: no wear');
  for (const n of [1, 2, 3]) {
    assert.equal(droidOf(s, droidIdFor(n)).updatedAtTick, 0, 'wear is ambient — it does not restamp the row');
  }
});

// --- 4. destroy at zero -------------------------------------------------------------------------------------

test('destroy: a droid is removed the tick it reaches 0, the loss is recorded, and the boost drops at once', () => {
  // 20 guild droids, all 3 ticks from the end: a full complement doubles the mine (10 a tick) until they go.
  const droids = Array.from({ length: 20 }, (_, i) => droid(i + 1, 'guild', { condition: 6 / 80_640 }));
  let s = galaxy({ droids });
  s = run(s, 2);
  assert.equal(g1Of(s).droids.length, 20, 'two ticks in: worn but alive');
  assert.equal(held(s, 'titanium'), 20, 'boosted: 10 a tick');
  s = run(s, 1);
  assert.equal(g1Of(s).droids, undefined, 'tick 3: all twenty reached 0 and are gone — the key omitted when empty');
  assert.equal(held(s, 'titanium'), 30, 'they still boosted the tick they wore out on');
  assert.equal(g1Of(s).droidSerial, 20, 'the serial is untouched — it only climbs');
  const notices = g1Of(s).events.filter((e) => e.type === 'droids_spent');
  assert.equal(notices.length, 1, 'one notice for the system, not one per droid');
  assert.equal(notices[0].tick, 3);
  assert.equal(notices[0].payload.systemId, SYS);
  assert.equal(notices[0].payload.systemName, SYS, 'an unseeded system falls back to its id');
  assert.deepEqual(notices[0].payload.spent.map((x) => x.droidId), droids.map((d) => d.id).sort());
  assert.deepEqual(notices[0].payload.spent[0], { droidId: droidIdFor(1), source: 'guild', ventureId: 'm' });
  s = run(s, 1);
  assert.equal(held(s, 'titanium'), 35, 'the boost is gone: back to the droidless 5 a tick');
});

test('destroy: the TOP-numbered droid\'s id is never reissued — the serial does not read live rows', () => {
  let s = galaxy({
    droids: [droid(1, 'guild', { idle: true }), droid(2, 'guild'), droid(3, 'syndicate', { condition: 4 / 80_640 })],
  });
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(3)), undefined, 'droid 03, the highest number, wore out');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a serial above every live droid is legal');
  const next = structuredClone(s);
  const minted = mintDroid(g1Of(next), 'guild', SYS, next.tick);
  assert.equal(minted.id, droidIdFor(4), 'the next droid is 04, never 03 again');
});

test('destroy: a spent droid frees its cap slot — "assigned" and "alive" coincide (docs/droids.md §10)', () => {
  const droids = Array.from({ length: 20 }, (_, i) => droid(i + 1, 'guild', { condition: i === 0 ? 2 / 80_640 : 1 }));
  droids.push(droid(21, 'guild', { idle: true }));
  let s = galaxy({ droids });
  assert.equal(validateAction(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(21), ventureId: 'm' })).valid, false, 'full');
  s = run(s, 1);
  assert.equal(assignedDroidCount(g1Of(s), 'm'), 19);
  s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(21), ventureId: 'm' }));
  assert.equal(assignedDroidCount(g1Of(s), 'm'), 20);
});

// --- 5. upkeep ----------------------------------------------------------------------------------------------

test('upkeep: the week boundary draws 1 per guild droid and 2 per Syndicate droid, and the slow rate follows', () => {
  let s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'syndicate'), droid(3, 'guild', { idle: true })],
    stock: { [DROID_COMPONENTS]: 10 },
    tick: WEEK - 2, // the next two producing ticks are 10,079 and 10,080 (the boundary)
  });
  s = run(s, 1);
  assert.equal(held(s, DROID_COMPONENTS), 10, 'off the boundary nothing is drawn');
  const atBoundary = { g: units(droidOf(s, droidIdFor(1)).condition), y: units(droidOf(s, droidIdFor(2)).condition) };
  s = run(s, 1);
  assert.equal(s.tick, WEEK);
  assert.equal(held(s, DROID_COMPONENTS), 10 - 1 - 2, 'one guild + one Syndicate droid: 3 drawn');
  assert.equal(droidOf(s, droidIdFor(1)).maintained, true);
  assert.equal(droidOf(s, droidIdFor(2)).maintained, true);
  assert.equal(droidOf(s, droidIdFor(3)).maintained, undefined, 'the idle droid is not paid for');
  assert.equal(droidOf(s, droidIdFor(1)).updatedAtTick, WEEK - 1, 'the coverage set is a discrete mutation: stamped');
  assert.equal(droidOf(s, droidIdFor(3)).updatedAtTick, 0, 'the idle droid is not touched');
  // The boundary tick itself still wore at LAST week's (fast) rate; the slow rate starts the tick after.
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), atBoundary.g - 2);
  assert.equal(units(droidOf(s, droidIdFor(2)).condition), atBoundary.y - 4);
  s = run(s, 10);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), atBoundary.g - 2 - 10, 'maintained guild: 1 a tick');
  assert.equal(units(droidOf(s, droidIdFor(2)).condition), atBoundary.y - 4 - 20, 'maintained Syndicate: 2 a tick');
  assert.equal(held(s, DROID_COMPONENTS), 7, 'nothing more drawn mid-week');
});

test('upkeep: when short, the LOWEST-condition droids are covered first, ties broken by id', () => {
  const s = galaxy({
    droids: [
      droid(1, 'guild', { condition: 0.5 }),
      droid(2, 'guild', { condition: 0.25 }),
      droid(3, 'guild', { condition: 0.25 }),
      droid(4, 'guild', { condition: 0.75 }),
    ],
    stock: { [DROID_COMPONENTS]: 2 },
  });
  const g = structuredClone(g1Of(s));
  assert.deepEqual(fundDroidUpkeep(g, SYS, 7), { drawn: 2, covered: 2, uncovered: 2 });
  assert.deepEqual(g.droids.filter((d) => d.maintained).map((d) => d.id), [droidIdFor(2), droidIdFor(3)],
    'the two at 0.25, not 0.5 or 0.75');
  assert.equal(g.stockpiles[SYS][DROID_COMPONENTS], 0);
  for (const d of g.droids) assert.equal(d.updatedAtTick, 7, 'every deployed droid\'s coverage was set, so stamped');
});

test('upkeep: a droid the remaining stock cannot pay for is skipped, and a cheaper one after it is still covered', () => {
  const s = galaxy({
    droids: [droid(1, 'syndicate', { condition: 0.1 }), droid(2, 'guild', { condition: 0.9 })],
    stock: { [DROID_COMPONENTS]: 1 },
  });
  const g = structuredClone(g1Of(s));
  assert.deepEqual(fundDroidUpkeep(g, SYS, 0), { drawn: 1, covered: 1, uncovered: 1 });
  assert.equal(g.droids[0].maintained, undefined, 'the Syndicate droid needs 2 — there is 1');
  assert.equal(g.droids[1].maintained, true, 'the 1 left covers the guild droid');
});

test('upkeep: a boundary that cannot pay UNCOVERS last week\'s maintained droids', () => {
  let s = galaxy({ droids: [droid(1, 'guild', { maintained: true })], tick: WEEK - 1 });
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined, 'no stock: the new week is unmaintained');
  const before = units(droidOf(s, droidIdFor(1)).condition);
  s = run(s, 1);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), before - 2, 'back to the fast rate');
});

test('upkeep: never draws below the system\'s reserve floor', () => {
  const s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'guild'), droid(3, 'guild')],
    stock: { [DROID_COMPONENTS]: 5 },
    reserve: { [SYS]: 4 },
  });
  const g = structuredClone(g1Of(s));
  assert.deepEqual(fundDroidUpkeep(g, SYS, 0), { drawn: 1, covered: 1, uncovered: 2 }, 'only 5 - 4 = 1 is spendable');
  assert.equal(g.stockpiles[SYS][DROID_COMPONENTS], 4, 'the floor is left standing');
  // Stock already below the floor: nothing is spendable, nothing drawn, nothing goes negative.
  const low = structuredClone(g1Of(s));
  low.stockpiles[SYS][DROID_COMPONENTS] = 2;
  assert.deepEqual(fundDroidUpkeep(low, SYS, 0), { drawn: 0, covered: 0, uncovered: 3 });
  assert.equal(low.stockpiles[SYS][DROID_COMPONENTS], 2);
});

test('upkeep: droids are maintained from their OWN system\'s stock only — another system\'s is never touched', () => {
  let s = galaxy({
    droids: [droid(1, 'guild')],
    ventures: [mine('m'), mine('m_b', 'copper', 4, SYS_B)],
    tick: WEEK - 1,
  });
  g1Of(s).stockpiles[SYS_B] = { [DROID_COMPONENTS]: 50 };
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined, 'sysA has none, so its droid is unmaintained');
  assert.equal(held(s, DROID_COMPONENTS, SYS_B), 50, 'sysB\'s stock is untouched');
});

test('upkeep: a droid deployed mid-week is unmaintained until the next boundary pays for it', () => {
  let s = galaxy({ droids: [droid(1, 'guild', { idle: true })], stock: { [DROID_COMPONENTS]: 5 }, tick: WEEK + 3 });
  s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(1), ventureId: 'm' }));
  s = run(s, 10);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), 80_640 - 20, 'the fast rate');
  assert.equal(held(s, DROID_COMPONENTS), 5);
  s.tick = 2 * WEEK - 1; // jump to just before the next boundary (deployedAtTick stays in the past)
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, true, 'the next boundary covers it');
  assert.equal(held(s, DROID_COMPONENTS), 4);
});

test('upkeep: unassigning a maintained droid clears its coverage; the spent component is not refunded', () => {
  let s = galaxy({ droids: [droid(1, 'guild', { maintained: true })], stock: { [DROID_COMPONENTS]: 3 } });
  s = accept(s, createUnassignDroidAction({ guildId: 'g1', droidId: droidIdFor(1) }));
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined);
  assert.equal(held(s, DROID_COMPONENTS), 3);
});

test('upkeep: the draw is conserved — stock falls by exactly what the covered droids cost, every boundary', () => {
  const droids = [
    droid(1, 'guild'), droid(2, 'guild', { condition: 0.4 }), droid(3, 'syndicate'), droid(4, 'syndicate', { condition: 0.3 }),
  ];
  let s = galaxy({ droids, stock: { [DROID_COMPONENTS]: 5 }, tick: WEEK - 1 });
  s = run(s, 1);
  // 5 to spend, lowest first: Syndicate 04 (0.3, costs 2), guild 02 (0.4, 1), then Syndicate 03 — it wore 4 units
  // a tick against guild 01's 2, so it sits LOWER than 01 — costs 2, and that is the last of the stock.
  const covered = g1Of(s).droids.filter((d) => d.maintained);
  assert.deepEqual(covered.map((d) => d.id), [droidIdFor(2), droidIdFor(3), droidIdFor(4)]);
  const cost = covered.reduce((sum, d) => sum + DROID_UPKEEP_PER_WEEK[d.source], 0);
  assert.equal(5 - held(s, DROID_COMPONENTS), cost, 'drawn = Σ the covered droids\' upkeep');
  assert.equal(held(s, DROID_COMPONENTS), 0, 'nothing left for guild 01, the healthiest');
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined);
  // The galactic supply cache moved with the stock (advance() checked it; here it is spelled out).
  assert.equal(s.galacticSupply.resources[DROID_COMPONENTS], 0);
});

// --- 6. neutrality ------------------------------------------------------------------------------------------

// The step's whole footprint: everything but the droids, droid_components and the notice log must be untouched.
function strip(st) {
  const c = structuredClone(st);
  for (const g of c.guilds) {
    delete g.droids; delete g.events; delete g.eventSeq;
    for (const pool of Object.values(g.stockpiles || {})) delete pool[DROID_COMPONENTS];
  }
  return c;
}

test('neutrality: wear, destruction and upkeep move no GP, no mean line, no fee, no credit and no fuel', () => {
  // A licensed venture staffed with droids, on a week boundary, with one droid wearing out on that very tick.
  let s = galaxy({
    droids: [droid(1, 'syndicate', { condition: 4 / 80_640 }), droid(2, 'guild'), droid(3, 'syndicate')],
    stock: { [DROID_COMPONENTS]: 9 },
    tick: WEEK - 1,
  });
  const out = intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm', committedOutputPct: 0.5, windowDays: 7 })]);
  assert.ok(out.results[0].accepted, out.results[0].reason);
  s = out.state;
  const before = structuredClone(s);
  const g = g1Of(s);
  const pointsBefore = guildPoints(before, 'g1');
  const modBefore = issuanceModifier(before, 'g1');
  const rpBefore = expectedReputation(before, 'g1');
  stepDroidUpkeep(s, g, SYS); // the producing tick is WEEK: a boundary
  assert.equal(droidOf(s, droidIdFor(1)), undefined, 'one wore out');
  assert.equal(droidOf(s, droidIdFor(2)).maintained, true, 'and the rest were paid for');
  assert.ok(held(s, DROID_COMPONENTS) < 9, 'components were drawn');
  assert.deepEqual(strip(s), strip(before), 'nothing else in the whole state moved');
  assert.deepEqual(guildPoints(s, 'g1'), pointsBefore, 'no GP');
  assert.deepEqual(issuanceModifier(s, 'g1'), modBefore, 'no mean-line modifier');
  assert.deepEqual(expectedReputation(s, 'g1'), rpBefore, 'no RP');
  assert.deepEqual(g.ventures[0].licence, before.guilds[0].ventures[0].licence, 'the licence (and its fee) untouched');
});

// --- 7. determinism -----------------------------------------------------------------------------------------

function decayRun(n) {
  let s = galaxy({
    droids: [
      droid(1, 'guild', { condition: 0.001 }), droid(2, 'syndicate', { condition: 0.0005 }),
      droid(3, 'guild'), droid(4, 'syndicate'), droid(5, 'guild', { idle: true }),
    ],
    stock: { [DROID_COMPONENTS]: 3 },
    tick: WEEK - 30,
  });
  return run(s, n);
}

test('determinism (invariant 9): two runs across a boundary and a destruction are byte-identical', () => {
  const a = decayRun(60);
  assert.ok(g1Of(a).events.some((e) => e.type === 'droids_spent'), 'the run destroyed droids');
  assert.ok(g1Of(a).droids.some((d) => d.maintained), 'the run funded upkeep');
  assert.equal(hashState(a), hashState(decayRun(60)));
});

test('determinism (invariant 9): a save/restore mid-run continues byte-identically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-decay-'));
  try {
    const mid = decayRun(35); // past the boundary, with maintained flags and a worn condition on the books
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
    assert.equal(hashState(restored), hashState(mid), 'the save holds every field');
    assert.equal(hashState(run(restored, 25)), hashState(decayRun(60)), 'and continues as if never stopped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 8. snapshot --------------------------------------------------------------------------------------------

test('snapshot: each droid row shows maintained; the per-system upkeep row shows stock, need, coverage and runway', () => {
  let s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'syndicate'), droid(3, 'guild', { idle: true })],
    stock: { [DROID_COMPONENTS]: 12 },
    reserve: { [SYS]: 2 },
    tick: WEEK - 1,
  });
  s = run(s, 1); // the boundary draws 1 + 2 = 3, leaving 9
  const row = buildSnapshot(s).guilds[0];
  assert.equal(row.droids.find((d) => d.id === droidIdFor(1)).maintained, true);
  assert.equal(row.droids.find((d) => d.id === droidIdFor(3)).maintained, undefined, 'omitted when not maintained');
  assert.equal(typeof row.droids[0].condition, 'number');
  assert.deepEqual(row.droidUpkeep, {
    [SYS]: {
      stock: 9, reserve: 2, weeklyUpkeep: 3, maintained: 2, unmaintained: 0,
      runwayWeeks: 2, // floor((9 - 2) / 3)
      nextUpkeepTick: 2 * WEEK,
    },
  });
  // Fogged: a rival never sees the upkeep row (its guild row is cut to the public fields).
  const two = galaxy({
    droids: [droid(1, 'guild')],
    extraGuilds: [{ id: 'g2', credits: 0, fuelHoard: 0, stockpiles: {}, ventures: [] }],
  });
  const asRival = buildSnapshot(two, 'g2').guilds.find((g) => g.id === 'g1');
  assert.equal(asRival.droidUpkeep, undefined);
  assert.ok(buildSnapshot(two, 'g1').guilds.find((g) => g.id === 'g1').droidUpkeep, 'the owner sees it');
});

test('snapshot: no deployed droid → no droidUpkeep key (omit-when-absent)', () => {
  const s = galaxy({ droids: [droid(1, 'guild', { idle: true })], stock: { [DROID_COMPONENTS]: 4 } });
  assert.equal(buildSnapshot(s).guilds[0].droidUpkeep, undefined);
  assert.equal(buildSnapshot(galaxy()).guilds[0].droidUpkeep, undefined);
});

// --- 9. the new invariants ----------------------------------------------------------------------------------

test('invariants: maintained only on a deployed droid and only `true`; no deployed droid at 0; a whole reserve', () => {
  const rules = (mutate) => {
    const s = galaxy({ droids: [droid(1, 'guild'), droid(2, 'guild', { idle: true })] });
    mutate(g1Of(s));
    return checkInvariants(s, s.tick).map((v) => v.rule);
  };
  assert.ok(rules((g) => { g.droids[1].maintained = true; }).some((r) => r.startsWith('droid-maintained-valid')), 'idle');
  assert.ok(rules((g) => { g.droids[0].maintained = 'yes'; }).some((r) => r.startsWith('droid-maintained-valid')), 'not true');
  assert.ok(rules((g) => { g.droids[0].condition = 0; }).some((r) => r.startsWith('droid-deployed-alive')), 'undead');
  assert.deepEqual(rules((g) => { g.droids[1].condition = 0; }), [], 'an IDLE droid at 0 is legal (it never wears)');
  for (const bad of [-1, 1.5, '3']) {
    assert.ok(rules((g) => { g.droidComponentReserve = { [SYS]: bad }; }).includes('droid-component-reserve-valid'), String(bad));
  }
  assert.ok(rules((g) => { g.droidComponentReserve = [1]; }).includes('droid-component-reserve-valid'));
  assert.deepEqual(rules((g) => { g.droidComponentReserve = { [SYS]: 3 }; }), []);
});

test('tripwire: fundDroidUpkeep halts if the draw and the coverage ever disagree', () => {
  const s = galaxy({ droids: [droid(1, 'guild')], stock: { [DROID_COMPONENTS]: 3 } });
  const g = structuredClone(g1Of(s));
  // A getter that lies about the stock after the draw: the conservation check must notice.
  let reads = 0;
  const pool = g.stockpiles[SYS];
  let real = pool[DROID_COMPONENTS];
  Object.defineProperty(pool, DROID_COMPONENTS, {
    get() { reads += 1; return reads > 1 ? real + 1 : real; },
    set(v) { real = v; },
    enumerable: true, configurable: true,
  });
  assert.throws(() => fundDroidUpkeep(g, SYS, 0), /drew 1 droid_components/);
});

test('decayDroidsIn: a system with no deployed droid returns nothing and changes nothing', () => {
  const g = { id: 'g1', droids: [droid(1, 'guild', { idle: true })], stockpiles: {} };
  const before = structuredClone(g);
  assert.deepEqual(decayDroidsIn(g, SYS), []);
  assert.deepEqual(decayDroidsIn(g, 'elsewhere'), []);
  assert.deepEqual(g, before);
});
