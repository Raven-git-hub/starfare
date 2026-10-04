'use strict';

// sell-cart.test.js — the INLINE-CART SELL (docs/syndicate-orders.md §9.2; roadmap 2.2, trading
// to/from outposts, engine: the inline-cart SELL). `sellToSyndicate` may carry a `cart: [{ good, qty }]`:
// the Outpost Manager's sale, sent whole on the confirm. The cart IS the order. It is sold from the
// action's origin (a held system or one of the guild's own Outposts, read through `sellOrigin`) under
// the SAME gates and settlement as the held order, and it never reads, writes or clears
// `guild.sellOrder` — so an Outpost sale cannot disturb a trade-tab draft.
//
// The tripwires:
//   - a cart sale from an Outpost drains exactly the cart (omit-when-empty), pays Σ round(qty × price),
//     burns the Outpost leg, and ships nothing;
//   - INDEPENDENCE: a held `sellOrder` is byte-identical after a cart sale, even one that would fail
//     every gate if it were read;
//   - PRECEDENCE: a cart's presence picks the cart path — an empty or malformed cart is refused, never
//     swapped for the held order;
//   - a cart sale from a system works the same (the path is origin-agnostic);
//   - PARITY: the same lines sold by cart or by held order give the same world, bar the order itself;
//   - reject-whole, state untouched: a short line, over the heavy hold, not enough fuel, a future or
//     expired quote, a malformed cart, a bad origin;
//   - the creator: the cart goes into the action only when given;
//   - conservation (1 & 2), galactic supply, `checkOrders`, and determinism (9) across save + replay.

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
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { nearestWaystationToHex, systemHex, hexDistance } = require('../transport.js');
const {
  routeFuelCost, routeFuelCostFromHex, volumeOf, HEAVY_HOLD, GUILD_STARTING_FUEL,
} = require('../fuel.js');
const { QUOTE_TTL_TICKS, quotedPrice } = require('../price-ring.js');
const { OUTPOST_DEPLOY_RANGE } = require('../outposts.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createAddOrderLineAction, createSellToSyndicateAction, validateAction, applyAction, intake,
} = require('../actions.js');

// --- the fixture: real seed geometry, DERIVED (the same scheme as sell-from-outpost.test.js) -------

const HOME = starterHomeAtDistance(6);   // g1's home system — a real starter, 6 hexes from a waystation
const HOME_HEX = systemHex(HOME.id);

// OUT_HEX — g1's Outpost: of the free hexes (in bounds, no seed landmark) within deploy range of HOME,
// the one FARTHEST from any waystation (first such, scan order), so its leg is unmistakably its own.
function farthestFreeHexNearHome() {
  let best = null;
  for (let dq = -OUTPOST_DEPLOY_RANGE; dq <= OUTPOST_DEPLOY_RANGE; dq += 1) {
    for (let dr = -OUTPOST_DEPLOY_RANGE; dr <= OUTPOST_DEPLOY_RANGE; dr += 1) {
      const hex = { q: HOME_HEX.q + dq, r: HOME_HEX.r + dr };
      if (hexDistance(hex, HOME_HEX) > OUTPOST_DEPLOY_RANGE) continue;
      if (!isHexInBounds(hex.q, hex.r) || seedLandmarkAtHex(hex.q, hex.r)) continue;
      if (best === null || nearestWaystationToHex(hex).distance > nearestWaystationToHex(best).distance) best = hex;
    }
  }
  return best;
}
const OUT_HEX = farthestFreeHexNearHome();
const RIVAL_HEX = { q: OUT_HEX.q, r: OUT_HEX.r + 1 }; // any other hex: only its owner matters here

const T1 = 'titanium';        // volume 1
const T2 = 'battery_cells';   // volume 100
const PRICE_T1 = 12;
const PRICE_T2 = 7.25;        // fractional, so per-line rounding shows: round(50 × 7.25) = round(362.5) = 363

// The main cart — listed OUT of good order on purpose, so the test can see the engine sorts a COPY
// and leaves the action's own cart alone.
const CART = [{ good: T1, qty: 300 }, { good: T2, qty: 50 }];
const CART_SPACE = 300 * volumeOf(T1) + 50 * volumeOf(T2);
const BURN_OUT = routeFuelCostFromHex(OUT_HEX, CART_SPACE).fuelBurn;
const BURN_HOME = routeFuelCost(HOME.id, CART_SPACE).fuelBurn;
// The premise every fuel assertion rests on: the Outpost's leg really is a different (longer) leg.
assert.ok(BURN_OUT > BURN_HOME, `fixture premise: the Outpost leg (${BURN_OUT}) must burn more than the home leg (${BURN_HOME})`);

// cartState(...) -> an invariant-clean galaxy: guild g1 holds HOME (stock in its pool there) and owns
// Outpost `outpost_g1_01` on OUT_HEX; rival guild g2 owns `outpost_g2_01`. Ledger-funded so invariant 2
// starts balanced; reserve-stocked so invariant 1 has fuel to conserve. No held order yet.
function cartState({
  outpostStock = { [T1]: 900, [T2]: 50 },
  homeStock = { [T1]: 500, [T2]: 50 },
  fuelHoard = GUILD_STARTING_FUEL,
  credits = 100000,
} = {}) {
  const outpost = (id, ownerGuildId, coords, stock) => ({
    id, ownerGuildId, anchorSystemId: HOME.id, coords: { ...coords }, createdAtTick: 0,
    ...(Object.keys(stock).length ? { stockpile: { ...stock } } : {}),
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
      outpost('outpost_g2_01', 'g2', RIVAL_HEX, { [T1]: 70 }),
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -credits },
    claims: [{
      claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: HOME.id,
      landmarkKind: 'system', claimedAtTick: 0, contested: false,
    }],
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

// refuseUntouched(state, action, pattern) — the action is refused with a reason matching `pattern`,
// and, through the batch intake, the WHOLE state is exactly as it was (a reject never reaches apply).
// Returns the reason.
const refuseUntouched = (state, action, pattern) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, `expected a refusal matching ${pattern}`);
  assert.match(reason, pattern);
  const { state: after, results } = intake(state, [action]);
  assert.equal(results[0].accepted, false);
  assert.equal(hashState(after), hashState(state), 'a refusal moves nothing');
  return reason;
};

const addSell = (good, qty) => createAddOrderLineAction({ guildId: 'g1', side: 'sell', good, qty });
const buildSell = (state, lines) => lines.reduce((s, [good, qty]) => accept(s, addSell(good, qty)), state);
const cartFromOutpost = (cart, more = {}) => createSellToSyndicateAction({ guildId: 'g1', originOutpostId: 'outpost_g1_01', cart, ...more });
const cartFromSystem = (cart, more = {}) => createSellToSyndicateAction({ guildId: 'g1', originSystemId: HOME.id, cart, ...more });
const outpostOf = (s, id) => s.outposts.find((o) => o.id === id);

// A held order that would FAIL every gate if a cart sale ever read it: more titanium than any pile
// holds, over the heavy hold, plus a good the cart does not list.
const POISON_ORDER = [[T1, HEAVY_HOLD + 1], ['ammonia', 7]];

// Invariant 1 restated by hand, so a failure names the term rather than the rule.
function assertFuelBalances(state, where) {
  const hoards = state.guilds.reduce((sum, g) => sum + g.fuelHoard + (g.deuteriumFuel || 0), 0);
  const lhs = hoards + state.reserve.reserveLevel;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  assert.equal(lhs, rhs, `${where}: hoards ${hoards} + reserve ${state.reserve.reserveLevel} = ${lhs}, but produced − consumed = ${rhs}`);
}

// --- 1. the sale itself ---------------------------------------------------------------------------

test('a cart sale from an Outpost drains exactly the cart, pays Σ round(qty × price) per line, burns the Outpost leg, and ships nothing', () => {
  const before = cartState();
  assert.deepEqual(checkInvariants(before, before.tick), [], 'the fixture opens invariant-clean');
  // A fresh copy of CART, so the check at the end can see whether apply touched the action's own cart.
  const action = cartFromOutpost(CART.map((line) => ({ ...line })));
  const after = accept(before, action);
  const g = after.guilds[0];

  // The drain — from the OUTPOST's stockpile, by exactly the cart's quantities. battery_cells was sold
  // down to 0, so its key is GONE (omit-when-empty), not left as a 0.
  assert.deepEqual(outpostOf(after, 'outpost_g1_01').stockpile, { [T1]: 900 - 300 },
    'titanium down by 300; battery_cells sold to 0 and omitted');
  assert.equal(getStock(g, HOME.id, T1), 500, 'the home system pool is not the origin — untouched');
  assert.deepEqual(outpostOf(after, 'outpost_g2_01'), outpostOf(before, 'outpost_g2_01'), 'the rival Outpost is untouched');

  // The proceeds — rounded PER LINE, funded by the ledger (invariant 2 to the credit).
  const proceeds = Math.round(300 * PRICE_T1) + Math.round(50 * PRICE_T2);
  assert.equal(proceeds, 3600 + 363, 'the per-line rounding this fixture is built to show');
  assert.equal(g.credits, before.guilds[0].credits + proceeds);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger - proceeds);

  // The burn — ONE leg, from the Outpost's own hex, at the cart's tier.
  assert.equal(g.fuelHoard, before.guilds[0].fuelHoard - BURN_OUT, `the Outpost leg burns ${BURN_OUT}`);
  assert.equal(after.audit.totalConsumed, before.audit.totalConsumed + BURN_OUT, 'the burn is recorded');

  // Immediate settlement — no shipment, and no held order appears.
  assert.deepEqual(after.shipments, before.shipments, 'no shipment created');
  assert.equal('sellOrder' in g, false, 'a cart sale creates no held order');

  // The action's own cart is untouched — the engine sorted a COPY.
  assert.deepEqual(action.cart, CART, 'the cart on the action is neither reordered nor changed');

  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('a cart that sells an Outpost\'s whole stockpile removes the `stockpile` key', () => {
  const before = cartState({ outpostStock: { [T1]: 40 } });
  const after = accept(before, cartFromOutpost([{ good: T1, qty: 40 }]));
  assert.equal('stockpile' in outpostOf(after, 'outpost_g1_01'), false, 'omit-when-empty: no `stockpile: {}` left behind');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- 2. independence from the held order (the reason the cart path exists) ------------------------

test('INDEPENDENCE: a cart sale neither reads, writes nor clears the held sellOrder', () => {
  // A held draft that would fail every gate if it were read (see POISON_ORDER).
  const before = buildSell(cartState(), POISON_ORDER);
  const heldBefore = JSON.stringify(before.guilds[0].sellOrder);

  const after = accept(before, cartFromOutpost(CART));
  // The SALE happened — from the cart...
  assert.deepEqual(outpostOf(after, 'outpost_g1_01').stockpile, { [T1]: 600 });
  assert.equal(after.guilds[0].credits, before.guilds[0].credits + 3600 + 363);
  // ...and the held order is BYTE-IDENTICAL: not read (it would have been refused), not cleared, not
  // appended to.
  assert.equal(JSON.stringify(after.guilds[0].sellOrder), heldBefore, 'the held sellOrder is byte-identical');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('INDEPENDENCE: a trade-tab draft survives an Outpost cart sale and still finalises from its system after', () => {
  const before = buildSell(cartState(), [[T1, 10]]);
  const afterCart = accept(before, cartFromOutpost(CART));
  assert.deepEqual(afterCart.guilds[0].sellOrder, { lines: [{ good: T1, qty: 10 }] }, 'the draft is still there');

  // The player goes back to the trade tab and confirms the draft: it sells from the home pool and clears.
  const afterHeld = accept(afterCart, createSellToSyndicateAction({ guildId: 'g1', originSystemId: HOME.id }));
  assert.equal(getStock(afterHeld.guilds[0], HOME.id, T1), 500 - 10);
  assert.equal('sellOrder' in afterHeld.guilds[0], false, 'the held finalise clears its own order, as ever');
  assert.deepEqual(checkInvariants(afterHeld, afterHeld.tick), []);
});

test('PRECEDENCE: a cart\'s presence picks the cart path — an empty or malformed cart is refused, never swapped for the held order', () => {
  // A held order that WOULD sell cleanly from the home system — so if a bad cart fell through to it,
  // the action would be accepted and this test would fail.
  const s = buildSell(cartState(), [[T1, 10]]);
  assert.equal(validateAction(s, createSellToSyndicateAction({ guildId: 'g1', originSystemId: HOME.id })).valid, true,
    'premise: the held order is sellable');

  refuseUntouched(s, cartFromSystem([]), /a SELL cart must carry at least one \{ good, qty \} line/);
  refuseUntouched(s, cartFromSystem(null), /a SELL cart must carry at least one/);
  refuseUntouched(s, cartFromSystem({ good: T1, qty: 10 }), /a SELL cart must carry at least one/);
  refuseUntouched(s, cartFromSystem('titanium'), /a SELL cart must carry at least one/);
});

// --- 3. origin-agnostic, and parity with the held order -------------------------------------------

test('a cart sale from a SYSTEM origin drains only the system pool, on the system leg', () => {
  const before = cartState();
  const after = accept(before, cartFromSystem(CART));
  const g = after.guilds[0];
  assert.equal(getStock(g, HOME.id, T1), 500 - 300, 'the system pool drained');
  assert.equal(getStock(g, HOME.id, T2), 0, 'battery_cells sold out of the pool');
  assert.deepEqual(after.outposts, before.outposts, 'every Outpost untouched');
  assert.equal(g.fuelHoard, before.guilds[0].fuelHoard - BURN_HOME, `the system leg burns ${BURN_HOME}`);
  assert.equal(g.credits, before.guilds[0].credits + 3600 + 363);
  assert.deepEqual(after.shipments, before.shipments, 'no shipment created');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('PARITY: the same lines sold by cart or by held order give the same world, from either origin, under a past quote', () => {
  // Two ticks on, so the quote below is a real past tick still inside the TTL — the quote-lock prices
  // both paths from the ring, not from today's posted price.
  const start = tick(tick(cartState(), []), []);
  const issueTick = start.tick - 2;
  for (const origin of [{ originSystemId: HOME.id }, { originOutpostId: 'outpost_g1_01' }]) {
    const byHeld = accept(buildSell(start, [[T1, 300], [T2, 50]]),
      createSellToSyndicateAction({ guildId: 'g1', ...origin, issueTick }));
    const byCart = accept(start, createSellToSyndicateAction({ guildId: 'g1', ...origin, cart: CART, issueTick }));
    // addOrderLine touches nothing but the order, and the held sale clears it — so the two worlds
    // must be identical to the byte.
    assert.equal(hashState(byCart), hashState(byHeld), `${JSON.stringify(origin)}: cart and held order settle identically`);
    const expected = Math.round(300 * quotedPrice(start, T1, issueTick)) + Math.round(50 * quotedPrice(start, T2, issueTick));
    assert.equal(byCart.guilds[0].credits, start.guilds[0].credits + expected, 'paid at the quoted prices');
  }
});

// --- 4. the gates — reject-whole, state untouched -------------------------------------------------
// Each refusal is run with a held draft present, so "state untouched" covers the draft too.

test('reject-whole: a short line in the origin\'s own pile, naming every short line', () => {
  const s = buildSell(cartState({ outpostStock: { [T1]: 100 }, homeStock: { [T1]: 10000, [T2]: 10000 } }), [[T1, 1]]);
  const reason = refuseUntouched(s, cartFromOutpost([{ good: T1, qty: 150 }, { good: T2, qty: 5 }]),
    /does not hold enough stock in outpost "outpost_g1_01"/);
  assert.match(reason, /titanium \(need 150, hold 100\)/);
  assert.match(reason, /battery_cells \(need 5, hold 0\)/, 'the system pool does not cover an Outpost cart');
});

test('reject-whole: a cart over the heavy hold', () => {
  const s = buildSell(cartState({ outpostStock: { [T1]: HEAVY_HOLD + 1 } }), [[T1, 1]]);
  refuseUntouched(s, cartFromOutpost([{ good: T1, qty: HEAVY_HOLD + 1 }]),
    /total cargo space \d+ exceeds the Syndicate heavy hold .* split the order/);
});

test('reject-whole: not enough fuel for the origin\'s leg', () => {
  const s = buildSell(cartState({ fuelHoard: BURN_OUT - 1 }), [[T1, 1]]);
  refuseUntouched(s, cartFromOutpost(CART),
    new RegExp(`cannot burn ${BURN_OUT} shipping this sell order from "outpost_g1_01"`));
});

test('reject-whole: the §8.1 quote-lock — a future issue tick, and one past the TTL', () => {
  const s = buildSell(cartState(), [[T1, 1]]);
  refuseUntouched(s, cartFromOutpost(CART, { issueTick: s.tick + 5 }), /in the future/);

  let later = s;
  for (let i = 0; i <= QUOTE_TTL_TICKS; i += 1) later = tick(later, []);
  refuseUntouched(later, cartFromOutpost(CART, { issueTick: s.tick }), /has expired/);
});

test('reject-whole: a malformed cart — fail loud, never deduplicated or coerced', () => {
  const s = buildSell(cartState(), [[T1, 1]]);
  const cases = [
    [[{ good: T1, qty: 10 }, { good: T1, qty: 5 }], /cart names "titanium" twice — one line per good/],
    [[{ good: 'unobtainium', qty: 10 }], /"unobtainium" is not a good the Syndicate posts a price for/],
    [[{ good: 'deuterium_fuel', qty: 10 }], /"deuterium_fuel" is Syndicate-regulated — fuel is never listed on the Exchange/],
    [[{ good: T1, qty: 0 }], /qty for "titanium" must be a positive integer/],
    [[{ good: T1, qty: -3 }], /must be a positive integer/],
    [[{ good: T1, qty: 1.5 }], /must be a positive integer/],
    [[{ good: T1, qty: '10' }], /must be a positive integer/],
    [[{ good: T1 }], /must be a positive integer/],
    [[[T1, 10]], /each cart line must be an object \{ good, qty \}/],
    [[null], /each cart line must be an object/],
    [[{ good: T1, qty: 10 }, 'titanium'], /each cart line must be an object/],
  ];
  for (const [cart, pattern] of cases) {
    refuseUntouched(s, cartFromOutpost(cart), pattern);
  }
});

test('reject-whole: the origin is exactly one node and must be the guild\'s — with a cart as without', () => {
  const s = buildSell(cartState(), [[T1, 1]]);
  const raw = (fields) => ({ type: 'sellToSyndicate', guildId: 'g1', cart: CART, ...fields });
  // Both: unchanged, word for word.
  assert.equal(refuseUntouched(s, raw({ originSystemId: HOME.id, originOutpostId: 'outpost_g1_01' }), /not both/),
    'a sell order ships from ONE origin — give originSystemId or originOutpostId, not both (docs/syndicate-orders.md §9)');
  // Neither: refused whole, and the refusal names BOTH origins. It must not fall back to the old
  // `originSystemId`-only wording, which hid that an Outpost origin is just as valid.
  const neither = refuseUntouched(s, raw({}), /ONE origin/);
  assert.equal(neither, 'a sell order ships from ONE origin — give originSystemId or originOutpostId (docs/syndicate-orders.md §9)');
  assert.notEqual(neither, 'originSystemId must be a non-empty string');
  // One origin given but empty: each field's own check, unchanged, word for word.
  assert.equal(refuseUntouched(s, raw({ originSystemId: '' }), /originSystemId/), 'originSystemId must be a non-empty string');
  assert.equal(refuseUntouched(s, raw({ originOutpostId: '' }), /originOutpostId/), 'originOutpostId must be a non-empty string');
  // A rival's Outpost (stocked with titanium) — the node-held gate, not stock.
  refuseUntouched(s, raw({ originOutpostId: 'outpost_g2_01' }), /guild "g1" owns no outpost "outpost_g2_01" to sell from/);
});

// --- 5. the creator -------------------------------------------------------------------------------

test('the creator puts the cart into the action only when given — the held-order actions are unchanged', () => {
  assert.deepEqual(createSellToSyndicateAction({ guildId: 'g1', originSystemId: HOME.id }),
    { type: 'sellToSyndicate', guildId: 'g1', originSystemId: HOME.id }, 'held, system: as before');
  assert.deepEqual(Object.keys(createSellToSyndicateAction({ guildId: 'g1', originOutpostId: 'o', issueTick: 3 })),
    ['type', 'guildId', 'originOutpostId', 'issueTick'], 'held, Outpost, quoted: as before');
  assert.deepEqual(cartFromOutpost(CART, { issueTick: 3 }),
    { type: 'sellToSyndicate', guildId: 'g1', originOutpostId: 'outpost_g1_01', cart: CART, issueTick: 3 });
  // The exactly-one-origin rule holds with a cart too.
  assert.throws(() => createSellToSyndicateAction({ guildId: 'g1', cart: CART }), /exactly one/);
});

// --- 6. conservation, supply, checkOrders, determinism --------------------------------------------

test('conservation and galactic supply hold across a cart sale, and the cart is never stored on the guild', () => {
  const before = buildSell(cartState(), [[T2, 1]]);   // a held draft too, so checkOrders has an order to check
  const after = accept(before, cartFromOutpost(CART));

  // Supply drops by EXACTLY the cart's quantities — counted once, sunk once.
  assert.equal(after.galacticSupply.resources[T1], before.galacticSupply.resources[T1] - 300);
  assert.equal(after.galacticSupply.resources[T2], before.galacticSupply.resources[T2] - 50);
  assert.deepEqual(after.galacticSupply, computeGalacticSupply(after), 'galactic-supply-consistency, live');

  // Invariant 2: credits move guild ↔ ledger, the total is unchanged. Invariant 1: fuel burned is consumed.
  const total = (s) => s.guilds.reduce((sum, g) => sum + g.credits, 0) + s.syndicate.ledger;
  assert.equal(total(after), total(before));
  assertFuelBalances(after, 'after a cart sale');

  // The cart left no trace on the guild: the only new key is the burn's own cycle counter, which
  // every sale's `burnFuel` records (the PARITY test shows a held sale leaves the same world). So
  // checkOrders still sees only the draft.
  const newKeys = Object.keys(after.guilds[0]).filter((k) => !(k in before.guilds[0]));
  assert.deepEqual(newKeys, ['fuelBurnedThisCycle']);
  assert.deepEqual(after.guilds[0].sellOrder, before.guilds[0].sellOrder);
  assert.deepEqual(checkInvariants(after, after.tick), []);
  const ticked = tick(after, []);
  assert.deepEqual(checkInvariants(ticked, ticked.tick), [], 'and the next tick stays green');
});

test('determinism (invariant 9): a run with a cart sale is identical run twice, and across save + journal replay', (t) => {
  const start = cartState();
  const actions = [addSell(T1, 5), cartFromOutpost(CART), cartFromSystem([{ good: T1, qty: 20 }])];

  const runA = intake(start, actions).state;
  const runB = intake(start, actions).state;
  assert.equal(hashState(runA), hashState(runB), 'two runs, one hash');

  // The server's write-ahead protocol: save, then journal each action (cart and all, as JSON) BEFORE
  // applying it; recover from disk and compare.
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-sell-cart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(start, dir);
  let live = start;
  for (const a of actions) {
    appendJournal(live.tick, a, dir);
    live = accept(live, a);
  }
  const recovered = loadOrInit(dir, () => { throw new Error('the save must be found'); });
  assert.equal(hashState(recovered), hashState(live), 'save + replay recovers the same world');
  assert.equal(hashState(tick(recovered, [])), hashState(tick(live, [])), 'and it ticks on identically');
});
