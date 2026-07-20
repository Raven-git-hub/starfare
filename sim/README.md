# sim/ — the Phase 1 economy engine

Stage 2 has started. The decision checklist is answered (19-07-26, `docs/phase-1-tuning.md`) and the **invariant harness has landed** — `invariants.js` (invariants 1/2/3 + the §15.2 integer convention, asserted every tick) and `serialize.js` (canonical stringify + hashing for the determinism check), both under `tests/`. Still to come before this directory is a running economy: the pure `tick(state, actions)` loop and the walking skeleton (see `docs/roadmap.md`, Phase 1 Stage 2).

Planned layout, from the Stage 1 plan (16-07-26) — ✅ marks what exists:

```
sim/
├── rng.js            seeded mulberry32 (same lineage as tools/) — present but unused by the loop in Phase 1
├── state.js          createState(scenario) + entity constructors (design.md §15.4 subset)
├── actions.js        action constructors + validate-as-they-arrive intake
├── tick.js           tick(state, actions) — pure; the eight §15.6 steps as named functions
├── economy.js        posted-price market, trades, baseline allocation, Syndicate ledger
├── territory.js      ownership / tolls / tariffs / contests — geography-agnostic
├── world-graph.js    the abstract-graph world adapter (Phase 4 swaps in hex behind the same interface)
├── bots.js           tier 1–2 decision functions: botDecide(state) → actions
├── disposition.js    disposition deltas, decay, caps
├── invariants.js     invariants 1/2/3, asserted every tick, halting loudly   ✅
└── serialize.js      canonical stable stringify + hashing for byte-identical determinism checks   ✅

scenarios/            squeeze-check (spreadsheet levers + scripted 12-turn grid) · sandbox
tests/                invariants · determinism · squeeze regression · territory (run against TWO world adapters)
ui/ + index.html      rendering reads state; never the other way
```

Hard rules for anything written here: no DOM access in the loop; integer credits and goods; the word is `guild`; every mutation records its tick; every unsourced constant goes back to the decision checklist instead of into the code.
