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

const { isRawResource, isStockpileGood } = require('./resources.js');
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

    // Stockpiles: every value is an integer, non-negative good; every key is a
    // known stockpile good — raw OR processed (a stray/misspelled key would
    // silently vanish from the galactic totals, so catch it here, not let it rot).
    if (g.stockpiles) {
      for (const [good, qty] of Object.entries(g.stockpiles)) {
        checkField(out, qty, `guild:${g.id}.stockpiles.${good}`);
        if (!isStockpileGood(good)) {
          out.push({ rule: 'known-good (resources.js)', where: `guild:${g.id}.stockpiles.${good}`, detail: { good } });
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
      }
    }
  }

  checkField(out, state.reserve.reserveLevel, 'reserve.reserveLevel');

  // Syndicate ledger: integer like any credits figure, but exempt from
  // non-negativity — it is the balancing account that funds baseline allocation.
  checkField(out, state.syndicate.ledger, 'syndicate.ledger', { nonNegative: false });

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
