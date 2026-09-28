'use strict';

// tier3-payment.test.js — Slice 3d of the Tier-3 economy build: the PER-TICK PROGRESS PAYMENT for a
// committed timed good (docs/tier3-timed-production.md "Income & commitment").
//
// The rule, each tick, for a factory making a committed timed (Tier-3) good:
//     paid = the committed share of the work done this tick, valued at this tick's posted price
//          = (1 − o) × (x / y) × (1 ÷ TICKS_PER_UNIT) × price      (0 on a tick with no unit on the line)
// in whole credits, the sub-credit remainder carried to the next tick. The unit the work completes
// is still delivered Syndicate-first (Slice 3b, unchanged), but its delivery credits NOTHING: it
// arrives already paid. Tier-1/2 goods keep the delivery-basis sale exactly as before.
//
// What this file proves, in order:
//   1. HEADLINE: a committed factory running gapless is paid on EVERY tick, each tick within one
//      credit of that tick's committed work — not a lump when a unit lands and nothing between.
//   2. THE RULE, TICK BY TICK, for every guild: what was paid, what was carried, and that the
//      credits the guild gained are exactly the progress payment (the delivery adds nothing).
//   3. THE TOTAL: over a met week the guild receives x units' worth at the week's prices — paid
//      ONCE. At a steady price that is exactly what the delivery-basis sale paid (the same income,
//      re-timed); it is never ~2×.
//   4. A STALLED line pays 0 for every tick it is stalled, owes nothing for the gap, claws nothing
//      back, and is paid again the tick it restarts.
//   5. Equity, an uncommitted factory, the sale record, the carry's tripwires, an impossible `x`.
//   6. DETERMINISM and ISOLATION: Tier-1/2 committed goods reproduce the pre-slice engine's bytes
//      (hashes computed on HEAD 4a0a651 and pinned), beside committed Tier-3 guilds.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createState, createVenture } = require('../state.js');
const { tick } = require('../tick.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { getRecipe } = require('../recipes.js');
const { getStock } = require('../stock.js');
const { getWindow } = require('../windows.js');
const { postedPrice } = require('../prices.js');

const SYS = 'sysA';
const WEEK = 10080;   // docs/tier3-timed-production.md: "exactly one 7-day window (10,080 ticks)"

const factory = (id, ownerGuildId, recipeId, extra = {}) => ({
  id, ownerGuildId, type: 'refining', systemId: SYS, recipeId, productionRate: 5, ...extra,
});
const mine = (id, ownerGuildId, good, productionRate) => ({
  id, ownerGuildId, type: 'mining', systemId: SYS, resourceType: good, productionRate,
});
// `n` whole input sets for a recipe, as a stockpile map.
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
function addInputSets(s, guildId, recipeId, n) {
  const pile = s.guilds.find((g) => g.id === guildId).stockpiles[SYS];
  for (const [good, qty] of Object.entries(inputSets(recipeId, n))) pile[good] = (pile[good] || 0) + qty;
}
// A Tier-3 licence (Slice 3c): `x` whole units of the weekly output.
const commitUnits = (guildId, ventureId, committedUnits) => createApplyForLicenceAction({
  guildId, ventureId, committedUnits,
});
const commitPct = (guildId, ventureId, committedOutputPct, windowDays) => createApplyForLicenceAction({
  guildId, ventureId, committedOutputPct, windowDays,
});
function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `licence refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const ventureOf = (s, gid, vid) => guildOf(s, gid).ventures.find((v) => v.id === vid);

// --- THE SHARED WEEK ------------------------------------------------------------------------------
//
// One galaxy, one week, one guild per case, each running ONE factory. Each case makes its own good
// where that matters, so its price is under control: a good nobody stockpiles stays at its base
// price all week, while fuel tanks (half of `even`'s output, and `stall`'s) pile up and their
// price climbs. `T` is the ruled timer (1 tick = 1 min): 15 for a 3-1 part, 2,880 for a heavy
// reactor engine. `y = 10,080 ÷ T` is the weekly output: 672 for a 3-1 part, 3.5 for the engine.
//   even    fuel tanks,     x = 336 of 672     → paid every tick; the price rises as its 336 pile up
//   full    hull plating,   x = 672 of 672     → every unit goes to the Syndicate; price flat at 100
//   heavy   heavy engine,   x = 3 of 3.5       → a specialist; price flat at 20M
//   equity  power cells,    x = 336, o = 0.4   → the owner keeps 60% of what its work earns
//   stall   fuel tanks,     x = 336, inputs for 100 units, 60 more added on tick 6,000
//   free    cargo modules,  UNLICENSED         → never paid, every unit its own
const CASES = {
  even: { recipe: 'fuel_tank', T: 15, x: 336, sets: 700 },
  full: { recipe: 'hull_plating', T: 15, x: 672, sets: 700 },
  heavy: { recipe: 'heavy_reactor_engine', T: 2880, x: 3, sets: 4 },
  equity: { recipe: 'power_cells', T: 15, x: 336, sets: 700, equityPct: 0.4 },
  stall: { recipe: 'fuel_tank', T: 15, x: 336, sets: 100 },
  free: { recipe: 'cargo_module', T: 15, x: 0, sets: 700 },
};
const STALL_REFILL_TICK = 6000;
const STALL_REFILL_SETS = 60;

let weekRun = null;
function runWeek() {
  if (weekRun) return weekRun;
  let s = createState({
    guilds: Object.entries(CASES).map(([id, c]) => ({
      id, credits: 0, fuelHoard: 0, stockpiles: { [SYS]: inputSets(c.recipe, c.sets) },
      ventures: [factory('f', id, c.recipe, c.equityPct ? { equityPct: c.equityPct } : {})],
    })),
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s = sign(s, Object.entries(CASES).filter(([, c]) => c.x > 0).map(([id, c]) => commitUnits(id, 'f', c.x)));

  // Per guild, per tick: whether a unit was on the line, what the work was worth, what was paid.
  const trace = {};
  for (const id of Object.keys(CASES)) {
    trace[id] = { ticks: [], owed: 0, paid: 0, fee: 0, violations: [] };
  }
  const flag = (id, text) => { if (trace[id].violations.length < 5) trace[id].violations.push(text); };
  const invariantHits = [];

  while (s.tick < WEEK) {
    if (s.tick === STALL_REFILL_TICK) addInputSets(s, 'stall', CASES.stall.recipe, STALL_REFILL_SETS);
    const before = {};
    for (const [id, c] of Object.entries(CASES)) {
      const g = guildOf(s, id);
      const good = getRecipe(c.recipe).output.good;
      const w = getWindow(g, SYS, good);
      before[id] = {
        good,
        price: postedPrice(s, good), // the tick pays at the posted price already on state
        credits: g.credits,
        stock: getStock(g, SYS, good),
        delivered: w ? w.delivered : 0,
        carry: ventureOf(s, id, 'f').paymentCarry || 0,
      };
    }
    const ledger = s.syndicate.ledger;
    s = tick(s);

    let paidAll = 0;
    let feesAll = 0;
    for (const [id, c] of Object.entries(CASES)) {
      const b = before[id];
      const g = guildOf(s, id);
      const v = ventureOf(s, id, 'f');
      const t = trace[id];
      const w = getWindow(g, SYS, b.good);
      const deliveredNow = (w ? w.delivered : 0) - b.delivered;
      const minted = getStock(g, SYS, b.good) - b.stock + deliveredNow;
      // A unit was on the line this tick iff one is still on it now, or one landed this tick. Read
      // off the stored countdown and the goods — not off anything the payment code computes.
      const onLine = v.unitTicksRemaining !== undefined || minted > 0;
      // The ruled value of this tick's committed work, typed from the ruling: (x / y) × (1 ÷ T) ×
      // price, with y = 10,080 ÷ T. The owner is owed its (1 − o) share of that.
      const work = onLine && c.x > 0 ? (c.x / (WEEK / c.T)) * (1 / c.T) * b.price : 0;
      const inc = (1 - (c.equityPct || 0)) * work;
      const fee = g.lastLicenceFee && g.lastLicenceFee.tick === s.tick ? g.lastLicenceFee.charged : 0;
      const gained = g.credits - b.credits + fee; // every credit the guild got this tick
      const sale = g.lastSyndicateSale && g.lastSyndicateSale.tick === s.tick ? g.lastSyndicateSale.goods[b.good] : null;
      const carry = v.paymentCarry || 0;
      t.ticks.push({ tick: s.tick, onLine, work, inc, paid: gained, deliveredNow, price: b.price });
      t.owed += inc;
      t.paid += gained;
      t.fee += fee;
      paidAll += gained;
      feesAll += fee;

      // THE RULE, this tick.
      if (!Number.isInteger(gained) || gained < 0) flag(id, `tick ${s.tick}: gained ${gained} — not a whole, non-negative payment`);
      if (gained !== (sale ? sale.credited : 0)) flag(id, `tick ${s.tick}: gained ${gained} but the sale record says ${sale ? sale.credited : 0}`);
      if (Math.abs(b.carry + inc - gained - carry) > 1e-6) flag(id, `tick ${s.tick}: ${b.carry} carried + ${inc} owed − ${gained} paid ≠ ${carry} carried on`);
      if (carry < 0 || carry >= 1) flag(id, `tick ${s.tick}: carry ${carry} outside [0, 1)`);
      if (gained < Math.floor(inc - 1e-9) || gained > Math.floor(inc + 1e-9) + 1) flag(id, `tick ${s.tick}: paid ${gained} for work worth ${inc} — more than one credit off`);
      if (!onLine && (gained !== 0 || carry !== b.carry)) flag(id, `tick ${s.tick}: no unit on the line, yet paid ${gained} (carry ${b.carry} → ${carry})`);
      if (sale && sale.units !== deliveredNow) flag(id, `tick ${s.tick}: the record says ${sale.units} units, ${deliveredNow} were delivered`);
    }
    // Invariant 2: the Syndicate paid exactly what the guilds got, and took exactly the fees.
    if (ledger - s.syndicate.ledger !== paidAll - feesAll) {
      invariantHits.push(`tick ${s.tick}: ledger moved ${s.syndicate.ledger - ledger}, guilds net ${paidAll - feesAll}`);
    }
    if (s.tick % 1440 === 0) invariantHits.push(...checkInvariants(s, s.tick).map((x) => `tick ${s.tick}: ${x.rule} at ${x.where}`));
  }
  weekRun = { end: s, trace, invariantHits };
  return weekRun;
}
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);

// --- 1. HEADLINE --------------------------------------------------------------------------------------

test('HEADLINE: a committed timed factory running gapless is paid SMOOTHLY — on every tick of the week, each within a credit of that tick\'s work — not a lump when a unit lands', () => {
  const { trace } = runWeek();
  const ticks = trace.even.ticks;
  assert.equal(ticks.length, WEEK);
  assert.equal(ticks.filter((t) => t.onLine).length, WEEK, 'the line never stopped: a unit was on it every tick');
  // 336 of 672 at a 3-1 part's ~100 is ~3.3 credits of committed work a tick. Every tick pays 3 or 4.
  assert.equal(ticks.filter((t) => t.paid > 0).length, WEEK, 'paid on all 10,080 ticks');
  assert.ok(Math.max(...ticks.map((t) => t.paid)) <= 5, `no tick pays a lump (max ${Math.max(...ticks.map((t) => t.paid))})`);
  assert.ok(Math.min(...ticks.map((t) => t.paid)) >= 3, 'no tick pays nothing');
  // The tick a unit lands pays for that tick's work like any other — at most the one carried
  // credit more (at a steady 3.33 a tick the payments run 3, 3, 4, and every 15th tick happens to
  // be a 4) — never the ~100 the landed unit itself is worth, which is what the delivery paid before.
  const onDelivery = ticks.filter((t) => t.deliveredNow > 0);
  assert.equal(onDelivery.length, 336, 'a unit still reached the Syndicate on 336 ticks (Slice 3b, unchanged)');
  for (const t of onDelivery) {
    assert.ok(t.paid <= Math.floor(t.inc) + 1 && t.paid < t.price / 10,
      `tick ${t.tick}: a unit landed and the guild was paid ${t.paid} (the tick's work: ${t.inc.toFixed(3)}; the unit: ${t.price})`);
  }
  // The same holds for the flat-price specialist: 3 of 3.5 heavy engines at 20M is 5,952.38 a tick.
  for (const t of trace.heavy.ticks) assert.ok(t.paid === 5952 || t.paid === 5953, `heavy tick ${t.tick}: paid ${t.paid}`);
});

// --- 2. THE RULE, TICK BY TICK ----------------------------------------------------------------------

test('THE RULE on every tick, for every guild: paid = the whole credits of (carry + committed work × price), the rest carried; the guild gains exactly that and nothing for a delivery', () => {
  const { trace, invariantHits } = runWeek();
  for (const id of Object.keys(CASES)) assert.deepEqual(trace[id].violations, [], id);
  assert.deepEqual(invariantHits, [], 'the ledger balances every tick, and the invariants hold at every day end');
});

// --- 3. THE TOTAL: x units' worth, paid once ---------------------------------------------------------

test('THE TOTAL: a met week pays x units\' worth at the week\'s prices, once. At a steady price that is exactly what the delivery-basis sale paid; it is never ~2×', () => {
  const { end, trace } = runWeek();
  const lastCarry = (id) => ventureOf(end, id, 'f').paymentCarry || 0;
  for (const id of ['even', 'full', 'heavy', 'equity']) {
    const t = trace[id];
    // Paid plus what is still carried is what the work was worth — short by less than a credit.
    assert.ok(Math.abs(t.paid + lastCarry(id) - t.owed) < 1e-3, `${id}: paid ${t.paid} + carried ${lastCarry(id)} vs owed ${t.owed}`);
    assert.ok(t.paid <= t.owed + 1e-6 && t.paid > t.owed - 1, `${id}: paid ${t.paid} for work worth ${t.owed}`);
    // The week was MET: x delivered, the discounted fee charged.
    const w = getWindow(guildOf(end, id), SYS, getRecipe(CASES[id].recipe).output.good);
    assert.equal(w.delivered, CASES[id].x, `${id}: all x units delivered`);
    assert.equal(guildOf(end, id).lastLicenceFee.ventures.f.status, 'met', `${id}: met`);
  }

  // A STEADY price: nothing is stockpiled anywhere, so hull plating sits at 100 and the heavy
  // engine at 20M all week. There the progress payment is EXACTLY the delivery-basis sale's total
  // (x units × the price), re-timed from x lumps into 10,080 slices — and nowhere near twice it.
  for (const [id, units, price] of [['full', 672, 100], ['heavy', 3, 20000000]]) {
    assert.ok(trace[id].ticks.every((t) => t.price === price), `${id}: the price never moved from ${price}`);
    const deliveryBasis = units * price;
    assert.ok(Math.abs(trace[id].paid + lastCarry(id) - deliveryBasis) < 1e-3,
      `${id}: paid ${trace[id].paid} (+${lastCarry(id)} carried), the delivery basis paid ${deliveryBasis}`);
    assert.ok(trace[id].paid < 1.01 * deliveryBasis, `${id}: paid once, not twice`);
  }
  assert.equal(trace.full.ticks.filter((t) => t.paid > 0).length, WEEK, 'hull plating: 10,080 payments, where the delivery basis made 672');

  // A MOVING price: the fuel-tank price climbs as the guilds stockpile their own units, so the week
  // is paid at its AVERAGE price — each tick's work at that tick's price, as ruled.
  const even = trace.even;
  const meanPrice = sumOf(even.ticks.map((t) => t.price)) / WEEK;
  assert.ok(Math.abs(even.paid - 336 * meanPrice) < 1, `even: paid ${even.paid}, 336 units at the week's mean ${meanPrice}`);
  // What each delivered unit would have fetched at its delivery tick's price, had the delivery
  // paid as well: the payment is one of these, never both.
  const deliveryValue = sumOf(even.ticks.filter((t) => t.deliveredNow > 0).map((t) => t.deliveredNow * t.price));
  assert.ok(even.paid < 1.2 * deliveryValue && even.paid > 0.8 * deliveryValue,
    `even: paid ${even.paid} against a delivery value of ${deliveryValue} — the same order, not the sum`);
});

test('the equity split is the sale\'s: an owner offering o = 0.4 is paid 60% of its committed work, and the Syndicate ledger keeps the other 40%', () => {
  const { trace } = runWeek();
  const t = trace.equity;
  const gross = sumOf(t.ticks.map((x) => x.work)); // the whole committed work's value, at each tick's price
  assert.ok(gross > 30000, `a real week of work (${gross})`);
  assert.ok(Math.abs(t.paid - 0.6 * gross) < 1, `paid ${t.paid}, 60% of ${gross} is ${0.6 * gross}`);
  // Only what the guild is paid leaves the ledger (THE RULE test balances it every tick), so the
  // 40% equity share simply stays there — "or, with none, to the Syndicate ledger" (§5).
});

// --- 4. A STALLED LINE --------------------------------------------------------------------------------

test('a STALLED line pays 0 for every tick it is stalled, is owed nothing for the gap, has nothing clawed back, and is paid again the tick it restarts', () => {
  const { end, trace } = runWeek();
  const ticks = trace.stall.ticks;
  // Inputs for 100 units run out after tick 1,500. More arrive on tick 6,000, enough for 60 more.
  const running = (from, to) => ticks.filter((t) => t.tick >= from && t.tick <= to);
  assert.ok(running(1, 1500).every((t) => t.onLine && t.paid > 0), 'paid while the first 100 units were made');
  const stalled = running(1501, STALL_REFILL_TICK);
  assert.ok(stalled.every((t) => !t.onLine && t.paid === 0), 'nothing paid while stalled');
  assert.ok(running(STALL_REFILL_TICK + 1, STALL_REFILL_TICK + 900).every((t) => t.onLine && t.paid > 0), 'paid again from the tick it restarts');
  assert.ok(running(STALL_REFILL_TICK + 901, WEEK).every((t) => !t.onLine && t.paid === 0), 'and nothing once the refill is used up');
  // Nothing clawed back: the guild's credits never fell, except by the boundary fee itself.
  for (const t of ticks) assert.ok(t.paid >= 0, `tick ${t.tick}: paid ${t.paid}`);
  // It made 160 units, so it was paid for 160 × (336 / 672) = 80 units' worth of committed work.
  assert.equal(ticks.filter((t) => t.onLine).length, 160 * 15);
  assert.ok(Math.abs(trace.stall.paid - trace.stall.owed) < 1);
  // Settlement is untouched: 160 delivered of 336 is a breach, charged the full weekly fee.
  const fee = guildOf(end, 'stall').lastLicenceFee;
  assert.equal(getWindow(guildOf(end, 'stall'), SYS, 'fuel_tank').delivered, 160);
  assert.equal(fee.ventures.f.status, 'breach');
  assert.equal(fee.charged, fee.ventures.f.basicFee, 'the full fee, exactly as before this slice');
});

// --- 5. THE EDGES ------------------------------------------------------------------------------------

test('an UNCOMMITTED timed factory is never paid and never carries: its units all go to its own stockpile', () => {
  const { end, trace } = runWeek();
  assert.ok(trace.free.ticks.every((t) => t.paid === 0), 'not one credit all week');
  assert.equal(trace.free.ticks.filter((t) => t.onLine).length, WEEK, 'though it ran every tick');
  assert.equal(getStock(guildOf(end, 'free'), SYS, 'cargo_module'), 672, 'all 672 units are its own');
  assert.equal('paymentCarry' in ventureOf(end, 'free', 'f'), false);
  assert.equal(guildOf(end, 'free').lastSyndicateSale, undefined, 'and it never sold anything');
});

test('the sale record: a timed good\'s row carries this tick\'s progress payment, and the whole units delivered (0 between deliveries)', () => {
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: inputSets('fuel_tank', 5) }, ventures: [factory('f', 'g1', 'fuel_tank')] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s = sign(s, [commitUnits('g1', 'f', 672)]);
  for (let i = 1; i <= 30; i += 1) {
    const price = postedPrice(s, 'fuel_tank');
    s = tick(s);
    const sale = s.guilds[0].lastSyndicateSale;
    assert.equal(sale.tick, s.tick, `tick ${s.tick}: written this tick`);
    const row = sale.goods.fuel_tank;
    assert.equal(row.units, s.tick % 15 === 0 ? 1 : 0, `tick ${s.tick}: units delivered`);
    assert.equal(row.price, price);
    assert.ok(row.credited === 6 || row.credited === 7, `tick ${s.tick}: 672/672 × 1/15 × 100 = 6.67 a tick, paid ${row.credited}`);
    assert.equal(sale.credited, row.credited);
  }
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a commitment no Tier-3 licence can hold (the dev scaffold, x above floor(y)) HALTS on its first tick of work, naming the tick and the numbers', () => {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: inputSets('fuel_tank', 2) },
      ventures: [factory('f', 'g1', 'fuel_tank', { syndicateCommitment: 673 })] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  assert.throws(() => tick(s), /venture f commits 673 units of fuel_tank at tick 1, outside \[0, floor\(y\)\] for its weekly output y = 672/);
  // The same scaffold inside the bound is paid like a licence (not a free delivery).
  const ok = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: inputSets('fuel_tank', 2) },
      ventures: [factory('f', 'g1', 'fuel_tank', { syndicateCommitment: 672 })] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  assert.ok(tick(ok).guilds[0].credits > 0);
});

test('committed work with no posted price HALTS rather than being valued at nothing', () => {
  let s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: inputSets('fuel_tank', 2) }, ventures: [factory('f', 'g1', 'fuel_tank')] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  s = sign(s, [commitUnits('g1', 'f', 100)]);
  delete s.prices.fuel_tank;
  assert.throws(() => tick(s), /committed venture f made progress on fuel_tank at tick 1 but the good has no posted price/);
});

test('the carry: omitted when 0, kept when handed in, fenced to [0, 1) on a timed factory by a tripwire', () => {
  const base = { id: 'v', ownerGuildId: 'g1', type: 'refining', recipeId: 'fuel_tank' };
  assert.equal('paymentCarry' in createVenture(base), false, 'absent by default — no key');
  assert.equal('paymentCarry' in createVenture({ ...base, paymentCarry: 0 }), false, 'a 0 is "nothing carried"');
  assert.equal(createVenture({ ...base, paymentCarry: 0.25 }).paymentCarry, 0.25, 'a saved carry survives construction');
  assert.equal(createVenture({ ...base, paymentCarry: 1.5 }).paymentCarry, 1.5, 'a bad one is kept, to reach the tripwire');

  const galaxy = (v) => createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: {} }, ventures: [v] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  const rules = (v) => checkInvariants(galaxy(v), 0).map((x) => x.rule);
  assert.deepEqual(rules(factory('f', 'g1', 'fuel_tank', { paymentCarry: 0.999 })), []);
  for (const bad of [1, 1.5, -0.01, Number.NaN]) {
    assert.deepEqual(rules(factory('f', 'g1', 'fuel_tank', { paymentCarry: bad })), ['payment-carry-in-[0,1) (Slice 3d)'], `carry ${bad}`);
  }
  assert.deepEqual(rules(factory('f', 'g1', 'titanium_alloy', { paymentCarry: 0.5 })), ['payment-carry-only-on-a-timed-factory (Slice 3d)'], 'a Tier-2 factory is never paid on progress');
  assert.deepEqual(rules({ ...mine('m', 'g1', 'titanium', 5), paymentCarry: 0.5 }), ['payment-carry-only-on-a-timed-factory (Slice 3d)'], 'nor is a mine');
});

// --- 6. DETERMINISM + ISOLATION -------------------------------------------------------------------

test('determinism: a galaxy of committed timed factories (carries, equity, a stall) run twice gives the same bytes at every tick', () => {
  function run() {
    let s = createState({
      guilds: [
        { id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...inputSets('fuel_tank', 20), ...inputSets('power_cells', 40) } },
          ventures: [factory('f', 'g1', 'fuel_tank', { equityPct: 0.3 }), factory('p', 'g1', 'power_cells')] },
        { id: 'g2', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: inputSets('heavy_reactor_engine', 1) },
          ventures: [factory('h', 'g2', 'heavy_reactor_engine')] },
      ],
      reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
    });
    s = sign(s, [commitUnits('g1', 'f', 37), commitUnits('g1', 'p', 500), commitUnits('g2', 'h', 1)]);
    const h = crypto.createHash('sha256');
    for (let i = 0; i < 700; i += 1) { s = tick(s); h.update(hashState(s)); }
    return h.digest('hex');
  }
  assert.equal(run(), run());
});

// ISOLATION. Two galaxies on a 60-tick day, 1,200 ticks (twenty Tier-1/2 boundaries), each tick
// hashed. These hashes were computed on the PRE-SLICE engine (HEAD 4a0a651) by the build session
// and pinned: the delivery-basis sale is untouched for every Tier-1/2 good, so the new engine must
// reproduce them.
//   ONE — a Tier-1/2 guild: a licensed titanium mine, a licensed titanium-alloy factory with 20%
//         equity, a carbon mine, and an UNLICENSED Tier-3 factory producing beside them. Full state
//         every tick, and the snapshot every 10 ticks.
//   TWO — that guild again, beside two guilds that COMMIT timed goods (one also holding a licensed
//         titanium mine; one with equity and a heavy engine). The Tier-1/2 guild's whole state every
//         tick; and, for the mixed guild, its titanium venture, window, sale row, fee row and stock
//         every tick — its Tier-1/2 slice, untouched by the timed good paid beside it.
// ⤳ RE-PINNED 28-09-26 by Slice A (the settlement-time stockpile rescue, design.md §5): the first
// three. The t12 guild's titanium-alloy licence falls short at its day boundaries (its committed
// titanium starves the factory: the ruled cascade) while it holds alloy above its floor of 0, as the
// fuel-tank factory's input stock. So the rescue now tops it up, at ticks 60, 120, 180 (150 units
// each) and 240 (18), in both galaxies. The new engine was checked against HEAD d12ba58 from the
// same input on every tick of both runs: equal on every tick without a rescue, different only on
// those. The mixed guild's titanium licence is always met, so ISO_TWO_MIXED_T12_SLICE did not move.
// Before the rescue the three were 1d6bc270…f150, ba0913ac…b3a and dd46d598…a10c.
const ISO_ONE_STATE = '71c11abcfe78193e53695c685a2013cbabec51ac471e80a882aefd71d6c97657';
const ISO_ONE_SNAPSHOTS = 'df1e6b65d45a6eee7f23a69a5ddf64ff91296b25498c819fe1d513d63adadda1';
const ISO_TWO_T12_GUILD = '49fd327d6c6476fe81cffda479722c163ef57d3e828df2b540e4e8f76c9c24a4';
const ISO_TWO_MIXED_T12_SLICE = 'dd507b95d13c73c1339d9fd77b872273ed8964d8ad0dc3d10d0502ff2c1925e9';
// The snapshot hash is taken WITHOUT `tier3Contract`, the additive top-level key the Tier-3
// Establish-popup slice added (sim/snapshot.js). That key is the same rules-derived map in every
// snapshot, and it did not exist when the pinned hash was computed on the pre-slice engine. Stripping
// it, and it alone, keeps the pin at that engine's own hash: every OTHER snapshot byte must still match.
function withoutTier3Contract(snap) {
  const { tier3Contract, ...rest } = snap;
  return rest;
}

const t12Row = () => ({
  id: 't12', credits: 5000000, fuelHoard: 0,
  stockpiles: { [SYS]: { ...inputSets('fuel_tank', 250), carbon_products: 5000 } },
  ventures: [mine('tm', 't12', 'titanium', 15), mine('cm', 't12', 'carbon_products', 5),
    factory('fa', 't12', 'titanium_alloy', { equityPct: 0.2 }), factory('ft', 't12', 'fuel_tank')],
});
const T12_LICENCES = [commitPct('t12', 'tm', 0.25, 7), commitPct('t12', 'fa', 0.5, 14)];

function isolationOne() {
  let s = createState({ guilds: [t12Row()], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: 60 });
  s = sign(s, T12_LICENCES);
  const state = crypto.createHash('sha256');
  const snaps = crypto.createHash('sha256');
  for (let i = 0; i < 1200; i += 1) {
    s = tick(s);
    state.update(hashState(s));
    if (s.tick % 10 === 0) snaps.update(hashState(withoutTier3Contract(buildSnapshot(s))));
  }
  return { state: state.digest('hex'), snaps: snaps.digest('hex'), invariants: checkInvariants(s, s.tick) };
}

function isolationTwo() {
  let s = createState({
    guilds: [
      t12Row(),
      { id: 'mixed', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...inputSets('fuel_tank', 250) } },
        ventures: [mine('tm', 'mixed', 'titanium', 12), factory('ft', 'mixed', 'fuel_tank')] },
      { id: 't3', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...inputSets('fuel_tank', 250), ...inputSets('heavy_reactor_engine', 2) } },
        ventures: [factory('ft', 't3', 'fuel_tank', { equityPct: 0.3 }), factory('h', 't3', 'heavy_reactor_engine')] },
    ],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: 60,
  });
  s = sign(s, [...T12_LICENCES, commitPct('mixed', 'tm', 0.3, 7), commitUnits('mixed', 'ft', 336),
    commitUnits('t3', 'ft', 200), commitUnits('t3', 'h', 3)]);
  const t12 = crypto.createHash('sha256');
  const slice = crypto.createHash('sha256');
  let mixedPaidOnProgress = 0;
  for (let i = 0; i < 1200; i += 1) {
    s = tick(s);
    const m = guildOf(s, 'mixed');
    t12.update(hashState(guildOf(s, 't12')));
    const sale = m.lastSyndicateSale && m.lastSyndicateSale.tick === s.tick ? m.lastSyndicateSale.goods : null;
    const fee = m.lastLicenceFee && m.lastLicenceFee.tick === s.tick ? m.lastLicenceFee.ventures.tm || null : null;
    slice.update(hashState({
      venture: m.ventures.find((v) => v.id === 'tm'),
      window: m.syndicateWindows[SYS].titanium,
      sale: sale ? sale.titanium || null : null,
      fee,
      stock: m.stockpiles[SYS].titanium || 0,
    }));
    if (sale && sale.fuel_tank) mixedPaidOnProgress += 1;
  }
  return {
    t12: t12.digest('hex'), mixedT12Slice: slice.digest('hex'),
    mixedPaidOnProgress, invariants: checkInvariants(s, s.tick),
  };
}

test('ISOLATION: Tier-1/2 committed goods reproduce the pre-slice engine byte for byte — alone, and beside guilds paid on timed progress', () => {
  const one = isolationOne();
  assert.deepEqual(one.invariants, []);
  assert.deepEqual({ state: one.state, snaps: one.snaps }, { state: ISO_ONE_STATE, snaps: ISO_ONE_SNAPSHOTS });

  const two = isolationTwo();
  assert.deepEqual(two.invariants, []);
  assert.equal(two.mixedPaidOnProgress, 1200, 'the mixed guild\'s fuel tanks really were paid every tick beside its titanium');
  assert.deepEqual({ t12: two.t12, mixedT12Slice: two.mixedT12Slice },
    { t12: ISO_TWO_T12_GUILD, mixedT12Slice: ISO_TWO_MIXED_T12_SLICE });
});
