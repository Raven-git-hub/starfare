'use strict';

// issuance.test.js — fuel flows (sim/issuance.js + tick.js's step 6;
// docs/fuel-supply-and-allocation.md §2.1, §1.1, §1.3, §4.1; numbers in
// phase-1-tuning.md §"Fuel — the pool & issuance").
//
// THIS IS THE SLICE WHERE FUEL FINALLY MOVES, so INVARIANT 1 is the thing under test more
// than any single number. Every scenario below re-checks conservation by hand as well as
// through `checkInvariants`, because the two failure modes this slice can introduce are
// both silent: fuel MINTED without an audit entry (the pool grows and the law quietly
// breaks), and fuel granted that the pool did not have (the pool goes negative). A test
// that only asserted grant sizes would catch neither.
//
// THE TWO KINDS OF MOVEMENT, and the whole design rests on keeping them apart:
//   - the INFLUX MINTS — there is no upstream account to debit, so `audit.totalProduced`
//     rises by exactly the same amount in the same breath;
//   - a GRANT only MOVES — pool → hoard, minting nothing, audit untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints } = require('../points.js');
const { getStarterSystems } = require('../seed.js');
const { issuanceModifier } = require('../meanline.js');
const {
  BASE_GRANT_PER_GP, DEUTERIUM_INFLUX_PER_CYCLE, POOL_SEED,
  grantFor, physicalGrantFor, rationGrants,
} = require('../issuance.js');

const N = 4;                                   // a short window, so a boundary is 4 ticks away

// REAL seed systems, taken from the seed rather than invented: `checkClaimIntegrity`
// asserts every claim references a landmark that actually exists, so a fixture cannot make
// territory up. Each guild below is dealt its own slice of this list, so no two guilds
// claim the same system.
const SEED_SYSTEMS = getStarterSystems().map((x) => (typeof x === 'string' ? x : x.id));

const claim = (guildId, landmarkId) => ({
  claimId: `claim_${guildId}_${landmarkId}`, ownerGuildId: guildId,
  landmarkId, landmarkKind: 'system', claimedAtTick: 0, contested: false,
});
const mine = (id, ownerGuildId, systemId) => ({
  id, ownerGuildId, type: 'mining', systemId, resourceType: 'titanium', productionRate: 5,
});

// A galaxy of `specs`, each { id, systems, mines, rp, fuelHoard }, over a pool of `pool`.
function galaxy(specs, pool = 0) {
  const claims = [];
  let nextSystem = 0;                          // deal real seed systems out, none shared
  const guilds = specs.map((spec, gi) => {
    const held = [];
    for (let i = 0; i < (spec.systems || 0); i += 1) {
      const sysId = SEED_SYSTEMS[nextSystem % SEED_SYSTEMS.length];
      nextSystem += 1;
      held.push(sysId);
      claims.push(claim(spec.id, sysId));
    }
    const ventures = Array.from({ length: spec.mines || 0 }, (_, i) =>
      mine(`${spec.id}_m${i}`, spec.id, held[i % held.length] || SEED_SYSTEMS[0]));
    if (spec.rp) {
      const each = Math.trunc(spec.rp / (ventures.length || 1));
      ventures.forEach((v, i) => { v.reputation = i === 0 ? spec.rp - each * (ventures.length - 1) : each; });
    }
    return {
      id: spec.id, credits: 0, fuelHoard: spec.fuelHoard || 0, ventures,
      guildReputation: ventures.reduce((n, v) => n + (v.reputation || 0), 0),
      _gi: gi,
    };
  });
  const s = createState({
    guilds: guilds.map(({ _gi, guildReputation, ...g }) => g),
    reserve: { reserveLevel: pool },
    syndicate: { ledger: 0 },
    claims,
    windowN: N,
  });
  // `createGuild` always writes `guildReputation: 0`, so the seeded venture reputations
  // are summed back onto the guild here — or `checkGuildReputationSum` would (rightly)
  // trip before this file tested anything at all.
  s.guilds.forEach((g) => { g.guildReputation = (g.ventures || []).reduce((n, v) => n + (v.reputation || 0), 0); });
  return s;
}

const pool = (s) => s.reserve.reserveLevel;
const hoards = (s) => s.guilds.reduce((n, g) => n + g.fuelHoard, 0);
const runToBoundary = (s) => { do { s = tick(s); } while (s.tick % N !== 0); return s; };

// INVARIANT 1, by hand, plus the full harness. Called after every scenario below.
function assertConserved(s, where) {
  assert.equal(
    s.audit.totalProduced - s.audit.totalConsumed, pool(s) + hoards(s),
    `${where}: conservation of fuel — produced − consumed must equal pool + Σ hoards`,
  );
  assert.ok(pool(s) >= 0, `${where}: the pool must never go negative (it is ${pool(s)})`);
  assert.deepEqual(checkInvariants(s, s.tick), [], `${where}: an invariant tripped`);
}

// --- 1. the ruled constants -------------------------------------------------------

test('the fuel-flow constants are the ruled [FIRST-CUT] numbers', () => {
  // ⤳ RE-BASED 01-09-26 (5 → 0.3) BY THE GP RESCALE, points-and-reputation.md §2.6. This
  // constant is denominated PER GUILD POINT and §2.6 changed what a Guild Point is
  // (`W_SYS` 12 → 200), so it had to move with its unit or it would have meant something
  // else: at an unchanged 5 the reference galaxy drew ~16 450 a cycle against an 800
  // influx, needing a settled price five times `PRICE_CEIL`. DERIVED, not chosen —
  // `5 × (W_SYS_old / W_SYS_new)` — and asserted as that ratio here, not as a bare 0.3.
  const { W_SYS } = require('../points.js');
  assert.equal(BASE_GRANT_PER_GP, 0.3);
  assert.equal(BASE_GRANT_PER_GP, 5 * (12 / W_SYS), 'the SAME rate, in the new units');
  assert.equal(DEUTERIUM_INFLUX_PER_CYCLE, 800);
  assert.equal(POOL_SEED, 4000);
  // The two GALAXY-SCALE constants are counts of fuel and stay whole (§15.2). The base is
  // not: it is a coefficient that scales GP into fuel, on the same footing as
  // `issuanceModifier`, and `grantFor` rounds at the one point where the two meet.
  for (const n of [DEUTERIUM_INFLUX_PER_CYCLE, POOL_SEED]) {
    assert.ok(Number.isInteger(n));
  }
  assert.ok(Number.isFinite(BASE_GRANT_PER_GP) && BASE_GRANT_PER_GP > 0);
});

test('the RE-BASE is a NO-OP wherever the GP weights merely re-denominated', () => {
  // The proof the re-base is arithmetic and not a retune. A held system and a tier-1 mine
  // draw exactly the fuel they drew before the rescale, to the unit — because their GP
  // weights and this rate moved by reciprocal factors.
  const { W_SYS, TIER_WEIGHT } = require('../points.js');
  assert.equal(BASE_GRANT_PER_GP * W_SYS, 60, 'a held system at par: 12 × 5 = 200 × 0.3');
  assert.equal(BASE_GRANT_PER_GP * TIER_WEIGHT[1], 30, 'a tier-1 mine at par: 6 × 5 = 100 × 0.3');
  // The ONE place it is not a no-op, and it is deliberate: tier 2 draws 45 where it drew
  // 40. That +12.5% IS §2.6's widened 1 : 1.5 tier spread arriving in the fuel layer —
  // which is exactly where the reward for climbing the tree is supposed to show up.
  assert.equal(BASE_GRANT_PER_GP * TIER_WEIGHT[2], 45, 'a tier-2 refinery draws 45, up from 40');
});

// --- 2. the grant formula ---------------------------------------------------------

test('a grant is round(BASE_GRANT_PER_GP × GP × modifier)', () => {
  const s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }]);
  const g = s.guilds[0];
  assert.equal(guildPoints(s, g), 500, 'the fixture is a par-shaped guild');
  assert.ok(Math.abs(issuanceModifier(s, g) - 1) < 0.01, '…sitting on its line');
  assert.equal(grantFor(s, g), Math.round(BASE_GRANT_PER_GP * guildPoints(s, g) * issuanceModifier(s, g)));
  // ⤳ 01-09-26: the SAME 149 it drew pre-rescale — GP 30 → 500 and the rate 5 → 0.3, and
  // the two cancel. The re-base is what keeps this number still.
  assert.equal(grantFor(s, g), 149, 'a par guild of GP 500 draws ~150 a cycle');
});

test('the grant scales with SIZE and with the MODIFIER, independently', () => {
  const par = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }]).guilds[0];
  const parState = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }]);
  // Same reputation, more territory ⇒ same base per Point but a throttled modifier.
  const sprawl = galaxy([{ id: 'g1', systems: 3, mines: 3, rp: 498 }]);
  assert.ok(guildPoints(sprawl, sprawl.guilds[0]) > guildPoints(parState, par), 'the sprawler is bigger…');
  assert.ok(issuanceModifier(sprawl, sprawl.guilds[0]) < 0.4, '…and throttled for it');
  // Bigger base, much smaller multiplier — the sprawler draws LESS despite holding more.
  assert.ok(grantFor(sprawl, sprawl.guilds[0]) < grantFor(parState, par),
    'holding more without earning it draws LESS fuel, not more');
});

test('a guild holding NOTHING is due nothing — no special case needed', () => {
  const s = galaxy([{ id: 'g1' }]);
  assert.equal(guildPoints(s, s.guilds[0]), 0);
  assert.equal(issuanceModifier(s, s.guilds[0]), 1, 'the empty-guild guard puts it on its own line…');
  assert.equal(grantFor(s, s.guilds[0]), 0, '…and GP 0 makes the product 0 anyway');
});

// --- 3. the influx MINTS ----------------------------------------------------------

test('the INFLUX mints into the pool and records itself in the audit', () => {
  let s = galaxy([], 0);                       // no guilds: the influx alone, nothing drawn
  assert.equal(pool(s), 0);
  assert.equal(s.audit.totalProduced, 0);

  s = runToBoundary(s);
  assert.equal(pool(s), DEUTERIUM_INFLUX_PER_CYCLE, 'the pool gained exactly one cycle of influx');
  assert.equal(s.audit.totalProduced, DEUTERIUM_INFLUX_PER_CYCLE, 'and it paid for itself as PRODUCED');
  assert.equal(s.audit.totalConsumed, 0, 'nothing was consumed');
  assertConserved(s, 'after one influx');

  s = runToBoundary(s);
  assert.equal(pool(s), 2 * DEUTERIUM_INFLUX_PER_CYCLE, 'and it is per CYCLE, not per tick');
  assertConserved(s, 'after two influxes');
});

test('NOTHING happens off a boundary — the pool holds and no fuel moves', () => {
  let s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }], 5000);
  const before = { p: pool(s), h: hoards(s), prod: s.audit.totalProduced };
  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(pool(s), before.p, `tick ${s.tick}: the pool must not move`);
    assert.equal(hoards(s), before.h, `tick ${s.tick}: no fuel granted`);
    assert.equal(s.audit.totalProduced, before.prod, `tick ${s.tick}: nothing minted`);
    assert.equal(s.guilds[0].lastFuelGrant, undefined, 'and no grant recorded');
  }
  s = tick(s);                                  // the boundary
  assert.notEqual(pool(s), before.p, 'the boundary really is where it all happens');
  assertConserved(s, 'the boundary tick');
});

// --- 4. issuance TRANSFERS --------------------------------------------------------

test('a grant TRANSFERS: the hoard rises by exactly the grant, the pool falls by the total', () => {
  let s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498, fuelHoard: 500 }], 5000);
  const due = grantFor(s, s.guilds[0]);
  const producedBefore = s.audit.totalProduced;

  s = runToBoundary(s);
  const g = s.guilds[0];
  assert.equal(g.fuelHoard, 500 + due, 'the hoard rose by exactly the grant');
  assert.equal(pool(s), 5000 + DEUTERIUM_INFLUX_PER_CYCLE - due, 'and the pool by the influx less the grant');
  // THE TRANSFER MINTS NOTHING: the audit moved by the influx alone.
  assert.equal(s.audit.totalProduced, producedBefore + DEUTERIUM_INFLUX_PER_CYCLE,
    'a grant adds NOTHING to totalProduced — only the influx mints');
  assert.equal(s.audit.totalConsumed, 0);
  assertConserved(s, 'after one grant');

  // The grant record now also carries the modifier that DROVE it (Guild Hall Slice B) —
  // `issuanceModifier` at the boundary. Reputation does not move for an unlicensed guild, so
  // it is the same value read here after the boundary as the one stamped during it.
  const modifier = issuanceModifier(s, g);
  assert.deepEqual(g.lastFuelGrant, { tick: N, granted: due, desired: due, modifier },
    'and the grant is on the record, due and received alike, with the modifier that sized it');
});

test('several guilds are each granted their OWN size × their OWN standing', () => {
  const s0 = galaxy([
    { id: 'par', systems: 1, mines: 3, rp: 498 },      // on its line
    { id: 'sprawl', systems: 3, mines: 3, rp: 498 },   // same output, more land
    { id: 'empty' },                                    // holds nothing
  ], 100000);
  const due = s0.guilds.map((g) => grantFor(s0, g));
  const s = runToBoundary(s0);

  s.guilds.forEach((g, i) => {
    assert.equal(g.fuelHoard, due[i], `${g.id} received exactly what it was due`);
  });
  assert.ok(due[0] > due[1], 'the par guild out-draws the sprawler despite being smaller');
  assert.equal(due[2], 0, 'and the guild holding nothing draws nothing');
  assert.equal(s.guilds[2].lastFuelGrant, undefined, 'so it carries no grant record at all');
  assertConserved(s, 'three guilds, no crunch');
});

// --- 5. RATIONING — the crunch edge ------------------------------------------------

test('rationGrants pays in full when the pool can cover it', () => {
  assert.deepEqual(rationGrants([10, 20, 30], 100), [10, 20, 30]);
  assert.deepEqual(rationGrants([10, 20, 30], 60), [10, 20, 30], 'exactly covered is still full payment');
  assert.deepEqual(rationGrants([], 100), []);
  assert.deepEqual(rationGrants([0, 0], 100), [0, 0]);
});

test('rationGrants clips PROPORTIONALLY and empties the pool to EXACTLY the pool', () => {
  const granted = rationGrants([100, 200, 300], 300);
  assert.equal(granted.reduce((n, x) => n + x, 0), 300, 'the total handed out is exactly the pool');
  assert.deepEqual(granted, [50, 100, 150], 'and each share is halved, proportionally');

  // A case that does NOT divide evenly — the remainder rule is what makes it deterministic.
  const awkward = rationGrants([10, 10, 10], 8);
  assert.equal(awkward.reduce((n, x) => n + x, 0), 8, 'still exactly the pool, to the unit');
  assert.deepEqual(awkward, [3, 3, 2], 'equal shares of 2.66 floor to 2 each; the two spare units '
    + 'go to the earliest guilds, ties in the remainder broken by array position');
});

test('the remainder goes by LARGEST FRACTION, not by array position — nobody is starved', () => {
  // The case that distinguishes the two rules, and the reason the rule is
  // largest-remainder: paying the spare unit out in plain array order lets the FIRST guild
  // take its whole claim while the last gets nothing, even though both were clipped.
  //
  // [3, 1] against a pool of 3: proportionally that is 2.25 and 0.75, so the floors are
  // 2 and 0 with one unit spare. It belongs to the larger fraction — the SECOND guild.
  assert.deepEqual(rationGrants([3, 1], 3), [2, 1],
    'the spare unit follows the fraction, so the small claim is not starved');
  assert.notDeepEqual(rationGrants([3, 1], 3), [3, 0],
    'array order would have paid the first guild in full and the second nothing');
  // Mirrored, so the rule is about the fractions and not about which end of the array wins.
  assert.deepEqual(rationGrants([1, 3], 3), [1, 2]);

  // Founding order must not be an economic advantage: two guilds with the SAME claim get
  // the same treatment whichever way round they sit, up to the one-unit tie-break.
  const [a, b] = rationGrants([7, 7], 9);
  const [c, d] = rationGrants([7, 7], 9);
  assert.deepEqual([a, b], [c, d]);
  assert.ok(Math.abs(a - b) <= 1, 'equal claims are split within a unit of each other');
});

test('rationing is DETERMINISTIC — the same inputs give the same split, every run', () => {
  const desired = [137, 4, 991, 0, 58, 58];
  const first = rationGrants(desired, 421);
  for (let i = 0; i < 50; i += 1) assert.deepEqual(rationGrants(desired, 421), first);
  assert.equal(first.reduce((n, x) => n + x, 0), 421);
  // Two guilds due the SAME amount split the remainder by position, never by chance.
  assert.ok(first[4] >= first[5], 'equal claims are resolved by array order, earliest first');
});

test('a guild due NOTHING can never receive a remainder unit', () => {
  const granted = rationGrants([0, 7, 7], 5);
  assert.equal(granted[0], 0, 'you cannot be granted fuel you were not due');
  assert.equal(granted.reduce((n, x) => n + x, 0), 5);
});

test('an empty pool grants nothing, and does not go negative', () => {
  assert.deepEqual(rationGrants([100, 200], 0), [0, 0]);
  assert.deepEqual(rationGrants([100, 200], -0), [0, 0]);
});

test('THE CRUNCH, through the real tick: an out-drawing galaxy rations to exactly zero', () => {
  // Six big well-run guilds against a pool that cannot cover one cycle of their draw.
  const specs = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, systems: 2, mines: 8, rp: 8 * 1494 }));
  const s0 = galaxy(specs, 0);
  const due = s0.guilds.map((g) => grantFor(s0, g));
  const total = due.reduce((n, d) => n + d, 0);
  assert.ok(total > DEUTERIUM_INFLUX_PER_CYCLE, 'the fixture really does out-draw one cycle of supply');

  const s = runToBoundary(s0);
  assert.equal(pool(s), 0, 'the pool emptied to EXACTLY zero — not below it, and not with fuel left over');
  assert.equal(hoards(s), DEUTERIUM_INFLUX_PER_CYCLE, 'every unit of the cycle\'s influx was handed out');
  assertConserved(s, 'a rationed cycle');

  // Everyone was clipped, nobody was paid in full, and the record says so.
  s.guilds.forEach((g, i) => {
    assert.ok(g.fuelHoard < due[i], `${g.id} was clipped below what it was due`);
    assert.equal(g.lastFuelGrant.desired, due[i], 'the record keeps what it was DUE…');
    assert.equal(g.lastFuelGrant.granted, g.fuelHoard, '…beside what it actually received');
  });
});

test('a rationed galaxy RECOVERS — and never once goes negative on the way', () => {
  // ⚠ REWRITTEN BY SLICE 5b-ii, AND THE REWRITE IS THE POINT OF THAT SLICE. This test used
  // to assert the opposite: `pool === 0` on every one of eight cycles, "an out-drawing
  // galaxy holds its pool at zero". That was true and correct under 5a, where nothing could
  // pull draw back under supply, and it was the single clearest statement of the defect 5b
  // exists to fix. With the controller live it is false by design — the price climbs, draw
  // falls, and the pool refills. What SURVIVES unchanged is the hard floor: however the
  // price moves, the pool is never negative and conservation holds every cycle.
  //
  // (A galaxy whose demand exceeds what even PRICE_CEIL can throttle DOES still ration
  // permanently — §4.1's crunch edge is not abolished, only moved out of reach of ordinary
  // loads. That case is pinned in fuel-controller.test.js, which is where it now belongs.)
  const specs = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, systems: 2, mines: 8, rp: 8 * 1494 }));
  let s = galaxy(specs, 0);

  s = runToBoundary(s);
  assert.equal(pool(s), 0, 'cycle 1 still rations: the pool opens empty and the price is still the seed');
  assertConserved(s, 'the opening rationed cycle');

  for (let c = 2; c <= 10; c += 1) {
    s = runToBoundary(s);
    assert.ok(pool(s) >= 0, `cycle ${c}: the pool is never negative, whatever the price does`);
    assertConserved(s, `cycle ${c} under a moving price`);
  }
  // The recovery really happened, rather than the loop simply not throwing.
  assert.ok(pool(s) > 0, `the pool climbed back off zero (${pool(s)})`);
  assert.ok(s.reserve.fuelPrice > 10, 'because fuel got dear — that is what pulled the draw down');
  const finalDraw = s.guilds.reduce((n, g) => n + physicalGrantFor(s, g), 0);
  assert.ok(finalDraw <= DEUTERIUM_INFLUX_PER_CYCLE + 20,
    `and the settled draw ${finalDraw} is back under the influx, which is the whole loop`);
});

test('an UNDER-drawing galaxy accumulates, and the controller lets it GROW into the surplus', () => {
  // ⚠ REWRITTEN BY SLICE 5b-ii, and this is the other half of the loop — the half §4
  // describes as "reserve filling → lower price → credits buy more → the economy grows".
  // The old version asserted `pool === previous + influx − due` with `due` a FIXED number,
  // which is exactly what a static price gives you. It cannot hold now, and should not: a
  // pool climbing above target makes fuel CHEAPER, so the same entitlement buys more and
  // the guild's real draw rises cycle after cycle.
  //
  // One par guild drawing ~149 a cycle against an 800/cycle influx is a wildly over-supplied
  // galaxy — the price falls all the way to `PRICE_FLOOR` and stays there, because even at
  // the floor one small guild cannot spend 800 a cycle. That is the floor doing its job: it
  // stops a rich galaxy from giving fuel away for nothing.
  let s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }], POOL_SEED);
  const entitlement = grantFor(s, s.guilds[0]);
  let previous = pool(s);
  let previousDraw = physicalGrantFor(s, s.guilds[0]);
  assert.equal(previousDraw, entitlement, 'the first cycle issues at the seeded reference price');

  for (let c = 1; c <= 12; c += 1) {
    s = runToBoundary(s);
    assert.ok(pool(s) > previous,
      `cycle ${c}: a galaxy drawing under its supply still ACCUMULATES (${previous} -> ${pool(s)})`);
    // Paid in full every cycle — an over-supplied galaxy never rations.
    assert.equal(s.guilds[0].lastFuelGrant.granted, s.guilds[0].lastFuelGrant.desired,
      `cycle ${c}: paid in full`);
    const draw = physicalGrantFor(s, s.guilds[0]);
    assert.ok(draw >= previousDraw, `cycle ${c}: cheaper fuel means the guild draws MORE, not less`);
    previous = pool(s);
    previousDraw = draw;
    assertConserved(s, `over-supplied cycle ${c}`);
  }
  // The entitlement never moved — only what it BUYS did. That separation is the 5b-i design
  // and it is what this test is really watching the controller exercise.
  assert.equal(grantFor(s, s.guilds[0]), entitlement, 'reputation-against-size is untouched by price');
  assert.ok(previousDraw > entitlement * 3, `yet it now draws ${previousDraw} against an entitlement of ${entitlement}`);
  assert.ok(s.reserve.fuelPrice < 3, `because fuel has fallen to near the floor (${s.reserve.fuelPrice})`);
});

// --- 6. the hard floor, proven by trying to break it -------------------------------

test('THE POOL FLOOR: invariant 3 catches a negative pool', () => {
  let s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }], 5000);
  s = runToBoundary(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'green before it is broken');

  const broken = structuredClone(s);
  broken.reserve.reserveLevel = -1;
  const rules = checkInvariants(broken, broken.tick).map((v) => v.rule);
  assert.ok(rules.includes('non-negativity (invariant 3)'), 'a negative pool is caught…');
  assert.ok(rules.includes('conservation-of-fuel (invariant 1)'), '…and so is the fuel it would have conjured');
});

test('rationGrants can NEVER hand out more than the pool — the property the guard guards', () => {
  // The clip proven as a property rather than on a handful of cases. Inputs are generated
  // from a fixed arithmetic sequence, not a random source, so this is deterministic and
  // reproducible (invariant 9) while still sweeping hundreds of shapes.
  let checked = 0;
  for (let n = 1; n <= 6; n += 1) {
    for (let seed = 0; seed < 40; seed += 1) {
      const desired = Array.from({ length: n }, (_, i) => (seed * 37 + i * 101) % 500);
      for (const p of [0, 1, 7, 50, 499, 5000]) {
        const granted = rationGrants(desired, p);
        const total = granted.reduce((a, b) => a + b, 0);
        const want = desired.reduce((a, b) => a + b, 0);
        assert.ok(total <= p || total === want,
          `n=${n} seed=${seed} pool=${p}: handed out ${total}`);
        assert.ok(granted.every((x, i) => Number.isInteger(x) && x >= 0 && x <= desired[i]),
          'every share is a whole number, non-negative, and never more than was due');
        if (want > p) assert.equal(total, p, 'and when it rations, the pool empties exactly');
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1000, `swept ${checked} shapes`);
});

test('THE POOL FLOOR: the tick itself refuses to over-grant, rather than trusting the clip', () => {
  // `rationGrants` is written so this cannot happen; the guard exists because `tick()`
  // alone runs no invariants (the tests call it directly), so a future edit that broke the
  // clip would travel a long way before anything noticed. Break the clip on purpose — in a
  // FRESH module instance, since tick.js destructures its imports at load — and the tick
  // must halt loudly instead of driving the pool negative.
  const issuancePath = require.resolve('../issuance.js');
  const tickPath = require.resolve('../tick.js');
  const savedIssuance = require.cache[issuancePath];
  const savedTick = require.cache[tickPath];
  const real = require('../issuance.js');

  require.cache[issuancePath] = {
    ...savedIssuance,
    exports: { ...real, rationGrants: (desired) => desired.slice() },  // pay in full, pool be damned
  };
  delete require.cache[tickPath];
  try {
    const { tick: brokenTick } = require('../tick.js');
    const specs = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, systems: 2, mines: 8, rp: 8 * 1494 }));
    let s = galaxy(specs, 0);
    assert.throws(
      () => { for (let i = 0; i < N; i += 1) s = brokenTick(s); },
      /would take the Syndicate pool negative/,
      'a broken clip halts the tick rather than conjuring fuel',
    );
  } finally {
    require.cache[issuancePath] = savedIssuance;
    delete require.cache[tickPath];
    require.cache[tickPath] = savedTick;
  }

  // …and the real tick is unharmed by the surgery.
  let ok = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }], 5000);
  ok = runToBoundary(ok);
  assertConserved(ok, 'after restoring the real module');
});

test('an UNMINTED grant would break invariant 1 — the audit is not optional', () => {
  // The other silent failure: fuel appearing in a hoard that `totalProduced` never saw.
  let s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }], 5000);
  s = runToBoundary(s);
  const smuggled = structuredClone(s);
  smuggled.guilds[0].fuelHoard += 1;            // one unit from nowhere
  const rules = checkInvariants(smuggled, smuggled.tick).map((v) => v.rule);
  assert.ok(rules.includes('conservation-of-fuel (invariant 1)'));
  assert.ok(rules.includes('galactic-supply-consistency'), 'and the supply cache notices too');
});

// --- 7. determinism ----------------------------------------------------------------

test('determinism (invariant 9): a galaxy that flows fuel is byte-identical run twice', () => {
  const run = () => {
    const specs = [
      { id: 'a', systems: 1, mines: 3, rp: 498 },
      { id: 'b', systems: 3, mines: 3, rp: 1000 },
      { id: 'c', systems: 2, mines: 8, rp: 8 * 1494 },
    ];
    let s = galaxy(specs, 1500);                 // small enough to ration for a cycle or two
    for (let c = 0; c < 6; c += 1) s = runToBoundary(s);
    return hashState(s);
  };
  assert.equal(run(), run());
});

// --- 8. the snapshot surface --------------------------------------------------------

test('the snapshot publishes the grant, and the pool it came from', () => {
  let s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 498 }], 5000);
  const due = grantFor(s, s.guilds[0]);
  s = runToBoundary(s);

  const snap = buildSnapshot(s);
  const g = snap.guilds[0];
  assert.equal(g.fuelGrant.granted, due);
  assert.equal(g.fuelGrant.desired, due);
  assert.equal(g.fuelGrant.rationed, false, 'a fully-paid grant is not rationed');
  assert.equal(g.fuelGrant.tick, N);
  assert.equal(g.fuelGrant.thisTick, true);
  assert.equal(g.fuelHoard, due, 'beside the hoard it landed in');
  // THE POOL NEEDED NO NEW FIELD — it has been published here since the walking skeleton.
  assert.equal(snap.galacticSupply.fuel.reserve, pool(s));
  assert.equal(snap.galacticSupply.fuel.guildHeld, hoards(s));
  assert.equal(snap.galacticSupply.fuel.total, pool(s) + hoards(s));
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
});

test('the snapshot flags a RATIONED grant, so the crunch is visible', () => {
  const specs = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, systems: 2, mines: 8, rp: 8 * 1494 }));
  let s = galaxy(specs, 0);
  s = runToBoundary(s);
  const g = buildSnapshot(s).guilds[0];
  assert.equal(g.fuelGrant.rationed, true);
  assert.ok(g.fuelGrant.granted < g.fuelGrant.desired, 'and both figures are there to show by how much');
});

test('the snapshot reports null for a guild that has never been due anything', () => {
  const snap = buildSnapshot(galaxy([{ id: 'g1' }], 5000));
  assert.equal(snap.guilds[0].fuelGrant, null, 'a null, not an absence');
});
