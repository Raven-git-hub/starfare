'use strict';

// issuance.js — FUEL FLOWS: the Syndicate's per-cycle supply into the pool, and the
// size-based grants out of it.
//
// docs/fuel-supply-and-allocation.md §2.1 (the issuance mechanic — the ruling for this
// slice), §1.1 (the abstracted influx), §1.3 (the seeded pool), §4.1 (the crunch edge),
// §4.2 (price mediation, slice 5b-i). Numbers in phase-1-tuning.md §"Fuel — the pool &
// issuance".
//
//     entitlement(guild) = round( BASE_GRANT_PER_GP × GP(guild) × issuanceModifier(guild) )
//     fuelGranted(guild) = round( entitlement × REFERENCE_FUEL_PRICE / reserve.fuelPrice )
//
// THE SECOND LINE IS SLICE 5b-i (01-09-26) and it is the price lever: an entitlement is
// what reputation-against-size earns you AT THE REFERENCE PRICE, and what it BUYS depends
// on what fuel currently costs.
//
// AND SLICE 5b-ii (01-09-26) MAKES THAT PRICE LIVE — the third line, and the one that
// closes the loop:
//
//     nextPrice = clamp( REFERENCE_FUEL_PRICE × (TARGET_CYCLES·avgDraw / reserveLevel)^s,
//                        PRICE_FLOOR, PRICE_CEIL )
//
// THE POOL IS ITS OWN INTEGRATOR, which is the idea the whole controller rests on. Nobody
// computes an equilibrium price and nobody could: it depends on how many guilds there are,
// how big they are and how well they are doing, all of which move. Instead the pool
// REMEMBERS the imbalance — every cycle that draws more than the influx leaves the level
// lower, which raises the price, which shrinks next cycle's grants. The loop settles
// exactly where total draw equals the influx, whatever galaxy it is running in. That is why
// the target is DEMAND-RELATIVE (`TARGET_CYCLES × avgDraw`) rather than an absolute number
// of units: a 3-guild galaxy and a 30-guild one behave identically.
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
const { REFERENCE_FUEL_PRICE } = require('./fuel.js');

// BASE_GRANT_PER_GP — fuel per Guild Point per cycle, at modifier 1.0.
//
// `[FIRST-CUT]` 0.3. The base is SIZE-RELATIVE by ruling (§2.1): a bigger footprint draws
// a bigger base, and the mean-line modifier then scales it by how well the guild
// contributes *relative to* that size. GP is therefore both the base AND the divisor
// inside the modifier's expected line, which is exactly "draw sized by
// reputation-against-size". A par guild (GP 500, modifier ~1.0) draws ~150 a cycle; an
// over-expanded one draws its base × 0.3.
//
// ⤳ RE-BASED 01-09-26 (5 → 0.3) BY THE GP RESCALE, points-and-reputation.md §2.6, and this
// is a RE-DENOMINATION, not a retune — the one place the reputation rescale reaches
// outside the reputation layer, and it had to.
//
// WHY IT WAS FORCED. This constant is denominated *per Guild Point*, and §2.6 changed what
// a Guild Point IS: `W_SYS` went 12 → 200, so an unchanged 5 would have multiplied every
// guild's entitlement by ~16.7 against an unmoved `DEUTERIUM_INFLUX_PER_CYCLE`. The
// reference galaxy's draw went to ~16 450 a cycle against a supply of 800, needing a
// settled price of ~206 to hold it — five times `PRICE_CEIL`. Every galaxy, down to the
// smallest possible founded guild (GP 300 → 1500 a cycle), would have sat in permanent
// crunch with the controller pinned and unable to answer. Not a tuning question: the unit
// moved, so the number denominated in it has to move with it or it means something else.
//
// AND IT IS DERIVED, NOT CHOSEN (§18 #5). `0.3 = 5 × (W_SYS_old / W_SYS_new) = 5 × 12/200`
// — the same ratio, in the new units. Its effect is a NO-OP by construction wherever the
// GP weights merely re-denominated: a held system still draws exactly 60 fuel a cycle at
// par (12×5 = 200×0.3) and a tier-1 mine exactly 30 (6×5 = 100×0.3). The one place it is
// NOT a no-op is tier 2, which draws 45 instead of 40 — and that +12.5% is not drift, it
// IS §2.6's deliberately widened 1 : 1.5 tier spread arriving in the fuel layer, which is
// exactly where the ruling wants the reward for climbing the tree to show up.
//
// A SANCTIONED FLOAT, on the same footing as `issuanceModifier` beside it: it is a
// COEFFICIENT that scales a quantity, not itself a count of fuel, and `grantFor` already
// rounds at the one point where a float meets integer fuel (§15.2). Nothing downstream
// changed to accommodate it.
//
// A demand/consumption-relative base is a possible later refinement, deferred to 5b —
// which builds the consumption tracking it would need anyway.
const BASE_GRANT_PER_GP = 0.3;

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

// ── THE PRICE CONTROLLER'S FIVE COEFFICIENTS (slice 5b-ii, §4.2) ─────────────────────
//
// `[FIRST-CUT]`, and — unusually for this repo — **MODELLED rather than picked**. They come
// from a discrete simulation of the pool dynamics validated against the recorder's REAL
// integer grants, and their workings are in docs/phase-1-tuning.md, which is where a
// retune reads them from. Nothing here invents a number, and there is deliberately no
// sixth: `basePrice` is `REFERENCE_FUEL_PRICE` (so the price sits exactly at the reference
// when the pool is exactly at target) rather than a new base-price constant of its own.

// PRICE_SENSITIVITY — how steeply the price answers a pool that is off target.
//
// `[FIRST-CUT]` 1.5. The exponent on the level ratio. The model converges with ZERO
// oscillation for s ≤ ~2.0 and starts to ripple at s ≥ 3, so this sits with room to spare;
// it also decides how far the settled pool sits from target (a gentler curve needs a bigger
// gap to hold the same price).
const PRICE_SENSITIVITY = 1.5;

// TARGET_CYCLES — the target reserve, in CYCLES OF DRAW rather than units.
//
// `[FIRST-CUT]` 3: hold three cycles' worth of what the galaxy actually draws. This is the
// scale-invariance: the setpoint is demand-relative, so it is the same rule for a galaxy of
// three guilds and one of thirty. It sets where the pool settles — bigger is a fatter
// buffer, smaller a leaner one.
const TARGET_CYCLES = 3;

// DRAW_EMA_ALPHA — how fast the trailing draw average follows the galaxy's real demand.
//
// `[FIRST-CUT]` 0.22: `avgDraw = α·draw + (1−α)·avgDraw`, roughly an 8-cycle window. The
// average is what stops the target chasing one cycle's noise — a guild founding, a venture
// landing, a modifier stepping — while still tracking a real change in the galaxy's size.
const DRAW_EMA_ALPHA = 0.22;

// PRICE_FLOOR / PRICE_CEIL — the bounds the curve is clamped to.
//
// `[FIRST-CUT]` 2 and 40. Modelled equilibrium prices run ~2–30 across galaxies drawing
// 0.2×–3× the influx, so the bracket contains the whole healthy band and only bites at the
// extremes. The CEILING is where the crunch edge lives (§4.1): a galaxy whose demand
// exceeds what a price of 40 can throttle pins there and rations, which is correct — a fuel
// crisis SHOULD feel like rationing.
//
// ⚠ THE FLOOR IS ALSO A SAFETY PROPERTY, not just a game number. `physicalGrantFor` divides
// by the price and throws on a price that is not `> 0` (slice 5b-i's guard, written when
// nothing yet wrote the field). `PRICE_FLOOR > 0` is what makes that guard UNREACHABLE from
// a controller-written price: the controller cannot produce a zero. The guard stays anyway
// — it now covers a hand-built fixture or a future writer, not the controller.
const PRICE_FLOOR = 2;
const PRICE_CEIL = 40;

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

// physicalGrantFor(state, guild) -> the PHYSICAL FUEL this guild is due, an integer ≥ 0.
//
// THE PRICE MEDIATION (docs/fuel-supply-and-allocation.md §4.2, slice 5b-i). `grantFor`
// above is the ENTITLEMENT — what a guild is due AT THE REFERENCE PRICE, sized by
// reputation-against-size and nothing else. This converts that entitlement into fuel at
// the price the market is actually charging:
//
//     physical = round( entitlement × REFERENCE_FUEL_PRICE / reserve.fuelPrice )
//
// so the same reputation buys LESS fuel when fuel is expensive. That is the whole lever:
// 5a had a fixed influx against a draw that answered to nothing, so a galaxy that
// out-drew its supply rationed forever. Price is what pulls draw back under supply, and
// 5b-ii's controller does nothing but move this one number.
//
// ⚠ THE RATIO FORM, NOT A RE-BASED PRODUCT, and it is not a stylistic preference. The
// alternative — folding the price into the original product as `round(BASE_GRANT_PER_GP ×
// GP × modifier / price × REFERENCE)` — is algebraically the same and NUMERICALLY IS NOT:
// float multiplication does not reassociate, so it lands a unit either side of `grantFor`
// in about 0.3% of GP/modifier cases. Scaling the ALREADY-ROUNDED entitlement means that
// at the seed price the factor is exactly 1.0, `round(entitlement × 1)` is the entitlement
// itself, and 5b-i is byte-identical to 5a — which is the whole claim this slice makes.
// A test pins the distinction on the cases where the two forms disagree.
//
// THE PRICE MUST BE A POSITIVE, FINITE NUMBER, asserted rather than trusted. Nothing in
// 5b-i can move it off the seed, which is exactly why the guard is worth having now: a
// zero or negative price would silently hand out Infinity/NaN/negative fuel, and a NaN
// grant would sail past `rationGrants` and land in a hoard before any invariant looked
// (§15.5 — a silent violation is worse than a crash). 5b-ii's floor will make the
// controller respect this; until then, the guard is what says so.
//
// PURE: reads the entitlement and the price, mutates nothing.
function physicalGrantFor(state, guild) {
  const price = state.reserve.fuelPrice;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`physicalGrantFor: reserve.fuelPrice must be a finite number > 0, got ${price}`);
  }
  return Math.round(grantFor(state, guild) * REFERENCE_FUEL_PRICE / price);
}

// ── THE CONTROLLER (slice 5b-ii) ─────────────────────────────────────────────────────
//
// Three small pure functions, deliberately separate rather than one that takes `state`:
// each is a single rule, each is testable on its own, and none of them touches state or
// knows where a galaxy keeps it. The tick step is what wires them together, and it is the
// only place the order between them is decided.

// targetReserve(avgDraw) -> the reserve level the controller is steering the pool TO.
//
// `TARGET_CYCLES × avgDraw` — "hold three cycles' worth of what this galaxy actually
// draws". THE ONE DEFINITION OF THE TARGET (§15.5 invariant 5): the curve below reads it,
// the snapshot publishes it, and the recorder shows it, all from here — nobody multiplies
// by `TARGET_CYCLES` a second time.
function targetReserve(avgDraw) {
  return TARGET_CYCLES * avgDraw;
}

// nextAvgDraw(avgDraw, cycleDemand) -> the updated trailing average of galaxy demand.
//
// A plain EMA, `α·demand + (1−α)·avgDraw`. A float by nature (§15.2's sanctioned
// non-integer: it AVERAGES a quantity, it does not count one), so it is not rounded — the
// rounding to integer fuel happens where fuel is granted, not here.
//
// ⚠ `cycleDemand` IS Σ DESIRED, NOT Σ GRANTED. Granted is clipped by the pool; desired is
// what the galaxy actually wants at the current price. If the average followed GRANTS, a
// galaxy in shortfall would report falling demand precisely because it was being starved,
// the demand-relative target would shrink with it, and the price would ease exactly when the
// shortfall was worst. Outside a crunch the two readings are identical, so this only ever
// bites at the edge — and it bites hardest in a PARTIAL shortfall, where the price still has
// room to move (at a fully empty pool both readings clamp to the ceiling anyway).
function nextAvgDraw(avgDraw, cycleDemand) {
  return DRAW_EMA_ALPHA * cycleDemand + (1 - DRAW_EMA_ALPHA) * avgDraw;
}

// nextFuelPrice(reserveLevel, avgDraw) -> the price NEXT cycle issues at.
//
//     clamp( REFERENCE_FUEL_PRICE × (target / reserveLevel)^PRICE_SENSITIVITY,
//            PRICE_FLOOR, PRICE_CEIL )
//
// Pool AT target ⇒ the ratio is 1 ⇒ the price is exactly `REFERENCE_FUEL_PRICE`, which is
// why the reference doubles as the base price and no new base number was needed. Pool BELOW
// target (draining) ⇒ ratio > 1 ⇒ the price RISES, so the same entitlement buys less and
// draw falls. Pool ABOVE target (filling) ⇒ the price FALLS and the economy is allowed to
// grow. That sign is the feedback; getting it backwards would amplify a crunch instead of
// easing it, and a test pins it in both directions.
//
// `Math.max(1, reserveLevel)` is the divide-by-zero guard, and 1 rather than a tuned
// epsilon because the pool is INTEGER fuel: 1 is the smallest non-zero level it can
// actually hold, so this is the pool's own next value up, not a number chosen for the
// arithmetic. An empty pool therefore reads as "maximally short" and the clamp takes the
// answer to `PRICE_CEIL`, which is exactly right.
//
// PURE, and it takes the level and the average rather than `state`: the same discipline
// `fuelValue` follows in sim/fuel.js. The CALLER decides which level to pass — the tick
// passes the POST-issuance pool, this cycle's realised level (§4.2).
function nextFuelPrice(reserveLevel, avgDraw) {
  const ratio = targetReserve(avgDraw) / Math.max(1, reserveLevel);
  const raw = REFERENCE_FUEL_PRICE * (ratio ** PRICE_SENSITIVITY);
  return Math.min(PRICE_CEIL, Math.max(PRICE_FLOOR, raw));
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
  PRICE_SENSITIVITY, TARGET_CYCLES, DRAW_EMA_ALPHA, PRICE_FLOOR, PRICE_CEIL,
  grantFor, physicalGrantFor, rationGrants,
  targetReserve, nextAvgDraw, nextFuelPrice,
};
