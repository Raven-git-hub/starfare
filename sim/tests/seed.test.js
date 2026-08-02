'use strict';

// Tests sim/seed.js — the engine's read-only window onto data/seed.json. These
// resolve real ids from the committed seed (deterministic, so the ids are
// stable): pl_00001 is a rocky planet whose n02 node is titanium and n01 is
// lead, with settlement slots s01.. (verified against the generated seed).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getSite, isResourceNode, isSettlementSlot, findNodesByResource } = require('../seed.js');

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
