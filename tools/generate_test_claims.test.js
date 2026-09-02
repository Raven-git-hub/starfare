'use strict';
// Drift tripwire for the test-claims fixture (tools/generate_test_claims.js),
// mirroring the seed drift tripwire in generate_seed.test.js.
//
// data/test_claims.json is a committed demo fixture (guild claims / outposts / gates)
// the seed viewer renders. It used to store the environment-dependent input PATH
// (`seedFile`), which made it differ across checkouts — so it could not be pinned.
// Now it stores the seed NUMBER (`galaxy.seed`), so the output is a pure function of
// (seed geometry, claimsSeed 4242) and this tripwire can guard it against drift:
// regenerate the seed (as the waystation slice did — outposts block guild-outpost /
// gate placement) and this file must be rebuilt, or it goes stale.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateTestClaims } = require('./generate_test_claims.js');

test('committed data/test_claims.json is byte-identical to the CLI output (drift tripwire)', () => {
  const seedPath = path.join(__dirname, '..', 'data', 'seed.json');
  const claims = generateTestClaims(seedPath, 4242); // 4242 is the CLI default claims seed
  const cli = JSON.stringify(claims, null, 2); // no trailing newline — matches the CLI writeFileSync
  const committed = fs.readFileSync(path.join(__dirname, '..', 'data', 'test_claims.json'), 'utf8');
  assert.equal(cli, committed, 'data/test_claims.json is stale — regenerate from tools/generate_test_claims.js');
});
