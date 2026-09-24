'use strict';

// route-cancel.test.js — the transport AUTOMATION layer, slice 3b: CANCEL (transport-model.md §11.10 "Cancel",
// §2.3 / §2.4; roadmap 2.2 automation slice 3b). Cancel ends a craft's lane AT ONCE: a craft in flight SNAPS
// to the hex it is over (its position interpolated along the current leg from the tick clock, rounded to a
// hex) and goes idle there; a craft parked mid-lane just drops its route where it sits.
//
// This file grows with the slice, one section per commit:
//   1. the snap maths — `cubeRound` / `legHexAtTick` (sim/transport.js) pinned to hand-computed hexes:
//      mid-leg, the cube correction, the endpoints + clamp, an exact tie, and the refusals of a bad schedule.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hexDistance, cubeRound, legHexAtTick } = require('../transport.js');

// --- 1. the snap maths ----------------------------------------------------------------------------

// The worked leg every snap test below uses: from (0, 0) to (9, 7). Its hex length is
// (|9| + |7| + |9 + 7|) / 2 = 16, so a light craft (105 ticks per hex) flies it in 16 × 105 = 1,680 ticks.
const O = { q: 0, r: 0 };
const NINE_SEVEN = { q: 9, r: 7 };
const SPAN = 1680;

test('snap: the cube correction — the point (0.45, 0.35) is in hex (1, 0), not the (0, 0) that rounding q and r alone gives', () => {
  // By hand (sim/transport.js cubeRound): s = −0.45 − 0.35 = −0.8. Round all three: q 0.45 → 0 (moved 0.45),
  // r 0.35 → 0 (moved 0.35), s −0.8 → −1 (moved 0.2). They add to −1, not 0, so the one that moved furthest,
  // q, is rebuilt from the other two: q = −r − s = 0 + 1 = 1.
  assert.deepEqual(cubeRound(45, 35, 100), { q: 1, r: 0 });
  assert.deepEqual(cubeRound(9, 7, 20), { q: 1, r: 0 }, 'the same point over another denominator');
  // An exact hex centre is itself.
  assert.deepEqual(cubeRound(300, -200, 100), { q: 3, r: -2 });
  assert.deepEqual(cubeRound(-7, 14, 7), { q: -1, r: 2 });
});

test('snap: mid-leg — half-way from (0,0) to (9,7) is the edge between (5,3) and (4,4); the fixed tie rule picks (5,3)', () => {
  // Half-way in time is half-way in space (§2.3): tick 840 of 1,680 is the point (4.5, 3.5). By hand:
  // s = −8. q 4.5 → 5 (a half rounds up; moved 0.5), r 3.5 → 4 (moved 0.5), s −8 → −8 (moved 0). They add
  // to 1, not 0. q and r moved equally far; the fixed order (q only if it moved STRICTLY furthest, else r if
  // it moved further than s) rebuilds r: r = −q − s = −5 + 8 = 3. So (5, 3). The point really is on the
  // edge — (5,3) and (4,4) are exactly as close — and rounding q and r alone would give (5, 4), which is not.
  assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 0, SPAN, 840), { q: 5, r: 3 });
  // The same leg, departing at tick 1,000, cancelled 840 ticks in — the answer depends on the time flown,
  // not on the clock reading.
  assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 1000, 1000 + SPAN, 1840), { q: 5, r: 3 });
  // 1/20 of the way (84 of 1,680 ticks) is the point (0.45, 0.35) — the cube-correction case above.
  assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 0, SPAN, 84), { q: 1, r: 0 });
  // Moving the whole leg by a whole-hex offset moves the answer by the same offset.
  const P = { q: -88, r: 73 };
  assert.deepEqual(legHexAtTick(P, { q: P.q + 9, r: P.r + 7 }, 0, SPAN, 840), { q: P.q + 5, r: P.r + 3 });
  // Flown the other way, the SAME point is the SAME hex: it is where the craft is that decides, never
  // which way it is heading.
  assert.deepEqual(legHexAtTick(NINE_SEVEN, O, 0, SPAN, 840), { q: 5, r: 3 });
});

test('snap: the endpoints and the clamp — at departure it is on `from`, at arrival on `to`, and never beyond either', () => {
  const from = { q: 2, r: -3 };
  const to = { q: -4, r: 5 };
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 100), from, 'at departureTick: the start hex');
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 900), to, 'at arrivalTick: the end hex');
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 5), from, 'before departure: clamped to the start');
  assert.deepEqual(legHexAtTick(from, to, 100, 900, 99999), to, 'after arrival: clamped to the end');
  // The shortest leg there is: one tick.
  assert.deepEqual(legHexAtTick(from, to, 10, 11, 10), from);
  assert.deepEqual(legHexAtTick(from, to, 10, 11, 11), to);
});

test('snap: tick by tick a craft moves hex to neighbouring hex — never a jump — from `from` to `to`', () => {
  let prev = legHexAtTick(O, NINE_SEVEN, 0, SPAN, 0);
  assert.deepEqual(prev, O);
  const seen = new Set([`${prev.q},${prev.r}`]);
  for (let t = 1; t <= SPAN; t += 1) {
    const hex = legHexAtTick(O, NINE_SEVEN, 0, SPAN, t);
    assert.ok(hexDistance(prev, hex) <= 1, `tick ${t}: ${JSON.stringify(prev)} → ${JSON.stringify(hex)} is a jump`);
    seen.add(`${hex.q},${hex.r}`);
    prev = hex;
  }
  assert.deepEqual(prev, NINE_SEVEN, 'it ends on the end hex');
  // A straight line 16 hexes long crosses at least 17 hexes.
  assert.ok(seen.size >= 17, `crossed ${seen.size} hexes`);
});

test('snap: an exact tie is settled by the fixed rule, never by floating point; no negative zero', () => {
  // The point (123366, 4876) / 659 ≈ (187.20, 7.40). By hand: q → 187 (moved 133/659), r → 7 (moved 263/659),
  // s = −128242/659 → −195 (moved 263/659). r and s tie EXACTLY at 263/659 — the point is on an edge — so the
  // fixed order rebuilds s (r did not move STRICTLY further than s), leaving (187, 7). The textbook decimal
  // version of this algorithm returns (187, 8) here: in floating point the two 263/659s come out a hair
  // apart and tip the tie. Whole-number maths has no hair to tip.
  assert.deepEqual(cubeRound(123366, 4876, 659), { q: 187, r: 7 });
  // Every call on the same point gives the same hex.
  for (let i = 0; i < 3; i += 1) assert.deepEqual(legHexAtTick(O, NINE_SEVEN, 0, SPAN, 840), { q: 5, r: 3 });
  // (0.4, −0.3): q is rebuilt as −r − s = −0 − 0, which JavaScript evaluates to NEGATIVE zero. It must come
  // back as a plain 0 (deepEqual tells the two apart; so would a replay comparing states).
  const h = cubeRound(4, -3, 10);
  assert.ok(Object.is(h.q, 0) && Object.is(h.r, 0), `got ${JSON.stringify(h)} with q ${Object.is(h.q, -0) ? '-0' : h.q}`);
});

test('snap: refuses a schedule it cannot trust — a fractional tick or coord, or a leg that takes no time', () => {
  assert.throws(() => legHexAtTick(O, NINE_SEVEN, 0, SPAN, 840.5), /whole-number coords and ticks/);
  assert.throws(() => legHexAtTick({ q: 0.5, r: 0 }, NINE_SEVEN, 0, SPAN, 840), /whole-number coords and ticks/);
  assert.throws(() => legHexAtTick(O, NINE_SEVEN, 50, 50, 50), /at least one tick/);
  assert.throws(() => legHexAtTick(O, NINE_SEVEN, 60, 50, 55), /at least one tick/);
});
