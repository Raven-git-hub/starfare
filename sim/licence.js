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
// 3b-i computes and locks the number; **Slice 3b-iii (28-08-26) CHARGES it** — `feeOwed`
// below is the per-venture arithmetic, and sim/tick.js sums a guild's oweds into the one
// boundary debit (the fee charge was renumbered when 3b-ii became the mid-window
// pro-rate). This file still moves no credit itself: `commitmentSale` and `feeOwed` both
// return numbers, and the tick is the only place a balance changes.

const { windowFraction } = require('./windows.js');
const { producedGoodFor } = require('./baseline.js');
const { tierWeight, tierOf } = require('./points.js');

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

// committedContribution(venture, windowStart, N) -> the venture's contribution, in
// units, to its good's aggregate window target `Q` = `syndicateCommitment ×
// windowFraction` (§5's windowed accrual + the Option-A join pro-rate).
//
// ONE SOURCE OF TRUTH, and that is the whole reason it exists. This quantity has two
// consumers — `resolveProduction` sums it into `Q` (sim/production.js) and
// `ownerFraction` below weights the sale's proceeds split by it — and until this slice
// each computed it for itself. They agreed only while `windowFraction` was pinned to 1;
// the moment the mid-window pro-rate went live (Slice 3b-ii) they drifted, and the sale
// paid a split weighted by a target nobody was actually delivering against. Two
// computations of one quantity is the bug; a second multiplication in the second place
// would only have been the same bug written twice, so the duplication is what got fixed.
//
// A non-positive or absent commitment contributes 0 — the same skip `ownerFraction`
// has always made, kept HERE so both consumers agree on sign as well as on magnitude.
// A negative `syndicateCommitment` would otherwise SUBTRACT from its good's aggregate
// and silently shrink a sibling mine's target; the tick asserts it can't be one
// (sim/invariants.js), and this is the belt to that braces.
function committedContribution(venture, windowStart, N) {
  const commitment = (venture && venture.syndicateCommitment) || 0;
  if (commitment <= 0) return 0;
  return commitment * windowFraction(venture, windowStart, N);
}

// ownerFraction(ventures, good, windowStart, N) -> the share of a good's sale proceeds
// the OWNER keeps, = the contribution-weighted mean of `(1 − o)` over the ventures
// committing that good in this system.
//
// WHY WEIGHTED: the delivery is per GOOD (the §5 windowed accrual sends toward the
// per-good aggregate `Q` = Σ `committedContribution` over the ventures producing it),
// while equity is per VENTURE. So a good's delivered units are, by the same arithmetic
// that built `Q`, each venture's contribution share of the total — and the proceeds
// split follows those shares. With one venture (or several sharing an equity offer)
// this reduces to plain `(1 − o)`.
//
// THE WEIGHT IS THE CONTRIBUTION, NOT THE RAW COMMITMENT. A mine licensed mid-window
// owes — and therefore supplies — only its pro-rated share of `Q`, so that share is
// what its equity terms are entitled to price. Weighting by the raw commitment
// over-counts a mid-window joiner against its full-window siblings and mis-splits the
// proceeds, silently: invariant 2 still balances (the guild's gain and the ledger's
// debit are one number by construction), only the line between the owner's keep and
// the ledger's `o` share moves. That was the live bug this slice fixes; the fixture
// that pins it is sim/tests/multi-venture-commitment.test.js.
//
// ── TWO ATTRIBUTIONS, TWO CLOCKS — read this before "fixing" the split ─────────────
// The engine attributes committed goods to ventures in two DIFFERENT places, on two
// different clocks, and they are not meant to agree (§5):
//
//   - THE SALE (here) is PER TICK. Each tick's delivered units are attributed
//     PROPORTIONALLY, by `committedContribution`, purely to price the equity (`o`)
//     share — money for goods. It is proportional because the units really are
//     co-mingled: one pot, one delivery, several contributors.
//   - THE FEE (the coming distribution slice) is PER WINDOW. At the boundary the
//     window's whole delivered pile fills the licensed ventures in the player's
//     PURSUE ORDER, each to its full commitment before the next is fed, and each is
//     then met (discounted fee) or breached (full fee) — which contracts you
//     honoured. The N-4 ruling makes that a boundary-total-pile operation.
//
// So the proportional weight here is the FINAL answer for the sale. It is not a
// placeholder for the pursue fill and is not superseded by the distribution slice:
// making the per-tick sale follow the per-window pursue order would price money-for-
// goods by a ranking that does not exist until the boundary, and cannot be known on
// the tick the goods are actually handed over.
//
// Delivered units with no committing venture at all cannot happen (`Q` is built from
// those very commitments), but if they somehow did, the owner keeps the lot rather
// than the engine quietly pocketing goods it can't attribute.
// THE PRODUCER TEST IS `producedGoodFor`, NOT `v.resourceType` (factory-commitment
// slice, 28-08-26). It used to be the latter, which was right only while commitment was
// mines-only: a committed FACTORY would match nothing, the weight would sum to 0, and
// this would return the fallback 1 — the owner silently keeping 100% of a sale whose
// equity terms said otherwise. It is the SAME function the resolver keys `Q` on, so the
// split can never be weighted over a different set of ventures than the target it pays.
function ownerFraction(ventures, good, windowStart, N) {
  let weight = 0;
  let ownerWeight = 0;
  for (const v of ventures) {
    if (producedGoodFor(v) !== good) continue;
    const contribution = committedContribution(v, windowStart, N);
    if (contribution <= 0) continue;
    weight += contribution;
    ownerWeight += contribution * (1 - equityOf(v));
  }
  return weight > 0 ? ownerWeight / weight : 1;
}

// commitmentSale({ ventures, good, delivered, price, windowStart, windowN })
//   -> { gross, ownerCredits }
//
//   `gross`        — the full sale value, `delivered × price` (a float: the price is a
//                    rate, the units are integer). Telemetry only; it never moves.
//   `ownerCredits` — the INTEGER credits the owner guild is paid, and — identically —
//                    the integer the Syndicate ledger is debited by.
//
// `windowStart`/`windowN` identify the window the delivery happened in — the SAME pair
// the resolver used to build `Q` that tick (applyProduction passes them from the one
// producing tick both are derived from), so the split can never be weighted against a
// different window than the one it is paying for.
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
function commitmentSale({ ventures, good, delivered, price, windowStart, windowN }) {
  const gross = delivered * price;
  return { gross, ownerCredits: Math.round(ownerFraction(ventures, good, windowStart, windowN) * gross) };
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
// conservation to preserve here — nothing moves until 3b-iii debits one of them, and
// whichever it debits is already a whole number of credits.
function licenceFee({ baselineUnitsPerTick, windowN, lockedPrice, committedOutputPct, equityPct }) {
  const basicFee = Math.round(FEE_RATE * baselineUnitsPerTick * windowN * lockedPrice);
  const { c, oNorm } = normalisedTerms({ committedOutputPct, equityPct });
  return { basicFee, discountedFee: Math.round(basicFee * feeFraction(c, oNorm)) };
}

// --- The charge (Slice 3b-iii) ---------------------------------------------------

// feeOwed(licence, status, fraction) -> the INTEGER credits ONE licensed venture owes at
// ONE window boundary. §5 "LICENCE FEE MECHANICS", verbatim:
//     round((met ? discountedFee : basicFee) × windowFraction)
//
// BREACH VOIDS THE DISCOUNT, and it is BINARY: a venture one unit short of its target
// pays the FULL basic fee, exactly as one that delivered nothing does. There is no
// partial-delivery credit anywhere in this function, and that absence is the rule.
//
// THE FRACTION IS THE SAME ONE THE TARGET WAS PRO-RATED BY (`windowFraction`,
// sim/windows.js) — §5: "One fraction (time present), applied once to the target and
// once to the fee." It is 1 for every full window, so only a mid-joiner's FIRST window
// is scaled, and it is scaled by the very number that decided what it owed in goods.
// The caller must pass the fraction for the window the verdict was computed against;
// passing a different window would price a verdict that was never reached.
//
// The fees themselves are NOT recomputed here. They are the integers locked on the
// licence at signing (Slice 3b-i) and stay fixed until renegotiation (#64), so this
// slice reads and never re-prices — one rounding, over a fraction that is usually 1.
//
// A status that is not a boundary verdict THROWS rather than quietly returning 0: a fee
// is only ever owed at a boundary, so an `accruing` reaching here would mean the charge
// fired on a tick where nothing was judged — and a silent 0 would under-charge forever
// without a single test going red (§15.5: a silent violation is worse than a crash).
function feeOwed(licence, status, fraction) {
  if (status !== 'met' && status !== 'breach') {
    throw new Error(`feeOwed: a licence fee is owed only on a boundary verdict — got status "${status}"`);
  }
  const due = status === 'met' ? licence.discountedFee : licence.basicFee;
  return Math.round(due * fraction);
}

// ── REPUTATION: the band arithmetic (RP slice 2, 31-08-26) ──────────────────────
//
// docs/points-and-reputation.md §2.1 (the band), §2.2 (the two outcomes + the slice-2
// arithmetic ruling) and §2.3 (the gain taper). Reputation Points are a PER-VENTURE
// running total (`venture.reputation`) summed into `guild.guildReputation`, and they have
// exactly ONE mover: the boundary verdict a licence is already judged on. That is
// design.md §15.5 invariant 8 made structural — "reputation moves only on measurable
// events ... never on vibes" — because the only event that can move RP is the same
// `status` the fee is charged on, read from the same row, in the same loop.
//
// WHY THE MAGNITUDES LIVE HERE. points-and-reputation.md §4 rules the seam in one line:
// "the LICENCE LAYER owns how RP MOVES ... the FUEL LAYER ... READS `guild.guildReputation`;
// it does not author it." meet/breach is how RP moves, so it is licence-layer, and it
// belongs beside `feeOwed` — the other consumer of the very same verdict.
//
// SLICE 2 RETIRED THE FLAT PLACEHOLDERS. `REP_MEET_FLAT` = 20 and `REP_BREACH_FLAT` = 30
// were slice 1's "make it move" stand-ins, explicitly never a first cut at this. They are
// GONE, not deprecated: nothing reads a flat magnitude any more.
//
// EVERY NUMBER BELOW IS `[FIRST-CUT]` AND RULED, not invented — phase-1-tuning.md
// §"Points & Reputation", promoted from `[SHEET]` by the 31-08-26 design pass. Tuned in
// play; each lives here ONCE and is never inlined.

// The MET-GAIN model — the deploy meter made real (§2.2; phase-1-tuning §"Points &
// Reputation"). A met cycle is worth `REP_MEET_MAX`, scaled by the TERMS the venture
// signed — how much output it promised, and how much equity it offered — and by the TIER
// it produces at. The terms weights sum to 1, so full terms at tier 1 score the maximum
// exactly: **+10 a cycle**.
//
// YOU EARN RP FOR CONTRIBUTING, NEVER FOR OWNING (§2). A venture that committed nothing
// and offered nothing scores 0 for "meeting" a promise of nothing — that falls out of
// this formula rather than needing a special case, and it is the whole reason the gain is
// terms-scaled instead of flat.
//
// ⤳ RESCALED 01-09-26 (100 → 10), points-and-reputation.md §2.6: RP and GP now share one
// small integer scale (`MEANLINE_K = 1`, sim/meanline.js), so the earn rate shrank ×10
// with everything else.
//
// The client's Establish-Venture meter (`repGain` in client/game.html, `[FIRST-CUT]`
// REP_MAX/REP_WC/REP_WO) is the SAME arithmetic; this slice makes the engine the
// authority for it. Wiring the panel to read the engine's number is a later UI slice —
// deliberately NOT done here, so the panel's reputation copy stays mock for now.
const REP_MEET_MAX = 10;
const REP_W_COMMIT = 0.5;
const REP_W_EQUITY = 0.5;

// The BREACH-DROP model — LINEAR and INVERSE to commitment (§2.2). Breaching a *small*
// commitment hurts MORE than breaching a large one: breaking a token promise is contempt,
// falling short of an ambitious one is forgivable. At tier 1, −2.5 at a full commitment,
// rising toward −10 as the commitment approaches nothing.
//
// −10 IS A LIMIT, NEVER PAID: §5's 0% commitment floor means a 0% licence owes zero units
// and is therefore always `met`, so the c→0 end of this line is approached and never
// reached. The constant is still the honest endpoint of the formula, not a magic number.
//
// ⤳ RESCALED 01-09-26 (100 / 10 → 10 / 2.5), points-and-reputation.md §2.6, and the two
// halves moved for DIFFERENT reasons. `MAX` fell ×10 with the RP scale, like everything
// else. `MIN` did not: it was deliberately **lifted from 10% of MAX to 25%**, so the
// gentlest breach costs −2.5 · tierFactor rather than −1. That firms the cheap end of the
// curve without flipping it — the Syndicate still does not punish a guild that commits
// maximally and narrowly falls short (maximum commitment already costs it all its
// delivered output) — and it is what will blunt the sign-at-100%-grab-the-bump-then-breach
// exploit the signing bump opens in slice 2. Whether 25% is enough is `[FIRST-CUT]`.
//
// `REP_BREACH_MIN` IS A SANCTIONED FLOAT, like `REP_W_COMMIT` beside it: it is a
// COEFFICIENT in a formula, not a counted quantity, and the `Math.round` in
// `breachPenalty` is what keeps the RP that actually lands an integer (§15.2).
//
// The discipline on a high commitment lives in CREDITS and CLOSURE, not here: breaching
// one is RP-cheap but fee-expensive (the full basic fee, `feeOwed`) and walks the venture
// toward the −500 floor. *Let the player play how they like.*
const REP_BREACH_MAX = 10;
const REP_BREACH_MIN = 2.5;

// The BAND (§2.1). −500 is the closure threshold and 1500 the organic soft cap; 800 is
// the knee where gains begin to taper. The band edges ARE the licence layer's reputation
// tiers (licence-and-price-system.md §5/§7) — one RP on one scale, by construction, not
// two reputations.
//
// ⚠ THE FLOOR IS A PIN, NOT A CONSEQUENCE. Reaching −500 means the venture sits AT the
// closure threshold; it does not close it. Venture removal, licence revocation and the
// −300 forced-lease offer are a SEPARATE later slice and none of them is built — nothing
// in this file or the tick acts on either threshold beyond clamping the number.
const RP_FLOOR = -500;
const RP_SOFT_CAP = 1500;
const RP_TAPER_KNEE = 800;

// repTerms(venture) -> { commit, equityFrac }, the two axes the RP model scales by, both
// in [0, 1].
//
// `equityFrac` REUSES `normalisedTerms`' `oNorm` — the offered equity over the 0.49
// ceiling — rather than dividing by `EQUITY_CEILING` a second time here. One expression,
// so the RP meter and the fee grid can never come to disagree about what "offered equity"
// normalises to, and the defensive clamp that function already carries is inherited.
//
// `commit` is the STORED `committedOutputPct`, which is what §2.2 and phase-1-tuning name
// — deliberately NOT the fee grid's floor-normalised `c`. The two are identical today
// (`COMMITMENT_FLOOR` is 0, so `c === committedOutputPct`), and binding RP to `c` would
// mean that moving the floor silently moved the reputation model too. Clamped for the
// same last-resort reason `normalisedTerms` clamps: intake refuses out-of-range terms and
// the tick asserts them, so this should be unreachable.
//
// A venture with no licence THROWS rather than scoring 0. Every caller reaches this
// through the tick's fee loop, which has already skipped the licence-less; an unlicensed
// venture arriving here would mean RP moved for a contract that does not exist, and a
// quiet 0 would hide it forever (§15.5: a silent violation is worse than a crash).
function repTerms(venture) {
  const lic = venture && venture.licence;
  if (!lic) {
    throw new Error(`repTerms: reputation is scaled by LICENCE TERMS — venture ${venture && venture.id} has no licence`);
  }
  const { oNorm } = normalisedTerms({ committedOutputPct: lic.committedOutputPct, equityPct: venture.equityPct });
  return {
    commit: Math.max(0, Math.min(1, lic.committedOutputPct)),
    equityFrac: oNorm,
  };
}

// tierFactor(venture) -> how much more RP this venture's tier moves, relative to tier 1.
// 1 at tier 1, 1.5 at tier 2 (3 and 5 when tiers 3 and 4 gain weights).
//
//     W_TIER( tierOf(producedGoodFor(venture)) ) ÷ W_TIER(1)
//
// ⤳ ADDED 01-09-26, points-and-reputation.md §2.6. THE RULING: a higher-tier venture
// earns proportionally more RP per cycle, so **every tier breaks even in the same ~10
// cycles** and climbing the manufacturing tree is a reward — bigger GP, bigger earning,
// bigger dividend — rather than a heavier bar to fill. It scales the breach the same way,
// for the same reason: the stake rises with the tier, both directions.
//
// IT IS A RATIO OF GP WEIGHTS, SOURCED FROM `sim/points.js` — the single source of truth
// for what a tier is worth — and DIVIDED BY THE TIER-1 WEIGHT rather than by a literal
// 100. That is what makes it invent no number (§18 #5): the factor is 1 / 1.5 / 3 / 5
// whatever absolute base the GP weights are later retuned to, and a retune that moved
// `W_T1` without moving this would otherwise silently change every venture's earn rate.
//
// SEAM NOTE — the import direction. licence.js reads points.js, never the reverse
// (points.js requires only claims / baseline / resources), so there is no cycle and no
// shared module was extracted. Duplicating the weight map here was the alternative and is
// exactly the drift §15.2 forbids.
//
// AN UNWEIGHTED TIER HALTS, through `tierWeight`'s own throw — the same stop `guildPoints`
// makes, for the same reason. A tier-3 venture must not quietly earn at the tier-1 rate.
// A venture producing NOTHING (`producedGoodFor` → null) reaches `tierOf(null)` → null and
// halts too, which is right here in a way it is not in `guildPoints`: GP scores a broken
// venture 0 because it produces nothing, but RP only moves for a venture the fee loop has
// already judged met or breached, so one arriving here with no output is a real
// contradiction, not an empty row.
function tierFactor(venture) {
  const good = producedGoodFor(venture);
  const where = { good, ventureId: venture && venture.id, guildId: venture && venture.ownerGuildId };
  return tierWeight(tierOf(good), where) / tierWeight(1, where);
}

// metGain(venture) -> the PRE-TAPER RP a met cycle is worth, a non-negative integer.
//
//     REP_MEET_MAX × tierFactor × (REP_W_COMMIT × commit + REP_W_EQUITY × equityFrac)
//
// Full terms: **+10 a cycle at tier 1, +15 at tier 2.**
//
// Rounded here, and rounded AGAIN by the taper at the call site. Two roundings, and
// unlike the commitment sale's single-rounding rule that is safe: RP is NOT conserved
// (§2 — minted and destroyed by events, no ledger counterpart), so there is no second leg
// for a rounding to drift against. The same reasoning `licenceFee` records for its own
// two roundings. The `tierFactor` is a float (1.5 at tier 2) and this rounding is what
// keeps the RP that lands an integer, §15.2.
function metGain(venture) {
  const { commit, equityFrac } = repTerms(venture);
  return Math.round(
    REP_MEET_MAX * tierFactor(venture) * (REP_W_COMMIT * commit + REP_W_EQUITY * equityFrac),
  );
}

// breachPenalty(venture) -> the RP a breached cycle costs, a NEGATIVE integer.
//
//     −( REP_BREACH_MAX − (REP_BREACH_MAX − REP_BREACH_MIN) × commit ) × tierFactor
//
// Still LINEAR and INVERSE to commitment — the tier scales the whole curve, it does not
// bend it. A tier-1 venture at 100% commitment pays **−3** a cycle (2.5 rounded up in
// magnitude); at tier 2, −4.
//
// The sign is returned, not left to the caller, for the same reason slice 1 put it in one
// place: no consumer can get "breach subtracts" backwards by writing the arithmetic
// itself. Equity does NOT appear — §2.2 scales the drop by commitment alone.
function breachPenalty(venture) {
  const { commit } = repTerms(venture);
  return -Math.round(
    (REP_BREACH_MAX - (REP_BREACH_MAX - REP_BREACH_MIN) * commit) * tierFactor(venture),
  );
}

// gainFactor(rp) -> the §2.3 taper: how much of a gain actually lands, given where the
// venture's reputation already stands.
//
//     clamp( (RP_SOFT_CAP − rp) / (RP_SOFT_CAP − RP_TAPER_KNEE), 0, 1 )
//
// 1.0 at or below the 800 knee, 0.5 at 1150, 0 at 1500. GAINS ONLY — drops stay linear
// everywhere, which is what makes the top of the band slow to climb and fast to fall
// (§2.3's hard-won, fragile buffer). A RECOVERING venture climbs at full strength: the
// factor is 1 for every negative RP, so a redemption arc out of the closure zone is
// achievable rather than asymptotically hopeless.
//
// THIS IS WHY THE TOP NEEDS NO HARD CLAMP. As `rp` approaches the cap the tapered gain
// rounds to 0 before the cap is reached — with the largest possible raw gain (100) the
// last unit lands at 1497 — so 1500 is *approached and never passed*, organically, which
// is exactly what §2.3 means by an "organic soft cap". The FLOOR, by contrast, is a real
// clamp: a drop is not tapered, so nothing stops it on its own.
function gainFactor(rp) {
  return Math.max(0, Math.min(1, (RP_SOFT_CAP - rp) / (RP_SOFT_CAP - RP_TAPER_KNEE)));
}

// reputationDelta(status, venture) -> the RAW (pre-taper, pre-clamp) signed RP a boundary
// verdict moves for this venture.
//
// Takes the SAME `status` string `feeOwed` takes, and refuses the same non-verdicts for
// the same reason: RP moves only at a boundary, so an `accruing` reaching here would mean
// reputation fired on a tick where nothing was judged. A silent 0 would be the quietest
// possible bug — a reputation that simply never moved, with no test going red — so it
// throws instead.
//
// RAW, and the name of what it is not matters: the taper and the floor clamp are applied
// by the CALLER (sim/tick.js), because both need the venture's CURRENT reputation and
// this function is a pure function of the verdict and the terms alone.
function reputationDelta(status, venture) {
  if (status !== 'met' && status !== 'breach') {
    throw new Error(`reputationDelta: reputation moves only on a boundary verdict — got status "${status}"`);
  }
  return status === 'met' ? metGain(venture) : breachPenalty(venture);
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
  EQUITY_CEILING, equityOf, isValidEquityPct, committedContribution, ownerFraction, commitmentSale,
  FEE_RATE, CORNERS, EQUITY_SHAPE_K, COMMITMENT_FLOOR, WINDOW_DAYS_MIN, WINDOW_DAYS_MAX,
  feeFraction, normalisedTerms, licenceFee, feeOwed, isValidCommitmentPct, isValidWindowDays,
  commitmentUnitsFor,
  REP_MEET_MAX, REP_W_COMMIT, REP_W_EQUITY, REP_BREACH_MAX, REP_BREACH_MIN,
  RP_FLOOR, RP_SOFT_CAP, RP_TAPER_KNEE,
  repTerms, tierFactor, metGain, breachPenalty, gainFactor, reputationDelta,
};
