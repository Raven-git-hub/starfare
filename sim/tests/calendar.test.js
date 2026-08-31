'use strict';

// calendar.test.js — the pure calendar layer (docs/cycle-and-calendar.md §5).
//
// These pin the four formulas AND the one property that makes them safe to build on:
// the calendar's day-roll and the engine's met/breach boundary are THE SAME EVENT,
// because both derive from the same `(tick - 1 - anchor)` phase. If that ever drifts,
// players read one cycle clock while the engine judges on another — a divergence that
// would be invisible until someone breached a licence a minute "early".
//
// Everything is exercised at N = 1440 (the ruled cycle) AND at a small N, because the
// formulas are length-RELATIVE: a bug that happens to cancel at 1440 shows at N = 5.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  minuteOf, dayOf, tickAt, format, displayLabel, anchorForCreation, minuteOfDayFromDate,
} = require('../calendar.js');
const { winStartFor, DEFAULT_WINDOW_N } = require('../windows.js');

const N = DEFAULT_WINDOW_N; // 1440
const SMALL = 5;

// --- 1. §5's worked examples ------------------------------------------------------

test('the first PRODUCING tick reads 0000:0000', () => {
  assert.equal(format(1, N), '0000:0000');
  assert.equal(format(1, SMALL), '0000:0000');
});

test('the boundary tick reads minute N-1 — the day’s LAST minute, not the next day’s first', () => {
  // §5: "1439 is the last tick of the first day". The boundary tick closes its day.
  assert.equal(format(N, N), '0000:1439');
  assert.equal(minuteOf(N, N), N - 1);
  assert.equal(dayOf(N, N), 0);
  // and the tick after it opens the next day
  assert.equal(format(N + 1, N), '0001:0000');
  assert.equal(dayOf(N + 1, N), 1);
  // length-relative: the same shape at N = 5
  assert.equal(minuteOf(SMALL, SMALL), SMALL - 1);
  assert.equal(dayOf(SMALL, SMALL), 0);
  assert.equal(dayOf(SMALL + 1, SMALL), 1);
});

test('every Nth boundary reads minute N-1, day by day', () => {
  for (const k of [1, 2, 3, 10]) {
    assert.equal(minuteOf(k * N, N), N - 1, `boundary ${k}N is its day's last minute`);
    assert.equal(dayOf(k * N, N), k - 1, `boundary ${k}N closes day ${k - 1}`);
  }
});

// --- 2. tickAt is the exact inverse ------------------------------------------------

test('tickAt round-trips dayOf/minuteOf, at both lengths and both anchors', () => {
  for (const [len, anchor] of [[N, 0], [N, -870], [SMALL, 0], [SMALL, -3]]) {
    for (const t of [1, 2, len - 1, len, len + 1, 3 * len, 3 * len + 7]) {
      const back = tickAt(dayOf(t, len, anchor), minuteOf(t, len, anchor), len, anchor);
      assert.equal(back, t, `N=${len} anchor=${anchor} tick=${t}`);
    }
  }
});

test('tickAt names the scheduling points §5 exists to give transports and deadlines', () => {
  assert.equal(tickAt(0, 0, N), 1, 'day 0 midnight is the first producing tick');
  assert.equal(tickAt(42, 0, N), 42 * N + 1, 'day 42, midnight');
  assert.equal(tickAt(7, 1230, N), 7 * N + 1231, 'day 7, minute 1230');
  // Elapsed time is a plain subtraction — the property the rejected DDDDTTTT packing
  // would have broken (§5: 00010001 - 00001439 computes 8562 where the truth is 2).
  assert.equal(tickAt(1, 0, N) - tickAt(0, N - 1, N), 1, 'across a day-roll, one tick is one tick');
});

// --- 3. the load-bearing property: day-roll IS the engine boundary ------------------

test('at anchor 0 the calendar day-roll and the engine boundary are the same event', () => {
  for (const len of [SMALL, 24, N]) {
    for (let t = 1; t <= 3 * len + 2; t += 1) {
      const dayEnds = minuteOf(t, len) === len - 1;
      const engineBoundary = (t % len) === 0;
      assert.equal(dayEnds, engineBoundary, `N=${len} tick=${t}`);
    }
  }
});

test('and it stays the same event under an anchor', () => {
  const anchor = anchorForCreation(870, N);
  for (const t of [1, 100, 569, 570, 571, 570 + N, 570 + N + 1]) {
    const dayEnds = minuteOf(t, N, anchor) === N - 1;
    const engineBoundary = (((t - anchor) % N) + N) % N === 0;
    assert.equal(dayEnds, engineBoundary, `tick=${t}`);
  }
});

test('the calendar agrees with winStartFor about which window a tick is in', () => {
  // Both derive from the same phase, so the window a tick belongs to must be the day
  // the calendar puts it in — the guarantee that keeps the clock and the verdict together.
  for (const [len, anchor] of [[SMALL, 0], [24, 0], [N, 0], [N, -870], [SMALL, -3]]) {
    for (let t = 1; t <= 2 * len + 3; t += 1) {
      const startFromCalendar = tickAt(dayOf(t, len, anchor), 0, len, anchor);
      assert.equal(winStartFor(t, len, anchor), startFromCalendar, `N=${len} anchor=${anchor} tick=${t}`);
    }
  }
});

// --- 4. anchorForCreation ----------------------------------------------------------

test('anchoring makes the first producing tick read the wall clock’s minute-of-day', () => {
  for (const minute of [0, 1, 870, 1439]) {
    const a = anchorForCreation(minute, N);
    assert.equal(minuteOf(1, N, a), minute, `created at minute ${minute}`);
    assert.equal(dayOf(1, N, a), 0, 'the creation tick is always on DAY 0');
  }
});

test('the anchor is the NEGATIVE representative — day 0, not day -1', () => {
  // Its positive congruent twin (+570 for minute 870) satisfies the boundary identically,
  // because the boundary reduces mod N. It does NOT satisfy dayOf, which divides: it
  // would put the creation tick on day -1 and roll to day 0 nine hours later. The sign
  // is a deliberate choice, and this is the assertion that keeps it.
  const a = anchorForCreation(870, N);
  assert.equal(a, -870);
  const twin = a + N; // 570 — congruent mod N, so same boundaries
  assert.equal(((1 - a) % N + N) % N, ((1 - twin) % N + N) % N, 'the twin agrees on the boundary');
  assert.equal(dayOf(1, N, a), 0, 'the chosen anchor puts creation on day 0');
  assert.equal(dayOf(1, N, twin), -1, 'the twin does not — which is why it is not chosen');
});

test('a galaxy created exactly at midnight needs no anchor at all', () => {
  assert.equal(anchorForCreation(0, N), 0, 'anchor 0 IS the unanchored cadence');
  assert.equal(format(1, N, 0), '0000:0000');
});

test('minuteOfDayFromDate converts a supplied Date — the module reads no clock itself', () => {
  // The one impure input, and it is impure only in its ARGUMENT. The caller (the galaxy
  // create handler) does the single wall-clock read; nothing here calls Date.now().
  // Built with Date.UTC so the instant's UTC fields are fixed on ANY machine —
  // minuteOfDayFromDate reads getUTCHours/getUTCMinutes, so a local-time constructor
  // made this assert 8h off in UTC+8 (390 != 870). The module's UTC contract, tested
  // in UTC.
  const d = new Date(Date.UTC(2026, 7, 27, 14, 30, 45)); // 14:30 UTC -> minute 870
  assert.equal(minuteOfDayFromDate(d), 870);
  assert.equal(minuteOfDayFromDate(new Date(Date.UTC(2026, 7, 27, 0, 0, 0))), 0);
  assert.equal(minuteOfDayFromDate(new Date(Date.UTC(2026, 7, 27, 23, 59, 0))), 1439);
});

// --- the pre-game tick has no clock to show (console legibility pass, 28-08-26) -----
//
// Day 0 starts at the FIRST PRODUCING tick, so `dayOf(0)` is -1 and `format(0)` reads
// `00-1:1439` — arithmetically exact, and not a moment anyone should be shown. The guard
// is at the DISPLAY seam only: `displayLabel` blanks it, `format`/`dayOf` are untouched,
// because clamping the arithmetic is the elapsed-time corruption this file exists to
// refuse.

test('displayLabel blanks the pre-game tick 0 instead of showing a negative day', () => {
  assert.equal(displayLabel(0, N), '—');
  assert.equal(displayLabel(0, SMALL), '—');
  assert.equal(displayLabel(0, N, -870), '—', 'anchored too — no anchor makes tick 0 a moment');
  assert.ok(!/-/.test(displayLabel(0, N).replace('—', '')), 'and nothing negative leaks through');
});

test('displayLabel is exactly `format` from the first producing tick on', () => {
  assert.equal(displayLabel(1, N), '0000:0000');
  for (const t of [1, 2, N, N + 1, 5000]) {
    assert.equal(displayLabel(t, N, -870), format(t, N, -870), `tick ${t}`);
  }
});

test('the arithmetic is NOT clamped — dayOf(0) is still -1', () => {
  // The guard must not have crept into the maths: elapsed time between two ticks stays
  // exact, including across the pre-game boundary.
  assert.equal(dayOf(0, N), -1);
  assert.equal(format(0, N), '00-1:1439');
});
