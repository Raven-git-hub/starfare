'use strict';

// points.js — GUILD POINTS (GP): how big a guild is.
//
// docs/points-and-reputation.md §1 and §1.0 (the formula and its four rulings).
//
//     GP(guild) = W_SYS × (held systems) + Σ ventures W_TIER( tier of producedGoodFor(v) )
//
// GP is one half of the fuel model's pair. RP (sim/licence.js) is what a guild
// CONTRIBUTES; GP is what it HOLDS, and slice 4's mean line will judge the first against
// the second — `expectedRP = MEANLINE_K × GP` — so that size alone earns nothing and
// merely raises the bar you must clear by contributing. Neither number is built to be
// read alone.
//
// ── FOUR RULINGS, all §1.0, and each one is a decision this module makes structural ──
//
// 1. DERIVED, NEVER STORED. GP is a pure function of a guild's CURRENT holdings, so it is
//    recomputed on read — exactly the standing `heldSystemIds` (sim/claims.js) has, and
//    for the same reason: a stored copy would be a second source of truth for a fact the
//    claims and the venture list already carry, and it could drift from them silently.
//    There is NO `guild.guildPoints` field and nothing here writes to state. That is also
//    what makes this slice free of determinism risk: GP reaches no serialized byte, so
//    the persisted-state goldens cannot move, by construction rather than by re-pinning.
//    Contrast `guild.guildReputation`, which IS stored — because RP is an accumulated
//    running total with no live inputs to recompute it from, while GP has nothing else.
//
// 2. COUNT VENTURES, NOT ASSETS. A venture IS its deployed asset (it names the `assetId`
//    it runs on, design.md §4), so counting ventures counts exactly the deployed machines
//    and counting deployed assets AS WELL would score one machine twice. IDLE INVENTORY
//    SCORES NOTHING, which is §1's "deployed only, idle = 0" — and it falls out of this
//    loop rather than needing a filter, because an idle asset is precisely one that no
//    venture names.
//
// 3. AN EMPTY HELD SYSTEM STILL COUNTS `W_SYS`. It is not an oversight that undeveloped
//    territory scores: it is the anti-sprawl liability (§2's density-beats-sprawl). A
//    held system with nothing in it is pure GP with no ventures earning the reputation to
//    pay for it, so it raises the guild's bar and delivers nothing — claiming space you
//    cannot use is meant to cost.
//
// 4. TIER COMES FROM `producedGoodFor`, GENERALLY. Mining, refining and (as of 2.1a)
//    module manufacture are not special-cased; the venture's produced good is looked up
//    and its tier decides the weight. When the Tier-3 recipes became real (2.1a) they
//    scored through this same line — the only edit was the new `3: 300` entry in
//    `TIER_WEIGHT`, exactly as this note anticipated.
//
// WHAT IS NOT HERE, deliberately (§1's `[DEFERRED]` sources): transports, tolls, droids,
// outposts and exploration. None of their systems exist, and the doc names them precisely
// so a build does not invent `guild.tolls` to have something to count. Nor is the mean
// line here — GP is published and nothing reads it yet; §4 rules that the FUEL layer owns
// the mean line and merely READS this.

const { heldSystemIds } = require('./claims.js');
const { producedGoodFor, isDeuteriumMine, isIllegalDeuteriumRefinery } = require('./baseline.js');
const { isRawResource, isProcessedGood, isTier3Good } = require('./resources.js');

// W_SYS — the Points a held system is worth.
//
// `[FIRST-CUT]` **200**, ruled in phase-1-tuning.md §"Points & Reputation"
// (200 / 100 / 150 / 300 / 500). What these numbers encode is the RATIO — systems
// Points-HEAVY, ventures Points-LIGHT — which is the density-beats-sprawl shape:
// territory is the expensive thing to hold, and you pay for it by putting ventures on it.
// A held system stays exactly 2× a tier-1 mine, as it was at 12 / 6.
//
// ⤳ RESCALED 01-09-26 (12 → 200), points-and-reputation.md §2.6. The absolute scale used
// to be meaningless on its own — GP was only ever read through `expectedRP = MEANLINE_K ×
// GP`, and `MEANLINE_K = 150` was what fixed it. The rescale drops `MEANLINE_K` to 1, so
// GP and RP now share ONE small integer scale and a guild's expected RP simply EQUALS its
// GP. That makes this weight the scale itself rather than an arbitrary ratio numerator:
// 200 is the RP a held system is expected to have earned.
const W_SYS = 200;

// TIER_WEIGHT — the Points a venture is worth, by the TIER of the good it produces.
//
// A MAP, not named constants, because ruling 4 is that tier is general: a higher tier
// scores more. `W_T3` (300) went LIVE in 2.1a (below); `W_T4` stays deferred as a GP
// weight — no Tier-4 good exists, its only reader is the deuterium-licence RP path.
//
// A tier with NO entry here is a deliberate STOP, not a zero — see `tierWeight`.
//
// ⤳ RESCALED 01-09-26 (6 / 8 → 100 / 150), points-and-reputation.md §2.6. Not just a ×
// re-denomination: the tier SPREAD was deliberately widened, from 6 : 8 (1 : 1.33) to the
// ruled 1 : 1.5 : 3 : 5 = 100 / 150 / 300 / 500, so climbing the manufacturing tree is a
// genuine reward.
//
// ⤳ W_T4 = 500 PULLED IN 04-09-26 (deuterium RP slice 2), points-and-reputation.md §2.6 /
// fuel-supply-and-allocation.md §1.4. A licensed deuterium mine earns RP at the Tier-4 rate
// (`tierFactor` = 5, `ventureTierWeight` = 500, sim/licence.js) — so the T4 weight now has a
// real reader and belongs in the map. It changes NO GP: `tierOf('deuterium')` is 1, and a
// licensed deuterium mine is already skipped in `guildPoints` (slice 1), so nothing reads a
// tier-4 GP weight.
//
// ⤳ W_T3 = 300 PULLED IN 2.1a (docs/asset-recipes.md; docs/phase-1-tuning.md GP-weights row).
// The 25 Tier-3 module goods are now real and producible, so `tierOf` resolves a module to 3
// and a venture manufacturing one MUST score its GP rather than HALT. The number is the ruled
// 1 : 1.5 : 3 : 5 ladder's third rung — not invented here, only un-deferred now that the goods
// it weighs exist. This closes a latent cross-system halt: `guildPoints`, the issuance grant
// (∝ GP), the mean line / founding endowment (∝ GP) and the licence signing bump (tier-scaled)
// all read this weight, and every one of them would have thrown on a module venture the instant
// the client's Tier-3 grey-out (a UI guard, removed next slice) stopped hiding it.
const TIER_WEIGHT = Object.freeze({
  1: 100,  // raw — a mine
  2: 150,  // processed — a refinery, half again the mine that feeds it
  3: 300,  // Tier-3 module — a factory manufacturing a module (2.1a; the ruled 3× the mine)
  4: 500,  // the RP-only Tier-4 weight (deuterium licence); no GP reader — see note above
});

// EVERY WEIGHT ABOVE IS AN INTEGER, and must stay one: GP is an integer (§15.2 / §1.0),
// and it is integral here BY CONSTRUCTION — an integer count times an integer weight,
// summed — with no rounding anywhere. Nothing clamps or rounds a fractional weight into
// shape, so a non-integer here would silently produce a non-integer GP; a test pins that
// the weights are whole numbers rather than leaving it to be noticed downstream.

// tierOf(good) -> 1 | 2 | 3 | null. Which manufacturing tier a good belongs to (design.md
// §15.2: Tier 1 Raw → Tier 2 Processed → Tier 3 Module → …), answered by the resources
// vocabulary through its OWN predicates rather than by re-reading the arrays here, so this
// cannot come to disagree with what the rest of the engine considers raw, processed or module.
//
// `null` = a good in NONE of the three lists. Today that is reachable only for `deuterium_fuel`
// (fuel is in no stockpile list, and no recipe outputs it). Since 2.1a the Tier-3 modules ARE
// weighted (tier 3), so a module no longer returns null — a venture producing one scores 300
// rather than halting. `null` remains a "this good has no ruled tier weight" signal on which
// the caller HALTS — never a 0.
function tierOf(good) {
  if (!good) return null;
  if (isRawResource(good)) return 1;
  if (isProcessedGood(good)) return 2;
  if (isTier3Good(good)) return 3;
  return null;
}

// tierWeight(tier, where) -> the Points for that tier, or HALT.
//
// An unweighted tier THROWS rather than scoring 0 (§18 / design.md §15.5: a silent
// violation is worse than a crash). A 0 would be the quietest possible bug in this whole
// model: a guild's tier-3 factories would simply not count toward its size, so its bar
// would sit below what it actually holds, and slice 4's mean line would hand it fuel it
// had not earned — with nothing anywhere going red.
//
// ⤳ IT HAS A SECOND CALLER SINCE 01-09-26: `tierFactor` (sim/licence.js), which scales the
// RP a met or breached cycle moves by the venture's tier (§2.6). So the same halt now also
// stops a tier-3 venture EARNING at the tier-1 rate, which would be the same bug wearing
// reputation's clothes. The message says "GP weight lookup" rather than "guildPoints" for
// that reason — it is one lookup with two consumers, and it must read honestly from both. Halting names the good, the venture
// and the guild, so the fix is obvious: rule the weight in phase-1-tuning and add it to
// `TIER_WEIGHT`. NEVER guess one here.
function tierWeight(tier, where) {
  const w = TIER_WEIGHT[tier];
  if (w === undefined) {
    const at = where || {};
    throw new Error(
      `GP weight lookup: no ruled GP weight for tier ${tier === null ? 'UNKNOWN' : tier} — `
      + `guild ${at.guildId}'s venture ${at.ventureId} produces "${at.good}", which is in neither `
      + 'RAW_RESOURCES nor PROCESSED_GOODS (sim/resources.js). Rule its weight in '
      + 'docs/phase-1-tuning.md and add it to TIER_WEIGHT — refusing to score it as 0, which '
      + 'would understate the guild\'s size and quietly lower the bar its reputation is judged against',
    );
  }
  return w;
}

// guildPoints(state, guild) -> the guild's GP, an integer.
//
// PURE AND READ-ONLY: it takes state, reads `state.claims` and the guild's own ventures,
// and mutates nothing. Safe to call from the snapshot (which must move no number) and
// from anywhere else that wants the figure, as often as it likes.
//
// The two terms, and what each deliberately does NOT do:
//   - SYSTEMS come from `heldSystemIds`, the one predicate that answers "does this guild
//     hold this system?" for every caller (sim/claims.js) — so GP counts territory by the
//     same reading of `state.claims` that gates a Syndicate delivery, and the two can
//     never disagree about what a guild holds. It counts held systems whether or not
//     anything sits in them (ruling 3).
//   - VENTURES are counted from the guild's own array — ownership is "the guild whose
//     array holds it" — with no reference to `guild.assets`, so idle inventory is
//     structurally unable to score (ruling 2).
//
// A VENTURE PRODUCING NOTHING CONTRIBUTES 0, and that is not the same as the halt above.
// `producedGoodFor` returns null for a venture with neither a `resourceType` nor a
// resolvable `recipeId` — a dangling recipe id, which `checkSiteOccupancy` is already
// halting the tick on, or a synthetic test venture with no output at all. That is a
// BROKEN or EMPTY venture rather than an unweighted TIER, it is already someone else's
// tripwire, and scoring it 0 is the honest reading: it produces nothing, so it is not a
// deployed producer. An unknown TIER is different — the venture really does produce
// something, and the model simply has no ruling for it yet.
// systemPoints(state, guild) -> the SYSTEM half of a guild's Points: `W_SYS × the systems
// it holds`. An integer, and non-negative (a count times a positive weight).
//
// Extracted so the term exists ONCE. `guildPoints` below is this plus the venture half,
// and the founding endowment (docs/points-and-reputation.md §2.5) is sized off this half
// ALONE — the home system a founding grants is all a newborn holds, and its idle starter
// assets score nothing. Two separate spellings of "W_SYS × held systems" could drift; one
// cannot, and the endowment must track a retune of `W_SYS` exactly as `guildPoints` does.
//
// PURE, like everything else here: reads `state.claims` through the one predicate every
// caller shares (`heldSystemIds`, sim/claims.js) and mutates nothing.
function systemPoints(state, guild) {
  if (!guild) return 0;
  return W_SYS * heldSystemIds(state, guild.id).length;
}

function guildPoints(state, guild) {
  if (!guild) return 0;
  let points = systemPoints(state, guild);
  for (const v of guild.ventures || []) {
    // A deuterium mine adds NO GP (§1.4 "The Deuterium Cycle", fuel-supply-and-allocation.md),
    // LICENSED OR NOT. The licensed mine's output serves the Syndicate; the UNLICENSED mine is
    // "idle to the Syndicate — no GP, no RP" (the illegal-path slice, ruled 06-09-26), its raw
    // deuterium piling up inert in the guild-wide contraband store. Either way it is not size:
    // licensing sells the output, refining it illegally is invisible to the Syndicate, and
    // neither is a holding the mean line should reward. Skipped BEFORE `producedGoodFor` so the
    // exclusion does not depend on how deuterium happens to tier — the widening from
    // `isLicensedDeuteriumMine` to `isDeuteriumMine` (slice 1a) is exactly this "no GP either".
    //
    // The ILLEGAL DEUTERIUM REFINERY is skipped for the same reason (§1.4, slice 1b): it is
    // idle to the Syndicate — its whole purpose is contraband fuel the Syndicate cannot see —
    // so it adds no size either. (It also produces no identifiable good, so `producedGoodFor`
    // would return null and it would score 0 anyway; the explicit skip states the ruled
    // intent rather than leaning on that, and keeps it off the tier lookup entirely.)
    if (isDeuteriumMine(v) || isIllegalDeuteriumRefinery(v)) continue;
    const good = producedGoodFor(v);
    if (!good) continue;
    points += tierWeight(tierOf(good), { good, ventureId: v.id, guildId: guild.id });
  }
  return points;
}

module.exports = { W_SYS, TIER_WEIGHT, tierOf, tierWeight, systemPoints, guildPoints };
