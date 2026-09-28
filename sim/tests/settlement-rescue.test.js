'use strict';

// settlement-rescue.test.js — Slice A (licence system), design.md §5, both RULED 28-09-26:
//   1. THE SETTLEMENT-TIME STOCKPILE RESCUE. At a good's own settlement boundary (the day for
//      Tier 1/2, the week for a timed Tier-3 good), just before the met/breach verdict, a licence
//      that came up short is topped up from the guild's stockpile of that good:
//          topUp = min(shortfall, stock above the reserve floor)
//      Stock at or below the floor (`reserveLevel`) is never touched. Partial is allowed, and a
//      licence still short after it still breaches. Rescued units are PAID at the posted price
//      through the normal sale. Built in `settlementRescue` (sim/production.js, the plan) and
//      applyProduction (sim/tick.js, the move and the payment).
//   2. DISTRIBUTION CONTROLS ON A COMMITTED TIMED GOOD ARE REFUSED, not accepted and ignored.
//
// The named tripwires, in order:
//   (a) RESCUED TO MET — a short licence with stock above the floor is met, and paid at the posted
//       price for exactly the top-up units.
//   (b) THE FLOOR IS UNTOUCHABLE — a licence whose only spare is at or under the floor still
//       breaches, and not one unit below the floor moves.
//   (c) PARTIAL — too little spare: all of it goes, it is paid for, the guild keeps exactly its
//       floor, and the licence STILL breaches on what is left (here, one unit).
//   (d) A TIMED GOOD IS PAID ONCE — a Tier-3 rescue is a one-off sale of stockpiled units; the
//       week's progress payments are unchanged beside it.
//   (e) CONSERVATION — the units that left the stockpile are the units the Syndicate got, the
//       credits that arrived are the credits that left the ledger, and every invariant holds.
//   (f) THE REFUSAL — setProductionProfile refuses a send control or an order on a committed timed
//       good, and still accepts them on a Tier-1/2 good.
// Then the composition: the rescue follows the pursue order, runs only on a boundary, reaches every
// tier, is previewed exactly, halts without a price — and ISOLATION: runs with no shortfall, and
// runs whose shortfalls have no spare above the floor, reproduce the pre-slice engine (HEAD d12ba58)
// byte for byte, every tick.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { previewProduction } = require('../production.js');
const { getStock } = require('../stock.js');
const { getWindow } = require('../windows.js');
const { postedPrice } = require('../prices.js');
const { computeGalacticSupply } = require('../supply.js');
const { getRecipe } = require('../recipes.js');
const { MINE_BASELINE } = require('../baseline.js');

const SYS = 'sysA';
const GOOD = 'titanium';
const N = 4;                         // a four-tick day, so a boundary is never far away
const B = MINE_BASELINE[GOOD];       // the mine's baseline, units a tick
const Q = B * N;                     // a 100% licence owes one day of baseline
// The fixture's own numbers (test inputs, not game constants). The mine runs at twice its
// baseline and the Syndicate send is pinned to half the baseline, so the licence falls short by
// half its target, while the unsent output piles up in the stockpile.
const RATE = 2 * B;
const SEND = B / 2;
const DELIVERED_FRESH = SEND * N;    // what the send hands over by the boundary
const SHORT = Q - DELIVERED_FRESH;   // the shortfall the verdict sees before any rescue
const PILE = (RATE - SEND) * N;      // what the stockpile holds at the boundary, before any rescue

// --- fixtures ------------------------------------------------------------------------------------

function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id = 'g1') => s.guilds.find((g) => g.id === id);
const stock = (s, good = GOOD, id = 'g1') => getStock(guildOf(s, id), SYS, good);
const win = (s, good = GOOD, id = 'g1') => getWindow(guildOf(s, id), SYS, good);
// The window the NEXT tick will produce — the preview the snapshot carries.
const nextWindow = (s, good = GOOD, id = 'g1') => {
  const g = previewProduction(s).find((x) => x.guildId === id);
  return g.systems.find((x) => x.systemId === SYS).goods[good].window;
};
function runTo(s, t) { while (s.tick < t) s = tick(s); return s; }

// One guild, one licensed titanium mine, the send pinned short, and a reserve floor of `floor`.
// (`reserve: { reserveLevel: 0 }` below is the galaxy's FUEL reserve — an unrelated field that
// happens to share the name.)
function mineGalaxy({ floor = 0, send = SEND } = {}) {
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: RATE },
    ] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  return sign(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm', committedOutputPct: 1, windowDays: 7 }),
    createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: {
      [GOOD]: { syndicate: { mode: 'absolute', value: send }, ...(floor ? { reserveLevel: floor } : {}) },
    } }),
  ]);
}

// Everything the boundary tick moved, read off the state on either side of it.
function acrossTheBoundary(s) {
  const edge = runTo(s, N - 1);
  const price = postedPrice(edge, GOOD);   // the price the boundary tick sells at (already posted)
  const preview = nextWindow(edge);
  const after = tick(edge);
  const g0 = guildOf(edge);
  const g1 = guildOf(after);
  return {
    edge, after, price, preview,
    stockBefore: stock(edge), stockAfter: stock(after),
    fee: g1.lastLicenceFee.ventures.m,
    sale: g1.lastSyndicateSale.goods[GOOD],
    creditsDelta: g1.credits - g0.credits,
    ledgerDelta: after.syndicate.ledger - edge.syndicate.ledger,
    licence: g1.ventures.find((v) => v.id === 'm').licence,
  };
}

// --- (a) RESCUED TO MET ----------------------------------------------------------------------------

test('(a) RESCUED TO MET: a short licence with stock above the floor is topped up to its target and paid at the posted price for exactly the top-up', () => {
  const r = acrossTheBoundary(mineGalaxy());
  // The fixture really is short, and really has the stock.
  assert.ok(SHORT > 0 && PILE > SHORT, `short ${SHORT}, with ${PILE} piled up`);

  // Topped up by exactly the shortfall, so the verdict is MET and the discounted fee is charged.
  assert.equal(r.preview.rescued, SHORT, 'the preview of the boundary tick names the rescue');
  assert.equal(win(r.after).delivered, Q, 'the window closes with its whole target delivered');
  assert.deepEqual(r.fee, {
    status: 'met', owed: r.licence.discountedFee, basicFee: r.licence.basicFee, discountedFee: r.licence.discountedFee,
  });

  // The units came out of the stockpile: this tick's fresh output, less the send, less the top-up.
  assert.equal(r.stockAfter, r.stockBefore + (RATE - SEND) - SHORT);

  // Paid, at the posted price, for exactly the top-up units, beside the ordinary delivery. No
  // equity here, so the owner keeps the whole of each sale; each sale is rounded once.
  assert.equal(r.sale.units, SEND + SHORT, 'the sale record counts the fresh send AND the rescued units');
  assert.equal(r.sale.credited, Math.round(SEND * r.price) + Math.round(SHORT * r.price));
  assert.equal(r.creditsDelta, r.sale.credited - r.fee.owed, 'the guild is paid the sales and charged the met fee');
  assert.equal(r.ledgerDelta, -r.creditsDelta, 'the Syndicate ledger moved by the same number, the other way');
});

// --- (b) THE FLOOR IS UNTOUCHABLE ------------------------------------------------------------------

test('(b) THE FLOOR IS UNTOUCHABLE: stock at or under the reserve floor is never taken, so the licence still breaches', () => {
  // A floor exactly at the pile, and one above it: either way there is no stock ABOVE the floor.
  for (const floor of [PILE, PILE + 1, 10 * PILE]) {
    const r = acrossTheBoundary(mineGalaxy({ floor }));
    assert.equal(r.preview.rescued, undefined, `floor ${floor}: nothing to rescue, so no rescued key`);
    assert.equal(win(r.after).delivered, DELIVERED_FRESH, `floor ${floor}: only the fresh send was delivered`);
    assert.equal(r.stockAfter, PILE, `floor ${floor}: every unit of the pile is still there`);
    assert.deepEqual(r.fee, {
      status: 'breach', owed: r.licence.basicFee, basicFee: r.licence.basicFee, discountedFee: r.licence.discountedFee,
    }, `floor ${floor}: breach, full basic fee`);
    assert.equal(r.sale.units, SEND, `floor ${floor}: only the fresh send was sold`);
  }
  // One unit under the pile, and exactly one unit is above the floor: exactly one unit moves.
  const one = acrossTheBoundary(mineGalaxy({ floor: PILE - 1 }));
  assert.equal(one.preview.rescued, 1);
  assert.equal(one.stockAfter, PILE - 1, 'the floor itself is intact');
  assert.equal(one.fee.status, 'breach', 'one unit does not cover the shortfall');
});

// --- (c) PARTIAL -----------------------------------------------------------------------------------

test('(c) PARTIAL: spare below the shortfall is ALL delivered and paid for, the guild keeps exactly its floor, and the licence STILL breaches', () => {
  // Spare one unit short of the shortfall: the sharpest partial. Everything above the floor goes,
  // and the licence is still one unit short, so it breaches and pays the full basic fee.
  const floor = PILE - (SHORT - 1);
  const r = acrossTheBoundary(mineGalaxy({ floor }));
  assert.equal(r.preview.rescued, SHORT - 1, 'the Syndicate takes all the spare there is');
  assert.equal(r.stockAfter, floor, 'the guild is left with exactly its reserve floor');
  assert.equal(win(r.after).delivered, Q - 1, 'one unit short of the target');
  assert.deepEqual(r.fee, {
    status: 'breach', owed: r.licence.basicFee, basicFee: r.licence.basicFee, discountedFee: r.licence.discountedFee,
  }, 'the rescue never softens a real breach');
  // The partial delivery is still a real, paid delivery.
  assert.equal(r.sale.units, SEND + SHORT - 1);
  assert.equal(r.sale.credited, Math.round(SEND * r.price) + Math.round((SHORT - 1) * r.price));
  assert.equal(r.creditsDelta, r.sale.credited - r.licence.basicFee);
});

// --- (d) A TIMED GOOD IS PAID ONCE -----------------------------------------------------------------
//
// One committed fuel-tank factory (a 3-1 part: a unit every 15 ticks, y = 672 a week) commits
// X = 50 units but has inputs for only MADE = 30, so its week falls short by 20. It also holds
// HELD = 40 fuel tanks from earlier (units it made past a met week, never progress-paid). Two
// guilds in one galaxy, identical but for the reserve floor: `rescue` at 0 (the rescue can take
// the 20) and `held` at HELD (it cannot). Sharing the galaxy, they sell at one posted price.
const WEEK = 10080;
const T3 = { recipe: 'fuel_tank', good: 'fuel_tank', X: 50, MADE: 30, HELD: 40 };
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
let timedRun = null;
function runTimedWeek() {
  if (timedRun) return timedRun;
  const row = (id) => ({ id, credits: 0, fuelHoard: 0,
    stockpiles: { [SYS]: { ...inputSets(T3.recipe, T3.MADE), [T3.good]: T3.HELD } },
    ventures: [{ id: 'f', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: T3.recipe, productionRate: 5 }] });
  let s = createState({ guilds: [row('rescue'), row('held')], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  s = sign(s, [
    createApplyForLicenceAction({ guildId: 'rescue', ventureId: 'f', committedUnits: T3.X }),
    createApplyForLicenceAction({ guildId: 'held', ventureId: 'f', committedUnits: T3.X }),
    createSetProductionProfileAction({ guildId: 'held', systemId: SYS, goods: { [T3.good]: { reserveLevel: T3.HELD } } }),
  ]);
  const credits = { rescue: [], held: [] };
  let edge = null;
  while (s.tick < WEEK) {
    if (s.tick === WEEK - 1) edge = s;
    s = tick(s);
    for (const id of ['rescue', 'held']) credits[id].push(guildOf(s, id).credits);
  }
  timedRun = { edge, end: s, credits };
  return timedRun;
}

test('(d) A TIMED GOOD IS PAID ONCE: a Tier-3 rescue is a one-off sale of stockpiled units, on top of unchanged progress payments', () => {
  const { edge, end, credits } = runTimedWeek();
  const short = T3.X - T3.MADE;
  const price = postedPrice(edge, T3.good);   // the posted price the boundary tick sells at

  // Every tick of the week before its boundary is identical for the two guilds: the floor moves
  // nothing mid-week, and the progress payments (the committed share of each tick's work) match.
  assert.deepEqual(credits.rescue.slice(0, WEEK - 1), credits.held.slice(0, WEEK - 1));
  assert.ok(credits.rescue[WEEK - 2] > 0, 'the week\'s work really was progress-paid');
  assert.equal(win(edge, T3.good, 'rescue').delivered, T3.MADE, 'every unit made went Syndicate first');
  assert.equal(stock(edge, T3.good, 'rescue'), T3.HELD, 'the held units sat untouched all week');

  // On the boundary the floor-0 guild's week is topped up from its held units, and is MET.
  const rFee = guildOf(end, 'rescue').lastLicenceFee.ventures.f;
  const hFee = guildOf(end, 'held').lastLicenceFee.ventures.f;
  assert.equal(rFee.status, 'met');
  assert.equal(hFee.status, 'breach', 'with the held units behind the floor, the same week breaches');
  assert.equal(stock(end, T3.good, 'rescue'), T3.HELD - short, 'the rescue took exactly the shortfall');
  assert.equal(stock(end, T3.good, 'held'), T3.HELD, 'the floor kept every unit');

  // PAID ONCE. The factory has been idle since its 30th unit, so on the boundary tick there is no
  // progress payment and no fresh delivery: the boundary's one sale IS the rescue, and it is `short`
  // units at the posted price (no equity, so the owner keeps it all). The floored guild sells
  // nothing that tick. The rescued units attract no progress payment (the mid-week trace above is
  // identical), so the whole difference on the boundary is that sale plus the met fee discount.
  const rSale = guildOf(end, 'rescue').lastSyndicateSale;
  assert.equal(rSale.tick, WEEK);
  assert.deepEqual(rSale.goods[T3.good], { units: short, price, credited: Math.round(short * price) });
  assert.notEqual(guildOf(end, 'held').lastSyndicateSale.tick, WEEK, 'no sale on the floored guild\'s boundary');
  const boundaryDelta = (id) => credits[id][WEEK - 1] - credits[id][WEEK - 2];
  assert.equal(boundaryDelta('rescue') - boundaryDelta('held'),
    Math.round(short * price) + (hFee.owed - rFee.owed), 'the rescue sale plus the fee discount, and nothing else');
});

// --- (e) CONSERVATION ------------------------------------------------------------------------------

test('(e) CONSERVATION: the units that left the stockpile are the units the Syndicate got, the credits balance, and every invariant holds', () => {
  let s = mineGalaxy();
  for (let t = 1; t <= 3 * N; t += 1) {
    const before = s;
    const galBefore = computeGalacticSupply(before).resources[GOOD];
    const rescued = nextWindow(before).rescued || 0;
    s = tick(before);
    assert.deepEqual(checkInvariants(s, s.tick), [], `invariants at tick ${s.tick}`);

    // Goods: this tick's output went in; the send and the rescue went to the Syndicate (a sink).
    const delivered = win(s).delivered - (s.tick % N === 1 ? 0 : win(before).delivered);
    assert.equal(stock(s) - stock(before), RATE - delivered, `tick ${s.tick}: stock moved by output minus delivery`);
    assert.equal(galBefore + RATE - computeGalacticSupply(s).resources[GOOD], delivered, `tick ${s.tick}: the galaxy lost exactly what was delivered`);
    if (s.tick % N === 0) assert.equal(rescued, SHORT, `tick ${s.tick}: each boundary rescues the shortfall`);
    else assert.equal(rescued, 0, `tick ${s.tick}: no rescue off the boundary`);

    // Credits: what the guild gained, the ledger lost (a sale), and vice versa (a fee).
    assert.equal(guildOf(s).credits + s.syndicate.ledger, guildOf(before).credits + before.syndicate.ledger,
      `tick ${s.tick}: credits only moved between the guild and the ledger`);
  }
});

// --- (f) THE REFUSAL -------------------------------------------------------------------------------

test('(f) THE REFUSAL: a send control or an order on a COMMITTED TIMED good is refused by name; a Tier-1/2 good still takes both', () => {
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 'f', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'fuel_tank', productionRate: 5 },
      { id: 'h', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'hull_plating', productionRate: 5 },
      { id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: RATE },
    ] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N * 360,   // a day the week nests in
  });
  s = sign(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'f', committedUnits: 50 }),
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm', committedOutputPct: 0.5, windowDays: 7 }),
  ]);
  const set = (good, policy) => intake(s, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [good]: policy } })]);
  const SEND_CONTROL = { syndicate: { mode: 'absolute', value: 3 } };
  const ORDER = { order: ['stockpile', 'downstream', 'syndicate'] };

  // Refused on the committed timed good — each field, by name, naming the committing venture —
  // and the state is untouched.
  for (const [field, policy] of [['syndicate', SEND_CONTROL], ['order', ORDER]]) {
    const out = set('fuel_tank', policy);
    assert.equal(out.results[0].accepted, false, `${field} on a committed timed good is refused`);
    assert.match(out.results[0].reason, new RegExp(`^${field} for good "fuel_tank" is refused: venture "f" commits it`));
    assert.equal(hashState(out.state), hashState(s), 'a refusal changes nothing');
  }
  // Still accepted: the same fields on a committed Tier-1 good (unchanged)...
  assert.equal(set(GOOD, SEND_CONTROL).results[0].accepted, true, 'a Tier-1 send control');
  assert.equal(set(GOOD, ORDER).results[0].accepted, true, 'a Tier-1 order');
  // ...the reserve floor (the field the rescue respects) and a pursue ranking on the timed good...
  assert.equal(set('fuel_tank', { reserveLevel: 5 }).results[0].accepted, true, 'the reserve floor on a timed good');
  assert.equal(set('fuel_tank', { pursue: ['f'] }).results[0].accepted, true, 'a pursue ranking on a timed good');
  // ...a CLEAR (null), which stores nothing and removes a stale value...
  assert.equal(set('fuel_tank', { syndicate: null, order: null }).results[0].accepted, true, 'clearing both to their defaults');
  // ...and a timed good that nobody here commits (hull plating is made, but not licensed).
  assert.equal(set('hull_plating', SEND_CONTROL).results[0].accepted, true, 'an uncommitted timed good is not refused');
});

// --- the composition -------------------------------------------------------------------------------

test('THE PURSUE ORDER: two short licences sharing one pile of spare are topped up in the player\'s pursue order — the same order the verdict fills in', () => {
  // Two titanium mines, each licensed for a full day of baseline. The send hands over only one
  // mine's worth of half a day, so the fill leaves the first-ranked licence half-met and the second
  // with nothing. The floor leaves spare for the first one's shortfall plus a sliver.
  const build = (pursue) => {
    let s = createState({
      guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
        { id: 'a', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: B },
        { id: 'b', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: B },
      ] }],
      reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
    });
    const pile = (2 * B - SEND) * N;              // both mines' output, less the send
    const spare = SHORT + 7;                      // the first-ranked licence's shortfall, and 7 more
    return sign(s, [
      createApplyForLicenceAction({ guildId: 'g1', ventureId: 'a', committedOutputPct: 1, windowDays: 7 }),
      createApplyForLicenceAction({ guildId: 'g1', ventureId: 'b', committedOutputPct: 1, windowDays: 7 }),
      createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: {
        [GOOD]: { syndicate: { mode: 'absolute', value: SEND }, reserveLevel: pile - spare, pursue },
      } }),
    ]);
  };
  for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
    const s = tick(runTo(build([first, second]), N - 1));
    const rows = guildOf(s).lastLicenceFee.ventures;
    assert.equal(rows[first].status, 'met', `${first}, ranked first, is topped up to its target`);
    assert.equal(rows[second].status, 'breach', `${second}, ranked second, gets only the sliver and breaches`);
    assert.equal(win(s).delivered, DELIVERED_FRESH + SHORT + 7, 'the whole spare was delivered');
  }
});

test('ONLY ON THE BOUNDARY: a licence that is short mid-window, with stock to spare, is not touched until its window closes', () => {
  let s = mineGalaxy();
  for (let t = 1; t < N; t += 1) {
    assert.equal(nextWindow(s).rescued, undefined, `tick ${t}: no rescue before the boundary`);
    const before = stock(s);
    s = tick(s);
    assert.equal(stock(s) - before, RATE - SEND, `tick ${t}: the pile only grows`);
  }
  assert.equal(nextWindow(s).rescued, SHORT, 'the boundary tick rescues');
});

test('EVERY TIER: a short Tier-2 factory licence is rescued from its alloy stock the same way', () => {
  // A titanium-alloy factory fed at full rate, licensed for 100% of its baseline, with its send
  // pinned at 1 a tick and 40 alloy already in stock.
  const FACTORY_Q = 5 * N;   // REFINERY_BASELINE 5 batches a tick × 1 alloy each, over one day
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { titanium_alloy: 40 } }, ventures: [
      { id: 'tm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 15 },
      { id: 'cm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'carbon_products', productionRate: 5 },
      { id: 'fa', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'titanium_alloy', productionRate: 5 },
    ] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  s = sign(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'fa', committedOutputPct: 1, windowDays: 7 }),
    createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { titanium_alloy: { syndicate: { mode: 'absolute', value: 1 } } } }),
  ]);
  s = runTo(s, N - 1);
  const pv = nextWindow(s, 'titanium_alloy');
  assert.equal(pv.rescued, FACTORY_Q - N, 'topped up by the shortfall (target less the 1-a-tick send)');
  s = tick(s);
  assert.equal(guildOf(s).lastLicenceFee.ventures.fa.status, 'met');
  assert.equal(win(s, 'titanium_alloy').delivered, FACTORY_Q);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('PREVIEW = TICK: the snapshot\'s preview of the boundary names the rescue, and the tick moves exactly that many units', () => {
  const edge = runTo(mineGalaxy(), N - 1);
  const snapWindow = buildSnapshot(edge).production[0].systems[0].goods[GOOD].window;
  assert.equal(snapWindow.rescued, SHORT);
  assert.equal(snapWindow.status, 'met', 'the preview already reads the rescued verdict');
  const after = tick(edge);
  assert.equal(stock(after) - stock(edge), (RATE - SEND) - snapWindow.rescued);
  assert.equal(win(after).delivered, snapWindow.delivered);
});

test('NO PRICE, NO HAND-OVER: a rescue with no posted price halts, naming the tick, instead of handing the units over for nothing', () => {
  // The send is 0, so on the boundary only the rescue would deliver anything.
  const edge = runTo(mineGalaxy({ send: 0 }), N - 1);
  delete edge.prices[GOOD];
  assert.throws(() => tick(edge), /settlement rescue would deliver 640 titanium to the Syndicate at tick 4 but the good has no posted price/);
});

// --- ISOLATION: the pre-slice engine's bytes ---------------------------------------------------------
//
// Two runs on a 60-tick day. Each runs 700 ticks (eleven day boundaries), then jumps the quiet stretch
// to 180 ticks before the week's end (the pattern tier3-contract.test.js uses) and runs on 300 more,
// through three more day boundaries, the Tier-3 WEEK boundary, and two after. Every tick's state is
// hashed, and the snapshot at every day boundary. The hashes were computed on the pre-slice engine
// (HEAD d12ba58) by the build session and pinned here: the new engine must reproduce them.
//   NO SHORTFALL — one guild whose three licences (a Tier-1 mine, a Tier-2 factory, a Tier-3
//     factory) all meet on their own delivery, while it holds spare stock of every committed good
//     above its floor of 0. Stock on hand, with nothing short, is never touched.
//   SHORT, NO SPARE — every licence falls short. `held` has stock of every committed good, all of it
//     behind a reserve floor; `bare` sends its whole output and so never has any stock to take.
//     Every verdict still breaches, exactly as it did before this slice.
// The met/breach counts are pinned too, so each run is known to be the case it claims to be.
const ISO_DAY = 60;
const ISO_JUMP_TO = WEEK - 180;
function isolationRun(rows, actions) {
  let s = createState({ guilds: rows, reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: ISO_DAY });
  s = sign(s, actions);
  const everyTick = crypto.createHash('sha256');
  const snapshots = crypto.createHash('sha256');
  const verdicts = { met: 0, breach: 0 };
  const step = () => {
    s = tick(s);
    everyTick.update(hashState(s));
    if (s.tick % ISO_DAY !== 0) return;
    snapshots.update(hashState(buildSnapshot(s)));
    for (const g of s.guilds) {
      const fee = g.lastLicenceFee;
      if (fee && fee.tick === s.tick) for (const row of Object.values(fee.ventures)) verdicts[row.status] += 1;
    }
  };
  for (let i = 0; i < 700; i += 1) step();
  s.tick = ISO_JUMP_TO;
  for (let i = 0; i < 300; i += 1) step();
  return { final: hashState(s), everyTick: everyTick.digest('hex'), snapshots: snapshots.digest('hex'), verdicts };
}
// A guild with a Tier-1 titanium mine, a Tier-2 titanium-alloy factory (fed by the mine and a carbon
// mine) and a Tier-3 fuel-tank factory, each licensed: half of the mine's and the factory's baseline,
// and 20 fuel tanks a week. `stockpile` is its starting pile; `goods` its profile (sends, floors).
function isoGuild(id, stockpile, goods) {
  return { id, credits: 0, fuelHoard: 0, stockpiles: { [SYS]: stockpile },
    ventures: [
      { id: 'tm', ownerGuildId: id, type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 400 },
      { id: 'cm', ownerGuildId: id, type: 'mining', systemId: SYS, resourceType: 'carbon_products', productionRate: 10 },
      { id: 'fa', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: 'titanium_alloy', productionRate: 5 },
      { id: 'ft', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: 'fuel_tank', productionRate: 5 },
    ],
    ...(goods ? { productionProfile: { [SYS]: { goods } } } : {}) };
}
const isoLicences = (id) => [
  createApplyForLicenceAction({ guildId: id, ventureId: 'tm', committedOutputPct: 0.5, windowDays: 7 }),
  createApplyForLicenceAction({ guildId: id, ventureId: 'fa', committedOutputPct: 0.5, windowDays: 7 }),
  createApplyForLicenceAction({ guildId: id, ventureId: 'ft', committedUnits: 20 }),
];
// A floor above anything the `held` guild can pile up (a test input, not a game number).
const HOLD_THE_PILE = Number.MAX_SAFE_INTEGER;
function noShortfall() {
  // Default sends; plenty of every input (60 fuel tanks' worth against a commitment of 20); and a
  // starting pile of each committed good, all of it above the default floor of 0.
  return isolationRun(
    [isoGuild('fed', { ...inputSets('fuel_tank', 60), titanium: 500, titanium_alloy: 50, fuel_tank: 25 })],
    isoLicences('fed'));
}
function shortNoSpare() {
  const floor = { reserveLevel: HOLD_THE_PILE };
  return isolationRun([
    // Sends pinned at 1 a tick (far under target), inputs for only 5 fuel tanks against 20, and the
    // same starting pile — every unit of it behind the floor.
    isoGuild('held', { ...inputSets('fuel_tank', 5), titanium: 500, titanium_alloy: 50, fuel_tank: 25 }, {
      titanium: { syndicate: { mode: 'absolute', value: 1 }, ...floor },
      titanium_alloy: { syndicate: { mode: 'absolute', value: 1 }, ...floor },
      fuel_tank: floor,
    }),
    // A titanium mine under its baseline, licensed for all of it, sending 100% of what it makes:
    // it is short every day and never holds a unit, so at the default floor of 0 there is nothing
    // to take.
    { id: 'bare', credits: 0, fuelHoard: 0, stockpiles: {},
      ventures: [{ id: 'm', ownerGuildId: 'bare', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 100 }],
      productionProfile: { [SYS]: { goods: { titanium: { syndicate: { mode: 'percent', value: 100 } } } } } },
  ], [...isoLicences('held'),
    createApplyForLicenceAction({ guildId: 'bare', ventureId: 'm', committedOutputPct: 1, windowDays: 7 })]);
}
// The verdict counts: 11 day boundaries before the jump, for each Tier-1/2 licence, plus the one
// Tier-3 week. The jump carries the Tier-1/2 licences past their renegotiation deadlines, so the
// auto-lapse step retires them and only the Tier-3 licence is judged after it. No shortfall: 11 × 2
// + 1 = 23, all met. Short, no spare: 11 × 3 (held's two, bare's one) + 1 = 34, all breached.
const ISO_NO_SHORTFALL = {
  final: '670451a841a79fa6c20c4b13041403751162018af300be2077b0dd7f77377ddf',
  everyTick: '590f3458c101bbd9cbe8c68328d2960d177995df527c46d81f9d9fefc29239ae',
  snapshots: '4ddd45b9b6556c7a26bdfb7b3a06855108fdf564dab146456f163e8619485acb',
  verdicts: { met: 23, breach: 0 },
};
const ISO_SHORT_NO_SPARE = {
  final: '21e2423c6386849be718a9efb445551027eeeaa32dbeda8f1382057e3c08c33a',
  everyTick: '228e8fa513eda998b839fca94ac88f3df82dde6f5576574c3e4fc2790b878846',
  snapshots: '8c38052457ebccda5bcb321bd481352c8af8dd14a4a20eac798388310f2a5ce8',
  verdicts: { met: 0, breach: 34 },
};

test('ISOLATION: a run with no shortfall, and a run whose shortfalls have no stock above the floor, reproduce the pre-slice engine byte for byte, every tick', () => {
  const a = noShortfall();
  const b = shortNoSpare();
  if (process.env.PRINT_ISO_PINS) console.log('ISO_PINS', JSON.stringify({ a, b }));
  assert.deepEqual(a, ISO_NO_SHORTFALL);
  assert.deepEqual(b, ISO_SHORT_NO_SPARE);
});
