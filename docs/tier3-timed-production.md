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

## Income & commitment — commit `x` of `y`, paid per tick on progress

A Tier-3 licence commits **`x` whole units of `y`**, where `y` is the venture's weekly
timed output — `y = 10,080 ÷ TICKS_PER_UNIT` (fractional allowed; a heavy-engine factory
is 3.5/week). `x` is an integer in **`[0, floor(y)]`** (whole units, for delivery); the
exact ratio **`x/y`** (fractional `y` kept) is what the fee and reputation read — replacing
T1/2's percentage-of-output commitment with a whole-unit count.

**Fee — the 1/10th rule, on the timed output:** `FEE_RATE (0.10) × y × price-at-signing`.
Measured on the good's REAL timed weekly output `y`, NOT the stale continuous
5-batches/tick baseline the fee read pre-Slice-3 (the fix Slice 2 flagged). Same
proportional cost as T1/2.

**Reputation** maps straight onto the existing T1/2 machinery: `committedOutputPct = x/y`
feeds the met-gain and signing-bump formulas unchanged — no new RP mechanism.

**Payment — per tick, on progress actually made (the new mechanism).** Each tick a timed
factory makes `1 ÷ TICKS_PER_UNIT` of a unit; the committed slice of that,
`(x/y) × (1 ÷ TICKS_PER_UNIT)`, is valued at **that tick's** current price and paid to the
guild. Smooth on-pace, less when the line stalls or is throttled, **nothing to claw back**
(payment tracks real progress, not a promise — this is what closes the teardown-and-walk
exploit a flat committed *rate* would open). Over a full week it sums to `x` units' worth
at the average price. **No double-count:** the per-tick progress payment IS the payment; a
completed committed unit is delivered to the Syndicate **already paid**, and only
uncommitted output mints whole units into the guild's own stockpile. Deviates deliberately
from T1/2's delivered-basis sale (`gross = delivered × price`); its own model.
*(⤳ As built: the whole-unit `x`-of-`y` commitment is Slice 3c, "As built — Slice 3c" at the end.
The per-tick progress payment is Slice 3d, "As built — Slice 3d" at the end.)*

## Contract & settlement — a rolling 7-day term

A Tier-3 contract is **exactly one 7-day window (10,080 ticks)** — the contract term and
the settlement window are the same week. Sign → produce for the week → **settle** at the
boundary (a delivered-or-not verdict on the whole committed `x` units; under-delivery →
breach → full fee) → the Syndicate **re-offers identical terms** (see Renegotiation below)
→ renew or lapse. It is a **rolling weekly commitment** that, because the re-offer never
changes, effectively auto-renews unless the guild opts out. *(⤳ RULED 28-09-26: auto-lapse is
intended. The guild renews by accepting the re-offer; an offer nobody accepts auto-lapses. There
is no auto-renew step. See Renegotiation below.)* There is **no separate
multi-cycle term** (`windowDays`) for Tier-3 — term and settlement window are one week,
collapsing the T1/2 term-vs-cadence distinction. Teardown owes at most this one week's
settlement fee.
*(⤳ As built: Slice 3c, "As built — Slice 3c" at the end. The licence stores a term of one of its
weekly windows, derived from the good.)*

## Delivery — Syndicate first (fixed)

Committed units go to the Syndicate first; the guild's own units are whatever completes
beyond the commitment. No staggering. It is the Syndicate's risk premium and it gates the
guild's own capital output, so breach bites harder on specialists — commit conservatively.
*(⤳ As built: Slice 3b, "As built — Slice 3b" at the end. **RULED 28-09-26:** on a breached
week the Syndicate keeps every unit delivered, while the guild is paid only its committed share
`x / y` of its work. That is an intended breach penalty, not a defect; see "As built — Slice 3d".)*

## Renegotiation — fixed re-offer

At contract end the Syndicate re-offers identical terms (same committed unit count, same
week window), price refreshed to current market; no standing ratchet, equity untouched.
Accept (renew) or reject (lapse). Drops T1/2's `renegotiationTerms` commitment recompute (the
ratchet) for Tier-3.

**The Strong discount is KEPT (RULED 28-09-26).** A Strong-standing venture's Tier-3 re-offer
carries the same Strong fee discount a Tier-1/2 one does (`STRONG_FEE_DISCOUNT`, −10%). Standing
still never moves the commitment or the term; the ruling drops only the ratchet.

**Auto-lapse is intended (RULED 28-09-26).** The re-offer renews only if the guild accepts it. An
offer nobody accepts auto-lapses on the existing timers (a day of grace, then a 5-day offer).
There is no auto-renew step.
*(⤳ As built: Slice 3c, "As built — Slice 3c" at the end. The discount: "As built — the Strong
discount on the re-offer" at the end.)*

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
   *(⤳ As built: Slice 3d — by construction, pinned by tests; see "As built — Slice 3d".)*
4. A unit's build never starts without its full inputs present; inputs consumed at start.

## The nine Tier-4 bills

The believable final bills live in `docs/asset-recipes.md` ("Tier-4 asset bills"). They
are small and literal (8–55 parts; the outpost is the deliberate bulk exception at ~666).
Their build time is assembly `BUILD_TICKS` above; part-sourcing is produced-or-bought.

## Sequencing & state

New serialized state (the per-venture countdown, per-contract `windowN`) is a schema
touch → fresh galaxy + omit-when-default discipline. Build is a later Claude Code slice.
*(⤳ As built: the countdown landed in Slice 2 as `venture.unitTicksRemaining`. The per-contract
`windowN` turned out not to need storing: it is a pure function of the good, **derived** by
`windowNForGood` (Slice 3a, below), so that part is no schema touch.)*

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
- **Invariant 3 (paid once)** is Slice 3's. *(⤳ Built by Slice 3d, below.)*

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

## As built (27-09-26) — Slice 3a: the weekly settlement window + the fee re-based on timed output

Slice 3 is built in sub-slices. **3a** builds the *clock* and the *sizing* of "Contract &
settlement" and "Income & commitment": a Tier-3 commitment settles on the week, and its fee and
committed quantity are measured on its timed weekly output `y`. It does **not** build the whole-unit
`x`-of-`y` commitment expression, Syndicate-first delivery, the fixed re-offer or the one-week
contract term (3b), nor the per-tick progress payment (3c). Tier-1/2 settlement is untouched.

**The week, derived — no new state.** `TIER3_WINDOW_N = 10,080` (`sim/windows.js`; 7 × the ruled
1,440-tick day). `windowNForGood(good, day)` answers the window a commitment on `good` runs in: the
week for a timed good (`ticksPerUnitFor(good)` is not null), the galaxy's `state.windowN` for
everything else, exactly as before. It is a pure function of the good, **so nothing is stored**:
the "per-contract `windowN`" that **Sequencing & state** above expected to serialize is not needed,
and there is **no schema change** (no fresh galaxy is needed for this slice's own sake). Because the
good decides (not the venture), every venture making one good in one system shares one window, so
their commitments still sum into the good's single `Q`. `goodWindow(good, tick, day, anchor)` builds
the `{ windowN, windowStart }` pair, and the resolver and the tick both read it.

**Threaded through every commitment read** (each one used `state.windowN` before):
- **the target `Q` and the pace** (`resolveProduction`): each committed good's
  `committedContribution` and `resolveWindow` read that good's window. A Tier-3 good paces over the
  whole week (`ticksRemaining` is 10,080 on the week's first tick), and its `syndicateWindows` entry
  opens on the week's first tick and rolls only on the next week's.
- **the verdict**: the met/breach fill runs on the good's own boundary. On the six day-ends inside
  a week a Tier-3 good is still `accruing`.
- **the sale's equity split** (`commitmentSale` → `ownerFraction`): weighted in the good's window.
- **the fee charge and reputation** (`applyProduction`): the outer gate is still the day boundary.
  Every window ends on one, so a non-boundary tick skips the block exactly as before. Inside it, each
  licence is charged **only on its own window's boundary**. A Tier-1/2 licence is due every day, and
  a Tier-3 licence once, on the week's last tick. Its `feeOwed` is pro-rated by `windowFraction`
  over the **week**: a licence signed mid-week owes the share of the week it was present for, in
  target and fee alike. On a day inside the week the guild's lump and `lastLicenceFee` record hold
  only its Tier-1/2 licences.
- **the invariant** `window-fraction-in-(0,1]` checks the venture's own window.

**The windows nest.** 10,080 = 7 × 1,440, so every week boundary is a day boundary. Nesting is what
lets the fee loop keep its day gate. `state.windowN` is a setup knob a test may set to anything,
so a day that does **not** divide the week is handled loudly in three places. `applyForLicence`
**refuses** a Tier-3 licence there. `windowNForGood` **halts** the tick rather than settle a week
nothing watches. The new invariant `tier3-week-nests-in-the-day` names any committed or licensed
Tier-3 venture in such a galaxy. An **unlicensed** Tier-3 factory never asks for a window, so it
runs in any galaxy.

**The fee and the committed quantity.** `licenceBasisFor(venture, day)` (`sim/licence.js`) is the
one basis they are sized on: a per-tick output and the window it runs over.
- **Continuous** (Tier 1/2, and the four unclassified modules): `baselineOutputFor` over the day,
  the very numbers the fee always read. Every Tier-1/2 fee and commitment is unchanged to the credit.
- **Timed Tier-3:** the timer's pace, `output qty ÷ TICKS_PER_UNIT` a tick, over the 10,080 week.
  The product is `y = 10,080 ÷ TICKS_PER_UNIT`, so `basicFee = round(0.10 × y × price-at-signing)`.
  This mirrors `capacityOutputFor`, over a week instead of a day. A 3-1 part is `0.10 × 672 × 100
  = 6,720` a week (it was 72,000 a *day* on the stale 5-batches/tick basis). A heavy reactor engine
  is `0.10 × 3.5 × 20M = 7M` a week. `FEE_RATE` stays 0.10, and **no number was invented**.
- `licenceFee` and `commitmentUnitsFor` keep their arithmetic byte for byte; only their inputs
  changed. For every ruled timer, `(1 ÷ TICKS_PER_UNIT) × 10,080` is exactly `10,080 ÷
  TICKS_PER_UNIT` in floating point, and a test pins that no whole percent rounds differently
  either way.
- **The ceiling.** The committed quantity is still the percentage expression (`round(pct × y)`;
  whole-unit `x` is 3b), but it is capped at `floor(y)`, the prompt's "a commitment can't exceed
  the venture's weekly output". It is also the doc's `x ∈ [0, floor(y)]`. It bites only where `y`
  is fractional: a heavy engine at 100% commits 3, not `round(3.5) = 4`. For Tier 1/2 it is
  provably a no-op, because a share `≤ 1` of a whole number rounds to at most that number.
- **One basis, four readers.** The signing (`applyForLicence`), the re-lock (`renegotiateLicence`)
  and their two previews (the snapshot's `feeQuote` and `renegotiationOffer`) all read it. The
  quote a player sees equals the fee they sign, and a re-lock can never slide a Tier-3 licence back
  onto the stale basis. Only the **basis** is shared. The terms function (the commitment ratchet)
  is unchanged for every tier; the Tier-3 fixed re-offer is 3b.

**Proven.** `sim/tests/tier3-settlement.test.js` (19) covers the following:
- The fee equals `0.10 × (10,080 ÷ TICKS_PER_UNIT) × price` for all 21 timed goods and never the
  old figure.
- One shared 10,080-tick run with seven guilds:
  - A fed 3-1 factory is judged and charged **once**, on tick 10,080, and on no day-end before it.
  - A starved one is still `accruing` at day 1's end and breaches on 10,080, paying the full
    weekly fee.
  - A titanium mine beside a Tier-3 licence is charged every day, its rows identical to the same
    mine alone.
  - A mid-week signer owes half the week.
  - A heavy engine at 100% commits 3 and meets it.
- A Tier-1/2-licensed galaxy with an unlicensed Tier-3 factory reproduces hashes computed on the
  pre-slice engine at **every tick**. This holds at a 60-tick day and at a 50-tick day the week
  does not divide.
- Four deliberate code breakages (the fee basis, the per-licence gate, the resolver's verdict clock
  and the ceiling) each turn tests red.

**No golden hash moved:** no pinned run licenses a Tier-3 venture. The build session also diffed
three 3,000-tick Tier-1/2 runs (plain, with an unlicensed Tier-3 factory, and anchored) against
HEAD: identical state at every tick, and identical snapshots except the Tier-3 `feeQuote` entries.

**⚠ The gap 3a exposes (Slice 3b's to close — pinned by a test, on the decision checklist).**
*(⤳ CLOSED 27-09-26 by Slice 3b: see "As built — Slice 3b" below.)*
The week and the sizing are right. Fed through the **existing `absolute` Syndicate send control**,
a committed 3-1 factory meets every commitment from 10% to 100% of `y`. On the **default paced
send**, the same factory delivers only about 20–40% of its target and **breaches at every level**.
The pace's whole-unit intent mostly falls on ticks the timer mints nothing, and the fork is
fresh-only, so most finished units go to the guild's stockpile instead.

| commitment | 10% | 25% | 50% | 75% | 90% | 100% |
|---|---|---|---|---|---|---|
| paced (default) | 27 / 67 | 69 / 168 | 100 / 336 | 132 / 504 | 142 / 605 | 211 / 672 |
| absolute, 1/tick | 67 / 67 | 168 / 168 | 336 / 336 | 504 / 504 | 605 / 605 | 672 / 672 |

*(3-1 fuel tank, one week, delivered / target.)* This is **delivery order**, not settlement:
**Delivery — Syndicate first** above is the ruled cure, and it is 3b's. It was not touched here.
**Tier 3 is still not safe to run live.**

## As built (27-09-26) — Slice 3b: Syndicate-first delivery

**The sub-slices were re-cut for this build** (the human's 3b build prompt). **3b** is Syndicate-first
delivery only. **3c** is the whole-unit `x`-of-`y` commitment expression, the one-week rolling term
and the fixed re-offer. **3d** is the per-tick progress payment. Where Slice 3a's text above says
"3b" for the commitment expression, the term or the re-offer, read 3c. Where it says "3c" for the
payment, read 3d.

3b builds **Delivery — Syndicate first (fixed)** and closes the gap 3a pinned. It changes only
**which minted units reach the Syndicate**. It does not touch the commitment expression, the term or
the re-offer (3c), the payment (3d), or the week and the fee (3a).

**The rule.** For a committed **timed** good, each tick:

    the Syndicate's take = min(units minted this tick, Q − delivered so far this week)

Every minted unit goes to the Syndicate until the week's target `Q` is met. Every unit after that
stays in the guild's stockpile. Whole units only: there is no paced rate and no send carry, so a
unit can no longer miss the Syndicate by landing on a tick the pace asked for nothing. `Q` is the
unchanged 3a target (`committedContribution` over the 10,080 week).

**Built as two small changes in `sim/production.js`** (the section "SYNDICATE FIRST"):
1. **The intent.** `resolveWindow` gives a timed good an intent of the whole of what is still owed,
   `Q − delivered`, and returns before the paced / absolute / percent branch. So the send control is
   not read, and `sendCarry` stays 0.
2. **The order.** The Syndicate claimant is lifted to the front of the good's claimant order
   (`syndicateFirstOrder`). The player's other two claimants keep their relative order. The
   default order already starts with the Syndicate, so this changes nothing for most profiles.

The existing fresh-only cap in the finalize walk then caps that intent at the units minted this
tick. That cap is what makes the take `min(minted, Q − delivered)`. `deliversSyndicateFirst(good)` is
`ticksPerUnitFor(good) !== null`, the same answer that decides timed production and the weekly
window. So the three can never disagree about a good.

**What did not move.** `delivered` still accumulates the units sent and `Q` still caps it. The
boundary verdict still reads `delivered` against `Q`. The fee, reputation and the sale
(`commitmentSale`, still on delivered units) are unchanged. `sim/tick.js` is untouched, because it
already delivered whatever `fork.syndicate` said. There is **no new state and no schema change**:
`sendCarry` keeps its field and is simply always 0 for a timed good. Tier-1 mines and Tier-2
refineries keep the paced / absolute / percent fresh-only send exactly as before.

**"Fixed" was built to mean not a lever.** Neither the stored claimant order (a reserve ranked ahead
of the Syndicate) nor the send control (e.g. "absolute 0") can hold a committed unit back. The
profile action still accepts both for a timed good; they are simply inert. Whether intake should
refuse them, and what the console should show instead, is on the decision checklist.

**The result** (a fed 3-1 fuel tank, one week, on the DEFAULT send; delivered / target, verdict):

| commitment | 10% | 25% | 50% | 75% | 90% | 100% |
|---|---|---|---|---|---|---|
| 3a (paced) | 27 / 67 ✗ | 69 / 168 ✗ | 100 / 336 ✗ | 132 / 504 ✗ | 142 / 605 ✗ | 211 / 672 ✗ |
| 3b (Syndicate first) | 67 / 67 ✓ | 168 / 168 ✓ | 336 / 336 ✓ | 504 / 504 ✓ | 605 / 605 ✓ | 672 / 672 ✓ |

The guild keeps `672 − Q` (605, 504, 336, 168, 67, 0). The 3a row was re-measured on HEAD 8af8b11
and matches 3a's own table.

**Consequences worth knowing** (all pinned by tests):
- **It is Syndicate FIRST, not interleaved.** A 25% factory's first 168 units all go to the Syndicate
  (the 168th lands on tick 2,520), and the stockpile is still empty at that moment. The other 504 all
  stay home.
- **The Syndicate never takes from the stockpile.** Units already in stock, or minted after `Q` is
  met, are the guild's.
- **An under-producing week delivers everything it made and still breaches.** With inputs for 100
  units against `Q = 336`, it delivers all 100 and pays the full basic fee.
- **One pot per good, as before.** `Q` is the good's target, and the fork has always drawn on the
  good's whole fresh output in the system. So an **unlicensed** factory making the same good beside a
  licensed one feeds `Q` too. This is unchanged from the paced send, but it is more visible now. It
  is on the checklist as a confirm.
- **Payment is still lumpy.** The sale still fires when a unit is delivered: nothing, then one whole
  unit's worth. Delivery is now reliable; smoothing the payment is 3d.

**Proven.** `sim/tests/tier3-delivery.test.js` (14) runs one shared week plus 30 ticks, 13 guilds.
- The table above, at all six levels, on the default send.
- **The rule on every tick** for every guild: the take is exactly `min(minted, Q − delivered)`,
  `delivered` never passes `Q`, the stockpile moves by exactly `minted − take`, and it does not move at
  all while the week is short of `Q`.
- The over-producing and under-producing weeks.
- A reserve ranked ahead of the Syndicate, and "absolute 0", both still meet.
- An unlicensed sibling, two licences on one good, and a heavy engine at `Q = floor(3.5) = 3`.
- The week rolling: next week's first two units go to the Syndicate again.
- Determinism, and an isolation pin (below).

The file was also run against the **HEAD** engine: 11 of its 14 tests fail, and the three that pass
are the engine-independent ones (invariants, determinism, the isolation pin). Four deliberate code
breakages each turn tests red:
- the order left un-lifted;
- the paced intent kept;
- Syndicate-first applied to every good (caught by the isolation pin);
- the `Q` cap dropped.

3a's **"THE GAP"** test in `tier3-settlement.test.js` is **repointed, not deleted**. It is now "THE
GAP, CLOSED": the same paced guild delivers 336 of 336 and settles exactly like the `absolute` one.

**Isolation.** A Tier-1/2 galaxy under every send control and order is pinned to hashes computed on
the pre-slice engine (HEAD 8af8b11), every tick of 600: absolute, percent, a reserve ahead of the
Syndicate, the Syndicate last, a pursue ranking, two licensed mines on one good, a licensed Tier-2
factory, and an unlicensed Tier-3 factory producing beside them. The build session also diffed six
3,000-tick runs against HEAD (paced at a 60- and a 1,440-tick day, anchored, every send mode, and an
unlicensed Tier-3 sibling): identical state, preview and snapshots at every tick. A seventh run with
a **licensed** Tier-3 factory beside the Tier-1/2 licences differs only in that factory's own good
(its delivery, the guild's credits, its fee and its quote); the Tier-1/2 slice is identical.

**No golden hash moved.** No pinned run commits a timed good, so nothing needed re-pinning.

**Before Tier 3 runs live.** The delivery blocker is closed. Two known defects from 3a still stand,
both 3c's (decision checklist): teardown settlement is still counted in days (a 7-day Tier-3 licence
torn down on day 1 is charged 7 weekly fees), and the Tier-1/2 `windowDays` term and commitment
ratchet still apply to a Tier-3 licence. *(⤳ Both CLOSED 28-09-26 by Slice 3c, below.)*

## As built (28-09-26) — Slice 3c: whole units, the one-week term, the fixed re-offer

3c builds three pieces of **Income & commitment**, **Contract & settlement** and **Renegotiation —
fixed re-offer**. Each applies only to a licence on a **timed** good, decided by the good alone
(`ticksPerUnitFor(good) !== null`, the same answer that decides timed production, the week and
Syndicate-first delivery; `isTimedVenture` in `sim/licence.js`). 3c does not touch the payment
(3d), delivery (3b), or the week and the fee sizing (3a). A Tier-1/2 licence is untouched, and so
is a licence on one of the four unclassified modules, which have no timer and keep the Tier-1/2
licence until their sub-tier is ruled.

**1. Commit `x` whole units.** `applyForLicence` now has two shapes:
- **Tier 1/2:** `{ committedOutputPct, windowDays }`, exactly as before.
- **Tier 3:** `{ committedUnits }` alone. `x` must be a whole number in `[0, floor(y)]`, where
  `y = 10,080 ÷ TICKS_PER_UNIT`. Anything else is refused, and the reason names the bound, e.g.
  "committedUnits must be an integer from 0 to 3 (the floor of its weekly output y = 3.5)".

Wrong shapes are refused, never converted:
- a percentage or a `windowDays` on a Tier-3 licence;
- `committedUnits` on a Tier-1/2 licence;
- a mix of the two shapes (the action creator throws).

The signing stores the exact ratio **`committedOutputPct = x / y`**. `y` keeps its fraction, and the
ratio is never rounded. It also stores **`syndicateCommitment = x`**.
- The fee grid, the signing bump and the met/breach reputation read the ratio.
- Delivery (3b) and settlement (3a) read `x`.
- Worked example: a heavy reactor engine at its most commits `x = 3` of its 3.5. The ratio is 6/7,
  so the discounted fee is 7,000,000 × (1 − 0.25 × 6/7) = **5,500,000** a week. The old 100% licence
  paid 5,250,000.

The new helpers live in `sim/licence.js`: `weeklyOutputOf`, `committedUnitsCeiling` (`floor(y)`),
`isValidCommittedUnits` and `committedPctForUnits`. `commitmentUnitsFor`'s own cap now calls
`committedUnitsCeiling`, which is the same expression as before.

**2. The one-week term.** A Tier-3 licence stores `windowDays: 1` (`TIER3_TERM_WINDOWS`, the ruled
"exactly one 7-day window"). `windowDays` counts the licence's **own** windows.
`licenceWindowN(venture)` derives that window from the good through `windowNForGood`: the day for
Tier 1/2, the 10,080-tick week for Tier 3. **No new field.** Every reader that counts the term now
reads the licence's own window. For a Tier-1/2 licence that is the day, as before.
- **Teardown** (`teardownSettlement`): `remainingCycles = max(0, 1 − floor(elapsed ÷ 10,080))`.
  - Torn down on any day of its week, a Tier-3 licence owes exactly **one** weekly `discountedFee`.
  - Its node is locked until `signedTick + 10,080`.
  - From the week's end it owes nothing.
  - On day 1 it used to owe **seven** weekly fees. That was the 3a defect, and it is closed.
- **The renegotiate / lapse gate** (`licenceEndTick`): opens at signing + 10,080.
- **The renegotiation schedule.** `renegotiationScheduleFor(venture)` is the one entry point the
  snapshot and the tick's auto-lapse both use. The term in days is `windowDays × (window ÷ day)`, which
  is 7 at the ruled day. So the timeline is exactly a 7-day Tier-1/2 licence's:
  - the window ends day-aligned 7 days after signing;
  - then a day of grace (a 7-day contract's grace);
  - then the offer stands for 5 days;
  - then the licence auto-lapses if nobody accepted it.
  - Without this threading, `windowDays: 1` would read as one **day**: the offer would appear after
    2 days and the licence would auto-lapse on day 6, before its week was ever settled. A test pins
    that the engine does not do this.
- The snapshot's `contractWindow` still counts in calendar days (a Tier-3 term shows 7).

**3. The fixed re-offer.** `renegotiationTerms` returns a Tier-3 licence's own terms. Standing never
moves the commitment or the term:
- the same `x / y`, to the bit (no 2-dp normalisation);
- the same one-week term;
- the Strong fee discount for a Strong venture, and none at any other band. *(⤳ Changed 28-09-26. As
  3c first built it, the discount was 0 at every band, Strong included. The human then ruled that a
  Strong venture keeps it and only the ratchet is dropped. See "As built — the Strong discount on the
  re-offer" at the end.)*

`renegotiationFee` re-prices those terms at today's posted price, as it does for every tier.
`renegotiateLicence` is unchanged: it re-derives the committed units from the ratio, and
`round((x / y) × y)` is `x` again. That is pinned for every timed good and every legal `x`
(5,139 pairs, at all four bands). RP carries and there is no fresh bump, as before.

**The invariant** (`sim/invariants.js`), for a licence on a timed good:
- its `windowDays` must be exactly 1 (`tier3-term-is-one-week`). A 7 there would mean seven weeks;
- its `syndicateCommitment` must be a whole number in `[0, floor(y)]`, and `committedOutputPct` must
  equal `x / y` exactly (`tier3-commitment-is-x-of-y`). These are two stored copies of one promise,
  and this checks they still agree.

A Tier-1/2 licence keeps the 7–42 day bound.

**No schema change.** `windowDays`, `committedOutputPct` and `syndicateCommitment` are existing fields.
A Tier-3 licence just holds different values in them. A save that holds a Tier-3 licence signed
before this slice (a percentage and a 7–42 term) fails the new invariant. Tier 3 has never been
declared safe to run live, so no live galaxy should hold one; if one does, it needs a fresh galaxy.

**Still as before.** The sale still fires when a unit is delivered, so income is still lumpy. The
per-tick progress payment is 3d. *(⤳ Built 28-09-26 by Slice 3d, below.)*

**Proven.** `sim/tests/tier3-contract.test.js` has 13 tests:
- (a) `x` and `x / y` stored for all 21 timed goods at four sizes. The fee grid and the signing bump
  read `x / y`. Every out-of-range, fractional or wrong-typed `x` is refused, naming the bound. The
  wrong shapes are refused. One committed week at `x = 200` of 672 delivers 200, is met, is charged
  on 200/672 and scores RP on 200/672.
- (b) A real seeded galaxy: a Tier-3 factory on a real settlement slot is torn down on day 1. It pays
  one weekly fee, and the slot is locked until the week ends and free from then. The settlement is
  swept across every day of the week, for a mid-week signer and on a 60-tick day. The whole
  renegotiation timeline is checked against a 7-day Tier-1/2 licence's, through the gate, the snapshot
  and the tick's auto-lapse.
- (c) The fixed re-offer at every band, re-priced at a moved price and renewed twice, plus the
  5,139-pair round trip.
- (d) A Tier-1/2 licence keeps its percentage, its 7–42 term, day-counted teardown and the ratchet at
  every band.
- ISOLATION: a Tier-1/2 lifecycle pinned to hashes computed on the pre-slice engine (HEAD 5867c18).
  It covers signing, the daily charge, teardown mid-term and after a re-lock, renegotiation at every
  band, an early renegotiate refused, a REJECT and an auto-lapse, with an unlicensed Tier-3 factory
  producing beside them. It hashes state every tick, the snapshot every 10 ticks, and every intake
  result.
- Determinism across a Tier-3 contract lifecycle.

The file was also run against the **HEAD** engine: 12 of its 13 fail there. The one that passes is
the isolation pin, as it must (its hashes are HEAD's own). The Tier-1/2 headline fails on HEAD only
because it calls the new `renegotiationScheduleFor` helper. Six deliberate code breakages each turn
tests red:
- teardown counted in days;
- the Tier-3 ratchet kept;
- the schedule counted in days (25 tests in the 3a/3b files also go red, because their weeks
  auto-lapse);
- the ratio rounded to 2 dp;
- the week applied to Tier-1/2 licences (caught by the isolation pin);
- the renegotiate gate counted in days.

**Tests updated deliberately** (3a's and 3b's files):
- Their Tier-3 licences now commit whole units: the same `Q` each measured before, `x = round(pct × y)`.
- 3a's re-lock test now expects the fixed re-offer (336 of 672 stays 336) instead of Steady's +0.10.
- Their Tier-1/2 licences and isolation pins are unchanged.

**Isolation, measured.** The build session also diffed three Tier-1/2 lifecycle runs against HEAD:
- a 60-tick day, an anchored 60-tick day, and a 45-day run at the ruled 1,440-tick day;
- each covering signing, charges, a renegotiation at every band, REJECT, auto-lapse and teardown;
- identical state at every tick, identical snapshots (5,160 compared), identical intake results and
  refusal reasons.

With a **licensed** Tier-3 guild beside the Tier-1/2 guilds, the Tier-1/2 guilds' licences, venture
rows, fees and verdicts are identical. Their **fuel grants** can move, though. A Tier-3 licence's
ratio sets that guild's RP (a heavy engine at its most is 6/7, where HEAD signed 100%), and the shared
fuel pool splits by RP across every guild. With a Tier-3 licence whose ratio equals HEAD's percentage
(336/672 = 0.5), the Tier-1/2 guild is byte-identical for 4,000 ticks. This is the existing
cross-guild coupling, not a Tier-1/2 change.

**Before Tier 3 runs live.** The two 3a defects are closed. Still open:
- the payment (3d); *(⤳ built by Slice 3d, below)*
- **the client**, which still sends the Tier-1/2 shape for a Tier-3 factory. The engine now refuses
  that, and the refusal names the right `x`;
  *(⤳ The Establish popup: built 28-09-26, "As built — the client" at the end.)*
- the Slice-3c items on the roadmap's decision checklist.

## As built (28-09-26) — Slice 3d: the per-tick progress payment

3d builds the payment half of **Income & commitment**, the last engine slice of the Tier-3 build. It
changes only **what a committed timed good is paid on, and when**. Delivery (3b), the commitment,
term and re-offer (3c), the week and the fee (3a) and reputation are untouched. Tier-1/2 goods keep the
delivery-basis sale (`commitmentSale`) byte for byte.

**The rule.** For a factory making a committed **timed** good, each tick:

    paid this tick = ownerFraction × (x / y) × progress × posted price    (whole credits; the rest carried)
    progress       = output qty ÷ TICKS_PER_UNIT on a tick a unit was on the line, else 0

- `(x / y) × (1 ÷ TICKS_PER_UNIT)` is `x ÷ 10,080` of a unit for every timer, so a week of running
  is paid exactly `x` units' worth.
- The price is the posted one already on state, as the sale's is.
- The owner split is the sale's `ownerFraction` (the contribution-weighted `1 − o`); the `o` share stays
  in the ledger.
- An uncommitted factory (`x = 0`) is never paid: its units go to its own stockpile, as before.

**No double-count.** The delivery still moves each committed unit to the Syndicate, Syndicate-first,
and still records it (`lastSyndicateSale.goods[good].units`). For a timed good it now credits
**nothing**. The payment runs just before the delivery in `applyProduction`, so a unit reaches the
Syndicate already paid, in code order as well as in money.

**Built as** (`sim/licence.js` "The progress payment"; `sim/tick.js` "THE PROGRESS PAYMENT"):
- `paidOnProgress(good)`: the timed goods. It is the same `ticksPerUnitFor` answer that decides timed
  production, the week, Syndicate-first delivery and the Tier-3 contract.
- `committedShareOf(venture, …)`: `x / y`, from `syndicateCommitment` and the licence basis. It uses
  `committedPctForUnits`, the division the signing stores as `committedOutputPct`. It returns 0 for an
  uncommitted factory. It **halts** on an `x` outside `[0, floor(y)]`, naming the tick, `x` and `y`: a
  share above 1 would pay for more of a unit than was made. Only the dev scaffold can set such an `x`.
- `progressPayment(…)`: `commitmentSale`'s twin, on progress instead of delivered units.
- The tick pays each timed row whose countdown moved (`rate > 0`, the same test that stamps the
  venture), and the delivery loop skips the credit for a timed good.
- `resolveProduction` is unchanged. Progress is worked out from facts the row already carries, so the
  production preview and the snapshot are unchanged too.

**Whole credits: floor-and-carry** (a build call; confirm on the decision checklist). One tick of
committed work is often worth less than a credit. A 3-1 part at its base price of 100, committed at
`x = 50`, earns about half a credit a tick. Rounding each tick would pay it **nothing** all week, and at
`x = 67` it would pay 1.5 times what was earned. So the payment uses the ruled floor-and-carry discipline
of the send (`sendCarry`) and `batchCarry`:
1. add this tick's earnings to what was carried;
2. pay the whole credits;
3. keep the part of a credit on the venture as **`paymentCarry`**, in `[0, 1)`.

Flooring never pays ahead of the work, so nothing is ever clawed back, and the guild is never more
than one credit behind. Both ledger legs still move one integer, so invariant 2 holds to the credit.

**The state.** `venture.paymentCarry` is **new**, and it is **omitted when 0**. So a galaxy with no
committed timed factory serializes exactly as before, and no fresh galaxy is needed. A teardown removes
the venture, and the carry (under a credit) is forfeited with its partial progress. A lapsed licence
leaves it in place; it is added to the next payment if the venture is committed again.

**The invariant** (`sim/invariants.js`, `checkTimedProduction` (c)). `paymentCarry` may sit only on a
timed factory, and only in `[0, 1)`. **Invariant 3 above (paid exactly once)** holds by construction,
since a timed good's delivery credits 0. It is pinned tick by tick by the tests.

**The result.** Each row is one fed factory in its own galaxy for one week, measured on HEAD 4a0a651 and
on this slice.

| case | before (paid on delivery) | after (paid on progress) |
|---|---|---|
| 3-1 fuel tank, `x = 672` of 672 (price flat at 100) | 672 ticks × 100 = **67,200** | all 10,080 ticks, 6–7 each = **67,200** |
| heavy reactor engine, `x = 3` of 3.5 (flat at 20M) | 3 ticks × 20M = **60,000,000** | all 10,080 ticks, 5,952–5,953 each = **59,999,999** + 0.99999999 carried |
| 3-1 fuel tank, `x = 336` of 672 | 336 ticks × 100 = **33,600** | all 10,080 ticks, 3–4 each = **35,062** (+0.14 carried) |
| 3-1 fuel tank, `x = 50` | 50 ticks × 100 = **5,000** | 5,747 ticks, 1 each = **5,747** |

**At a steady price the total is the old one, re-timed.** When the price moves, the two differ, because
each tick's work is now valued at that tick's price, as ruled. The old sale valued each unit at its
delivery tick instead. Syndicate-first delivery is front-loaded: at `x = 336`, all 336 units reach the
Syndicate by tick 5,040, while the stock is empty and the price is at its base. After that, the guild's
own 336 units pile up and push the fuel-tank price to 117. So the week is now paid at its average price.

**A consequence worth knowing** (RULED 28-09-26: intended): **within a week, delivery and payment
disagree.**
- Delivery is Syndicate-first: whole units, the first `Q` made. Payment is `x / y` of every tick's work.
- Over a met week they agree: `x` delivered, `x` units' worth paid.
- A **met week at `x < y`** delivers early and is paid evenly. At 50%, by tick 5,040, 336 units are
  delivered and 168 units' worth is paid.
- A **short week** delivers more units than it is paid for. A factory at `x = 336` that makes only 160
  units delivers all 160 and is paid for 80. It then breaches and pays the full fee, as before.
- Under the old sale the same factory was paid for all 160.

This follows from the two rulings together: delivery (3b) was not touched, and neither was the payment
rule. *(As first written: whether it is intended ("the Syndicate's risk premium … breach bites harder")
is for the human.)*

**RULED 28-09-26 — intended, not a defect.** On a breached Tier-3 week the Syndicate keeps every unit
delivered, while the guild is paid only its committed share `x / y` of the work. That is a deliberate
breach penalty: it is the ruled "breach bites harder" of Syndicate-first delivery, and the reason to
commit conservatively. Neither delivery nor payment changes. (The two alternatives the checklist
offered, both of which would have touched delivery, are not taken.)

**Proven.** `sim/tests/tier3-payment.test.js` has 12 tests. One shared week has six guilds, each with one
factory:

| guild | factory | commitment |
|---|---|---|
| `even` | fuel tanks | 336 |
| `full` | hull plating | 672, price flat |
| `heavy` | heavy reactor engine | 3 of 3.5, price flat |
| `equity` | power cells | 336, `o = 0.4` |
| `stall` | fuel tanks | 336; inputs for 100 units, 60 more added on tick 6,000 |
| `free` | cargo modules | unlicensed |

On every tick, for every guild, the test checks the following against values it computes
independently. It reads "was a unit on the line?" off the stored countdown and the goods, and types
the payment formula from the ruling.
- The guild gained exactly the recorded payment, and nothing for a delivery.
- Paid plus carried equals carried-before plus that tick's committed work.
- The payment is within one credit of that tick's work.
- An idle tick pays 0 and leaves the carry alone.
- The ledger moves by exactly what the guilds net.

The headline and the other tests:
- **HEADLINE:** paid on all 10,080 ticks, 3–4 credits each. Each of the 336 ticks a unit lands pays at
  most one credit more than that tick's work, never a unit's worth. The heavy engine is 5,952 or 5,953
  on every tick.
- **The total:** every met week is paid its committed work's worth, short by under a credit. At a flat
  price that is the old delivery total exactly (hull plating 67,200; heavy engine 60M), and never 2×.
  At a moving price it is `x` × the week's mean price.
- **Equity:** the `o = 0.4` guild is paid 60% of its committed work's value.
- **The stall:** paid on ticks 1–1,500, 0 on ticks 1,501–6,000, paid again from tick 6,001 to 6,900,
  then 0. It is paid for 160 units' work at `x / y`, nothing is clawed back, and it breaches with the
  full fee, exactly as before.
- The uncommitted factory, the sale record's shape, the halt on an impossible `x`, the halt on a
  missing price, the carry's construction and tripwires, and determinism.
- **Isolation:** Tier-1/2 committed goods, pinned to hashes computed on HEAD 4a0a651, every tick of
  1,200 on a 60-tick day. One galaxy is Tier-1/2 alone, with an unlicensed Tier-3 factory: state every
  tick and the snapshot every 10. The other puts that guild beside two guilds paid on timed progress:
  the Tier-1/2 guild's whole state, and the Tier-1/2 slice of a guild that commits both a titanium mine
  and fuel tanks.

The file was also run against the **HEAD** engine: 10 of its 12 tests fail there. The two that pass are
engine-independent (the uncommitted factory and determinism). The isolation test fails on HEAD only at
its check that the mixed guild was paid every tick (HEAD paid it on 80 of 1,200); its hashes are HEAD's
own. Eight deliberate code breakages each turn tests red:
- the delivery crediting a timed good too (the double count: 7 tests red);
- rounding each tick instead of floor-and-carry;
- flooring with no carry;
- paying on a tick with no unit on the line;
- paying the whole progress instead of the committed share;
- ignoring the owner split;
- paying every good on progress (caught by the isolation pin: Tier-1/2 deliveries stop crediting);
- dropping the halt on an impossible `x`.

**Test updated deliberately.** `tier3-timed-production.test.js` "SEAM 1" pinned the old lumpy sale. It
now pins the new split: delivery stays lumpy (ticks 15, 30 and 45), and payment is 6 or 7 credits every
tick, 300 in all for three units. Its scaffold commitment of 10,000 became 672, the most a 3-1 factory
can commit, because the payment now refuses an `x` above `floor(y)`.

**No golden hash moved.** No pinned run commits a timed good. Every existing isolation pin (3a, 3b, 3c)
passes unchanged, and so do the goldens in `commitment-scaffold.test.js` and elsewhere. The build
session also diffed the two isolation galaxies against HEAD for 3,000 ticks at the ruled 1,440-tick
day, at an anchored day and at a 60-tick day: identical at every tick (state and snapshot for the
Tier-1/2 galaxy; the Tier-1/2 guild and slice beside the committed Tier-3 guilds).

**Before Tier 3 runs live.** The engine slices are done. Still open:
- **the client**, which still sends the Tier-1/2 licence shape for a Tier-3 factory (3c's item);
  *(⤳ The Establish popup: built 28-09-26, "As built — the client" at the end.)*
- the Slice 3c and 3d items on the roadmap's decision checklist.

## As built (28-09-26) — the Strong discount on the re-offer, and two rulings recorded

A cleanup after 3c and 3d. Three lifecycle items those slices flagged for the human are now **RULED**.
One needed a code change; the other two are recorded here only.

**1. A Strong venture keeps its Strong discount on the Tier-3 re-offer (code).** 3c built the fixed
re-offer with a fee discount of 0 at every band. The ruling is that a Tier-3 re-offer drops only the
commitment **ratchet**. So `renegotiationTerms` (`sim/licence.js`) now returns, for a Tier-3 licence:
- the same `x / y`, to the bit, and the same one-week term, at every band (unchanged);
- `feeDiscount = STRONG_FEE_DISCOUNT` (the existing −10%) for a Strong venture, and 0 otherwise.

Standing is read for the discount and for nothing else. `renegotiationFee`, the `renegotiateLicence`
re-lock and the snapshot's `renegotiationOffer` all read that one function, so the offer shown and the
fee locked still agree. Example: a Strong heavy reactor engine at `x = 3`, re-offered at 20M, is re-locked
at 90% of 7,000,000 and 5,500,000, which is **6,300,000 and 4,950,000**. The discount is taken off the
freshly priced fee at each renewal, so it never compounds. **No new number:** `STRONG_FEE_DISCOUNT` is
the existing constant. The Tier-1/2 branch is not touched.

**2. The breached-week divergence is intended (docs only).** On a breached week the Syndicate keeps
every unit delivered, while the guild is paid only its committed share `x / y`. This is a deliberate
breach penalty; see "A consequence worth knowing" in "As built — Slice 3d".

**3. Auto-lapse is intended (docs only).** An unaccepted Tier-3 re-offer lapses on the existing timers.
There is no auto-renew step. See "Renegotiation — fixed re-offer".

**Proven** (`sim/tests/tier3-contract.test.js`):
- The (c) headline now expects the discount at Strong only. At today's price of 150, a 200-of-672
  re-offer is re-locked at 10,080 / 9,330 at every other band and at 9,072 / 8,397 at Strong (typed by
  hand). A second renewal is priced the same, so the discount is not applied twice. The offer shown
  matches the fee locked, `feeDiscountApplied` included.
- A new **tripwire** probes both sides of every band edge (−300 / 0 / 500), for a 3-1 part and for a
  heavy engine (`x / y = 6/7`). The commitment and term never move, and the discount is there only at
  Strong. It also checks the 6.3M / 4.95M example above, and the full fee one RP below Strong.
- The 5,139-pair round trip now also checks the discount at each of the four bands.
- Run against HEAD's `sim/licence.js`, 3 of the file's 14 tests fail (the three re-offer tests). Two
  deliberate breakages are each caught by the same three: the Tier-3 ratchet put back, and the discount
  given at every band.

**Isolation.** Only the Tier-3 branch of `renegotiationTerms` changed. The 3c Tier-1/2 isolation pin
(hashes computed on HEAD 5867c18) passes unchanged, and so does the (d) ratchet test. **No golden
moved.** No pinned run renegotiates a Strong Tier-3 venture: the only other Tier-3 re-lock in the suite
(`tier3-settlement.test.js`) is at Steady, where the discount is 0 as before.

## As built (28-09-26) — the client: the Tier-3 fork of the Establish popup

The engine slices were done, but the game client still sent the Tier-1/2 licence shape (a percentage
and a 7–42-day window) for every factory, and 3c's engine refuses that for a timed good. So every
licensed Tier-3 deploy from the game landed **unlicensed**, with the refusal in its receipt. This
slice is client-only, except for one additive snapshot field. The engine's behaviour is unchanged.

**The one engine-side change: a derived snapshot field, `tier3Contract`** (`sim/snapshot.js`). The
popup must offer `x` whole units of `y`. It must also know which goods are timed, and it may compute
no game number. Nothing it read said any of that. `feeQuote` is the basic fee only, and GET /goods's
`baselineUnits` is the continuous 5-a-tick figure, not the timer. So the snapshot now publishes, per
**timed** good only:

    tier3Contract: { <good>: { weeklyOutput, committedUnitsCeiling, termDays } }

- `weeklyOutput` is `y`, from `weeklyOutputOf` over the signing's own basis (`licenceBasisForGood`).
  It is exact, so it may be fractional (a heavy reactor engine is 3.5).
- `committedUnitsCeiling` is `floor(y)`, from `committedUnitsCeiling`. That is the bound
  `applyForLicence` refuses above.
- `termDays` is `TIER3_TERM_WINDOWS × (week ÷ day)`, the same expression `renegotiationSchedule`
  counts a signed licence's term in. It is 7 at the ruled 1,440-tick day.

A good is listed only when `isTimedVenture` says so, asked about the venture that makes it. That
gives the 21 timed goods, and never the four unclassified modules. A galaxy whose day does not
divide the week lists none, because it cannot sign one. The field is derived on read: no stored
byte, no determinism hash, no schema bump. **No number was invented.**

**The fork** (`client/game.html`, `applyTier3Fork`). It is triggered the way FUEL and TIER 4
already fold the popup: one more function run from `draw()`, after theirs. The test is "is the
chosen recipe's good in `tier3Contract`?", so the client holds no good list, timer or week of its
own. When it is on:
- **Commitment.** The percentage slider is swapped for a whole-unit slider, `0..floor(y)`, `step 1`.
  It can only rest on a whole unit (336.7 snaps to 337; a click at 60% of a heavy engine's track
  lands on 2). It reads `x / y /week`, with `y` as the engine gives it. A new recipe re-scales it
  live: a new max, new notches, a new readout. An `x` above the new `floor(y)` is held to it (400
  fuel tanks become 3 heavy engines), so the deploy can never carry an `x` the engine would refuse.
- **Equity** is unchanged.
- **Fee, graph and reputation** read `x / y`. That is the exact ratio the signing stores as
  `committedOutputPct` (`committedPctForUnits`), fed through the popup's existing, test-guarded
  mirror of the engine's four-corner grid (`feePct`) and `metGain` (`repGain`). The basic fee is
  the snapshot's `feeQuote`, which for a timed good is already the weekly `0.10 × y × price`. The
  graph's axis reads `commit 0 … y /week`. With a fractional `y` the marker cannot reach the right
  edge (3 of 3.5 is 6/7), which is the truth of that contract.
- **Renegotiation window.** The 7–42-day slider is replaced by a read-only `termDays days · fixed`.
- **Licence Summary.** It reads weekly: Committed `x / y <good> /week`, Fee `… ¢ /week`, Breach fee
  `= basic ¢ /week`, Renegotiate in `7 days`. The 3a checklist's "per cycle" label is fixed here,
  for timed goods in this popup.
  *(⤳ 28-09-26: its Rate row now reads "Produces `y /week`", the weekly capacity. See "As built —
  the client's weekly copy" below.)*
- **Deploy.** `establishVenture` is exactly as before (equity rides on it). It is followed by
  `applyForLicence { guildId, ventureId, committedUnits: x }`, with no `committedOutputPct` and no
  `windowDays`. The receipt reads the stored contract back off the snapshot: `x` is
  `syndicateCommitment`, the days are `contractWindow.cyclesRemaining` (not the stored `windowDays`,
  which counts weeks), and the fees are the locked ones.

Every non-timed recipe keeps today's popup. The Tier-1/2 slider, window and ledger lines are
untouched, and so are the Fuel, Tier-4 and Deuterium paths. The hero art is the popup's existing
planet image, loaded as before.

**`y` for reading.** The label shows `y` to at most 2 dp (a deep scan mast's 2.333… reads `2.33`),
following the engine's own convention: `validateTier3Licence` names `y` "to 2 dp only for reading".
The ratio always uses the exact `y`.

**Proven.**
- `sim/tests/tier3-establish-client.test.js` (6 tests):
  - the field lists exactly the 21 timed goods;
  - at `floor(y)` each is accepted and stores the published `x ÷ y` to the bit, and one more is
    refused, naming the same bound;
  - the quoted fee is the locked fee;
  - `termDays` equals the schedule's term and the Venture Management window at a 1,440- and a
    60-tick day (7 and 168);
  - the field is omitted at a 50-tick day;
  - it is derived only and deterministic;
  - **end to end over HTTP**, the popup's exact two actions for a heavy engine are ACCEPTED, and the
    old `{ committedOutputPct, windowDays }` is REFUSED with the bound named.
- `server.test.js` pins the served page:
  - the trigger reads `tier3Contract`, and the page carries no timer, week or timed-good name;
  - the fork runs after the two collapses;
  - the step-1 slider is re-scaled to `floor(y)`;
  - the fee and meter read `x / y`;
  - the fixed term reads `termDays`;
  - the Tier-3 licence object carries `committedUnits` and neither Tier-1/2 term.
- Six deliberate breakages each turn tests red:
  - `termDays` not over the day;
  - every good listed;
  - `y` rounded;
  - the old shape sent;
  - the fee reading `S.c` on Tier 3;
  - the fork not called.
- **By exercise**, in Chromium on a live dev server, through the real connect → system → homeworld →
  Settlements path:
  - the fork switches on and off by recipe (an unclassified module keeps the Tier-1/2 panel, and
    back to Tier 2 restores it);
  - the slider snaps, and re-scales from 0–672 (fuel tank) to 0–3 of 3.5 (heavy engine) and 0–2 of
    2.33 (deep scan mast);
  - at every point of a sweep of `x` and equity, the ledger's ¢/week equals the engine's
    `licenceFee` arithmetic, and the fee % and the marker move with it (3 of 3.5 reads 5,500,000,
    the worked example in "As built — Slice 3c");
  - the deploy sent `{ committedUnits: 2 }` alone and was accepted, and the locked fee equalled the
    panel's pre-deploy figure;
  - the same Tier-3 deploy through the **pre-slice client** (HEAD 5aa9099) sent
    `{ committedOutputPct: 0.5, windowDays: 14 }` and was refused, leaving the venture unlicensed;
  - the Tier-2 popup screenshot is **pixel-identical** to the pre-slice client's, and its two
    actions, confirm text and receipt are identical.

**Isolation, and the one test change.** No engine behaviour changed, and no golden moved. Two
isolation pins hash whole snapshots: `ISO_SNAPSHOTS_AND_RESULTS` in `tier3-contract.test.js` and
`ISO_ONE_SNAPSHOTS` in `tier3-payment.test.js`. The new top-level key moved them. They now hash the
snapshot **without `tier3Contract`**, and both still match the hashes computed on the pre-slice
engine, so every other snapshot byte is unchanged. **Nothing was re-pinned.** `server.test.js`'s
tier-blind meter pin now matches `repGain(cr,S.o01)`, where `cr` is `S.c` for Tier 1/2. It still
guards "two arguments, no tier".

**Before Tier 3 runs live.** The Establish popup is no longer a blocker. Still open (roadmap
decision checklist):
- the Venture Management and renegotiation popups' Tier-3 readings (3c's list);
- the System Production Console (a later slice);
- the items this slice defers.

## As built (28-09-26) — the client's weekly copy: capacity in the Rate row, no per-tick words

A follow-up to "As built — the client", in `client/game.html` only. The fork was right, but three
things on the Tier-3 path still spoke Tier-1/2:
- the Rate row showed the stamped `5 batches/tick`;
- the unlicensed receipt said "First output next tick";
- the licensed receipt and a help reel said the committed "share" is "paid tick by tick".

A timed good makes one whole unit per timer, and nothing lands on the next tick. So this slice
changes **only what the popup says, and what the Rate row shows**, for a timed good. The engine, the
snapshot, the `applyForLicence` shape and the fork's mechanics (snapping, the fee graph, the deploy)
are untouched. **The convention from here on:** every Tier-3 client surface speaks in whole units
and weeks. It says no "share", no "per cycle" and no "per tick".

**1. The Rate row shows weekly CAPACITY.** For a timed good the row is labelled **Produces**, and
its value is `y /week`. `y` is the snapshot's `tier3Contract[good].weeklyOutput`, formatted as the
fork already formats it (`fmtY`: 672, 3.5, 2.33). It is a property of the recipe. It reads neither
the commitment nor the licence choice, so it is the same in every state. It pairs with the
commitment below it: capacity `y` a week, then `x` of `y` committed.
- The engine is unchanged. The stamped `productionRate` is still inert for a timed factory (the
  decision checklist's Slice-2 question). The row now simply shows the figure that is true for a
  timed good.
- Every other venture keeps its **Rate** row exactly: a mine's units/tick, a factory's batches/tick
  (including the four unclassified modules), the refinery's `/tick`.

**2. The commitment readout.** On the Tier-3 path, the readout beside the whole-unit slider was
already weekly (`x / y /week`). The Tier-1/2 readout (`cQty`) is hidden there, but it was still
being filled with a `/cycle` figure sized off the stale continuous baseline. It is now left empty on
the Tier-3 path. Tier 1/2 still read `– N/cycle`.

**3. The confirm and the receipts.** For a timed good:
- **The confirm:** "committing `x` of its `y` units a week to the Syndicate, on a fixed one-week
  term … at a weekly fee of about N% of basic". Then: "It can make up to `y` units a week, one whole
  unit at a time, and delivers the `x` you commit to the Syndicate first, each week." Then when the
  first unit starts, and that the week ends in `termDays` days, when the Syndicate re-offers the
  same terms. Unlicensed, it names the capacity and the first unit only.
- **The licensed receipt:** `x` of the `y` units it can make a week, to the Syndicate, on a fixed
  one-week term. It says when the week ends, and when the first unit starts. The fee lines are
  unchanged. Their last sentence is now "The committed units are paid for steadily through the week,
  as the factory works, not in a lump on delivery", which is Slice 3d's rule without "share" or
  "tick". A "672 fuel tank a week" grammar slip became "672 units".
- **The unlicensed receipt:** "on guild droids. It can make up to `y` units a week, one whole unit
  at a time; its first unit starts once a full set of its inputs is in stock". Before, it said "at
  baseline … First output next tick". ("At baseline" is dropped because baseline is the continuous,
  per-tick idea.)
- **The "Recorded:" line** names no rate for a timed venture: the stamped batches/tick is inert, and
  the weekly capacity is already stated. It still names the venture and the site.

**No ETA is shown.** The build prompt allowed "first unit in ~N hours" only if it could be sourced
cleanly from the good's timer. It cannot. The page holds no timer (a served-page pin forbids
`TICKS_PER_UNIT` in it), and working it out as `10,080 ÷ y` would be the browser computing a game
number (§5's display rule). So the copy says what starts the first unit (a full set of its inputs in
stock) and gives no time. This is on the decision checklist.

**4. The two Tier-3 help reels.**
- `commitUnits` now ties `y` to the Produces row.
- Its second page says the `x` units go to the Syndicate first each week and are paid for steadily
  as the factory works. Before, it said "your committed share … paid tick by tick".
- `term3` names "the same `x` units a week".

The three reels the Tier-3 path shares with Tier 1/2 (asset, licence, equity) are unchanged. They
carry no per-tick or per-cycle rate, and changing them would change Tier 1/2.

**Proven.**
- `server.test.js` gets one new served-page pin (+1):
  - the Rate row answers `y /week` before the per-tick branch, and reads none of `S.x`, `S.c`,
    `S.o01` or `S.licensed`;
  - the key swaps to Produces;
  - `cQty` is empty on the Tier-3 path;
  - the Tier-3 halves of the confirm, both receipts and the two reels carry no "next tick", "tick by
    tick", "per tick", "/tick", "batches", "cycle" or "share" in their copy;
  - the "Recorded:" line skips the rate for Tier 3;
  - the Tier-1/2 per-tick and per-cycle strings are still there.
- Six deliberate breakages each turn it red:
  - the per-tick rate put back;
  - the rate row gated on the licence choice;
  - the `/cycle` readout written on Tier 3;
  - "tick by tick" put back in the receipt;
  - the rate put back in "Recorded:";
  - "share" put back in the reel.
- **By exercise**, in Chromium on two live dev servers (seed 7331): one served HEAD 3ef93a2's client
  and one this slice's. The same script ran the real connect → home system → Settlements path on
  both, in the same deploy order:
  - A fuel tank reads "Produces 672 /week" in all 11 states tried: undecided; licensed at
    `x` = 0, 1, 336, 671 and 672; equity 0, 25 and 49%; unlicensed; and back again. HEAD read
    "Rate 5 batches/tick".
  - A heavy engine reads "3.5 /week" in 5 states, and a deep scan mast "2.33 /week".
  - An unclassified module (Drive Module) keeps "Rate 5 batches/tick".
  - The Tier-3 confirms (licensed and unlicensed), both receipts and both reels carry none of the
    words above. HEAD's receipts and reel carried "share", "tick by tick", "next tick" and
    "batches/tick".
  - **Parity:** every Tier-1 (mine), Tier-2, unclassified-module, Fuel and Tier-4 capture is
    identical to HEAD's. That covers the panel in every slider state tried, the confirms, the
    receipts of real deploys, and the Tier-1/2 and shared reels. Each of the five paths' popup
    screenshots is a **byte-identical** PNG to a HEAD run. The renderer has a little run-to-run
    noise: at most 12 pixels, at most 2 of 765 colour levels. HEAD shows the same noise against
    itself, on the same pixels, so the check compared against three HEAD runs.

**No engine change, and no golden moved.**
