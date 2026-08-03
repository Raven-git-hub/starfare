# Starfare — Roadmap

*Last updated 17-07-26. This is the authoritative, checklist-level roadmap. `docs/design.md` §17 carries only a summary; when the two disagree on **status**, this file wins, and on **design**, that one wins. Update the relevant checklist in the same commit as the work it records — a checked box with no commit behind it is exactly the failure mode the 16-07 reconciliation caught.*

**How phases work here:** each phase is a legitimate finish line, not a checkpoint. A phase isn't done until its **exit criteria** hold, and no phase starts until its **entry dependencies** do. "Phase" refers only to this roadmap — manufacturing levels are *tiers* (design.md §15.2).

---

## Status Dashboard

| Phase | Name | Status |
|---|---|---|
| 0 | Prove it's fun, learn to code | ✅ Done (residual experiments optional) |
| 1 | Playable economy sandbox (widened) | 🔶 In progress — Stage 1 ✅, checklist ✅ (19-07-26); Stage 2: harness + driver + zero-state ✅ (01-08-26), resource representation ✅ (02-08-26), state inspector ✅ (03-08-26), live world→seed + home-seating ✅ (03-08-26), establish-venture action + claims-in-snapshot ✅ (03-08-26), testbed server + container ✅ (03-08-26), testbed web UI ✅ (03-08-26), refining (titanium→alloy) ✅ (03-08-26), walking skeleton continuing |
| 2 | Persist and tick on a server | ⬜ Not started |
| G | Galaxy generation recovery (parallel track) | 🔶 In progress — generator complete (rings, ×4/×1/×0.25 gradient, repair, validation, settlement slots) + viewer renders `ring` (02-08-26); remaining items are decisions only |
| 3 | Multiplayer foundations | ⬜ Not started |
| 4 | Territory, routes, tolls, travel time (real map) | ⬜ Not started |
| 5 | The political layer | ⬜ Not started |
| 6 | Bots and the Storyteller | ⬜ Not started |
| 7 | Self-hosting, config, onboarding, polish | ⬜ Not started |

---

## Phase 0 — Prove it's fun, and learn to code ✅

**Goal:** know the economy is tense and fun before writing real code, and get far enough in JavaScript to read everything that gets written.

- [x] Walk a single shipment through its full lifecycle on paper
- [x] Build and hand-play the fuel market simulator (`analysis/fuel_market_simulator.xlsx`)
- [x] Run the deliberate squeeze — confirmed drama, confirmed the purchasing-power model, surfaced open question #31
- [x] Extract the simulator's exact formulas and semantics into the design doc as the port contract (design.md §8, done 16-07)
- [ ] *(Optional, any time)* Fight-the-squeeze experiment: replay from turn 4 using only existing levers, to test whether counter-play exists (#31)
- [ ] *(Ongoing)* JavaScript learning — note: `galaxy-map-hex.html`, the intended hands-on textbook, is among the lost artifacts; recover it or adopt `client/seed_viewer.html` as the replacement textbook

**Exit criteria:** met — the squeeze produced real tension and a real open balance question, which is exactly what Phase 0 existed to find out.

---

## Phase 1 — The economy as a playable sandbox 🔶

**Goal:** sit down, play a session as one guild against several bot guilds, and feel a real fuel squeeze happen — with territory, tolls, and ventures as levers you can actually use to cause or resist it.

**Scope was deliberately widened (16-07-26)** from the original one-guild spine. What that buys: an early, honest answer to whether the game's *shape* is fun. What it knowingly leaves unproven: persistence (Phase 2) and real player-vs-player trust (Phase 3+). The guard-rail: territory is an **abstract graph** behind a world-interface boundary — the hex galaxy, coordinates, gate-placement rules, and per-leg risk stay in Phase 4.

Working spec: `docs/prompts/phase-1-sandbox-prompt.md` plus the Stage 1 report (delivered in-session 16-07; key findings absorbed into design.md §8, §15.6, §16, §19).

### Stage 1 — Read and report ✅

- [x] Reconciliation of documents vs repo (found: stale doc copy in circulation; 15-07 generator work documented but lost; missing artifacts list)
- [x] Spreadsheet extracted cell-by-cell; transcription verified; port semantics identified (posted price, force-sell, floor-and-record, over-demand, fractional credits)
- [x] Plan: graph shape, file layout, tick-loop shape, world-interface boundary, bot tiers 1–2, contest design
- [x] Invention table delivered (~24 rows) with proposals

### Decision checklist — ✅ answered 19-07-26 (unblocks Stage 2; rulings in `docs/phase-1-tuning.md`)

Rulings needed from the project owner. "Accept proposal" is a valid answer to any of them; each decision gets recorded in design.md §19 in the same commit that implements it.

- [x] **#45 — Option A or B.** A *(recommended)*: fuel stays instant/Syndicate-delivered; a second raw good moves by shipment and pays tolls. B: fuel-only, produced fuel physically ships to the reserve. Most of the remaining numbers hang on this.
- [x] **#48 — force-sell: keep or drop.** Dropping it enables the pooled fuel-allocation model and the licence-premium anti-hoarding mechanism (design.md §8, `docs/fuel-allocation-model.md`); it re-derives the port's semantic #2 and the squeeze signature. Enforcement of illegal withholding is Phase 5; in Phase 1, dropping it just makes hoarding possible-and-expensive.
- [x] **#42 — posted-price semantics** (proposal: step 3 publishes next window's price)
- [x] **#43 — credit rounding** (proposal: `round(qty × price)`, identical both sides)
- [x] **#44 — scarcity allocation** (proposal: validate-as-they-arrive, whole order fails, fixed bot order)
- [x] **#46 — land rent out of Phase 1** (proposal: yes, tolls + tariffs only)
- [x] Eight-step tick order confirmed as amended in design.md §15.6 (adopted in the 17-07 consolidation; veto here if wrong)
- [x] Invariant 3 per-field rulings (proposals: credits **fail**; consumption **floors + records**; hoard-sales **fail**; reserve over-buys **fail whole order**; venture inputs floor via `min(rate, available)`; influence **fail**; Syndicate ledger exempt/may go negative)
- [x] **#47 — tuning numbers**, decide or accept proposals: player guild start · transit ticks per edge (2 open / 1 secured) · toll unit + default + range · tariff unit + default + range · influence starting stock + earn rate · contest open-cost/min-stake/window · disposition scale/deltas/grudge-multiplier/decay/cap · bot trading band + rolling window + budget floor · bot contest-defense policy · shortfall throttle in sandbox (record-only in the squeeze check) · graph topology (proposed: Citadel + 6 homes + 3 contested middles) · second good's market levers (if Option A)

### Stage 2 — Harness, then walking skeleton

- [x] `package.json` (zero runtime dependencies; tests on `node:test`)
- [x] Invariant checks: conservation of fuel (1), conservation of credits (2, with an explicit Syndicate ledger), non-negativity (3, per-field), determinism (9) — asserting **every tick**, halting loudly with tick number and offending values
- [x] Canonical serialization + state hashing for byte-identical comparison
- [ ] `tick(state, actions)` pure function; all eight §15.6 steps as named functions in fixed order; no DOM access anywhere in `sim/`
- [x] Action intake validated as-it-arrives (state-as-it-stands), first-valid-wins — `actions.js`; wired into the driver and tested end-to-end via `advance` (01-08-26)
- [ ] Walking skeleton: 2 guilds, 3 systems + Citadel, one venture each, fuel market live, one claim, one toll paid end-to-end
  - [x] **First slice landed (01-08-26):** the driver `advance(state, actions)` (`sim/run.js`, intake→tick→assert — invariants now assert every tick in the running loop), the guild-less **zero-state** boot (`sim/scenarios/zero-state.js`), and the conservation-clean **`foundGuild`** action (starting credits debited from the Syndicate ledger). Watchable via `node sim/demo.js`; determinism green through the driver. Remaining on this line: fuel market (step 3), a second guild/bot, a real claim, a toll end-to-end.
  - [x] **Resource representation landed (02-08-26):** guild-level typed `stockpiles` (replacing the typeless per-venture `outputStockpile`); the canonical resource vocabulary `sim/resources.js` (17 raw goods, **drift-guarded** against the generator's archetype pools by a test); the derived `galacticSupply` totals (`sim/supply.js`) written each tick with a **consistency invariant** asserted every tick; and step-1 production now depositing a mining venture's `resourceType` into its owner's stockpile. Watchable via `node sim/demo.js` — Titanium climbs 5→10→15 and the per-good totals + fuel pool print. Remaining on this line: fuel market/pricing (step 3), a second guild/bot, a real claim, a toll end-to-end.
  - [x] **Venture ↔ seed link landed (02-08-26):** the first time the engine references the seed. Ventures carry a `siteId` (a resource node or settlement slot); `sim/seed.js` resolves it against `data/seed.json` (read-only); occupancy is the derived lookup `sim/occupancy.js`; and a new invariant asserts every `siteId` resolves to a real site, one venture per site, and a mining venture's `resourceType` matches its node. Settlement slots were added to the generator in the same slice (see Track G). Watchable via `node sim/demo.js` — the mine now shows seated at `pl_00001_n02 (titanium on pl_00001)`. The tick hot path stays seed-free (only seating-validation and the invariant read the seed).
  - [x] **State inspector landed (03-08-26):** a developer debug lens on live engine state (design.md §7 hides real supply from *players*; this is god's-eye and labelled so on the page). `sim/snapshot.js` is a pure `buildSnapshot(state)` that derives per-good galactic totals, the fuel reserve/hoard split, guild breakdowns, and seated-venture occupancy straight from the engine's own selectors (`computeGalacticSupply`/`computeOccupancy`/`getSite`) — it invents no number; its CLI boots the demo scenario and writes `dev/state_snapshot.json` (gitignored — a throwaway dev artifact). `client/state_inspector.html` loads that file by file-picker (same pattern as `seed_viewer.html`) and renders it. Tripwire `sim/tests/snapshot.test.js` pins every snapshot total to those selectors so the lens can never silently drift; the page was render-verified in headless Chromium. Remaining on this line: fuel market/pricing (step 3), a second guild/bot, a real claim, a toll end-to-end.
  - [x] **Live world wired to the seed + guild home-seating landed (03-08-26):** the live TERRITORY layer stops being a placeholder graph and references the real seed (design.md §15.3). `sim/seed.js` gains a landmark index (`getCitadel`/`getOutpost`/`getOutposts`/`getSystem`/`getLandmark`/`isStarterSystem`/`getTerranHomeworld`/`getSeedNumber`); the zero-state's world is now `{ seed }` and its Syndicate claims are the real **Citadel + 9 outposts** (retiring the invented `home_i`/`middle_i` nodes and the 3 placeholder waystations); `foundGuild` seats a guild on a chosen starter system's Terran homeworld and adds its home claim. Two new invariants assert every tick: **claim-integrity** (each claim's `landmarkId`+`landmarkKind` resolves to a real seed landmark) and **guild-home** (a guild's denormalised home matches the seed's starter-eligibility + homeworld, and a matching ownership claim exists). Watchable via `node sim/demo.js` — the player founds at sys_0002, its mine sits on the homeworld's titanium node, and the 10 Syndicate claims print by real id. 113 tests green; determinism re-verified. Remaining on this line: fuel market/pricing (step 3), a second guild/bot, a toll end-to-end.
  - [x] **establishVenture action + claims in the snapshot landed (03-08-26)** — groundwork for an interactive **testbed** for the tick/advancement system (design's own "the update discipline is where economic games die"). `establishVenture` (sim/actions.js) seats a NEW mining venture, belonging to an existing guild, onto a real unoccupied seed resource node, validated the validate-as-they-arrive way (guild exists; venture id unique galaxy-wide; node resolves, is a resource node, matches the venture's `resourceType`, and is unoccupied; `productionRate` a positive integer) and backstopped by the site-occupancy invariant. It moves no credits/fuel (no site cost yet) and starts producing on the next tick. `productionRate` is operator-supplied, not baked — only Titanium's 5/tick is ruled, so the testbed takes the rate as an explicit dial rather than inventing others. `buildSnapshot` gains the SHARED **claims** layer (each row's seed landmark resolved, with coords) so the debug lens can finally see Syndicate waystations + guild homes; snapshot schema 1→2. Watchable via `node sim/snapshot.js` — the emitted snapshot founds a guild, adds a second mine via the action, and carries 11 resolved claims. 126 tests green; determinism re-verified.
  - **Testbed direction (decided 03-08-26):** this feeds a self-hostable dev rig — a thin Node HTTP server wrapping the SAME `sim/` (one engine, still guarded by the tests/invariants — no browser-side copy), in a Docker container on the project's Docker host (listen port **7331**, the galaxy seed), repo **volume-mounted** so edits show up on restart. State stays **in-memory + ephemeral with a Reset** (a stress-test wants to blow it away and retry); **Postgres is deferred to Phase 2** (its stated headline), the entities already being row-shaped so that swap is a swap, not a rewrite. Sliced: (1) this pure-engine step; (2) thin server + container; (3) authoring UI (found-guild / add-venture / play-pause auto-tick). Slice 2 will ship its own design/roadmap note when the server lands, so "a server arrived early as a harness" is recorded, not silent.
  - [x] **Testbed server + container landed (03-08-26)** — testbed slice 2. `sim/server.js`: a thin Node built-in-`http` server (no framework, no dependencies) that holds ONE in-memory live state and exposes the engine — `GET /snapshot`, `POST /tick` (advance one turn), `POST /action` (intake one action, **NO tick** — manual tick), `POST /reset`. Zero game logic: every mutation goes through the same `intake`/`advance` the tests guard, and the live state lives behind a single get/set holder (the seam Phase 2 swaps for Postgres — no speculative abstraction built now). An invariant trip is caught and returned as a 500 with the live state left on its last good value, so the tripwire is visible and the server stays up. A `Dockerfile` (node:22-alpine, `CMD node sim/server.js`) + `.dockerignore` containerise it on the project's Docker host (listen port **7331**, the galaxy seed); the repo can be volume-mounted so edits show up on restart, and the image is self-contained so it also runs without a mount. Tripwire `sim/tests/server.test.js` boots the real server on an ephemeral port and drives it over HTTP (11 tests): the **manual-tick contract** (an action applies but does NOT tick; a `/tick` does and production mints), rejections (occupied node / unknown type → 200 + reason), 400s on malformed bodies, 404 routing, and reset. 137 tests green. Verified under plain Node here (`node sim/server.js` served correctly); `docker build`/`docker run` are the human's to run on the Docker host. Next: the authoring UI (slice 3) — found-guild / add-venture pickers + a snapshot poll, served so the browser drives all this by clicking.
  - [x] **Testbed web UI landed (03-08-26)** — testbed slice 3, closing the interactive rig. The server now serves a page at `GET /` (`client/testbed.html`); the JSON liveness probe moved to `GET /health` (same shape, so scripts keep working). The page reuses the state-inspector lens (supply table, fuel panel, guild cards with home, ventures/occupancy, and a new territory/claims panel) and adds **Found-guild / Establish-venture / Tick / Reset** controls plus a status line that surfaces each action's accepted / REJECTED-with-reason (and any engine 500). It computes nothing — same-origin `fetch('/snapshot')`, re-rendered after each action and each tick (**refresh-on-action**; manual tick, no background polling), so the galaxy moves only when you press TICK. Verified end-to-end in headless Chromium (found → establish → tick×2 → galactic titanium 10; a repeat-node establish rejected in amber without mutating; reset to zero-state; zero console errors); the server route is tripwired in `sim/tests/server.test.js` (GET / is HTML with the controls present; GET /health is JSON). 138 tests green. Open at `http://<docker-host>:7331/`. This completes the **manual** testbed; auto-tick (the galaxy on its own clock, with tick-interval polling) remains a separate later slice.
  - [x] **Refining engine landed — titanium → alloy ingots (03-08-26):** the first raw→processed conversion, and the first venture kind beyond mining. A **recipe catalog** (`sim/recipes.js`, one recipe: `titanium_to_alloy` = 3 titanium → 1 alloy_ingot `[FIRST-CUT]`) is the fixed set of conversions — a refinery names a `recipeId`, it can't invent one. `sim/resources.js` gains a **processed-goods** category (`alloy_ingots`) distinct from raw resources and from the special fuel; processed goods live in stockpiles and appear in galactic supply (supply + the non-negativity/known-good invariant now range over raw + processed). Step-1 production handles refining: a venture on a **settlement slot** consumes its recipe's input from and produces its output into the owner's stockpile, **up to `productionRate` batches/tick, throttled by available input** (so nothing goes negative — invariant 3 holds without a special case). `establishVenture` now branches mining (resource node + `resourceType`) vs refining (settlement slot + `recipeId`), each validated up front and backstopped by the occupancy invariant (a refinery must sit on a settlement slot and its recipe must resolve). Refinery throughput is operator-supplied, not baked. Verified: a mine feeding a refinery converts titanium→alloy every tick, throttles when starved, and stays green; 152 tests (+14); determinism re-verified. The testbed UI shows it already (alloy_ingots in the supply table, refining ventures in the ventures table); a click-to-establish-refinery UI comes with the per-guild homeworld view next.
- [ ] Determinism test green: same start, run twice, identical hash at tick 50
- [ ] **Gate:** shown running before scaling up

**Follow-on decisions surfaced in the Stage 2 build (01-08-26)** — each needs a ruling before the code that consumes it (working practice #5); until then it is an explicit, flagged placeholder in the code, never a silent number:
- [x] **Starter mining rate** — **ruled**: Titanium's base extraction rate is **5/tick** (`[FIRST-CUT]`; recorded in phase-1-tuning.md, 01-08-26). Extraction rate is a per-resource property, not a mine tier; droid buffs remain out of scope. `sim/demo.js`'s quiet ticks now visibly accumulate Titanium while conservation holds.
- [x] **Waystation count + placement — resolved 03-08-26**: adopted the seed's **9 outposts** as the Syndicate waystations; the zero-state claims them by reference. No invented count — it is whatever the generator places, deterministically.
- **Home-node assignment on founding** — *partially resolved 03-08-26*: `foundGuild` now takes an explicit `homeSystemId`, validates it is a starter-eligible system that is unclaimed, seats the guild on that system's Terran homeworld, and adds a guild-owned home claim; the genesis claim does **not** grant the +20 (setup, not a play action). Still open: **bot** home auto-assignment (which of the 368 starters each bot gets), a later scenario concern.
- [x] **#22 Deuterium's identity — ruled 02-08-26**: `deuterium` (raw, mined) and `deuterium_fuel` (refined; the fuel held in reserve/hoards) are two distinct goods; the refined good is not minable and is in no archetype pool. The id string `deuterium_fuel` is a `[FIRST-CUT]` open to veto. Encoded in `sim/resources.js`; full ruling in design.md §20.
- [x] **Venture output model — decided 02-08-26**: the typeless per-venture `outputStockpile` is retired; produced goods are typed and flow into the owner guild's `stockpiles` (one home, no double-counting; producer attribution via `lifetimeProduced`). Reversible if a produced-but-unsold-at-venture state is later needed (design.md §15.4).
- **Fuel price inputs** — surfaced by the representation slice, deferred to the pricing step: the committed `fuel-allocation-model.md` floats fuel price on the **reserve pool alone**, while the working rule from the 02-08-26 design chat wants **reserve + guild hoards**. `galacticSupply.fuel` already reports both figures; which the price reads is a Stage-3 ruling.
- [x] **Settlement-slot counts — ruled 02-08-26** `[FIRST-CUT]`: per-planet non-mining build spaces by archetype — Terran 15; rocky/desert 7–10; ice/crystalline 4–7; oceanic 3–4; gasGiant/molten/irradiated 0. In the generator (`SETTLEMENT_SLOTS`) and `docs/phase-1-tuning.md`; open to a veto.
- [x] **Venture seating model — decided 02-08-26**: a venture's `siteId` (resource node or settlement slot) is the authoritative location; occupancy is derived (`sim/occupancy.js`), never stored on the site (design.md §15). `resourceType` stays a denormalised copy of the node's, guarded by the site-occupancy invariant. The tick loop stays seed-free.

### Stage 3 — The sandbox

- [ ] Full roster: five spreadsheet guilds (bot) + player guild; full graph
- [ ] **Squeeze regression check**: headless scripted replay of the sheet's 12-turn action grid reproduces the signature — price 5 → 7.03 → 16.75 → 38.48 peak → recovery; Dracis shortfalls 6/7/2; Refiner finishes richer than the Stockpiler (design.md §8)
- [ ] Territory claim/contest working (influence-commitment contests; negotiated transfer)
- [ ] Tolls and tariffs settable, negotiable with bots; disposition moves on costly actions, decays, stays capped, never touches prices
- [ ] Ventures with automation parameters (production is renewable-powered — no fuel/energy draw; fuel is burned by spacecraft only, §3 / #54)
- [ ] UI: map, guild dashboard, market panel with price history, territory/negotiation panels, event log, fast-forward
- [ ] Boundary test: territory suite passes against **two** world adapters (the real graph + a toy topology)
- [ ] Play sessions logged: can the player cause a squeeze? resist one? does #31's answer change when territory levers exist?

### Definition of done (from the build prompt, unchanged)

- [ ] Tests exist and run; invariants 1, 2, 3, 9 assert every tick and halt loudly
- [ ] Same starting state, run twice, byte-identical at tick N
- [ ] Tick loop pure, no DOM; all eight steps named functions in fixed order
- [ ] The squeeze reproduces the three signature results as an internal check
- [ ] A real session is playable: claim/contest, set/negotiate tolls and tariffs, watch disposition move, cause or fight a squeeze
- [ ] Territory/toll logic sits behind the world boundary; swapping in hex geography later shouldn't touch it
- [ ] **design.md updated in the same delivery**: what the phase taught, #31's answer as observed in play, #2's formula as now implemented, every tuning number decided, and the widened-scope note kept accurate

**Exit criteria:** the definition of done, plus an honest written answer to "does the shape of this game feel right to actually play."

---

## Phase 2 — Persist and tick on a server

**Goal:** close the tab, come back an hour later, something happened.
**Entry:** Phase 1 done (the loop being pure and DOM-free is what makes this phase a port, not a rewrite).

- [ ] Node server hosting the existing `sim/` loop unmodified
- [ ] Real heartbeat (working assumption: one minute — confirm #5), with the tick as a *checking* clock: due-tick items resolve on their own deadlines
- [ ] Crash-safe ticking: restart knows exactly which tick it was on; never double-applies or skips
- [ ] PostgreSQL schema for the §15.4 entities; transactions as the mechanical answer to invariant 4
- [ ] Migration: in-memory Phase 1 state → persisted live state; seed remains a JSON file, linked by reference only
- [ ] HTTP client: refresh-and-see, no WebSockets yet
- [ ] Invariant checks running server-side every tick, with violation halting + alerting
- [x] Decide `generatedAt`'s fate in the seed — **resolved early 20-07-26: dropped** from all generators + committed fixtures; file is now byte-identical across runs (design.md §16). *Residual:* `test_claims.json` still embeds an environment-dependent `seedFile` path — separate open determinism question, not yet ruled.

**Exit criteria:** the milestone sentence at the top, plus a week of unattended ticking with zero invariant violations.

---

## Track G — Galaxy generation recovery *(parallel track)*

**Goal:** re-implement the lost 15-07 generator work against its surviving spec (design.md §2, §13, §16), and make the galaxy layer visible for the first time.
**Entry:** none — schedulable any time. **Required before Phase 4.**

- [x] Searched the local machine (17-07-26): recovered `client/system_planet_ui_mockup.html` and a partial 15-07-era generator. Its archetype/resource-node/starter/validation logic (`validation: PASSED` on seed 7331) has now been **consolidated into `tools/generate_seed.js`** (01-08-26), with Terran corrected to §2 and applied as a decorating pass that preserves the base skeleton; the partial file was removed. The old **5,089-vs-5,290 planet-count discrepancy is resolved** (one generator, 5,290; the 15-07 build's ~393-starter figure was its own generator's and is superseded — this one yields 337). **Still missing:** ring classification, the rare-tier ×4/×1/×0.25 gradient, and the repair pass — §2's 41%/3.6% figures remain the verification targets for the next slice. `galaxy-map-hex.html` and `SyndicateMarketplace.jsx` remain unrecovered.
- [x] **Archetypes + resource nodes landed (01-08-26):** steps 5, 6, 8, 10 consolidated into `generate_seed.js` as a skeleton-preserving decorating pass; `data/seed.json` regenerated (5,290 planets, 23,420 nodes, 337 starter systems, `validation: PASSED`); Terran corrected to §2. Remaining below: rings + gradient + repair + the 41%/3.6% verification + viewer/UI rendering.
- [x] Ring classification (inner/middle/outer by Citadel distance) — pure geometry, no RNG; `system.ring` set at build time so the base skeleton stays byte-identical (02-08-26)
- [x] Nine archetypes, weighted draw, rare-tier ring multipliers (×4 / ×1 / ×0.25) — measures ~38.7% inner / ~14.4% middle / ~4.3% outer rare-tier on seed 7331 (02-08-26)
- [x] Resource-node generation: archetype pools + ranges; Terran guaranteed minimums (incl. Gold/Silver/Tungsten) + 3 random extras; Oceanic ≥2 Deuterium; 10-node cap asserted at startup, Terran the sole named exception
- [x] **Settlement slots landed (02-08-26):** per-planet non-mining build spaces (`settlementSlots`, ids `_sNN`), count by archetype (Terran 15; rocky/desert 7–10; ice/crystalline 4–7; oceanic 3–4; gasGiant/molten/irradiated 0) `[FIRST-CUT]`; added as a decorate pass AFTER repair so every prior field stays byte-identical — `data/seed.json` regenerated (32,813 slots), determinism re-verified, generator tripwire covers the counts/ids. Drives where refinery/factory/construction ventures can later be seated (consumed live via `sim/seed.js`).
- [x] Starter-eligible tagging: system has ≥1 Terran planet
- [x] Rare-tier repair pass (≥2 rare-tier within ⅓ radius of every starter system) — fires zero times on 7331; 359 repairs at a stress floor of 50, still valid (02-08-26)
- [x] Validation pass: every resourceType reachable, starter pool non-empty and spread across all 16 sectors, rare-tier guarantee post-repair; results in `validation.passed`/`validation.issues` (02-08-26)
- [x] Verified on seed 7331 (02-08-26): **368** starter systems (the 393 was a different, unrecovered build); rare-tier spread ~38.7% inner / ~4.3% outer (9.0×), close to the ~41%/~3.6% targets and exactly what ×4/×1/×0.25 predict; repair pass fires zero times; stress floor of 50 applies 359 repairs and still validates
- [x] Determinism re-verified: same seed → byte-identical galaxy; `data/test_claims.json` still byte-identical (skeleton unchanged) (02-08-26)
- [x] Viewer renders `ring` (#34) — System View header shows INNER/MIDDLE/OUTER and the map-side info panel carries a Ring row; verified in-browser (02-08-26)
- [x] Index UI (System View) wired to real seed data (#34, #35) — the mockup's system/planet view is ported into `seed_viewer.html` as a `#detail-screen` overlay, opened by OPEN DETAILS on a clicked system and fed that system's archetypes + resource nodes; exit returns to the map (01-08-26)
- [x] System View verified rendering in-browser (02-08-26) — fixed two defects in the port: a dropped `</div>` that left the overlay unclosed (swallowing the page scripts), and a CSS comment containing `*/` that voided the `#detail-screen` rule so the overlay never positioned over the map
- [ ] Decide the standalone `system_planet_ui_mockup.html`'s fate now that the System View lives in `seed_viewer.html` — keep as an isolated design reference or retire it to avoid drift
- [ ] Decide **which rare tier a repaired planet becomes** — the repair pass (design.md §2, §16 step 9) currently makes a base-weighted draw among molten/irradiated/crystalline. Unobservable on seed 7331 (repair never fires), so this is a flag, not a live number; a ruling of "accept the base-weighted draw" is a valid answer.
- [ ] Decide node **richness/yield** (slice A left it ungenerated — nodes carry only `id` + `resourceType`; a node's richness is an undecided number kept out of the canonical seed until designed)
- [ ] Decide `Planet.stats`' fate (#33): build or delete

**Exit criteria:** a committed seed regenerable from a published integer, with the galaxy layer visible in at least one client.

---

## Phase 3 — Multiplayer foundations

**Goal:** multiple humans share one galaxy against the same market, and the atomicity invariant carries real weight.
**Entry:** Phase 2 done.

- [ ] Accounts, login, sessions
- [ ] Concurrent action intake through the same validate-as-it-arrives discipline, now under real concurrency (Postgres transactions doing the work)
- [ ] The Syndicate Exchange's **player order book** (design.md §5): asks/bids, conventional sorting, divergence from the Syndicate value line
- [ ] Partial-transparency rules enforced server-side (stockpiles hidden, venture types visible)
- [ ] Adversarial self-testing: simulated ~200-actor squeeze against a single shared row (design.md §15.7) — the measurement deciding whether the escape hatches are needed; also covers the money-printer/dupe class of bug
- [ ] First population test at ~5 humans (#12)

**Exit criteria:** a weekend playtest with ≥3 humans, zero conservation violations, and at least one genuinely felt betrayal.

---

## Phase 4 — Territory, routes, tolls, travel time (the real map)

**Goal:** the map graduates from a picture into a system players contest.
**Entry:** Phase 3 done; Track G done.

- [ ] World adapter swap: graph → hex galaxy; the Phase 1 boundary test is the proof this doesn't touch economic logic
- [ ] Claims live on the Territory Map (one row per system/outpost/gate; bare-hex ownership derived, never stored)
- [ ] Outposts (anchor ≤10 of an own system) and Toll Gates (≤10 of an own system *or* outpost) as placeable live-state claims; Tier‑4 construction kits as their build path
- [ ] Toll Paths: strictly gate-to-gate; single risk profile known at entry; one roll at entry, no per-tick attention
- [ ] Shipments with real travel time; the **change calculator** built at route-segment granularity (open space per-segment checks vs toll-path single roll) — resolving #7
- [ ] Pirate-bot ambient hazard (basic form) so open space costs something; attributable vs non-attributable line enforced
- [ ] Syndicate public transport as a real round-trip Shipment (§6 terms); `feePercent` and hauler speed decided (#27 residue)
- [ ] Vehicle gate honored: Syndicate never ferries deployable assets
- [ ] Legality hooks stubbed (defiance is *recorded* even though courts don't exist until Phase 5)

**Exit criteria:** a toll empire is buildable, avoidable, and worth arguing about — traffic genuinely chooses between paying and flying dark.

---

## Phase 5 — The political layer

**Goal:** council sessions people scheme about.
**Entry:** Phase 4 done (disputes need something real to dispute).

- [ ] Council votes: influence-weighted, real time windows, zero-sum/resource-constrained framing
- [ ] Legality disputes over recorded defiance (mining without licence, blockade-running); everyone-votes model (#3) unless play shows otherwise
- [ ] Fines: legislated schedules, compounding repeats, paid to victims (conservation-safe), pile-on guard
- [ ] Forced-compliance rulings; precedent with decay
- [ ] Vote-weight integrity (invariant 6) tested under influence spent-vs-voted races
- [ ] Vote-window fairness mitigation chosen (#14)

**Exit criteria:** a real dispute resolved by a real vote whose outcome someone lobbied for.

---

## Phase 6 — Bots and the Storyteller

**Goal:** sparse servers feel alive; leaders feel hunted; nobody gets taxed by rule.
**Entry:** Phase 5 done (bots need politics to have standing interests in).

- [ ] Bot tiers 1–3 complete (Phase 1's tier 1–2 work graduates; tier 3 filler factions added)
- [ ] Disposition system finished and feeding vote behavior (#11 numbers finalized from Phase 1 experience)
- [ ] Pirate bots complete: event-driven escalation, fencing/black market
- [ ] Storyteller: signals (concentration, Gini, time-since-loss, stagnation), surface-area targeting, disposition-fed weights, ~70/30 telegraphed/sudden, named presets (#10)
- [ ] Events redistribute opportunity, not just delete value — verified against play logs
- [ ] *(Stretch / v2)*: the narrative layer — Rebellion containment tax, cover missions, intel/evidence, the Ancients (#16–21)

**Exit criteria:** a server left alone for a week produces a story worth retelling.

---

## Phase 7 — Self-hosting, config, onboarding, polish

**Goal:** someone who isn't the developer runs a galaxy, and someone who's never read the design doc learns the game by playing it.
**Entry:** Phase 6 done.

- [ ] Server config surface: fine severities, vote windows, tick rate, starting resources, bot density, storyteller presets
- [ ] Onboarding live: reserved starter systems, homeworld placement, vehicle gate, Titanium starter quest against `lifetimeProduced`, archetype-neutral kit; the second-vehicle path decided (#8)
- [ ] Legibility pass: dashboard/notifications for the many-clocks tension
- [ ] Deployment shape documented for self-hosters; seed shareability by number
- [ ] *(Later)* master-server listing layer

**Exit criteria:** one self-hosted galaxy running that the developer didn't set up.

---

## Standing rules (all phases)

1. **The repo is the only memory.** No artifact leaves a session unsaved. The doc updates in the same commit as the code it describes.
2. **Sequential vertical slices**, never parallel modules — the seams are the hard part and no session owns a seam.
3. **Tests are the tripwires**, AI review is a supplement. When unsure what to test: one of the nine invariants.
4. **Never invent a number silently.** Unsourced constants go to the decision checklist and get a ruling.
5. **Tag phase gates** in git (`phase1-stage2`, `phase1-done`, …) so any past playable state is one checkout away.
