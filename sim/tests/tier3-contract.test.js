'use strict';

// tier3-contract.test.js — Slice 3c of the Tier-3 economy build: the Tier-3 CONTRACT
// (docs/tier3-timed-production.md "Income & commitment", "Contract & settlement",
// "Renegotiation — fixed re-offer").
//
// A licence on a TIMED Tier-3 good is a different contract from a Tier-1/2 licence in three ways:
//   (a) it commits `x` WHOLE UNITS of its weekly output `y = 10,080 ÷ TICKS_PER_UNIT`, an integer
//       in [0, floor(y)], and stores the exact ratio `committedOutputPct = x / y`;
//   (b) its term is ONE WEEK — one of its weekly settlement windows — so a teardown owes at most
//       that one week's fee and locks the node only until the week ends;
//   (c) at term end the Syndicate re-offers IDENTICAL terms, whatever the venture's standing.
//   (d) A Tier-1/2 licence keeps its percentage, its 7–42 day term and the standing ratchet, and
//       a Tier-1/2 galaxy reproduces the pre-slice engine's bytes (hashes computed on HEAD 5867c18).
//
// The payment (still on delivered units, so still lumpy) is Slice 3d's and is not tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const {
  intake, validateAction, createApplyForLicenceAction, createRenegotiateLicenceAction,
  createLapseLicenceAction, createDecommissionVentureAction, createFoundGuildAction,
  createEstablishVentureAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { getRecipe } = require('../recipes.js');
const { ticksPerUnitFor, MINE_BASELINE } = require('../baseline.js');
const { TIER3_GOODS } = require('../resources.js');
const { postedPrice } = require('../prices.js');
const { getWindow } = require('../windows.js');
const {
  FEE_RATE, feeFraction, normalisedTerms, ventureTierWeight, teardownSettlement, licenceEndTick,
  renegotiationSchedule, renegotiationScheduleFor, renegotiationTerms, commitmentUnitsFor,
  licenceBasisForGood, licenceWindowN, committedPctForUnits, STRONG_FEE_DISCOUNT,
} = require('../licence.js');
const { HOME_SYSTEM, HOME_SLOT } = require('./home-anchor.js');

const SYS = 'sysA';
const WEEK = 10080;   // docs/tier3-timed-production.md: "exactly one 7-day window (10,080 ticks)"
const DAY = 1440;     // docs/cycle-and-calendar.md: the ruled day

// The 21 timed Tier-3 goods, and `y` typed from the doc's formula (not read off the code).
const TIMED = TIER3_GOODS.filter((g) => ticksPerUnitFor(g) !== null);
const yOf = (good) => WEEK / ticksPerUnitFor(good);

const factory = (id, ownerGuildId, recipeId) => ({
  id, ownerGuildId, type: 'refining', systemId: SYS, recipeId, productionRate: 5,
});
const mine = (id, ownerGuildId, good, productionRate) => ({
  id, ownerGuildId, type: 'mining', systemId: SYS, resourceType: good, productionRate,
});
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
function guildRow(id, ventures, stock = {}) {
  return { id, credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures };
}
function galaxy(guilds, extra = {}) {
  return createState({ guilds, reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, ...extra });
}
// The two licence shapes: Tier 3 commits whole units and picks no term; Tier 1/2 a share + a term.
const units = (guildId, ventureId, committedUnits) => createApplyForLicenceAction({ guildId, ventureId, committedUnits });
const share = (guildId, ventureId, committedOutputPct, windowDays = 7) => createApplyForLicenceAction({
  guildId, ventureId, committedOutputPct, windowDays,
});
function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const ventureOf = (s, gid, vid) => guildOf(s, gid).ventures.find((v) => v.id === vid);
// Put a venture's RP at `rp` (and keep the guild sum exact), to place it in a standing band.
function setRp(s, gid, vid, rp) {
  const g = guildOf(s, gid);
  const v = ventureOf(s, gid, vid);
  g.guildReputation += rp - (v.reputation || 0);
  v.reputation = rp;
}
const BANDS = { atRisk: -400, subPar: -100, steady: 100, strong: 600 };

// --- 1. (a) WHOLE UNITS ------------------------------------------------------------------------

test('(a) HEADLINE: a Tier-3 licence commits x whole units of its weekly output y and stores committedOutputPct = x / y exactly', () => {
  for (const pick of [() => 0, () => 1, (y) => Math.floor(y / 2), (y) => Math.floor(y)]) {
    let s = galaxy([guildRow('g1', TIMED.map((good) => factory(`f_${good}`, 'g1', good)))]);
    s = sign(s, TIMED.map((good) => units('g1', `f_${good}`, pick(yOf(good)))));
    for (const good of TIMED) {
      const y = yOf(good);
      const x = pick(y);
      const v = ventureOf(s, 'g1', `f_${good}`);
      const price = postedPrice(s, good);
      assert.equal(v.syndicateCommitment, x, `${good}: delivery and settlement read x`);
      assert.equal(v.licence.committedOutputPct, x / y, `${good}: the exact ratio x / y (y = ${y})`);
      assert.equal(v.licence.windowDays, 1, `${good}: a one-week term`);
      const basicFee = Math.round(FEE_RATE * y * price);
      assert.equal(v.licence.basicFee, basicFee, `${good}: 0.10 × y × price`);
      const { c, oNorm } = normalisedTerms({ committedOutputPct: x / y, equityPct: 0 });
      assert.equal(v.licence.discountedFee, Math.round(basicFee * feeFraction(c, oNorm)), `${good}: the grid reads x / y`);
      assert.equal(v.reputation || 0, Math.round(2 * (x / y) * ventureTierWeight(v)), `${good}: the signing bump reads x / y`);
    }
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  // Worked by hand: a heavy reactor engine (y = 3.5) at its most, x = 3. The ratio is 6/7, not a
  // full commitment, so the grid takes 25 × 6/7 points off the fee: 7,000,000 × (1 − 0.25 × 6/7).
  let s = galaxy([guildRow('g1', [factory('h', 'g1', 'heavy_reactor_engine')])]);
  s = sign(s, [units('g1', 'h', 3)]);
  const h = ventureOf(s, 'g1', 'h');
  assert.equal(h.licence.committedOutputPct, 3 / 3.5);
  assert.deepEqual([h.licence.basicFee, h.licence.discountedFee], [7000000, 5500000]);
});

test('(a) x must be a whole number in [0, floor(y)] — anything else is refused, and the refusal names the bound', () => {
  const s = galaxy([guildRow('g1', [
    factory('t', 'g1', 'fuel_tank'), factory('h', 'g1', 'heavy_reactor_engine'), factory('d', 'g1', 'deep_scan_mast'),
  ])]);
  const raw = (ventureId, extra) => ({ type: 'applyForLicence', guildId: 'g1', ventureId, ...extra });
  for (const bad of [-1, 673, 2.5, '5', null, NaN, Infinity]) {
    const v = validateAction(s, raw('t', { committedUnits: bad }));
    assert.equal(v.valid, false, `fuel tank x = ${String(bad)}`);
    assert.match(v.reason, /committedUnits must be an integer from 0 to 672 \(the floor of its weekly output y = 672\)/);
  }
  assert.match(validateAction(s, raw('t', {})).reason, /from 0 to 672/, 'no x at all');
  // A fractional y: the bound is its floor, and the refusal says so.
  assert.match(validateAction(s, units('g1', 'h', 4)).reason, /from 0 to 3 \(the floor of its weekly output y = 3\.5\)/);
  assert.match(validateAction(s, units('g1', 'd', 3)).reason, /from 0 to 2 \(the floor of its weekly output y = 2\.33\)/);
  // Every whole number in range is accepted, ends included.
  for (const [vid, x] of [['t', 0], ['t', 672], ['h', 3], ['d', 2], ['d', 0]]) {
    assert.deepEqual(validateAction(s, units('g1', vid, x)), { valid: true }, `${vid} x = ${x}`);
  }
});

test('(a) a Tier-3 licence takes no percentage and no term — the Tier-1/2 shape is refused, and the creator will not mix them', () => {
  const s = galaxy([guildRow('g1', [factory('t', 'g1', 'fuel_tank'), mine('m', 'g1', 'titanium', 15)])]);
  const pct = validateAction(s, share('g1', 't', 0.5, 7));
  assert.equal(pct.valid, false);
  assert.match(pct.reason, /Tier-3 good — its licence commits whole units, not a percentage: send committedUnits, an integer from 0 to 672/);
  // A term, even alongside a legal x — even a term of "1" — is not the applicant's to set.
  for (const windowDays of [7, 1]) {
    const v = validateAction(s, { type: 'applyForLicence', guildId: 'g1', ventureId: 't', committedUnits: 336, windowDays });
    assert.match(v.reason, /contract term is fixed at one week, so it takes no windowDays/, `windowDays ${windowDays}`);
  }
  assert.throws(() => createApplyForLicenceAction({ guildId: 'g1', ventureId: 't', committedUnits: 336, windowDays: 7 }), /takes no committedOutputPct and no windowDays/);
  assert.throws(() => createApplyForLicenceAction({ guildId: 'g1', ventureId: 't', committedUnits: 336, committedOutputPct: 0.5 }), /takes no committedOutputPct and no windowDays/);
  // And the reverse: a Tier-1/2 good does not take whole units.
  assert.match(validateAction(s, units('g1', 'm', 100)).reason, /"titanium" is a Tier-1\/2 good .* committedUnits is the Tier-3 whole-unit commitment/);
});

// One committed week, end to end: a fuel-tank factory at x = 200 of 672 — a count whose ratio,
// 0.2976…, is no whole percentage, so any reader still sizing off a percentage would show up.
let weekRun = null;
function runWeek() {
  if (weekRun) return weekRun;
  let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')], inputSets('fuel_tank', 700))]);
  s = sign(s, [units('g1', 'f', 200)]);
  const signed = JSON.parse(JSON.stringify(s));
  let rpBeforeBoundary = null;
  while (s.tick < WEEK) {
    if (s.tick === WEEK - 1) rpBeforeBoundary = ventureOf(s, 'g1', 'f').reputation;
    s = tick(s);
  }
  weekRun = { signed, end: s, rpBeforeBoundary };
  return weekRun;
}

test('(a) fee, reputation, delivery and settlement all read the ONE commitment: x = 200 delivered, met, charged and scored on 200 / 672', () => {
  const { signed, end, rpBeforeBoundary } = runWeek();
  const lic = ventureOf(signed, 'g1', 'f').licence;
  const g = guildOf(end, 'g1');
  // Delivery (3b) and settlement (3a) read x: 200 to the Syndicate first, the other 472 kept.
  assert.deepEqual(getWindow(g, SYS, 'fuel_tank'), { windowStart: 1, delivered: 200, sendCarry: 0 });
  assert.equal(g.stockpiles[SYS].fuel_tank, 472);
  // The fee reads x / y: met, so the discounted fee — the grid at 200 / 672.
  assert.equal(g.lastLicenceFee.tick, WEEK);
  assert.deepEqual(g.lastLicenceFee.ventures.f, {
    status: 'met', owed: lic.discountedFee, basicFee: lic.basicFee, discountedFee: lic.discountedFee,
  });
  assert.equal(lic.discountedFee, Math.round(6720 * (1 - 0.25 * (200 / 672))));
  // Reputation reads x / y: bump round(2 × 200/672 × 300) = 179 (a 30% licence would be 180), and
  // the met gain round(10 × 0.5 × 200/672) = 1 (a 30% licence would be 2).
  assert.equal(ventureOf(signed, 'g1', 'f').reputation, 179);
  assert.equal(rpBeforeBoundary, 179, 'nothing moved RP before the boundary');
  assert.equal(ventureOf(end, 'g1', 'f').reputation, 180);
  assert.deepEqual(checkInvariants(end, end.tick), []);
});

// --- 2. (b) THE ONE-WEEK TERM ------------------------------------------------------------------

// A real seeded galaxy: the guild founded on its home system, a fuel-tank factory seated on a
// real settlement slot and licensed at x = 336, at the ruled 1,440-tick day.
const FACTORY_ASSET = 'asset_player-guild_factory_01';
function seatedTier3() {
  let s = advance(createZeroState(), [
    createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]).state;
  s = advance(s, [
    createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'tank', type: 'refining', siteId: HOME_SLOT, assetId: FACTORY_ASSET, recipeId: 'fuel_tank', productionRate: 5 }),
    units('player-guild', 'tank', 336),
  ]).state;
  return s;
}

test('(b) HEADLINE: a Tier-3 licence torn down on day 1 pays ONE week\'s fee — not seven — and its node is locked only until its week ends', () => {
  let s = seatedTier3();
  const v = ventureOf(s, 'player-guild', 'tank');
  const lic = v.licence;
  assert.equal(lic.windowDays, 1);
  // Day 1 of its week. (A jump, the renegotiation tests' own pattern: nothing else needs to move.)
  s.tick = lic.signedTick + DAY;
  const credits = guildOf(s, 'player-guild').credits;
  const ledger = s.syndicate.ledger;
  const out = intake(s, [createDecommissionVentureAction({ guildId: 'player-guild', ventureId: 'tank' })]);
  assert.equal(out.results[0].accepted, true, out.results[0].reason);
  const after = out.state;
  const charged = credits - guildOf(after, 'player-guild').credits;
  assert.equal(charged, lic.discountedFee, 'one weekly fee');
  assert.notEqual(charged, 7 * lic.discountedFee, 'not the seven weekly fees a day-counted term charged (the 3a defect)');
  assert.equal(after.syndicate.ledger - ledger, charged, 'and the ledger took exactly that (invariant 2)');
  // The lockout runs to the end of the abandoned week: signing + 10,080, so at most a week.
  assert.deepEqual(after.nodeLockouts, [{ siteId: HOME_SLOT, releaseTick: lic.signedTick + WEEK, lockedAtTick: s.tick }]);
  assert.ok(after.nodeLockouts[0].releaseTick - s.tick <= WEEK);
  assert.deepEqual(checkInvariants(after, after.tick), []);
  // The slot really is locked until then, and free from then.
  const reseat = createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'tank2', type: 'refining', siteId: HOME_SLOT, assetId: FACTORY_ASSET, recipeId: 'fuel_tank', productionRate: 5 });
  after.tick = lic.signedTick + WEEK - 1;
  assert.match(validateAction(after, reseat).reason, /locked after a venture teardown/);
  after.tick = lic.signedTick + WEEK;
  assert.deepEqual(validateAction(after, reseat), { valid: true });
});

test('(b) whichever day of its week a Tier-3 licence is torn down, it owes that one weekly fee; from the week\'s end it owes nothing', () => {
  // A Tier-3 factory and, beside it, a 7-day titanium mine whose term is counted in DAYS (unchanged).
  let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank'), mine('m', 'g1', 'titanium', 15)])]);
  s = sign(s, [units('g1', 'f', 336), share('g1', 'm', 0.5, 7)]);
  const f = ventureOf(s, 'g1', 'f');
  const m = ventureOf(s, 'g1', 'm');
  for (const t of [1, DAY, 2 * DAY, 3 * DAY, 5 * DAY, 6 * DAY, WEEK - 1]) {
    s.tick = t;
    assert.deepEqual(teardownSettlement(s, guildOf(s, 'g1'), f),
      { settlementFee: f.licence.discountedFee, lockoutUntilTick: WEEK, rpForfeit: f.reputation }, `Tier 3 at tick ${t}`);
    const daysLeft = 7 - Math.floor(t / DAY);
    assert.equal(teardownSettlement(s, guildOf(s, 'g1'), m).settlementFee, daysLeft * m.licence.discountedFee, `Tier 1 at tick ${t}: ${daysLeft} days`);
  }
  for (const t of [WEEK, WEEK + 1, 3 * WEEK]) {
    s.tick = t;
    assert.deepEqual(teardownSettlement(s, guildOf(s, 'g1'), f),
      { settlementFee: 0, lockoutUntilTick: null, rpForfeit: f.reputation }, `past its week, tick ${t}`);
  }
  // A licence signed mid-week runs its own week from signing: owed until signing + 10,080.
  let late = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')])]);
  late.tick = 5040;
  late = sign(late, [units('g1', 'f', 336)]);
  late.tick = 5040 + 6 * DAY;
  assert.equal(teardownSettlement(late, guildOf(late, 'g1'), ventureOf(late, 'g1', 'f')).lockoutUntilTick, 5040 + WEEK);
  // The week is 10,080 ticks whatever the galaxy's day length (here a 60-tick day).
  let short = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')])], { windowN: 60 });
  short = sign(short, [units('g1', 'f', 336)]);
  short.tick = 600;
  assert.equal(teardownSettlement(short, guildOf(short, 'g1'), ventureOf(short, 'g1', 'f')).lockoutUntilTick, WEEK);
});

test('(b) the term is derived, not chosen: one window of the week — so the licence reopens, is offered and auto-lapses on a 7-day contract\'s timeline', () => {
  let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank'), mine('m', 'g1', 'titanium', 15)])]);
  s = sign(s, [units('g1', 'f', 336), share('g1', 'm', 0.5, 7)]);
  const f = ventureOf(s, 'g1', 'f');
  const m = ventureOf(s, 'g1', 'm');
  assert.equal(licenceWindowN(f, DAY), WEEK, 'a Tier-3 licence window is the week');
  assert.equal(licenceWindowN(m, DAY), DAY, 'a Tier-1/2 licence window is the day');
  assert.equal(licenceEndTick(f.licence, licenceWindowN(f, DAY)), WEEK);
  // The whole renegotiation timeline equals a 7-day Tier-1/2 licence's signed on the same tick.
  // (It is day-aligned on the calendar: tick 0 is the last tick of day −1, so a licence signed
  // there is "signed on day −1", its seven days end as day 6 opens (tick 8,641), the Syndicate acts
  // a day's grace later and the offer stands five days. The raw term — the renegotiate/lapse gate,
  // the teardown fee and the lockout — is signing + 10,080. Both are the existing Tier-1/2 rules.)
  const sched = renegotiationScheduleFor(f, DAY, 0);
  assert.deepEqual(sched, renegotiationSchedule(m.licence, DAY, 0));
  assert.deepEqual(sched, { windowEndTick: 6 * DAY + 1, actsTick: 7 * DAY + 1, lapseTick: 12 * DAY + 1 });
  // Renegotiation and lapse open at the week's end — not after one day.
  const reneg = createRenegotiateLicenceAction({ guildId: 'g1', ventureId: 'f' });
  const lapse = createLapseLicenceAction({ guildId: 'g1', ventureId: 'f' });
  s.tick = DAY;
  assert.match(validateAction(s, reneg).reason, /ends at tick 10080, now 1440/);
  s.tick = WEEK - 1;
  assert.match(validateAction(s, lapse).reason, /ends at tick 10080, now 10079/);
  s.tick = WEEK;
  assert.deepEqual(validateAction(s, reneg), { valid: true });
  assert.deepEqual(validateAction(s, lapse), { valid: true });
  // The snapshot's contract window and offer read the same timeline (still counted in days).
  s.tick = 0;
  const row0 = buildSnapshot(s).ventures.find((v) => v.id === 'f');
  assert.deepEqual(row0.contractWindow, { endTick: sched.windowEndTick, endCycle: 6, cyclesRemaining: 7, expired: false });
  s.tick = sched.actsTick - 1;
  assert.equal(buildSnapshot(s).ventures.find((v) => v.id === 'f').renegotiationOffer, null, 'grace: no offer yet');
  s.tick = sched.actsTick;
  const offer = buildSnapshot(s).ventures.find((v) => v.id === 'f').renegotiationOffer;
  assert.equal(offer.lapseTick, sched.lapseTick);
  assert.equal(offer.daysToLapse, 5);
  // And the tick's auto-lapse fires on that deadline, not before.
  s.tick = sched.lapseTick - 2;
  s = tick(s);
  assert.ok(ventureOf(s, 'g1', 'f').licence, 'still licensed the tick before the deadline');
  s = tick(s);
  assert.equal(ventureOf(s, 'g1', 'f').licence, undefined, 'lapsed on the deadline');
  // HEAD, for contrast: with the term counted in DAYS, a one-window licence would have reopened
  // after one day and auto-lapsed on day 6, before its week was ever settled.
  const dayCounted = renegotiationSchedule(f.licence, DAY, 0);
  assert.equal(dayCounted.lapseTick, 6 * DAY + 1, 'the day-counted reading this slice rules out');
});

test('(a)(b) the invariant names a Tier-3 licence whose term was chosen, or whose stored ratio is not its x of y', () => {
  const signed = sign(galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank'), mine('m', 'g1', 'titanium', 15)])]),
    [units('g1', 'f', 336), share('g1', 'm', 0.5, 7)]);
  assert.deepEqual(checkInvariants(signed, 0), []);
  const edit = (fn) => { const s = JSON.parse(JSON.stringify(signed)); fn(ventureOf(s, 'g1', 'f'), ventureOf(s, 'g1', 'm')); return checkInvariants(s, 0).map((v) => v.rule); };
  assert.deepEqual(edit((f) => { f.licence.windowDays = 7; }), ['tier3-term-is-one-week (Tier-3 contract)'], 'seven WEEKS');
  assert.deepEqual(edit((f) => { f.syndicateCommitment = 337; }), ['tier3-commitment-is-x-of-y (Tier-3 contract)'], 'x moved without its ratio');
  assert.deepEqual(edit((f) => { f.licence.committedOutputPct = 0.51; }), ['tier3-commitment-is-x-of-y (Tier-3 contract)'], 'the ratio moved without x');
  assert.ok(edit((f) => { f.syndicateCommitment = 673; f.licence.committedOutputPct = 673 / 672; }).includes('tier3-commitment-is-x-of-y (Tier-3 contract)'), 'x above floor(y)');
  // A Tier-1/2 licence keeps its 7–42 day bounds: a one-window term is refused there.
  assert.deepEqual(edit((f, m) => { m.licence.windowDays = 1; }), ['renegotiation-window-in-bounds (§5)']);
});

// --- 3. (c) THE FIXED RE-OFFER -----------------------------------------------------------------

test('(c) HEADLINE: a Tier-3 licence renegotiates to IDENTICAL terms at every standing — no ratchet, no jump to 100%, no Strong discount; only the price is refreshed', () => {
  for (const [band, rp] of Object.entries(BANDS)) {
    let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank')])]);
    s = sign(s, [units('g1', 'f', 200)]);
    const signedLic = { ...ventureOf(s, 'g1', 'f').licence };
    setRp(s, 'g1', 'f', rp);
    // The market moved since signing: the re-offer is priced at today's posted price.
    s.prices.fuel_tank.posted = 150;
    s.tick = renegotiationScheduleFor(ventureOf(s, 'g1', 'f'), DAY, 0).actsTick;
    assert.deepEqual(renegotiationTerms(ventureOf(s, 'g1', 'f')), { committedOutputPct: 200 / 672, windowDays: 1, feeDiscount: 0 }, band);
    const offer = buildSnapshot(s).ventures.find((v) => v.id === 'f').renegotiationOffer;
    s = sign(s, [createRenegotiateLicenceAction({ guildId: 'g1', ventureId: 'f' })]);
    const v = ventureOf(s, 'g1', 'f');
    assert.equal(v.licence.committedOutputPct, signedLic.committedOutputPct, `${band}: the same x / y, to the bit`);
    assert.equal(v.syndicateCommitment, 200, `${band}: the same 200 whole units`);
    assert.equal(v.licence.windowDays, 1, `${band}: the same one-week term`);
    const basicFee = Math.round(FEE_RATE * 672 * 150);
    assert.equal(v.licence.basicFee, basicFee, `${band}: re-priced at today's 150 (was ${signedLic.basicFee})`);
    assert.equal(v.licence.discountedFee, Math.round(basicFee * (1 - 0.25 * (200 / 672))), `${band}: no Strong discount`);
    assert.equal(v.reputation, rp, `${band}: RP carries, no fresh bump`);
    assert.deepEqual({ c: offer.committedOutputPct, b: offer.basicFee, d: offer.discountedFee, f: offer.feeDiscountApplied },
      { c: v.licence.committedOutputPct, b: v.licence.basicFee, d: v.licence.discountedFee, f: false }, `${band}: the offer shown is what was locked`);
    assert.deepEqual(checkInvariants(s, s.tick), [], band);
    // And again: a second renewal a week later still holds x.
    s.tick = renegotiationScheduleFor(v, DAY, 0).actsTick;
    s = sign(s, [createRenegotiateLicenceAction({ guildId: 'g1', ventureId: 'f' })]);
    assert.equal(ventureOf(s, 'g1', 'f').syndicateCommitment, 200, `${band}: still 200 after two renewals`);
    assert.equal(ventureOf(s, 'g1', 'f').licence.committedOutputPct, signedLic.committedOutputPct);
  }
});

test('(c) every legal x survives the re-lock unchanged — all 21 timed goods, every x from 0 to floor(y), at every standing', () => {
  let checked = 0;
  for (const good of TIMED) {
    const basis = licenceBasisForGood(good, DAY);
    for (let x = 0; x <= Math.floor(yOf(good)); x += 1) {
      const pct = committedPctForUnits(x, basis);
      for (const rp of Object.values(BANDS)) {
        const venture = { id: 'v', type: 'refining', recipeId: good, reputation: rp, licence: { committedOutputPct: pct, windowDays: 1 } };
        const terms = renegotiationTerms(venture);
        assert.equal(terms.committedOutputPct, pct);
        assert.equal(commitmentUnitsFor(terms.committedOutputPct, basis.unitsPerTick, basis.windowN), x, `${good} x = ${x}`);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 5139, 'every (good, x) pair');
});

// --- 4. (d) TIER 1/2 UNCHANGED -----------------------------------------------------------------

test('(d) HEADLINE: a Tier-1/2 licence still commits a percentage, picks a 7–42 day term, and gets the standing ratchet', () => {
  const s0 = galaxy([guildRow('g1', [mine('m', 'g1', 'titanium', 15)])]);
  for (const windowDays of [6, 43, 1, 7.5]) {
    assert.match(validateAction(s0, share('g1', 'm', 0.3, windowDays)).reason, /windowDays must be a whole number of days between 7 and 42/);
  }
  assert.match(validateAction(s0, share('g1', 'm', 1.2, 14)).reason, /committedOutputPct must be a fraction between 0 and 1/);
  const signed = sign(s0, [share('g1', 'm', 0.3, 14)]);
  const lic = ventureOf(signed, 'g1', 'm').licence;
  assert.deepEqual({ c: lic.committedOutputPct, w: lic.windowDays }, { c: 0.3, w: 14 });
  assert.equal(ventureOf(signed, 'g1', 'm').syndicateCommitment, Math.round(0.3 * MINE_BASELINE.titanium * DAY));
  // Torn down on day 1 of its 14-day term it owes 13 daily fees, locked out to day 14 — as ever.
  const t = JSON.parse(JSON.stringify(signed));
  t.tick = DAY;
  assert.deepEqual(teardownSettlement(t, guildOf(t, 'g1'), ventureOf(t, 'g1', 'm')),
    { settlementFee: 13 * lic.discountedFee, lockoutUntilTick: 14 * DAY, rpForfeit: ventureOf(t, 'g1', 'm').reputation });
  // The ratchet, band by band (design.md §5): Strong keeps (and takes the discount), Steady +0.10,
  // Sub-par +0.25, At risk jumps to 100%.
  const expected = { atRisk: [1, 0], subPar: [0.55, 0], steady: [0.4, 0], strong: [0.3, STRONG_FEE_DISCOUNT] };
  for (const [band, rp] of Object.entries(BANDS)) {
    const s = JSON.parse(JSON.stringify(signed));
    setRp(s, 'g1', 'm', rp);
    const terms = renegotiationTerms(ventureOf(s, 'g1', 'm'));
    assert.deepEqual(terms, { committedOutputPct: expected[band][0], windowDays: 14, feeDiscount: expected[band][1] }, band);
    s.tick = renegotiationScheduleFor(ventureOf(s, 'g1', 'm'), DAY, 0).actsTick;
    const after = sign(s, [createRenegotiateLicenceAction({ guildId: 'g1', ventureId: 'm' })]);
    assert.equal(ventureOf(after, 'g1', 'm').licence.committedOutputPct, expected[band][0], `${band}: re-locked on the ratchet`);
    assert.equal(ventureOf(after, 'g1', 'm').licence.windowDays, 14, `${band}: its own term carries`);
  }
});

// ISOLATION. A Tier-1/2 licence lifecycle on a 60-tick day, run through every path this slice
// touched: signing at several shares and terms, the daily charge, teardown mid-term and after a
// re-lock, renegotiation at every standing band (hand-set RP), an early renegotiate/lapse refused,
// a REJECT, and an auto-lapse — beside an UNLICENSED Tier-3 factory really producing. Each tick's
// state, the snapshot every 10 ticks (contract window, teardown preview, offer), and every intake
// result are hashed. The two hashes were computed on the PRE-SLICE engine (HEAD 5867c18) by the
// build session and pinned: the new engine must reproduce them.
const ISO_STATE_EVERY_TICK = '96e4b9caba27f61dcd8d2518db6e9cbe56b09e2928300082cfb6e2c2f0993006';
const ISO_SNAPSHOTS_AND_RESULTS = '240ee2aa089e496e5a65ae7bd10f30fdbeb8ebfc1aaf3ca7057cca94060b6af6';

function isolationRun() {
  const N = 60;
  const lic = (guildId, ventureId, committedOutputPct, windowDays) => createApplyForLicenceAction({ guildId, ventureId, committedOutputPct, windowDays });
  const act = (type) => (guildId, ventureId) => ({ type, guildId, ventureId });
  const reneg = act('renegotiateLicence');
  const lapse = act('lapseLicence');
  const decom = act('decommissionVenture');
  const rp = (gid, vid, delta) => (s) => {
    const v = ventureOf(s, gid, vid);
    v.reputation = (v.reputation || 0) + delta;
    guildOf(s, gid).guildReputation += delta;
  };
  const schedule = {
    0: [lic('g1', 'tm', 0.25, 7), lic('g1', 'fa', 0.5, 14), lic('g2', 'm1', 1, 7), lic('g2', 'm2', 0, 7), lic('g2', 'm3', 0.3, 7), lic('g2', 'm4', 0.7, 21)],
    137: [decom('g2', 'm3'), reneg('g1', 'tm'), lapse('g1', 'tm')],
    300: [rp('g2', 'm1', 700), rp('g1', 'tm', -150), rp('g2', 'm4', -500)],
    483: [reneg('g1', 'tm'), reneg('g2', 'm1')],
    540: [decom('g1', 'fa')],
    700: [lic('g2', 'm3b', 0.55, 9)],
    1000: [lapse('g1', 'tm')],
    1100: [decom('g2', 'm1')],
    1500: [reneg('g2', 'm4')],
  };
  let s = galaxy([
    { id: 'g1', credits: 5000000, fuelHoard: 0, stockpiles: { [SYS]: { ...inputSets('fuel_tank', 200), titanium_alloy: 900, carbon_products: 900 } },
      ventures: [mine('tm', 'g1', 'titanium', 15), factory('fa', 'g1', 'titanium_alloy'), factory('ft', 'g1', 'fuel_tank')] },
    { id: 'g2', credits: 5000000, fuelHoard: 0, stockpiles: { [SYS]: {} },
      ventures: [mine('m1', 'g2', 'titanium', 12), mine('m2', 'g2', 'carbon_products', 5), mine('m3', 'g2', 'titanium', 4), mine('m3b', 'g2', 'titanium', 2), mine('m4', 'g2', 'titanium', 20)] },
  ], { windowN: N });
  const stateHash = crypto.createHash('sha256');
  const snapHash = crypto.createHash('sha256');
  for (let i = 0; i < 1600; i += 1) {
    const due = schedule[s.tick] || [];
    for (const f of due.filter((a) => typeof a === 'function')) f(s);
    const actions = due.filter((a) => typeof a !== 'function');
    if (actions.length) {
      const out = intake(s, actions);
      snapHash.update(JSON.stringify(out.results.map((r) => [r.accepted, r.reason || ''])));
      s = out.state;
    }
    s = tick(s);
    stateHash.update(hashState(s));
    if (s.tick % 10 === 0) snapHash.update(hashState(buildSnapshot(s)));
  }
  return { state: stateHash.digest('hex'), snaps: snapHash.digest('hex') };
}

test('(d) ISOLATION: a Tier-1/2 licence lifecycle reproduces the pre-slice engine byte for byte — state, snapshots and every intake result', () => {
  assert.deepEqual(isolationRun(), { state: ISO_STATE_EVERY_TICK, snaps: ISO_SNAPSHOTS_AND_RESULTS });
});

test('determinism: a Tier-3 contract lifecycle (sign, a settled week, renew, tear down) run twice gives the same bytes at every tick', () => {
  // The quiet stretches are jumped (the renegotiation tests' pattern), so the run reaches the week's
  // boundary, the Syndicate's offer and a teardown in a few hundred ticks. Every tick's bytes hashed.
  function run() {
    let s = galaxy([guildRow('g1', [factory('f', 'g1', 'fuel_tank'), factory('h', 'g1', 'heavy_reactor_engine')],
      { ...inputSets('fuel_tank', 30), ...inputSets('heavy_reactor_engine', 2) })], { windowN: 24 });
    s = sign(s, [units('g1', 'f', 17), units('g1', 'h', 3)]);
    const h = crypto.createHash('sha256');
    const run = (n) => { for (let i = 0; i < n; i += 1) { s = tick(s); h.update(hashState(s)); } };
    run(100);
    s.tick = WEEK - 50;
    run(100);                                                    // across the week's boundary: settled
    s.tick = renegotiationScheduleFor(ventureOf(s, 'g1', 'f'), 24, 0).actsTick;
    s = sign(s, [createRenegotiateLicenceAction({ guildId: 'g1', ventureId: 'f' })]);
    run(50);
    s = sign(s, [createDecommissionVentureAction({ guildId: 'g1', ventureId: 'h' })]);
    run(50);
    h.update(hashState(buildSnapshot(s)));
    return h.digest('hex');
  }
  assert.equal(run(), run());
});
