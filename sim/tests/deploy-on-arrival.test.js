'use strict';

// deploy-on-arrival.test.js — the deploy pipeline slice 2, roadmap 2.2 (docs/territory-model.md §5 —
// "haul a Tier-4 kit on a transport to a target, and place it on arrival").
//
// The tripwires for the RETREAT GEOMETRY (sim/transport.js `hexStepToward`) — the pure maths a failed
// on-arrival deploy uses to pull a craft back toward the nearest system its guild holds:
//   - HAND-COMPUTED hexes: a straight line, a diagonal, an exact edge tie, and a negative-coordinate line;
//   - NEVER OVERSHOOTS: a target n hexes away or closer answers `reached`, never a hex past it;
//   - EXACT DISTANCE: over a sweep of lines, the hex is exactly n from the start and d − n from the end;
//   - BAD INPUT throws instead of answering.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hexDistance, hexStepToward } = require('../transport.js');

// --- the retreat geometry: hexStepToward ---------------------------------------------------------

test('geometry: a straight line along the q axis steps exactly n hexes', () => {
  // (0,0) -> (10,0): d = 10. The point 3/10 of the way is (3, 0), already a hex centre.
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 10, r: 0 }, 3), { reached: false, hex: { q: 3, r: 0 } });
  assert.deepEqual(hexStepToward({ q: 10, r: 0 }, { q: 0, r: 0 }, 3), { reached: false, hex: { q: 7, r: 0 } }, 'and back');
});

test('geometry: a diagonal line rounds through cubeRound (hand-computed)', () => {
  // (0,0) -> (5,2): d = (5 + 2 + 7) / 2 = 7. Three hexes along: q = 15/7 ≈ 2.14, r = 6/7 ≈ 0.86, s = −3.
  // Round each: q → 2 (moved 1/7), r → 1 (moved 1/7), s → −3 (moved 0). They sum to 0 already… but the
  // rule still rebuilds the one that moved FURTHEST: q and r tie at 1/7, so the fixed order rebuilds r
  // from q and s: r = −2 + 3 = 1. The hex is (2, 1): 3 hexes from the start, 4 from the end.
  const step = hexStepToward({ q: 0, r: 0 }, { q: 5, r: 2 }, 3);
  assert.deepEqual(step, { reached: false, hex: { q: 2, r: 1 } });
  assert.equal(hexDistance({ q: 0, r: 0 }, step.hex), 3);
  assert.equal(hexDistance(step.hex, { q: 5, r: 2 }), 4);
});

test('geometry: a point exactly on an edge between two hexes is settled by the fixed check order', () => {
  // (0,0) -> (2,-1): d = 2. One hex along is (1, −0.5) — exactly on the edge of (1,0) and (1,−1).
  // Round: q 1 → 1 (moved 0), r −0.5 → 0 (half rounds up, moved 0.5), s −0.5 → 0 (moved 0.5). r and s tie,
  // so neither check fires and s is the one "rebuilt" (it is not returned). The hex is (1, 0) — every time.
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 2, r: -1 }, 1), { reached: false, hex: { q: 1, r: 0 } });
});

test('geometry: negative coordinates round exactly too (a line near the galaxy rim)', () => {
  // (−150,−30) -> (−156,−20): d = (6 + 10 + 4) / 2 = 10. Three hexes along: q = −151.8, r = −27 exactly,
  // s = 178.8. Round: q → −152 (moved 0.2), r → −27 (moved 0), s → 179 (moved 0.2). q and s tie at 0.2,
  // so neither check fires; the hex is (−152, −27).
  assert.deepEqual(
    hexStepToward({ q: -150, r: -30 }, { q: -156, r: -20 }, 3),
    { reached: false, hex: { q: -152, r: -27 } },
  );
});

test('geometry: never overshoots — a target n hexes away or closer is REACHED, not passed', () => {
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 3, r: 0 }, 3), { reached: true }, 'exactly n away');
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 1, r: 1 }, 3), { reached: true }, 'closer than n');
  assert.deepEqual(hexStepToward({ q: 4, r: 4 }, { q: 4, r: 4 }, 3), { reached: true }, 'already there');
  // One hex further than n is NOT reached: it steps n and stops one short.
  assert.deepEqual(hexStepToward({ q: 0, r: 0 }, { q: 4, r: 0 }, 3), { reached: false, hex: { q: 3, r: 0 } });
});

test('geometry: over a sweep of lines the hex is exactly n from the start and d − n from the end', () => {
  // Every target within 12 hexes of two different starts, every step count short of the target. This is
  // the property the retreat relies on: the snap is exactly the ruled number of hexes, never fewer or more.
  let checked = 0;
  for (const from of [{ q: 0, r: 0 }, { q: 7, r: -3 }]) {
    for (let dq = -12; dq <= 12; dq += 1) {
      for (let dr = -12; dr <= 12; dr += 1) {
        const to = { q: from.q + dq, r: from.r + dr };
        const d = hexDistance(from, to);
        if (d > 12) continue;
        for (let n = 0; n < d; n += 1) {
          const step = hexStepToward(from, to, n);
          assert.equal(step.reached, false);
          assert.equal(hexDistance(from, step.hex), n, `${JSON.stringify({ from, to, n })}: n from the start`);
          assert.equal(hexDistance(step.hex, to), d - n, `${JSON.stringify({ from, to, n })}: d - n from the end`);
          assert.deepEqual(hexStepToward(from, to, n), step, 'the same inputs give the same hex');
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 5000, `swept ${checked} steps`);
});

test('geometry: bad input throws rather than answering', () => {
  const o = { q: 0, r: 0 };
  const far = { q: 9, r: 0 };
  assert.throws(() => hexStepToward(o, far, -1), /n >= 0/);
  assert.throws(() => hexStepToward(o, far, 1.5), /whole-number/);
  assert.throws(() => hexStepToward({ q: 0.5, r: 0 }, far, 1), /whole-number/);
  assert.throws(() => hexStepToward(o, { q: 9, r: undefined }, 1), /whole-number/);
});
