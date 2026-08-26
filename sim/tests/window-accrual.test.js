'use strict';

// §5 "The Syndicate commitment is a per-good windowed accrual" + "Window boundaries
// and edge cases (Slice B; ruled 10-08-26)". These are the production-engine tripwires
// the Slice B-i build must ship (§18 #4 — mechanical tripwires over review), in the
// recipe-ratio.test.js style: controlled single-system scenarios, exact numbers. They
// pin the accrual mechanics the windowed model turns on:
//   (a) the fraction==1 deferral guard  (b) send carry fenced in [0,1)
//   (c) delivered never exceeds Q        (d) fresh-only (never the stockpile)
//   (e) boundary met/breach + roll       (f) self-terminating overflow at Q
//   (g) impossible-pace breach, guarded  (h) galacticSupply drops by exactly delivered
//   (i) determinism over multi-window    (j) the send carry preserves determinism

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { getWindow, winStartFor, windowFraction } = require('../windows.js');
const { previewProduction } = require('../production.js');
const { computeGalacticSupply } = require('../supply.js');

const SYS = 'sysA';
const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate, syndicateCommitment: commitment,
});
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);
const w = (s, good) => getWindow(s.guilds[0], SYS, good);
// The window telemetry the NEXT tick will produce (previewProduction previews
// producing tick state.tick + 1), the surface the client reads and computes nothing.
const nextWindow = (s, good) => previewProduction(s)[0].systems[0].goods[good].window;

function sysState({ ventures, profile = {}, stockpiles = {}, windowN }) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: Object.keys(stockpiles).length ? { [SYS]: stockpiles } : {},
      productionProfile: Object.keys(profile).length ? { [SYS]: profile } : {},
      ventures,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

// --- (a) the mid-window pro-rate ------------------------------------------------
//
// This slot used to hold the DEFERRAL guard — "fraction == 1 for every venture" — whose
// job was to go red the instant a mid-window join was wired without the pro-rate (§5's
// join ruling, Option A, build deferred). Slice 3b-ii wires it, so the guard has done
// its job and is retired: what replaces it is the correctness of the thing it was
// guarding. The runtime half of the swap lives in invariants.js, which now asserts the
// fraction is SANE (in (0, 1]) rather than absent. See docs/mid-window-pro-rate.md.

test('(a) a venture present for the whole window still owes the whole window', () => {
  // The unchanged majority case: no committedFromTick at all (unlicensed, or committed
  // through the dev scaffold, which stays full-window), or one stamped at/before the
  // window opened. Both mean "present since before this window" ⇒ fraction 1.
  const N = 6;
  const ventures = [
    mine('t', 'titanium', 10, 8), mine('c', 'carbon_products', 10, 4),
    refinery('r', 'titanium_alloy', 2),
  ];
  for (const p of [1, 2, 5, 6, 7, 12]) {
    const ws = winStartFor(p, N);
    for (const v of ventures) {
      assert.equal(windowFraction(v, ws, N), 1, `venture ${v.id} carries no join tick (fraction 1) at p=${p}`);
    }
    assert.equal(windowFraction({ committedFromTick: ws }, ws, N), 1, 'joined exactly as the window opened');
    assert.equal(windowFraction({ committedFromTick: ws - 3 }, ws, N), 1, 'joined before it opened');
  }
});

test('(a) a mid-window joiner owes present/N — down to a single-tick sliver', () => {
  const N = 4;
  const ws = winStartFor(3, N); // window 1 spans producing ticks 1..4
  assert.equal(ws, 1);
  // First producing tick 2 ⇒ present for ticks 2,3,4 = 3 of 4.
  assert.equal(windowFraction({ committedFromTick: 2 }, ws, N), 3 / 4);
  assert.equal(windowFraction({ committedFromTick: 3 }, ws, N), 2 / 4);
  // First delivering ON the boundary tick: it owes a sliver, and a sliver is still
  // deliverable — which is the whole point of pro-rating rather than excusing.
  assert.equal(windowFraction({ committedFromTick: 4 }, ws, N), 1 / 4);
  // A venture whose first producing tick is past this window contributes nothing to it.
  assert.equal(windowFraction({ committedFromTick: 5 }, ws, N), 0);
});

// --- (b) send carry fenced in [0,1) every tick ----------------------------------

test('(b) the send carry stays in [0,1) every tick, even under a fractional pace', () => {
  // Q=7 over N=4 ⇒ a 1.75/tick pace, so the send carry is genuinely fractional every
  // tick. It must never reach 1 (a whole undelivered unit) or go negative.
  let s = sysState({ ventures: [mine('t', 'titanium', 10, 7)], windowN: 4 });
  for (let i = 0; i < 40; i += 1) {
    s = tick(s);
    const win = w(s, 'titanium');
    assert.ok(win.sendCarry >= 0 && win.sendCarry < 1, `sendCarry ${win.sendCarry} in [0,1) at tick ${s.tick}`);
    assert.deepEqual(checkInvariants(s, s.tick), []); // the invariant tripwire agrees
  }
});

// --- (c) delivered never exceeds Q within a window ------------------------------

test('(c) delivered never exceeds Q within a window, however aggressive the send', () => {
  // percent 100 on a lean-then-rich supply: it tries to send ALL fresh, but must cap at
  // Q and self-terminate. Over many windows, delivered ≤ Q at every tick.
  const Q = 9;
  let s = sysState({
    ventures: [mine('t', 'titanium', 5, Q)],
    profile: { goods: { titanium: { syndicate: { mode: 'percent', value: 100 } } } },
    windowN: 5,
  });
  for (let i = 0; i < 30; i += 1) {
    s = tick(s);
    assert.ok(w(s, 'titanium').delivered <= Q, `delivered ${w(s, 'titanium').delivered} <= Q ${Q} at tick ${s.tick}`);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

// --- (d) fresh-only: a full stockpile + zero fresh delivers 0 -------------------

test('(d) fresh-only: a full stockpile with zero fresh delivers 0 — the fork never touches the pile', () => {
  // An idle/offline committed mine (rate 0 — its commitment still counts toward Q, but
  // it produces no fresh) with a big pre-seeded pile. Fresh is 0, so the fresh-only
  // Syndicate fork delivers 0 every tick and the 100-unit pile is never reduced.
  let s = sysState({ ventures: [mine('t', 'titanium', 0, 8)], stockpiles: { titanium: 100 }, windowN: 4 });
  for (let i = 0; i < 8; i += 1) {
    const send = nextWindow(s, 'titanium').sendThisTick;
    assert.equal(send, 0, 'zero fresh ⇒ nothing to send');
    s = tick(s);
    assert.equal(held(s, 'titanium'), 100, 'the pile is untouched — the fork drew no reserve');
    assert.equal(w(s, 'titanium').delivered, 0);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

// --- (e) boundary: met/breach status; delivered resets + windowStart re-stamps ---

test('(e) boundary MET: status resolves met, then the next tick resets delivered and re-stamps windowStart', () => {
  // Q=4 over N=2 ⇒ paced 2/tick, so delivered reaches 4 = Q exactly at the boundary.
  let s = sysState({ ventures: [mine('t', 'titanium', 10, 4)], windowN: 2 });
  s = tick(s); // producing tick 1: delivered 2
  assert.equal(w(s, 'titanium').delivered, 2);
  assert.equal(nextWindow(s, 'titanium').status, 'met', 'the boundary tick (p=2) will meet Q');
  s = tick(s); // producing tick 2 = boundary
  assert.equal(w(s, 'titanium').delivered, 4, 'Q met at the boundary');
  assert.equal(w(s, 'titanium').windowStart, 1);
  s = tick(s); // producing tick 3 = first tick of the next window
  assert.equal(w(s, 'titanium').windowStart, 3, 'a new window-start is stamped');
  assert.equal(w(s, 'titanium').delivered, 2, 'delivered reset to 0, then this tick sent 2');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('(e) boundary BREACH: an under-delivering absolute send breaches at the boundary', () => {
  // absolute 1/tick against Q=4 over N=2 ⇒ delivered 2 by the boundary, short of Q.
  let s = sysState({
    ventures: [mine('t', 'titanium', 10, 4)],
    profile: { goods: { titanium: { syndicate: { mode: 'absolute', value: 1 } } } },
    windowN: 2,
  });
  s = tick(s); // p=1: delivered 1
  assert.equal(nextWindow(s, 'titanium').status, 'breach', 'p=2 will fall short of Q ⇒ breach');
  s = tick(s); // p=2 boundary
  assert.equal(w(s, 'titanium').delivered, 2, 'only 2 delivered against Q 4 — a breach (status flag only, no fee)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- (f) self-terminating: once Q is met, further fresh overflows to stockpile ---

test('(f) self-terminating: once delivered >= Q mid-window, the fork stops and fresh overflows to stockpile', () => {
  // percent 100, mine rate 5, Q=10, N=8. It delivers 5 + 5 = Q by tick 2 (well before
  // the boundary), then STOPS: from tick 3 on the fork takes nothing and the fresh 5
  // piles up untouched (the same fall-through overflow Gate 3 has), no penalty.
  let s = sysState({
    ventures: [mine('t', 'titanium', 5, 10)],
    profile: { goods: { titanium: { syndicate: { mode: 'percent', value: 100 } } } },
    windowN: 8,
  });
  s = tick(s); s = tick(s); // delivered 10 = Q, pool 0
  assert.equal(w(s, 'titanium').delivered, 10);
  assert.equal(held(s, 'titanium'), 0, 'everything sent so far');
  for (let i = 0; i < 3; i += 1) {
    const before = held(s, 'titanium');
    s = tick(s);
    assert.equal(w(s, 'titanium').delivered, 10, 'self-terminated at Q — delivers no more this window');
    assert.equal(held(s, 'titanium') - before, 5, 'the fresh 5 overflows to stockpile, untouched by the fork');
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
});

// --- (g) impossible-pace: zero-fresh window breaches; the pace stays display-only ---

test('(g) impossible-pace: a zero-fresh window breaches, the required-rate is guarded (finite), the tick never crashes, send == 0', () => {
  // An idle committed mine (rate 0, commitment 8) and NO pile: production cannot keep
  // pace. Every tick the send is 0 (min(pace, fresh=0)); the required-rate climbs as a
  // DISPLAY figure but is guarded (always finite — never Infinity/NaN into state); the
  // window breaches at the boundary. The tick loop never throws.
  let s = sysState({ ventures: [mine('t', 'titanium', 0, 8)], windowN: 4 });
  for (let i = 0; i < 4; i += 1) {
    const pv = nextWindow(s, 'titanium');
    assert.equal(pv.sendThisTick, 0, 'zero fresh ⇒ send 0');
    assert.ok(Number.isFinite(pv.requiredRate), 'the required-rate is guarded to a finite number (no divide-by-zero into state)');
    s = tick(s);
    assert.equal(w(s, 'titanium').delivered, 0);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  // At the boundary (tick 4) the window has delivered 0 of Q 8 — a breach.
  assert.equal(nextWindow(s, 'titanium').status !== undefined, true);
  // Re-run to the boundary reading its status: rebuild and step to just before it.
  let s2 = sysState({ ventures: [mine('t', 'titanium', 0, 8)], windowN: 4 });
  for (let i = 0; i < 3; i += 1) s2 = tick(s2); // producing ticks 1..3
  assert.equal(nextWindow(s2, 'titanium').status, 'breach', 'producing tick 4 (the boundary) breaches');
});

// --- (h) galacticSupply drops by exactly the delivered amount --------------------

test('(h) galacticSupply drops by exactly the delivered amount (the Syndicate sink stays consistent)', () => {
  // A committed mine-to-sell (rate 10, Q=8, N=4 ⇒ paced 2/tick), no consumer. Each tick
  // galactic titanium = before + fresh(10) − delivered, so the drop-from-fresh IS the
  // delivered amount — the sink is real and consistent (invariants.js models selling as
  // a sink, not a conservation break).
  let s = sysState({ ventures: [mine('t', 'titanium', 10, 8)], windowN: 4 });
  for (let i = 0; i < 8; i += 1) {
    const before = computeGalacticSupply(s).resources.titanium;
    s = tick(s);
    const delivered = w(s, 'titanium').delivered; // this window's running total
    const sentThisTick = computeGalacticSupply(s).resources.titanium - (before + 10);
    // sentThisTick is negative = the units that sank this tick.
    assert.ok(sentThisTick <= 0, 'the galactic total never rises by more than the fresh mined');
    assert.equal(-sentThisTick, 2, 'exactly the paced 2 units sank this tick (Q 8 / N 4)');
    assert.deepEqual(checkInvariants(s, s.tick), []);
    // sanity: delivered is a running non-negative total ≤ Q
    assert.ok(delivered >= 0 && delivered <= 8);
  }
});

// --- (i) determinism over a multi-tick, multi-window run with commitments --------

test('(i) determinism (invariant 9): a multi-window committed run is byte-identical run twice', () => {
  const build = () => {
    let s = sysState({
      ventures: [
        mine('t', 'titanium', 10, 7),          // paced, fractional
        mine('c', 'carbon_products', 10, 5),   // paced, fractional
        mine('s', 'silica', 8, 6),             // percent-controlled below
        refinery('r', 'titanium_alloy', 2),
      ],
      profile: {
        goods: {
          silica: { syndicate: { mode: 'percent', value: 40 } },
          titanium: { order: ['downstream', 'syndicate', 'stockpile'] },
        },
      },
      windowN: 5,
    });
    for (let i = 0; i < 53; i += 1) s = tick(s); // spans >10 windows, crossing many boundaries
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

// --- (j) the send carry preserves determinism (stable keys, byte-identical) ------

test('(j) the send carry, like batchCarry, preserves determinism — stable key set, same-process byte-identical', () => {
  // A fractional pace keeps a live send carry in serialized state across the whole run;
  // the syndicateWindows key set must be stable and the state byte-identical run twice.
  const build = () => {
    let s = sysState({ ventures: [mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 6, 3)], windowN: 4 });
    for (let i = 0; i < 37; i += 1) s = tick(s);
    return s;
  };
  const a = build();
  const b = build();
  assert.equal(hashState(a), hashState(b));
  // The windows exist and their key set is deterministic (both goods carry a window).
  assert.deepEqual(
    Object.keys(a.guilds[0].syndicateWindows[SYS]).sort(),
    ['carbon_products', 'titanium'],
  );
  // Every carry is a fenced fraction (belt-and-braces alongside the invariant tripwire).
  for (const win of Object.values(a.guilds[0].syndicateWindows[SYS])) {
    assert.ok(win.sendCarry >= 0 && win.sendCarry < 1);
  }
});
