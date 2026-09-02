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

**⚠ REVISED 31-08-26 — read this first; it supersedes the ruling and the bullets below.** The mechanical
"real mining PG" model below is **retired**. The ruled design is now:

- **Supply is an abstracted back-end deuterium influx into the Syndicate pool** — mechanically, the hidden
  engine ticker this section originally set aside. One tuned amount per cycle enters the pool; it is **not**
  computed from any PG's mining. This reverses the "a real miner beats a ticker" argument below, on purpose:
  the mining connection bought two drama hooks — the PG as an equity **investment target**, and takeover
  **inheriting** its supply — both Phase-3+ anyway, so they are deferred, not lost.
- **PGs are narrative / territorial only, MECHANICALLY DECOUPLED from the supply.** Ordinary bot guilds (no
  new entity) that hold territory and can be conquered later; they do **not** mine-to-pool, trade, pay fees,
  or draw fuel issuance. The Syndicate sustains them entirely — **no back-end economy to model**, which also
  **closes §6 open 5 (PG bust-cost):** a Syndicate-sustained PG cannot fail economically; it ends only by
  **takeover** or the deliberate weaning/collapse.
- **They home on an OCEANIC world in a NON-TERRAN system** (not the terran+oceanic home below) — a PG's home
  planet may be non-Terran, the one relaxation of the "home = the lowest-id Terran planet" rule, which keeps
  PG placement clear of the starter-eligible (Terran) systems players spawn into.
- **The PG is NOT an investment target** — the equity hook below is removed.
- **Takeover hook (future):** conquering a PG's system **removes a fixed amount from the back-end deuterium
  influx** — the clean way to tie the abstracted supply to the PGs when the territory/conquest system lands
  (Phase 3+). Not "inherit the supply".
- **PGs are HIDDEN on the map from players** (unlike waystations, which are public), **discoverable by
  scanner arrays** — a hook into the future exploration / espionage layer.
- **Deferred, and decoupled from the fuel loop:** placing PGs needs a guild-seeding layer (nothing seats a
  bot guild at galaxy creation today — the galaxy boots empty) plus the non-Terran-home relaxation, so it is
  its **own later slice**. The fuel loop (pool + the back-end influx + issuance) needs **no PG at all**.

*The original real-mining-PG design is kept below for the record; where it disagrees with the block above,
the block above wins.*

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

### 2.1 The issuance mechanic — slice 5a (ruled 31-08-26; **BUILT 31-08-26**)

> **✅ BUILT.** `sim/issuance.js` (the three constants, `grantFor`, `rationGrants`) and step 6 of the tick
> (`sim/tick.js` `stepBaselineAllocation` — §15.6 names "fuel allocation" as a per-tick shared-resource
> concern, and step 6 is the allocation step; the eight-step order is unchanged). Published per guild in the
> snapshot as `fuelGrant` and shown in the operator console beside the pool.
>
> **THE POOL IS `state.reserve.reserveLevel` — no new field.** The wording below offers
> "`state.syndicate.fuelPool` **or equivalent**", and the equivalent already existed: that field has been the
> communal Syndicate reserve since the walking skeleton, is named as such by `sim/supply.js` and
> `sim/resources.js`, is the **Fuel Utility** entity of `design.md` §15.4, and was ALREADY a term in invariant 1
> and in `galacticSupply.fuel`. Minting a second pool beside it would have been two sources of truth for one
> number — with the conservation law summing one while the code filled the other. All this slice had to add was
> a real seed (`POOL_SEED`) in place of the `[SHEET]` placeholder 30 the zero-state carried.
>
> **What is NOT built:** the price controller (§4, slice 5b) — grants are physical fuel at the flat price, and
> nothing pushes draw back under supply, so an out-drawing galaxy rations and stays rationed. That is the
> losable state of §1.2, intended for this cut.


*Rules the "how much fuel each guild gets" mechanic; the price CURVE (5b) stays open. Numbers are `[FIRST-CUT]`
in `phase-1-tuning.md`; this rules the SHAPE.*

**Each cycle, at the window boundary, the Syndicate grants each guild fuel from a finite pool:**

    fuelGranted(guild) = round( BASE_GRANT_PER_GP · GP(guild) · issuanceModifier(guild) )

- **The base is SIZE-RELATIVE (ruled): `BASE_GRANT_PER_GP · GP`.** A guild's base entitlement scales with its
  Guild Points (`points-and-reputation.md §1.0`) — bigger footprint, bigger base — and the mean-line modifier
  (§3 there, `[0.3, 1.5]`) scales it by how well it contributes *relative to* that size. GP is both the base and
  the divisor inside the modifier's expected line, which is exactly "draw sized by reputation-against-size"
  (§0). *(demand/consumption-relative base was considered and **ruled against** 02-09-26 (see §2.2): the base stays contribution-relative, and the open lever is the calibration of `BASE_GRANT_PER_GP`, which is downstream of the seed.)*
- **Integer fuel: `round(…)`.** This is where slice 4's deliberately-unrounded float modifier meets integer
  fuel (§15.2) — the rounding is ruled HERE, at the point of grant, and nowhere upstream.

**The pool — a finite, conserved Syndicate reserve.**

- New state: a Syndicate-owned fuel store (`state.syndicate.fuelPool` or equivalent), **seeded** at galaxy
  creation (§1.3, `POOL_SEED`) and **non-negative** — a hard floor (invariant 1's conservation).
- **Supply IN:** the abstracted **back-end deuterium influx** (§1.1, revised) adds `DEUTERIUM_INFLUX_PER_CYCLE`
  to the pool each cycle. Fuel is **minted** into the pool here (recorded in `audit.totalProduced`, as the
  starter hoard is), so invariant 1 balances.
- **Issuance OUT:** each grant **moves** fuel `pool → guild.fuelHoard` — a transfer, conserved, minting nothing.
  The pool joins `galacticSupply` as a fuel holder, so the supply invariant sums `pool + Σ hoards`.

**Rationing — the pool can never be over-granted below zero (ruled, §4.1 / invariant 1).** When the cycle's
total grants exceed what the pool holds, grants are **clipped proportionally** to each guild's share, so the
pool empties to exactly 0 rather than going negative. Without the price controller (5b) nothing pushes draw
back under supply, so a galaxy that out-draws its influx **rations, then risks collapse** — the losable state
of §1.2, correct and intended for this cut.

**Price mediation — slice 5b-i (ruled 01-09-26; ✅ BUILT 01-09-26; byte-identical).** The grant now passes through a market fuel **price**. `round(BASE_GRANT_PER_GP · GP · modifier)` is a guild's **entitlement at the reference price** (the existing `grantFor`, unchanged); the physical fuel it receives is `round(entitlement · REFERENCE_FUEL_PRICE / reserve.fuelPrice)`, so the same reputation-sized entitlement buys **less** fuel when the price is high — the lever that pulls draw back under supply. **5b-i holds the price fixed at `REFERENCE_FUEL_PRICE`**, so the ratio is exactly `1.0` and the grant is **byte-identical to 5a** (the plumbing lands with no behaviour change). The controller that **moves** the price each cycle is **5b-ii** (§4.2), where the price state, the retired flat constant and the ratio-vs-rebase choice are ruled, and which is **NOT built**.

**Out of 5a:** the dynamic price controller (5b); the Producer Guilds (their own later slice — the influx is
abstracted, §1.1); closure; illegal refining; the grey market.

### 2.2 The grant base — contribution confirmed; the real levers, corrected (ruled 02-09-26, corrected same day post-seed)

§2.1's parenthetical floated a *demand/consumption-relative* base as a later refinement. **Ruled against —
closed, not deferred.** The grant stays **contribution-relative** (`BASE_GRANT_PER_GP · GP · modifier`, unchanged
shape). §2's own thesis: issuance is sized to *what you contribute relative to your size*, never *what you took
last cycle*. A consumption-relative base would (a) make expansion non-strategic — max out transport for one
cycle and the grant follows — and (b) be exploitable: above the line, churn junk trades to inflate your assessed
need and the grant returns more fuel than you burned. **You get what you contribute, not what you took.** *(This
half stands.)*

**⚠ CORRECTION — the first cut of this section aimed the fix at the wrong knob, and measuring on the regenerated
seed proved it.** It claimed you'd set `BASE_GRANT_PER_GP` so an on-line guild draws what it consumes. But
dropping the base from 0.3 to 0.11 on the recorder **barely moved the physical grants** (Forge 368 → 354,
Meridian 245 → 236); what it moved was the **price**, 12.2 → 4.6. The engine's own invariant is why: *the pool
settles exactly where total draw equals the influx*, so the total physical fuel leaving the pool each cycle is
pinned to the **influx**, and each guild's share is `GP·modifier ÷ Σ(GP·modifier)` — in which
`BASE_GRANT_PER_GP` **cancels**. The corrected levers:

- **`DEUTERIUM_INFLUX_PER_CYCLE`** sets the galaxy's total physical fuel per cycle — the **abundance**, i.e. how
  many hauls the galaxy can afford.
- **`BASE_GRANT_PER_GP`** sets the resting **price** (`price = REFERENCE · Σentitlement ÷ influx`), **not** the
  quantity of fuel.
- **`GP · modifier`** sets each guild's **share** of the fixed total — so a high-standing guild always draws a
  bigger slice than a low-standing one. **The throttle *between* guilds rides here** and holds at any abundance:
  a below-line guild gets a thinner slice of whatever the galaxy has.

**Per-trade fuel, measured on the new 96-waystation seed (02-09-26):** mean **~7.6** (median 7, range 1–23) —
~4× cheaper and far more uniform than the old ~30 (the waystation rebalance did exactly what it was for). So the
*same* influx now buys ~4× more hauls: an on-line guild in a small galaxy draws ~32 hauls/cycle.

**⚠ Hauls-per-guild is population-relative under a fixed influx** — one fixed pool split by share, so more guilds
means a thinner slice each (and a higher price). "~32 hauls" is a *small-galaxy* figure. This is not a bug to
tune out; it is the **commons** — the Syndicate produces a baseline and the galaxy competes for it.

**The supply model (ruled).** The influx is a **fixed PG baseline** (the abstracted §1.1 back-end supply) that
**grows organically as player guilds produce deuterium into the pool** — there is **no mechanical link to
population**; the influx rises because fuel is actually *made* (licensed deuterium mining, §1.0/§1.1's later
slice) and falls back toward the baseline when production stops. Fuel abundance is an emergent, player-driven
quantity sitting on a fixed floor.

**DECISION (02-09-26): leave the baseline loose — no constant change.** `DEUTERIUM_INFLUX_PER_CYCLE` stays
**800** and `BASE_GRANT_PER_GP` stays **0.3**. On the new seed 0.3 yields a resting price near the reference (~12
on the recorder galaxy), and 800 is deliberately abundant (~32 baseline hauls for an on-line guild in a small
galaxy). Fuel is **not a hard throttle at the baseline** right now, by choice: the throttle emerges as a server
fills (more guilds sharing the fixed baseline) and the tension is meant to be worked by the emergent supply —
guilds choosing to mine deuterium — not by a tight starting number. The tighter baselines were on the table and
are recorded as the known knob, not taken: **influx ~175 / base ~0.065 → ~7 on-line hauls**; **influx ~350 /
base ~0.13 → ~14** (the base moves only to hold the price near reference when the influx moves). Dial in from
playtest later.

**What stands from the first cut.** The **conservation audit** (02-09-26): the built engine rations against the
reserve (`rationGrants`, hard-floor assert), reads the price off the **post-issuance** pool against a
demand-relative target, burns a **fixed unit** quantity per route (credits derived at sale, never stored), and
marks the hoard to market on read — no unit leak survived, and **the architecture needs no change; this whole
item resolved to *tune nothing yet*.** The **war chest** stays the storyteller's, not the fuel layer's —
bank-forever (§3) stands; a guild grown too comfortable is Phase 6's target, and while loose supply lets everyone
accumulate, the high-standing draw fastest by their larger share. *(`sim/issuance.js`'s comment calling a
consumption-relative base "a possible later refinement, deferred to 5b" should be reconciled to "ruled against"
whenever that file is next touched — no code change is otherwise implied.)*

**The next substantive fuel work is the SUPPLY side, not the grant.** The engine that *spends* fuel is done;
what's unbuilt is what *makes* it — the PG baseline as a real entity and licensed/unlicensed deuterium mining
that grows the influx (the auto-100%-commit, T4-RP, output-to-Syndicate venture, §1.1). That is where the fuel
economy gets its teeth, and it is a build of its own.

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

- **The controller reads the reserve LEVEL** (flow deferred — see §4.2). When the pool drains below its
  target, price **rises** (each credit converts to less fuel → smaller grants → draw falls back under
  production); when it fills above, price **falls** (credits buy more → guilds trade more → the economy grows).
  *(The original design also read the FLOW — deuterium-in vs fuel-out — as a faster corrective; the 5b-ii
  modelling (01-09-26) found the level term alone converges cleanly and a naive flow term destabilised it, so
  flow is **deferred to a possible refinement**, §4.2.)*
- **The setpoint is demand-relative.** The target reserve scales with **aggregate consumption** ("hold N
  cycles' worth of total draw, plus a buffer"), so the whole loop is scale-invariant — it behaves the same in a
  3-guild galaxy and a 30-guild one.
- **Goal:** set the price so the change in fuel-credit value brings next cycle's consumption back to
  replenishment, calibrated against **average consumption over a trailing window.**
- **The starting point is already playtested.** §8's port contract carries a reserve-based curve —
  `price = clamp(basePrice × (targetReserve / stockpile)^sensitivity, floor, ceiling)` — that produced the full
  squeeze signature when five guilds hand-played it. Use it as the level term. **RESOLVED by the 5b-ii
  modelling (01-09-26):** the coefficients are ruled `[FIRST-CUT]` from a simulation validated against the
  recorder's real integer grants — see §4.2 / 5b-ii and `phase-1-tuning.md`. The flow term is **deferred** (it
  did not help in the model), so its weight is no longer an open coefficient.

### 4.1 The crunch edge — where "credit, not share" necessarily bends

In the **healthy band** the reserve is ample, price keeps total grants well under supply, and issuance behaves
as a reputation-sized **currency, not a share** (the intended feel). At the **scarcity edge** the pool nears
empty and the Syndicate physically cannot honour every reputation-grant — so grants must be clipped or price
spikes to the ceiling, and issuance **degrades to rationing-of-what's-left.** This is correct: a fuel crisis
*should* feel like rationing. The only firm requirement it imposes: **the pool can never be over-granted below
zero** (a hard conservation floor — invariant 1). That floor, the life-support minimum, and the storyteller
rescue (§1.2) are the same safety layer viewed three ways.

### 4.2 The two build slices — 5b-i (price plumbing) and 5b-ii (the controller)

The loop above lands in **two slices**, one module at a time (`design.md` §18 #3).

**5b-i — price mediation (the plumbing; ruled 01-09-26; ✅ BUILT 01-09-26; byte-identical).** Introduces the
market price as STATE and routes the grant through it, with the price held fixed so nothing about the economy
moves yet.

- **`reserve.fuelPrice`** — a float, the ONE market price of `deuterium_fuel`, seeded at galaxy creation to
  `REFERENCE_FUEL_PRICE`. It is **serialized** reserve state (it must persist cycle to cycle for 5b-ii to move
  it), so the determinism goldens gain this one field — proven, as the founding endowment was, by an inverted
  strip that deletes it and recovers the pre-slice hash byte for byte.
- **`REFERENCE_FUEL_PRICE` (`[FIRST-CUT]` 10)** — the price at which `BASE_GRANT_PER_GP`'s "5 fuel/GP" is
  calibrated, taking the value of the **retired** `FLAT_FUEL_PRICE_PER_UNIT`. There is now ONE fuel price
  (invariant 5): `reserve.fuelPrice` serves both the grant conversion and the hoard's mark-to-market.
- **The grant — the RATIO form.** `entitlement = round(BASE_GRANT_PER_GP · GP · modifier)` (unchanged);
  physical = `round(entitlement · REFERENCE_FUEL_PRICE / reserve.fuelPrice)`. Scaling the already-rounded
  entitlement by `reference / price` is chosen over re-basing the product, because at the seed price the ratio
  is **exactly `1.0`** and the grant is byte-identical; the re-based `round(50 · GP · mod / 10)` was tested and
  drifts by a unit in ~0.3% of cases (float reassociation), which would break the no-op.
- **The hoard tracks the price.** `fuelHoardValue = round(fuelHoard · reserve.fuelPrice)` (was the flat
  constant) — identical at the seed price; once 5b-ii moves the price, a hoard is worth **more** when fuel is
  scarce, which is intended.
- **Fixed price ⇒ byte-identical.** 5b-i seeds and holds `fuelPrice = REFERENCE_FUEL_PRICE`, so every grant and
  every hoard value is unchanged from 5a; the whole behaviour change belongs to 5b-ii.

**AS BUILT (01-09-26)** — where each of the five rulings above landed, and the two places the build had to decide
something the ruling did not name:

- `REFERENCE_FUEL_PRICE` = **10** and `fuelValue(units, price)` in **`sim/fuel.js`**; `reserve.fuelPrice` on
  **`createReserve`** (`sim/state.js`), which **defaults** it — `reserveLevel` stays required, because a pool level
  is galaxy-scale and only a scenario can know it, while a price has exactly one sensible opening value. So
  `zero-state.js` and every fixture in the repo pass `{ reserveLevel }` alone and stay valid, unchanged.
- The conversion is **`physicalGrantFor(state, guild)`** in `sim/issuance.js`, beside the untouched `grantFor`;
  `tick.js`'s step 6 calls it in place of `grantFor` and everything downstream — the rationing, the transfer, the
  `lastFuelGrant` record — is in physical fuel, which is the only unit the pool is denominated in.
- **THE THIRD CONSUMER, which §4.2 did not name.** The retired constant had three readers, not two: the hoard's
  mark-to-market, the issuance conversion, **and `routeFuelCost`'s `creditCost`**. The same "one price" principle
  covers it, so the route quote is marked to `reserve.fuelPrice` too — and the function **split**:
  `routeFuelCost(systemId)` now returns `{ fuelBurn }` alone, because a burn is GEOMETRY and is what the engine
  actually CHARGES, while what it is WORTH is a valuation at a price that changes every cycle. The valuation moved
  to the display site (`sim/snapshot.js`), exactly parallel to the hoard's, through the same `fuelValue`. The
  physical `fuelBurn` is unchanged and every caller's `const { fuelBurn } = routeFuelCost(id)` still reads.
- ⚠ **A GUARD THE RULING DOES NOT NAME.** `physicalGrantFor` **throws** on a `fuelPrice` that is not finite and
  `> 0`, rather than dividing by it. Nothing in 5b-i can reach it — the price is seeded and held — which is why it
  is worth having *now*: 5b-ii's controller is what will start writing the field, and a zero or NaN price would
  otherwise hand out Infinity or NaN fuel that sails past the rationing and into a hoard before any invariant
  looks (§15.5: halt and report, never continue quietly). 5b-ii's `floor` is what will make the controller respect
  it; until then, the guard is what says so.
- **Exposed:** `galacticSupply.fuel.fuelPrice` in the snapshot (additive, schema stays 7), so the console and the
  recorder are already watching the number 5b-ii will move.
- **Proven byte-identical**, not asserted: the determinism goldens gain exactly `reserve.fuelPrice` and nothing
  else. Every pre-slice hash in `persist.test.js` and `commitment-scaffold.test.js` is **UNCHANGED** and now
  asserted with that one field stripped — including the committed 40-tick run, which crosses ten cycle boundaries
  and issues ten cycles of grants. Three new hashes pin the price-inclusive state beside them.

**5b-ii — the controller (level-only; ruled 01-09-26; ✅ BUILT 01-09-26; coefficients `[FIRST-CUT]`, modelled).** Each cycle, AFTER
issuance, the controller sets NEXT cycle's `reserve.fuelPrice` from the reserve **level** against a
**demand-relative** target. The pool is its own integrator: draining below target raises the price until draw
falls back to the influx, so the controller **discovers the equilibrium price for any galaxy without hardcoding
it** — scale-invariant by construction.

- **The curve:** `nextPrice = clamp(REFERENCE_FUEL_PRICE · (target / max(1, reserveLevel))^PRICE_SENSITIVITY,
  PRICE_FLOOR, PRICE_CEIL)`. **`basePrice = REFERENCE_FUEL_PRICE`** — no new base-price number; the price sits at
  the reference exactly when the pool is at target, rises above it when draining, falls below when filling.
- **The demand-relative target:** `target = TARGET_CYCLES · avgDraw`, where `avgDraw` is a smoothed (EMA) trailing
  average of the total physical fuel granted per cycle — a new **serialized** field `reserve.avgDraw`, seeded to
  `DEUTERIUM_INFLUX_PER_CYCLE` (a balanced-galaxy opening assumption). The target scales with consumption, so a
  3-guild and a 30-guild galaxy behave the same.
- **`[FIRST-CUT]` coefficients — modelled, then validated against the recorder's REAL integer grants (workings in
  `phase-1-tuning.md`):** `PRICE_SENSITIVITY = 1.5`, `TARGET_CYCLES = 3`, `DRAW_EMA_ALPHA = 0.22` (≈ an 8-cycle
  window), `PRICE_FLOOR = 2`, `PRICE_CEIL = 40`. In the discrete simulation the pool converges with **no
  oscillation and no draw jitter**, and absorbs a 2× demand jump in ~9 cycles; equilibrium prices run ~2–30 across
  0.2×–3× draw:influx galaxies, which the floor and ceiling bracket.
- **The 5b-i guard becomes a floor.** `PRICE_FLOOR > 0` is what makes the controller respect `physicalGrantFor`'s
  divide-by-price guard (§4.2, 5b-i AS BUILT): the price the controller writes can never reach 0.
- **Ordering (§15.6 step 6; §8 "price posted this cycle governs next"):** issuance runs at the CURRENT price; the
  controller then reads this cycle's realized draw and the resulting pool level and writes the price for the NEXT
  cycle. The first cycle uses the seeded reference price.
- **The recorder is the proof.** With the controller, the recorder scenario's pool **stabilises** instead of
  bleeding to zero — the headline demonstration. The scenario and its test are updated: normal load now converges
  (no rationing), and a **genuine-crisis** load — draw exceeding what even `PRICE_CEIL` can throttle — still
  exercises the rationing edge (§4.1). The committed trace changes to show the stabilisation.
- **NOT a no-op — this is the behaviour change.** The price moves and draw bends to supply. `reserve.avgDraw` is a
  new serialized field (strip-proven where no cycle boundary is crossed); runs that cross boundaries re-pin with
  the new, stabilising trajectory.

**AS BUILT (01-09-26)** — where each piece landed, the numbers the real engine produced, and the two places the
build had to decide something this ruling did not name:

- The five coefficients and three pure functions live in **`sim/issuance.js`**, beside `BASE_GRANT_PER_GP` and the
  influx: `targetReserve(avgDraw)` (the ONE definition of the target), `nextAvgDraw(avgDraw, cycleDemand)` (the
  EMA) and `nextFuelPrice(reserveLevel, avgDraw)` (the curve). Three small pure functions rather than one that
  takes `state`: each is a single rule, each is testable alone, and the tick step is the only place the ORDER
  between them is decided. `reserve.avgDraw` is on **`createReserve`** (`sim/state.js`), defaulting to
  `DEUTERIUM_INFLUX_PER_CYCLE` on the same reasoning that let `fuelPrice` default in 5b-i — so every
  `{ reserveLevel }` fixture in the repo stayed valid and unchanged.
- **Wired at the END of `stepBaselineAllocation`** (§15.6 step 6): influx → issuance at the CURRENT price →
  rationing → `reserveLevel -= moved` → the controller. It moves no fuel, so invariant 1 cannot see it.
- ⚠ **THE ONE PLACE THE RULING'S WORDING AND THE BUILD DIVERGE: `avgDraw` averages Σ DESIRED, not Σ GRANTED.**
  The bullet above calls it "a trailing average of the total physical fuel granted per cycle". Outside a crunch
  those are the same number; inside one they are not, and **granted is the reading that breaks the loop** — a
  galaxy in shortfall would report falling demand precisely *because* it was being starved, the demand-relative
  target would shrink with it, and the price would ease exactly when the shortfall was worst. Concretely, on a
  pool of 2000 with true demand averaging 1200: desired gives a target of 3600 and a price of ~24, granted-at-800
  gives 2400 and ~15.7 — and the cheaper price buys **more** fuel out of a pool already short. So the build reads
  **Σ desired**, the sum step 6 already computes at the `physicalGrantFor` line before rationing. (At a fully
  empty pool both readings clamp to the ceiling and it makes no difference; it is the PARTIAL shortfall, where
  the price still has room to move, that the choice decides.) The wording above is the ruling's; this note is the
  correction, and a test pins it through the real tick.
- ⚠ **A GUILD-LESS GALAXY NEVER RUNS THE CONTROLLER.** Step 6's pre-existing `guilds.length === 0` early return
  sits before it. Deliberate rather than incidental: a galaxy with no players has no demand to average and
  nothing that could draw at any price, so running the curve would drive `avgDraw` to 0, the target to 0 and the
  price to the floor — a meaningless answer written into serialized state. It also keeps a guild-less run
  byte-identical, which the zero-state's own tests rest on.
- **What the real engine does**, against the model's predictions (`phase-1-tuning.md`): on the recorder galaxy the
  pool converges to **~2100** and the price to **~12.17**, with draw at **799** against an influx of 800 — beside
  the modelled 2108 / 12.15 / 800. **No oscillation**: the settled pool is monotone. A galaxy three times the size
  settles at the same *draw* and the same *target* but a **smaller pool and a dearer price** (~1006 / ~36.8) —
  worth stating, because "scale-invariant" reads as "identical in every column" and it is not: what is invariant
  is the outcome, and the buffer is what the curve trades to produce the price that galaxy needs.
- **The crunch edge survives, and is now the only way to reach rationing.** A galaxy whose demand exceeds what
  `PRICE_CEIL` can throttle pins at 40 and rations exactly as 5a did. The recorder gained a second scenario for
  it (`buildCrisisScenario` — five wings of the SAME guilds, so the crisis is "too big for its supply", not "a
  strange guild"), because the four-guild run no longer rations and would otherwise have retired the repo's only
  multi-cycle exercise of `rationGrants`'s clip. The ceiling is a **clamp, not a trap**: a galaxy whose load falls
  climbs back off it, which is tested.
- **Determinism, enumerated.** Runs that cross NO cycle boundary gained exactly `reserve.avgDraw` and nothing else
  — every pre-slice hash in `persist.test.js` and the UNLICENSED run in `commitment-scaffold.test.js` is
  UNCHANGED under a strip of that one field, and both are asserted to still carry the seeded price and average.
  The COMMITTED run crosses ten boundaries, so the controller ran ten times and its three hashes moved **for the
  behaviour change**, re-pinned with the pre-controller values kept beside them. Its inverted un-flow proof still
  recovers the pre-5a bytes even though the amounts moved changed — which is the sharpest evidence that the
  controller touched the fuel flows and nothing else.

**Flow — deferred, not dropped (`[DEFERRED]` → possible 5b-iii; still deferred as built, 01-09-26).** §4's original design read the FLOW
(deuterium-in vs fuel-out) as a faster corrective. The 5b-ii modelling found the level term alone converges
cleanly and a *naive* flow term made things worse — deeper dips, ~5× slower recovery, and at higher weight it
crashed the pool to zero fighting the level term. So flow is **deferred to a possible later slice** if playtesting
shows the ~9-cycle recovery from a demand shock feels sluggish; a proper derivative/damping form would be modelled
to be *stably* faster than level-only before it is built. Its weight is not a `[FIRST-CUT]` coefficient today.

## 5. Who feels the scarcity (left organic — watch one dial)

Not hard-ruled: it's expected to **emerge**. The mechanism that makes it plausible — fuel burns on
**transport/trade**, and big guilds trade more, so a large guild's **burn scales with its size** and it stays
exposed to scarcity despite its hoard, while a lean guild is near self-sufficient and gains leverage over the
big. The one dial that decides whether the big are exposed or insulated is **burn-growth vs hoard-growth** —
a **watch-it-in-play** number, not a pre-solve.

## 6. Open questions (decide on purpose)

1. **The price curve coefficients** and the flow/level blend (§4) — a sim/spreadsheet pass, like the original.
2. **The reputation event list** — ✅ **RULED 31-08-26** → see `docs/points-and-reputation.md` §2
   (per-venture RP, MEET/BREACH, the −500-to-approximately-1500 band, `[DEFERRED]` sources). Spine is
   licence met/breach; first build slice wires exactly that.
3. **The Points formula** — ✅ **RULED 31-08-26** → see `docs/points-and-reputation.md` §1 (Guild Points:
   deployed holdings, tier-scaled, idle = 0; `[DEFERRED]` sources named so Code invents no fields).
4. **The mean-line shape** — ✅ **RULED 31-08-26** → see `docs/points-and-reputation.md` §3: linear
   `expectedRP = MEANLINE_K × GP`; position→issuance is a clamped ratio-based modifier
   `clamp(1 + s·gap/expected, FLOOR, CEIL)`.
5. **PG bust-cost** — ✅ **RESOLVED 31-08-26 (§1.1):** the PG is Syndicate-sustained and mechanically
   decoupled from the supply, so it has no back-end economy and cannot fail economically — it ends only by
   takeover or weaning. No bust-cost to design.
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
- **Slice 3 — Deduct it on the Syndicate trade action.** ✅ Built (engine + client). **BUY-only**, as
  scoped: `buyFromSyndicate` gates on `routeFuelCost(destinationSystemId).fuelBurn` — the gate runs
  **last**, so a trade short on credits or territory is refused on those terms — and the apply deducts
  the burn from `guild.fuelHoard`, adds it to `audit.totalConsumed` (this counter's first writer), and
  refreshes the `galacticSupply` cache the deduction moves. **Reject-whole**: no partial trade, no
  shorter flight. Client: the SELL panel gained a Fuel row reading the snapshot's `fuelCost`, plus a
  short-fuel pre-gate. **SELL fuel deduction is still deferred** — but the multi-system routing is now
    **RULED (31-08-26): Σ per allocation row** — a sale split across 3 systems flies 3 routes and burns
    3 routes' fuel (`routeFuelCost(systemId).fuelBurn` summed over the `allocations` rows), not the max and
    not one flat route. Same density-beats-sprawl principle as the issuance model
    (`docs/points-and-reputation.md`): fragmenting a sale across scattered territory costs more. SELL still
    burns nothing *yet* and a test pins that, but the ruling the deduction slice needs is made. ⚠ Note for that slice: the SELL panel's short-fuel *disable* shipped
  ahead of the deduction, so it currently blocks sales the engine would accept — see
  `docs/client-wiring.md`.

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
