'use strict';

// tier3-timed-production.test.js — Slice 2 of the Tier-3 economy build: every Tier-3 good is
// PRODUCED ON A TIMER, and a timed good's price capacity is measured per DAY, not per tick
// (docs/tier3-timed-production.md; numbers in docs/phase-1-tuning.md "Tier-3 production timers").
//
// What this file proves, in order:
//   1. THE NUMBERS — TICKS_PER_UNIT is the ruled table, every classified Tier-3 good resolves to
//      its timer, and Tier-1/2 goods (and the four unclassified modules) stay continuous.
//   2. THE TIMER — a factory mints exactly one whole unit every TICKS_PER_UNIT ticks, 0 between.
//   3. INPUTS UP FRONT — a unit never starts without its whole input set, and takes the whole set
//      on its start tick (nothing is drawn while it is on the line).
//   4. THE THROTTLE — 0 stops new units; a unit on the line still finishes.
//   5. ONE RESOLVER — the preview reports exactly what the tick then does.
//   6. THE STATE — the countdown is omitted when the line is empty (the byte-identical no-op).
//   7. SEAM 1 — a committed timed factory delivers lumpily (and, since Slice 3d, is paid smoothly on
//      its progress rather than through the delivery-basis sale).
//   8. SEAM 2 — `baselineOutputFor` is untouched; the capacity path reads per day (the fee moved off it in Slice 3a).
//   9. THE PRICE FIX — capacity per day, and the headline tripwire: one finished specialist is a
//      gentle nudge above base, where a per-tick capacity would peg it at the ceiling.
//  10. THE TRIPWIRES — each new invariant fires on a constructed violation, naming the good.
//  11. DETERMINISM — a timed run is byte-identical twice.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState, createVenture } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants, assertInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { previewProduction } = require('../production.js');
const { getRecipe, listRecipes } = require('../recipes.js');
const { getWindow } = require('../windows.js');
const {
  TIER3_GOODS, TIER3_PRICE_CLASS, SPECIALIST, UNCLASSIFIED, RAW_RESOURCES, PROCESSED_GOODS,
} = require('../resources.js');
const { TICKS_PER_UNIT, ticksPerUnitFor, baselineOutputFor, REFINERY_BASELINE } = require('../baseline.js');
const {
  CAPACITY_PERIOD_TICKS, capacityOutputFor, productionCapacity, priceTarget, advanceLeading,
  bandFor, postedPrice, LEVEL_SENSITIVITY,
} = require('../prices.js');

const SYS = 'sysA';
const factory = (id, recipeId, extra = {}) => ({
  id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: 5, ...extra,
});
const mine = (id, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate,
});

// One guild in one system, holding `stock` there. `guildExtra` adds guild fields (a profile).
function sysState(ventures, stock = {}, guildExtra = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures, ...guildExtra }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const held = (s, good) => (s.guilds[0].stockpiles[SYS] || {})[good] || 0;
const ventureOf = (s, id) => s.guilds[0].ventures.find((v) => v.id === id);
// `n` whole input sets for a recipe, as a stockpile map.
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
// The preview row for one factory — what the NEXT tick will do.
const previewRow = (s, id) => previewProduction(s)[0].systems[0].refineries.find((r) => r.ventureId === id);

// --- 1. THE NUMBERS -----------------------------------------------------------------------

test('TICKS_PER_UNIT is the ruled table, keyed by sub-tier and by specialist (docs/phase-1-tuning.md)', () => {
  // Typed here ON PURPOSE from docs/phase-1-tuning.md "Tier-3 production timers" — this is the
  // tripwire that pins the ruling. Retune it there and here together.
  assert.deepEqual({ ...TICKS_PER_UNIT }, {
    '3-1': 15,
    '3-2': 30,
    '3-3': 60,
    extraction_head: 360,
    fabrication_line: 480,
    medium_reactor_engine: 720,
    interdiction_projector: 1440,
    stealth_module: 2880,
    heavy_reactor_engine: 2880,
    deep_scan_mast: 4320,
  });
});

test('every classified Tier-3 good resolves to its timer; Tier-1/2 and the four unclassified modules stay continuous', () => {
  for (const good of TIER3_GOODS) {
    const cls = TIER3_PRICE_CLASS[good];
    const expected = cls === UNCLASSIFIED ? null : TICKS_PER_UNIT[cls === SPECIALIST ? good : cls];
    assert.equal(ticksPerUnitFor(good), expected, `${good} (${cls})`);
  }
  // The four no bill uses yet have no sub-tier, so no ruled timer: continuous, their status quo
  // (on the decision checklist — not guessed).
  assert.deepEqual(TIER3_GOODS.filter((g) => ticksPerUnitFor(g) === null),
    ['claim_beacon', 'drive_module', 'droid_components', 'habitation_module']);
  for (const good of [...RAW_RESOURCES, ...PROCESSED_GOODS]) {
    assert.equal(ticksPerUnitFor(good), null, `${good} is continuous (Tier 1/2 unchanged)`);
  }
  assert.equal(ticksPerUnitFor('toString'), null, 'an inherited name is not a good');
});

test('every timed recipe outputs exactly ONE unit per batch — the model\'s "one whole unit"', () => {
  const timed = listRecipes().filter((r) => ticksPerUnitFor(r.output.good) !== null);
  assert.equal(timed.length, 21, 'the 21 classified Tier-3 modules');
  for (const r of timed) assert.equal(r.output.qty, 1, `${r.id} makes one unit`);
});

// --- 2. THE TIMER -------------------------------------------------------------------------

test('a 3-1 factory mints exactly one whole unit every 15 ticks, and nothing in between', () => {
  let s = sysState([factory('f', 'fuel_tank')], inputSets('fuel_tank', 10));
  const mintTicks = [];
  for (let i = 1; i <= 60; i += 1) {
    const before = held(s, 'fuel_tank');
    s = tick(s);
    const made = held(s, 'fuel_tank') - before;
    assert.ok(made === 0 || made === 1, `tick ${s.tick}: a whole unit or nothing, never ${made}`);
    if (made === 1) mintTicks.push(s.tick);
    const left = ventureOf(s, 'f').unitTicksRemaining;
    assert.ok(left === undefined || (Number.isInteger(left) && left >= 1 && left < 15), `tick ${s.tick}: countdown ${left} in range`);
    assert.deepEqual(checkInvariants(s, s.tick), [], `invariants green at tick ${s.tick}`);
  }
  assert.deepEqual(mintTicks, [15, 30, 45, 60], 'one unit every 15 ticks, exactly');
});

test('a specialist runs its own, slower timer: a heavy reactor engine lands on tick 2,880 and not a tick before', () => {
  let s = sysState([factory('f', 'heavy_reactor_engine')], inputSets('heavy_reactor_engine', 2));
  let firstMint = null;
  for (let i = 1; i <= 2880; i += 1) {
    s = tick(s);
    if (firstMint === null && held(s, 'heavy_reactor_engine') > 0) firstMint = s.tick;
  }
  assert.equal(firstMint, 2880, 'two days of work, then one engine');
  assert.equal(held(s, 'heavy_reactor_engine'), 1);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. INPUTS UP FRONT -------------------------------------------------------------------

test('a unit does not start without its WHOLE input set — nothing is drawn, the line stalls', () => {
  // fuel_tank = 2 radiation_shielding + 2 refrigerant_fluid + 2 titanium_alloy. One alloy short.
  const short = { radiation_shielding: 2, refrigerant_fluid: 2, titanium_alloy: 1 };
  let s = sysState([factory('f', 'fuel_tank')], short);
  for (let i = 0; i < 20; i += 1) s = tick(s);
  assert.deepEqual(s.guilds[0].stockpiles[SYS], short, 'no partial draw: every input is still there');
  assert.equal('unitTicksRemaining' in ventureOf(s, 'f'), false, 'no unit on the line');
  assert.equal(held(s, 'fuel_tank'), 0);
  const row = previewRow(s, 'f');
  assert.equal(row.started, false);
  assert.equal(row.bottleneckGood, 'titanium_alloy', 'the preview names the missing input');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // Top the alloy up: the very next tick the unit starts and takes the whole set.
  s.guilds[0].stockpiles[SYS].titanium_alloy = 2;
  s = tick(s);
  assert.deepEqual(s.guilds[0].stockpiles[SYS], { radiation_shielding: 0, refrigerant_fluid: 0, titanium_alloy: 0 },
    'the whole set left on the start tick');
  assert.equal(ventureOf(s, 'f').unitTicksRemaining, 14, 'the start tick was the unit\'s first tick of work');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the whole input set is taken on the START tick, and nothing more while the unit is on the line', () => {
  const two = inputSets('fuel_tank', 2); // 4 / 4 / 4
  let s = sysState([factory('f', 'fuel_tank')], two);
  s = tick(s); // tick 1: unit 1 starts
  assert.deepEqual(s.guilds[0].stockpiles[SYS], inputSets('fuel_tank', 1), 'one whole set gone at the start');
  for (let t = 2; t <= 15; t += 1) {
    s = tick(s);
    for (const inp of getRecipe('fuel_tank').inputs) {
      assert.equal(held(s, inp.good), inp.qty, `tick ${t}: ${inp.good} untouched while the unit is on the line`);
    }
  }
  assert.equal(held(s, 'fuel_tank'), 1, 'unit 1 landed on tick 15');
  s = tick(s); // tick 16: unit 2 starts
  for (const inp of getRecipe('fuel_tank').inputs) assert.equal(held(s, inp.good), 0, `${inp.good}: second set taken at unit 2's start`);
});

test('a timed factory shares its inputs through the gates: an earlier line is fed first and the timed one waits, drawing nothing', () => {
  // drive_module is UNCLASSIFIED, so continuous — at rate 5 it asks for 10 magnetic_assemblies a
  // tick. It was established first, so under FCFS it takes 10 of the 11 in the pool; the timed
  // small_reactor_engine (needs 2) is handed 1, cannot start, and leaves that 1 in the pool.
  const stock = {
    magnetic_assemblies: 11, conductive_material: 100, heat_resistant_alloy: 100, titanium_alloy: 100,
  };
  let s = sysState([factory('d', 'drive_module'), factory('e', 'small_reactor_engine')], stock);
  s = tick(s);
  assert.equal(held(s, 'magnetic_assemblies'), 1, 'the continuous line drew its 10; the timed line drew none');
  assert.equal('unitTicksRemaining' in ventureOf(s, 'e'), false, 'the timed unit did not start on a partial set');
  assert.equal(held(s, 'titanium_alloy'), 100, 'and none of its other inputs moved either');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. THE THROTTLE ----------------------------------------------------------------------

test('a timed factory throttled to 0 starts no unit — but a unit already on the line still finishes', () => {
  const paused = { productionProfile: { [SYS]: { throttles: { f: 0 } } } };

  // Inputs present, throttle 0: nothing starts, nothing is drawn.
  let s = sysState([factory('f', 'fuel_tank')], inputSets('fuel_tank', 1), paused);
  for (let i = 0; i < 30; i += 1) s = tick(s);
  assert.deepEqual(s.guilds[0].stockpiles[SYS], inputSets('fuel_tank', 1));
  assert.equal(held(s, 'fuel_tank'), 0);

  // A unit already on the line (5 ticks left) when the throttle is 0: it finishes, and no new one
  // starts after it.
  s = sysState([factory('f', 'fuel_tank', { unitTicksRemaining: 5 })], inputSets('fuel_tank', 1), paused);
  for (let i = 0; i < 5; i += 1) s = tick(s);
  assert.equal(held(s, 'fuel_tank'), 1, 'the spent inputs still became a unit');
  for (let i = 0; i < 20; i += 1) s = tick(s);
  assert.equal(held(s, 'fuel_tank'), 1, 'and no second unit started');
  assert.deepEqual(s.guilds[0].stockpiles[SYS], { ...inputSets('fuel_tank', 1), fuel_tank: 1 });
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. ONE RESOLVER ----------------------------------------------------------------------

test('the preview reports exactly what the tick then does — the timed path goes through the one resolver', () => {
  let s = sysState([factory('f', 'fuel_tank')], inputSets('fuel_tank', 3));
  for (let i = 0; i < 40; i += 1) {
    const row = previewRow(s, 'f');
    const before = held(s, 'fuel_tank');
    s = tick(s);
    assert.equal(row.timed, true);
    assert.equal(row.minted, held(s, 'fuel_tank') - before, `tick ${s.tick}: previewed mint = applied mint`);
    const stored = ventureOf(s, 'f').unitTicksRemaining;
    assert.equal(row.unitTicksRemaining, stored === undefined ? null : stored, `tick ${s.tick}: previewed countdown = stored`);
  }
});

// --- 6. THE STATE -------------------------------------------------------------------------

test('the countdown is omitted when the line is empty, kept when handed in, and never minted by a Tier-1/2 run', () => {
  const base = { id: 'v', ownerGuildId: 'g1', type: 'refining', recipeId: 'fuel_tank' };
  assert.equal('unitTicksRemaining' in createVenture(base), false, 'absent by default — no key');
  assert.equal(createVenture({ ...base, unitTicksRemaining: 7 }).unitTicksRemaining, 7, 'a saved countdown survives construction');
  assert.equal(createVenture({ ...base, unitTicksRemaining: 0 }).unitTicksRemaining, 0, 'a 0 is kept, to reach the tripwire');

  // A Tier-1/2 galaxy never mints the key — the byte-identical no-op every golden relies on.
  let s = sysState([mine('m', 'titanium', 10), mine('c', 'carbon_products', 10), factory('r', 'titanium_alloy')]);
  for (let i = 0; i < 10; i += 1) s = tick(s);
  for (const v of s.guilds[0].ventures) assert.equal('unitTicksRemaining' in v, false, `${v.id} carries no timer`);

  // And a timed factory drops the key again the tick its unit lands.
  s = sysState([factory('f', 'fuel_tank')], inputSets('fuel_tank', 1));
  for (let i = 0; i < 15; i += 1) s = tick(s);
  assert.equal(held(s, 'fuel_tank'), 1);
  assert.equal('unitTicksRemaining' in ventureOf(s, 'f'), false, 'line empty again → key removed');
  assert.deepEqual(ventureOf(s, 'f').batchCarry, {}, 'a timed factory never keeps a continuous carry');
});

// --- 7. SEAM 1 — the commitment/sale reads whatever production yields ----------------------

// ⤳ Slice 3d (the progress payment) changed what this seam pins. It used to pin that the payment
// was LUMPY: the unchanged delivery-basis sale paid one unit's worth on a completion tick and 0
// otherwise. A committed timed factory is now paid tick by tick on its committed progress, and a
// delivered unit arrives already paid (sim/tests/tier3-payment.test.js is the full proof). What
// stands is the delivery half: whole units still land on completion ticks only. The scaffold
// commitment was 10,000 — more than any Tier-3 licence can commit, which the payment now refuses —
// so it is 672, the most a 3-1 factory can commit (`floor(y)`), which still sends every unit.
test('SEAM 1 (as of Slice 3d): a committed timed factory DELIVERS lumpily — one unit on a completion tick — but is PAID smoothly on its progress', () => {
  let s = sysState([factory('f', 'fuel_tank', { syndicateCommitment: 672 })], inputSets('fuel_tank', 5));
  const deliveryTicks = [];
  for (let i = 1; i <= 45; i += 1) {
    const price = postedPrice(s, 'fuel_tank'); // the payment is valued at the posted price at step start
    const credits = s.guilds[0].credits;
    const ledger = s.syndicate.ledger;
    const delivered = (getWindow(s.guilds[0], SYS, 'fuel_tank') || { delivered: 0 }).delivered;
    s = tick(s);
    const paid = s.guilds[0].credits - credits;
    if (getWindow(s.guilds[0], SYS, 'fuel_tank').delivered > delivered) deliveryTicks.push(s.tick);
    // 672 of 672 × 1/15 of a unit × 100 = 6.67 credits of committed work a tick: 6 or 7 paid.
    assert.equal(price, 100);
    assert.ok(paid === 6 || paid === 7, `tick ${s.tick}: paid ${paid} for a tick of work, never a whole unit`);
    assert.equal(ledger - s.syndicate.ledger, paid, 'the Syndicate paid exactly what the guild got (invariant 2)');
    assert.equal(held(s, 'fuel_tank'), 0, 'every finished unit went to the Syndicate');
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  assert.deepEqual(deliveryTicks, [15, 30, 45], 'delivered only on the ticks a unit landed');
  assert.equal(getWindow(s.guilds[0], SYS, 'fuel_tank').delivered, 3, 'three whole units delivered this window');
  assert.equal(s.guilds[0].credits, 300, 'three units\' worth in all (45 ticks × 6.67), paid once');
});

// --- 8. SEAM 2 — the per-tick baseline is untouched ------------------------------------------

// ⤳ Slice 3a (Tier-3 settlement) re-based the licence fee: a TIMED good's fee and commitment now
// read its timer over the 10,080-tick week (`licenceBasisFor`, sim/licence.js — pinned in
// tier3-settlement.test.js), no longer `baselineOutputFor`. What this test still pins is the part
// of Seam 2 that stands: `baselineOutputFor` itself is unchanged (a continuous good's fee, the
// unclassified modules and `productionRate`'s establish stamp still read it), and the capacity
// path reads per DAY. Title and comment updated with that slice; the assertions are unchanged.
test('SEAM 2: baselineOutputFor is unchanged (per TICK); the capacity path reads per DAY', () => {
  for (const good of TIER3_GOODS) {
    const venture = { recipeId: good };
    const qty = getRecipe(good).output.qty;
    // The per-tick baseline — unchanged. (A timed good's LICENCE no longer reads it: Slice 3a.)
    assert.deepEqual(baselineOutputFor(venture), { good, units: REFINERY_BASELINE[good] * qty }, `${good}: baseline unchanged`);
    // What the price capacity reads.
    const ticksPerUnit = ticksPerUnitFor(good);
    const expected = ticksPerUnit === null
      ? REFINERY_BASELINE[good] * qty
      : (CAPACITY_PERIOD_TICKS / ticksPerUnit) * qty;
    assert.deepEqual(capacityOutputFor(venture), { good, units: expected }, `${good}: capacity reader`);
  }
  // Continuous Tier-1/2 ventures: the capacity reader IS the baseline, per tick.
  for (const venture of [{ resourceType: 'titanium' }, { recipeId: 'titanium_alloy' }]) {
    assert.deepEqual(capacityOutputFor(venture), baselineOutputFor(venture));
  }
});

// --- 9. THE PRICE FIX ---------------------------------------------------------------------

test('capacity: a timed good counts per DAY (1,440 ÷ ticks-per-unit), a continuous good per tick as before', () => {
  assert.equal(CAPACITY_PERIOD_TICKS, 1440, 'the first-cut period is one day');
  const s = sysState([
    factory('f1', 'fuel_tank'), factory('f2', 'fuel_tank'), factory('h', 'heavy_reactor_engine'),
    factory('d', 'deep_scan_mast'), mine('m', 'titanium', 1), factory('r', 'titanium_alloy'),
  ]);
  const cap = productionCapacity(s);
  assert.equal(cap.fuel_tank, 192, 'two 3-1 factories: 2 × 96 a day');
  assert.equal(cap.heavy_reactor_engine, 0.5, 'a heavy-engine factory: half a unit a day');
  assert.equal(cap.deep_scan_mast, 1440 / 4320, 'a deep-scan-mast factory: a third a day');
  assert.equal(cap.titanium, 160, 'a titanium mine: its per-tick baseline, unchanged (not its rate)');
  assert.equal(cap.titanium_alloy, 5, 'an alloy refinery: its per-tick baseline, unchanged');
});

test('HEADLINE: one finished heavy reactor engine nudges the price gently above base — it does NOT peg the ceiling', () => {
  // One heavy-engine factory (no inputs, so it never makes one — capacity is what it COULD make)
  // and ONE finished engine in the stockpile.
  const band = bandFor('heavy_reactor_engine'); // base 20M, ceiling 2B
  let s = sysState([factory('h', 'heavy_reactor_engine')], { heavy_reactor_engine: 1 });
  for (let i = 0; i < 150; i += 1) s = tick(s);

  // Per-DAY capacity: 0.5 a day, so one engine is a level of 2 (two days of output), and the
  // target is base × (1 + 0.05 × 2) = 22M — a 10% nudge.
  const level = 1 / productionCapacity(s).heavy_reactor_engine;
  assert.equal(level, 2);
  const gentle = band.base * (1 + LEVEL_SENSITIVITY * level);
  assert.equal(gentle, 22000000);
  const posted = postedPrice(s, 'heavy_reactor_engine');
  assert.ok(Math.abs(posted - gentle) < 1, `the price settled at ~22M (got ${posted})`);
  assert.ok(posted < band.ceiling / 50, 'nowhere near the 2B ceiling');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // CONTRAST — the same hoard against a PER-TICK capacity (what the timed factory makes in one
  // tick: 1/2,880 of an engine). The level is 2,880, the target 20M × 145 = 2.9B, past the
  // ceiling — and the same smoothing the tick uses walks the value up and PEGS it there.
  const perTickCapacity = 1 / TICKS_PER_UNIT.heavy_reactor_engine;
  const degenerate = priceTarget(band, 1, perTickCapacity, 0);
  assert.ok(degenerate > band.ceiling, `per-tick target ${degenerate} is past the ceiling`);
  let v = band.base;
  for (let i = 0; i < 150; i += 1) v = advanceLeading(band, v, degenerate);
  assert.equal(v, band.ceiling, 'per-tick capacity: one engine pins the price at the 2B ceiling');
  // …while the per-day target the engine now uses is the gentle one above.
  assert.equal(priceTarget(band, 1, 0.5, 0), gentle);
});

test('the same fix holds at the cheap end: one finished 3-1 part is a fraction-of-a-percent nudge', () => {
  const band = bandFor('fuel_tank'); // base 100
  // Per day: 96 a day, so one tank is a level of 1/96.
  assert.ok(Math.abs(priceTarget(band, 1, 96, 0) - 100 * (1 + 0.05 / 96)) < 1e-9);
  // Per tick it would have been a level of 15 — +75% for a single tank.
  assert.equal(priceTarget(band, 1, 1 / 15, 0), 100 * (1 + 0.05 * 15));
});

// --- 10. THE TRIPWIRES --------------------------------------------------------------------

const rulesOf = (s) => checkInvariants(s, 0).map((v) => v.rule);

test('INVARIANT: a timed good produced continuously fails loud, naming the good', () => {
  assert.deepEqual(checkInvariants(sysState([factory('f', 'fuel_tank')]), 0), [], 'a clean timed factory passes');

  // (a) a timed factory carrying a continuous remainder — it was run at a rate.
  const carried = sysState([factory('f', 'fuel_tank', { batchCarry: { titanium_alloy: 0.4, fuel_tank: 0.2 } })]);
  const hit = checkInvariants(carried, 0).filter((v) => v.rule.startsWith('timed-good-never-continuous'));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].detail.good, 'fuel_tank', 'the violation names the good');
  assert.equal(hit[0].where, 'venture:f');

  // (b) a mine "extracting" a timed good — mines only ever run continuously.
  const mined = sysState([mine('m', 'heavy_reactor_engine', 1)]);
  const minedHit = checkInvariants(mined, 0).filter((v) => v.rule.startsWith('timed-good-never-continuous'));
  assert.equal(minedHit.length, 1);
  assert.equal(minedHit[0].detail.good, 'heavy_reactor_engine');

  // And the harness halts loudly on it, with the tick and the offending values.
  assert.throws(() => assertInvariants(carried, 7), (err) =>
    /Invariant violation at tick 7/.test(err.message)
    && /timed-good-never-continuous/.test(err.message)
    && /"good": "fuel_tank"/.test(err.message));
});

test('INVARIANT: the countdown stays in [1, TICKS_PER_UNIT) and lives only on a timed factory', () => {
  const RANGE = 'unit-timer-in-[1, TICKS_PER_UNIT) (tier3-timed-production.md)';
  const ONLY = 'unit-timer-only-on-a-timed-factory (tier3-timed-production.md)';
  const withTimer = (value, venture = factory('f', 'fuel_tank')) => {
    const s = sysState([venture]);
    s.guilds[0].ventures[0].unitTicksRemaining = value;
    return s;
  };
  assert.deepEqual(rulesOf(withTimer(1)), [], '1 tick left is legal');
  assert.deepEqual(rulesOf(withTimer(14)), [], '14 of 15 is legal');
  for (const bad of [0, 15, 99, 2.5, -3, '5']) {
    assert.deepEqual(rulesOf(withTimer(bad)), [RANGE], `${JSON.stringify(bad)} is out of range for a 15-tick part`);
  }
  assert.deepEqual(rulesOf(withTimer(3, factory('r', 'titanium_alloy'))), [ONLY], 'a Tier-2 refinery has no timer');
  assert.deepEqual(rulesOf(withTimer(3, factory('d', 'drive_module'))), [ONLY], 'nor does a continuous (unclassified) module line');
  assert.deepEqual(rulesOf(withTimer(3, mine('m', 'titanium', 5))), [ONLY], 'nor does a mine');
});

test('INVARIANT: no fractional unit in any stockpile — a part-built unit can never sit in the pool', () => {
  // The existing §15.2 integer sweep covers every stockpile cell of every good, Tier 3 included.
  const s = sysState([factory('f', 'fuel_tank')], { fuel_tank: 0.5 });
  const hit = checkInvariants(s, 0).filter((v) => v.where === `guild:g1.stockpiles.${SYS}.fuel_tank`);
  assert.deepEqual(hit.map((v) => v.rule), ['integer credits/goods (§15.2)']);
});

// --- 11. DETERMINISM ----------------------------------------------------------------------

test('determinism (invariant 9): a timed run is byte-identical twice, tick by tick', () => {
  const build = () => sysState(
    [factory('f', 'fuel_tank'), factory('c', 'chassis'), factory('d', 'drive_module')],
    { ...inputSets('fuel_tank', 3), ...inputSets('chassis', 2), ...inputSets('drive_module', 20) },
  );
  let a = build();
  let b = build();
  for (let i = 1; i <= 70; i += 1) {
    a = tick(a);
    b = tick(b);
    assert.equal(hashState(a), hashState(b), `byte-identical at tick ${i}`);
  }
  assert.ok(held(a, 'fuel_tank') > 0 && held(a, 'chassis') > 0, 'both timers really landed units in the run');
});
