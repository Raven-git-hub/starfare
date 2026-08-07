'use strict';

// Slice 2b-i: the gate resolution is extracted into ONE pure function
// `resolveProduction` (sim/production.js); `stepProduction` APPLIES its report and
// the read-only `previewProduction` selector REPORTS it, so the displayed numbers
// and the moved numbers are one computation and cannot drift (design.md §5
// "the resolved numbers come from the engine, never the browser", ruled 07-08-26).
//
// This slice is a PROVABLE NO-OP: no produced number changes. These tests pin
// that (galactic supply over a real multi-tick scenario, determinism), pin the
// anti-drift property (the preview predicts exactly what the tick does), pin
// purity (the selector mutates nothing), and pin the null-system tolerance the
// resolver inherits from stepProduction.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { getRecipe } = require('../recipes.js');
const { resolveProduction, previewProduction } = require('../production.js');
const { computeGalacticSupply } = require('../supply.js');

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

// --- No-op proof: a real mine -> two-refinery chain, 50 ticks -------------------

// A real scenario exercising both Gate-1 forking (a stockpile floor + downstream
// cap on silica) and Gate-3 contention (r_a and r_b compete for the short silica),
// plus a stalled line (r_c needs polymers that nothing produces). The exact 50-tick
// figures below are the pre-refactor engine's — captured before the extraction and
// hard-pinned here, so if the extraction ever changes a produced number this test
// fails loudly. (conductive_material and silicon_wafer share silica but output
// DIFFERENT goods, so the split is visible in the pool.)
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
      throttles: { r_a: 100, r_b: 50 },
    },
  });
}

test('no-op: galactic supply over a 50-tick chain matches the pre-refactor engine exactly', () => {
  let s = chainState();
  for (let i = 0; i < 50; i += 1) s = tick(s);
  const r = computeGalacticSupply(s).resources;
  // Byte-identical to the numbers the whole-in-stepProduction engine produced.
  assert.equal(r.conductive_material, 200); // r_a fed fully with silica each tick (4/tick * 50)
  assert.equal(r.silicon_wafer, 100);       // r_b throttled to 50%: 2/tick * 50
  assert.equal(r.silica, 50);               // the 20%-of-fresh(7)=1/tick stockpile floor accretes
  assert.equal(r.carbon_products, 200);     // r_c stalls (no polymers): carbon just accretes, 4/tick * 50
  assert.equal(r.copper, 800);              // 20 fresh - 4 drawn = 16/tick * 50
  assert.equal(r.carbon_fiber_weave, 0);    // never runs
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('no-op: determinism holds — same start, run twice to tick 50, identical hash', () => {
  const build = () => { let s = chainState(); for (let i = 0; i < 50; i += 1) s = tick(s); return s; };
  assert.equal(hashState(build()), hashState(build()));
});

// --- The anti-drift tripwire: the preview predicts exactly what the tick does ---

test('anti-drift: the report predicts the pool deltas a real tick then produces', () => {
  // A contended silica supply + a Gate-1 downstream cap, so the report is non-trivial.
  const s = sysState({
    ventures: [
      mine('cu', 'copper', 20), mine('si', 'silica', 10),
      mine('ag', 'silver', 20), mine('pd', 'palladium', 20),
      refinery('r_a', 'conductive_material', 10),
      refinery('r_b', 'silicon_wafer', 10),
    ],
    profile: { throttles: { r_a: 100, r_b: 50 } },
  });

  // Predict the per-good pool delta from the report alone (no tick yet).
  const report = resolveProduction(s.guilds[0], SYS);
  const predicted = {};
  for (const m of report.mines) predicted[m.good] = (predicted[m.good] || 0) + m.amount;
  for (const r of report.refineries) {
    if (r.batches <= 0) continue;
    const recipe = getRecipe(s.guilds[0].ventures.find((v) => v.id === r.ventureId).recipeId);
    for (const inp of recipe.inputs) predicted[inp.good] = (predicted[inp.good] || 0) - r.batches * inp.qty;
    predicted[recipe.output.good] = (predicted[recipe.output.good] || 0) + r.batches * recipe.output.qty;
  }

  // Now run the tick and compare the ACTUAL deltas.
  const after = tick(s);
  for (const good of Object.keys(predicted)) {
    assert.equal(held(after, good) - held(s, good), predicted[good], `delta for ${good} must match the report`);
  }
  // And the report the preview surfaces is the same object the tick resolved from,
  // plus the additive read-only `review` array (slice 2c-i) — the resolved fields
  // that predict the tick are byte-identical; only the extra telemetry field is new.
  const preview = previewProduction(s);
  const { review, ...resolved } = preview[0].systems[0];
  assert.deepEqual(resolved, report);
  assert.ok(Array.isArray(review), 'the preview adds a read-only review array');
});

// --- Purity: the selector reads state and changes nothing ----------------------

test('purity: previewProduction does not mutate state (hash identical before/after)', () => {
  const s = chainState();
  const before = hashState(s);
  const report = previewProduction(s);
  assert.equal(hashState(s), before, 'state must be byte-identical after a preview');
  assert.ok(Array.isArray(report) && report.length === 1, 'the preview still returns a real report');
});

// --- The report shape: fork split + per-line allocation ------------------------

test('report: a good carries fresh/demand/fork-split/supplied and each consuming line its alloc', () => {
  // fresh silica 10, two consumers demanding 10 each (demand 20); a 30% downstream
  // cap => supplied = floor(20 * 30/100) = 6, so 4 silica waterfalls into the
  // stockpile catch-all; FCFS (no throttles) feeds r_a fully (6), r_b starves.
  const s = sysState({
    ventures: [
      mine('cu', 'copper', 20), mine('si', 'silica', 10),
      mine('ag', 'silver', 20), mine('pd', 'palladium', 20),
      refinery('r_a', 'conductive_material', 10),
      refinery('r_b', 'silicon_wafer', 10),
    ],
    profile: { goods: { silica: { downstreamPct: 30 } } },
  });
  const report = resolveProduction(s.guilds[0], SYS);

  const silica = report.goods.silica;
  assert.equal(silica.fresh, 10);
  assert.equal(silica.demand, 20);        // Gate-2 naive full-tilt (10 + 10)
  assert.equal(silica.supplied, 6);       // floor(20 * 30/100)
  assert.equal(silica.fork.syndicate, 0); // inert (0 commitment today)
  assert.equal(silica.fork.downstream, 6);
  assert.equal(silica.fork.stockpile, 4); // catch-all: the 4 not fed downstream stays
  assert.equal(silica.fork.downstream, silica.supplied);

  // Per-line allocation for silica: FCFS gives r_a the 6, r_b 0.
  const silicaLines = report.lines.filter((l) => l.good === 'silica');
  const la = silicaLines.find((l) => l.ventureId === 'r_a');
  const lb = silicaLines.find((l) => l.ventureId === 'r_b');
  assert.equal(la.demand, 10);
  assert.equal(la.alloc, 6);
  assert.equal(lb.alloc, 0);

  // Refinery batches follow from the allocation (all other inputs plentiful).
  assert.equal(report.refineries.find((r) => r.ventureId === 'r_a').batches, 6);
  assert.equal(report.refineries.find((r) => r.ventureId === 'r_b').batches, 0);
});

// --- Null-system tolerance: a seatless mine resolves without crashing -----------

test('null-system: previewProduction includes a seatless mine (no systemId) without crashing', () => {
  // Exactly the supply.test.js seatless fixture shape: a mining venture with no
  // siteId and no systemId, whose fresh flow the tick deposits into an undefined-
  // keyed pool. The resolver and preview must tolerate it the same way.
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
