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
//   - stepSyndicateBuilds runs a PER-GUILD single-slot queue (asset-purchase.md §"Build
//     concurrency"): only the HEAD counts down its BUILD_TICKS and promotes at 0 (an asset-marked
//     shipment appears) and NOT before, scheduling the delivery leg from the completion tick;
//   - stepArrivals mints one idle asset of the right kind at the destination with a fresh stable
//     id, and DROPS the shipment (mints nothing) when the owner is gone;
//   - the §8.1 quote-lock prices the parts from the ring at the issue tick / refuses on expiry;
//   - serialization: a state with a pending build survives save→load with its remainingTicks
//     intact and lands the asset on the right tick;
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
const { GUILD_STARTING_FUEL, routeFuelCost, ASSET_CARGO_VOLUME } = require('../fuel.js');
// A T4 asset fills a HEAVY hold (§5.1, RULED 14-09-26), so its delivery burns the heavy rate.
// The test's expected burn must be sized on that same space, exactly as the engine does.
const assetBurn = (systemId) => routeFuelCost(systemId, ASSET_CARGO_VOLUME).fuelBurn;
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const { QUOTE_TTL_TICKS } = require('../price-ring.js');
const {
  ASSET_BILLS, ALL_BILLS, ASSET_PURCHASE_FLOOR, ASSET_PURCHASE_REDUCTION, BUILD_TICKS,
  BUILDABLE_KINDS, SYNDICATE_SELLABLE_KINDS, priceAssetForPurchase,
} = require('../asset-recipes.js');
const { SPYCRAFT } = require('../vehicles.js');
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

test('validate: refuses a non-sellable kind, an unknown destination, and a missing guild', () => {
  const s = buyState();
  reject(s, buy('ship', DEST), /not a Syndicate-sellable kind/);
  reject(s, buy(MINER, 'sys_does_not_exist'), /not a system on the seed/);
  reject(s, createBuyAssetFromSyndicateAction({ guildId: 'nope', assetKind: MINER, destinationSystemId: DEST }), /no guild with id/);
});

test('validate: refuses when CREDITS are short — and blames credits, not fuel', () => {
  const s = buyState({ credits: ASSET_PURCHASE_FLOOR - 1 });
  reject(s, buy(MINER, DEST), /cannot pay 12000000/);
});

test('validate: refuses when FUEL is short — reached only once credits pass (the goods-buy gate order)', () => {
  const burn = assetBurn(DEST);
  assert.ok(burn > 0, 'the DEST leg costs fuel');
  // Ample credits, but one unit short of the delivery burn.
  const s = buyState({ fuelHoard: burn - 1 });
  reject(s, buy(MINER, DEST), /insufficient fuel/);
});

// --- 2b. the sell catalog DIVERGES from the build catalog at spycraft (2.1d/2.2) ----------------
// docs/asset-purchase.md §"What the Syndicate sells — sellable ⊂ buildable (RULED 22-09-26)".

test('catalog: SYNDICATE_SELLABLE_KINDS is EXACTLY BUILDABLE_KINDS minus spycraft (rule-4 tripwire)', () => {
  // The load-bearing set relation, asserted both ways so a future kind added to ONE catalog can
  // never silently skip the other: spycraft is buildable but NOT sellable, and every OTHER
  // buildable kind IS sellable.
  assert.ok(BUILDABLE_KINDS.includes(SPYCRAFT), 'spycraft is a BUILDABLE kind (a guild builds it)');
  assert.ok(!SYNDICATE_SELLABLE_KINDS.includes(SPYCRAFT), 'spycraft is NOT sellable (guild-build-only)');
  for (const kind of BUILDABLE_KINDS) {
    if (kind === SPYCRAFT) continue;
    assert.ok(SYNDICATE_SELLABLE_KINDS.includes(kind), `${kind} is buildable AND sellable`);
  }
  // The sell set is precisely the buildable set with spycraft removed — nothing more, nothing less.
  assert.deepEqual(
    [...SYNDICATE_SELLABLE_KINDS].sort(),
    BUILDABLE_KINDS.filter((k) => k !== SPYCRAFT).sort(),
  );
});

test('validate: the buy gate ACCEPTS each of the five sellable kinds and REFUSES spycraft (build-only)', () => {
  // Fund past the priciest baseline (heavy transport, 200M) and its own delivery burn, so this is
  // a pure KIND-gate check — no accept turns on a credits/fuel shortfall.
  const s = buyState({ credits: 500_000_000, fuelHoard: 5_000 });
  for (const kind of SYNDICATE_SELLABLE_KINDS) {
    assert.equal(validateAction(s, buy(kind, DEST)).valid, true, `buy ${kind} accepted`);
  }
  // A spycraft buy is refused LOUDLY, naming it guild-build-only (not merely hidden from the UI).
  reject(s, buy(SPYCRAFT, DEST), /guild-build-only/);
});

// --- 3. apply -----------------------------------------------------------------

test('apply: debits the EXACT price to the ledger (invariant 2) and burns the EXACT route fuel (invariant 1), and records the build order', () => {
  const s0 = buyState();
  const price = priceAssetForPurchase(s0, MINER, s0.tick);
  const burn = assetBurn(DEST);
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
  // The build order records the dockyard's RELATIVE shape (asset-purchase.md §"Build concurrency"):
  // `remainingTicks: null` = queued, not yet started — the clock starts when it reaches the head.
  assert.deepEqual(s.syndicateBuilds[0], {
    ownerGuildId: 'g1',
    assetKind: MINER,
    destinationSystemId: DEST,
    remainingTicks: null,
    boughtTick: s.tick,
  });
  // Every invariant green right after apply (the between-tick assert the server runs).
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('apply: the delivery burns the HEAVY rate — a T4 asset fills a heavy hold (§5.1, RULED 14-09-26)', () => {
  // The light→heavy fix. A T4 asset fills a heavy hold, so the burn is ceil(distance × 0.7),
  // NOT the old light-rate ceil(distance × 0.5) placeholder. Pinned against both, so a slip
  // back to the light rate fails here loudly.
  const s0 = buyState();
  const { distance } = nearestWaystation(DEST);
  const s = accept(s0, buy(MINER, DEST));
  const spent = s0.guilds[0].fuelHoard - s.guilds[0].fuelHoard;
  assert.equal(spent, Math.ceil(distance * 0.7), 'burns the heavy rate 0.7/hex');
  assert.notEqual(spent, Math.ceil(distance * 0.5), 'and NOT the retired light-rate placeholder');
  assert.equal(spent, assetBurn(DEST), 'exactly the heavy-hold route burn the engine quotes');
});

// --- 4. stepSyndicateBuilds: promotion timing ---------------------------------

test('stepSyndicateBuilds — the HEAD counts down and promotes at 0 (an asset-marked shipment appears), and NOT before', () => {
  // Seed a head 3 ticks from completion — a mid-construction save (bypassing the full BUILD_TICKS
  // wait). `remainingTicks` is the RELATIVE countdown (not the retired absolute buildDoneTick).
  const seed = [{ ownerGuildId: 'g1', assetKind: FACTORY, destinationSystemId: DEST, remainingTicks: 3, boughtTick: 0 }];
  let s = buyState({ syndicateBuilds: seed });

  s = ticks(s, 2); // remainingTicks 3 → 1 over ticks 1,2 — still building, not yet done
  assert.equal(s.tick, 2);
  assert.equal(s.syndicateBuilds.length, 1, 'still on order at tick 2');
  assert.equal(s.syndicateBuilds[0].remainingTicks, 1, 'one tick of build left');
  assert.equal((s.shipments || []).length, 0, 'no shipment before completion');

  s = tick(s); // to tick 3 — remainingTicks 1 → 0 → promoted
  assert.equal(s.tick, 3);
  assert.equal(s.syndicateBuilds, undefined, 'the completed head leaves the queue (omit-when-empty)');
  assert.equal(s.shipments.length, 1);
  const ship = s.shipments[0];
  assert.equal(ship.assetKind, FACTORY, 'the shipment carries the ASSET marker, not a goods cargo');
  assert.equal(ship.cargo, undefined, 'no goods cargo on an asset delivery');
  // The delivery leg is scheduled from the completion tick: arrival = completionTick + ceil(dist × speed).
  assert.equal(ship.arrivalTick, arrivalTickFor(3, DEST_DISTANCE));
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. stepArrivals: the mint ------------------------------------------------

test('stepArrivals mints one idle asset of the right kind at the destination, with a fresh stable id', () => {
  const seed = [{ ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: 2, boughtTick: 0 }];
  let s = buyState({ syndicateBuilds: seed });
  s = ticks(s, 2);                 // remainingTicks 2 → 0 at tick 2 — promoted
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

test('serialization: a state with a pending build survives save→load with its remainingTicks intact, and lands on the right tick', () => {
  const s0 = accept(buyState(), buy(MINER, DEST));
  assert.equal(s0.syndicateBuilds[0].remainingTicks, null, 'queued at buy, not yet started');

  // save → load (the engine's canonical JSON, reloaded verbatim as the persist path does).
  const reloaded = JSON.parse(canonicalStringify(s0));
  assert.equal(hashState(reloaded), hashState(s0), 'the pending build round-trips byte-identically');
  assert.equal(reloaded.syndicateBuilds[0].remainingTicks, null, 'remainingTicks intact');

  // The queue clock is RELATIVE but deterministic: the reloaded galaxy runs the SAME
  // start→countdown→ship→arrive sequence as the original, so it lands the asset on the SAME tick
  // (invariant 9). Tick both well past the whole span — the start tick, BUILD_TICKS, and the
  // delivery leg — and compare byte-for-byte.
  const span = 1 + BUILD_TICKS[MINER] + arrivalTickFor(0, DEST_DISTANCE) + 5;
  const fromReload = ticks(reloaded, span);
  const fromOriginal = ticks(s0, span);
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

// --- 8b. the snapshot asset-purchase quote (CLIENT slice A) --------------------
// The client renders the price and build time; it computes neither (§5). The snapshot publishes
// `assetPurchaseQuote[kind].{price,buildTicks}` off the engine's own `priceAssetForPurchase`
// (quote-lock ring) and `BUILD_TICKS`, so the TRADE tab's "4 · Constructed" view can show them.

test('snapshot: assetPurchaseQuote publishes the engine price + build ticks for every SELLABLE kind', () => {
  const s = buyState();
  const snap = buildSnapshot(s);
  // The quote is the SELL catalog, not the build catalog: exactly SYNDICATE_SELLABLE_KINDS (the
  // five), spycraft ABSENT — the TRADE tab iterates the quote, so this is what it shows.
  assert.deepEqual(Object.keys(snap.assetPurchaseQuote).sort(), [...SYNDICATE_SELLABLE_KINDS].sort());
  assert.ok(!(SPYCRAFT in snap.assetPurchaseQuote), 'spycraft is guild-build-only — not in the sell quote');
  for (const kind of SYNDICATE_SELLABLE_KINDS) {
    const q = snap.assetPurchaseQuote[kind];
    assert.equal(q.price, priceAssetForPurchase(s, kind, s.tick), `${kind} price == priceAssetForPurchase`);
    assert.equal(q.buildTicks, BUILD_TICKS[kind], `${kind} buildTicks == BUILD_TICKS`);
  }
  // At today's parts scale the floor binds, so the published price is the flat 12M floor.
  assert.equal(snap.assetPurchaseQuote[MINER].price, ASSET_PURCHASE_FLOOR);
  assert.equal(snap.assetPurchaseQuote[FACTORY].price, ASSET_PURCHASE_FLOOR);
});

test('snapshot: the quote is DERIVED-on-read — a galaxy with no purchase serializes byte-identically', () => {
  const s = buyState();
  const before = canonicalStringify(s);
  const hashBefore = hashState(s);
  buildSnapshot(s); // building the quote must move no serialized byte
  assert.equal(canonicalStringify(s), before, 'building the snapshot mutates no state');
  assert.equal(hashState(s), hashBefore, 'and moves no determinism byte');
  assert.ok(!before.includes('assetPurchaseQuote'), 'the quote is never a serialized field');
  // Same state, byte-identical quote bytes on a re-read.
  assert.equal(
    JSON.stringify(buildSnapshot(s).assetPurchaseQuote),
    JSON.stringify(buildSnapshot(s).assetPurchaseQuote),
  );
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
  const burn = assetBurn(homeSystemId);
  s = intake(s, [createBuyAssetFromSyndicateAction({ guildId: 'e2e', assetKind: FACTORY, destinationSystemId: homeSystemId })]).state;

  // Credits + fuel debited; a build order recorded; no asset yet.
  assert.equal(guild().credits, creditsAfterFound - price);
  assert.equal(guild().fuelHoard, fuelAfterFound - burn);
  assert.equal(s.syndicateBuilds.length, 1);
  assert.equal(s.syndicateBuilds[0].remainingTicks, null, 'queued at buy, not yet started');

  // Sequential model (asset-purchase.md §"Build concurrency"): the head STARTS the tick after buy,
  // then counts down BUILD_TICKS, so it completes (promotes to a shipment) at buyTick + 1 + BUILD_TICKS.
  const completionTick = s.tick + 1 + BUILD_TICKS[FACTORY];
  s = ticks(s, completionTick - s.tick);
  assert.equal(s.syndicateBuilds, undefined, 'construction finished');
  assert.equal(s.shipments.length, 1);
  assert.equal(s.shipments[0].assetKind, FACTORY, 'an asset-marked transit shipment');
  const arrivalTick = s.shipments[0].arrivalTick;
  assert.ok(arrivalTick > completionTick, 'the delivery leg is still ahead');

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

// --- 10. per-guild single-slot sequential (asset-purchase.md §"Build concurrency") -------------
// The ruling (19-09-26): the Syndicate runs ONE build slot per guild. A guild's commissions form a
// FIFO queue on `state.syndicateBuilds`; only the HEAD builds (counting down its BUILD_TICKS), and
// the next entry starts when the head ships. These tripwires guard that shape against a regression
// to the retired PARALLEL model (a batch collapsing to near-simultaneous completion — the bug that
// motivated the ruling). It mirrors the dockyard's single-slot `remainingTicks` model per GUILD.

// How many of a guild's builds are actively counting down (remainingTicks > 0) right now.
const startedCount = (state, guildId) =>
  (state.syndicateBuilds || []).filter((b) => b.ownerGuildId === guildId && b.remainingTicks > 0).length;

// A two-guild seed helper for the independence/snapshot cases (no ventures, just a queue).
const twoGuildState = (syndicateBuilds) => createState({
  guilds: [
    { id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: DEST, homePlanetId: HOME.homePlanet },
    { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: DEST, homePlanetId: HOME.homePlanet },
  ],
  reserve: { reserveLevel: 0 },
  syndicate: { ledger: 0 },
  claims: [homeClaim('g1', DEST), homeClaim('g2', DEST)],
  syndicateBuilds,
});

test('single-slot: at any tick a guild has AT MOST ONE build counting down (never the parallel batch)', () => {
  // Three miners commissioned in the SAME tick — the batch the parallel model would build all at once.
  let s = buyState({ credits: 100_000_000 });
  s = accept(s, buy(MINER, DEST));
  s = accept(s, buy(MINER, DEST));
  s = accept(s, buy(MINER, DEST));
  assert.equal(s.syndicateBuilds.length, 3, 'three queued');
  assert.deepEqual(s.syndicateBuilds.map((b) => b.remainingTicks), [null, null, null], 'none started at buy');

  // Tick through the whole sequential run. At NO tick may two of g1's builds count down at once.
  const span = 3 * (BUILD_TICKS[MINER] + 1) + 10;
  let maxStarted = 0;
  for (let i = 0; i < span; i += 1) {
    s = tick(s);
    const started = startedCount(s, 'g1');
    maxStarted = Math.max(maxStarted, started);
    assert.ok(started <= 1, `two of g1's builds counting down at tick ${s.tick} — single-slot broken`);
    if (!s.syndicateBuilds) break;
  }
  assert.equal(maxStarted, 1, 'exactly one slot was ever active (a build really ran — not a dead no-op loop)');
});

test('sequential handoff: a head completing dispatches ONE shipment AND the next entry starts the FOLLOWING tick', () => {
  // A head one tick from done, a second build queued behind it (same guild).
  const seed = [
    { ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: 1, boughtTick: 0 },
    { ownerGuildId: 'g1', assetKind: FACTORY, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 },
  ];
  let s = buyState({ syndicateBuilds: seed });

  s = tick(s); // the head (miner) hits 0 → ships; the factory is NOT started this same tick
  assert.equal(s.shipments.length, 1, 'the completed head dispatched exactly one shipment');
  assert.equal(s.shipments[0].assetKind, MINER);
  assert.equal(s.syndicateBuilds.length, 1, 'only the second build remains');
  assert.equal(s.syndicateBuilds[0].assetKind, FACTORY);
  assert.equal(s.syndicateBuilds[0].remainingTicks, null, 'the new head has NOT started on the handoff tick');

  s = tick(s); // NOW the factory (the new head) starts its own countdown
  assert.equal(s.syndicateBuilds[0].remainingTicks, BUILD_TICKS[FACTORY], 'the new head starts the FOLLOWING tick');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('independence: two guilds\' queues are independent — both build at once, and A completing does not advance B', () => {
  // g1's head one tick from done; g2's head mid-build; each with a second build queued behind it.
  let s = twoGuildState([
    { ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: 1, boughtTick: 0 },
    { ownerGuildId: 'g2', assetKind: MINER, destinationSystemId: DEST, remainingTicks: 5, boughtTick: 0 },
    { ownerGuildId: 'g1', assetKind: FACTORY, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 },
    { ownerGuildId: 'g2', assetKind: FACTORY, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 },
  ]);
  // BOTH heads count down at once — parallelism ACROSS guilds is allowed; the single slot is PER guild.
  assert.equal(startedCount(s, 'g1'), 1);
  assert.equal(startedCount(s, 'g2'), 1);

  s = tick(s); // g1's head (rt 1) ships; g2's head (rt 5→4) keeps building, untouched by g1's completion
  assert.equal(s.shipments.length, 1, 'only g1 shipped');
  assert.equal(s.shipments[0].ownerGuildId, 'g1');
  const g2Head = s.syndicateBuilds.find((b) => b.ownerGuildId === 'g2' && b.assetKind === MINER);
  assert.equal(g2Head.remainingTicks, 4, 'g2\'s head advanced by its OWN one tick — g1 completing did not push it');
  const g1Next = s.syndicateBuilds.find((b) => b.ownerGuildId === 'g1');
  assert.equal(g1Next.assetKind, FACTORY);
  assert.equal(g1Next.remainingTicks, null, 'g1\'s next waits for the following tick');
  const g2Next = s.syndicateBuilds.find((b) => b.ownerGuildId === 'g2' && b.assetKind === FACTORY);
  assert.equal(g2Next.remainingTicks, null, 'g2\'s second build never started — its head is still building');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('worked example: 3 miners commissioned together complete one build apart, in order — one shipment each, NOT all at once', () => {
  let s = buyState({ credits: 100_000_000 });
  s = accept(s, buy(MINER, DEST));
  s = accept(s, buy(MINER, DEST));
  s = accept(s, buy(MINER, DEST));
  assert.equal(s.syndicateBuilds.length, 3);

  // Watch the queue empty one build at a time; record the tick each build ships.
  const completionTicks = [];
  let prevLen = s.syndicateBuilds.length;
  const runFor = 3 * (BUILD_TICKS[MINER] + 1) + 10;
  for (let i = 0; i < runFor; i += 1) {
    s = tick(s);
    const len = (s.syndicateBuilds || []).length;
    if (len < prevLen) completionTicks.push(s.tick);
    prevLen = len;
  }

  // Each build takes its own BUILD_TICKS countdown PLUS the one start tick (the dockyard mirror:
  // start and count-down are separate), so completions land one BUILD_TICKS+1 apart, IN ORDER —
  // NOT the near-simultaneous collapse of the retired parallel model. For a miner (720) that is
  // 721, 1442, 2163 ticks out — k × (BUILD_TICKS+1).
  const step = BUILD_TICKS[MINER] + 1; // 721
  assert.deepEqual(completionTicks, [step, 2 * step, 3 * step], 'staggered completions, one after another');
  assert.equal(completionTicks[1] - completionTicks[0], step, 'evenly one build apart — not simultaneous');
  assert.equal(completionTicks[2] - completionTicks[1], step);

  // Flush the delivery legs: exactly three miners minted at the destination — one shipment each.
  s = ticks(s, arrivalTickFor(0, DEST_DISTANCE) + 2);
  const minted = (s.guilds[0].assets || []).filter((a) => a.kind === MINER);
  assert.equal(minted.length, 3, 'three miners delivered — one per build, none lost or doubled');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('determinism: a mixed sequential multi-build run is byte-identical across two runs (invariant 9)', () => {
  const run = () => {
    let s = buyState({ credits: 100_000_000 });
    s = accept(s, buy(MINER, DEST));
    s = accept(s, buy(FACTORY, DEST));
    s = accept(s, buy(MINER, DEST));
    // Deep into the run: the head has completed and shipped, the second is mid-build, the third waits.
    return ticks(s, BUILD_TICKS[MINER] + 50);
  };
  assert.equal(hashState(run()), hashState(run()));
});

// --- 11. the snapshot per-guild queue (derived-on-read) ------------------------
// The snapshot rebuilds `syndicateBuilds` as the client-readable queue: a `building` flag on each
// guild's head, the stored `remainingTicks`, and a QUEUE-AWARE `ticksRemaining` (a per-guild running
// sum). No serialized byte — additive derived-on-read, like assetPurchaseQuote.

test('snapshot: syndicateBuilds publishes the per-guild single-slot queue — head building, queue-aware ticksRemaining', () => {
  // g1: a head mid-build (100 left) + two queued behind it; g2: one queued head. Interleaved in the
  // array to prove the derive keys on ownerGuildId, not on position alone.
  const rows = buildSnapshot(twoGuildState([
    { ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: 100, boughtTick: 0 },
    { ownerGuildId: 'g1', assetKind: FACTORY, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 },
    { ownerGuildId: 'g2', assetKind: MINER, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 },
    { ownerGuildId: 'g1', assetKind: MINER, destinationSystemId: DEST, remainingTicks: null, boughtTick: 0 },
  ])).syndicateBuilds;
  assert.equal(rows.length, 4);

  // `building` is true for each guild's HEAD only (the first entry per guild in FIFO order).
  assert.deepEqual(rows.map((r) => r.building), [true, false, true, false]);
  //                                              g1head g1-2  g2head g1-3

  // `remainingTicks` echoes the STORED value — null while queued.
  assert.deepEqual(rows.map((r) => r.remainingTicks), [100, null, null, null]);

  // `ticksRemaining` is a per-guild running sum of (remainingTicks ?? BUILD_TICKS[kind]): the head's
  // own remaining, and each entry behind it adds a full BUILD_TICKS. g2 is independent of g1.
  assert.equal(rows[0].ticksRemaining, 100, 'g1 head: its own countdown');
  assert.equal(rows[1].ticksRemaining, 100 + BUILD_TICKS[FACTORY], 'g1 2nd: head remaining + a full factory build');
  assert.equal(rows[2].ticksRemaining, BUILD_TICKS[MINER], 'g2 head: a full miner build, independent of g1');
  assert.equal(rows[3].ticksRemaining, 100 + BUILD_TICKS[FACTORY] + BUILD_TICKS[MINER], 'g1 3rd: the two ahead + its own');

  // `buildDoneTick` is GONE (the retired absolute model).
  assert.ok(rows.every((r) => r.buildDoneTick === undefined), 'no buildDoneTick on the published row');
});
