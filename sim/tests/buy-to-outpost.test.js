'use strict';

// buy-to-outpost.test.js — BUY to a node (docs/syndicate-orders.md §9.1 / §9.4; roadmap 2.2, trading
// to/from outposts, engine slice 1b). `buyFromSyndicate` finalises the guild's held buy order to ONE
// destination node: a held system (`destinationSystemId`, unchanged) or one of the guild's OWN Outposts
// (`destinationOutpostId`, new). An Outpost delivery flies the leg to the Outpost's own hex, and on
// arrival lands in THAT Outpost's `stockpile` — all of it, or none of it.
//
// The tripwires, one per ruling:
//   - a buy to an Outpost with room schedules ONE shipment naming the Outpost, burns the Outpost's leg,
//     and on arrival deposits every good into the Outpost's stockpile, with no notice;
//   - NO placement capacity gate (§9.1): a buy the Outpost cannot hold now is still accepted and departs,
//     and a `delivery_space_warning` notice is written at departure;
//   - all-or-nothing on arrival (§9.4): still full → the WHOLE consignment is lost, no refund, and a
//     `delivery_turned_back` notice (cause 'full'); room cleared in transit → it lands; one unit of space
//     over → nothing lands; exactly full → it lands;
//   - an Outpost torn down in transit → lost, notice cause 'outpost-gone';
//   - the warning does not count deliveries already in flight, so over-committing in transit loses a
//     buy with no warning; same-tick deliveries to one Outpost land in the order they were bought;
//   - the node-held gate, exactly one destination, and the unchanged hauler-hold / fuel gates;
//   - conservation (invariants 1 & 2) and galactic supply: a lost consignment imbalances nothing, a
//     landed one is counted once;
//   - determinism (invariant 9) across save + journal replay, mid-flight;
//   - the SYSTEM destination is untouched: same action shape, same shipment record, same leg, no notice;
//   - the two notice types are in the vocabulary, and their payloads are self-contained and emoji-free;
//   - (04-10-26, the Outpost delivery in transit) the snapshot publishes an Outpost delivery's leg from the
//     Outpost's own hex, derived on read; a system row keeps its exact shape; a torn-down Outpost's row
//     has no leg and does not throw.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock } = require('../stock.js');
const { buildSnapshot } = require('../snapshot.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  nearestWaystation, nearestWaystationToHex, systemHex, hexDistance, arrivalTickFor,
} = require('../transport.js');
const {
  routeFuelCost, routeFuelCostFromHex, volumeOf, HEAVY_HOLD, GUILD_STARTING_FUEL,
} = require('../fuel.js');
const { OUTPOST_CAPACITY, OUTPOST_DEPLOY_RANGE } = require('../outposts.js');
const { isEventType, DELIVERY_SPACE_WARNING, DELIVERY_TURNED_BACK } = require('../events.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createAddOrderLineAction, createBuyFromSyndicateAction, createSellToSyndicateAction,
  createRemoveOutpostAction, validateAction, applyAction, intake,
} = require('../actions.js');

// --- the fixture: real seed geometry, DERIVED (a regen carries the tests) — 1a's fixture -----------

const HOME = starterHomeAtDistance(6);   // g1's home system — a real starter, 6 hexes from a waystation
const HOME_HEX = systemHex(HOME.id);

// Every free hex (in bounds, no seed landmark) within the deploy range of HOME, in a fixed scan order —
// the hexes a guild could really have planted an Outpost on.
function freeHexesNearHome() {
  const out = [];
  for (let dq = -OUTPOST_DEPLOY_RANGE; dq <= OUTPOST_DEPLOY_RANGE; dq += 1) {
    for (let dr = -OUTPOST_DEPLOY_RANGE; dr <= OUTPOST_DEPLOY_RANGE; dr += 1) {
      const hex = { q: HOME_HEX.q + dq, r: HOME_HEX.r + dr };
      if (hexDistance(hex, HOME_HEX) > OUTPOST_DEPLOY_RANGE) continue;
      if (!isHexInBounds(hex.q, hex.r) || seedLandmarkAtHex(hex.q, hex.r)) continue;
      out.push(hex);
    }
  }
  return out;
}
const FREE = freeHexesNearHome();
// OUT_HEX — g1's Outpost: the free hex FARTHEST from any waystation (first such, scan order), so its
// leg is unmistakably its own and longer than the home system's.
const OUT_HEX = FREE.reduce((best, hex) => (
  nearestWaystationToHex(hex).distance > nearestWaystationToHex(best).distance ? hex : best));
const others = FREE.filter((h) => h.q !== OUT_HEX.q || h.r !== OUT_HEX.r);
const RIVAL_HEX = others[0];   // g2's Outpost

const T1 = 'titanium';        // volume 1
const T2 = 'battery_cells';   // volume 100
const PRICE_T1 = 12;
const PRICE_T2 = 7.25;        // fractional, so per-line rounding shows: round(50 × 7.25) = round(362.5) = 363

const ORDER = [[T1, 300], [T2, 50]];
const ORDER_SPACE = 300 * volumeOf(T1) + 50 * volumeOf(T2);       // 5,300
const ORDER_COST = Math.round(300 * PRICE_T1) + Math.round(50 * PRICE_T2);
const BURN_OUT = routeFuelCostFromHex(OUT_HEX, ORDER_SPACE).fuelBurn;
const BURN_HOME = routeFuelCost(HOME.id, ORDER_SPACE).fuelBurn;
const TRAVEL_OUT = arrivalTickFor(0, nearestWaystationToHex(OUT_HEX).distance);
const TRAVEL_HOME = arrivalTickFor(0, nearestWaystation(HOME.id).distance);
// The premise every fuel / timing assertion below rests on: the Outpost's leg really is a different
// (longer) leg than its anchor system's. Asserted up front so a regen that broke it fails here, by name.
assert.ok(BURN_OUT > BURN_HOME, `fixture premise: the Outpost leg (${BURN_OUT}) must burn more than the home leg (${BURN_HOME})`);
assert.ok(TRAVEL_OUT > TRAVEL_HOME, 'fixture premise: the Outpost leg is a longer flight');

const claim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`, ownerGuildId: guildId, landmarkId: systemId,
  landmarkKind: 'system', claimedAtTick: 0, contested: false,
});

// roomFor(n) -> an Outpost stockpile of titanium (volume 1) that leaves EXACTLY `n` cargo space free
// under the real OUTPOST_CAPACITY — how "near full" is built without inventing a smaller cap.
const roomFor = (n) => ({ [T1]: OUTPOST_CAPACITY - n });

// outpostState(...) -> an invariant-clean galaxy: guild g1 holds HOME and owns Outpost `outpost_g1_01`
// on OUT_HEX; rival guild g2 owns `outpost_g2_01` on RIVAL_HEX. Both Outposts are minted with their
// default `capacity` (OUTPOST_CAPACITY). Ledger-funded so invariant 2 starts balanced; reserve-stocked
// so invariant 1 has fuel to conserve.
function outpostState({
  outpostStock = {},
  homeStock = {},
  fuelHoard = GUILD_STARTING_FUEL,
  credits = 1000000,
} = {}) {
  const outpost = (id, ownerGuildId, coords, stock) => ({
    id, ownerGuildId, anchorSystemId: HOME.id, coords: { ...coords }, createdAtTick: 0,
    ...(stock && Object.keys(stock).length ? { stockpile: { ...stock } } : {}),
  });
  const s = createState({
    guilds: [
      {
        id: 'g1', credits, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet, outpostSerial: 1,
        ...(Object.keys(homeStock).length ? { stockpiles: { [HOME.id]: { ...homeStock } } } : {}),
      },
      { id: 'g2', credits: 0, fuelHoard: 0, outpostSerial: 1 },
    ],
    outposts: [
      outpost('outpost_g1_01', 'g1', OUT_HEX, outpostStock),
      outpost('outpost_g2_01', 'g2', RIVAL_HEX, {}),
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -credits },
    claims: [claim('g1', HOME.id)],
  });
  s.prices[T1].posted = PRICE_T1;
  s.prices[T2].posted = PRICE_T2;
  return s;
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected a refusal');
  return reason;
};

const addBuy = (good, qty) => createAddOrderLineAction({ guildId: 'g1', side: 'buy', good, qty });
const buildBuy = (state, lines) => lines.reduce((s, [good, qty]) => accept(s, addBuy(good, qty)), state);
const buyToOutpost = (destinationOutpostId) => createBuyFromSyndicateAction({ guildId: 'g1', destinationOutpostId });
const buyToSystem = (destinationSystemId) => createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId });
// buy(state, lines, action) -> the state after building the held order and finalising it.
const buy = (state, lines, action) => accept(buildBuy(state, lines), action);
const outpostOf = (s, id) => (s.outposts || []).find((o) => o.id === id);
const eventsOf = (s, type) => (s.guilds[0].events || []).filter((e) => e.type === type);

// land(state) -> the state on the tick the LAST pending shipment arrives. buy.test.js's idiom: an
// arrival tick is absolute, so the state is moved to the eve of it and ticked once (a flight is a pure
// schedule — nothing happens to it on the ticks between).
function land(state) {
  const last = Math.max(...state.shipments.map((s) => s.arrivalTick));
  const landed = tick({ ...state, tick: last - 1 }, []);
  assert.equal(landed.tick, last);
  assert.deepEqual(checkInvariants(landed, landed.tick), [], 'every invariant holds on the arrival tick');
  return landed;
}

// Invariant 1 restated by hand, so a failure names the term rather than the rule.
function assertFuelBalances(state, where) {
  const hoards = state.guilds.reduce((sum, g) => sum + g.fuelHoard + (g.deuteriumFuel || 0), 0);
  const lhs = hoards + state.reserve.reserveLevel;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  assert.equal(lhs, rhs, `${where}: hoards ${hoards} + reserve ${state.reserve.reserveLevel} = ${lhs}, but produced − consumed = ${rhs}`);
}
const creditTotal = (s) => s.guilds.reduce((sum, g) => sum + g.credits, 0) + s.syndicate.ledger;

// --- 1. a buy to an Outpost with room -------------------------------------------------------------

test('a buy to an Outpost with room schedules ONE shipment naming the Outpost, pays and burns the Outpost leg, and lands every good in its stockpile with no notice', () => {
  const before = buildBuy(outpostState({ outpostStock: { [T1]: 40 } }), ORDER);
  assert.deepEqual(checkInvariants(before, before.tick), [], 'the fixture opens invariant-clean');
  const after = accept(before, buyToOutpost('outpost_g1_01'));
  const g = after.guilds[0];

  // The shipment — the Outpost replaces the system field, in the same place in the record; nothing else.
  assert.equal(after.shipments.length, 1);
  assert.deepEqual(after.shipments[0], {
    ownerGuildId: 'g1',
    cargo: { [T2]: 50, [T1]: 300 },
    destinationOutpostId: 'outpost_g1_01',
    arrivalTick: before.tick + TRAVEL_OUT,
  });
  assert.deepEqual(Object.keys(after.shipments[0]), ['ownerGuildId', 'cargo', 'destinationOutpostId', 'arrivalTick']);

  // The cash moved now (to the ledger, per line), and ONE leg burned — from the Outpost's own hex.
  assert.equal(g.credits, before.guilds[0].credits - ORDER_COST);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger + ORDER_COST);
  assert.equal(g.fuelHoard, before.guilds[0].fuelHoard - BURN_OUT, `the Outpost leg burns ${BURN_OUT}`);
  assert.equal(after.audit.totalConsumed, before.audit.totalConsumed + BURN_OUT);
  assert.equal(g.buyOrder, undefined, 'the held order is cleared');
  // Nothing landed yet, and room was ample: no notice at all (the log stays omit-when-empty).
  assert.deepEqual(outpostOf(after, 'outpost_g1_01').stockpile, { [T1]: 40 });
  assert.equal('events' in g, false, 'no space-warning: the order fits');
  assert.deepEqual(checkInvariants(after, after.tick), []);

  // On the eve it is still in flight; on the arrival tick every good is in the Outpost's stockpile.
  const eve = tick({ ...after, tick: after.shipments[0].arrivalTick - 2 }, []);
  assert.equal(eve.shipments.length, 1, 'still flying the tick before');
  const landed = land(after);
  assert.deepEqual(outpostOf(landed, 'outpost_g1_01').stockpile, { [T1]: 340, [T2]: 50 });
  assert.deepEqual(landed.shipments, [], 'the delivery leaves the list');
  assert.equal(getStock(landed.guilds[0], HOME.id, T1), 0, 'the home pool is not the destination');
  assert.deepEqual(outpostOf(landed, 'outpost_g2_01'), outpostOf(after, 'outpost_g2_01'), 'the rival is untouched');
  assert.equal('events' in landed.guilds[0], false, 'no turn-back notice for a delivery that landed');
});

test('a delivery to an Outpost with NO stockpile creates the `stockpile` key on arrival', () => {
  const after = buy(outpostState(), [[T1, 25]], buyToOutpost('outpost_g1_01'));
  assert.equal('stockpile' in outpostOf(after, 'outpost_g1_01'), false, 'an empty Outpost carries no key (omit-when-empty)');
  const landed = land(after);
  assert.deepEqual(outpostOf(landed, 'outpost_g1_01').stockpile, { [T1]: 25 });
});

// --- 2. no placement gate: the warning, and the all-or-nothing arrival ----------------------------

test('a buy the Outpost cannot hold NOW is still accepted and departs, with a delivery_space_warning written at departure', () => {
  const before = buildBuy(outpostState({ outpostStock: roomFor(1000) }), ORDER);   // 1,000 free, order needs 5,300
  const after = accept(before, buyToOutpost('outpost_g1_01'));

  // It went: paid, fuelled, scheduled — exactly as a buy with room does (§9.1, no placement gate).
  assert.equal(after.shipments.length, 1);
  assert.equal(after.guilds[0].credits, before.guilds[0].credits - ORDER_COST);
  assert.equal(after.guilds[0].fuelHoard, before.guilds[0].fuelHoard - BURN_OUT);

  // ...and the warning, on the departure tick, born unread.
  const warnings = eventsOf(after, DELIVERY_SPACE_WARNING);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    id: 0,
    tick: before.tick,
    type: DELIVERY_SPACE_WARNING,
    payload: {
      guildId: 'g1',
      outpostId: 'outpost_g1_01',
      cargo: { [T2]: 50, [T1]: 300 },
      units: 350,
      space: ORDER_SPACE,
      freeSpace: 1000,
      shortfall: ORDER_SPACE - 1000,
      arrivalTick: before.tick + TRAVEL_OUT,
    },
  });
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('the warning fires only when the order does not fit NOW: exactly the free space is no warning, one unit of space more is', () => {
  const exact = buy(outpostState({ outpostStock: roomFor(300) }), [[T1, 300]], buyToOutpost('outpost_g1_01'));
  assert.equal('events' in exact.guilds[0], false, 'space 300 into 300 free: fits, no warning');
  const over = buy(outpostState({ outpostStock: roomFor(299) }), [[T1, 300]], buyToOutpost('outpost_g1_01'));
  assert.equal(eventsOf(over, DELIVERY_SPACE_WARNING).length, 1, 'space 300 into 299 free: warned');
  assert.equal(eventsOf(over, DELIVERY_SPACE_WARNING)[0].payload.shortfall, 1);
});

test('still full on arrival: the WHOLE consignment is lost, no refund, the stockpile unchanged, and a delivery_turned_back notice (cause full)', () => {
  const after = buy(outpostState({ outpostStock: roomFor(1000) }), ORDER, buyToOutpost('outpost_g1_01'));
  const landed = land(after);

  assert.deepEqual(outpostOf(landed, 'outpost_g1_01').stockpile, roomFor(1000), 'nothing deposited — not even what would fit');
  assert.deepEqual(landed.shipments, [], 'the lost delivery leaves the list');
  assert.equal(landed.guilds[0].credits, after.guilds[0].credits, 'no refund');
  assert.equal(getStock(landed.guilds[0], HOME.id, T1), 0, 'no divert to another node');

  const turned = eventsOf(landed, DELIVERY_TURNED_BACK);
  assert.equal(turned.length, 1);
  assert.deepEqual(turned[0], {
    id: 1,                         // after the departure warning (id 0) — a per-guild counter, never reused
    tick: after.shipments[0].arrivalTick,
    type: DELIVERY_TURNED_BACK,
    payload: {
      guildId: 'g1',
      outpostId: 'outpost_g1_01',
      cargo: { [T2]: 50, [T1]: 300 },
      units: 350,
      space: ORDER_SPACE,
      cause: 'full',
      freeSpace: 1000,
      shortfall: ORDER_SPACE - 1000,
    },
  });
  assert.equal(eventsOf(landed, DELIVERY_SPACE_WARNING).length, 1, 'the departure warning is still in the log');
});

test('room cleared in transit: the warned delivery lands, with no turn-back notice', () => {
  const after = buy(outpostState({ outpostStock: roomFor(1000) }), ORDER, buyToOutpost('outpost_g1_01'));
  assert.equal(eventsOf(after, DELIVERY_SPACE_WARNING).length, 1, 'warned at departure');

  // While it flies, the guild sells 5,000 titanium off the Outpost (1a's SELL from a node): 6,000 free.
  const cleared = accept(
    accept(after, createAddOrderLineAction({ guildId: 'g1', side: 'sell', good: T1, qty: 5000 })),
    createSellToSyndicateAction({ guildId: 'g1', originOutpostId: 'outpost_g1_01' }),
  );
  const landed = land(cleared);
  assert.deepEqual(outpostOf(landed, 'outpost_g1_01').stockpile, {
    [T1]: OUTPOST_CAPACITY - 1000 - 5000 + 300,
    [T2]: 50,
  });
  assert.equal(eventsOf(landed, DELIVERY_TURNED_BACK).length, 0, 'it landed — nothing turned back');
});

test('all-or-nothing at the boundary: exactly full lands; one unit of space over loses the ENTIRE multi-good consignment', () => {
  // 101 space free: a battery cell (100) + a titanium (1) fills it to the brim.
  const exact = land(buy(outpostState({ outpostStock: roomFor(101) }), [[T1, 1], [T2, 1]], buyToOutpost('outpost_g1_01')));
  const full = outpostOf(exact, 'outpost_g1_01');
  assert.deepEqual(full.stockpile, { [T1]: OUTPOST_CAPACITY - 101 + 1, [T2]: 1 });
  assert.equal(full.capacity, OUTPOST_CAPACITY, 'the cap judged is the minted OUTPOST_CAPACITY');
  assert.equal(eventsOf(exact, DELIVERY_TURNED_BACK).length, 0);

  // 100 free: the same consignment needs 101. The battery cell alone would fit — but nothing lands.
  const before = buy(outpostState({ outpostStock: roomFor(100) }), [[T1, 1], [T2, 1]], buyToOutpost('outpost_g1_01'));
  const over = land(before);
  assert.deepEqual(outpostOf(over, 'outpost_g1_01').stockpile, roomFor(100), 'never a partial deposit');
  const [notice] = eventsOf(over, DELIVERY_TURNED_BACK);
  assert.equal(notice.payload.cause, 'full');
  assert.equal(notice.payload.shortfall, 1, 'one unit of space over');
});

test('an Outpost torn down in transit: the consignment is lost, deposited nowhere, with a delivery_turned_back notice (cause outpost-gone)', () => {
  const after = buy(outpostState({ outpostStock: { [T1]: 40 } }), ORDER, buyToOutpost('outpost_g1_01'));
  const torn = accept(after, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  const landed = land(torn);

  assert.equal(outpostOf(landed, 'outpost_g1_01'), undefined, 'still gone');
  assert.deepEqual(landed.shipments, []);
  assert.equal(getStock(landed.guilds[0], HOME.id, T1), 0, 'never a silent spill to another node');
  assert.deepEqual(outpostOf(landed, 'outpost_g2_01'), outpostOf(after, 'outpost_g2_01'));
  const turned = eventsOf(landed, DELIVERY_TURNED_BACK);
  assert.deepEqual(turned.map((e) => e.payload), [{
    guildId: 'g1',
    outpostId: 'outpost_g1_01',   // the last known id
    cargo: { [T2]: 50, [T1]: 300 },
    units: 350,
    space: ORDER_SPACE,
    cause: 'outpost-gone',
  }]);
});

test('an Outpost that is no longer this guild\'s on arrival is the same loss (cause outpost-gone)', () => {
  // No action hands an Outpost to another guild today; the arrival asks anyway, as the departure gate
  // does. Simulated by re-owning it in flight.
  const after = buy(outpostState(), [[T1, 10]], buyToOutpost('outpost_g1_01'));
  outpostOf(after, 'outpost_g1_01').ownerGuildId = 'g2';
  const landed = land(after);
  assert.equal('stockpile' in outpostOf(landed, 'outpost_g1_01'), false, 'nothing landed in g2\'s Outpost');
  assert.equal(eventsOf(landed, DELIVERY_TURNED_BACK)[0].payload.cause, 'outpost-gone');
  assert.equal('events' in landed.guilds[1], false, 'and g2 is told nothing — it bought nothing');
});

test('an Outpost still naming a guild that does not exist halts the tick loudly rather than vanish the goods', () => {
  const s = outpostState();
  s.outposts[1].ownerGuildId = 'ghost';
  s.shipments = [{ ownerGuildId: 'ghost', cargo: { [T1]: 5 }, destinationOutpostId: 'outpost_g2_01', arrivalTick: s.tick + 1 }];
  assert.throws(() => tick(s, []), /shipment for guild "ghost" arriving at tick 1 is bound for its outpost "outpost_g2_01" but no such guild exists/);
});

// --- 3. the jeopardy: in-flight deliveries are not counted ----------------------------------------

test('the warning does not count deliveries in flight: two buys that each fit now can over-commit the Outpost, and the later-bought one is lost with no warning', () => {
  const start = outpostState({ outpostStock: roomFor(1000) });
  const a = [[T1, 600]];        // 600 space
  const b = [[T2, 7]];          // 700 space — each fits the 1,000 free; together they do not
  const both = buy(buy(start, a, buyToOutpost('outpost_g1_01')), b, buyToOutpost('outpost_g1_01'));
  assert.equal(both.shipments[0].arrivalTick, both.shipments[1].arrivalTick, 'premise: they land on the same tick');
  assert.equal('events' in both.guilds[0], false, 'no warning for either — the stockpile had room for each');

  const landed = land(both);
  assert.deepEqual(outpostOf(landed, 'outpost_g1_01').stockpile, { [T1]: OUTPOST_CAPACITY - 1000 + 600 }, 'the first bought landed');
  const turned = eventsOf(landed, DELIVERY_TURNED_BACK);
  assert.deepEqual(turned.map((e) => [e.payload.cargo, e.payload.cause, e.payload.freeSpace]), [[{ [T2]: 7 }, 'full', 400]]);

  // Bought the other way round, the other one lands: purchase order decides, nothing else.
  const flipped = land(buy(buy(start, b, buyToOutpost('outpost_g1_01')), a, buyToOutpost('outpost_g1_01')));
  assert.deepEqual(outpostOf(flipped, 'outpost_g1_01').stockpile, { [T1]: OUTPOST_CAPACITY - 1000, [T2]: 7 });
  assert.deepEqual(eventsOf(flipped, DELIVERY_TURNED_BACK).map((e) => e.payload.cargo), [{ [T1]: 600 }]);
});

// --- 4. the gates -----------------------------------------------------------------------------------

test('the node-held gate: an Outpost the guild does not own, or one that is gone, is refused whole with the draft untouched', () => {
  const s = buildBuy(outpostState(), [[T1, 10]]);
  assert.match(refuse(s, buyToOutpost('outpost_g2_01')), /guild "g1" owns no outpost "outpost_g2_01" to deliver to/);
  assert.match(refuse(s, buyToOutpost('outpost_g1_09')), /owns no outpost "outpost_g1_09"/);
  // Torn down between the popup opening and the confirm (§9.4) — the same refusal.
  const torn = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.match(refuse(torn, buyToOutpost('outpost_g1_01')), /owns no outpost "outpost_g1_01"/);

  const { state: after, results } = intake(s, [buyToOutpost('outpost_g2_01')]);
  assert.equal(results[0].accepted, false);
  assert.equal(hashState(after), hashState(s), 'nothing moved — no credits, no fuel, no shipment, the draft kept');
});

test('the destination is EXACTLY ONE node — both, an empty id, or neither is refused; the creator enforces the same', () => {
  const s = buildBuy(outpostState(), [[T1, 10]]);
  const both = { type: 'buyFromSyndicate', guildId: 'g1', destinationSystemId: HOME.id, destinationOutpostId: 'outpost_g1_01' };
  assert.match(refuse(s, both), /ONE destination — give destinationSystemId or destinationOutpostId, not both/);
  assert.match(refuse(s, { type: 'buyFromSyndicate', guildId: 'g1', destinationOutpostId: '' }), /destinationOutpostId must be a non-empty string/);
  // Neither: the system check's own refusal, word for word as before §9.
  assert.equal(refuse(s, { type: 'buyFromSyndicate', guildId: 'g1' }), 'destinationSystemId must be a non-empty string');

  assert.throws(() => createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: HOME.id, destinationOutpostId: 'outpost_g1_01' }), /exactly one/);
  assert.throws(() => createBuyFromSyndicateAction({ guildId: 'g1' }), /exactly one/);
  assert.deepEqual(buyToOutpost('outpost_g1_01'), { type: 'buyFromSyndicate', guildId: 'g1', destinationOutpostId: 'outpost_g1_01' });
});

test('the fuel gate prices the OUTPOST\'s leg: fuel enough for the home leg is not enough for the farther Outpost', () => {
  const s = buildBuy(outpostState({ fuelHoard: BURN_OUT - 1 }), ORDER);
  assert.ok(BURN_OUT - 1 >= BURN_HOME, 'premise: the hoard covers the home leg');
  assert.match(refuse(s, buyToOutpost('outpost_g1_01')), new RegExp(`cannot burn ${BURN_OUT} flying to "outpost_g1_01"`));
  const toHome = accept(s, buyToSystem(HOME.id));
  assert.equal(toHome.guilds[0].fuelHoard, BURN_OUT - 1 - BURN_HOME, 'the same order to the home system flies the shorter leg');
});

test('the hauler-hold gate is unchanged for an Outpost destination: over one heavy hold is refused, even into an empty Outpost', () => {
  const s = buildBuy(outpostState({ credits: 100000000 }), [[T1, HEAVY_HOLD + 1]]);
  assert.match(refuse(s, buyToOutpost('outpost_g1_01')), /exceeds the Syndicate heavy hold .* split the order/);
});

// --- 5. conservation, supply, determinism ---------------------------------------------------------

test('conservation and supply: a lost consignment imbalances nothing; a landed one is counted once, at tick end', () => {
  // LOST — credits moved to the ledger at purchase and stay there; supply never counted the cargo.
  const before = buildBuy(outpostState({ outpostStock: roomFor(1000) }), ORDER);
  const flying = accept(before, buyToOutpost('outpost_g1_01'));
  assert.equal(creditTotal(flying), creditTotal(before), 'invariant 2 at purchase');
  assert.deepEqual(flying.galacticSupply.resources, before.galacticSupply.resources, 'cargo in flight is not supply');
  assertFuelBalances(flying, 'after the buy');
  const lost = land(flying);
  assert.equal(creditTotal(lost), creditTotal(before), 'invariant 2 after the loss');
  assert.deepEqual(lost.galacticSupply.resources, flying.galacticSupply.resources, 'a lost consignment leaves supply unchanged');
  assertFuelBalances(lost, 'after the loss');

  // LANDED — supply rises by exactly the delivered goods, re-derived at the tick's end.
  const roomy = accept(buildBuy(outpostState(), ORDER), buyToOutpost('outpost_g1_01'));
  const landed = land(roomy);
  assert.equal(landed.galacticSupply.resources[T1], roomy.galacticSupply.resources[T1] + 300);
  assert.equal(landed.galacticSupply.resources[T2], roomy.galacticSupply.resources[T2] + 50);
  assert.deepEqual(landed.galacticSupply, computeGalacticSupply(landed), 'galactic-supply-consistency');
  assert.equal(creditTotal(landed), creditTotal(roomy));
  assertFuelBalances(landed, 'after the landing');
});

test('determinism (invariant 9): warned, lost and landed deliveries — the outcome, the stockpile and the notice ids/ticks — are identical across save + journal replay, saved mid-flight', (t) => {
  const start = outpostState({ outpostStock: roomFor(1000) });
  const actions = [
    addBuy(T1, 300), addBuy(T2, 50), buyToOutpost('outpost_g1_01'),   // warned, and lost on arrival
    addBuy(T1, 200), buyToSystem(HOME.id),                             // a system delivery beside it
  ];
  const runA = intake(start, actions).state;
  const runB = intake(start, actions).state;
  assert.equal(hashState(runA), hashState(runB), 'two runs, one hash');

  // The server's write-ahead protocol: save, then journal each action BEFORE applying it; recover from
  // disk mid-flight and fly both worlds to the arrival.
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-outpost-buy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(start, dir);
  let live = start;
  for (const a of actions) {
    appendJournal(live.tick, a, dir);
    live = accept(live, a);
  }
  const recovered = loadOrInit(dir, () => { throw new Error('the save must be found'); });
  assert.equal(hashState(recovered), hashState(live), 'save + replay recovers the same world, mid-flight');

  const landedLive = land(live);
  const landedRecovered = land(recovered);
  assert.equal(hashState(landedRecovered), hashState(landedLive), 'and it lands identically');
  assert.deepEqual(landedRecovered.guilds[0].events, landedLive.guilds[0].events, 'the same notices, ids and ticks');
  assert.deepEqual(landedLive.guilds[0].events.map((e) => [e.id, e.type]), [[0, DELIVERY_SPACE_WARNING], [1, DELIVERY_TURNED_BACK]]);
  assert.deepEqual(outpostOf(landedRecovered, 'outpost_g1_01'), outpostOf(landedLive, 'outpost_g1_01'));
});

// --- 6. the SYSTEM destination is untouched -------------------------------------------------------

test('a system buy beside a FULL Outpost is exactly as before: the action shape, the shipment record, the system leg, the deposit — and no notice', () => {
  const action = buyToSystem(HOME.id);
  assert.deepEqual(Object.keys(action), ['type', 'guildId', 'destinationSystemId'], 'the action shape is unchanged');

  const before = buildBuy(outpostState({ outpostStock: roomFor(0) }), ORDER);
  const after = accept(before, action);
  assert.deepEqual(after.shipments, [{
    ownerGuildId: 'g1',
    cargo: { [T2]: 50, [T1]: 300 },
    destinationSystemId: HOME.id,
    arrivalTick: before.tick + TRAVEL_HOME,
  }]);
  assert.deepEqual(Object.keys(after.shipments[0]), ['ownerGuildId', 'cargo', 'destinationSystemId', 'arrivalTick']);
  assert.equal(after.guilds[0].fuelHoard, before.guilds[0].fuelHoard - BURN_HOME, 'the system leg — routeFuelCost(system)');
  assert.equal(after.guilds[0].credits, before.guilds[0].credits - ORDER_COST);
  assert.equal('events' in after.guilds[0], false, 'a system is uncapped — never warned, however full an Outpost is');
  assert.equal('eventSeq' in after.guilds[0], false);

  const landed = land(after);
  assert.equal(getStock(landed.guilds[0], HOME.id, T1), 300);
  assert.equal(getStock(landed.guilds[0], HOME.id, T2), 50);
  assert.deepEqual(landed.outposts, after.outposts, 'every Outpost untouched');
  assert.equal('events' in landed.guilds[0], false, 'and no notice on arrival');

  // The system refusals read exactly as before.
  const unheld = buildBuy(outpostState(), [[T1, 1]]);
  assert.match(refuse(unheld, buyToSystem('sys_nope')), /does not hold system "sys_nope" — a delivery goes only to a system you hold/);
});

// --- 7. the notices and the snapshot --------------------------------------------------------------

test('the two notice types are in the vocabulary; their payloads are self-contained plain data, integer-valued and emoji-free', () => {
  assert.ok(isEventType(DELIVERY_SPACE_WARNING) && isEventType(DELIVERY_TURNED_BACK));
  const warned = buy(outpostState({ outpostStock: roomFor(1000) }), ORDER, buyToOutpost('outpost_g1_01'));
  const gone = land(accept(warned, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' })));
  const full = land(warned);
  const rows = [...gone.guilds[0].events, ...full.guilds[0].events];
  assert.deepEqual([...new Set(rows.map((e) => e.type))].sort(), [DELIVERY_SPACE_WARNING, DELIVERY_TURNED_BACK]);
  for (const e of rows) {
    const json = JSON.stringify(e.payload);
    assert.deepEqual(JSON.parse(json), e.payload, `${e.type}: plain JSON data, nothing a save would lose`);
    assert.doesNotMatch(json, /\p{Extended_Pictographic}/u, `${e.type}: no emoji in the payload`);
    for (const [k, v] of Object.entries(e.payload)) {
      if (typeof v === 'number') assert.ok(Number.isInteger(v) && v >= 0, `${e.type}.${k} is a whole number (§15.2)`);
    }
  }
  // The notice never shares an object with the shipment it describes.
  assert.notEqual(warned.guilds[0].events[0].payload.cargo, warned.shipments[0].cargo);
});

// THE OUTPOST DELIVERY IN TRANSIT (04-10-26, slice 1b call 5): the snapshot publishes an Outpost
// delivery's leg exactly as it does a system's — the same three fields, measured from the Outpost's own
// hex — so the client can draw it. Derived on read: nothing is stored on the shipment.
const LEG_KEYS = ['originOutpostId', 'originCoords', 'departureTick'];
// The keys a row has on the WIRE (JSON drops a key whose value is undefined), which is what the client reads.
const wireKeys = (row) => Object.keys(JSON.parse(JSON.stringify(row)));

test('the snapshot publishes an Outpost delivery\'s leg from the Outpost\'s hex: origin = its nearest waystation, departureTick = arrivalTick − the leg — derived, nothing stored', () => {
  const placed = buildBuy(outpostState({ outpostStock: roomFor(1000) }), ORDER);
  const s = accept(placed, buyToOutpost('outpost_g1_01'));
  const hashBefore = hashState(s);
  const snap = buildSnapshot(s);
  const [row] = snap.shipments;

  // The waystation the BUY apply timed the flight from: the one nearest the OUTPOST's hex.
  const near = nearestWaystationToHex(OUT_HEX);
  assert.equal(row.destinationOutpostId, 'outpost_g1_01');
  assert.equal(row.originOutpostId, near.outpost.id, 'origin = the waystation nearest the Outpost');
  assert.deepEqual(row.originCoords, near.outpost.coords);
  assert.notEqual(row.originCoords, near.outpost.coords, 'a fresh object — never an alias into the seed');
  assert.equal(row.departureTick, row.arrivalTick - TRAVEL_OUT, 'departureTick = arrivalTick − the Outpost leg\'s ticks');
  assert.equal(row.departureTick, placed.tick, 'so the leg starts on the tick the buy was placed');
  assert.notEqual(TRAVEL_OUT, TRAVEL_HOME, 'premise: an anchor-system leg would give a different departureTick');
  assert.equal(row.ticksRemaining, TRAVEL_OUT);
  for (const k of ['arrivalTick', 'ticksRemaining', 'departureTick']) {
    assert.ok(Number.isInteger(row[k]), `${k} is a whole tick (§15.2)`);
  }

  // The row the client receives: the system row's fields, with the Outpost id in place of the system id.
  assert.deepEqual(wireKeys(row), [
    'ownerGuildId', 'cargo', 'arrivalTick', 'ticksRemaining', 'destinationOutpostId', ...LEG_KEYS,
  ]);

  // DERIVED ON READ: the stored shipment is the same four keys, and building the snapshot moved no
  // stored byte, so the determinism hash cannot see the leg.
  assert.deepEqual(Object.keys(s.shipments[0]), ['ownerGuildId', 'cargo', 'destinationOutpostId', 'arrivalTick']);
  assert.equal(hashState(s), hashBefore, 'building the snapshot changes no stored byte');
});

test('an Outpost delivery\'s ticksRemaining counts down while its leg stays put', () => {
  const s = buy(outpostState(), ORDER, buyToOutpost('outpost_g1_01'));
  const first = buildSnapshot(s).shipments[0];
  const next = tick(s, []);
  const second = buildSnapshot(next).shipments[0];
  assert.equal(second.ticksRemaining, first.ticksRemaining - 1, 'one tick later, one tick less');
  for (const k of LEG_KEYS) assert.deepEqual(second[k], first[k], `${k} does not move in flight`);

  const eve = buildSnapshot({ ...s, tick: first.arrivalTick - 1 }).shipments[0];
  assert.equal(eve.ticksRemaining, 1, 'the eve of arrival reads 1');
  assert.equal(eve.departureTick, first.departureTick);
});

test('a system shipment row beside an Outpost one keeps its exact shape: destinationSystemId, its own leg, no destinationOutpostId', () => {
  const s = buy(
    buy(outpostState({ outpostStock: roomFor(1000) }), ORDER, buyToOutpost('outpost_g1_01')),
    [[T1, 5]], buyToSystem(HOME.id),
  );
  const snap = buildSnapshot(s);
  const toSystem = snap.shipments.find((r) => r.destinationSystemId === HOME.id);
  assert.deepEqual(Object.keys(toSystem), [
    'ownerGuildId', 'cargo', 'destinationSystemId', 'arrivalTick', 'ticksRemaining', ...LEG_KEYS,
  ], 'a system row keeps its exact shape');
  assert.equal('destinationOutpostId' in toSystem, false);
  const near = nearestWaystation(HOME.id);
  assert.equal(toSystem.originOutpostId, near.outpost.id);
  assert.deepEqual(toSystem.originCoords, near.outpost.coords);
  assert.equal(toSystem.departureTick, toSystem.arrivalTick - TRAVEL_HOME, 'the system\'s own leg, unchanged');

  // The notices still surface with their day (slice 1b's pin, kept).
  const g1 = snap.guilds.find((g) => g.id === 'g1');
  assert.deepEqual(g1.events.map((e) => e.type), [DELIVERY_SPACE_WARNING]);
  assert.equal(typeof g1.events[0].whenDay, 'number', 'the day it was written, derived on read');
  assert.deepEqual(g1.events[0].payload, s.guilds[0].events[0].payload);
});

test('an Outpost torn down mid-flight: its row omits the three leg fields and the snapshot does not throw', () => {
  const after = buy(outpostState(), ORDER, buyToOutpost('outpost_g1_01'));
  const torn = accept(after, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
  assert.equal(outpostOf(torn, 'outpost_g1_01'), undefined, 'premise: the Outpost is gone');
  assert.equal(torn.shipments.length, 1, 'premise: its delivery is still in flight');

  let snap;
  assert.doesNotThrow(() => { snap = buildSnapshot(torn); });
  const [row] = snap.shipments;
  assert.deepEqual(wireKeys(row), ['ownerGuildId', 'cargo', 'arrivalTick', 'ticksRemaining', 'destinationOutpostId'],
    'the row still surfaces with its cargo and countdown, but no leg to draw');
  for (const k of LEG_KEYS) assert.equal(k in row, false, `${k}: no Outpost hex to measure from`);
  assert.deepEqual(row.cargo, { [T2]: 50, [T1]: 300 });
});
