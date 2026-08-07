'use strict';

// production.js — the ONE place §5's three-gate arithmetic lives.
//
// `resolveProduction(guild, systemId)` is a PURE resolver: given a guild and one
// of its systems, it computes — but does NOT move — what production does this
// tick. It returns a plain report (integers only). Two callers share it, which is
// the whole point (design.md §5 "the resolved numbers come from the engine, never
// the browser", ruled 07-08-26):
//   - `stepProduction` (sim/tick.js) APPLIES the report — it deposits each mine's
//     fresh output and runs each refinery's batches, and is the only place goods
//     actually move.
//   - `previewProduction` (below) REPORTS the report — a read-only selector the
//     snapshot carries so the interactive Production view shows engine truth.
// Because both go through this single function they cannot drift: a preview can
// never disagree with what the tick will do, by construction.
//
// KEY PROPERTY that makes the resolver clean: under §5's "never touch the pile,"
// the resolution depends ONLY on the ventures' rates, their recipes, and the
// profile — NOT on the current pool balance. Mining fresh = Σ mine rates; Gate
// 1/2/3 all operate on that fresh flow; a refinery's batches come from its Gate-3
// allocation. So this function reads the profile (via sim/profile.js) and the
// ventures, and NOTHING from the stockpile pool — no state is read that a mutation
// could change, so it is trivially pure and side-effect-free.

const { getRecipe } = require('./recipes.js');
const {
  getGoodPolicy, getThrottlePct, hasThrottle, storedThrottleIds, storedPolicyGoods,
} = require('./profile.js');

// resolveProduction(guild, systemId) -> a plain report for that (guild, system):
//   {
//     systemId,
//     mines:      [ { ventureId, good, amount } ],   // each producing mine's fresh deposit
//     goods:      { [good]: { fresh, demand, fork: { syndicate, downstream, stockpile }, supplied } },
//     lines:      [ { ventureId, good, demand, alloc } ],  // per consuming line, per good it draws
//     refineries: [ { ventureId, batches } ],        // batches each refinery runs (0 = starved)
//   }
// All values are integers. `demand` in `goods` is the Gate-2 naive full-tilt Σ for
// the good; `supplied` is the Downstream fork's take (the draw cap consumers share)
// and equals `fork.downstream`. `demand` in `lines` is that one line's full-tilt
// draw for that good (D_c_g = rate × input-qty).
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

  // --- Route each fresh raw good through Gates 1→3 into per-line draw caps.
  const goods = {};
  const lines = [];
  const alloc = {}; // ventureId -> good -> units this refinery may draw this tick

  for (const good of Object.keys(fresh).sort()) {
    const freshG = fresh[good];
    if (freshG <= 0) continue;

    // Consumers of `good`: refineries whose recipe lists it as an input, with that
    // input's per-batch qty — in establishment order.
    const consumers = [];
    for (const c of refineryVentures) {
      const recipe = getRecipe(c.recipeId);
      if (!recipe) continue; // dangling recipeId — the occupancy invariant halts on it
      const inp = recipe.inputs.find((i) => i.good === good);
      if (inp) consumers.push({ venture: c, qty: inp.qty });
    }
    // Fresh good with no consumer this system: nothing to route — it all stays in
    // the pool (the Stockpile fork's catch-all). No `goods` entry (there is no
    // downstream figure to report), exactly as the old routing skipped it.
    if (consumers.length === 0) continue;

    // Gate 2 — naive full-tilt demand: Σ rated rate × input-qty. Uses the RATED
    // productionRate, not the throttle, so it is a stable figure the Downstream cap
    // keys off (§5).
    let demandTotal = 0;
    for (const { venture, qty } of consumers) demandTotal += venture.productionRate * qty;

    // Gate 1 — pour freshG through the forks in the policy order; record each
    // fork's take and compute `supplied` (the collective downstream draw cap).
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

    // Gate 3 — distribute `supplied` across consumers into per-venture draw caps.
    // Regime: FCFS unless SOME consumer has a throttle explicitly set (a throttle
    // of 100 counts as set — hence hasThrottle, not the value).
    const anyThrottled = consumers.some(({ venture }) => hasThrottle(guild, systemId, venture.id));
    let give;
    if (!anyThrottled) {
      // FCFS in establishment order: each takes min(its full demand, what's left).
      give = [];
      let rem = supplied;
      for (const { venture, qty } of consumers) {
        const g = Math.min(venture.productionRate * qty, rem);
        give.push(g);
        rem -= g;
      }
    } else {
      // Proportional: each consumer's THROTTLED ask; scale down together if the
      // asks exceed what arrived, remainder to the earliest-established line.
      const asks = consumers.map(({ venture, qty }) =>
        Math.floor((venture.productionRate * getThrottlePct(guild, systemId, venture.id)) / 100) * qty);
      const askTotal = asks.reduce((a, b) => a + b, 0);
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
    }
    consumers.forEach(({ venture, qty }, idx) => {
      (alloc[venture.id] || (alloc[venture.id] = {}))[good] = give[idx];
      lines.push({ ventureId: venture.id, good, demand: venture.productionRate * qty, alloc: give[idx] });
    });

    goods[good] = { fresh: freshG, demand: demandTotal, fork, supplied };
  }

  // --- Refineries: batches each runs, capped in LOCKSTEP by the scarcest allocated
  // input (floor per input) and by its own throttled rate. 0 = starved this tick.
  const refineries = [];
  for (const c of refineryVentures) {
    const recipe = getRecipe(c.recipeId);
    if (!recipe) continue;
    let batches = Math.floor((c.productionRate * getThrottlePct(guild, systemId, c.id)) / 100);
    for (const inp of recipe.inputs) {
      const allocated = (alloc[c.id] && alloc[c.id][inp.good]) || 0;
      batches = Math.min(batches, Math.floor(allocated / inp.qty));
    }
    refineries.push({ ventureId: c.id, batches });
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
