# Starfare — full-client data-point catalogue (all surfaces)

Extends `console-client-and-art.md §2` (which covers the production console in depth) to the
**whole client** as built so far: the HUD, the galaxy map, the system/planet/waystation detail
screens, the two heroes, and the not-yet-built tabs. Purpose: the panel-first spine — enumerate
everything the full client demands so the live-state model + seed can be grown to supply it.

**Buckets:** STORED (player-set, in the determinism hash) · DERIVED (recomputed each tick into the
snapshot, never persisted) · IDENTITY (stable seed/state facts) · PRESENTATION (client-only, no
state) · FUTURE (no engine surface yet).
**Sources** are the verified engine (`sim/state.js`, `sim/profile.js`), the seed/galaxy generator
(`tools/generate_seed.js`), or the client. **Note:** the current build MOCKS most of these (demo
galaxy + mock HUD); this is the list the *real* client needs, i.e. what go-live must wire.

---

## 1. Persistent HUD (top bar)
| Element | Bucket | Source |
|---|---|---|
| Guild name ("Vanguard") | IDENTITY | `guild.name` |
| Credits | STORED | `guild.credits` |
| ◎ My System (+ dropdown of the guild's systems) | IDENTITY | `guild.homeSystemId` / `homePlanetId`; the list = systems the guild holds a claim on (`state.claims` where `ownerGuildId == guild`) |
| Sector label ("FEN SECTOR") | IDENTITY | prefix of the current `system.name` (seed `SECTOR_PREFIXES`) |
| TICK number | DERIVED | `state.tick` |
| ♪ Music + volume | PRESENTATION | client only (`__TRACKS`, shuffle) |
| Server-time radial clock (60s) | PRESENTATION | client render of the tick cadence |

## 2. Top tabs (navigation)
System Manifest (built) · Syndicate Marketplace · Transport · Guild Hall (stubs). Pure client nav
state (PRESENTATION); each tab's *contents* are catalogued below / in §9.

## 3. Galaxy map (the seed_viewer engine)
| Element | Bucket | Source |
|---|---|---|
| Systems — position, hex coords, ring, name | IDENTITY | seed: `system {id, coords{q,r}, ring:'inner'|'middle'|'outer', name}` — deterministic from `world.seed` |
| System controller / ownership colouring | DERIVED-from-STATE | `state.claims` (SHARED) → owning guild per system |
| Waystations (Syndicate outposts) + the Citadel | IDENTITY | seed: `outposts[] {id,coords,name}`, `citadel {coords,radius}` |
| Zoom / rotate / selected system / fly-to | PRESENTATION | client nav state |

## 4. System detail — the celestial zone (left index)
| Element | Bucket | Source |
|---|---|---|
| System name ("FEN-6461") | IDENTITY | `system.name` (+ future `nameOverride`) |
| Controller ("VANGUARD") | DERIVED-from-STATE | `state.claims` for this system → `ownerGuildId` |
| "N surveyed bodies · RING · q# r#" | IDENTITY | `system.planets.length`, `system.ring`, `system.coords` |
| System dropdown (guild's systems) | IDENTITY | claims filtered by owner (as §1) |
| Planet list — name + archetype (e.g. "FEN-6461 II · Terran") | IDENTITY | seed: `planet {id, archetype}` |
| Resource-node **squares** per planet | IDENTITY + DERIVED | count/type = seed `planet.nodes[] {id, resourceType}`; filled/vacant = a venture sits on the node (`ventures[].siteId`) |
| Settlement-slot **triangles** per planet | IDENTITY + DERIVED | count = seed `planet.slots[] {id}`; occupied = a venture on the slot |
| Celestial hero art | PRESENTATION | archetype → `assets/planets/{archetype}.jpg` (+ system star) |

## 5. Planet detail (Resources / Settlements sub-tabs)
| Element | Bucket | Source |
|---|---|---|
| Resources tab — each node: id, resourceType, occupied-by | IDENTITY + DERIVED | seed `nodes[]`; occupancy from `ventures[].siteId` (one-venture-per-site, `sim/occupancy.js`) |
| Settlements tab — each slot: id, occupied / **VACANT** | IDENTITY + DERIVED | seed `slots[]`; occupancy from ventures |
| Mine/refinery on a node/slot → opens the venture | IDENTITY | the `venture` whose `siteId` matches |

## 6. Waystation detail
| Element | Bucket | Source |
|---|---|---|
| Waystation name, "Syndicate", coords | IDENTITY | seed `outpost {name, coords}` + its Syndicate `claim` |
| Trade row | FUTURE | opens the Marketplace (§9) |

## 7. The two heroes
- **Celestial hero** (left) — see §4 (system art + system facts).
- **Industrial hero** (right) — venture name + management button today; full data points (planet,
  kind, output/rate, recipe, throttle, and FUTURE droids/condition) are in `console-client-and-art.md
  §2.2`. Facility **art** is derived (archetype, kind, biome) per that doc §3 — the only new *optional*
  state field is a cosmetic venture `biome`.

## 8. Production console (System Manifest main panel)
Fully catalogued in **`console-client-and-art.md §2`** (stockpile strip, Producers/Distribution/
Consumers, trends, top-ups, the Syndicate window block, and the licence-layer FUTURE fields). Not
repeated here. The console's data spine, in one line: STORED = `productionProfile[systemId]`
(order/downstreamPct/reserveLevel/syndicate + throttles); DERIVED = the per-good snapshot block
(fresh/demand/supplied/fork/window) + `mines[]`/`refineries[]`.

## 9. Not-yet-built tabs — the data points they will demand (FUTURE, design-ahead)
| Tab | Data points | Likely source when built |
|---|---|---|
| **Syndicate Marketplace** | per-good current price; **price-history** (the one new STORED structure); the Syndicate's hidden true supply; buy/sell | current price DERIVED from `galacticSupply` (Σ stockpiles); price-history = NEW stored downsampled series (open ruling); orders/market = a new slice |
| **Transport** | vehicles (idle/loading/in-transit), routes on the hex map, cargo, fuel burn, ETA | `guild.vehicles[]` (STORED, exists) + `state.shipments[]` (IN-FLIGHT, empty until routes exist) — Phase 4 |
| **Guild Hall** | roster, credit ledger, licences, reputation, lifetime production | `guild.guildReputation`, `guild.lifetimeProduced` (exist); licences = the deferred licence layer; ledger = `syndicate.ledger` view |

---

## 10. Where it all comes from — the sources map
Five wells feed the entire client. Growing the game = filling these in, panel by panel:

1. **Seed / galaxy** (`tools/generate_seed.js`, keyed by `world.seed`) — all geometry & identity:
   systems (coords/ring/name), planets (archetype), resource nodes (resourceType), settlement slots,
   outposts, the Citadel. Deterministic, read-only, never written back.
2. **State — STORED** (`sim/state.js`) — guild economy (`credits`, `fuelHoard`), `productionProfile`,
   `ventures[]`, `vehicles[]`, `claims[]`, `reserve`, `syndicate.ledger`. What the player sets; the
   determinism hash's subject.
3. **Snapshot — DERIVED** (recomputed each tick) — all production telemetry the console renders, plus
   `galacticSupply`, system controller resolution, node/slot occupancy. Never persisted.
4. **Client — PRESENTATION** — nav (zoom/select/fly-to), hero & planet art, music, the trend
   sparkline buffers, archetype dot colours. No state.
5. **FUTURE surfaces** — the licence layer (breach fee, roster), price-history, the market, transport
   routing, guild-hall aggregates.

**The boundary to keep sacred:** the live-state file holds only (1)-partial + (2). Everything in (3)
is derived and thrown away each tick; everything in (4) never leaves the browser. When a new panel
needs a data point, decide FIRST which well it belongs in — most "new" data points turn out to be
DERIVED or PRESENTATION, and only rarely a genuinely new STORED field (price-history is the standout
example so far).
