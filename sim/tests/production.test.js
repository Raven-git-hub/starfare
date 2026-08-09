'use strict';

// §5 rate-based engine rewrite (10-08-26). The gate resolution is ONE pure
// function `resolveProduction` (sim/production.js); `stepProduction` APPLIES its
// report and the read-only `previewProduction` selector REPORTS it, so the
// displayed numbers and the moved numbers are one computation and cannot drift
// (design.md §5 "the resolved numbers come from the engine, never the browser").
//
// The rewrite is a DELIBERATE behaviour change (continuous rate + stockpile
// drawdown + the output-accumulator balancer), so these tests prove the NEW
// behaviour: the report predicts the exact pool deltas the tick then moves (now
// via the balancer's `consumed`/`minted`, not floor(batches)), determinism holds
// with the fractional carry in serialized state, the selector is pure, the report
// carries the new shape, and the null-system case still resolves.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { getRecipe } = require('../recipes.js');
const { resolveProduction, previewProduction } = require('../production.js');

const SYS = 'sysA';
const mine = (id, good, rate) => ({ id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate });
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);

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

// A real scenario exercising Gate-1 forking (a stockpile floor + downstream cap on
// silica), Gate-3 contention (r_a and r_b compete for short silica), a fractional
// throttle (r_a at 67% => a fractional carry), a stockpile drawdown (a pre-seeded
// silica pile), and a stalled line (r_c needs polymers nothing produces).
function chainState() {
  return sysState({
    ventures: [
      mine('cu', 'copper', 20), mine('si', 'silica', 7),
      mine('ag', 'silver', 20), mine('pd', 'palladium', 20),
      mine('c', 'carbon_products', 4),
      refinery('r_a', 'conductive_material', 10), // copper + silica
      refinery('r_b', 'silicon_wafer', 10),       // silica + silver + palladium
      refinery('r_c', 'carbon_fiber_weave', 3),   // carbon_products + polymers -> stalls (no polymers)
    ],
    profile: {
      goods: { silica: { order: ['stockpile', 'downstream', 'syndicate'], downstreamPct: 80, stockpile: { mode: 'percent', value: 20 } } },
      throttles: { r_a: 67, r_b: 50 },
    },
    stockpiles: { silica: 30 }, // a pile to draw down
  });
}

// --- The anti-drift tripwire: the report predicts exactly what the tick does ----

// Predict a tick's per-good pool delta from the report ALONE (the balancer: mines
// deposit fresh, each line removes `consumed`, each running refinery mints output).
function predictedDeltas(guild) {
  const report = resolveProduction(guild, SYS);
  const d = {};
  for (const m of report.mines) d[m.good] = (d[m.good] || 0) + m.amount;
  for (const l of report.lines) d[l.good] = (d[l.good] || 0) - l.consumed;
  for (const r of report.refineries) {
    if (r.minted <= 0) continue;
    const out = getRecipe(guild.ventures.find((v) => v.id === r.ventureId).recipeId).output;
    d[out.good] = (d[out.good] || 0) + r.minted;
  }
  return d;
}

test('anti-drift: the report predicts the pool deltas a real tick then produces, tick after tick', () => {
  let s = chainState();
  for (let i = 0; i < 15; i += 1) {
    const predicted = predictedDeltas(s.guilds[0]);
    const before = {};
    for (const good of Object.keys(predicted)) before[good] = held(s, good);
    s = tick(s);
    for (const good of Object.keys(predicted)) {
      assert.equal(held(s, good) - before[good], predicted[good], `delta for ${good} at tick ${s.tick}`);
    }
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

test('anti-drift: the preview surfaces the SAME resolved report the tick moves from', () => {
  const s = chainState();
  const report = resolveProduction(s.guilds[0], SYS);
  const preview = previewProduction(s);
  // The preview adds a read-only `review` array (slice 2c-i); everything else is
  // byte-identical to what the tick resolves from.
  const { review, ...resolved } = preview[0].systems[0];
  assert.deepEqual(resolved, report);
  assert.ok(Array.isArray(review), 'the preview adds a read-only review array');
});

// --- Determinism (invariant 9) with the fractional carry now in serialized state -

test('determinism: same start, run twice to tick 50, identical hash (fractional carry in state)', () => {
  const build = () => { let s = chainState(); for (let i = 0; i < 50; i += 1) s = tick(s); return s; };
  assert.equal(hashState(build()), hashState(build()));
});

// --- Purity: the selector reads state and changes nothing ----------------------

test('purity: previewProduction does not mutate state (hash identical before/after)', () => {
  const s = chainState();
  const before = hashState(s);
  const report = previewProduction(s);
  assert.equal(hashState(s), before, 'state must be byte-identical after a preview');
  assert.ok(Array.isArray(report) && report.length === 1, 'the preview still returns a real report');
});

// --- The report shape: fork split + drawdown pool + balancer + rate telemetry ---

test('report: a good carries fresh/demand/fork/supplied/drawable/pool and each line its balancer split', () => {
  // fresh silica 10, two consumers demanding 10 each (demand 20), a pre-seeded pile
  // of 5, both throttled (r_a 100 / r_b 50). Gate 1 (default order) supplies
  // min(20, 10)=10 fresh; drawable = 5 - floor(0) = 5; pool = 15. Proportional wants
  // 10 and 5 (total 15), toAllocate=min(15,15)=15 => r_a 10, r_b 5. Other inputs
  // plentiful, so r_a runs at rate 10, r_b at its throttle cap 5.
  const s = sysState({
    ventures: [
      mine('cu', 'copper', 20), mine('si', 'silica', 10),
      mine('ag', 'silver', 20), mine('pd', 'palladium', 20),
      refinery('r_a', 'conductive_material', 10),
      refinery('r_b', 'silicon_wafer', 10),
    ],
    profile: { throttles: { r_a: 100, r_b: 50 } },
    stockpiles: { silica: 5 },
  });
  const report = resolveProduction(s.guilds[0], SYS);

  const silica = report.goods.silica;
  assert.equal(silica.fresh, 10);
  assert.equal(silica.demand, 20);        // Gate-2 naive full-tilt (10 + 10)
  assert.equal(silica.supplied, 10);      // downstream fresh take (= fork.downstream)
  assert.equal(silica.fork.downstream, 10);
  assert.equal(silica.drawable, 5);       // the pile, above the (default 0) reserve floor
  assert.equal(silica.pool, 15);          // supplied + drawable — what Gate 3 rations

  const laSilica = report.lines.find((l) => l.good === 'silica' && l.ventureId === 'r_a');
  const lbSilica = report.lines.find((l) => l.good === 'silica' && l.ventureId === 'r_b');
  assert.equal(laSilica.alloc, 10);
  assert.equal(laSilica.consumed + laSilica.spill, laSilica.alloc, 'balancer identity');
  assert.equal(lbSilica.alloc, 5);

  const ra = report.refineries.find((r) => r.ventureId === 'r_a');
  const rb = report.refineries.find((r) => r.ventureId === 'r_b');
  assert.equal(ra.rate, 10);
  assert.equal(ra.minted, 10);
  assert.equal(rb.rate, 5);               // held at its throttle cap (0.5 * 10)
  assert.ok(ra.accumulator >= 0 && ra.accumulator < 1, 'carry fenced in [0,1)');
  assert.ok(typeof ra.bottleneckGood === 'string', 'the min input is reported as the bottleneck');
});

// --- Null-system tolerance: a seatless mine resolves without crashing -----------

test('null-system: previewProduction includes a seatless mine (no systemId) without crashing', () => {
  // A mining venture with no siteId and no systemId, whose fresh flow the tick
  // deposits into an undefined-keyed pool. The resolver and preview must tolerate it
  // — including the new start-of-step pool read (getStock on a null system => 0).
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 'v1', ownerGuildId: 'g1', type: 'mining', resourceType: 'titanium', productionRate: 5 },
    ] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const preview = previewProduction(s);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].systems.length, 1, 'the null-system is included, not dropped');
  const sysReport = preview[0].systems[0];
  assert.equal(sysReport.systemId, null); // createVenture defaults an unseated venture's systemId to null
  assert.deepEqual(sysReport.mines, [{ ventureId: 'v1', good: 'titanium', amount: 5 }]);
  assert.deepEqual(sysReport.goods, {}); // no refinery consumes it, so no downstream figure
});
