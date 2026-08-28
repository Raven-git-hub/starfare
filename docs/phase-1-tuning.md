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
