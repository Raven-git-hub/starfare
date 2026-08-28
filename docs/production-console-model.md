# The System Production Console — data model & storyteller lens

> Status: design catalogue, first cut (11-08-26). Companion to design.md §5
> (one-pot distribution + windowed accrual) and the console mockup at
> `docs/mockups/console_redesign.html`. This doc catalogues WHAT the console
> reads and writes; it does not restate the distribution rules — those live in
> §5. When this doc and the engine disagree, the engine wins and this doc is the
> bug (§18 rule 2).

## Why this doc exists

The System Production Console is where a guild sets its Gate-1 distribution
policy for one system: for each good, how the one pot (`reserve0 + fresh`) is
split between the three claimants — **Syndicate**, **Production** (downstream
consumers), **Stockpile** (reserve held) — in a priority order the player picks.

Cataloguing its inputs and outputs does double duty:

1. **The data model.** Every value the console writes is a column the live
   galaxy DB must hold; every value it reads is either another stored column or
   something the tick recomputes. Pinning these now means the Phase-2 Postgres
   schema is a transcription of a known contract, not a guess. The console is
   two hops from the DB — `panel → action → engine → state (→ DB)` on the way in,
   `panel ← snapshot ← state (← DB)` on the way out — and never touches the DB
   directly (design.md §5 client-computes-no-game-number, §15.7 action-vs-tick).

2. **The storyteller's instrument panel.** The same fields that drive the UI are
   the read-signals of a guild's comfort and dominance (is it reliably meeting
   its commitment? hoarding? starving its consumers?) and, on the write side, the
   levers the storyteller can lean on — window length, a guild's commitment
   target — to apply *pressure over prohibition* (design.md, Syndicate model).
   The storyteller section at the end maps which fields are Signals and which are
   Levers.

## The three-way taxonomy

Every value the console touches is exactly one of:

- **STORED** — a durable field that survives ticks and enters the determinism
  hash. These become DB columns. The console WRITES these (through an action;
  never directly). The tick READS them.
- **DERIVED** — recomputed by the tick from stored state every turn, serialized
  nowhere. The snapshot carries it so the console can render it; the console
  computes nothing from it (§5 display rule). Never a DB column.
- **BRIDGE** — the plumbing between the panel and state: which *action* a control
  emits, and which *snapshot field* a readout reads. Not data itself; the wiring.

The rule that keeps STORED and DERIVED honest: **if the tick can recompute it
from other stored state, it is DERIVED and must not be a column.** Storing a
derived value invites two sources of truth that drift (the §18 bug the doc-and-
code-in-one-commit rule exists to prevent).

## Stored state the console governs

One system's production policy, as it sits in state today (`sim/profile.js`,
`sim/windows.js`, and the `Venture` shape). These are the columns.

### Per-good policy — `guild.productionProfile[systemId].goods[good]`

Set by the `setProductionProfile` action (`sim/actions.js`). `getGoodPolicy`
(`sim/profile.js`) fills any field the player never set with its structural
default (§15.4).

| Field | Type | Default | Meaning | Set by (panel) |
|---|---|---|---|---|
| `order` | permutation of `["syndicate","downstream","stockpile"]` | `["syndicate","downstream","stockpile"]` | claimant priority — who draws from the pot first | Stockpile panel's priority rank (and the others' implied ranks) |
| `downstreamPct` | int 0..100 | `100` | share of consumer demand the Production fork is allowed to meet | Production panel slider |
| `reserveLevel` | int ≥ 0 | `0` | units the Stockpile fork holds back in the pot (the "put this much in if you can" target) | Stockpile panel slider / number |
| `syndicate` | `{ mode: "absolute"\|"percent", value: int ≥ 0 }` or ABSENT | ABSENT = paced required-rate | the Syndicate fork's per-tick send control. Absent ⇒ engine paces itself to hit `Q` by the deadline; present ⇒ player pins the rate | Syndicate panel slider (writes `{mode:"absolute", value}`) |
| `pursue` | ordered list of the good's committed venture IDs, or ABSENT | ABSENT = establishment order | the priority the delivered pile fills the good's licences at the boundary — the top licence gets its full commitment first, then the next, until the pile runs out; editable any tick, only the order at the boundary counts | Syndicate roster (per-row ▲/▼ movers) |

Note on `syndicate`: **presence, not value, selects the regime.** Absent means
"pace yourself." The panel's snap-to-marker writes `{mode:"absolute", value:
ceil(requiredRate)}` — an absolute rate so it doesn't drift as fresh output
changes (the player's stated intent). `percent` is legal in the engine (share of
this tick's fresh, >100 allowed = "send all fresh") but the panel does not emit
it in this cut.

### Per-venture commitment — `Venture.syndicateCommitment`

| Field | Type | Default | Meaning | Set by |
|---|---|---|---|---|
| `syndicateCommitment` | int ≥ 0 | `0` (unlicensed) | this mine's FULL-WINDOW delivery target. Its target for a *particular* window is `qᵢ = round(syndicateCommitment × windowFraction)` — the mid-window pro-rate, `= syndicateCommitment` for a mine present the whole window | `applyForLicence` (the licence grant); `setSyndicateCommitment` remains as the dev/test/bot setter |

This is the *source* of the Syndicate panel's whole target line. The panel reads
`Q` (the derived sum) but the stored truth is per-mine here.

**The rounding, and why it is per venture:** `Q = Σ qᵢ` — each mine's target is
rounded **first** and the rounded targets are summed. It is *not*
`round(Σ contribution)`: those are different integers whenever the window
fractions don't round the same way, and the difference is not cosmetic. The
boundary fill hands each venture its own `qᵢ` while the Syndicate fork
self-terminates at `Q`, so a `Q` below `Σ qᵢ` would leave a licence unable to
reach a target the pile was never allowed to hold — a **phantom breach** — and a
`Q` above it would admit a unit no verdict accounts for. Summing the rounded
targets makes the cap and the verdicts the same integers by construction. (For a
full-window mine `qᵢ` is just its stored commitment, so every full-window run is
unaffected, byte for byte.)

### Per-good window accumulators — `guild.syndicateWindows[systemId][good]`

Minted lazily (`sim/windows.js`); a guild whose every commitment is 0 never gets
the key, keeping serialized state byte-identical to the pre-window path.

| Field | Type | Meaning |
|---|---|---|
| `windowStart` | int ≥ 1 | the producing tick the current window opened on |
| `delivered` | int ≥ 0 | units delivered to the Syndicate so far THIS window |
| `sendCarry` | float [0,1) | fractional send remainder (floor-and-carry, so integer sends still average the required rate) |

These three ARE serialized and enter the determinism hash. Everything else the
Syndicate panel shows about the window (below) is recomputed from them.

### Per-good production/consumption history — `guild.productionHistory[systemId][good]`

*(Added 28-08-26 — the persistent-history slice.)* The console's two trend
sparklines. Minted lazily (`sim/history.js`), one sample per producing tick,
written in exactly ONE place: `applyProduction`. A guild that has produced
nothing never gets the key, so an idle galaxy's serialized state is
byte-identical to the pre-slice path — the same discipline `syndicateWindows`
follows, and the reason the golden-hash regen is provable rather than blind.

| Field | Type | Meaning |
|---|---|---|
| `prod` | int[] ≤ 60 | this good's OUTPUT here per tick — Σ mine fresh **+** Σ refinery `minted`, oldest→newest |
| `cons` | int[] ≤ 60 | its DOWNSTREAM DRAW per tick (`fork.downstream` — what the lines really took) |

Both ARE serialized and enter the determinism hash. They are the first stored
state the console reads that is **not** recomputed on read — which is exactly
why the graph survives a reload and is the same for every viewer. Before this
slice the buffer lived in the browser: it started EMPTY on every page load, so a
returning player watched "gathering history…" refill live and no two viewers saw
the same line.

Two rules worth stating, because a trend line is a claim about time:

- **Contiguous.** Once a good has a series, every tick it is still routed pushes
  a sample — a `0` on a lull included. A gap would draw a slope between two
  ticks that are not adjacent.
- **Never back-filled.** The past was never recorded (the journal holds actions,
  not per-tick production), so the buffer fills FORWARD from deploy. Nothing is
  reconstructed and nothing is pruned; a good that stops producing keeps its
  bounded tail, because "production fell to nothing" is the story the graph is
  for.

`HISTORY_N = 60` is a **display-depth** constant — how far back the sparkline
looks. It is not an economy number (it feeds no rate, price or commitment), so
it is not a `[FIRST-CUT]` and carries no decision-checklist entry.

### Engine-wide — `state.windowN`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `windowN` | int ≥ 1 | `DEFAULT_WINDOW_N = 1,440` | window length in ticks, galaxy-wide. **RULED 27-08-26**: a commitment cycle is one 24-hour day = 1,440 one-minute ticks (`docs/cycle-and-calendar.md` §1), which promoted the old `[FIRST-CUT] 24` placeholder this line used to name. Player-facing copy says "hours," never "ticks." Set by `setWindowN` (an operator/storyteller lever, not a per-guild control) |

## Derived telemetry the console reads

All of this comes from `buildSnapshot`'s `production` block
(`sim/snapshot.js` → `previewProduction`, `sim/production.js`), recomputed every
tick by the SAME `resolveProduction` the tick applies, so the figures are engine
truth. **None of it is a DB column.** The block is an array — one entry per guild
`{ guildId, systems: [...] }`, each system `{ systemId, mines, goods, lines,
refineries, review, history }` — so the console finds a good by filtering to its
guild, then its system, then `goods[good]`.

The one exception is `history`, which is NOT derived: it is the stored buffer
above, echoed verbatim (copied, so a snapshot consumer cannot mutate engine
state through it). It sits beside `review` at SYSTEM level rather than inside
`goods` because `goods` holds only the goods ROUTED this tick — a mined good
with no in-system consumer and no commitment has no `goods` entry, yet still has
a trend to draw. The console reads `…systems[…].history[good]`.

### Per-good, per-system — `…systems[…].goods[good]`

| Field | Type | Meaning | Read by (panel) |
|---|---|---|---|
| `fresh` | int | Σ mine output this tick (the routing basis) | Syndicate (send-vs-fresh), Stockpile (%-of-output math) |
| `demand` | int | Gate-2 naive full-tilt Σ — what consumers would take at full rate, IGNORING `downstreamPct` (the stable REQUIRED basis) | Production panel (the REQUIRED number) |
| `reserve0` | int | start-of-step reserve (what last tick left in the pot) | — (context for `pot`) |
| `pot` | int | `reserve0 + fresh` — the one pot the three claimants draw from | — |
| `supplied` | int | the consumer draw CAP this tick = min(demand×downstreamPct, what's left above the Production slot) | Production panel (PROVIDED, for the %) |
| `fork.syndicate` | int | units DELIVERED to the Syndicate this tick (leaves to the sink) | Syndicate panel (current send) |
| `fork.downstream` | int | units consumers actually DREW this tick | Production panel (actual throughput) |
| `fork.stockpile` | int | units HELD in reserve this tick (stay in the pot) | Stockpile panel (units going in) |
| `reserveDelta` | int (signed) | `pot − draws − reserve0` — this tick's net reserve change (the console's trend arrow) | Stockpile panel (pile rising/falling) |

At the line level each consuming venture also reports `demand / alloc / drawn`
(`drawn` = whole units pulled). The three distribution panels work at the
good level and don't read the line rows; the future Producers/Consumers panels
will.

### Per-good window telemetry — `…goods[good].window`

Present only for a good carrying commitment. The first four echo stored state;
the rest is pure derived telemetry (the client renders it and computes nothing).

| Field | Type | STORED or DERIVED | Meaning | Read by |
|---|---|---|---|---|
| `Q` | int | derived (Σ of stored `syndicateCommitment`) | the aggregate window target | Syndicate (the goal) |
| `windowStart` | int | STORED (echo) | tick the window opened | — |
| `delivered` | int | STORED (echo, post-apply) | AGGREGATE units delivered to the Syndicate so far this window (= Σ of the per-venture `delivered` below); the accumulator stays aggregate, the per-venture shares are DERIVED from it | Syndicate (overall progress) |
| `sendCarry` | float | STORED (echo) | fractional carry | — |
| `ticksRemaining` | int | DERIVED | ticks left in the window. A tick is ruled at ONE MINUTE, so the console shows it as a **duration** (`23h 14m remaining`) — it was labelled "hours remaining", which was 60x wrong (fixed 28-08-26) | Syndicate |
| `requiredRate` | float | DERIVED | `remaining / ticksRemaining` — the pace needed to hit `Q` on time (the amber marker) | Syndicate (marker + snap target) |
| `sendThisTick` | int | DERIVED | the ACTUAL delivery resolved this tick (`= fork.syndicate` for the good) | Syndicate |
| `pctAchieved` | float | DERIVED | `delivered / Q × 100` | Syndicate (progress %) |
| `status` | `"accruing"` \| `"met"` \| `"breach"` | DERIVED (ROLLUP) | the good-level **summary** of the per-venture verdicts below — the real met/breach is per venture (see next section). `met` as soon as EVERY row is met (mid-window included, 28-08-26); otherwise `accruing` mid-window and `breach` at the boundary | Syndicate (overall pill) — **and the storyteller** |

| `perVenture` | `{ [ventureId]: { commitment, delivered, status } }` | DERIVED | the per-licence outcome — see the next section. Keyed by ventureId so the roster reads a row per venture with no reshaping; insertion order IS the reconciled pursue order | Syndicate roster (one row each) |

### Per-venture licence outcome — the REAL met/breach *(added 27-08-26; BUILT 27-08-26)*

Met/breach is fundamentally a **per-licence** fact, not a per-good one: each venture either delivered its whole
committed quantity or it did not, and that is what the fee (later slice) charges against. The good-level
`window.status` above is only a rollup of these. **DERIVED** — computed from the aggregate `delivered`, each
venture's commitment, and the good's `pursue` order; no new stored accumulator (the taxonomy rule:
recomputable ⇒ derived).

Per licensed venture producing the good, at read time:

| Field | Type | Meaning |
|---|---|---|
| `commitment` | int | the venture's target THIS window = `syndicateCommitment × windowFraction` (the mid-window pro-rate, §5 join ruling; = `syndicateCommitment` for a full-window venture) |
| `delivered` | int | its share of the aggregate `delivered`, allocated by the `pursue` fill: ventures are filled top-of-order first, each to its full `commitment`, until the delivered pile runs out. Mid-window a projection off the delivered-so-far; at the boundary the final allocation |
| `status` | `"accruing"` \| `"met"` \| `"breach"` | `met` iff `delivered ≥ commitment` (the ENTIRE commitment — one short is `breach`, no partial credit), reported **as soon as it is true, mid-window included** (28-08-26: `delivered` only grows within a window and the fill is top-down, so a full licence cannot fall back). A row still short reads `accruing` mid-window, and `breach` only at the boundary. Drives the per-venture fee: `met` → discounted, `breach` → full |

The fill is **binary per venture** and **priority-ordered**: in a shortfall the top licences are met in full and
the tail breaches, exactly as the player ranked them — so a player who cannot meet the aggregate steers the
goods onto the licences that cost least or need reputation. The good-level `delivered` = Σ these; the
good-level `status` = their rollup.

**BUILT — licence distribution slice, 27-08-26** (`docs/licence-distribution.md`). The `pursue` control, the
per-venture allocation and the per-venture `status` are all live in the engine, exactly as specified above. The
window still tracks ONE aggregate `delivered` per `(guild, system, good)` — the per-venture shares are derived
from it at read time, no new stored accumulator — and the good-level `status` is now the rollup.

Where to find each piece: `pursue` is stored/read through `sim/profile.js` (`getGoodPolicy`, `storedPursue`,
`storedPursueGoods`) and set by `setProductionProfile`; the fill and the rollup are `pursueFill` /
`rollupStatus` in `sim/production.js`; the outcome is emitted as `…goods[good].window.perVenture` (below).

Two behaviours the table above leaves implicit, both settled by §5 and pinned by tests:
- **Reconciliation at read time.** A stored ranking naming a venture that no longer produces the good is
  DROPPED at the boundary and raises a `stale_pursue` **review flag** (the same class as a stale throttle) —
  the engine never rewrites the player's stored list. A committing venture the ranking omits is APPENDED, in
  establishment order. An absent ranking is therefore pure establishment order.
- **No arrival-time fencing (the N-4 ruling).** The fill draws on the window's *whole* pile, including units
  delivered before a mid-window joiner's licence existed. Ranked first, a latecomer can be met on goods an
  earlier venture actually sent, and that earlier venture breaches. Intentional — see §5.

**ON SCREEN — console-rewire slice, 27-08-26** (`docs/client-wiring.md`, the Syndicate-roster revision).
The roster reads `perVenture` directly: each row carries its own dot, its own `delivered / commitment`, and
its rank, and the committed block is drawn in the good's `pursue` order (reconciled in the browser by
`reconcilePursueIds`, which mirrors the engine's `reconcilePursue` rule for rule). Two movers per row write
the ranking back through `setProductionProfile`; a "clear ranking" button POSTs `pursue: null`. The
good-level `window.status` is kept for the thermometer's overview only — it is a rollup, not the truth about
any one row. The browser computes no game number: it orders rows and re-sequences ids, nothing else.

**Still not shown:** the **fee**. The charge is Slice 3b-iii, so the panel shows the met/breach dot and says
in as many words that the fee is not built — rather than printing a figure that never moves.

## Bridge — control → action, readout → field

Everything the console writes goes through an action; everything it reads comes
from the snapshot. No third path. Every player-facing control on the three
distribution panels emits ONE action — `setProductionProfile`. The other two
below are not player drags: `setSyndicateCommitment` is the dev/licence-layer
setter feeding `Q`, and `setWindowN` is the operator/storyteller knob.

### Writes (panel control → action → stored field)

| Panel control | Action emitted | Stored field it sets |
|---|---|---|
| Syndicate rate slider (snap) | `setProductionProfile` | `goods[good].syndicate = {mode:"absolute", value}` |
| Syndicate target (the `Q` line, once the licence layer feeds it) | `setSyndicateCommitment` | `Venture.syndicateCommitment` (per mine; `Q` re-derives) |
| Production fork slider | `setProductionProfile` | `goods[good].downstreamPct` |
| Stockpile level slider / number | `setProductionProfile` | `goods[good].reserveLevel` |
| Priority rank selectors (all three panels) | `setProductionProfile` | `goods[good].order` (the permutation) |
| Syndicate roster ▲/▼ movers, and "clear ranking" | `setProductionProfile` | `goods[good].pursue` (an array of ventureIds; `null` clears back to establishment order) |
| Window length (operator, not a per-guild control) | `setWindowN` | `state.windowN` |

Actions set standing policy and DO NOT advance the galaxy (§15.7): the write
lands in state immediately; the next tick reads it. This is why the panel is
"decoupled" — nothing the player drags moves time; the tick does.

### Reads (panel readout ← snapshot field)

Covered field-by-field in the two derived tables above. The shape the console
consumes per good (after locating guild → system in the `production` array) is:

```
…systems[systemId].goods[good] = {
  fresh, demand, reserve0, pot, supplied, reserveDelta,
  fork:   { syndicate, downstream, stockpile },
  window: { Q, windowStart, delivered, sendCarry,
            ticksRemaining, requiredRate, sendThisTick, pctAchieved, status,
            perVenture: { [ventureId]: { commitment, delivered, status } } }
}

…systems[systemId].history[good] = { prod: [int], cons: [int] }   // stored, verbatim
```

plus the good's policy echoed back so the controls render their current
positions: `order`, `downstreamPct`, `reserveLevel`, `syndicate`, `pursue`.

**The right hero's resting state — the system inventory** *(28-08-26)*. With no
venture selected, the industrial (right) zone shows every good the engine names,
grouped `TIER 1` / `TIER 2` / `TIER 3`, each a labelled bar. The quantity is a
plain per-system read — `guilds[guildId].stockpilesBySystem[systemId][good]`,
ruling B1's pool, **not** the flat guild-wide `stockpiles` — so a good that is
fully committed and ships out each tick honestly reads near 0; the trend
sparklines are where flow is shown, this is holdings. Tier 3's vocabulary is
`/goods`'s `tier3` (design.md §15.2): three display-only placeholders that always
read 0, since no recipe makes them yet. **Refined fuel never appears here** — it
is not a stockpile good and is not in `stockpilesBySystem`; it is guild-wide and
lives on the HUD. The only arithmetic is the bar fill, `qty ÷ the largest qty in
that same tier` (per-tier normalised, divide-by-zero guarded) — display math on
displayed numbers, exactly like the existing thermometer; no game number is
computed in the browser. Row order is sorted descending by quantity (ties
alphabetical by id) and then **held**, re-sorting only when the panel opens or the
system changes, so rows don't dance as quantities cross tick-to-tick. The venture
chips are single-select **with toggle-off**: clicking the selected chip clears it
and the hero falls back to this panel.

**…and embedded, it rides the venture bridge** *(28-08-26)*. In `?embed=1` the
console builds no side zones — the game shell owns them — so there is no right
zone here to render the panel into. It is **sent** instead, over the same
`postMessage` bridge the venture nameplate already uses. Two messages, one per
hero mode:

```
{ source:'starfare-console', kind:'venture',   name, role, facility }   // a chip is selected
{ source:'starfare-console', kind:'inventory', system, rows: [ { tier, good, label, qty, frac } … ] }
```

`rows` is the panel's OWN data — `inventoryRows()`, the one function both the
standalone panel and the bridge read, in the held order, with `frac` already
normalised within its tier. It is posted on every poll while the console is
resting, so the quantities in the game are as live as the standalone ones, and
the row order holds identically (it is the same held order). The game shell
renders what it is sent and computes nothing: it groups the rows by `tier` and
draws each `frac` as a bar — the same §5 display rule the nameplate follows. It
also dims its venture art and hides "Open venture management" in that mode, since
neither means anything over an inventory. This closes the "a toggle-off posts
nothing" gap left by the panel's first cut, where the host kept showing the last
venture forever.

## The storyteller lens

The storyteller (design.md, Rimworld-style: targets whoever has grown too
comfortable) reads the galaxy through the SAME fields. Its job splits cleanly
along the taxonomy: it watches DERIVED fields as **Signals** of comfort and
dominance, and it pulls STORED fields as **Levers** to apply pressure. It never
invents a prohibition — it moves the numbers the guild is already living inside.

### Signals — what the storyteller reads (DERIVED, per guild, over time)

| Signal | Field(s) | What it reveals |
|---|---|---|
| **Reliability / comfort** | `window.status` streak, `window.pctAchieved` | a guild that is `met` window after window is comfortable and dependable — a target. Chronic `breach` is a guild already under strain (leave it, or it snaps) |
| **Hoarding** | `reserveDelta` trend, `fork.stockpile` vs `fresh` | reserve climbing tick over tick = stockpiling. A guild sitting on a deep pile is insulated from shocks — comfort worth disturbing |
| **Production scale / dominance** | `fresh`, per-system spread of it | raw output is the crudest dominance measure; a guild out-producing the galaxy is the obvious storyteller mark |
| **Starving the network** | `demand` vs `supplied`, `downstreamPct` | a guild throttling its own consumers (low `downstreamPct`) or one whose supplied ≪ demand is choking downstream — a lever it has ALREADY pulled, and a tension the storyteller can amplify |
| **Licence footprint** | Σ `syndicateCommitment`, `fork.syndicate` throughput | how deep a guild is into the Syndicate — big committed, reliably delivering = a pillar of the institution, and thus exposed to institutional pressure |

None of these are stored; the storyteller samples them from snapshots over a
span of ticks (a comfort READING is a trend, not one tick's value).

### Levers — what the storyteller pulls (STORED, causes real pressure)

| Lever | Field | Pressure it applies | Blast radius |
|---|---|---|---|
| **Tighten the deadline** | `state.windowN` | shortening the window raises everyone's `requiredRate` — the comfortable feel it as a squeeze, the strained may breach | galaxy-wide (one knob) — a blunt instrument, use as a season/era shift |
| **Raise a guild's commitment** | `Venture.syndicateCommitment` (→ `Q`) | a bigger target for a specific over-comfortable guild: more of its fresh must go to the Syndicate, less to its own consumers/pile | one guild, one system, one good — the storyteller's precision tool |
| **(future) Licence terms / fuel utility** | licence layer, fuel price | the institution-level levers §5 reserves for later — grant, revoke, reprice | one guild to the whole market, depending |

The design principle holds on the lever side too: the storyteller can only make a
guild's own choices *cost more* — a tighter window, a heavier target. It cannot
forbid a guild from stockpiling or from starving its consumers; it makes those
choices bite (pressure over prohibition).

### The one asymmetry worth flagging now

A guild's `order` (which claimant it prioritises) and `reserveLevel` are stored
levers the *player* pulls, not the storyteller. The storyteller reads their
CONSEQUENCES (hoarding, starvation) as signals but does not overwrite them —
doing so would be prohibition by another name. The storyteller's write-surface is
deliberately narrow: `windowN` and `syndicateCommitment` today. Keeping that
surface small is what stops the storyteller from feeling like an author yanking
the player's hands off the controls.

## Open questions this catalogue surfaces

1. **Comfort needs history the snapshot doesn't carry.** Every Signal above is a
   *trend*, but the snapshot is one tick. Either the storyteller keeps its own
   rolling sample, or the engine grows a small per-guild rolling summary (a new
   STORED structure). Decide before the storyteller is built — it changes the
   schema. (Not a console concern; flagged because the console's fields are its
   inputs.)
2. **Is `syndicateCommitment` per-mine the right grain for a storyteller lever?**
   Raising `Q` means writing individual `Venture.syndicateCommitment` values; a
   guild- or system-level target might be the cleaner lever surface. Ruling
   deferred to the storyteller design.
3. **`percent` mode on the Syndicate fork is stored-legal but panel-absent.** If
   the console never emits it, is it dead surface, or a deliberate power-user /
   bot affordance? Keep or cut at licence-layer time.

_None of the above blocks the DB schema: the columns in "Stored state the console
governs" are settled and match the engine at main 7c6e46b._
