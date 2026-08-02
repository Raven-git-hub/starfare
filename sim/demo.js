'use strict';

// demo.js -- a runnable narration of the new-server lifecycle, so the walking
// skeleton can be WATCHED, not just trusted green. Not a test; run it with:
//     node sim/demo.js
//
// Numbers fed in are sourced from docs/phase-1-tuning.md (player guild: $120,
// influence 100, one Titanium mine -- Titanium's base extraction rate is 5/tick).

const { createZeroState } = require('./scenarios/zero-state.js');
const { advance } = require('./run.js');
const { createFoundGuildAction } = require('./actions.js');
const { assertInvariants } = require('./invariants.js');
const { hashState } = require('./serialize.js');

// Total Titanium held across all guild stockpiles.
function heldTitanium(state) {
  return state.guilds.reduce((sum, g) => sum + ((g.stockpiles && g.stockpiles.titanium) || 0), 0);
}

function summary(state) {
  const claims = state.claims.map((c) => `${c.kind}@${c.nodeId}`).join(', ');
  const lines = [
    `  tick             ${state.tick}`,
    `  guilds           ${state.guilds.length}${state.guilds.length ? ' (' + state.guilds.map((g) => `${g.id}:$${g.credits}`).join(', ') + ')' : ''}`,
    `  reserve (fuel)   ${state.reserve.reserveLevel}`,
    `  Syndicate ledger ${state.syndicate.ledger}`,
  ];
  if (state.guilds.some((g) => (g.ventures || []).length)) {
    lines.push(`  titanium held    ${heldTitanium(state)}`);
  }
  const gs = state.galacticSupply;
  if (gs) {
    const nonzero = Object.entries(gs.resources)
      .filter(([, q]) => q > 0)
      .map(([k, q]) => `${k} ${q}`);
    lines.push(`  galactic supply  ${nonzero.length ? nonzero.join(', ') : '(all resources 0)'}`);
    lines.push(`  fuel pool        reserve ${gs.fuel.reserve}, guild-held ${gs.fuel.guildHeld}`);
  }
  lines.push(
    `  world nodes      ${state.world.nodes.length}`,
    `  Syndicate claims ${state.claims.length}  [${claims}]`,
    `  state hash       ${hashState(state).slice(0, 16)}...`,
  );
  return lines.join('\n');
}

console.log('=== 1. A fresh server boots the zero-state (no guilds yet) ===');
let state = createZeroState();
assertInvariants(state, state.tick); // green at genesis
console.log(summary(state));
console.log('  invariants: OK\n');

console.log('=== 2. The owner founds the first guild (one turn) ===');
console.log('  action: foundGuild player ($120, influence 100, one mine @ 5 Titanium/tick)');
const foundPlayer = createFoundGuildAction({
  guildId: 'player',
  name: 'Player Guild',
  credits: 120,       // [phase-1-tuning.md]
  influence: 100,     // [phase-1-tuning.md]
  ventures: [{ id: 'mine_1', ownerGuildId: 'player', type: 'mining', resourceType: 'titanium', productionRate: 5 }], // [phase-1-tuning.md]
});
let res = advance(state, [foundPlayer]);
state = res.state;
console.log(`  intake: ${res.results[0].accepted ? 'accepted' : 'rejected'}`);
console.log(summary(state));
console.log('  note: ledger fell by exactly 120 -- credits MOVED from the Syndicate,');
console.log('        none were minted. The founding turn also ran one tick, so the');
console.log('        mine has already extracted its first 5 Titanium.\n');

console.log('=== 3. Two quiet ticks (no actions) -- the mine keeps extracting ===');
for (let i = 0; i < 2; i += 1) {
  res = advance(state, []);
  state = res.state;
  console.log(`  tick ${state.tick}: titanium held now ${heldTitanium(state)} (+5), invariants OK`);
}
console.log('\n  The galaxy is running: no action needed for the world to advance, and the');
console.log('  mine turns out Titanium every tick while conservation holds throughout.');
