'use strict';

// scenarios/zero-state.js -- the guild-less "zero-state": what a fresh server
// boots into and WAITS in until its owner founds the first guild (foundGuild,
// actions.js), at which point it begins to tick.
//
// It is a full galaxy MINUS players: the fuel reserve, the Syndicate and its
// ledger, an abstract-graph world, and the Syndicate's own claims (the Citadel
// and its waystations). No guilds. The economy engine (tick/intake/assert)
// reads NONE of the world/claims scaffolding -- it is carried inert so a booted
// galaxy is legibly a galaxy; the engine acts only on guilds, reserve, ledger.
// Real hex geography (coords, edges, per-leg risk) is Phase 4 behind the world
// boundary; here the world is bare named nodes.
//
// Every number here is sourced or an explicit, flagged placeholder -- never a
// silent invention (working practice #5):
//   - reserve 30            [SHEET]  fuel simulator target reserve / start stock
//   - ledger 0                       nothing paid out yet; the first foundGuild
//                                    debits it (conservation, invariant 2)
//   - 10 nodes (1 + 6 + 3)  [PROP]   docs/phase-1-tuning.md graph topology
//   - waystation placement  [OPEN]   PLACEHOLDER: one per contested-middle node.
//                                    The real count + placement rule is undecided
//                                    (roadmap decision list). Deliberately NOT
//                                    random -- a random layout would break
//                                    determinism (invariant 9). Fixed for now.

const { createState } = require('../state.js');

const SYNDICATE_OWNER = 'syndicate'; // sentinel owner for Syndicate assets (not a guild)

// The abstract Phase-1 graph: Citadel + 6 home slots + 3 contested middles = 10
// nodes [PROP]. Edges are intentionally omitted -- edge topology and the transit
// model are later territory/routes work, the engine does not read them yet, and
// inventing them now would be a silent number.
function buildNodes() {
  const nodes = [{ id: 'citadel', kind: 'citadel' }];
  for (let i = 1; i <= 6; i += 1) nodes.push({ id: `home_${i}`, kind: 'home' });
  for (let i = 1; i <= 3; i += 1) nodes.push({ id: `middle_${i}`, kind: 'contested' });
  return nodes;
}

// Syndicate claims: the Citadel, plus a waystation on each contested-middle node
// (PLACEHOLDER placement -- see header). Owner is the Syndicate sentinel,
// claimedAtTick 0 (genesis), uncontested. Row shape is the design.md §15.4
// Territory Map row minus the hex-only fields (coords/claimRadius/security) that
// belong to Phase 4.
function buildSyndicateClaims() {
  const claims = [
    { claimId: 'claim_citadel', ownerGuildId: SYNDICATE_OWNER, nodeId: 'citadel', kind: 'citadel', claimedAtTick: 0, contested: false },
  ];
  for (let i = 1; i <= 3; i += 1) {
    claims.push({
      claimId: `claim_waystation_${i}`,
      ownerGuildId: SYNDICATE_OWNER,
      nodeId: `middle_${i}`,
      kind: 'waystation',
      claimedAtTick: 0,
      contested: false,
    });
  }
  return claims;
}

// createZeroState() -- assemble the guild-less tick-0 galaxy. Deterministic:
// the same call always yields byte-identical state (serialize.hashState).
function createZeroState() {
  return createState({
    guilds: [], // the whole point: a galaxy with no players yet
    reserve: { reserveLevel: 30 }, // [SHEET]
    syndicate: { ledger: 0 },
    world: { nodes: buildNodes() },
    claims: buildSyndicateClaims(),
  });
}

module.exports = { createZeroState, SYNDICATE_OWNER };
