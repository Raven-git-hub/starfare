'use strict';

// droid-noop-script.js — two droidless runs whose end-state hashes were RECORDED AT fb550f7 (main, before
// droid engine slice 2 existed) and are pinned in droid-entity.test.js. The droid entity is
// omit-when-empty (`guild.droids`, `guild.droidSerial`), so a galaxy that builds no droid must still
// serialize byte for byte as it did before the slice. If one of these hashes moves, something other than
// a droid build has changed the state's shape.
//
// Both runs exercise the code the slice touched, without building a droid:
//   - yardScript():     a dockyard builds a light transport, then a miner (the mintFinishedKind vehicle and
//                       ground-asset branches the droid branch sits beside), with every invariant checked on
//                       every tick by advance();
//   - foundingScript(): a human guild founded on the zero-state (its starter fleet + kit), ticked a while.

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { applyAction, validateAction, createCommissionBuildAction, createFoundGuildAction } = require('../actions.js');
const { ALL_BILLS } = require('../asset-recipes.js');
const { HOME_SYSTEM } = require('./home-anchor.js');
const { kitGalaxy, YARD } = require('./installation-kit-fixtures.js');

function run(s, n) {
  for (let i = 0; i < n; i += 1) s = advance(s, []).state;
  return s;
}

function mustApply(s, action) {
  const { valid, reason } = validateAction(s, action);
  if (!valid) throw new Error(`droid-noop-script: ${action.type} refused: ${reason}`);
  return applyAction(s, action);
}

function yardScript() {
  // Exactly both bills in the yard's pool, so each build starts the tick it reaches the head.
  const stock = {};
  for (const kind of ['lightTransport', 'miner']) {
    for (const [good, qty] of Object.entries(ALL_BILLS[kind])) stock[good] = (stock[good] || 0) + qty;
  }
  let s = kitGalaxy({ stock });
  s = mustApply(s, createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind: 'lightTransport' }));
  s = mustApply(s, createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind: 'miner' }));
  return run(s, 1200); // 360 + 720 build ticks, plus the two start ticks, plus slack
}

function foundingScript() {
  let s = createZeroState();
  s = mustApply(s, createFoundGuildAction({
    guildId: 'h1', credits: 1_000_000, homeSystemId: HOME_SYSTEM,
  }));
  return run(s, 200);
}

module.exports = { yardScript, foundingScript };
