'use strict';

// venture-teardown.test.js — the `decommissionVenture` action, engine + snapshot
// (docs/venture-teardown.md). Teardown is the mirror of establishVenture: it removes a
// venture, and its site goes vacant and its asset idle FOR FREE because both are DERIVED
// (sim/occupancy.js, sim/assets.js). The costs are all built from already-ruled terms —
// the RP forfeit is the venture's own reputation leaving the guild sum, the settlement fee
// is `remainingCycles × discountedFee`, the node lockout runs to the abandoned contract's
// end (`signedTick + windowDays × windowN`). One pure `teardownSettlement` helper computes
// all three, so the snapshot's preview and the apply's charge cannot disagree (§7).
//
// The home is DERIVED from the seed (home-anchor.js): HOME_MINE / HOME_MINE_2 are the
// homeworld's first two titanium nodes; HOME_SLOT a settlement slot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createState } = require('../state.js');
const {
  intake, validateAction,
  createFoundGuildAction, createEstablishVentureAction, createApplyForLicenceAction,
  createDecommissionVentureAction, createSetWindowNAction, createEstablishDeuteriumRefineryAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { computeOccupancy } = require('../occupancy.js');
const { idleAssets } = require('../assets.js');
const { teardownSettlement } = require('../licence.js');
const { buildSnapshot } = require('../snapshot.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const {
  HOME_SYSTEM, HOME_MINE, HOME_MINE_2, HOME_SLOT,
} = require('./home-anchor.js');

const GUILD = 'player-guild';
const N = 4;                                    // a short accrual window, so terms resolve fast
const M1 = 'asset_player-guild_miner_01';       // two of the fifteen Miners the founding gifts
const M2 = 'asset_player-guild_miner_02';

const guildOf = (s) => s.guilds.find((g) => g.id === GUILD);
const ventureOf = (s, id) => guildOf(s).ventures.find((v) => v.id === id);

// A galaxy with windowN pinned to N and the player founded on the home system, no ventures
// yet. Both actions apply at tick 0 (setWindowN is setup-only; founding is legal there),
// then the advance's tick carries state to tick 1.
function founded() {
  return advance(createZeroState(), [
    createSetWindowNAction({ windowN: N }),
    createFoundGuildAction({ guildId: GUILD, credits: 120, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]).state;
}

// Found, then establish a titanium mine on HOME_MINE and license it 100%/7-day in one
// advance (both apply at the same tick, so the licence signs the tick the mine is seated).
function foundedWithLicensedMine() {
  return advance(founded(), [
    createEstablishVentureAction({ guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 }),
    createApplyForLicenceAction({ guildId: GUILD, ventureId: 'mine_1', committedOutputPct: 1, windowDays: 7 }),
  ]).state;
}

// The settlement the engine would charge for tearing `id` down at the state's current tick,
// computed from the licence's OWN stored terms — the arithmetic the test asserts against,
// stated here rather than read back off the helper under test.
function expectedSettlement(s, id) {
  const lic = ventureOf(s, id).licence;
  if (!lic) return { settlementFee: 0, lockoutUntilTick: null };
  const remaining = Math.max(0, lic.windowDays - Math.floor((s.tick - lic.signedTick) / N));
  return {
    settlementFee: remaining * lic.discountedFee,
    lockoutUntilTick: remaining > 0 ? lic.signedTick + lic.windowDays * N : null,
  };
}

// --- constructor guards ----------------------------------------------------

test('createDecommissionVentureAction requires guildId and ventureId', () => {
  assert.throws(() => createDecommissionVentureAction({ ventureId: 'v' }), /guildId is required/);
  assert.throws(() => createDecommissionVentureAction({ guildId: 'g' }), /ventureId is required/);
  const a = createDecommissionVentureAction({ guildId: 'g', ventureId: 'v' });
  assert.deepEqual(a, { type: 'decommissionVenture', guildId: 'g', ventureId: 'v' });
});

// --- the end-to-end happy path (the required scenario) ----------------------

test('decommissioning a licensed venture: fee charged, site free, asset idle, lockout written, sum exact', () => {
  const s = foundedWithLicensedMine();
  // The bump minted at signing is on the venture, and the guild total carries it.
  const bump = ventureOf(s, 'mine_1').reputation;
  assert.ok(bump > 0, 'a 100% licence mints a signing bump');

  const creditsBefore = guildOf(s).credits;
  const ledgerBefore = s.syndicate.ledger;
  const want = expectedSettlement(s, 'mine_1');
  assert.ok(want.settlementFee > 0 && want.lockoutUntilTick != null, 'a fresh licence still has term left');

  const { state: after, results } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  assert.equal(results[0].accepted, true);

  // The venture is gone; its site reads vacant and its asset reads idle — both DERIVED (§0).
  assert.equal(ventureOf(after, 'mine_1'), undefined);
  assert.ok(!(HOME_MINE in computeOccupancy(after)), 'the site is free');
  assert.ok(idleAssets(guildOf(after), 'miner').some((a) => a.id === M1), 'the asset is idle again');

  // The settlement fee moved guild -> ledger exactly (§3.2), invariant 2 stays exact.
  assert.equal(guildOf(after).credits, creditsBefore - want.settlementFee);
  assert.equal(after.syndicate.ledger, ledgerBefore + want.settlementFee);

  // The node lockout is written to the abandoned term's end (§3.3).
  assert.equal(after.nodeLockouts.length, 1);
  assert.deepEqual(after.nodeLockouts[0], {
    siteId: HOME_MINE, releaseTick: want.lockoutUntilTick, lockedAtTick: after.tick,
  });

  // The teardown state is clean — checkGuildReputationSum included.
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('the freed asset is redeployable on another node immediately', () => {
  const s = foundedWithLicensedMine();
  const { state: after } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  // M1, idle again, deploys onto a DIFFERENT titanium node (not the locked HOME_MINE).
  const res = advance(after, [createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_2', siteId: HOME_MINE_2, assetId: M1, resourceType: 'titanium', productionRate: 5,
  })]);
  assert.equal(res.results[0].accepted, true);
  assert.equal(ventureOf(res.state, 'mine_2').assetId, M1);
  assert.deepEqual(checkInvariants(res.state, res.state.tick), []);
});

// --- the lockout: refused until release, then allowed, then pruned ----------

test('re-establishing the locked node is refused until release, then succeeds and prunes the entry', () => {
  let s = foundedWithLicensedMine();
  ({ state: s } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]));
  const releaseTick = s.nodeLockouts[0].releaseTick;

  const reEstablish = createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_1b', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5,
  });

  // Refused for every tick strictly before the release.
  while (s.tick < releaseTick - 1) s = advance(s, []).state;
  assert.equal(s.tick, releaseTick - 1);
  assert.equal(validateAction(s, reEstablish).valid, false, 'still locked one tick before release');
  assert.ok(s.nodeLockouts && s.nodeLockouts.length === 1, 'the lockout still stands');

  // At the release tick the site is free again; establishing there prunes the dead entry,
  // and because it was the only one the key vanishes (omit-when-empty preserved).
  s = advance(s, []).state;
  assert.equal(s.tick, releaseTick);
  const { state: reopened, results } = intake(s, [reEstablish]);
  assert.equal(results[0].accepted, true, 'the lockout has released');
  assert.equal(reopened.nodeLockouts, undefined, 'the expired entry is pruned, key omitted');
  assert.deepEqual(checkInvariants(reopened, reopened.tick), []);
});

// --- unlicensed teardown is trivially clean (§4) ---------------------------

test('an unlicensed venture tears down with no fee and no lockout, and its node is instantly reusable', () => {
  // Establish a mine but never license it.
  const s = advance(founded(), [createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_u', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5,
  })]).state;
  const creditsBefore = guildOf(s).credits;
  const ledgerBefore = s.syndicate.ledger;

  const { state: after, results } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_u' })]);
  assert.equal(results[0].accepted, true);
  assert.equal(guildOf(after).credits, creditsBefore, 'no fee off an absent licence');
  assert.equal(after.syndicate.ledger, ledgerBefore);
  assert.equal(after.nodeLockouts, undefined, 'no lockout, no key');
  // The node is free at once — a fresh establish is accepted with no wait.
  assert.equal(validateAction(after, createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_u2', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5,
  })).valid, true);
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- no bump farming (§8) --------------------------------------------------

test('signing 100% then tearing down before delivering keeps no RP and the sum stays exact', () => {
  const endowmentOnly = founded().guilds.find((g) => g.id === GUILD).guildReputation; // no ventures yet
  const s = foundedWithLicensedMine();
  assert.ok(guildOf(s).guildReputation > endowmentOnly, 'signing raised the guild total by the bump');

  const { state: after } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  // The bump left with the venture — the guild is back to exactly its founding endowment,
  // and the sum tripwire is exact (no RP kept, none stranded).
  assert.equal(guildOf(after).guildReputation, endowmentOnly);
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- GP drops when the venture leaves (via the snapshot) -------------------

test('the snapshot guildPoints drop by the venture that left', () => {
  const s = foundedWithLicensedMine();
  const gpBefore = buildSnapshot(s).guilds.find((g) => g.id === GUILD).guildPoints;
  const { state: after } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  const gpAfter = buildSnapshot(after).guilds.find((g) => g.id === GUILD).guildPoints;
  assert.ok(gpAfter < gpBefore, 'the venture no longer contributes its tier weight to GP');
});

// --- the settlement fee may drive credits negative (§3.2) ------------------

test('the settlement fee is charged in full and may drive credits negative (invariant 2 stays exact)', () => {
  // Found with zero credits; the licensed mine's remaining-term fee dwarfs any sale income.
  let s = advance(createZeroState(), [
    createSetWindowNAction({ windowN: N }),
    createFoundGuildAction({ guildId: GUILD, credits: 0, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]).state;
  s = advance(s, [
    createEstablishVentureAction({ guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5 }),
    createApplyForLicenceAction({ guildId: GUILD, ventureId: 'mine_1', committedOutputPct: 1, windowDays: 7 }),
  ]).state;

  const creditsBefore = guildOf(s).credits;
  const want = expectedSettlement(s, 'mine_1');
  const { state: after } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);

  assert.equal(guildOf(after).credits, creditsBefore - want.settlementFee);
  assert.ok(guildOf(after).credits < 0, 'the fee is charged whether or not the guild can pay');
  // The carve-out frees only the SIGN — invariant 2 (guild -X, ledger +X) is still exact.
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- past the term teardown is free (§3.2) ---------------------------------

test('past the contract term the settlement is 0 and no lockout is written', () => {
  let s = foundedWithLicensedMine();
  const lic = ventureOf(s, 'mine_1').licence;
  // Roll the whole contract out: at signedTick + windowDays × N the term has elapsed.
  const termEnd = lic.signedTick + lic.windowDays * N;
  while (s.tick < termEnd) s = advance(s, []).state;
  assert.ok(s.tick >= termEnd);

  const creditsBefore = guildOf(s).credits;
  const ledgerBefore = s.syndicate.ledger;
  const { state: after } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  assert.equal(guildOf(after).credits, creditsBefore, 'rolling past the term, walking is fee-free');
  assert.equal(after.syndicate.ledger, ledgerBefore);
  assert.equal(after.nodeLockouts, undefined, 'no term left, no lockout');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- orphaned window accrual is benign (§8) --------------------------------

test('tearing down the last committing venture mid-window, then crossing the boundary, throws nothing and charges nothing', () => {
  const s = foundedWithLicensedMine();
  // The committed mine has opened a window and delivered into it.
  const win = guildOf(s).syndicateWindows[HOME_SYSTEM] && guildOf(s).syndicateWindows[HOME_SYSTEM].titanium;
  assert.ok(win && win.delivered > 0, 'the mine delivered into an open window');

  // Tear it down mid-window (before the tick-N boundary).
  const { state: torn } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  const creditsBeforeBoundary = guildOf(torn).credits;

  // Advance across the next window boundary. `advance` asserts every invariant, so simply
  // reaching the far side is the "no throw" proof; the orphaned window state is left inert.
  let after = torn;
  do { after = advance(after, []).state; } while (after.tick % N !== 0);
  after = advance(after, []).state; // one more, comfortably past the boundary

  assert.equal(guildOf(after).credits, creditsBeforeBoundary, 'no phantom fee at the boundary for the removed venture');
  assert.equal(guildOf(after).lastLicenceFee, undefined, 'no fee record — nothing was judged');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- the snapshot preview matches the charge (§7) --------------------------

test('the snapshot previews teardownSettlement with the same numbers the apply charges', () => {
  const s = foundedWithLicensedMine();
  const previewSnap = buildSnapshot(s).ventures.find((v) => v.id === 'mine_1').teardownSettlement;
  const previewFn = teardownSettlement(s, guildOf(s), ventureOf(s, 'mine_1'));
  assert.deepEqual(previewSnap, previewFn, 'snapshot preview == the helper');

  const creditsBefore = guildOf(s).credits;
  const { state: after } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]);
  // The preview the client would have shown is exactly what the engine took.
  assert.equal(guildOf(after).credits, creditsBefore - previewSnap.settlementFee);
  assert.equal(after.nodeLockouts[0].releaseTick, previewSnap.lockoutUntilTick);
  assert.equal(previewSnap.rpForfeit, ventureOf(s, 'mine_1').reputation);
});

test('the snapshot publishes top-level nodeLockouts with ticksRemaining', () => {
  let s = foundedWithLicensedMine();
  ({ state: s } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]));
  const snap = buildSnapshot(s);
  assert.equal(snap.nodeLockouts.length, 1);
  const l = snap.nodeLockouts[0];
  assert.equal(l.siteId, HOME_MINE);
  assert.equal(l.ticksRemaining, l.releaseTick - s.tick);
  // A galaxy with no lockouts still emits a stable [] for the reader.
  assert.deepEqual(buildSnapshot(founded()).nodeLockouts, []);
});

// --- the lockout survives save/reload (§3.3) -------------------------------

test('a node lockout survives a save/reload round-trip', () => {
  let s = foundedWithLicensedMine();
  ({ state: s } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'mine_1' })]));
  assert.ok(s.nodeLockouts.length === 1);

  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-teardown-'));
  saveState(s, dir);
  const restored = loadOrInit(dir, createZeroState);   // no journal, so this is the parsed snapshot
  assert.equal(hashState(restored), hashState(s), 'the reloaded state is byte-identical');
  assert.deepEqual(restored.nodeLockouts, s.nodeLockouts, 'the absolute-tick lockout came back intact');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- validation refusals ---------------------------------------------------

test('decommission refuses an unknown guild, an unknown venture, and another guild\'s venture', () => {
  const s = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 0, ventures: [{ id: 'v1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'titanium', productionRate: 5 }] },
      { id: 'g2', credits: 0, fuelHoard: 0, ventures: [{ id: 'v2', ownerGuildId: 'g2', type: 'mining', systemId: 'sysB', resourceType: 'titanium', productionRate: 5 }] },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.match(validateAction(s, createDecommissionVentureAction({ guildId: 'ghost', ventureId: 'v1' })).reason, /no guild/);
  assert.match(validateAction(s, createDecommissionVentureAction({ guildId: 'g1', ventureId: 'nope' })).reason, /has no venture/);
  // Closing is an act on a venture you OWN — g1 cannot decommission g2's venture.
  assert.match(validateAction(s, createDecommissionVentureAction({ guildId: 'g1', ventureId: 'v2' })).reason, /has no venture/);
  assert.equal(validateAction(s, createDecommissionVentureAction({ guildId: 'g1', ventureId: 'v1' })).valid, true);
});

test('a licensed deuterium mine is refused (§6 deferral); an unlicensed one is not', () => {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [
        { id: 'lic', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: 5, deuteriumLicence: { signedTick: 0 } },
        { id: 'unl', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: 5 },
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.match(validateAction(s, createDecommissionVentureAction({ guildId: 'g1', ventureId: 'lic' })).reason, /deferred to the deuterium hardening slice/);
  // An UNLICENSED deuterium mine carries no deuterium licence — it tears down clean.
  assert.equal(validateAction(s, createDecommissionVentureAction({ guildId: 'g1', ventureId: 'unl' })).valid, true);
});

// --- the invariant trips on a corrupt entry (§9) ---------------------------

test('checkNodeLockouts trips on a corrupt entry', () => {
  const base = { guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } };
  // releaseTick not strictly after lockedAtTick.
  const backwards = createState({ ...base, nodeLockouts: [{ siteId: HOME_MINE, releaseTick: 5, lockedAtTick: 10 }] });
  assert.ok(checkInvariants(backwards, 0).some((v) => /node-lockout-releaseTick/.test(v.rule)));
  // A siteId that resolves to no seed site.
  const dangling = createState({ ...base, nodeLockouts: [{ siteId: 'not_a_real_site', releaseTick: 10, lockedAtTick: 2 }] });
  assert.ok(checkInvariants(dangling, 0).some((v) => /node-lockout-site-exists/.test(v.rule)));
  // A negative lockedAtTick.
  const negative = createState({ ...base, nodeLockouts: [{ siteId: HOME_MINE, releaseTick: 10, lockedAtTick: -1 }] });
  assert.ok(checkInvariants(negative, 0).some((v) => /node-lockout-lockedAtTick/.test(v.rule)));
  // A well-formed entry trips nothing.
  const ok = createState({ ...base, nodeLockouts: [{ siteId: HOME_MINE, releaseTick: 10, lockedAtTick: 2 }] });
  assert.deepEqual(checkInvariants(ok, 0).filter((v) => /node-lockout/.test(v.rule)), []);
});

// --- the lockout gates a deuterium refinery too (§3.3) ---------------------

test('a lockout on a settlement slot refuses an establishDeuteriumRefinery there', () => {
  // A licensed refining venture on a settlement slot, torn down mid-term, locks the slot.
  let s = advance(founded(), [createEstablishVentureAction({
    guildId: GUILD, ventureId: 'ref_1', type: 'refining', siteId: HOME_SLOT,
    assetId: 'asset_player-guild_factory_01', recipeId: 'titanium_alloy', productionRate: 5,
  })]).state;
  s = advance(s, [createApplyForLicenceAction({ guildId: GUILD, ventureId: 'ref_1', committedOutputPct: 1, windowDays: 7 })]).state;
  ({ state: s } = intake(s, [createDecommissionVentureAction({ guildId: GUILD, ventureId: 'ref_1' })]));
  assert.equal(s.nodeLockouts[0].siteId, HOME_SLOT);
  // The refinery establish is refused on the locked slot, the same gate establishVenture hits.
  const refinery = createEstablishDeuteriumRefineryAction({
    guildId: GUILD, ventureId: 'refy', siteId: HOME_SLOT, assetId: 'asset_player-guild_factory_02', productionRate: 5,
  });
  assert.match(validateAction(s, refinery).reason, /locked after a venture teardown/);
});
