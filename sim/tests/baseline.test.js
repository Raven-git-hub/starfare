'use strict';

// baseline.test.js — the droidless baseline tables (sim/baseline.js) as the source of
// a new venture's RATE (design.md §2 "A mine's yield IS its establish rate", 24-09-26).
//
// Two tripwires:
//   - `baselineRateFor` answers in the venture's OWN rate unit (a mine's units/tick, a
//     factory's batches/tick) and answers null, never a default, when there is none;
//   - every value in both tables is a POSITIVE INTEGER. A mine deposits its rate as
//     whole units every tick with no fractional carry (sim/production.js), and the
//     engine now stamps these values straight onto new ventures, so a fractional or
//     zero baseline would be a silent bug: goods minted as fractions (§15.2 says goods
//     are integers), or a venture that exists and makes nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MINE_BASELINE, REFINERY_BASELINE, baselineRateFor } = require('../baseline.js');
const { RAW_RESOURCES } = require('../resources.js');
const { RECIPES } = require('../recipes.js');

test('TRIPWIRE: every MINE_BASELINE and REFINERY_BASELINE value is a positive integer', () => {
  for (const [table, name] of [[MINE_BASELINE, 'MINE_BASELINE'], [REFINERY_BASELINE, 'REFINERY_BASELINE']]) {
    for (const [key, value] of Object.entries(table)) {
      assert.ok(Number.isInteger(value) && value > 0,
        `${name}.${key} = ${JSON.stringify(value)}: a baseline must be a positive integer — it is stamped as a venture's productionRate and deposited as whole units`);
    }
  }
});

test('a mine\'s rate is its MINE_BASELINE entry (units/tick), for every raw good', () => {
  for (const good of RAW_RESOURCES) {
    assert.equal(baselineRateFor({ resourceType: good }), MINE_BASELINE[good], good);
  }
});

test('a factory\'s rate is its REFINERY_BASELINE entry (batches/tick), for every recipe', () => {
  for (const id of Object.keys(RECIPES)) {
    assert.equal(baselineRateFor({ recipeId: id }), REFINERY_BASELINE[id], id);
  }
});

test('no baseline means null — never a default number', () => {
  assert.equal(baselineRateFor({ resourceType: 'unobtainium' }), null, 'an unknown raw good');
  assert.equal(baselineRateFor({ recipeId: 'no_such_recipe' }), null, 'an unknown recipe');
  assert.equal(baselineRateFor({}), null, 'a venture that names neither');
  assert.equal(baselineRateFor(null), null, 'no venture at all');
  // A prototype name must not read Object.prototype's function as a "rate".
  assert.equal(baselineRateFor({ resourceType: 'constructor' }), null);
  assert.equal(baselineRateFor({ recipeId: 'toString' }), null);
});
