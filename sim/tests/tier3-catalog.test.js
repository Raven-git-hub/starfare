'use strict';

// tier3-catalog.test.js — the 2.1a Tier-3 module catalog, proven at the ENGINE level
// (docs/asset-recipes.md; roadmap item 2.1a). Three claims the slice must make good:
//
//   1. USABLE END TO END. A factory carrying a module `recipeId` is a `refining` venture
//      the tier-blind engine accepts and runs, minting the module into the guild's
//      system stockpile — raw → processed → module, all nine invariants green. No new
//      venture type, no tier check: the same batch/throttle path a raw->processed
//      refine uses (sim/tick.js, sim/production.js), reached only by naming a module
//      recipe. (The client's picker still greys Tier-3 out — that un-gating is the next
//      slice; here the proof is that the catalog WORKS through the engine.)
//
//   2. AT REST BY DEFAULT. On a galaxy where nothing manufactures a module, every module
//      is present but inert: capacity 0, so its price rests at base, its galactic-supply
//      row is 0, and nothing about the rest of the economy moves. This is the flip side
//      of the persist/commitment-scaffold strip-and-prove goldens (the byte-level proof).
//
//   3. DETERMINISTIC. The new goods iterate in the sorted order resources.js keeps, so a
//      scenario that manufactures a module runs byte-identical twice (invariant 9).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { guildTotals } = require('../stock.js');
const { computeGalacticSupply } = require('../supply.js');
const { hashState } = require('../serialize.js');
const {
  PRICED_GOODS, postedPrice, basePriceFor, BASE_PRICE, productionCapacity,
} = require('../prices.js');
const { TIER3_GOODS } = require('../resources.js');
const { getRecipe } = require('../recipes.js');
const { REFINERY_BASELINE, baselineOutputFor } = require('../baseline.js');
const { guildPoints, tierOf, TIER_WEIGHT } = require('../points.js');

const SYS = 'sysA';
const mine = (id, good, rate) => ({ id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate });
const factory = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });

// The full raw -> processed -> module chain for `power_cells` (3 battery_cells +
// 2 conductive_material + 1 composite_resin), each processed good fed by its own
// refinery drawing mined raws:
//   battery_cells      = lithium + polymers + nitrogen
//   conductive_material= copper + silica
//   composite_resin    = polymers + nitrogen
// The raws are seeded generously so the refineries never starve; the mines still run
// (a real raw source in the loop), and the module is minted from the processed goods the
// refineries make. Rates are chosen so processed output outpaces the factory's draw — no
// tuning claim, just "enough for the chain to flow" (§ these are test rates, not [FIRST-CUT]).
function powerCellChainState() {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: { [SYS]: { lithium: 100000, polymers: 100000, nitrogen: 100000, copper: 100000, silica: 100000 } },
      ventures: [
        mine('m_li', 'lithium', 50), mine('m_po', 'polymers', 50), mine('m_ni', 'nitrogen', 50),
        mine('m_cu', 'copper', 50), mine('m_si', 'silica', 50),
        factory('r_bat', 'battery_cells', 10),
        factory('r_con', 'conductive_material', 10),
        factory('r_com', 'composite_resin', 10),
        factory('f_pc', 'power_cells', 2), // the Tier-3 manufacture: processed -> module
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

test('a factory manufactures a module through the tier-blind engine — raw → processed → module, invariants green', () => {
  let s = powerCellChainState();

  // The factory is an ordinary `refining` venture; only its recipeId names a module. The
  // engine looks the recipe up like any other (no tier gate) — this is what "the catalog
  // is deployable through the ENGINE" means.
  assert.equal(getRecipe('power_cells').output.good, 'power_cells');

  let firstMintTick = null;
  for (let i = 1; i <= 15; i += 1) {
    s = tick(s);
    // All nine invariants green EVERY tick — never once a silent violation while the
    // brand-new module good flows through mint, stockpile and supply cache.
    assert.deepEqual(checkInvariants(s, s.tick), [], `invariants must stay green at tick ${s.tick}`);
    if (firstMintTick === null && guildTotals(s.guilds[0]).power_cells > 0) firstMintTick = s.tick;
  }

  const totals = guildTotals(s.guilds[0]);
  // The module was minted into the guild's (system) stockpile — the load-bearing claim.
  assert.ok(totals.power_cells > 0, 'the module was manufactured and banked in the stockpile');
  assert.ok(Number.isInteger(totals.power_cells), 'goods are integers (§15.2)');
  assert.ok(firstMintTick !== null && firstMintTick >= 2, 'the module is minted once its processed inputs have accrued');
  // The two lower tiers really did flow (the chain is genuine, not seeded modules): the
  // processed inputs were manufactured, and the raws were mined and drawn.
  assert.ok(totals.battery_cells > 0 && totals.conductive_material > 0 && totals.composite_resin > 0,
    'the Tier-2 processed inputs were produced (raw → processed leg)');
  // The galactic-supply cache — which now carries a row for every module — agrees with
  // the guild's holdings, so the new good is a first-class economy member.
  assert.equal(computeGalacticSupply(s).resources.power_cells, totals.power_cells,
    'the supply cache counts the minted module, exactly (invariants would already halt otherwise)');
});

test('at rest: with no module venture, every module sits at base price, zero stock, zero capacity', () => {
  // A galaxy that manufactures no module — one lonely mine. This is the "new vocabulary at
  // rest" the strip-and-prove goldens (persist/commitment-scaffold) pin byte-for-byte; here
  // it is asserted good-by-good so the intent is legible.
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [mine('m', 'titanium', 5)] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  for (let i = 0; i < 5; i += 1) s = tick(s);

  const capacity = productionCapacity(s);
  const supply = computeGalacticSupply(s).resources;
  for (const m of TIER3_GOODS) {
    assert.equal(capacity[m], 0, `${m} has zero production capacity (nobody makes it)`);
    assert.equal(postedPrice(s, m), BASE_PRICE, `${m} rests exactly at base — zero capacity rests priceTarget at base`);
    assert.equal(basePriceFor(m), BASE_PRICE, `${m} is a priced good with the uniform base`);
    assert.equal(supply[m], 0, `${m} holds nothing anywhere`);
    // The module's baseline resolves (it is quotable) even though nothing makes it — the
    // capacity is 0 only because no VENTURE makes it, not because it is unmakeable.
    assert.equal(baselineOutputFor({ recipeId: m }).units, REFINERY_BASELINE[m] * getRecipe(m).output.qty,
      `${m} has a resolvable droidless baseline`);
  }
});

test('GP scores a module venture at the ruled W_T3 = 300 — the halt is now a score (2.1a)', () => {
  // Before 2.1a un-deferred W_T3, guildPoints would THROW on a module-producing venture
  // (tierOf(module) was null → tierWeight halts). That halt had four reachable readers
  // (GP, issuance ∝ GP, the mean line ∝ GP, the tier-scaled signing bump) the moment the
  // client's Tier-3 grey-out stopped hiding it. It is now a real score.
  assert.equal(tierOf('power_cells'), 3, 'a module resolves to tier 3');
  assert.equal(TIER_WEIGHT[3], 300, 'tier 3 is the ruled 300');
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'f', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'power_cells', productionRate: 2 }],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  let gp;
  assert.doesNotThrow(() => { gp = guildPoints(s, s.guilds[0]); }, 'a module venture no longer halts guildPoints');
  // No claims (0 held systems), so GP is exactly the one module venture's weight.
  assert.equal(gp, 300, 'the module venture scores W_T3 = 300, not a halt and not a 0');
});

test('determinism (invariant 9): a module-manufacturing scenario runs byte-identical twice', () => {
  // The new goods iterate in the sorted order resources.js keeps (PRICED_GOODS is sorted),
  // so nothing about the run depends on object-key order. Two independent runs of the same
  // scenario must hash identically at every tick.
  assert.deepEqual([...PRICED_GOODS], [...PRICED_GOODS].sort(), 'priced goods iterate in sorted order');

  let a = powerCellChainState();
  let b = powerCellChainState();
  assert.equal(hashState(a), hashState(b), 'identical seeds hash identically at tick 0');
  for (let i = 1; i <= 12; i += 1) {
    a = tick(a);
    b = tick(b);
    assert.equal(hashState(a), hashState(b), `byte-identical at tick ${i}`);
  }
});
