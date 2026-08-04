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
- **First recipe** `[FIRST-CUT]` (03-08-26): **`titanium_to_alloy` = 3 titanium -> 1 alloy_ingot** per batch. A refining venture sits on a settlement slot and runs up to `productionRate` batches/tick, throttled by the titanium its owner holds. The catalog lives in `sim/recipes.js`.
- **Processed-good id** `[FIRST-CUT]`: **`alloy_ingots`** — a *processed* good (held in stockpiles like a raw good, summed into galactic supply), distinct from raw resources and from the special `deuterium_fuel`. Id string open to veto; the raw/processed/fuel three-way distinction is settled.
- **Refinery throughput**: `productionRate` (batches/tick) is **operator-supplied**, not a baked constant — like the mining rate, only Titanium's is ruled, so the testbed dials it.

### The second good (tolled/shipped raw)
- **Good** `[FIRST-CUT]`: **Titanium** (a Tier-1 raw; also the onboarding starter-quest good, so it recurs later).
- **Market** `[FIRST-CUT]`: reuses the fuel price curve's *shape* (§5) with its own levers — base $3, target reserve 20, sensitivity 0.6, floor $1, ceiling $20.
- **Extraction rate** `[FIRST-CUT]`: a **base rate per resource** — a property of the resource mined, *not* a mine 'tier' (mines have no tiers). Titanium **5/tick** (ruled 01-08-26); a common Tier-1 raw yields decently, a scarcer one less (a gold mine might yield ~1). Mines can later be buffed (droids) — out of scope now; the model leaves room, since production reads the base rate and a buff would modify the *effective* rate at step time.

### Guild starts
- **Five bot guilds** `[SHEET]`: exactly the spreadsheet roster (Refinery Combine, Vantar Trust, Orun Compact, Dracis Concern, Ilyra Holdings) — their credits, needs, capacities, hoard 0.
- **Player guild** `[FIRST-CUT]`: deliberately archetype-neutral — credits **$120**, hoard **0**, fuel need **5**, capacity **8**, one **Titanium mine**. Unremarkable on purpose, so no archetype is favoured.

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

---

*When Stage 2/3 runs and these start to feel wrong, change them here. That is the expected workflow, not a failure of planning.*
