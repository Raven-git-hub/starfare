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
  siteName, roman,
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
  // Seed-general: the first starter's Terran homeworld, whatever seed is loaded.
  // Its NAME and how many planets share its system are seed-7331 accidents, so
  // this asserts only what the §2/§13 guarantees make true of ANY such homeworld.
  const homeSystemId = getStarterSystems()[0].id;
  const homePlanetId = getTerranHomeworld(homeSystemId);
  const sys = getSystemLayout(homeSystemId);
  assert.ok(sys);
  assert.equal(sys.id, homeSystemId);
  assert.equal(sys.starterEligible, true);
  assert.equal(sys.terranHomeworldId, homePlanetId);
  // Find the homeworld by id — its position in the planet list is seed-specific.
  const hw = sys.planets.find((p) => p.id === homePlanetId);
  assert.ok(hw, 'the Terran homeworld appears in its system layout');
  assert.equal(hw.archetype, 'terran');
  assert.equal(hw.resourceNodes.length, 15); // Terran homeworld
  assert.equal(hw.settlementSlots.length, 15); // Terran slot count ([FIRST-CUT])
  // node shape carries id + resourceType; slot shape is id-only (no resourceType).
  // Terran's guaranteed spread always opens titanium (§2), so _n01 is titanium.
  assert.deepEqual(hw.resourceNodes[0], { id: `${homePlanetId}_n01`, resourceType: 'titanium' });
  assert.deepEqual(Object.keys(hw.settlementSlots[0]), ['id']);
  assert.equal(hw.settlementSlots[0].id, `${homePlanetId}_s01`);
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

// --- the friendly site name (console legibility pass, 28-08-26) --------------------
//
// The seed names systems and nothing below them, so every screen that wanted to say
// WHERE a venture sits printed a raw `pl_00004_n01` at the player. `site.name` is the
// derivation that fixes that: "<system> <planet's Roman ordinal> · <Node|Slot> <n>".
// Pure seed data — no live state, nothing invented, nothing hashed.

test('a site carries its friendly name: pl_00004_n01 in FEN-6425 reads "FEN-6425 I · Node 1"', () => {
  // sys_0002 is FEN-6425 and has exactly ONE planet, pl_00004 — so its ordinal is 1
  // and its Roman numeral is I. The `_n01` suffix names node 1, with the leading zero
  // dropped (the id's padding is an id detail, not something to read aloud).
  const site = getSite('pl_00004_n01');
  assert.equal(site.systemId, 'sys_0002');
  assert.equal(site.name, 'FEN-6425 I · Node 1');
});

test('a settlement slot names its SLOT, and the ordinal follows the planet, not the id', () => {
  assert.equal(getSite('pl_00004_s03').name, 'FEN-6425 I · Slot 3');
  // pl_00001 is another system's planet entirely; whatever its ordinal is, the name is
  // built from that system's name and the planet's place IN it — never from the id digits.
  const other = getSite('pl_00001_n02');
  const sys = getSystemLayout(other.systemId);
  const ordinal = sys.planets.findIndex((p) => p.id === other.planetId) + 1;
  assert.equal(other.name, `${sys.name} ${roman(ordinal)} · Node 2`);
});

test('every site in a system carries a name, and the name is stable per planet', () => {
  // The name is a pure function of (system name, planet ordinal, site suffix), so two
  // sites on the SAME planet differ only in their trailing "Node/Slot n".
  const a = getSite('pl_00004_n01');
  const b = getSite('pl_00004_n02');
  assert.equal(a.name.replace(/Node 1$/, ''), b.name.replace(/Node 2$/, ''));
});

test('roman writes the ordinals a system can actually have (1..6 planets)', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(roman), ['I', 'II', 'III', 'IV', 'V', 'VI']);
  // …and keeps working past that if a future seed makes systems bigger.
  assert.deepEqual([9, 10, 14].map(roman), ['IX', 'X', 'XIV']);
});

test('an id with no _nNN/_sNN suffix falls back to the id itself, never to a fake name', () => {
  assert.equal(siteName('pl_00004', 'FEN-6425', 1), 'pl_00004');
  assert.equal(siteName('weird', 'FEN-6425', 1), 'weird');
});
