'use strict';

// droid-boost-noop-script.js — a run whose end-state hash was RECORDED AT a8ff924 (main, before droid engine
// slice 4 — the production boost — existed) and is pinned in droid-boost.test.js. With no WORKING droid on any
// producing venture the boost is exactly 0 everywhere, so the slice must not move a byte.
//
// It walks every production path the boost now sits in, in one system:
//   - a MINE (titanium) — the new extraction carry;
//   - a CONTINUOUS refinery (titanium_alloy, fed by that mine) — the scaled throttle cap and input ask;
//   - a TIMED Tier-3 factory (fuel_tank) — the new work carry;
//   - a committed mine (licensed, 50%) and a committed timed factory (x units) — the commitment, the
//     Syndicate delivery, the progress payment and the fee;
// and the guild holds two IDLE droids (handed in through createState, so no mint stamps them) — an idle droid
// staffs nothing and must boost nothing. Every invariant is checked on every tick by advance().
//
// Uses only engine API that existed at a8ff924, so the same file ran there to record the hash.

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');
const { getRecipe } = require('../recipes.js');

const SYS = 'sysA';

function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}

function boostlessScript(tickCount = 400) {
  const stock = { carbon_products: 2000, ...inputSets('fuel_tank', 60) };
  let s = createState({
    guilds: [{
      id: 'g1', credits: 1_000_000, fuelHoard: 0, stockpiles: { [SYS]: stock },
      ventures: [
        { id: 'mine_ti', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 5 },
        { id: 'mine_cu', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'copper', productionRate: 4 },
        { id: 'ref_alloy', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'titanium_alloy', productionRate: 1 },
        { id: 'fac_tank', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'fuel_tank', productionRate: 5 },
      ],
      droids: [
        { id: 'asset_g1_droid_01', systemId: SYS, source: 'guild', condition: 1 },
        { id: 'asset_g1_droid_02', systemId: SYS, source: 'syndicate', condition: 1 },
      ],
      droidSerial: 2,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const out = intake(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'mine_cu', committedOutputPct: 0.5, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'fac_tank', committedUnits: 300 }),
  ]);
  for (const r of out.results) {
    if (!r.accepted) throw new Error(`droid-boost-noop-script: licence refused: ${r.reason}`);
  }
  s = out.state;
  for (let i = 0; i < tickCount; i += 1) s = advance(s).state;
  return s;
}

module.exports = { boostlessScript, SYS };
