'use strict';

// tools/scenarios/economy_meanline.js — the four-guild MEAN-LINE scenario for the economy
// recorder. Player tooling, NOT engine: it only assembles a `createState` scenario and
// wires the drivers. It changes no `sim/` file and chooses no engine constant.
//
// THE ARC this scenario is built to produce (visible in the JSONL trace and the table):
//
//   - FOUR GUILDS SPANNING THE MODIFIER RANGE, so the mean line has a spread to be a
//     spread of. Forge sits well above its line, Meridian almost exactly on it, Reach well
//     below, and Spark holds nothing at all.
//   - ONE GUILD EXPANDS MID-RUN. At tick T the world driver gives Reach a seventh mine.
//     Its Points rise at once while the reputation to pay for them does not, so its
//     modifier falls further — and its DRAW FALLS WITH IT. Expanding makes it draw LESS.
//   - THE POOL BLEEDS, THEN RATIONS. Σdesired is above the fixed influx, so every cycle
//     takes out more than it puts back. The opening cycles are paid in full; once the pool
//     can no longer cover the galaxy's draw, `rationGrants` clips everyone proportionally
//     and the pool sits at exactly 0 from there on. That crossing is the whole point: it is
//     the fixed-influx-vs-variable-draw drift that slice 5b's price controller exists to
//     correct, made watchable rather than argued about.
//
// ── EVERY NUMBER HERE IS A `[FIXTURE]`, NOT A GAME CONSTANT ────────────────────────────
// The guild shapes, the seeded reputations, the seeded pool and the run length are the
// SCENARIO AUTHOR'S dials — the same status supply_relief.js's R_t/Q/N have, and the same
// status sim/demo.js's $120 has. They are chosen ONLY to make the arc above happen, they
// are NOT game balance, and they do NOT belong in docs/phase-1-tuning.md. Each is tagged
// with what it is chosen to exercise.
//
// NO ENGINE CONSTANT IS CHANGED OR CHOSEN ANYWHERE IN THIS FILE. In particular
// `DEUTERIUM_INFLUX_PER_CYCLE`, `BASE_GRANT_PER_GP` and `MEANLINE_K` are read from the
// engine (below) purely to DOCUMENT the arithmetic in comments and to let the fixtures be
// stated in terms of it; the scenario tunes only its own seeded reserve, its guild shapes
// and its tick count. The one genuinely engine-owned number it sets is the window length
// `N`, fed through the state's own `windowN` override exactly as the engine intends.

const { createState } = require('../../sim/state.js');
const { getStarterSystems } = require('../../sim/seed.js');
const { starterAssetSpecs } = require('../../sim/assets.js');
const { makeReliefWorld } = require('../world_relief.js');
const { makeLicenceBot } = require('../licence_bot.js');

// --- Where, in the real seed (grounded, not invented) -------------------------
// Territory has to reference landmarks that really exist: `checkClaimIntegrity` asserts
// every claim resolves to a real seed landmark, so a scenario cannot invent systems. These
// are taken from the seed's own starter list, in its own order, and dealt out one guild at
// a time so no two guilds claim the same system.
const STARTER_SYSTEMS = getStarterSystems().map((s) => (typeof s === 'string' ? s : s.id));

// sys_0002 (FEN-6425) is the one system this scenario needs a real NODE in: the mid-run
// expansion is a real `establishVenture`, which must name a real, unoccupied resource node
// whose good matches. pl_00004_n01 is a titanium node there (the same one supply_relief
// seats its committed mine on). Reach is dealt this system first so it holds the ground it
// expands onto — deploy is gated to systems the guild holds (design.md §4, gate 3).
const EXPANSION_SYSTEM = 'sys_0002';
const EXPANSION_NODE = 'pl_00004_n01';

// --- The scenario dials (author's choices — see the header) --------------------
const FIXTURES = Object.freeze({
  // [FIXTURE] The window length. Short, so the run crosses many cycle boundaries in a
  // readable number of ticks — issuance only happens at a boundary, so a long window would
  // mean a trace that is almost all quiet ticks.
  windowN: 4,

  // [FIXTURE] Run length: 11 cycle boundaries at N=4. Chosen so the rationing crossing
  // (cycle 8, below) lands with a clear un-rationed run before it and a clear rationed tail
  // after it, rather than at either end where it could be missed.
  ticks: 44,

  // [FIXTURE] The reputation each seeded venture carries at tick 0. This is where a venture
  // that has always met its commitments PARKS — the §2.3 gain taper shrinks its gains to
  // nothing just under the +1500 soft cap — so seeding it here means every guild starts
  // with a settled, non-trivial reputation instead of climbing for forty ticks first. It
  // also makes reputation STABLE across the run, which is what leaves the pool and the
  // rationing as the only things moving in the trace.
  ventureRP: 1497,

  // [FIXTURE] The Syndicate pool at tick 0. Sized (with the shapes below) so roughly seven
  // cycles are paid in full before the pool can no longer cover the draw. Scenario-local:
  // it does NOT touch `POOL_SEED`, the galaxy-creation constant the zero-state uses.
  seededPool: 1400,

  // [FIXTURE] The tick the world driver gives Reach its seventh mine — early, so most of
  // the run is spent on the post-expansion draw and the fall in Reach's own grant is
  // visible for many cycles rather than one.
  //
  // ⚠ AND DELIBERATELY NOT A CYCLE BOUNDARY (10 is not a multiple of windowN 4). `advance`
  // applies intake before the tick's steps, so an action landing on a boundary would
  // already be in force when issuance reads the state, while the recorder's PRE snapshot
  // was taken before it — making the trace's `gp` column one action stale against the grant
  // printed beside it. Keeping the expansion off a boundary means the two can never
  // disagree here. A test pins this so the tick cannot drift onto one.
  expansionTick: 10,

  // [FIXTURE] Every mine's output rate, and the per-window commitment on the one committed
  // mine each producing guild carries. Production is not this scenario's subject — it
  // exists so the guilds are real economic actors with something for a bot to steer, and so
  // the committed good has a window the licence bot can sense. Sized so the paced target
  // (Q/N = 2/tick) sits comfortably below the mine's rate and is always feasible.
  mineRate: 5,
  commitment: 8,

  // [FIXTURE] The bot's reserve buffer — how much of a genuine surplus it banks rather than
  // sending. A dial of the bot's strategy, not of the economy.
  reserveBuffer: 2,
});

// --- The four guilds -----------------------------------------------------------
//
// The shapes are chosen against the engine's own arithmetic, stated here so the intent is
// checkable rather than magic. With `MEANLINE_K` = 150 and GP weights 12 (system) / 6
// (Tier-1 venture), and each venture parked at `ventureRP`:
//
//   guild     systems  mines   GP   expected     RP   ratio   modifier   desired
//   Forge        1       8      60     9000    11976   1.33     ~1.50       449
//   Meridian     2       6      60     9000     8982   1.00     ~1.00       299
//   Reach        4       6      84    12600     8982   0.71     ~0.57       239
//   Spark        0       0       0        0        0    n/a       1.00         0
//                                                              Σdesired =   987
//
// Σdesired (987) is ABOVE the engine's fixed influx (800), which is what makes the pool
// bleed and the crossing happen at all. Forge and Meridian are deliberately the SAME size
// (GP 60) with different footprints — that is density-beats-sprawl as one comparison: the
// dense guild draws half again what the spread one does, for identical Points.
const GUILDS = Object.freeze([
  // [FIXTURE] DENSE — everything on one system, so its reputation is spread over few
  // Points. Sits far above its line; near the issuance CEILING.
  { id: 'forge-guild', name: 'Forge Guild', systems: 1, mines: 8 },
  // [FIXTURE] PAR — sized so its reputation lands almost exactly on `MEANLINE_K × GP`.
  // The reference row: whatever else the trace shows, this one should read ~1.00×.
  { id: 'meridian-guild', name: 'Meridian Guild', systems: 2, mines: 6 },
  // [FIXTURE] SPRAWL — the SAME six ventures as Meridian over twice the territory, so it
  // holds more and contributes the same. Sits well below its line. This is the guild the
  // world driver expands mid-run.
  { id: 'reach-guild', name: 'Reach Guild', systems: 4, mines: 6 },
  // [FIXTURE] EMPTY — no territory, no ventures, nothing. It exists to prove the
  // empty-guild guard: GP 0 → expected 0 → the modifier returns exactly 1.0 without
  // dividing by zero, and its desired grant is 0, so `rationGrants` skips it even in a
  // rationed cycle. See the note on Spark below for why it is present from tick 0 rather
  // than founded mid-run.
  { id: 'spark-guild', name: 'Spark Guild', systems: 0, mines: 0 },
]);

// ⚠ WHY SPARK IS SEEDED AT TICK 0 RATHER THAN FOUNDED MID-RUN.
// The obvious way to introduce a newborn is to have the world driver call `foundGuild`
// partway through. That cannot produce the guild this scenario needs: founding MINTS A
// HOME CLAIM, so a freshly-founded ventureless guild holds one system and therefore has
// GP 12 and `expectedReputation` 1800 — it is a floor-pinned newborn, not a size-0 guild,
// and `expectedReputation === 0` is unreachable through it. (Verified against the engine:
// found a guild into the zero-state and its snapshot row reads gp 12 / expected 1800 /
// modifier 0.3.) Since the point of this guild is the EMPTY-GUILD GUARD — the `expected ===
// 0` branch that must return 1.0 rather than divide by zero — it is seeded holding nothing
// and stays that way, which also means the guard is exercised on every tick of the run
// instead of one.

// The venture rows for one guild, and the claim rows for the territory it holds.
// Ventures are deliberately UNSEATED (no `siteId`): a venture with no site is legal, is
// skipped by the site-occupancy invariant, and still produces and still scores its Tier-1
// Points — so the scenario can shape twenty ventures across four guilds without hunting
// for twenty matching, unoccupied seed nodes. The ONE seated venture in this run is the
// mid-run expansion, which is a real `establishVenture` and must name a real node.
function shapeGuild(spec, systemIds) {
  const ventures = [];
  for (let i = 0; i < spec.mines; i += 1) {
    ventures.push({
      id: `${spec.id}_mine_${i + 1}`,
      ownerGuildId: spec.id,
      type: 'mining',
      // Ventures are spread over the guild's own systems; with one system they all pool
      // there (ruling B1 — resources are system-scoped).
      systemId: systemIds[i % systemIds.length] || null,
      resourceType: 'titanium',
      productionRate: FIXTURES.mineRate,
      // Every venture carries the same settled reputation, so a guild's total is simply
      // its venture count × `ventureRP` and the table's arithmetic is checkable by eye.
      reputation: FIXTURES.ventureRP,
      // Exactly ONE committed mine per guild, in its FIRST system — enough to give the
      // licence bot a window to sense and steer, without making production the subject.
      ...(i === 0 ? { syndicateCommitment: FIXTURES.commitment } : {}),
    });
  }
  return ventures;
}

// makeState() — a FRESH tick-0 state for one run. Pure and deterministic: the same call
// always assembles byte-identical state (no `Date`, no `Math.random`).
function makeState() {
  const claims = [];
  const guilds = [];
  let nextSystem = 0;

  for (const spec of GUILDS) {
    // Reach is dealt EXPANSION_SYSTEM first so it holds the ground the world driver later
    // expands onto; every other guild takes the next unused starter systems in seed order.
    const systemIds = [];
    for (let i = 0; i < spec.systems; i += 1) {
      let sysId;
      if (spec.id === 'reach-guild' && i === 0) {
        sysId = EXPANSION_SYSTEM;
      } else {
        do {
          sysId = STARTER_SYSTEMS[nextSystem % STARTER_SYSTEMS.length];
          nextSystem += 1;
        } while (sysId === EXPANSION_SYSTEM);
      }
      systemIds.push(sysId);
      claims.push({
        claimId: `claim_${spec.id}_${sysId}`,
        ownerGuildId: spec.id,
        landmarkId: sysId,
        landmarkKind: 'system',
        claimedAtTick: 0,
        contested: false,
      });
    }

    guilds.push({
      id: spec.id,
      name: spec.name,
      credits: 0,
      fuelHoard: 0,
      // The starter ground-asset gift a real founding would have granted. Assembled here
      // because this scenario builds its guilds directly through `createState` rather than
      // through the `foundGuild` action — without it the mid-run expansion's
      // `establishVenture` would be refused for naming a Miner the guild does not own.
      // The seeded ventures deliberately occupy NONE of them, so every machine is idle and
      // the expansion can take the first.
      assets: starterAssetSpecs(spec.id),
      ventures: shapeGuild(spec, systemIds),
    });
  }

  const state = createState({
    guilds,
    // [FIXTURE] the seeded Syndicate pool — see FIXTURES.seededPool.
    reserve: { reserveLevel: FIXTURES.seededPool },
    syndicate: { ledger: 0 },
    windowN: FIXTURES.windowN,
    claims,
  });

  // `createGuild` always writes `guildReputation: 0` — the guild total is a denormalised
  // cache the TICK maintains, not a constructor parameter — so the seeded venture
  // reputations are summed onto each guild here. Without this `checkGuildReputationSum`
  // would (rightly) trip on the very first tick. Deterministic: a plain sum over the
  // ventures this function just assembled.
  for (const g of state.guilds) {
    g.guildReputation = (g.ventures || []).reduce((n, v) => n + (v.reputation || 0), 0);
  }
  return state;
}

// buildScenario() — the full spec the recorder consumes.
function buildScenario() {
  const reach = GUILDS.find((g) => g.id === 'reach-guild');
  // The expansion takes the guild's FIRST idle Miner, read from the engine's own starter
  // id scheme rather than spelled out here (the seeded ventures occupy none of them).
  const reachMinerId = starterAssetSpecs(reach.id).filter((a) => a.kind === 'miner')[0].id;

  // One licence bot per PRODUCING guild, keyed by guild id — the recorder's multi-guild
  // `bots` map. Each steers its own guild's committed good in its own first system, which
  // is where `shapeGuild` puts the commitment. Spark has no bot: it produces nothing, so
  // there is nothing to allocate.
  const bots = {};
  let nextSystem = 0;
  for (const spec of GUILDS) {
    if (spec.mines === 0) continue;
    const firstSystem = spec.id === 'reach-guild'
      ? EXPANSION_SYSTEM
      : STARTER_SYSTEMS.filter((s) => s !== EXPANSION_SYSTEM)[nextSystem];
    if (spec.id !== 'reach-guild') nextSystem += spec.systems;
    bots[spec.id] = makeLicenceBot({
      guildId: spec.id,
      systemId: firstSystem,
      committedGood: 'titanium',
      reserveBuffer: FIXTURES.reserveBuffer,
    });
  }

  return {
    name: 'economy_meanline',
    ticks: FIXTURES.ticks,
    makeState,
    // The ONE scheduled perturbation: Reach gains a seventh mine. Its Points rise the
    // moment the venture exists while its reputation does not, so its modifier falls — and
    // because the modifier falls further than the base rises, its GRANT FALLS TOO. That is
    // "expansion is lean until backed by reputation" as a number in a table.
    world: makeReliefWorld({
      atTick: FIXTURES.expansionTick,
      guildId: reach.id,
      ventureId: 'reach-guild_mine_expansion',
      siteId: EXPANSION_NODE,
      assetId: reachMinerId,
      resourceType: 'titanium',
      productionRate: FIXTURES.mineRate,
    }),
    bots,
  };
}

module.exports = { buildScenario, makeState, FIXTURES, GUILDS };
