'use strict';

// cycle-length.test.js — the tripwire for the RULED cycle length N = 1,440
// (docs/cycle-and-calendar.md §1 and §7 Slice 1; design.md §5 "windowed accrual";
// docs/phase-1-tuning.md's `N` entry).
//
// N is no longer a first cut. It is DERIVED from two things already ruled — a window
// is one day, and a tick is one minute — so 24 h × 60 min/h = 1,440 ticks. A derived
// number is exactly the kind that gets silently reverted by someone who reads `24` in
// an old comment and "fixes" the constant back, so it is pinned here on all three
// surfaces it can be observed from: the constant itself, the licence terms it sizes,
// and the boundary cadence the tick engine actually runs.
//
// Every one of these runs sets NO `state.windowN` — that is the point. They exercise
// the engine-wide FALLBACK (`DEFAULT_WINDOW_N`), which is what a live, unconfigured
// galaxy runs on. Existing suites all inject their own short `windowN`, so this file
// is the only place the shipped default is under test.
//
// OUT of scope here (Slice 2): the midnight anchor, `dayAnchorTick`, and the calendar
// layer. This asserts the LENGTH of a cycle, never where its boundary falls in wall time.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { DEFAULT_WINDOW_N, winStartFor, getWindow } = require('../windows.js');
const { commitmentUnitsFor, licenceFee, FEE_RATE } = require('../licence.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');
const { MINE_BASELINE } = require('../baseline.js');

const SYS = 'sysA';
const TITANIUM_BASELINE = MINE_BASELINE.titanium; // 5 units/tick, the one RULED rate

// A one-mine system with NO `windowN` on the state — the fallback is what runs.
function unconfigured(venture) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [venture] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

const mine = (extra = {}) => ({
  id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: SYS,
  resourceType: 'titanium', productionRate: 10, ...extra,
});

// --- 1. the number itself ---------------------------------------------------------

test('the engine-wide default window is 1,440 ticks — the RULED cycle length', () => {
  assert.equal(DEFAULT_WINDOW_N, 1440);
});

test('1,440 is the DERIVED figure, not a memorable coincidence: 24 h × 60 min/h', () => {
  // Both terms are ruled elsewhere (a one-day window, §5; a one-minute tick,
  // phase-1-tuning.md 24-08-26). If either ruling ever moves, this line is where the
  // arithmetic that ties them to the constant must be re-derived — not patched.
  const HOURS_PER_DAY = 24;
  const TICKS_PER_HOUR = 60; // 1 tick = 1 minute
  assert.equal(DEFAULT_WINDOW_N, HOURS_PER_DAY * TICKS_PER_HOUR);
});

// --- 2. what the number is FOR: the licence terms it sizes -------------------------

test('an unconfigured galaxy sizes a 100% titanium licence at 7,200 units a window', () => {
  // The headline the ruling exists for. A full-commitment titanium mine owes its type
  // baseline over a whole day — 5 × 1,440 — where under the retired placeholder 24 it
  // owed 120, a figure that was a day's promise priced as twenty-four minutes' work.
  assert.equal(commitmentUnitsFor(1, TITANIUM_BASELINE, DEFAULT_WINDOW_N), 7200);
  assert.equal(commitmentUnitsFor(1, TITANIUM_BASELINE, 24), 120, 'the value being retired');
});

test('the real licence action stamps 7,200 with no windowN set anywhere', () => {
  // Not the formula in isolation — the shipped intake path, reading the same fallback
  // a live galaxy reads, on a state that configures nothing.
  const s = unconfigured(mine());
  assert.equal(s.windowN, undefined, 'nothing configured the window');

  const { state: next, results } = intake(s, [createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'm', committedOutputPct: 1, equityPct: 0, windowDays: 7,
  })]);
  assert.equal(results[0].accepted, true, results[0].reason);

  const v = next.guilds[0].ventures.find((x) => x.id === 'm');
  assert.equal(v.syndicateCommitment, 7200, 'a day of titanium at the type baseline');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('the fee re-derives off the same window — the RATIO is what is tuned, not the absolute', () => {
  // phase-1-tuning.md's FEE_RATE note: the fee and the income it is measured against
  // scale together with N, so flipping N must leave the ratio untouched at 1/10th.
  const lockedPrice = 10;
  const terms = { baselineUnitsPerTick: TITANIUM_BASELINE, lockedPrice, committedOutputPct: 1, equityPct: 0 };
  const { basicFee } = licenceFee({ ...terms, windowN: DEFAULT_WINDOW_N });
  const windowIncome = commitmentUnitsFor(1, TITANIUM_BASELINE, DEFAULT_WINDOW_N) * lockedPrice;

  assert.equal(basicFee, 7200, 'the fee scaled with the window, exactly as the note says it must');
  assert.equal(basicFee / windowIncome, FEE_RATE, 'and the tuned ratio is unmoved at a tenth');
});

// --- 3. the cadence the tick engine actually runs ----------------------------------

test('with no windowN set, a committed good runs a 1,440-tick cycle in the live engine', () => {
  // The strongest form: no formula, no constant — just the boundary the engine puts a
  // window roll on. Under the retired 24 this window would have rolled sixty times.
  let s = unconfigured(mine({ syndicateCommitment: 7200 }));
  const win = () => getWindow(s.guilds[0], SYS, 'titanium').windowStart;

  for (let i = 0; i < 24; i += 1) s = tick(s);
  assert.equal(s.tick, 24);
  assert.equal(win(), 1, 'tick 24 is NOT a boundary — the placeholder cadence is gone');

  while (s.tick < 1440) s = tick(s);
  assert.equal(win(), 1, 'tick 1,440 is the LAST tick of the first cycle, not the first of the second');

  s = tick(s); // tick 1441
  assert.equal(win(), 1441, 'the cycle rolls exactly one day in');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('winStartFor agrees with the engine across three consecutive default cycles', () => {
  const N = DEFAULT_WINDOW_N;
  assert.equal(winStartFor(1, N), 1);
  assert.equal(winStartFor(N, N), 1, 'the boundary tick belongs to the window it closes');
  assert.equal(winStartFor(N + 1, N), N + 1);
  assert.equal(winStartFor(2 * N, N), N + 1);
  assert.equal(winStartFor(2 * N + 1, N), 2 * N + 1);
});
