'use strict';

// forced-closure.test.js — the −500 forced closure of a venture (docs/forced-closure.md).
//
// At a window boundary, a breach that drives a venture's reputation to the −500 floor is a
// CLOSURE trigger: the Syndicate revokes the licence, removes the venture, and quarantines its
// node. Forced closure is an INVOLUNTARY sibling of `decommissionVenture` (docs/venture-teardown.md)
// — it REUSES that machinery (the shared `applyVentureClosure` mutation: RP forfeit + removal +
// node lockout), with ONE difference: it charges NO settlement fee (§3.4), because the breach that
// triggered it already paid the full basic fee for that cycle at the boundary.
//
// The trigger fires in the tick's boundary RP move (sim/tick.js `applyProduction`), collected there
// and applied by `stepProduction` after the guild's whole fee loop finishes — so the ventures array
// is never mutated mid-loop and the cratering breach's fee is still charged (§1/§5).
//
// The fixtures mirror venture-teardown.test.js: a real founded galaxy on the seed home, a short
// accrual window, and `atRP` to stand a venture near the floor so a single breach craters it —
// standing in for the many cycles the engine would take to get there, not bypassing a rule (the
// REAL tick then does the closing).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { tick } = require('../tick.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createState } = require('../state.js');
const {
  intake, validateAction,
  createFoundGuildAction, createEstablishVentureAction, createApplyForLicenceAction,
  createSetProductionProfileAction, createSetWindowNAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { computeOccupancy } = require('../occupancy.js');
const { idleAssets } = require('../assets.js');
const { licenceEndTick, RP_FLOOR } = require('../licence.js');
const {
  HOME_SYSTEM, HOME_MINE, HOME_MINE_2,
} = require('./home-anchor.js');

const GUILD = 'player-guild';
const N = 4;                                    // a short accrual window, so a boundary is 4 ticks away
const M1 = 'asset_player-guild_miner_01';       // one of the fifteen Miners the founding gifts

const guildOf = (s) => s.guilds.find((g) => g.id === GUILD);
const ventureOf = (s, id) => guildOf(s).ventures.find((v) => v.id === id);

// A galaxy with windowN pinned to N, the player founded on the home system, holding a titanium
// mine on HOME_MINE licensed 100%/7-day (signed the tick the mine is seated, so its window opens
// clean). The licence gives it a commitment to breach and a term for the lockout to run to.
function foundedWithLicensedMine() {
  const founded = advance(createZeroState(), [
    createSetWindowNAction({ windowN: N }),
    createFoundGuildAction({ guildId: GUILD, credits: 100000, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]).state;
  return advance(founded, [
    createEstablishVentureAction({ guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 }),
    createApplyForLicenceAction({ guildId: GUILD, ventureId: 'mine_1', committedOutputPct: 1, windowDays: 7 }),
  ]).state;
}

// Send NOTHING to the Syndicate, so a positive commitment is breached at the boundary — the same
// lever reputation.test.js uses to force a breach (a starved fork delivers 0 against a target > 0).
function starve(s) {
  return intake(s, [createSetProductionProfileAction({
    guildId: GUILD, systemId: HOME_SYSTEM, goods: { titanium: { syndicate: { mode: 'absolute', value: 0 } } },
  })]).state;
}

// Put a venture AT a reputation the engine would have taken many cycles to reach, keeping the
// guild total exact so checkGuildReputationSum stays green — the reputation.test.js `atRP` helper.
function atRP(s, id, value) {
  ventureOf(s, id).reputation = value;
  guildOf(s).guildReputation = guildOf(s).ventures.reduce((n, v) => n + (v.reputation || 0), 0)
    + (guildOf(s).foundingEndowment || 0);
  return s;
}

// Run whole ticks to the next window boundary (the tick where the verdict — and any closure — lands).
function runToBoundary(s) {
  do { s = tick(s); } while (s.tick % N !== 0);
  return s;
}

// --- the end-to-end happy path (the required scenario) ----------------------

test('a breach that drives a venture to −500 force-closes it: removed, licence gone, asset idle, node locked, sum exact', () => {
  // Stand the mine one breach above the floor, then starve its commitment so the next boundary
  // breaches it to −500. A full-commitment breach is −3, so −498 craters to −501 → clamped to −500.
  let s = starve(foundedWithLicensedMine());
  s = atRP(s, 'mine_1', -498);
  const lic = ventureOf(s, 'mine_1').licence;
  const expectedRelease = licenceEndTick(lic, N);          // the abandoned term's end (§3.3)
  const endowment = guildOf(s).foundingEndowment || 0;

  const creditsBefore = guildOf(s).credits;
  const ledgerBefore = s.syndicate.ledger;

  s = runToBoundary(s);

  // The venture is GONE — the breach that hit the floor closed it (§1).
  assert.equal(ventureOf(s, 'mine_1'), undefined, 'the cratered venture is force-closed');
  // Its site reads vacant and its asset reads idle — both DERIVED (§0/§3.2), so redeployable.
  assert.ok(!(HOME_MINE in computeOccupancy(s)), 'the site is free');
  assert.ok(idleAssets(guildOf(s), 'miner').some((a) => a.id === M1), 'the asset is idle again');
  // The node lockout runs to the abandoned contract's end, for ANY guild (§3.3). `lockedAtTick`
  // is the tick the mutation was made — `state.tick` DURING the boundary tick, one below the tick
  // it lands on (the same pre-increment convention the tick's venture `updatedAtTick` stamps use).
  assert.equal(s.nodeLockouts.length, 1);
  assert.deepEqual(s.nodeLockouts[0], { siteId: HOME_MINE, releaseTick: expectedRelease, lockedAtTick: s.tick - 1 });
  // A `venture_closed` NOTICE was written (docs/event-log.md §2), cause 'forced', with a
  // self-contained payload and born UNREAD. The venture is gone, so the notice must carry its
  // own display name/good/system — the client cannot re-resolve them off a removed venture.
  const notice = guildOf(s).events.find((e) => e.type === 'venture_closed');
  assert.ok(notice, 'a venture_closed notice was recorded');
  assert.equal(notice.payload.cause, 'forced', 'a Syndicate forced closure');
  assert.equal(notice.payload.ventureId, 'mine_1');
  assert.ok(typeof notice.payload.ventureName === 'string' && notice.payload.ventureName.length > 0, 'a display name is carried');
  assert.equal(notice.payload.good, 'titanium', 'the committed good is carried');
  assert.equal(notice.payload.systemId, HOME_SYSTEM, 'the system is carried');
  assert.equal(notice.payload.lockoutUntilTick, expectedRelease, 'the node lockout tick is carried (one was written)');
  assert.equal(notice.readTick, undefined, 'born unread');
  // The RP forfeit removed the venture's −500 as it left the array, so the guild is back to just
  // its founding endowment — the "windfall" of shedding the wreck (§3.1) — and the sum is exact.
  assert.equal(guildOf(s).guildReputation, endowment, 'the floored venture\'s RP left with it');
  // Closure charged NO fee of its own (§3.4). Credits moved only by the cycle's breach fee (the
  // full basic fee), which is a debit to the ledger — the closure added nothing on top.
  const feeCharged = creditsBefore - guildOf(s).credits;
  assert.ok(feeCharged >= 0, 'the only credit movement is the breach fee, never a settlement fee');
  assert.equal(s.syndicate.ledger - ledgerBefore, feeCharged, 'guild −fee, ledger +fee — invariant 2 exact');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'checkGuildReputationSum / checkNodeLockouts / band all pass');
});

test('the breach that triggers closure still pays its FULL BASIC FEE this cycle (§3.4)', () => {
  // Closure adds no fee, but the breach it rides on is charged like any breach: the full basic
  // fee, the discount voided. Crater it in a FULL window (windowFraction 1), so `owed` is the
  // whole `basicFee` and is distinguishable from the discounted fee — the mine signed mid-window,
  // so its FIRST window is pro-rated and would blur the two. Advance one boundary first (holding
  // RP up), then stand it at the floor edge and let the next, full window crater it.
  let s = starve(foundedWithLicensedMine());
  s = runToBoundary(s);                                   // clear the pro-rated first window
  if (ventureOf(s, 'mine_1')) atRP(s, 'mine_1', 0);       // ...holding RP up so it did not crater yet
  const lic = ventureOf(s, 'mine_1').licence;
  const { basicFee, discountedFee } = lic;
  assert.ok(basicFee > discountedFee, 'this licence really does carry a discount to void');

  s = atRP(s, 'mine_1', -498);
  s = runToBoundary(s);

  const row = guildOf(s).lastLicenceFee.ventures.mine_1;
  assert.equal(row.status, 'breach', 'the cratering verdict was a breach');
  assert.equal(row.owed, basicFee, 'and a breach owes the FULL basic fee, not the discounted one');
  assert.notEqual(row.owed, discountedFee, 'the discount is voided — this is a real distinction');
  assert.equal(ventureOf(s, 'mine_1'), undefined, 'and the venture is gone all the same');
});

// --- the node lockout gates a fresh establish for ANY guild (§3.3) ----------

test('the locked node refuses a fresh establish until release, then permits it', () => {
  let s = starve(foundedWithLicensedMine());
  s = atRP(s, 'mine_1', -498);
  s = runToBoundary(s);
  const releaseTick = s.nodeLockouts[0].releaseTick;
  assert.ok(releaseTick > s.tick, 'the lockout is live');

  const reEstablish = createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_1b', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5,
  });

  // Refused for every tick strictly before release — the site is vacant but quarantined.
  while (s.tick < releaseTick - 1) s = advance(s, []).state;
  assert.equal(validateAction(s, reEstablish).valid, false, 'still locked one tick before release');

  // At the release tick the establish is accepted and the dead entry is pruned (omit-when-empty).
  s = advance(s, []).state;
  assert.equal(s.tick, releaseTick);
  const { state: reopened, results } = intake(s, [reEstablish]);
  assert.equal(results[0].accepted, true, 'the lockout has released');
  assert.equal(reopened.nodeLockouts, undefined, 'the expired entry is pruned, key omitted');
  assert.deepEqual(checkInvariants(reopened, reopened.tick), []);
});

test('the freed asset redeploys immediately onto a DIFFERENT node', () => {
  let s = starve(foundedWithLicensedMine());
  s = atRP(s, 'mine_1', -498);
  s = runToBoundary(s);
  // M1, idle again, deploys onto a different titanium node (not the locked HOME_MINE).
  const res = advance(s, [createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_2', siteId: HOME_MINE_2, assetId: M1, resourceType: 'titanium', productionRate: 5,
  })]);
  assert.equal(res.results[0].accepted, true);
  assert.equal(ventureOf(res.state, 'mine_2').assetId, M1);
  assert.deepEqual(checkInvariants(res.state, res.state.tick), []);
});

// --- closure past the term writes no lockout (§3.3 accepted asymmetry) ------

test('a venture cratering PAST its term is closed but writes no lockout', () => {
  // Roll the whole contract out first, then crater it in the post-term rolling window (before the
  // renegotiation auto-lapse deadline). Past the term `remainingCycles` is 0, so no lockout (§3.3).
  let s = starve(foundedWithLicensedMine());
  const lic = ventureOf(s, 'mine_1').licence;
  const termEnd = licenceEndTick(lic, N);
  // Advance to the term end WITHOUT letting RP fall to the floor on the way — keep it topped up
  // each tick so the crater happens only where we choose, past the term.
  while (s.tick < termEnd) {
    s = tick(s);
    if (ventureOf(s, 'mine_1')) atRP(s, 'mine_1', 0);   // hold it up until we are past the term
  }
  assert.ok(ventureOf(s, 'mine_1'), 'still open, and now past its term');
  assert.ok(s.tick >= termEnd);

  // Now stand it at the floor edge and let the next post-term boundary crater it.
  s = atRP(s, 'mine_1', -498);
  s = runToBoundary(s);
  assert.equal(ventureOf(s, 'mine_1'), undefined, 'closed all the same');
  assert.equal(s.nodeLockouts, undefined, 'but no lockout — the term had already rolled past (§3.3)');
  // The notice omits `lockoutUntilTick` exactly when no lockout was written (§2 self-contained).
  const notice = guildOf(s).events.find((e) => e.type === 'venture_closed');
  assert.equal(notice.payload.cause, 'forced');
  assert.ok(!('lockoutUntilTick' in notice.payload), 'no lockout tick in the payload — none was written');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- closure pre-empts / discards pending renegotiation state (§2) ---------

test('closure discards pending renegotiation state — no orphaned offer or auto-lapse timer survives', () => {
  // A venture whose window has elapsed carries a renegotiation offer (derived) and is a candidate
  // for the auto-lapse tick step. If it craters at a boundary, closure removes it — and because ALL
  // of that state is derived from the now-gone licence/venture, nothing is left to fire (§2).
  let s = starve(foundedWithLicensedMine());
  const lic = ventureOf(s, 'mine_1').licence;
  const termEnd = licenceEndTick(lic, N);
  while (s.tick < termEnd) {
    s = tick(s);
    if (ventureOf(s, 'mine_1')) atRP(s, 'mine_1', 0);
  }
  // Stand it at the floor edge and crater it at the next boundary.
  s = atRP(s, 'mine_1', -498);
  s = runToBoundary(s);
  assert.equal(ventureOf(s, 'mine_1'), undefined, 'the venture (and its licence, and its derived offer) is gone');

  // Advance well past where an auto-lapse deadline would have fallen: no throw, no phantom mutation,
  // and the guild is untouched by any orphaned timer. `advance` asserts every invariant each tick.
  for (let i = 0; i < 3 * N; i += 1) s = advance(s, []).state;
  assert.equal(ventureOf(s, 'mine_1'), undefined, 'still gone — nothing resurrected or re-lapsed it');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- a met at the floor is NOT closed (only a breach reaches it, §1) --------

test('a venture at the floor that MEETS climbs back and is NOT closed', () => {
  // No starve: the mine meets its commitment, so at the boundary it GAINS (climbs off the floor)
  // rather than reaching it. Only a breach can land on −500, so a met is never a closure.
  let s = foundedWithLicensedMine();
  s = atRP(s, 'mine_1', RP_FLOOR);
  s = runToBoundary(s);
  assert.ok(ventureOf(s, 'mine_1'), 'a meeting venture at the floor survives and climbs');
  assert.ok(ventureOf(s, 'mine_1').reputation > RP_FLOOR, 'it climbed off the floor at full strength');
  assert.equal(s.nodeLockouts, undefined, 'nothing closed, so no lockout');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- a licensed deuterium mine never force-closes (§1, out of scope) --------

test('a licensed deuterium mine never force-closes — it cannot breach and opens at +1000', () => {
  // A licensed deuterium mine is breachless (it delivers continuously) and its RP only ever climbs
  // via the per-cycle met, so it can never reach −500. Even hand-seeded near the floor, its cycle
  // verdict is a MET (a gain), so it is never collected for closure. Built directly (no windowed
  // licence path exists for deuterium) with the seed home's deuterium... use a synthetic state so
  // the assertion is about the RP path, not a full deuterium galaxy.
  let s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'dmine', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA',
        resourceType: 'deuterium', productionRate: 5,
        deuteriumLicence: { signedTick: 0 }, reputation: -499,
      }],
    }],
    reserve: { reserveLevel: 0, fuelPrice: 1, avgDraw: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
  s.guilds[0].guildReputation = -499;
  // Run several boundaries: the deuterium met (a gain) climbs it away from the floor; it is never
  // closed, and no lockout is ever written for it.
  for (let i = 0; i < 3 * N; i += 1) s = tick(s);
  assert.ok(s.guilds[0].ventures.find((v) => v.id === 'dmine'), 'the deuterium mine is still open');
  assert.ok(s.guilds[0].ventures[0].reputation > RP_FLOOR, 'it climbed away from the floor, never reaching it');
  assert.equal(s.nodeLockouts, undefined, 'no forced closure, no lockout');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
