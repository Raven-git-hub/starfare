'use strict';

// invariants.js — the tripwires. Everything else in sim/ exists to keep these
// true (design.md §15.5). Asserted EVERY tick; a silent violation is worse than
// a crash, so assertInvariants throws loudly with the tick number and the exact
// offending values.
//
// This file checks invariants 1, 2, and 3. Invariant 9 (determinism) is not a
// within-a-single-run check — it is verified across two runs by comparing
// serialize.hashState(), and lands as its own test with the walking skeleton.
//
// ---------------------------------------------------------------------------
// The slice of state this harness reads (full entity shapes: design.md §15.4).
// state.js must populate these fields; nothing here invents a game number.
//
//   state.guilds     : [{ id, credits, fuelHoard, influence?, stockpiles?,
//                         ventures? (each: siteId?, resourceType? | recipeId?,
//                         productionRate?), homeSystemId?, homePlanetId? }]
//   state.claims?    : [{ claimId, ownerGuildId, landmarkId, landmarkKind }]
//                          // SHARED territory rows; reference real seed landmarks
//   state.reserve    : { reserveLevel }                    // SHARED fuel reserve
//   state.syndicate  : { ledger }         // credits; may be negative (see below)
//   state.shipments? : [{ cargo: { fuel? } }]   // fuel in transit; none yet in
//                                               // the walking skeleton
//   state.audit      : { totalProduced, totalConsumed, expectedCreditTotal }
//   state.galacticSupply : { resources: {good->int}, fuel: {reserve, guildHeld} }
//                          // DERIVED cache; checked against the live sum here
//   state.prices?    : { <non-fuel good>: { posted, pending: [...] } }
//                          // the Syndicate value per good (sim/prices.js); floats by
//                          // design — sanity-checked here, not integer-swept
//   venture.committedFromTick? : the venture's first PRODUCING tick under its licence
//                          // (Slice 3b-ii); absent = present since before the window
//   venture.licence? : { committedOutputPct, windowDays, signedTick, lockedPrice,
//                        basicFee, discountedFee }   // the terms locked at signing
//                          // (Slice 3b-i); absent on an unlicensed venture
//   guild.lastSyndicateSale? : { tick, credited, goods: {good: {units, price, credited}} }
//                          // what the Syndicate bought from this guild, last time it
//                          // bought anything (Slice 3a); absent until a first sale
//
// audit.* are GLOBAL bookkeeping counters, not game numbers — they are the
// running totals invariants 1 and 2 are literally *defined against*:
//   - totalProduced / totalConsumed are monotonic fuel counters. Invariant 1 is
//     the equation Σ hoards + reserve + in-transit = produced − consumed.
//   - expectedCreditTotal changes ONLY when a sanctioned credit source/sink fires
//     (baseline allocation, Syndicate fee, fine) and records its delta there.
//     Checking the live total against it makes invariant 2 robust to whether
//     baseline income is minted or paid out of the Syndicate ledger — either
//     way, the one sanctioned delta is recorded and nothing else may move credits.
//
// The Syndicate ledger is the credit-conservation balancing account: it is a
// real credits figure that is EXEMPT from non-negativity (it may go negative to
// fund baseline allocation), but it must still be an integer like all credits.
// ---------------------------------------------------------------------------

// One violation record shape everywhere: { rule, where, detail }.

const { isRawResource, isStockpileGood, FUEL_GOOD } = require('./resources.js');
const { PRICED_GOODS, PRICE_FLOOR, PRICE_CEILING, PUBLISH_LAG } = require('./prices.js');
const { EQUITY_CEILING, WINDOW_DAYS_MIN, WINDOW_DAYS_MAX, isValidWindowDays } = require('./licence.js');
const { FIRST_CUT_WINDOW_N, winStartFor, windowFraction } = require('./windows.js');
const { computeGalacticSupply } = require('./supply.js');
const { getSite, getLandmark, getSystem, getTerranHomeworld } = require('./seed.js');
const { getRecipe } = require('./recipes.js');

function sumFuelInTransit(state) {
  if (!Array.isArray(state.shipments)) return 0;
  let total = 0;
  for (const ship of state.shipments) {
    total += (ship.cargo && ship.cargo.fuel) || 0;
  }
  return total;
}

// Invariant 1 — conservation of fuel.
function checkFuelConservation(state) {
  const hoards = state.guilds.reduce((sum, g) => sum + g.fuelHoard, 0);
  const inTransit = sumFuelInTransit(state);
  const lhs = hoards + state.reserve.reserveLevel + inTransit;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  if (lhs !== rhs) {
    return [{
      rule: 'conservation-of-fuel (invariant 1)',
      where: 'global',
      detail: {
        hoards, reserve: state.reserve.reserveLevel, inTransit,
        lhs, rhs,
        produced: state.audit.totalProduced, consumed: state.audit.totalConsumed,
      },
    }];
  }
  return [];
}

// Invariant 2 — conservation of credits.
function checkCreditConservation(state) {
  const guildCredits = state.guilds.reduce((sum, g) => sum + g.credits, 0);
  const actual = guildCredits + state.syndicate.ledger;
  const expected = state.audit.expectedCreditTotal;
  if (actual !== expected) {
    return [{
      rule: 'conservation-of-credits (invariant 2)',
      where: 'global',
      detail: { guildCredits, syndicateLedger: state.syndicate.ledger, actual, expected },
    }];
  }
  return [];
}

// Checks one numeric field for the §15.2 conventions and (optionally) invariant
// 3 non-negativity. Pushes a separate record per broken rule so a report can
// show everything wrong at once.
function checkField(out, value, where, { nonNegative = true } = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    out.push({ rule: 'finite-number (§15.2)', where, detail: { value } });
    return; // further checks are meaningless on a non-number
  }
  if (!Number.isInteger(value)) {
    out.push({ rule: 'integer credits/goods (§15.2)', where, detail: { value } });
  }
  if (nonNegative && value < 0) {
    out.push({ rule: 'non-negativity (invariant 3)', where, detail: { value } });
  }
}

// Invariant 3 — non-negativity — plus the §15.2 integer convention, which is
// cheap to check here and catches the exact fractional-credit drift the
// spreadsheet port has to avoid.
function checkNonNegativityAndIntegrality(state) {
  const out = [];

  for (const g of state.guilds) {
    checkField(out, g.credits, `guild:${g.id}.credits`);
    checkField(out, g.fuelHoard, `guild:${g.id}.fuelHoard`);
    if (g.influence !== undefined) checkField(out, g.influence, `guild:${g.id}.influence`);

    // Stockpiles (ruling B1, §15.2): a NESTED map systemId -> good -> int. Every
    // value is an integer, non-negative; every good key is a known stockpile good
    // — raw OR processed (a stray/misspelled key would silently vanish from the
    // galactic totals, so catch it here, not let it rot). Checked per system pool.
    if (g.stockpiles) {
      for (const [systemId, pool] of Object.entries(g.stockpiles)) {
        for (const [good, qty] of Object.entries(pool || {})) {
          checkField(out, qty, `guild:${g.id}.stockpiles.${systemId}.${good}`);
          if (!isStockpileGood(good)) {
            out.push({ rule: 'known-good (resources.js)', where: `guild:${g.id}.stockpiles.${systemId}.${good}`, detail: { good } });
          }
        }
      }
    }

    if (Array.isArray(g.ventures)) {
      for (const ven of g.ventures) {
        if (ven.inputStockpiles) {
          for (const [good, qty] of Object.entries(ven.inputStockpiles)) {
            checkField(out, qty, `venture:${ven.id}.inputStockpiles.${good}`);
          }
        }
        // syndicateCommitment — a per-window committed QUANTITY OF GOODS, so it obeys
        // §15.2 like any other: a whole number, never negative. Both intake paths guard
        // it (`setSyndicateCommitment` validates, `applyForLicence` computes it with
        // `Math.round`), but a venture built DIRECTLY by a scenario or a test bypasses
        // intake entirely — the case this file exists for — and neither failure is loud
        // on its own: a FRACTIONAL value hides inside `Q`'s own `Math.round`
        // (production.js), and a NEGATIVE one SUBTRACTS from its good's aggregate `Q`
        // and silently shrinks a sibling mine's target, so the sibling breaches a
        // contract it was meeting. Absent (the unlicensed majority) is legal.
        if (ven.syndicateCommitment !== undefined) {
          checkField(out, ven.syndicateCommitment, `venture:${ven.id}.syndicateCommitment`);
        }
      }
    }
  }

  checkField(out, state.reserve.reserveLevel, 'reserve.reserveLevel');

  // Syndicate ledger: integer like any credits figure, but exempt from
  // non-negativity — it is the balancing account that funds baseline allocation.
  checkField(out, state.syndicate.ledger, 'syndicate.ledger', { nonNegative: false });

  return out;
}

// Batch carries — the sanctioned non-integers (§5 rate-based rewrite, Ruling 2 as
// generalized by the "Correction — the recipe ratio"). Each venture carries a
// per-good sub-unit remainder in Venture.batchCarry (every recipe input AND the
// output), and EVERY entry must stay in [0, 1): a value ≥ 1 means a whole unit that
// should have been drawn/minted was left uncarried (goods silently mis-ledgered),
// and a negative value is nonsense. The carries are fenced OFF the integer sweep
// above (units drawn/minted stay integer; the carries are draw/mint-TIMING state),
// so they get their own tripwire here. A venture with no map yet (undefined) is
// legal; only a present, out-of-range entry trips.
function checkBatchCarry(state) {
  const out = [];
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.batchCarry === undefined) continue;
      for (const [good, frac] of Object.entries(v.batchCarry)) {
        if (typeof frac !== 'number' || Number.isNaN(frac) || frac < 0 || frac >= 1) {
          out.push({ rule: 'batch-carry-in-[0,1) (§5 Ruling 2)', where: `venture:${v.id}.batchCarry.${good}`, detail: { value: frac } });
        }
      }
    }
  }
  return out;
}

// Syndicate windowed-accrual state — the engine-owned per-(system, good) window
// bookkeeping (guild.syndicateWindows, §5 Slice B-i, sim/windows.js). `windowStart`
// and `delivered` are conserved-integer state (delivered is a running unit count that
// must be a whole non-negative number; windowStart is the tick a window opened, a
// positive integer). `sendCarry` is the sanctioned NON-integer — the fractional send
// remainder, fenced OFF the goods ledger in [0, 1) with its own tripwire, exactly like
// batchCarry: a value ≥ 1 means a whole unit that should have been delivered was left
// uncarried, a negative one is nonsense. A guild with no committed goods has no
// syndicateWindows field at all (legal — the no-op path); only present, out-of-range
// values trip.
function checkSyndicateWindows(state) {
  const out = [];
  for (const g of state.guilds || []) {
    if (!g.syndicateWindows) continue;
    for (const [systemId, perGood] of Object.entries(g.syndicateWindows)) {
      for (const [good, win] of Object.entries(perGood || {})) {
        const where = `guild:${g.id}.syndicateWindows.${systemId}.${good}`;
        checkField(out, win.delivered, `${where}.delivered`);
        checkField(out, win.windowStart, `${where}.windowStart`);
        // A window opens on a REAL producing tick, and ticks start at 1 (`winStartFor`
        // maps window k to `(k−1)·N + 1`), so 0 is not a small window-start — it is a
        // window that never opened. `checkField`'s non-negativity allows it, hence this.
        if (Number.isInteger(win.windowStart) && win.windowStart < 1) {
          out.push({ rule: 'window-start-is-a-real-tick (§5 Slice B)', where: `${where}.windowStart`, detail: { value: win.windowStart } });
        }
        // NOT checked here: `delivered ≤ Q`. `Q` is deliberately NOT stored (invariant
        // 5 — the venture commitments are its single source), so asserting it would
        // mean recomputing the per-venture sum inside this sweep. Left to the
        // distribution slice, which walks the ventures at the boundary anyway.
        const c = win.sendCarry;
        if (typeof c !== 'number' || Number.isNaN(c) || c < 0 || c >= 1) {
          out.push({ rule: 'send-carry-in-[0,1) (§5 Slice B)', where: `${where}.sendCarry`, detail: { value: c } });
        }
      }
    }
  }
  return out;
}

// Licence terms + the commitment-sale record (Slices 3a/3b-i, §5 "Output commitment",
// "Equity offered", and "LICENCE FEE MECHANICS"). Three things a tick may now touch
// that the integer sweep above does not cover:
//
//   - `Venture.equityPct` — the offered equity share `o`. A FRACTION, so it is one of
//     the sanctioned non-integers (it scales credits, it is not credits), and it must
//     stay inside §5's structural [0, 49%] ceiling: an `o` above it would mean an owner
//     who no longer controls its own venture, which the design forbids outright. The
//     establish action refuses one, but a venture built directly (a scenario, an inline
//     founding venture) bypasses that, so the tick asserts it too. Absent = 0 = legal.
//   - `Guild.lastSyndicateSale` — the record of what the Syndicate bought this tick.
//     Its credit figures are real credits and must be whole (§15.2); its `credited`
//     total must equal the sum of its per-good rows, or the console would report a
//     number the ledger never moved. Absent (nothing ever sold) is legal.
//
// This checks the RECORD's internal consistency, not the credit movement itself — the
// movement is already covered, exactly, by invariant 2 above: the sale pays the guild
// and debits the ledger by one identical integer, so any drift between them is a
// conservation break and fails there first.
function checkLicenceTerms(state) {
  const out = [];
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.equityPct !== undefined) {
        const o = v.equityPct;
        if (typeof o !== 'number' || !Number.isFinite(o) || o < 0 || o > EQUITY_CEILING) {
          out.push({ rule: 'equity-within-ceiling (§5)', where: `venture:${v.id}.equityPct`, detail: { value: o, ceiling: EQUITY_CEILING } });
        }
      }

      // The licence's stored terms (Slice 3b-i). These are LOCKED numbers — computed
      // once at signing and never recomputed — so nothing downstream will ever
      // re-derive them and notice they went wrong: if a bad fee is written it simply
      // stays, and 3b-iii will one day debit it. Hence a tripwire on the stored values
      // themselves. The fees are real credits and must be whole (§15.2); the discount
      // can never EXCEED the basic fee (the grid's corners top out at 100%); and the
      // terms must stay inside the bounds intake refuses outside of, since a venture
      // built directly by a scenario bypasses intake entirely.
      // The mid-window pro-rate's join tick (Slice 3b-ii, §5's join ruling). This
      // REPLACES the deferral guard that used to assert `windowFraction == 1` for every
      // venture — that guard existed to catch a mid-window join being wired without the
      // pro-rate, and the pro-rate is now wired. What matters instead is that the
      // fraction it produces is SANE: a committed venture is present for at least one
      // tick of any window it is counted in, so its fraction is in (0, 1] — never 0 (it
      // would owe nothing while still delivering) and never above 1 (it would owe more
      // than a full window). A fabricated or corrupted `committedFromTick` is exactly
      // what would break that, silently, in the direction of a target nobody can meet.
      if (v.committedFromTick !== undefined) {
        const from = v.committedFromTick;
        const at = `venture:${v.id}.committedFromTick`;
        if (!Number.isInteger(from) || from < 1) {
          out.push({ rule: 'join-tick-is-a-real-tick (§5 join ruling)', where: at, detail: { value: from } });
        } else if (v.syndicateCommitment) {
          // The range check. Be honest about what it is: for an integer join tick ≥ 1
          // the fraction is in (0, 1] BY CONSTRUCTION, so no corrupted datum can trip
          // this — it is a guard on the MATH, and it goes red if windowFraction's
          // formula, or the tick the stamp is written at, ever changes in a way that
          // would hand a venture a target it cannot meet (owing nothing while
          // delivering, or owing more than a whole window). That is the exact failure
          // this slice exists to end, so it is worth a standing assertion.
          //
          // Checked against the venture's OWN first window — always well-defined — and
          // deliberately not ONLY against `state.tick`'s window: between intake and the
          // tick that follows it, `committedFromTick` is legitimately `state.tick + 1`,
          // so a check keyed on the live window alone would fire spuriously on a licence
          // signed on a boundary tick. The live window is checked too, once the venture
          // has actually started producing.
          const N = state.windowN == null ? FIRST_CUT_WINDOW_N : state.windowN;
          const windows = [winStartFor(from, N)];
          if (from <= state.tick) windows.push(winStartFor(state.tick, N));
          for (const ws of windows) {
            const f = windowFraction(v, ws, N);
            if (!(f > 0) || f > 1) {
              out.push({ rule: 'window-fraction-in-(0,1] (§5 join ruling)', where: at, detail: { committedFromTick: from, windowStart: ws, N, fraction: f } });
            }
          }
        }
      }

      const lic = v.licence;
      if (!lic) continue;
      const at = `venture:${v.id}.licence`;

      // A committed, LICENSED venture must carry its join tick. The whole mid-window
      // pro-rate rests on one assignment in `applyForLicence`, and nothing downstream
      // notices its absence: `windowFraction` reads a missing stamp as "present since
      // before the window opened" and returns 1, so a mine that joined yesterday
      // silently owes a WHOLE window's Q — the exact unfairness Slice 3b-ii exists to
      // end, back again and invisible. Only a licensed venture is asserted: the
      // `setSyndicateCommitment` dev scaffold deliberately carries no stamp (it commits
      // for the whole window by design), and it grants no licence.
      if (v.syndicateCommitment > 0 && v.committedFromTick === undefined) {
        out.push({ rule: 'licensed-commitment-carries-a-join-tick (§5 join ruling)', where: `venture:${v.id}.committedFromTick`, detail: { syndicateCommitment: v.syndicateCommitment, signedTick: lic.signedTick } });
      }

      // And it must be the DOCUMENTED stamp: `signedTick + 1`, the venture's first
      // PRODUCING tick (actions.js — intake runs before the tick, so a licence signed
      // while state.tick is T first produces on the tick yielding T+1). The range check
      // above cannot catch a wrong one: for ANY integer ≥ 1 the fraction it yields is in
      // (0, 1] by construction, so an off-by-one (`signedTick`, crediting the venture
      // with a tick it could never produce in) or a far-future stamp (owing almost
      // nothing) both sail through it. This checks the stamp against the licence that
      // set it, which is the only thing that can tell them apart.
      if (v.committedFromTick !== undefined && Number.isInteger(lic.signedTick)
        && v.committedFromTick !== lic.signedTick + 1) {
        out.push({ rule: 'join-tick-is-signedTick+1 (§5 join ruling)', where: `venture:${v.id}.committedFromTick`, detail: { committedFromTick: v.committedFromTick, signedTick: lic.signedTick, expected: lic.signedTick + 1 } });
      }
      checkField(out, lic.basicFee, `${at}.basicFee`);
      checkField(out, lic.discountedFee, `${at}.discountedFee`);
      checkField(out, lic.signedTick, `${at}.signedTick`);
      if (lic.discountedFee > lic.basicFee) {
        out.push({ rule: 'discount-never-exceeds-basic-fee (§5 grid)', where: `${at}.discountedFee`, detail: { discountedFee: lic.discountedFee, basicFee: lic.basicFee } });
      }
      if (typeof lic.committedOutputPct !== 'number' || !Number.isFinite(lic.committedOutputPct)
        || lic.committedOutputPct < 0 || lic.committedOutputPct > 1) {
        out.push({ rule: 'commitment-is-a-fraction (§5)', where: `${at}.committedOutputPct`, detail: { value: lic.committedOutputPct } });
      }
      if (!isValidWindowDays(lic.windowDays)) {
        out.push({ rule: 'renegotiation-window-in-bounds (§5)', where: `${at}.windowDays`, detail: { value: lic.windowDays, min: WINDOW_DAYS_MIN, max: WINDOW_DAYS_MAX } });
      }
      if (typeof lic.lockedPrice !== 'number' || !Number.isFinite(lic.lockedPrice) || lic.lockedPrice <= 0) {
        out.push({ rule: 'locked-price-is-a-real-price (Slice 3b-i)', where: `${at}.lockedPrice`, detail: { value: lic.lockedPrice } });
      }
    }

    const sale = g.lastSyndicateSale;
    if (!sale) continue;
    const where = `guild:${g.id}.lastSyndicateSale`;
    checkField(out, sale.tick, `${where}.tick`);
    checkField(out, sale.credited, `${where}.credited`);
    let sum = 0;
    for (const [good, row] of Object.entries(sale.goods || {})) {
      checkField(out, row.units, `${where}.goods.${good}.units`);
      checkField(out, row.credited, `${where}.goods.${good}.credited`);
      if (typeof row.price !== 'number' || !Number.isFinite(row.price)) {
        out.push({ rule: 'sale-price-finite (Slice 3a)', where: `${where}.goods.${good}.price`, detail: { value: row.price } });
      }
      sum += row.credited;
    }
    if (sum !== sale.credited) {
      out.push({ rule: 'sale-total-matches-rows (Slice 3a)', where: `${where}.credited`, detail: { total: sale.credited, sumOfRows: sum } });
    }
  }
  return out;
}

// Price sanity — the per-good Syndicate value (state.prices, sim/prices.js). Like
// batchCarry and sendCarry, prices are SANCTIONED NON-INTEGERS fenced off the goods
// ledger, so the integer sweep above skips them and they get their own tripwire here.
// A NaN or Infinity price is the exact failure that would rot silently: nothing reads
// the price yet, but the moment the licence slice denominates credits in it, a poisoned
// value would spread through the ledger before anyone noticed. So: every priced good
// present, every value finite and inside the clamp band, the publish pipeline the right
// depth, and NO row for fuel (never listed, §8). A state with no price block at all is
// legal (a pre-price-engine save, or a hand-built test fixture); only a present, broken
// one trips.
function checkPrices(state) {
  const out = [];
  if (!state.prices) return out;
  const inBand = (v) => typeof v === 'number' && Number.isFinite(v) && v >= PRICE_FLOOR && v <= PRICE_CEILING;

  for (const good of PRICED_GOODS) {
    const row = state.prices[good];
    if (!row) {
      out.push({ rule: 'price-present (price engine)', where: `prices.${good}`, detail: { missing: true } });
      continue;
    }
    if (!inBand(row.posted)) {
      out.push({ rule: 'price-finite-and-in-band (price engine)', where: `prices.${good}.posted`, detail: { value: row.posted, floor: PRICE_FLOOR, ceiling: PRICE_CEILING } });
    }
    if (!Array.isArray(row.pending) || row.pending.length !== PUBLISH_LAG) {
      out.push({ rule: 'publish-pipeline-depth (price engine)', where: `prices.${good}.pending`, detail: { value: row.pending, expected: PUBLISH_LAG } });
      continue;
    }
    row.pending.forEach((v, i) => {
      if (!inBand(v)) {
        out.push({ rule: 'price-finite-and-in-band (price engine)', where: `prices.${good}.pending[${i}]`, detail: { value: v, floor: PRICE_FLOOR, ceiling: PRICE_CEILING } });
      }
    });
  }
  // A row for a good that is not priced at all — fuel above all — is stale or bogus.
  for (const good of Object.keys(state.prices)) {
    if (!PRICED_GOODS.includes(good)) {
      out.push({ rule: 'priced-good (price engine)', where: `prices.${good}`, detail: { good, fuel: good === FUEL_GOOD } });
    }
  }
  return out;
}

// Galactic-supply consistency — the derived totals cache (state.galacticSupply)
// must equal a fresh re-derivation from the guilds' actual stockpiles and the
// fuel figures. This is a CONSISTENCY check, not a conservation one: non-fuel
// resources are not conserved (mining mints them, selling sinks them into the
// Syndicate's infinite backend), so nothing here says a total is constant —
// only that the cache the viewer/telemetry reads never lies about the live sum.
// A missing cache on a real state is itself a violation: every state built by
// createState or produced by tick carries one.
function checkGalacticSupplyConsistency(state) {
  const out = [];
  const cache = state.galacticSupply;
  if (!cache || typeof cache !== 'object') {
    return [{ rule: 'galactic-supply-consistency', where: 'galacticSupply', detail: { missing: true } }];
  }
  const expected = computeGalacticSupply(state);

  const cacheRes = cache.resources || {};
  for (const [good, qty] of Object.entries(expected.resources)) {
    if (cacheRes[good] !== qty) {
      out.push({ rule: 'galactic-supply-consistency', where: `galacticSupply.resources.${good}`, detail: { cached: cacheRes[good], live: qty } });
    }
  }
  // A cached key that isn't a known resource (so never re-derived) is stale/bogus.
  for (const good of Object.keys(cacheRes)) {
    if (!(good in expected.resources)) {
      out.push({ rule: 'galactic-supply-consistency', where: `galacticSupply.resources.${good}`, detail: { cached: cacheRes[good], live: 'absent' } });
    }
  }

  const cacheFuel = cache.fuel || {};
  if (cacheFuel.reserve !== expected.fuel.reserve) {
    out.push({ rule: 'galactic-supply-consistency', where: 'galacticSupply.fuel.reserve', detail: { cached: cacheFuel.reserve, live: expected.fuel.reserve } });
  }
  if (cacheFuel.guildHeld !== expected.fuel.guildHeld) {
    out.push({ rule: 'galactic-supply-consistency', where: 'galacticSupply.fuel.guildHeld', detail: { cached: cacheFuel.guildHeld, live: expected.fuel.guildHeld } });
  }
  return out;
}

// Site occupancy / referential integrity — the first cross-check between live
// state and the static seed. Only SEATED ventures (those with a siteId) are
// checked; an unseated venture is legal (production runs off resourceType). For
// each seated venture:
//   - its siteId must resolve to a real seed node/slot (no dangling reference);
//   - a mining venture (resourceType set) must sit on a resource node, and that
//     node's resourceType must match the one driving its production — this is
//     the guard that lets resourceType stay a denormalised copy safely;
//   - at most one venture may occupy any given site.
function checkSiteOccupancy(state) {
  const out = [];
  const seenAt = new Map(); // siteId -> first ventureId that claimed it

  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (!v.siteId) continue; // unseated: nothing to check

      const site = getSite(v.siteId);
      if (!site) {
        out.push({ rule: 'site-exists (seed.js)', where: `venture:${v.id}.siteId`, detail: { siteId: v.siteId } });
        // fall through: still record the claim for duplicate detection
      } else if (v.resourceType != null) {
        // a mining venture: must be on a resource node whose good matches
        if (site.kind !== 'resource') {
          out.push({ rule: 'mining-venture-on-resource-node', where: `venture:${v.id}.siteId`, detail: { siteId: v.siteId, siteKind: site.kind } });
        } else if (site.resourceType !== v.resourceType) {
          out.push({ rule: 'venture-resource-matches-node', where: `venture:${v.id}.resourceType`, detail: { venture: v.resourceType, node: site.resourceType, siteId: v.siteId } });
        }
      } else if (v.recipeId != null) {
        // a refining venture: must sit on a settlement slot, and its recipe must
        // resolve (the territory analogue of a mining venture's node match).
        if (site.kind !== 'settlement') {
          out.push({ rule: 'refining-venture-on-settlement-slot', where: `venture:${v.id}.siteId`, detail: { siteId: v.siteId, siteKind: site.kind } });
        }
        if (!getRecipe(v.recipeId)) {
          out.push({ rule: 'recipe-exists (recipes.js)', where: `venture:${v.id}.recipeId`, detail: { recipeId: v.recipeId } });
        }
      }

      // The denormalised venture.systemId must match its site's system (ruling
      // B1, §15.2): production deposits into guild.stockpiles[systemId], so a
      // drifted copy would silently pool goods in the wrong system. Same guard
      // shape as venture-resource-matches-node above; only checked when both the
      // site and a systemId are present (a synthetic unseated venture has neither).
      if (site && v.systemId != null && v.systemId !== site.systemId) {
        out.push({ rule: 'venture-system-matches-site', where: `venture:${v.id}.systemId`, detail: { venture: v.systemId, site: site.systemId, siteId: v.siteId } });
      }

      if (seenAt.has(v.siteId)) {
        out.push({ rule: 'one-venture-per-site', where: `site:${v.siteId}`, detail: { siteId: v.siteId, ventures: [seenAt.get(v.siteId), v.id] } });
      } else {
        seenAt.set(v.siteId, v.id);
      }
    }
  }
  return out;
}

// Claim integrity — the territory analogue of site occupancy. Every claim in
// the SHARED territory layer names a seed landmark by (landmarkId, landmarkKind);
// each must resolve to a real landmark of that exact kind (a citadel-kind claim
// pointing at an outpost id fails, not resolves by luck). This is the referential
// half of "live state references the seed by id" (design.md §15.3) for territory.
function checkClaimIntegrity(state) {
  const out = [];
  for (const c of state.claims || []) {
    if (typeof c.landmarkId !== 'string' || typeof c.landmarkKind !== 'string') {
      out.push({ rule: 'claim-references-landmark', where: `claim:${c.claimId}`, detail: { landmarkId: c.landmarkId, landmarkKind: c.landmarkKind } });
      continue;
    }
    if (!getLandmark(c.landmarkId, c.landmarkKind)) {
      out.push({ rule: 'claim-landmark-exists (seed.js)', where: `claim:${c.claimId}`, detail: { landmarkId: c.landmarkId, landmarkKind: c.landmarkKind } });
    }
  }
  return out;
}

// Guild home integrity — a guild's homeSystemId/homePlanetId is a DENORMALISED
// pointer; this guards it against the seed and against the ownership source of
// truth (its claim), the same discipline that lets a mining venture's
// resourceType stay a denormalised copy. Only guilds WITH a home are checked; a
// homeless guild (e.g. one built directly by a test) is legal. For each home:
//   - the system resolves and is starter-eligible (design.md §13);
//   - homePlanetId is exactly that system's Terran homeworld (seed's authority);
//   - a matching home claim exists, owned by this guild (denormalisation agrees
//     with the ownership row).
function checkGuildHome(state) {
  const out = [];
  for (const g of state.guilds || []) {
    if (g.homeSystemId == null) continue; // homeless: nothing to check

    const sys = getSystem(g.homeSystemId);
    if (!sys || !sys.starterEligible) {
      out.push({ rule: 'home-is-starter-system (§13)', where: `guild:${g.id}.homeSystemId`, detail: { homeSystemId: g.homeSystemId, resolved: !!sys, starterEligible: sys ? sys.starterEligible : null } });
    } else {
      const homeworld = getTerranHomeworld(g.homeSystemId);
      if (g.homePlanetId !== homeworld) {
        out.push({ rule: 'home-planet-matches-seed', where: `guild:${g.id}.homePlanetId`, detail: { homePlanetId: g.homePlanetId, seedHomeworld: homeworld, homeSystemId: g.homeSystemId } });
      }
    }

    const claim = (state.claims || []).find((c) => c.landmarkId === g.homeSystemId && c.ownerGuildId === g.id);
    if (!claim) {
      out.push({ rule: 'home-claim-exists', where: `guild:${g.id}.homeSystemId`, detail: { homeSystemId: g.homeSystemId } });
    }
  }
  return out;
}

// Run all within-run invariants. Returns a (possibly empty) list of violations,
// each tagged with the tick.
function checkInvariants(state, tick) {
  const violations = [
    ...checkFuelConservation(state),
    ...checkCreditConservation(state),
    ...checkNonNegativityAndIntegrality(state),
    ...checkBatchCarry(state),
    ...checkSyndicateWindows(state),
    ...checkPrices(state),
    ...checkLicenceTerms(state),
    ...checkGalacticSupplyConsistency(state),
    ...checkSiteOccupancy(state),
    ...checkClaimIntegrity(state),
    ...checkGuildHome(state),
  ];
  return violations.map((v) => ({ ...v, tick }));
}

// Halt loudly on any violation. This is the "fail mechanically, don't drift"
// guarantee — the harness is the tripwire, not an AI review pass.
function assertInvariants(state, tick) {
  const violations = checkInvariants(state, tick);
  if (violations.length > 0) {
    throw new Error(
      `Invariant violation at tick ${tick}:\n${JSON.stringify(violations, null, 2)}`
    );
  }
}

module.exports = { checkInvariants, assertInvariants };
