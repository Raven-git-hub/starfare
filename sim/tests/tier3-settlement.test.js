'use strict';

// tier3-settlement.test.js — Slice 3a of the Tier-3 economy build: a Tier-3 venture settles on
// a WEEKLY window (10,080 ticks), and its licence fee and committed quantity are sized off its
// TIMED weekly output `y = 10,080 ÷ TICKS_PER_UNIT` (docs/tier3-timed-production.md "Income &
// commitment" + "Contract & settlement"; docs/phase-1-tuning.md "Tier-3 licence fee &
// commitment").
//
// What this file proves, in order:
//   1. THE NUMBERS — the week is 10,080 ticks = 7 ruled days, and only a TIMED good gets it.
//   2. (d) THE WINDOWS NEST — every Tier-3 boundary is also a day boundary; a galaxy whose day
//      does not divide the week refuses a Tier-3 licence, halts rather than mis-settle, and
//      the invariant names it. An UNLICENSED Tier-3 factory reads no window at all.
//   3. (a) THE FEE — a Tier-3 licence's basic fee is 0.10 × (10,080 ÷ TICKS_PER_UNIT) × the
//      price at signing, NOT the old 5-batches/tick × 1,440 figure; its commitment is whole
//      units of `y`, never more than floor(y) (since Slice 3c the licence commits `x` directly —
//      sim/tests/tier3-contract.test.js). The quote, the signing and the re-lock all read that one
//      basis. A Tier-1/2 fee is unchanged.
//   4. (b) + (c) ONE WEEK, SEVERAL GUILDS — a committed Tier-3 factory is judged and charged on
//      the 10,080 boundary and on no daily one before it; a Tier-1/2 licence beside it is still
//      judged and charged every day, byte for byte as if the Tier-3 licence were not there.
//   5. ISOLATION — a Tier-1/2-licensed galaxy with an unlicensed Tier-3 factory reproduces the
//      PRE-SLICE engine's bytes at every tick (hashes computed on HEAD f060689 and pinned).
//
// THE GAP, NOW CLOSED (test "THE GAP, CLOSED" below). 3a pinned it: on the DEFAULT paced Syndicate
// send a committed Tier-3 factory under-delivered and breached, because the pace's whole-unit
// intent mostly landed on ticks the timer minted nothing (the fork is fresh-only). Slice 3b built
// Syndicate-first delivery (docs/tier3-timed-production.md "Delivery — Syndicate first"): every
// minted unit goes to the Syndicate until the week's Q is met. The same test now asserts the
// default send MEETS. Slice 3b's own tripwires are in tier3-delivery.test.js.
//
// Since 3b a timed good's send control is not read at all, so the guilds below that set the
// `absolute` send (`met`, `mixed`, `late`, `heavy`) settle exactly as they would on the default
// send. They keep the setting, which now doubles as proof that it is inert.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  intake, validateAction, createApplyForLicenceAction, createRenegotiateLicenceAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { previewProduction } = require('../production.js');
const { getRecipe, listRecipes } = require('../recipes.js');
const {
  DEFAULT_WINDOW_N, TIER3_WINDOW_N, windowNForGood, tier3WindowNests, goodWindow,
  isWindowBoundary, winStartFor, getWindow,
} = require('../windows.js');
const {
  TICKS_PER_UNIT, ticksPerUnitFor, REFINERY_BASELINE, MINE_BASELINE,
} = require('../baseline.js');
const { TIER3_GOODS, RAW_RESOURCES, PROCESSED_GOODS } = require('../resources.js');
const { postedPrice, PRICED_GOODS } = require('../prices.js');
const {
  FEE_RATE, feeFraction, normalisedTerms, commitmentUnitsFor, licenceBasisFor, licenceBasisForGood,
  renegotiationScheduleFor,
} = require('../licence.js');

const SYS = 'sysA';
const WEEK = 10080;   // docs/tier3-timed-production.md: "exactly one 7-day window (10,080 ticks)"
const DAY = 1440;     // docs/cycle-and-calendar.md: the ruled day, 24 h × 60 ticks

// The timed Tier-3 goods — every Tier-3 good with a ruled timer (the four unclassified modules
// have none and stay continuous, docs/roadmap.md decision checklist).
const TIMED = TIER3_GOODS.filter((g) => ticksPerUnitFor(g) !== null);
// y — the ruled timed weekly output, typed from the doc's formula, not read off the code under
// test: 10,080 ÷ TICKS_PER_UNIT (every timed recipe makes one unit — tier3-timed-production.test.js).
const yOf = (good) => WEEK / ticksPerUnitFor(good);

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
// A guild row for createState. `absoluteSend` sets the EXISTING per-good Syndicate send control
// to "absolute, 1 unit a tick" for that good — a player lever that already exists (§5 Slice B).
function guildRow(id, ventures, stock = {}, absoluteSend = []) {
  const goods = {};
  for (const g of absoluteSend) goods[g] = { syndicate: { mode: 'absolute', value: 1 } };
  return {
    id, credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures,
    ...(absoluteSend.length ? { productionProfile: { [SYS]: { goods } } } : {}),
  };
}
function galaxy(guilds, extra = {}) {
  return createState({ guilds, reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, ...extra });
}
// A Tier-1/2 licence: a share of output and a 7-day term.
const licence = (guildId, ventureId, committedOutputPct) => createApplyForLicenceAction({
  guildId, ventureId, committedOutputPct, windowDays: 7,
});
// A Tier-3 licence (Slice 3c): `x` whole units of the weekly output `y`, and no term to choose.
// This file is 3a's; where it signed a Tier-3 licence at a percentage it now commits the whole
// units that percentage sized to (`round(pct × y)`, at most floor(y)), so every Q it measures is
// the one 3a measured.
const commitUnits = (guildId, ventureId, committedUnits) => createApplyForLicenceAction({
  guildId, ventureId, committedUnits,
});
const unitsAt = (good, pct) => Math.min(Math.round(pct * yOf(good)), Math.floor(yOf(good)));
function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `licence refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const ventureOf = (s, gid, vid) => guildOf(s, gid).ventures.find((v) => v.id === vid);

// --- 1. THE NUMBERS ---------------------------------------------------------------------------

test('the Tier-3 week is 10,080 ticks — exactly 7 ruled days — and only a TIMED good settles on it', () => {
  assert.equal(TIER3_WINDOW_N, WEEK, 'docs/tier3-timed-production.md "Contract & settlement"');
  assert.equal(TIER3_WINDOW_N, 7 * DEFAULT_WINDOW_N, 'seven of the ruled 1,440-tick days');
  assert.equal(TIMED.length, 21, 'the 21 classified Tier-3 modules');
  for (const engineN of [DAY, 60, 24]) {
    for (const good of TIMED) assert.equal(windowNForGood(good, engineN), WEEK, `${good} settles weekly`);
    for (const good of [...RAW_RESOURCES, ...PROCESSED_GOODS]) {
      assert.equal(windowNForGood(good, engineN), engineN, `${good} (Tier 1/2) keeps the galaxy's day`);
    }
    for (const good of TIER3_GOODS.filter((g) => ticksPerUnitFor(g) === null)) {
      assert.equal(windowNForGood(good, engineN), engineN, `${good} (unclassified, continuous) keeps the day`);
    }
  }
});

// --- 2. (d) THE WINDOWS NEST -------------------------------------------------------------------

test('(d) every Tier-3 week boundary is also a day boundary, and every week opens on a day start', () => {
  // Three anchors: none, a mid-day galaxy creation, and the extreme one-tick-after-midnight case
  // (calendar anchors are ≤ 0 — sim/calendar.js). Three weeks of ticks each.
  for (const anchor of [0, -600, -(DAY - 1)]) {
    let weekBoundaries = 0;
    for (let t = 1; t <= 3 * WEEK; t += 1) {
      if (!isWindowBoundary(t, WEEK, anchor)) continue;
      weekBoundaries += 1;
      assert.ok(isWindowBoundary(t, DAY, anchor), `anchor ${anchor}: week boundary ${t} is a day boundary`);
      const nextWeekStart = t + 1;
      assert.equal(winStartFor(nextWeekStart, WEEK, anchor), winStartFor(nextWeekStart, DAY, anchor),
        `anchor ${anchor}: the week after ${t} opens on the same tick as a day`);
    }
    assert.equal(weekBoundaries, 3, `anchor ${anchor}: three weeks, three boundaries`);
  }
  // The same property through the one helper the engine reads.
  assert.deepEqual(goodWindow('fuel_tank', WEEK, DAY), { windowN: WEEK, windowStart: 1 });
  assert.deepEqual(goodWindow('fuel_tank', WEEK + 1, DAY), { windowN: WEEK, windowStart: WEEK + 1 });
  assert.deepEqual(goodWindow('titanium', WEEK + 1, DAY), { windowN: DAY, windowStart: WEEK + 1 });
});

test('(d) a galaxy whose day does not divide the week cannot license a Tier-3 venture — refused, halted, and flagged', () => {
  assert.equal(tier3WindowNests(DAY), true);
  assert.equal(tier3WindowNests(24), true);
  assert.equal(tier3WindowNests(50), false, '10,080 ÷ 50 is not whole');
  assert.throws(() => windowNForGood('fuel_tank', 50), /fuel_tank.*does not divide/);
  assert.equal(windowNForGood('titanium', 50), 50, 'a Tier-1/2 good does not care');

  // Refused at intake, with the reason — not signed and then halted on.
  const s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')])], { windowN: 50 });
  const v = validateAction(s, commitUnits('g1', 'f', 336));
  assert.equal(v.valid, false);
  assert.match(v.reason, /Tier-3 good.*10080-tick week.*50-tick day/);

  // A hand-built state that got past intake anyway trips the invariant, naming the good.
  const bad = galaxy([guildRow('g1', [{ ...factory('f', 'g1', 'fuel_tank'), syndicateCommitment: 10 }])], { windowN: 50 });
  const rules = checkInvariants(bad, 0).filter((x) => x.rule.startsWith('tier3-week-nests'));
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].detail, { good: 'fuel_tank', weekTicks: WEEK, dayTicks: 50 });
  // …and the tick halts before settling it on a clock nothing watches.
  assert.throws(() => tick(bad), /does not divide/);
});

test('an UNLICENSED Tier-3 factory reads no window — it runs in any galaxy and mints no window state', () => {
  // A non-nesting day: if the unlicensed path asked for a window, this would throw.
  let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')], inputSets('fuel_tank', 5))], { windowN: 50 });
  for (let i = 0; i < 60; i += 1) s = tick(s);
  assert.equal(guildOf(s, 'g1').stockpiles[SYS].fuel_tank, 4, 'it produced (units on ticks 15/30/45/60)');
  assert.equal(guildOf(s, 'g1').syndicateWindows, undefined, 'and no window was ever created');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. (a) THE FEE AT SIGNING ------------------------------------------------------------------

test('(a) HEADLINE: a Tier-3 licence\'s basic fee is 0.10 × (10,080 ÷ TICKS_PER_UNIT) × price-at-signing — NOT 5 batches/tick × 1,440', () => {
  // One factory of every timed good, all signed at tick 0 at half its weekly output in whole
  // units (Slice 3c: x = round(y / 2), so x / y is 0.5 or just off it) with no equity.
  const ventures = TIMED.map((good) => factory(`f_${good}`, 'g1', good));
  let s = galaxy([guildRow('g1', ventures)]);
  s = sign(s, TIMED.map((good) => commitUnits('g1', `f_${good}`, unitsAt(good, 0.5))));
  for (const good of TIMED) {
    const lic = ventureOf(s, 'g1', `f_${good}`).licence;
    const price = postedPrice(s, good);
    assert.equal(lic.lockedPrice, price, `${good}: locked at the posted price`);
    const expected = Math.round(FEE_RATE * yOf(good) * price);
    assert.equal(lic.basicFee, expected, `${good}: 0.10 × ${yOf(good)} × ${price}`);
    const stale = Math.round(FEE_RATE * REFINERY_BASELINE[good] * getRecipe(good).output.qty * DAY * price);
    assert.notEqual(lic.basicFee, stale, `${good}: not the old 5-batches/tick × 1,440 figure`);
    const { c, oNorm } = normalisedTerms({ committedOutputPct: unitsAt(good, 0.5) / yOf(good), equityPct: 0 });
    assert.equal(lic.discountedFee, Math.round(expected * feeFraction(c, oNorm)), `${good}: the grid discounts the new basis`);
  }
  // Two worked examples, typed out: a 3-1 fuel tank (672 a week) and a heavy engine (3.5 a week).
  assert.equal(ventureOf(s, 'g1', 'f_fuel_tank').licence.basicFee, 6720, '0.10 × 672 × 100 (was 72,000)');
  assert.equal(ventureOf(s, 'g1', 'f_heavy_reactor_engine').licence.basicFee, 7000000, '0.10 × 3.5 × 20,000,000');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('(a) the committed quantity is the x whole units signed, of the weekly output y, at most floor(y)', () => {
  // 3a sized a percentage of y here; since Slice 3c the licence commits whole units directly, so
  // the committed quantity is exactly the `x` signed (sim/tests/tier3-contract.test.js has the
  // headline). The same three goods and three sizes as 3a, so the same quantities.
  const goods = ['fuel_tank', 'heavy_reactor_engine', 'deep_scan_mast'];
  for (const pct of [0.25, 0.5, 1]) {
    let s = galaxy([guildRow('g1', goods.map((g) => factory(`f_${g}`, 'g1', g)))]);
    s = sign(s, goods.map((g) => commitUnits('g1', `f_${g}`, unitsAt(g, pct))));
    for (const good of goods) {
      const y = yOf(good);
      assert.equal(ventureOf(s, 'g1', `f_${good}`).syndicateCommitment,
        Math.min(Math.round(pct * y), Math.floor(y)), `${good} at ${pct * 100}%`);
    }
  }
  // The ceiling bites exactly where y is fractional: a heavy engine makes 3.5 a week, and the most
  // it can commit is 3 — 4 is more than it can be sure to finish, and is refused.
  let s = galaxy([guildRow('g1', [factory('h', 'g1', 'heavy_reactor_engine')])]);
  assert.equal(validateAction(s, commitUnits('g1', 'h', 4)).valid, false, 'floor(3.5) is 3, not round(3.5) = 4');
  s = sign(s, [commitUnits('g1', 'h', 3)]);
  assert.equal(ventureOf(s, 'g1', 'h').syndicateCommitment, 3);
});

test('(a) float-safety: timer-pace × week lands on exactly the typed y for every timed good and every whole percent', () => {
  // The fee and the commitment multiply (1 ÷ TICKS_PER_UNIT) × 10,080 — the timer's pace over the
  // week — rather than dividing 10,080 by the timer. This pins that the two spellings of y never
  // round to different whole units, so no commitment is off by one on float noise.
  for (const good of TIMED) {
    const basis = licenceBasisForGood(good, DAY);
    assert.equal(basis.unitsPerTick * basis.windowN, yOf(good), `${good}: pace × week is exactly y`);
    for (let i = 0; i <= 100; i += 1) {
      const pct = i / 100;
      assert.equal(commitmentUnitsFor(pct, basis.unitsPerTick, basis.windowN),
        Math.min(Math.round(pct * yOf(good)), Math.floor(yOf(good))), `${good} at ${i}%`);
    }
  }
});

test('(c) a Tier-1/2 licence signs exactly as before: baseline × the 1,440 day × price', () => {
  let s = galaxy([guildRow('g1', [mine('m', 'g1', 'titanium', 160), factory('a', 'g1', 'titanium_alloy')])]);
  s = sign(s, [licence('g1', 'm', 0.25), licence('g1', 'a', 0.5)]);
  const m = ventureOf(s, 'g1', 'm');
  const a = ventureOf(s, 'g1', 'a');
  assert.equal(m.licence.basicFee, Math.round(FEE_RATE * MINE_BASELINE.titanium * DAY * postedPrice(s, 'titanium')));
  assert.equal(m.syndicateCommitment, Math.round(0.25 * MINE_BASELINE.titanium * DAY));
  const alloyUnits = REFINERY_BASELINE.titanium_alloy * getRecipe('titanium_alloy').output.qty;
  assert.equal(a.licence.basicFee, Math.round(FEE_RATE * alloyUnits * DAY * postedPrice(s, 'titanium_alloy')));
  assert.equal(a.syndicateCommitment, Math.round(0.5 * alloyUnits * DAY));
  assert.deepEqual(licenceBasisFor(m, DAY), { good: 'titanium', unitsPerTick: MINE_BASELINE.titanium, windowN: DAY });
});

test('the quote a player reads is the fee a signature locks — for every priced good, Tier 3 included', () => {
  const makers = PRICED_GOODS.map((good) => ({ good, basis: licenceBasisForGood(good, DAY) }))
    .filter((x) => x.basis !== null);
  const ventures = makers.map(({ good }) => (MINE_BASELINE[good] !== undefined
    ? mine(`v_${good}`, 'g1', good, MINE_BASELINE[good])
    : factory(`v_${good}`, 'g1', listRecipes().find((r) => r.output.good === good).id)));
  let s = galaxy([guildRow('g1', ventures)]);
  const quote = buildSnapshot(s).feeQuote;
  // Deuterium never takes the ordinary licence (§1.4), so it is quoted but not signed here.
  // Each signs at a zero commitment: 0% for Tier 1/2, x = 0 whole units for a timed Tier-3 good.
  const signable = makers.filter(({ good }) => good !== 'deuterium');
  s = sign(s, signable.map(({ good }) => (ticksPerUnitFor(good) !== null
    ? commitUnits('g1', `v_${good}`, 0) : licence('g1', `v_${good}`, 0))));
  for (const { good } of signable) {
    assert.equal(quote[good], ventureOf(s, 'g1', `v_${good}`).licence.basicFee, `${good}: quote = signed fee`);
  }
  assert.equal(quote.fuel_tank, 6720, 'the 3-1 quote is the weekly 0.10 × 672 × 100');
  // A day that does not divide the week has no Tier-3 quote (it cannot be signed there).
  const odd = buildSnapshot(galaxy([guildRow('g1', [])], { windowN: 50 })).feeQuote;
  assert.equal(odd.fuel_tank, undefined);
  assert.equal(odd.titanium, Math.round(FEE_RATE * MINE_BASELINE.titanium * 50 * postedPrice(s, 'titanium')));
});

test('a Tier-3 re-lock (renegotiateLicence) re-prices on the SAME weekly basis — it never slides back to the stale one', () => {
  let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')])]);
  s = sign(s, [commitUnits('g1', 'f', 336)]);
  // Jump to the Syndicate's acts tick without ticking (the renegotiation tests' own pattern),
  // so nothing else moves. Standing is Steady (the signing bump). 3a stepped the terms +0.10
  // here; since Slice 3c a Tier-3 re-offer is FIXED — the same 336 of 672 — and only re-priced.
  s.tick = renegotiationScheduleFor(ventureOf(s, 'g1', 'f'), DAY, 0).actsTick;
  const offer = buildSnapshot(s).ventures.find((v) => v.id === 'f').renegotiationOffer;
  const out = intake(s, [createRenegotiateLicenceAction({ guildId: 'g1', ventureId: 'f' })]);
  assert.equal(out.results[0].accepted, true, out.results[0].reason);
  const v = ventureOf(out.state, 'g1', 'f');
  const price = postedPrice(out.state, 'fuel_tank');
  assert.equal(v.licence.committedOutputPct, 0.5, 'the fixed re-offer: 336 of 672 again, no Steady +0.10 (Slice 3c)');
  assert.equal(v.licence.basicFee, Math.round(FEE_RATE * yOf('fuel_tank') * price), 'weekly basis');
  assert.equal(v.syndicateCommitment, 336, 'the same 336 whole units a week');
  assert.equal(offer.basicFee, v.licence.basicFee, 'the previewed offer is what was locked');
  assert.equal(offer.discountedFee, v.licence.discountedFee);
});

// --- 4. (b) + (c) ONE WEEK, SEVERAL GUILDS -------------------------------------------------------
//
// One galaxy, one week (10,080 ticks — the Tier-3 boundary cannot be reached any faster, so the
// run is shared by every test below rather than repeated). Guilds, all in one system each:
// (Since Slice 3c each Tier-3 factory commits whole units; "50%" is x = 336 of 672.)
//   met      a 3-1 factory at 50%, fed, absolute send            → met on 10,080, discounted fee
//   starved  the same with NO inputs                             → breach on 10,080, full fee
//   mixed    a titanium mine (T1, 25%) + the `met` factory       → the mine every day, the factory weekly
//   solo     the same titanium mine alone                        → (c)'s reference: mixed's mine must match it
//   late     the `met` factory, licensed at tick 5,040 (mid-week) → met on a half-week target, half the fee
//   heavy    a heavy reactor engine at its most, absolute send   → commits floor(3.5) = 3, met on 10,080
//   paced    the `met` factory on the DEFAULT send               → met (3a's gap, closed by Slice 3b)
const LATE_TICK = 5040;
let weekRun = null;
function runWeek() {
  if (weekRun) return weekRun;
  const tank = (gid) => factory('f', gid, 'fuel_tank');
  let s = galaxy([
    guildRow('met', [tank('met')], inputSets('fuel_tank', 700), ['fuel_tank']),
    guildRow('starved', [tank('starved')]),
    guildRow('mixed', [mine('m', 'mixed', 'titanium', 160), tank('mixed')], inputSets('fuel_tank', 700), ['fuel_tank']),
    guildRow('solo', [mine('m', 'solo', 'titanium', 160)]),
    guildRow('late', [tank('late')], inputSets('fuel_tank', 700), ['fuel_tank']),
    guildRow('heavy', [factory('f', 'heavy', 'heavy_reactor_engine')], inputSets('heavy_reactor_engine', 4), ['heavy_reactor_engine']),
    guildRow('paced', [tank('paced')], inputSets('fuel_tank', 700)),
  ]);
  s = sign(s, [
    commitUnits('met', 'f', 336), commitUnits('starved', 'f', 336),
    licence('mixed', 'm', 0.25), commitUnits('mixed', 'f', 336), licence('solo', 'm', 0.25),
    commitUnits('heavy', 'f', 3), commitUnits('paced', 'f', 336),
  ]);
  const signed = JSON.parse(JSON.stringify(s));
  const firstPreview = previewProduction(s);
  const fees = {};         // guildId -> [ the lastLicenceFee record, each time a new one is written ]
  const reputation = {};   // guildId -> [ { tick, rp } ] each time the Tier-3 venture's RP moved
  const tankWindow = [];   // the met guild's fuel-tank window, at each day's last and first tick
  let pacedAtWeekEnd = null; // the paced guild's fuel-tank window on the week's last tick
  const invariantsAt = {};
  const starvedVerdict = {}; // the resolver's verdict for the starved factory, on a day's end and the week's end
  for (const g of s.guilds) { fees[g.id] = []; reputation[g.id] = []; }
  while (s.tick < WEEK + 1) {
    if (s.tick === LATE_TICK) s = sign(s, [commitUnits('late', 'f', 336)]);
    if (s.tick === DAY - 1 || s.tick === WEEK - 1) {
      // previewProduction reports what the NEXT tick (a day end / the week end) will resolve.
      const w = previewProduction(s).find((g) => g.guildId === 'starved').systems[0].goods.fuel_tank.window;
      starvedVerdict[s.tick + 1] = { status: w.status, venture: w.perVenture.f.status };
    }
    const rpBefore = Object.fromEntries(s.guilds.map((g) => [g.id, (g.ventures.find((v) => v.id === 'f') || {}).reputation]));
    s = tick(s);
    for (const g of s.guilds) {
      if (g.lastLicenceFee && g.lastLicenceFee.tick === s.tick) fees[g.id].push(JSON.parse(JSON.stringify(g.lastLicenceFee)));
      const f = g.ventures.find((v) => v.id === 'f');
      if (f && f.reputation !== rpBefore[g.id]) reputation[g.id].push({ tick: s.tick, rp: f.reputation });
    }
    if (s.tick % DAY === 0 || s.tick % DAY === 1) {
      tankWindow.push({ tick: s.tick, ...getWindow(guildOf(s, 'met'), SYS, 'fuel_tank') });
    }
    if (s.tick === WEEK) pacedAtWeekEnd = { ...getWindow(guildOf(s, 'paced'), SYS, 'fuel_tank') };
    if (s.tick % DAY === 0) invariantsAt[s.tick] = checkInvariants(s, s.tick);
  }
  weekRun = { signed, firstPreview, end: s, fees, reputation, tankWindow, pacedAtWeekEnd, invariantsAt, starvedVerdict };
  return weekRun;
}
const DAY_ENDS = [1, 2, 3, 4, 5, 6, 7].map((d) => d * DAY);

test('(b) HEADLINE: a committed Tier-3 factory is judged and charged on the 10,080 boundary — and on no daily one before it', () => {
  const { signed, fees, reputation } = runWeek();
  const lic = signed.guilds.find((g) => g.id === 'met').ventures[0].licence;
  assert.deepEqual(fees.met.map((f) => f.tick), [WEEK], 'exactly one charge, on the week\'s last tick — none on days 1-6');
  assert.deepEqual(fees.met[0].ventures, {
    f: { status: 'met', owed: lic.discountedFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee },
  });
  assert.equal(lic.basicFee, 6720, 'the weekly fee, 0.10 × 672 × 100');
  assert.equal(fees.met[0].charged, lic.discountedFee, 'met → the discounted fee, the whole week\'s');
  // Reputation moves on the verdict and only there (invariant 8): signing bump, then once at 10,080.
  assert.deepEqual(reputation.met.map((r) => r.tick), [WEEK], 'RP moved once, on the week boundary');
});

test('(b) a starved Tier-3 factory breaches on the 10,080 boundary and pays the FULL weekly fee — not a daily one', () => {
  const { signed, fees, starvedVerdict } = runWeek();
  // The VERDICT itself (not only the charge) is the week's: at the end of day 1 the factory has
  // delivered nothing, yet it is still accruing — a shortfall is only a fact at ITS window's end.
  assert.deepEqual(starvedVerdict[DAY], { status: 'accruing', venture: 'accruing' }, 'day 1 ends: no verdict yet');
  assert.deepEqual(starvedVerdict[WEEK], { status: 'breach', venture: 'breach' }, 'the week ends: breach');
  const lic = signed.guilds.find((g) => g.id === 'starved').ventures[0].licence;
  assert.deepEqual(fees.starved.map((f) => f.tick), [WEEK]);
  assert.deepEqual(fees.starved[0].ventures.f, {
    status: 'breach', owed: lic.basicFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee,
  });
});

test('(b) the Tier-3 window spans the week: it does not roll at a day boundary, and its window counts down 10,080 ticks', () => {
  const { firstPreview, tankWindow, end } = runWeek();
  const w0 = firstPreview.find((g) => g.guildId === 'met').systems[0].goods.fuel_tank.window;
  assert.equal(w0.ticksRemaining, WEEK, 'on tick 1 the whole week remains');
  assert.equal(w0.Q, 336, '50% of 672 a week');
  // At every day boundary inside the week the stored window still opened on tick 1, and the
  // delivered pile carries across the day (it only grows). It rolls on tick 10,081.
  let last = -1;
  for (const w of tankWindow.filter((x) => x.tick <= WEEK)) {
    assert.equal(w.windowStart, 1, `tick ${w.tick}: still the week that opened on tick 1`);
    assert.ok(w.delivered >= last, `tick ${w.tick}: delivered carries across the day`);
    last = w.delivered;
  }
  assert.equal(last, 336, 'the whole weekly target was delivered by the week\'s end');
  assert.equal(getWindow(guildOf(end, 'met'), SYS, 'fuel_tank').windowStart, WEEK + 1, 'the next week opened on 10,081');
});

test('(c) a Tier-1/2 licence beside a Tier-3 one still settles EVERY DAY — its rows identical to the same mine with no Tier-3 sibling', () => {
  const { signed, fees } = runWeek();
  assert.deepEqual(fees.mixed.map((f) => f.tick), DAY_ENDS, 'a charge at each of the seven day ends');
  assert.deepEqual(fees.solo.map((f) => f.tick), DAY_ENDS);
  const mineLic = signed.guilds.find((g) => g.id === 'solo').ventures[0].licence;
  assert.equal(mineLic.basicFee, Math.round(FEE_RATE * MINE_BASELINE.titanium * DAY * 1), 'the unchanged daily fee (titanium at 1)');
  for (let d = 0; d < 7; d += 1) {
    assert.deepEqual(fees.mixed[d].ventures.m, fees.solo[d].ventures.m, `day ${d + 1}: the mine's verdict and fee are untouched`);
    const tier3Due = DAY_ENDS[d] === WEEK;
    assert.equal('f' in fees.mixed[d].ventures, tier3Due, `day ${d + 1}: the Tier-3 row appears only on the week's end`);
    const expectedLump = fees.solo[d].charged + (tier3Due ? fees.mixed[d].ventures.f.owed : 0);
    assert.equal(fees.mixed[d].charged, expectedLump, `day ${d + 1}: one lump of what was due that day`);
  }
  assert.deepEqual(fees.mixed[6].ventures.f, fees.met[0].ventures.f, 'and the factory settles exactly as it does alone');
});

test('a Tier-3 licence signed MID-WEEK owes the week pro-rated: half the week present → half the target, half the fee', () => {
  const { end, fees } = runWeek();
  const v = ventureOf(end, 'late', 'f');
  assert.equal(v.committedFromTick, LATE_TICK + 1);
  assert.equal(fees.late.length, 1);
  const row = fees.late[0].ventures.f;
  assert.equal(fees.late[0].tick, WEEK);
  assert.equal(row.status, 'met', 'met against the pro-rated target');
  // Present from tick 5,041 to 10,080 inclusive = 5,040 of 10,080 ticks — exactly half the week.
  assert.equal(row.owed, Math.round(v.licence.discountedFee * 0.5));
});

test('a heavy reactor engine at its most commits floor(3.5) = 3 and meets it on the week boundary', () => {
  const { signed, fees } = runWeek();
  const v = signed.guilds.find((g) => g.id === 'heavy').ventures[0];
  assert.equal(v.syndicateCommitment, 3);
  assert.equal(v.licence.basicFee, Math.round(FEE_RATE * 3.5 * 20000000));
  assert.deepEqual(fees.heavy.map((f) => f.tick), [WEEK]);
  assert.equal(fees.heavy[0].ventures.f.status, 'met');
});

test('THE GAP, CLOSED (Slice 3b): on the DEFAULT send a committed Tier-3 factory delivers its whole weekly Q and settles MET', () => {
  // Same factory, same inputs, same 50% as `met`; this one sets no send control. Under 3a the pace
  // wanted 1/30 of a unit a tick, its whole-unit intent mostly fell on ticks the timer minted
  // nothing, and the fork was fresh-only, so it delivered 100 of 336 and breached. Slice 3b's
  // Syndicate-first delivery (docs/tier3-timed-production.md) sends every minted unit until Q is
  // met, so the default send now meets, and settles exactly as `met` does.
  const { signed, fees, pacedAtWeekEnd } = runWeek();
  const lic = signed.guilds.find((g) => g.id === 'paced').ventures[0].licence;
  assert.deepEqual(fees.paced.map((f) => f.tick), [WEEK], 'it is still judged on the week boundary only');
  assert.equal(pacedAtWeekEnd.delivered, 336, 'the whole weekly target (50% of 672), not 3a\'s 100');
  assert.deepEqual(fees.paced[0].ventures.f, {
    status: 'met', owed: lic.discountedFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee,
  });
  assert.deepEqual(fees.paced[0].ventures.f, fees.met[0].ventures.f, 'the default send settles exactly like the absolute one');
});

test('invariants hold at every day boundary of the week, for every guild', () => {
  const { invariantsAt } = runWeek();
  assert.deepEqual(Object.keys(invariantsAt).map(Number), DAY_ENDS);
  for (const [t, v] of Object.entries(invariantsAt)) assert.deepEqual(v, [], `tick ${t}`);
});

// --- 5. ISOLATION: the pre-slice engine's bytes --------------------------------------------------
//
// A guild with a LICENSED Tier-1 mine and a LICENSED Tier-2 factory, running beside an UNLICENSED
// Tier-3 factory that is really producing, for 200 ticks on a 60-tick day. These two hashes were
// computed on the pre-slice engine (HEAD f060689) by the build session and pinned here: the new
// engine must reproduce them — every tick's state, not only the last. A second run on a 50-tick day
// (a day the Tier-3 week does NOT divide) must also run unchanged: the unlicensed factory never
// asks for a window, so it cannot trip the nesting halt.
const ISO_FINAL_N60 = 'ec96eb5bf7778cd4c16181431afbcffb6d981a63812e4dfaf22b1aeb4fd47b07';
const ISO_EVERY_TICK_N60 = '0bddb5091a455f8f395ba329482818b523a1fd38de9c1e7814efc706185e55b6';
const ISO_FINAL_N50 = '3951bbd14ed39bf103bf53a4d4d794f08b6afb6c53c8ba12c89c35c8d57aff7e';
const ISO_EVERY_TICK_N50 = 'd578f2949931a302068352991af3e29ccbf37eb5d17eb56e2a6a10803b2d9393';

function isolationRun(windowN) {
  const crypto = require('node:crypto');
  let s = galaxy([guildRow('g1', [
    mine('tm', 'g1', 'titanium', 15), mine('cm', 'g1', 'carbon_products', 5),
    factory('fa', 'g1', 'titanium_alloy'), factory('ft', 'g1', 'fuel_tank'),
  ], { titanium_alloy: 400, aluminium_alloy: 400, carbon_products: 400 })], { windowN });
  s = sign(s, [licence('g1', 'tm', 0.25), licence('g1', 'fa', 0.5)]);
  const everyTick = crypto.createHash('sha256');
  for (let i = 0; i < 200; i += 1) { s = tick(s); everyTick.update(hashState(s)); }
  return { final: hashState(s), everyTick: everyTick.digest('hex') };
}

test('ISOLATION: Tier-1/2 licences beside an unlicensed Tier-3 factory reproduce the pre-slice engine byte for byte', () => {
  assert.deepEqual(isolationRun(60), { final: ISO_FINAL_N60, everyTick: ISO_EVERY_TICK_N60 });
  assert.deepEqual(isolationRun(50), { final: ISO_FINAL_N50, everyTick: ISO_EVERY_TICK_N50 });
});
