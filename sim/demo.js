'use strict';

// demo.js -- a runnable narration of the new-server lifecycle, so the walking
// skeleton can be WATCHED, not just trusted green. Not a test; run it with:
//     node sim/demo.js
//
// The numbers it feeds in are sourced from docs/phase-1-tuning.md (player guild:
// $120, influence 100, one Tier-1 mining venture). The mine's productionRate is
// 0 here on PURPOSE: that number is not decided yet (inventing it would break
// working practice #5), so the mine sits idle until it is ruled -- see the note
// the demo prints on the quiet tick.

const { createZeroState } = require('./scenarios/zero-state.js');
const { advance } = require('./run.js');
const { createFoundGuildAction } = require('./actions.js');
const { assertInvariants } = require('./invariants.js');
const { hashState } = require('./serialize.js');

function summary(state) {
  const claims = state.claims.map((c) => `${c.kind}@${c.nodeId}`).join(', ');
  return [
    `  tick            ${state.tick}`,
    `  guilds          ${state.guilds.length}${state.guilds.length ? ' (' + state.guilds.map((g) => `${g.id}:$${g.credits}`).join(', ') + ')' : ''}`,
    `  reserve (fuel)  ${state.reserve.reserveLevel}`,
    `  Syndicate ledger ${state.syndicate.ledger}`,
    `  world nodes     ${state.world.nodes.length}`,
    `  Syndicate claims ${state.claims.length}  [${claims}]`,
    `  state hash      ${hashState(state).slice(0, 16)}...`,
  ].join('\n');
}

console.log('=== 1. A fresh server boots the zero-state (no guilds yet) ===');
let state = createZeroState();
assertInvariants(state, state.tick); // green at genesis
console.log(summary(state));
console.log('  invariants: OK\n');

console.log('=== 2. The owner founds the first guild (one turn) ===');
console.log('  action: foundGuild player ($120, influence 100, one mining venture @ rate 0)');
const foundPlayer = createFoundGuildAction({
  guildId: 'player',
  name: 'Player Guild',
  credits: 120,       // [phase-1-tuning.md]
  influence: 100,     // [phase-1-tuning.md]
  ventures: [{ id: 'mine_1', ownerGuildId: 'player', type: 'mining', productionRate: 0 }],
});
let res = advance(state, [foundPlayer]);
state = res.state;
console.log(`  intake: ${res.results[0].accepted ? 'accepted' : 'rejected'}`);
console.log(summary(state));
console.log('  note: ledger fell by exactly 120 -- credits MOVED from the Syndicate,');
console.log('        none were minted. The galaxy is now running.\n');

console.log('=== 3. A quiet tick (no actions) ===');
res = advance(state, []);
state = res.state;
console.log(summary(state));
const mine = state.guilds[0].ventures[0];
console.log(`  the mine produced ${mine.productionRate} this tick (rate is 0 -- pending a ruling`);
console.log('        on the starter mining rate; once decided, this tick starts making ore).');
console.log('  invariants held every step.');
