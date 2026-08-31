'use strict';

// tick.js — the pure economy step: the fixed eight-step order from
// design.md §15.6, as eight named functions. Being filled in one pillar at a
// time (working practice #3) rather than all at once, so each pillar is a
// real, individually-tested fact rather than a batch of invented behavior.
//
// Landed so far: step 1, production (see its own comment below for exactly what
// it does and doesn't do yet), step 3, the price recompute (the Syndicate value
// per good — the formula itself lives in sim/prices.js), and step 5, arrivals
// (Syndicate BUY deliveries landing on their due tick — design.md §6). Steps 2,
// 4 and 6-8 are still `identity` — explicit NAMED no-ops — because their real
// logic needs modules that don't exist yet (territory.js, bots.js — see sim/README.md's
// planned layout). Their seam already sits in the right place, in the right
// order, instead of being invented ad hoc whenever that module lands.
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
const { guildHolds } = require('./claims.js');
const { resolveProduction } = require('./production.js');
const {
  setWindow, winStartFor, windowFraction, isWindowBoundary, DEFAULT_WINDOW_N,
} = require('./windows.js');
const { getHistory, pushHistory } = require('./history.js');
const { recordPriceSamples } = require('./price-history.js');
const { recomputePrices, postedPrice } = require('./prices.js');
const {
  commitmentSale, committedContribution, feeOwed, reputationDelta,
} = require('./licence.js');
const { producedGoodFor } = require('./baseline.js');

// A total, deterministic string order for sort keys — used where a tie has to
// break the same way every run (invariant 9) rather than however sort found it.
function cmp(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

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
function stepProduction(state, _actions, ctx) {
  for (const guild of state.guilds) {
    const ventures = guild.ventures || [];
    // Systems this guild produces in, in a deterministic order. A synthetic test
    // venture with no seat keeps its `systemId` (null) as its pool key — exactly as
    // before, when a null systemId deposited into a null-keyed pool — so we do NOT
    // drop it. Sorted by String coercion so null/undefined order deterministically
    // ("null"/"undefined") without relying on sort's undefined-to-end quirk.
    const systemIds = [...new Set(ventures.map((v) => v.systemId))]
      .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    // LAYER 2 of the licence fee (§5, Slice 3b-iii): the VERDICT and the owed amount are
    // per (system, good) — each system's applyProduction returns the per-venture oweds it
    // computed from its OWN boundary verdicts — but the CHARGE is guild-level and
    // system/good-agnostic, because a guild has exactly ONE credit pool. Every window in
    // the galaxy closes on the same anchored boundary, so a guild's oweds all fall due on
    // the same tick and sum into ONE lump: one debit, one ledger transfer, one receipt.
    //
    // THE TOTAL IS DERIVED FROM THE INDIVIDUALS, never the reverse. Each venture computes
    // what IT owes from ITS OWN verdict, rounded there (§5 rounds per venture); this only
    // adds the whole numbers up. There is no (system, good) fee "pot" to split — building
    // one and dividing it would round a pooled total and hand ventures shares of a number
    // nobody owed.
    let lump = 0;
    const charged = {};
    for (const sys of systemIds) {
      const fee = applyProduction(state, guild, sys, ctx);
      if (!fee) continue;
      lump += fee.owed;
      Object.assign(charged, fee.ventures);   // keys are venture ids — unique guild-wide
    }

    // The one movement: credits leave the guild, the same integer lands in the Syndicate
    // ledger (invariant 2 holds by construction — one number, both legs). The debit MAY
    // take the guild negative and that is the ruling, not a bug (§5: "a breach fee may
    // drive a guild's credits negative… a guild in debt is a pressure state whose
    // consequences are deferred"); guild credits are exempt from invariant 3 exactly as
    // the ledger already is (sim/invariants.js).
    //
    // Written LAZILY, only where a licensed venture was actually judged — so a guild with
    // no licence, and EVERY non-boundary tick, touches nothing and stays byte-identical
    // (the same discipline as guild.syndicateWindows and guild.lastSyndicateSale). A lump
    // of 0 is still a real charge event when there are rows: at the grid's max-commit /
    // max-equity corner the discounted fee IS 0, and "you were judged and owed nothing" is
    // a different fact from "you were not judged".
    if (Object.keys(charged).length > 0) {
      guild.credits -= lump;
      state.syndicate.ledger += lump;
      recordLicenceFee(guild, state.tick + 1, lump, charged);
    }
  }
  return state;
}

// One (guild, system): resolve production, then MOVE the goods to match the
// report. This is the ONLY place addStock is called for production. Mutates the
// guild's system pool (and each refinery's batchCarry) in place — tick()
// already cloned state, so this never touches the caller's input. The resolver
// reads the pool balance + accumulators (start-of-step) and mutates nothing.
//
// RETURNS (Slice 3b-iii) the licence-fee accrual for this system —
// `{ owed, ventures: { ventureId: { status, owed, basicFee, discountedFee } } }` at a
// window boundary where this system holds a licensed venture, else `null`. It is a
// RETURN and not a debit because the charge is guild-level: stepProduction sums a
// guild's systems and moves the credits once (§5's two layers, spelled out below).
function applyProduction(state, guild, systemId, ctx) {
  // The producing tick is state.tick + 1 (the tick number of the state this step
  // yields), and the window length is the engine-wide state.windowN — passed so the
  // resolver's windowed-accrual send matches what previewProduction reports for the
  // same advance (anti-drift). Both are read only for a good carrying a commitment.
  const report = resolveProduction(guild, systemId, {
    tick: state.tick + 1, windowN: state.windowN, dayAnchorTick: state.dayAnchorTick,
  });
  const byId = new Map((guild.ventures || []).map((v) => [v.id, v]));

  // The window this tick's delivery falls in, derived from the SAME producing tick and
  // the SAME engine-wide `N` the resolver just used — so the commitment sale below
  // weights its split by each venture's contribution to the very `Q` this report was
  // built against. Pure arithmetic (sim/windows.js), read only by the sale.
  const windowN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
  // The same anchored cadence the resolver just used (docs/cycle-and-calendar.md §2) —
  // the sale must weight its split against the very window the report was built on, so
  // this MUST read the anchor the same way, not fall back to the unanchored cadence.
  const dayAnchorTick = state.dayAnchorTick == null ? 0 : state.dayAnchorTick;
  const curWindowStart = winStartFor(state.tick + 1, windowN, dayAnchorTick);

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

  // Deliver the Gate-1 Syndicate fork (§5 "Syndicate fork delivery", 10-08-26) — and,
  // as of Slice 3a, PAY FOR IT. The committed units leave the guild's pool for the
  // Syndicate's infinite backend exactly as before (invariants.js's galactic-supply
  // check already treats selling as a sink, not a conservation break); what is new is
  // the credit leg beside it: the delivery is a SALE, not a tithe
  // (docs/licence-and-price-system.md Part 2; design.md §5 "Output commitment").
  //
  // The whole split lives in sim/licence.js — this is the seam that hands it the
  // three inputs and applies the one number it returns:
  //   - the PRICE is the POSTED one (sim/prices.js), the two-ticks-lagged value
  //     already sitting on state when this step runs. That is the point of the lag:
  //     the rate a sale executes at was fixed two ticks before the sale.
  //   - the VENTURES are this system's, and the WINDOW is this tick's, so a good's
  //     proceeds split by the same per-venture contributions (`committedContribution`,
  //     sim/licence.js) that built its aggregate `Q` — one function, both consumers,
  //     so a mid-window joiner's pro-rated share can never be weighted as a full one.
  //   - the OWNER's integer share moves twice, equal and opposite: into the guild's
  //     credits, out of the Syndicate ledger (the buyer). The `o` equity share is not
  //     paid to anyone — no investor exists yet — so it simply never leaves the
  //     ledger (§5: "or, with none, to the Syndicate ledger"). One rounding, one
  //     number, both legs: invariant 2 holds to the credit.
  // Goods are iterated in sorted key order for determinism (invariant 9). For an
  // unlicensed venture fork.syndicate is 0, so nothing here runs at all and the
  // credit-free path stays byte-identical.
  const systemVentures = (guild.ventures || []).filter((v) => v.systemId === systemId);
  for (const good of Object.keys(report.goods).sort()) {
    const delivered = report.goods[good].fork.syndicate;
    if (delivered <= 0) continue;
    addStock(guild, systemId, good, -delivered);

    // A committed good with no posted price is not a free delivery — it is a broken
    // state, and taking the goods anyway would be a silent loss. Halt loudly (§15.5's
    // "a silent violation is worse than a crash"). Every non-fuel good carries a price
    // from tick 0 (createState seeds them), and fuel is never committed or sold here,
    // so this fires only on a state whose price block was removed by hand.
    const price = postedPrice(state, good);
    if (price == null) {
      throw new Error(`applyProduction: guild ${guild.id} delivered ${delivered} ${good} to the Syndicate at tick ${state.tick + 1} but the good has no posted price — refusing to hand over goods for nothing`);
    }

    const { ownerCredits } = commitmentSale({
      ventures: systemVentures, good, delivered, price, windowStart: curWindowStart, windowN,
    });
    guild.credits += ownerCredits;
    state.syndicate.ledger -= ownerCredits;
    recordSale(guild, state.tick + 1, good, delivered, price, ownerCredits);
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

  // ── LAYER 1 of the licence fee (§5 "LICENCE FEE MECHANICS", Slice 3b-iii) ────────
  // At the window boundary — and ONLY there — every licensed venture in this system owes
  //     round((met ? discountedFee : basicFee) × windowFraction)
  // computed from ITS OWN verdict in ITS OWN (system, good) window. The arithmetic is
  // `feeOwed` (sim/licence.js); nothing is debited here. This returns the accrual and
  // stepProduction moves the guild's summed lump once (Layer 2).
  //
  // WHY THE VERDICT IS READ HERE and not in a later pass: `status` is DERIVED telemetry
  // that reaches no stored byte (§5), and at the boundary the window is on the cusp of
  // rolling — a second pass would have to rebuild the pursue fill from the stored
  // `delivered` against a window that is about to reset. The verdicts are in hand right
  // now, on the one tick they are true for.
  //
  // WHY THE LOOP IS OVER VENTURES, NOT OVER `perVenture` ROWS — this is the mechanism
  // choice, and it is load-bearing for §5's 0% commitment floor. A venture that committed
  // NOTHING has no `Q`, so its good has no window block and it appears in no `perVenture`
  // row at all — yet §5 says it is licensed, is `met` (it owed zero units and delivered
  // zero), and PAYS its discounted fee, which at the `c = 0` corner is the full basic fee.
  // Driving the loop off the stored LICENCE (the thing being charged) and looking the
  // verdict UP is what makes that venture visible; driving it off the rows would silently
  // give every 0% licence a free ride.
  //
  // AND THE ABSENT ROW IS GUARDED, because "no row ⇒ met" is only true for a venture that
  // owed NOTHING. `resolveProduction` routes every good whose aggregate `Q` is positive
  // and emits a target row for every venture with a positive contribution to it, so a
  // committed licence ALWAYS has a real boundary verdict — a missing one is a broken
  // state, not a free window. Reading it as `met` would charge the DISCOUNT on a contract
  // that was never judged: the quietest possible undercharge, invisible in every balance
  // and every test. So it halts instead, naming the tick and the offending values (§15.5:
  // a silent violation is worse than a crash). The predicate is `committedContribution` —
  // the SAME function the resolver builds its targets from, so the guard cannot disagree
  // with the thing it guards about which ventures were owed a row.
  //
  // A venture with a commitment but NO stored licence — the throwaway
  // `setSyndicateCommitment` dev scaffold — is skipped: it has no `basicFee` to charge,
  // and the scaffold's whole point is that it costs nothing.
  const feeVentures = {};
  let feeOwedHere = 0;
  if (isWindowBoundary(state.tick + 1, windowN, dayAnchorTick)) {
    for (const v of systemVentures) {
      if (!v.licence) continue;
      // The good the licence is judged in is the one the venture PRODUCES — its
      // `resourceType` for a mine, its recipe's output for a factory (`producedGoodFor`,
      // sim/baseline.js). This read used to be `v.resourceType`, which was right only
      // while a factory could not be licensed: after the factory-commitment slice it
      // would have found no window for a licensed factory, and the guard below would
      // have halted the tick on a licence that was in fact judged perfectly well.
      const committedGood = producedGoodFor(v);
      const win = (report.goods[committedGood] || {}).window;
      const row = win && win.perVenture ? win.perVenture[v.id] : null;
      if (!row) {
        // Legal ONLY for a licence that owed zero units this window (§5's 0% floor, or a
        // fraction that leaves nothing owed). Anything else is a committed licence about
        // to be charged as met without having been judged — halt.
        const owedUnits = committedContribution(v, curWindowStart, windowN);
        if (owedUnits > 0) {
          throw new Error(`applyProduction: guild ${guild.id}'s licensed venture ${v.id} owed ${owedUnits} units of ${committedGood} in the window closing at tick ${state.tick + 1}, but the boundary produced no verdict for it — refusing to charge a committed licence the discounted fee it was never judged for`);
        }
      }
      const status = row ? row.status : 'met';
      // The SAME window the verdict was computed against — `curWindowStart` and `windowN`
      // are the pair the resolver just used, so the fee can never be pro-rated by a
      // fraction from a different window than the one it is paying for (§5: one fraction,
      // applied once to the target and once to the fee).
      const owed = feeOwed(v.licence, status, windowFraction(v, curWindowStart, windowN));
      feeOwedHere += owed;
      // ── REPUTATION (RP slice 1, docs/points-and-reputation.md §6 step 1) ──────────
      // The SAME `status`, read from the SAME row, in the SAME loop as the fee — never
      // recomputed. That is the whole mechanism: a venture cannot be charged as breached
      // and credited as met, because there is exactly one verdict and both consumers
      // take it from this one variable. It also makes design.md §15.5 invariant 8 —
      // "reputation moves only on measurable events" — structural rather than a promise:
      // the only thing that can move RP is a boundary this loop reached.
      //
      // ONCE PER LICENSED VENTURE PER BOUNDARY, by construction, because that is what
      // this loop already is — it is the fee loop, guarded by `isWindowBoundary` and
      // driven off the stored licence. A non-boundary tick never enters it; a guild with
      // no licensed venture never reaches the body. So there is no separate "have we
      // already done this window?" bookkeeping to get wrong, and none is added.
      //
      // FLAT, and deliberately so: `reputationDelta` returns +REP_MEET_FLAT or
      // -REP_BREACH_FLAT with no reference to the venture's terms. The terms-scaled
      // meet, the inverse-commitment breach, the gain taper, the 1500 soft cap and the
      // -500 closure are the NEXT slice (§2.2-2.3) and none of them is here — RP is a
      // running integer with no band and no clamp.
      //
      // The venture's own total and the guild's cached sum move by the SAME delta, in
      // one place, so `guild.guildReputation == Σ venture.reputation` holds by
      // construction and `checkGuildReputationSum` (invariants.js) has to catch only a
      // future writer that forgets this pairing — which is exactly what it is for.
      // `(v.reputation || 0)` is the one place the omitted-when-0 absence is read as
      // zero, the same courtesy `equityOf` does for `equityPct`.
      const repDelta = reputationDelta(status);
      v.reputation = (v.reputation || 0) + repDelta;
      guild.guildReputation += repDelta;
      feeVentures[v.id] = {
        status, owed, basicFee: v.licence.basicFee, discountedFee: v.licence.discountedFee,
      };
    }
  }

  // Record this tick's per-good sample into the rolling production/consumption
  // HISTORY (guild.productionHistory, sim/history.js) — the engine-owned buffer the
  // console's two trend sparklines are drawn from. Two numbers per good, and they are
  // deliberately the SAME two the browser's old client-side buffer recorded, so the
  // line the player sees is unchanged and only its SOURCE moved into the engine:
  //   - produced = this tick's OUTPUT of the good here: Σ the mines' fresh deposits PLUS
  //     Σ the refineries' `minted` for the good they mint. That sum is exactly what the
  //     console's producer stack lists under "Production" (`producersOf` in
  //     client/console.html walks `mines` then `refineries`), and it is what the old
  //     client buffer recorded through its `sumAmount(producers)` path.
  //   - consumed = the DOWNSTREAM DRAW (`fork.downstream`, what the lines really took).
  //
  // Production is summed from the report's `mines`/`refineries` rather than read off
  // `report.goods[good].fresh` for two reasons, and the second is a correction: (1) a
  // mined good with no in-system consumer and no commitment is never routed and has NO
  // `goods` entry at all — yet it is producing; (2) `fresh` used to count MINE output
  // only, so a refined good that DOES have a `goods` entry would record 0 production
  // while its refinery visibly minted units. The old client hit exactly that case and
  // plotted a flat zero under a producing refinery. *(Reason (2) is now also fixed at
  // source — the factory-commitment slice made `fresh` the units produced here this
  // tick, minted included — but reason (1) stands on its own and this stays the
  // producer-side sum either way.)* Every other case is byte-for-byte the number it
  // recorded.
  //
  // SPARSE + CONTIGUOUS: a key is minted only for a good that actually moved this tick,
  // so a galaxy where nothing is produced writes nothing (the byte-identical no-op that
  // makes the golden regen provable); but once a good HAS a series, every tick it is
  // still visible here pushes a sample — a `0` on a lull included — because a gap would
  // draw a slope between two ticks that are not adjacent. Sorted good order for
  // determinism (invariant 9), matching the two loops above.
  const producedByGood = {};
  for (const m of report.mines) producedByGood[m.good] = (producedByGood[m.good] || 0) + m.amount;
  for (const r of report.refineries) {
    if (r.minted <= 0) continue;
    const recipe = getRecipe(byId.get(r.ventureId).recipeId);
    const out = recipe.output.good;
    producedByGood[out] = (producedByGood[out] || 0) + r.minted;
  }
  const sampledGoods = [...new Set([...Object.keys(producedByGood), ...Object.keys(report.goods)])].sort();
  for (const good of sampledGoods) {
    const produced = producedByGood[good] || 0;
    const entry = report.goods[good];
    const consumed = (entry && entry.fork) ? (entry.fork.downstream || 0) : 0;
    if (produced <= 0 && consumed <= 0 && !getHistory(guild, systemId, good)) continue;
    pushHistory(guild, systemId, good, produced, consumed);
  }

  // Accumulate this (guild, system)'s DOWNSTREAM DRAW per good into the tick's
  // scratch context, for step 3's idleness term. `fork.downstream` is the report's
  // ACTUAL consumer draw — the same number this step just debited from the pool — so
  // the price step reads a fact production already established instead of resolving
  // production a second time. The scratch is per-tick telemetry, never state: it
  // does not serialize and does not enter the determinism hash. Sorted good order
  // for determinism (invariant 9), matching the two loops above; a direct
  // applyProduction call with no ctx (a test) simply skips it.
  if (ctx) {
    for (const good of Object.keys(report.goods).sort()) {
      const drawn = report.goods[good].fork.downstream;
      if (drawn > 0) ctx.consumed[good] = (ctx.consumed[good] || 0) + drawn;
    }
  }

  // The licence-fee accrual for this (guild, system), or null when there is nothing to
  // charge — no boundary, or no licensed venture here. The caller applies it.
  return Object.keys(feeVentures).length > 0
    ? { owed: feeOwedHere, ventures: feeVentures }
    : null;
}

// recordLicenceFee(...) — stamp the boundary charge onto the guild, so a reader can say
// WHO was charged, HOW MUCH, and met-or-breached without recomputing anything (§5's
// display rule). Like `recordSale` above this is a RECORD OF AN EVENT, not a second copy
// of a derivable fact (invariant 5): the verdict is momentary — the moment this tick ends
// the window rolls, the delivered pile resets and the met/breach that priced the fee is
// gone, so there is nowhere else it could ever be read from again.
//
// `tick` is the PRODUCING tick (the boundary), matching recordSale's convention, so a
// reader compares it against `state.tick`/`snapshot.tick` with no off-by-one. The record
// is REPLACED at each boundary, never accumulated across windows, and it is written only
// where a licensed venture was judged — an unlicensed guild carries no key at all.
function recordLicenceFee(guild, tick, charged, ventures) {
  guild.lastLicenceFee = { tick, charged, ventures };
}

// recordSale(...) — stamp what the Syndicate just bought onto the guild, so the
// console can say "you earned N credits from your commitment this tick" without the
// browser recomputing anything (§5's display rule). This is a RECORD OF AN EVENT, not
// a second copy of a derivable fact (invariant 5): once the tick is over neither the
// price nor the pile it was sold from can be recovered from state, so there is nowhere
// else this could be read from.
//
// `tick` is the PRODUCING tick — the tick number of the state this step yields — so a
// reader compares it against `state.tick`/`snapshot.tick` directly, with no off-by-one
// (the same convention applyProduction already passes to the resolver). The record is
// REPLACED, not accumulated, when a new tick's first sale lands, and accumulates across
// a guild's several systems within one tick. It is written LAZILY — only by a real
// sale — so a guild that has never sold carries no key and the unlicensed path stays
// byte-identical (the same discipline as guild.syndicateWindows).
function recordSale(guild, tick, good, units, price, credited) {
  if (!guild.lastSyndicateSale || guild.lastSyndicateSale.tick !== tick) {
    guild.lastSyndicateSale = { tick, credited: 0, goods: {} };
  }
  const sale = guild.lastSyndicateSale;
  sale.credited += credited;
  const row = sale.goods[good] || { units: 0, price, credited: 0 };
  row.units += units;
  row.price = price;   // one posted price per good per tick — the same value every system sold at
  row.credited += credited;
  sale.goods[good] = row;
}

// Step 2 — consumption. SEAM for spacecraft fuel burn against the shared
// allocation pool (docs/fuel-allocation-model.md) once Shipments/Vehicles
// exist. Ventures are NOT consumers here: production is renewable-powered
// and draws no Deuterium (§3 / open question #54).
function stepConsumption(state, _actions) {
  return state;
}

// Step 3 — price recompute. The Syndicate value per non-fuel good, recomputed
// EVERY tick and published PUBLISH_LAG ticks behind (docs/licence-and-price-system.md
// Part 1; §8/#42's posted price, now per-tick and lagged rather than per-window).
// The whole formula — level × idleness, EMA, slew, clamp, the publish pipeline —
// lives in sim/prices.js; this step is the seam that hands it the two inputs it
// cannot derive alone and writes the result back:
//   - the STOCK numerator comes from state.guilds as they stand right now (step 1
//     has already moved this tick's goods), derived inside recomputePrices via the
//     one supply selector — NOT from state.galacticSupply, which is the post-steps
//     cache and is still stale at this point in the tick;
//   - the CONSUMPTION signal (the idleness term) comes from the scratch context
//     stepProduction filled from its own report, so no production is re-resolved.
// This step moves no credits and no goods; it publishes the number, and — since the
// price-history slice — RECORDS it.
//
// THE HISTORY SAMPLE (sim/price-history.js). Once the posted value for this tick is
// settled, any tier whose bucket closes on this tick takes a point sample of it (the
// closing price). It goes here, right after the recompute, for one reason: this is
// the only place in the tick where "the posted price for tick T" exists and is final.
// The tick argument is the PRODUCING tick — `state.tick + 1`, the tick number of the
// state being built (`next.tick` is assigned after the steps run) — matching the
// convention recordSale and the window boundary already use, so a sample's position
// in the ring lines up with `snapshot.tick` with no off-by-one.
function stepPriceRecompute(state, _actions, ctx) {
  state.prices = recomputePrices(state, ctx ? ctx.consumed : {});
  recordPriceSamples(state, state.tick + 1);
  return state;
}

// Step 4 — scheduled events. Anything with a due-tick (contest-window
// closures now; the change calculator's interceptions later, §15.6).
// SEAM: no scheduled events exist yet — no territory/contests built.
function stepScheduledEvents(state, _actions) {
  return state;
}

// Step 5 — arrivals. Shipments that reach their destination this tick.
//
// FILLED 29-08-26 by the Syndicate BUY engine (design.md §6, "Syndicate Delivery
// — the BUY side"). `buyFromSyndicate` debits the cash and pushes a pending
// delivery onto `state.shipments`; this is the half that lands it.
//
// THE PURE SCHEDULE (§15.6). A delivery that has not arrived costs NOTHING here:
// the loop reads `arrivalTick` and moves on. There is no per-tick progress to
// advance, because a straight line at a fixed speed has no state between
// departure and arrival — its position at any tick is arithmetic nobody needs.
//
// `state.tick` is still the PREVIOUS tick's number inside a step (tick() assigns
// `next.tick` only after all eight have run), so the tick BEING BUILT is
// `state.tick + 1` — the same convention stepPriceRecompute uses. `<=` rather
// than `===` so a delivery whose tick has somehow already passed still lands
// instead of being stranded in the list forever.
function stepArrivals(state, _actions) {
  const shipments = state.shipments;
  if (!Array.isArray(shipments) || shipments.length === 0) return state;

  const thisTick = state.tick + 1;
  const due = [];
  const pending = [];
  for (const ship of shipments) {
    (ship.arrivalTick <= thisTick ? due : pending).push(ship);
  }
  if (due.length === 0) return state;

  // A FIXED order for the deposits (invariant 9). Addition commutes, so no total
  // depends on this — which is exactly why it must be pinned anyway: the day a
  // step's outcome DOES depend on order, the order must already be a decision
  // rather than whatever the array happened to hold. Sort is stable, so equal
  // keys keep their (deterministic) insertion order.
  due.sort((a, b) => (
    a.arrivalTick - b.arrivalTick
    || cmp(a.destinationSystemId, b.destinationSystemId)
    || cmp(a.ownerGuildId, b.ownerGuildId)
  ));

  for (const ship of due) {
    // THE VANISH CHECK (§6). The same `guildHolds` predicate the purchase was
    // validated against: if the buying guild no longer holds the destination,
    // contact with the craft is lost — no deposit, no refund, no divert.
    //
    // Conservation-clean by construction: the cargo was never in a stockpile (a
    // scheduled deposit, not held inventory, so galactic supply never counted
    // it) and the cash moved to the ledger at purchase (so invariant 2 was
    // settled ticks ago). Dropping the shipment therefore imbalances nothing —
    // it is a loss the player owns, not a hole in the books.
    if (!guildHolds(state, ship.ownerGuildId, ship.destinationSystemId)) continue;

    const guild = (state.guilds || []).find((g) => g.id === ship.ownerGuildId);
    if (!guild) {
      // A live claim naming a guild that does not exist is a broken state, not a
      // lost delivery — halt loudly with the tick rather than quietly vanish
      // goods for a reason nobody chose (§15.5).
      throw new Error(`stepArrivals: shipment for guild ${JSON.stringify(ship.ownerGuildId)} arriving at tick ${thisTick} holds a claim on ${JSON.stringify(ship.destinationSystemId)} but no such guild exists`);
    }
    // Goods sorted so the sequence of mutations within one cargo is fixed too.
    for (const good of Object.keys(ship.cargo || {}).sort()) {
      addStock(guild, ship.destinationSystemId, good, ship.cargo[good]);
    }
  }

  // Delivered AND vanished shipments both leave the list — an arrived delivery is
  // finished either way, and a shipment nobody will ever land is exactly the kind
  // of record that accumulates forever if "arrived" and "deposited" are conflated.
  state.shipments = pending;
  // NO galacticSupply refresh here, deliberately. Unlike sellToSyndicate — an
  // ACTION, applied by intake with no tick around it, so it must refresh the
  // cache itself — a tick STEP is followed by tick()'s own end-of-steps derive
  // pass, which recomputes the cache from whatever the eight steps produced. The
  // tick owns the cache; a step that re-derived it would be a second opinion.
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

  // The per-tick SCRATCH context: within-tick facts one step establishes and a
  // later step reads (today: the per-good downstream draw stepProduction resolved,
  // which step 3's idleness term needs). It is deliberately NOT state — it never
  // serializes, never enters the determinism hash, and starts empty every tick — so
  // a step can hand a fact forward without a fact getting a second home (invariant 5).
  const ctx = { consumed: {} };

  let next = cloneState(state);
  for (const step of STEPS) {
    next = step(next, actions, ctx);
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
