'use strict';

// guild-hall-fields.test.js — the Guild Hall engine slice (docs/guild-hall.md §4,
// slices A/B/C): the three per-guild fields the Standing panel wires up, all stamped at
// the issuance boundary in tick.js step 6 and published in the snapshot.
//
//   A — `fuelHoardAtCycleStart` (+ its marked `…Value`): the hoard POST-grant, before
//       this cycle's usage — the stockpile bar's max and used-this-cycle datum.
//   B — `fuelGrant.modifier`: the issuance modifier that DROVE the grant (the panel's
//       Current gauge), stamped on `lastFuelGrant`.
//   C — `modifierHistory`: a rolling per-guild ring of the modifier, one sample per cycle
//       (sim/modifier-history.js) — the panel's Performance line.
//
// The determinism / byte-identity story for these fields (the goldens moved for the
// committed run alone, proven the ONLY delta by strip) lives in commitment-scaffold.test.js;
// this file pins the VALUES, the snapshot surface, the sparsity, the ring cap, and the
// tripwires that guard each field.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { issuanceModifier } = require('../meanline.js');
const { fuelValue, REFERENCE_FUEL_PRICE, GUILD_STARTING_FUEL } = require('../fuel.js');
const {
  MODIFIER_HISTORY_N, getModifierHistory, pushModifierSample, cloneModifierHistory,
} = require('../modifier-history.js');

const SYS = 'sysA';
const N = 4; // a short window, so a boundary is 4 ticks away
const mine = (id, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate,
});

// A one-guild galaxy with a titanium mine (GP > 0, so it is DUE a grant) over a pool that
// starts empty — the boundary's influx fills it — on the short window N.
function fixture({ fuelHoard = 0, pool = 0 } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard, ventures: [mine('t', 'titanium', 5)] }],
    reserve: { reserveLevel: pool },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}
const runToBoundary = (s) => { do { s = tick(s); } while (s.tick % N !== 0); return s; };

// --- the module in isolation ------------------------------------------------------

test('modifier-history: push appends oldest → newest and the ring caps at MODIFIER_HISTORY_N', () => {
  const g = {};
  assert.equal(getModifierHistory(g), null, 'no history before the first sample');
  for (let i = 0; i < MODIFIER_HISTORY_N; i += 1) pushModifierSample(g, i / 10);
  assert.equal(g.modifierHistory.length, MODIFIER_HISTORY_N, 'the ring fills to its cap');
  assert.equal(g.modifierHistory[0], 0, 'oldest first');
  assert.equal(g.modifierHistory[MODIFIER_HISTORY_N - 1], (MODIFIER_HISTORY_N - 1) / 10, 'newest last');

  // One past the cap: the oldest is dropped, the newest is appended, length holds.
  pushModifierSample(g, 9.9);
  assert.equal(g.modifierHistory.length, MODIFIER_HISTORY_N, 'still capped');
  assert.equal(g.modifierHistory[0], 0.1, 'the oldest sample fell off');
  assert.equal(g.modifierHistory[MODIFIER_HISTORY_N - 1], 9.9, 'the newest is at the end');
});

test('modifier-history: a NaN or non-number is REFUSED, never written', () => {
  const g = {};
  assert.throws(() => pushModifierSample(g, NaN), /non-finite/);
  assert.throws(() => pushModifierSample(g, Infinity), /non-finite/);
  assert.throws(() => pushModifierSample(g, '1'), /non-finite/);
  assert.equal(g.modifierHistory, undefined, 'nothing was minted by a refused push');
});

test('modifier-history: clone is a fresh array that cannot alias engine state', () => {
  const src = [1, 2, 3];
  const copy = cloneModifierHistory(src);
  assert.deepEqual(copy, src);
  copy.push(4);
  assert.deepEqual(src, [1, 2, 3], 'mutating the clone leaves the source untouched');
  assert.deepEqual(cloneModifierHistory(undefined), [], 'absent history clones to an empty array');
});

// --- pinning the values on a real boundary ----------------------------------------

test('after a boundary, the three fields carry exactly the ruled values', () => {
  let s = fixture({ fuelHoard: 100 });
  s = runToBoundary(s);
  const g = s.guilds[0];

  // The modifier that drove the grant — read at the boundary. Reputation does not move for
  // an unlicensed guild, so this after-the-fact read is the value that was stamped.
  const modifier = issuanceModifier(s, g);
  const granted = g.lastFuelGrant.granted;
  assert.ok(granted > 0, 'the guild really was granted fuel (else the pins are vacuous)');

  // Slice A — the start-of-cycle hoard is the hoard POST-grant, before any usage.
  assert.equal(g.fuelHoardAtCycleStart, g.fuelHoard, 'A: cycle-start hoard equals the post-grant hoard');
  assert.equal(g.fuelHoardAtCycleStart, 100 + granted, 'and that is the opening hoard plus this cycle\'s grant');

  // Slice B — the grant record carries the modifier that sized it.
  assert.equal(g.lastFuelGrant.modifier, modifier, 'B: fuelGrant.modifier equals issuanceModifier at the boundary');

  // Slice C — the history gained exactly one sample, equal to that modifier.
  assert.deepEqual(g.modifierHistory, [modifier], 'C: one sample, the boundary modifier');

  assert.deepEqual(checkInvariants(s, s.tick), [], 'and the state is invariant-clean');
});

test('the history gains exactly one sample per cycle, at the boundary and nowhere else', () => {
  let s = fixture();
  // Mid-window ticks add no HISTORY sample — that is minted only at the boundary. Slice A′
  // (03-09-26) stamps `fuelHoardAtCycleStart` at FOUNDING (= the fixture's opening hoard, 0
  // here), so it is already present and holds fixed through the window until the boundary
  // re-stamp — it does NOT track the boundary the way the history sample does.
  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(s.guilds[0].modifierHistory, undefined, `tick ${s.tick}: nothing off a boundary`);
    assert.equal(s.guilds[0].fuelHoardAtCycleStart, 0, `tick ${s.tick}: A holds its founding value off a boundary`);
  }
  s = tick(s); // the boundary
  assert.equal(s.guilds[0].modifierHistory.length, 1, 'one sample at the first boundary');

  for (let c = 2; c <= 5; c += 1) s = runToBoundary(s);
  assert.equal(s.guilds[0].modifierHistory.length, 5, 'one more per cycle — five cycles, five samples');
});

test('over many cycles the ring caps at MODIFIER_HISTORY_N and keeps the most recent', () => {
  let s = fixture();
  const boundaries = MODIFIER_HISTORY_N + 3;
  for (let c = 0; c < boundaries; c += 1) s = runToBoundary(s);
  const ring = s.guilds[0].modifierHistory;
  assert.equal(ring.length, MODIFIER_HISTORY_N, `${boundaries} boundaries, but the ring holds only ${MODIFIER_HISTORY_N}`);
  // The last sample is the modifier that drove the most recent grant.
  assert.equal(ring[ring.length - 1], issuanceModifier(s, s.guilds[0]), 'newest sample is the current cycle\'s modifier');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'still invariant-clean after the ring has rolled');
});

// --- sparsity: a holdings-less galaxy stays byte-identical -------------------------

test('a guild DUE nothing (holds nothing) is stamped nothing AT THE BOUNDARY, and the run is deterministic', () => {
  // GP 0 ⇒ due 0 ⇒ the boundary re-stamp never fires: none of the boundary-only fields (B and
  // C, and A's re-stamp) is minted. But Slice A′ stamps `fuelHoardAtCycleStart` at FOUNDING, so
  // this holdings-less guild carries it from birth — at its opening hoard (7), untouched by the
  // boundary that never came for it. That founding stamp is exactly the point of A′: a guild's
  // bar sizes from its starting fuel even if it is never due a grant.
  const empty = () => createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 7 }], // no ventures ⇒ GP 0
    reserve: { reserveLevel: 5000 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
  let s = empty();
  for (let c = 0; c < 3; c += 1) s = runToBoundary(s);
  const g = s.guilds[0];
  assert.equal(g.fuelHoardAtCycleStart, 7, 'A′: stamped at founding (= the opening hoard), never re-stamped for a guild due no grant');
  assert.equal(g.modifierHistory, undefined, 'C: no key — the boundary re-stamp never fired');
  assert.equal(g.lastFuelGrant, undefined, 'and no grant record to carry B');

  // Determinism (invariant 9): the same holdings-less run twice is byte-identical.
  let s2 = empty();
  for (let c = 0; c < 3; c += 1) s2 = runToBoundary(s2);
  assert.equal(hashState(s), hashState(s2), 'a holdings-less run is deterministic');
});

test('determinism (invariant 9): a run that stamps the three fields is byte-identical twice', () => {
  const run = () => {
    let s = fixture({ fuelHoard: 250 });
    for (let c = 0; c < 6; c += 1) s = runToBoundary(s);
    return hashState(s);
  };
  assert.equal(run(), run());
});

// --- the snapshot surface ---------------------------------------------------------

test('the snapshot publishes all three fields, marked and echoed', () => {
  let s = fixture({ fuelHoard: 40 });
  s = runToBoundary(s);
  const g = s.guilds[0];
  const snap = buildSnapshot(s);
  const row = snap.guilds[0];

  // A — the value AND its mark-to-market at the CURRENT fuel price (docs/guild-hall.md §2.3:
  // "the boundary hoard × the current price"), exactly parallel to fuelHoardValue and through
  // the same `fuelValue` (invariant 5: one fuel price for the whole snapshot). At the boundary
  // tick no fuel has been used yet, so the cycle-start hoard equals the live hoard — and so do
  // their marked values, both at the price the controller has just posted (moved off the
  // reference, which is exactly the price a stockpile bar must mark against).
  assert.equal(row.fuelHoardAtCycleStart, g.fuelHoardAtCycleStart);
  assert.equal(row.fuelHoardAtCycleStartValue, fuelValue(g.fuelHoardAtCycleStart, s.reserve.fuelPrice));
  assert.equal(row.fuelHoardAtCycleStart, row.fuelHoard, 'at the boundary tick, cycle-start hoard == live hoard');
  assert.equal(row.fuelHoardAtCycleStartValue, row.fuelHoardValue, 'and their marked values agree, at the current price');
  assert.notEqual(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'the controller moved the price off the reference by now');

  // B — the modifier on the grant, beside the live Predicted one.
  assert.equal(row.fuelGrant.modifier, g.lastFuelGrant.modifier);
  assert.equal(row.issuanceModifier, issuanceModifier(s, g), 'the live Predicted is still there beside the stored Current');

  // C — the history echoed, and a deep-enough copy (no alias into engine state).
  assert.deepEqual(row.modifierHistory, g.modifierHistory);
  row.modifierHistory.push(999);
  assert.equal(s.guilds[0].modifierHistory.length, 1, 'mutating the snapshot must not reach into engine state');

  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
});

test('Slice A′: the snapshot sizes the bar from birth — cycle-start == live hoard, before any boundary', () => {
  // THE ACCEPTANCE OF SLICE A′ (docs/guild-hall.md §4). At tick 0, before any boundary, the
  // stockpile bar must read FULL at the guild's starting fuel — so `fuelHoardAtCycleStart`
  // (the bar's max) equals the live `fuelHoard`, and their marked credit values agree at the
  // opening price. Before A′ both were null and the bar showed 500u of real fuel as empty.
  const s = fixture({ fuelHoard: 12 }); // tick 0 — never crossed a boundary
  const snap = buildSnapshot(s);
  const row = snap.guilds[0];
  assert.equal(row.fuelHoardAtCycleStart, 12, 'A′: the founding hoard is the bar max from birth (not null)');
  assert.equal(row.fuelHoardAtCycleStart, row.fuelHoard, 'so the bar reads FULL — max == live hoard at founding');
  assert.equal(row.fuelHoardAtCycleStartValue, fuelValue(12, s.reserve.fuelPrice), 'marked through the same fuelValue/price');
  assert.equal(row.fuelHoardAtCycleStartValue, row.fuelHoardValue, 'and the marked max == the marked live value (the acceptance)');
  assert.notEqual(row.fuelHoardAtCycleStartValue, null, 'a non-null value — the client sizes its track off it');
  // The two boundary-only fields are still in their pre-boundary state — A′ moved only A.
  assert.deepEqual(row.modifierHistory, [], 'the Performance line gets a stable [] — its "gathering history" state');
  assert.equal(row.fuelGrant, null, 'and no grant record yet');
});

test('Slice A′: a freshly-created guild carries fuelHoardAtCycleStart == fuelHoard, before any boundary', () => {
  // The engine-level tripwire behind the snapshot acceptance above: `createGuild` stamps the
  // reference at creation (= the guild's own fuelHoard) for EVERY creation path. A guild
  // founded through the real action opens on GUILD_STARTING_FUEL, so its bar sizes off that.
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: GUILD_STARTING_FUEL, ventures: [mine('t', 'titanium', 5)] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
  const g = s.guilds[0];
  assert.equal(s.tick, 0, 'no boundary has been crossed');
  assert.equal(g.fuelHoardAtCycleStart, g.fuelHoard, 'stamped at creation, equal to the opening hoard');
  assert.equal(g.fuelHoardAtCycleStart, GUILD_STARTING_FUEL, 'which for a founded guild is the starter floor (500u)');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'and the freshly-stamped state is invariant-clean');
});

// --- the tripwires ----------------------------------------------------------------

test('invariants: a corrupt fuelHoardAtCycleStart is caught (integer + non-negative)', () => {
  let s = fixture({ fuelHoard: 100 });
  s = runToBoundary(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'clean before it is broken');

  const neg = structuredClone(s);
  neg.guilds[0].fuelHoardAtCycleStart = -1;
  assert.ok(checkInvariants(neg, neg.tick).some((v) => v.rule === 'non-negativity (invariant 3)'),
    'a negative cycle-start hoard trips non-negativity');

  const frac = structuredClone(s);
  frac.guilds[0].fuelHoardAtCycleStart = 12.5;
  assert.ok(checkInvariants(frac, frac.tick).some((v) => v.rule === 'integer credits/goods (§15.2)'),
    'a fractional one trips the integer sweep');
});

test('invariants: a non-positive or non-finite grant modifier is caught', () => {
  let s = fixture({ fuelHoard: 100 });
  s = runToBoundary(s);

  for (const bad of [0, -0.5, NaN, Infinity]) {
    const broken = structuredClone(s);
    broken.guilds[0].lastFuelGrant.modifier = bad;
    assert.ok(
      checkInvariants(broken, broken.tick).some((v) => v.rule === 'grant-modifier-is-a-positive-float (Guild Hall §4 B)'),
      `modifier ${String(bad)} trips the grant-modifier tripwire`,
    );
  }
});

test('invariants: a rotted modifier history is caught (shape, cap, finiteness)', () => {
  let s = fixture({ fuelHoard: 100 });
  s = runToBoundary(s);

  const notArray = structuredClone(s);
  notArray.guilds[0].modifierHistory = { 0: 1 };
  assert.ok(checkInvariants(notArray, notArray.tick).some((v) => v.rule === 'modifier-history-is-an-array (sim/modifier-history.js)'),
    'a non-array history is caught');

  const overCap = structuredClone(s);
  overCap.guilds[0].modifierHistory = new Array(MODIFIER_HISTORY_N + 1).fill(1);
  assert.ok(checkInvariants(overCap, overCap.tick).some((v) => v.rule === 'modifier-history-ring-capped-at-MODIFIER_HISTORY_N (sim/modifier-history.js)'),
    'a ring past its cap is caught');

  const nan = structuredClone(s);
  nan.guilds[0].modifierHistory = [1, NaN, 1];
  assert.ok(checkInvariants(nan, nan.tick).some((v) => v.rule === 'modifier-history-sample-finite (sim/modifier-history.js)'),
    'a NaN sample is caught');
});
