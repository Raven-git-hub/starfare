# Starfare

A real-time, persistent, self-hostable web game. Each player runs a **Guild** competing and cooperating across a shared galactic economy, under one opaque institution — **the Syndicate** — that runs the fuel utility, the market, and the law, and that every guild part-owns but none controls. The defining tension, borrowed from *Dune*: **mutual dependency without trust.**

Not a game engine project — a persistent web application: a database holding state, a server advancing it on a tick, a browser page displaying it. Plain JavaScript throughout.

- **The contract:** [`docs/design.md`](docs/design.md) — the living master document. All code is checked against it; when code and doc disagree, that's a bug in one of them.
- **The plan:** [`docs/roadmap.md`](docs/roadmap.md) — phases, checklists, exit criteria, and live status.

**Where the project actually is (17-07-26):** design far ahead of code. The map/territory tooling works; the economy — the thing the game rests on — has never run as software. Phase 1 (a playable economy sandbox) is current: its Stage 1 read-and-report is delivered, and Stage 2 is blocked only on the decision checklist in the roadmap.

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
├── sim/                       ← the Phase 1 economy engine (empty — see sim/README.md)
├── tools/                     ← offline generation tooling (Node, no dependencies)
│   ├── generate_seed.js
│   └── generate_test_claims.js
├── client/
│   └── seed_viewer.html       ← galaxy/claims viewer (open in a browser, no server needed)
├── data/                      ← committed reference fixtures (all regenerable)
│   ├── seed.json              ←   seed 7331
│   └── test_claims.json       ←   claims seed 4242 over seed 7331
└── analysis/
    └── fuel_market_simulator.xlsx   ← the Phase 0 hand-played fuel market
```

## File manifest — what each file is, where it stands, what it needs

| File | What it is | Status | What it needs |
|---|---|---|---|
| `docs/design.md` | The master design & technical document; the contract. Sections 1–20: vision, galaxy, economy/manufacturing tiers, ventures & the Exchange, logistics, politics, fuel, storyteller, bots, narrative layer, onboarding, architecture, data model & invariants, seed generation, roadmap summary, AI workflow, open questions | ✅ Consolidated 17-07-26 (statuses corrected against the repo; Marketplace thread merged; simulator port contract added; 8-step tick order adopted) | Rulings on open questions #42–47 (the Phase 1 blockers); ongoing upkeep in the same commit as code |
| `docs/roadmap.md` | Authoritative phase-by-phase checklists and exit criteria | ✅ New, current | Boxes ticked as work lands; the Phase 1 **decision checklist** answered first |
| `docs/prompts/phase-1-sandbox-prompt.md` | The working prompt Phase 1 is built from (three gated stages) | ✅ Versioned as written 16-07 | Nothing — historical artifact; superseded details are tracked in design.md/roadmap.md |
| `sim/` | The Phase 1 economy engine: pure tick loop, invariant harness, world-interface boundary, bots, UI | ⬜ Empty | Decision checklist answered → Stage 2 build (harness first) |
| `tools/generate_seed.js` | Deterministic galaxy-seed generator — currently pipeline steps 1–3 + 7 only (systems, names, placeholder planets, outposts, Citadel). Usage: `node tools/generate_seed.js [seed] [outPath]` | 🔶 Works; determinism verified 16-07; **pre-archetype version** — the 15-07 build with archetypes/nodes/validation was never saved | Track G: re-implement archetypes, rings, resource nodes, starter tagging, repair + validation per design.md §2/§13/§16 |
| `tools/generate_test_claims.js` | Test tooling (not architecture): writes a separate claims file — guilds, territory, outposts, toll gates/paths — obeying the real placement rules, so rendering can be exercised. Usage: `node tools/generate_test_claims.js [seedFile] [claimsSeed] [outPath]` | ✅ Works as designed | Nothing until the seed format grows (Track G) |
| `client/seed_viewer.html` | Browser viewer: pan/zoom galaxy, territory fills, hex borders at zoom, hollow-ring toll gates, dashed toll paths, click-anything info panel. Loads files via the two file pickers | ✅ Works | Track G: render `archetype`/`ring` once seeds carry them (#34) |
| `data/seed.json` | Reference seed 7331 — verified to be exactly what the committed generator produces | ✅ Current for the committed generator | Regenerate when Track G lands |
| `data/test_claims.json` | Reference claims (seed 4242) over the reference seed | ✅ Current | Regenerate alongside the seed |
| `analysis/fuel_market_simulator.xlsx` | Phase 0's hand-played fuel market and the deliberate squeeze; ground truth for the price formula | ✅ Done; transcribed into design.md §8 as the port contract | Optional: the fight-the-squeeze experiment (#31) |

**Referenced but missing** (built in past sessions, never saved — recover from the local machine if copies survive, otherwise rebuild per their specs in design.md §16): `galaxy-map-hex.html` · `system_planet_ui_mockup.html` · `SyndicateMarketplace.jsx` · the 15-07 `generate_seed.js`.

## Running what exists

Requires Node.js (any recent version; no packages to install).

```bash
# Regenerate the reference seed (deterministic: same number → same galaxy)
node tools/generate_seed.js 7331 data/seed.json

# Regenerate test claims over it
node tools/generate_test_claims.js data/seed.json 4242 data/test_claims.json

# View: open client/seed_viewer.html in a browser, then use the file pickers
# to load data/seed.json (and optionally data/test_claims.json)
```

## Working practices

These are the project's survival rules — the long form is design.md §18.

1. **The repo is the only memory.** AI sessions are stateless; code + `docs/` are the sole continuity. **No artifact leaves a session unsaved** — the 15-07 generator work was lost exactly this way.
2. **Doc and code move in the same commit.** A behavior change without its design.md/roadmap.md update is an incomplete commit.
3. **Sequential vertical slices**, one module at a time, each conforming to what exists. Never parallel "expert" sessions per module — the seams are the hard part and nobody owns a seam.
4. **Mechanical tripwires over review.** Tests and schema checks fail loudly when the contract is violated; AI writes the tripwires but is never *the* tripwire. When unsure what to test: one of the nine invariants (design.md §15.5).
5. **Never invent a number silently.** Unsourced constants go to the roadmap's decision checklist for a ruling.
6. **Conventions** (design.md §15.2): integer credits, integer goods, the word is `guild`, manufacturing *tiers*, stable IDs, every mutation records its tick.

**Starting a new AI session:** have it read `docs/design.md` and `docs/roadmap.md` first, state which roadmap item it's working on, and deliver the doc/roadmap updates in the same commit as the code.

## Git

First push of this directory to the empty repo:

```bash
cd starfare
git init
git add .
git commit -m "Consolidated project state: docs, tooling, reference data (17-07-26)"
git branch -M main
git remote add origin https://github.com/Raven-git-hub/starfare.git
git push -u origin main
```

Ongoing habits, kept deliberately simple for a solo project: work on `main`; commit small and often (a commit per working change, message saying *why*); tag phase gates (`git tag phase1-stage2 && git push --tags`) so any past playable state is one checkout away. Branches and pull requests can wait until there's a second contributor or a reason to keep `main` always-runnable against experiments. If GitHub Issues appeal, mirror the open questions there — but design.md §19 stays the source of truth either way.
