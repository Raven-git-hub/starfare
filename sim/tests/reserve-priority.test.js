'use strict';

// §5 "The distribution model — one pot with priority-ordered claimants" (Slice A,
// 10-08-26). Each tick, per good: pot = start-of-step reserve + fresh; the three
// claimants (Reserve ▲ / Production ▶ / Syndicate ▼) draw from the pot in the
// player's `order`. This file covers what the rewritten gates/refining tests don't:
// the reserve trend-arrow delta, the Syndicate drawing from the ACCUMULATED reserve
// (not just fresh), and priority deciding who reaches a tight pot first. Style
// follows recipe-ratio.test.js — controlled single-system scenarios, exact numbers.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { computeGalacticSupply } = require('../supply.js');
const { resolveProduction } = require('../production.js');

const SYS = 'sysA';
const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate, syndicateCommitment: commitment,
});
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);

function sysState({ ventures, profile = {}, stockpiles = {} }) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: Object.keys(stockpiles).length ? { [SYS]: stockpiles } : {},
      productionProfile: Object.keys(profile).length ? { [SYS]: profile } : {},
      ventures,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const goodOf = (s, good) => resolveProduction(s.guilds[0], SYS).goods[good];

// --- the reserve trend delta (the console's arrow) -----------------------------

test('reserveDelta reports this tick net reserve change: + when fresh outpaces the draw, - when the draw eats the pile', () => {
  // (A rate-based good only gets a `goods` entry when a claimant acts on it — a
  // consumer or a commitment; a pure-mine good with neither just piles up untracked.)
  //
  // Positive: titanium mined 10/tick feeds a titanium_alloy line wanting only 6
  // (rate 2). Consumers draw 6, so the reserve climbs by 10 - 6 = +4.
  let s = sysState({
    ventures: [mine('t', 'titanium', 10), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
  });
  assert.equal(goodOf(s, 'titanium').fork.downstream, 6, 'the line draws 6 ti (rate 2 * 3)');
  assert.equal(goodOf(s, 'titanium').reserveDelta, 4, 'fresh 10 - drawn 6 => +4');
  s = tick(s);
  assert.equal(held(s, 'titanium'), 4);
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // Negative: titanium mined only 5/tick but the line wants 6, with a pre-seeded pile
  // of 20 to draw from. The reserve falls by 6 - 5 = 1, so reserveDelta reads -1.
  const s2 = sysState({
    ventures: [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
    stockpiles: { titanium: 20 },
  });
  assert.equal(goodOf(s2, 'titanium').reserveDelta, -1, 'fresh 5 - drawn 6 => -1 (drawn from the pile)');
});

// --- the Syndicate draws from the accumulated reserve, not just fresh -----------

test('Syndicate claimant draws from the POT (reserve + fresh), delivering beyond this tick fresh', () => {
  // commitment 5 but fresh only 3, with a pre-seeded reserve of 10. Ranked first
  // (default order), the Syndicate draws min(5, pot=13) = 5 — the 2-unit shortfall
  // beyond fresh comes out of the reserve, which falls 10 -> 8.
  let s = sysState({
    ventures: [mine('t', 'titanium', 3, 5)],
    stockpiles: { titanium: 10 },
  });
  const before = computeGalacticSupply(s).resources.titanium; // 10 (the pile)
  const g = goodOf(s, 'titanium');
  assert.equal(g.pot, 13);
  assert.equal(g.fork.syndicate, 5, 'delivers the full commitment 5, drawing 2 from reserve');
  s = tick(s);
  assert.equal(held(s, 'titanium'), 8, 'reserve fell 10 + 3 fresh - 5 delivered = 8');
  assert.equal(before - computeGalacticSupply(s).resources.titanium, 2, 'galactic titanium net -2 (10 -> 8)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- priority decides who reaches a tight pot first ----------------------------

test('priority: Syndicate-first vs Production-first split a tight pot differently', () => {
  // titanium pot 6 (mine 6, no prior reserve), commitment 4, a titanium_alloy line
  // wanting 6 ti (rate 2). Carbon is plentiful. The pot (6) can't satisfy both the
  // commitment (4) and the consumer demand (6) — priority decides.
  const ventures = () => [mine('t', 'titanium', 6, 4), mine('c', 'carbon_products', 10), refinery('r', 'titanium_alloy', 2)];

  // Syndicate FIRST: it takes 4, leaving 2 for the consumer.
  const synFirst = sysState({
    ventures: ventures(),
    profile: { goods: { titanium: { order: ['syndicate', 'downstream', 'stockpile'] } } },
  });
  const gSyn = goodOf(synFirst, 'titanium');
  assert.equal(gSyn.fork.syndicate, 4, 'syndicate first takes its full commitment');
  assert.equal(gSyn.fork.downstream, 2, 'the consumer gets only the 2 left');

  // Production FIRST: the consumer takes its 6, leaving 0 for the syndicate.
  const prodFirst = sysState({
    ventures: ventures(),
    profile: { goods: { titanium: { order: ['downstream', 'syndicate', 'stockpile'] } } },
  });
  const gProd = goodOf(prodFirst, 'titanium');
  assert.equal(gProd.fork.downstream, 6, 'production first draws its full demand');
  assert.equal(gProd.fork.syndicate, 0, 'nothing left for the syndicate this tick');
});

// --- the reserve never goes below 0, under aggressive draws over a run ----------

test('non-negativity: an over-committed, over-consuming good never drives the reserve below 0', () => {
  // commitment 100 and a rate-100 consumer both hammering a mine of 5 with a small
  // pile — every tick the pot is emptied but never overdrawn; the reserve floors at 0.
  let s = sysState({
    ventures: [mine('t', 'titanium', 5, 100), mine('c', 'carbon_products', 100), refinery('r', 'titanium_alloy', 100)],
    stockpiles: { titanium: 7, carbon_products: 3 },
  });
  for (let i = 0; i < 15; i += 1) {
    s = tick(s);
    assert.ok(held(s, 'titanium') >= 0 && held(s, 'carbon_products') >= 0, 'reserves stay >= 0');
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

// --- determinism (invariant 9) with reserve level + commitment in play ----------

test('determinism: reserve level + commitment, run twice to tick 50, identical hash', () => {
  const build = () => {
    let s = sysState({
      ventures: [mine('t', 'titanium', 6, 3), mine('c', 'carbon_products', 6), refinery('r', 'titanium_alloy', 2)],
      profile: { goods: { titanium: { order: ['stockpile', 'downstream', 'syndicate'], reserveLevel: 4 } } },
      stockpiles: { titanium: 8 },
    });
    for (let i = 0; i < 50; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});
