'use strict';

// homeworld-floor.test.js — THE HOMEWORLD PRODUCTION FLOOR (design.md §2 "Resource Yield
// Tiers & the Homeworld Production Floor", ruled 24-09-26). A design invariant, enforced
// here mechanically so a later recipe or yield change that breaks it fails the suite
// instead of shipping.
//
// The floor, in words: on any Terran homeworld, a new guild mines each of the 12
// GUARANTEED resource nodes, licenses every mine at a 75% commitment, and runs one
// factory on each of the six Tier-2 recipes whose inputs are all homeworld-guaranteed.
// The UNCOMMITTED 25% of those mines' baseline output must feed all six factories at
// their full droidless baseline. For every raw good g:
//
//   Σ over the six recipes r ( REFINERY_BASELINE[r] × input qty of g in r )
//       ≤  0.25 × MINE_BASELINE[g] × (guaranteed Terran nodes of g)
//
// Everything is read LIVE — the seed, the recipe catalog, both baseline tables — so the
// test holds or fails on the data as it stands, with no copied number to go stale. The
// only literals are design.md §2's own definitions: the 12-node spread, the six recipe
// names and the 25% uncommitted share. Headroom is deliberately NOT pinned: the ruling
// is the inequality, and re-tuning a yield inside it must stay free.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The committed reference seed (seed 7331) — the same file sim/seed.js indexes by
// default. Read raw here because the question is about the ARCHETYPE across every
// Terran planet in the galaxy, not about any one system.
const seed = require('../../data/seed.json');
const { listRecipes } = require('../recipes.js');
const { MINE_BASELINE, REFINERY_BASELINE } = require('../baseline.js');

// design.md §2's guaranteed Terran spread: titanium ×2 and one each of the other ten.
const DESIGN_TERRAN_SPREAD = {
  titanium: 2, copper: 1, lead: 1, silica: 1, lithium: 1, polymers: 1,
  carbon_products: 1, nitrogen: 1, gold: 1, silver: 1, tungsten: 1,
};

// design.md §2's six homeworld-complete Tier-2 recipes.
const DESIGN_HOME_RECIPES = [
  'battery_cells', 'conductive_material', 'carbon_fiber_weave',
  'nanotube_cable', 'titanium_alloy', 'composite_resin',
];

// The uncommitted share, 25% (design.md §2: every mine licensed at a 75% commitment),
// kept as a fraction so the inequality is checked in whole numbers, never floats:
// demand ≤ supply × 1/4  ⇔  demand × 4 ≤ supply.
const UNCOMMITTED_NUM = 1;
const UNCOMMITTED_DEN = 4;

// Every Terran planet in the seed.
function terranPlanets() {
  const out = [];
  for (const sys of seed.systems) {
    for (const planet of sys.planets || []) {
      if (planet.archetype === 'terran') out.push(planet);
    }
  }
  return out;
}

// The GUARANTEED spread: for each resource, the fewest nodes of it on ANY Terran planet.
// A resource some Terran world lacks has a minimum of 0 and is left out — a guarantee is
// what every homeworld has, not what a lucky one has (the 3 random extras never count).
function guaranteedTerranSpread() {
  const planets = terranPlanets();
  const counts = planets.map((p) => {
    const c = {};
    for (const n of p.resourceNodes || []) c[n.resourceType] = (c[n.resourceType] || 0) + 1;
    return c;
  });
  const goods = new Set(counts.flatMap((c) => Object.keys(c)));
  const spread = {};
  for (const g of goods) {
    const min = Math.min(...counts.map((c) => c[g] || 0));
    if (min > 0) spread[g] = min;
  }
  return spread;
}

// Recipes whose EVERY input is in the guaranteed spread. Deliberately scanned over the
// WHOLE catalog, not only Tier 2: if any future recipe (at any tier) becomes makeable from
// homeworld raws alone, the floor's definition has to be revisited, so it must fail here.
function homeworldCompleteRecipes(spread) {
  return listRecipes()
    .filter((r) => r.inputs.every((i) => spread[i.good] > 0))
    .map((r) => r.id);
}

test('the guaranteed Terran spread in the seed is design.md §2\'s 12 nodes', () => {
  const planets = terranPlanets();
  assert.ok(planets.length > 0, 'the reference seed has Terran planets to read');
  const spread = guaranteedTerranSpread();
  assert.deepEqual(spread, DESIGN_TERRAN_SPREAD,
    `the seed's guaranteed Terran spread ${JSON.stringify(spread)} is not design.md §2's list`);
  const nodes = Object.values(spread).reduce((a, b) => a + b, 0);
  assert.equal(nodes, 12, 'the 12 guaranteed nodes');
});

test('the homeworld-complete recipes are exactly design.md §2\'s six', () => {
  const found = homeworldCompleteRecipes(guaranteedTerranSpread());
  assert.deepEqual([...found].sort(), [...DESIGN_HOME_RECIPES].sort(),
    `recipes makeable from the guaranteed spread alone: ${JSON.stringify(found)}. A change here means the floor's definition must be revisited (design.md §2) before this test is touched`);
});

test('THE FLOOR: the uncommitted 25% of the guaranteed mines feeds all six factories at full baseline', () => {
  const spread = guaranteedTerranSpread();
  const recipes = listRecipes().filter((r) => DESIGN_HOME_RECIPES.includes(r.id));
  assert.equal(recipes.length, DESIGN_HOME_RECIPES.length, 'all six recipes exist in the catalog');

  // Demand per raw good: each factory at its full droidless baseline, in batches/tick,
  // times the units of that good one batch consumes.
  const demand = {};
  for (const r of recipes) {
    for (const input of r.inputs) {
      demand[input.good] = (demand[input.good] || 0) + REFINERY_BASELINE[r.id] * input.qty;
    }
  }

  // Supply per raw good: the uncommitted share of every guaranteed node's baseline yield.
  // Checked for EVERY input good, and all failures are reported together with their
  // values, so a broken floor names each good that breaks it.
  const failures = [];
  for (const [good, need] of Object.entries(demand)) {
    const nodes = spread[good] || 0;
    const mined = MINE_BASELINE[good] * nodes; // units/tick from the guaranteed mines
    if (need * UNCOMMITTED_DEN > mined * UNCOMMITTED_NUM) {
      failures.push(`${good}: six factories draw ${need}/tick, but 25% of ${nodes} node(s) × MINE_BASELINE ${MINE_BASELINE[good]} is only ${mined * UNCOMMITTED_NUM / UNCOMMITTED_DEN}/tick`);
    }
  }
  assert.deepEqual(failures, [], `the homeworld production floor is broken (design.md §2):\n  ${failures.join('\n  ')}`);
});
