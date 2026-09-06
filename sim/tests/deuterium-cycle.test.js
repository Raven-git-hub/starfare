'use strict';

// deuterium-cycle.test.js — the licensed per-tick deuterium supply lever, slice 1
// (docs/fuel-supply-and-allocation.md §1.4 "The Deuterium Cycle", engine only).
//
// What this slice adds, and what these tests pin:
//   - a SEPARATE `licenseDeuteriumMine` action (windowless, 100%-committed, fee-less),
//     distinct from `applyForLicence` and mutually exclusive with it — the validation
//     refusals below are each a decision that would be invisible if it silently reversed;
//   - a PER-TICK auto-sale in `applyProduction` (sim/tick.js): a licensed deuterium mine
//     never stockpiles — every tick its output is sold to the Syndicate for credits at the
//     posted deuterium price AND minted 1:1 into the fuel pool. The one-tick test asserts
//     all four movements together, plus that invariants 1 (fuel) and 2 (credit) hold;
//   - ZERO GP for a licensed deuterium mine (sim/points.js), while an unlicensed one is
//     untouched (still a normal tier-1 mine).
//
// RP (the §1.4 T4 weighting) is DEFERRED to a later slice and is deliberately NOT tested
// or built here.
//
// SLICE 1a (the illegal-path INPUT half, ruled 06-09-26 — §1.4 "The illegal path, made
// concrete") revises the two "unlicensed is untouched" facts above: an UNLICENSED deuterium
// mine is now ALSO idle to the Syndicate — it earns ZERO GP (widened from the licensed-only
// skip) and mines its raw `deuterium` into a NEW guild-wide store (`guild.deuterium`, the one
// B1 exemption) instead of a per-system stockpile, where it piles up inert until the illegal
// refinery (slice 1b). Its deuterium still reaches no fuel pool and no ledger — no sell path
// exists for it. The regression tests that pinned the old per-system-stockpile / tier-1-GP
// behaviour are updated below to the ruled behaviour; the licensed path is UNCHANGED.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  validateAction, applyAction, createLicenseDeuteriumMineAction, createApplyForLicenceAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { postedPrice } = require('../prices.js');
const { guildTotals, getStock } = require('../stock.js');
const { guildPoints, W_SYS, TIER_WEIGHT } = require('../points.js');
const { hashState } = require('../serialize.js');
const {
  signingBump, deuteriumMetGain, tierFactor, gainFactor, RP_SOFT_CAP,
} = require('../licence.js');

const W_T1 = TIER_WEIGHT[1];
const W_T4 = TIER_WEIGHT[4];
const RATE = 5; // the mine's productionRate for these scenarios

// A guild with one deuterium mine, and optionally an ordinary licence / a pre-existing
// deuterium licence on it, built through createState so the venture is normalised exactly
// as the game builds it. No claims by default (a mine needs no held system to produce, and
// leaving them out keeps the claim-landmark invariant out of the picture).
function deuteriumMineState(ventureOverrides = {}, { claims = [] } = {}) {
  return createState({
    guilds: [{
      id: 'g1',
      credits: 0,
      fuelHoard: 0,
      ventures: [{
        id: 'v1',
        ownerGuildId: 'g1',
        type: 'mining',
        systemId: 'sysA',
        resourceType: 'deuterium',
        productionRate: RATE,
        ...ventureOverrides,
      }],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
    claims,
  });
}

const licenseAction = (ventureId = 'v1') => createLicenseDeuteriumMineAction({ guildId: 'g1', ventureId });

// --- 1. the action constructor -------------------------------------------------------

test('createLicenseDeuteriumMineAction requires guildId and ventureId, and carries no terms', () => {
  assert.throws(() => createLicenseDeuteriumMineAction({ ventureId: 'v1' }), /guildId is required/);
  assert.throws(() => createLicenseDeuteriumMineAction({ guildId: 'g1' }), /ventureId is required/);
  // The deuterium licence takes NO terms — commitment is 100% implicit, no fee, no window.
  assert.deepEqual(
    createLicenseDeuteriumMineAction({ guildId: 'g1', ventureId: 'v1' }),
    { type: 'licenseDeuteriumMine', guildId: 'g1', ventureId: 'v1' },
  );
});

// --- 2. validation: refuse, never clamp ----------------------------------------------

test('licenseDeuteriumMine: a real deuterium mine you own is accepted', () => {
  const s = deuteriumMineState();
  assert.deepEqual(validateAction(s, licenseAction()), { valid: true });
});

test('licenseDeuteriumMine: refused when the guild does not exist', () => {
  const s = deuteriumMineState();
  const r = validateAction(s, createLicenseDeuteriumMineAction({ guildId: 'nope', ventureId: 'v1' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /no guild with id/);
});

test('licenseDeuteriumMine: refused when the guild does not own the venture', () => {
  const s = deuteriumMineState();
  const r = validateAction(s, licenseAction('does_not_exist'));
  assert.equal(r.valid, false);
  assert.match(r.reason, /has no venture with id/);
});

test('licenseDeuteriumMine: refused for a NON-MINING venture (a refinery has no resourceType)', () => {
  const s = deuteriumMineState({ type: 'refining', resourceType: null, recipeId: 'titanium_alloy' });
  const r = validateAction(s, licenseAction());
  assert.equal(r.valid, false);
  assert.match(r.reason, /is not a deuterium mine/);
});

test('licenseDeuteriumMine: refused for a mine of ANOTHER resource', () => {
  const s = deuteriumMineState({ resourceType: 'copper' });
  const r = validateAction(s, licenseAction());
  assert.equal(r.valid, false);
  assert.match(r.reason, /is not a deuterium mine/);
});

test('licenseDeuteriumMine: refused when the mine is ALREADY deuterium-licensed', () => {
  const s = deuteriumMineState({ deuteriumLicence: { signedTick: 0 } });
  const r = validateAction(s, licenseAction());
  assert.equal(r.valid, false);
  assert.match(r.reason, /already deuterium-licensed/);
});

test('licenseDeuteriumMine: refused when the mine holds an ORDINARY windowed licence (mutually exclusive)', () => {
  const s = deuteriumMineState({
    licence: {
      committedOutputPct: 0.5, windowDays: 7, signedTick: 0,
      lockedPrice: 10, basicFee: 0, discountedFee: 0,
    },
  });
  const r = validateAction(s, licenseAction());
  assert.equal(r.valid, false);
  assert.match(r.reason, /ordinary Syndicate licence/);
});

// --- 2b. the exclusion is symmetric: the ordinary path refuses a deuterium mine too ---

test('applyForLicence: refused on a deuterium mine — it takes only the windowless deuterium licence (§1.4)', () => {
  // The reverse half of the mutual exclusion. Without this guard a player could route a
  // deuterium mine down the windowed path (fee, breach, tier-1 GP), which §1.4 forbids.
  // Refused for the raw good, which is NOT fuel and would otherwise slip through as a
  // normal tier-1 mine.
  const s = deuteriumMineState();
  const r = validateAction(s, createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'v1', committedOutputPct: 0.5, windowDays: 7,
  }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /licenseDeuteriumMine/);
});

test('the exclusion is symmetric: the same deuterium mine the ordinary path refuses can still be deuterium-licensed', () => {
  const s = deuteriumMineState();
  // Ordinary path: refused.
  assert.equal(validateAction(s, createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'v1', committedOutputPct: 0.5, windowDays: 7,
  })).valid, false);
  // Deuterium path: accepted.
  assert.deepEqual(validateAction(s, licenseAction()), { valid: true });
});

// --- 3. apply: grant the licence, move nothing ---------------------------------------

test('licenseDeuteriumMine apply: stamps deuteriumLicence with the signing tick and moves no credits', () => {
  const s = deuteriumMineState();
  const next = applyAction(s, licenseAction());
  const v = next.guilds[0].ventures[0];
  assert.deepEqual(v.deuteriumLicence, { signedTick: next.tick });
  // No fee: credits and ledger are exactly where they were.
  assert.equal(next.guilds[0].credits, s.guilds[0].credits);
  assert.equal(next.syndicate.ledger, s.syndicate.ledger);
  // It does not touch the ordinary windowed fields.
  assert.equal(v.licence, undefined);
  assert.equal(v.syndicateCommitment, 0);
});

test('an UNLICENSED venture carries no deuteriumLicence key at all (the byte-identical no-op)', () => {
  // The field is omitted when absent, exactly like `licence`/`equityPct` — which is why a
  // galaxy with no deuterium licence serializes byte-identically to pre-slice, and why the
  // whole existing determinism-golden suite did not move when this field was added.
  const s = deuteriumMineState();
  assert.equal('deuteriumLicence' in s.guilds[0].ventures[0], false);
});

// --- 4. the per-tick auto-sale: all four movements together --------------------------

test('one tick of a licensed deuterium mine: sells to the Syndicate AND mints pool fuel, and never stockpiles', () => {
  let s = deuteriumMineState();
  s = applyAction(s, licenseAction());

  // The rate the sale executes at is the price ON STATE as the tick begins (applyProduction
  // reads the posted price before step 3 recomputes it), so it is exactly this.
  const price = postedPrice(s, 'deuterium');
  const qty = RATE;
  const credited = Math.round(qty * price);

  const before = {
    credits: s.guilds[0].credits,
    ledger: s.syndicate.ledger,
    reserve: s.reserve.reserveLevel,
    produced: s.audit.totalProduced,
  };

  const next = tick(s);

  // (1) the SALE — a credit MOVE: guild up by round(qty × price), ledger down by the same.
  assert.equal(next.guilds[0].credits - before.credits, credited);
  assert.equal(next.syndicate.ledger - before.ledger, -credited);
  // (2) the POOL MINT — reserve up by qty, and the mint records itself in totalProduced.
  assert.equal(next.reserve.reserveLevel - before.reserve, qty);
  assert.equal(next.audit.totalProduced - before.produced, qty);
  // (3) it NEVER stockpiles — no deuterium lands in the guild's piles.
  assert.equal(guildTotals(next.guilds[0]).deuterium, undefined);
  // The mine's tick is still stamped (every mutation records its tick, §15.2).
  assert.equal(next.guilds[0].ventures[0].updatedAtTick, 0);

  // INVARIANTS 1 (fuel conservation) and 2 (credit conservation) hold — they are among the
  // rules `checkInvariants` runs, so an empty result set is them passing (and everything else).
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('invariants 1 and 2 hold on EVERY tick of a multi-tick licensed-deuterium run', () => {
  let s = deuteriumMineState();
  s = applyAction(s, licenseAction());
  for (let i = 0; i < 20; i += 1) {
    s = tick(s);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  // After 20 ticks the pool has grown by 20 × qty and no deuterium was ever stockpiled.
  assert.equal(guildTotals(s.guilds[0]).deuterium, undefined);
});

test('the licensed-deuterium run is deterministic (byte-identical run twice)', () => {
  const build = () => {
    let s = deuteriumMineState();
    s = applyAction(s, licenseAction());
    for (let i = 0; i < 10; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

// --- 4a. the UNLICENSED path: mine into the guild-wide store, idle to the Syndicate (slice 1a)

test('an UNLICENSED deuterium mine routes its raw output into the guild-wide store, NOT a per-system stockpile', () => {
  // No licence: the mine is idle to the Syndicate — its raw deuterium accumulates in the new
  // guild-wide store (§1.4's B1 exemption), never a per-system stockpile, and nothing is sold,
  // minted or credited (no sell/pool path exists for it in this slice).
  const s = deuteriumMineState();
  const before = { reserve: s.reserve.reserveLevel, produced: s.audit.totalProduced, credits: s.guilds[0].credits };
  const next = tick(s);
  // The guild-wide store grew by exactly the mine's resolved rate.
  assert.equal(next.guilds[0].deuterium, RATE);
  // NOTHING landed in any per-system stockpile for it.
  assert.equal(guildTotals(next.guilds[0]).deuterium, undefined);
  assert.deepEqual(next.guilds[0].stockpiles || {}, {});
  // It reached no fuel pool and no ledger — reserve, audit and credits are exactly as before.
  assert.equal(next.reserve.reserveLevel, before.reserve);
  assert.equal(next.audit.totalProduced, before.produced);
  assert.equal(next.guilds[0].credits, before.credits);
  assert.equal(next.syndicate.ledger, s.syndicate.ledger);
  // The mine's tick is stamped (every mutation records its tick, §15.2).
  assert.equal(next.guilds[0].ventures[0].updatedAtTick, 0);
});

test('the guild-wide store grows by the mine\'s rate every tick, and the pool is never touched by it', () => {
  let s = deuteriumMineState(); // default window (1440) — a short run crosses no boundary
  for (let i = 1; i <= 10; i += 1) {
    s = tick(s);
    assert.equal(s.guilds[0].deuterium, RATE * i, 'the store grows by the resolved rate each tick');
  }
  // Across the whole run the raw deuterium reached no per-system stockpile and no fuel pool.
  assert.equal(guildTotals(s.guilds[0]).deuterium, undefined);
  assert.equal(s.reserve.reserveLevel, 100, 'reserveLevel is unchanged by the unlicensed mine');
  assert.equal(s.audit.totalProduced, 100, 'nothing was minted into the pool');
});

test('an unlicensed deuterium mine mints no `deuterium` key until it actually produces (omitted-when-0)', () => {
  // The field is omitted when 0, exactly like `licence`/`equityPct`/`foundingEndowment` — a
  // freshly built guild carries no `deuterium` key, which is why every galaxy with no
  // unlicensed deuterium mining serializes byte-identically to pre-slice.
  const s = deuteriumMineState();
  assert.equal('deuterium' in s.guilds[0], false);
});

test('a NORMAL (non-deuterium) mine still deposits into its per-system stockpile — unchanged', () => {
  // The third fork (every non-deuterium good) is untouched: a titanium mine still stockpiles
  // per-system, and no guild-wide `deuterium` store is created for it.
  const s = deuteriumMineState({ resourceType: 'titanium' });
  const next = tick(s);
  assert.equal(getStock(next.guilds[0], 'sysA', 'titanium'), RATE);
  assert.equal(next.guilds[0].deuterium, undefined);
});

test('the unlicensed-deuterium run is deterministic (byte-identical run twice)', () => {
  const build = () => {
    let s = deuteriumMineState();
    for (let i = 0; i < 10; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

// --- 4b. invariants over a multi-cycle unlicensed-deuterium run (slice 1a) --------------

// Does the violation list carry a rule whose name starts with `prefix`? (the invariants.test.js
// convention — the individual check functions are not exported, so specific invariants are
// asserted by filtering the aggregate `checkInvariants` result.)
const hasRule = (violations, prefix) => violations.some((v) => v.rule.startsWith(prefix));

test('all invariants pass every tick of a MULTI-CYCLE scenario holding an unlicensed deuterium mine', () => {
  // A small window so a 20-tick run crosses several cycle boundaries (influx + issuance +
  // the price controller all run) while the guild-wide deuterium store climbs the whole time.
  let s = createState({
    windowN: WIN,
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: RATE }],
    }],
    reserve: { reserveLevel: 1000 },
    syndicate: { ledger: 0 },
  });
  for (let i = 0; i < 5 * WIN; i += 1) {
    s = tick(s);
    // checkInvariants runs the WHOLE sweep — an empty result is every invariant passing,
    // including fuel conservation (1), the galactic-supply/goods-cache consistency check, and
    // the non-negativity/integrality sweep that now covers `guild.deuterium`.
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  // The store really did grow across the run — the invariants held over a real, non-trivial
  // guild-wide deuterium balance, not a zero.
  assert.equal(s.guilds[0].deuterium, RATE * 5 * WIN);
  // And the goods-cache's deuterium row counts the guild-wide store exactly (§1.4: counted for
  // accounting, not laundered — an unlicensed mine has no sell/pool path).
  assert.equal(s.galacticSupply.resources.deuterium, s.guilds[0].deuterium);
});

test('the non-negativity/integrality sweep COVERS the new guild-wide store', () => {
  // Prove the tripwire really reaches `guild.deuterium`: a negative store trips
  // non-negativity, a fractional one trips the integer convention. Without the new
  // checkField call these would sail through silently.
  const negative = deuteriumMineState({}, {});
  negative.guilds[0].deuterium = -1;
  assert.ok(hasRule(checkInvariants(negative, 0), 'non-negativity'), 'a negative store trips invariant 3');

  const fractional = deuteriumMineState();
  fractional.guilds[0].deuterium = 2.5;
  assert.ok(hasRule(checkInvariants(fractional, 0), 'integer'), 'a fractional store trips the §15.2 integer rule');
});

test('the goods-cache consistency check COVERS the guild-wide store', () => {
  // A store the cache does not count is a silent lie about how much deuterium the galaxy holds.
  // Corrupt the cache away from the live store and the consistency check must catch it.
  let s = deuteriumMineState();
  s = tick(s); // stores RATE into guild.deuterium; the cache row now reads RATE
  assert.equal(s.galacticSupply.resources.deuterium, RATE);
  assert.deepEqual(checkInvariants(s, s.tick), []); // consistent as produced by tick
  s.galacticSupply.resources.deuterium = 0; // hand-break the cache
  assert.ok(hasRule(checkInvariants(s, s.tick), 'galactic-supply-consistency'), 'the cache must count the store');
});

// --- 5. GP: a licensed deuterium mine scores zero -------------------------------------

test('GP: a deuterium mine scores ZERO whether licensed or not; only non-deuterium ventures and systems count', () => {
  // A held system (W_SYS) + a titanium mine (W_T1) + a deuterium mine. The claim must name a
  // real seed landmark for the claim-landmark invariant, but GP reads it purely.
  //
  // SLICE 1a widens the GP skip: an UNLICENSED deuterium mine is idle to the Syndicate and
  // scores zero too (§1.4), so it contributes nothing here even before it is licensed —
  // exactly the "no GP either" this slice adds. The system and the titanium mine are all the GP.
  const claims = [{
    claimId: 'c_home', ownerGuildId: 'g1', landmarkId: 'sys_0002',
    landmarkKind: 'system', claimedAtTick: 0, contested: false,
  }];
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [
        { id: 'vt', ownerGuildId: 'g1', type: 'mining', systemId: 'sys_0002', resourceType: 'titanium', productionRate: RATE },
        { id: 'vd', ownerGuildId: 'g1', type: 'mining', systemId: 'sys_0002', resourceType: 'deuterium', productionRate: RATE },
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims,
  });

  // Unlicensed: the deuterium mine already adds NOTHING — system + titanium mine only.
  const unlicensed = guildPoints(s, s.guilds[0]);
  assert.equal(unlicensed, W_SYS + W_T1);

  // Licensing it changes GP by nothing — it was already zero either way.
  const licensed = applyAction(s, createLicenseDeuteriumMineAction({ guildId: 'g1', ventureId: 'vd' }));
  const after = guildPoints(licensed, licensed.guilds[0]);
  assert.equal(after, W_SYS + W_T1);
  assert.equal(unlicensed - after, 0);
});

test('RP: an unlicensed deuterium mine earns ZERO RP across a multi-cycle run (idle to the Syndicate)', () => {
  // §1.4's "idle to the Syndicate" guarantee, stated explicitly: with no licence there is no
  // signing bump, no windowed met/breach (a mine carries no windowed `licence`), and no
  // per-cycle deuterium MET (that is gated on `isLicensedDeuteriumMine` in step 6). So across
  // many cycle boundaries the venture never mints a `reputation` key and the guild total stays 0.
  let s = createState({
    windowN: WIN,
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: RATE }],
    }],
    reserve: { reserveLevel: 1000 },
    syndicate: { ledger: 0 },
  });
  for (let i = 0; i < 5 * WIN; i += 1) s = tick(s);
  assert.equal(s.guilds[0].ventures[0].reputation, undefined, 'no RP key is ever minted');
  assert.equal(s.guilds[0].guildReputation, 0, 'the guild RP total stays zero');
  assert.equal(guildPoints(s, s.guilds[0]), 0, 'GP is zero too — an unlicensed deuterium mine is neither size nor standing');
  // And its deuterium really did accumulate guild-wide the whole time.
  assert.equal(s.guilds[0].deuterium, RATE * 5 * WIN);
});

// --- 6. RP: the signing bump + per-cycle T4 accrual (slice 2) -------------------------
//
// §1.4 "The RP accrual": a licensed deuterium mine gets a one-time 1000 RP signing bump and
// a per-cycle automatic MET at the full Tier-4 rate (50 pre-taper), both equity-free and
// breachless, reusing the existing RP arithmetic at the T4 weight.

const WIN = 4; // a short accrual window so a few ticks cross several cycle boundaries

// A licensed-deuterium scenario with a small window. A big reserve and no held systems keep
// issuance out of the way (GP is 0, so the grant is ~0), leaving RP the only thing moving.
function rpScenario() {
  const s = createState({
    windowN: WIN,
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: RATE }],
    }],
    reserve: { reserveLevel: 1_000_000 },
    syndicate: { ledger: 0 },
  });
  return applyAction(s, licenseAction());
}

test('the RP tier lookups treat a licensed deuterium mine as Tier-4', () => {
  const s = rpScenario();
  const v = s.guilds[0].ventures[0];
  // W_T4 is 500, so the RP tier factor is 5 (500 / W_T1) — the maximum.
  assert.equal(W_T4, 500);
  assert.equal(tierFactor(v), 5);
});

test('licensing a deuterium mine mints exactly 1000 RP onto the venture and the guild', () => {
  const s = rpScenario();
  const v = s.guilds[0].ventures[0];
  // 2 · 1.0 · W_T4 = 1000, the signingBump formula at implicit full commit and the T4 weight.
  assert.equal(signingBump(v), 1000);
  assert.equal(v.reputation, 1000);
  assert.equal(s.guilds[0].guildReputation, 1000);
});

test('the deuterium per-cycle MET is the full T4 rate, 50 pre-taper', () => {
  const s = rpScenario();
  // REP_MEET_MAX · tierFactor(T4) = 10 · 5 = 50, with NO terms multiplier (equity-free).
  assert.equal(deuteriumMetGain(s.guilds[0].ventures[0]), 50);
});

test('each cycle boundary adds the TAPERED T4 met; the mine sits above the 800 knee, so it is tapered', () => {
  let s = rpScenario();
  // Start: the 1000 bump, already above the 800 taper knee.
  assert.equal(s.guilds[0].ventures[0].reputation, 1000);

  // First boundary (producing tick WIN): +round(50 · gainFactor(1000)).
  const firstGain = Math.round(50 * gainFactor(1000));
  assert.ok(firstGain > 0 && firstGain < 50, 'the gain is tapered — between 0 and the pre-taper 50');
  for (let i = 0; i < WIN; i += 1) s = tick(s);
  assert.equal(s.guilds[0].ventures[0].reputation, 1000 + firstGain);
  assert.equal(s.guilds[0].guildReputation, 1000 + firstGain);

  // Second boundary: tapered again off the NEW, higher reputation, so a smaller step.
  const before2 = s.guilds[0].ventures[0].reputation;
  const secondGain = Math.round(50 * gainFactor(before2));
  for (let i = 0; i < WIN; i += 1) s = tick(s);
  assert.equal(s.guilds[0].ventures[0].reputation, before2 + secondGain);
  assert.ok(secondGain <= firstGain, 'the higher the reputation, the smaller the tapered step');

  // A non-boundary tick moves no RP.
  const restBoundary = s.guilds[0].ventures[0].reputation;
  s = tick(s); // this advances into a fresh window, not onto a boundary
  assert.equal(s.guilds[0].ventures[0].reputation, restBoundary, 'RP moves only at the cycle boundary');
});

test('over a long run RP climbs toward but never exceeds 1500, monotonically, and never breaches', () => {
  let s = rpScenario();
  let prev = s.guilds[0].ventures[0].reputation;
  for (let i = 0; i < 4000; i += 1) {
    s = tick(s);
    const rp = s.guilds[0].ventures[0].reputation;
    assert.ok(rp >= prev, 'a licensed deuterium mine never breaches — RP is monotonically non-decreasing');
    assert.ok(rp <= RP_SOFT_CAP, 'the taper holds RP at or below the 1500 soft cap');
    prev = rp;
  }
  // It has genuinely climbed off the 1000 bump toward the cap.
  assert.ok(prev > 1000 && prev <= RP_SOFT_CAP);
  assert.ok(RP_SOFT_CAP - prev < 10, 'after a long run it sits just under the cap');
});

test('invariants hold on EVERY tick of a multi-cycle licensed-deuterium scenario (guild-rep sum + band)', () => {
  // checkInvariants runs the whole sweep, which includes invariant 8 (guildReputation ==
  // Σ venture.reputation + foundingEndowment) and the reputation-band check — an empty
  // result is them (and everything else) passing on every tick across many boundaries.
  let s = rpScenario();
  for (let i = 0; i < 40; i += 1) {
    s = tick(s);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

test('an UNLICENSED deuterium mine earns no RP over many cycles', () => {
  const s = createState({
    windowN: WIN,
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: RATE }],
    }],
    reserve: { reserveLevel: 1000 },
    syndicate: { ledger: 0 },
  });
  let cur = s;
  for (let i = 0; i < 20; i += 1) cur = tick(cur);
  // No signing bump was ever minted, and the per-cycle MET is gated on the licence — so no
  // reputation key is ever written, and the guild total stays 0.
  assert.equal(cur.guilds[0].ventures[0].reputation, undefined);
  assert.equal(cur.guilds[0].guildReputation, 0);
});

test('the licensed mine still scores ZERO GP after RP accrues (slice-1 regression)', () => {
  let s = rpScenario();
  for (let i = 0; i < 3 * WIN; i += 1) s = tick(s); // let RP climb across several cycles
  assert.ok(s.guilds[0].ventures[0].reputation > 1000, 'RP has grown');
  assert.equal(guildPoints(s, s.guilds[0]), 0, 'GP is still zero — RP is not size');
});

test('a licensed-deuterium RP run is deterministic (byte-identical run twice)', () => {
  const build = () => {
    let s = rpScenario();
    for (let i = 0; i < 3 * WIN; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
