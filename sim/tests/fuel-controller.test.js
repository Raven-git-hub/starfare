'use strict';

// fuel-controller.test.js — the fuel price controller, slice 5b-ii
// (docs/fuel-supply-and-allocation.md §4.2, the ruling this pins; §4 for the loop's intent,
// §4.1 for the crunch edge it must NOT abolish; the five `[FIRST-CUT]` coefficients and
// their workings in docs/phase-1-tuning.md).
//
// WHAT THIS SLICE IS, AND WHY IT IS THE ONE THAT FINALLY CHANGES BEHAVIOUR. 5a issued fuel
// from a finite pool against a FIXED influx, and nothing anywhere pulled draw back under
// supply: a galaxy drawing more than 800 a cycle bled its pool to zero and rationed for
// ever. 5b-i introduced the price and deliberately held it still. This slice lets go of it.
//
// THE IDEA UNDER TEST IS ONE SENTENCE: THE POOL IS ITS OWN INTEGRATOR. Nobody computes an
// equilibrium price, because nobody could — it depends on how many guilds there are, how
// big they are and how well they are doing, all of which move. Instead every cycle that
// over-draws leaves the level lower, which raises the price, which shrinks the next
// cycle's grants; the loop settles exactly where total draw equals the influx, in whatever
// galaxy it is running in. So the headline test here is not an arithmetic identity — it is
// that a long run CONVERGES.
//
// AND THE THING IT MUST NOT DO IS ABOLISH THE CRUNCH. §4.1 rules that a galaxy CAN out-draw
// what any price can throttle, and that when it does, grants are clipped and the pool sits
// at zero. A controller that quietly made rationing unreachable would have deleted a ruled
// part of the game, so the crisis regime is tested here as deliberately as the convergence.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState, createReserve } = require('../state.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { getStarterSystems } = require('../seed.js');
const { REFERENCE_FUEL_PRICE } = require('../fuel.js');
const {
  DEUTERIUM_INFLUX_PER_CYCLE,
  PRICE_SENSITIVITY, TARGET_CYCLES, DRAW_EMA_ALPHA, PRICE_FLOOR, PRICE_CEIL,
  physicalGrantFor, targetReserve, nextAvgDraw, nextFuelPrice,
} = require('../issuance.js');

const N = 4;                                   // a short window, so a boundary is 4 ticks away

const SEED_SYSTEMS = getStarterSystems().map((x) => (typeof x === 'string' ? x : x.id));

const claim = (guildId, landmarkId) => ({
  claimId: `claim_${guildId}_${landmarkId}`, ownerGuildId: guildId,
  landmarkId, landmarkKind: 'system', claimedAtTick: 0, contested: false,
});
const mine = (id, ownerGuildId, systemId) => ({
  id, ownerGuildId, type: 'mining', systemId, resourceType: 'titanium', productionRate: 5,
});

// A galaxy of `specs` ({ id, systems, mines, rp }), over a pool, optionally at a given
// price / trailing average. Same builder shape as fuel-price.test.js's, extended with the
// controller's own field — every test below is a statement about what the controller does
// to one of these over time.
function galaxy(specs, { pool = 0, fuelPrice, avgDraw } = {}) {
  const claims = [];
  let nextSystem = 0;
  const guilds = specs.map((spec) => {
    const held = [];
    for (let i = 0; i < (spec.systems || 0); i += 1) {
      const sysId = SEED_SYSTEMS[nextSystem % SEED_SYSTEMS.length];
      nextSystem += 1;
      held.push(sysId);
      claims.push(claim(spec.id, sysId));
    }
    const ventures = Array.from({ length: spec.mines || 0 }, (_, i) =>
      mine(`${spec.id}_m${i}`, spec.id, held[i % held.length] || SEED_SYSTEMS[0]));
    if (spec.rp) {
      const each = Math.trunc(spec.rp / (ventures.length || 1));
      ventures.forEach((v, i) => { v.reputation = i === 0 ? spec.rp - each * (ventures.length - 1) : each; });
    }
    return { id: spec.id, credits: 0, fuelHoard: 0, ventures };
  });
  const reserve = { reserveLevel: pool };
  if (fuelPrice !== undefined) reserve.fuelPrice = fuelPrice;
  if (avgDraw !== undefined) reserve.avgDraw = avgDraw;
  const s = createState({ guilds, reserve, syndicate: { ledger: 0 }, claims, windowN: N });
  s.guilds.forEach((g) => { g.guildReputation = (g.ventures || []).reduce((n, v) => n + (v.reputation || 0), 0); });
  return s;
}

// The four-guild spread the recorder uses, in miniature: Σ entitlement ~987 against an
// influx of 800, so this galaxy opens ABOVE its supply and the controller has real work to
// do. (Under 5a this exact shape bled to zero and rationed for ever.)
const SPREAD = [
  { id: 'forge', systems: 1, mines: 8, rp: 11976 },
  { id: 'meridian', systems: 2, mines: 6, rp: 8982 },
  { id: 'reach', systems: 4, mines: 6, rp: 8982 },
  { id: 'spark' },
];

const runToBoundary = (s) => { do { s = tick(s); } while (s.tick % N !== 0); return s; };
const poolOf = (s) => s.reserve.reserveLevel;
const hoards = (s) => s.guilds.reduce((n, g) => n + g.fuelHoard, 0);
const demandOf = (s) => s.guilds.reduce((n, g) => n + physicalGrantFor(s, g), 0);

// Run `cycles` boundaries, returning one row per cycle: the demand the galaxy asked for at
// the price it was issued at, and the pool/price/average the controller left behind.
function runCycles(s, cycles) {
  const rows = [];
  for (let c = 0; c < cycles; c += 1) {
    const demand = demandOf(s);              // what this cycle wants, at THIS cycle's price
    const priceIssuedAt = s.reserve.fuelPrice;
    s = runToBoundary(s);
    rows.push({
      demand,
      priceIssuedAt,
      pool: poolOf(s),
      price: s.reserve.fuelPrice,
      avgDraw: s.reserve.avgDraw,
      granted: hoards(s) - (rows.length ? rows.map((r) => r.granted).reduce((a, b) => a + b, 0) : 0),
    });
  }
  return { state: s, rows };
}

function assertConserved(s, where) {
  assert.equal(
    s.audit.totalProduced - s.audit.totalConsumed, poolOf(s) + hoards(s),
    `${where}: conservation of fuel — produced − consumed must equal pool + Σ hoards`,
  );
  assert.ok(poolOf(s) >= 0, `${where}: the pool must never go negative (it is ${poolOf(s)})`);
  assert.deepEqual(checkInvariants(s, s.tick), [], `${where}: an invariant tripped`);
}

// --- 1. THE COEFFICIENTS AND THE STATE FIELD ----------------------------------------

test('the five controller coefficients are the ruled [FIRST-CUT] numbers', () => {
  // Read from phase-1-tuning.md, not chosen here. Pinned so a retune is a deliberate,
  // visible act that moves these numbers and every golden downstream of them.
  assert.equal(PRICE_SENSITIVITY, 1.5);
  assert.equal(TARGET_CYCLES, 3);
  assert.equal(DRAW_EMA_ALPHA, 0.22);
  assert.equal(PRICE_FLOOR, 2);
  assert.equal(PRICE_CEIL, 40);
  // THERE IS NO SIXTH. `basePrice` is `REFERENCE_FUEL_PRICE`, which is why the price sits
  // exactly at the reference when the pool is exactly at target — asserted below.
  assert.ok(PRICE_FLOOR < REFERENCE_FUEL_PRICE && REFERENCE_FUEL_PRICE < PRICE_CEIL,
    'the reference must sit inside the clamp, or the base price would be unreachable');
  assert.ok(DRAW_EMA_ALPHA > 0 && DRAW_EMA_ALPHA < 1, 'an EMA weight is a proper fraction');
});

test('a galaxy opens with a seeded avgDraw, and it is real serialized state', () => {
  const s = createZeroState();
  assert.equal(s.reserve.avgDraw, DEUTERIUM_INFLUX_PER_CYCLE,
    'the opening assumption is a BALANCED galaxy: it draws what the Syndicate supplies');
  // Reached through the structural default, exactly as `fuelPrice` is — which is what keeps
  // every `{ reserveLevel }` caller and fixture in the repo valid and unchanged.
  assert.deepEqual(createReserve({ reserveLevel: 1 }),
    { reserveLevel: 1, fuelPrice: REFERENCE_FUEL_PRICE, avgDraw: DEUTERIUM_INFLUX_PER_CYCLE });
  // REAL STATE: an EMA is memory, so it has to survive from one cycle to the next.
  assert.equal(tick(s).reserve.avgDraw, DEUTERIUM_INFLUX_PER_CYCLE, 'and it persists across a tick');
});

test('avgDraw is the SECOND sanctioned float — fractional passes, NaN and negative do not', () => {
  const fractional = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 4482 }], { pool: 100, avgDraw: 812.5 });
  assert.deepEqual(checkInvariants(fractional, fractional.tick), [],
    'an EMA is a fractional quantity by nature — it averages fuel, it does not count it');

  const negative = galaxy([{ id: 'g1' }], { pool: 100, avgDraw: -1 });
  assert.ok(checkInvariants(negative, negative.tick).some(
    (v) => v.where === 'reserve.avgDraw' && v.rule.startsWith('non-negativity')),
    'a negative demand average is nonsense and must trip invariant 3');

  const nan = galaxy([{ id: 'g1' }], { pool: 100, avgDraw: NaN });
  assert.ok(checkInvariants(nan, nan.tick).some(
    (v) => v.where === 'reserve.avgDraw' && v.rule.startsWith('finite-number')),
    'a NaN average would poison the target, the price and every grant on the next cycle');
});

// --- 2. THE CURVE IS WHAT WAS RULED --------------------------------------------------

test('THE CURVE: at target the price is exactly REFERENCE_FUEL_PRICE', () => {
  // The property that lets the reference double as the base price, so 5b-ii introduced no
  // new base-price number. Swept over a range of demand levels, because "at target" is a
  // RELATIVE statement — the target moves with the galaxy.
  for (const avgDraw of [1, 50, 800, 4000, 12345.6]) {
    const target = targetReserve(avgDraw);
    assert.equal(target, TARGET_CYCLES * avgDraw, `target at avgDraw ${avgDraw}`);
    assert.equal(nextFuelPrice(target, avgDraw), REFERENCE_FUEL_PRICE,
      `a pool exactly at target prices exactly at the reference (avgDraw ${avgDraw})`);
  }
});

test('THE CURVE: below target the price RISES, above it FALLS — the sign of the feedback', () => {
  // Getting this backwards would build a controller that amplified a crunch instead of
  // easing it, so the direction is pinned in both directions and across the range.
  const avgDraw = 800;
  const target = targetReserve(avgDraw);
  for (const frac of [0.25, 0.5, 0.75, 0.9]) {
    assert.ok(nextFuelPrice(target * frac, avgDraw) > REFERENCE_FUEL_PRICE,
      `a pool at ${frac}x target must price ABOVE the reference — draining means dearer`);
  }
  for (const frac of [1.1, 1.5, 2, 4]) {
    assert.ok(nextFuelPrice(target * frac, avgDraw) < REFERENCE_FUEL_PRICE,
      `a pool at ${frac}x target must price BELOW the reference — filling means cheaper`);
  }
  // Monotone in the level: a fuller pool is never a dearer one.
  let last = Infinity;
  for (let level = 200; level <= 6000; level += 200) {
    const p = nextFuelPrice(level, avgDraw);
    assert.ok(p <= last, `the price must fall monotonically as the pool fills (level ${level})`);
    last = p;
  }
});

test('THE CURVE: it is the ruled formula, term for term', () => {
  // Stated against the constants rather than against pinned numbers, so a retune moves this
  // with the coefficients instead of leaving it stale.
  for (const [level, avgDraw] of [[2400, 800], [1000, 800], [5000, 800], [900, 300], [77, 1234]]) {
    const expected = Math.min(PRICE_CEIL, Math.max(PRICE_FLOOR,
      REFERENCE_FUEL_PRICE * ((TARGET_CYCLES * avgDraw) / Math.max(1, level)) ** PRICE_SENSITIVITY));
    assert.equal(nextFuelPrice(level, avgDraw), expected, `level ${level}, avgDraw ${avgDraw}`);
  }
});

test('THE CLAMP: the price is bounded to [PRICE_FLOOR, PRICE_CEIL] at both extremes', () => {
  assert.equal(nextFuelPrice(0, 800), PRICE_CEIL, 'an empty pool reads as maximally short');
  assert.equal(nextFuelPrice(1, 800), PRICE_CEIL);
  assert.equal(nextFuelPrice(1e12, 800), PRICE_FLOOR, 'an enormous pool bottoms out at the floor');
  assert.equal(nextFuelPrice(1000, 0), PRICE_FLOOR, 'a galaxy with no demand at all needs no throttle');
  for (const [level, avgDraw] of [[0, 0], [1, 1e9], [1e9, 1], [3, 7.5]]) {
    const p = nextFuelPrice(level, avgDraw);
    assert.ok(p >= PRICE_FLOOR && p <= PRICE_CEIL, `level ${level}, avgDraw ${avgDraw} -> ${p}`);
    assert.ok(Number.isFinite(p), 'and always a finite number');
  }
});

test('THE FLOOR HOLDS THE 5b-i GUARD: the controller can never write a price ≤ 0', () => {
  // `physicalGrantFor` divides by the price and throws on one that is not `> 0` — a guard
  // written in 5b-i when nothing yet wrote the field. `PRICE_FLOOR > 0` is what makes it
  // UNREACHABLE from a controller-written price, which is the safety half of that constant.
  assert.ok(PRICE_FLOOR > 0, 'the floor is what makes the guard unreachable');
  // Swept over the extremes and over a long real run, rather than argued: no pool level and
  // no average, however absurd, produces a price the guard would reject.
  for (const level of [0, 1, 2, 37, 1e6, 1e12, -5]) {
    for (const avgDraw of [0, 1, 800, 1e6]) {
      const p = nextFuelPrice(level, avgDraw);
      assert.ok(Number.isFinite(p) && p > 0, `level ${level}, avgDraw ${avgDraw} produced ${p}`);
    }
  }
  // And through the real tick: a galaxy driven all the way into the crunch never trips it.
  let s = galaxy(SPREAD, { pool: 0 });
  for (let c = 0; c < 15; c += 1) {
    s = runToBoundary(s);
    assert.ok(s.reserve.fuelPrice >= PRICE_FLOOR, `cycle ${c}: the price stayed at or above the floor`);
    assert.doesNotThrow(() => demandOf(s), `cycle ${c}: the divide-by-price guard never fires`);
  }
});

// --- 3. THE EMA IS THE DEMAND SIGNAL --------------------------------------------------

test('avgDraw is the ruled EMA of DEMAND, and it converges on a steady demand', () => {
  assert.equal(nextAvgDraw(800, 800), 800, 'a demand equal to the average leaves it alone');
  assert.equal(nextAvgDraw(800, 1800), DRAW_EMA_ALPHA * 1800 + (1 - DRAW_EMA_ALPHA) * 800);
  // It follows a step change without jumping to it — that is what stops the target chasing
  // one cycle's noise (a guild founding, a venture landing, a modifier stepping).
  let a = 800;
  for (let i = 0; i < 40; i += 1) a = nextAvgDraw(a, 1600);
  assert.ok(Math.abs(a - 1600) < 1, `an ~8-cycle window reaches a step change in the end (${a})`);
  const oneStep = nextAvgDraw(800, 1600);
  assert.ok(oneStep > 800 && oneStep < 1600, 'but never in one cycle');
});

test('the EMA is fed Σ DESIRED, not the rationed Σ granted — the sign that keeps the loop stable', () => {
  // THE ONE PLACE THE RULING'S WORDING AND THE BUILD DIVERGE (§4.2 AS BUILT). §4.2 calls
  // this "a trailing average of the fuel GRANTED per cycle"; outside a crunch that is the
  // same number, but inside one it is not, and granted is the reading that breaks the loop:
  // a starving galaxy would report shrinking demand BECAUSE it was starving, so the
  // demand-relative target would shrink with it and the price would ease exactly when the
  // shortfall was worst. This pins the desired reading through the real tick.
  const s = galaxy(SPREAD, { pool: 0 });         // an empty pool ⇒ this cycle MUST ration
  const demand = demandOf(s);
  const after = runToBoundary(s);

  const granted = hoards(after);
  assert.ok(granted < demand, 'the fixture really did ration, or there is nothing to distinguish');
  assert.equal(granted, DEUTERIUM_INFLUX_PER_CYCLE, 'a galaxy on an empty pool gets exactly the influx');
  assert.equal(after.reserve.avgDraw, nextAvgDraw(DEUTERIUM_INFLUX_PER_CYCLE, demand),
    'the average followed what the galaxy WANTED…');
  assert.notEqual(after.reserve.avgDraw, nextAvgDraw(DEUTERIUM_INFLUX_PER_CYCLE, granted),
    '…and provably not what it was actually handed');
  // And the consequence: the target stays sized to real demand rather than collapsing to
  // the influx, so the price keeps pointing the right way.
  assert.ok(targetReserve(after.reserve.avgDraw) > targetReserve(DEUTERIUM_INFLUX_PER_CYCLE));
});

// --- 4. THE ACCEPTANCE TEST: THE POOL STABILISES ---------------------------------------

test('ACCEPTANCE: a normal-load galaxy CONVERGES — draw meets the influx and the pool settles', () => {
  // THE HEADLINE. This exact galaxy, under 5a and 5b-i, bled its pool to zero and rationed
  // for ever. Run it long enough and the controller finds the price at which total draw
  // equals the influx — a price nothing in the engine knows in advance.
  const { state, rows } = runCycles(galaxy(SPREAD, { pool: 1400 }), 60);
  const tail = rows.slice(-10);

  // 1. DRAW MET SUPPLY. The whole point of the loop.
  for (const r of tail) {
    assert.ok(Math.abs(r.demand - DEUTERIUM_INFLUX_PER_CYCLE) <= 10,
      `settled demand ${r.demand} must sit within 10 of the influx ${DEUTERIUM_INFLUX_PER_CYCLE}`);
  }
  // 2. THE POOL SETTLED — positive, and not still moving.
  assert.ok(state.reserve.reserveLevel > 0, 'the pool is emphatically not zero');
  const poolSpread = Math.max(...tail.map((r) => r.pool)) - Math.min(...tail.map((r) => r.pool));
  assert.ok(poolSpread <= 20, `the settled pool barely moves across ten cycles (spread ${poolSpread})`);
  // 3. NOT RATIONING. Everyone is paid in full at the settled price.
  for (const g of state.guilds) {
    if (g.lastFuelGrant) {
      assert.equal(g.lastFuelGrant.granted, g.lastFuelGrant.desired,
        `${g.id}: a converged galaxy pays in full`);
    }
  }
  // 4. NO OSCILLATION. The pool approaches its settled level from below and stays there —
  // the model's "converges with zero oscillation" claim for PRICE_SENSITIVITY 1.5, checked
  // rather than trusted. (Cycle 1 is the opening correction and is excluded: the fixture
  // deliberately opens far off target, which is the transient, not the steady state.)
  const settled = rows.slice(-20);
  for (let i = 1; i < settled.length; i += 1) {
    assert.ok(settled[i].pool >= settled[i - 1].pool - 1,
      `cycle ${i}: the settled pool must not ring (went ${settled[i - 1].pool} -> ${settled[i].pool})`);
  }
  // 5. AND IT LANDED WHERE THE MODEL SAID, which is what makes the coefficients calibrated
  // rather than merely present. phase-1-tuning.md's discrete model puts this galaxy at pool
  // ~2108 / price ~12.15; the real engine, on integer grants, lands right beside it.
  assert.ok(Math.abs(state.reserve.reserveLevel - 2108) < 60,
    `the settled pool ${state.reserve.reserveLevel} must be near the modelled 2108`);
  assert.ok(Math.abs(state.reserve.fuelPrice - 12.15) < 0.3,
    `the settled price ${state.reserve.fuelPrice} must be near the modelled 12.15`);
  assertConserved(state, 'a converged galaxy');
});

test('the controller is SCALE-INVARIANT: bigger galaxies settle at the same DRAW, not the same pool', () => {
  // The demand-relative target is what buys this, and it is why the setpoint is "three
  // cycles of draw" rather than a number of units. What is invariant is the OUTCOME — draw
  // meets the influx — and the target, which at equilibrium is `TARGET_CYCLES × influx` in
  // any galaxy, because a converged galaxy by definition draws the influx.
  //
  // ⚠ WHAT IS *NOT* INVARIANT IS THE SETTLED POOL, and it took running this to see why. A
  // bigger galaxy needs a HIGHER price to be held to the same supply, and the only way the
  // curve produces a higher price is a pool further below target — so a bigger galaxy
  // settles on a SMALLER buffer. Worth stating plainly rather than letting "scale-invariant"
  // be read as "identical in every column".
  const wings = (n) => [...Array(n)].flatMap((_, w) => SPREAD
    .filter((g) => g.mines)
    .map((g) => ({ ...g, id: `${g.id}-w${w + 1}` })));

  const small = runCycles(galaxy(wings(1), { pool: 1400 }), 80);
  const big = runCycles(galaxy(wings(3), { pool: 4200 }), 80);

  for (const [label, run] of [['1 wing', small], ['3 wings', big]]) {
    const last = run.rows[run.rows.length - 1];
    assert.ok(Math.abs(last.demand - DEUTERIUM_INFLUX_PER_CYCLE) <= 12,
      `${label}: settles at draw = influx (got ${last.demand})`);
    assert.ok(Math.abs(targetReserve(run.state.reserve.avgDraw)
      - TARGET_CYCLES * DEUTERIUM_INFLUX_PER_CYCLE) < 20,
      `${label}: and its target is TARGET_CYCLES x the influx, whatever its size`);
    assert.ok(run.state.reserve.reserveLevel > 0, `${label}: with a real buffer, not zero`);
  }

  // The three-wing galaxy is genuinely three times the load — it just pays for it.
  assert.ok(big.state.reserve.fuelPrice > small.state.reserve.fuelPrice * 2.5,
    'three times the demand needs a far dearer price to be held to the same supply');
  assert.ok(big.state.reserve.reserveLevel < small.state.reserve.reserveLevel,
    'and holds a SMALLER buffer, because that is what generates the dearer price');
  // …and it is still inside the clamp, which is what separates "big" from "in crisis".
  assert.ok(big.state.reserve.fuelPrice < PRICE_CEIL,
    'three wings is still throttleable; the crisis test below is what happens when it is not');
  assertConserved(big.state, 'a three-wing galaxy');
});

test('the price a cycle ISSUES at is the one the controller posted the cycle before (§8)', () => {
  // The ordering ruling, pinned. Issuance runs at the CURRENT price; the controller writes
  // afterwards, so its write cannot reach the grants it was computed from.
  const s = galaxy(SPREAD, { pool: 1400 });
  assert.equal(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'the first cycle issues at the seed');

  const { rows } = runCycles(s, 6);
  for (let i = 1; i < rows.length; i += 1) {
    assert.equal(rows[i].priceIssuedAt, rows[i - 1].price,
      `cycle ${i} issued at the price cycle ${i - 1} posted`);
  }
  assert.equal(rows[0].priceIssuedAt, REFERENCE_FUEL_PRICE);
  // And the price really did move, or the assertion above is vacuous.
  assert.notEqual(rows[rows.length - 1].price, REFERENCE_FUEL_PRICE);
});

test('nothing happens off a boundary: the price and the average are per-CYCLE, not per-tick', () => {
  let s = galaxy(SPREAD, { pool: 1400 });
  s = runToBoundary(s);                         // land on a boundary so the controller has run
  const { fuelPrice, avgDraw, reserveLevel } = s.reserve;
  assert.notEqual(fuelPrice, REFERENCE_FUEL_PRICE, 'the controller really did write something');

  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(s.reserve.fuelPrice, fuelPrice, `tick +${i}: the price holds between boundaries`);
    assert.equal(s.reserve.avgDraw, avgDraw, `tick +${i}: so does the average`);
    assert.equal(s.reserve.reserveLevel, reserveLevel, `tick +${i}: and so does the pool`);
  }
});

test('a guild-less galaxy leaves the controller alone', () => {
  // The early return in step 6. A galaxy with no players has no demand to average and
  // nothing that could draw at any price, so running the curve on it would write a
  // meaningless answer into serialized state. It keeps its seeds instead.
  let s = createZeroState();
  for (let i = 0; i < 20; i += 1) s = tick(s);
  assert.equal(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE);
  assert.equal(s.reserve.avgDraw, DEUTERIUM_INFLUX_PER_CYCLE);
});

// --- 5. THE CRUNCH EDGE SURVIVES (§4.1) ------------------------------------------------

test('THE CRISIS: a galaxy too big for its supply pins at the CEILING and still rations', () => {
  // §4.1 is a RULING, not a failure mode the controller may quietly delete. Five wings of
  // the spread demand ~4935 at the reference; even pinned at PRICE_CEIL that is ~1234 a
  // cycle against an influx of 800, so no price this controller can post will balance it.
  // The correct behaviour is exactly what 5a did: clip, and sit at zero.
  const wings = [1, 2, 3, 4, 5].flatMap((w) => SPREAD
    .filter((g) => g.mines)
    .map((g) => ({ ...g, id: `${g.id}-w${w}` })));
  const { state, rows } = runCycles(galaxy(wings, { pool: 6000 }), 15);

  // It really is beyond the throttle: even at the ceiling, demand exceeds supply.
  const tail = rows.slice(-8);
  for (const r of tail) {
    assert.equal(r.price, PRICE_CEIL, 'the price is pinned at the ceiling, with nowhere left to go');
    assert.ok(r.demand > DEUTERIUM_INFLUX_PER_CYCLE,
      `demand ${r.demand} still exceeds the influx even at the ceiling — that is the crunch`);
  }
  // And the crunch edge behaves as §4.1 rules: the pool empties to EXACTLY zero, never
  // below, and grants are clipped.
  assert.equal(state.reserve.reserveLevel, 0, 'the pool sits at exactly zero');
  let clipped = 0;
  for (const g of state.guilds) {
    if (g.lastFuelGrant && g.lastFuelGrant.granted < g.lastFuelGrant.desired) clipped += 1;
  }
  assert.ok(clipped >= 3, `grants are still being clipped (${clipped} guilds short)`);
  // The crossing happened mid-run rather than at tick 0 — an opening buffer, then the bleed.
  const firstEmpty = rows.findIndex((r) => r.pool === 0);
  assert.ok(firstEmpty > 2, `the run opens with a buffer and crosses at cycle ${firstEmpty}`);
  assertConserved(state, 'a galaxy in genuine crisis');
});

test('the ceiling is a CLAMP, not a trap: a galaxy climbs back out of the crunch', () => {
  // The other half of §4.1: the crunch is a REGIME, not a one-way door. A controller that
  // could not climb back would have turned a ruled temporary crisis into a permanent one —
  // which is precisely the 5a failure this whole slice exists to end.
  //
  // The crisis END-STATE is SEEDED rather than reached by deleting guilds from a running
  // galaxy: an empty pool, the price pinned at the ceiling, and a demand memory inflated by
  // the guilds that have since gone. That is exactly the state a survivor is left holding,
  // and seeding it keeps the fixture a legal state rather than a mutilated one (removing
  // guilds would take their hoards with them and break invariant 1).
  const s = galaxy(SPREAD, { pool: 0, fuelPrice: PRICE_CEIL, avgDraw: 4000 });
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the seeded crisis state is itself legal');

  const { state, rows } = runCycles(s, 60);
  assert.equal(rows[0].priceIssuedAt, PRICE_CEIL, 'it really did open pinned at the ceiling');
  assert.ok(state.reserve.fuelPrice < PRICE_CEIL, 'and the price comes back off it');
  assert.ok(state.reserve.reserveLevel > 0, 'the pool refills');
  assert.ok(Math.abs(rows[rows.length - 1].demand - DEUTERIUM_INFLUX_PER_CYCLE) <= 12,
    'settling once more at draw = influx');
  // The inflated demand memory decays away rather than holding the target hostage.
  assert.ok(Math.abs(state.reserve.avgDraw - DEUTERIUM_INFLUX_PER_CYCLE) < 20,
    `the EMA forgets the departed load (${state.reserve.avgDraw})`);
  assertConserved(state, 'a galaxy that climbed out of the crunch');
});

// --- 6. THE LAWS STILL HOLD ------------------------------------------------------------

test('INVARIANT 1 across a long controlled run: the controller moves NO fuel', () => {
  // The controller reads the pool and writes a price. It must not be able to touch a unit
  // of fuel — so across a long run the only thing that mints is the influx, exactly as
  // before this slice existed.
  let s = galaxy(SPREAD, { pool: 1400 });
  const producedAtStart = s.audit.totalProduced;
  let boundaries = 0;
  for (let c = 0; c < 30; c += 1) {
    s = runToBoundary(s);
    boundaries += 1;
    assertConserved(s, `boundary ${boundaries} under the controller`);
  }
  assert.equal(s.audit.totalProduced - producedAtStart, boundaries * DEUTERIUM_INFLUX_PER_CYCLE,
    'the influx is the ONLY thing that minted, controller or no controller');
  assert.equal(s.audit.totalConsumed, 0, 'and nothing was consumed — no trade in this fixture');
  // The price moved a great deal over those cycles, which is what makes the above a claim.
  assert.notEqual(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE);
});

test('determinism (invariant 9): a controlled galaxy is byte-identical run twice', () => {
  const run = () => {
    let s = galaxy(SPREAD, { pool: 1400 });
    for (let i = 0; i < 60; i += 1) s = tick(s);
    return hashState(s);
  };
  assert.equal(run(), run(), 'the same galaxy under the same controller hashes the same, every run');
});

test('the snapshot publishes the controller: price, the demand average and the target', () => {
  let s = galaxy(SPREAD, { pool: 1400 });
  s = runToBoundary(s);
  const fuel = buildSnapshot(s).galacticSupply.fuel;

  assert.equal(fuel.fuelPrice, s.reserve.fuelPrice, 'the price is echoed off state');
  assert.equal(fuel.avgDraw, s.reserve.avgDraw, 'and so is the demand average');
  // The target is DERIVED through the engine's own function, so a reader never carries a
  // second copy of the rule (§15.5 invariant 5).
  assert.equal(fuel.targetReserve, targetReserve(s.reserve.avgDraw));
  assert.equal(fuel.targetReserve, TARGET_CYCLES * fuel.avgDraw);
  // Read together they explain the price without any reader doing arithmetic on constants.
  assert.ok(fuel.reserve < fuel.targetReserve, 'this galaxy is still below target…');
  assert.ok(fuel.fuelPrice > REFERENCE_FUEL_PRICE, '…which is exactly why fuel is dear');
  assert.equal(buildSnapshot(s).schemaVersion, 7, 'additive fields, no schema bump');
});
