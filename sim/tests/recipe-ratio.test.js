'use strict';

// The guard that was MISSING from the first rate-based build (design.md §5
// "Correction — the recipe ratio", and "The guard that was missing"). The old
// model accrued the OUTPUT fractionally but ROUNDED each INPUT to a whole unit
// per tick and refunded the surplus — so a 1:1 line ran ~1.5 titanium in : 1 alloy
// out, the recipe ratio quietly wrong. Per-good conservation could not catch it
// (each good balances on its own ledger); nothing compared input-drawn against
// output-minted. THIS is that comparison.
//
// It is deliberately MODEL-AGNOSTIC: it reads only stockpile totals, never a report
// field, so the SAME test runs red on the pre-fix branch and green after the fix.
// For a good g with recipe quantity q_g, the corrected model draws/mints
// `rate × q_g` on average, carrying the sub-unit remainder — so over a run the
// cross-good ratio holds to within one whole unit per good (exact on average,
// bounded transient). The pre-fix model diverges without bound (~0.33 units/tick).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { getStock } = require('../stock.js');

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

// Cumulative units DRAWN of an input = (mined over the run) − (left in the pool).
// Cumulative units MINTED of the output = what sits in the pool (nothing consumes it).
const drawn = (s, good, mineRate, ticks) => mineRate * ticks - held(s, good);

// --- the ratio guard on a 1:1 recipe (conductive_material = copper + silica) ----

test('recipe-ratio guard (1:1): drawn inputs match minted output within one unit (RED on 993dd2d)', () => {
  // A rate-1 conductive line at 67%: the exact case the old model broke. Over 100
  // ticks the corrected model draws ~0.67 copper AND ~0.67 silica per unit of
  // conductive_material (1:1). The old model drew a whole 1 copper/silica per tick
  // (~100) while minting ~67 conductive — a ~33-unit divergence that this asserts away.
  const TICKS = 100;
  let s = sysState({
    ventures: [mine('cu', 'copper', 2), mine('si', 'silica', 2), refinery('r', 'conductive_material', 1)],
    profile: { throttles: { r: 67 } },
  });
  for (let i = 0; i < TICKS; i += 1) s = tick(s);

  const made = held(s, 'conductive_material');
  const drawnCu = drawn(s, 'copper', 2, TICKS);
  const drawnSi = drawn(s, 'silica', 2, TICKS);
  assert.ok(made > 60, `the line really ran (~67 conductive over ${TICKS} ticks, got ${made})`);
  // recipe is 1:1, so each input drawn must equal the output minted to within one
  // whole unit (the outstanding carry). The pre-fix model fails this by ~33.
  assert.ok(Math.abs(drawnCu - made) < 1, `copper drawn (${drawnCu}) matches conductive made (${made}) 1:1`);
  assert.ok(Math.abs(drawnSi - made) < 1, `silica drawn (${drawnSi}) matches conductive made (${made}) 1:1`);
});

// --- the ratio guard on a 3:1 recipe (titanium_alloy = 3 titanium + 1 carbon) ---

test('recipe-ratio guard (3:1 / 1:1): drawn inputs match the recipe ratio against minted output', () => {
  // titanium_alloy = 3 titanium + 1 carbon -> 1 alloy. A rate-2 line at 67% over 100
  // ticks: titanium drawn must be ~3x the alloy made, carbon ~1x — each to within its
  // per-good carry bound (< q_g). The old model broke both ratios at once.
  const TICKS = 100;
  let s = sysState({
    ventures: [mine('t', 'titanium', 20), mine('c', 'carbon_products', 20), refinery('r', 'titanium_alloy', 2)],
    profile: { throttles: { r: 67 } },
  });
  for (let i = 0; i < TICKS; i += 1) s = tick(s);

  const made = held(s, 'titanium_alloy');
  const drawnTi = drawn(s, 'titanium', 20, TICKS);
  const drawnC = drawn(s, 'carbon_products', 20, TICKS);
  assert.ok(made > 100, `the line really ran (~134 alloy over ${TICKS} ticks, got ${made})`);
  // titanium 3:1 against alloy (bound < 3), carbon 1:1 (bound < 1).
  assert.ok(Math.abs(drawnTi - 3 * made) < 3, `titanium drawn (${drawnTi}) matches 3x alloy (${3 * made})`);
  assert.ok(Math.abs(drawnC - made) < 1, `carbon drawn (${drawnC}) matches alloy (${made}) 1:1`);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
