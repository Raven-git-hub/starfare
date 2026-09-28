'use strict';

// tier3-delivery.test.js — Slice 3b of the Tier-3 economy build: SYNDICATE-FIRST delivery for a
// committed timed good (docs/tier3-timed-production.md "Delivery — Syndicate first (fixed)").
//
// The rule, each tick, for a committed timed (Tier-3) good:
//     the Syndicate's take = min(units minted this tick, Q − delivered so far this week)
// So every minted unit goes to the Syndicate until the week's target Q is met, and every unit
// after that stays in the guild's stockpile. It replaces the paced / absolute / percent send for
// timed goods only. Tier-1/2 goods keep that send exactly as before.
//
// What this file proves, in order:
//   1. HEADLINE: on the DEFAULT send a fed 3-1 factory meets every commitment from 10% to 100%.
//      (Under 3a it delivered ~20–40% and breached at every level.) It keeps y − Q for itself.
//   2. THE RULE, TICK BY TICK: for every guild, on every tick of the week (and into the next), the
//      Syndicate's take is exactly min(minted, Q − delivered). It never takes more than Q, never
//      takes from the stockpile, and the stockpile gets nothing until Q is met.
//   3. OVER- and UNDER-producing weeks: an over-producer fills Q and stockpiles the rest. An
//      under-producer delivers every unit it made and still breaches, paying the full fee.
//   4. FIXED: neither the player's claimant order (a reserve ranked ahead of the Syndicate) nor
//      the old send control (absolute 0) can hold a committed unit back.
//   5. The per-good pot, a heavy engine at a fractional y, and the week rolling over.
//   6. ISOLATION: Tier-1/2 goods under every send control and order reproduce the pre-slice
//      engine's bytes (hashes computed on HEAD 8af8b11 and pinned).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { resolveProduction } = require('../production.js');
const { getRecipe } = require('../recipes.js');
const { getStock } = require('../stock.js');
const { getWindow, winStartFor } = require('../windows.js');
const { ticksPerUnitFor } = require('../baseline.js');

const SYS = 'sysA';
const WEEK = 10080;   // docs/tier3-timed-production.md: "exactly one 7-day window (10,080 ticks)"
const DAY = 1440;     // docs/cycle-and-calendar.md: the ruled day

const factory = (id, ownerGuildId, recipeId) => ({
  id, ownerGuildId, type: 'refining', systemId: SYS, recipeId, productionRate: 5,
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
// A guild row for createState. `goods` (optional) is the guild's stored per-good profile policy.
function guildRow(id, ventures, stock, goods) {
  return {
    id, credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures,
    ...(goods ? { productionProfile: { [SYS]: { goods } } } : {}),
  };
}
// A Tier-1/2 licence: a share of output and a 7-day term.
const licence = (guildId, ventureId, committedOutputPct) => createApplyForLicenceAction({
  guildId, ventureId, committedOutputPct, windowDays: 7,
});
// A Tier-3 licence (Slice 3c): `x` whole units of the weekly output, and no term to choose.
const commitUnits = (guildId, ventureId, committedUnits) => createApplyForLicenceAction({
  guildId, ventureId, committedUnits,
});
// The whole units a 3-1 factory commits at each of 3b's levels. Since Slice 3c a Tier-3 licence
// commits whole units rather than a percentage, so each level commits the SAME Q 3b measured at
// that percentage: x = round(pct × 672), the old sizing (at most 672).
const unitsAt = (pct) => Math.min(Math.round(pct * 672), 672);
function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `licence refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);

// --- THE SHARED WEEK ------------------------------------------------------------------------------
//
// The Tier-3 boundary cannot be reached in fewer than 10,080 ticks, so every case below shares one
// galaxy and one run (a week plus 30 ticks, so the next week's first units are seen too). One guild
// per case, each in its own system, each making 3-1 fuel tanks (one every 15 ticks, y = 672 a week)
// unless noted. Every one is on the DEFAULT send — no guild sets a send control except `sendOff`.
// (Every licence below commits whole units, the Slice 3c shape; "50%" means x = 336 of 672.)
//   pct10 … pct100  one fed factory at 10/25/50/75/90/100% (x = 67 … 672) → met, delivered Q, keeps 672 − Q
//   under           50% (Q 336) but inputs for only 100 units      → delivers all 100, breaches
//   reserveFirst    50%, order [stockpile, downstream, syndicate], reserveLevel 1,000 → still met
//   sendOff         50%, the old send control set to "absolute 0"  → still met (the control is inert)
//   sibling         50% factory + an UNLICENSED factory of the same good → the one pot fills Q
//   twoLic          two factories at 25% each (Q = 168 + 168)       → both met
//   heavy           a heavy reactor engine at x = 3 = floor(3.5), its most → met
const LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9, 1];
const levelId = (pct) => `pct${Math.round(pct * 100)}`;
const RUN_END = WEEK + 30;

let weekRun = null;
function runWeek() {
  if (weekRun) return weekRun;
  const tank = (id, gid) => factory(id, gid, 'fuel_tank');
  const full = inputSets('fuel_tank', 700); // more than the 672 a week can use
  let s = createState({
    guilds: [
      ...LEVELS.map((pct) => guildRow(levelId(pct), [tank('f', levelId(pct))], full)),
      guildRow('under', [tank('f', 'under')], inputSets('fuel_tank', 100)),
      guildRow('reserveFirst', [tank('f', 'reserveFirst')], full,
        { fuel_tank: { order: ['stockpile', 'downstream', 'syndicate'], reserveLevel: 1000 } }),
      guildRow('sendOff', [tank('f', 'sendOff')], full, { fuel_tank: { syndicate: { mode: 'absolute', value: 0 } } }),
      guildRow('sibling', [tank('f', 'sibling'), tank('u', 'sibling')], inputSets('fuel_tank', 1400)),
      guildRow('twoLic', [tank('f', 'twoLic'), tank('f2', 'twoLic')], inputSets('fuel_tank', 1400)),
      guildRow('heavy', [factory('f', 'heavy', 'heavy_reactor_engine')], inputSets('heavy_reactor_engine', 4)),
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  s = sign(s, [
    ...LEVELS.map((pct) => commitUnits(levelId(pct), 'f', unitsAt(pct))),
    commitUnits('under', 'f', 336), commitUnits('reserveFirst', 'f', 336), commitUnits('sendOff', 'f', 336),
    commitUnits('sibling', 'f', 336), commitUnits('twoLic', 'f', 168), commitUnits('twoLic', 'f2', 168),
    commitUnits('heavy', 'f', 3),
  ]);
  const signed = JSON.parse(JSON.stringify(s));

  // Each guild's timed good — the output of its (first) factory.
  const goodOf = {};
  for (const g of s.guilds) goodOf[g.id] = getRecipe(g.ventures[0].recipeId).output.good;

  const trace = {};        // guildId -> { ticks, violations: [ first few, as text ], qMetTick, stockWhenQMet }
  const atWeekEnd = {};    // guildId -> { Q, delivered, stock, fee }
  const invariantsAt = {}; // day-end tick -> violations
  for (const g of s.guilds) trace[g.id] = { ticks: 0, violations: [], qMetTick: null, stockWhenQMet: null };
  const flag = (gid, text) => { if (trace[gid].violations.length < 5) trace[gid].violations.push(text); };

  while (s.tick < RUN_END) {
    const p = s.tick + 1; // the producing tick this step yields
    // BEFORE the tick: what the engine is about to do (resolveProduction is the very function the
    // tick applies — design.md §5's anti-drift rule) and the independent facts to check it against.
    const before = {};
    for (const g of s.guilds) {
      const good = goodOf[g.id];
      const report = resolveProduction(g, SYS, { tick: p, windowN: s.windowN, dayAnchorTick: s.dayAnchorTick });
      const stored = getWindow(g, SYS, good);
      // Delivered-so-far THIS week: 0 if the stored window is last week's (it rolls on this tick).
      const deliveredBefore = stored && stored.windowStart === winStartFor(p, WEEK) ? stored.delivered : 0;
      const minted = report.refineries.reduce((sum, r) => sum + r.minted, 0);
      before[g.id] = {
        good, report, deliveredBefore, minted,
        Q: report.goods[good].window.Q,
        send: report.goods[good].fork.syndicate,
        stock: getStock(g, SYS, good),
      };
    }
    s = tick(s);
    // AFTER the tick: THE RULE, and that the tick applied exactly what the report said.
    for (const g of s.guilds) {
      const b = before[g.id];
      const t = trace[g.id];
      t.ticks += 1;
      const expected = Math.min(b.minted, b.Q - b.deliveredBefore);
      if (b.send !== expected) flag(g.id, `tick ${s.tick}: sent ${b.send}, rule says min(${b.minted} minted, ${b.Q} − ${b.deliveredBefore}) = ${expected}`);
      const delivered = getWindow(g, SYS, b.good).delivered;
      if (delivered !== b.deliveredBefore + b.send) flag(g.id, `tick ${s.tick}: delivered ${delivered} ≠ ${b.deliveredBefore} + ${b.send}`);
      if (delivered > b.Q) flag(g.id, `tick ${s.tick}: delivered ${delivered} is past Q ${b.Q}`);
      const stock = getStock(g, SYS, b.good);
      if (stock !== b.stock + b.minted - b.send) flag(g.id, `tick ${s.tick}: stock ${stock} ≠ ${b.stock} + ${b.minted} minted − ${b.send} sent`);
      // Syndicate FIRST, not interleaved: while the week is short of Q, no minted unit stays home.
      if (delivered < b.Q && stock !== b.stock) flag(g.id, `tick ${s.tick}: the stockpile moved (${b.stock} → ${stock}) while only ${delivered} of ${b.Q} was delivered`);
      if (t.qMetTick === null && s.tick <= WEEK && b.Q > 0 && delivered === b.Q) {
        t.qMetTick = s.tick;
        t.stockWhenQMet = stock;
      }
      if (s.tick === WEEK) {
        atWeekEnd[g.id] = {
          Q: b.Q, delivered, stock,
          fee: g.lastLicenceFee && g.lastLicenceFee.tick === WEEK ? JSON.parse(JSON.stringify(g.lastLicenceFee)) : null,
        };
      }
    }
    if (s.tick % DAY === 0) invariantsAt[s.tick] = checkInvariants(s, s.tick);
  }
  weekRun = { signed, end: s, goodOf, trace, atWeekEnd, invariantsAt };
  return weekRun;
}
const signedLicence = (run, gid, vid = 'f') => guildOf(run.signed, gid).ventures.find((v) => v.id === vid).licence;

// --- 1. HEADLINE -----------------------------------------------------------------------------------

test('HEADLINE: on the DEFAULT send a committed 3-1 factory delivers its whole weekly Q and settles MET, at every level from 10% to 100%', () => {
  const run = runWeek();
  // Q typed from the ruled sizing: round(pct × 672), capped at 672 — since Slice 3c the whole units
  // each licence committed (`unitsAt`), typed out again here. Under 3a's paced send
  // these same factories delivered 27 / 69 / 100 / 132 / 142 / 211 and breached at every level.
  const TYPED_Q = { pct10: 67, pct25: 168, pct50: 336, pct75: 504, pct90: 605, pct100: 672 };
  for (const pct of LEVELS) {
    const id = levelId(pct);
    const w = run.atWeekEnd[id];
    const lic = signedLicence(run, id);
    assert.equal(w.Q, TYPED_Q[id], `${id}: Q`);
    assert.equal(w.delivered, w.Q, `${id}: the whole weekly target was delivered`);
    assert.equal(w.stock, 672 - w.Q, `${id}: the guild keeps what completed beyond the commitment`);
    assert.deepEqual(w.fee.ventures.f, {
      status: 'met', owed: lic.discountedFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee,
    }, `${id}: met → the discounted weekly fee`);
  }
});

// --- 2. THE RULE, TICK BY TICK ---------------------------------------------------------------------

test('THE RULE, every tick: the Syndicate takes exactly min(minted, Q − delivered) — never past Q, never from the stockpile, and nothing stays home until Q is met', () => {
  const run = runWeek();
  for (const [gid, t] of Object.entries(run.trace)) {
    assert.equal(t.ticks, RUN_END, `${gid}: every tick was checked`);
    assert.deepEqual(t.violations, [], `${gid}: the rule held on every tick`);
  }
});

test('invariants hold at every day end of the week, for every guild', () => {
  const run = runWeek();
  assert.deepEqual(Object.keys(run.invariantsAt).map(Number), [1, 2, 3, 4, 5, 6, 7].map((d) => d * DAY));
  for (const [t, v] of Object.entries(run.invariantsAt)) assert.deepEqual(v, [], `tick ${t}`);
});

// --- 3. OVER- and UNDER-PRODUCING WEEKS --------------------------------------------------------------

test('an OVER-producing week fills Q first — the stockpile is still empty when Q is met — then stockpiles the rest', () => {
  const run = runWeek();
  const t = run.trace.pct25;
  // Q = 168 and a unit lands every 15 ticks, so the 168th unit — the one that meets Q — lands on
  // tick 168 × 15 = 2,520. Every unit before it went to the Syndicate.
  assert.equal(t.qMetTick, 2520);
  assert.equal(t.stockWhenQMet, 0, 'no unit reached the guild before the Syndicate had its 168');
  const w = run.atWeekEnd.pct25;
  assert.equal(w.delivered, 168, 'never more than Q, though 672 were made');
  assert.equal(w.stock, 504, 'every unit after Q stayed with the guild');
});

test('an UNDER-producing week delivers every unit it made, still breaches, and pays the FULL weekly fee', () => {
  const run = runWeek();
  const w = run.atWeekEnd.under;
  const lic = signedLicence(run, 'under');
  assert.equal(w.Q, 336);
  assert.equal(w.delivered, 100, 'inputs for 100 units → all 100 went to the Syndicate');
  assert.equal(w.stock, 0, 'none kept back');
  assert.deepEqual(w.fee.ventures.f, {
    status: 'breach', owed: lic.basicFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee,
  }, 'short of Q → breach → the full basic fee');
});

// --- 4. FIXED: no lever holds a committed unit back ------------------------------------------------

test('FIXED: a reserve ranked ahead of the Syndicate cannot catch a committed unit', () => {
  // On the 3a engine this guild delivered nothing: its reserve (level 1,000) held every unit
  // before the Syndicate's turn came. Syndicate-first is fixed, so the stored order cannot demote it.
  const run = runWeek();
  const w = run.atWeekEnd.reserveFirst;
  assert.equal(w.delivered, 336);
  assert.equal(w.fee.ventures.f.status, 'met');
  assert.equal(w.stock, 336, 'the reserve still holds what came AFTER the commitment');
  assert.deepEqual(run.trace.reserveFirst.violations, []);
});

test('FIXED: the old send control is not read for a timed good — "absolute 0" still delivers Q', () => {
  const run = runWeek();
  const w = run.atWeekEnd.sendOff;
  assert.equal(w.delivered, 336);
  assert.equal(w.fee.ventures.f.status, 'met');
  assert.deepEqual({ ...w, fee: undefined }, { ...run.atWeekEnd.pct50, fee: undefined },
    'it settles exactly like the same factory with no control set');
});

// --- 5. THE POT, A FRACTIONAL y, THE ROLL ------------------------------------------------------------

test('one pot per good: an unlicensed sibling factory\'s units fill the good\'s Q too (the existing per-good pot)', () => {
  // Q is a GOOD's target, and the fork has always drawn on the good's whole fresh output in the
  // system (design.md §5). Two factories land 2 units every 15 ticks, so Q = 336 is met on tick
  // 168 × 15 = 2,520, and all 1,344 − 336 = 1,008 after it stay with the guild.
  const run = runWeek();
  assert.equal(run.trace.sibling.qMetTick, 2520);
  assert.equal(run.trace.sibling.stockWhenQMet, 0);
  assert.deepEqual({ delivered: run.atWeekEnd.sibling.delivered, stock: run.atWeekEnd.sibling.stock }, { delivered: 336, stock: 1008 });
  assert.equal(run.atWeekEnd.sibling.fee.ventures.f.status, 'met');
});

test('two licences on one good: the one Syndicate-first pile fills both, and both are met', () => {
  const run = runWeek();
  const w = run.atWeekEnd.twoLic;
  assert.equal(w.Q, 168 + 168);
  assert.equal(w.delivered, 336);
  assert.equal(w.fee.ventures.f.status, 'met');
  assert.equal(w.fee.ventures.f2.status, 'met');
});

test('a heavy reactor engine at its most, x = floor(3.5) = 3, delivers its 3 on the DEFAULT send and is met', () => {
  // 2,880 ticks a unit: units land on 2,880, 5,760 and 8,640; the fourth is still on the line at
  // the week's end. Each of the three went to the Syndicate the tick it was minted.
  const run = runWeek();
  assert.equal(ticksPerUnitFor('heavy_reactor_engine'), 2880);
  const w = run.atWeekEnd.heavy;
  assert.deepEqual({ Q: w.Q, delivered: w.delivered, stock: w.stock }, { Q: 3, delivered: 3, stock: 0 });
  assert.equal(run.trace.heavy.qMetTick, 8640);
  assert.equal(w.fee.ventures.f.status, 'met');
});

test('the week rolls over: next week\'s first units go to the Syndicate first again', () => {
  // Week 2 opens on tick 10,081. A fed 3-1 factory's next units land on 10,095 and 10,110: both
  // are the new week's, so both go to the Syndicate, and last week's leftovers are untouched.
  const run = runWeek();
  const g = guildOf(run.end, 'pct50');
  assert.deepEqual(getWindow(g, SYS, 'fuel_tank'), { windowStart: WEEK + 1, delivered: 2, sendCarry: 0 });
  assert.equal(getStock(g, SYS, 'fuel_tank'), run.atWeekEnd.pct50.stock, 'the stockpile got nothing new');
});

test('a timed good keeps no send carry — there is no paced fraction to carry', () => {
  const run = runWeek();
  for (const g of run.end.guilds) {
    assert.equal(getWindow(g, SYS, run.goodOf[g.id]).sendCarry, 0, `${g.id}`);
  }
});

// --- 6. DETERMINISM + ISOLATION ---------------------------------------------------------------------

test('determinism: the same committed Tier-3 galaxy run twice gives the same bytes at every tick', () => {
  function run() {
    const crypto = require('node:crypto');
    let s = createState({
      guilds: [guildRow('g1', [factory('f', 'g1', 'fuel_tank'), factory('u', 'g1', 'fuel_tank')], inputSets('fuel_tank', 60),
        { fuel_tank: { order: ['stockpile', 'syndicate', 'downstream'], reserveLevel: 3 } })],
      reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
    });
    s = sign(s, [commitUnits('g1', 'f', 336)]);
    const h = crypto.createHash('sha256');
    for (let i = 0; i < 400; i += 1) { s = tick(s); h.update(hashState(s)); }
    return h.digest('hex');
  }
  assert.equal(run(), run());
});

// A Tier-1/2 galaxy under EVERY send control and order: absolute, percent, a reserve ranked ahead
// of the Syndicate, a claimant order with the Syndicate last, a pursue ranking, two licensed mines
// on one good, a licensed Tier-2 factory, and an unlicensed Tier-3 factory producing beside them.
// 600 ticks on a 60-tick day (ten boundaries). These two hashes were computed on the PRE-SLICE
// engine (HEAD 8af8b11) by the build session and pinned: the paced / absolute / percent send is
// untouched for every Tier-1/2 good, so the new engine must reproduce every tick's bytes.
const ISO_FINAL = '11fafaf8cd59b5cc649701f09151a5a7b399a7e438cf8f60de6b815d513c16a0';
const ISO_EVERY_TICK = 'fe166027428d67b5c392d88bb780affca25e0a14f971fa5141bfcefd10a44a34';

function isolationRun() {
  const crypto = require('node:crypto');
  const PROFILES = {
    abs: { titanium: { syndicate: { mode: 'absolute', value: 3 } }, titanium_alloy: { syndicate: { mode: 'absolute', value: 1 } } },
    pct: { titanium: { syndicate: { mode: 'percent', value: 40 } } },
    reord: {
      titanium: { order: ['stockpile', 'syndicate', 'downstream'], reserveLevel: 50, pursue: ['tm2', 'tm'] },
      titanium_alloy: { order: ['downstream', 'stockpile', 'syndicate'], reserveLevel: 7 },
    },
  };
  const guilds = Object.entries(PROFILES).map(([id, goods]) => ({
    id, credits: 0, fuelHoard: 0,
    stockpiles: { [SYS]: { ...inputSets('fuel_tank', 250), carbon_products: 5000 } },
    ventures: [
      mine('tm', id, 'titanium', 15), mine('tm2', id, 'titanium', 9), mine('cm', id, 'carbon_products', 5),
      factory('fa', id, 'titanium_alloy'), factory('ft', id, 'fuel_tank'),
    ],
    productionProfile: { [SYS]: { goods } },
  }));
  let s = createState({ guilds, reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: 60 });
  s = sign(s, Object.keys(PROFILES).flatMap((id) => [licence(id, 'tm', 0.25), licence(id, 'tm2', 0.4), licence(id, 'fa', 0.5)]));
  const everyTick = crypto.createHash('sha256');
  for (let i = 0; i < 600; i += 1) { s = tick(s); everyTick.update(hashState(s)); }
  return { final: hashState(s), everyTick: everyTick.digest('hex'), invariants: checkInvariants(s, s.tick) };
}

test('ISOLATION: Tier-1/2 goods under every send control and order reproduce the pre-slice engine byte for byte', () => {
  const { final, everyTick, invariants } = isolationRun();
  assert.deepEqual(invariants, []);
  assert.deepEqual({ final, everyTick }, { final: ISO_FINAL, everyTick: ISO_EVERY_TICK });
});
