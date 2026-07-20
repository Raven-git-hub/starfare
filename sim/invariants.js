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
//   state.guilds     : [{ id, credits, fuelHoard, influence?, ventures? }]
//   state.reserve    : { reserveLevel }                    // SHARED fuel reserve
//   state.syndicate  : { ledger }         // credits; may be negative (see below)
//   state.shipments? : [{ cargo: { fuel? } }]   // fuel in transit; none yet in
//                                               // the walking skeleton
//   state.audit      : { totalProduced, totalConsumed, expectedCreditTotal }
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

    if (Array.isArray(g.ventures)) {
      for (const ven of g.ventures) {
        if (ven.outputStockpile !== undefined) {
          checkField(out, ven.outputStockpile, `venture:${ven.id}.outputStockpile`);
        }
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

// Run all within-run invariants. Returns a (possibly empty) list of violations,
// each tagged with the tick.
function checkInvariants(state, tick) {
  const violations = [
    ...checkFuelConservation(state),
    ...checkCreditConservation(state),
    ...checkNonNegativityAndIntegrality(state),
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
