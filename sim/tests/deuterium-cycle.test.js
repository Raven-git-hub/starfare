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

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  validateAction, applyAction, createLicenseDeuteriumMineAction, createApplyForLicenceAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { postedPrice } = require('../prices.js');
const { guildTotals } = require('../stock.js');
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

test('an UNLICENSED deuterium mine still stockpiles normally (the illegal path is untouched)', () => {
  // No licence: the mine behaves exactly as any tier-1 mine — output lands in the stockpile,
  // nothing is sold, nothing is minted.
  const s = deuteriumMineState();
  const before = { reserve: s.reserve.reserveLevel, produced: s.audit.totalProduced, credits: s.guilds[0].credits };
  const next = tick(s);
  assert.equal(guildTotals(next.guilds[0]).deuterium, RATE);
  assert.equal(next.reserve.reserveLevel, before.reserve);
  assert.equal(next.audit.totalProduced, before.produced);
  assert.equal(next.guilds[0].credits, before.credits);
});

// --- 5. GP: a licensed deuterium mine scores zero -------------------------------------

test('GP: a deuterium mine contributes 100 GP while unlicensed and 0 once licensed; the rest is unchanged', () => {
  // A held system (W_SYS) + a titanium mine (W_T1) + a deuterium mine (W_T1). The claim
  // must name a real seed landmark for the claim-landmark invariant, but GP reads it purely.
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

  const unlicensed = guildPoints(s, s.guilds[0]);
  assert.equal(unlicensed, W_SYS + W_T1 + W_T1); // system + titanium mine + deuterium mine

  const licensed = applyAction(s, createLicenseDeuteriumMineAction({ guildId: 'g1', ventureId: 'vd' }));
  const after = guildPoints(licensed, licensed.guilds[0]);

  // Exactly the deuterium mine's W_T1 has dropped; the system and the titanium mine are
  // untouched (§1.4: a licensed deuterium mine is pure reputation, never size).
  assert.equal(after, W_SYS + W_T1);
  assert.equal(unlicensed - after, W_T1);
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
