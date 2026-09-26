# The resource price engine — what was built (26-08-26)

The build note for **Slice 2** of `docs/licence-and-price-system.md` Part 4: filling the empty
`stepPriceRecompute` socket. That doc's **Part 1 is the contract**; this one records what the code
actually does, where it made a choice the contract left open, and what it deliberately did not do.
Every number is `[FIRST-CUT]` and lives in `docs/phase-1-tuning.md`, never in prose here.

## What it does

Per tick, for every non-fuel stockpile good (54 of them since 2.1a — 17 raw, 12 processed, 25 Tier-3
modules — walked in sorted order for invariant 9), step 3 computes

```
level    = Σ guild stockpile ÷ production capacity
idleness = 1 − IDLENESS_WEIGHT × (consumed this tick ÷ (stock + consumed))
target   = base × (1 + SENSITIVITY × level) × idleness      (base = the good's TIER base)
leading  = clamp( slew( leading + ALPHA × (target − leading) ) )   (clamp = the good's TIER band)
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
tick 0 by `createState` with every good at its own tier's base price (since 26-09-26 — see below).

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
- **A good nobody produces rests at its tier's base.** With no producers there is no capacity to be scarce
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

## Tripwires (`sim/tests/prices.test.js`, 32 tests since 26-09-26; 24 at build)

Rises on a hoard · crashes on a drain · rarity scaling (same hoard, one producer vs ten) · idleness
(consumed stock prices below identical static stock, and the step demonstrably used the resolver's own
draw) · EMA glide · slew cap · clamp band · the two-tick lag (both as an identity and as a delayed
reaction to a stock shock) · fuel never priced · determinism · the empty-galaxy no-op proof · a
pre-slice state with no price block still ticks · capacity reads the baseline not the rate · the
baseline table drift guard · the snapshot surface · step purity.

`sim/invariants.js` also gains a **price sanity tripwire**, asserted every tick beside the other
tripwires: every priced good present, every value finite and inside its own tier's clamp band (since
26-09-26; one flat band before), the publish pipeline
the right depth, and no row for fuel. Prices are floats fenced off the integer sweep (like `batchCarry`
and `sendCarry`), and a NaN is exactly the failure that would rot silently — nothing reads the price
*yet*, but the moment the licence slice denominates credits in it, a poisoned value would reach the
ledger before anyone noticed.

The three **golden-hash no-op proofs** elsewhere in the suite (`persist.test.js`,
`commitment-scaffold.test.js`) keep their original hashes, now asserted against the state with the
price block stripped — so they prove something *stronger* than before: this slice added prices and
changed nothing else, byte for byte. The full-state hashes are pinned beside them.

## Per-tier price bands (26-09-26)

The build for design.md §5's ruling "PER-TIER PRICE BANDS + THE REFINING PUMP AS A FEATURE". The numbers
are in `docs/phase-1-tuning.md` "Resource prices". **Only the base, floor and ceiling changed.** The
level sensitivity, idleness weight, EMA alpha, slew cap, publish lag and the linear curve are untouched.
The Syndicate stays a spreadless two-sided market-maker, so the refining pump the new bases open is left
live, as ruled.

- **One table, keyed by tier.** `PRICE_BANDS` in `sim/prices.js` holds `{ base, floor, ceiling }` for
  tiers 1, 2 and 3 (T1 1 / 0.2 / 1,000; T2 10 / 2 / 10,000; T3 100 / 20 / 100,000). It replaces the flat
  `BASE_PRICE` / `PRICE_FLOOR` / `PRICE_CEILING`, which are gone. Every importer was updated in the same
  commit rather than keeping a misleading flat constant alive. There is no tier-4 row: Tier-4 assets are
  never priced by this engine.
- **The seam is `bandFor(good)`**, which reads the good's tier through `tierOf` (`sim/points.js`, the
  same answer the GP weights and cargo volumes use), except for raw deuterium (below). `basePriceFor(good)` is now `bandFor(good).base`.
  Both still return **null** for a good that is not priced (fuel, an unknown name); the snapshot's
  `priceBase` and other readers rely on that null.
- **Fail loud.** If a priced good ever resolves to a tier with no row, `bandFor` throws and names the
  good. It never guesses a band. A test pins that every other entry of `PRICED_GOODS` has tier 1, 2 or 3.
- **Threaded once per good.** `recomputePrices` looks the band up once per good and hands the same band
  to `priceTarget(band, …)` (the target and the zero-capacity rest) and `advanceLeading(band, …)` (the
  clamp), so the target and the clamp can never disagree about which good they are pricing. A missing
  price row (an old save) is seeded at that good's own base.
- **The invariant is per tier.** `checkPrices` (`sim/invariants.js`) checks each good against its own
  band. Left flat, it would have passed a module crashed to 5 and flagged a healthy raw good at 0.5.
- **The snapshot is unchanged in shape.** `prices` and `priceBase` carry the new values; there is no new
  field and no schema bump, so the client needed no change (it already read `priceBase` per good).

**Raw `deuterium` is excepted — it keeps its own band (RULED 26-09-26).** Deuterium is out of the tier
system (design.md §8): `tierOf` calls it tier 1, but that is only the Points (GP) view, so the tier bands
must not re-price it. It stays in `PRICED_GOODS`, because the licensed deuterium mine's per-tick auto-sale
pays its posted price, and `bandFor` hands it `DEUTERIUM_BAND` — **base 10, floor 2, ceiling 200**, the
flat band every good had before this slice. Those are its status-quo values, not new numbers, so its
price row behaves exactly as before: replaying a run with licensed mines and a growing unlicensed hoard
(the price moving off base) gives a byte-identical deuterium row and auto-sale income on both engines. A
separate, fuel-facing deuterium price is a future fuel-economy decision
(`docs/fuel-supply-and-allocation.md` §1.4), not built here. (The same day's first cut had put deuterium on
the T1 band at base 1. The ruling reverted that before merge.)

**The floor is a backstop the formula never reaches.** At level 0 the target is `base × idleness`, and
idleness never falls below 0.5, so the lowest target is half the base. The floor (0.2 × base) binds only
on a hand-set or corrupted value, so it is tested on `advanceLeading` directly. The old flat floor was the
same.

**Golden hashes.** A fresh galaxy's price block is different, so every pinned hash that includes prices
moved and was re-pinned in the same commit: 14 of 15 in `persist.test.js` and 23 of 27 in
`commitment-scaffold.test.js`. The two hashes computed with the price block **stripped**
(`GOLDEN_HASH`, `GOLDEN_UNLICENSED`) did **not** move, and deuterium's price row in every run is the same
as before this slice (the deuterium exception was proven by the same replay, above). On the committed run, the only non-price fields
that moved are the guild's credits, its last-sale record and the Syndicate ledger: its scaffold sale is
paid at a T1 price that now rests near 1. As a build-session proof, the new code with every band set
back to the old uniform 10 / 2 / 200 reproduced every previous hash the tests assert equal to (39 of the
42 pinned; the other 3 are historical records read only by a `notEqual`) byte for byte. **A fresh galaxy is
required on deploy.** Saved states keep their old uniform-10 price rows and are not migrated.
