# Tier-3 Timed Production — the manufacturing model

*RULED 27-09-26 (design record; build is a later Claude Code slice). Supersedes the
27-09-26 "specialist manufacturing model" draft of this file — scope, timers, the
build rule and the capacity fix are all now SETTLED. The companion the pricing ruling
(design.md §5 / `phase-1-tuning.md`) named "deferred to the next design pass."*

## Why this exists

Tier-3 parts span cheap bulk (fuel tanks) to slow specialists (reactor engines, 1M–20M
base). Two problems needed one cure. (1) At ordinary batch speed a factory could refine
a 20M specialist every tick — a fair +20M-per-unit reward becomes a +20M-per-tick
printer. (2) At a per-tick rate, a slow good's price goes degenerate (see the price fix).
The cure for both: **produce Tier-3 goods discretely, on a timer — one whole unit per
`TICKS_PER_UNIT`.**

## Scope — ALL Tier-3 goods are timed (RULED)

Every Tier-3 good — the three sub-tiers (3-1/3-2/3-3) AND the specialist parts — is
produced on the timed engine. One production model, no fast/slow split. (The earlier
"specialists-only" question is closed: cheap tiers get *fast* timers, so bulk stays
buildable, and a single uniform engine is simpler than two.) **Tier-1 (mines) and
Tier-2 (refineries) are UNCHANGED** — continuous, units-per-tick, as today.

## The model — one whole unit per `TICKS_PER_UNIT`

A Tier-3 factory runs a continuous single-good loop (no per-build commission, unlike the
T4 dockyard): **check its recipe inputs are all present → consume the whole input set at
start → count down `TICKS_PER_UNIT` → mint one whole unit → repeat.** Inputs are gated
UP FRONT per unit (the dockyard/T4 discipline, not continuous draw) and consumed when
that unit's build starts; a unit can't begin without its full inputs. **No fractional
units are ever stored** — the countdown is hidden per-venture state; stockpiles hold
whole units only.

## The timer ladder (`TICKS_PER_UNIT`, 1 tick = 1 min; all `[FIRST-CUT]` → `phase-1-tuning.md`)

Climbs by complexity: 3-1 15 min · 3-2 30 min · 3-3 1 h · then the specialists —
extraction_head 6 h · fabrication_line 8 h · medium_reactor_engine 12 h ·
interdiction_projector 24 h · stealth_module 48 h · heavy_reactor_engine 48 h ·
deep_scan_mast 72 h. (Paired with base price: dearer ≈ slower.)

## Build time — assembly is a SEPARATE clock; parts are produced OR bought

A Tier-4 asset needs its parts present, then assembled. These are two clocks in
sequence, and neither is a design target we tune the recipe to:
- **Sourcing the parts** is player-elected: **produce** them (bill × the timers above ×
  how many factories the guild runs) OR **buy them from the Syndicate** at market price.
  A guild in a hurry buys; a guild saving credits produces. So parts-sourcing time is
  variable and player-driven, never a fixed floor.
- **Assembly** is the dockyard `BUILD_TICKS` countdown, UNCHANGED from today: it starts
  ONLY once all parts are present, **consumes the whole bill atomically at start**, and
  counts down its fixed time. Existing (`sim/asset-recipes.js`, all `[FIRST-CUT]`): light
  6 h · miner 12 h · factory 16 h · medium 16 h · heavy 7 d · spycraft 7 d. Not yet set,
  assigned here: **outpost 9 d · deep scan array 7 d · toll gate 6 d.**

**Sequential, not parallel.** Assembly does not run alongside production; parts must
exist first. (An earlier `max(parts, assembly)` / parallel idea was raised and STRUCK —
it contradicted "all parts present before build starts.") So a spycraft is 7 days of
assembly for anyone who has (or buys) its parts; its own parts are quick to make, which
is fine — the buy option means part-sourcing is never a wall.

## Income — progress-based per-tick committed payment

Each tick, the committed share of the progress ACTUALLY MADE that tick is valued at the
current market price and paid to the guild — smooth on-pace, less when behind, nothing
to claw back (payment tracks real work, not a promise). Deviates from T1/2's
delivered-basis (`gross = delivered × price`); its own model, and it closes the
teardown-and-walk exploit a flat committed *rate* would open. **No double-count:**
committed progress IS the payment — a completed committed unit goes to the Syndicate
already paid; only uncommitted progress mints whole units to the guild's stockpile.

## Settlement — weekly, on whole units

A Tier-3 commitment settles per **10,080-tick week** (7 × the 1,440 daily window) via a
per-contract `windowN` that nests inside the daily boundary. At the boundary: a
delivered-or-not verdict on whole committed units (existing boundary machinery);
under-delivery → breach → full fee.

## Delivery — Syndicate first (fixed)

Committed units go to the Syndicate first; the guild's own units are whatever completes
beyond the commitment. No staggering. It is the Syndicate's risk premium and it gates the
guild's own capital output, so breach bites harder on specialists — commit conservatively.

## Renegotiation — fixed re-offer

At contract end the Syndicate re-offers identical terms (same committed unit count, same
week window), price refreshed to current market; no standing ratchet, equity untouched.
Accept (renew) or reject (lapse). Drops T1/2's `renegotiationTerms` recompute for Tier-3.

## Teardown

Forfeit partial progress + consumed ingredients, pay the remaining contract fee, forfeit
RP. Mostly existing `decommissionVenture` behaviour. No benefit to tearing down.

## The price fix — per-PERIOD capacity for timed goods (LOAD-BEARING; do not skip)

`level = stock ÷ capacity`, capacity in units per tick (`sim/prices.js`). Every timed
Tier-3 good produces at LESS than 1 unit/tick (the fastest, 3-1, is 1 per 15 ticks), so
its per-tick capacity is a fraction — `stock ÷ tiny` explodes, and any hoard pins the
price at the ceiling (degenerate, no gradient). **Fix: a timed good's capacity is
measured per a reference PERIOD, not per tick** — `capacity = units produced per period ×
producers`, so `level` reads as "**periods of production hoarded**" and gives a sensible
gradient with the unchanged 0.05 sensitivity. The natural first-cut period is **one day
(1,440 ticks)** — e.g. a 3-1 at 15 min makes 96/day, a heavy engine at 48 h makes 0.5/day
— but the exact period is `[FIRST-CUT]` → `phase-1-tuning.md`. This applies to **all
Tier-3 (all timed)**; **Tier-1/2 keep per-tick capacity** (they are continuous and fast).
So the capacity basis is per production MODEL: timed → per-period, continuous → per-tick.
Rarity preserved (more factories → higher capacity → lower level); throttle-gaming still
impossible (capacity reads the fixed baseline). Change lives in `baselineOutputFor` /
the capacity sum only.

## Buy-to-skip relies on specialists staying dear (note for future tuning)

Buying parts from the Syndicate to skip production is the same two-sided-market
interaction as the refining pump, run in reverse. It is a healthy time-vs-credits
tradeoff ONLY while the Syndicate sells specialists at their (high, scarce) market price.
Do NOT let a future tuning pass sell specialists cheaply — that would make buy-to-skip a
no-brainer and re-feed the pump. Specialists are dear by construction (timed + scarce),
so this holds today; the caution is to keep it holding.

## Invariants (mechanical tripwires)

1. A timed Tier-3 good is never also produced continuously (the capacity sum must not mix
   per-period and per-tick timescales — fail loud).
2. No fractional units in any stockpile (progress is hidden per-venture state only).
3. Committed progress is paid exactly once (no double-count with completed-unit delivery).
4. A unit's build never starts without its full inputs present; inputs consumed at start.

## The nine Tier-4 bills

The believable final bills live in `docs/asset-recipes.md` ("Tier-4 asset bills"). They
are small and literal (8–55 parts; the outpost is the deliberate bulk exception at ~666).
Their build time is assembly `BUILD_TICKS` above; part-sourcing is produced-or-bought.

## Sequencing & state

New serialized state (the per-venture countdown, per-contract `windowN`) is a schema
touch → fresh galaxy + omit-when-default discipline. Build is a later Claude Code slice.

## As built (27-09-26) — Slice 2: timed production + the per-period capacity

This slice built **The model**, **The timer ladder**, the input-gating half of **Build time**, and
**The price fix**. Income, weekly settlement, Syndicate-first delivery, renegotiation and teardown
changes are **Slice 3** and were not touched.

**The timer.** `TICKS_PER_UNIT` in `sim/baseline.js` is the ladder above, keyed the way it is ruled:
`'3-1'` 15, `'3-2'` 30, `'3-3'` 60, and one row per specialist. `ticksPerUnitFor(good)` looks a good
up through its Tier-3 class (`TIER3_PRICE_CLASS`) and answers null for a good that is not timed. That
one function is the whole "timed or continuous?" question for the resolver, the price capacity and
the invariants. A load-time check throws, naming the good, if a classified Tier-3 good has no timer.
(The classifier moved, unchanged, from `sim/prices.js` to `sim/resources.js`, because
`sim/baseline.js` now reads it and cannot import `sim/prices.js`. `sim/prices.js` re-exports it.)

**The loop** (`sim/production.js`, `resolveTimedFactory`). Each tick, for a factory whose output is
timed:
1. If no unit is on the line, the throttle is above 0 and Gate 3 handed it **every** input's full
   qty, the unit **starts**: the whole input set is drawn this tick and the countdown is set to
   `TICKS_PER_UNIT`. If any input is short, nothing is drawn. What it was handed stays in the pool,
   and the preview names the first short input as the bottleneck.
2. A unit on the line (including one that just started) gets this tick's work, so the countdown
   drops by 1. At 0 the unit is minted into the stockpile and the line is empty again.

With steady inputs a unit therefore lands exactly every `TICKS_PER_UNIT` ticks (a 3-1 part on ticks
15, 30, 45 …), and nothing lands in between. The timed factory is an ordinary **consumer** in Gates
2 and 3. It shares its inputs through the same pool, reserve, priority order and FCFS/proportional
split as every other line, so it can never take a unit another claimant was handed. The only
difference is its ask: one whole input set when its line is empty, and nothing while a unit is on
it. Mines and Tier-2 refineries are untouched.

**The state.** `venture.unitTicksRemaining` is the ticks of work the unit on the line still needs.
It is an integer in `[1, TICKS_PER_UNIT)` between ticks, because the start tick is itself the
unit's first tick of work. It is **omitted when the line is empty**, so a galaxy with no Tier-3
factory at work is byte-identical to before. A timed factory keeps no `batchCarry`. This is a schema
touch, so **a fresh galaxy is required on deploy.**

**The price fix** (`sim/prices.js`). `capacityOutputFor(venture)` is the capacity path's own
reader:
- A continuous good gets `baselineOutputFor`, per tick, unchanged.
- A timed good gets `CAPACITY_PERIOD_TICKS (1,440) ÷ TICKS_PER_UNIT × recipe output`, units per
  **day**. A 3-1 factory counts 96 a day, a heavy-engine factory 0.5.

`productionCapacity` sums it. With the unchanged 0.05 sensitivity, one finished heavy reactor engine
held against one factory is a level of 2 (two days of output). Its price settles at 20M × 1.1 =
22M, a 10% nudge. Against a per-tick capacity (1/2,880 an engine a tick) the same one engine would be
a level of 2,880, a target of 2.9B, and the price pinned at its 2B ceiling. The test file pins both.

**The two seams, fenced.**
- *The commitment / sale / fee logic is unchanged.* It reads what production yields, and a
  committed timed factory now yields 0 most ticks and 1 on a completion tick. So the Syndicate fork
  delivers, and the sale pays, lumpily. That is expected, and smoothing it is Slice 3.
- *`baselineOutputFor` is unchanged.* The licence fee ("baseline output over one window") and the
  snapshot's fee quote read exactly what they read before. Only the capacity sum reads per day.
- **Consequence to know before running live:** a Tier-3 licence's committed quantity and fee are
  still sized off the continuous 5 batches/tick baseline. A licensed Tier-3 factory (making at most
  96 a day) will therefore breach its daily window at any meaningful commitment, until Slice 3's
  weekly whole-unit settlement lands. Tier 3 is still **not safe to run live**.

**Invariants** (`sim/invariants.js`, `checkTimedProduction`):
- **Invariant 1 (timed never continuous).** A venture producing a timed good must be a factory
  running the timer. A mine of a timed good, or a timed factory carrying a `batchCarry`, fails,
  naming the good.
- **Invariant 2 (no fractional units).** Needs no new code: the §15.2 integer sweep already checks
  every stockpile cell.
- **The timer.** The countdown may sit only on a timed factory, and only in `[1, TICKS_PER_UNIT)`.
- **Invariant 4 (inputs at start).** Holds by construction and is pinned by tests.
- **Invariant 3 (paid once)** is Slice 3's.

**Decided by the ruling's silence, not invented — on the roadmap's decision checklist:**
- **The four unclassified modules** (drive_module, droid_components, claim_beacon,
  habitation_module) have no sub-tier, so no timer. They stay **continuous**, their status quo,
  until a sub-tier is ruled; then they become timed with no code change.
- **A timed factory's throttle is on/off.** 0 stops a new unit starting (a unit on the line still
  finishes); anything above 0 runs the timer at full pace. Whether a partial throttle should slow
  the timer is unruled.
- **`productionRate` on a timed factory is inert.** The establish path still stamps
  `REFINERY_BASELINE` (5) as it did; the timed path only needs it to be above 0. It is still what
  the console shows and what the snapshot's equity projection multiplies.

Tests: `sim/tests/tier3-timed-production.test.js` (20). No golden hash moved: no run behind a
pinned hash makes a Tier-3 good, and a Tier-1/2 run is byte-identical to the pre-slice engine.
