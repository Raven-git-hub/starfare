# sim/ — the Phase 1 economy engine

Stage 2 has started. The decision checklist is answered (19-07-26, `docs/phase-1-tuning.md`) and the **invariant harness has landed** — `invariants.js` (invariants 1/2/3 + the §15.2 integer convention, asserted every tick) and `serialize.js` (canonical stringify + hashing for the determinism check), both under `tests/`. **`state.js` has landed** — entity constructors (Guild, Venture, Reserve, Syndicate) plus `createState(scenario)`, the one-time tick-0 bootstrap; it holds no game-balance numbers of its own. **`tick.js` landed as a scaffold and is now being filled in pillar by pillar**: `tick(state, actions)` is pure and runs the eight §15.6 steps in their fixed order; **step 1, production, is now real** — each venture's `outputStockpile` grows by its `productionRate` every tick, and `Venture.updatedAtTick` records when (§15.2's "every mutation records its tick"). Steps 2–8 remain documented no-op seams, each waiting on a module that doesn't exist yet (`economy.js`, `territory.js`, `bots.js`). **`actions.js` has landed too, also deliberately thin** — the validate-as-they-arrive intake discipline (state-as-it-stands, first-valid-wins) is real and tested directly against §15.6's own worked example (three "spend 80" orders on 100 credits — only the first is accepted), but there is exactly ONE concrete action type so far (`paySyndicateFee`, a guild paying credits to the Syndicate ledger) — every other action type (orders, tolls, votes, claims) waits for the module that would give it an effect. Still to come: consumption/energy (step 2), the fuel market (step 3), and the rest of the walking skeleton's starting scenario (2 guilds, one venture each, per `docs/phase-1-tuning.md`) (see `docs/roadmap.md`, Phase 1 Stage 2).

Planned layout, from the Stage 1 plan (16-07-26) — ✅ marks what exists:

```
sim/
├── rng.js            seeded mulberry32 (same lineage as tools/) — present but unused by the loop in Phase 1
├── state.js          createState(scenario) + entity constructors (design.md §15.4 subset)   ✅
├── actions.js        action constructors + validate-as-they-arrive intake   ✅ (one action type: paySyndicateFee)
├── tick.js           tick(state, actions) — pure; the eight §15.6 steps as named functions   ✅ (step 1, production, real; steps 2–8 stubs)
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
