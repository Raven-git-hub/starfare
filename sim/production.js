'use strict';

// production.js — the ONE place §5's three-gate arithmetic lives.
//
// `resolveProduction(guild, systemId)` is a PURE resolver: given a guild and one
// of its systems, it computes — but does NOT move — what production does this
// tick. It returns a plain report. Two callers share it, which is the whole point
// (design.md §5 "the resolved numbers come from the engine, never the browser",
// ruled 07-08-26):
//   - `stepProduction` (sim/tick.js) APPLIES the report — it deposits each mine's
//     fresh output, subtracts each line's `consumed`, mints each refinery's whole
//     output and advances its carry, and is the only place goods actually move.
//   - `previewProduction` (below) REPORTS the report — a read-only selector the
//     snapshot carries so the interactive Production view shows engine truth.
// Because both go through this single function they cannot drift: a preview can
// never disagree with what the tick will do, by construction.
//
// WHAT THE RESOLVER READS (§5 rate-based rewrite, 10-08-26 — supersedes the old
// floor-batches resolver): the profile (via sim/profile.js), the ventures, their
// per-venture `outputAccumulator` (the fractional output carry), AND the stockpile
// pool BALANCE as it stands at the START of this tick's production step (Ruling 3).
// The pool read is the documented departure from the old resolver's "reads NOTHING
// from the pool": the stockpile drawdown needs the current balance to know how far
// a consumer may draw. It is still a PURE, side-effect-free function — it reads
// current state and mutates nothing; the balance is start-of-step state, not a
// mutation observed mid-resolve. This tick's own Gate-1 stockpile deposit and
// Gate-3 spill land at APPLY (stepProduction) and are drawable NEXT tick.
//
// THE MODEL, in one breath (design.md §5 "Engine rewrite — rate-based resolution"
// and its "Rulings — composition, carry, ordering"): a consuming line runs at a
// CONTINUOUS rate set by its scarcest input (no `floor(batches)` — so a 67% line
// genuinely runs at 67%, never stalling at 0). The good's pool that Gate 3 rations
// is the Downstream fork's fresh take PLUS the drawable stockpile (balance −
// reserveFloor); one proportional split feeds both fresh and drawn-down shortfall
// (Ruling 1). Integers stay exact via a balancer — `consumed = round(rate × qty)`,
// `spill = alloc − consumed` (≥ 0 by construction) — and the whole-unit output is
// minted through the venture's `outputAccumulator` so a fractional rate never
// strands output. The one non-integer (the rate) is transient; the one persisted
// fraction (the accumulator) is fenced in [0, 1) with its own tripwire.

const { getRecipe } = require('./recipes.js');
const { getStock } = require('./stock.js');
const {
  getGoodPolicy, getThrottlePct, hasThrottle, storedThrottleIds, storedPolicyGoods,
} = require('./profile.js');

// resolveProduction(guild, systemId) -> a plain report for that (guild, system):
//   {
//     systemId,
//     mines:      [ { ventureId, good, amount } ],   // each producing mine's fresh deposit
//     goods:      { [good]: { fresh, demand, fork: { syndicate, downstream, stockpile },
//                             supplied, drawable, pool } },
//     lines:      [ { ventureId, good, demand, alloc, consumed, spill } ],  // per consuming line, per input
//     refineries: [ { ventureId, rate, bottleneckGood, minted, accumulator } ],
//   }
// GOOD-LEVEL integers: `demand` is the Gate-2 naive full-tilt Σ (rated, not
// throttled — the stable Downstream cap figure); `supplied` is the Downstream
// fork's fresh take (= fork.downstream, ≤ fresh); `drawable` is the stockpile
// above its reserve floor (start-of-step); `pool` = supplied + drawable is what
// Gate 3 rations (Ruling 1 — the drawdown folds in here, one split for fresh and
// drawn-down alike). LINE-LEVEL integers: `demand` = that line's full-tilt draw
// for the input (rate × input-qty), `alloc` = the integer units Gate 3 handed it,
// `consumed`/`spill` the balancer split (consumed + spill = alloc, by construction).
// REFINERY-LEVEL: `rate` is the CONTINUOUS batches/tick the line runs (a float —
// transient telemetry, never serialized, Ruling 2); `bottleneckGood` is the input
// that set the min (the scarcest, by definition — no search); `minted` is the
// whole output units produced this tick; `accumulator` is the venture's NEW
// outputAccumulator (in [0, 1)) after minting, which stepProduction writes back.
//
// The null/undefined system is handled EXACTLY as stepProduction does: a venture
// with no seat keeps its `systemId` (undefined/null) as its key, and the strict
// `=== systemId` filter includes it when systemId is that same value — so a
// seatless mine resolves without crashing and is never dropped.
function resolveProduction(guild, systemId) {
  const ventures = (guild.ventures || []).filter((v) => v.systemId === systemId);

  // --- Mines: this tick's fresh raw output (the routing basis), per producing
  // mine and aggregated per good. Order is establishment order (ventures order),
  // matching the deposit order stepProduction has always used.
  const mines = [];
  const fresh = {}; // good -> units produced fresh this tick in this system
  for (const v of ventures) {
    if (!v.productionRate || !v.resourceType) continue;
    mines.push({ ventureId: v.id, good: v.resourceType, amount: v.productionRate });
    fresh[v.resourceType] = (fresh[v.resourceType] || 0) + v.productionRate;
  }

  // Refineries in this system, in establishment order.
  const refineryVentures = ventures.filter((v) => v.recipeId && v.productionRate);

  // Goods to route: everything mined fresh here PLUS every good some in-system
  // refinery consumes — the latter so a good with NO local mine can still be fed by
  // the stockpile drawdown (§5 rewrite: a titanium_alloy line runs off a bought-in
  // carbon pile with no carbon mine). Sorted for determinism (invariant 9).
  const goodsToRoute = new Set(Object.keys(fresh));
  for (const c of refineryVentures) {
    const recipe = getRecipe(c.recipeId);
    if (!recipe) continue; // dangling recipeId — the occupancy invariant halts on it
    for (const inp of recipe.inputs) goodsToRoute.add(inp.good);
  }

  // --- Route each good through Gates 1→3 into per-line integer allocations.
  const goods = {};
  const lines = [];
  const alloc = {}; // ventureId -> good -> integer units allocated this tick

  for (const good of [...goodsToRoute].sort()) {
    const freshG = fresh[good] || 0;

    // Consumers of `good`: refineries whose recipe lists it as an input, with that
    // input's per-batch qty — in establishment order.
    const consumers = [];
    for (const c of refineryVentures) {
      const recipe = getRecipe(c.recipeId);
      if (!recipe) continue;
      const inp = recipe.inputs.find((i) => i.good === good);
      if (inp) consumers.push({ venture: c, qty: inp.qty });
    }
    // A fresh good nobody consumes here: nothing to route — it all stays in the
    // pool (the Stockpile fork's catch-all). No `goods` entry (no downstream figure).
    if (consumers.length === 0) continue;

    // Gate 2 — naive full-tilt demand: Σ rated rate × input-qty. Uses the RATED
    // productionRate, not the throttle, so it is the stable figure the Downstream
    // cap keys off (§5). Effective (cross-input) demand is realised NOT here but by
    // the per-line min-rate balancer below: a line held by a scarce partner input
    // consumes less of this good and spills the rest back.
    let demandTotal = 0;
    for (const { venture, qty } of consumers) demandTotal += venture.productionRate * qty;

    // Gate 1 — pour freshG through the forks in the policy order; record each
    // fork's take and compute `supplied` (the Downstream fresh take, ≤ fresh).
    const policy = getGoodPolicy(guild, systemId, good);
    // Σ producers' committed output — the Syndicate fork's amount. 0 for every
    // venture today (no licences); structured so slice 3 wires delivery here.
    let commitment = 0;
    for (const v of ventures) {
      if (v.resourceType === good) commitment += v.syndicateCommitment || 0;
    }
    const fork = { syndicate: 0, downstream: 0, stockpile: 0 };
    let supplied = 0;
    let remaining = freshG;
    policy.order.forEach((f, i) => {
      if (f === 'syndicate') {
        const take = Math.min(commitment, remaining);
        fork.syndicate = take;
        remaining -= take;
      } else if (f === 'downstream') {
        const cap = Math.floor((demandTotal * policy.downstreamPct) / 100);
        supplied = Math.min(cap, remaining);
        fork.downstream = supplied;
        remaining -= supplied;
      } else if (f === 'stockpile') {
        // Last fork = catch-all (absorbs everything left); otherwise a floor set as
        // a % of fresh production or a flat quantity. The take stays in the pool
        // either way (the apply step never removes it), so the resolver only tracks
        // the figure — it moves nothing.
        const isLast = i === policy.order.length - 1;
        const amt = isLast
          ? remaining
          : (policy.stockpile.mode === 'percent'
            ? Math.floor((freshG * policy.stockpile.value) / 100)
            : policy.stockpile.value);
        const take = Math.min(amt, remaining);
        fork.stockpile = take;
        remaining -= take;
      }
    });

    // Ruling 1 — the stockpile drawdown FOLDS INTO Gate 3. The pool consumers
    // ration is the Downstream fresh take PLUS the drawable stockpile: the balance
    // at start-of-step (Ruling 3) minus the reserve floor. One combined pool, one
    // proportional split — never a per-line race down the pile (the rejected 8/2;
    // the ruled 5/5). Because supplied ≤ fresh and drawable ≤ balance − floor, the
    // apply can draw the pile down to exactly the floor and no further (invariant 3
    // holds by construction — see stepProduction).
    const startBalance = getStock(guild, systemId, good);
    const drawable = Math.max(0, startBalance - policy.reserveFloor);
    const pool = supplied + drawable;

    // Gate 3 — ration `pool` across consumers into integer per-line allocations.
    // Regime unchanged: FCFS in establishment order unless SOME consumer of this
    // good has a throttle explicitly set (a throttle of 100 counts as set — hence
    // hasThrottle, not the value), in which case the split is proportional.
    const anyThrottled = consumers.some(({ venture }) => hasThrottle(guild, systemId, venture.id));
    let give;
    if (!anyThrottled) {
      // FCFS in establishment order: each takes min(its full demand, what's left).
      give = [];
      let rem = pool;
      for (const { venture, qty } of consumers) {
        const g = Math.min(venture.productionRate * qty, rem);
        give.push(g);
        rem -= g;
      }
    } else {
      // Proportional to each line's THROTTLED demand — continuous, so a rate-1 line
      // at 67% is NOT floored to a 0 ask (the floor-batches stall this rewrite
      // kills). Allocate min(pool, Σ ceil(want)) integer units split by the real
      // wants; the integer remainder goes to the earliest-established line
      // (invariant 9). Capping at Σ ceil(want) stops an abundant pool from
      // over-handing a line more than it can use (the surplus just stays put).
      const wants = consumers.map(({ venture, qty }) =>
        (getThrottlePct(guild, systemId, venture.id) / 100) * venture.productionRate * qty);
      const wantTotal = wants.reduce((a, b) => a + b, 0);
      const capTotal = wants.reduce((a, b) => a + Math.ceil(b), 0);
      const toAllocate = Math.min(pool, capTotal);
      if (wantTotal <= 0) {
        give = wants.map(() => 0);
      } else {
        give = wants.map((w) => Math.floor((toAllocate * w) / wantTotal));
        let remainder = toAllocate - give.reduce((a, b) => a + b, 0);
        for (let idx = 0; remainder > 0; idx = (idx + 1) % consumers.length) {
          give[idx] += 1;
          remainder -= 1;
        }
      }
    }
    consumers.forEach(({ venture, qty }, idx) => {
      (alloc[venture.id] || (alloc[venture.id] = {}))[good] = give[idx];
      lines.push({ ventureId: venture.id, good, demand: venture.productionRate * qty, alloc: give[idx] });
    });

    goods[good] = { fresh: freshG, demand: demandTotal, fork, supplied, drawable, pool };
  }

  // --- Refineries: each runs at a CONTINUOUS rate = min(its throttle cap, the
  // scarcest input's batch capacity alloc/qty). NO floor(batches). The balancer
  // then makes goods exact per input: consumed = round(rate × qty), spill = alloc −
  // consumed (≥ 0, since rate ≤ alloc/qty). Output is minted through the venture's
  // outputAccumulator, so a fractional rate accrues instead of stalling.
  const refineries = [];
  const consumedByLine = {}; // ventureId -> good -> integer units consumed
  for (const c of refineryVentures) {
    const recipe = getRecipe(c.recipeId);
    if (!recipe) continue;
    const throttleCap = (getThrottlePct(guild, systemId, c.id) / 100) * c.productionRate;
    // The scarcest input sets the rate; that input IS the bottleneck (no search —
    // it is the min by definition, §5). Ties resolve to the first input in recipe
    // order (a fixed, frozen array — deterministic).
    let inputCap = Infinity;
    let bottleneckGood = null;
    for (const inp of recipe.inputs) {
      const allocated = (alloc[c.id] && alloc[c.id][inp.good]) || 0;
      const cap = allocated / inp.qty;
      if (cap < inputCap) { inputCap = cap; bottleneckGood = inp.good; }
    }
    const rate = Math.min(throttleCap, inputCap);

    const consumed = {};
    for (const inp of recipe.inputs) consumed[inp.good] = Math.round(rate * inp.qty);
    consumedByLine[c.id] = consumed;

    // Mint the whole-unit output; carry the sub-unit remainder in [0, 1).
    const carry = c.outputAccumulator || 0;
    const raw = carry + rate * recipe.output.qty;
    const minted = Math.floor(raw);
    const accumulator = raw - minted;

    refineries.push({ ventureId: c.id, rate, bottleneckGood, minted, accumulator });
  }

  // Back-fill each line's consumed/spill from its refinery's resolved rate, so the
  // report itself carries the balancer identity (consumed + spill = alloc).
  for (const line of lines) {
    const consumed = (consumedByLine[line.ventureId] || {})[line.good] || 0;
    line.consumed = consumed;
    line.spill = line.alloc - consumed;
  }

  return { systemId, mines, goods, lines, refineries };
}

// reviewSystem(guild, systemId) -> the §5 "review flag": a deterministically
// sorted list of issue objects telling the player where their stored profile has
// stopped cleanly covering reality. READ-ONLY telemetry on the preview path only —
// it moves no goods and is NOT consulted by resolveProduction/stepProduction, so
// it can never change production output. The engine flags; it never rewrites the
// player's stored intent (§5, §15.4).
//
// Three triggers, matching §5's ruling exactly:
//   (a) stale_throttle    — a stored throttle names a venture no longer in S.
//   (b) stale_good_policy — a stored `goods` policy is for a good S no longer produces.
//   (c) unmanaged_surplus — a RAW mined good with no in-system consumer AND no policy
//                           set (the "you have unallocated titanium, go set it" nudge).
// Deliberately NOT flagged (d): a consumer the player chose to starve (a downstream
// cap / stockpile floor / throttle) — chosen scarcity is intent, not an oversight.
// Because (c) fires only for RAW goods, a processed refinery output that nothing
// consumes never flags (piling processed output is a normal, unmanaged-by-design state).
function reviewSystem(guild, systemId) {
  const ventures = (guild.ventures || []).filter((v) => v.systemId === systemId);
  const ventureIds = new Set(ventures.map((v) => v.id));

  // Derive what S actually produces/consumes from the current ventures + recipes.
  const mineGoods = new Set();       // raw goods mined in S
  const refOutputs = new Set();      // processed goods refined in S
  const consumedInputs = new Set();  // goods some refinery in S lists as a recipe input
  for (const v of ventures) {
    if (v.resourceType) {
      mineGoods.add(v.resourceType);
    } else if (v.recipeId) {
      const recipe = getRecipe(v.recipeId);
      if (!recipe) continue; // dangling recipeId — the occupancy invariant halts on it
      refOutputs.add(recipe.output.good);
      for (const inp of recipe.inputs) consumedInputs.add(inp.good);
    }
  }
  const producedGoods = new Set([...mineGoods, ...refOutputs]);
  const policyGoods = new Set(storedPolicyGoods(guild, systemId));

  const issues = [];
  // (a) a throttle for a venture that has since been removed from S.
  for (const id of storedThrottleIds(guild, systemId)) {
    if (!ventureIds.has(id)) issues.push({ kind: 'stale_throttle', ventureId: id });
  }
  // (b) a `goods` policy for a good S no longer produces.
  for (const good of storedPolicyGoods(guild, systemId)) {
    if (!producedGoods.has(good)) issues.push({ kind: 'stale_good_policy', good });
  }
  // (c) a raw good produced here that nothing consumes and no policy covers.
  for (const good of mineGoods) {
    if (!consumedInputs.has(good) && !policyGoods.has(good)) {
      issues.push({ kind: 'unmanaged_surplus', good });
    }
  }

  // Sort by (kind, ventureId|good) so the list is deterministic (invariant 9).
  issues.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const ak = a.ventureId || a.good;
    const bk = b.ventureId || b.good;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return issues;
}

// previewProduction(state) -> read-only display telemetry, per guild → per system.
// Iterates every guild and system in the SAME deterministic order stepProduction
// uses (guilds in array order; systems sorted by String-coerced systemId, so the
// null/undefined seatless system is included, not dropped) and calls the SAME
// resolveProduction. Pure: reads state, mutates nothing, and — being derived
// telemetry — adds nothing to serialized state or the determinism hash.
//
// Shape (arrays keep their deterministic order through serialize.canonicalize):
//   [ { guildId, systems: [ { ...<resolveProduction report>, review: [ ...issues ] } ] } ]
// The `review` array is attached HERE, on the read path only — resolveProduction
// (shared with the move path) stays untouched, so the flag is provably a no-op.
function previewProduction(state) {
  return (state.guilds || []).map((guild) => {
    const ventures = guild.ventures || [];
    const systemIds = [...new Set(ventures.map((v) => v.systemId))]
      .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    return {
      guildId: guild.id,
      systems: systemIds.map((sys) => ({
        ...resolveProduction(guild, sys),
        review: reviewSystem(guild, sys),
      })),
    };
  });
}

module.exports = { resolveProduction, reviewSystem, previewProduction };
