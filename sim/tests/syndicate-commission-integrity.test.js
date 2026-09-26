'use strict';

// syndicate-commission-integrity.test.js — the tripwire on the Syndicate commission's stable id
// (docs/asset-purchase.md §"Cancelling a queued commission"; roadmap 2.1d, the cancel CLIENT slice).
// `checkSyndicateBuildsIntegrity` (sim/invariants.js) asserts, per guild, over the
// `state.syndicateBuilds` entries it owns:
//   - an entry that HAS a `commissionId` carries a positive integer, unique within the guild;
//   - `guild.syndicateCommissionSerial` (absent ⇒ 0) is a non-negative integer ≥ the highest live id
//     — the vehicleSerial / savedRouteSerial monotonic-counter assert;
//   - an entry with NO id (bought before ids were stamped) is legal and never trips it.
// Every state below is BUILT through the real buy / tick / cancel path and then, where a test needs
// a fault, corrupted by hand — so a clean pass proves the guard is a no-op on real state, and a
// fault proves it fails loudly.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants, assertInvariants } = require('../invariants.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { BUILD_TICKS } = require('../asset-recipes.js');
const { LIGHT_TRANSPORT } = require('../vehicles.js');
const { MINER, FACTORY } = require('../assets.js');
const {
  validateAction, applyAction, createBuyAssetFromSyndicateAction,
  createCancelSyndicateCommissionAction,
} = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

// The syndicate-queue-cancel.test.js fixture: guilds homed on a real starter a short waystation hop
// away, ledger-funded so invariant 2 starts balanced.
const HOME = starterHomeAtDistance(6);
const DEST = HOME.id;

function queueState({ guildIds = ['g1'], credits = 200_000_000, syndicateBuilds } = {}) {
  return createState({
    guilds: guildIds.map((id) => ({
      id, credits, fuelHoard: GUILD_STARTING_FUEL, homeSystemId: DEST, homePlanetId: HOME.homePlanet,
    })),
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits * guildIds.length },
    claims: guildIds.map((id) => ({
      claimId: `claim_home_${id}`, ownerGuildId: id, landmarkId: DEST, landmarkKind: 'system',
      claimedAtTick: 0, contested: false,
    })),
    ...(syndicateBuilds === undefined ? {} : { syndicateBuilds }),
  });
}

const buy = (assetKind, guildId = 'g1') =>
  createBuyAssetFromSyndicateAction({ guildId, assetKind, destinationSystemId: DEST });
const cancel = (commissionId, guildId = 'g1') =>
  createCancelSyndicateCommissionAction({ guildId, commissionId });
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};

const g = (state, id = 'g1') => state.guilds.find((x) => x.id === id);
// Only this guard's findings, so an unrelated rule can never mask (or fake) a result here.
const syndicateFindings = (state) =>
  checkInvariants(state, state.tick).filter((v) => v.rule.startsWith('syndicate-commission'));
const rules = (state) => syndicateFindings(state).map((v) => v.rule);

// Tick until every commission has left the queue, asserting every invariant on every tick (throws
// with the tick number on any violation). Bounded by the whole queue's build time, so a queue that
// never drains fails here instead of looping forever.
function tickUntilShipped(state) {
  let s = state;
  const limit = s.syndicateBuilds.reduce((sum, b) => sum + BUILD_TICKS[b.assetKind] + 1, 0);
  for (let i = 0; s.syndicateBuilds && i < limit; i += 1) {
    s = tick(s);
    assertInvariants(s, s.tick);
  }
  return s;
}

// g1 holds ids 1, 2, 3 (the head building after one tick); g2 holds its own 1.
function builtQueue() {
  let s = queueState({ guildIds: ['g1', 'g2'] });
  s = accept(s, buy(MINER, 'g1'));
  s = accept(s, buy(FACTORY, 'g1'));
  s = accept(s, buy(MINER, 'g2'));
  s = accept(s, buy(LIGHT_TRANSPORT, 'g1'));
  return tick(s);
}

// --- the no-op on real state ----------------------------------------------------

test('a normal built queue passes — two guilds, overlapping per-guild ids, a building head, a cancel', () => {
  let s = builtQueue();
  assert.deepEqual(s.syndicateBuilds.map((b) => [b.ownerGuildId, b.commissionId]),
    [['g1', 1], ['g1', 2], ['g2', 1], ['g1', 3]], 'g1 and g2 each hold an id 1 — ids are per guild, no clash');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  s = accept(s, cancel(2)); // a gap in g1's ids (1, 3) is legal — only a repeat or a counter below one is not
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = accept(s, buy(MINER)); // id 4: the counter kept climbing past the spent 2
  assert.equal(g(s).syndicateCommissionSerial, 4);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the guard stays silent through a whole build-and-ship run (every tick asserted)', () => {
  let s = builtQueue();
  s = tickUntilShipped(s);
  assert.equal(s.syndicateBuilds, undefined, 'every commission shipped — the queue key is gone');
  assert.equal(g(s).syndicateCommissionSerial, 3, 'the counter outlives the queue');
});

// --- the faults -----------------------------------------------------------------

test('two of a guild\'s entries sharing a commissionId fail loudly, naming the entry', () => {
  const s = builtQueue();
  s.syndicateBuilds[1].commissionId = 1; // g1's #2 now also claims id 1
  const found = syndicateFindings(s);
  assert.deepEqual(found.map((v) => v.rule), ['syndicate-commissionId-unique (asset-purchase.md)']);
  assert.equal(found[0].where, 'syndicateBuilds[1].commissionId');
  assert.deepEqual(found[0].detail, { ownerGuildId: 'g1', commissionId: 1 });
  assert.throws(() => assertInvariants(s, s.tick), /Invariant violation at tick 1[\s\S]*syndicate-commissionId-unique/);
});

test('a syndicateCommissionSerial below a live id fails loudly — and an ABSENT counter reads as 0', () => {
  const s = builtQueue();
  g(s).syndicateCommissionSerial = 2; // g1 still holds id 3
  const found = syndicateFindings(s);
  assert.deepEqual(found.map((v) => v.rule), ['syndicate-commission-serial-monotonic']);
  assert.equal(found[0].where, 'guild:g1.syndicateCommissionSerial');
  assert.deepEqual(found[0].detail, { syndicateCommissionSerial: 2, highestLiveCommissionId: 3 });

  const absent = builtQueue();
  delete g(absent, 'g2').syndicateCommissionSerial; // g2 holds id 1 with no counter at all
  assert.deepEqual(syndicateFindings(absent).map((v) => [v.rule, v.detail]),
    [['syndicate-commission-serial-monotonic', { syndicateCommissionSerial: 0, highestLiveCommissionId: 1 }]]);
});

test('a commissionId that is not a positive integer fails loudly', () => {
  for (const bad of [0, -1, 1.5, '1', NaN]) {
    const s = builtQueue();
    s.syndicateBuilds[3].commissionId = bad;
    assert.deepEqual(rules(s), ['syndicate-commissionId-positive-int (asset-purchase.md)'], `id ${String(bad)}`);
  }
});

test('a counter that is not a non-negative integer fails loudly (it would make the ≥ check silently false)', () => {
  for (const bad of [-1, 2.5, '3', NaN, null]) {
    const s = builtQueue();
    g(s).syndicateCommissionSerial = bad;
    // `null` reads as absent (0) — legal as a counter, but g1 holds id 3, so it is the monotonic fault.
    const expected = bad === null
      ? ['syndicate-commission-serial-monotonic']
      : ['syndicate-commission-serial-non-negative-int'];
    assert.deepEqual(rules(s), expected, `serial ${String(bad)}`);
  }
});

// --- the migration case -----------------------------------------------------------

test('migration: an entry with no commissionId (a pre-slice buy) never trips the guard — absent or null', () => {
  const legacy = { ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 };
  // No id and no counter on the guild: the exact shape a save from before the id slice reloads as.
  let s = queueState({ syndicateBuilds: [legacy, { ...legacy, assetKind: FACTORY, commissionId: null }] });
  assert.equal('syndicateCommissionSerial' in g(s), false);
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // A fresh buy behind them takes id 1 alongside the id-less entries — still clean.
  s = accept(s, buy(MINER));
  assert.deepEqual(s.syndicateBuilds.map((b) => b.commissionId), [undefined, null, 1]);
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // And the legacy entries build and ship with every tick asserted.
  s = tickUntilShipped(s);
  assert.equal(s.syndicateBuilds, undefined);
});
