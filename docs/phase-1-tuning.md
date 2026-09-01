# Phase 1 — Tuning Constants & Decision-Checklist Record

*Created 19-07-26. This closes the Phase 1 decision checklist (roadmap.md) and unblocks Stage 2.*

> **These numbers are PROVISIONAL.** Every value below is a day-one starting point, not a tuned figure. Toll defaults, disposition deltas, contest costs and the like are **playtest outputs** — they get their real values by running the sandbox and watching what feels broken, then editing *this table*, not the code. That's the whole point of keeping them here: tuning later is a one-file edit. Tags: `[SHEET]` sourced from `fuel_market_simulator.xlsx`; `[PROP]` an accepted Stage 1 proposal; `[FIRST-CUT]` pure invention, expected to move.

---

## Part A — The decision checklist, resolved (19-07-26)

| # | Item | Ruling |
|---|---|---|
| 45 | Phase 1's second good | **Option A** — fuel stays instant/Syndicate-delivered; a raw good ships and pays tolls. (Settled by the fuel allocation model, which ships *resources* to outposts and handles fuel via the pool.) |
| 48 | Force-sell — keep or drop | **Drop.** The allocation model requires hoarding to be possible. *Build note:* the squeeze-regression replay must script sell actions explicitly rather than assume auto-sale. |
| 42 | Posted-price semantics | **Accept proposal** — step 3 publishes the price governing the next action window. |
| 43 | Credit rounding | **Accept proposal** — `round(qty × price)`, identical both sides. |
| 44 | Scarcity allocation | **Accept proposal** — validate-as-they-arrive, whole order fails if short, fixed bot order. |
| 46 | Land rent in Phase 1 | **Out** — tolls + tariffs only. |
| — | Eight-step tick order (§15.6) | **Confirmed** as amended. |
| 3 | Invariant 3 per-field | **Accept proposals** — credits fail; consumption floors+records; hoard-sales fail; reserve over-buys fail whole order; venture inputs floor via `min(rate, available)`; influence fail; Syndicate ledger exempt. |
| 47 | Tuning numbers | **Provisional first-cut below**, tuned in live play. |

*§19's open-question entries (#42–48) flip from open to resolved in the same commit as the Stage 2 code that implements them, per the doc's own "record on implementation" rule.*

---

## Part B — Provisional #47 constants

### World shape
- **Graph topology** — the Phase-1 placeholder graph (Citadel + 6 home + 3 contested = 10 abstract nodes) is **retired (03-08-26)**: the live world references the real seed instead. Genesis territory is the seed's **Citadel** + its **9 Syndicate outposts** (the waystations) — this also settles the old *waystation count/placement* question: it is whatever the generator places, **9**. Guild homes are the seed's **starter-eligible systems** (any system with a Terran planet; 368 on seed 7331), chosen and claimed at **founding**, not pre-authored. Live claims reference seed landmarks by `landmarkId`+`landmarkKind`, guarded by the claim-integrity invariant.
- **Transit ticks per edge** `[PROP]`: **2** on an open edge, **1** on a secured (owned) edge — territory security's mechanical payoff.
- **Syndicate craft speed** `[FIRST-CUT]` (29-08-26): **300 ticks per hex** (5 hours at 1 tick = 1 minute). A Syndicate BUY delivery travels the nearest-waystation→destination straight-line hex distance at this rate: `arrivalTick = buyTick + ceil(hexDistance × 300)`. A one-hex delivery lands in 5 hours, a four-hex one in most of a cycle — the friction that makes BUY a *planned* act against instant SELL. Distinct from **Transit ticks per edge** above (the guild-routed, per-leg number); the two should stay in sight of each other when the guild tier is tuned. Chosen as a first pass, to be felt against real deliveries and retuned; changing it is this one line. ⚠️ **Felt against real deliveries, 29-08-26 (the BUY engine slice) — and it is far too slow for the seed's hex scale.** Measured over seed 7331's 368 starter-eligible systems, the nearest-waystation distance is **6 hexes at the closest, ~60 median, 155 at the furthest** — so at 300 ticks/hex a delivery takes **1,800 to 46,500 ticks: 1.25 to 32 real-world days**. The number was ruled against the intuition "a one-hex delivery lands in 5 hours, a four-hex one in most of a cycle" (design.md §6), which assumes journeys of a handful of hexes; the generated galaxy is two orders of magnitude wider than that. Left **unchanged and shipped as ruled** — the fix is a new number and numbers are not invented in code — and raised on the roadmap's decision checklist. The likely shapes are a much smaller ticks-per-hex, or a distance that is not raw hexes (a log or a per-ring band); both are rulings.
- **Syndicate hauler burn rate** `[FIRST-CUT]` *(fuel Slice 2, 31-08-26)*: **0.5 fuel units per hex** of route distance. A Syndicate trade's fuel cost is `fuelBurn = ceil(hexDistance × 0.5)`, measured from the system to its **nearest waystation** — the same distance the craft-speed line above times the flight on, read from the same `nearestWaystation` call so a trade cannot be priced on one geometry and flown on another. **Cargo-independent** (RULED, `docs/fuel-supply-and-allocation.md` §8): the hauler burns what the trip costs, not what it carries, so the burn does not move with the good or the quantity. `ceil` so a 1-hex route costs 1 rather than truncating to a free delivery. Defined once as `SYNDICATE_HAULER_BURN_RATE` in **`sim/fuel.js`**; nothing inlines it. **One hauler, one rate** — a per-craft table would be a table of one, and arrives with the guild transport tier (Phase 4). `design.md` §15.4 defines `Vehicle.fuelCostToRun` and names the Syndicate Hauler as an instance of it; no such Vehicle row exists in state, so this constant is the deliberate stand-in until one does. **Retune after the waystation rebalance** (9 → 96), which moves every distance in the galaxy and so moves every burn with it. Nothing spends fuel yet — Slice 2 only *quotes* it — so like `GUILD_STARTING_FUEL` it cannot be tuned honestly until Slice 3 makes it a real cost.
- **Starter asset gift** `[FIRST-CUT]` (30-08-26): a founding guild receives **15 Miners + 10 Factories** (idle, in inventory). Deliberately below a home system's capacity (median starter ≈ 28 resource nodes / 34 settlement slots on the seed), so asset scarcity bites from turn one — source #1 of the five asset sources (§4). Tunable; one number. ✅ **WIRED 30-08-26** (the asset-economy slice 1): granted by `foundGuild` from the single constant pair `STARTER_MINERS` / `STARTER_FACTORIES` in `sim/assets.js` — the numbers live there and nowhere else. Not yet felt in play: a home system on the seed holds ~28 nodes / ~34 slots against this 15/10, and sys_0002 in particular holds exactly 15 nodes and 15 slots, so the miner pool runs out exactly at its node count while 5 slots stay machine-less. Retune when it has been played, not before.

### Settlement slots (per-planet, by archetype)
- **Counts** `[FIRST-CUT]` (ruled 02-08-26): surface spaces for **non-mining** ventures (refinery/manufacturing/construction), separate from resource nodes. The more solid/stable the world, the more room: **Terran 15** (fixed); **rocky / desert 7–10**; **ice / crystalline 4–7**; **oceanic 3–4**; **gasGiant / molten / irradiated 0**. Ranged counts are drawn from the seed's deterministic RNG at generation, so a given seed number always yields the same layout (invariant 9). Encoded in `tools/generate_seed.js` (`SETTLEMENT_SLOTS`); slot ids are `${planetId}_sNN`, disjoint from resource-node `_nNN` ids.

### Refining (raw -> processed)
- **The Phase-2 catalog** (04-08-26): 11 raw->processed recipes, one per processed good, all in `sim/recipes.js`. **Every ratio is `[PLACEHOLDER]`** (new recipes seed at all-1s; `titanium_alloy` keeps its earlier 3:1 titanium cut) — provisional and unbalanced, present so each recipe functions and can be tested. **Real numbers get set through the live recipe editor** (next slice) and then baked back into `sim/recipes.js`. Input SETS come from the design list and deliberately keep **process gases** (helium/xenon/nitrogen) as manufacturing consumables, not only structural inputs. The recipes (output ← inputs):
  - `titanium_alloy` ← titanium (×3) + carbon_products
  - `carbon_fiber_weave` ← carbon_products + polymers
  - `nanotube_cable` ← carbon_products + nitrogen + silica
  - `battery_cells` ← lithium + polymers + nitrogen
  - `conductive_material` ← copper + silica
  - `silicon_wafer` ← silica + silver + palladium
  - `composite_resin` ← polymers + nitrogen
  - `heat_resistant_alloy` ← tungsten + helium + carbon_products
  - `radiation_shielding` ← lead + titanium + xenon
  - `magnetic_assemblies` ← neodymium + xenon + gold + lithium
  - `refrigerant_fluid` ← ammonia + nitrogen
- **How recipes run**: a refining venture sits on a settlement slot and runs up to `productionRate` batches/tick, throttled by the **scarcest** input its owner holds; `inputs` is an **array**, so a recipe may require several goods at once. The catalog SHAPE (a fixed, id-addressed set) is settled; the numbers are the open part. A pinned test (`recipes.test.js`, `resources.test.js`) makes adding/removing a recipe or good a deliberate, loud change.
- **Processed-good ids** `[FIRST-CUT]` (from the design list, 04-08-26): the 11 goods above — each a *processed* good (held in stockpiles like a raw good, summed into galactic supply), distinct from raw resources and from the special `deuterium_fuel`. `titanium_alloy` was renamed from `alloy_ingots`. Id strings open to veto; the raw/processed/fuel distinction is settled.
- **Refinery throughput**: `productionRate` (batches/tick) is **operator-supplied**, not a baked constant — like the mining rate, only Titanium's is ruled, so the testbed dials it.

### Production flow *(10-08-26)*
- **Starved-line warn threshold** `[FIRST-CUT]` — a consuming line is flagged "starved" (the §5 pulsing box / future Plant-Manager cue) only when its effective rate is below this fraction of its own throttle, so a rounding wobble near 100% doesn't cry wolf. **95%** — pure first-cut, tune in play.
- **Tick duration** — **RULED (24-08-26): 1 tick = 1 minute of real time** → 60 ticks/hour, 1,440 ticks/day. The engine stays per-tick and clock-free; this is the multiplier the per-hour UI display (§5) reads. Full entry below.
- **Syndicate commitment window length `N` (ticks)** — **RULED (27-08-26): 1,440** *(a 24-hour day at 1 min/tick; supersedes the `[FIRST-CUT] 24`, Slice B-i)* — the number of ticks a per-good windowed accrual runs before it resolves met/breach and rolls (§5 "windowed accrual"; the boundary is the GLOBAL cadence `tick % N == 0`). A commitment cycle is one 24-hour day, which at the ruled 1 min/tick is 1,440 ticks — a *derived* number (24 h x 60 / 1), not a tuned guess. It is *not* a game-meaningful constant baked into the boundary maths (the boundary stays the global cadence). See `docs/cycle-and-calendar.md`. It is a single **engine-wide** value: the fallback `FIRST_CUT_WINDOW_N` in `sim/windows.js` moves `24 -> 1,440` (the number slice), and no golden's bytes depend on the fallback's value — the committed golden sets its own `state.windowN`, and the unlicensed golden reads the fallback but never consults a window (every mine has commitment 0), so its hash is invariant to `N` — so the flip is byte-identical for the suite (verified 444/444, Slice 1 / PR #29). Boundaries are then anchored to server midnight via a per-galaxy `dayAnchorTick` (default 0 — a no-op), with a calendar layer (`dayOf`/`minuteOf`/`tickAt`) deriving days and times from the plain tick — see `docs/cycle-and-calendar.md`.

### Resource prices *(26-08-26 — the price engine, `sim/prices.js`)*

The Syndicate value per non-fuel good: `target = BASE × (1 + SENSITIVITY × level) × idleness`,
EMA-smoothed, slew-capped, clamped, and published two ticks behind (`docs/licence-and-price-system.md`
Part 1 — the **shape** is settled design; every **number** below is `[FIRST-CUT]` and lives here).
`deuterium_fuel` is never priced (Syndicate-regulated, design.md §8) — a permanent exclusion, not a
deferral.

**The one flat rate that exists anyway** `[FIRST-CUT]` *(fuel Slice 1, 31-08-26)*: because fuel has no
posted row, a client that wants a guild's hoard **in credits** can only invent a rate — so the engine
names one instead. **`FLAT_FUEL_PRICE_PER_UNIT` = 10 credits/unit** (`sim/fuel.js`) feeds exactly one
thing, the snapshot's derived `guild.fuelHoardValue`, and **nothing charges it**: no credit moves
through it, so invariant 2 cannot see it. *(**Retired 01-09-26 by slice 5b-i — ✅ BUILT, the constant no longer exists in `sim/`.** The stateful `reserve.fuelPrice` replaces it as the ONE fuel price — used for both the hoard's mark-to-market and the issuance grant conversion — and its value 10 becomes `REFERENCE_FUEL_PRICE`, the price at which `BASE_GRANT_PER_GP` is calibrated. It had **three** consumers, not the two §4.2 names — the hoard's mark-to-market, the issuance conversion, **and the route quote's `creditCost`** — and all three now read `reserve.fuelPrice` through one valuation function, `fuelValue`. See the fuel section below and `fuel-supply-and-allocation.md §4.2`.)* It is **not** an answer to `docs/fuel-economy.md` §9's open
question 4 (reuse the price engine, or a dedicated reserve-based curve?) and it does **not** soften the
exclusion above — it is a named stand-in so that question has one line to replace.

| Constant | `[FIRST-CUT]` value | Rationale |
|---|---|---|
| **Base price** | **10** credits | The seed value every good starts at and the anchor the curve multiplies. Uniform across all 28 goods: per-good (or tier-aware) bases are **unruled**, so none was invented. |
| **Level sensitivity** | **0.05** | The level is *ticks of galaxy-wide production held in stockpiles* (`stock ÷ capacity-per-tick`), so this sets the timescale on which hoarding pays: a level of 20 doubles the value; the ceiling needs a level of 380 — a little over **six hours** of wholly unmanaged hoarding at the ruled 1 tick = 1 minute. **Chosen against a live run**: the first value tried (0.6) pinned every hoarded good at the ceiling inside forty ticks, which is a flat line, not a market. |
| **Idleness weight** | **0.5** | Stock being drawn downstream is *working inventory* and is discounted; static stock is a *hoard* and takes the full level. At 0.5 a pile wholly consumed each tick prices at half. 0 would disable the behavioural term; 1 would make working inventory worthless. |
| **EMA alpha** | **0.2** | The fraction of the gap to the target closed per tick — the value glides (visibly, ~5 ticks to most of a move) instead of strobing. The EMA memory is also what folds the momentum/trend term in for free. |
| **Slew cap** | **10% per tick** | Relative, so it scales with the good's own price level. Binding only on shocks: it lets a value double in ~7 ticks, so a single dump can't teleport the price but an honest trend isn't throttled. |
| **Floor / ceiling** | **2 / 200** | 0.2× and 20× base — the *technical* stop only. The real circuit-breakers are the storyteller (Phase 6) and the destabiliser/counter bots (Slice 7); this band exists so nothing runs away before they exist. |
| **Publish lag** | **2 ticks** | Straight from the settled design: it breaks the price↔action circular dependency, restores §8/#42's knowable posted price, and creates the front-running read (the stock is visible now, the price catches up later). |
| **Droidless baseline output** | **5** units/tick per mine, **5** batches/tick per recipe | The capacity denominator needs a venture's *max possible* output, not its throttleable `productionRate`. 5 is the one extraction rate the repo has actually ruled (Titanium 5/tick, 01-08-26) and the client's uniform `ESTABLISH_RATE`. The table in `sim/baseline.js` is written out entry by entry so tuning is a one-file edit; **per-resource differentiation is designed but unruled** ("a gold mine might yield ~1", above) and is deliberately left on the checklist rather than guessed. |

**Open, for the human — not invented here:** per-good base prices (a tier-aware base is the obvious next
ruling); per-resource/per-recipe baseline outputs; whether the level curve should stay **linear** in the
level or bend (concave would make the first units of a hoard matter most); and `docs/licence-and-price-system.md`
Part 5's *normaliser confirm* — live production capacity (what was built) vs. a fixed per-good reference.

### Price history — the chart's depth *(29-08-26 — `sim/price-history.js`)*

`state.priceHistory` records the posted value into **three fixed-size rings per good** at
coarsening cadences, so the TRADE tab's graph can show three months without keeping a
per-tick sample (~130,000 ticks × ~28 goods would be ~3.6M numbers in the save **and** in
the determinism hash, every tick). A sample is the **closing price** — the posted value at
the tick the bucket closes on, point-sampled, never averaged.

Every number here is a **`[FIRST-CUT]` DISPLAY-DEPTH constant, not an economy number**: none
of it feeds a rate, a price, a fee or a commitment, and changing any of it changes only how
far back a line on screen reaches. So none of it is a decision-checklist entry either.
Single-sourced in `sim/price-history.js`; the client never hard-codes a depth.

| Ring | Cadence `[FIRST-CUT]` | Length `[FIRST-CUT]` | Span | Rationale |
|---|---|---|---|---|
| **`fine`** | every **15** ticks | **288** | 4,320 ticks ≈ **3 days** | A quarter-hour resolution is fine enough that an intraday move is visible and coarse enough that three days cost 288 numbers. |
| **`medium`** | every **120** ticks | **168** | 20,160 ticks ≈ **14 days** | Two-hourly over a fortnight — the resolution at which a week-long trend reads as a trend rather than as noise. |
| **`coarse`** | every **1,440** ticks | **90** | 129,600 ticks ≈ **90 days** | One sample per **cycle** (N = 1,440, `docs/cycle-and-calendar.md`) — the natural daily close, and the only cadence at which a quarter is affordable at all. |

**~546 samples per good, ~15,300 across all 28** — trivial to serialize, which is the whole
point of the coarsening.

**Tier → scale-button mapping — RECORDED HERE, not implemented.** The engine emits **rings**,
not scale buttons, and there are three rings for four buttons. The later client slice that
finishes the chart maps them like this, so the mapping is unambiguous rather than re-derived:

| Scale button | Reads | Window |
|---|---|---|
| **3D** | `fine` | all 288 samples |
| **2W** | `medium` | all 168 samples |
| **1M** | `coarse` | its most recent ~**30** samples (~30 days) |
| **3M** | `coarse` | all 90 samples (~90 days) |

**Deferred, not invented:** averaged buckets, candlesticks (open/high/low/close) and min–max
bands. All would need an accumulator carried in serialized state between bucket closes, for
no visible gain on a game chart; the close price is what a real daily chart plots. **No
backfill:** the past was never recorded, so the rings fill forward from deploy.

### Licence — the commitment sale *(26-08-26 — Slice 3a, `sim/licence.js`)*

A committed delivery is now a **sale**: the owner is paid `round((1 − o) × units × posted price)` and the
Syndicate ledger is debited the same integer (`docs/commitment-sale.md`; design.md §5 "Output
commitment"). **This slice invented no new tuning number** — that is the entry. What it pinned instead:

| Value | Where it comes from | Tag |
|---|---|---|
| **Equity ceiling — 0.49** | design.md §5, "up to the structural **49%** ceiling (the owner keeps control by retaining at least 51%)". A **design** number, not a dial: it is what makes the owner's control non-negotiable. Lives in `sim/licence.js` as `EQUITY_CEILING`. | **not** `[FIRST-CUT]` |
| **The sale price** | `state.prices[good].posted` — the price engine's posted, two-ticks-lagged value. Nothing here fabricates a rate. | sourced |
| **Rounding — `Math.round`, once, both legs** | Decision **#43** (already ruled): `round(qty × price)`, *identical both sides*. Realised as one rounding at the end whose single integer is used for both the guild's gain and the ledger's debit, so invariant 2 holds to the credit. | ruled |
| **Default equity offered — 0** | "no offer", not a balance choice. Omitted from the venture entirely when 0, so an unlicensed galaxy's bytes are unchanged. | n/a |
| **Sale cadence — per tick** | Ruled at this slice and reconciled into §5 (the *fee* stays on the 24h cycle). Not a number to tune. | ruled |

**Still unruled, and deliberately not invented here** — all of them Slice 3b/4/5, all still open at #56:
the **per-type basic fee**, the four-corner grid's corner values (100/75/75/0) and its shaping exponent
`k`, the **0% commitment floor**, the breach charge, and the reputation build/decay rates.

### Licence — the fee *(27-08-26 — Slice 3b-i, `sim/licence.js`)*

`basicFee = feeRate × baseline-per-tick × N × posted price at signing`, discounted by §5's four-corner
grid with the equity axis shaped `o' = oNorm^k` (`docs/licence-fee.md`; design.md §5 "LICENCE FEE
MECHANICS — RULED"). The **shape** is the design; every number below is tuning, and all of them remain
open at **#56**.

| Constant | `[FIRST-CUT]` value | Rationale |
|---|---|---|
| **`FEE_RATE`** | **0.10** | The basic fee is a tenth of what the venture's droidless baseline output over one window is worth at the price locked at signing — the licence's headline cost is a tenth of the thing it licenses, measured on the same window the fee is charged over. Visible but survivable, and an easy number to reason from when tuning. It scales with the window: if `N` moves from its own first-cut 24 to the ruled-day **1,440**, the fee and the income it is measured against scale together, so the *ratio* is the number to tune, not the absolute. |
| **Four corners — 100 / 75 / 75 / 0** | as §5 states them | Straight from the design table: each lever alone buys 25 points of relief, both together buy 100. The design statement **is** these four readable numbers, not a fitted curve — tuning is editing the table, and making it asymmetric (say 70/80) is free: it says the Syndicate values output over openness, with no change to the formula. |
| **Equity shaping `k`** | **2** | §5's `o' = o^k`, `k > 1`: low equity buys proportionally little relief and the payoff **accelerates** toward the 49% ceiling — deep entanglement is rewarded over toe-dipping. 2 is the design's own first cut. Corners are untouched (`0^k = 0`, `1^k = 1`), so the grid table stays the un-shaped reference. **Commitment stays linear** — its own shaping exponent is an available, unused option. |
| **Commitment floor** | **0%** | Ruled in §5's "LICENCE FEE MECHANICS": a licensed venture may commit nothing and simply pay the full fee for the licence's other benefits (this is also what reconciles the grid table's "5%" row header — `c = 0` maps to the floor). Kept as a named constant because the grid's `c` axis is normalised against it: move the floor and the whole axis re-normalises for free. |
| **Renegotiation window — 7–42 days** | as §5 states them | §5's `[FIRST-CUT]` bounds (open question **#64**). Stored on the licence at signing and still **inert**, but the days-to-tick conversion is now defined: `renegotiationDeadline = tickAt(dayOf(signedTick) + windowDays, 0)` (`docs/cycle-and-calendar.md`). Distinct from the accrual **cycle** (`windowN`, one day): a licence delivers-or-breaches every cycle; its terms lock for `windowDays` days. Only the **behaviour** — detecting the deadline and reopening terms — stays #64. |
| **Equity ceiling — 0.49** | — | **Not** a dial: §5's structural ceiling, what makes the owner's control non-negotiable (they retain 51%). Already in `sim/licence.js` since 3a. |

**Slice 3b-ii (27-08-26) added NO tuning constant.** The mid-window pro-rate is §5's ruled Option-A
formula (`fraction = ticks-present / N`) and the `Q` rounding is a rule, not a dial: goods are integers
(§15.2), so the aggregate target is rounded where it is finalised and pacing and judgement read the same
number. The prerequisite it was flagged as — pro-rate vs first-window grace — is **answered: the
pro-rate** (`docs/mid-window-pro-rate.md`).

~~**Still unruled, and deliberately not invented here:**~~ **All three are now answered, and Slice
3b-iii (28-08-26) charged the fee against them:** the **breach charge** is the full basic fee and
*nothing else* this slice — no reputation move, no payout (§5; the rest is #61 / Slice 5);
**per-venture breach attribution** landed with the pursue-order distribution
(`docs/licence-distribution.md`); and a partial first window's **FEE** is **pro-rated** by the same
`windowFraction` as its target (§5's "Partial first window" clause, 27-08-26 —
`docs/mid-window-pro-rate.md`). No new `[FIRST-CUT]` number was authored by the charge: `FEE_RATE`, the
corners, `k`, the baselines and `N` are all read from where they already live.

### The second good (tolled/shipped raw)
- **Good** `[FIRST-CUT]`: **Titanium** (a Tier-1 raw; also the onboarding starter-quest good, so it recurs later).
- **Market** — ~~`[FIRST-CUT]`: reuses the fuel price curve's *shape* (§5) with its own levers — base $3,
  target reserve 20, sensitivity 0.6, floor $1, ceiling $20.~~ **SUPERSEDED (26-08-26) by the price
  engine** — see the **Resource prices** table above and `sim/prices.js`. Titanium has no per-good market
  of its own: every non-fuel good is priced by the one curve (base **10**, level sensitivity **0.05**,
  idleness weight 0.5, EMA + slew + clamp, published two ticks behind). The struck numbers are the
  PRE-engine sketch and are dead — the 0.6 sensitivity in particular was **tried and rejected against a
  live run** (it pinned every hoarded good at the ceiling inside forty ticks), which is exactly why it
  must not sit here reading as live. The toll/shipping figures in this section are untouched.
- **Client establish-rate** `[FIRST-CUT]` *(client-wiring Slice 3, 24-08-26)*: the `productionRate` the **game client** sends with every `establishVenture` — a uniform **5**, for every resource and for refineries alike. Given by the human for the slice and explicitly *to change*. It does **not** change the engine's per-resource intent below: `establishVenture` takes whatever rate the caller sends and stores it, so this is the client's single stand-in until the per-resource extraction rates (and a refinery throughput rule) are wired through the establishment panel. Defined once as `ESTABLISH_RATE` in `client/game.html`; a venture seeded by the operator over `POST /action` still carries whatever rate that call names.
- **Extraction rate** `[FIRST-CUT]`: a **base rate per resource** — a property of the resource mined, *not* a mine 'tier' (mines have no tiers). Titanium **5/tick** (ruled 01-08-26); a common Tier-1 raw yields decently, a scarcer one less (a gold mine might yield ~1). Mines can later be buffed (droids) — out of scope now; the model leaves room, since production reads the base rate and a buff would modify the *effective* rate at step time.

### Guild starts
- **Five bot guilds** `[SHEET]`: exactly the spreadsheet roster (Refinery Combine, Vantar Trust, Orun Compact, Dracis Concern, Ilyra Holdings) — their credits, needs, capacities, hoard 0.
- **Player guild** `[FIRST-CUT]`: deliberately archetype-neutral — credits **$120**, hoard **0**, fuel need **5**, capacity **8**, one **Titanium mine**. Unremarkable on purpose, so no archetype is favoured.
- **Founding starting credits** `[FIRST-CUT]` *(client-wiring Slice 1, 24-08-26)*: **2,000** — the grant a guild is founded with when a **player** founds it through the game client. Given by the human for the slice, **not** derived from anything: it wants a real ruling once the loop is playable (how long 2,000 keeps a new guild alive is a play question, not a design one). It is **debited from the Syndicate ledger** by the engine, never minted (design.md §14), so the ledger goes negative by design and invariant 2 still holds. Single-sourced in the client as `STARTING_CREDITS` in `client/game.html`; the engine has no default of its own — `foundGuild` takes whatever the caller sends. Distinct from the **$120** scenario figure above, which is the *scripted* walking-skeleton guild, not a player founding.
- **Founding starting fuel** `[FIRST-CUT]` *(fuel Slice 1, 31-08-26)*: **500** units of `deuterium_fuel` in the new guild's hoard, granted by `foundGuild` to **every** founded guild. Given by the human for the slice, **not** derived from anything. The ruling behind it is `docs/fuel-economy.md` §7 — the early-game **starter floor** that closes the no-fuel → no-trade → no-reputation trap, anchored on design.md §8's survival floor. Unlike the founding credits above it is **ENGINE POLICY, not an action field**: the constant is `GUILD_STARTING_FUEL` in **`sim/fuel.js`** and no caller can ask for a different hoard, exactly like the starter asset gift. Unlike credits it is also **MINTED, not moved** — there is no fuel counterpart to the Syndicate ledger to debit — so the apply records it in `audit.totalProduced`, which is what keeps invariant 1 balanced from tick 0. **It wants retuning after the waystation rebalance** (9 → 96), which changes what 500 units buys in delivery reach; and it cannot be tuned honestly at all until fuel is *spent* (Slice 3), since nothing consumes it yet. **Distinct from the `hoard 0` roster figures above**, which describe *scenario* guilds assembled directly by `createState` — that path passes its own hoard and was deliberately left untouched, so those two bullets stay exactly true.

### Influence
- **Starting stock** `[FIRST-CUT]`: **100** per guild (all six). *(This is an onboarding/seeding grant and lives only here. The testbed's Found-guild control does **not** apply it — it founds at the engine default 0 — so the value stays single-sourced in this table rather than duplicated in a debug form; the seeding scenario will apply it. 04-08-26.)*
- **Earn** `[FIRST-CUT]`: passive **+1/tick**; **+20** on claiming an uncontested system. Spent on contests. *(The genesis home-claim at founding is exempt from the +20 — it is setup, not a play action; ruled 03-08-26.)*

### Tolls & tariffs
- **Toll** `[FIRST-CUT]`: unit = **credits per shipment** crossing an owned edge; default **10**; range **0–50**.
- **Tariff** `[FIRST-CUT]`: unit = **% of extracted value** taken by the territory owner; default **10%**; range **0–50%**.

### Contests (influence-commitment, no combat/council)
- **Open cost** `[FIRST-CUT]`: **20** influence to initiate.
- **Min stake** `[FIRST-CUT]`: **10** influence.
- **Window** `[FIRST-CUT]`: **5** ticks; higher committed influence at close takes/holds the system; ties resolve first-valid-wins.

### Disposition (bots)
- **Scale** `[FIRST-CUT]`: **−100 … +100**, start **0** (neutral).
- **Deltas** `[FIRST-CUT]`: **+10** for a costly favour (honored contract, vote/toll in their favour); **−15** for a costly slight (broken contract, contest against them).
- **Grudge multiplier** `[FIRST-CUT]`: negatives ×**1.5** (grudges accumulate faster than goodwill, per §10).
- **Decay** `[FIRST-CUT]`: **1/tick** toward 0.
- **Effect cap** `[FIRST-CUT]`: **±30** on a toll or vote — bends it, never owns it. Never touches prices.

### Bot behaviour
- **Trading band** `[FIRST-CUT]`: buy/sell within **±15%** of a **10-tick rolling average**; never chase spot price; **budget floor** — keep ≥**20%** of credits in reserve.
- **Contest-defense** `[FIRST-CUT]`: defend an owned system if attacker's committed influence ≤ **0.5×** the bot's available influence, else concede.
- **Shortfall throttle** `[FIRST-CUT]`: in the squeeze-regression check, **record-only** (matches the sheet); in live play, a shortfall cuts next-tick effective output proportionally.

### Time & display

- **Tick duration (real time per tick)** — **RULED (24-08-26): 1 tick = 1 minute** → **60 ticks/hour, 1,440 ticks/day.** Confirms the Phase-2 heartbeat's long-standing working assumption (roadmap Phase 2, "confirm #5"). The engine stays clock-free and per-tick (never `Date.now()`); this constant is the presentation/mapping multiplier only — the read-only Production view's per-**hour** display (§5 Gate 2), the commitment-window ≈24h→`N` mapping, and the renegotiation-window day→tick maths (#64) all read it, and the per-hour UI seam can now light up in one place. Distinct from the dev-rig **playback-speed** knob (`/autotick` interval), which stays decoupled and is *not* a game number.

---

*When Stage 2/3 runs and these start to feel wrong, change them here. That is the expected workflow, not a failure of planning.*

### Points & Reputation — GP, RP band & the mean line *(31-08-26 — shapes in `docs/points-and-reputation.md`)*

Shapes are ruled in `docs/points-and-reputation.md`; these are the values. `venture.reputation` /
`guild.guildReputation` are signed **integers**, non-negativity-**exempt**; guild RP = Σ venture RP.

**Ruled now `[FIRST-CUT]`** (structural / dimensionless — safe to pick, expected to move in play):

| Constant | `[FIRST-CUT]` | Rationale |
|---|---|---|
| Gain taper knee | **800** | Below it, MEET-gains are full strength; above it they taper toward the cap. **BUILT 31-08-26** as `RP_TAPER_KNEE` (`sim/licence.js` `gainFactor`). Applies to GAINS ONLY — drops land at full strength at every height, which is what makes the top of the band slow to climb and fast to fall. |
| Gain soft cap | **1500** | Organic asymptote: `gainFactor = clamp((1500 − RP)/700, 0, 1)`. RP can bank a buffer past dividend-max but with diminishing returns. **BUILT 31-08-26** as `RP_SOFT_CAP`. Genuinely organic — **nothing clamps the top**; the tapered gain rounds to zero first, so the largest possible gain lands its last unit at **1497** and 1500 is never reached. `checkReputationBand` is the only guard on that half of the band. |
| `ISSUANCE_SENSITIVITY` | **1.5** *(slice 4)* | Slope on `gap/expected`. Raised 1.0→1.5 to lean **punishing for ambition** — a below-line guild falls faster. **BUILT 31-08-26 (slice 4)**, `sim/meanline.js`. |
| `ISSUANCE_FLOOR` | **0.3** *(slice 4)* | A deeply below-line guild draws 0.3 of its `baseGrant` — no death spiral, but over-expansion stings. Lowered 0.5→0.3 (punishing ambition); asymmetric with the 1.5 CEIL so falling below the line hurts more than rising above helps. **BUILT 31-08-26 (slice 4)**, `sim/meanline.js`. |
| `ISSUANCE_CEIL` | **1.5** | Caps the buff; protects the finite pool. Saturation under universal cooperation = "price becomes the throttle" (`fuel-economy.md §2`). **BUILT 31-08-26 (slice 4)**, `sim/meanline.js`. |

**Band edges — from the licence layer (`licence-and-price-system.md §5/§7`), not new numbers:** `−500` closure,
`−300` forced-lease, `+1000` dividend-max (10 tiers × +10% dividend). The RP band reuses these by construction.

**`[SHEET]` / `[DEFERRED]` — deferred, calibrate, do NOT invent:**

| Constant | Tag | Rationale |
|---|---|---|
| `MEANLINE_K` | `[FIRST-CUT]` **1** *(rescaled 01-09-26)* | `expectedRP = MEANLINE_K × GP`. **Rescaled 150 → 1 (01-09-26):** GP and RP now share ONE small integer scale — a guild's expected RP simply *equals* its GP. The old 150 existed only to lift RP into the thousands while GP sat in the tens; with the GP weights and `REP_MEET_MAX` rescaled to match (below) that bridge is redundant. Every *ratio* survives — the modifier `1 + SENS·gap/expected` is scale-invariant, so par / floor / ceiling behaviour is exactly as calibrated; only the numbers shrank. Shape in `points-and-reputation.md §2.6`. **✅ BUILT 01-09-26** (`sim/meanline.js`). `foundingEndowmentFor` needed **no code change** — it is `MEANLINE_K × systemPoints`, so it retracked to `1 × 200 = 200` on its own. |
| `REP_MEET_MAX` / `REP_W_COMMIT` / `REP_W_EQUITY` | `[FIRST-CUT]` **10 / 0.5 / 0.5** *(rescaled 01-09-26)* | Met-cycle gain = `REP_MEET_MAX · tierFactor · (REP_W_COMMIT · committedOutputPct + REP_W_EQUITY · equityFrac)`. **Rescaled 100 → 10** (÷10, matching the RP scale) and gains a **`tierFactor = W_TIER / 100`** (T1 = 1, T2 = 1.5, T3 = 3, T4 = 5) so a higher-tier venture earns proportionally more per cycle and *every* tier breaks even in the same **~10 cycles** — higher tiers are a reward (more GP, more earning, bigger dividend), not a heavier bar. Full-terms T1 → **+10/cycle**; a mine (bar 100) breaks even in ~10 cycles ≈ 10 game-days. `equityFrac` unchanged. Shape in `points-and-reputation.md §2.6`. **✅ BUILT 01-09-26** (`sim/licence.js` `metGain`, with `tierFactor` — see the AS-BUILT note below). |
| `REP_BREACH_MAX` / `REP_BREACH_MIN` | `[FIRST-CUT]` **10 / 2.5** *(rescaled 01-09-26)* | Breach drop = `−(REP_BREACH_MAX − (REP_BREACH_MAX − REP_BREACH_MIN) · committedOutputPct) · tierFactor` — still linear **inverse**-commitment (a high-committer who narrowly fails is barely penalised; the Syndicate does not punish maximum effort, which already costs the guild all its output). **Rescaled 100/10 → 10/2.5:** `MAX` ÷10 with the scale, and `MIN` **lifted from 10% to 25% of MAX** so the gentlest breach (100% commit) is `−2.5·tierFactor` (T1 ≈ −3/cycle), not −1. This blunts the sign-max-grab-the-bump-then-breach exploit (free-boost tail ~100 → ~34 cycles) *without flipping the curve*; the full undiscounted licence fee a breach already pays is the rest of the deterrent. 25%-enough is a playtest question. Shape in `points-and-reputation.md §2.6`. **✅ BUILT 01-09-26** (`sim/licence.js` `breachPenalty`). As built, a tier-1 venture at 100% commitment pays **−3**/cycle (2.5 rounded); at tier 2, −4. |
| `W_SYS` / `W_T1` / `W_T2` / `W_T3` / `W_T4` (GP weights) | `[FIRST-CUT]` **200 / 100 / 150 / 300 / 500** *(rescaled 01-09-26)* | `GP = W_SYS·(held systems) + Σ ventures W_TIER(tier)`. **Rescaled from 12/6/8** to a small-integer scale where GP = expected RP directly. A held system stays **2× a tier-1 mine** (200 vs 100) — the anti-sprawl bite preserved (empty territory is pure GP with no RP to pay it back). Tier spread widened to a deliberate **1 : 1.5 : 3 : 5** to reward climbing the tree. `W_T3`/`W_T4` are the ruled ratio but stay **`[DEFERRED]`** in code until those goods exist (an unweighted tier still halts). Integer GP; DERIVED, never stored. See `points-and-reputation.md §1.0 / §2.6`. **✅ BUILT 01-09-26** (`sim/points.js` `W_SYS` / `TIER_WEIGHT`; T3/T4 stay out of the map and an unweighted tier still halts). ⚠ **It forced `BASE_GRANT_PER_GP` 5 → 0.3** — see the fuel section's AS-BUILT note. |
| **Venture signing bump** `[FIRST-CUT]` **`2 · committedOutputPct · W_TIER`** *(new 01-09-26)* | On **signing a licence**, the venture is minted with an instant RP bump = `2 · committedOutputPct · (its GP weight)`. `0%` commit → **0** (flatlines, below its line); `50%` → **1× its GP** (bar-neutral, on its line — the Syndicate's expected deal); `100%` → **2× its GP** (its GP *above* the line, instant fuel buff); linear between. Generalises §1.2's passive-asset offset to **productive** ventures and scales it by negotiated terms, so the deploy slider sets whether a venture launches above / on / below its line. Lives on `venture.reputation` at signing (so `checkGuildReputationSum` covers it, no new term); **supersedes** the old "ventures earn their whole bar from zero." Shape in `points-and-reputation.md §2.6`. **✅ BUILT 01-09-26 (slice 2 of 2)** — `sim/licence.js` `signingBump`, minted by the `applyForLicence` apply in `sim/actions.js`. Verified at founding scale: a home system + one tier-1 mine is GP 300 / expected 300, and signing that mine at **50%** puts the guild at `endowment 200 + bump 100 = 300` — modifier **exactly 1.00**, on its line; at 100%, RP 200 and above the line; at 0%, no bump and below it. A zero bump mints **no key at all**, exactly as a zero-delta verdict does in the tick. See the AS-BUILT note below for the one sharp edge it surfaced. |
| Outpost deploy RP offset | `[DEFERRED]` | `= MEANLINE_K × (outpost GP)` (bar-neutral, `points-and-reputation.md §1.2`); when outposts are built. |

**Guild founding endowment — DERIVED, not a constant (ruled 31-08-26, A′; **BUILT 31-08-26**, `sim/meanline.js` `foundingEndowmentFor` off `sim/points.js` `systemPoints`; `docs/points-and-reputation.md §2.5`).** A one-time RP grant set at founding `= MEANLINE_K × (home-system GP)`. **Rescaled automatically 01-09-26** with `MEANLINE_K` (→1) and `W_SYS` (→200): `= 1 × 200 = 200` (was `150 × 12 = 1800`), so a newborn still opens exactly on its line, now at RP 200. It invents **no** number — a function of `MEANLINE_K` and `W_SYS`, both ruled above, and it tracks them. **Not a tunable**; do not add it as a `[FIRST-CUT]`/`[SHEET]` row.

**RP band — `[DEFERRED for rescale]` (flagged 01-09-26).** The band bounds (`RP_FLOOR` −500, `RP_TAPER_KNEE` 800, `RP_SOFT_CAP` 1500) and the gain taper were sized for the old thousands-scale and were **deliberately left unchanged** by the 01-09-26 rescale — nothing halts (signing bumps top out at 1000 for a T4, below the 1500 cap; breach still clamps at −500), but at the new scale the band is loose (a mine could bank ~15× its bar before the taper bites). Rescaling it is the **next ruling**, and it carries a real sub-choice the wide 1 : 1.5 : 3 : 5 spread forces: one global band, or a per-tier band scaled to each venture's weight. Do **not** treat −500 / 800 / 1500 as final.

### ⚠ AS-BUILT 01-09-26 — the reputation rescale, slice 1 of 2 (`sim/points.js`, `sim/meanline.js`, `sim/licence.js`)

**Four constants moved and one function was added.** `MEANLINE_K` 150 → 1; `W_SYS` 12 → 200; `TIER_WEIGHT`
{1:6, 2:8} → {1:100, 2:150}; `REP_MEET_MAX` 100 → 10; `REP_BREACH_MAX` 100 → 10; `REP_BREACH_MIN` 10 → **2.5**
(a quarter of MAX, lifted from a tenth — the breach-floor half of §2.6, which moved for its own reason and not
with the scale).

**`tierFactor(venture)` — new, in `sim/licence.js`, scaling BOTH `metGain` and `breachPenalty`.** It is
`W_TIER(tierOf(producedGoodFor(venture))) ÷ W_TIER(1)` — a ratio of GP weights **sourced from `sim/points.js`**,
the single source of truth for what a tier is worth, and divided by the tier-1 weight rather than by a literal
100, so it stays 1 / 1.5 / 3 / 5 through any future retune of the absolute GP scale. **No shared module was
needed:** `licence.js` → `points.js` is a new edge but not a cycle (`points.js` requires only `claims` /
`baseline` / `resources`), so the weight map was not duplicated. An unweighted tier **halts** through
`tierWeight`'s existing throw — a tier-3 venture must never quietly earn at the tier-1 rate.

**As built, the headline figures:** a home system + one T1 mine is **GP 300**, expected **300**, endowment
**200**. Full-terms T1 earns **+10**/cycle and T2 **+15**; a T1 venture at 100% commitment breaches **−3** and a
T2 **−4**. Every tier breaks even in the same **ten** met cycles (bar ÷ earn rate), which is the point of the
factor.

**OUT of scope by ruling, and left untouched:** the **venture signing bump** (slice 2 — a signed venture is
still minted at 0 RP *at the time of this slice*; ⤳ **it landed the same day** — see the slice-2 note below) and
the **RP band** (still deferred, below). `ISSUANCE_SENSITIVITY` / `FLOOR` / `CEIL`,
`REFERENCE_FUEL_PRICE`, the five controller coefficients, `DEUTERIUM_INFLUX_PER_CYCLE` and `POOL_SEED` are all
unchanged. The one constant outside the reputation layer that had to move is `BASE_GRANT_PER_GP` — see its
AS-BUILT note in the fuel section.

**⚠ WHAT THE DEFERRED BAND COSTS IN PLAY, now measured rather than estimated.** The band was left at its
old-scale bounds on purpose, and the built engine shows what that means: a full-terms tier-1 venture reaches the
**800 knee after EIGHTY met cycles** (not eight) and the **+1000 dividend-max tier after ~104** (not eleven),
and an always-meeting venture rests at **1466** — about **14×** the 100-point bar it had to clear, where
pre-rescale it rested at 1.66× its bar. The licence layer's tiers no longer fall out of the meter; they sit an
order of magnitude above it. Nothing halts and every value stays inside `[−500, 1500]`, so this is a
calibration gap, not a break — but it is a real one, it is pinned by tripwire tests in `meanline.test.js` and
`reputation.test.js` that say so in as many words, and it is what the band's own ruling has to fix.
⤳ **Slice 2 took the edge off without closing it:** a venture signed at 100% opens 200 RP up, so it reaches the
knee on cycle **60** and the dividend tier on **84** rather than 80 and 104. The gap is smaller and still an
order of magnitude wide.

*Note: the earlier draft's `guild.reputation` field and its flat `+50 / −80` event list are **withdrawn** —
superseded by `venture.reputation` summed into the existing `guild.guildReputation`, per `points-and-reputation.md`.*

*Built as of 31-08-26 (RP slices 1 and 2 and GP slice 3, `points-and-reputation.md` §6 steps 1-3): the two RP
fields, the guild sum, the terms-scaled meet, the inverse-commitment breach, the gain taper, the band clamp —
plus `RP_FLOOR` = −500 as a hard clamp in the tick — and the **GP weights**, derived per read and published in
the snapshot — and, as of slice 4, `MEANLINE_K` and the three `ISSUANCE_*` constants, which make the mean line
and the issuance modifier real, derived and watchable. **Still NOT built:** `baseGrant`, the pool and the
reserve/flow price controller — so the modifier scales nothing and **no fuel is issued anywhere**; the outpost
offset; and — importantly — the −500 / −300 **consequences**. Reaching the floor is a PIN: the venture keeps producing, keeps being judged and
keeps paying its fee. Closure and forced-lease are a slice of their own.*

### Fuel — the pool & issuance *(31-08-26 — slice 5a; shapes in `fuel-supply-and-allocation.md §2.1`)*

All `[FIRST-CUT]`, and rougher than most — they lean on burn rates still being retuned, which is why 5b's price
controller exists to self-correct. Modelled only to confirm the *structure* (a balanced galaxy's pool holds; an
out-drawing one rations), not tuned.

| Constant | `[FIRST-CUT]` | Rationale |
|---|---|---|
| `BASE_GRANT_PER_GP` | **0.3** *(re-based 01-09-26; was 5)* | Fuel per GP per cycle at modifier 1.0. `fuelGranted = round(BASE_GRANT_PER_GP · GP · modifier)`. A par guild (GP 500, modifier 1.0) draws ~150/cycle; a big well-run one more; an over-expanded one its base × 0.3. **BUILT 31-08-26 (slice 5a)**, `sim/issuance.js` `grantFor`. Verified: a par guild of GP 500 on its line draws **149**/cycle — the **same 149** it drew at GP 30 before the rescale. **⤳ RE-BASED 01-09-26 by the GP rescale — a RE-DENOMINATION, not a retune. See the AS-BUILT note below; do not read the change as a decision to make issuance meaner or more generous.** |
| `DEUTERIUM_INFLUX_PER_CYCLE` | **800** | The abstracted back-end supply (§1.1). Fixed here, set to roughly balance a typical small galaxy's draw; a solo galaxy over-fills and a large one rations, because the influx is fixed and the draw is not — which is precisely what 5b's demand-relative controller corrects. Wants a proper `[SHEET]` pass with the price curve. **BUILT 31-08-26 (slice 5a)**, minted into the pool at each boundary and recorded in `audit.totalProduced`. |
| `POOL_SEED` | **4000** | The Syndicate's starting reserve (§1.3) — ~5 cycles of a typical galaxy's draw, a buffer so early imbalance rations gently rather than instantly. Galaxy-scale, not per-guild; `[SHEET]` alongside 5b. **BUILT 31-08-26 (slice 5a)**: it seeds `state.reserve.reserveLevel` in `sim/scenarios/zero-state.js`, replacing the `[SHEET]` placeholder **30** that line had carried since the walking skeleton. |

### ⚠ AS-BUILT 01-09-26 — the venture signing bump, slice 2 of 2 (`sim/licence.js`, `sim/actions.js`)

**One helper and one mint site.** `signingBump(venture)` = `round(2 · commit · W_TIER)`, exported beside `metGain` and
`breachPenalty`; `applyForLicence`'s apply mints it onto `venture.reputation` and adds the same amount to
`guild.guildReputation`, mirroring the tick's RP move exactly so `checkGuildReputationSum` stays exact with no new term
and no second writer. No new field, no new event, no schema change.

**The weight lookup was extracted, not duplicated.** The bump needs the venture's **absolute** GP tier weight (100 / 150)
where slice 1's `tierFactor` needs the **ratio** (1 / 1.5). Rather than write the lookup twice, `tierFactor` was split
into `whereOf` + `ventureTierWeight` + itself — same arithmetic, same halt on an unweighted tier, one weight map still
living only in `sim/points.js`.

**COMMIT ONLY, NO EQUITY TERM** — the one place the bump parts company with `metGain`. §2.6 sizes it off
`committedOutputPct` alone: the bump answers "how much of your output have you promised", which is what makes the
venture's own bar defensible. Equity is a claim on the proceeds and buys a share of the per-cycle *earn*; if it bought the
opening position too, a guild could buy its way onto its line by giving away shares while promising nothing.

**A ZERO BUMP WRITES NOTHING.** A 0%-commitment licence is legal (§5's floor) and its bump is 0; assigning anyway would
mint `reputation: 0` — a key holding its own default — into every save and every determinism hash for a venture whose
reputation has never moved. The tick's rule 5 is mirrored here, so the field's lifecycle stays "minted by the first thing
that MOVES it", which is now normally signing.

**⚠ THE SHARP EDGE: a 0%-commitment venture can NEVER earn its way back.** No bump, and a 0% licence owes zero units so it
is `met` every window while `metGain` scores its zero terms at zero. It sits below its line for ever, throttling its
guild, with no move available inside its contract — and the way out (renegotiation, #64) is not built. That is a **ruling
question, not a build one** (refuse a 0% signing? give the bump a floor?), so it is on `roadmap.md`'s decision checklist
and pinned meanwhile by a named test rather than papered over.

**⚠ NO RE-BUMP.** `applyForLicence` refuses a second application, so the bump fires once per venture and cannot be farmed
by re-signing. Whether renegotiation re-bumps is deliberately **not** ruled and **not** built; it rides with #64.

**Determinism:** no golden moved. Neither `persist.test.js`'s canonical sequence nor `commitment-scaffold.test.js`'s runs
sign a licence — the scaffold fixtures set `syndicateCommitment` directly — so every pinned hash in the suite is
structurally untouched, and both committed economy traces regenerate byte-identical.

### ⚠ AS-BUILT 01-09-26 — `BASE_GRANT_PER_GP` re-based 5 → 0.3 by the reputation rescale

**It is denominated PER GUILD POINT, and the reputation rescale (`points-and-reputation.md §2.6`) changed what a
Guild Point is.** `W_SYS` went 12 → 200 and the tier weights 6/8 → 100/150, so a guild's GP grew ~16.7×. Left at
**5**, this constant would have multiplied every entitlement in the galaxy by that same factor against an
**unmoved** `DEUTERIUM_INFLUX_PER_CYCLE` of 800. Measured on the reference galaxy before the fix: Σ desired went
987 → **16 450** a cycle, which needs a settled price of ~**206** to hold draw to supply — five times
`PRICE_CEIL` (40). Every galaxy, down to the smallest possible founded guild (GP 300 → 1 500 a cycle), would
have sat in permanent crunch with the controller pinned and unable to answer. Not a tuning question: the unit
moved, so the number denominated in it had to move with it or it silently meant something else.

**DERIVED, NOT CHOSEN (design.md §18 #5).** `0.3 = 5 × (W_SYS_old / W_SYS_new) = 5 × 12/200` — the same rate,
expressed in the new units — and the test pins it as that ratio, not as a bare 0.3, so it tracks a future GP
retune instead of drifting from one.

**It is a NO-OP wherever the GP weights merely re-denominated, to the unit:** a held system still draws exactly
**60** fuel a cycle at par (12×5 = 200×0.3), and a tier-1 mine exactly **30** (6×5 = 100×0.3). The reference
galaxy's four modifiers and its Σ desired are preserved to within one unit of fuel each, and the fuel
controller's acceptance tests — convergence, scale-invariance, the crisis run and the recovery — all pass on
their pre-rescale calibration untouched.

**The ONE place it is not a no-op is TIER 2, and that is deliberate:** a refinery draws **45** where it drew
**40**, because §2.6 widened the tier spread from 6 : 8 to 1 : 1.5. That +12.5% is the ruling's reward for
climbing the manufacturing tree arriving in the fuel layer, which is exactly where it was meant to show up. It
is also the sole reason `commitment-scaffold.test.js`'s five COMMITTED goldens moved.

**A SANCTIONED FLOAT**, on the same footing as `issuanceModifier`: it is a coefficient that scales GP into fuel,
not itself a count of fuel, and `grantFor` already rounds at the one point where the two meet (§15.2). Nothing
downstream changed to accommodate it. ⚠ And it does **not** weaken the anchor note below: `REFERENCE_FUEL_PRICE`
is still not a dial. The pair now reads *"0.3 fuel per Guild Point, at a price of 10"* — the same statement, in
the new units.

*`DEUTERIUM_INFLUX_PER_CYCLE` and `POOL_SEED` are galaxy-scale and belong to the same control loop as 5b's
price coefficients — supply, draw and price are one system, and these get their real values there.*

*Built 31-08-26 (slice 5a): all three, plus the proportional rationing that keeps the pool at or above zero.
**The pool is `state.reserve.reserveLevel`** — the communal reserve that already existed and was already a term
in invariant 1 — not a new field. **Still NOT built:** the reserve/flow **price controller** (5b), which is what
makes a fixed influx against a variable draw self-correct; until it lands, a small galaxy over-fills and a large
one rations, exactly as the rationale column says.*

**`REFERENCE_FUEL_PRICE` `[FIRST-CUT]` 10 *(slice 5b-i, 01-09-26; ✅ BUILT 01-09-26, `sim/fuel.js`)*.** The price at which `BASE_GRANT_PER_GP`'s "5 fuel/GP" is calibrated — a guild draws its full `round(BASE_GRANT_PER_GP · GP · modifier)` entitlement when `reserve.fuelPrice` sits here. It takes the value of the retired `FLAT_FUEL_PRICE_PER_UNIT` (10), so 5b-i is byte-identical; `reserve.fuelPrice` is seeded to it and held there until **5b-ii**'s controller moves it. Physical grant = `round(entitlement · REFERENCE_FUEL_PRICE / reserve.fuelPrice)`; hoard value = `round(fuelHoard · reserve.fuelPrice)` — one price, both uses. **The 5b-ii controller coefficients — `[FIRST-CUT]`, MODELLED (01-09-26; not invented). ✅ BUILT 01-09-26 (`sim/issuance.js`).** Derived from a
discrete simulation of the pool dynamics and validated against the recorder's REAL integer grants. The level-only
controller is `nextPrice = clamp(REFERENCE_FUEL_PRICE × (target / max(1, reserveLevel))^PRICE_SENSITIVITY,
PRICE_FLOOR, PRICE_CEIL)` with `target = TARGET_CYCLES × avgDraw` and `basePrice = REFERENCE_FUEL_PRICE` (so no new
base-price number).

| Constant | `[FIRST-CUT]` | Rationale (from the model) |
|---|---|---|
| `PRICE_SENSITIVITY` | **1.5** | Curve steepness. The pool converges with zero oscillation for s ≤ ~2.0; s ≥ 3 starts to ripple. 1.5 leaves a healthy settled buffer. |
| `TARGET_CYCLES` | **3** | Target reserve = `3 × avgDraw`. Sets where the pool settles (≈ 2.6 cycles of draw in the recorder galaxy); larger = fatter buffer, smaller = leaner. |
| `DRAW_EMA_ALPHA` | **0.22** | Smoothing of the trailing draw average (`avgDraw = α·draw + (1−α)·avgDraw`), ≈ an 8-cycle window. `reserve.avgDraw` is seeded to `DEUTERIUM_INFLUX_PER_CYCLE`. |
| `PRICE_FLOOR` | **2** | Lower price bound — lets an over-supplied galaxy (equilibrium price ~2 at 0.2× draw:influx) cheapen fuel. Also `> 0`, satisfying `physicalGrantFor`'s divide-by-price guard. |
| `PRICE_CEIL` | **40** | Upper bound — caps the throttle. Equilibrium prices reach ~30 at 3× draw:influx; beyond the ceiling the pool rations (the crunch edge, `fuel-supply-and-allocation.md §4.1`). |

Validated: on the recorder galaxy the pool converges to draw = influx with **no oscillation and no draw jitter**,
and recovers from a 2× demand jump in ~9 cycles. **✅ CONFIRMED AGAINST THE REAL ENGINE (01-09-26):** the built
controller settles that galaxy at **pool ~2100 / price ~12.17 / draw 799** against the model's 2108 / 12.15 / 800,
with a monotone (non-ringing) tail. ⚠ **One thing the model's summary did not say, found in the build:** a galaxy
three times the size settles at the same *draw* and the same *target* but a **smaller pool and a dearer price**
(~1006 / ~36.8) — the buffer is what the curve trades to produce the price a given galaxy needs, so
"scale-invariant" means the OUTCOME is invariant, not every column. **The FLOW weight is deliberately NOT here** — the flow term is
deferred (it destabilised the model); see `fuel-supply-and-allocation.md §4.2`.

⚠ **IT IS NOT A TUNING DIAL — IT IS A CALIBRATION ANCHOR, and the distinction matters for whoever retunes next.** `REFERENCE_FUEL_PRICE` and `BASE_GRANT_PER_GP` are two halves of ONE number: "5 fuel per Guild Point, at a price of 10". Moving the reference alone does **not** make fuel dearer — it silently rescales every grant in the galaxy by the ratio, because the grant is `entitlement × REFERENCE / price`. To make fuel dearer, move `reserve.fuelPrice` (5b-ii's job); to change how generous issuance is, move `BASE_GRANT_PER_GP`. The reference should move only alongside a deliberate re-denomination of the fuel economy, and when it does, **every determinism golden in the suite moves with it** — which is the honest signal, not a nuisance.

✅ **`reserve.fuelPrice` NOW HAS ITS FLOOR — ANSWERED 01-09-26 by slice 5b-ii.** 5b-i flagged that nothing bounded the price away from **zero**, which the grant conversion divides by, and closed the gap the only way that invented no number: `physicalGrantFor` **throws** on a price that is not finite and `> 0`. `PRICE_FLOOR = 2` is the answer, and it makes that guard **unreachable from a controller-written price** — a clamped curve cannot produce a zero. The guard stays anyway, now covering a hand-built fixture or a future writer rather than the controller, and a test sweeps the extremes to show no pool level and no demand average can defeat the clamp. *(Original note, for the record: the invariants sweep the price for finiteness and non-negativity, but nothing bounded it away from zero; the floor/ceiling that make the controller respect that were two of the coefficients above, and were not a first cut taken in 5b-i.)*

⚠ **`reserve.avgDraw` IS THE SECOND SANCTIONED FLOAT ON THE RESERVE (slice 5b-ii).** It averages a quantity of fuel rather than counting one, so it is not rounded — the rounding to integer fuel happens at the point of grant, where it always has. The invariants sweep it for finiteness and non-negativity like the price. It is seeded to `DEUTERIUM_INFLUX_PER_CYCLE`, which invents nothing: it IS the influx constant, used as the honest opening guess that a galaxy with no history draws what the Syndicate supplies.
