'use strict';

// syndicate-queue-cancel.test.js — the Syndicate commission QUEUE CAP and CANCELLING a not-started
// commission (docs/asset-purchase.md §"The queue cap" + §"Cancelling a queued commission", both
// RULED 26-09-26; roadmap 2.1d). Engine + snapshot only.
//
// The tripwires, one per ruling:
//   - the constants + the ONE baseline helper: SYNDICATE_QUEUE_MAX is 10 (the dockyard's MAX_QUEUE
//     stays 5), and the price floor and the cancel refund read the SAME assetPurchaseBaseline;
//   - the CAP counts a guild's WHOLE queue (the building head included): the 10th buy is accepted,
//     the 11th refused loudly, blamed on the cap rather than on credits; other guilds don't count;
//   - STABLE ids: a per-guild monotonic `commissionId`, never shifted by an earlier cancel and never
//     reissued;
//   - CANCEL of a not-started entry removes exactly it, refunds the kind's baseline, forfeits the
//     fuel, keeps the survivors' FIFO order, and deletes the key when the queue empties;
//   - an UNDERWAY commission (remainingTicks a number) is refused; only the owner may cancel;
//   - invariants hold across buy → cancel, and credits are conserved (the Syndicate keeps a premium);
//   - the SNAPSHOT rows carry commissionId + cancellable;
//   - a PRE-SLICE entry (no commissionId) is never matched by a cancel and still builds normally;
//   - the no-op / determinism proofs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL, routeFuelCost, ASSET_CARGO_VOLUME } = require('../fuel.js');
const { arrivalTickFor } = require('../transport.js');
const {
  ASSET_BILLS, ASSET_PURCHASE_FLOOR, VEHICLE_BUY_BASELINE, BUILD_TICKS, MAX_QUEUE,
  SYNDICATE_QUEUE_MAX, SYNDICATE_SELLABLE_KINDS, assetPurchaseBaseline, priceAssetForPurchase,
} = require('../asset-recipes.js');
const { LIGHT_TRANSPORT, MEDIUM_TRANSPORT } = require('../vehicles.js');
const { MINER, FACTORY } = require('../assets.js');
const {
  validateAction, applyAction, createBuyAssetFromSyndicateAction,
  createCancelSyndicateCommissionAction,
} = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

// The same fixture shape asset-purchase.test.js uses: a real starter home at a small waystation
// distance, so every delivery leg is cheap and a full tick-by-tick run stays short.
const HOME = starterHomeAtDistance(6);
const DEST = HOME.id;
const DEST_DISTANCE = HOME.distance;

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// One or more guilds homed on DEST, ledger-funded so invariant 2 starts balanced. 200M credits is
// room for eleven 12M miners (the cap test) plus change; the starter fuel covers eleven ~5-unit burns.
function queueState({ guildIds = ['g1'], credits = 200_000_000, syndicateBuilds } = {}) {
  return createState({
    guilds: guildIds.map((id) => ({
      id, credits, fuelHoard: GUILD_STARTING_FUEL, homeSystemId: DEST, homePlanetId: HOME.homePlanet,
    })),
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits * guildIds.length },
    claims: guildIds.map((id) => homeClaim(id, DEST)),
    ...(syndicateBuilds === undefined ? {} : { syndicateBuilds }),
  });
}

const buy = (assetKind, guildId = 'g1') =>
  createBuyAssetFromSyndicateAction({ guildId, assetKind, destinationSystemId: DEST });
const cancel = (commissionId, guildId = 'g1') =>
  createCancelSyndicateCommissionAction({ guildId, commissionId });

// accept = the POST /action path in-process: validate, apply, then every invariant with NO tick
// between (server.js applyOneAction asserts exactly this), so a cache the apply forgot to refresh
// fails here, not in play.
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  const next = applyAction(state, action);
  assert.deepEqual(checkInvariants(next, next.tick), [], `invariants after ${action.type}`);
  return next;
};
const reject = (state, action, match) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, `expected a rejection of ${JSON.stringify(action)}`);
  assert.match(reason, match);
  return reason;
};
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

const g = (state, id = 'g1') => state.guilds.find((x) => x.id === id);
const mine = (state, id = 'g1') => (state.syndicateBuilds || []).filter((b) => b.ownerGuildId === id);
const ids = (state, id = 'g1') => mine(state, id).map((b) => b.commissionId);
// Guild credits + the Syndicate ledger — the pair invariant 2 conserves on every buy and cancel.
const creditTotal = (state) => state.guilds.reduce((sum, x) => sum + x.credits, 0) + state.syndicate.ledger;

// --- 1. the constants + the one baseline --------------------------------------

test('constants: SYNDICATE_QUEUE_MAX is the ruled 10, and the dockyard\'s MAX_QUEUE stays 5', () => {
  // Pinned against docs/phase-1-tuning.md: a silent retune of either fails here.
  assert.equal(SYNDICATE_QUEUE_MAX, 10);
  assert.equal(MAX_QUEUE, 5, 'the dockyard cap is a separate, per-yard number — untouched');
});

test('assetPurchaseBaseline: the per-class transport baseline, else the flat 12M floor — and the price never goes below it', () => {
  assert.equal(assetPurchaseBaseline(MINER), ASSET_PURCHASE_FLOOR);
  assert.equal(assetPurchaseBaseline(FACTORY), ASSET_PURCHASE_FLOOR);
  for (const kind of Object.keys(VEHICLE_BUY_BASELINE)) {
    assert.equal(assetPurchaseBaseline(kind), VEHICLE_BUY_BASELINE[kind], `${kind} baseline`);
  }
  // At today's parts scale the baseline binds for every sellable kind, so the price IS the baseline —
  // which is exactly why a cancel refund at the baseline makes the guild whole on credits today.
  const s = queueState();
  for (const kind of SYNDICATE_SELLABLE_KINDS) {
    assert.equal(priceAssetForPurchase(s, kind, s.tick), assetPurchaseBaseline(kind), `${kind}: the floor binds`);
  }
});

// --- 2. the queue cap ---------------------------------------------------------

test('cap: with 1 building + 9 queued the 10th buy was accepted, and an 11th is refused loudly — the building head counts', () => {
  let s = queueState();
  s = accept(s, buy(MINER));
  s = tick(s); // the head STARTS (remainingTicks null → BUILD_TICKS): it is now building, not queued
  assert.equal(mine(s)[0].remainingTicks, BUILD_TICKS[MINER], 'the head is building');

  for (let i = 2; i <= SYNDICATE_QUEUE_MAX; i += 1) s = accept(s, buy(MINER)); // the 2nd … the 10th
  assert.equal(mine(s).length, SYNDICATE_QUEUE_MAX, '10 pending: 1 building + 9 queued');
  assert.equal(mine(s).filter((b) => b.remainingTicks === null).length, 9, '9 of them waiting');

  // The 11th: refused, naming the count and the cap.
  reject(s, buy(MINER), /Syndicate commission queue is full \(10\/10\)/);
  // A transport buy counts against the SAME per-guild queue (one unified list).
  reject(s, buy(LIGHT_TRANSPORT), /queue is full \(10\/10\)/);
});

test('cap: a full queue is blamed on the CAP, not on credits — the structural gate runs first', () => {
  let s = queueState();
  for (let i = 1; i <= SYNDICATE_QUEUE_MAX; i += 1) s = accept(s, buy(MINER));
  s.guilds[0].credits = 0; // now ALSO unable to pay (a hand-set state; only validate reads it)
  reject(s, buy(MINER), /queue is full/);
});

test('cap: it is PER GUILD — a rival\'s full queue never blocks yours', () => {
  let s = queueState({ guildIds: ['g1', 'g2'] });
  for (let i = 1; i <= SYNDICATE_QUEUE_MAX; i += 1) s = accept(s, buy(MINER, 'g2'));
  reject(s, buy(MINER, 'g2'), /queue is full \(10\/10\)/);
  s = accept(s, buy(MINER, 'g1')); // g1's own queue is empty — g2's ten do not count against it
  assert.equal(mine(s, 'g1').length, 1);
});

test('cap: cancelling one commission frees a place — the next buy is accepted again', () => {
  let s = queueState();
  for (let i = 1; i <= SYNDICATE_QUEUE_MAX; i += 1) s = accept(s, buy(MINER));
  reject(s, buy(MINER), /queue is full/);
  s = accept(s, cancel(5));
  s = accept(s, buy(MINER));
  assert.equal(mine(s).length, SYNDICATE_QUEUE_MAX);
});

// --- 3. stable ids --------------------------------------------------------------

test('stable id: commissionIds are unique per guild, start at 1, and are recorded on the guild\'s counter', () => {
  let s = queueState({ guildIds: ['g1', 'g2'] });
  s = accept(s, buy(MINER, 'g1'));
  s = accept(s, buy(FACTORY, 'g2'));
  s = accept(s, buy(MINER, 'g1'));
  s = accept(s, buy(MINER, 'g2'));
  assert.deepEqual(ids(s, 'g1'), [1, 2]);
  assert.deepEqual(ids(s, 'g2'), [1, 2], 'each guild counts its OWN commissions — ids are per guild');
  assert.equal(g(s, 'g1').syndicateCommissionSerial, 2);
  assert.equal(g(s, 'g2').syndicateCommissionSerial, 2);
});

test('stable id: cancelling the head-adjacent entry does NOT shift a later entry\'s id, and a spent id is never reissued', () => {
  let s = queueState();
  s = accept(s, buy(MINER));           // id 1 — becomes the building head
  s = accept(s, buy(FACTORY));         // id 2 — head-adjacent
  s = accept(s, buy(LIGHT_TRANSPORT)); // id 3
  s = accept(s, buy(MINER));           // id 4
  s = tick(s); // id 1 starts building
  const laterBefore = { ...mine(s).find((b) => b.commissionId === 4) };

  s = accept(s, cancel(2));
  assert.deepEqual(ids(s), [1, 3, 4], 'only id 2 left; the others kept their ids');
  assert.deepEqual(mine(s).find((b) => b.commissionId === 4), laterBefore, 'id 4 is the SAME entry, byte-for-byte');

  // The next commission is 5 — never the freed 2 (the counter only climbs).
  s = accept(s, buy(FACTORY));
  assert.deepEqual(ids(s), [1, 3, 4, 5]);
  assert.equal(g(s).syndicateCommissionSerial, 5);
  // And a cancel addressed to the spent id 2 now finds nothing.
  reject(s, cancel(2), /has no Syndicate commission with id 2/);
});

// --- 4. cancel a not-started entry ---------------------------------------------

test('cancel: removes exactly that entry, refunds the kind\'s baseline, forfeits the fuel, keeps FIFO order', () => {
  let s = queueState();
  s = accept(s, buy(MINER));           // id 1
  s = accept(s, buy(LIGHT_TRANSPORT)); // id 2 — the one we cancel (a transport: a per-class baseline)
  s = accept(s, buy(FACTORY));         // id 3
  s = accept(s, buy(MINER));           // id 4
  s = tick(s); // the head (id 1) starts

  const credits0 = g(s).credits;
  const ledger0 = s.syndicate.ledger;
  const fuel0 = g(s).fuelHoard;
  const contraband0 = g(s).deuteriumFuel || 0;
  const consumed0 = s.audit.totalConsumed;
  const produced0 = s.audit.totalProduced;
  const survivors0 = mine(s).filter((b) => b.commissionId !== 2);

  s = accept(s, cancel(2));

  assert.deepEqual(mine(s), survivors0, 'exactly id 2 left; the survivors are untouched and in the SAME order');
  assert.deepEqual(mine(s).map((b) => b.assetKind), [MINER, FACTORY, MINER]);
  // Credits: the baseline, guild ↔ ledger, one integer both legs.
  const refund = VEHICLE_BUY_BASELINE[LIGHT_TRANSPORT];
  assert.equal(assetPurchaseBaseline(LIGHT_TRANSPORT), refund);
  assert.equal(g(s).credits, credits0 + refund);
  assert.equal(s.syndicate.ledger, ledger0 - refund);
  // Fuel: FORFEIT — no hoard, contraband or audit counter moves on a cancel.
  assert.equal(g(s).fuelHoard, fuel0);
  assert.equal(g(s).deuteriumFuel || 0, contraband0);
  assert.equal(s.audit.totalConsumed, consumed0);
  assert.equal(s.audit.totalProduced, produced0);
});

test('cancel: the not-started HEAD (bought, no tick yet) is cancellable, and the last cancel deletes the key (omit-when-empty)', () => {
  let s = queueState();
  s = accept(s, buy(MINER));
  assert.equal(mine(s)[0].remainingTicks, null, 'the head has not begun its countdown');
  s = accept(s, cancel(1));
  assert.equal(s.syndicateBuilds, undefined, 'the emptied queue carries NO key');
  assert.ok(!canonicalStringify(s).includes('syndicateBuilds'), 'and serializes no such field');
  // The counter STAYS — it remembers which numbers are spent (the savedRouteSerial discipline).
  assert.equal(g(s).syndicateCommissionSerial, 1);
});

test('cancel: cancelling the queued entry behind a not-started head leaves that head to start normally', () => {
  let s = queueState();
  s = accept(s, buy(MINER));   // id 1, not started
  s = accept(s, buy(FACTORY)); // id 2
  s = accept(s, cancel(1));    // the head goes — id 2 is now the head
  s = tick(s);
  assert.deepEqual(ids(s), [2]);
  assert.equal(mine(s)[0].remainingTicks, BUILD_TICKS[FACTORY], 'the new head starts on the next tick');
});

// --- 5. refusals ---------------------------------------------------------------

test('underway refused: a BUILDING head (remainingTicks > 0) cannot be cancelled — nor one finished and waiting to ship (0)', () => {
  let s = queueState();
  s = accept(s, buy(MINER));
  s = tick(s);
  assert.ok(mine(s)[0].remainingTicks > 0);
  reject(s, cancel(1), /a commission already under construction cannot be cancelled/);

  // A head that has counted to 0 but not yet shipped is still underway, not "not started".
  const done = queueState({
    syndicateBuilds: [{ ownerGuildId: 'g1', commissionId: 1, assetKind: MINER, destinationSystemId: DEST, remainingTicks: 0, boughtTick: 0 }],
  });
  reject(done, cancel(1), /already under construction/);
});

test('refusals: an unknown guild, a malformed id, an id this guild does not have, and ANOTHER guild\'s commission', () => {
  let s = queueState({ guildIds: ['g1', 'g2'] });
  s = accept(s, buy(MINER, 'g1')); // g1 #1
  s = accept(s, buy(MINER, 'g1')); // g1 #2
  s = accept(s, buy(MINER, 'g2')); // g2 #1

  reject(s, cancel(1, 'nobody'), /no guild with id "nobody"/);
  for (const bad of [0, -1, 1.5, '1', null, undefined]) {
    reject(s, { type: 'cancelSyndicateCommission', guildId: 'g1', commissionId: bad }, /commissionId must be a positive integer/);
  }
  reject(s, cancel(7), /guild g1 has no Syndicate commission with id 7/);
  // Only the OWNER may cancel: g2 has no #2 (that is g1's), and g2 cancelling its #1 leaves g1's #1 alone.
  reject(s, cancel(2, 'g2'), /guild g2 has no Syndicate commission with id 2/);
  s = accept(s, cancel(1, 'g2'));
  assert.deepEqual(ids(s, 'g1'), [1, 2], 'g1\'s queue is untouched by g2\'s cancel');
  assert.deepEqual(ids(s, 'g2'), []);
});

test('createCancelSyndicateCommissionAction: the exact shape, and a loud throw on a missing field', () => {
  assert.deepEqual(cancel(3), { type: 'cancelSyndicateCommission', guildId: 'g1', commissionId: 3 });
  assert.throws(() => createCancelSyndicateCommissionAction({ commissionId: 1 }), /guildId is required/);
  assert.throws(() => createCancelSyndicateCommissionAction({ guildId: 'g1' }), /commissionId is required/);
});

// --- 6. invariants + conservation across buy → cancel -------------------------

test('invariants: across buy → cancel every invariant holds, credits are conserved, and with the floor binding the guild is made whole on credits', () => {
  const s0 = queueState();
  const credits0 = g(s0).credits;
  const fuel0 = g(s0).fuelHoard;
  const total0 = creditTotal(s0);
  const burn = routeFuelCost(DEST, ASSET_CARGO_VOLUME).fuelBurn;
  assert.equal(priceAssetForPurchase(s0, MINER, s0.tick), assetPurchaseBaseline(MINER), 'the floor binds');

  const s1 = accept(s0, buy(MINER));
  assert.equal(creditTotal(s1), total0, 'the buy moves credits guild → ledger, total unchanged');
  const s2 = accept(s1, cancel(1)); // accept() also asserts checkInvariants after each apply
  assert.equal(creditTotal(s2), total0, 'the cancel moves them back, total unchanged');
  assert.equal(g(s2).credits, credits0, 'price == baseline, so the refund returns every credit paid');
  assert.equal(g(s2).fuelHoard, fuel0 - burn, 'but the delivery fuel stays burned (forfeit)');
  assert.equal(s2.audit.totalConsumed, s0.audit.totalConsumed + burn);

  // A vehicle flies itself in (its OWN per-hex burn, not the hauler's): forfeit the same way — the
  // cancel returns every credit and moves no fuel, so the hoard stays where the buy left it.
  const t1 = accept(s0, buy(MEDIUM_TRANSPORT));
  assert.ok(g(t1).fuelHoard < fuel0, 'the buy burned the flight');
  const t2 = accept(t1, cancel(1));
  assert.equal(g(t2).credits, credits0);
  assert.equal(g(t2).fuelHoard, g(t1).fuelHoard, 'the cancel returns no fuel');
  assert.equal(t2.audit.totalConsumed, t1.audit.totalConsumed);
  // And the galaxy keeps ticking clean after the cancel.
  const later = ticks(s2, 3);
  assert.deepEqual(checkInvariants(later, later.tick), []);
});

test('premium: when the parts branch lifts the price ABOVE the baseline, the cancel refunds only the baseline — the Syndicate keeps the premium', () => {
  // The parts branch is out of reach under today's per-tier price bands (even at the Tier-3 ceiling
  // a miner's parts price to well under the 12M floor), so this HAND-SETS every miner module above
  // its band to force it — the asset-purchase.test.js price-branch technique. A price over its
  // ceiling trips the price-sanity invariant, so the buy is applied without the invariant assert
  // and the real prices are put back before the cancel (which `accept` then checks in full).
  const s0 = queueState();
  const realPosted = {};
  for (const module of Object.keys(ASSET_BILLS[MINER])) {
    realPosted[module] = s0.prices[module].posted;
    s0.prices[module].posted = 2_000_000;
  }
  const price = priceAssetForPurchase(s0, MINER, s0.tick);
  const baseline = assetPurchaseBaseline(MINER);
  assert.ok(price > baseline, `the parts branch governs (price ${price} > baseline ${baseline})`);

  const total0 = creditTotal(s0);
  assert.equal(validateAction(s0, buy(MINER)).valid, true);
  const s1 = applyAction(s0, buy(MINER));
  assert.equal(g(s1).credits, g(s0).credits - price, 'the buy charged the full premium price');
  for (const [module, posted] of Object.entries(realPosted)) s1.prices[module].posted = posted;
  const s2 = accept(s1, cancel(1));
  assert.equal(g(s2).credits, g(s0).credits - (price - baseline), 'the guild is out exactly the premium');
  assert.equal(s2.syndicate.ledger, s0.syndicate.ledger + (price - baseline), 'which the ledger keeps');
  assert.equal(creditTotal(s2), total0, 'no credit created or destroyed');
});

// --- 7. the snapshot -----------------------------------------------------------

test('snapshot: every row carries commissionId + cancellable — true only for a not-started entry', () => {
  let s = queueState();
  s = accept(s, buy(MINER));
  s = accept(s, buy(FACTORY));
  // Before any tick: the head has not started, so BOTH are cancellable.
  let rows = buildSnapshot(s).syndicateBuilds;
  assert.deepEqual(rows.map((r) => [r.commissionId, r.cancellable]), [[1, true], [2, true]]);

  s = tick(s); // the head starts building
  rows = buildSnapshot(s).syndicateBuilds;
  assert.deepEqual(rows.map((r) => r.commissionId), [1, 2]);
  assert.deepEqual(rows.map((r) => r.building), [true, false]);
  assert.deepEqual(rows.map((r) => r.cancellable), [false, true], 'the building head is not cancellable');
  // The flag agrees with the engine: every cancellable row validates, every other one is refused.
  for (const r of rows) {
    assert.equal(validateAction(s, cancel(r.commissionId)).valid, r.cancellable, `row ${r.commissionId}`);
  }
});

test('snapshot: the new fields are DERIVED-on-read — building the snapshot moves no serialized byte', () => {
  const s = accept(queueState(), buy(MINER));
  const before = canonicalStringify(s);
  buildSnapshot(s);
  assert.equal(canonicalStringify(s), before);
  assert.ok(!before.includes('cancellable'), '`cancellable` is never stored');
});

// --- 8. an entry that predates this slice (no commissionId) --------------------

test('migration: a pre-slice entry (no commissionId) is never matched by a cancel, shows not-cancellable, and still builds and ships', () => {
  const legacy = { ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 };
  let s = queueState({ syndicateBuilds: [legacy] });

  // No cancel can reach it: a missing / undefined id is refused before the lookup, and a real id
  // finds no entry (the old one has none to match).
  reject(s, { type: 'cancelSyndicateCommission', guildId: 'g1' }, /commissionId must be a positive integer/);
  reject(s, { type: 'cancelSyndicateCommission', guildId: 'g1', commissionId: undefined }, /positive integer/);
  reject(s, cancel(1), /has no Syndicate commission with id 1/);

  // The snapshot marks it not-cancellable, with a null id rather than a made-up one.
  const [row] = buildSnapshot(s).syndicateBuilds;
  assert.equal(row.commissionId, null);
  assert.equal(row.cancellable, false);

  // A NEW commission behind it gets id 1 (the guild's counter was absent) — no clash, since the old
  // entry has no id — and only the new one is cancellable.
  s = accept(s, buy(FACTORY));
  assert.deepEqual(mine(s).map((b) => b.commissionId), [undefined, 1]);
  assert.deepEqual(buildSnapshot(s).syndicateBuilds.map((r) => r.cancellable), [false, true]);

  // The old entry still builds, ships and mints normally — nothing throws.
  s = ticks(s, 1 + BUILD_TICKS[MINER] + arrivalTickFor(0, DEST_DISTANCE) + 2);
  assert.equal((g(s).assets || []).filter((a) => a.kind === MINER).length, 1, 'the pre-slice miner was delivered');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 9. the no-op / determinism proofs ------------------------------------------

test('no-op: a galaxy that never commissions carries no counter, no id, and no queue key', () => {
  const s = ticks(queueState(), 20);
  const bytes = canonicalStringify(s);
  assert.ok(!bytes.includes('syndicateCommissionSerial'), 'no counter written');
  assert.ok(!bytes.includes('commissionId'), 'no id written');
  assert.ok(!bytes.includes('syndicateBuilds'), 'no queue key');
  assert.equal('syndicateCommissionSerial' in g(s), false);
});

test('no-op: createGuild omits a zero counter and carries a non-zero one (a restored save keeps its spent ids)', () => {
  const fresh = queueState();
  assert.equal('syndicateCommissionSerial' in g(fresh), false);
  const restored = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, syndicateCommissionSerial: 7 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.equal(g(restored).syndicateCommissionSerial, 7);
});

test('save → load: the counter and ids survive a reload, and the reloaded galaxy never reissues a spent id', () => {
  let s = queueState();
  s = accept(s, buy(MINER));
  s = accept(s, buy(FACTORY));
  s = accept(s, cancel(2));
  const reloaded = JSON.parse(canonicalStringify(s)); // the persist path reloads verbatim
  assert.equal(hashState(reloaded), hashState(s));
  const after = accept(reloaded, buy(MINER));
  assert.deepEqual(ids(after), [1, 3], 'id 2 stays spent across the reload');
});

test('determinism: a buy → tick → cancel → buy run is byte-identical across two runs (invariant 9)', () => {
  const run = () => {
    let s = queueState({ guildIds: ['g1', 'g2'] });
    s = accept(s, buy(MINER, 'g1'));
    s = accept(s, buy(LIGHT_TRANSPORT, 'g1'));
    s = accept(s, buy(FACTORY, 'g2'));
    s = accept(s, buy(MINER, 'g1'));
    s = ticks(s, 5);
    s = accept(s, cancel(2, 'g1'));
    s = accept(s, buy(FACTORY, 'g1'));
    return ticks(s, BUILD_TICKS[MINER] + 20);
  };
  assert.equal(hashState(run()), hashState(run()));
});
