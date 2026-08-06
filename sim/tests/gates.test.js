'use strict';

// Slice 2a-ii: stepProduction reads the System Production Profile and routes each
// good through §5's three gates. These tests pin the gate behaviour directly,
// building controlled single-system scenarios with createState so every fresh
// quantity and policy is exact.
//
// Recipe shapes used (from recipes.js, all qty 1 so an allocation maps straight to
// batches): conductive_material = copper + silica; silicon_wafer = silica + silver
// + palladium. The two SHARE silica but output DIFFERENT goods — so when they
// compete for a short silica supply, the split is visible in the pool (one produces
// conductive_material, the other silicon_wafer), which a single shared output could
// never reveal.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');

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

// --- default profile reproduces today's behaviour where fresh meets demand ----

test('default profile: when fresh supply meets demand, output matches the old fed-fully behaviour', () => {
  // copper 10/tick + silica 10/tick feed one conductive_material refinery rate 10:
  // fresh (10,10) exactly meets demand (10,10), so no pile forms and the gates with
  // defaults reproduce the old whole-pool result — 10 conductive/tick, pools net 0.
  let s = sysState({ ventures: [mine('cu', 'copper', 10), mine('si', 'silica', 10), refinery('r', 'conductive_material', 10)] });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 10);
  assert.equal(held(s, 'copper'), 0);
  assert.equal(held(s, 'silica'), 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = tick(s); s = tick(s);
  assert.equal(held(s, 'conductive_material'), 30); // 3 ticks * 10
});

// --- never touch the pile ------------------------------------------------------

test('never touch the pile: a refinery draws only fresh supply, the accumulated pile is untouched', () => {
  // A pre-existing pile of 100 copper + 100 silica; copper mints only 2 fresh/tick,
  // silica plentiful. A rate-10 conductive_material refinery demands 10 copper, but
  // may draw only the 2 FRESH — so it runs 2 batches, NOT the 10 the old whole-pool
  // draw managed by dipping into the pile. The copper pile stays put.
  let s = sysState({
    ventures: [mine('cu', 'copper', 2), mine('si', 'silica', 100), refinery('r', 'conductive_material', 10)],
    stockpiles: { copper: 100, silica: 100 },
  });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 2, 'fresh copper (2) caps it at 2 batches — old whole-pool would give 10');
  assert.equal(held(s, 'copper'), 100, 'pile untouched: +2 fresh in, 2 consumed'); // old whole-pool: 92
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- Gate 1 waterfall ----------------------------------------------------------

test('Gate 1: a stockpile floor ranked above downstream starves downstream by exactly the floor', () => {
  // fresh silica 10; a 40%-of-fresh stockpile floor ranked FIRST sets aside 4 before
  // downstream is fed, leaving 6 for the rate-10 wafer... use conductive here (single
  // input pair). demand copper/silica = 10 each. Copper is unconstrained (fresh 10),
  // silica is floored: downstream silica = 10 - floor(10*40/100)=4 => 6. So 6 batches.
  let s = sysState({
    ventures: [mine('cu', 'copper', 10), mine('si', 'silica', 10), refinery('r', 'conductive_material', 10)],
    profile: { goods: { silica: { order: ['stockpile', 'downstream', 'syndicate'], stockpile: { mode: 'percent', value: 40 } } } },
  });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 6, 'downstream starved by exactly the 4-unit floor (10 - 4)');
  assert.equal(held(s, 'silica'), 4, 'the floor stays in the pool');
  assert.equal(held(s, 'copper'), 4, 'copper: 10 fresh - 6 drawn = 4 left (downstream took only what silica allowed)');
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
  // fresh silica 10, demand 20 (10 each). No throttles => FCFS: r_a (earliest) takes
  // its full 10, r_b starves.
  let s = twoRefineriesForSilica({});
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 10, 'earliest line fed fully');
  assert.equal(held(s, 'silicon_wafer'), 0, 'later line starves under FCFS');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('Gate 3 proportional: throttled lines split a short good in proportion, remainder to the earliest', () => {
  // r_a throttle 100, r_b throttle 50 => asks 10 and 5 (total 15) for silica; only 10
  // arrives. floor split: r_a=floor(10*10/15)=6, r_b=floor(10*5/15)=3; remainder 1 to
  // the earliest line (r_a) => r_a silica 7, r_b silica 3. Other inputs are plentiful,
  // so those become the batch counts: conductive 7, wafer 3.
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
  // (r_a), so the regime is proportional and r_b defaults to 100%: asks 5 and 10
  // (total 15) for 10 fresh silica => r_a floor(10*5/15)=3 +remainder 1 = 4, r_b
  // floor(10*10/15)=6. The silent line out-competes the throttled one, as intended.
  let s = twoRefineriesForSilica({ throttles: { r_a: 50 } });
  s = tick(s);
  assert.equal(held(s, 'conductive_material'), 4);
  assert.equal(held(s, 'silicon_wafer'), 6, 'the profile-silent line defaults to full and competes');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- determinism (invariant 9) at tick 50 -------------------------------------

test('determinism: same start + profile, run twice to tick 50, identical canonical hash', () => {
  const build = () => {
    let s = twoRefineriesForSilica({
      goods: { silica: { order: ['stockpile', 'downstream', 'syndicate'], downstreamPct: 80, stockpile: { mode: 'percent', value: 20 } } },
      throttles: { r_a: 100, r_b: 50 },
    });
    for (let i = 0; i < 50; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
