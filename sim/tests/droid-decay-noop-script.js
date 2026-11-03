'use strict';

// droid-decay-noop-script.js — a run whose end-state hash was RECORDED AT 8ffbd21 (main, before droid engine
// slice 5 — decay and the droid_components upkeep — existed) and is pinned in droid-decay.test.js. With no
// DEPLOYED droid, nothing wears and nothing is maintained, so the slice must not move a byte.
//
// It is built to tempt every new code path and give each one nothing to do:
//   - two IDLE droids (one per source) — idle droids do not wear and are never maintained;
//   - a pile of droid_components in their system — upkeep must not touch it;
//   - the run CROSSES A WEEK BOUNDARY (it starts a few ticks before tick 10,080), where upkeep would draw;
//   - a mine and a timed factory keep production running on every tick.
// A second guild with no droid at all runs beside it. Every invariant is checked on every tick by advance().
//
// Uses only engine API that existed at 8ffbd21, so the same file ran there to record the hash.

const { createState } = require('../state.js');
const { advance } = require('../run.js');

const SYS = 'sysA';
const SYS_B = 'sysB';

function droidlessDecayScript(tickCount = 40) {
  let s = createState({
    guilds: [
      {
        id: 'g1', credits: 50_000, fuelHoard: 0,
        stockpiles: { [SYS]: { droid_components: 30, carbon_products: 500 } },
        ventures: [
          { id: 'mine_ti', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 5 },
        ],
        droids: [
          { id: 'asset_g1_droid_01', systemId: SYS, source: 'guild', condition: 1 },
          { id: 'asset_g1_droid_02', systemId: SYS, source: 'syndicate', condition: 0.75 },
        ],
        droidSerial: 2,
      },
      {
        id: 'g2', credits: 10_000, fuelHoard: 0,
        stockpiles: { [SYS_B]: { droid_components: 5 } },
        ventures: [
          { id: 'mine_cu', ownerGuildId: 'g2', type: 'mining', systemId: SYS_B, resourceType: 'copper', productionRate: 4 },
        ],
      },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  // Start just short of the first week boundary (tick 10,080), so the run passes over it.
  s.tick = 10_060;
  for (let i = 0; i < tickCount; i += 1) s = advance(s).state;
  return s;
}

module.exports = { droidlessDecayScript, SYS };
