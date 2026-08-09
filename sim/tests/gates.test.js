'use strict';

// §5 rate-based engine rewrite (10-08-26): stepProduction reads the System
// Production Profile and routes each good through the three gates, then a line
// turns its allocation into output at a CONTINUOUS rate (no floor(batches)). These
// tests pin the gate behaviour directly, building controlled single-system
// scenarios with createState so every fresh quantity and policy is exact.
//
// This file was rewritten FROM the old floor-batches truth TO the rate-based
// truth: the "never touch the pile" test becomes a drawdown test, and new tests
// prove the behaviour the rewrite exists to create (a 67% line never stalls at 0,
// a shared pile splits proportionally not first-come, a line runs off the
// stockpile down to a reserve floor, an abundant input spills back).
//
// Recipe shapes used (from recipes.js, all qty 1 unless noted so an allocation
// maps straight to a batch): conductive_material = copper + silica; silicon_wafer
// = silica + silver + palladium; titanium_alloy = 3 titanium + 1 carbon_products.
// conductive/wafer SHARE silica but output DIFFERENT goods, so a split is visible
// in the pool (one makes conductive_material, the other silicon_wafer).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { resolveProduction } = require('../production.js');

const SYS = 'sysA';

// Build a one-guild, one-system state. `ventures` are placed in SYS; `profile` is
// the guild's productionProfile for SYS; `stockpiles` seeds a pre-existing pile.
function sysState({ ventures, profile = {}, stockpiles = {} }) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: Object.keys(stockpiles).length ? { [SYS]: stockpiles } : {},
      productionProfile: Object.keys(profile).length ? { [SYS]: profile } : {},
      ventures,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const mine = (id, good, rate) => ({ id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate });
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);
const acc = (s, id) => s.guilds[0].ventures.find((v) => v.id === id).outputAccumulator;

// --- default profile reproduces today's behaviour where fresh meets demand ----

test('default profile: when fresh supply meets demand, output matches the fed-fully behaviour', () => {
  // copper 10/tick + silica 10/tick feed one conductive_material refinery rate 10:
  // fresh (10,10) exactly meets demand (10,10), so no pile forms, the line runs at
  // rate 10 — 10 conductive/tick, pools net 0.
  let s = sysState({ ventures: [mine('cu', 'copper', 10), mine('si', 'silica', 10), refinery('r', 'conductive_material', 10)] });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 10);
  assert.equal(held(s, 'copper'), 0);
  assert.equal(held(s, 'silica'), 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = tick(s); s = tick(s);
  assert.equal(held(s, 'conductive_material'), 30); // 3 ticks * 10
});

// --- the stockpile is a drawable input source (drawdown replaces never-touch) ---

test('drawdown: a refinery draws the shortfall from the accumulated pile (was: never touch it)', () => {
  // A pre-existing pile of 100 copper + 100 silica; copper mints only 2 fresh/tick,
  // silica plentiful. A rate-10 conductive_material refinery demands 10 copper. The
  // §5 rewrite lands the DRAWDOWN: the 2 fresh copper plus 8 drawn from the pile
  // feed 10 batches — the OLD "never touch the pile" model gave only 2. The pile
  // falls by exactly the drawn shortfall (100 + 2 fresh - 10 consumed = 92).
  let s = sysState({
    ventures: [mine('cu', 'copper', 2), mine('si', 'silica', 100), refinery('r', 'conductive_material', 10)],
    stockpiles: { copper: 100, silica: 100 },
  });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 10, 'fresh 2 + drawdown 8 = 10 batches (old fresh-only gave 2)');
  assert.equal(held(s, 'copper'), 92, 'pile drawn down by the 8-unit shortfall (100 + 2 - 10)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- Gate 1 waterfall ----------------------------------------------------------

test('Gate 1: a stockpile floor ranked above downstream starves downstream by exactly the floor', () => {
  // fresh silica 10; a 40%-of-fresh stockpile floor ranked FIRST sets aside 4 before
  // downstream is fed, leaving 6 for the rate-10 conductive line. demand copper/silica
  // = 10 each. Copper is unconstrained (fresh 10), silica is floored: supplied silica
  // = 10 - floor(10*40/100)=4 => 6. No pre-existing pile, so no drawdown: 6 batches.
  let s = sysState({
    ventures: [mine('cu', 'copper', 10), mine('si', 'silica', 10), refinery('r', 'conductive_material', 10)],
    profile: { goods: { silica: { order: ['stockpile', 'downstream', 'syndicate'], stockpile: { mode: 'percent', value: 40 } } } },
  });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 6, 'downstream starved by exactly the 4-unit floor (10 - 4)');
  assert.equal(held(s, 'silica'), 4, 'the floor stays in the pool');
  assert.equal(held(s, 'copper'), 4, 'copper: 10 fresh - 6 consumed = 4 left (rate held at 6 by silica)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('Gate 1: a downstream cap below full demand leaves the remainder in stockpile', () => {
  // downstreamPct 50 on silica caps its downstream draw at floor(10*50/100)=5, so the
  // refinery runs 5 batches and 5 fresh silica lands in the pool.
  let s = sysState({
    ventures: [mine('cu', 'copper', 10), mine('si', 'silica', 10), refinery('r', 'conductive_material', 10)],
    profile: { goods: { silica: { downstreamPct: 50 } } },
  });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 5);
  assert.equal(held(s, 'silica'), 5, 'the uncapped remainder waterfalls into stockpile');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- Gate 3 distribution -------------------------------------------------------

// Two refineries competing for short silica; conductive_material (r_a) is established
// BEFORE silicon_wafer (r_b), so it is the earliest line for the FCFS / remainder rule.
function twoRefineriesForSilica(profile, silicaRate = 10) {
  return sysState({
    ventures: [
      mine('cu', 'copper', 20), mine('si', 'silica', silicaRate),
      mine('ag', 'silver', 20), mine('pd', 'palladium', 20),
      refinery('r_a', 'conductive_material', 10), // earliest consumer
      refinery('r_b', 'silicon_wafer', 10),
    ],
    profile,
  });
}

test('Gate 3 FCFS (no throttles): short silica goes to the earliest-established line first', () => {
  // fresh silica 10, demand 20 (10 each), no pile. No throttles => FCFS: r_a (earliest)
  // takes its full 10, r_b starves.
  let s = twoRefineriesForSilica({});
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 10, 'earliest line fed fully');
  assert.equal(held(s, 'silicon_wafer'), 0, 'later line starves under FCFS');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('Gate 3 proportional: throttled lines split a short good in proportion, remainder to the earliest', () => {
  // r_a throttle 100, r_b throttle 50 => silica wants 10 and 5 (total 15); only 10
  // arrives (no pile). floor split: r_a=floor(10*10/15)=6, r_b=floor(10*5/15)=3;
  // remainder 1 to the earliest line (r_a) => r_a silica 7, r_b silica 3. Other inputs
  // are plentiful, so those become the rates: conductive 7, wafer 3.
  let s = twoRefineriesForSilica({ throttles: { r_a: 100, r_b: 50 } });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 7, 'floor 6 + rounding remainder 1 (earliest line)');
  assert.equal(held(s, 'silicon_wafer'), 3);
  assert.equal(held(s, 'silica'), 0, 'all 10 fresh silica allocated (7 + 3), none left');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- read-time reconciliation (§5) — falls out of reading the actual ventures --

test('reconciliation: a stale throttle (named venture removed) is ignored; survivors re-split', () => {
  // Same profile (throttles for r_a AND r_b) applied to two states: one with both
  // refineries, one with r_b removed but its throttle still stored. With r_b present
  // the split is 7/3; with r_b gone, r_a alone re-splits and takes all 10 fresh silica
  // (its stale peer's throttle simply never resolves to a consumer) => conductive 10.
  const profile = { throttles: { r_a: 100, r_b: 50 } };
  let withB = twoRefineriesForSilica(profile);
  withB = tick(withB);
  assert.equal(held(withB, 'conductive_material'), 7);

  let withoutB = sysState({
    ventures: [mine('cu', 'copper', 20), mine('si', 'silica', 10), refinery('r_a', 'conductive_material', 10)],
    profile, // still names r_b, which no longer exists
  });
  withoutB = tick(withoutB);
  assert.equal(held(withoutB, 'conductive_material'), 10, 'survivor re-splits to take all fresh silica');
  assert.deepEqual(checkInvariants(withoutB, withoutB.tick), []);
});

test('reconciliation: a new venture the profile is silent about defaults to 100 and competes fully', () => {
  // r_a throttled to 50; r_b has NO throttle. The good silica has a throttled consumer
  // (r_a), so the regime is proportional and r_b defaults to 100%: wants 5 and 10
  // (total 15) for 10 fresh silica => r_a floor(10*5/15)=3 +remainder 1 = 4, r_b
  // floor(10*10/15)=6. The silent line out-competes the throttled one, as intended.
  let s = twoRefineriesForSilica({ throttles: { r_a: 50 } });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 4);
  assert.equal(held(s, 'silicon_wafer'), 6, 'the profile-silent line defaults to full and competes');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- the rate-based core: a fractional line runs, it never stalls at 0 ----------

test('rate-1 line at 67%: averages ~0.67 output/tick over many ticks and NEVER stalls at 0', () => {
  // The bug this rewrite kills: the old floor(batches) resolver computed
  // floor(1 * 0.67) = 0 for a rate-1 line throttled to 67%, so it produced NOTHING
  // forever. The rate-based line runs at a continuous 0.67, minting a whole unit
  // through the output accumulator whenever it crosses 1 — ~67 over 100 ticks.
  let s = sysState({
    ventures: [mine('cu', 'copper', 2), mine('si', 'silica', 2), refinery('r', 'conductive_material', 1)],
    profile: { throttles: { r: 67 } },
  });
  for (let i = 0; i < 100; i += 1) {
    s = tick(s);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  const out = held(s, 'conductive_material');
  assert.ok(out >= 66 && out <= 68, `~0.67/tick over 100 ticks => ~67 (got ${out})`);
  assert.ok(out > 0, 'the line never stalled at 0 (the old floor-batches bug)');
  assert.ok(acc(s, 'r') >= 0 && acc(s, 'r') < 1, 'the carry stays fenced in [0,1)');
});

test('rate-5 line at 67% runs at 0.67, not the old floor(batches) 0.60', () => {
  // rate 5 throttled 67%: the rate-based line runs at 5*0.67 = 3.35 batches/tick
  // => ~335 output over 100 ticks. The old floor(5*0.67)=3 model ran it at 3/tick
  // = 60% (300), silently shedding the 0.35 remainder every tick.
  let s = sysState({
    ventures: [mine('cu', 'copper', 5), mine('si', 'silica', 5), refinery('r', 'conductive_material', 5)],
    profile: { throttles: { r: 67 } },
  });
  for (let i = 0; i < 100; i += 1) s = tick(s);
  const out = held(s, 'conductive_material');
  assert.ok(out >= 334 && out <= 336, `3.35/tick over 100 ticks => ~335 (got ${out})`);
  assert.ok(out > 300, 'runs at 0.67, strictly more than the old floor-batches 0.60 (=300)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- Ruling 1: the drawdown folds into Gate 3 — one pile splits 5/5, not 8/2 ----

// Two lines share ONE silica pile of 10 (no fresh silica), each wanting 8. The
// ruled fold-into-Gate-3 splits the combined pool proportionally (5/5), NOT a
// per-line sequential clamp (8/2, earliest wins). Both throttled at 100% with
// rate 8 => each wants 8 of silica.
function onePileTwoLines(order) {
  const ventures = [
    mine('cu', 'copper', 8), mine('ag', 'silver', 8), mine('pd', 'palladium', 8),
    refinery('r_a', 'conductive_material', 8),
    refinery('r_b', 'silicon_wafer', 8),
  ];
  // `order` reverses the two refineries in the ventures array to prove the split
  // is order-INDEPENDENT (a sequential clamp would flip to 2/8).
  if (order === 'reversed') { const a = ventures[3]; ventures[3] = ventures[4]; ventures[4] = a; }
  return sysState({
    ventures,
    profile: { throttles: { r_a: 100, r_b: 100 } },
    stockpiles: { silica: 10 }, // the one pile, no fresh silica mine, reserveFloor default 0
  });
}

test('drawdown Ruling 1: two lines drawing one 10-unit silica pile split 5/5, order-independent', () => {
  let a = onePileTwoLines('normal');
  a = tick(a);
  assert.equal(held(a, 'conductive_material'), 5, 'proportional split of the pile, not 8 to the earliest');
  assert.equal(held(a, 'silicon_wafer'), 5);
  assert.equal(held(a, 'silica'), 0, 'the whole pile (10) drawn: 5 + 5');

  // Reorder the two ventures — the split must NOT change (a sequential clamp would).
  let b = onePileTwoLines('reversed');
  b = tick(b);
  assert.equal(held(b, 'conductive_material'), 5, 'reordering the ventures does not change the split');
  assert.equal(held(b, 'silicon_wafer'), 5);
  assert.deepEqual(checkInvariants(a, a.tick), []);
  assert.deepEqual(checkInvariants(b, b.tick), []);
});

// --- reserveFloor: a no-mine input runs off the pile down to the floor, then stops -

test('reserveFloor: a titanium_alloy line with NO carbon mine runs off the carbon pile down to the floor', () => {
  // titanium_alloy = 3 titanium + 1 carbon; refinery rate 2 (demand 6 ti, 2 carbon).
  // Titanium is mined 6/tick (meets demand). Carbon has NO mine — it comes entirely
  // from a pre-seeded pile of 20 with a reserveFloor of 5. Each tick draws 2 carbon
  // until the pile nears the floor, then the last unit runs a partial batch, and at
  // the floor (5) the line stalls — the draw never dips below the reserve.
  let s = sysState({
    ventures: [mine('t', 'titanium', 6), refinery('r', 'titanium_alloy', 2)],
    profile: { goods: { carbon_products: { reserveFloor: 5 } } },
    stockpiles: { carbon_products: 20 },
  });
  for (let i = 0; i < 20; i += 1) {
    s = tick(s);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  assert.equal(held(s, 'carbon_products'), 5, 'the draw floored at the reserve and stopped there');
  // 7 full ticks (2 carbon each: 20->6) + 1 partial (6->5) => 14 + 1 = 15 alloy, then stalls.
  assert.equal(held(s, 'titanium_alloy'), 15);
});

// --- the balancer: over-delivery spills an abundant input back to the pool ------

test('over-delivery: an abundant input spills back; a tier-1 raw good rises from a scarcity on another page', () => {
  // titanium_alloy = 3 titanium + 1 carbon; refinery rate 2. Titanium is ABUNDANT
  // (mined 10/tick), carbon is the SCARCE bottleneck (mined 1/tick). The line runs
  // at the carbon-limited rate 1, so it consumes only 3 titanium of the 6 allocated
  // — the surplus 3 SPILLS back. Titanium is a tier-1 raw good (a mine makes it from
  // nothing, so it can never bottleneck at Gate 1) yet it receives spill at Gate 3:
  // its pile rises from a cause that lives on carbon's page.
  const s = sysState({
    ventures: [mine('t', 'titanium', 10), mine('c', 'carbon_products', 1), refinery('r', 'titanium_alloy', 2)],
  });
  const report = resolveProduction(s.guilds[0], SYS);
  const tiLine = report.lines.find((l) => l.good === 'titanium');
  assert.equal(tiLine.alloc, 6, 'allocated its full-tilt draw (demand 2*3)');
  assert.equal(tiLine.consumed, 3, 'but consumes only what the carbon-limited rate 1 needs (3)');
  assert.equal(tiLine.spill, 3, 'the abundant surplus spills back');
  assert.equal(tiLine.consumed + tiLine.spill, tiLine.alloc, 'balancer identity holds');
  const bottleneck = report.refineries.find((r) => r.ventureId === 'r').bottleneckGood;
  assert.equal(bottleneck, 'carbon_products', 'the scarce input is the reported bottleneck');

  const after = tick(s);
  // Titanium pile: 10 fresh - 3 consumed = +7/tick (the 4 not sent downstream + the 3 spill).
  assert.equal(held(after, 'titanium'), 7, 'the tier-1 raw good accumulates from the spill');
  assert.equal(held(after, 'titanium_alloy'), 1, 'one alloy from the carbon-limited rate');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- conservation: consumed + spill = alloc, every input, every tick -----------

test('conservation: consumed + spill = alloc per input each tick, and every invariant holds', () => {
  // A contended, multi-input scenario run several ticks. Each tick, the resolver's
  // report must satisfy the balancer identity for every line, and the tick's own
  // invariants (incl. galactic-supply consistency and the carry tripwire) must pass.
  let s = twoRefineriesForSilica({ throttles: { r_a: 67, r_b: 33 } }, 7);
  for (let i = 0; i < 12; i += 1) {
    const report = resolveProduction(s.guilds[0], SYS);
    for (const line of report.lines) {
      assert.equal(line.consumed + line.spill, line.alloc, `consumed+spill=alloc for ${line.ventureId}/${line.good}`);
      assert.ok(line.spill >= 0, 'spill is never negative');
    }
    s = tick(s);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

// --- the carry tripwire, and that it actually catches a bad value --------------

test('carry tripwire: 0 <= outputAccumulator < 1 holds every tick, and a bad value is caught', () => {
  let s = sysState({
    ventures: [mine('cu', 'copper', 5), mine('si', 'silica', 5), refinery('r', 'conductive_material', 5)],
    profile: { throttles: { r: 67 } },
  });
  for (let i = 0; i < 30; i += 1) {
    s = tick(s);
    const a = acc(s, 'r');
    assert.ok(a >= 0 && a < 1, `carry fenced in [0,1) (got ${a})`);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  // Corrupt the carry out of range: the dedicated tripwire must flag it.
  s.guilds[0].ventures[0].outputAccumulator = 1.5;
  const violations = checkInvariants(s, s.tick);
  assert.ok(violations.some((v) => v.rule.startsWith('output-accumulator')), 'an out-of-range carry trips the wire');
});

// --- determinism (invariant 9) at tick 50, with a fractional carry in state ----

test('determinism: same start + fractional throttles, run twice to tick 50, identical hash', () => {
  const build = () => {
    let s = sysState({
      ventures: [
        mine('cu', 'copper', 6), mine('si', 'silica', 6),
        mine('ag', 'silver', 6), mine('pd', 'palladium', 6),
        refinery('r_a', 'conductive_material', 5), // rate 5 @ 67% => fractional carry
        refinery('r_b', 'silicon_wafer', 5),
      ],
      profile: {
        goods: { silica: { order: ['stockpile', 'downstream', 'syndicate'], downstreamPct: 80, stockpile: { mode: 'percent', value: 20 } } },
        throttles: { r_a: 67, r_b: 33 },
      },
    });
    for (let i = 0; i < 50; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
