'use strict';

// operator-adjust.test.js — the invariant-safety bar for the six operator/dev adjust
// levers (docs/operator-adjust.md). The whole point of these actions (§2) is that each
// does the CONSERVING COUNTER-MOVE its quantity requires, so `checkInvariants` is CLEAN
// after every apply — that is what makes them safe to hand an operator. So every test
// here applies one lever through the real intake path (no tick, exactly as POST /action
// applies it) and asserts the §15.5 tripwires stay silent, plus the specific conserved
// quantity moved the way §3 says.
//
// State is built the way the game builds it — a founded guild on a real seed home, its
// starter assets, and (where a venture is needed) a real mine established on a real node
// — so the levers act on the same shapes production and teardown do, never a synthetic
// one that could hide a seam.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { tick } = require('../tick.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { getStock, guildTotals } = require('../stock.js');
const {
  intake,
  createFoundGuildAction, createEstablishVentureAction,
  createAdjustCreditsAction, createAdjustFuelAction, createAdjustGoodsAction,
  createGrantAssetAction, createRemoveAssetAction, createRemoveVentureAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const GUILD = 'player-guild';
const M1 = 'asset_player-guild_miner_01'; // the first of the fifteen founding Miners

// A galaxy with the player founded on the home system (starter assets granted, no
// ventures). Founded through intake at tick 0 — no tick — so each test's own apply is
// the only mutation between it and the invariant check.
function founded(credits = 5_000_000) {
  const found = createFoundGuildAction({ guildId: GUILD, credits, influence: 100, homeSystemId: HOME_SYSTEM });
  return intake(createZeroState(), [found]).state;
}

// The same, with one titanium mine established on the home node, occupying miner M1 —
// the venture ↔ asset pair the removal levers act on.
function withMine(credits = 5_000_000) {
  const s = founded(credits);
  const est = createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1, resourceType: 'titanium', productionRate: 5,
  });
  return intake(s, [est]).state;
}

const guildOf = (state) => state.guilds.find((g) => g.id === GUILD);
// Apply one action through intake (no tick), returning { next, result }.
function apply(state, action) {
  const { state: next, results } = intake(state, [action]);
  return { next, result: results[0] };
}

// --- constructor guards ------------------------------------------------------

test('the six adjust constructors require their fields', () => {
  assert.throws(() => createAdjustCreditsAction({ delta: 1 }), /guildId is required/);
  assert.throws(() => createAdjustCreditsAction({ guildId: 'g' }), /delta is required/);
  assert.throws(() => createAdjustFuelAction({ guildId: 'g' }), /delta is required/);
  assert.throws(() => createAdjustGoodsAction({ guildId: 'g', systemId: 's', good: 'x' }), /delta is required/);
  assert.throws(() => createAdjustGoodsAction({ guildId: 'g', good: 'x', delta: 1 }), /systemId is required/);
  assert.throws(() => createGrantAssetAction({ guildId: 'g', kind: 'miner' }), /systemId is required/);
  assert.throws(() => createRemoveAssetAction({ guildId: 'g' }), /assetId is required/);
  assert.throws(() => createRemoveVentureAction({ guildId: 'g' }), /ventureId is required/);
});

// --- adjustCredits (§3.1) ----------------------------------------------------

test('adjustCredits grant and remove leave invariant 2 exact (guild ±C, ledger ∓C)', () => {
  const s = founded();
  const g0 = guildOf(s);
  const startCredits = g0.credits;
  const startLedger = s.syndicate.ledger;
  const startExpected = s.audit.expectedCreditTotal;

  // Grant: guild +C, ledger −C, total unchanged.
  const { next: granted, result: gr } = apply(s, createAdjustCreditsAction({ guildId: GUILD, delta: 1_500_000 }));
  assert.equal(gr.accepted, true);
  assert.equal(guildOf(granted).credits, startCredits + 1_500_000);
  assert.equal(granted.syndicate.ledger, startLedger - 1_500_000);
  assert.equal(granted.audit.expectedCreditTotal, startExpected, 'the sanctioned total never moves');
  assert.deepEqual(checkInvariants(granted, granted.tick), []);

  // Remove: guild −C, ledger +C.
  const { next: removed, result: rr } = apply(granted, createAdjustCreditsAction({ guildId: GUILD, delta: -500_000 }));
  assert.equal(rr.accepted, true);
  assert.equal(guildOf(removed).credits, startCredits + 1_000_000);
  assert.equal(removed.syndicate.ledger, startLedger - 1_000_000);
  assert.deepEqual(checkInvariants(removed, removed.tick), []);
});

test('adjustCredits past the balance reject-wholes (credits unchanged)', () => {
  const s = founded(2_000);
  const { next, result } = apply(s, createAdjustCreditsAction({ guildId: GUILD, delta: -2_001 }));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /below zero/);
  assert.equal(guildOf(next).credits, 2_000, 'a refused remove leaves credits untouched');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// --- adjustFuel (§3.2) -------------------------------------------------------

test('adjustFuel grant and remove keep invariant 1 closed (audit moves with the hoard)', () => {
  const s = founded();
  const g0 = guildOf(s);
  const startHoard = g0.fuelHoard;
  const startProduced = s.audit.totalProduced;
  const startConsumed = s.audit.totalConsumed;

  // Grant: hoard += delta, totalProduced += delta.
  const { next: granted, result: gr } = apply(s, createAdjustFuelAction({ guildId: GUILD, delta: 40_000 }));
  assert.equal(gr.accepted, true);
  assert.equal(guildOf(granted).fuelHoard, startHoard + 40_000);
  assert.equal(granted.audit.totalProduced, startProduced + 40_000);
  assert.equal(granted.audit.totalConsumed, startConsumed, 'a grant does not touch consumed');
  assert.deepEqual(checkInvariants(granted, granted.tick), []);

  // Remove: hoard += delta (delta<0), totalConsumed += -delta.
  const { next: removed, result: rr } = apply(granted, createAdjustFuelAction({ guildId: GUILD, delta: -10_000 }));
  assert.equal(rr.accepted, true);
  assert.equal(guildOf(removed).fuelHoard, startHoard + 30_000);
  assert.equal(removed.audit.totalConsumed, startConsumed + 10_000);
  assert.deepEqual(checkInvariants(removed, removed.tick), []);
});

test('adjustFuel below zero reject-wholes (hoard untouched)', () => {
  const s = founded();
  const startHoard = guildOf(s).fuelHoard;
  const { next, result } = apply(s, createAdjustFuelAction({ guildId: GUILD, delta: -(startHoard + 1) }));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /below zero/);
  assert.equal(guildOf(next).fuelHoard, startHoard);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// --- adjustGoods (§3.3) ------------------------------------------------------

test('adjustGoods add and remove keep the galactic-supply cache consistent', () => {
  const s = founded();
  // Add 900 titanium into the home cell — the cache must refresh in the same apply.
  const { next: added, result: ar } = apply(s, createAdjustGoodsAction({ guildId: GUILD, systemId: HOME_SYSTEM, good: 'titanium', delta: 900 }));
  assert.equal(ar.accepted, true);
  assert.equal(getStock(guildOf(added), HOME_SYSTEM, 'titanium'), 900);
  assert.equal(added.galacticSupply.resources.titanium, 900, 'the cache saw the deposit');
  assert.deepEqual(checkInvariants(added, added.tick), []);

  // Remove 400 back down — cache follows.
  const { next: removed, result: rr } = apply(added, createAdjustGoodsAction({ guildId: GUILD, systemId: HOME_SYSTEM, good: 'titanium', delta: -400 }));
  assert.equal(rr.accepted, true);
  assert.equal(getStock(guildOf(removed), HOME_SYSTEM, 'titanium'), 500);
  assert.equal(removed.galacticSupply.resources.titanium, 500);
  assert.deepEqual(checkInvariants(removed, removed.tick), []);
});

test('adjustGoods below the cell, and an unknown good / system / fuel, reject-whole', () => {
  const s = founded();
  const below = apply(s, createAdjustGoodsAction({ guildId: GUILD, systemId: HOME_SYSTEM, good: 'titanium', delta: -1 }));
  assert.equal(below.result.accepted, false, 'the empty cell cannot go negative');
  assert.match(below.result.reason, /below zero/);

  const badGood = apply(s, createAdjustGoodsAction({ guildId: GUILD, systemId: HOME_SYSTEM, good: 'not_a_good', delta: 10 }));
  assert.equal(badGood.result.accepted, false);
  assert.match(badGood.result.reason, /not a known stockpile good/);

  // Fuel is not a stockpile good — it belongs on adjustFuel, so adjustGoods refuses it.
  const fuel = apply(s, createAdjustGoodsAction({ guildId: GUILD, systemId: HOME_SYSTEM, good: 'deuterium_fuel', delta: 10 }));
  assert.equal(fuel.result.accepted, false);
  assert.match(fuel.result.reason, /not a known stockpile good/);

  const badSys = apply(s, createAdjustGoodsAction({ guildId: GUILD, systemId: 'no_such_system', good: 'titanium', delta: 10 }));
  assert.equal(badSys.result.accepted, false);
  assert.match(badSys.result.reason, /not a system on the seed/);

  const zero = apply(s, createAdjustGoodsAction({ guildId: GUILD, systemId: HOME_SYSTEM, good: 'titanium', delta: 0 }));
  assert.equal(zero.result.accepted, false, 'a zero delta is a refused no-op');
});

// --- grantAsset (§3.4) -------------------------------------------------------

test('grantAsset mints a unique, well-formed, idle asset; a second gets the next NN', () => {
  const s = founded();
  const before = guildOf(s).assets.length;

  const { next: g1, result: r1 } = apply(s, createGrantAssetAction({ guildId: GUILD, kind: 'factory', systemId: HOME_SYSTEM }));
  assert.equal(r1.accepted, true);
  const a1 = guildOf(g1).assets[guildOf(g1).assets.length - 1];
  // The starter grant is 10 factories (asset_..._factory_01..10), so the next free NN is 11.
  assert.equal(a1.id, 'asset_player-guild_factory_11');
  assert.equal(a1.kind, 'factory');
  assert.equal(a1.systemId, HOME_SYSTEM);
  assert.equal(a1.maintenanceCondition, 1, 'minted new');
  // Idle: no venture references it (there are no ventures at all here).
  assert.equal((guildOf(g1).ventures || []).some((v) => v.assetId === a1.id), false);
  assert.equal(guildOf(g1).assets.length, before + 1);
  assert.deepEqual(checkInvariants(g1, g1.tick), []);

  // A second factory grant continues the sequence — NN 12, no collision.
  const { next: g2, result: r2 } = apply(g1, createGrantAssetAction({ guildId: GUILD, kind: 'factory', systemId: HOME_SYSTEM }));
  assert.equal(r2.accepted, true);
  assert.equal(guildOf(g2).assets[guildOf(g2).assets.length - 1].id, 'asset_player-guild_factory_12');
  assert.deepEqual(checkInvariants(g2, g2.tick), []);
});

test('grantAsset rejects an unknown kind or system, and mints nothing', () => {
  const s = founded();
  const before = guildOf(s).assets.length;
  const badKind = apply(s, createGrantAssetAction({ guildId: GUILD, kind: 'starbase', systemId: HOME_SYSTEM }));
  assert.equal(badKind.result.accepted, false);
  assert.match(badKind.result.reason, /not an asset kind/);
  assert.equal(guildOf(badKind.next).assets.length, before);

  const badSys = apply(s, createGrantAssetAction({ guildId: GUILD, kind: 'miner', systemId: 'no_such_system' }));
  assert.equal(badSys.result.accepted, false);
  assert.match(badSys.result.reason, /not a system on the seed/);
  assert.equal(guildOf(badSys.next).assets.length, before);
});

// --- removeAsset (§3.5) ------------------------------------------------------

test('removeAsset detach leaves the venture dormant (assetId gone) — invariants clean through a tick', () => {
  const s = withMine();
  assert.equal(guildOf(s).ventures[0].assetId, M1, 'the mine occupies M1');

  const { next, result } = apply(s, createRemoveAssetAction({ guildId: GUILD, assetId: M1 })); // default 'detach'
  assert.equal(result.accepted, true);
  const v = guildOf(next).ventures[0];
  assert.equal(v.id, 'mine_1', 'the venture survives');
  assert.equal(v.assetId, undefined, 'its asset pointer is nulled (omit-when-null)');
  assert.equal(guildOf(next).assets.some((a) => a.id === M1), false, 'the asset is gone');
  assert.deepEqual(checkInvariants(next, next.tick), []);

  // THE DETACH-PRODUCTION PROOF (§3.5): an asset-less venture is invariant-legal, and a
  // tick step run afterward stays clean — no path dereferences the nulled assetId.
  const ticked = tick(next);
  assert.deepEqual(checkInvariants(ticked, ticked.tick), []);
  // …and the same holds driven through the full advance() (intake + tick + assert).
  assert.doesNotThrow(() => advance(next, []));
});

test('removeAsset close removes venture + asset and writes the venture_closed event', () => {
  const s = withMine();
  const { next, result } = apply(s, createRemoveAssetAction({ guildId: GUILD, assetId: M1, occupied: 'close' }));
  assert.equal(result.accepted, true);
  assert.equal(guildOf(next).ventures.length, 0, 'the venture is gone');
  assert.equal(guildOf(next).assets.some((a) => a.id === M1), false, 'the asset is gone');
  const events = guildOf(next).events || [];
  const closed = events.find((e) => e.type === 'venture_closed');
  assert.ok(closed, 'a venture_closed event was written');
  assert.equal(closed.payload.cause, 'operator');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('removeAsset on an idle asset just deletes it; an unknown asset reject-wholes', () => {
  const s = founded();
  const idle = 'asset_player-guild_miner_03'; // a starter miner, occupied by nothing
  const before = guildOf(s).assets.length;
  const { next, result } = apply(s, createRemoveAssetAction({ guildId: GUILD, assetId: idle }));
  assert.equal(result.accepted, true);
  assert.equal(guildOf(next).assets.some((a) => a.id === idle), false);
  assert.equal(guildOf(next).assets.length, before - 1);
  assert.deepEqual(checkInvariants(next, next.tick), []);

  const unknown = apply(s, createRemoveAssetAction({ guildId: GUILD, assetId: 'asset_player-guild_miner_99' }));
  assert.equal(unknown.result.accepted, false);
  assert.match(unknown.result.reason, /owns no asset/);
  assert.equal(guildOf(unknown.next).assets.length, before, 'a refused remove touches nothing');
});

// --- removeVenture (§3.6) ----------------------------------------------------

test('removeVenture keep closes the venture and leaves its asset idle', () => {
  const s = withMine();
  const { next, result } = apply(s, createRemoveVentureAction({ guildId: GUILD, ventureId: 'mine_1' })); // default 'keep'
  assert.equal(result.accepted, true);
  assert.equal(guildOf(next).ventures.length, 0, 'the venture is gone');
  assert.equal(guildOf(next).assets.some((a) => a.id === M1), true, 'its machine dropped to idle inventory');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('removeVenture remove closes the venture and deletes its asset', () => {
  const s = withMine();
  const { next, result } = apply(s, createRemoveVentureAction({ guildId: GUILD, ventureId: 'mine_1', asset: 'remove' }));
  assert.equal(result.accepted, true);
  assert.equal(guildOf(next).ventures.length, 0);
  assert.equal(guildOf(next).assets.some((a) => a.id === M1), false, 'the machine is gone too');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('removeVenture on an unknown venture reject-wholes', () => {
  const s = withMine();
  const before = guildOf(s).ventures.length;
  const { next, result } = apply(s, createRemoveVentureAction({ guildId: GUILD, ventureId: 'no_such_venture' }));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /has no venture/);
  assert.equal(guildOf(next).ventures.length, before);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// --- shared: unknown guild, and bad mode strings, reject-whole ---------------

test('every lever refuses an unknown guild', () => {
  const s = founded();
  for (const action of [
    createAdjustCreditsAction({ guildId: 'ghost', delta: 1 }),
    createAdjustFuelAction({ guildId: 'ghost', delta: 1 }),
    createAdjustGoodsAction({ guildId: 'ghost', systemId: HOME_SYSTEM, good: 'titanium', delta: 1 }),
    createGrantAssetAction({ guildId: 'ghost', kind: 'miner', systemId: HOME_SYSTEM }),
    createRemoveAssetAction({ guildId: 'ghost', assetId: M1 }),
    createRemoveVentureAction({ guildId: 'ghost', ventureId: 'mine_1' }),
  ]) {
    const { result } = apply(s, action);
    assert.equal(result.accepted, false, `${action.type} must refuse an unknown guild`);
    assert.match(result.reason, /no guild with id/);
  }
});

test('a bad occupied / asset mode string reject-wholes', () => {
  const s = withMine();
  const badOcc = apply(s, createRemoveAssetAction({ guildId: GUILD, assetId: M1, occupied: 'destroy' }));
  assert.equal(badOcc.result.accepted, false);
  assert.match(badOcc.result.reason, /occupied must be/);

  const badAsset = apply(s, createRemoveVentureAction({ guildId: GUILD, ventureId: 'mine_1', asset: 'vaporise' }));
  assert.equal(badAsset.result.accepted, false);
  assert.match(badAsset.result.reason, /asset must be/);
});
