'use strict';

// licence.js — the Syndicate Venture Licence layer. Slice 3a builds exactly one
// bullet of it: **commitment is a SALE, not a tithe**
// (docs/licence-and-price-system.md Part 2; design.md §5 "The Venture Licence Fee",
// the Output-commitment bullet).
//
// THE RULE, in §5's own words: a share of the venture's output is "auto-sold to the
// Syndicate at market rate"; the sale income splits — "the owner keeps `(1 − o)` of
// it, the `o` share going to outside investors — or, with none, to the Syndicate
// ledger". Two things that rule leaves to the build, and this slice pins:
//
//   - **"market rate" is the POSTED price** (`state.prices[good].posted`, sim/prices.js):
//     the two-ticks-lagged value that is already on state when delivery happens at
//     step 1. That is the whole point of the lag — the price a sale executes at is
//     knowable before the tick that sells at it, so it can never be computed from the
//     sale it is pricing.
//   - **the cadence is PER TICK**, not per cycle. §5 says "each cycle" and Part 2 says
//     "per tick"; Part 2's header lists the per-tick sale as *proposed, pending
//     reconciliation at the licence slice*. This IS that slice: per tick wins, because
//     the delivery it pays for is already per tick (the §5 windowed accrual sends toward
//     `Q` every tick). Paying per cycle for goods taken per tick would mean the engine
//     owed the guild money between cycles, which is a debt entity nothing has designed.
//     Recorded in the doc in the same commit, not drifted.
//
// WHAT 3a DID NOT DO — the fee, the breach check, the four-corner grid, reputation and
// the investor market. The sale PAYS; it charges nothing. With no investors in
// existence, the `o` share simply is not paid out: the Syndicate keeps it (§5's "or,
// with none, to the Syndicate ledger"), so only the owner's share ever leaves the ledger.
//
// ── SLICE 3b-i (27-08-26) adds the FEE MATH below ──────────────────────────────────
// design.md §5 "LICENCE FEE MECHANICS — RULED": the basic fee is
//     feeRate × the good's droidless baseline output over one window × the posted
//     price AT SIGNING
// discounted by §5's four-corner commitment × equity grid, both amounts computed ONCE
// at signing and stored on the venture's licence (fixed until renegotiation).
//
// STILL NOT CHARGED. 3b-i computes and locks the number; 3b-ii debits it at the window
// boundary. Nothing in this file moves a credit except `commitmentSale` above.

// The structural equity ceiling — §5: "up to the structural 49% ceiling (the owner
// keeps control by retaining at least 51%)". This is a DESIGN number, not a tuning
// one: it is what makes the owner's control non-negotiable. Not `[FIRST-CUT]`.
const EQUITY_CEILING = 0.49;

// equityOf(venture) -> the venture's offered equity share `o`, 0 when it has none.
// The field is ABSENT on a venture that offered nothing (see createVenture), so this
// is the one place that absence is read as zero.
function equityOf(venture) {
  return (venture && venture.equityPct) || 0;
}

// isValidEquityPct(value) -> is this a legal `o`? A fraction in [0, EQUITY_CEILING].
// Used by the establish action to REFUSE an out-of-range offer rather than silently
// clamp it: a clamped 0.8 would be the engine quietly rewriting the terms the player
// agreed to, and a licence whose terms are not what you set is worse than a rejection.
function isValidEquityPct(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= EQUITY_CEILING;
}

// ownerFraction(ventures, good) -> the share of a good's sale proceeds the OWNER
// keeps, = the commitment-weighted mean of `(1 − o)` over the ventures committing
// that good in this system.
//
// WHY WEIGHTED: the delivery is per GOOD (the §5 windowed accrual sends toward the
// per-good aggregate `Q` = Σ `Venture.syndicateCommitment` over the mines producing
// it), while equity is per VENTURE. So a good's delivered units are, by the same
// arithmetic that built `Q`, each venture's commitment share of the total — and the
// proceeds split follows those shares. With one venture (or several sharing an
// equity offer) this reduces to plain `(1 − o)`.
//
// The weight is the raw commitment, which equals its `Q` contribution only while
// `windowFraction` is pinned to 1 (sim/windows.js). That pin has its own tripwire —
// if a mid-window join is ever wired without the pro-rate, that tripwire goes red
// and this weight needs the same fraction applied.
//
// Delivered units with no committing venture at all cannot happen (`Q` is built from
// those very commitments), but if they somehow did, the owner keeps the lot rather
// than the engine quietly pocketing goods it can't attribute.
function ownerFraction(ventures, good) {
  let weight = 0;
  let ownerWeight = 0;
  for (const v of ventures) {
    if (v.resourceType !== good) continue;
    const commitment = v.syndicateCommitment || 0;
    if (commitment <= 0) continue;
    weight += commitment;
    ownerWeight += commitment * (1 - equityOf(v));
  }
  return weight > 0 ? ownerWeight / weight : 1;
}

// commitmentSale({ ventures, good, delivered, price }) -> { gross, ownerCredits }
//
//   `gross`        — the full sale value, `delivered × price` (a float: the price is a
//                    rate, the units are integer). Telemetry only; it never moves.
//   `ownerCredits` — the INTEGER credits the owner guild is paid, and — identically —
//                    the integer the Syndicate ledger is debited by.
//
// THE ROUNDING RULE (§15.2 integer credits; #43 "round(qty × price), identical both
// sides"): round exactly ONCE, at the end, with `Math.round`, and use that single
// integer for BOTH legs. Because the guild's gain and the ledger's debit are the same
// number by construction, invariant 2 holds to the credit — there is no second
// rounding anywhere for a half-credit to escape through. The `o` share is never
// rounded because it is never moved: it is simply the part of `gross` that stays in
// the ledger, so it can carry a fraction without anyone's balance doing so.
//
// Pure: reads its arguments, mutates nothing.
function commitmentSale({ ventures, good, delivered, price }) {
  const gross = delivered * price;
  return { gross, ownerCredits: Math.round(ownerFraction(ventures, good) * gross) };
}


// --- The fee (Slice 3b-i) --------------------------------------------------------

// [FIRST-CUT] the fee RATE: the basic fee is this fraction of what the venture's
// droidless baseline output over one window is worth, at the price locked at signing.
// A tenth means the licence's headline cost is a tenth of the thing it licenses,
// measured on the same window the fee is charged over — visible but survivable, and an
// easy number to reason from when tuning. It scales with the window: if `N` moves from
// its own [FIRST-CUT] 24 to the ruled-day 1,440, the fee and the income it is measured
// against scale together. Recorded in docs/phase-1-tuning.md; open at #56.
const FEE_RATE = 0.10;

// [FIRST-CUT] §5's four corners, as percentages of the basic fee:
//                   | offer min | offer max
//   commit min      |    100    |    75
//   commit max      |     75    |     0
// "Each lever alone buys 25 points of relief; together they buy 100 — the last half
// exists only when both are pulled." The design statement is these four readable
// numbers, NOT a fitted curve: tuning is editing this table, and making it asymmetric
// (say 70/80) is free — it says the Syndicate values output over openness, with no
// change to the formula below.
const CORNERS = Object.freeze({
  minCommitMinOffer: 100,
  minCommitMaxOffer: 75,
  maxCommitMinOffer: 75,
  maxCommitMaxOffer: 0,
});

// [FIRST-CUT] the equity shaping exponent (§5: `o' = o^k`, `k > 1`, first cut 2). Low
// equity buys proportionally little relief and the payoff ACCELERATES toward the 49%
// ceiling — deep entanglement is rewarded over toe-dipping. The corners are untouched
// by it (`0^k = 0`, `1^k = 1`), so the table above still states them exactly and the
// plain bilinear grid stays the un-shaped reference. Commitment stays LINEAR — its own
// shaping exponent is an available, unused option (§5).
const EQUITY_SHAPE_K = 2;

// [FIRST-CUT] the minimum commitment a licence may carry, as a fraction. RULED at 0%
// (§5's "LICENCE FEE MECHANICS": a licensed venture may commit nothing and simply pay
// the full fee for the licence's other benefits — which is also what reconciles the
// grid table's "5%" row header: `c = 0` maps to whatever this floor is). It is kept as
// a named constant, not inlined, precisely because the grid's `c` axis is normalised
// against it: move the floor and the whole commitment axis re-normalises for free.
const COMMITMENT_FLOOR = 0;

// [FIRST-CUT] §5's renegotiation-window bounds, in days (open question #64). Stored on
// the licence at signing; RESOLVING it to a tick — and letting either side reopen the
// terms once it elapses — is renegotiation, which this slice does not build.
const WINDOW_DAYS_MIN = 7;
const WINDOW_DAYS_MAX = 42;

// feeFraction(c, oNorm) -> the share of the basic fee actually payable, in [0, 1].
// §5's bilinear interpolation over the four corners, with the equity axis shaped:
//
//   fee% = 100·(1−c)(1−o') + 75·c(1−o') + 75·(1−c)·o' + 0·c·o'     where o' = oNorm^k
//
// `c` and `oNorm` are the NORMALISED axes (both 0 at the minimum offer, 1 at the
// maximum) — see licenceFee for how the stored terms map onto them. Pure arithmetic.
function feeFraction(c, oNorm) {
  const o = oNorm ** EQUITY_SHAPE_K;
  const pct = (CORNERS.minCommitMinOffer * (1 - c) * (1 - o))
    + (CORNERS.maxCommitMinOffer * c * (1 - o))
    + (CORNERS.minCommitMaxOffer * (1 - c) * o)
    + (CORNERS.maxCommitMaxOffer * c * o);
  return pct / 100;
}

// normalisedTerms({ committedOutputPct, equityPct }) -> { c, oNorm }, the two grid axes.
// `c` runs from 0 at the commitment FLOOR to 1 at a full commitment; `oNorm` from 0 at
// no equity to 1 at the 49% ceiling. Both are clamped into [0, 1] as a last resort —
// the establish and apply actions refuse out-of-range terms outright, and the tick
// asserts them, so a clamp here should be unreachable; it exists so that a fee can
// never be computed from a nonsense axis if one ever slips through.
function normalisedTerms({ committedOutputPct, equityPct }) {
  const span = 1 - COMMITMENT_FLOOR;
  const c = span > 0 ? (committedOutputPct - COMMITMENT_FLOOR) / span : 1;
  return {
    c: Math.max(0, Math.min(1, c)),
    oNorm: Math.max(0, Math.min(1, (equityPct || 0) / EQUITY_CEILING)),
  };
}

// licenceFee({ baselineUnitsPerTick, windowN, lockedPrice, committedOutputPct, equityPct })
//   -> { basicFee, discountedFee }, both INTEGER credits (§15.2)
//
//   basicFee      = round( FEE_RATE × baseline output over one window × the locked price )
//   discountedFee = round( basicFee × feeFraction(c, oNorm) )
//
// THE BASIS IS THE BASELINE, never `productionRate` (§5, "LICENCE FEE MECHANICS"): the
// fee is priced off what the venture's TYPE can make droidless (sim/baseline.js), so
// throttling the mine cannot shrink the fee and droids cannot inflate it. The price is
// the POSTED one at signing and is stored with the licence, so the fee is fixed until
// renegotiation however far the market moves afterwards — which is what makes timing
// your signature a real decision (§5: "rewards reading the market and timing your lock").
//
// Rounded twice on purpose, and safely: these are two SEPARATE stored quantities, not
// two halves of one movement, so unlike the sale's single-rounding rule there is no
// conservation to preserve here — nothing moves until 3b-ii debits one of them, and
// whichever it debits is already a whole number of credits.
function licenceFee({ baselineUnitsPerTick, windowN, lockedPrice, committedOutputPct, equityPct }) {
  const basicFee = Math.round(FEE_RATE * baselineUnitsPerTick * windowN * lockedPrice);
  const { c, oNorm } = normalisedTerms({ committedOutputPct, equityPct });
  return { basicFee, discountedFee: Math.round(basicFee * feeFraction(c, oNorm)) };
}

// isValidCommitmentPct(value) -> a fraction from the floor up to a full commitment.
function isValidCommitmentPct(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= COMMITMENT_FLOOR && value <= 1;
}

// isValidWindowDays(value) -> a whole number of days inside §5's renegotiation bounds.
function isValidWindowDays(value) {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= WINDOW_DAYS_MIN && value <= WINDOW_DAYS_MAX;
}

// commitmentUnitsFor(pct, baselineUnitsPerTick, windowN) -> the venture's committed
// quantity per window, in whole units — the operative number the §5 window accrual and
// 3a's sale already read off `Venture.syndicateCommitment`. It is a share of the
// BASELINE over one window, so it is exactly the quantity a droidless venture running
// flat out could deliver at `pct` of its capacity.
function commitmentUnitsFor(pct, baselineUnitsPerTick, windowN) {
  return Math.round(pct * baselineUnitsPerTick * windowN);
}

module.exports = {
  EQUITY_CEILING, equityOf, isValidEquityPct, ownerFraction, commitmentSale,
  FEE_RATE, CORNERS, EQUITY_SHAPE_K, COMMITMENT_FLOOR, WINDOW_DAYS_MIN, WINDOW_DAYS_MAX,
  feeFraction, normalisedTerms, licenceFee, isValidCommitmentPct, isValidWindowDays,
  commitmentUnitsFor,
};
