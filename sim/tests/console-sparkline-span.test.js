'use strict';

// console-sparkline-span.test.js — the System Production Console's trend sparkline
// (`trendSpark` in client/console.html; docs/production-console-model.md, the sparkline note).
//
// Goods are integers, so a fractional per-tick rate is emitted as a carried ±1 flicker
// (216, 217, 216, …). The sparkline used to scale to its own min/max, which stretched that
// one-unit noise across the whole box. It now floors the span at SPARK_MIN_SPAN_FRAC of the
// level and places the line around its midpoint. These tests pin both halves, and pin that a
// series with a real trend draws exactly as it did before.
//
// trendSpark is pulled out of the page source and run in a sandbox, the same way
// kit-kinds-client.test.js reads DK_KIT_LABEL — the page has no module system.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'console.html'), 'utf8');

function grab(re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in client/console.html`);
  return m[0];
}

// The function and the three names it reads. The function's body ends at the first
// line that is just "}" — trendSpark has no nested top-level-indented braces.
const code = [
  grab(/var SPARK_SEQ = 0;/, 'SPARK_SEQ'),
  grab(/var SPARK_W = \d+, SPARK_H = \d+;/, 'SPARK_W / SPARK_H'),
  grab(/var SPARK_MIN_SPAN_FRAC = [\d.]+;/, 'SPARK_MIN_SPAN_FRAC'),
  grab(/function trendSpark\(values, cls\)\{[\s\S]*?\n\}/, 'trendSpark'),
].join('\n');

const sandbox = {};
vm.runInNewContext(code + '\nthis.trendSpark = trendSpark; this.W = SPARK_W; this.H = SPARK_H;', sandbox);
const { trendSpark, W, H } = sandbox;
const pad = 4;            // trendSpark's own inner padding
const ih = H - pad * 2;   // the inner (drawable) height
const floorY = H - pad;   // the baseline rule, and the bottom of the inner box
const ceilY = pad;
const centreY = pad + ih / 2;

// The y-coordinates of the LINE path (the one drawn with fill="none", not the area),
// in point order.
function lineYs(svg) {
  const m = svg.match(/<path d="(M[^"]*)" fill="none"/);
  assert.ok(m, 'the sparkline has a line path');
  return m[1].slice(1).split(' L').map((p) => Number(p.split(',')[1]));
}
function dotY(svg) {
  const m = svg.match(/<circle cx="[^"]*" cy="([^"]*)"/);
  assert.ok(m, 'the sparkline has its last-point dot');
  return Number(m[1]);
}

// The mapping before this change, kept here as the reference the equivalence test checks.
function oldYs(vs) {
  const lo = Math.min(...vs), hi = Math.max(...vs);
  return vs.map((v) => Number((pad + ih - ((v - lo) / (hi - lo)) * ih).toFixed(1)));
}

test('a near-steady series is a small wobble in the middle of the box, not a sawtooth on the floor', () => {
  const vs = [216, 217, 216, 217, 217, 216];
  const ys = lineYs(trendSpark(vs, 'prod'));
  const top = Math.min(...ys), bottom = Math.max(...ys);
  // ±1 on ~216 against a 10% floor: about 1/21.6 of the height.
  assert.ok(bottom - top < ih * 0.1, `extent ${bottom - top} should be under 10% of ${ih}`);
  // The one that matters: extent alone also passes for a line lying on the floor.
  const middle = (top + bottom) / 2;
  assert.ok(Math.abs(middle - centreY) < 1, `line centred at ${middle}, box centre ${centreY}`);
  assert.ok(bottom < floorY - ih / 4, `line bottom ${bottom} must be well clear of the baseline ${floorY}`);
});

test('a trending series still fills the inner height, first point on the floor, last on the ceiling', () => {
  const ys = lineYs(trendSpark([100, 130, 170, 200], 'prod'));
  assert.equal(ys[0], floorY);
  assert.equal(ys[ys.length - 1], ceilY);
});

test('a small base with a real swing (3↔4) still fills the inner height', () => {
  const ys = lineYs(trendSpark([3, 4, 3, 4], 'cons'));
  assert.equal(Math.max(...ys), floorY);
  assert.equal(Math.min(...ys), ceilY);
});

test('a flat series is still drawn down the middle', () => {
  const ys = lineYs(trendSpark([216, 216, 216], 'prod'));
  for (const y of ys) assert.equal(y, centreY);
});

test('an unfloored series draws exactly the old y-values', () => {
  // Each swings by more than 10% of its own top, so the floor never engages.
  const cases = [
    [100, 130, 170, 200],
    [3, 4, 3, 4],
    [0, 5, 2, 9, 9, 1],
    [50, 40, 60, 45],
  ];
  // Hard-coded from the old formula pad + ih - ((v - lo) / (hi - lo)) * ih, with H = 132.
  const expected = [
    [128, 90.8, 41.2, 4],
    [128, 4, 128, 4],
    [128, 59.1, 100.4, 4, 4, 114.2],
    [66, 128, 4, 97],
  ];
  assert.equal(H, 132, 'the hard-coded values below assume SPARK_H = 132');
  cases.forEach((vs, i) => {
    assert.deepEqual(oldYs(vs), expected[i], `reference formula for ${vs}`);
    assert.deepEqual(lineYs(trendSpark(vs, 'prod')), expected[i], `y-values for ${vs}`);
  });
});

test('the last-point dot follows the new mapping', () => {
  for (const vs of [[216, 217, 216, 217, 217, 216], [100, 130, 170, 200], [216, 216, 216]]) {
    const svg = trendSpark(vs, 'prod');
    const ys = lineYs(svg);
    assert.equal(dotY(svg), ys[ys.length - 1], `dot sits on the last point for ${vs}`);
  }
});
