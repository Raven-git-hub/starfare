# Fuel — Supply, Issuance, and the Price Loop (working design)

*Status: **design-in-progress**, captured 31-08-26. This is the consolidated fuel model as settled in the
31-08 design chat. It **supersedes the route/burn-based allocation** of `docs/fuel-allocation-model.md`,
**absorbs and extends** `docs/fuel-economy.md`, and **refines design.md §8**. Where a number is unruled it is
called an OPEN, never a silent constant. Not built. The exact price curve and the reputation event list are
the two big opens; both are content/numbers work, not conceptual gaps.*

## 0. The one-line frame

**Fuel is a commons.** One shared reserve, filled only as fast as deuterium is mined, drawn down every cycle
by every guild. Overdraw it and it collapses for everyone. The Syndicate referees the commons with a single
lever — **price** — and issues each guild its draw by **reputation measured against size**. This is "mutual
dependency without trust" made mechanical: the Dune premise as a tragedy of the commons.

## 1. Supply — how deuterium becomes pool fuel

The pipeline is unchanged from §8 and is the same for everyone (no special backend — the no-infinite-backend
invariant, preserved by construction):

> raw **deuterium** (mined, territorial) → **committed to the Syndicate** for credits + standing → the
> Syndicate **converts it 1:1** → **pool fuel**.

The pool holds no more than the deuterium someone mined.

### 1.0 The two goods and the two refining paths (clarified 31-08-26)

Two distinct goods (the #22 ruling, already in `sim/resources.js`):
- **`deuterium`** — a **raw, tier-1** resource. Mined (Oceanic planets, §3), lives in stockpiles, tradeable.
- **`deuterium_fuel`** — the fuel: a **processed "pseudo-tier-2"** good. The recipe is **1 deuterium → 1
  deuterium_fuel, nothing added, run in a factory asset.** It is *not* minable, not on the open market, and is
  priced by the fuel controller (§4), not the commodity price engine.

The same 1:1 conversion has **two paths, and legality is the only difference:**
- **Legal — the Syndicate, as bookkeeping.** The Syndicate **runs no physical assets.** When a guild commits
  raw deuterium to it, the Syndicate **auto-converts it 1:1 into pool fuel** at the moment of commitment — no
  factory, no venture, no recipe execution. That abstraction *is* the "monopoly refining."
- **Illegal — a guild's own factory.** A guild that **keeps** its raw deuterium and runs the 1:1 recipe in its
  **own factory asset** produces `deuterium_fuel` it holds. The recipe physically works — the engine does not
  hard-block it (**pressure, not prohibition**) — but it can **never be licensed**, and it is exactly what the
  Syndicate's usage-meter infers and fines (§3). *"Illegally hoarded deuterium must be refined in an asset
  before it can be used."*

**Build wrinkle (flagged, not solved):** `deuterium_fuel` is currently defined as *not* a processed good and
*not* any recipe's output, so realising the illegal-refine path means either adding it as a **special recipe**
that outputs the fuel good, or modelling illegal refining as **its own action**. Decide when it becomes a
slice.

### 1.1 Producer Guilds (PGs) — the seeded supply (supersedes §6's "hidden ticker")

`fuel-economy.md §6` left the background deuterium floor's implementation open ("a bot, or a hidden engine
ticker"). **Ruling: it's a seeded Producer Guild**, and that choice supersedes the hidden-ticker option,
because a real guild that really mines keeps the commons honest and buys emergent drama a ticker can't.

- **Shape:** an ordinary **bot guild** (reusing the guild/venture/asset machinery — no new entity), seeded
  into the generator on a fuel-rich home (terran + oceanic). **No ambition:** it mines deuterium and funnels
  **all** of it straight to the Syndicate; it never stockpiles, expands, tolls, or fights. It gets rich (which
  moves the deuterium market and makes it an **investment target** for real guilds — a parked hook riding the
  existing equity lever).
- **Non-combative → dies only to economic pressure.** A PG can't be attacked into ruin; it erodes only if the
  economics turn against it. **OPEN:** a costless miner can't actually go bust — economic collapse of a PG
  needs *some* cost on it (maintenance overhead, or margin compression as player supply undercuts it). Design
  the bust-cost when the maintenance system lands.
- **Weaning.** Two clocks: **takeover** (a player conquers the PG's system and inherits its deuterium supply —
  needs the territory/conquest system, Phase 3+, not built), and **economic bust** (above). The intent is that
  over a galaxy's life the server is **weaned off PG supply onto competitive players and bots.**

### 1.2 Collapse is a real, losable state — with a storyteller ladder out

**Ruling:** full weaning is allowed to end in **total fuel collapse** — players drain the commons, the PGs are
gone, nobody supplies deuterium, the galaxy chokes. This is deliberate: it's the tragedy-of-the-commons payoff.
**But on a perpetual server, collapse must be *recoverable***, or it's just a dead server. So the storyteller's
fuel-crisis intervention is a **required backstop, not garnish**: it injects emergency deuterium, spawns a
rescue PG, or cracks an Ancients cache — turning collapse into a brutal, climbable near-death saga rather than
a permanent brick. Lean into "the players nearly killed the galaxy and the Syndicate barely saved it."

### 1.3 Bootstrapping (the day-0 deadlock)

The galaxy opens already supplied, because the fiction is you're joining an **already-running** Syndicate:
- **The Syndicate opens with a starting pool** (seeded), and the PGs are producing from tick 0.
- **Each new guild opens with a baseline fuel-credit balance**, so a player can stumble onto viable fuel while
  finding their feet; the tutorial guides good early fuel decisions.

**Ruling (31-08-26):** the starter floor is `GUILD_STARTING_FUEL` (currently `[FIRST-CUT]` 500 units), minted
into the guild's `fuelHoard` in the `foundGuild` apply and recorded in `state.audit.totalProduced` so
invariant 1 closes from tick 0. The flat valuation is `FLAT_FUEL_PRICE_PER_UNIT` (currently `[FIRST-CUT]`
10 ¢/unit). Both constants live in `sim/fuel.js`. They are tuned after the waystation rebalance lands and
replaced by the real price controller when the fuel economy is built.

## 2. Issuance — the mean line (Points vs Reputation)

This **replaces the route/burn-based allocation** of `fuel-allocation-model.md` entirely. Allocation is no
longer sized to what you haul; it's sized to **how well you contribute relative to how big you are.**

- **Points = what you hold** (mines, systems, tolls, scanners, outposts, exploration…). Your *size / capacity*.
  Density beats sprawl (`fuel-economy.md §4`). Points set **the bar**.
- **Reputation = what you did** — every Syndicate interaction carries a **± reputation implication**,
  accumulating over the cycle. Your *track record*. It fluctuates (contrast Points).
- **The mean line is a DESIGNED curve** (confirmed — not a live population average; a population-relative line
  breaks with one guild and wobbles as guilds come and go). It maps Points → **expected reputation for a guild
  that size** ("3 mines, 50 rep each = 150 expected").
- **Your issuance = your position vs the line.** Actual reputation above the expected-for-your-size → **buff**;
  below → **penalty**. (Example: 3 mines expects 150; you have 200 → above → buffed issuance.)

**The property to protect: the bar rises with your size.** Every mine you add lifts your expected-reputation
bar, so a big guild must keep contributing *in proportion to how big it's grown* just to hold its issuance.
Bigness alone earns nothing — it raises the standard you're held to. This is "the storyteller targets the
comfortable" as pure economics, and it cuts both ways: it punishes coasting *and* hands the high-standing a
reputation buffer they're tempted to gamble (illegal refining, breaking ranks) — both roads to drama.

## 3. Holding fuel — banking, no cap, consume-only

**Issuance is granted as PHYSICAL fuel, not a spendable credit balance.**

- **At cycle start (tick 1), your fuel-credit entitlement converts to a quantity of fuel at that tick's price**,
  and you receive that physical fuel. The UI shows your **fuel quantity** and its **mark-to-market credit
  value** at the current price.
- **It accumulates, uncapped.** Unused fuel banks. A guild's held fuel is a real, growing asset.
- **Consume-only, officially.** Fuel is burned (by transport/spacecraft, §3 / #54); the Syndicate runs **no
  buy-back desk**, so fuel is never resold into the pool. Hoarding is therefore **defensive insurance**, not a
  profit pump — which keeps the commons a survival resource, not a commodities desk, and keeps open-question
  #31 (schemer vs bystander) from returning.
- **But peer-to-peer fuel trades exist as a grey market** (pressure, not prohibition): guilds may move fuel
  between themselves off the books. This is the "don't limit the player" valve, and off-book fuel movement is
  exactly what the Syndicate's usage-meter flags (below). *(Later; not Phase-1.)*
- **One pot with illegal fuel.** Legally-granted fuel and illegally-refined fuel (§1.0 — your own factory on
  the 1:1 recipe) accumulate in the **same** physical holding, so the Syndicate can't tell them apart by
  looking. It can only **infer**: it knows what it issued you; consumption/holdings that imply more fuel than
  your issuance could cover → suspected illegal refining → risk of a steep fine (§7, unenforced until Phase 5).
  *(Structure now; detection mechanic deferred, per `fuel-economy.md §5`.)*

## 4. The price loop — the Syndicate defends the reserve

Because issuance hands out **physical fuel from a finite pool**, price is the lever that keeps total draw in
line with supply. Each cycle **resolves** and sets the next cycle's fuel price.

- **The controller reads FLOW, not just level.** It compares **deuterium in** (refined into the pool this
  cycle) against **fuel out** (granted to all guilds), takes the **net change**, and moves price to correct it:
  reserve draining → raise price (each credit converts to less fuel → smaller grants → draw falls back under
  production); reserve filling → lower price (credits buy more → guilds trade more → the economy grows).
- **The setpoint is demand-relative.** The target reserve scales with **aggregate consumption** ("hold N
  cycles' worth of total draw, plus a buffer"), so the whole loop is scale-invariant — it behaves the same in a
  3-guild galaxy and a 30-guild one.
- **Goal:** set the price so the change in fuel-credit value brings next cycle's consumption back to
  replenishment, calibrated against **average consumption over a trailing window.**
- **The starting point is already playtested.** §8's port contract carries a reserve-based curve —
  `price = clamp(basePrice × (targetReserve / stockpile)^sensitivity, floor, ceiling)` — that produced the full
  squeeze signature when five guilds hand-played it. Use it as the level term; add the flow term above. **OPEN:
  the exact coefficients (base, target, sensitivity, floor, ceiling, the flow weight, the trailing window) are a
  SIM/spreadsheet job, not a prose job** — do not invent them here.

### 4.1 The crunch edge — where "credit, not share" necessarily bends

In the **healthy band** the reserve is ample, price keeps total grants well under supply, and issuance behaves
as a reputation-sized **currency, not a share** (the intended feel). At the **scarcity edge** the pool nears
empty and the Syndicate physically cannot honour every reputation-grant — so grants must be clipped or price
spikes to the ceiling, and issuance **degrades to rationing-of-what's-left.** This is correct: a fuel crisis
*should* feel like rationing. The only firm requirement it imposes: **the pool can never be over-granted below
zero** (a hard conservation floor — invariant 1). That floor, the life-support minimum, and the storyteller
rescue (§1.2) are the same safety layer viewed three ways.

## 5. Who feels the scarcity (left organic — watch one dial)

Not hard-ruled: it's expected to **emerge**. The mechanism that makes it plausible — fuel burns on
**transport/trade**, and big guilds trade more, so a large guild's **burn scales with its size** and it stays
exposed to scarcity despite its hoard, while a lean guild is near self-sufficient and gains leverage over the
big. The one dial that decides whether the big are exposed or insulated is **burn-growth vs hoard-growth** —
a **watch-it-in-play** number, not a pre-solve.

## 6. Open questions (decide on purpose)

1. **The price curve coefficients** and the flow/level blend (§4) — a sim/spreadsheet pass, like the original.
2. **The reputation event list** — which Syndicate interactions move reputation, which direction, how much. The
   big content lump; the whole engine idles without it (`fuel-economy.md §9.1`, invariant-8 rule #61).
3. **The Points formula** — source weights and the density-over-sprawl shape (`fuel-economy.md §9.2`).
4. **The mean-line shape** — expected-reputation vs Points, and the position→buff/penalty map.
5. **PG bust-cost** (§1.1) — what makes a costless miner economically fail.
6. **Deuterium's map presence** — confirm which archetypes carry deuterium nodes (terran/oceanic) and that the
   generator places enough for the PG homes and player mining. (Ties to the seed-generator rework.)
7. **Detection mechanic** for illegal refining / grey-market fuel (§3) — deferred, structure-only now.

## 8. Build sequence — the mini-roadmap to fuel-on-a-trade

**End goal:** a Syndicate trade action computes and deducts the **fuel cost of its route**. Reachable with
`[FIRST-CUT]` numbers and **without** the pool/issuance/mean-line/price machinery — those get built *under* it
later. This is the consumption side; everything in §1–§5 is the supply/economy that eventually feeds it.

**The three slices to the goal** (each a vertical, engine-first, tune-by-play):

- **Slice 1 — Fuel becomes a real, spendable, seeded balance.** ✅ Built (PR #50). `sim/fuel.js` created;
  `GUILD_STARTING_FUEL = 500` and `FLAT_FUEL_PRICE_PER_UNIT = 10` defined. `foundGuild` apply seeds the hoard;
  `totalProduced` seeded to match; `galacticSupply` cache refreshed. `fuelHoardValue` exposed in snapshot.
- **Slice 2 — The route fuel-cost quote ("define fuel credits on a route").** ✅ Built (engine-only).
  `SYNDICATE_HAULER_BURN_RATE = 0.5` and `routeFuelCost(systemId)` added to `sim/fuel.js`; `fuelCost`
  map added to the per-guild snapshot block, keyed by **held** systemId and sorted. `routeFuelCost`
  reads the distance `nearestWaystation` already computed — the same value `buyFromSyndicate` schedules
  the arrival tick from — so the quote and the flight cannot be priced on different geometries. Quote
  only: **nothing is deducted**, and `buyFromSyndicate` is untouched (it still derives the route inline;
  Slice 3 wires it).
  - **Burn model — RULED (31-08-26):** `fuel = distance × craftBurnRate`, **cargo-independent**. Syndicate
    trades fly the one Syndicate hauler; its `[FIRST-CUT]` rate is `SYNDICATE_HAULER_BURN_RATE = 0.5`.
  - **SELL routing — RULED (31-08-26):** SELL uses the same system→nearest-waystation route as BUY.
- **Slice 3 — Deduct it on the Syndicate trade action.** Not yet built. BUY-only in this slice; SELL fuel
  deduction deferred pending a ruling on per-allocation-row vs total cost for multi-system sales. Reject-whole
  (no partial trade on short fuel).

**Then — the economy that feeds it** (§1–§5, spreadsheet-first for the numbers): pool + deuterium 1:1 supply
spine with a seeded Producer Guild; simple per-cycle issuance; mean-line issuance (needs Points formula +
reputation event list); reserve/flow price controller; edges (illegal refining, grey market, PG weaning,
storyteller rescue).

## 7. What this supersedes / refines

- **`docs/fuel-allocation-model.md`** — its per-route, per-burn allocation is **retired**; issuance is now the
  mean line (§2). Its pool / refining-monopoly / no-infinite-backend framing **stands** and is reused.
- **`docs/fuel-economy.md`** — this doc is its successor: same reputation/Points/mean-line spine, now joined to
  the supply side (PGs), the banking model, and the price loop.
- **design.md §8** — refined: allocation is mean-line issuance (not per-burn purchasing power); the background
  floor is a Producer Guild (not a hidden backend); fuel is now priced by a dedicated reserve/flow controller.

*When the two big opens (the price curve and the reputation list) are filled, this hardens into a design.md §8
rewrite + the retirement of `fuel-allocation-model.md`'s route model, as a single doc-only commit.*
