# sim/ — the Phase 1 economy engine

Stage 2 is well underway and **the economy runs**. The engine is built one vertical slice at a time (working practice #3), each with its own tripwires; **152 tests pass** (`node --test`).

The spine is the **driver** `run.js`: `advance(state, actions)` = *intake → tick → assert* — apply this window's moves (validate-as-they-arrive, first-valid-wins, §15.6), advance the economy tick, then assert every invariant and halt loudly on a violation, so the invariants hold for the *running loop*, not only the tests. `tick.js` runs the eight §15.6 steps in fixed order; **step 1 (production) is real** — a mining venture extracts `productionRate` units of its `resourceType`, and (03-08-26) a **refining** venture runs a `recipes.js` recipe, consuming a raw good and producing a processed one, throttled by available input so nothing goes negative. Steps 2–8 remain documented no-op seams.

`state.js` holds the entity constructors and `createState`. `actions.js` carries the intake discipline and the concrete play actions: **`foundGuild`** (seats a guild on a real starter homeworld; its credits are **debited from the Syndicate ledger**, so they *move*, not appear) and **`establishVenture`** (mining on a resource node, or refining on a settlement slot). The engine **references the static seed**: a venture's `siteId` resolves through `seed.js` (a read-only window on `data/seed.json`), `occupancy.js` derives the site→venture map (never stored on the site), and the **site-occupancy invariant** asserts every siteId is real, one venture per site, a mining venture matches its node, and a refinery sits on a settlement slot with a resolvable recipe. Territory lives as **claims** (the Citadel + 9 Syndicate outposts + each guild's home), asserted by the claim-integrity and guild-home invariants — **nine invariants** in all, asserted every tick.

Goods are three kinds (`resources.js`): **raw** (minable), **processed** (refined into stockpiles — `alloy_ingots` is the first), and the special **fuel** (reserve/hoards, invariant 1). `supply.js` derives the galactic totals from guild stockpiles (a cache the invariant re-derives and checks). `recipes.js` is the fixed recipe catalog (one recipe so far: `titanium_to_alloy` = 3 titanium → 1 alloy ingot). `snapshot.js` builds the read-only debug-lens view.

On top of the pure engine sits a thin **dev harness**: `server.js` holds ONE in-memory state and exposes the engine over HTTP (`GET /snapshot`, `GET /starters`, `GET /system/:id`, `GET /recipes`, `POST /tick`, `POST /action`, `POST /reset`) with **manual tick**, serving `client/testbed.html` at `GET /`; a `Dockerfile` containers it. The server carries **zero game logic** — every mutation goes through the same `intake`/`advance` the tests guard, so there is one engine and no unowned seam. `scenarios/zero-state.js` is the guild-less tick-0 galaxy it boots into; `node sim/demo.js` watches a galaxy advance from the CLI.

Still ahead in the walking skeleton: **consumption / fuel burn** (step 2, now that Vehicle exists), the **fuel market** (step 3), a **second (bot) guild** for real SHARED contention, and **tolls/shipping** — plus the per-guild homeworld UI (world-dropdown founding, settlement slots, click-a-site to establish a venture). See `docs/roadmap.md`, Phase 1 Stage 2.

Planned layout, from the Stage 1 plan (16-07-26) — ✅ marks what exists:

```
sim/
├── run.js            the driver: advance(state, actions) = intake → tick → assert   ✅
├── state.js          createState(scenario) + entity constructors (Guild, Venture, Vehicle, …)   ✅
├── actions.js        action constructors + validate-as-they-arrive intake   ✅ (foundGuild, establishVenture[mining|refining], paySyndicateFee)
├── tick.js           tick(state, actions) — pure; the eight §15.6 steps as named functions   ✅ (step 1 production real, incl. refining; steps 2–8 stubs)
├── seed.js           read-only window on data/seed.json (resolve a siteId/landmark)   ✅
├── occupancy.js      derived site→venture map (never stored on the site)   ✅
├── resources.js      the good vocabulary: raw + processed + fuel   ✅
├── recipes.js        the recipe catalog (raw→processed conversions)   ✅
├── supply.js         derived galactic-supply totals (Σ stockpiles), a guarded cache   ✅
├── snapshot.js       the read-only debug-lens view of state   ✅
├── invariants.js     the nine invariants, asserted every tick, halting loudly   ✅
├── serialize.js      canonical stable stringify + hashing for determinism checks   ✅
├── server.js         thin dev-harness HTTP server (in-memory, manual tick, serves testbed.html)   ✅
├── demo.js           CLI: watch a galaxy advance   ✅
├── economy.js        posted-price market, trades, baseline allocation           (not yet)
├── territory.js      ownership / tolls / tariffs / contests — geography-agnostic (not yet)
├── world-graph.js    the abstract-graph world adapter (Phase 4 swaps in hex)     (not yet)
├── bots.js           tier 1–2 decision functions: botDecide(state) → actions     (not yet)
└── disposition.js    disposition deltas, decay, caps                             (not yet)

scenarios/            zero-state.js (the guild-less tick-0 galaxy the server boots)   ✅
tests/                17 files, 152 tests: invariants · determinism · actions · refining · server · snapshot · seed · occupancy …   ✅
```

Hard rules for anything written here: no DOM access in the loop; integer credits and goods; the word is `guild`; every mutation records its tick; every unsourced constant goes back to the decision checklist instead of into the code.
