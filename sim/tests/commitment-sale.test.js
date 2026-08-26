'use strict';

// commitment-sale.test.js — licence Slice 3a: a committed delivery is a SALE
// (docs/licence-and-price-system.md Part 2; design.md §5 "Output commitment").
//
// The mechanical tripwires: the sale pays, the equity share splits it, the price used
// is the POSTED (lagged) one, credit conservation holds to the credit, an unlicensed
// galaxy moves nothing at all — and the whole thing is deterministic.
//
// Deliberately NOT tested here because it deliberately does not exist yet: the licence
// FEE, the breach charge, reputation, and any payment to an investor.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { intake, createEstablishVentureAction, createSetSyndicateCommitmentAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { BASE_PRICE } = require('../prices.js');
const { EQUITY_CEILING, equityOf, ownerFraction, commitmentSale, isValidEquityPct } = require('../licence.js');

const SYS = 'sysA';

// A seatless synthetic mine, as the other engine tests build them. `equityPct` is
// passed through createVenture, so a 0 offer leaves no key on the venture at all.
const mine = (id, good, rate, commitment = 0, equityPct = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good,
  productionRate: rate, syndicateCommitment: commitment, equityPct,
});

function sysState(ventures, { windowN = 2, credits = 0, ledger = 0 } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger },
    windowN,
  });
}

const guild = (s) => s.guilds[0];
const delivered = (s) => (guild(s).syndicateWindows[SYS].titanium.delivered);

// --- 1. the sale pays -----------------------------------------------------------

test('a committed delivery pays the guild and debits the Syndicate ledger, to the credit', () => {
  // Commitment 4 over a 2-tick window with a rate-10 mine: 2 units paced per tick.
  // The posted price is the seeded base at these ticks (the 2-tick publish lag).
  let s = sysState([mine('t', 'titanium', 10, 4)]);
  const before = { credits: guild(s).credits, ledger: s.syndicate.ledger };

  s = tick(s);
  const units = delivered(s);
  assert.ok(units > 0, 'the fixture really does deliver');
  const expected = Math.round(units * BASE_PRICE); // o = 0 ⇒ the owner keeps all of it

  assert.equal(guild(s).credits - before.credits, expected, 'the guild was paid for what it delivered');
  assert.equal(before.ledger - s.syndicate.ledger, expected, 'and the Syndicate paid exactly that');
  assert.equal(guild(s).credits + s.syndicate.ledger, before.credits + before.ledger,
    'credit conservation (invariant 2): the sale MOVES credits, it does not mint them');
  assert.ok(Number.isInteger(guild(s).credits), 'integer credits (§15.2)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the sale is recorded on the guild, stamped with the tick it happened on', () => {
  let s = sysState([mine('t', 'titanium', 10, 4)]);
  s = tick(s);
  const sale = guild(s).lastSyndicateSale;
  assert.equal(sale.tick, s.tick, 'stamped with the producing tick — no off-by-one for a reader');
  assert.equal(sale.credited, guild(s).credits, 'the record matches what was actually paid');
  assert.equal(sale.goods.titanium.units, delivered(s));
  assert.equal(sale.goods.titanium.price, BASE_PRICE);
  assert.equal(sale.goods.titanium.credited, sale.credited);
});

// --- 2. the equity split ---------------------------------------------------------

test('with o = 0 the owner keeps the whole proceeds', () => {
  let s = sysState([mine('t', 'titanium', 10, 4, 0)]);
  assert.equal('equityPct' in guild(s).ventures[0], false, 'a zero offer leaves no key on the venture');
  s = tick(s);
  assert.equal(guild(s).credits, Math.round(delivered(s) * BASE_PRICE));
});

test('with o = 0.4 the owner keeps 60% and the ledger keeps the rest', () => {
  const OFFER = 0.4;
  let plain = sysState([mine('t', 'titanium', 10, 4, 0)]);
  let offered = sysState([mine('t', 'titanium', 10, 4, OFFER)]);
  plain = tick(plain);
  offered = tick(offered);

  assert.equal(delivered(plain), delivered(offered), 'identical deliveries — only the terms differ');
  const gross = delivered(plain) * BASE_PRICE;
  assert.equal(guild(offered).credits, Math.round((1 - OFFER) * gross), 'the owner keeps (1 − o)');
  assert.ok(guild(offered).credits < guild(plain).credits, 'offering equity really costs the owner');

  // The forfeited share is NOT paid to anyone — no investor exists — so it simply never
  // leaves the ledger: the ledger's debit is smaller by exactly the owner's shortfall.
  const kept = guild(plain).credits - guild(offered).credits;
  assert.equal(offered.syndicate.ledger - plain.syndicate.ledger, kept, 'the o share stays in the Syndicate ledger');
  assert.equal(guild(offered).credits + offered.syndicate.ledger, 0, 'conservation holds regardless of the split');
  assert.deepEqual(checkInvariants(offered, offered.tick), []);
});

test('no investor receives anything — nobody else’s credits move', () => {
  // A second guild, present and uninvolved. Slice 5 gives it a way to buy in; today an
  // offered share is forfeited to the ledger, never routed to another guild.
  const s0 = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard: 0, ventures: [mine('t', 'titanium', 10, 4, 0.4)] },
      { id: 'g2', credits: 500, fuelHoard: 0, ventures: [] },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: 2,
  });
  const s = tick(s0);
  assert.equal(s.guilds[1].credits, 500, 'the bystander guild is untouched');
  assert.equal(s.guilds[1].lastSyndicateSale, undefined, 'and has no sale record');
});

test('the split is commitment-weighted when two ventures offer different equity', () => {
  // Both mines commit equally, one at o = 0 and one at o = 0.4, so the good's proceeds
  // split half at 100% and half at 60% ⇒ 80% to the owner overall.
  const ventures = [mine('a', 'titanium', 10, 4, 0), mine('b', 'titanium', 10, 4, 0.4)];
  assert.equal(ownerFraction(ventures, 'titanium'), 0.8);
  assert.equal(commitmentSale({ ventures, good: 'titanium', delivered: 10, price: 10 }).ownerCredits, 80);

  let s = sysState(ventures);
  s = tick(s);
  assert.equal(guild(s).credits, Math.round(0.8 * delivered(s) * BASE_PRICE));
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. no commitment, no credits -------------------------------------------------

test('an unlicensed venture moves no credits at all', () => {
  let s = sysState([mine('t', 'titanium', 10, 0)], { credits: 120, ledger: -120 });
  for (let i = 0; i < 10; i += 1) s = tick(s);
  assert.equal(guild(s).credits, 120, 'not one credit earned');
  assert.equal(s.syndicate.ledger, -120, 'and the ledger never moved');
  assert.equal(guild(s).lastSyndicateSale, undefined, 'no sale record is created');
  assert.ok(guild(s).stockpiles[SYS].titanium > 0, 'it did produce — it just sold nothing');
});

test('NO-OP PROOF: a commitment-free boot+tick is hash-identical run twice, and moves no credits', () => {
  const run = () => {
    let s = createZeroState();
    for (let i = 0; i < 5; i += 1) s = advance(s, []).state;
    return s;
  };
  const a = run();
  const b = run();
  assert.equal(hashState(a), hashState(b), 'determinism (invariant 9)');
  assert.equal(a.syndicate.ledger, 0, 'the zero-state ledger is untouched by a slice that only pays on delivery');
  assert.deepEqual(checkInvariants(a, a.tick), []);
});

// --- 4. it uses the POSTED (lagged) price -----------------------------------------

test('the sale executes at the POSTED price, not at a freshly-computed one', () => {
  // Pin the posted price to something no recompute would produce, leaving the pipeline
  // (the un-published values) at base. If the sale used anything but `posted`, the
  // credits would come out at the base price instead.
  const PINNED = 37;
  let s = sysState([mine('t', 'titanium', 10, 4)]);
  s.prices.titanium.posted = PINNED;
  assert.notEqual(s.prices.titanium.pending[1], PINNED, 'the leading value is deliberately different');

  s = tick(s);
  assert.equal(guild(s).credits, Math.round(delivered(s) * PINNED), 'paid at the posted price');
  assert.equal(guild(s).lastSyndicateSale.goods.titanium.price, PINNED);
});

test('the price a sale pays was fixed two ticks earlier — the lag is what makes it knowable', () => {
  // Run until the posted price has actually moved off base, then check the sale used the
  // value posted at that moment (which the engine computed two ticks before).
  // A commitment big enough to keep delivering all window (100 over 50 ticks ⇒ a paced
  // 2/tick), so there is still a sale to inspect once the price has moved.
  let s = sysState([mine('t', 'titanium', 10, 100)], { windowN: 50 });
  for (let i = 0; i < 6; i += 1) s = tick(s);
  const postedNow = s.prices.titanium.posted;
  assert.notEqual(postedNow, BASE_PRICE, 'the price has moved off base by now');

  const creditsBefore = guild(s).credits;
  const next = tick(s);
  const soldUnits = next.guilds[0].lastSyndicateSale.goods.titanium.units;
  assert.equal(next.guilds[0].lastSyndicateSale.goods.titanium.price, postedNow,
    'the sale used the price that was ALREADY posted when the tick began');
  assert.equal(guild(next).credits - creditsBefore, Math.round(soldUnits * postedNow));
});

test('a delivery with no posted price halts loudly rather than handing goods over for nothing', () => {
  const s = sysState([mine('t', 'titanium', 10, 4)]);
  delete s.prices.titanium;
  assert.throws(() => tick(s), /no posted price/);
});

// --- 5. determinism, integers, and the terms themselves ---------------------------

test('determinism (invariant 9): a committed, equity-split run is byte-identical run twice', () => {
  const build = () => {
    let s = sysState([mine('a', 'titanium', 7, 3, 0.25), mine('b', 'titanium', 5, 2, 0)], { windowN: 3 });
    for (let i = 0; i < 20; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

test('every credit figure stays an integer through a long fractional-equity run', () => {
  // o = 0.33 on an odd commitment guarantees fractional gross proceeds every tick.
  let s = sysState([mine('t', 'titanium', 7, 3, 0.33)], { windowN: 3 });
  for (let i = 0; i < 30; i += 1) {
    s = tick(s);
    assert.ok(Number.isInteger(guild(s).credits), `tick ${s.tick}: credits must stay whole`);
    assert.ok(Number.isInteger(s.syndicate.ledger), `tick ${s.tick}: the ledger must stay whole`);
    assert.equal(guild(s).credits + s.syndicate.ledger, 0, `tick ${s.tick}: conservation holds every tick`);
  }
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the equity ceiling is §5’s 49%, and an offer above it is refused, not clamped', () => {
  assert.equal(EQUITY_CEILING, 0.49);
  assert.equal(isValidEquityPct(0), true);
  assert.equal(isValidEquityPct(0.49), true);
  assert.equal(isValidEquityPct(0.5), false);
  assert.equal(isValidEquityPct(-0.1), false);
  assert.equal(isValidEquityPct('0.2'), false);
  assert.equal(equityOf({}), 0, 'an absent offer reads as none');
});

test('establishVenture carries a valid equity offer and refuses an invalid one', () => {
  const found = {
    type: 'foundGuild', guildId: 'g1', name: 'G1', credits: 0, influence: 0, homeSystemId: 'sys_0002', ventures: [],
  };
  let s = createZeroState();
  ({ state: s } = intake(s, [found]));

  const ok = createEstablishVentureAction({
    guildId: 'g1', ventureId: 'm1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5, equityPct: 0.25,
  });
  const tooMuch = createEstablishVentureAction({
    guildId: 'g1', ventureId: 'm2', siteId: 'pl_00004_n02', resourceType: 'titanium', productionRate: 5, equityPct: 0.8,
  });
  const { state: after, results } = intake(s, [ok, tooMuch]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /equityPct/);
  assert.equal(after.guilds[0].ventures[0].equityPct, 0.25, 'the accepted offer is stored exactly as agreed');
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

test('an out-of-range equity built directly into state trips the tripwire', () => {
  const s = sysState([mine('t', 'titanium', 10, 4, 0)]);
  s.guilds[0].ventures[0].equityPct = 0.8;
  assert.equal(checkInvariants(s, s.tick).length, 1, 'the establish action is not the only guard');
});

test('a tampered sale record trips the tripwire', () => {
  let s = sysState([mine('t', 'titanium', 10, 4)]);
  s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s.guilds[0].lastSyndicateSale.credited += 1; // a total the ledger never moved
  assert.equal(checkInvariants(s, s.tick).length, 1);
});

// --- the snapshot surface ---------------------------------------------------------

test('the snapshot reports the sale, whether it is this tick’s, and the equity offer', () => {
  let s = sysState([mine('t', 'titanium', 10, 4, 0.25)]);
  s = tick(s);
  const snap = buildSnapshot(s);
  const row = snap.guilds[0];
  assert.equal(row.syndicateSale.credited, s.guilds[0].credits);
  assert.equal(row.syndicateSale.thisTick, true, 'the engine answers "did this happen now?"');
  assert.equal(row.syndicateSale.goods.titanium.units, delivered(s));
  assert.equal(snap.ventures[0].equityPct, 0.25);

  // Tick past the window's end with nothing more delivered and the record goes stale —
  // reported honestly as not-this-tick rather than quietly repeated as new income.
  let later = s;
  later.guilds[0].ventures[0].syndicateCommitment = 0;
  later = tick(later);
  later = tick(later);
  assert.equal(buildSnapshot(later).guilds[0].syndicateSale.thisTick, false);
});

test('an unlicensed guild reports no sale at all', () => {
  const snap = buildSnapshot(sysState([mine('t', 'titanium', 10, 0)]));
  assert.equal(snap.guilds[0].syndicateSale, null);
  assert.equal(snap.ventures[0].equityPct, 0);
});
