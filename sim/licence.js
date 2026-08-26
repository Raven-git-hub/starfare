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
// WHAT THIS SLICE DOES NOT DO — the fee, the breach check, the four-corner grid, the
// price-linked basic fee, reputation, and the investor market are all later slices.
// The sale PAYS; it charges nothing. With no investors in existence, the `o` share
// simply is not paid out: the Syndicate keeps it (§5's "or, with none, to the
// Syndicate ledger"), so only the owner's share ever leaves the ledger.

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

module.exports = { EQUITY_CEILING, equityOf, isValidEquityPct, ownerFraction, commitmentSale };
