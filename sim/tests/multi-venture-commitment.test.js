'use strict';

// multi-venture-commitment.test.js — the case no other fixture covers: TWO ventures
// committing the SAME good in the SAME system for ONE guild, on DIFFERENT window
// fractions and DIFFERENT equity terms, run through a window boundary.
//
// WHY IT EXISTS — the F-A REGRESSION GUARD. The commitment sale (sim/licence.js,
// Slice 3a) splits each tick's proceeds between the owner's keep and the ledger's
// equity (`o`) share by weighting each venture's `(1 − o)`. The good's delivered
// target `Q` (sim/production.js) is built as `Σ syndicateCommitment × windowFraction`.
// Until this slice the SALE weighted by the RAW `syndicateCommitment` while `Q`
// weighted by `commitment × fraction` — one quantity computed twice, and once the
// mid-window pro-rate went live (Slice 3b-ii, `windowFraction` < 1) the two drifted.
// The result was a SILENT MIS-PAYMENT: invariant 2 still balanced to the credit (the
// guild's gain and the ledger's debit are one number by construction), but the split
// between the owner's keep and the ledger's `o` share was wrong — a mis-attribution,
// not a conservation break, which is exactly why 406 tests never saw it.
//
// The fixture below is that case. Its headline assertion FAILS on the pre-fix engine.
// The fix is structural (one `committedContribution`, both consumers calling it), so
// what this file really pins is that the sale's weight IS each venture's contribution
// to `Q` — never its raw commitment.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { getWindow, windowFraction, winStartFor } = require('../windows.js');
const { postedPrice } = require('../prices.js');
const { previewProduction } = require('../production.js');
const { MINE_BASELINE } = require('../baseline.js');

const SYS = 'sysA';
const GOOD = 'titanium';
const N = 4;                       // a short window, so a mid-window join is a real fraction

// The two mines. `full` is committed from the start (no `committedFromTick` — the
// dev-scaffold shape, deliberately full-window); `late` is licensed mid-window
// through the real action, so it carries a stamp and a fraction < 1.
const FULL_COMMITMENT = 8;         // raw units per window
const LATE_EQUITY = 0.4;           // `late` offers equity, `full` offers none

const mine = (id, commitment, equityPct) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD,
  productionRate: 10, syndicateCommitment: commitment, equityPct,
});

function fixture() {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [mine('full', FULL_COMMITMENT, 0), mine('late', 0, LATE_EQUITY)],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}

const guild = (s) => s.guilds[0];
const venture = (s, id) => guild(s).ventures.find((v) => v.id === id);
const win = (s) => getWindow(guild(s), SYS, GOOD);
const nextWindow = (s) => previewProduction(s)[0].systems[0].goods[GOOD].window;

// Licence `late` while state.tick is 1, so it is stamped `committedFromTick` 2 — the
// third of the four ticks of the window that opened at tick 1.
const licenceLate = (s) => intake(s, [createApplyForLicenceAction({
  guildId: 'g1', ventureId: 'late', committedOutputPct: 1, windowDays: 7,
})]).state;

// The two weights, stated here as plain arithmetic rather than read back from the
// code under test — that is the whole point of the fixture.
const LATE_COMMITMENT = MINE_BASELINE[GOOD] * N;          // round(1 × baseline × N) = 20
const LATE_FRACTION = 3 / 4;                               // present ticks 2,3,4 of a 4-tick window
const CONTRIB_FULL = FULL_COMMITMENT;                      // fraction 1
const CONTRIB_LATE = LATE_COMMITMENT * LATE_FRACTION;      // 15
// RIGHT: each venture's weight is its contribution to Q.
const OWNER_FRACTION = ((CONTRIB_FULL * 1) + (CONTRIB_LATE * (1 - LATE_EQUITY)))
  / (CONTRIB_FULL + CONTRIB_LATE);
// WRONG (the F-A bug): weighting by the RAW commitment, ignoring the window fraction.
const RAW_WEIGHTED_FRACTION = ((FULL_COMMITMENT * 1) + (LATE_COMMITMENT * (1 - LATE_EQUITY)))
  / (FULL_COMMITMENT + LATE_COMMITMENT);

test('the fixture really does put the two weightings in conflict', () => {
  // If these ever coincide the headline test below proves nothing.
  assert.notEqual(OWNER_FRACTION, RAW_WEIGHTED_FRACTION);
  assert.ok(OWNER_FRACTION > RAW_WEIGHTED_FRACTION,
    'the pro-rated venture is the one offering equity, so under-weighting its fraction under-pays the owner');
});

test('F-A: the sale splits by each venture’s CONTRIBUTION to Q, not its raw commitment', () => {
  let s = fixture();
  s = tick(s);                                   // tick 1 — only `full` is committed
  assert.equal(s.tick, 1);
  s = licenceLate(s);
  const late = venture(s, 'late');
  assert.equal(late.committedFromTick, 2, 'stamped as its first producing tick (signedTick + 1)');
  assert.equal(late.syndicateCommitment, LATE_COMMITMENT);
  assert.equal(windowFraction(late, winStartFor(2, N), N), LATE_FRACTION, 'present for 3 of the window’s 4 ticks');
  assert.equal(windowFraction(venture(s, 'full'), winStartFor(2, N), N), 1, 'the other mine owes the whole window');

  // Ticks 2, 3 and 4 (the boundary) — every one of them a tick where the two
  // weightings disagree. Each tick's payment is checked on its own, because the sale
  // is a PER-TICK attribution (see the two-axes note in sim/licence.js).
  let paidTicks = 0;
  for (const expectedTick of [2, 3, 4]) {
    const before = { credits: guild(s).credits, ledger: s.syndicate.ledger, delivered: win(s).delivered };
    const price = postedPrice(s, GOOD);           // the sale executes at the price already on state
    s = tick(s);
    assert.equal(s.tick, expectedTick);

    const delivered = win(s).delivered - before.delivered;
    if (delivered <= 0) continue;
    paidTicks += 1;
    const gross = delivered * price;
    const expected = Math.round(OWNER_FRACTION * gross);

    // Slice 3b-iii: tick 4 is the window BOUNDARY, so the licence fee is debited on the
    // same tick as the sale. Two independent internal transfers, neither folded into the
    // other — so the sale's own figure is checked against the credit change with the fee
    // added back, and the fee is read from its own record rather than inferred.
    const feeRec = guild(s).lastLicenceFee;
    const feeCharged = feeRec && feeRec.tick === s.tick ? feeRec.charged : 0;
    assert.equal(feeCharged > 0, expectedTick === N,
      `tick ${expectedTick}: the fee fires on the boundary tick and only there`);

    assert.equal((guild(s).credits - before.credits) + feeCharged, expected,
      `tick ${expectedTick}: the owner is paid its contribution-weighted share`);
    assert.equal((before.ledger - s.syndicate.ledger) + feeCharged, expected,
      'and the Syndicate ledger funded exactly that (invariant 2, to the credit)');
    assert.notEqual(expected, Math.round(RAW_WEIGHTED_FRACTION * gross),
      `tick ${expectedTick}: the raw-commitment weighting really would pay a DIFFERENT number (this is F-A)`);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  assert.ok(paidTicks >= 2, 'the fixture pays on more than one tick, so the split is pinned repeatedly');

  // Invariant-2 cleanliness over the whole run: the sale MOVES credits, never mints.
  assert.equal(guild(s).credits + s.syndicate.ledger, 0, 'every credit the guild holds came out of the ledger');
});

test('F-A: the window target and the paid split are built from the SAME weights', () => {
  let s = fixture();
  s = tick(s);
  s = licenceLate(s);
  s = tick(s);                                   // tick 2 — the first tick both are committed

  // Q is the sum of the same two contributions the sale splits by (rounded once, where
  // it is finalised — goods are integers, §15.2).
  assert.equal(nextWindow(s).Q, Math.round(CONTRIB_FULL + CONTRIB_LATE),
    'Q = Σ committedContribution, rounded at the one place it is finalised');
});

test('F-A: the boundary still resolves a status, and the state is clean', () => {
  let s = fixture();
  s = tick(s);
  s = licenceLate(s);
  while (s.tick < N - 1) s = tick(s);           // stop one short of the boundary...
  const verdict = nextWindow(s);                // ...where the NEXT tick is the boundary
  assert.ok(['met', 'breach'].includes(verdict.status), 'the boundary resolves a verdict');

  s = tick(s);                                  // the boundary tick itself
  assert.equal(s.tick, N);
  assert.equal(win(s).windowStart, 1, 'the verdict belongs to the window that opened at tick 1');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  s = tick(s);                                  // and the window rolls cleanly afterwards
  assert.equal(win(s).windowStart, N + 1);
  assert.equal(windowFraction(venture(s, 'late'), N + 1, N), 1, 'the latecomer owes the WHOLE of its second window');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- the tripwires this slice adds ------------------------------------------------
//
// All three guard the same seam: a venture built DIRECTLY by a scenario, a test or a
// persisted state, which never passes through intake's validation. That is precisely
// the case the engine's own comments say the tick must assert, and none of these three
// failures is loud on its own.

// Trips on a record whose rule matches AND — where given — that names the exact field,
// so a test can never pass on some unrelated breakage in the same fixture.
const trips = (s, rule, where) => checkInvariants(s, s.tick)
  .some((r) => r.rule.startsWith(rule) && (where === undefined || r.where === where));

// A committed state built with NO action — the bypass the tripwires exist for.
function direct(ventures) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}

test('a fractional syndicateCommitment trips the tick', () => {
  // `Q`'s own `Math.round` (production.js) would swallow it silently — goods are
  // integers (§15.2) and so is the quantity you promise to deliver.
  const s = direct([mine('full', 8.5, 0)]);
  assert.ok(trips(s, 'integer credits/goods', 'venture:full.syndicateCommitment'), 'a fractional commitment is caught, not rounded away');
  assert.deepEqual(checkInvariants(direct([mine('full', 8, 0)]), 0), [], 'and a whole one is clean');
});

test('N-1: a NEGATIVE syndicateCommitment trips the tick, and cannot shrink a sibling’s target', () => {
  const s = direct([mine('full', FULL_COMMITMENT, 0), mine('late', -4, 0)]);
  assert.ok(trips(s, 'non-negativity', 'venture:late.syndicateCommitment'), 'a negative commitment is caught');

  // And the damage it used to do is gone at the source: `committedContribution` skips a
  // non-positive commitment, so the sibling's aggregate `Q` is its own 8 — not 4. Before
  // the skip lived in one shared place, this venture SUBTRACTED from the good's `Q` and
  // silently shrank a target the sibling was meeting.
  assert.equal(nextWindow(s).Q, FULL_COMMITMENT, 'the sibling mine still owes exactly its own commitment');
});

test('a licensed, committed venture with NO join tick trips the tick', () => {
  let s = fixture();
  s = tick(s);
  s = licenceLate(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the granted licence is clean');

  const stripped = JSON.parse(JSON.stringify(s));
  delete stripped.guilds[0].ventures[1].committedFromTick;
  assert.ok(trips(stripped, 'licensed-commitment-carries-a-join-tick', 'venture:late.committedFromTick'),
    'without the stamp the mine silently owes a WHOLE window again — the pro-rate undone');
});

test('an off-by-one (or fabricated) join tick trips the tick', () => {
  let s = fixture();
  s = tick(s);
  s = licenceLate(s);
  const signedTick = venture(s, 'late').licence.signedTick;

  for (const [stamp, why] of [
    [signedTick, 'the off-by-one: crediting the venture with a tick it could not produce in'],
    [signedTick + 50, 'a far-future stamp: owing almost nothing'],
  ]) {
    const bent = JSON.parse(JSON.stringify(s));
    bent.guilds[0].ventures[1].committedFromTick = stamp;
    assert.ok(trips(bent, 'join-tick-is-signedTick+1', 'venture:late.committedFromTick'), why);
  }
});

test('a window that never opened (windowStart 0) trips the tick', () => {
  let s = fixture();
  s = tick(s);
  const bent = JSON.parse(JSON.stringify(s));
  bent.guilds[0].syndicateWindows[SYS][GOOD].windowStart = 0;
  assert.ok(trips(bent, 'window-start-is-a-real-tick'), 'ticks start at 1, so 0 is not a small window-start');
});
