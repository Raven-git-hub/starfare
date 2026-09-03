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
Syndicate's line (modifier > 1.0) and red where **below**. Beside it, two **vertical gauges**
centred on the expected line (×1.00 always at centre): **Current** (the modifier that set this
cycle's grant) and **Predicted** (where the guild sits *now* — what next boundary would grant
if the cycle ended this instant). Each gauge fills from the centre to the marker — **green up,
red down** — so a Predicted marker in the red is a plain warning that this cycle's actions are
dropping the guild below its line.

**Deliberately NOT shown: raw GP, RP, expected, or the gap.** Those are backend numbers the
player doesn't reason in. The modifier gauge and the line carry the whole story graphically.

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
| 10-cycle performance line | `guilds[].modifierHistory` — rolling per-guild modifier history | BUILT (C) |
| RP total | `guilds[].guildReputation` | LIVE |
| RP — Ventures | `guildReputation − foundingEndowment` | DERIVE |
| RP — System holdings | `guilds[].foundingEndowment` | LIVE |
| RP — Deuterium / Transport / Council | 0 | DEFERRED |
| Fuel price | `galacticSupply.fuel.fuelPrice` | LIVE |
| Legal remaining (credits) | `guilds[].fuelHoardValue` | LIVE |
| Illegal (credits) | 0 | DEFERRED |
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
