# The resource price engine — what was built (26-08-26)

The build note for **Slice 2** of `docs/licence-and-price-system.md` Part 4: filling the empty
`stepPriceRecompute` socket. That doc's **Part 1 is the contract**; this one records what the code
actually does, where it made a choice the contract left open, and what it deliberately did not do.
Every number is `[FIRST-CUT]` and lives in `docs/phase-1-tuning.md`, never in prose here.

## What it does

Per tick, for every non-fuel stockpile good (28 of them — 17 raw + 11 processed, walked in sorted
order for invariant 9), step 3 computes

```
level    = Σ guild stockpile ÷ production capacity
idleness = 1 − IDLENESS_WEIGHT × (consumed this tick ÷ (stock + consumed))
target   = BASE × (1 + SENSITIVITY × level) × idleness
leading  = clamp( slew( leading + ALPHA × (target − leading) ) )
posted   = the `leading` computed PUBLISH_LAG ticks ago
```

- **The direction is the flipped one** (`licence-and-price-system.md` Part 1, superseding design.md §8):
  the value **rises** as a good sits in guild stockpiles and **falls** as hoards drain.
- **Capacity** is Σ of the **fixed droidless baseline output** of every venture making the good
  (`sim/baseline.js`) — *not* `productionRate`. Throttling every mine to zero therefore does **not**
  inflate the level, and nothing can divide by zero.
- **Nothing consumes the price yet.** No sale, no fee, no dividend, no ledger effect — this slice only
  produces the number (the licence slice spends it). No credits move, so invariant 2 is untouched.

## The state shape, and where the lag and the EMA memory live

```js
state.prices = {
  titanium: { posted: 22.0, pending: [23.0, 24.1] },   // one row per non-fuel good
  ...
}
```

- `posted` — the value readable **this** tick: the one computed two ticks ago.
- `pending` — a `PUBLISH_LAG`-deep FIFO. Each tick publishes `pending[0]` and pushes the newly-computed
  value on the back. **The last slot IS the EMA memory** — the value the next smoothing step glides
  from — so the leading value has exactly one home and is never stored twice (invariant 5).

It is **serialized state**: it joins the save and the determinism hash, because the EMA memory and the
publish pipeline are real memory the next tick reads, not telemetry that could be re-derived. Seeded at
tick 0 by `createState` with every good at its base price.

**Floats are correct here.** §15.2's "integer credits, integer goods" governs *balances*; a price is a
*rate*, like the resolver's `rate` and the `batchCarry`/`sendCarry` fractions. The credits a price
eventually moves get rounded at that point (#43, `round(qty × price)`), in the slice that moves them.

## How consumption reaches step 3 without re-resolving production

`tick()` now creates a **per-tick scratch context** and passes it to each step. `stepProduction`
accumulates each good's `fork.downstream` — the resolver's own consumer draw, the exact number it just
debited from the pool — into `ctx.consumed`; `stepPriceRecompute` reads it. Production is resolved
**once**. The scratch is deliberately *not* state: it never serializes, never enters the determinism
hash, and starts empty every tick, so a step can hand a fact forward without that fact getting a second
home. The `STEPS` array and its order are untouched (§15.6 is a fixed contract).

The stock numerator is derived **inside** the price step from `state.guilds` as they stand after step 1,
via the one supply selector — **not** from `state.galacticSupply`, which is the post-steps cache and is
still stale at step 3.

## Choices this build made that the contract left open

- **The curve is LINEAR in the level** (`1 + SENSITIVITY × level`). The contract fixes the level as the
  main driver and says it must be rarity-aware and self-correcting; it does not name a shape. Linear is
  the least-invented option that satisfies all three. Whether it should bend is on the tuning doc's open
  list.
- **Idleness is measured as TURNOVER** — the draw as a fraction of the pile it came out of (drawn plus
  left standing). Lands in [0, 1] by construction, needs no clamp, and reads directly as "how much of
  this pile is working inventory".
- **The slew cap is RELATIVE** (a % of the good's own current value), so it means the same thing to a
  cheap good and an expensive one.
- **A good nobody produces rests at BASE.** With no producers there is no capacity to be scarce
  against, so the level is undefined, not infinite. This is also what keeps an empty galaxy's prices
  sitting exactly at base (the no-op path).
- **The `[FIRST-CUT]` level sensitivity was chosen against a live run**, not from the armchair: the
  first value tried pinned every hoarded good at the ceiling within forty ticks. Recorded, with the
  reasoning, in `docs/phase-1-tuning.md`.

## Out of scope, deliberately

- **Any use of the price** — commitment sale, fee, dividends, ledger effects. (Licence slice.)
- **The `productionRate` → throttle-below / droids-above refactor.** `sim/baseline.js` introduces the
  constant table and one helper *for the pricing normaliser only*; **nothing in `production.js` reads
  it** and `productionRate` is unchanged. The refactor rides with the licence slice, where commitment
  and fee actually need it.
- **The console's price chart binding** and the player order book. The snapshot now carries the real
  numbers; wiring the chart is its own slice, and the client keeps its ring buffer until then.
- **Fuel pricing** — excluded permanently (§8). `deuterium_fuel` has no price row anywhere.
- **A price history on state** — a chart ring buffer in serialized state would be memory the engine
  doesn't need. Snapshot carries `posted` only; the client buffers.

## The snapshot surface

`buildSnapshot` gains a top-level `prices: { <good>: <posted> }`. **Additive — no schema bump** (still
7): nothing existing changed shape. Deliberately **posted only** — the un-published pipeline stays off
the lens, because handing out the future price would kill the front-running read the lag exists to
create.

## Tripwires (`sim/tests/prices.test.js`, 24 tests)

Rises on a hoard · crashes on a drain · rarity scaling (same hoard, one producer vs ten) · idleness
(consumed stock prices below identical static stock, and the step demonstrably used the resolver's own
draw) · EMA glide · slew cap · clamp band · the two-tick lag (both as an identity and as a delayed
reaction to a stock shock) · fuel never priced · determinism · the empty-galaxy no-op proof · a
pre-slice state with no price block still ticks · capacity reads the baseline not the rate · the
baseline table drift guard · the snapshot surface · step purity.

`sim/invariants.js` also gains a **price sanity tripwire**, asserted every tick beside the other
tripwires: every priced good present, every value finite and inside the clamp band, the publish pipeline
the right depth, and no row for fuel. Prices are floats fenced off the integer sweep (like `batchCarry`
and `sendCarry`), and a NaN is exactly the failure that would rot silently — nothing reads the price
*yet*, but the moment the licence slice denominates credits in it, a poisoned value would reach the
ledger before anyone noticed.

The three **golden-hash no-op proofs** elsewhere in the suite (`persist.test.js`,
`commitment-scaffold.test.js`) keep their original hashes, now asserted against the state with the
price block stripped — so they prove something *stronger* than before: this slice added prices and
changed nothing else, byte for byte. The full-state hashes are pinned beside them.
