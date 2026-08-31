'use strict';

// issuance.js — FUEL FLOWS: the Syndicate's per-cycle supply into the pool, and the
// size-based grants out of it.
//
// docs/fuel-supply-and-allocation.md §2.1 (the issuance mechanic — the ruling for this
// slice), §1.1 (the abstracted influx), §1.3 (the seeded pool), §4.1 (the crunch edge).
// Numbers in phase-1-tuning.md §"Fuel — the pool & issuance".
//
//     fuelGranted(guild) = round( BASE_GRANT_PER_GP × GP(guild) × issuanceModifier(guild) )
//
// THIS IS WHERE FUEL FINALLY MOVES. Slice 1 seeded a hoard, slice 2 quoted a route, slice
// 3 burned it on a purchase, and slices 3-4 built the Points/reputation pair that decides
// how much a guild deserves. Until now nothing filled a hoard back up. This closes the
// loop: supply enters the pool, and grants leave it sized by *reputation against size*.
//
// ── THE POOL IS `state.reserve.reserveLevel`, WHICH ALREADY EXISTED. ──────────────────
// The build prompt and §2.1 both suggest "a Syndicate-owned fuel store (`state.syndicate
// .fuelPool` **or equivalent**)". The equivalent already exists and has since the walking
// skeleton: `state.reserve.reserveLevel` IS the communal Syndicate fuel reserve —
// sim/supply.js names it "the communal pool, the headline galactic fuel stockpile",
// sim/resources.js points at it by name, design.md §15.4's **Fuel Utility** entity is
// built around it, and it is ALREADY a term in invariant 1 and in `galacticSupply.fuel`.
// Minting a second pool beside it would have created two communal fuel stores for one
// concept — a straight breach of §15.2's single-source-of-truth and invariant 5 — and
// would have left invariant 1 summing one of them while the code filled the other. So
// this slice fills the pool the galaxy already had, and the only change it needed was a
// real seed (`POOL_SEED`) in place of the `[SHEET]` placeholder the zero-state carried.
//
// ── WHAT IS MINTED AND WHAT MERELY MOVES (invariant 1 — the one to respect above all) ──
//   - THE INFLUX MINTS. There is no upstream account to debit — the back-end refineries
//     are abstracted (§1.1) — so fuel is genuinely created, and it pays for itself in the
//     audit exactly as the founding hoard does: `audit.totalProduced` rises by the same
//     amount in the same breath (§15.5 invariant 1's genesis amendment, which reads
//     "created only by an event that records itself in `totalProduced`").
//   - ISSUANCE ONLY MOVES. A grant is a TRANSFER, pool → hoard, minting nothing:
//     `totalProduced` and `totalConsumed` are both untouched, and the conserved total
//     `pool + Σ hoards` is unchanged by it. That is why a grant needs no audit entry and
//     must never be given one.
//
// ── AND IT READS. IT NEVER AUTHORS. ── §4 of points-and-reputation.md: the fuel layer
// owns issuance and READS Points and reputation. Nothing here decides how GP is weighted
// (sim/points.js) or how RP moves (sim/licence.js) or where the mean line sits
// (sim/meanline.js); this only spends the answer.

const { guildPoints } = require('./points.js');
const { issuanceModifier } = require('./meanline.js');

// BASE_GRANT_PER_GP — fuel per Guild Point per cycle, at modifier 1.0.
//
// `[FIRST-CUT]` 5. The base is SIZE-RELATIVE by ruling (§2.1): a bigger footprint draws a
// bigger base, and the mean-line modifier then scales it by how well the guild
// contributes *relative to* that size. GP is therefore both the base AND the divisor
// inside the modifier's expected line, which is exactly "draw sized by
// reputation-against-size". A par guild (GP 30, modifier ~1.0) draws ~150 a cycle; an
// over-expanded one draws its base × 0.3.
//
// A demand/consumption-relative base is a possible later refinement, deferred to 5b —
// which builds the consumption tracking it would need anyway.
const BASE_GRANT_PER_GP = 5;

// DEUTERIUM_INFLUX_PER_CYCLE — the abstracted back-end supply into the pool (§1.1).
//
// `[FIRST-CUT]` 800, and rougher than most: it is a FIXED number against a draw that is
// not, so a small galaxy over-fills and a large one rations. That asymmetry is not a bug
// to tune out here — it is precisely what 5b's demand-relative price controller exists to
// correct, and the tuning doc says so.
const DEUTERIUM_INFLUX_PER_CYCLE = 800;

// POOL_SEED — what the Syndicate reserve opens with at galaxy creation (§1.3).
//
// `[FIRST-CUT]` 4000, roughly five cycles of a typical galaxy's draw: a buffer so early
// imbalance rations GENTLY rather than instantly. Galaxy-scale, not per-guild. It
// replaces the `[SHEET]` placeholder 30 the zero-state carried since the walking
// skeleton — a number that predated there being any rule for what the pool was for.
//
// Seeded by the SCENARIO (sim/scenarios/zero-state.js), not by `createState`, for the
// same reason `GUILD_STARTING_FUEL` is seeded by the founding action and not by
// `createGuild`: a scenario or a test passes its own reserve, and baking a galaxy-scale
// number into the constructor would move every fixture for nothing.
const POOL_SEED = 4000;

// grantFor(state, guild) -> the fuel this guild is DUE this cycle, an integer ≥ 0.
//
// `round(BASE_GRANT_PER_GP × GP × modifier)`. THE ROUNDING IS RULED HERE and nowhere else
// (§2.1): slice 4 left the modifier a deliberately-unrounded float precisely so that the
// one place a float meets integer fuel (§15.2) would be the point of grant. Do not round
// upstream.
//
// A guild holding NOTHING is due NOTHING — GP 0 makes the product 0 whatever the modifier
// (which the empty-guild guard puts at 1.0). It falls out of the arithmetic rather than
// needing a special case, and it is the right answer: the grant is sized by holdings.
//
// PURE: reads Points and the modifier, mutates nothing.
function grantFor(state, guild) {
  return Math.round(BASE_GRANT_PER_GP * guildPoints(state, guild) * issuanceModifier(state, guild));
}

// rationGrants(desired, pool) -> what each guild ACTUALLY receives, same order, integers.
//
// THE CRUNCH EDGE (§4.1, and invariant 1's hard floor). When the cycle's grants come to
// more than the pool holds, they are clipped PROPORTIONALLY to each guild's share so the
// pool empties to EXACTLY 0 rather than going negative. Nothing in this slice pushes draw
// back under supply — that is 5b's price controller — so a galaxy that out-draws its
// influx rations, and then risks collapse. That is the losable state of §1.2, correct and
// intended for this cut.
//
// DETERMINISTIC, which for an integer apportionment means the remainder rule has to be
// pinned as tightly as the shares (invariant 9). Each guild takes `floor(desired × pool /
// total)`, and the units left over by that flooring go to the guilds with the largest
// fractional parts, ties broken by POSITION IN THE GUILD ARRAY — the classic
// largest-remainder apportionment. ⚠ The tie-break is the one thing here the doc does not
// rule: §2.1 says "clipped proportionally" and integer fuel forces *some* remainder rule,
// so largest-remainder-then-array-order is a build decision, flagged on the roadmap rather
// than taken silently. It is the standard unbiased choice; handing the remainder out in
// plain array order would systematically favour whoever founded first.
//
// A guild that asked for NOTHING can never receive a remainder unit — it is skipped
// explicitly. Arithmetically its fractional part is already 0 and it would sort last, but
// "you cannot be granted fuel you were not due" is a rule worth being structural rather
// than emergent from a sort.
//
// THE TOTAL HANDED OUT IS COMPUTED IN INTEGERS THROUGHOUT. Floats appear only in the
// ranking; `left` is `pool − Σ floors`, so no rounding error can leak into how much
// actually leaves the pool.
function rationGrants(desired, pool) {
  const total = desired.reduce((sum, d) => sum + d, 0);
  if (total <= pool) return desired.slice();          // no crunch: everyone is paid in full
  if (pool <= 0) return desired.map(() => 0);         // nothing to share out

  const exact = desired.map((d) => (d * pool) / total);
  const granted = exact.map((v) => Math.floor(v));
  let left = pool - granted.reduce((sum, g) => sum + g, 0);

  const byRemainder = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .filter((r) => desired[r.i] > 0)
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  for (let k = 0; k < byRemainder.length && left > 0; k += 1) {
    granted[byRemainder[k].i] += 1;
    left -= 1;
  }
  return granted;
}

module.exports = {
  BASE_GRANT_PER_GP, DEUTERIUM_INFLUX_PER_CYCLE, POOL_SEED,
  grantFor, rationGrants,
};
