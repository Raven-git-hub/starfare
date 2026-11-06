'use strict';

// droid-autoreplace-noop-script.js — a run whose end-state hash was RECORDED AT ef14e01 (main, before droid
// client slice 2 — auto-replace — existed) and is pinned in droid-autoreplace.test.js. With `autoReplace` OFF on
// every venture, a droid that wears out leaves its slot empty exactly as before, so the slice must not move a byte.
//
// It is built to tempt the new refill path and give it nothing to do:
//   - deployed droids of BOTH sources, near the end of their life, so several DIE during the run;
//   - idle spares of BOTH sources standing in the same system — exactly what a refill would take;
//   - one venture LICENSED (so a Syndicate spare would be gate-legal there) and one unlicensed;
//   - the run CROSSES A WEEK BOUNDARY (it starts 30 ticks before tick 10,080), so upkeep runs too.
// A second guild with no droid at all runs beside it. Every invariant is checked on every tick by advance().
//
// Uses only engine API that existed at ef14e01, so the same file ran there to record the hash.

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const WEEK = 10_080;
const id = (n) => `asset_g1_droid_${String(n).padStart(2, '0')}`;
const deployed = (n, source, ventureId, condition) => ({
  id: id(n), systemId: SYS, source, condition, assignedToVentureId: ventureId, deployedAtTick: 0, updatedAtTick: 0,
});
const idle = (n, source, condition = 1) => ({ id: id(n), systemId: SYS, source, condition, updatedAtTick: 0 });

function autoReplaceOffScript(tickCount = 60) {
  let s = createState({
    guilds: [
      {
        id: 'g1', credits: 100_000, fuelHoard: 0,
        stockpiles: { [SYS]: { droid_components: 3 } },
        ventures: [
          { id: 'm_lic', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 5 },
          { id: 'm_free', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'copper', productionRate: 4 },
        ],
        droids: [
          deployed(1, 'syndicate', 'm_lic', 0.0005),
          deployed(2, 'guild', 'm_lic', 0.001),
          deployed(3, 'guild', 'm_free', 0.0008),
          deployed(4, 'guild', 'm_free', 1),
          idle(5, 'guild', 0.5),
          idle(6, 'syndicate'),
          idle(7, 'guild'),
        ],
        droidSerial: 7,
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
  s.tick = WEEK - 30;
  const out = intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm_lic', committedOutputPct: 0.5, windowDays: 7 })]);
  if (!out.results[0].accepted) throw new Error(`autoReplaceOffScript: licence refused: ${out.results[0].reason}`);
  s = out.state;
  for (let i = 0; i < tickCount; i += 1) s = advance(s).state;
  return s;
}

module.exports = { autoReplaceOffScript, SYS };
