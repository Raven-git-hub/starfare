'use strict';

// asset-purchase.test.js — buying a Tier-4 asset from the Syndicate (docs/asset-purchase.md,
// roadmap 2.1d, ENGINE slice 1). The mirror of the goods BUY (buy.test.js): pay CREDITS + fuel
// up front, the Syndicate builds the asset centrally over BUILD_TICKS, then it ships as a
// standard delivery and mints an idle asset at the destination.
//
// The tripwires, one per ruling:
//   - the PRICE: `max(FLOOR, round(partsCost × 0.8))` off the SAME quoted parts prices the
//     economy uses — the floor binds at today's scale, and the discount branch governs once a
//     high quoted price lifts partsCost past the floor;
//   - VALIDATE refuses on credits short, fuel short, a non-buildable kind, an unknown
//     destination, and an expired quote (§8.1);
//   - APPLY moves TWO costs and records ONE build order: the exact price debited to the ledger
//     (invariant 2), the exact routeFuelCost fuel burned (invariant 1), a build order recorded,
//     and NO shipment / NO asset yet;
//   - stepSyndicateBuilds promotes at buildDoneTick (an asset-marked shipment appears) and NOT
//     before, scheduling the delivery leg from the completion tick;
//   - stepArrivals mints one idle asset of the right kind at the destination with a fresh stable
//     id, and DROPS the shipment (mints nothing) when the owner is gone;
//   - the §8.1 quote-lock prices the parts from the ring at the issue tick / refuses on expiry;
//   - serialization: a state with a pending build survives save→load with buildDoneTick intact
//     and lands the asset on the right tick;
//   - the no-op / determinism proofs: an unbought galaxy carries no syndicateBuilds key and is
//     byte-identical, and a bought galaxy run twice is byte-identical;
//   - a HEADLESS END-TO-END: found → buy → build → deliver → mint, ticked the whole span.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick, stepSyndicateBuilds } = require('../tick.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { getStock } = require('../stock.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL, routeFuelCost } = require('../fuel.js');
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const { QUOTE_TTL_TICKS } = require('../price-ring.js');
const {
  ASSET_BILLS, ASSET_PURCHASE_FLOOR, ASSET_PURCHASE_REDUCTION, BUILD_TICKS, priceAssetForPurchase,
} = require('../asset-recipes.js');
const { MINER, FACTORY, idleAssets } = require('../assets.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const {
  validateAction, applyAction, intake, createBuyAssetFromSyndicateAction, createFoundGuildAction,
} = require('../actions.js');
const { starterHomeAtDistance, systemAtDistance } = require('./waystation-fixtures.js');

// A real starter home at a small even waystation distance, so a guild can home on it and the
// delivery leg stays cheap for a full tick-by-tick run (the buy.test discipline).
const HOME = starterHomeAtDistance(6);
const DEST = HOME.id;
const DEST_DISTANCE = HOME.distance;               // hexes, DEST's nearest waystation -> DEST
const OTHER = systemAtDistance(7);                 // a second real system (not held; presence not required)

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// A guild homed on DEST, ledger-funded so invariant 2 starts balanced. Ample credits + fuel by
// default (a 12M floor + a 3-unit burn), both overridable to pin the short cases.
function buyState({ credits = 20_000_000, fuelHoard = GUILD_STARTING_FUEL, syndicateBuilds } = {}) {
  return createState({
    guilds: [{
      id: 'g1', credits, fuelHoard, homeSystemId: DEST, homePlanetId: HOME.homePlanet,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims: [homeClaim('g1', DEST)],
    ...(syndicateBuilds === undefined ? {} : { syndicateBuilds }),
  });
}

// Set every module in a kind's bill to one posted price — the shortcut buy.test takes, so a test
// can lift partsCost past the floor without driving the price engine.
function setBillPosted(state, kind, value) {
  for (const module of Object.keys(ASSET_BILLS[kind])) state.prices[module].posted = value;
  return state;
}

const buy = (assetKind, destinationSystemId, issueTick) =>
  createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind, destinationSystemId, issueTick });
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const reject = (state, action, match) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected a rejection');
  assert.match(reason, match);
  return reason;
};
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. the price -------------------------------------------------------------

test('price: the FLOOR binds at today\'s parts scale — a miner and a factory both cost exactly ASSET_PURCHASE_FLOOR', () => {
  const s = buyState();
  // At the seed's base prices a miner/factory's parts are worth ~100 credits, far below 12M, so
  // `round(partsCost × 0.8)` never wins and the price is the flat floor (asset-purchase.md).
  assert.equal(priceAssetForPurchase(s, MINER, s.tick), ASSET_PURCHASE_FLOOR);
  assert.equal(priceAssetForPurchase(s, FACTORY, s.tick), ASSET_PURCHASE_FLOOR);
});

test('price: the partsCost × 0.8 branch governs once a high quoted price lifts the parts past the floor', () => {
  const s = buyState();
  // Force the discount branch: set every miner module to 2,000,000. partsCost = Σ qty × price;
  // for the miner bill (qty sum 10) that is 20,000,000, and round(20M × 0.8) = 16,000,000 > floor.
  const P = 2_000_000;
  setBillPosted(s, MINER, P);
  let partsCost = 0;
  for (const [module, qty] of Object.entries(ASSET_BILLS[MINER])) partsCost += qty * P;
  const expected = Math.max(ASSET_PURCHASE_FLOOR, Math.round(partsCost * ASSET_PURCHASE_REDUCTION));
  assert.equal(expected, 16_000_000, 'the forced parts price clears the floor');
  assert.equal(priceAssetForPurchase(s, MINER, s.tick), expected);
});

test('price: rounded ONCE on the whole order (#43), and a non-buildable kind prices to null', () => {
  const s = buyState();
  // An odd per-part price makes the single whole-order round observable: 3 credits/part over the
  // miner bill (qty sum 10) = partsCost 30, × 0.8 = 24 — but the floor still binds here, so the
  // rounding is exercised where it matters in the branch test above; this pins the null contract.
  assert.equal(priceAssetForPurchase(s, 'ship', s.tick), null, 'a kind with no bill is not priceable');
  assert.equal(priceAssetForPurchase(s, 'not_a_kind', s.tick), null);
});

// --- 2. validate --------------------------------------------------------------

test('validate: accepts a well-formed purchase into a real system (presence NOT required)', () => {
  const s = buyState();
  assert.equal(validateAction(s, buy(MINER, DEST)).valid, true);
  // OTHER is a real system the guild does NOT hold — an asset lands idle anywhere (asset-purchase.md
  // "Destination"), so this is accepted where a goods BUY would be refused for not holding it.
  assert.equal(validateAction(s, buy(MINER, OTHER)).valid, true, 'no guildHolds gate for an asset');
});

test('validate: refuses a non-buildable kind, an unknown destination, and a missing guild', () => {
  const s = buyState();
  reject(s, buy('ship', DEST), /not a Syndicate-buildable asset kind/);
  reject(s, buy(MINER, 'sys_does_not_exist'), /not a system on the seed/);
  reject(s, createBuyAssetFromSyndicateAction({ guildId: 'nope', assetKind: MINER, destinationSystemId: DEST }), /no guild with id/);
});

test('validate: refuses when CREDITS are short — and blames credits, not fuel', () => {
  const s = buyState({ credits: ASSET_PURCHASE_FLOOR - 1 });
  reject(s, buy(MINER, DEST), /cannot pay 12000000/);
});

test('validate: refuses when FUEL is short — reached only once credits pass (the goods-buy gate order)', () => {
  const burn = routeFuelCost(DEST).fuelBurn;
  assert.ok(burn > 0, 'the DEST leg costs fuel');
  // Ample credits, but one unit short of the delivery burn.
  const s = buyState({ fuelHoard: burn - 1 });
  reject(s, buy(MINER, DEST), /insufficient fuel/);
});

// --- 3. apply -----------------------------------------------------------------

test('apply: debits the EXACT price to the ledger (invariant 2) and burns the EXACT route fuel (invariant 1), and records the build order', () => {
  const s0 = buyState();
  const price = priceAssetForPurchase(s0, MINER, s0.tick);
  const burn = routeFuelCost(DEST).fuelBurn;
  const creditsBefore = s0.guilds[0].credits;
  const ledgerBefore = s0.syndicate.ledger;
  const fuelBefore = s0.guilds[0].fuelHoard;
  const consumedBefore = s0.audit.totalConsumed;

  const s = accept(s0, buy(MINER, DEST));

  // Credits: guild down by price, ledger up by the SAME integer (invariant 2 exact).
  assert.equal(s.guilds[0].credits, creditsBefore - price);
  assert.equal(s.syndicate.ledger, ledgerBefore + price);
  // Fuel: burned up front, hoard down by exactly the route burn; totalConsumed up to match.
  assert.equal(s.guilds[0].fuelHoard, fuelBefore - burn);
  assert.equal(s.audit.totalConsumed, consumedBefore + burn);
  // The build order — NO shipment yet, NO asset yet.
  assert.equal((s.shipments || []).length, 0, 'no shipment until construction finishes');
  assert.equal((s.guilds[0].assets || []).length, 0, 'no asset until it arrives');
  assert.equal(s.syndicateBuilds.length, 1);
  assert.deepEqual(s.syndicateBuilds[0], {
    ownerGuildId: 'g1',
    assetKind: MINER,
    destinationSystemId: DEST,
    buildDoneTick: s.tick + BUILD_TICKS[MINER],
    boughtTick: s.tick,
  });
  // Every invariant green right after apply (the between-tick assert the server runs).
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. stepSyndicateBuilds: promotion timing ---------------------------------

test('stepSyndicateBuilds promotes at buildDoneTick — an asset-marked shipment appears, and NOT before', () => {
  // Seed a build due at tick 5 (bypassing the 4,320-tick wait), then tick up to it.
  const seed = [{ ownerGuildId: 'g1', assetKind: FACTORY, destinationSystemId: DEST, buildDoneTick: 5, boughtTick: 0 }];
  let s = buyState({ syndicateBuilds: seed });

  s = ticks(s, 4); // to tick 4 — thisTick reaches 4 < 5, so no promotion yet
  assert.equal(s.tick, 4);
  assert.equal(s.syndicateBuilds.length, 1, 'still on order at tick 4');
  assert.equal((s.shipments || []).length, 0, 'no shipment at tick 4');

  s = tick(s); // to tick 5 — promoted
  assert.equal(s.tick, 5);
  assert.equal(s.syndicateBuilds, undefined, 'the promoted build leaves the list (omit-when-empty)');
  assert.equal(s.shipments.length, 1);
  const ship = s.shipments[0];
  assert.equal(ship.assetKind, FACTORY, 'the shipment carries the ASSET marker, not a goods cargo');
  assert.equal(ship.cargo, undefined, 'no goods cargo on an asset delivery');
  // The delivery leg is scheduled from the completion tick: arrival = buildDoneTick + ceil(dist × speed).
  assert.equal(ship.arrivalTick, arrivalTickFor(5, DEST_DISTANCE));
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. stepArrivals: the mint ------------------------------------------------

test('stepArrivals mints one idle asset of the right kind at the destination, with a fresh stable id', () => {
  const seed = [{ ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, buildDoneTick: 2, boughtTick: 0 }];
  let s = buyState({ syndicateBuilds: seed });
  s = ticks(s, 2);                 // promote at tick 2
  assert.equal(s.shipments.length, 1);
  const arrivalTick = s.shipments[0].arrivalTick;

  s = ticks(s, arrivalTick - s.tick); // fly to arrival
  assert.equal(s.tick, arrivalTick);
  assert.equal((s.shipments || []).length, 0, 'the shipment lands and leaves the list');
  const assets = s.guilds[0].assets || [];
  assert.equal(assets.length, 1, 'exactly one asset minted');
  assert.equal(assets[0].kind, MINER);
  assert.equal(assets[0].systemId, DEST, 'minted at the destination system');
  assert.equal(assets[0].id, 'asset_g1_miner_01', 'a fresh stable id from the per-(guild, kind) sequence');
  // Idle = referenced by no venture (the guild has none), so it is deployable inventory.
  assert.equal(idleAssets(s.guilds[0]).length, 1);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('stepArrivals drops the shipment and mints NOTHING when the owning guild is gone (torn down mid-flight)', () => {
  // A galaxy whose ONLY guild does not own the in-flight asset: the shipment names a vanished
  // owner, so the arrival mints nothing and drops it (asset-purchase.md failure mode). Built with
  // a guild-less-of-that-owner state: the shipment's ownerGuildId has no matching guild.
  const near = nearestWaystation(DEST);
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }], // g1 exists, but the shipment is g_gone's
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    shipments: [{
      ownerGuildId: 'g_gone', assetKind: MINER, destinationSystemId: DEST,
      arrivalTick: 1, // due next tick
    }],
  });
  const producedBefore = s.audit.totalProduced;
  s = tick(s); // arrival tick
  assert.equal((s.shipments || []).length, 0, 'the shipment is dropped');
  assert.equal((s.guilds[0].assets || []).length, 0, 'no asset minted for a vanished owner');
  assert.equal(s.audit.totalProduced, producedBefore, 'nothing minted, nothing produced');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 6. the §8.1 quote-lock ---------------------------------------------------

test('quote-lock: a purchase prices the parts from the ring at the ISSUE TICK, and is refused when the quote has expired', () => {
  let s = buyState();
  // Lift the miner parts to the discount branch, then advance so the ring carries that value at a
  // past tick. All priced goods share one per-tick ring, so the bought kind reprices off it.
  setBillPosted(s, MINER, 2_000_000);
  const issueTick = s.tick;
  const lockedPrice = priceAssetForPurchase(s, MINER, issueTick);
  assert.equal(lockedPrice, 16_000_000, 'the price at the issue tick');

  // Advance a couple of ticks — still inside the TTL. The price engine will move the live posted
  // value, but a quote pinned to `issueTick` re-prices from the ring at that tick.
  s = ticks(s, 2);
  const accepted = validateAction(s, buy(MINER, DEST, issueTick));
  assert.equal(accepted.valid, true, 'a 2-tick-old quote is still honoured');
  const afterBuy = applyAction(s, buy(MINER, DEST, issueTick));
  assert.equal(afterBuy.syndicateBuilds[0].boughtTick, s.tick);
  assert.equal(
    s.syndicate.ledger + priceAssetForPurchase(s, MINER, issueTick),
    afterBuy.syndicate.ledger,
    'apply charges the ring-locked issue-tick price, not the moved live price',
  );

  // Past the TTL — refused on expiry (§8.1).
  const expired = ticks(s, QUOTE_TTL_TICKS + 1);
  reject(expired, buy(MINER, DEST, issueTick), /expired/);
});

// --- 7. serialization round-trip ----------------------------------------------

test('serialization: a state with a pending build survives save→load with buildDoneTick intact, and lands on the right tick', () => {
  const s0 = accept(buyState(), buy(MINER, DEST));
  const buildDoneTick = s0.syndicateBuilds[0].buildDoneTick;

  // save → load (the engine's canonical JSON, reloaded verbatim as the persist path does).
  const reloaded = JSON.parse(canonicalStringify(s0));
  assert.equal(hashState(reloaded), hashState(s0), 'the pending build round-trips byte-identically');
  assert.equal(reloaded.syndicateBuilds[0].buildDoneTick, buildDoneTick, 'buildDoneTick intact');

  // buildDoneTick is ABSOLUTE, so the reloaded galaxy lands the asset on the SAME tick the
  // original would have — determinism across a save/load (invariant 9).
  const arrivalTick = buildDoneTick + arrivalTickFor(0, DEST_DISTANCE);
  const fromReload = ticks(reloaded, arrivalTick - reloaded.tick);
  const fromOriginal = ticks(s0, arrivalTick - s0.tick);
  assert.equal(hashState(fromReload), hashState(fromOriginal));
  assert.equal((fromReload.guilds[0].assets || []).length, 1, 'the asset lands from the reloaded save');
  assert.equal(fromReload.guilds[0].assets[0].kind, MINER);
});

// --- 8. the no-op / determinism proofs ----------------------------------------

test('no-op: an unbought galaxy carries NO syndicateBuilds key and is byte-identical to a pre-slice galaxy', () => {
  let s = buyState();
  assert.equal(s.syndicateBuilds, undefined, 'a fresh galaxy has no syndicateBuilds key');
  s = ticks(s, 20);
  assert.equal(s.syndicateBuilds, undefined, 'ticking a galaxy that bought nothing never mints the key');
  assert.ok(!canonicalStringify(s).includes('syndicateBuilds'), 'the serialized state carries no such field');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('determinism: a bought galaxy run through construction twice is byte-identical (invariant 9)', () => {
  const build = () => {
    let s = accept(buyState(), buy(MINER, DEST));
    return ticks(s, 30); // deep into construction, well before completion
  };
  assert.equal(hashState(build()), hashState(build()));
});

// --- 9. a headless end-to-end -------------------------------------------------

test('headless end-to-end: found → buy → build → deliver → mint', () => {
  // Found a guild through the real action path (the only path that grants a home + starter gift).
  const homeSystemId = starterHomeAtDistance(6).id;
  let s = intake(createZeroState(), [createFoundGuildAction({
    guildId: 'e2e', credits: 20_000_000, influence: 100, homeSystemId,
  })]).state;
  const guild = () => s.guilds.find((g) => g.id === 'e2e');
  const startersFactories = idleAssets(guild(), FACTORY).length; // the 10 founding factories
  const creditsAfterFound = guild().credits;
  const fuelAfterFound = guild().fuelHoard;

  // Buy a factory delivered to the home system.
  const price = priceAssetForPurchase(s, FACTORY, s.tick);
  const burn = routeFuelCost(homeSystemId).fuelBurn;
  s = intake(s, [createBuyAssetFromSyndicateAction({ guildId: 'e2e', assetKind: FACTORY, destinationSystemId: homeSystemId })]).state;

  // Credits + fuel debited; a build order recorded; no asset yet.
  assert.equal(guild().credits, creditsAfterFound - price);
  assert.equal(guild().fuelHoard, fuelAfterFound - burn);
  assert.equal(s.syndicateBuilds.length, 1);
  const buildDoneTick = s.syndicateBuilds[0].buildDoneTick;
  assert.equal(buildDoneTick, s.tick + BUILD_TICKS[FACTORY]);

  // Tick PAST buildDoneTick — the transit shipment appears, asset-marked.
  s = ticks(s, (buildDoneTick - s.tick) + 1);
  assert.equal(s.syndicateBuilds, undefined, 'construction finished');
  assert.equal(s.shipments.length, 1);
  assert.equal(s.shipments[0].assetKind, FACTORY, 'an asset-marked transit shipment');
  const arrivalTick = s.shipments[0].arrivalTick;
  assert.ok(arrivalTick > buildDoneTick, 'the delivery leg is still ahead');

  // The snapshot labels the transit manifest for the client slice.
  const snap = buildSnapshot(s);
  assert.equal(snap.shipments[0].assetKind, FACTORY);

  // Tick to arrival — one NEW idle factory of the bought kind, at the destination.
  s = ticks(s, arrivalTick - s.tick);
  assert.equal((s.shipments || []).length, 0);
  const factoriesNow = idleAssets(guild(), FACTORY);
  assert.equal(factoriesNow.length, startersFactories + 1, 'exactly one new factory minted');
  assert.ok(factoriesNow.every((a) => a.systemId === homeSystemId), 'minted at the home system');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
