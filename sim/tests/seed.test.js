'use strict';

// Tests sim/seed.js — the engine's read-only window onto data/seed.json. These
// resolve real ids from the committed seed (deterministic, so the ids are
// stable): pl_00001 is a rocky planet whose n02 node is titanium and n01 is
// lead, with settlement slots s01.. (verified against the generated seed).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getSite, isResourceNode, isSettlementSlot, findNodesByResource,
  getStarterSystems, isStarterSystem, getTerranHomeworld, getSystemLayout,
} = require('../seed.js');

test('getSite resolves a real resource node with its resourceType and location', () => {
  const site = getSite('pl_00001_n02');
  assert.ok(site, 'pl_00001_n02 should exist');
  assert.equal(site.kind, 'resource');
  assert.equal(site.resourceType, 'titanium');
  assert.equal(site.planetId, 'pl_00001');
  assert.ok(site.systemId, 'carries a systemId');
});

test('getSite resolves a settlement slot (no resourceType)', () => {
  const site = getSite('pl_00001_s01');
  assert.ok(site, 'pl_00001_s01 should exist');
  assert.equal(site.kind, 'settlement');
  assert.equal(site.resourceType, undefined);
  assert.equal(site.planetId, 'pl_00001');
});

test('getSite returns null for a dangling id', () => {
  assert.equal(getSite('pl_99999_n99'), null);
  assert.equal(getSite('not-an-id'), null);
});

test('isResourceNode / isSettlementSlot classify correctly', () => {
  assert.equal(isResourceNode('pl_00001_n02'), true);
  assert.equal(isResourceNode('pl_00001_s01'), false);
  assert.equal(isSettlementSlot('pl_00001_s01'), true);
  assert.equal(isSettlementSlot('pl_00001_n02'), false);
  assert.equal(isResourceNode('nope'), false);
});

test('findNodesByResource returns only that good, sorted, and includes a known node', () => {
  const titanium = findNodesByResource('titanium');
  assert.ok(titanium.length > 0);
  assert.ok(titanium.every((s) => s.kind === 'resource' && s.resourceType === 'titanium'));
  const ids = titanium.map((s) => s.id);
  assert.deepEqual(ids, [...ids].sort(), 'sorted by id');
  assert.ok(ids.includes('pl_00001_n02'));
});

test('getStarterSystems enumerates every starter, id-sorted, each with a real homeworld', () => {
  const starters = getStarterSystems();
  assert.equal(starters.length, 368); // seed 7331; pinned so a seed change is loud
  // id-sorted and consistent with the single-system helpers it was missing.
  for (let i = 1; i < starters.length; i++) {
    assert.ok(starters[i - 1].id < starters[i].id, 'id-sorted');
  }
  for (const s of starters) {
    assert.equal(isStarterSystem(s.id), true, `${s.id} is starter-eligible`);
    assert.equal(s.terranHomeworldId, getTerranHomeworld(s.id), 'homeworld matches getTerranHomeworld');
    assert.ok(typeof s.terranHomeworldId === 'string' && s.terranHomeworldId.length > 0, 'has a homeworld');
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
    assert.ok(['inner', 'middle', 'outer'].includes(s.ring));
  }
  assert.equal(starters[0].id, 'sys_0002'); // the known first starter
});

test('getSystemLayout returns a system with planets, nodes, and settlement slots', () => {
  // sys_0002 is the demo home: a single-planet Terran system.
  const sys = getSystemLayout('sys_0002');
  assert.ok(sys);
  assert.equal(sys.id, 'sys_0002');
  assert.equal(sys.name, 'FEN-6425');
  assert.equal(sys.starterEligible, true);
  assert.equal(sys.terranHomeworldId, 'pl_00004');
  assert.equal(sys.planets.length, 1);
  const hw = sys.planets[0];
  assert.equal(hw.id, 'pl_00004');
  assert.equal(hw.archetype, 'terran');
  assert.equal(hw.resourceNodes.length, 15); // Terran homeworld
  assert.equal(hw.settlementSlots.length, 15); // Terran slot count ([FIRST-CUT])
  // node shape carries id + resourceType; slot shape is id-only (no resourceType).
  assert.deepEqual(hw.resourceNodes[0], { id: 'pl_00004_n01', resourceType: 'titanium' });
  assert.deepEqual(Object.keys(hw.settlementSlots[0]), ['id']);
  assert.equal(hw.settlementSlots[0].id, 'pl_00004_s01');
});

test('getSystemLayout handles a multi-planet system and returns null for a missing one', () => {
  // sys_0009 has 4 planets (desert / terran / rocky / ice), incl. varying counts.
  const sys = getSystemLayout('sys_0009');
  assert.ok(sys);
  assert.equal(sys.planets.length, 4);
  const terran = sys.planets.find((p) => p.archetype === 'terran');
  assert.ok(terran, 'has a terran planet');
  assert.equal(terran.settlementSlots.length, 15);
  // every site id resolves back through getSite — the layout and the site index agree.
  for (const p of sys.planets) {
    for (const n of p.resourceNodes) assert.equal(isResourceNode(n.id), true);
    for (const s of p.settlementSlots) assert.equal(isSettlementSlot(s.id), true);
  }
  assert.equal(getSystemLayout('sys_9999'), null);
  assert.equal(getSystemLayout('not-an-id'), null);
});
