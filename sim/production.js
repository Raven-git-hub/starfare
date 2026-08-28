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
// (Slice A) + the §5 windowed accrual (Slice B-i)): each good's pot = start-of-step
// reserve + fresh; three claimants draw from it in the player's `order` — Reserve holds
// `min(reserveLevel, available)`, Production offers consumers `min(demand×downstreamPct,
// available)`, and the Syndicate draws its PACED per-tick send toward the per-good
// aggregate window target `Q` (Σ commitment over the mines) — FRESH ONLY, never past
// `Q`, self-terminating at `Q`, resolving met/breach PER LICENSED VENTURE at the
// `tick % N == 0` boundary — the window's whole delivered pile is filled down the
// player's `pursue` order, each venture to its full target `qᵢ` before the next is fed,
// and `Q = Σ qᵢ` so the pile cap and the verdicts are the same integers (§5's
// per-venture ruling; the good-level status is a rollup of those verdicts)
// (the window state lives in guild.syndicateWindows, sim/windows.js; the send lands on
// integers via a per-good send carry, the same floor-and-carry discipline as batchCarry).
// A consuming line runs at a CONTINUOUS rate
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
  getGoodPolicy, getThrottlePct, hasThrottle,
  storedThrottleIds, storedPolicyGoods, storedPursueGoods, storedPursue,
} = require('./profile.js');
const {
  DEFAULT_WINDOW_N, winStartFor, getWindow,
} = require('./windows.js');
const { committedContribution } = require('./licence.js');
const { getHistory } = require('./history.js');

// resolveProduction(guild, systemId) -> a plain report for that (guild, system):
//   {
//     systemId,
//     mines:      [ { ventureId, good, amount } ],   // each producing mine's fresh deposit
//     goods:      { [good]: { fresh, demand, reserve0, pot, supplied,
//                             fork: { syndicate, downstream, stockpile }, reserveDelta } },
//     lines:      [ { ventureId, good, demand, alloc, drawn } ],  // per consuming line, per input
//     refineries: [ { ventureId, rate, bottleneckGood, minted, batchCarry } ],
//   }
// A good carrying commitment also gets `goods[good].window` = the §5 windowed-accrual
// telemetry — { Q, windowStart, delivered, sendCarry, ticksRemaining, requiredRate,
// sendThisTick, pctAchieved, status, perVenture } — where `perVenture` is
// { [ventureId]: { commitment, delivered, status } }, the per-licence outcome of the
// boundary fill. All of it DERIVED: only windowStart/delivered/sendCarry echo stored
// state, and nothing here enters the determinism hash.
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
function resolveProduction(guild, systemId, opts = {}) {
  const ventures = (guild.ventures || []).filter((v) => v.systemId === systemId);

  // The producing tick this resolve is FOR (the tick number of the state production
  // yields — both callers pass state.tick + 1) and the engine-wide window length
  // (state.windowN). A direct single-resolve (a test) may omit them, in which case
  // the window falls to tick 1 of a default-length window — consulted ONLY where a
  // good actually carries a commitment, so an unlicensed resolve never reads them.
  const p = opts.tick == null ? 1 : opts.tick;
  const windowN = opts.windowN == null ? DEFAULT_WINDOW_N : opts.windowN;
  // The midnight anchor (docs/cycle-and-calendar.md §2), threaded exactly like windowN:
  // an integer offset from state, defaulting to 0, at which every expression below is
  // byte-identical to the pre-anchor engine. Never a clock — the one wall-clock read
  // happens at galaxy creation and is frozen into state from then on.
  const dayAnchorTick = opts.dayAnchorTick == null ? 0 : opts.dayAnchorTick;
  const curWindowStart = winStartFor(p, windowN, dayAnchorTick);

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

  // --- The per-good aggregate Syndicate commitment target Q (§5 "windowed accrual"):
  // Q = Σ over the MINES producing the good of `committedContribution` — that is,
  // `syndicateCommitment × windowFraction`, computed by the ONE function in
  // sim/licence.js that the commitment SALE weights its proceeds split by, so the
  // target and the payment for hitting it can never again be built from two different
  // arithmetics (invariant 5 — the venture field is the single source of the target;
  // the window accumulators live in guild.syndicateWindows, sim/windows.js). Behaviour
  // here is unchanged: this loop already computed exactly that product, inline. A
  // non-positive commitment contributes 0, so a corrupted negative one can no longer
  // subtract from a sibling mine's target (the tick asserts it can't be one anyway).
  // As of Slice 3b-ii the
  // fraction is REAL: a venture licensed mid-window contributes only the share of its
  // commitment for the ticks it is present (§5's join ruling, Option A). It is still 1
  // for every venture present the whole window, so this sum is unchanged for every
  // pre-3b-ii path. Refinery-OUTPUT commitment is a later slice (this sums over mines
  // only). Computed UP FRONT so a committed good with NO fresh and NO consumer (an idle
  // committed mine) is still routed and still delivers 0 — fresh-only — rather than
  // being silently skipped.
  //
  // ── Q IS BUILT FROM THE PER-VENTURE TARGETS, NOT ROUNDED AFTER THE SUM ──────────
  // Each committing venture's own target is `qᵢ = round(committedContribution)`, and
  // `Q = Σ qᵢ`. It used to be `Q = round(Σ contribution)`, which is a DIFFERENT integer
  // whenever the fractions don't round the same way (two ventures at `×0.25` of an odd
  // commitment, say). That difference is harmless while met/breach is judged on the
  // aggregate and fatal once it is judged PER VENTURE (§5, RULING 27-08-26): the
  // boundary fill hands each venture its own `qᵢ`, while the Syndicate fork
  // self-terminates at `Q`. If `Q < Σ qᵢ` the pile can never fill the last venture and
  // it breaches on a window it could not possibly have met — a PHANTOM breach; if
  // `Q > Σ qᵢ` a unit arrives that no venture's verdict accounts for. Summing the
  // rounded targets makes the pile cap and the verdicts the same integers, by
  // construction rather than by luck. `qᵢ` is the ONE per-venture target — this sum and
  // the fill below both read it, the same single-source discipline `committedContribution`
  // itself exists for.
  //
  // NO-OP where it must be: a full-window venture has `fraction = 1`, so `qᵢ` is its
  // integer commitment and `Σ round = round(Σ)` exactly — every pre-3b-ii run keeps its
  // bytes (the committed golden hash pins it).
  //
  // `ventureTargets` keeps them in ESTABLISHMENT ORDER (the `ventures` array order),
  // which is the stable tie-break the pursue reconciliation appends by — the same one
  // the FCFS throttle default already uses. A `qᵢ` of 0 (a sliver of a window that
  // rounds away) still gets a row: it is a real licence with a target of zero units,
  // and it reads `met` because zero units is what it owed.
  const commitmentQ = {};
  const ventureTargets = {};
  for (const v of ventures) {
    if (!v.resourceType) continue;
    const contribution = committedContribution(v, curWindowStart, windowN);
    if (contribution <= 0) continue;
    const q = Math.round(contribution);
    (ventureTargets[v.resourceType] || (ventureTargets[v.resourceType] = []))
      .push({ ventureId: v.id, q });
    commitmentQ[v.resourceType] = (commitmentQ[v.resourceType] || 0) + q;
  }

  // Goods to route: everything mined fresh here PLUS every good some in-system
  // refinery consumes (so a good with NO local mine can still be fed by the stockpile
  // drawdown — §5 rewrite) PLUS every good carrying a non-zero commitment (so a
  // committed mine-to-sell / idle good routes and delivers). Sorted for determinism
  // (invariant 9).
  const goodsToRoute = new Set(Object.keys(fresh));
  for (const c of refineryVentures) {
    const recipe = getRecipe(c.recipeId);
    if (!recipe) continue; // dangling recipeId — the occupancy invariant halts on it
    for (const inp of recipe.inputs) goodsToRoute.add(inp.good);
  }
  for (const good of Object.keys(commitmentQ)) {
    if (commitmentQ[good] > 0) goodsToRoute.add(good);
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
    // The aggregate windowed target (0 = unlicensed). ALREADY a whole number: it is
    // `Σ qᵢ` over the good's committing ventures, each `qᵢ` rounded where it was built
    // (above). Goods are integers (§15.2) and `Q` is compared against `delivered` (a
    // whole-unit count), so the pacing, the fork's self-termination and every
    // per-venture verdict read the SAME integers — pacing can never aim at a target
    // the boundary won't accept, and no venture can be asked for a unit the pile is
    // not allowed to hold.
    const Q = commitmentQ[good] || 0;
    const targets = ventureTargets[good] || [];

    // A fresh good nobody consumes AND that carries no commitment: nothing to route —
    // it all stays in the pool (next tick's reserve). No `goods` entry. A good with
    // consumers OR a non-zero commitment falls through and routes normally; for a
    // committed no-consumer good, demandTotal is 0 so Production takes 0, the Syndicate
    // draws its paced fresh-only send, and everything else stays in the pot.
    if (consumers.length === 0 && Q <= 0) continue;

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

    // §5 windowed accrual: resolve THIS tick's INTENDED Syndicate send (a whole-unit
    // count) from the window state + the per-tick send control (paced / absolute /
    // percent). This reads guild.syndicateWindows START-OF-STEP (like batchCarry) and
    // reports the NEW window state for apply to write back — the resolver mutates
    // nothing. `win` is null for an uncommitted good (Q ≤ 0), so the Syndicate takes 0.
    const win = Q > 0
      ? resolveWindow(guild, systemId, good, Q, freshG, policy.syndicate, curWindowStart, windowN, p)
      : null;
    const intendedSend = win ? win.intendedSend : 0;

    // Walk the order UP TO the Production ('downstream') slot to find how much of the
    // pot is offered to consumers. Reserve holds min(reserveLevel, available). The
    // Syndicate is FRESH-ONLY (§5): capped at its intended send AND at the fresh not
    // yet spoken for (preFreshRem, full fresh here — no consumer has acted). Claimants
    // BELOW Production see the pot minus what consumers ACTUALLY draw, resolved in the
    // finalize pass. `available` never goes negative — each take is ≤ it.
    let availableForConsumers = pot;
    let preFreshRem = freshG;
    for (const f of policy.order) {
      if (f === 'downstream') break;
      if (f === 'stockpile') {
        availableForConsumers -= Math.min(policy.reserveLevel, availableForConsumers);
      } else if (f === 'syndicate') {
        const s = Math.min(intendedSend, availableForConsumers, preFreshRem);
        availableForConsumers -= s;
        preFreshRem -= s;
      }
    }
    const demandCap = Math.floor((demandTotal * policy.downstreamPct) / 100);
    const consumerPool = Math.min(demandCap, availableForConsumers);

    // Stash what the finalize pass needs; the fork split (and the Syndicate's actual,
    // fresh-capped draw) is assembled there, once the consumer draw is known.
    goodPlans.push({
      good, fresh: freshG, reserve0, pot, demand: demandTotal,
      order: policy.order, reserveLevel: policy.reserveLevel, consumerPool,
      // `targets` (establishment order) and `pursue` (the player's ranking, absent =
      // none) are what the finalize pass fills the window's pile with — read HERE, on
      // the one pass that already reads the good's policy, so the fill never opens the
      // profile a second time.
      Q, intendedSend, win, targets, pursue: policy.pursue || [],
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

    // Walk the claimant order with the ACTUAL consumer draw. Track `available` (the
    // pot remaining) AND `freshRem` (fresh not yet spoken for): consumers feed on
    // fresh first (the rate-based drawdown), and the Syndicate is FRESH-ONLY, so it is
    // capped at freshRem — which guarantees it NEVER reduces the reserve (§5). If a
    // higher-priority Production claimant consumed the fresh, the Syndicate under-draws
    // and the pace self-corrects (or breaches) — the on-theme competition for fresh.
    let available = plan.pot;
    let freshRem = plan.fresh;
    let reserveHeld = 0;
    let synDraw = 0;
    for (const f of plan.order) {
      if (f === 'stockpile') {
        reserveHeld = Math.min(plan.reserveLevel, available);
        available -= reserveHeld;
      } else if (f === 'downstream') {
        available -= consumerDraw;
        freshRem -= Math.min(consumerDraw, freshRem);
      } else if (f === 'syndicate') {
        synDraw = Math.min(plan.intendedSend, available, freshRem);
        available -= synDraw;
        freshRem -= synDraw;
      }
    }
    // Goods left in the pot at tick end become next tick's reserve. reserveHeld STAYS
    // in the pot; only the consumer draw and the syndicate delivery leave. Both are
    // bounded by `available` at their slot, so newReserve ≥ 0 (invariant 3).
    const newReserve = plan.pot - consumerDraw - synDraw;
    const goodEntry = {
      fresh: plan.fresh,
      demand: plan.demand,
      reserve0: plan.reserve0,           // start-of-step reserve (the pot minus fresh)
      pot: plan.pot,                     // reserve0 + fresh — the whole pot the claimants draw from
      supplied: plan.consumerPool,       // the consumer draw CAP this tick (min of demand-cap and what's left above Production)
      fork: { syndicate: synDraw, downstream: consumerDraw, stockpile: reserveHeld },
      reserveDelta: newReserve - plan.reserve0, // this tick's net reserve change — the console's trend arrow
    };

    // §5 windowed accrual telemetry + the engine-owned window state apply writes back.
    // windowStart/delivered/sendCarry ARE serialized state (enter the determinism
    // hash); the rest (ticksRemaining, requiredRate, sendThisTick, pctAchieved,
    // status) is DERIVED telemetry the client renders and computes nothing from (§5
    // display rule). synDraw is the ACTUAL delivery, so delivered advances by it and
    // NEVER exceeds Q (intendedSend was ≤ Q − delivered). At the boundary tick
    // (p % N == 0 — the window's last), status resolves met/breach AFTER this tick's
    // apply; otherwise the window is still accruing. `perVenture` is the REAL verdict
    // (§5: met/breach is per licence) — pure derived telemetry keyed by ventureId, so
    // the console roster reads a row per licence without reshaping anything, and the
    // good-level `status` above it is a rollup of those rows.
    if (plan.win) {
      const w = plan.win;
      const newDelivered = w.delivered + synDraw;
      // The ANCHORED boundary (§2): `(tick - dayAnchorTick) % N == 0`. At the default
      // anchor 0 this is exactly the old `p % windowN === 0`.
      const isBoundary = (((p - dayAnchorTick) % windowN) + windowN) % windowN === 0;
      // The PER-VENTURE verdicts (§5's per-venture met/breach ruling), and the
      // good-level status ROLLED UP from them — the individuals are computed first and
      // the aggregate is derived from them, never the other way round.
      const perVenture = pursueFill(plan.targets, plan.pursue, newDelivered, isBoundary);
      goodEntry.window = {
        Q: plan.Q,
        windowStart: w.windowStart,
        delivered: newDelivered,
        sendCarry: w.newSendCarry,
        ticksRemaining: w.ticksRemaining,
        requiredRate: w.requiredRate,
        sendThisTick: synDraw,
        pctAchieved: plan.Q > 0 ? (newDelivered / plan.Q) * 100 : 100,
        status: rollupStatus(perVenture, isBoundary),
        perVenture,
      };
    }

    goods[plan.good] = goodEntry;
  }

  return { systemId, mines, goods, lines, refineries };
}

// reconcilePursue(targets, pursue) -> the good's committing ventures in the order the
// boundary fill feeds them, as { ventureId, q } rows.
//
// The stored `pursue` list is STANDING INTENT, not a referential key: the player ranks
// licences and the world moves underneath the ranking. So it is reconciled at READ
// time, exactly as a stored throttle is (§15.4) — the action never refused a stale
// entry, and the engine never rewrites the player's stored list:
//   - an id naming a venture that is NOT committing this good this window is DROPPED
//     (it was sold, re-sited, or its licence lapsed — the review flag tells the player);
//   - a committing venture the list OMITS is APPENDED, in ESTABLISHMENT order — the
//     same stable tie-break Gate 3's FCFS default already uses, not a new one. So a
//     newly-licensed mine the ranking has never heard of is fed LAST, which is the safe
//     default: ranking is a privilege you grant, never one you inherit.
//   - a duplicate id is honoured once, at its first appearance.
// An ABSENT (or empty) list therefore yields pure establishment order.
function reconcilePursue(targets, pursue) {
  const byId = new Map(targets.map((t) => [t.ventureId, t]));
  const seen = new Set();
  const out = [];
  for (const id of pursue) {
    const t = byId.get(id);
    if (!t || seen.has(id)) continue;
    seen.add(id);
    out.push(t);
  }
  for (const t of targets) if (!seen.has(t.ventureId)) out.push(t);
  return out;
}

// pursueFill(targets, pursue, delivered, isBoundary) -> { [ventureId]: { commitment,
// delivered, status } }, the §5 PER-VENTURE licence outcome.
//
// The window's WHOLE delivered pile is walked down the reconciled pursue order, each
// venture taking `min(qᵢ, remaining)` — its full target before the next is fed. Integer
// subtraction throughout; nothing is rounded here, because `qᵢ` and `delivered` are
// already the whole units the fill is defined on.
//
// BINARY (§5): `met` iff the venture got its ENTIRE target. One unit short is `breach`,
// with no partial credit — the fee it drives (3b-iii) is a lump, so a half-met licence
// is not a thing the model can charge for.
//
// MID-WINDOW (refined 28-08-26): a row still short of its target reads `accruing`, with
// `delivered` a projection off the pile as it stands — the ranking is editable until the
// boundary, so calling a shortfall a BREACH mid-window would be a guess presented as a
// fact. A row already AT or PAST its target is different: `met` is monotone under this
// fill, because `delivered` only grows within a window and a licence at its target has
// nothing left to lose to a re-ranking below it. So a fully-delivered licence reads `met`
// the moment it is full, instead of spinning `accruing` until the boundary while the
// console shows the amber wait dot on a licence that is visibly done.
//
// (Only `met` is early. `breach` is still boundary-only, and stays a fact about the
// window's END — the whole point of the asymmetry.)
//
// NO ARRIVAL-TIME FENCING (§5, RULED 27-08-26). The pile is not fenced by when a unit
// was delivered or when a licence was signed: a mid-window joiner ranked first draws on
// units delivered before its licence existed, and the full-window venture that actually
// sent them then breaches. That is the RULING, not an oversight — pursue is the lever
// for steering the goods you have onto the licences that cost you least, and the
// Syndicate receives the same total goods either way; only which licence pays the
// discounted fee moves. A test asserts this behaviour so it cannot be "fixed" quietly.
function pursueFill(targets, pursue, delivered, isBoundary) {
  const out = {};
  let remaining = delivered;
  for (const t of reconcilePursue(targets, pursue)) {
    const got = Math.min(t.q, remaining);
    remaining -= got;
    out[t.ventureId] = {
      commitment: t.q,
      delivered: got,
      status: got >= t.q ? 'met' : (isBoundary ? 'breach' : 'accruing'),
    };
  }
  return out;
}

// rollupStatus(perVenture, isBoundary) -> the GOOD-level status, derived from the
// per-venture verdicts above: `met` only if every licence on the good was met, else
// `breach` at the boundary and `accruing` while the window is still running — the same
// early-`met` asymmetry the rows have (28-08-26), so the good reads `met` as soon as
// every licence on it is full and the pill never disagrees with the dots beneath it.
// The aggregate is a summary of the individuals and nothing reads it to decide a
// venture's fate — §5's "the aggregate is derived from the individuals, never the
// reverse". (With `Q = Σ qᵢ` and a greedy fill this is the
// same verdict the old `delivered >= Q` test gave, which is exactly why the change is
// byte-identical for the single-venture case — but it is now computed the way the
// design says it is composed, so a future per-venture rule cannot silently disagree
// with the dot the console shows.)
function rollupStatus(perVenture, isBoundary) {
  const allMet = Object.values(perVenture).every((r) => r.status === 'met');
  if (allMet) return 'met';
  return isBoundary ? 'breach' : 'accruing';
}

// resolveWindow(...) -> the §5 per-good windowed-accrual send for ONE tick. Reads the
// stored window state (guild.syndicateWindows, sim/windows.js) at START-OF-STEP and
// computes — moving nothing — the NEW window state apply will persist plus the
// intended whole-unit send. Returns:
//   { windowStart, delivered, newSendCarry, intendedSend, ticksRemaining, requiredRate }
// where `delivered` is the delivered-so-far AFTER any window roll (0 on a fresh
// window), `intendedSend` is this tick's whole-unit send capped at Q − delivered
// (the fresh-only cap is applied by the finalize walk, not here), and requiredRate /
// ticksRemaining are display telemetry.
//
// The window rolls on the GLOBAL cadence: if the stored windowStart is not the window
// that contains this producing tick, the window has ended — delivered and the send
// carry reset to 0 and a new windowStart is stamped (the "next tick opens a new
// window" rule, §5). The per-tick send is:
//   - default (no control): the PACED required-rate = (Q − delivered) / ticks-remaining
//     — the minimum steady send to reach Q on time; it self-corrects.
//   - "absolute": a fixed `value` units/tick.
//   - "percent":  `value`% of THIS tick's fresh (the Syndicate fork's own mode).
// That fractional rate lands on integers via the send carry (floor-and-carry, RULED):
// accrue the intent, deliver the whole part, carry the sub-unit remainder in [0,1).
function resolveWindow(guild, systemId, good, Q, freshG, control, curWindowStart, windowN, p) {
  const stored = getWindow(guild, systemId, good);
  const roll = !stored || stored.windowStart !== curWindowStart;
  const windowStart = curWindowStart;
  const delivered = roll ? 0 : stored.delivered;
  const sendCarry = roll ? 0 : stored.sendCarry;

  const remaining = Math.max(0, Q - delivered); // never send past Q

  // ticks-remaining INCLUSIVE of this tick: boundary = windowStart + N − 1, so this is
  // boundary − p + 1 = windowStart + N − p. It is ≥ 1 throughout the window and 1 on
  // the boundary tick — the basis for the "minimum steady send" pace (§5). The §5 note
  // that the naive display formula divides by zero on the final tick is honoured as a
  // DEFENSIVE guard (the `> 0` below); with the inclusive count the resolver never
  // actually divides by zero in-window, and any absurd rate is bounded by the fresh
  // cap at apply, so no Infinity/NaN ever reaches integer state.
  const ticksRemaining = windowStart + windowN - p;
  const requiredRate = ticksRemaining > 0 ? remaining / ticksRemaining : remaining;

  let targetRate;
  if (!control) {
    targetRate = requiredRate; // paced default
  } else if (control.mode === 'absolute') {
    targetRate = control.value;
  } else if (control.mode === 'percent') {
    targetRate = (control.value / 100) * freshG;
  } else {
    targetRate = requiredRate; // unknown mode → fall back to the pace
  }
  if (!(targetRate >= 0)) targetRate = 0; // guard NaN / negative

  // Floor-and-carry (the batchCarry discipline, RULED): accrue the fractional intent,
  // deliver the whole part, carry the sub-unit remainder in [0,1). The whole units are
  // Q-capped here; the fresh-only cap is the finalize walk's job.
  const desired = sendCarry + targetRate;
  const wholeDesired = Math.floor(desired);
  const newSendCarry = desired - wholeDesired;
  const intendedSend = Math.min(wholeDesired, remaining);

  return { windowStart, delivered, newSendCarry, intendedSend, ticksRemaining, requiredRate };
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
//   (d) stale_pursue      — a stored `pursue` list ranks a venture that no longer
//                           produces that good in S. The same CLASS of staleness as
//                           (a): the ranking still stands, the engine silently drops
//                           the dead entry at the boundary (reconcilePursue), and the
//                           player is told rather than having their list rewritten.
//                           It is checked against PRODUCERS of the good, not against
//                           licence-holders, because an unlicensed producer is a
//                           legitimate thing to rank ahead of time — it becomes live
//                           the moment the licence is granted — while a venture that
//                           has stopped producing the good never will.
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

  // Which ventures produce each good in S — a mine by its `resourceType`, a refinery by
  // its recipe's OUTPUT. This is the set a `pursue` entry must name to still be live.
  const producersOfGood = {};
  for (const v of ventures) {
    let good = null;
    if (v.resourceType) {
      good = v.resourceType;
    } else if (v.recipeId) {
      const recipe = getRecipe(v.recipeId);
      good = recipe ? recipe.output.good : null;
    }
    if (good) (producersOfGood[good] || (producersOfGood[good] = new Set())).add(v.id);
  }

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
  // (d) a `pursue` ranking naming a venture that no longer produces that good here.
  for (const good of storedPursueGoods(guild, systemId)) {
    const producers = producersOfGood[good] || new Set();
    const seen = new Set();
    for (const id of storedPursue(guild, systemId, good)) {
      if (producers.has(id) || seen.has(id)) continue;
      seen.add(id); // one flag per dead id, however many times the list repeats it
      issues.push({ kind: 'stale_pursue', good, ventureId: id });
    }
  }

  // Sort by (kind, good, ventureId) so the list is deterministic (invariant 9). The
  // three original kinds carry exactly one of `good`/`ventureId`, so for them the
  // missing half is '' and this is the same ordering as before; `stale_pursue` carries
  // BOTH, and needs both to be totally ordered.
  const key = (i) => `${i.kind}\u0000${i.good || ''}\u0000${i.ventureId || ''}`;
  issues.sort((a, b) => {
    const ak = key(a);
    const bk = key(b);
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
//   [ { guildId, systems: [ { ...<resolveProduction report>,
//                             review: [ ...issues ],
//                             history: { [good]: { prod: [...], cons: [...] } } } ] } ]
// The `review` array is attached HERE, on the read path only — resolveProduction
// (shared with the move path) stays untouched, so the flag is provably a no-op. The
// `history` map is attached the same way and for the same reason: it is a verbatim
// echo of the STORED buffer `guild.productionHistory[systemId]` (sim/history.js), so
// the console draws its trend sparklines from engine state instead of from a browser
// buffer that emptied on every reload.
//
// WHY `history` sits beside `review` at SYSTEM level and not inside `goods`: the
// `goods` map holds only the goods actually ROUTED this tick (a mined good with no
// in-system consumer and no commitment is deliberately absent), whereas history exists
// for every good that has ever moved here. Hanging it off `goods` would silently drop
// the trend for the commonest case in the game — a mine with no local refinery. One
// map, keyed by good, is what the console reads: `sysEntry.history[good]`.
// systemHistory(guild, systemId) -> { [good]: { prod: [...], cons: [...] } } — the
// stored history for one system, COPIED so a snapshot consumer can never mutate engine
// state through it (the snapshot is handed out over HTTP; `cloneProfile`/`cloneWindows`
// take the same care). Goods in sorted order, and `{}` for a system with no history yet.
function systemHistory(guild, systemId) {
  const stored = (guild.productionHistory || {})[systemId] || {};
  const out = {};
  for (const good of Object.keys(stored).sort()) {
    const series = getHistory(guild, systemId, good);
    out[good] = { prod: [...series.prod], cons: [...series.cons] };
  }
  return out;
}

function previewProduction(state) {
  // Preview the NEXT tick's production (state.tick + 1 is the tick it would yield),
  // under the engine-wide window length, so the windowed-accrual telemetry matches
  // exactly what applyProduction will do when the tick advances (the anti-drift
  // guarantee). state.windowN may be undefined (no committed scenario has set it) —
  // resolveProduction defaults it, and it is read only for committed goods.
  const opts = { tick: (state.tick || 0) + 1, windowN: state.windowN, dayAnchorTick: state.dayAnchorTick };
  return (state.guilds || []).map((guild) => {
    const ventures = guild.ventures || [];
    const systemIds = [...new Set(ventures.map((v) => v.systemId))]
      .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    return {
      guildId: guild.id,
      systems: systemIds.map((sys) => ({
        ...resolveProduction(guild, sys, opts),
        review: reviewSystem(guild, sys),
        history: systemHistory(guild, sys),
      })),
    };
  });
}

module.exports = { resolveProduction, reviewSystem, previewProduction };
