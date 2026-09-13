'use strict';

// invariants-buildqueue.test.js — the structural tripwire for the dockyard commission queue
// (roadmap 2.1b, amendment to slice 1: `checkBuildQueues`, sim/invariants.js). It guards the
// single-slot / strict-FIFO / id-integrity properties docs/build-yard.md §3/§6 rule, so a future
// slice, a save-reload, or a client bug that breaks single-slot is caught by the HARNESS, not a
// review pass. These tests hand-corrupt an otherwise-valid dockyard state and assert the invariant
// bites with exactly the expected rule (and that assertInvariants halts).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { checkInvariants, assertInvariants } = require('../invariants.js');
const { BUILD_TICKS } = require('../asset-recipes.js');

// A valid dockyard state: one started head (10 ticks left, well under BUILD_TICKS.miner), one
// queued entry, unique ids 0/1, nextCommissionId 2 above them. Unseated (no site/asset), so the
// occupancy invariants skip it and this isolates checkBuildQueues.
function validDockState() {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA',
        dockyard: true, nextCommissionId: 2,
        buildQueue: [
          { commissionId: 0, assetKind: 'miner', remainingTicks: 10 },
          { commissionId: 1, assetKind: 'factory', remainingTicks: null },
        ],
      }],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
}

// A plain (non-dockyard) mining venture, for the "queue on a non-dockyard is corruption" cases.
function plainVentureState() {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: [{ id: 'm1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'titanium', productionRate: 5 }],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
}

const yard = (s) => s.guilds[0].ventures[0];
// Only the build-queue invariant's own violations (rules start with build- / dockyard-).
const bqViolations = (s) => checkInvariants(s, 0).filter((v) => /^(build-|dockyard-)/.test(v.rule));

test('a valid dockyard state produces NO build-queue violation', () => {
  const s = validDockState();
  assert.deepEqual(checkInvariants(s, 0), [], 'the whole state is valid');
  assert.deepEqual(bqViolations(s), []);
});

test('bites: a started entry that is NOT the head', () => {
  const s = validDockState();
  yard(s).buildQueue[0].remainingTicks = null; // head not started
  yard(s).buildQueue[1].remainingTicks = 5;    // a later entry started — skip-ahead
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /started-is-head/);
  assert.equal(v[0].where, 'venture:d1.buildQueue[1]');
});

test('bites: two started entries (single active build)', () => {
  const s = validDockState();
  yard(s).buildQueue[0].remainingTicks = 5;
  yard(s).buildQueue[1].remainingTicks = 5;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /single-active-build/);
  assert.equal(v[0].detail.startedCount, 2);
});

test('bites: remainingTicks negative', () => {
  const s = validDockState();
  yard(s).buildQueue[0].remainingTicks = -1;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /remainingTicks-null-or-non-negative-int/);
  assert.equal(v[0].detail.remainingTicks, -1);
});

test('bites: remainingTicks above BUILD_TICKS[kind]', () => {
  const s = validDockState();
  yard(s).buildQueue[0].remainingTicks = BUILD_TICKS.miner + 1;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /remainingTicks-within-BUILD_TICKS/);
  assert.equal(v[0].detail.cap, BUILD_TICKS.miner);
});

test('bites: remainingTicks non-integer', () => {
  const s = validDockState();
  yard(s).buildQueue[0].remainingTicks = 2.5;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /remainingTicks-null-or-non-negative-int/);
});

test('bites: a non-buildable assetKind', () => {
  const s = validDockState();
  yard(s).buildQueue[1].assetKind = 'light_transport';
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /kind-buildable/);
  assert.equal(v[0].detail.assetKind, 'light_transport');
});

test('bites: a duplicate commissionId', () => {
  const s = validDockState();
  yard(s).buildQueue[1].commissionId = 0; // collides with the head's id
  yard(s).nextCommissionId = 1;           // still above the (now single) max id 0
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /commissionId-unique/);
});

test('bites: nextCommissionId not above every live id', () => {
  const s = validDockState();
  yard(s).nextCommissionId = 1; // but id 1 is live in the queue — a new commission would reuse it
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /nextCommissionId-above-live-ids/);
  assert.equal(v[0].detail.maxCommissionId, 1);
});

test('bites: a buildQueue present on a NON-dockyard venture', () => {
  const s = plainVentureState();
  s.guilds[0].ventures[0].buildQueue = [{ commissionId: 0, assetKind: 'miner', remainingTicks: null }];
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /only-on-dockyard/);
  assert.equal(v[0].where, 'venture:m1.buildQueue');
});

test('bites: a nextCommissionId present on a NON-dockyard venture', () => {
  const s = plainVentureState();
  s.guilds[0].ventures[0].nextCommissionId = 3;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /only-on-dockyard/);
  assert.equal(v[0].where, 'venture:m1.nextCommissionId');
});

test('bites: a dockyard missing its buildQueue array', () => {
  const s = validDockState();
  yard(s).buildQueue = undefined;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /dockyard-has-a-build-queue/);
});

test('bites: a dockyard with a non-integer nextCommissionId', () => {
  const s = validDockState();
  yard(s).nextCommissionId = 2.5;
  const v = bqViolations(s);
  assert.equal(v.length, 1);
  assert.match(v[0].rule, /nextCommissionId-non-negative-int/);
});

test('assertInvariants HALTS on a corrupted queue, naming the venture', () => {
  const s = validDockState();
  yard(s).buildQueue[0].remainingTicks = null; // head not started …
  yard(s).buildQueue[1].remainingTicks = 5;    // … but a later entry is — skip-ahead
  assert.throws(() => assertInvariants(s, 7), /venture:d1\.buildQueue\[1\]/);
});
