# Starfare — Production Console, Client Integration & Venture Art

Session design record, 21-08-26. Companion to `docs/console-field-map.md` (the field
contract) and `docs/client-console-design.md` (the earlier composition rationale). This
document supersedes the composition details in those where they differ, and adds two things
the earlier docs did not have: a full **data-point catalogue** for the panel, and a ruling on
**how venture artwork is referenced**.

Nothing here is committed yet — it is the design record to reconcile into the repo at bank time.

---

## 1. What the console is now (architecture)

The production console was restructured this session to reclaim width and to put the venture
hero where it belongs. Four decisions, in order:

**1.1 The console is three working columns.** Production │ Distribution │ Consumption. The
venture hero is **not** a fourth column — that was the mistake that made everything cramped.
Producers and Consumers are compact clickable *chips* (a planet-archetype-coloured dot + the
venture id, plus a light rate figure); the meaningless tags ("terran homeworld", "mine · 5/tick")
are gone. Each column's trend sparkline sits **on top of its own chip stack** rather than in a
separate column. The two top-up indicators (Consumption, Syndicate) moved out of the flow and
into the **stockpile row** as two permanent squares beside the stockpile strip.

**1.2 The width rule — one controlling number.** Distribution is the anchor width `C`; the two
working flanks are each a fixed fraction of it. Expressed in `fr` so it *fills* its column with
no side gaps (fixed px centred the block and left gaps — that was wrong). The ratio landed at
**7 : 15 : 10** (Production ≈ ½C, Distribution = C, Consumption ≈ ⅝C — Consumption rides ~25%
wider because it carries the licence panel). These are now a real four-number decision, not a
"halves" rule — record them so nobody "tidies" them back to halves and re-cramps the licence tab.

**1.3 The heroes live OUTSIDE the console, in reserved side zones.** The system manifest frames
the console with a permanent **celestial** zone (left) and **industrial/venture** zone (right).
The console fills the central column edge-to-edge, flush with the resource selector above it. A
venture click fills the right zone **in place** — the console never reflows or shrinks. Both
hero tops align with each other; the celestial art anchors bottom-**left**, the industrial art
bottom-**right** (mirrored).

**1.4 In the real client, the client owns both heroes.** The detail screen's left index *is* the
celestial zone; a client-side `.ind-hero` aside *is* the industrial zone. So the console, when
embedded, is **console-only** (no heroes of its own) and simply **posts the selected venture up
to the client**, which swaps the hero. This keeps the venture→hero interaction live while letting
the heroes be full-height client panels that mirror each other.

### The client integration (how it's wired)
- The console is embedded as a **sandboxed iframe** (a base64 blob) inside the manifest's `.main`.
  In embed mode it hides its own dev chrome (header/status) and drops both hero zones.
- On venture click (and once on load for the default selection) the console does
  `postMessage({ source:'starfare-console', kind:'venture', name, role, facility })` to the parent.
- The client listens, sets the hero's name, and swaps the facility art by `facility` (mine vs
  refinery today; biome-aware next — see §3).
- The industrial hero is minimal by request: **venture name + "Open venture management ▸" button**,
  content dropped ~20% down the panel so it clears the detail screen's "Back to map" button.

> Build-pipeline debt (flagged, not fixed): the client is still assembled by a chain of manual
> steps (`assemble.py` → shell → inject assets → inject console blob → patch hero wiring). One
> edit corrupted the built file mid-session and had to be rebuilt from clean pieces. **Before this
> goes to Claude Code, the whole pipeline must become one reproducible script** that reads the repo
> `client/assets/` rather than re-embedding by hand.

---

## 2. The panel's data points (input to the live-state design)

Every data point the console + hero consume, by bucket. This is the shopping list the live-state
file has to satisfy. Buckets:

- **STORED** — a value the player sets; lives in the guild's production profile; set by an action;
  in the determinism hash.
- **DERIVED** — recomputed each tick into the snapshot; never stored; the client renders it verbatim.
- **IDENTITY** — stable facts from the seed/state (who/what/where); not tick-advanced.
- **PRESENTATION** — computed by the client for display only; not in state at all.
- **FUTURE** — no engine surface yet (the licence layer).

### 2.1 Per-good, per-system (the body of the console)
| Data point | Bucket | Field / source |
|---|---|---|
| Fork draw order (Syndicate/Production/Stockpile rank) | STORED | `profile.goods[good].order` (setProductionProfile) |
| Downstream provision cap | STORED | `profile.goods[good].downstreamPct` |
| Reserve level (stockpile floor) | STORED | `profile.goods[good].reserveLevel` |
| Syndicate send (mode + value, or paced) | STORED | `profile.goods[good].syndicate {mode,value}` (null = paced) |
| Per-venture throttle | STORED | `profile.throttles[ventureId]` |
| Fresh output this tick | DERIVED | `goods[good].fresh` |
| Full-tilt demand (Gate-2 max) | DERIVED | `goods[good].demand` |
| Supplied (consumer draw cap) | DERIVED | `goods[good].supplied` |
| On-hand stockpile at tick start | DERIVED | `goods[good].reserve0` |
| Reserve change this tick | DERIVED | `goods[good].reserveDelta` (drives trend chevrons + top-up) |
| Fork takes (routed amounts) | DERIVED | `goods[good].fork.{syndicate,downstream,stockpile}` |
| Commitment window | DERIVED | `goods[good].window {Q, delivered, ticksRemaining, requiredRate, sendThisTick, pctAchieved, status}` |
| Producers (mines) identity + output share | DERIVED/IDENTITY | `mines[]` / a mine's share of `fresh` |
| Consumers (lines) identity | IDENTITY | `lines[]` (ventureId, good) |
| Refinery telemetry | DERIVED | `refineries[]` (rate, minted, bottleneckGood) |

### 2.2 The venture hero (right zone)
| Data point | Bucket | Field / source |
|---|---|---|
| Venture name | IDENTITY | `ventureId` |
| Planet | IDENTITY | `ventureId → planetId → planet.name` |
| **Planet archetype** | IDENTITY | `planet.archetype` (terran/molten/…) — **needed for art; see §3** |
| Kind (mine / refinery) | IDENTITY | derived from `venture.recipeId` (present ⇒ refinery) |
| Recipe (in → out) | IDENTITY | `good` → `recipeOut[recipeId]` |
| Output (mine) / eff. rate + makes (refinery) | DERIVED | `mine.amount` / `refineries[].rate` + `.minted` |
| Bottleneck ("held by") | DERIVED | `refineries[].bottleneckGood` |
| Throttle control | STORED | `profile.throttles[ventureId]` |
| Facility art | PRESENTATION | derived from (archetype, kind, biome) — **§3** |
| Droid complement, condition | FUTURE | venture-management slice (mocked today) |

### 2.3 Selector, stockpile strip, trends
| Data point | Bucket | Field / source |
|---|---|---|
| Tier vocabulary (raw/processed) + which goods are active | IDENTITY | static goods config + `recipeOut` |
| On-hand stockpile value | DERIVED | guild stockpile for (system, good) |
| Trend sparklines (production/consumption over time) | PRESENTATION | client rolling buffer of past `fresh` / `fork.downstream` — the *values* are derived, the *series* is client view-memory |
| Archetype dot colour on chips | PRESENTATION | `planet.archetype → colour` (client table) |

### 2.4 The Syndicate-management tab — ENTIRELY FUTURE
Licence roster, pursue flags, thermometer, fee presets, min/projected fee, top-up enable+limit.
None exists in the engine (the deferred licence layer). The **breach-fee formula is still a NEEDED
ruling** — the console shows a projected fee with nothing behind it. Keep on mock data until the
licence slice is built.

> Two cleanups still standing from the field-map: `reserveLevel` is shown twice (stockpile strip
> AND the Stockpile fork) — pick one canonical home; and "provided" must **read `supplied`**, not
> recompute `demand × downstreamPct` in the browser.

---

## 3. Venture artwork — how it's referenced (ruling)

**Principle: art is presentation, so it is DERIVED, never a stored path.** A facility image moves
no game number; storing a filename in a venture would be brittle (rename art ⇒ break saves) and
would push cosmetic data into the determinism hash. The state supplies stable *descriptors*; the
client turns them into an image.

### 3.1 The three descriptors
1. **Planet archetype** — terran, molten, desert, ice, oceanic, rocky, gasGiant, irradiated,
   crystalline. (From the venture's planet.)
2. **Kind** — mine vs refinery. (Refineries are archetype-only; resource/biome does not apply.)
3. **Biome** — *only for multi-biome archetypes* (terran). Mono-biome archetypes ignore it — they
   "get what they're given."

### 3.2 Biome selection for a mine
- **Multi-biome archetype (terran):** biome = `biomeForResource[resource]`. A static presentation
  table (titanium→Mountain, carbon_products→Forrest, …). Because a planet mines several resources,
  its ventures spread across several biomes — the "random-looking" variety you wanted, but
  deterministic and stable (same mine, same biome, every reload).
- **Mono-biome archetype:** biome is fixed by the archetype; the resource does not change the look.

### 3.3 Derive-by-default, override-if-present
- The venture MAY optionally carry a cosmetic `biome` (or `artKey`) tag, set at **seed-generation**.
  If present the client uses it verbatim; if absent, it derives per §3.2. This is the escape hatch
  for true seed-time randomisation or hand-tuning one venture, without making the field mandatory.
- If adopted, `biome` is **cosmetic, stable, NOT tick-advanced, NOT in the determinism hash.**

### 3.4 Derive a KEY, then look up the FILE (don't assemble filenames blindly)
The repo's `client/assets/industrial/` naming is **inconsistent** — some PascalCase
(`TerranMountain`, `OceanicMine`, `MoltenManufacture`), some lowercase (`moltenmine`,
`desertfactory`, `crystalfactory`, `icemine`). So pure filename convention is fragile. Instead:

- The client derives a **descriptor key**: e.g. `terran/mine/mountain`, `molten/mine`,
  `terran/refinery`, `gasGiant/refinery`.
- A small client-side **art manifest** maps key → actual filename (and encodes which archetypes are
  multi-biome). Changing or adding art = edit the manifest; **state never changes.**
- **Fallback chain** so a missing image never shows broken:
  `{archetype}/{kind}/{biome}` → `{archetype}/{kind}` (archetype default, e.g. `TerranRig`) →
  a universal default.

This also gives us a natural moment to **normalise the art filenames** to one convention as a
cleanup (recommended), after which the manifest becomes a thin, obvious table.

### 3.5 Starter resource → terran-biome table (TUNABLE — Andy's creative call)
Terran biomes available: Mountain, Forrest, Coast, Continental, Riverbed. A first pass, to be
tuned freely (this is presentation flavour, not mechanics):

| Biome | Resources (proposed) | Rationale |
|---|---|---|
| Mountain | titanium, tungsten, lead, neodymium | hard-rock ore veins |
| Forrest | carbon_products, polymers, ammonia, nitrogen | organic / atmospheric |
| Coast | lithium, silica, xenon, helium | brines, evaporites, light gases |
| Riverbed | gold, silver, copper, palladium | alluvial / placer metals |
| Continental | deuterium (+ overflow) | deep, heavy, stable crust |

Refineries on terran → `TerranManufacture` regardless of recipe. Mono-biome archetypes → their
single mine/factory art.

### 3.6 What the seed/live-state must carry (the takeaway)
- **Required, already present:** planet `archetype`; venture `kind` (mine vs refinery, via recipe);
  venture `resource`/recipe. These are enough for the client to derive every image.
- **New, optional:** a cosmetic `biome`/`artKey` override on a venture (seed-time only).
- **Not state at all:** the `biomeForResource` table and the art manifest — presentation config in
  the design doc + client. Re-skin the whole game by editing them; no save is touched.
- **Message plumbing:** the console→client venture message must carry (or let the client look up)
  **kind + resource + archetype** so the client can pick biome-aware art. Today it carries
  `facility` (mine/refinery) only; extend to include `resource` and `archetype` (or post the
  derived key).

---

## 4. Carry-forward (open rulings & next)
- **Breach-fee formula** — still NEEDED before the licence layer is real.
- **price-history** — the one genuinely new STORED structure; pin at market-slice time.
- **System/planet rename** — stored `nameOverride`, controller-set; deferred.
- **Field-map cleanups** — `reserveLevel` shown twice; "provided" must read `supplied`.
- **Build pipeline** — make the client build one reproducible script reading `client/assets/`.
- **Art filename normalisation** — optional cleanup that simplifies the art manifest.
- **The 7:15:10 column ratio** — record as a deliberate decision, not a "halves" rule.
