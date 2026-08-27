# Licence-layer hardening — the mis-payment fix and the gaps closed (27-08-26)

The build note for the hardening slice that sits between **3b-ii** (the mid-window pro-rate) and
**3b-iii** (the fee charge). It introduces **no new mechanic and no new `[FIRST-CUT]` number**: it fixes
one live bug, removes the duplication that caused it, and adds the tripwires that would have caught it.
Companion notes: `docs/commitment-sale.md` (3a, the sale), `docs/licence-fee.md` (3b-i, the fee math),
`docs/mid-window-pro-rate.md` (3b-ii, the pro-rate this bug rode in on).

## The live bug — the sale paid the wrong split

`ownerFraction` (`sim/licence.js`) splits each tick's commitment-sale proceeds between the owner's keep
and the ledger's equity (`o`) share, weighting each venture by its **raw** `syndicateCommitment`. The
good's delivered target is built in `sim/production.js` as `Σ syndicateCommitment × windowFraction`.
Those two weightings agreed only while `windowFraction` was pinned at 1. **Slice 3b-ii unpinned it**, and
from that moment a guild running two mines on one good in one system — with different window fractions
**and** different equity — was paid the **wrong split**.

It was silent. Invariant 2 still balanced to the credit (the guild's gain and the ledger's debit are one
number by construction), so nothing halted: only the line *between* the owner's keep and the ledger's `o`
share moved. A **mis-attribution, not a conservation break** — which is why 406 tests never saw it.

Observed on the fixture below (`N = 4`, a full-window mine committing 8 at `o = 0`, a mine licensed at
tick 1 committing 20 at `o = 0.4`, so its window fraction is ¾ and its contribution 15):

| weighting | owner fraction | paid on tick 2 |
|---|---|---|
| raw commitment (the bug) | `(8 + 20×0.6) / 28` = **0.7143** | **50** |
| contribution to `Q` (correct) | `(8 + 15×0.6) / 23` = **0.7391** | **52** |

## The fix — one source of truth, not one more multiplication

The root cause is **two computations of one quantity**. Multiplying the fraction in a second place would
have been the same bug written twice, so the duplication is what was removed:

```js
// sim/licence.js
committedContribution(venture, windowStart, N)   // = syndicateCommitment × windowFraction, 0 if ≤ 0
```

- `resolveProduction` (`sim/production.js`) sums it into `Q` — behaviour-identical, it already computed
  exactly this product inline.
- `ownerFraction` weights the proceeds split by it, instead of by the raw commitment. It needs the
  window, so `applyProduction` (`sim/tick.js`) threads `windowStart`/`windowN` through `commitmentSale` —
  derived from the same producing tick and the same engine-wide `N` the resolver used that tick.
- The non-positive-commitment skip now lives **inside** the shared function, so the two consumers agree
  on **sign** as well as magnitude (see N-1 below).

**Byte-identical where it must be.** `GOLDEN_COMMITTED_WITH_PRICES` is a single-venture, full-window run
(`windowFraction == 1`), so the weight is unchanged and the hash is unmoved:
`e0255c73292645b5b785d818ec6e045f4bfb80e4b0a12f38814acb74947f8272`, before and after. The unlicensed
golden is untouched.

## Two attributions, two clocks — the thing to not "fix" later

Recorded in `design.md` §5 and in `ownerFraction`'s own comment, because the next slice will be tempted to
unify them:

- **The SALE is PER TICK.** Each tick's delivered units are attributed **proportionally** by
  `committedContribution`, purely to price the equity `o` share — *money for goods*, on goods that really
  are co-mingled in one pot.
- **The FEE is PER WINDOW.** At the boundary the window's whole delivered pile fills the licensed ventures
  in the player's **pursue order**, each to its full commitment, and each is met or breached — *which
  contracts you honoured*. The N-4 ruling makes that a boundary-total-pile operation.

The proportional weight is therefore the **final** answer for the sale, not a placeholder. Making the
per-tick sale follow pursue would price money-for-goods by a ranking that does not exist until the
boundary, on goods handed over ticks earlier.

## The tripwires added

| tripwire | what it catches |
|---|---|
| `venture.syndicateCommitment` in the integer/non-negativity sweep | A **fractional** commitment (hidden by `Q`'s own `Math.round`) and a **negative** one (N-1: it used to SUBTRACT from its good's aggregate `Q` and silently shrink a *sibling* mine's target, breaching a contract the sibling was meeting). Both intake paths guard it; a venture built directly by a scenario or test does not. |
| a licensed, committed venture must carry `committedFromTick` | The whole pro-rate rests on one assignment in `applyForLicence`, and nothing downstream notices its absence: `windowFraction` reads a missing stamp as "present since before the window opened" and returns 1, so the mine silently owes a **whole window** again. |
| `committedFromTick === licence.signedTick + 1` | The existing guard only checks the *fraction* is in `(0, 1]`, which **any** integer ≥ 1 satisfies — so an off-by-one (`signedTick`, crediting a tick the venture could never produce in) or a far-future stamp both sailed through it. This checks the stamp against the licence that set it, the only thing that can tell them apart. |
| `windowStart ≥ 1` | `checkField`'s non-negativity allowed **0**, which is not a small window-start — it is a window that never opened. |

**Deliberately NOT added: `delivered ≤ Q`.** `Q` is not stored (invariant 5 — the venture commitments are
its single source), so asserting it would mean recomputing the per-venture sum inside the sweep. Left to
the distribution slice, which walks the ventures at the boundary anyway. Noted in `invariants.js`.

## `createVenture` carries `committedFromTick`

`createVenture` (`sim/state.js`) destructured every licence field **except** `committedFromTick`, so a
scenario or a persisted state handing one in lost it silently and the venture reverted to a full window —
the pro-rate quietly undone by a field that assembled fine everywhere else. Now carried, **omitted when
absent** (like `equityPct` and `licence`), so the no-op hash holds. `!= null` rather than truthiness: a
`0` is not "absent", it is a tick that does not exist, and it should reach the tripwire rather than be
swallowed at assembly.

## The comment/doc sweep

The **3b-ii → 3b-iii** renumbering of the fee charge, and the retirement of the `fraction == 1` deferral
guard, had been applied to some sentences and not others. Corrected in: `sim/licence.js`,
`sim/actions.js`, `sim/invariants.js`, `sim/state.js`, `sim/tests/licence-fee.test.js`,
`docs/licence-fee.md`, `docs/design.md` (§15.4's scaffold note — also reworded "these dev setters retire"
to *retired as the commitment source, kept for tests/scenarios/the bot*), and `docs/phase-1-tuning.md`
(the dead pre-price-engine Titanium market — base $3 / sensitivity 0.6 / floor $1 / ceiling $20 — struck
and pointed at the **Resource prices** table + `sim/prices.js`; its 0.6 was tried and **rejected** by the
price engine, so it must not read as live. The toll/shipping figures there are untouched).

## Out of scope

The per-venture **pursue-order distribution** and per-venture met/breach (the big rebuild) · the **fee
charge** (3b-iii — no credits leave a wallet here) · the `delivered ≤ Q` invariant · anything that
changes how met/breach is computed or touches the aggregate `status` site.

## Deferred, not invented

Nothing new was chosen. The one judgement recorded rather than settled: whether a partial first window's
**FEE** is pro-rated, free, or full stays open for 3b-iii (`docs/mid-window-pro-rate.md`), and
per-venture breach attribution stays with the distribution slice.
