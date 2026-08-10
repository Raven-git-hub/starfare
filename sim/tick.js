'use strict';

// tick.js — the pure economy step: the fixed eight-step order from
// design.md §15.6, as eight named functions. Being filled in one pillar at a
// time (working practice #3) rather than all at once, so each pillar is a
// real, individually-tested fact rather than a batch of invented behavior.
//
// Landed so far: step 1, production (the simplest possible cut -- see its
// own comment below for exactly what it does and doesn't do yet). Steps
// 2-8 are still `identity` — explicit NAMED no-ops — because their real
// logic needs modules that don't exist yet (economy.js, territory.js,
// bots.js — see sim/README.md's planned layout). Their seam already sits in
// the right place, in the right order, instead of being invented ad hoc
// whenever that module lands.
//
// What IS real about this file, even where a step is still a stub:
//   - the ORDER is fixed and correct per §15.6, so invariant 9 (deterministic
//     tick order) has something true to hold onto as soon as steps start
//     doing something
//   - tick() is pure: it never mutates its `state` argument, always returns
//     a new state object
//   - no DOM access anywhere (the hard rule in sim/README.md)

const { computeGalacticSupply } = require('./supply.js');
const { getRecipe } = require('./recipes.js');
const { addStock } = require('./stock.js');
const { resolveProduction } = require('./production.js');
const { setWindow } = require('./windows.js');

// Deep-clones state so tick() can never accidentally mutate its input.
// structuredClone is a plain JS global (Node 17+), not a DOM API.
function cloneState(state) {
  return structuredClone(state);
}

// Step 1 — production, routed through §5's THREE GATES from the System Production
// Profile, now in the RATE-BASED model (§5 "Engine rewrite", 10-08-26). The gate
// ARITHMETIC lives in ONE pure function, `resolveProduction(guild, systemId)`
// (sim/production.js) — see §5 "the resolved numbers come from the engine, never
// the browser". This step is the APPLY half: it asks the resolver what production
// does this tick, then MOVES the goods to match. The read-only `previewProduction`
// selector (also sim/production.js, surfaced through the snapshot) asks the SAME
// resolver, so the displayed numbers and the moved numbers can never drift.
//
// Per guild, per system (deterministic order), the resolver's report says:
//   - `mines`: each producing mine's fresh deposit (good + amount).
//   - `lines`: per consuming line per input, the whole units `drawn` this tick (the
//     `floor` of its per-good carry — ≤ its Gate-3 `alloc`, which only bounds the
//     rate). The undrawn surplus of a non-binding input stays in the pool.
//   - `refineries`: each line's continuous `rate`, its whole-unit `minted` output,
//     and its NEW `batchCarry` (the per-good remainder map to write back, §5
//     Correction).
// Applying it is pure bookkeeping: deposit each mine's fresh, subtract each line's
// `drawn`, add each refinery's `minted`, write back `Venture.batchCarry`, and deliver
// each good's `fork.syndicate` to the sink. Non-negativity (invariant 3) holds BY
// CONSTRUCTION (§5 one-pot, Slice A): the pot = start-of-step reserve + fresh, and
// every claimant's take (reserve held, consumer draw, syndicate delivery) is ≤ the
// `available` at its priority slot, so the pot ends at ≥ 0 (down to the held reserve).
//
// `Venture.updatedAtTick` records when a venture moved goods (§15.2). Every
// deposit/draw lands in the venture's OWN system pool (ruling B1, §15.2):
// `systemId` is the denormalised site→system copy stamped at establish.
//
// Deliberately NOT yet implemented, left for later slices (all inert in the
// resolver too): the Syndicate fork delivers nothing (`syndicateCommitment` is 0
// for every venture — slice 3); per-venture `inputStockpiles` buffers and
// crediting guild.lifetimeProduced (§13); ventures draw no fuel (§3 / #54).
//
// DETERMINISM (invariant 9): the iteration order is fixed here — guilds in array
// order, systems by sorted systemId (the resolver fixes goods/consumer order
// internally). No plain-object key order feeds any number.
function stepProduction(state, _actions) {
  for (const guild of state.guilds) {
    const ventures = guild.ventures || [];
    // Systems this guild produces in, in a deterministic order. A synthetic test
    // venture with no seat keeps its `systemId` (null) as its pool key — exactly as
    // before, when a null systemId deposited into a null-keyed pool — so we do NOT
    // drop it. Sorted by String coercion so null/undefined order deterministically
    // ("null"/"undefined") without relying on sort's undefined-to-end quirk.
    const systemIds = [...new Set(ventures.map((v) => v.systemId))]
      .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    for (const sys of systemIds) {
      applyProduction(state, guild, sys);
    }
  }
  return state;
}

// One (guild, system): resolve production, then MOVE the goods to match the
// report. This is the ONLY place addStock is called for production. Mutates the
// guild's system pool (and each refinery's batchCarry) in place — tick()
// already cloned state, so this never touches the caller's input. The resolver
// reads the pool balance + accumulators (start-of-step) and mutates nothing.
function applyProduction(state, guild, systemId) {
  // The producing tick is state.tick + 1 (the tick number of the state this step
  // yields), and the window length is the engine-wide state.windowN — passed so the
  // resolver's windowed-accrual send matches what previewProduction reports for the
  // same advance (anti-drift). Both are read only for a good carrying a commitment.
  const report = resolveProduction(guild, systemId, { tick: state.tick + 1, windowN: state.windowN });
  const byId = new Map((guild.ventures || []).map((v) => [v.id, v]));

  // Deposit each mine's fresh output into the pool; stamp the mine's tick.
  for (const m of report.mines) {
    addStock(guild, systemId, m.good, m.amount);
    byId.get(m.ventureId).updatedAtTick = state.tick;
  }

  // Draw each consuming line's whole `drawn` units from the pool. A non-binding
  // input is under-drawn, so its surplus simply stays put — there is no refund.
  for (const line of report.lines) {
    if (line.drawn > 0) addStock(guild, systemId, line.good, -line.drawn);
  }

  // Mint each refinery's whole-unit output and write back its advanced per-good
  // carry map (§5 Correction). A starved line (rate 0) draws/mints nothing, but its
  // carry map is unchanged by the resolver, so writing it back is a harmless no-op —
  // still, only a line that ran is stamped (matching the old `if rate<=0 continue`).
  for (const r of report.refineries) {
    if (r.rate <= 0) continue;
    const v = byId.get(r.ventureId);
    v.batchCarry = r.batchCarry;
    if (r.minted > 0) {
      const recipe = getRecipe(v.recipeId);
      addStock(guild, systemId, recipe.output.good, r.minted);
    }
    v.updatedAtTick = state.tick;
  }

  // Deliver the Gate-1 Syndicate fork (§5 "Syndicate fork delivery", 10-08-26):
  // remove each good's committed units from the pool — they leave the guild and sink
  // into the Syndicate's infinite backend (no receiving entity; invariants.js's
  // galactic-supply check already treats selling as a sink, not a conservation
  // break). Instant/per-tick, full commitment, no buffer/fee/breach (licence layer,
  // later). Goods are iterated in sorted key order for determinism (invariant 9);
  // fork.syndicate is 0 for every unlicensed venture, so this is a no-op today.
  for (const good of Object.keys(report.goods).sort()) {
    const delivered = report.goods[good].fork.syndicate;
    if (delivered > 0) addStock(guild, systemId, good, -delivered);
  }

  // Write back the §5 windowed-accrual state (guild.syndicateWindows) for each
  // committed good — the running `delivered`, the re-stamped `windowStart` on a roll,
  // and the fractional `sendCarry`. Only a good with a `window` entry (Q > 0) is
  // touched, so an unlicensed guild never gets a syndicateWindows key: the no-op path
  // stays byte-identical (the determinism-hash no-op proof). Goods iterated in sorted
  // order for determinism (invariant 9), matching the delivery loop above.
  for (const good of Object.keys(report.goods).sort()) {
    const w = report.goods[good].window;
    if (w) setWindow(guild, systemId, good, { windowStart: w.windowStart, delivered: w.delivered, sendCarry: w.sendCarry });
  }
}

// Step 2 — consumption. SEAM for spacecraft fuel burn against the shared
// allocation pool (docs/fuel-allocation-model.md) once Shipments/Vehicles
// exist. Ventures are NOT consumers here: production is renewable-powered
// and draws no Deuterium (§3 / open question #54).
function stepConsumption(state, _actions) {
  return state;
}

// Step 3 — price recompute. Publishes the posted price governing the NEXT
// action window (§8, decided #42). SEAM: no market/price fields exist on
// state yet — state.js only carries reserve.reserveLevel so far.
function stepPriceRecompute(state, _actions) {
  return state;
}

// Step 4 — scheduled events. Anything with a due-tick (contest-window
// closures now; the change calculator's interceptions later, §15.6).
// SEAM: no scheduled events exist yet — no territory/contests built.
function stepScheduledEvents(state, _actions) {
  return state;
}

// Step 5 — arrivals. Shipments that reach their destination this tick.
// SEAM: state.shipments is always empty until routes exist (Phase 1 Stage 3+).
function stepArrivals(state, _actions) {
  return state;
}

// Step 6 — baseline allocation. The flat per-guild income (guild.incomeRate).
// SEAM: needs a ruling on where the credits come from (minted vs. paid from
// the Syndicate ledger — see invariants.js's comment on expectedCreditTotal).
function stepBaselineAllocation(state, _actions) {
  return state;
}

// Step 7 — storyteller. Reads signals, may fire an event (design.md §9).
// SEAM: no storyteller exists yet (Phase 6).
function stepStoryteller(state, _actions) {
  return state;
}

// Step 8 — vote closures. Council votes whose window has closed resolve.
// SEAM: no Council exists yet (Phase 5).
function stepVoteClosures(state, _actions) {
  return state;
}

// The fixed order itself — the one piece of this file design.md actually
// requires to be correct FROM THE START, even while every step above is
// still a stub. Changing this array's order is changing the tick contract
// (§15.6); it is exported below so a test can pin the order down directly.
const STEPS = [
  stepProduction,
  stepConsumption,
  stepPriceRecompute,
  stepScheduledEvents,
  stepArrivals,
  stepBaselineAllocation,
  stepStoryteller,
  stepVoteClosures,
];

// tick(state, actions) — pure. Returns a NEW state; never mutates `state`.
// `actions` isn't consumed by anything yet (every step ignores it) — the
// parameter is here because the eventual step functions need it, and
// actions.js (validate-as-they-arrive intake) is Stage 2's next piece.
function tick(state, actions = []) {
  if (!state) throw new Error('tick: state is required');
  if (!Array.isArray(actions)) throw new Error('tick: actions must be an array');

  let next = cloneState(state);
  for (const step of STEPS) {
    next = step(next, actions);
  }
  next.tick = state.tick + 1;

  // Derive pass, NOT a §15.6 step: refresh the galactic-supply cache from the
  // state the eight steps just produced. Kept out of the STEPS array on purpose
  // — it computes nothing new about the game, it only re-totals what already
  // happened, and invariants.js asserts it matches. (The eight-step order is a
  // contract; this derivation is bookkeeping that runs after it.)
  next.galacticSupply = computeGalacticSupply(next);

  return next;
}

module.exports = { tick, STEPS };
