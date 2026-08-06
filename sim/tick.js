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
const { getGoodPolicy, getThrottlePct, hasThrottle } = require('./profile.js');

// Deep-clones state so tick() can never accidentally mutate its input.
// structuredClone is a plain JS global (Node 17+), not a DOM API.
function cloneState(state) {
  return structuredClone(state);
}

// Step 1 — production, routed through §5's THREE GATES from the System Production
// Profile (sim/profile.js). Per guild, per system, in three sub-steps:
//
//   1. MINE: each mining venture deposits `productionRate` of its `resourceType`
//      into the owner's system pool, AND we record it as this tick's FRESH flow.
//   2. ROUTE (Gates 1→3): for each raw good produced fresh this tick, the Gate-1
//      waterfall decides how much refineries may collectively draw (`supplied`),
//      and Gate 3 rations that across the competing consumers into per-refinery
//      draw caps (`alloc`). Gate 2 is the naive full-tilt demand those gates key
//      off. THE ROUTING IS ON FRESH PRODUCTION ONLY — never the accumulated pile.
//   3. RUN: each refinery consumes up to its `alloc` (lockstep across inputs,
//      scaled by its Gate-3 throttle) and produces its output good.
//
// THE SETTLED BEHAVIOUR CHANGE (§5 "never touch the pile"): the forks route only
// THIS tick's fresh production; a refinery the fresh flow can't feed STALLS for
// the tick — it does NOT draw down titanium accumulated on earlier ticks (a
// stockpile-drawdown/buffer mechanism is deferred). Before this slice a refinery
// drew from the whole system pool, so it could ramp off the pile; now it is
// capped at fresh supply. With an ALL-DEFAULT profile this reproduces the old
// FCFS-fed-fully behaviour EXCEPT where a pile would have been drawn — there the
// number legitimately drops.
//
// `Venture.updatedAtTick` records when a venture moved goods (§15.2). Every
// deposit/draw lands in the venture's OWN system pool (ruling B1, §15.2):
// `systemId` is the denormalised site→system copy stamped at establish.
//
// Deliberately NOT yet implemented, left for later slices:
//   - the Syndicate fork (Gate 1) delivers nothing: `commitment` is Σ producers'
//     `syndicateCommitment`, 0 for every venture today (no licences) — the fork
//     is STRUCTURED but wires no delivery (slice 3). When it is non-zero, its
//     take must LEAVE the pool (addStock −); flagged inline where it would.
//   - per-venture `inputStockpiles` buffers, and crediting guild.lifetimeProduced
//     (§13) — unchanged from before, wired when a consumer needs them.
//   - ventures draw no fuel (renewable-powered, §3 / open question #54).
//
// DETERMINISM (invariant 9): every iteration order is fixed — guilds in array
// order, systems by sorted systemId, goods by sorted name, consumers in
// establishment (guild.ventures) order, and the proportional rounding remainder
// handed out in establishment order. No plain-object key order feeds any number.
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
      produceInSystem(state, guild, sys, ventures);
    }
  }
  return state;
}

// One (guild, system): mine fresh output, route it through the gates, run the
// refineries. Mutates the guild's system pool in place (tick() already cloned
// state, so this never touches the caller's input).
function produceInSystem(state, guild, sys, ventures) {
  // --- Sub-step 1: mine fresh raw output into the pool; track THIS tick's flow.
  const fresh = {}; // good -> units produced this tick in this system (routing basis)
  for (const v of ventures) {
    if (v.systemId !== sys || !v.productionRate || !v.resourceType) continue;
    addStock(guild, sys, v.resourceType, v.productionRate);
    fresh[v.resourceType] = (fresh[v.resourceType] || 0) + v.productionRate;
    v.updatedAtTick = state.tick;
  }

  // Refineries in this system, in establishment order (their order in ventures).
  const refineries = ventures.filter((v) => v.systemId === sys && v.recipeId && v.productionRate);

  // --- Sub-step 2: route each fresh raw good into per-refinery draw caps.
  // alloc[ventureId][good] = units of `good` refinery `ventureId` may draw this tick.
  const alloc = {};
  for (const good of Object.keys(fresh).sort()) {
    const freshG = fresh[good];
    if (freshG <= 0) continue;

    // Consumers of `good`: refineries whose recipe lists it as an input, with that
    // input's per-batch qty — in establishment order.
    const consumers = [];
    for (const c of refineries) {
      const recipe = getRecipe(c.recipeId);
      if (!recipe) continue; // dangling recipeId — the occupancy invariant halts on it
      const inp = recipe.inputs.find((i) => i.good === good);
      if (inp) consumers.push({ venture: c, qty: inp.qty });
    }
    // Fresh good with no consumer this system: nothing to route — it all stays in
    // the pool (the Stockpile fork's catch-all). Also covers a `goods` policy set
    // for a good with no producer here (fresh 0 never reaches this loop at all).
    if (consumers.length === 0) continue;

    // Gate 2 — naive full-tilt demand. Each consumer's demand uses its RATED
    // productionRate (NOT its throttle) and does not shrink if it will run slow for
    // other reasons — a stable figure the Downstream cap keys off.
    let demandTotal = 0;
    for (const { venture, qty } of consumers) demandTotal += venture.productionRate * qty;

    // Gate 1 — pour freshG through the forks in the policy order; compute `supplied`
    // (the collective draw cap for downstream). Each fork takes from what remains.
    const policy = getGoodPolicy(guild, sys, good);
    // Σ producers' committed output — the Syndicate fork's amount. 0 for every
    // venture today (no licences); structured so slice 3 wires delivery here.
    let commitment = 0;
    for (const v of ventures) {
      if (v.systemId === sys && v.resourceType === good) commitment += v.syndicateCommitment || 0;
    }
    let supplied = 0;
    let remaining = freshG;
    policy.order.forEach((fork, i) => {
      if (fork === 'syndicate') {
        // Leaves the pool for the Syndicate. 0 today, so no pool op; when
        // commitment > 0 this take must be removed via addStock(−) — slice 3.
        remaining -= Math.min(commitment, remaining);
      } else if (fork === 'downstream') {
        const cap = Math.floor((demandTotal * policy.downstreamPct) / 100);
        supplied = Math.min(cap, remaining);
        remaining -= supplied;
      } else if (fork === 'stockpile') {
        // The take STAYS in the pool (it was deposited in sub-step 1), so we only
        // decrement `remaining`. Last fork = catch-all (absorbs everything left);
        // otherwise a floor set as a % of fresh production or a flat quantity.
        const isLast = i === policy.order.length - 1;
        const amt = isLast
          ? remaining
          : (policy.stockpile.mode === 'percent'
            ? Math.floor((freshG * policy.stockpile.value) / 100)
            : policy.stockpile.value);
        remaining -= Math.min(amt, remaining);
      }
    });
    // never-touch-the-pile falls out here: supplied ≤ freshG, so refinery draws
    // (bounded by supplied) can never exceed this tick's fresh production.

    // Gate 3 — distribute `supplied` across consumers into per-venture draw caps.
    // Regime: FCFS unless SOME consumer has a throttle explicitly set (a throttle
    // of 100 counts as set — hence hasThrottle, not the value).
    const anyThrottled = consumers.some(({ venture }) => hasThrottle(guild, sys, venture.id));
    if (!anyThrottled) {
      // FCFS in establishment order: each takes min(its full demand, what's left).
      let rem = supplied;
      for (const { venture, qty } of consumers) {
        const give = Math.min(venture.productionRate * qty, rem);
        (alloc[venture.id] || (alloc[venture.id] = {}))[good] = give;
        rem -= give;
      }
    } else {
      // Proportional: each consumer's THROTTLED ask; scale down together if the
      // asks exceed what arrived, remainder to the earliest-established line.
      const asks = consumers.map(({ venture, qty }) =>
        Math.floor((venture.productionRate * getThrottlePct(guild, sys, venture.id)) / 100) * qty);
      const askTotal = asks.reduce((a, b) => a + b, 0);
      let give;
      if (askTotal <= supplied) {
        give = asks; // everyone gets their throttled ask; any surplus stays in pool
      } else {
        give = asks.map((ask) => Math.floor((supplied * ask) / askTotal));
        let remainder = supplied - give.reduce((a, b) => a + b, 0);
        for (let idx = 0; remainder > 0; idx = (idx + 1) % consumers.length) {
          give[idx] += 1;
          remainder -= 1;
        }
      }
      consumers.forEach(({ venture }, idx) => {
        (alloc[venture.id] || (alloc[venture.id] = {}))[good] = give[idx];
      });
    }
  }

  // --- Sub-step 3: refineries run — consume allocated inputs, produce output.
  for (const c of refineries) {
    const recipe = getRecipe(c.recipeId);
    if (!recipe) continue;
    // The throttle scales the line's own rate (default 100 → full rate). Batches
    // are then capped in LOCKSTEP by the scarcest allocated input (floor per input),
    // so a multi-input line runs at one rate — as before, but bounded now by the
    // Gate-3 allocation rather than the whole pool.
    let batches = Math.floor((c.productionRate * getThrottlePct(guild, sys, c.id)) / 100);
    for (const inp of recipe.inputs) {
      const allocated = (alloc[c.id] && alloc[c.id][inp.good]) || 0;
      batches = Math.min(batches, Math.floor(allocated / inp.qty));
    }
    if (batches <= 0) continue; // starved this tick: no goods move. Unused alloc stays in pool.
    for (const inp of recipe.inputs) {
      addStock(guild, sys, inp.good, -batches * inp.qty);
    }
    addStock(guild, sys, recipe.output.good, batches * recipe.output.qty);
    c.updatedAtTick = state.tick;
  }
  // Sub-step 4 (processed goods): a refinery's output is now in the pool. No recipe
  // consumes a processed good today (every recipe input is raw — verified), so its
  // Gate-1 routing is trivial (demand 0, everything stays in the pool). When
  // processed goods gain consumers, they route through this SAME per-good Gate-1
  // logic within the tick, raw goods first then processed — no change needed here
  // beyond having deposited the output above.
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
