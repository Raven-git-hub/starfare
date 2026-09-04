'use strict';

// price-ring.js — the per-tick posted-price RING: engine-internal, serialized state
// that lets a SELL/BUY confirm re-derive the price a quote was ISSUED at, up to a few
// ticks after it was shown (docs/transport-model.md §8.1 "The agreed-price quote",
// RULED 04-09-26).
//
// WHY a separate store, distinct from sim/price-history.js. The §8.1 quote-lock honours
// a quote for `QUOTE_TTL_TICKS` (5) ticks after its issue tick, so the engine must be
// able to answer "what was `good`'s posted price at tick T" for any T in the last five
// ticks. The chart's price history samples only every 15 ticks (its `fine` tier) — far
// too coarse for a 5-tick window — and its three tiers are a PUBLISHED client contract
// (a fourth would be a schema change, and it is walked in coarsening cadences, not per
// tick). So the quote-lock gets its own, finer, engine-only store: one slot per
// still-valid quote age, deep enough that a confirm a full 5 ticks after issue can still
// be priced.
//
// THE SHAPE:  state.priceRing: { [good]: [oldest, …, newest] }
// Each good's array holds up to `RING_DEPTH` (= QUOTE_TTL_TICKS + 1 = 6) of the most
// recent posted values, NEWEST LAST. The newest slot always corresponds to the tick the
// state is AT (`state.tick`): it is seeded at galaxy creation with tick 0's posted price
// and appended to once per tick in stepPriceRecompute (beside recomputePrices), right
// after the posted value for that tick is known. So the price at issue tick T is read at
// AGE `state.tick − T` from the end — no per-slot tick stamp is stored, the alignment is
// the invariant.
//
// ENGINE-INTERNAL, and NOT published. The client never sees the ring and never sends a
// price (§18): a confirm carries only the ISSUE TICK, which the engine validates and
// prices from its OWN ring. Nothing the client sends can pin a rate.
//
// SERIALIZED AND ALWAYS-ON (invariant 9). Unlike price-history (which is sparse — its
// first key is minted only when the fine bucket closes at tick 15), the ring is seeded
// at tick 0 and present on every state from then on, because a trade with `issueTick`
// OMITTED must resolve at age 0 to exactly today's posted price — the byte-identical
// no-op that keeps every existing caller unchanged. Being always-on serialized state is
// also why this slice MOVES the persisted-state goldens (an added top-level field), and
// they are re-pinned with that justification. The arithmetic is a fixed walk over
// PRICED_GOODS in sorted order, so the same galaxy + seed yields an identical ring.

const { PRICED_GOODS, postedPrice } = require('./prices.js');
const { DEFAULT_WINDOW_N } = require('./windows.js');

// QUOTE_TTL_TICKS — the quote-lock window (docs/phase-1-tuning.md "Quote-lock — the
// agreed-price window"). `[FIRST-CUT]` 5: a SELL/BUY quote is honoured for at most 5
// ticks after its issue tick, and additionally voided the instant a cycle boundary
// passes (below). This is the ONE ruled tuning number the slice reads; the depth is
// derived from it.
const QUOTE_TTL_TICKS = 5;

// RING_DEPTH — the ring is `QUOTE_TTL_TICKS + 1` = 6 deep: one slot per still-valid
// quote age 0 through 5, so a quote confirmed a full 5 ticks after issue can still be
// priced. DERIVED, not a free tunable (docs/phase-1-tuning.md): invent no number.
const RING_DEPTH = QUOTE_TTL_TICKS + 1;

// seedPriceRing(prices) -> the tick-0 ring: each priced good's array holds a single
// slot, its seeded posted price. state.js calls this once in createState, with the block
// seedPrices() just built. Every priced good carries a seed row there, so every good's
// ring opens with exactly one entry (= its base price) — which is what lets a trade at
// tick 0 with `issueTick` omitted resolve at age 0 to that same value.
function seedPriceRing(prices) {
  const ring = {};
  for (const good of PRICED_GOODS) {
    const row = (prices || {})[good];
    ring[good] = (row && row.posted != null) ? [row.posted] : [];
  }
  return ring;
}

// recordPriceRing(state) -> mutate state.priceRing in place: append each priced good's
// CURRENT posted value (the one settled for the tick being built) and drop the oldest
// once the ring is full. The tick's one call, made in stepPriceRecompute right after
// recomputePrices has written this tick's posted values — the only moment "the posted
// price for this tick" exists and is final, exactly where price-history samples too.
//
// No tick argument is needed and none is stored: the ring is appended to exactly once
// per tick, so its newest slot is always the tick the state is at, and the lookup reads
// AGE from the end. Goods are walked in PRICED_GOODS' sorted order (invariant 9). A good
// with no posted value is skipped rather than recorded as a hole — fuel is not in
// PRICED_GOODS at all, so this only fires for a state whose price row was removed by hand.
function recordPriceRing(state) {
  if (!state.priceRing) state.priceRing = {};
  for (const good of PRICED_GOODS) {
    const price = postedPrice(state, good);
    if (price == null) continue;
    const ring = state.priceRing[good] || (state.priceRing[good] = []);
    ring.push(price);
    if (ring.length > RING_DEPTH) ring.shift();
  }
  return state;
}

// quotedPrice(state, good, issueTick) -> the posted price of `good` AT `issueTick`, or
// null when that tick cannot be priced (in the future, too old to still be held, or a
// good with no ring). `age = state.tick − issueTick`.
//
// AGE 0 — the CURRENT tick — is read from the LIVE posted price (`postedPrice`), its
// canonical home, not from the ring's newest slot (a copy of it). This is deliberate and
// load-bearing: it makes an OMITTED `issueTick` price at exactly `postedPrice`, so a trade
// with no quote-lock is byte-identical to the pre-slice engine — independent of whether
// the ring is present or aligned, which a hand-built test fixture that pokes
// `prices[good].posted` directly deliberately is not. In real flow the ring's newest slot
// equals `postedPrice` (recordPriceRing copies it every tick), so the two agree; reading
// the live source for "now" and the ring only for the PAST is both correct and the more
// robust of the two.
//
// AGE ≥ 1 — a genuine quote-lock — reads the ring: slot `ring.length − 1 − age`, newest
// last. The caller gates expiry with `checkQuote` first; this is the pure read.
function quotedPrice(state, good, issueTick) {
  const age = state.tick - issueTick;
  if (!Number.isInteger(age) || age < 0) return null;
  if (age === 0) return postedPrice(state, good);
  const ring = (state.priceRing || {})[good];
  if (!Array.isArray(ring) || age >= ring.length) return null;
  return ring[ring.length - 1 - age];
}

// cycleIndexOf(state, tick) -> which FUEL-PRICE cycle a tick sits in: `floor((tick −
// anchor) / N)`. This is the partition the fuel price is constant on, and it is
// deliberately NOT `calendar.dayOf` (which carries the §5 `(tick − 1)` phase, grouping a
// window by the boundary that ENDS it). The fuel price is posted at the END of a boundary
// tick's step (sim/tick.js step 6, `reserve.fuelPrice = nextFuelPrice(…)`), so the NEW
// price is already on state AT the boundary tick B = anchor + kN; `cycleIndexOf`
// increments exactly there (index k−1 at B−1, k at B), so two ticks share a fuel price
// iff they share this index. `N` and the anchor are read the same way the tick resolves
// them (the engine-wide `windowN` fallback, the default-0 anchor), so this never
// disagrees with where a boundary actually falls.
function cycleIndexOf(state, tick) {
  const N = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
  const anchor = state.dayAnchorTick == null ? 0 : state.dayAnchorTick;
  return Math.floor((tick - anchor) / N);
}

// checkQuote(state, good, issueTick) -> { valid: true } if the quote issued at
// `issueTick` may still be honoured for `good`, else { valid: false, reason }. THE §8.1
// EXPIRY GATE, both rules. `issueTick` is the caller's already-defaulted value — the
// current tick when the confirm omitted it (age 0, today's price, always valid). Three
// distinct refusals, all reject-whole and all blaming the quote:
//   - FUTURE: a tick that has not happened names no posted price. Checked first, so the
//     TTL subtraction below is never read as a negative "age".
//   - TOO OLD: more than QUOTE_TTL_TICKS ticks behind the current tick.
//   - CYCLE BOUNDARY: a boundary has passed since issue, so the fuel price the quote
//     agreed no longer exists (§8.1) — even inside the TTL window.
// The final ring guard cannot fail once the two above pass (the ring is deep enough for
// every in-TTL age); it stands so a state whose ring was edited by hand refuses rather
// than pricing at nothing.
function checkQuote(state, good, issueTick) {
  const currentTick = state.tick;
  if (!Number.isInteger(issueTick)) {
    return { valid: false, reason: 'issueTick must be an integer tick (§8.1 quote-lock)' };
  }
  if (issueTick > currentTick) {
    return {
      valid: false,
      reason: `quote issueTick ${issueTick} is in the future (current tick ${currentTick}) — it names no posted price (§8.1)`,
    };
  }
  if (currentTick - issueTick > QUOTE_TTL_TICKS) {
    return {
      valid: false,
      reason: `quote issued at tick ${issueTick} has expired — more than ${QUOTE_TTL_TICKS} ticks old at tick ${currentTick} (§8.1); refresh to re-quote`,
    };
  }
  if (cycleIndexOf(state, issueTick) !== cycleIndexOf(state, currentTick)) {
    return {
      valid: false,
      reason: `quote issued at tick ${issueTick} has expired — a cycle boundary has passed by tick ${currentTick}, so the fuel price it agreed no longer exists (§8.1); refresh to re-quote`,
    };
  }
  if (quotedPrice(state, good, issueTick) == null) {
    return {
      valid: false,
      reason: `quote issued at tick ${issueTick} is not in the posted-price ring for ${JSON.stringify(good)} (§8.1)`,
    };
  }
  return { valid: true };
}

// clonePriceRing(ring) -> a deep-enough copy so a caller's object can never alias into
// engine state (createState uses it, parallel to clonePriceHistory / cloneStockpiles).
// The arrays are copied too — they are the mutable part.
function clonePriceRing(ring) {
  const out = {};
  for (const [good, arr] of Object.entries(ring || {})) out[good] = [...(arr || [])];
  return out;
}

module.exports = {
  QUOTE_TTL_TICKS, RING_DEPTH,
  seedPriceRing, recordPriceRing, quotedPrice, cycleIndexOf, checkQuote, clonePriceRing,
};
