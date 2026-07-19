# Starfare — Roadmap

*Last updated 17-07-26. This is the authoritative, checklist-level roadmap. `docs/design.md` §17 carries only a summary; when the two disagree on **status**, this file wins, and on **design**, that one wins. Update the relevant checklist in the same commit as the work it records — a checked box with no commit behind it is exactly the failure mode the 16-07 reconciliation caught.*

**How phases work here:** each phase is a legitimate finish line, not a checkpoint. A phase isn't done until its **exit criteria** hold, and no phase starts until its **entry dependencies** do. "Phase" refers only to this roadmap — manufacturing levels are *tiers* (design.md §15.2).

---

## Status Dashboard

| Phase | Name | Status |
|---|---|---|
| 0 | Prove it's fun, learn to code | ✅ Done (residual experiments optional) |
| 1 | Playable economy sandbox (widened) | 🔶 In progress — Stage 1 ✅, Stage 2 blocked on the decision checklist |
| 2 | Persist and tick on a server | ⬜ Not started |
| G | Galaxy generation recovery (parallel track) | ⬜ Not started — design complete, code lost |
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

### Decision checklist — ⛔ blocks Stage 2

Rulings needed from the project owner. "Accept proposal" is a valid answer to any of them; each decision gets recorded in design.md §19 in the same commit that implements it.

- [ ] **#45 — Option A or B.** A *(recommended)*: fuel stays instant/Syndicate-delivered; a second raw good moves by shipment and pays tolls. B: fuel-only, produced fuel physically ships to the reserve. Most of the remaining numbers hang on this.
- [ ] **#48 — force-sell: keep or drop.** Dropping it enables the pooled fuel-allocation model and the licence-premium anti-hoarding mechanism (design.md §8, `docs/fuel-allocation-model.md`); it re-derives the port's semantic #2 and the squeeze signature. Enforcement of illegal withholding is Phase 5; in Phase 1, dropping it just makes hoarding possible-and-expensive.
- [ ] **#42 — posted-price semantics** (proposal: step 3 publishes next window's price)
- [ ] **#43 — credit rounding** (proposal: `round(qty × price)`, identical both sides)
- [ ] **#44 — scarcity allocation** (proposal: validate-as-they-arrive, whole order fails, fixed bot order)
- [ ] **#46 — land rent out of Phase 1** (proposal: yes, tolls + tariffs only)
- [ ] Eight-step tick order confirmed as amended in design.md §15.6 (adopted in the 17-07 consolidation; veto here if wrong)
- [ ] Invariant 3 per-field rulings (proposals: credits **fail**; consumption **floors + records**; hoard-sales **fail**; reserve over-buys **fail whole order**; venture inputs floor via `min(rate, available)`; influence **fail**; Syndicate ledger exempt/may go negative)
- [ ] **#47 — tuning numbers**, decide or accept proposals: player guild start · transit ticks per edge (2 open / 1 secured) · toll unit + default + range · tariff unit + default + range · influence starting stock + earn rate · contest open-cost/min-stake/window · disposition scale/deltas/grudge-multiplier/decay/cap · bot trading band + rolling window + budget floor · bot contest-defense policy · shortfall throttle in sandbox (record-only in the squeeze check) · graph topology (proposed: Citadel + 6 homes + 3 contested middles) · second good's market levers (if Option A)

### Stage 2 — Harness, then walking skeleton

- [ ] `package.json` (zero runtime dependencies; tests on `node:test`)
- [ ] Invariant checks: conservation of fuel (1), conservation of credits (2, with an explicit Syndicate ledger), non-negativity (3, per-field), determinism (9) — asserting **every tick**, halting loudly with tick number and offending values
- [ ] Canonical serialization + state hashing for byte-identical comparison
- [ ] `tick(state, actions)` pure function; all eight §15.6 steps as named functions in fixed order; no DOM access anywhere in `sim/`
- [ ] Action intake validated as-it-arrives (state-as-it-stands), first-valid-wins
- [ ] Walking skeleton: 2 guilds, 3 systems + Citadel, one venture each, fuel market live, one claim, one toll paid end-to-end
- [ ] Determinism test green: same start, run twice, identical hash at tick 50
- [ ] **Gate:** shown running before scaling up

### Stage 3 — The sandbox

- [ ] Full roster: five spreadsheet guilds (bot) + player guild; full graph
- [ ] **Squeeze regression check**: headless scripted replay of the sheet's 12-turn action grid reproduces the signature — price 5 → 7.03 → 16.75 → 38.48 peak → recovery; Dracis shortfalls 6/7/2; Refiner finishes richer than the Stockpiler (design.md §8)
- [ ] Territory claim/contest working (influence-commitment contests; negotiated transfer)
- [ ] Tolls and tariffs settable, negotiable with bots; disposition moves on costly actions, decays, stays capped, never touches prices
- [ ] Ventures with automation parameters and energy draw from the shared pool
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
- [ ] Decide `generatedAt`'s fate in the seed (drop it, or accept content-level determinism)

**Exit criteria:** the milestone sentence at the top, plus a week of unattended ticking with zero invariant violations.

---

## Track G — Galaxy generation recovery *(parallel track)*

**Goal:** re-implement the lost 15-07 generator work against its surviving spec (design.md §2, §13, §16), and make the galaxy layer visible for the first time.
**Entry:** none — schedulable any time. **Required before Phase 4.**

- [x] Searched the local machine (17-07-26): recovered `client/system_planet_ui_mockup.html` and a partial 15-07-era generator, committed as `tools/generate_seed_recovered_partial.js`. It implements archetypes, resource-node generation, starter-eligible tagging, and validation — confirmed working, `validation: PASSED` on seed 7331. **Missing from this recovery:** ring classification, the rare-tier ×4/×1/×0.25 gradient, and the repair pass — none of that logic exists in this file, so §2's 41%/3.6% figures are still unverified against any real code. **Known discrepancy to resolve:** this file produces 5,089 planets for seed 7331 vs. the committed generator's 5,290 — the RNG stream diverges somewhere before or during planet-count generation, so the two files aren't a clean subset/superset of each other; reconciling that is part of finishing this track, not just layering ring logic on top. `galaxy-map-hex.html` and `SyndicateMarketplace.jsx` remain unrecovered.
- [ ] Ring classification (inner/middle/outer by Citadel distance)
- [ ] Nine archetypes, weighted draw, rare-tier ring multipliers (×4 / ×1 / ×0.25)
- [ ] Resource-node generation: archetype pools + ranges; Terran guaranteed minimums (incl. Gold/Silver/Tungsten) + 3 random extras; Oceanic ≥2 Deuterium; 10-node cap asserted at startup, Terran the sole named exception
- [ ] Starter-eligible tagging: system has ≥1 Terran planet
- [ ] Rare-tier repair pass (≥2 rare-tier within ⅓ radius of every starter system)
- [ ] Validation pass: every resourceType reachable, starter pool non-empty and spread across all 16 sectors, rare-tier guarantee post-repair; results in `validation.passed`/`validation.issues`
- [ ] Verify against the 15-07 figures on seed 7331: ~393 starter systems; ~41% / ~3.6% rare-tier spread; repair pass fires zero times; stress-test the repair pass
- [ ] Determinism re-verified after every step
- [ ] Viewer renders `archetype` and `ring` (#34)
- [ ] Index UI rebuilt or recovered, wired to real seed data (#34, #35)
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
