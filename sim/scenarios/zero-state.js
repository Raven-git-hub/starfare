'use strict';

// scenarios/zero-state.js -- the guild-less "zero-state": what a fresh server
// boots into and WAITS in until its owner founds the first guild (foundGuild,
// actions.js), at which point it begins to tick.
//
// It is a full galaxy MINUS players: the fuel reserve, the Syndicate and its
// ledger, and the Syndicate's own claims -- the Citadel and its waystations.
// No guilds. The economy engine (tick/intake/assert) reads none of the world
// reference; claims now carry real weight (they reference the seed and are
// checked by the claim-integrity invariant), but the tick loop still acts only
// on guilds, reserve, and ledger.
//
// As of 03-08-26 the world is wired to the real seed (design.md §15.3): rather
// than an invented 10-node abstract graph, the live layer references the seed's
// actual landmarks -- the Citadel (galactic origin) and the 9 Syndicate
// outposts the generator places (the "waystations"). The old placeholder
// `home_i`/`middle_i` nodes are retired; guild homes are chosen from the seed's
// starter-eligible systems at founding time (foundGuild), not pre-authored here.
//
// Every number here is sourced or an explicit, flagged placeholder -- never a
// silent invention (working practice #5):
//   - reserve 30            [SHEET]  fuel simulator target reserve / start stock
//   - ledger 0                       nothing paid out yet; the first foundGuild
//                                    debits it (conservation, invariant 2)
//   - Citadel + 9 outposts           taken from the seed, not invented -- this
//                                    resolves the old "waystation count/placement"
//                                    open question (it is whatever the generator
//                                    placed: 9). Deterministic by construction.

const { createState } = require('../state.js');
const { getCitadel, getOutposts, getSeedNumber } = require('../seed.js');

const SYNDICATE_OWNER = 'syndicate'; // sentinel owner for Syndicate assets (not a guild)

// Syndicate claims at genesis: the Citadel, plus one waystation claim on each of
// the seed's outposts. Every claim references a real seed landmark by id and
// declares its kind, so the claim-integrity invariant (invariants.js) can verify
// it resolves. Row shape is the design.md §15.4 Territory Map row minus the
// hex-only fields (coords/claimRadius/security) that belong to Phase 4.
function buildSyndicateClaims() {
  const citadel = getCitadel();
  const claims = [
    {
      claimId: 'claim_citadel',
      ownerGuildId: SYNDICATE_OWNER,
      landmarkId: citadel.id, // 'citadel'
      landmarkKind: 'citadel',
      claimedAtTick: 0,
      contested: false,
    },
  ];
  for (const out of getOutposts()) {
    claims.push({
      claimId: `claim_waystation_${out.id}`,
      ownerGuildId: SYNDICATE_OWNER,
      landmarkId: out.id,
      landmarkKind: 'outpost',
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
    world: { seed: getSeedNumber() }, // the galaxy IS this seed (referenced, not copied)
    claims: buildSyndicateClaims(),
  });
}

module.exports = { createZeroState, SYNDICATE_OWNER };
