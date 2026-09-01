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
//   - ⚠ THE POOL STABILISES. **This is what slice 5b-ii changed, and it is the headline.**
//     Σdesired opens ABOVE the fixed influx, so the first cycle takes out more than it puts
//     back and the pool dips. Under 5a and 5b-i that drift never reversed: the pool bled to
//     zero and `rationGrants` clipped everyone from there on, permanently, because nothing
//     pulled draw back under supply. That was the whole motivation for 5b, and this scenario
//     existed to make it watchable. With the controller live the price rises as the pool
//     falls, draw bends down to meet the influx, and the pool CONVERGES on the controller's
//     demand-relative target instead — no rationing at all. The un-rationed convergence IS
//     the demonstration now; the rationing edge moved to `buildCrisisScenario` below, which
//     still exercises it at a load no price can throttle.
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

  // [FIXTURE] Run length: 20 cycle boundaries at N=4. Lengthened from 44 for slice 5b-ii:
  // the arc is no longer "bleed, then ration" (which was over in eleven cycles) but "dip,
  // correct, converge", and a settled TAIL is the part worth seeing — the last several
  // cycles move the pool by a handful of units and the price by hundredths. Twenty cycles
  // reaches pool ~2079 / price ~12.20 / draw ~796 against an influx of 800, close enough to
  // the settled point that the convergence is unmistakable without printing sixty rows.
  ticks: 80,

  // [FIXTURE] The reputation each seeded venture carries at tick 0. Seeding it means every
  // guild starts with a settled, non-trivial reputation instead of climbing for forty
  // ticks first, and it makes reputation STABLE across the run — which is what leaves the
  // pool and the rationing as the only things moving in the trace.
  //
  // ⤳ RESCALED 01-09-26 (1497 → 166), points-and-reputation.md §2.6, and the RATIONALE
  // changed with it. This used to be read off the §2.3 TAPER: where a venture that always
  // meets its commitments PARKS, just under the 1500 soft cap. That reading is gone,
  // because the rescale deliberately did NOT rescale the band (§2.6 defers it) — a resting
  // venture now parks at ~1466 against a mine's bar of 100, some 14× over its line, and
  // seeding that would pin every guild in the galaxy at the issuance CEILING and flatten
  // the trace this scenario exists to show.
  //
  // So it is sized off the LINE now, not the taper: 166 is the per-venture carry that puts
  // the reference roster (Meridian, 2 systems and 6 mines) almost exactly on `MEANLINE_K ×
  // GP`. The four modifiers below are preserved to within a unit of fuel each, which is
  // the point — the scenario is about the pool and the crossing, not about this number.
  ventureRP: 166,

  // [FIXTURE] The Syndicate pool at tick 0. Deliberately BELOW where the controller will
  // settle it, so the run opens with the pool genuinely off target and the correction is
  // something the trace shows happening rather than something it starts already having
  // done. Scenario-local: it does NOT touch `POOL_SEED`, the galaxy-creation constant the
  // zero-state uses. (Under 5a this number sized how many cycles were paid in full before
  // the pool bled out; it is kept unchanged so the two traces are comparable.)
  seededPool: 1400,

  // [FIXTURE] The crisis run's dials — see `buildCrisisScenario` below.
  //
  // `crisisWings` 5: how many copies of the producing roster the crisis galaxy holds. Five
  // because Σ entitlement per wing is ~984, and a galaxy pinned at the engine's PRICE_CEIL
  // still draws `Σ × REFERENCE / CEIL` = Σ/4 — so four wings would only just exceed the
  // influx, while five (Σ ~4920, ~1230 at the ceiling against 800 in) is a decisive,
  // unmistakable crunch. Stated as the arithmetic rather than as a magic number, and it is
  // a FIXTURE: it tunes this scenario's load, not the engine's ceiling.
  crisisWings: 5,
  // `crisisTicks` 60: fifteen cycles — enough for a clear un-rationed opening, the crossing,
  // and a rationed tail, the same three-part shape the 5a trace had.
  crisisTicks: 60,
  // `crisisPool` 6000: a fat opening buffer, so the run genuinely starts paid-in-full and
  // the crossing is something that HAPPENS rather than the state it opens in.
  crisisPool: 6000,

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
// checkable rather than magic. ⤳ RESCALED 01-09-26 (§2.6): `MEANLINE_K` = 1 and GP weights
// 200 (system) / 100 (Tier-1 venture), with each venture parked at `ventureRP` = 166:
//
//   guild     systems  mines    GP   expected     RP   ratio   modifier   desired
//   Forge        1       8     1000     1000    1328   1.33     ~1.50       448
//   Meridian     2       6     1000     1000     996   1.00     ~1.00       298
//   Reach        4       6     1400     1400     996   0.71     ~0.57       238
//   Spark        0       0        0        0       0    n/a       1.00         0
//                                                              Σdesired =   984
//
// Every RATIO is unchanged from the pre-rescale table (1.33 / 1.00 / 0.71) and every
// `desired` lands within one unit of what it was (449 / 299 / 239), because
// `BASE_GRANT_PER_GP` was re-based 5 → 0.3 with the GP weights. That is the whole claim of
// the rescale made visible in one table: the numbers shrank and the economy did not move.
//
// Σdesired (984) is ABOVE the engine's fixed influx (800), which is what makes the pool
// bleed and the crossing happen at all. Forge and Meridian are deliberately the SAME size
// (GP 1000) with different footprints — that is density-beats-sprawl as one comparison: the
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
// GP 200 and `expectedReputation` 200 — it is a NEWBORN, not a size-0 guild, and
// `expectedReputation === 0` is unreachable through it. (Verified against the engine: found
// a guild into the zero-state and its snapshot row reads gp 200 / expected 200. ⤳ RESCALED
// 01-09-26 from gp 12 / expected 1800 / modifier 0.3 — and note the modifier is no longer
// 0.3 either: the founding endowment, added 31-08-26, now puts a newborn ON its line.) Since the point of this guild is the EMPTY-GUILD GUARD — the `expected ===
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

// makeStateFrom(roster, opts) — a FRESH tick-0 state for one run. Pure and deterministic:
// the same call always assembles byte-identical state (no `Date`, no `Math.random`).
//
// TAKES ITS ROSTER AND ITS POOL AS ARGUMENTS (generalised for the crisis scenario, slice
// 5b-ii) so the four-guild run and the multi-wing crisis run are the SAME assembly code
// with different fixtures — the crisis is "more of these guilds", not "different guilds",
// which is exactly the claim it exists to make. `expansionGuildId` is the one guild that
// must be seated on `EXPANSION_SYSTEM` (the mid-run expansion needs a real node there);
// pass null when there is no expansion and no system is reserved.
function makeStateFrom(roster, { seededPool, expansionGuildId }) {
  const claims = [];
  const guilds = [];
  let nextSystem = 0;

  for (const spec of roster) {
    // The expansion guild is dealt EXPANSION_SYSTEM first so it holds the ground the world
    // driver later expands onto; every other guild takes the next unused starter systems in
    // seed order.
    const systemIds = [];
    for (let i = 0; i < spec.systems; i += 1) {
      let sysId;
      if (expansionGuildId && spec.id === expansionGuildId && i === 0) {
        sysId = EXPANSION_SYSTEM;
      } else {
        do {
          sysId = STARTER_SYSTEMS[nextSystem % STARTER_SYSTEMS.length];
          nextSystem += 1;
        } while (expansionGuildId && sysId === EXPANSION_SYSTEM);
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
    // [FIXTURE] the seeded Syndicate pool. `fuelPrice` and `avgDraw` are deliberately NOT
    // passed: `createReserve` opens them at the reference price and the balanced-galaxy
    // draw assumption, which is where a real galaxy starts, and letting the controller find
    // its own way from there is the whole demonstration.
    reserve: { reserveLevel: seededPool },
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

// The four-guild scenario's own state: the standard roster, the standard pool, and Reach
// seated where the mid-run expansion can land.
function makeState() {
  return makeStateFrom(GUILDS, {
    seededPool: FIXTURES.seededPool,
    expansionGuildId: 'reach-guild',
  });
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

// ── THE CRISIS SCENARIO (slice 5b-ii) ────────────────────────────────────────────────
//
// WHY IT EXISTS. Once the controller is live the four-guild run above stops rationing —
// which is the win, and which would also quietly retire the only test in this repo that
// exercises `rationGrants`'s clip through a real multi-cycle run. §4.1's crunch edge is
// still real and still ruled: a galaxy CAN out-draw what any price can throttle, and when
// it does, grants are clipped and the pool sits at zero. So the rationing demonstration
// moves here rather than being lost.
//
// ⚠ IT IS THE SAME GUILDS, JUST MORE OF THEM, and that is the point it is shaped to make.
// Nothing about a guild changes — same footprints, same seeded reputations, same modifiers,
// same per-guild draw. The galaxy is simply five WINGS of the producing roster instead of
// one. So the crisis is not "we made a weird guild"; it is "this galaxy is too big for its
// supply", which is exactly the condition §4.1 describes. It also demonstrates the LIMIT of
// the controller's scale-invariance honestly: the demand-relative target means the loop
// behaves the same at any size right up until the price it needs exceeds `PRICE_CEIL`, and
// past that the clamp bites and rationing takes over — correctly, because a fuel crisis
// SHOULD feel like rationing.
//
// No world driver and no bots: the expansion and the licence bots exist to give the
// four-guild trace its mean-line story, and this run's subject is the fuel loop alone.
const CRISIS_GUILDS = Object.freeze(
  [...Array(FIXTURES.crisisWings)].flatMap((_, wing) => GUILDS
    .filter((g) => g.mines > 0)                    // the empty guild adds no load; one is kept below
    .map((g) => ({ ...g, id: `${g.id}-w${wing + 1}`, name: `${g.name} ${wing + 1}` })))
    // One empty guild, so the empty-guild guard is exercised in the crunch too — the branch
    // of `rationGrants` that must skip a zero-ask guild rather than hand it a remainder unit
    // only runs in a rationed cycle, which is a case only this scenario reaches.
    .concat(GUILDS.filter((g) => g.mines === 0 && g.systems === 0)),
);

function makeCrisisState() {
  return makeStateFrom(CRISIS_GUILDS, {
    seededPool: FIXTURES.crisisPool,
    expansionGuildId: null,          // no expansion: no system needs reserving
  });
}

// buildCrisisScenario() — the crunch-edge spec the recorder consumes.
function buildCrisisScenario() {
  return {
    name: 'economy_crisis',
    ticks: FIXTURES.crisisTicks,
    makeState: makeCrisisState,
    world: null,
    bots: null,
  };
}

module.exports = {
  buildScenario, makeState, FIXTURES, GUILDS,
  buildCrisisScenario, makeCrisisState, CRISIS_GUILDS,
};
