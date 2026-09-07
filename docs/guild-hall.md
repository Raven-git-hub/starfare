# Guild Hall — the player's Standing & fuel dashboard (working design, 02-09-26)

The Guild Hall is the player's home tab: at a glance, *where the guild stands with the
Syndicate* and *what fuel that standing buys it this cycle*. It is matched to the TRADE
tab's visual language (`docs/mockups/trade-panel.html`) — amber/Cinzel/IBM-Plex on the void
palette, the three-zone body, the right-hero art.

- **Clickable mockup (the visual + interaction contract): `docs/mockups/guild-hall.html`.**
  Not shipped as-is; the game renders this shape inside `client/game.html`, reading the live
  snapshot (the same rule the trade mockup follows).
- **This doc rules the STANDING panel (v1) and the engine wiring it needs.** Finance,
  Ventures, Council and Forum are later tabs, out of scope here.

## 1. Layout

Three zones, left to right: a **tab rail** (left hero) — Standing / Finance / Ventures, with
Council and Forum stubbed **"soon"**; the **centre panel** for the selected tab; and the
**CouncilChamber art** (right hero) with "GUILD HALL" over it. No text labels on the art.

## 2. The Standing panel

Three cards. The top row is two equal panels (Performance | Reputation sources); the
stockpile bar spans the width beneath them.

### 2.1 Performance (top-left)

A **10-cycle line of the guild's issuance modifier**, drawn green where it sits **above** the
Syndicate's line (modifier > 1.0) and red where **below**. Beside it, three **vertical gauges**
centred on ×1.00 (always at centre): **Current** (the modifier that set this cycle's grant),
**Predicted** (where the guild sits *now* — the modifier next boundary would grant on if the
cycle ended this instant), and **Fuel Δ** (the expected fuel-credit **change** next cycle). Each
gauge fills from the centre to the marker — **green up, red down** — so a Predicted marker in the
red is a plain warning that this cycle's actions are dropping the guild below its line.

**The Fuel Δ gauge** is the expected change in the guild's fuel-credit **entitlement** next
cycle: `predicted-next entitlement ÷ this-cycle entitlement`, a ratio centred on ×1.00 that
swings with the guild's **growth this cycle** (more GP or a lifted modifier → more entitlement →
the ratio rises above ×1.00). It divides two entitlements, so the shared fuel price cancels — it
measures the guild's own growth, **not** the market's price move (the absolute fuel-credit size
and the price ticker are a separate later panel). It reuses the same gauge as Current/Predicted:
centred on ×1.00, green up / red down, and **it prints the true `×N.NN`** even when the bar pins
at the axis clamp (a big-growth cycle shows e.g. `×2.10` with the bar at the top — expected, not
an error).

**It is live from founding.** The denominator is the entitlement stamped on this cycle's grant
(`fuelGrant.entitlement`) once the first cycle boundary has recorded one; **before that** it falls
back to `foundingEntitlement` — the credit entitlement `grantFor` captured at the instant the
guild was founded (an engine baseline, stamped in the `foundGuild` apply beside `foundingEndowment`
— **not** a synthesised grant). At founding, `predictedGrant` and `foundingEntitlement` come from
one GP and modifier, so the gauge opens at exactly **×1.00** and swings up live as the guild grows
this cycle; at the first boundary `fuelGrant.entitlement` takes over the denominator and the gauge
rebases with no visible change. So the gauge is honest from tick 0 — it renders `—` only when
there is genuinely no baseline (a zero-GP founding that draws nothing, or a guild founded before
the baseline existed, both of which read `null`).

**Deliberately NOT shown: raw GP, RP, expected, the gap, or any absolute fuel-credit size.**
Those are backend numbers the player doesn't reason in. The modifier gauges, the Fuel Δ ratio and
the line carry the whole story graphically.

### 2.2 Reputation sources (top-right)

A **donut of RP by source**, legend beneath, no centre number. Sources:

- **Ventures** — RP earned from met commitments (and signing bumps) on ordinary ventures.
- **System holdings** — the founding endowment (RP granted for territory; a baseline).
- **Deuterium production** — RP from licensed deuterium ventures *(0 until that mechanic
  lands; broken out from Ventures because it is special — T4-weight RP, output surrendered)*.
- **Transport contracts** — *placeholder, "soon".*
- **Council & politics** — the governance layer *(placeholder, "soon")*.

### 2.3 Fuel-credit stockpile (bottom, full width)

A **horizontal credit bar** — a live readout of the guild's fuel hoard valued in credits,
mirrored onto the dispatch page so the player judges affordability at the point of a trade.
**No absolute fuel quantity appears anywhere; every figure is credits — the backend hoard ×
the current fuel price this tick.**

The bar is purely presentational: it reads the hoard and draws it. **The engine owns the
`fuelHoard` number** and moves it — grants drop credits in at the boundary, trade burns take
them out, and (later) illegal refining adds to it per tick — and the bar just follows. The
client computes nothing and holds no state.

- **Fill = the live `fuelHoard`, in credits, every tick.** Whatever the engine has put in the
  hoard is what the bar shows; the client re-reads it each poll.
- **Max (the full length of the track) = the hoard at the START of the period, in credits** —
  legal and illegal together (the hoard does not distinguish them for sizing). It is set **at
  each cycle boundary** to the current (post-grant) `fuelHoard` × price, and **at founding** to
  the starting hoard — so a newly-founded guild's bar is **full from birth** rather than empty
  until its first boundary.
- Within a cycle the max **holds fixed** while the hoard stays at or below it: usage drains the
  bar from the **right**, and the empty space on the right is **what has been used this cycle**.
- The fill **grows from the LEFT and is contiguous: `[red illegal][blue legal]`.** Red (illegal
  fuel) sits at the base, 0 → its credit value; blue (legal fuel) stacks on top. **Depletion
  eats from the right, blue first** — only once blue is exhausted does usage bite into the red,
  the tell that the guild is burning **illegal** fuel. The **credit figure sits above each
  segment's head**, in the segment's colour, spaced so the two never collide.
- **The one case the max changes mid-cycle:** illegal refining is the only thing that raises the
  hoard within a cycle, ticking `fuelHoard` up and growing the red. When it pushes the live
  `fuelHoard` **above the current max, the max rises to match the current `fuelHoard`**, and the
  bar shows an increasing proportion of red (illegal) to blue (legal). The red is the natural
  home for a future **suspicion** marker.
- **v1 ships with illegal = 0** (no red bar; the illegal-refining mechanic is deferred). With
  nothing adding to the hoard mid-cycle, the hoard only ever **falls** within a cycle, so the max
  stays the start-of-period value and the max-rise case is dormant — the bar is simply the blue
  legal stock draining from the right against the start-of-period max, refilling at each boundary.

## 3. Data-point audit — every value, its source, its status

> **Correction (client panel build, 02-09-26).** The audit row above originally read
> Location ← `guilds[].landmark.name`, marked LIVE. Building the panel found that field is
> **not on the guild row** — `snapshot.js`'s guild block carries `homeSystemId` /
> `homePlanetId`, never a `landmark`. No engine field was added (the slice is client-only
> and §18 says STOP-and-report, not invent): the guild's **home system IS its location**,
> and the panel resolves `homeSystemId` through the shell's existing `__systemName` bridge
> (the same read the TRADE tab's per-system rows use). Founded-cycle stays dropped, not
> stubbed. Nothing else in the table changed.

Grounded against `sim/snapshot.js` at HEAD `bce3a74`. **LIVE** = already in the snapshot;
**SLICE** = needs a small additive engine field (§4); **DERIVE** = presentation arithmetic on
live fields; **DEFERRED** = waits on an unbuilt mechanic. **BUILT** = the engine field this
row needed now ships (the A/B/C slice, 02-09-26).

| Data point | Source | Status |
|---|---|---|
| Guild name | `guilds[].name` | LIVE |
| Location | `guilds[].homeSystemId` → the shell's `__systemName` | LIVE *(corrected — see note)* |
| Founded cycle | *(not exposed)* | DROPPED (not exposed; no engine field added) |
| Cycle / day / tick | calendar | LIVE |
| Predicted modifier (gauge) | `guilds[].issuanceModifier` (recomputed on read = live) | LIVE |
| Current modifier (gauge) | `guilds[].fuelGrant.modifier` — modifier stamped on the grant | BUILT (B) |
| Fuel Δ ratio (gauge) | `guilds[].predictedGrant ÷ (fuelGrant.entitlement ?? foundingEntitlement)` | BUILT (D, derived) |
| Fuel Δ founding baseline | `guilds[].foundingEntitlement` — `grantFor` at founding | BUILT (D′) |
| 10-cycle performance line | `guilds[].modifierHistory` — rolling per-guild modifier history | BUILT (C) |
| RP total | `guilds[].guildReputation` | LIVE |
| RP — Ventures | `guildReputation − foundingEndowment` | DERIVE |
| RP — System holdings | `guilds[].foundingEndowment` | LIVE |
| RP — Deuterium / Transport / Council | 0 | DEFERRED |
| Fuel price | `galacticSupply.fuel.fuelPrice` | LIVE |
| Legal remaining (credits) | `guilds[].fuelHoardValue` | LIVE |
| Illegal remaining (credits) | `guilds[].deuteriumFuelValue` | LIVE *(illegal refining now exists — slice 1b)* |
| Illegal start-of-cycle max (credits) | `guilds[].deuteriumFuelAtCycleStartValue` (boundary contraband × price) | BUILT (fuel-burn-history slice, §4) |
| Start-of-cycle max (credits) | `guilds[].fuelHoardAtCycleStartValue` (boundary hoard × price) | BUILT (A) |
| Used this cycle (credits) | (`fuelHoardAtCycleStart` − `fuelHoard`) × price | BUILT (A, derived) |

## 4. Engine wiring — the slices

The fuel loop itself — grant, price, hoard, burn-on-route, deplete — is **already built** (see
`fuel-supply-and-allocation.md`), so once the panel reads these fields the bar depletes live as
the guild trades. Three small **additive** snapshot fields are needed; all follow the pattern
every field in `snapshot.js` already documents (additive, no schema bump, DERIVED where there is
no stored counterpart, tripwire-tested).

**✅ BUILT 02-09-26 (slices A + B + C, engine + snapshot only — the client panel is the next prompt).**
All three are stamped in `sim/tick.js`'s step 6 (`stepBaselineAllocation`) at the cycle boundary,
under the **same `desired > 0` sparsity** the grant record already uses — so a holdings-less
galaxy carries none of them and stays byte-identical. The determinism goldens moved for the
committed 40-tick run alone (it crosses ten boundaries) and are proven the ONLY delta by an added
strip (`commitment-scaffold.test.js`); the fuel loop's own numbers are unchanged.

- **Slice A — `fuelHoardAtCycleStart`. ✅ BUILT.** Step 6 stamps `g.fuelHoardAtCycleStart =
  g.fuelHoard` after the grant is applied (post-grant, before this cycle's usage). Exposed in the
  snapshot as `fuelHoardAtCycleStart` and its marked value `fuelHoardAtCycleStartValue =
  fuelValue(…, reserve.fuelPrice)` (parallel to `fuelHoardValue`; null before the first boundary — closed for a freshly-founded guild by Slice A′ below).
  Gives the stockpile bar its **max** and the **used-this-cycle** gap.
- **Slice B — the grant modifier. ✅ BUILT.** `recordFuelGrant` now takes and stores the
  `issuanceModifier(state, g)` read at the boundary — the record is `{tick, granted, desired,
  modifier}` — exposed as `fuelGrant.modifier`. Gives the **Current** gauge; the live
  `issuanceModifier` already in the snapshot is the **Predicted**.
- **Slice C — modifier history. ✅ BUILT.** A new engine-owned module `sim/modifier-history.js`
  keeps a rolling per-guild ring (`guild.modifierHistory`), one sample per cycle at the boundary,
  same serialized/sparse/deterministic discipline as `sim/history.js` / `sim/price-history.js` but
  simpler — ONE small ring, no coarsening. The ring length is a `[FIRST-CUT]` display constant
  `MODIFIER_HISTORY_N = 12` (≥ the 10 the panel draws, with a two-cycle headroom; recorded in the
  module and `docs/phase-1-tuning.md`). Exposed as `modifierHistory` (always emitted, `[]` when
  empty). Gives the **performance line**.
- **Slice D — the expected-fuel-change gauge (`predictedGrant` + `fuelGrant.entitlement`).
  ✅ BUILT 06-09-26.** The Standing panel's THIRD gauge (§2.1 Fuel Δ), added beside
  Current/Predicted. Two small **additive** snapshot fields, one derived and one serialized:
  - **`predictedGrant`** — the guild's LIVE fuel-credit entitlement, `grantFor(state, g)` =
    `round(BASE_GRANT_PER_GP × GP × modifier)` (credits, at the reference price). DERIVED like
    `guildPoints`/`issuanceModifier` (no stored counterpart, no serialized byte, no determinism
    impact). The gauge's **numerator**.
  - **`fuelGrant.entitlement`** — THIS cycle's entitlement, `grantFor` captured at the boundary
    in `recordFuelGrant` beside the modifier that sized it (the same value `physicalGrantFor`
    scaled by the price). SERIALIZED, so it appears only after a guild's first boundary (null
    before), under the same `desired > 0` sparsity the record already uses. The **denominator**.

  The client divides them (`predictedGrant ÷ fuelGrant.entitlement`) for the change ratio — a
  ratio of two published fields, the one presentation derive this slice adds, the same sanctioned
  move as the RP donut's subtraction. The client reads no constant and holds no engine number.
  Because `entitlement` is serialized, the determinism goldens moved for a run that crosses a
  boundary alone (the committed 40-tick run); proven the ONLY delta by an added strip that
  recovers the pre-slice golden byte-for-byte. `predictedGrant` moves no golden (snapshot-only).
- **Slice D′ — the founding baseline (`foundingEntitlement`). ✅ BUILT 06-09-26.** Slice D's
  denominator (`fuelGrant.entitlement`) is only recorded at a cycle boundary, so the gauge read
  `—` from creation until a guild's first boundary. This closes that gap: the `foundGuild` apply
  (`sim/actions.js`) now stamps `guild.foundingEntitlement = grantFor(next, guild)` — the credit
  entitlement at the instant of founding — beside the `foundingEndowment` stamp it mirrors. It is
  serialized **omitted-when-absent** (`sim/state.js`, like `foundingEndowment`) and published on
  the guild row (`sim/snapshot.js`). The client (`standingPanel`) falls the Fuel Δ denominator
  back to it: `fuelGrant.entitlement ?? foundingEntitlement`. So the gauge opens at ×1.00 at
  founding (numerator and baseline are one GP/modifier), swings live as the guild grows this
  cycle, and rebases to `fuelGrant.entitlement` from the first boundary onward — today's
  behaviour, with no `—` gap at the start. **No new presentation derive** — the same division,
  only its denominator source widened. **Additive, no backfill**: an old guild founded without the
  field simply keeps today's behaviour (`null` baseline ⇒ `—` until its next boundary). Goldens:
  only a scenario that FOUNDS a guild gains the field (a `createState` galaxy never founds), and a
  `withoutFoundingEntitlement` strip recovers the prior golden byte-for-byte.
- **RP-by-source** needs no engine change: Ventures = `guildReputation − foundingEndowment`,
  System holdings = `foundingEndowment` (a presentation subtraction, like the recorder's `gap`).
- **The client panel — ✅ BUILT 02-09-26 (client-only, no engine/snapshot/`sim/` change).**
  The `guild` tab in `client/game.html` now renders the real Standing panel, following the
  TRADE tab's pattern exactly: a scoped, `gh-`-prefixed `#tp-guild` overlay with the mockup's
  palette (`--gh-*`) and the CouncilChamber art by path; `openTab('guild')` shows it and calls
  `window.__guildOpen()`; a render reads the player's guild row on open and on every poll while
  open (wired into `applySnapshot` beside the TRADE refresh). The Standing sub-page ports the
  mockup's four SVG helpers (`ghPerf`, `ghVgauge`, `ghDonut`, `ghStockBar`) and feeds them the
  snapshot — the Performance line from `modifierHistory` (last 10, "gathering" until ≥2), the
  Current gauge from `fuelGrant.modifier` and Predicted from the live `issuanceModifier`, the RP
  donut from the `guildReputation − foundingEndowment` split, and the stockpile bar from the
  published credit values (`fuelHoardAtCycleStartValue` max, `fuelHoardValue` legal remaining,
  illegal = 0). Finance / Ventures / Council / Forum are honest "soon" placeholders — no invented
  figures. **The gauge/line axis** is the one mirrored constant: it claims to be the engine's
  issuance-modifier clamp, so per §18 the client copy `GH_FLOOR = 0.3` / `GH_CEIL = 1.5` MIRRORS
  `sim/meanline.js`'s `ISSUANCE_FLOOR` / `ISSUANCE_CEIL` with a served-page tripwire in
  `sim/tests/server.test.js` (**+1 test → 906, zero failures**). Every other figure is read
  verbatim or is the one sanctioned RP subtraction; the client computes no other engine number.

- **Slice A′ — stamp `fuelHoardAtCycleStart` at FOUNDING. ✅ BUILT 03-09-26.** Slice A stamped the
  reference only at a cycle boundary, so a guild founded mid-cycle carried
  `fuelHoardAtCycleStart = null` until its first boundary and the bar could not size itself: 500u of
  real fuel showed as an EMPTY bar (caught in playtest, 03-09-26). Fixed by defaulting the reference
  to the starting hoard in `createGuild` (the single constructor — so every creation path, founded
  now or any future bot path, is covered) when a caller supplies none; the bar is now **full from
  birth** (§2.3) and drains as the guild spends, and tick.js's boundary re-stamp keeps handling
  every subsequent cycle unchanged. It is **engine-only** — the client already reads
  `fuelHoardAtCycleStartValue` as the max, so no client change — and **additive**, but it adds
  stored state at creation, so the determinism goldens moved: regenerated by strip-and-prove, the
  delta proven confined to `fuelHoardAtCycleStart` appearing at creation. Acceptance MET: a
  freshly-founded guild's stockpile bar reads **full at its starting fuel**, before any boundary.

Slices A and B both stamp a value at the same tick boundary and rode one prompt with C; the client
panel is the last, and now landed. The minimal end-to-end path is **A + the client panel** (the
stockpile bar working as you trade), with B and C the enrichments — all four now on screen.

### 4.1 The fuel-burn-history slice — per-guild burn history + the contraband start-of-cycle datum *(07-09-26 — engine + snapshot only)*

The **DEUTERIUM tab** (`fuel-supply-and-allocation.md` §1.4, slice 2b) will show two fuel visuals:
a **donut** of the guild's held fuel depleting over the cycle (mirroring §2.3's stockpile bar, with
a `[red illegal][blue legal]` fill), and a **10-cycle "fuel-burn habits" graph** superimposing each
cycle's total burn against the legal fuel it was granted. Both need data the engine did not store.
This slice adds **only that data layer** — three new per-guild fields, stamped in the tick, published
in the snapshot, guarded by invariants and tests. **Observation only:** no existing fuel behaviour
(burn, grant, price) changes — we only observe them — and **invariant 1 is untouched** (the burn
accumulator is a statistic, not held fuel).

Three fields, all **integer fuel QUANTITIES — deliberately NOT credits**, so the burn/allotment
series stays comparable across price moves (the snapshot marks the start-of-cycle data to credits
for the donut, exactly as §2.3 does, but the stored series is quantities):

- **`fuelBurnedThisCycle`** — the running per-cycle burn TOTAL (legal + contraband together),
  accumulated in `burnFuel` (`sim/fuel.js`, the one choke point every route burn passes through)
  and **reset at each cycle boundary** once the closing cycle's history entry is recorded. A
  **counter, never held fuel:** it is NOT summed by invariant 1's conservation nor by
  `computeGalacticSupply`'s `guildHeld`. Omit-when-0.
- **`deuteriumFuelAtCycleStart`** — the **contraband held at the START of the cycle** — the donut's
  **RED baseline**, exactly as `fuelHoardAtCycleStart` (Slice A) is the blue one. Stamped at each
  boundary to `g.deuteriumFuel`; the contraband store is **not granted**, so its start-of-cycle
  value is simply whatever is held at the boundary (no `+= grant` the way the legal hoard takes one).
  Published marked to `reserve.fuelPrice` as `deuteriumFuelAtCycleStartValue`, parallel to
  `fuelHoardAtCycleStartValue`. Omit-when-0 (a guild with no contraband has no red baseline — the
  donut reads `null`, not a real 0), UNLIKE the blue datum which always carries a value so the bar
  is full from birth. *(This is the datum §2.3's audit rows deferred as "Illegal (credits) | 0 |
  DEFERRED" when illegal refining did not yet exist — now BUILT.)*
- **`fuelBurnHistory`** — a rolling **last-10-cycle** ring of `{ burn, granted, contrabandBurned }`,
  oldest → newest (position is the cycle; no tick field, matching `modifierHistory`). One entry per
  boundary for the closing cycle. `granted` is the **legal fuel actually received (post-rationing)**
  that FUNDED that cycle — the PREVIOUS boundary's grant. `contrabandBurned` is the red half of the
  burn (`max(0, burn − legalBurned)`; legal-first `burnFuel` only touches the red once legal is dry).
  Depth `FUEL_BURN_HISTORY_N = 10` is a display constant (`docs/phase-1-tuning.md`), matching the
  Standing panel's 10-cycle line. Omit-when-empty.

**⚠ THE BOUNDARY ORDER IS LOAD-BEARING** (`sim/tick.js` step 6). The closing cycle's entry is
computed **BEFORE** the new grant is applied and before `fuelHoardAtCycleStart` is overwritten,
because it reads both: `legalBurned = (OLD fuelHoardAtCycleStart − current, pre-new-grant
fuelHoard)` — nothing but the boundary grant ever adds legal fuel, so the drop from the cycle's
start to now is exactly the legal burn — and `granted` from the still-unoverwritten `lastFuelGrant`.
Recording after the grant would measure burn against a hoard that had already taken next cycle's
fuel, and read the wrong grant.

**Sparsity holds the byte-identity:** an entry is pushed only when the guild BURNED this cycle
(`fuelBurnedThisCycle > 0`) OR was DUE a grant (`desired > 0`); a completely inert guild carries none
of these keys. The determinism goldens moved for the committed run alone (it crosses ten boundaries
and is due a grant at each, so it gains the `fuelBurnHistory` ring), proven the ONLY delta by an
added strip in `commitment-scaffold.test.js`; no fuel number moved.

**Consumed by (later slices):** the DEUTERIUM tab / donut / graph themselves — **now BUILT (client
slice 2b, 07-09-26; `docs/mockups/deuterium-tab.html`):** the donut reads the two `*AtCycleStartValue`
baselines + the two live values, and the burn-habits graph reads `fuelBurnHistory`. Still OUT of scope:
lighting up §2.3's Guild-Hall bar red segment beyond what slice 1b already did; §7 detection / fines
(`contrabandBurned` is a recorded statistic, nothing punishes it yet — the tab's suspicion gauge is an
inert concept placeholder).

### 4.2 The DEUTERIUM tab's engine data — the fuel-price history + the production aggregate *(07-09-26 — engine + snapshot only)*

The **DEUTERIUM tab** (`fuel-supply-and-allocation.md` §1.4, slice 2b) is a guild-wide monitoring
dashboard; most of what it draws is already LIVE (the stockpile values, the two cycle-start baselines,
the fuel-burn graph of §4.1, the refinery list off `ventures[]`). This slice adds the **two remaining
data feeds** it needs, then stops — engine + snapshot only, **no client work**. **Observation only:** no
existing fuel behaviour (burn, grant, price) changes; the fuel price is read, never moved.

**1. A galaxy-wide fuel-price history — a 3-day trend of 6-hour averages — for the tab's price graph.**
A new top-level field `state.fuelPriceHistory` (a sibling of `state.priceHistory`, in a new module
`sim/fuel-price-history.js`), because the fuel price is **galaxy-wide** — one value for the whole galaxy
(§15.5 invariant 5), not a guild's — so its history lives ONCE, top-level, never hung off a guild:

```
state.fuelPriceHistory: { ring: [ <avg>, … ], acc: { sum, count, bucket } }
```

- **`ring`** — the last **12** COMPLETED 6-hour averages, oldest → newest (12 points = 3 days).
- **`acc`** — the 6-hour bucket in progress: `{ sum, count }` of this bucket's fuel prices, plus
  `bucket`, the quarter-day index it is accumulating.

Unlike `price-history`'s **point-sampled close**, a point here is the **true 6-hour average** of the fuel
price across the bucket's ticks — the tab wants a smoothed trend, so this pays the accumulator
`price-history` deliberately avoided. Averages are **floats** (an average of the float fuel price), stored
as such — the sanctioned non-integer (§15.2), tolerated by `checkFuelPriceHistory` exactly as the modifier
ring's floats are. `FUEL_PRICE_HISTORY_N = 12` and `FUEL_PRICE_BUCKET_DIVISOR = 4` are DISPLAY-DEPTH
constants (`docs/phase-1-tuning.md`); the bucket LENGTH is DERIVED — `windowN / 4` (= 360 on the standard
1,440-tick day) — never hardcoded, so a non-standard day still buckets to quarter-days.

**The mechanic (`sim/tick.js`, once per tick, after the eight steps).** The fuel price is sampled EVERY
tick with the tick's FINAL price. It sits after the step loop, NOT inside step 6 where the controller
posts the price, for one load-bearing reason: step 6 (`stepBaselineAllocation`) early-returns on every
non-boundary tick, so a sample taken inside it would fire only at boundaries. If the tick opens a new
6-hour bucket (the quarter-day index rolled) and the accumulator has samples, its true average
(`sum / count`) is pushed onto the ring (oldest dropped past 12) and the accumulator resets; then this
tick's price is added. **Buckets align to the calendar day** exactly as `isWindowBoundary` aligns cycle
boundaries (`bucketIndexOf` is built from `sim/calendar.js`'s `dayOf`/`minuteOf`, the same `(tick-1)`
phase and anchor), so a day boundary is always a bucket boundary — no galaxy-tick-1 drift. A fresh galaxy
has an empty ring and its first point lands 6 game-hours in; "not yet" is empty, not a failure.

**Snapshot.** Published top-level as `fuelPriceHistory` — the ring of ≤12 closed averages, a plain array
the client draws with no reshaping, ALWAYS emitted (a stable `[]` before the first bucket closes). The
partial accumulator is **not** published: the live "now" tip is already `galacticSupply.fuel.fuelPrice`,
so the client tips the line with the live price.

**2. A per-guild deuterium production aggregate — for the tab's Production readout.** A snapshot derive on
each guild row, in fuel-quantity UNITS per cycle (not credits):

```
deuteriumProduction: { legalPerCycle, contrabandPerCycle }
```

- **`legalPerCycle`** = Σ (`productionRate` of the guild's LICENSED deuterium mines — `resourceType ===
  'deuterium'` and a `deuteriumLicence`, i.e. `isLicensedDeuteriumMine`) × `windowN`.
- **`contrabandPerCycle`** = Σ (`productionRate` of the guild's ILLEGAL refineries — the `deuteriumRefinery`
  marker, i.e. `isIllegalDeuteriumRefinery`) × `windowN`.

A pure DERIVED read in `buildSnapshot` — no stored state, nothing in the determinism hash — the engine
deciding the number so the client renders rather than computes it (§5). Deliberately a **projection, not
exact**: rate × cycle length, ignoring that a refinery is raw-limited in reality (as designed — it shows
committed capacity per cycle, not realised throughput). `windowN` (the galaxy's real cycle), never a
hardcoded 1,440, so it tracks a non-standard cycle.

**Determinism.** Unlike the sparse §4.1 rings, `fuelPriceHistory` accumulates in **every ticking galaxy**
(every galaxy has a fuel price), so **every determinism golden that ticks moved** — re-pinned in
`persist.test.js` and `commitment-scaffold.test.js` with a `withoutFuelPriceHistory` strip that recovers
each pre-slice golden byte-for-byte (the field proven the ONLY delta). The production aggregate is a
snapshot derive and moves **no golden**. New tripwire `checkFuelPriceHistory` (`sim/invariants.js`): the
ring is an array capped at 12 with finite non-negative float samples; the accumulator's `sum`/`count` are
finite and non-negative and `bucket` a finite integer coordinate.

**No new game number:** the two depths are display constants, and the production aggregate is rate × cycle,
both existing quantities.

**Consumed by:** all client work (the tab, donut, graphs, refinery tree) — **now BUILT (client slice 2b,
07-09-26; `docs/mockups/deuterium-tab.html`):** the tab's price graph draws this `fuelPriceHistory`
(tipped with the live `galacticSupply.fuel.fuelPrice`), and the Production readout draws
`deuteriumProduction`. Still OUT of scope: the suspicion gauge's maths / §7 detection (the gauge ships as
an inert concept placeholder); the raw-deuterium price (the tab's price graph is the FUEL price — this
history; the raw-deuterium price keeps its own `priceHistory`, untouched).

## 5. Deferred (with their mechanics, not here)

- **The legal/illegal hoard split** — the whole illegal-refining system. Until it exists,
  `fuelHoard` is entirely legal; the bar shows legal = hoard, illegal = 0, and the red bar and
  its suspicion marker are dormant. When it lands, illegal production is the only
  thing that raises the hoard mid-cycle, and per §2.3 the bar's max **rises to match the live
  `fuelHoard`** when it climbs above the start-of-period level (the one case the max moves mid-cycle);
  the red/blue rescale and the suspicion marker are designed with it, not before.
- **Deuterium / Transport contracts / Council & politics RP sources** — each waits on its own
  mechanic (licensed deuterium mining, transport contracts, the political layer).
- **The other Guild Hall tabs** — Finance, Ventures, Council, Forum.
