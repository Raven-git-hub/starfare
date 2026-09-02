'use strict';

// tools/scenarios/supply_relief.js — the "supply relief" scenario for the
// lockstep run-recorder (roadmap Phase 1 Stage 2, the licence-layer sequence's
// step (3)). Player tooling, NOT engine: it only assembles a createState
// scenario and wires the world + bot drivers. It changes no sim/ file.
//
// THE ARC this scenario is built to produce (visible in the JSONL trace):
//   - OPENING SQUEEZE. One guild on a starter system has a single committed
//     titanium mine, a plentiful carbon mine, and a titanium_alloy refinery.
//     The committed mine's titanium rate is sized DELIBERATELY BELOW what the
//     licence pace (Q/N) and the refinery's full demand (3 titanium/batch × r)
//     need together, so titanium is squeezed: the licence-first bot serves the
//     Syndicate on pace and the refinery runs starved (below its rated output).
//   - RELIEF. At a chosen mid-run tick T the world driver establishes a SECOND
//     titanium mine on another valid titanium node in the SAME system, so its
//     output pools with the first (ruling B1, §15.2 — resources are system-
//     scoped, one pool per system). The squeeze eases; the bot rebalances toward
//     the factory and the refinery's output rises.
//
// ── THE NUMBERS ARE SCENARIO / STRATEGY PARAMETERS, NOT ENGINE TUNING ──────────
// Every number below (R_t, R_c, r, R_t2, Q, N, K, T, the bot's reserve buffer)
// is the SCENARIO AUTHOR'S choice — the fed-in dials of a hand-played setup, the
// same status sim/demo.js's $120 / rate-5 numbers have. They are chosen ONLY to
// produce the intended squeeze→relief arc; they are NOT game-balance constants
// and do NOT belong in docs/phase-1-tuning.md. The one genuinely engine-owned
// number here — the window length N — is fed to the engine through the state's
// own `windowN` field (a scenario override, exactly as the engine intends), not
// invented in game logic. No engine constant is chosen anywhere in this file.
//
// Why these particular values (the squeeze inequality the arc needs):
//   titanium the licence pace + the refinery need together = Q/N + 3·r
//                                                          = 16/8 + 3·2 = 2 + 6 = 8
//   committed titanium mine rate R_t = 5  <  8   → SQUEEZED at the start.
//   licence pace alone Q/N = 2  ≤  R_t = 5        → the licence stays FEASIBLE
//                                                   (fresh always covers the pace).
//   after relief: R_t + R_t2 = 5 + 5 = 10  ≥  8   → the refinery runs full again,
//                                                   with a small titanium surplus
//                                                   the bot banks as reserve.

const { createState } = require('../../sim/state.js');
const { getStarterSystems, getTerranHomeworld } = require('../../sim/seed.js');
const { starterAssetSpecs } = require('../../sim/assets.js');
const { makeReliefWorld } = require('../world_relief.js');
const { makeLicenceBot } = require('../licence_bot.js');

// --- Where, in the real seed (DERIVED, not pinned) ----------------------------
// The first starter system and its Terran homeworld, resolved from the seed. By
// §2's Terran guarantee that homeworld always carries two titanium nodes (_n01/
// _n02), a carbon_products node (_n08 — guaranteed-spread position 8) and
// settlement slots (_s01) — everything this scenario needs, all in ONE system so
// the two titanium mines pool together. Deriving it (rather than pinning
// sys_0002/pl_00004) keeps the scenario valid across a seed regen.
const HOME_SYSTEM = getStarterSystems()[0].id;
const HOME_PLANET = getTerranHomeworld(HOME_SYSTEM);
const TITANIUM_NODE_1 = `${HOME_PLANET}_n01`; // the committed mine's node
const TITANIUM_NODE_2 = `${HOME_PLANET}_n02`; // the RELIEF mine's node (added at tick T)
const CARBON_NODE = `${HOME_PLANET}_n08`; // carbon_products — the refinery's second input
const REFINERY_SLOT = `${HOME_PLANET}_s01`; // a settlement slot for the titanium_alloy refinery

const GUILD_ID = 'weaver-guild';

// --- The scenario / strategy parameters (author's dials — see the header) ------
const PARAMS = Object.freeze({
  R_t: 5, // committed titanium mine rate (below the combined need → squeeze)
  R_c: 5, // carbon mine rate (plentiful — carbon is never the bottleneck)
  r: 2, // titanium_alloy refinery rate (batches/tick; each batch = 3 titanium + 1 carbon_products)
  R_t2: 5, // relief titanium mine rate (added at T → total fresh titanium 10)
  Q: 16, // per-window Syndicate commitment on the committed mine (paced Q/N = 2/tick)
  windowN: 8, // Syndicate accrual window length in ticks (fed to state.windowN)
  ticks: 24, // run length (3 full windows: boundaries at 8, 16, 24)
  reliefTick: 12, // T — the world driver establishes the second titanium mine here (mid window 2)
  reserveBuffer: 4, // BOT dial: the modest titanium reserve the bot banks from genuine surplus
});

// The starter pool's ids, by kind and 0-based position. The SPECS are re-minted
// inside makeState() so every run gets fresh objects (no state shared between two
// runs — invariant 9); these two read ids only, so both makeState and the relief
// mine below can name the same machines without spelling an id out anywhere.
const nthAssetId = (kind, n) => starterAssetSpecs(GUILD_ID).filter((a) => a.kind === kind)[n].id;
const minerId = (n) => nthAssetId('miner', n);
const factoryId = (n) => nthAssetId('factory', n);

// makeState() — a FRESH tick-0 state for one run. Pure and deterministic: the
// same call always assembles byte-identical state (no Date, no Math.random).
// Seeds the committed mine's syndicateCommitment via createVenture's own param
// (no action needed for setup), and N via the state's own windowN field.
function makeState() {
  const homePlanetId = HOME_PLANET; // the seed's authority for HOME_SYSTEM's homeworld
  // The guild's ground-asset inventory (design.md §4, 30-08-26). This scenario
  // assembles its guild DIRECTLY through createState rather than through the
  // foundGuild action, so it has to hand itself the same starter gift founding
  // would have granted — otherwise the relief mine's `establishVenture` at tick T
  // is refused by deploy gate 2 (it names a Miner this guild would not own). Taken from
  // sim/assets.js so the counts and the id scheme stay in one place; the three
  // ventures below then occupy one each, exactly as a real founding would.
  const assets = starterAssetSpecs(GUILD_ID);
  return createState({
    guilds: [{
      id: GUILD_ID,
      name: 'Weaver Guild',
      credits: 0, // no market/credits move in this slice — production only
      fuelHoard: 0,
      homeSystemId: HOME_SYSTEM,
      homePlanetId,
      assets,
      ventures: [
        // The committed titanium mine — its syndicateCommitment IS the per-window
        // target Q the resolver sums into the licence (§5 windowed accrual).
        {
          id: 'mine_ti_1', ownerGuildId: GUILD_ID, type: 'mining',
          siteId: TITANIUM_NODE_1, systemId: HOME_SYSTEM, assetId: minerId(0),
          resourceType: 'titanium', productionRate: PARAMS.R_t,
          syndicateCommitment: PARAMS.Q,
        },
        // The plentiful carbon mine — the refinery's other input, sized so carbon
        // is never the bottleneck (the titanium squeeze is the whole point).
        {
          id: 'mine_carbon', ownerGuildId: GUILD_ID, type: 'mining',
          siteId: CARBON_NODE, systemId: HOME_SYSTEM, assetId: minerId(1),
          resourceType: 'carbon_products', productionRate: PARAMS.R_c,
        },
        // The refinery: titanium_alloy = 3 titanium + 1 carbon_products → 1 alloy.
        {
          id: 'refinery_alloy', ownerGuildId: GUILD_ID, type: 'refining',
          siteId: REFINERY_SLOT, systemId: HOME_SYSTEM, assetId: factoryId(0),
          recipeId: 'titanium_alloy', productionRate: PARAMS.r,
        },
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: PARAMS.windowN, // the one engine-owned number, fed through the scenario override
    // The guild's home ownership claim (the source of truth the guild-home
    // invariant checks the denormalised home pointer against).
    claims: [{
      claimId: `claim_home_${GUILD_ID}`,
      ownerGuildId: GUILD_ID,
      landmarkId: HOME_SYSTEM,
      landmarkKind: 'system',
      claimedAtTick: 0,
      contested: false,
    }],
  });
}

// buildScenario() — the full spec the recorder consumes: how to seed state, the
// two drivers, and the run knobs. Assembled here so the numbers live in exactly
// one place and the recorder stays a generic, scenario-agnostic loop.
function buildScenario() {
  return {
    name: 'supply_relief',
    guildId: GUILD_ID,
    systemId: HOME_SYSTEM,
    ticks: PARAMS.ticks,
    makeState,
    // The world driver: the ONE scheduled perturbation this slice models — a
    // supply RELIEF event (a second titanium mine) at tick T.
    world: makeReliefWorld({
      atTick: PARAMS.reliefTick,
      guildId: GUILD_ID,
      ventureId: 'mine_ti_2',
      siteId: TITANIUM_NODE_2,
      // The deploy NAMES its machine (design.md §4, 31-08-26). The three ventures in
      // makeState() occupy miners 0 and 1 and factory 0, so the relief mine takes the
      // third Miner of the same starter pool — read from sim/assets.js's own id
      // scheme, never spelled out here.
      assetId: minerId(2),
      resourceType: 'titanium',
      productionRate: PARAMS.R_t2,
    }),
    // The bot driver: the licence-first reactive allocator, steering THIS guild.
    bot: makeLicenceBot({
      guildId: GUILD_ID,
      systemId: HOME_SYSTEM,
      committedGood: 'titanium',
      reserveBuffer: PARAMS.reserveBuffer,
    }),
  };
}

module.exports = { buildScenario, makeState, PARAMS, GUILD_ID, HOME_SYSTEM };
