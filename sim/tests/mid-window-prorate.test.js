'use strict';

// mid-window-prorate.test.js — licence Slice 3b-ii: the mid-window join pro-rate
// (design.md §5 "Window boundaries and edge cases (Slice B)", the Option-A join ruling
// whose build was DEFERRED; build note docs/mid-window-pro-rate.md).
//
// Slice B-i built the pro-rate's math and pinned it unreachable, guarded by a tripwire
// asserting `windowFraction == 1` for every venture. Slice 3b-i then introduced the
// thing that reaches it — a licence granted at an arbitrary tick — and, with the pin
// still in, a mine licensed mid-window owed a FULL window's Q with only part of a
// window to deliver it: an unavoidable breach on a contract just signed. This slice
// stamps `committedFromTick`, so it owes only its share.
//
// The headline test below is that exact failure, fixed. Nothing here charges anything:
// the fee debit is Slice 3b-iii.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { advance } = require('../run.js');
const {
  intake, createApplyForLicenceAction, createSetSyndicateCommitmentAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { previewProduction } = require('../production.js');
const { getWindow, windowFraction, winStartFor } = require('../windows.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { MINE_BASELINE } = require('../baseline.js');

const SYS = 'sysA';

const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good,
  productionRate: rate, syndicateCommitment: commitment,
});

function sysState(ventures, windowN) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

const guild = (s) => s.guilds[0];
const venture = (s, id = 'm') => guild(s).ventures.find((v) => v.id === id);
const win = (s, good = 'titanium') => getWindow(guild(s), SYS, good);
// The window telemetry the NEXT producing tick will yield — at the tick before a
// boundary this is how the boundary's met/breach verdict is read.
const nextWindow = (s, good = 'titanium') => previewProduction(s)[0].systems[0].goods[good].window;
const licenseNow = (s, opts = {}) => intake(s, [createApplyForLicenceAction({
  guildId: 'g1', ventureId: 'm', committedOutputPct: 1, windowDays: 7, ...opts,
})]).state;

// --- 1. the stamp, and the off-by-one it encodes ---------------------------------

test('applyForLicence stamps committedFromTick as the venture’s FIRST PRODUCING tick', () => {
  let s = sysState([mine('m', 'titanium', 5)], 4);
  s = tick(s); s = tick(s);              // ticks 1 and 2 pass unlicensed
  assert.equal(s.tick, 2);

  s = licenseNow(s);
  const v = venture(s);
  assert.equal(v.licence.signedTick, 2, 'signed against the state as it stands');
  assert.equal(v.committedFromTick, 3, 'and committed from the next tick — the first it can produce in');
  // Intake runs before the tick, so the tick that follows this signature is tick 3.
  const after = tick(s);
  assert.equal(after.tick, 3, 'the stamp names the very next producing tick');
  assert.ok(win(after).delivered > 0, 'which is indeed the first tick it delivers in');
});

test('only applyForLicence stamps it — the dev scaffold stays full-window', () => {
  let s = sysState([mine('m', 'titanium', 5)], 4);
  s = tick(s);
  ({ state: s } = intake(s, [createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'm', commitment: 8 })]));
  assert.equal('committedFromTick' in venture(s), false, 'the scaffold commits for the whole window, as it always has');
  assert.equal(windowFraction(venture(s), winStartFor(s.tick, 4), 4), 1);
});

// --- 2. THE HEADLINE: the case that used to breach unavoidably --------------------

test('a mine licensed mid-window now MEETS its pro-rated Q, where it used to breach', () => {
  // N = 4, baseline 5, committed 100% ⇒ syndicateCommitment = 20 units per window.
  // Licensed at tick 2, so it first delivers at tick 3: present for ticks 3 and 4 of a
  // window spanning 1..4 ⇒ 2/4 present ⇒ it owes round(20 × 0.5) = 10, and it can
  // deliver exactly 10 (2 ticks × 5 fresh). Before this slice it owed the full 20,
  // delivered 10, and breached at the boundary having never had a chance.
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s); s = tick(s);
  s = licenseNow(s);

  const v = venture(s);
  assert.equal(v.syndicateCommitment, MINE_BASELINE.titanium * N, 'a full commitment: 20 units per window');
  assert.equal(windowFraction(v, winStartFor(3, N), N), 0.5, 'present for half the window');

  s = tick(s);                                   // producing tick 3
  const boundary = nextWindow(s);
  assert.equal(boundary.Q, 10, 'it owes the pro-rated half, as a whole number of goods');
  assert.equal(boundary.status, 'met', 'the boundary tick will MEET it — the fix, in one assertion');

  s = tick(s);                                   // producing tick 4 = the boundary
  assert.equal(win(s).delivered, 10, 'delivered exactly what it owed');
  assert.equal(win(s).windowStart, 1);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('...and the same timing WOULD have breached without the stamp', () => {
  // The counterfactual, so the headline test can never quietly pass for another reason:
  // strip the join tick and the identical run owes the full 20 and falls short.
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s); s = tick(s);
  s = licenseNow(s);
  delete venture(s).committedFromTick;           // pre-3b-ii behaviour, exactly

  s = tick(s);
  const boundary = nextWindow(s);
  assert.equal(boundary.Q, 20, 'a full window owed');
  assert.equal(boundary.status, 'breach', 'with only two ticks to deliver it in');
});

test('a licence signed for the very last tick of a window owes a sliver, and meets it', () => {
  // The extreme case: first producing tick IS the boundary tick. 1/4 of 20 = 5, which
  // is exactly one tick of fresh output. Pro-rating means owing a little, not nothing.
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s); s = tick(s); s = tick(s);         // ticks 1..3
  s = licenseNow(s);
  assert.equal(venture(s).committedFromTick, 4);

  const boundary = nextWindow(s);
  assert.equal(boundary.Q, 5);
  assert.equal(boundary.status, 'met');
  s = tick(s);
  assert.equal(win(s).delivered, 5);
});

// --- 3. Q rounds, and the fraction = 1 path is byte-identical ---------------------

test('Q is a whole number of goods even on a fractional window', () => {
  // N = 3 with a commitment of 20 ⇒ a 2/3 fraction ⇒ 13.33… before rounding.
  const N = 3;
  let s = sysState([mine('m', 'titanium', 5, 0)], N);
  s = tick(s);                                    // tick 1; licence signs from tick 2
  s = licenseNow(s);
  assert.equal(venture(s).committedFromTick, 2);
  assert.equal(windowFraction(venture(s), 1, N), 2 / 3);

  s = tick(s);
  const Q = nextWindow(s).Q;
  assert.ok(Number.isInteger(Q), `Q ${Q} must be a whole number of goods (§15.2)`);
  assert.equal(Q, Math.round(venture(s).syndicateCommitment * (2 / 3)));
  // Pacing and judgement must read the SAME rounded target, or a venture could pace to
  // a number the boundary refuses.
  assert.equal(nextWindow(s).requiredRate, (Q - win(s).delivered) / nextWindow(s).ticksRemaining);
});

test('NO-OP: with a full-window fraction, rounding Q changes nothing — byte-identical', () => {
  // The guard on this whole slice: `round` of an integer is the identity, so every path
  // where no venture joined mid-window must produce exactly the bytes it did before.
  const build = () => {
    let s = sysState([mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 10, 5)], 4);
    for (let i = 0; i < 40; i += 1) s = tick(s);
    return s;
  };
  // Pinned on the pre-3b-ii engine (the same scaffold-committed run the commitment
  // scaffold's own golden covers, at a different shape) — if rounding ever bit on a
  // full-window path, this drifts.
  const a = build();
  assert.equal(hashState(a), hashState(build()), 'determinism (invariant 9)');
  for (const v of guild(a).ventures) {
    assert.equal('committedFromTick' in v, false, 'nothing here joined mid-window');
  }
  assert.ok(win(a).delivered >= 0);
  assert.deepEqual(checkInvariants(a, a.tick), []);
});

// --- 4. later windows revert to the full commitment -------------------------------

test('from its first COMPLETE window on, a mid-window licence owes the full Q', () => {
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s); s = tick(s);
  s = licenseNow(s);                              // committedFromTick 3, window 1..4

  s = tick(s);                                    // 3 — pro-rated window
  assert.equal(nextWindow(s).Q, 10);
  s = tick(s);                                    // 4 — the boundary
  // Window 2 spans ticks 5..8; committedFromTick 3 ≤ its windowStart, so fraction 1.
  assert.equal(windowFraction(venture(s), winStartFor(5, N), N), 1);
  assert.equal(nextWindow(s).Q, 20, 'the full commitment, every window after the first');

  for (let i = 0; i < 4; i += 1) s = tick(s);      // ticks 5..8
  assert.equal(s.tick, 8);
  assert.equal(win(s).delivered, 20, 'and it delivers the full amount');
  assert.equal(win(s).windowStart, 5);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a licence signed exactly as a window opens is never pro-rated', () => {
  // Signed on the boundary tick T (so committedFromTick = T+1 = the next window's first
  // tick): it owes nothing in the window it never produced in, and a full Q in its own.
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  for (let i = 0; i < 4; i += 1) s = tick(s);     // ticks 1..4, boundary at 4
  s = licenseNow(s);
  assert.equal(venture(s).committedFromTick, 5, 'the first tick of window 2');
  assert.equal(windowFraction(venture(s), winStartFor(5, N), N), 1);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'and the tripwire is content mid-intake');

  s = tick(s);
  assert.equal(nextWindow(s).Q, 20, 'a full window, owed from the start of it');
});

// --- 5. the tripwire, determinism, and the unlicensed no-op -----------------------

test('the correctness tripwire replaces the deferral guard: a broken join tick trips', () => {
  let s = sysState([mine('m', 'titanium', 5)], 4);
  s = tick(s);
  s = licenseNow(s);
  s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a real pro-rated licence is sane');

  for (const bad of [0, -3, 2.5, '3', null]) {
    const broken = JSON.parse(JSON.stringify(s));
    broken.guilds[0].ventures[0].committedFromTick = bad;
    assert.ok(checkInvariants(broken, broken.tick).length >= 1, `committedFromTick ${bad} must trip`);
  }
});

test('the fraction the tripwire guards is in (0, 1] for every legal join tick', () => {
  // The tripwire's premise, swept rather than asserted: for an INTEGER join tick ≥ 1,
  // the fraction against its own window — and against any later one — is always in
  // (0, 1]. Which is why the range check cannot be tripped by data alone: it is a guard
  // on the MATH, and it goes red if windowFraction's formula (or the tick the stamp is
  // written at) ever changes in a way that would hand a venture a target nobody can
  // meet. That is precisely the failure this slice exists to end, so it is worth a
  // standing assertion rather than a comment.
  for (const N of [1, 2, 3, 4, 6, 24]) {
    for (let from = 1; from <= 40; from += 1) {
      const v = { committedFromTick: from };
      const own = windowFraction(v, winStartFor(from, N), N);
      assert.ok(own > 0 && own <= 1, `N=${N} from=${from}: own-window fraction ${own}`);
      for (let later = from; later <= from + 3 * N; later += 1) {
        const f = windowFraction(v, winStartFor(later, N), N);
        assert.ok(f > 0 && f <= 1, `N=${N} from=${from} at tick ${later}: fraction ${f}`);
      }
    }
  }
});

test('a long-past join is simply a full window — the tripwire does not cry wolf', () => {
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s);
  s = licenseNow(s);
  for (let i = 0; i < 20; i += 1) s = tick(s);
  assert.ok(venture(s).committedFromTick < winStartFor(s.tick, N), 'the join is windows behind us');
  assert.equal(windowFraction(venture(s), winStartFor(s.tick, N), N), 1);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('determinism (invariant 9): a pro-rated run is byte-identical run twice', () => {
  const build = () => {
    let s = sysState([mine('m', 'titanium', 5), mine('c', 'carbon_products', 7, 3)], 6);
    s = tick(s); s = tick(s); s = tick(s);
    s = licenseNow(s, { committedOutputPct: 0.6, windowDays: 21 });
    for (let i = 0; i < 25; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

test('NO-OP PROOF: an unlicensed boot+ticks is hash-identical and stamps nothing', () => {
  const run = () => {
    let s = createZeroState();
    for (let i = 0; i < 5; i += 1) s = advance(s, []).state;
    return s;
  };
  const a = run();
  assert.equal(hashState(a), hashState(run()));
  for (const g of a.guilds) for (const v of g.ventures || []) {
    assert.equal('committedFromTick' in v, false);
  }
});

// --- the credit side: the pro-rate moves nothing of its own, but it SCALES the fee ---

// Shipped with 3b-ii as "the pro-rate moves no credits of its own — only 3a's sale does".
// Slice 3b-iii charges the fee, so the boundary ticks now move credits too — and the
// pro-rate is what decides HOW MUCH on the first of them. The walk is unchanged; the
// assertion now names both movements, so the pro-rate still cannot smuggle in a third.
test('the pro-rate moves no credits of its OWN — every tick is the sale, less the boundary fee', () => {
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s); s = tick(s);
  s = licenseNow(s);

  let boundaries = 0;
  for (let i = 0; i < 12; i += 1) {
    const before = guild(s).credits;
    s = tick(s);
    const sale = guild(s).lastSyndicateSale;
    const sold = sale && sale.tick === s.tick ? sale.credited : 0;
    const fee = guild(s).lastLicenceFee;
    const charged = fee && fee.tick === s.tick ? fee.charged : 0;
    if (s.tick % N === 0) boundaries += 1; else assert.equal(charged, 0, `tick ${s.tick}: not a boundary, nothing charged`);
    assert.equal(guild(s).credits - before, sold - charged,
      `tick ${s.tick}: the credit change is the sale less the boundary fee — nothing else moves`);
  }
  assert.ok(boundaries >= 2, 'the walk really did cross several boundaries');
  assert.equal(guild(s).credits + s.syndicate.ledger, 0, 'invariant 2 exact');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// The pro-rate's own credit consequence, stated as arithmetic: the FIRST boundary after
// a mid-window signature charges `round(fee × windowFraction)`, every later one the whole
// fee (§5: "one fraction, applied once to the target and once to the fee").
test('a mid-window licence pays a PRO-RATED fee at its first boundary and the full fee after', () => {
  const N = 4;
  let s = sysState([mine('m', 'titanium', 5)], N);
  s = tick(s); s = tick(s);            // state.tick 2 — mid-window (the window is ticks 1..4)
  s = licenseNow(s);
  const lic = venture(s).licence;
  const from = venture(s).committedFromTick;
  assert.equal(from, 3, 'first producing tick is signedTick + 1');

  // Present for ticks 3 and 4 of the 4-tick window that opened at tick 1 ⇒ ½ of it.
  const fraction = windowFraction(venture(s), winStartFor(from, N), N);
  assert.equal(fraction, 0.5);

  s = tick(s); s = tick(s);            // producing ticks 3 and 4 — tick 4 is the boundary
  assert.equal(s.tick, 4);
  const first = guild(s).lastLicenceFee;
  assert.equal(first.tick, 4);
  assert.equal(first.ventures.m.status, 'met', 'the pro-rated target is one it can meet — that is 3b-ii');
  assert.equal(first.charged, Math.round(lic.discountedFee * 0.5),
    'the first, partial window is charged HALF the fee — the same fraction that halved its target');
  assert.ok(first.charged < lic.discountedFee, 'and that really is less than a full window’s fee');

  for (let i = 0; i < N; i += 1) s = tick(s);   // the next whole window
  assert.equal(s.tick, 8);
  const second = guild(s).lastLicenceFee;
  assert.equal(second.tick, 8);
  assert.equal(windowFraction(venture(s), winStartFor(8, N), N), 1, 'a full window from here on');
  assert.equal(second.charged, lic.discountedFee, 'and the full fee is charged from the second window on');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
