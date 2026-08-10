'use strict';

// production.js — the ONE place §5's three-gate arithmetic lives.
//
// `resolveProduction(guild, systemId)` is a PURE resolver: given a guild and one
// of its systems, it computes — but does NOT move — what production does this
// tick. It returns a plain report. Two callers share it, which is the whole point
// (design.md §5 "the resolved numbers come from the engine, never the browser",
// ruled 07-08-26):
//   - `stepProduction` (sim/tick.js) APPLIES the report — it deposits each mine's
//     fresh output, draws each line's whole `drawn` units, mints each refinery's
//     whole output and writes back its carry, and is the only place goods move.
//   - `previewProduction` (below) REPORTS the report — a read-only selector the
//     snapshot carries so the interactive Production view shows engine truth.
// Because both go through this single function they cannot drift: a preview can
// never disagree with what the tick will do, by construction.
//
// WHAT THE RESOLVER READS (§5 rate-based rewrite, 10-08-26 — supersedes the old
// floor-batches resolver): the profile (via sim/profile.js), the ventures, their
// per-venture `batchCarry` (the per-good sub-unit carries), AND the stockpile pool
// BALANCE as it stands at the START of this tick's production step (Ruling 3). The
// pool read is the documented departure from the old resolver's "reads NOTHING from
// the pool": the stockpile drawdown needs the current balance to know how far a
// consumer may draw. It is still a PURE, side-effect-free function — it reads
// current state and mutates nothing; the balance is start-of-step state, not a
// mutation observed mid-resolve. This tick's own Gate-1 stockpile deposit and the
// undrawn surplus stay in the pool and are drawable NEXT tick.
//
// THE MODEL, in one breath (design.md §5 "Engine rewrite — rate-based resolution",
// its "Rulings — composition, carry, ordering", the "Correction — the recipe ratio"
// that supersedes the original balancer, and "The distribution model — one pot"
// (Slice A)): each good's pot = start-of-step reserve + fresh; three claimants draw
// from it in the player's `order` — Reserve holds `min(reserveLevel, available)`,
// Production offers consumers `min(demand×downstreamPct, available)`, Syndicate
// delivers `min(commitment, available)`. A consuming line runs at a CONTINUOUS rate
// set by its scarcest input (no `floor(batches)` — so a 67% line genuinely runs at
// 67%, never stalling at 0). That one rate then lands on integer piles via a PER-GOOD carry:
// every good the line touches — each input AND the output — accrues `rate × qty`
// into its own remainder, `floor` of which is the whole units DRAWN (inputs) or
// MINTED (output) this tick, the sub-unit part carried on. No independent rounding,
// no refund — a non-binding input is simply under-drawn (its surplus stays put), so
// the recipe ratio holds on average (bounded transient). The one non-integer the
// rate itself is transient; the persisted fractions live in `batchCarry`, each
// fenced in [0, 1) with its own tripwire.

const { getRecipe } = require('./recipes.js');
const { getStock } = require('./stock.js');
const {
  getGoodPolicy, getThrottlePct, hasThrottle, storedThrottleIds, storedPolicyGoods,
} = require('./profile.js');

// resolveProduction(guild, systemId) -> a plain report for that (guild, system):
//   {
//     systemId,
//     mines:      [ { ventureId, good, amount } ],   // each producing mine's fresh deposit
//     goods:      { [good]: { fresh, demand, reserve0, pot, supplied,
//                             fork: { syndicate, downstream, stockpile }, reserveDelta } },
//     lines:      [ { ventureId, good, demand, alloc, drawn } ],  // per consuming line, per input
//     refineries: [ { ventureId, rate, bottleneckGood, minted, batchCarry } ],
//   }
// GOOD-LEVEL integers (§5 one-pot distribution, Slice A): `fresh` = Σ mine output;
// `demand` = the Gate-2 naive full-tilt Σ (rated, not throttled — the stable draw
// cap basis); `reserve0` = start-of-step reserve; `pot` = reserve0 + fresh (the one
// pot the three claimants draw from, in `order`); `supplied` = the consumer draw
// CAP this tick (min of the downstream-% demand cap and what's left above the
// Production slot); `fork` = the three claimants' takes — `stockpile` = reserve HELD
// (stays in the pot), `downstream` = consumer DRAW (actual), `syndicate` = the
// commitment DELIVERED (leaves to the Syndicate sink); `reserveDelta` = this tick's
// net reserve change (pot − draws − reserve0), the console's trend arrow. Undrawn
// goods stay in the pot as next tick's reserve. LINE-LEVEL integers: `demand` = that
// line's full-tilt draw
// for the input (rate × input-qty), `alloc` = the integer units Gate 3 handed it
// (it bounds the rate — the pool is NOT debited by it), `drawn` = the whole units
// the line actually pulls this tick (≤ alloc; the surplus of a non-binding input
// stays in the pool, undrawn). REFINERY-LEVEL: `rate` is the CONTINUOUS batches/tick
// the line runs (a float — transient telemetry, never serialized); `bottleneckGood`
// is the input that set the min (the scarcest, by definition — no search); `minted`
// is the whole output units produced this tick; `batchCarry` is the venture's NEW
// per-good carry map (every input + the output, each in [0, 1)), which
// stepProduction writes back onto the venture (§5 Correction, Ruling 2 generalized).
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

  // --- Route each good through the one-pot claimants + Gate-3 into per-line allocs.
  const goods = {};        // filled in the finalize pass (needs actual draws)
  const goodPlans = [];    // per-good claim inputs carried to the finalize pass
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
    // Σ producers' committed output — the Gate-1 Syndicate fork's amount (§5
    // "Syndicate fork delivery", 10-08-26). Summed over MINES producing this good
    // (resourceType === good); refinery-output commitment is a later slice. Computed
    // BEFORE the skip below so a committed *mine-to-sell* good (no in-system consumer)
    // still routes its fork and delivers — the common case the old skip dropped.
    let commitment = 0;
    for (const v of ventures) {
      if (v.resourceType === good) commitment += v.syndicateCommitment || 0;
    }

    // A fresh good nobody consumes AND that carries no commitment: nothing to route —
    // it all stays in the pool (the Stockpile fork's catch-all). No `goods` entry. A
    // good with consumers OR a non-zero commitment falls through and routes normally;
    // for a committed no-consumer good, demandTotal is 0 so Downstream takes 0, the
    // Syndicate fork takes min(commitment, fresh), and Stockpile catches the rest.
    if (consumers.length === 0 && commitment === 0) continue;

    // Gate 2 — naive full-tilt demand: Σ rated rate × input-qty. Uses the RATED
    // productionRate, not the throttle, so it is the stable figure the Downstream
    // cap keys off (§5). Effective (cross-input) demand is realised NOT here but by
    // the per-line min-rate balancer below: a line held by a scarce partner input
    // consumes less of this good and spills the rest back.
    let demandTotal = 0;
    for (const { venture, qty } of consumers) demandTotal += venture.productionRate * qty;

    // §5 one-pot distribution (Slice A, 10-08-26). The whole pot for this good is the
    // start-of-step reserve PLUS this tick's fresh; three claimants draw from it in
    // the player's priority `order`. This REPLACES the route-fresh-through-forks +
    // separate stockpile-drawdown framing (and the stockpile-% / reserveFloor fields).
    const policy = getGoodPolicy(guild, systemId, good);
    const reserve0 = getStock(guild, systemId, good);
    const pot = reserve0 + freshG;

    // Walk the order UP TO the Production ('downstream') slot to find how much of the
    // pot is offered to consumers. The claimants above Production are deterministic
    // without knowing consumer draws — Reserve holds min(reserveLevel, available),
    // Syndicate draws min(commitment, available). Claimants BELOW Production see the
    // pot minus what consumers ACTUALLY draw, resolved in the finalize pass once the
    // rates are known. `available` never goes negative — each take is ≤ it.
    let availableForConsumers = pot;
    for (const f of policy.order) {
      if (f === 'downstream') break;
      if (f === 'stockpile') availableForConsumers -= Math.min(policy.reserveLevel, availableForConsumers);
      else if (f === 'syndicate') availableForConsumers -= Math.min(commitment, availableForConsumers);
    }
    const demandCap = Math.floor((demandTotal * policy.downstreamPct) / 100);
    const consumerPool = Math.min(demandCap, availableForConsumers);

    // Stash what the finalize pass needs; the fork split is assembled there (it needs
    // the actual consumer draw, known only after the refinery rates resolve).
    goodPlans.push({
      good, fresh: freshG, reserve0, pot, demand: demandTotal,
      order: policy.order, commitment, reserveLevel: policy.reserveLevel, consumerPool,
    });

    // Gate 3 — ration `consumerPool` across consumers into integer per-line allocations.
    // Regime unchanged: FCFS in establishment order unless SOME consumer of this
    // good has a throttle explicitly set (a throttle of 100 counts as set — hence
    // hasThrottle, not the value), in which case the split is proportional.
    const anyThrottled = consumers.some(({ venture }) => hasThrottle(guild, systemId, venture.id));
    let give;
    if (!anyThrottled) {
      // FCFS in establishment order: each takes min(its full demand, what's left).
      give = [];
      let rem = consumerPool;
      for (const { venture, qty } of consumers) {
        const g = Math.min(venture.productionRate * qty, rem);
        give.push(g);
        rem -= g;
      }
    } else {
      // Proportional to each line's THROTTLED demand — continuous, so a rate-1 line
      // at 67% is NOT floored to a 0 ask (the floor-batches stall this rewrite
      // kills). Allocate min(consumerPool, Σ ceil(want)) integer units split by the real
      // wants; the integer remainder goes to the earliest-established line
      // (invariant 9). Capping at Σ ceil(want) stops an abundant pool from
      // over-handing a line more than it can use (the surplus just stays put).
      const wants = consumers.map(({ venture, qty }) =>
        (getThrottlePct(guild, systemId, venture.id) / 100) * venture.productionRate * qty);
      const wantTotal = wants.reduce((a, b) => a + b, 0);
      const capTotal = wants.reduce((a, b) => a + Math.ceil(b), 0);
      const toAllocate = Math.min(consumerPool, capTotal);
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
  }

  // --- Refineries: each runs at a CONTINUOUS rate = min(its throttle cap, the
  // scarcest input's batch capacity alloc/qty). NO floor(batches). That one rate
  // then lands on integer piles through a PER-GOOD carry (§5 "Correction — the
  // recipe ratio"): for EVERY good the line touches — each input AND the output —
  //     carry_g += rate × q_g ; whole_g = floor(carry_g) ; carry_g -= whole_g
  // Inputs DRAW whole_g from the pool; the output MINTS whole_g; the sub-unit
  // remainder carries to next tick. No independent rounding and no refund, so every
  // good averages rate × q_g and the recipe ratio holds (bounded transient). This
  // replaces the old round-input/accrue-output balancer, which broke the ratio.
  const refineries = [];
  const drawnByLine = {}; // ventureId -> input good -> integer units drawn this tick
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

    // Advance a fresh carry map from the venture's stored one (start-of-step, Ruling
    // 3). One entry per input AND the output. whole_g ≤ alloc_g by construction:
    // rate ≤ alloc_g / q_g and the carry is < 1, so carry + rate × q_g < 1 + alloc_g
    // and its floor never exceeds alloc_g — the pool can't go negative.
    const prev = c.batchCarry || {};
    const batchCarry = {};
    const drawn = {};
    for (const inp of recipe.inputs) {
      const raw = (prev[inp.good] || 0) + rate * inp.qty;
      const whole = Math.floor(raw);
      batchCarry[inp.good] = raw - whole;
      drawn[inp.good] = whole;
    }
    const outRaw = (prev[recipe.output.good] || 0) + rate * recipe.output.qty;
    const minted = Math.floor(outRaw);
    batchCarry[recipe.output.good] = outRaw - minted;

    drawnByLine[c.id] = drawn;
    refineries.push({ ventureId: c.id, rate, bottleneckGood, minted, batchCarry });
  }

  // Back-fill each line's `drawn` (the whole input units the pool is debited by).
  // `alloc` only bounded the rate; the pool loses exactly `drawn`, never a refund.
  for (const line of lines) {
    line.drawn = (drawnByLine[line.ventureId] || {})[line.good] || 0;
  }

  // --- Finalize per good (§5 one-pot). With consumer draws now known, walk the
  // claimant `order` with the ACTUAL consumer draw so a claimant BELOW Production
  // sees the pot minus what consumers really took (not the offered pool). goodPlans
  // is already in sorted-good order (built in the sorted good-loop), so this is
  // deterministic. The fork reports reserve HELD / consumer DRAW / syndicate DRAW.
  for (const plan of goodPlans) {
    let consumerDraw = 0;
    for (const line of lines) if (line.good === plan.good) consumerDraw += line.drawn;

    let available = plan.pot;
    let reserveHeld = 0;
    let synDraw = 0;
    for (const f of plan.order) {
      if (f === 'stockpile') {
        reserveHeld = Math.min(plan.reserveLevel, available);
        available -= reserveHeld;
      } else if (f === 'downstream') {
        available -= consumerDraw;
      } else if (f === 'syndicate') {
        synDraw = Math.min(plan.commitment, available);
        available -= synDraw;
      }
    }
    // Goods left in the pot at tick end become next tick's reserve. reserveHeld STAYS
    // in the pot; only the consumer draw and the syndicate delivery leave. Both are
    // bounded by `available` at their slot, so newReserve ≥ 0 (invariant 3).
    const newReserve = plan.pot - consumerDraw - synDraw;
    goods[plan.good] = {
      fresh: plan.fresh,
      demand: plan.demand,
      reserve0: plan.reserve0,           // start-of-step reserve (the pot minus fresh)
      pot: plan.pot,                     // reserve0 + fresh — the whole pot the claimants draw from
      supplied: plan.consumerPool,       // the consumer draw CAP this tick (min of demand-cap and what's left above Production)
      fork: { syndicate: synDraw, downstream: consumerDraw, stockpile: reserveHeld },
      reserveDelta: newReserve - plan.reserve0, // this tick's net reserve change — the console's trend arrow
    };
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
