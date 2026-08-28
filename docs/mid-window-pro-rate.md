# The mid-window join pro-rate — what was built (licence Slice 3b-ii, 27-08-26)

The build note for **3b-ii**. This is not a new decision: `design.md` §5's *"A mid-window join is
pro-rated — **Option A, ruled**; build **DEFERRED**"* is the contract, and this slice is that deferred
build. Companion notes: `docs/licence-fee.md` (3b-i, the entity + fee math), `docs/commitment-sale.md`
(3a, the sale).

## The failure it fixes

Slice B-i built the pro-rate's arithmetic and pinned it unreachable — `windowFraction` returned `1` for
everything — because nothing could yet join mid-window, guarded by a tripwire asserting exactly that.
Slice 3b-i then introduced the thing that reaches it: a licence granted at an arbitrary tick. With the
pin still in, a mine licensed part-way through a window owed a **whole window's `Q`** with only part of
a window to deliver it. Observed at 3b-i, `N = 4`, a rate-5 mine licensed at tick 2 at 100% commitment:

```
tick 3  delivered  5   window 1   status breach    <- the tick-4 boundary already lost
tick 4  delivered 10   window 1                    <- 10 of 20: breached, unavoidably
```

Harmless while nothing was charged; unfair the moment 3b-iii debits a full basic fee for it. Now:

```
producing | Q  deliv   status
        3 | 10     5  accruing   <- owes 10, not 20
        4 | 10    10       met   <- the boundary it used to lose
        5 | 20     5  accruing   <- and a full window from here on
```

## What changed — three edits, one of them one line

**1. `applyForLicence` stamps `committedFromTick` (`sim/actions.js`).** The whole slice turns on this
value being **`signedTick + 1`**, not `signedTick`:

- Intake runs **before** the tick (`advance` = intake → tick → assert), so a venture licensed while
  `state.tick` is `T` is committed during intake but first *produces* — and therefore first delivers —
  on the tick that yields state `T+1`.
- `windowFraction` counts `present = windowStart + N − committedFromTick`, which is the number of
  producing ticks from the stamp to the boundary **inclusive**. For that to equal the ticks the venture
  actually delivers in, the stamp must be its **first producing tick**.
- Stamping `signedTick` would credit it with one tick it could never produce in, and it would owe a
  unit it could not deliver — the same unfairness the pro-rate exists to end, in miniature.

**Only `applyForLicence` stamps it.** An unlicensed venture, or one committed through the
`setSyndicateCommitment` dev scaffold, carries no `committedFromTick`, so `windowFraction` returns `1`
and its behaviour is untouched — the scaffold stays deliberately full-window, and its test asserting so
stays green.

**2. `Q` is rounded (`sim/production.js`).** `Q = Σ (integer commitment × fraction)` can now be
fractional. It is rounded to a whole number at the **single place it is finalised**, so the paced
`requiredRate` and the met/breach judgement read the *same* target — pacing can never aim at a number
the boundary refuses. `Math.round`, matching the send carry's half-up convention. Goods are integers
(§15.2); this is a rule, not a tunable, so **no `[FIRST-CUT]` constant is introduced by this slice**.

**3. `windowFraction`'s "PINNED to 1" comment is retired** (`sim/windows.js`). The math is unchanged —
it was always built, only unreached.

## The deferral guard → the correctness tripwire

§5 required Slice B to *"ship a tripwire asserting `fraction == 1` for every venture"* so the deferral
could not silently rot. It didn't rot: it went red-adjacent exactly as intended, by making the
mid-window unfairness visible at 3b-i. That guard has now done its job and is **retired**, and what
replaces it is the correctness of the thing it guarded:

- **`sim/tests/window-accrual.test.js`** — the `(a)` slot now holds pro-rate correctness: a
  full-window venture still owes a full window; a mid-window joiner owes `present / N`, down to a
  single-tick sliver; a venture whose first tick is past the window contributes nothing to it.
- **`sim/invariants.js`** — asserts every tick that a present `committedFromTick` is an integer ≥ 1,
  and that the fraction it produces is in `(0, 1]`. Be honest about that range check: for an integer
  stamp ≥ 1 the fraction is in range **by construction**, so no corrupted datum can trip it. It is a
  guard on the **math** — it goes red if `windowFraction`'s formula, or the tick the stamp is written
  at, ever changes in a way that would hand a venture a target it cannot meet. A property sweep in the
  tests pins that premise.

It is checked against the venture's **own** first window, not only the live one: between intake and the
tick that follows, `committedFromTick` is legitimately `state.tick + 1`, so a check keyed on the live
window alone would fire spuriously on a licence signed on a boundary tick. The live window is checked
too, once the venture has actually started producing.

## The byte-identical proof

With `fraction = 1`, `Q = Σ integers` and `round(integer)` is the identity — so **every path where
nothing joined mid-window produces exactly the bytes it did before**. That is not argued, it is pinned:
the pre-existing **committed golden hash** (`commitment-scaffold.test.js`) and the persist golden both
still match, untouched, alongside a determinism proof for a pro-rated run and the unlicensed no-op
proof. The rounding only ever bites when `fraction < 1`, which is new state that did not exist before
this slice.

## ✅ RESOLVED — the fee on a partial first window is PRO-RATED

> **Ruled in `design.md` §5 (27-08-26, the "Partial first window" clause of the LICENCE FEE MECHANICS
> note) and BUILT in Slice 3b-iii (28-08-26, `docs/licence-fee.md` §"The charge").** Answer **1**
> below was taken: the fee is pro-rated by the **same** `windowFraction` that pro-rated the target —
> "one fraction (time present), applied once to the target and once to the fee". The boundary charge
> is `round((met ? discountedFee : basicFee) × windowFraction)`, which is 1 for every full window, so
> the pro-rate touches only a mid-joiner's first window. The section below stands as the record of the
> three options and why a ruling was needed before anything was charged.

## ~~⚠️ Still open for 3b-iii: the fee on a partial first window~~ *(answered — see above)*

The pro-rate settles what a mid-window licence **owes in goods**. It does not settle what it **pays in
credits** for that first, partial window. Three defensible answers, and this slice invents none of them:

1. **Pro-rate the fee too** — it owes `fraction × discountedFee`, symmetric with the commitment.
2. **Free first window** — the partial window is judged but never charged (the "first-window grace"
   3b-i floated as the alternative to the pro-rate; it is still available as a *fee* rule).
3. **Full fee** — the licence's benefits start immediately, so its cost does too.

A ruling is needed **before 3b-iii charges anything**, because whichever is chosen is the first thing a
player will notice about signing mid-window. *(**Answered: option 1**, §5's own clause — see the box
above. Pinned by `mid-window-prorate.test.js`, "a mid-window licence pays a PRO-RATED fee at its first
boundary and the full fee after".)*

## Out of scope *(as of 3b-ii — the fee charge has since landed, 28-08-26)*

Charging the fee or the breach debit (**3b-iii** — the fee charge, renumbered from 3b-ii by this
slice) · the `setSyndicateCommitment` scaffold, which stays full-window · factory/refinery commitment
(still mines-only) · renegotiation and re-signing.

## Tripwires (`sim/tests/mid-window-prorate.test.js`, 15 tests, plus the reworked `(a)` slot)

The stamp is the first producing tick, and the tick that follows proves it · only `applyForLicence`
stamps it · **the headline: a mine licensed mid-window meets its pro-rated `Q` where it used to
breach** · the counterfactual (strip the stamp and the identical run breaches, so the headline can
never pass for another reason) · a licence signed for the very last tick of a window owes a sliver and
meets it · `Q` is a whole number on a fractional window, and pacing reads the same rounded target ·
the full-window path is byte-identical and deterministic · later windows revert to the full `Q` · a
licence signed exactly as a window opens is never pro-rated · a broken join tick trips · the fraction
range holds across a swept `N` × join-tick grid · a long-past join does not cry wolf · determinism ·
the unlicensed no-op proof · and the credit side: across 12 ticks the credit change is 3a's sale less
the boundary fee, and nothing else. *(That last one read "equals 3a's sale exactly, every tick" until
Slice 3b-iii; it was updated, not dropped, and joined by the pro-rated-fee test named above.)*
