'use strict';

// droid-boost.test.js — roadmap 2.6, droid engine slice 4: THE PRODUCTION BOOST (docs/droids.md §2/§4/§9;
// BOOST_MAX 1.0, p 1.5, CAP 20 from docs/phase-1-tuning.md §Droids). Plus the two folded-in fixes: #3 (a droid
// may be assigned only to a PRODUCING venture) and #4 (every droid mutation records its tick).
//
// The tripwires, in order:
//   1. THE CURVE: boost(n) = 1.0 × (n / 20) ^ 1.5, exactly 0 at n = 0 and exactly 1 at n = 20; source-blind;
//      only WORKING droids (assigned, condition > 0) count.
//   2. NO-OP BYTE-IDENTICAL: a galaxy with no working droid hashes exactly as it did at a8ff924.
//   3. MINES: k droids extract rate × (1 + boost(k)), landed on whole units by the extraction carry.
//   4. CONTINUOUS: k droids run the line at rate × (1 + boost(k)), drawing proportionally more inputs; a
//      starved line is still held by its inputs.
//   5. TIMED: k droids finish units (1 + boost(k))× sooner, whole units only, one whole input set each; the
//      overshoot rolls into the next unit; an idle line banks nothing.
//   6. ONE RESOLVER: the preview reports exactly what the tick then does, boost included.
//   7. NEUTRALITY: a committed boosted venture delivers exactly its baseline commitment and keeps the surplus;
//      the stored rate, the commitment, the fee, the progress payment, GP and the mean line do not move.
//   8. DETERMINISM (invariant 9): two runs, and a save/restore, are byte-identical.
//   9. #3: an assign to a venture that makes nothing is refused, naming it.
//  10. #4: mint / assign / unassign each stamp the droid's updatedAtTick.
//  11. THE NEW TRIPWIRES: both carries and the droid stamp are fenced, and the fences bite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { checkInvariants } = require('../invariants.js');
const { previewProduction } = require('../production.js');
const { getRecipe } = require('../recipes.js');
const { baselineRateFor, ticksPerUnitFor } = require('../baseline.js');
const { assertWholeWeeklyOutput } = require('../windows.js');
const { TIER3_GOODS } = require('../resources.js');
const { guildPoints } = require('../points.js');
const { issuanceModifier, expectedReputation } = require('../meanline.js');
const {
  DROID_CAP, DROID_BOOST_MAX, DROID_BOOST_P, productionBoost, isDroidWorking, workingDroidCounts, mintDroid,
} = require('../droids.js');
const {
  validateAction, applyAction, intake,
  createApplyForLicenceAction, createAssignDroidAction, createUnassignDroidAction, createBuyAssetFromSyndicateAction,
} = require('../actions.js');
const { boostlessScript } = require('./droid-boost-noop-script.js');
const { HOME, YARD, kitGalaxy, g1Of } = require('./installation-kit-fixtures.js');

const SYS = 'sysA';
const droidIdFor = (n) => `asset_g1_droid_${String(n).padStart(2, '0')}`;

// galaxy({ ventures, stock, staff, credits }) -> one guild in one system. `staff` maps a venture id to how many
// droids are ALREADY assigned to it (handed in through createState, assigned at tick 0) — the quick way to a
// boosted venture; the assign action itself is tested below. Every invariant is checked before it is returned.
function galaxy({ ventures, stock = {}, staff = {}, credits = 0, idle = 0 }) {
  const droids = [];
  for (const [ventureId, k] of Object.entries(staff)) {
    for (let i = 0; i < k; i += 1) {
      droids.push({
        id: droidIdFor(droids.length + 1), systemId: SYS, source: 'guild', condition: 1,
        assignedToVentureId: ventureId, deployedAtTick: 0, updatedAtTick: 0,
      });
    }
  }
  for (let i = 0; i < idle; i += 1) {
    droids.push({ id: droidIdFor(droids.length + 1), systemId: SYS, source: 'guild', condition: 1, updatedAtTick: 0 });
  }
  const s = createState({
    guilds: [{
      id: 'g1', credits, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures,
      ...(droids.length ? { droids, droidSerial: droids.length } : {}),
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fixture itself is legal');
  return s;
}
const mine = (id, good, productionRate) => ({ id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate });
const factory = (id, recipeId, productionRate = 1) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate });
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
// run(s, n) -> `s` advanced n ticks through advance(), which asserts EVERY invariant on EVERY tick and throws
// naming the tick — so every run below is also the "conservation and integer goods hold every tick" proof.
function run(s, n) {
  let out = s;
  for (let i = 0; i < n; i += 1) out = advance(out).state;
  return out;
}
const held = (s, good) => (s.guilds[0].stockpiles[SYS] || {})[good] || 0;
const ventureOf = (s, id) => s.guilds[0].ventures.find((v) => v.id === id);
function accept(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected ${action.type} accepted, got: ${reason}`);
  const next = applyAction(s, action);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
}
function refuse(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, false, `expected ${action.type} refused`);
  return reason;
}

// --- 1. the curve -------------------------------------------------------------------------------------------

test('curve: boost(n) = 1.0 × (n/20)^1.5 — the ruled numbers, exactly 0 at none and exactly 1.0 at a full complement', () => {
  // Typed from docs/phase-1-tuning.md §Droids: retune there and here together.
  assert.equal(DROID_BOOST_MAX, 1.0);
  assert.equal(DROID_BOOST_P, 1.5);
  assert.equal(DROID_CAP, 20);
  assert.equal(productionBoost(0), 0, 'no droids: exactly 0, so × (1 + 0) is an exact × 1');
  assert.equal(productionBoost(20), 1, 'a full complement doubles production');
  // Points along the curve, against the formula written independently here.
  for (const n of [1, 5, 7, 10, 15, 19]) {
    const want = 1.0 * Math.pow(n / 20, 1.5);
    assert.ok(Math.abs(productionBoost(n) - want) < 1e-12, `boost(${n}) = ${want}`);
  }
  assert.ok(Math.abs(productionBoost(5) - 0.125) < 1e-12, 'a quarter complement: (1/4)^1.5 = 1/8');
  assert.ok(Math.abs(productionBoost(10) - Math.SQRT1_2 / 2) < 1e-12, 'half: (1/2)^1.5 ≈ 0.3536');
  // Mildly convex: each extra droid adds more than the one before.
  for (let n = 1; n < 20; n += 1) {
    assert.ok(productionBoost(n + 1) - productionBoost(n) > productionBoost(n) - productionBoost(n - 1), `convex at ${n}`);
  }
  // Out of range is a bug upstream, never a guess.
  for (const bad of [-1, 21, 1.5, NaN, '3']) assert.throws(() => productionBoost(bad), /not a whole number in \[0, 20\]/);
});

test('curve: only WORKING droids count — assigned AND condition > 0 — and source does not matter', () => {
  const g = {
    droids: [
      { id: 'a', source: 'guild', condition: 1, assignedToVentureId: 'v1', deployedAtTick: 0 },
      { id: 'b', source: 'syndicate', condition: 1, assignedToVentureId: 'v1', deployedAtTick: 0 },
      { id: 'c', source: 'guild', condition: 0, assignedToVentureId: 'v1', deployedAtTick: 0 }, // spent: not working
      { id: 'd', source: 'syndicate', condition: 1 },                                          // idle: not working
      { id: 'e', source: 'syndicate', condition: 0.5, assignedToVentureId: 'v2', deployedAtTick: 0 },
    ],
  };
  assert.deepEqual([...workingDroidCounts(g)], [['v1', 2], ['v2', 1]]);
  assert.equal(isDroidWorking(g.droids[2]), false);
  assert.equal(isDroidWorking(g.droids[3]), false);
  assert.deepEqual([...workingDroidCounts({})], [], 'a droidless guild counts nothing');

  // Source-blind, end to end: 10 guild droids and 10 Syndicate droids boost a mine identically.
  const make = (source) => {
    const s = galaxy({ ventures: [mine('m', 'titanium', 5)], staff: { m: 10 } });
    for (const d of s.guilds[0].droids) d.source = source;
    return run(s, 30);
  };
  assert.equal(held(make('guild'), 'titanium'), held(make('syndicate'), 'titanium'));
});

// --- 2. no-op byte-identical --------------------------------------------------------------------------------

// RECORDED AT a8ff924 (main, before this slice's code existed) by running droid-boost-noop-script.js there: a
// mine, a continuous refinery, a timed factory, a committed mine and a committed timed factory, run 400 ticks,
// with two IDLE droids on the books.
const BOOSTLESS_GOLDEN_A8FF924 = '66f43b3373e61c14b8bcd13a1ff3e00b52b036c37badaf680078e837625ef29f';

test('no-op: a galaxy with no working droid is byte-identical to a8ff924 (boost 0 everywhere)', () => {
  const s = boostlessScript();
  // The run really did produce on every path: a mine, a continuous line and a timed factory all ran.
  assert.ok(held(s, 'titanium_alloy') > 0, 'the continuous line ran');
  assert.ok(ventureOf(s, 'fac_tank').syndicateCommitment > 0, 'the timed factory is committed');
  assert.equal(s.guilds[0].droids.length, 2, 'two idle droids were on the books');
  for (const v of s.guilds[0].ventures) {
    assert.equal(v.extractionCarry, undefined, `${v.id}: no extraction carry`);
    assert.equal(v.unitWorkCarry, undefined, `${v.id}: no work carry`);
  }
  assert.equal(hashState(s), BOOSTLESS_GOLDEN_A8FF924);
});

// --- 3. mines -----------------------------------------------------------------------------------------------

test('mine: a full complement doubles extraction exactly — 2 × rate every tick, no carry', () => {
  let s = galaxy({ ventures: [mine('m', 'titanium', 5)], staff: { m: 20 } });
  for (let t = 1; t <= 10; t += 1) {
    s = run(s, 1);
    assert.equal(held(s, 'titanium'), 10 * t, `tick ${t}: 10 a tick`);
  }
  assert.equal(ventureOf(s, 'm').extractionCarry, undefined, 'a whole-number boosted rate carries nothing');
  assert.equal(ventureOf(s, 'm').productionRate, 5, 'the STORED rate is untouched');
});

test('mine: k droids extract rate × (1 + boost(k)) on average, whole units every tick, the remainder carried', () => {
  for (const k of [1, 3, 10, 17]) {
    const rate = 5;
    const perTick = rate * (1 + productionBoost(k));
    let s = galaxy({ ventures: [mine('m', 'titanium', rate)], staff: { m: k } });
    let prev = 0;
    for (let t = 1; t <= 200; t += 1) {
      s = run(s, 1);
      const now = held(s, 'titanium');
      const dep = now - prev;
      prev = now;
      assert.ok(Number.isInteger(dep), `k=${k} tick ${t}: a whole deposit`);
      // Each tick deposits floor or ceil of the boosted rate — never a lump, never a gap.
      assert.ok(dep === Math.floor(perTick) || dep === Math.ceil(perTick), `k=${k} tick ${t}: deposited ${dep} of ${perTick}`);
      const carry = ventureOf(s, 'm').extractionCarry || 0;
      // Exactly: everything extracted so far = what was deposited + what is carried.
      assert.ok(Math.abs(now + carry - perTick * t) < 1e-6, `k=${k} tick ${t}: ${now} + ${carry} = ${perTick * t}`);
    }
    assert.equal(ventureOf(s, 'm').productionRate, rate, 'the stored rate never moves');
  }
});

// --- 4. continuous refineries -------------------------------------------------------------------------------

test('continuous: a full complement runs the line at 2× and draws exactly 2× the inputs (conservation)', () => {
  // titanium_alloy: 3 titanium + 1 carbon_products -> 1 alloy, at productionRate 1 batch a tick.
  const stock = { titanium: 3000, carbon_products: 1000 };
  let s = galaxy({ ventures: [factory('f', 'titanium_alloy', 1)], stock, staff: { f: 20 } });
  s = run(s, 50);
  assert.equal(held(s, 'titanium_alloy'), 100, '2 a tick for 50 ticks');
  assert.equal(held(s, 'titanium'), 3000 - 300, '6 titanium a tick: 2 batches × 3');
  assert.equal(held(s, 'carbon_products'), 1000 - 100, '2 carbon a tick');
  assert.equal(ventureOf(s, 'f').productionRate, 1, 'the STORED rate is untouched');
});

test('continuous: k droids run at rate × (1 + boost(k)) — every good the line touches at that pace, whole units', () => {
  for (const k of [2, 10, 13]) {
    const rate = 1 + productionBoost(k);
    const stock = { titanium: 9000, carbon_products: 3000 };
    let s = galaxy({ ventures: [factory('f', 'titanium_alloy', 1)], stock, staff: { f: k } });
    const T = 300;
    s = run(s, T);
    const carry = ventureOf(s, 'f').batchCarry;
    const made = held(s, 'titanium_alloy');
    const ti = 9000 - held(s, 'titanium');
    const c = 3000 - held(s, 'carbon_products');
    // Whole units moved + the carried remainder = the boosted pace × T, for the output AND each input.
    assert.ok(Math.abs(made + carry.titanium_alloy - rate * T) < 1e-6, `k=${k}: output ${made}`);
    assert.ok(Math.abs(ti + carry.titanium - 3 * rate * T) < 1e-6, `k=${k}: titanium drawn ${ti}`);
    assert.ok(Math.abs(c + carry.carbon_products - rate * T) < 1e-6, `k=${k}: carbon drawn ${c}`);
    assert.ok(made > T, `k=${k}: above the droidless ${T}`);
  }
});

test('continuous: a boosted line short of an input is still held by it — the input cap clamps, the boost cannot conjure', () => {
  // Carbon for only 30 batches: a full complement would run 2 a tick, but there is no 31st batch.
  let s = galaxy({ ventures: [factory('f', 'titanium_alloy', 1)], stock: { titanium: 3000, carbon_products: 30 }, staff: { f: 20 } });
  s = run(s, 40);
  assert.equal(held(s, 'titanium_alloy'), 30, 'exactly the 30 batches the carbon allows');
  assert.equal(held(s, 'carbon_products'), 0);
  assert.equal(held(s, 'titanium'), 3000 - 90, 'titanium drawn only for the batches run');
});

// --- 5. timed factories -------------------------------------------------------------------------------------

test('timed: a full complement finishes each unit in half the ticks — 20 fuel tanks in 150 ticks, not 10', () => {
  assert.equal(ticksPerUnitFor('fuel_tank'), 15);
  const make = (k) => run(galaxy({ ventures: [factory('t', 'fuel_tank', 5)], stock: inputSets('fuel_tank', 100), staff: { t: k } }), 150);
  const base = make(0);
  const boosted = make(20);
  assert.equal(held(base, 'fuel_tank'), 10, 'droidless: one every 15 ticks');
  assert.equal(held(boosted, 'fuel_tank'), 20, 'boosted ×2: one every 7.5 ticks on average');
  // One WHOLE input set per unit, and only per unit (each started unit took its set at start).
  for (const inp of getRecipe('fuel_tank').inputs) {
    const startedBoosted = 20 + (ventureOf(boosted, 't').unitTicksRemaining === undefined ? 0 : 1);
    assert.equal(held(boosted, inp.good), inp.qty * (100 - startedBoosted), `${inp.good}: one set per started unit`);
  }
});

test('timed: THE OVERSHOOT rolls into the next unit — at ×2 on a 15-tick timer units land on ticks 8, 15, 23, 30 …', () => {
  let s = galaxy({ ventures: [factory('t', 'fuel_tank', 5)], stock: inputSets('fuel_tank', 100), staff: { t: 20 } });
  const landed = [];
  for (let t = 1; t <= 60; t += 1) {
    const before = held(s, 'fuel_tank');
    s = run(s, 1);
    if (held(s, 'fuel_tank') > before) landed.push(t);
    if (t === 8) {
      // Unit 1 needed 15 ticks of work and got 16 (8 ticks × 2): the spare tick waits for the next unit.
      assert.equal(ventureOf(s, 't').unitTicksRemaining, undefined, 'the line is empty after the mint');
      assert.equal(ventureOf(s, 't').unitWorkCarry, 1, 'one whole tick of overshoot banked');
    }
    if (t === 9) {
      // Unit 2 starts and gets the banked tick plus this tick's 2: 15 − 3 = 12 left.
      assert.equal(ventureOf(s, 't').unitTicksRemaining, 12);
      assert.equal(ventureOf(s, 't').unitWorkCarry, undefined);
    }
  }
  assert.deepEqual(landed, [8, 15, 23, 30, 38, 45, 53, 60], 'exactly 7.5 ticks a unit on average — no tick lost to overshoot');
});

test('timed: k droids finish units (1 + boost(k))× sooner over a long run — whole units, never early, never in part', () => {
  for (const k of [3, 10, 16]) {
    const T = 1500;
    const s = run(galaxy({ ventures: [factory('t', 'fuel_tank', 5)], stock: inputSets('fuel_tank', 400), staff: { t: k } }), T);
    const units = held(s, 'fuel_tank');
    const want = (T * (1 + productionBoost(k))) / 15;
    assert.ok(Number.isInteger(units));
    // The carried work makes this exact up to the one unit still on the line.
    assert.ok(units <= want && want - units < 1, `k=${k}: ${units} units against an exact ${want}`);
  }
  // The weekly-y tripwire pins the BASELINE timers and is untouched by the boost.
  assert.doesNotThrow(() => assertWholeWeeklyOutput(TIER3_GOODS, ticksPerUnitFor));
});

test('timed: an EMPTY line banks no work — with no input set for the next unit, the overshoot is dropped (and stamped)', () => {
  let s = galaxy({ ventures: [factory('t', 'fuel_tank', 5)], stock: inputSets('fuel_tank', 1), staff: { t: 20 } });
  s = run(s, 8);
  assert.equal(held(s, 'fuel_tank'), 1);
  assert.equal(ventureOf(s, 't').unitWorkCarry, 1, 'banked at the mint');
  s = run(s, 1); // no set for unit 2: the line stays empty
  assert.equal(ventureOf(s, 't').unitWorkCarry, undefined, 'an idle line keeps no banked work');
  assert.equal(ventureOf(s, 't').updatedAtTick, s.tick - 1, 'clearing it is a mutation, so it is stamped');
  s = run(s, 30);
  assert.equal(held(s, 'fuel_tank'), 1, 'and nothing more is made without inputs');
});

// --- 6. one resolver ----------------------------------------------------------------------------------------

test('one resolver: the preview reports the boosted numbers the tick then applies', () => {
  // comms_array (a 30-tick timer) takes no titanium_alloy, so the alloy line's output is all its own.
  let s = galaxy({
    ventures: [mine('m', 'titanium', 5), factory('f', 'titanium_alloy', 1), factory('t', 'comms_array', 5)],
    stock: { carbon_products: 500, ...inputSets('comms_array', 20) },
    staff: { m: 7, f: 11, t: 13 },
  });
  for (let i = 0; i < 40; i += 1) {
    const sys = previewProduction(s)[0].systems.find((x) => x.systemId === SYS);
    const mineRow = sys.mines.find((r) => r.ventureId === 'm');
    const alloyRow = sys.refineries.find((r) => r.ventureId === 'f');
    const tankRow = sys.refineries.find((r) => r.ventureId === 't');
    const before = { alloy: held(s, 'titanium_alloy'), tank: held(s, 'comms_array') };
    const next = run(s, 1);
    assert.equal(ventureOf(next, 'm').extractionCarry, mineRow.extractionCarry);
    assert.equal(held(next, 'titanium_alloy') - before.alloy, alloyRow.minted);
    assert.equal(held(next, 'comms_array') - before.tank, tankRow.minted);
    assert.equal(ventureOf(next, 't').unitWorkCarry, tankRow.unitWorkCarry);
    // The rate the client renders is the boosted one.
    if (tankRow.rate > 0) assert.equal(tankRow.rate, (1 + productionBoost(13)) / 30);
    assert.equal(alloyRow.rate, 1 + productionBoost(11), 'the line runs at its boosted pace');
    s = next;
  }
});

// --- 7. neutrality ------------------------------------------------------------------------------------------

// A copper mine at its droidless baseline, licensed at 50% on the default day window, run one window and a bit
// (so the boundary verdict and the fee land), with and without a full complement.
function committedMineRun(k) {
  const rate = baselineRateFor({ resourceType: 'copper' });
  let s = galaxy({ ventures: [mine('cu', 'copper', rate)], staff: { cu: k }, credits: 1_000_000 });
  const out = intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'cu', committedOutputPct: 0.5, windowDays: 7 })]);
  assert.equal(out.results[0].accepted, true, out.results[0].reason);
  s = out.state;
  const signed = structuredClone(ventureOf(s, 'cu'));
  s = run(s, 1445);
  return { s, signed, rate };
}

test('NEUTRALITY: a committed boosted mine delivers exactly its baseline commitment and KEEPS the surplus; the fee does not move', () => {
  const base = committedMineRun(0);
  const boosted = committedMineRun(20);
  const Q = ventureOf(base.s, 'cu').syndicateCommitment;
  assert.equal(Q, 72_000, '50% of a 100/tick baseline over the 1,440-tick window');
  // The commitment and the licence terms are the droidless ones, in both runs, before and after.
  assert.equal(ventureOf(boosted.s, 'cu').syndicateCommitment, Q, 'the commitment target is not inflated');
  assert.deepEqual(ventureOf(boosted.s, 'cu').licence, ventureOf(base.s, 'cu').licence, 'the licence terms (and its fees) are unchanged');
  assert.deepEqual(boosted.signed.licence, base.signed.licence, 'droids on the books at signing changed nothing either');
  assert.equal(ventureOf(boosted.s, 'cu').productionRate, base.rate, 'the stored rate is untouched');
  // The window closed at tick 1,440 and the next one is 5 ticks in: same delivery in both.
  const winOf = (s) => s.guilds[0].syndicateWindows[SYS].copper;
  assert.deepEqual(winOf(boosted.s), winOf(base.s), 'the same units delivered, on the same pace');
  // Everything mined, less exactly Q for the closed window and the current window's delivery, is kept.
  const T = 1445;
  const current = winOf(base.s).delivered;
  assert.equal(held(base.s, 'copper'), T * base.rate - Q - current);
  assert.equal(held(boosted.s, 'copper'), T * 2 * base.rate - Q - current, 'the boosted surplus stays with the guild');
  // The fee charged at the boundary is identical — same verdict, same amount.
  assert.ok(base.s.guilds[0].lastLicenceFee, 'a fee was charged at the boundary');
  assert.deepEqual(boosted.s.guilds[0].lastLicenceFee, base.s.guilds[0].lastLicenceFee);
});

test('NEUTRALITY: a committed boosted TIMED factory delivers exactly x and keeps the rest; its progress payment does not move', () => {
  const make = (k) => {
    let s = galaxy({ ventures: [factory('t', 'fuel_tank', 5)], stock: inputSets('fuel_tank', 100), staff: { t: k } });
    const out = intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 't', committedUnits: 10 })]);
    assert.equal(out.results[0].accepted, true, out.results[0].reason);
    return run(out.state, 300);
  };
  const base = make(0);
  const boosted = make(20);
  const delivered = (s) => s.guilds[0].syndicateWindows[SYS].fuel_tank.delivered;
  assert.equal(delivered(base), 10);
  assert.equal(delivered(boosted), 10, 'the Syndicate gets its x, not a unit more');
  assert.equal(held(base, 'fuel_tank'), 20 - 10);
  assert.equal(held(boosted, 'fuel_tank'), 40 - 10, 'twice the units made, every extra one kept');
  assert.equal(ventureOf(boosted, 't').syndicateCommitment, 10);
  assert.deepEqual(ventureOf(boosted, 't').licence, ventureOf(base, 't').licence);
  // The progress payment pays the COMMITTED share of BASELINE progress for every tick a unit is on the line —
  // the droid's extra work is the guild's, not something the Syndicate pays for. Both lines ran every tick.
  assert.equal(boosted.guilds[0].credits, base.guilds[0].credits, 'the same credits paid on progress');
  assert.equal(boosted.syndicate.ledger, base.syndicate.ledger);
});

test('NEUTRALITY tripwire: assigning droids, and running boosted, moves neither GP nor the mean line', () => {
  const fixture = () => galaxy({
    ventures: [mine('m', 'titanium', 5), factory('f', 'titanium_alloy', 1)],
    stock: { carbon_products: 500 },
    idle: 20,
  });
  const reads = (s) => {
    const g = s.guilds[0];
    return { gp: guildPoints(s, g), modifier: issuanceModifier(s, g), expected: expectedReputation(s, g) };
  };
  const idle = fixture();
  let staffed = idle;
  for (let n = 1; n <= 20; n += 1) {
    staffed = accept(staffed, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(n), ventureId: n <= 10 ? 'm' : 'f' }));
  }
  assert.deepEqual(reads(staffed), reads(idle), 'assigning moved nothing');
  const a = run(idle, 100);
  const b = run(staffed, 100);
  assert.ok(held(b, 'titanium_alloy') > held(a, 'titanium_alloy'), 'the boost really ran');
  assert.deepEqual(reads(b), reads(a), 'GP, the issuance modifier and the expected RP are blind to the boost');
});

// --- 8. determinism -----------------------------------------------------------------------------------------

function boostedScript() {
  let s = galaxy({
    ventures: [mine('m', 'titanium', 5), factory('f', 'titanium_alloy', 1), factory('t', 'fuel_tank', 5)],
    stock: { carbon_products: 2000, ...inputSets('fuel_tank', 60) },
    idle: 30,
  });
  for (let n = 1; n <= 30; n += 1) {
    const ventureId = n <= 7 ? 'm' : n <= 18 ? 'f' : 't';
    s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(n), ventureId }));
  }
  const mid = run(s, 120);
  let end = accept(mid, createUnassignDroidAction({ guildId: 'g1', droidId: droidIdFor(1) }));
  end = run(end, 80);
  return { mid, end };
}

test('determinism (invariant 9): a boosted run is byte-identical twice', () => {
  const a = boostedScript();
  const b = boostedScript();
  assert.equal(hashState(a.mid), hashState(b.mid));
  assert.equal(hashState(a.end), hashState(b.end));
  assert.ok(ventureOf(a.mid, 'm').extractionCarry !== undefined || ventureOf(a.mid, 't').unitWorkCarry !== undefined,
    'the carries are in play');
});

test('determinism: a boosted save restores byte-identically and runs on identically', () => {
  const { mid } = boostedScript();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-droid-boost-'));
  try {
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(mid));
    assert.equal(hashState(run(restored, 60)), hashState(run(mid, 60)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 9. #3: assignable = boostable --------------------------------------------------------------------------

test('#3: a droid cannot be assigned to a venture that makes nothing — a dockyard, a bare shell — naming it', () => {
  // The dockyard: a real Tier-4 build yard, which no boost can ever reach.
  let k = kitGalaxy({ credits: 100_000 });
  k = accept(k, createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind: 'droid', destinationSystemId: HOME.id }));
  const d = g1Of(k).droids[0].id;
  assert.match(refuse(k, createAssignDroidAction({ guildId: 'g1', droidId: d, ventureId: YARD })),
    new RegExp(`venture ${YARD} produces no good, so a droid there could boost nothing`));
  // A bare venture with neither a resource nor a recipe.
  const s = galaxy({ ventures: [{ id: 'shell', ownerGuildId: 'g1', type: 'refining', systemId: SYS }], idle: 1 });
  assert.match(refuse(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(1), ventureId: 'shell' })),
    /venture shell produces no good/);
  // Checked right after ownership: an already-assigned droid is refused for the venture first, not its state.
  const busy = galaxy({ ventures: [mine('m', 'titanium', 5), { id: 'shell', ownerGuildId: 'g1', type: 'refining', systemId: SYS }], staff: { m: 1 } });
  assert.match(refuse(busy, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(1), ventureId: 'shell' })),
    /venture shell produces no good/);
  // A mine and a factory are producing ventures and accept.
  const ok = galaxy({ ventures: [mine('m', 'titanium', 5), factory('f', 'titanium_alloy', 1)], idle: 2 });
  accept(accept(ok, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(1), ventureId: 'm' })),
    createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(2), ventureId: 'f' }));
});

// --- 10. #4: every droid mutation records its tick ----------------------------------------------------------

test('#4: mint, assign and unassign each stamp the droid with the tick; the mint refuses to run without one', () => {
  let s = run(galaxy({ ventures: [mine('m', 'titanium', 5)], idle: 1 }), 5);
  assert.equal(s.guilds[0].droids[0].updatedAtTick, 0, 'the fixture row');
  s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(1), ventureId: 'm' }));
  assert.equal(s.guilds[0].droids[0].updatedAtTick, 5, 'assign');
  s = run(s, 4);
  assert.equal(s.guilds[0].droids[0].updatedAtTick, 5, 'a droid that merely works is not re-stamped (nothing about it changed)');
  s = accept(s, createUnassignDroidAction({ guildId: 'g1', droidId: droidIdFor(1) }));
  assert.equal(s.guilds[0].droids[0].updatedAtTick, 9, 'unassign');
  // The Syndicate buy mints at the action's tick (the dockyard mint is pinned in droid-entity.test.js, the
  // closure release in droid-assignment.test.js).
  let k = run(kitGalaxy({ credits: 100_000 }), 3);
  k = accept(k, createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind: 'droid', destinationSystemId: HOME.id }));
  assert.equal(g1Of(k).droids[0].updatedAtTick, k.tick, 'mint');
  assert.throws(() => mintDroid({ id: 'g1' }, 'guild', SYS), /without a valid tick/);
});

// --- 11. the new tripwires ----------------------------------------------------------------------------------

test('tripwires: the extraction carry, the work carry and the droid stamp are fenced — and each fence bites', () => {
  const base = run(galaxy({
    ventures: [mine('m', 'titanium', 5), factory('t', 'fuel_tank', 5)],
    stock: inputSets('fuel_tank', 5), staff: { m: 3, t: 3 },
  }), 3);
  assert.deepEqual(checkInvariants(base, base.tick), []);
  const broken = (mutate) => {
    const s = structuredClone(base);
    mutate(s);
    return checkInvariants(s, s.tick).map((x) => x.rule);
  };
  const v = (s, id) => s.guilds[0].ventures.find((x) => x.id === id);
  assert.deepEqual(broken((s) => { v(s, 'm').extractionCarry = 1; }), ['extraction-carry-in-[0,1) (droids.md §2)']);
  assert.deepEqual(broken((s) => { v(s, 'm').extractionCarry = -0.1; }), ['extraction-carry-in-[0,1) (droids.md §2)']);
  assert.deepEqual(broken((s) => { v(s, 't').extractionCarry = 0.5; }), ['extraction-carry-only-on-a-mine (droids.md §2)']);
  // On a running line the work carry is under 1; on an empty one (just after a mint) under 2.
  assert.equal(v(base, 't').unitTicksRemaining !== undefined, true, 'a unit is on the line');
  assert.deepEqual(broken((s) => { v(s, 't').unitWorkCarry = 1; }), ['unit-work-carry-in-[0,1) (droids.md §2)']);
  assert.deepEqual(broken((s) => { delete v(s, 't').unitTicksRemaining; v(s, 't').unitWorkCarry = 1.5; }), []);
  assert.deepEqual(broken((s) => { delete v(s, 't').unitTicksRemaining; v(s, 't').unitWorkCarry = 2; }), ['unit-work-carry-in-[0,2) (droids.md §2)']);
  assert.deepEqual(broken((s) => { v(s, 'm').unitWorkCarry = 0.5; }), ['unit-work-carry-only-on-a-timed-factory (droids.md §2)']);
  assert.deepEqual(broken((s) => { s.guilds[0].droids[0].updatedAtTick = s.tick + 1; }), ['droid-updated-at-tick-valid (design.md §15.2)']);
  assert.deepEqual(broken((s) => { s.guilds[0].droids[0].updatedAtTick = 1.5; }), ['droid-updated-at-tick-valid (design.md §15.2)']);
});
