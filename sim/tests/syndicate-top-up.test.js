'use strict';

// syndicate-top-up.test.js — Slice A2-engine (licence system), design.md §5 "SYNDICATE TOP-UP —
// opt-in + capped (REVISES Slice A rescue)", RULED 28-09-26.
//
// Slice A built the settlement rescue ALWAYS ON: at a good's boundary a short licence was topped up
// from any stock above the reserve floor. The ruling makes it the player's SYNDICATE TOP-UP, set per
// good in the production profile, beside `reserveLevel`:
//     syndicateTopUp        true or false. Absent = false: OFF until the player opts in.
//     syndicateTopUpLimit   an integer ≥ 0, or null = no limit. Absent = null.
// The rescue now runs for a good ONLY when its switch is on, and then delivers the LOWER of three:
// the shortfall, the stock above the reserve floor, and the limit. Everything else about it stands
// (Slice A, Slice A-fix): the floor, partial rescue, the posted price, each licence's own equity,
// no licence no rescue. The per-tick CONSUMPTION top-up (the Gate-1 reserve drawdown that feeds
// downstream lines) is a different mechanism, and is not touched.
//
// The named tripwires:
//   (a) OFF ⇒ NO RESCUE — with the switch absent or false, a short licence with stock to spare is
//       not topped up: the pile is untouched and the licence breaches on its shortfall. The same
//       galaxy with the switch on is rescued to met: the before and the after.
//   (b) ON, NO LIMIT ⇒ THE OLD RESCUE — a run of real play with the switch on and no limit is the
//       always-on engine (HEAD cad2877) byte for byte, every tick. With the switch off, the same run
//       is the engine from before any rescue existed (HEAD d12ba58), byte for byte.
//   (c) THE LIMIT — with a limit under the shortfall, exactly min(limit, stock above the floor) is
//       rescued and the licence breaches on the rest. A limit at or over the shortfall does not bind.
//   (d) THE FLOOR STILL HOLDS — however high the limit, stock at or under the floor never moves.
//   (e) EQUITY UNCHANGED — a capped rescue shared by two licences pays each top-up on its own
//       licence's equity, exactly as an uncapped one does.
//   (f) THE FIELDS — setProductionProfile takes true/false, and an integer ≥ 0 or null for the limit;
//       it refuses anything else by name, and a refusal changes nothing.
// Every tier is covered (a Tier-1 mine, a Tier-2 factory, a timed Tier-3 week), and conservation is
// checked across every boundary crossed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction, createSetSyndicateCommitmentAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { previewProduction } = require('../production.js');
const { getGoodPolicy } = require('../profile.js');
const { getStock } = require('../stock.js');
const { getWindow } = require('../windows.js');
const { postedPrice } = require('../prices.js');
const { getRecipe } = require('../recipes.js');
const { MINE_BASELINE } = require('../baseline.js');

const SYS = 'sysA';
const GOOD = 'titanium';
const N = 4;                         // a four-tick day, so a boundary is never far away
const B = MINE_BASELINE[GOOD];       // one mine's baseline, units a tick
// The fixture's own numbers (test inputs, not game constants), as in settlement-rescue.test.js: the
// mine runs at twice its baseline and the send is pinned at half the baseline, so a 100% licence
// ends its day short by half its target while the unsent output piles up.
const Q = B * N;                     // what a 100% licence owes a day
const RATE = 2 * B;
const SEND = B / 2;
const DELIVERED_FRESH = SEND * N;    // what the send hands over by the boundary
const SHORT = Q - DELIVERED_FRESH;   // the shortfall before any rescue (320)
const PILE = (RATE - SEND) * N;      // the stockpile at the boundary, before any rescue (960)

// --- fixtures ------------------------------------------------------------------------------------

function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id = 'g1') => s.guilds.find((g) => g.id === id);
const stock = (s, good = GOOD, id = 'g1') => getStock(guildOf(s, id), SYS, good);
const win = (s, good = GOOD, id = 'g1') => getWindow(guildOf(s, id), SYS, good);
const nextWindow = (s, good = GOOD, id = 'g1') => previewProduction(s).find((g) => g.guildId === id)
  .systems.find((x) => x.systemId === SYS).goods[good].window;
function runTo(s, t) { while (s.tick < t) s = tick(s); return s; }

// One guild, one licensed titanium mine, the send pinned short. `topUp` is spread into the good's
// profile as it is: {} leaves both fields absent (the defaults), or it names either or both.
function mineGalaxy({ floor = 0, topUp = {} } = {}) {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: RATE },
    ] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  return sign(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm', committedOutputPct: 1, windowDays: 7 }),
    createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: {
      [GOOD]: { syndicate: { mode: 'absolute', value: SEND }, ...(floor ? { reserveLevel: floor } : {}), ...topUp },
    } }),
  ]);
}

// Everything the boundary tick moved, with the conservation checks read across it.
function acrossTheBoundary(s, good = GOOD) {
  const edge = runTo(s, N - 1);
  const price = postedPrice(edge, good);   // the price the boundary tick sells at (already posted)
  const preview = nextWindow(edge, good);
  const after = tick(edge);
  assert.deepEqual(checkInvariants(after, after.tick), [], 'every invariant holds after the boundary');
  assert.equal(guildOf(after).credits + after.syndicate.ledger, guildOf(edge).credits + edge.syndicate.ledger,
    'credits only moved between the guild and the ledger');
  return {
    edge, after, price, preview,
    stockAfter: stock(after, good),
    fees: guildOf(after).lastLicenceFee.ventures,
    sale: guildOf(after).lastSyndicateSale.goods[good],
    creditsDelta: guildOf(after).credits - guildOf(edge).credits,
  };
}

// --- (a) OFF ⇒ NO RESCUE ---------------------------------------------------------------------------

test('(a) OFF ⇒ NO RESCUE: with Syndicate Top-Up absent or false, a short licence with stock to spare is not topped up and breaches on its shortfall — the same galaxy with it on is rescued to met', () => {
  // BEFORE: switched on, the galaxy is Slice A's always-on rescue — topped up to its target, met.
  const on = acrossTheBoundary(mineGalaxy({ topUp: { syndicateTopUp: true } }));
  assert.equal(on.preview.rescued, SHORT);
  assert.equal(on.fees.m.status, 'met');
  assert.equal(on.stockAfter, PILE - SHORT);

  // AFTER: switched off, in each way it can be off, nothing is rescued.
  for (const [how, topUp] of [
    ['absent (the default)', {}],
    ['false', { syndicateTopUp: false }],
    ['false, with a limit set', { syndicateTopUp: false, syndicateTopUpLimit: SHORT }],
  ]) {
    const off = acrossTheBoundary(mineGalaxy({ topUp }));
    assert.equal(off.preview.rescued, undefined, `${how}: nothing rescued, so no rescued key`);
    assert.equal(win(off.after).delivered, DELIVERED_FRESH, `${how}: only the fresh send was delivered`);
    assert.equal(off.stockAfter, PILE, `${how}: every unit of the pile is still there`);
    const lic = guildOf(off.after).ventures[0].licence;
    assert.deepEqual(off.fees.m, { status: 'breach', owed: lic.basicFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee },
      `${how}: breach, and the full basic fee`);
    assert.equal(off.sale.units, SEND, `${how}: only the fresh send was sold`);
    assert.equal(off.creditsDelta, off.sale.credited - lic.basicFee, `${how}: paid the send, charged the breach`);
  }
});

// --- (c) THE LIMIT, and (d) THE FLOOR STILL HOLDS ----------------------------------------------------
//
// One table, read the same way on every row: the good's whole rescue is the LOWEST of the
// shortfall (SHORT = 320), the stock above the floor (PILE − floor), and the limit (null = none).

test('(c) THE LIMIT and (d) THE FLOOR: the rescue is the lowest of the shortfall, the stock above the floor, and the limit; the licence breaches on whatever that leaves', () => {
  const rows = [
    // [why, floor, limit, rescued]
    ['a limit under the shortfall binds',               0,          100,         100],
    ['one unit under the shortfall still breaches',     0,          SHORT - 1,   SHORT - 1],
    ['a limit of exactly the shortfall meets',          0,          SHORT,       SHORT],
    ['a limit over the shortfall does not bind',        0,          10 * SHORT,  SHORT],
    ['a limit of 0 rescues nothing',                    0,          0,           0],
    ['no limit: the whole shortfall, as Slice A',       0,          null,        SHORT],
    ['no limit, little spare: all the spare',           PILE - 50,  null,        50],
    ['(d) spare under the limit: the floor binds',      PILE - 50,  200,         50],
    ['(d) no spare at all: nothing, whatever the limit', PILE,      10 * SHORT,  0],
  ];
  for (const [why, floor, limit, rescued] of rows) {
    // Absent and null both mean "no limit"; each row sends the limit only when it has one.
    const x = acrossTheBoundary(mineGalaxy({ floor, topUp: { syndicateTopUp: true, ...(limit === null ? {} : { syndicateTopUpLimit: limit }) } }));
    assert.equal(x.preview.rescued || 0, rescued, `${why}: rescued`);
    assert.equal(win(x.after).delivered, DELIVERED_FRESH + rescued, `${why}: delivered the send plus the rescue`);
    assert.equal(x.stockAfter, PILE - rescued, `${why}: exactly the rescue left the stockpile`);
    assert.ok(x.stockAfter >= floor, `${why}: never below the floor`);
    assert.equal(x.fees.m.status, rescued === SHORT ? 'met' : 'breach', `${why}: the verdict`);
    assert.equal(x.sale.units, SEND + rescued, `${why}: the send and the rescue were both sold`);
    assert.equal(x.sale.credited, Math.round(SEND * x.price) + (rescued ? Math.round(rescued * x.price) : 0),
      `${why}: each paid at the posted price, rounded once per sale`);
  }
});

test('(c) THE LIMIT is per settlement: each boundary may rescue up to the limit again', () => {
  // The limit caps what ONE settlement delivers, so a guild short every day is topped up by the
  // limit every day. It is not a budget that runs down.
  const LIMIT = 100;
  let s = mineGalaxy({ topUp: { syndicateTopUp: true, syndicateTopUpLimit: LIMIT } });
  for (let day = 1; day <= 3; day += 1) {
    s = runTo(s, day * N - 1);
    assert.equal(nextWindow(s).rescued, LIMIT, `day ${day}: rescued the limit`);
    s = tick(s);
    assert.equal(guildOf(s).lastLicenceFee.ventures.m.status, 'breach', `day ${day}: short by the rest`);
  }
});

test('(c) and (d) EVERY TIER: a Tier-2 factory licence is switched and capped the same way', () => {
  // A titanium-alloy factory fed at full rate, licensed for 100% of its baseline, its send pinned
  // at 1 a tick, with 40 alloy in stock: short by 16 at the day's end (the Slice A fixture).
  const FACTORY_Q = 5 * N;   // REFINERY_BASELINE 5 batches a tick × 1 alloy each, over one day
  const factory = (topUp) => sign(createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { titanium_alloy: 40 } }, ventures: [
      { id: 'tm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 15 },
      { id: 'cm', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: 'carbon_products', productionRate: 5 },
      { id: 'fa', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'titanium_alloy', productionRate: 5 },
    ] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  }), [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'fa', committedOutputPct: 1, windowDays: 7 }),
    createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { titanium_alloy: { syndicate: { mode: 'absolute', value: 1 }, ...topUp } } }),
  ]);
  const short = FACTORY_Q - N;
  for (const [why, topUp, rescued] of [
    ['off', {}, 0],
    ['on, no limit', { syndicateTopUp: true }, short],
    ['on, limit 5', { syndicateTopUp: true, syndicateTopUpLimit: 5 }, 5],
  ]) {
    const x = acrossTheBoundary(factory(topUp), 'titanium_alloy');
    assert.equal(x.preview.rescued || 0, rescued, `${why}: rescued`);
    assert.equal(win(x.after, 'titanium_alloy').delivered, N + rescued, `${why}: delivered`);
    assert.equal(x.fees.fa.status, rescued === short ? 'met' : 'breach', `${why}: the verdict`);
  }
});

// A timed Tier-3 week: one fuel-tank factory per guild commits X = 50 units but has inputs for
// only MADE = 30, and holds HELD = 40 tanks from before the week (never progress-paid). Three
// guilds in one galaxy, identical but for the switch and the limit, so all sell at one price.
const WEEK = 10080;
const T3 = { recipe: 'fuel_tank', good: 'fuel_tank', X: 50, MADE: 30, HELD: 40, LIMIT: 7 };
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}

test('(a) and (c) EVERY TIER: a timed Tier-3 week is left to breach when off, topped up when on, and capped by its limit', () => {
  const row = (id) => ({ id, credits: 0, fuelHoard: 0,
    stockpiles: { [SYS]: { ...inputSets(T3.recipe, T3.MADE), [T3.good]: T3.HELD } },
    ventures: [{ id: 'f', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: T3.recipe, productionRate: 5 }] });
  let s = createState({ guilds: [row('off'), row('on'), row('capped')], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  s = sign(s, [
    ...['off', 'on', 'capped'].map((id) => createApplyForLicenceAction({ guildId: id, ventureId: 'f', committedUnits: T3.X })),
    // The switch and the limit are refused on NO timed good: the rescue runs for every tier.
    createSetProductionProfileAction({ guildId: 'on', systemId: SYS, goods: { [T3.good]: { syndicateTopUp: true } } }),
    createSetProductionProfileAction({ guildId: 'capped', systemId: SYS, goods: { [T3.good]: { syndicateTopUp: true, syndicateTopUpLimit: T3.LIMIT } } }),
  ]);
  // Run until every guild has made its 30 units, then jump the idle rest of the week.
  s = runTo(s, 1000);
  for (const id of ['off', 'on', 'capped']) assert.equal(win(s, T3.good, id).delivered, T3.MADE, `${id}: made and sent its 30`);
  s.tick = WEEK - 1;
  const edge = s;
  const end = tick(edge);
  assert.deepEqual(checkInvariants(end, end.tick), []);

  const short = T3.X - T3.MADE;   // 20
  for (const [id, rescued] of [['off', 0], ['on', short], ['capped', T3.LIMIT]]) {
    assert.equal(stock(end, T3.good, id), T3.HELD - rescued, `${id}: took ${rescued} of the held tanks`);
    assert.equal(win(edge, T3.good, id).delivered + rescued, T3.MADE + rescued);
    assert.equal(guildOf(end, id).lastLicenceFee.ventures.f.status, rescued === short ? 'met' : 'breach', `${id}: the verdict`);
  }
});

// --- (e) EQUITY UNCHANGED ----------------------------------------------------------------------------
//
// Two licences on one good, `a` (o = 0.1) and `b` (o = 0.4), each owing q and each sending nothing,
// so each is short by its whole q. Plenty of stock above a floor of 0: here only the LIMIT decides.

test('(e) EQUITY UNCHANGED: a limit shared by two licences tops them up in the pursue order, and each top-up is paid on its own licence\'s equity', () => {
  const OA = 0.1;
  const OB = 0.4;
  const q = B * N;
  const LIMIT = q + q / 2;   // all of a's shortfall, and half of b's
  const s = sign(createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 'a', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: RATE, equityPct: OA },
      { id: 'b', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: RATE, equityPct: OB },
    ] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  }), [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'a', committedOutputPct: 1, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'b', committedOutputPct: 1, windowDays: 7 }),
    createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: {
      syndicate: { mode: 'absolute', value: 0 }, pursue: ['a', 'b'], syndicateTopUp: true, syndicateTopUpLimit: LIMIT,
    } } }),
  ]);
  const x = acrossTheBoundary(s);
  assert.equal(x.preview.rescued, LIMIT, 'the two licences share ONE limit: the good rescues the limit in all');
  assert.deepEqual(x.preview.perVenture.a, { commitment: q, delivered: q, status: 'met' }, 'a, ranked first, is saved');
  assert.deepEqual(x.preview.perVenture.b, { commitment: q, delivered: q / 2, status: 'breach' }, 'b gets what the limit leaves');
  assert.equal(x.stockAfter, 2 * RATE * N - LIMIT);
  // Paid exactly as Slice A-fix pays an uncapped rescue: each top-up on its own 1 − o, summed and
  // rounded once. The boundary's only sale is the rescue (nothing is sent).
  assert.deepEqual(x.sale, { units: LIMIT, price: x.price,
    credited: Math.round((1 - OA) * q * x.price + (1 - OB) * (q / 2) * x.price) });
});

// --- (f) THE FIELDS ----------------------------------------------------------------------------------

test('(f) THE FIELDS: setProductionProfile takes a boolean switch and an integer ≥ 0 or null limit, refuses anything else by name, and stores what it takes', () => {
  const s = mineGalaxy();
  const set = (state, policy) => intake(state, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: policy } })]);
  const policyOf = (state) => getGoodPolicy(guildOf(state), SYS, GOOD);

  // Refused, by name, changing nothing.
  for (const bad of ['true', 1, 0, {}, []]) {
    const out = set(s, { syndicateTopUp: bad });
    assert.equal(out.results[0].accepted, false, `switch ${JSON.stringify(bad)} is refused`);
    assert.match(out.results[0].reason, /^syndicateTopUp for good "titanium" must be true or false$/);
    assert.equal(hashState(out.state), hashState(s), 'a refusal changes nothing');
  }
  for (const bad of [-1, 2.5, '10', true, Infinity, NaN, {}]) {
    const out = set(s, { syndicateTopUpLimit: bad });
    assert.equal(out.results[0].accepted, false, `limit ${String(bad)} is refused`);
    assert.match(out.results[0].reason, /^syndicateTopUpLimit for good "titanium" must be a non-negative integer, or null for no limit/);
    assert.equal(hashState(out.state), hashState(s), 'a refusal changes nothing');
  }

  // The defaults, before anything is set: off, and no limit.
  assert.equal(policyOf(s).syndicateTopUp, false);
  assert.equal(policyOf(s).syndicateTopUpLimit, null);
  // Taken and stored.
  let t = sign(s, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: { syndicateTopUp: true, syndicateTopUpLimit: 0 } } })]);
  assert.equal(policyOf(t).syndicateTopUp, true);
  assert.equal(policyOf(t).syndicateTopUpLimit, 0, 'a limit of 0 is a real limit');
  t = sign(t, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: { syndicateTopUpLimit: 25 } } })]);
  assert.equal(policyOf(t).syndicateTopUpLimit, 25);
  assert.equal(policyOf(t).syndicateTopUp, true, 'setting the limit alone leaves the switch as it was');
  // A null limit is accepted: it clears the limit, which reads back as null — no limit.
  t = sign(t, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: { syndicateTopUpLimit: null } } })]);
  assert.equal(policyOf(t).syndicateTopUpLimit, null);
  assert.equal('syndicateTopUpLimit' in guildOf(t).productionProfile[SYS].goods[GOOD], false, 'cleared, not stored as null');
  // false is stored; null clears the switch back to its default, false.
  t = sign(t, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: { syndicateTopUp: false } } })]);
  assert.equal(guildOf(t).productionProfile[SYS].goods[GOOD].syndicateTopUp, false);
  t = sign(t, [createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: { syndicateTopUp: null } } })]);
  assert.equal(policyOf(t).syndicateTopUp, false);
  assert.equal('syndicateTopUp' in guildOf(t).productionProfile[SYS].goods[GOOD], false);
});

// --- (b) ON, NO LIMIT ⇒ THE OLD RESCUE (and OFF ⇒ NO RESCUE AT ALL) ---------------------------------
//
// One run of real play on a 60-tick day, made twice: once with Syndicate Top-Up ON (no limit) for
// both committed goods, and once with it left at its default, OFF. Each runs 700 ticks, jumps to 180
// ticks before the week's end, and runs 300 more (the pattern of settlement-rescue.test.js). Every
// tick's state, the production preview before every tick and the snapshot at every day boundary
// are hashed. What the run holds:
//   - three titanium mines at their baseline: `m1` (o = 0.1) and `m2` (o = 0.4) each licensed for
//     half of it, and `m3` committed through the dev scaffold (no licence), ranked FIRST;
//   - the send pinned at 1 a tick and a floor of 20,000, so on the first day the spare cannot cover
//     both licences (a partial rescue, then a breach), and on every later day it can;
//   - a Tier-3 fuel-tank licence (o = 0.2) of 20 a week, with inputs for 5 and 12 tanks held: at the
//     week's end it is topped up by 12 of its 15 and still breaches.
// ON: the hashes were computed on the always-on engine, HEAD cad2877, from this same input (that
//   engine does not know the switch, so its `setEntry` never stores it). The switch is removed
//   before hashing here (`withoutTopUpSwitch`), since that key is the one byte the old engine could
//   not write. So: switch on, no limit, IS the old rescue.
// OFF: the hashes were computed on the engine before any rescue existed, HEAD d12ba58, from this
//   same input. So: the default IS no rescue at all.
// The rescue and verdict counts are pinned too, so each run is known to be the case it claims.
const ISO_DAY = 60;
const ISO_JUMP_TO = WEEK - 180;
const ISO_FLOOR = 20000;   // a test input: under two days' pile, over one day's
// A copy of a state or snapshot with every `syndicateTopUp` switch taken out of the guilds'
// production profiles, and a good left with no policy removed (the profile's own rule, `setEntry`).
function withoutTopUpSwitch(value) {
  const copy = structuredClone(value);
  for (const g of copy.guilds) {
    for (const entry of Object.values(g.productionProfile || {})) {
      for (const [good, policy] of Object.entries(entry.goods || {})) {
        delete policy.syndicateTopUp;
        if (Object.keys(policy).length === 0) delete entry.goods[good];
      }
    }
  }
  return copy;
}
function isolationRun(switchOn) {
  const id = 'mix';
  const mine = (vid, o) => ({ id: vid, ownerGuildId: id, type: 'mining', systemId: SYS, resourceType: GOOD,
    productionRate: B, ...(o ? { equityPct: o } : {}) });
  let s = createState({
    guilds: [{ id, credits: 0, fuelHoard: 0,
      stockpiles: { [SYS]: { ...inputSets('fuel_tank', 5), fuel_tank: 12 } },
      ventures: [mine('m1', 0.1), mine('m2', 0.4), mine('m3'),
        { id: 'ft', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: 'fuel_tank', productionRate: 5, equityPct: 0.2 }] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: ISO_DAY,
  });
  const on = switchOn ? { syndicateTopUp: true } : {};
  s = sign(s, [
    createApplyForLicenceAction({ guildId: id, ventureId: 'm1', committedOutputPct: 0.5, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: id, ventureId: 'm2', committedOutputPct: 0.5, windowDays: 7 }),
    createSetSyndicateCommitmentAction({ guildId: id, ventureId: 'm3', commitment: (B * ISO_DAY) / 2 }),
    createApplyForLicenceAction({ guildId: id, ventureId: 'ft', committedUnits: 20 }),
    createSetProductionProfileAction({ guildId: id, systemId: SYS, goods: {
      [GOOD]: { syndicate: { mode: 'absolute', value: 1 }, reserveLevel: ISO_FLOOR, pursue: ['m3', 'm2', 'm1'], ...on },
      ...(switchOn ? { fuel_tank: on } : {}),
    } }),
  ]);
  const everyTick = crypto.createHash('sha256');
  const previews = crypto.createHash('sha256');
  const snapshots = crypto.createHash('sha256');
  const counts = { rescued: 0, met: 0, breach: 0 };
  const step = () => {
    const preview = previewProduction(s);
    previews.update(hashState(preview));
    for (const g of preview) for (const sys of g.systems) for (const e of Object.values(sys.goods)) {
      if (e.window && e.window.rescued) counts.rescued += e.window.rescued;
    }
    s = tick(s);
    everyTick.update(hashState(withoutTopUpSwitch(s)));
    if (s.tick % ISO_DAY !== 0) return;
    snapshots.update(hashState(withoutTopUpSwitch(buildSnapshot(s))));
    const fee = guildOf(s, id).lastLicenceFee;
    if (fee && fee.tick === s.tick) for (const r of Object.values(fee.ventures)) counts[r.status] += 1;
  };
  for (let i = 0; i < 700; i += 1) step();
  s.tick = ISO_JUMP_TO;
  for (let i = 0; i < 300; i += 1) step();
  return {
    final: hashState(withoutTopUpSwitch(s)), everyTick: everyTick.digest('hex'),
    previews: previews.digest('hex'), snapshots: snapshots.digest('hex'), counts,
  };
}
// The counts: 11 day boundaries before the jump (the jump carries the Tier-1/2 licences past their
// renegotiation deadlines, so only the Tier-3 licence is judged after it), each judging m1 and m2,
// plus the one Tier-3 week: 23 verdicts. ON: m1 breaches on the first day (the partial) and the
// Tier-3 week breaches (12 of 15); the other 21 are rescued to met. OFF: all 23 breach, and nothing
// is rescued. (The scaffold m3 has no licence, so it is never rescued and has no fee row.)
const ISO_ON_IS_THE_OLD_RESCUE = {
  final: '7eb4426c1a491e2bfc9605f37a72a27a60e3200ed6afdbca9930b58c3fdef48a',
  everyTick: '6c206885906cc36bdd03c259faf2ce08db8bdb1b891e0bf6ea48adceb922d713',
  previews: 'da5c423a39ec00cfb992e0f4d36579aeff84f9ac454d3df8b3652e85d8528aad',
  snapshots: '556532c48244d0113164e595b5d69c4f5aea5a12ddab042c8333ca76265cd12c',
  counts: { rescued: 104752, met: 21, breach: 2 },
};
const ISO_OFF_IS_NO_RESCUE = {
  final: 'a337c8cd11fbb8f8b2abec6b419674e2cf317f56a4905268a6b7f217d895449a',
  everyTick: '90b6e6d162637fc01524bab19b03fbdf049f1a5403aed95908aa45c99f9785d0',
  previews: 'ce91994da972a1ae281ed8df18c7053bb5bb43e5b2417b35fddd3fbd9c04222c',
  snapshots: 'b755a87f752022eb6d0e3b6e535934f2c116cb67b4dcd93fe026e22365221264',
  counts: { rescued: 0, met: 0, breach: 23 },
};

test('(b) ON, NO LIMIT ⇒ THE OLD RESCUE: switched on with no limit, a run of real play is the always-on engine (HEAD cad2877) byte for byte; left off, it is the engine before any rescue (HEAD d12ba58)', () => {
  const on = isolationRun(true);
  const off = isolationRun(false);
  if (process.env.PRINT_ISO_PINS) console.log('ISO_PINS', JSON.stringify({ on, off }));
  assert.ok(on.counts.rescued > 0, 'the rescue really fires when switched on');
  assert.deepEqual(on, ISO_ON_IS_THE_OLD_RESCUE);
  assert.deepEqual(off, ISO_OFF_IS_NO_RESCUE);
});
