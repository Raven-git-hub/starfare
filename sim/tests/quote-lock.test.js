'use strict';

// quote-lock.test.js — the §8.1 agreed-price quote-lock, ENGINE side (SELL + BUY;
// docs/transport-model.md §8.1 "The agreed-price quote", RULED 03/04-09-26).
//
// The slice: a per-tick posted-price RING (sim/price-ring.js), and an optional `issueTick`
// on `sellToSyndicate` / `buyFromSyndicate` that prices the trade at the good's posted
// value AT THAT TICK — re-derived from the ring, validated for expiry (TTL + cycle
// boundary), across both directions. The client wiring is a later slice.
//
// The tripwires, one per ruling:
//   - THE RING: seeded at tick 0, appended every tick, capped at QUOTE_TTL_TICKS + 1 = 6,
//     and deterministic (same galaxy + seed ⇒ identical ring);
//   - THE NO-OP: with `issueTick` OMITTED, a SELL and a BUY produce the exact credits,
//     goods and fuel they did before this slice — because omitted ⇒ the current tick ⇒
//     age 0 ⇒ today's posted price;
//   - THE LOCK LOCKS: a quote issued at tick T and confirmed a few ticks later (no cycle
//     boundary crossed) executes at T's price, not the moved current one;
//   - EXPIRY, THREE WAYS: a confirm 6 ticks old, one whose cycle rolled, and a future
//     tick are each refused reject-whole, blaming the quote — but only after the other
//     gates it does not also trip;
//   - CONSERVATION: invariants 1 and 2 hold across a multi-tick locked-trade scenario.
//
// The goldens MOVE with this slice, and that is expected: the ring is always-on serialized
// state, so the persisted-state / determinism goldens gain a `priceRing` field and are
// re-pinned (persist.test.js, commitment-scaffold.test.js — the added-key strip proves the
// ring is the ONLY delta). This file proves the behaviour the ring enables.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { assertInvariants, checkInvariants } = require('../invariants.js');
const { postedPrice } = require('../prices.js');
const { baselineOutputFor } = require('../baseline.js');
const { FUEL_GOOD } = require('../resources.js');
const { GUILD_STARTING_FUEL, routeFuelCost } = require('../fuel.js');
const { getStock } = require('../stock.js');
const {
  QUOTE_TTL_TICKS, RING_DEPTH, seedPriceRing, quotedPrice, checkQuote, cycleIndexOf,
  clonePriceRing,
} = require('../price-ring.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  createSellToSyndicateAction, createBuyFromSyndicateAction, validateAction, applyAction,
} = require('../actions.js');

// A real seed home so the claim-integrity / guild-home invariants have something true to
// check and a BUY has a system to deliver into and a waystation to sail from.
const DEST_HOME = starterHomeAtDistance(6);
const DEST = DEST_HOME.id;
const GOOD = 'titanium';

// A SEATLESS mine (no siteId) on the home system — exactly the shape sell.test.js uses, so
// the occupancy invariant has nothing to resolve. It gives the good galactic CAPACITY, so a
// hoard beside it has something to be scarce against and the posted price actually MOVES
// tick over tick (the whole point — a lock is only visible against a moving price).
const mine = (id) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: DEST, resourceType: GOOD, productionRate: 5,
});
const CAP = baselineOutputFor(mine('m')).units;

// A guild homed on DEST with a titanium mine and a fat titanium hoard, so ticking climbs
// the posted price. `windowN` lets a test pick a short cycle to exercise the boundary rule.
function lockState({ credits = 100000, hoard = CAP * 40, fuelHoard = GUILD_STARTING_FUEL, windowN } = {}) {
  return createState({
    guilds: [{
      id: 'g1',
      credits,
      fuelHoard,
      homeSystemId: DEST,
      homePlanetId: DEST_HOME.homePlanet,
      ventures: [mine('m1')],
      stockpiles: { [DEST]: { [GOOD]: hoard } },
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims: [{
      claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: DEST, landmarkKind: 'system',
      claimedAtTick: 0, contested: false,
    }],
    ...(windowN === undefined ? {} : { windowN }),
  });
}

const ticks = (state, n) => { let s = state; for (let i = 0; i < n; i += 1) s = tick(s, []); return s; };
const sell = (allocations, issueTick) => createSellToSyndicateAction({ guildId: 'g1', good: GOOD, allocations, issueTick });
const buy = (qty, issueTick) => createBuyFromSyndicateAction({ guildId: 'g1', good: GOOD, qty, destinationSystemId: DEST, issueTick });
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

// --- 1. the ring itself -------------------------------------------------------

test('the ring is seeded at tick 0 with each good\'s posted price, and appended to every tick, newest last', () => {
  const s0 = lockState();
  // Seeded present from tick 0: one slot per priced good, = its posted value.
  assert.ok(s0.priceRing, 'the ring is always-on state, present from creation');
  assert.deepEqual(s0.priceRing[GOOD], [postedPrice(s0, GOOD)], 'one seed slot, the tick-0 posted price');
  assert.equal(seedPriceRing(s0.prices)[GOOD][0], postedPrice(s0, GOOD), 'seedPriceRing reads the posted value');

  // Each tick appends the new posted value; the newest slot is always the current tick's.
  let s = s0;
  for (let t = 1; t <= 4; t += 1) {
    s = tick(s, []);
    const ring = s.priceRing[GOOD];
    assert.equal(ring[ring.length - 1], postedPrice(s, GOOD), `tick ${t}: newest ring slot == the posted price`);
  }
});

test('the ring is capped at QUOTE_TTL_TICKS + 1 = 6, dropping the oldest', () => {
  assert.equal(RING_DEPTH, QUOTE_TTL_TICKS + 1, 'depth is derived, not invented');
  const s = ticks(lockState(), 20);
  assert.equal(s.priceRing[GOOD].length, RING_DEPTH, 'the ring never grows past its depth');
  // The six slots are the six most-recent posted values, oldest → newest.
  const ring = s.priceRing[GOOD];
  assert.equal(ring[ring.length - 1], postedPrice(s, GOOD), 'newest is this tick');
});

test('the ring is deterministic — same galaxy, same seed ⇒ identical ring', () => {
  const a = ticks(lockState(), 8);
  const b = ticks(lockState(), 8);
  assert.deepEqual(a.priceRing, b.priceRing, 'two runs of the same scenario build the identical ring');
  assert.equal(hashState(a), hashState(b), 'and the whole state, ring included, hashes identically');
});

test('quotedPrice reads age 0 from the live posted price and age ≥ 1 from the ring', () => {
  const s = ticks(lockState(), 6);
  // Age 0 is the live posted value (its canonical home), independent of the ring copy.
  assert.equal(quotedPrice(s, GOOD, s.tick), postedPrice(s, GOOD), 'age 0 == postedPrice');
  // Age ≥ 1 is the ring's record of that past tick.
  const ring = s.priceRing[GOOD];
  for (let age = 1; age <= QUOTE_TTL_TICKS; age += 1) {
    assert.equal(quotedPrice(s, GOOD, s.tick - age), ring[ring.length - 1 - age], `age ${age} reads the ring`);
  }
  // Out of the window ⇒ null (too old, and the future).
  assert.equal(quotedPrice(s, GOOD, s.tick - RING_DEPTH), null, 'a tick older than the ring is null');
  assert.equal(quotedPrice(s, GOOD, s.tick + 1), null, 'a future tick is null');
});

test('the ring-shape invariant trips on an over-long or non-finite ring, and on a fuel row', () => {
  const good = ticks(lockState(), 3);
  assert.deepEqual(checkInvariants(good, good.tick), [], 'a real ring is clean');

  const tooLong = structuredClone(good);
  tooLong.priceRing[GOOD] = new Array(RING_DEPTH + 1).fill(10);
  assert.ok(checkInvariants(tooLong, tooLong.tick).some((v) => v.rule === 'price-ring-capped (sim/price-ring.js)'), 'an over-long ring trips the cap');

  const nan = structuredClone(good);
  nan.priceRing[GOOD] = [Number.NaN];
  assert.ok(checkInvariants(nan, nan.tick).some((v) => v.rule === 'price-ring-sample-finite (sim/price-ring.js)'), 'a NaN sample trips finiteness');

  const fuelRow = structuredClone(good);
  fuelRow.priceRing[FUEL_GOOD] = [10];
  assert.ok(checkInvariants(fuelRow, fuelRow.tick).some((v) => v.rule === 'price-ring-priced-good (sim/price-ring.js)'), 'a fuel ring is never legal (§8)');
});

test('clonePriceRing deep-copies so a caller can never alias into engine state', () => {
  const s = ticks(lockState(), 4);
  const copy = clonePriceRing(s.priceRing);
  copy[GOOD].push(999);
  assert.notEqual(s.priceRing[GOOD].length, copy[GOOD].length, 'mutating the copy does not touch the original');
});

// --- 2. the no-op: issueTick omitted ⇒ exactly today's behaviour --------------

test('NO-OP: a SELL with issueTick omitted prices at the current posted value, exactly as before the slice', () => {
  const s = ticks(lockState(), 5);
  const price = postedPrice(s, GOOD);
  const qty = 10;

  const omitted = createSellToSyndicateAction({ guildId: 'g1', good: GOOD, allocations: [{ systemId: DEST, qty }] });
  assert.equal('issueTick' in omitted, false, 'an omitted issueTick leaves the action shape byte-identical');

  const after = accept(s, omitted);
  const credited = after.guilds[0].credits - s.guilds[0].credits;
  assert.equal(credited, Math.round(qty * price), 'credited at round(qty × postedPrice) — the pre-slice arithmetic');

  // And it is byte-identical to naming the current tick explicitly (age 0), which is the
  // whole no-op claim: omitting == pricing at the current tick.
  const explicit = accept(s, sell([{ systemId: DEST, qty }], s.tick));
  assert.equal(hashState(after), hashState(explicit), 'omitted ⇒ issueTick = current tick, to the byte');
});

test('NO-OP: a BUY with issueTick omitted debits round(qty × posted) and burns the same route fuel as before', () => {
  const s = ticks(lockState(), 5);
  const price = postedPrice(s, GOOD);
  const qty = 10;
  const { fuelBurn } = routeFuelCost(DEST);

  const omitted = createBuyFromSyndicateAction({ guildId: 'g1', good: GOOD, qty, destinationSystemId: DEST });
  assert.equal('issueTick' in omitted, false, 'omitted issueTick, byte-identical action shape');

  const after = accept(s, omitted);
  assert.equal(s.guilds[0].credits - after.guilds[0].credits, Math.round(qty * price), 'cost is round(qty × postedPrice)');
  assert.equal(s.guilds[0].fuelHoard - after.guilds[0].fuelHoard, fuelBurn, 'the route fuel burned is seed geometry, unchanged by the quote-lock');
  assert.equal(hashState(after), hashState(accept(s, buy(qty, s.tick))), 'omitted ⇒ the current tick, to the byte');
});

// --- 3. the lock actually locks -----------------------------------------------

test('a SELL confirmed a few ticks after issue executes at the ISSUE tick\'s price, not the moved one', () => {
  // Issue at tick T, record the price; advance (no boundary on the 1,440 default window);
  // confirm with issueTick = T and prove the trade priced at T, not now.
  const atIssue = ticks(lockState(), 3);
  const T = atIssue.tick;
  const issuePrice = postedPrice(atIssue, GOOD);

  const now = ticks(atIssue, 2); // T+2
  assert.notEqual(postedPrice(now, GOOD), issuePrice, 'the price really moved between issue and confirm');
  assert.equal(quotedPrice(now, GOOD, T), issuePrice, 'the ring still holds the issue-tick price');

  const qty = 10;
  const after = accept(now, sell([{ systemId: DEST, qty }], T));
  const credited = after.guilds[0].credits - now.guilds[0].credits;
  assert.equal(credited, Math.round(qty * issuePrice), 'the sale executed at the LOCKED issue price');
  assert.notEqual(credited, Math.round(qty * postedPrice(now, GOOD)), 'and NOT at the current, moved price');
});

test('a BUY confirmed a few ticks after issue debits the ISSUE tick\'s price, not the moved one', () => {
  const atIssue = ticks(lockState(), 3);
  const T = atIssue.tick;
  const issuePrice = postedPrice(atIssue, GOOD);
  const now = ticks(atIssue, 2);
  assert.notEqual(postedPrice(now, GOOD), issuePrice, 'the price moved');

  const qty = 10;
  const after = accept(now, buy(qty, T));
  const cost = now.guilds[0].credits - after.guilds[0].credits;
  assert.equal(cost, Math.round(qty * issuePrice), 'the purchase paid the LOCKED issue price');
  assert.notEqual(cost, Math.round(qty * postedPrice(now, GOOD)), 'not the current price');
  // The affordability check validate ran used the SAME locked price, so a guild that can
  // just afford the locked cost is not surprised at apply.
  assert.deepEqual(checkInvariants(after, after.tick), [], 'every invariant green after the locked buy');
});

test('a quote confirmed a full QUOTE_TTL_TICKS after issue is still honoured (the edge of the window)', () => {
  const atIssue = ticks(lockState(), 2);
  const T = atIssue.tick;
  const issuePrice = postedPrice(atIssue, GOOD);
  const now = ticks(atIssue, QUOTE_TTL_TICKS); // exactly TTL ticks later
  assert.equal(now.tick - T, QUOTE_TTL_TICKS, 'confirmed the full TTL after issue');
  const after = accept(now, sell([{ systemId: DEST, qty: 10 }], T));
  assert.equal(after.guilds[0].credits - now.guilds[0].credits, Math.round(10 * issuePrice), 'the oldest still-valid age prices at issue');
});

// --- 4. expiry, three ways, reject-whole, blaming the quote -------------------

test('a confirm QUOTE_TTL_TICKS + 1 ticks old is refused as expired (the TTL rule)', () => {
  const atIssue = ticks(lockState(), 2);
  const T = atIssue.tick;
  const now = ticks(atIssue, QUOTE_TTL_TICKS + 1); // one tick past the window
  reject(now, sell([{ systemId: DEST, qty: 10 }], T), /has expired — more than 5 ticks old/);
  reject(now, buy(10, T), /has expired — more than 5 ticks old/);
});

test('a confirm whose cycle has rolled is refused as expired (the boundary rule), even inside the TTL', () => {
  // A short window so a boundary falls within the TTL: N = 3, issue at tick 2 (cycle 0),
  // confirm at tick 3 (cycle 1) — one tick later, well inside the 5-tick TTL, but a
  // boundary has passed, so the fuel price it agreed no longer exists.
  const s = ticks(lockState({ windowN: 3 }), 2);
  assert.equal(s.tick, 2);
  const now = tick(s, []); // tick 3 — the boundary
  assert.equal(now.tick, 3);
  assert.equal(now.tick - s.tick, 1, 'only one tick old — the TTL is not the reason');
  assert.notEqual(cycleIndexOf(now, 2), cycleIndexOf(now, 3), 'but the fuel-price cycle rolled');
  reject(now, sell([{ systemId: DEST, qty: 10 }], 2), /a cycle boundary has passed/);
  reject(now, buy(10, 2), /a cycle boundary has passed/);
  // ...and a quote issued AT the boundary tick (same cycle as now) is still fine.
  assert.doesNotThrow(() => accept(now, sell([{ systemId: DEST, qty: 10 }], 3)));
});

test('a FUTURE issueTick is refused — it names no posted price', () => {
  const now = ticks(lockState(), 4);
  reject(now, sell([{ systemId: DEST, qty: 10 }], now.tick + 1), /is in the future/);
  reject(now, buy(10, now.tick + 3), /is in the future/);
});

test('expiry is reject-whole and blamed LAST — another failing gate is named first', () => {
  const now = ticks(lockState(), 8);
  const expired = 0; // 8 ticks old

  // A SELL that also over-draws stock: the STOCK gate is blamed, not the quote.
  reject(now, sell([{ systemId: DEST, qty: 10 ** 9 }], expired), /cannot sell/);
  // A SELL that names a system the guild holds none of: that gate first.
  reject(now, sell([{ systemId: 'sys_nobody', qty: 1 }], expired), /holds no titanium/);
  // A BUY the guild cannot afford AND an expired quote: CREDITS first — a problem
  // refreshing the quote would not fix.
  const broke = ticks(lockState({ credits: 1 }), 8);
  reject(broke, buy(10 ** 6, 0), /cannot pay/);

  // Only once every other gate passes is the quote itself the refusal — reject-whole,
  // changing nothing.
  const before = hashState(now);
  const r = validateAction(now, sell([{ systemId: DEST, qty: 10 }], expired));
  assert.equal(r.valid, false);
  assert.match(r.reason, /has expired/);
  assert.equal(hashState(now), before, 'a refused confirm mutates nothing (reject-whole)');
});

test('checkQuote is the pure gate: a bare integer, the TTL edge, the future, and a non-integer', () => {
  const s = ticks(lockState(), 6);
  assert.equal(checkQuote(s, GOOD, s.tick).valid, true, 'age 0 is always valid');
  assert.equal(checkQuote(s, GOOD, s.tick - QUOTE_TTL_TICKS).valid, true, 'the TTL edge is valid');
  assert.equal(checkQuote(s, GOOD, s.tick - QUOTE_TTL_TICKS - 1).valid, false, 'one past the edge is not');
  assert.equal(checkQuote(s, GOOD, s.tick + 1).valid, false, 'the future is not');
  assert.match(checkQuote(s, GOOD, 2.5).reason, /must be an integer tick/);
});

// --- 5. conservation across a multi-tick locked-trade scenario ----------------

test('invariants 1 (fuel) and 2 (credits) hold across a multi-tick run with locked SELL and BUY', () => {
  let s = lockState();
  assertInvariants(s, s.tick);

  // Tick a few, issue a quote, tick more, confirm a locked SELL, then a locked BUY, then
  // keep ticking — asserting every invariant at every step.
  s = ticks(s, 3);
  const T = s.tick;
  const g0Credits = s.guilds[0].credits;
  const g0Ledger = s.syndicate.ledger;

  s = ticks(s, 2);
  s = accept(s, sell([{ systemId: DEST, qty: 20 }], T));
  assertInvariants(s, s.tick);
  // Invariant 2 to the credit: what the guild gained the ledger lost.
  assert.equal(s.guilds[0].credits + s.syndicate.ledger, g0Credits + g0Ledger, 'the SELL moved credits, minted none');

  s = accept(s, buy(15, T)); // still within TTL, same cycle
  assertInvariants(s, s.tick);

  // Keep ticking, including across a real cycle boundary is not needed here — the point is
  // the trades leave the books balanced, which the invariants assert directly.
  for (let i = 0; i < 5; i += 1) { s = tick(s, []); assertInvariants(s, s.tick); }

  // A spot check on invariant 1 by hand at the end: fuel is conserved.
  const hoards = s.guilds.reduce((n, g) => n + g.fuelHoard, 0);
  assert.equal(hoards + s.reserve.reserveLevel, s.audit.totalProduced - s.audit.totalConsumed, 'conservation of fuel holds');
  // The bought goods land in the held system (a scheduled delivery), and the sold goods
  // left the galaxy — both accounted for by the galactic-supply invariant above.
  assert.ok(getStock(s.guilds[0], DEST, GOOD) >= 0, 'the destination pile is well-formed');
});
