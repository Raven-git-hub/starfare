'use strict';

// The EQUIVALENCE TRIPWIRE for the home-anchor de-couple. It proves the derived
// home (home-anchor.js) resolves, on the COMMITTED seed (7331), to exactly the
// literal ids the suite used to hardcode — so swapping every literal for the
// fixture is a mechanical no-op, not one asserted by hand.
//
// This is the ONE place that pins the seed-7331 ids. When the seed is regenerated
// and the first starter moves, THESE right-hand literals change (and only these) —
// the rest of the suite follows the fixture automatically.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { HOME_SYSTEM, HOME_PLANET, HOME_MINE, HOME_MINE_2, HOME_SLOT } = require('./home-anchor.js');
const { getStarterSystems, getTerranHomeworld } = require('../seed.js');

test('the derived home anchor equals the retired literals on the committed seed', () => {
  // the two seed facts the whole de-couple rests on
  assert.equal(getStarterSystems()[0].id, 'sys_0006');
  assert.equal(getTerranHomeworld('sys_0006'), 'pl_00015');
  // and the fixture exports exactly those, plus the homeworld's first sites
  assert.equal(HOME_SYSTEM, 'sys_0006');
  assert.equal(HOME_PLANET, 'pl_00015');
  assert.equal(HOME_MINE, 'pl_00015_n01');
  assert.equal(HOME_MINE_2, 'pl_00015_n02');
  assert.equal(HOME_SLOT, 'pl_00015_s01');
});
