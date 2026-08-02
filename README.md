# Starfare

A real-time, persistent, self-hostable web game. Each player runs a **Guild** competing and cooperating across a shared galactic economy, under one opaque institution — **the Syndicate** — that runs the fuel utility, the market, and the law, and that every guild part-owns but none controls. The defining tension, borrowed from *Dune*: **mutual dependency without trust.**

Not a game engine project — a persistent web application: a database holding state, a server advancing it on a tick, a browser page displaying it. Plain JavaScript throughout.

- **The contract:** [`docs/design.md`](docs/design.md) — the living master document. All code is checked against it; when code and doc disagree, that's a bug in one of them.
- **The plan:** [`docs/roadmap.md`](docs/roadmap.md) — phases, checklists, exit criteria, and live status.

**Where the project actually is (02-08-26):** design far ahead of code. The map/territory tooling works and the galaxy seed is now fully populated; the economy — the thing the game rests on — has never run as software. Phase 1 (a playable economy sandbox) is current: its Stage 1 read-and-report is delivered, and Stage 2 is blocked only on the decision checklist in the roadmap. Since the 17-07-26 recovery pass the generator has been consolidated into one **populated** generator (planet **archetypes** and **resource nodes**, starter tagging, validation — the recovered 15-07 partial absorbed and removed), and the **System View** drill-down has been wired into the seed viewer and confirmed rendering in-browser. Ring classification and the rare-tier gradient are the next generation slice; two past artifacts (`galaxy-map-hex.html`, `SyndicateMarketplace.jsx`) remain unrecovered.

---

## Repository map

```
starfare/
├── README.md                  ← you are here
├── docs/
│   ├── design.md              ← the contract (design + technical architecture + open questions)
│   ├── roadmap.md             ← phases, checklists, status
│   └── prompts/
│       └── phase-1-sandbox-prompt.md   ← the working build prompt for Phase 1
├── sim/                       ← the Phase 1 economy engine (invariant harness landed; tick loop next — see sim/README.md)
├── tools/                     ← offline generation tooling (Node, no dependencies)
│   ├── generate_seed.js         ← the one deterministic generator (populated: archetypes + nodes)
│   └── generate_test_claims.js
├── client/
│   ├── seed_viewer.html       ← galaxy/claims viewer + System View drill-down (browser, no server)
│   └── system_planet_ui_mockup.html   ← standalone System View prototype (its view now lives in seed_viewer.html)
├── data/                      ← committed reference fixtures (all regenerable)
│   ├── seed.json              ←   seed 7331, populated (5,290 planets · 23,420 resource nodes)
│   └── test_claims.json       ←   claims seed 4242 over seed 7331
└── analysis/
    └── fuel_market_simulator.xlsx   ← the Phase 0 hand-played fuel market
```

## File manifest — what each file is, where it stands, what it needs

| File | What it is | Status | What it needs |
|---|---|---|---|
| `docs/design.md` | The master design & technical document; the contract. Sections 1–20: vision, galaxy, economy/manufacturing tiers, ventures & the Exchange, logistics, politics, fuel, storyteller, bots, narrative layer, onboarding, architecture, data model & invariants, seed generation, roadmap summary, AI workflow, open questions | ✅ Consolidated 17-07-26; §16 corrected against the recovery the same day | Rulings on the Phase 1 blockers (#42–47) plus the force-sell fork (#48); ongoing upkeep in the same commit as code |
| `docs/roadmap.md` | Authoritative phase-by-phase checklists and exit criteria | ✅ Current; Track G updated 17-07-26 with the recovery result | Boxes ticked as work lands; the Phase 1 **decision checklist** answered first |
| `docs/fuel-allocation-model.md` | The fuel pool, purchasing-power allocation, the Syndicate-only benefit & its regional-bloc tension, and conditional refinery licensing (added 19-07-26) | ✅ New, current | Force-sell ruling (#48) before build; folds into §8, which carries the summary |
| `docs/prompts/phase-1-sandbox-prompt.md` | The working prompt Phase 1 is built from (three gated stages) | ✅ Versioned as written 16-07 | Nothing — historical artifact; superseded details are tracked in design.md/roadmap.md |
| `sim/` | The Phase 1 economy engine: pure tick loop, invariant harness, world-interface boundary, bots, UI | 🔶 Harness landed (`invariants.js`, `serialize.js`, tests green) | The pure `tick(state, actions)` loop + walking skeleton |
| `tools/generate_seed.js` | The one deterministic galaxy-seed generator — pipeline steps 1–3, 5, 6, 7, 8, 10: systems, names, planets **with archetypes and resource nodes**, outposts, Citadel, starter-eligible tagging, validation. Usage: `node tools/generate_seed.js [seed] [outPath]` | ✅ Populated (01-08-26); byte-identical across runs; seed 7331 → 101,287 hexes · 1,500 systems · 5,290 planets · 23,420 nodes · 337 starter systems · 9 outposts (`validation: PASSED`) | Track G: steps 4 & 9 — ring classification + rare-tier ×4/×1/×0.25 gradient + repair pass (design.md §2) — still in no code; the next slice |
| `tools/generate_test_claims.js` | Test tooling (not architecture): writes a separate claims file — guilds, territory, outposts, toll gates/paths — obeying the real placement rules, so rendering can be exercised. Usage: `node tools/generate_test_claims.js [seedFile] [claimsSeed] [outPath]` | ✅ Works as designed; re-verified 17-07 (20 guilds · 109 systems · 60 outposts · 49 gates · 29 paths) | Nothing until the seed format grows (Track G) |
| `client/seed_viewer.html` | Browser viewer: pan/zoom galaxy, territory fills, hex borders at zoom, hollow-ring toll gates, dashed toll paths, click-anything info panel — and a full-screen **System View** overlay (OPEN DETAILS on a system → its planets → each planet's resource nodes, each with an Establish-Venture affordance; exit returns to the map). Loads files via the two file pickers | ✅ Works; System View wired to real seed data and verified in-browser (02-08-26) | Track G: render `ring` once seeds carry it (#34) |
| `client/system_planet_ui_mockup.html` | The standalone System View prototype (design.md §16) — the origin of the view now embedded in `seed_viewer.html`; runs on hardcoded demo data | ✅ Wired into the viewer 01-08-26; kept as an isolated reference | Decide its fate: keep as reference or retire to avoid drift |
| `data/seed.json` | Reference seed 7331 — verified to be exactly what the committed generator produces | ✅ Current for the committed generator | Regenerate when Track G lands |
| `data/test_claims.json` | Reference claims (seed 4242) over the reference seed | ✅ Current | Regenerate alongside the seed |
| `analysis/fuel_market_simulator.xlsx` | Phase 0's hand-played fuel market and the deliberate squeeze; ground truth for the price formula | ✅ Done; transcribed into design.md §8 as the port contract | Optional: the fight-the-squeeze experiment (#31) |

**Referenced but missing** (built in past sessions, never saved — rebuild per their specs in design.md §16): `galaxy-map-hex.html` · `SyndicateMarketplace.jsx`.

*Recovered 17-07-26: `system_planet_ui_mockup.html` (kept as a reference) and a partial 15-07 `generate_seed.js` — the latter's archetype/node/starter/validation logic has since been absorbed into `tools/generate_seed.js` and the partial file removed (01-08-26).*

## Running what exists

Requires Node.js (any recent version; no packages to install).

```bash
# Regenerate the reference seed (deterministic: same number → same galaxy)
node tools/generate_seed.js 7331 data/seed.json

# Regenerate test claims over it
node tools/generate_test_claims.js data/seed.json 4242 data/test_claims.json

# View: open client/seed_viewer.html in a browser, then use the file pickers to load
# data/seed.json (and optionally data/test_claims.json). Click a system, then OPEN
# DETAILS to drill into the System View; "Back to map" returns you.
```

Note: the generators are fully deterministic and no longer embed a wall-clock timestamp (the `generatedAt` field was dropped 20-07-26 — provenance is git's job), so regenerating on the same seed reproduces the committed file **byte-for-byte**. See design.md §16.

## Working practices

These are the project's survival rules — the long form is design.md §18.

1. **The repo is the only memory.** AI sessions are stateless; code + `docs/` are the sole continuity. **No artifact leaves a session unsaved** — the 15-07 generator work was lost exactly this way, and only partially recovered.
2. **Doc and code move in the same commit.** A behavior change without its design.md/roadmap.md update is an incomplete commit.
3. **Sequential vertical slices**, one module at a time, each conforming to what exists. Never parallel "expert" sessions per module — the seams are the hard part and nobody owns a seam.
4. **Mechanical tripwires over review.** Tests and schema checks fail loudly when the contract is violated; AI writes the tripwires but is never *the* tripwire. When unsure what to test: one of the nine invariants (design.md §15.5).
5. **Never invent a number silently.** Unsourced constants go to the roadmap's decision checklist for a ruling.
6. **Conventions** (design.md §15.2): integer credits, integer goods, the word is `guild`, manufacturing *tiers*, stable IDs, every mutation records its tick.

**Starting a new AI session:** have it read `docs/design.md` and `docs/roadmap.md` first, state which roadmap item it's working on, and deliver the doc/roadmap updates in the same commit as the code.

## Git

Live at `https://github.com/Raven-git-hub/starfare` — first pushed 17-07-26.

Ongoing habits, kept deliberately simple for a solo project: work on `main`; commit small and often (a commit per working change, message saying *why*); tag phase gates (`git tag phase1-stage2 && git push --tags`) so any past playable state is one checkout away. Branches and pull requests can wait until there's a second contributor or a reason to keep `main` always-runnable against experiments. If GitHub Issues appeal, mirror the open questions there — but design.md §19 stays the source of truth either way.
