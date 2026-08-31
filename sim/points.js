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
// 4. TIER COMES FROM `producedGoodFor`, GENERALLY. Mining and refining are not special-
//    cased; the venture's produced good is looked up and its tier decides the weight. So
//    the day tier-3 recipes are real, they score through this same line — the only edit
//    is a new entry in `TIER_WEIGHT`.
//
// WHAT IS NOT HERE, deliberately (§1's `[DEFERRED]` sources): transports, tolls, droids,
// outposts and exploration. None of their systems exist, and the doc names them precisely
// so a build does not invent `guild.tolls` to have something to count. Nor is the mean
// line here — GP is published and nothing reads it yet; §4 rules that the FUEL layer owns
// the mean line and merely READS this.

const { heldSystemIds } = require('./claims.js');
const { producedGoodFor } = require('./baseline.js');
const { isRawResource, isProcessedGood } = require('./resources.js');

// W_SYS — the Points a held system is worth.
//
// `[FIRST-CUT]`, ruled in phase-1-tuning.md §"Points & Reputation" (12 / 6 / 8). THE
// ABSOLUTE SCALE IS MEANINGLESS ON ITS OWN and is not worth tuning here: GP is only ever
// read through `expectedRP = MEANLINE_K × GP`, and slice 4's `MEANLINE_K` is what fixes
// the scale. What these numbers encode is the RATIO — systems Points-HEAVY, ventures
// Points-LIGHT — which is the density-beats-sprawl shape: territory is the expensive
// thing to hold, and you pay for it by putting ventures on it.
const W_SYS = 12;

// TIER_WEIGHT — the Points a venture is worth, by the TIER of the good it produces.
//
// A MAP, not two named constants, because ruling 4 is that tier is general: a higher tier
// scores more, and `W_T3` / `W_T4` are `[DEFERRED]` in phase-1-tuning only because those
// goods are not real yet (sim/resources.js `TIER3_GOODS` are display-only placeholders
// with no recipes). When they are, this gains a line and nothing else changes.
//
// A tier with NO entry here is a deliberate STOP, not a zero — see `tierWeight`.
const TIER_WEIGHT = Object.freeze({
  1: 6,   // raw — a mine
  2: 8,   // processed — a refinery, a notch above the mine that feeds it
});

// EVERY WEIGHT ABOVE IS AN INTEGER, and must stay one: GP is an integer (§15.2 / §1.0),
// and it is integral here BY CONSTRUCTION — an integer count times an integer weight,
// summed — with no rounding anywhere. Nothing clamps or rounds a fractional weight into
// shape, so a non-integer here would silently produce a non-integer GP; a test pins that
// the weights are whole numbers rather than leaving it to be noticed downstream.

// tierOf(good) -> 1 | 2 | null. Which manufacturing tier a good belongs to (design.md
// §15.2: Tier 1 Raw → Tier 2 Processed → …), answered by the resources vocabulary through
// its OWN predicates rather than by re-reading the arrays here, so this cannot come to
// disagree with what the rest of the engine considers raw or processed.
//
// `null` = a good in NEITHER list. Today that is reachable only for `deuterium_fuel`
// (fuel is in no stockpile list, and no recipe outputs it) and the `TIER3_GOODS`
// placeholders (no 2→3 recipe exists, so no venture can produce one). It is a "this tier
// has no ruled weight yet" signal, and the caller HALTS on it — it is never a 0.
function tierOf(good) {
  if (!good) return null;
  if (isRawResource(good)) return 1;
  if (isProcessedGood(good)) return 2;
  return null;
}

// tierWeight(tier, where) -> the Points for that tier, or HALT.
//
// An unweighted tier THROWS rather than scoring 0 (§18 / design.md §15.5: a silent
// violation is worse than a crash). A 0 would be the quietest possible bug in this whole
// model: a guild's tier-3 factories would simply not count toward its size, so its bar
// would sit below what it actually holds, and slice 4's mean line would hand it fuel it
// had not earned — with nothing anywhere going red. Halting names the good, the venture
// and the guild, so the fix is obvious: rule the weight in phase-1-tuning and add it to
// `TIER_WEIGHT`. NEVER guess one here.
function tierWeight(tier, where) {
  const w = TIER_WEIGHT[tier];
  if (w === undefined) {
    const at = where || {};
    throw new Error(
      `guildPoints: no ruled GP weight for tier ${tier === null ? 'UNKNOWN' : tier} — `
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
    const good = producedGoodFor(v);
    if (!good) continue;
    points += tierWeight(tierOf(good), { good, ventureId: v.id, guildId: guild.id });
  }
  return points;
}

module.exports = { W_SYS, TIER_WEIGHT, tierOf, tierWeight, systemPoints, guildPoints };
