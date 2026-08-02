'use strict';

// seed.js — the engine's read-only window onto the static galaxy seed
// (data/seed.json). This is the FIRST place the live engine references the seed
// (design.md §15.3's separate store): the live overlay names a place by id, and
// this module resolves that id to what the seed says is there. It NEVER mutates
// the seed — the seed is a pure function of one integer and stays that way.
//
// It builds one index over every planet's resource nodes AND settlement slots,
// once, lazily, cached for the process. `require('../data/seed.json')` is itself
// cached by Node, so "load once" is free; the index is the id -> place map on
// top of it. Kept out of the tick hot path on purpose: only seating-validation
// and the occupancy invariant call in here, so tick() stays seed-free and pure.

const path = require('node:path');

// A "site" is anywhere a venture can sit: a resource node (mining) or a
// settlement slot (refinery/factory/construction). Both share this shape:
//   { id, kind: 'resource' | 'settlement', planetId, systemId, resourceType? }
// resourceType is present only on resource-node sites.
let _index = null;

function buildIndex() {
  // Resolve relative to this file so it works regardless of cwd.
  const seed = require(path.join(__dirname, '..', 'data', 'seed.json'));
  const bySite = new Map();
  for (const sys of seed.systems || []) {
    for (const planet of sys.planets || []) {
      for (const node of planet.resourceNodes || []) {
        bySite.set(node.id, {
          id: node.id, kind: 'resource', resourceType: node.resourceType,
          planetId: planet.id, systemId: sys.id,
        });
      }
      for (const slot of planet.settlementSlots || []) {
        bySite.set(slot.id, {
          id: slot.id, kind: 'settlement',
          planetId: planet.id, systemId: sys.id,
        });
      }
    }
  }
  return { bySite };
}

function index() {
  if (_index === null) _index = buildIndex();
  return _index;
}

// getSite(id) -> the site entry, or null if no such node/slot exists in the
// seed. This is the referential-integrity check a dangling siteId fails.
function getSite(id) {
  return index().bySite.get(id) || null;
}

function isResourceNode(id) {
  const s = getSite(id);
  return !!s && s.kind === 'resource';
}

function isSettlementSlot(id) {
  const s = getSite(id);
  return !!s && s.kind === 'settlement';
}

// findNodesByResource(type) -> every resource-node site of that good. For
// scenarios/tests that need a real node id to seat a venture on. Sorted by id
// for a stable, deterministic order.
function findNodesByResource(resourceType) {
  const out = [];
  for (const site of index().bySite.values()) {
    if (site.kind === 'resource' && site.resourceType === resourceType) out.push(site);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

module.exports = { getSite, isResourceNode, isSettlementSlot, findNodesByResource };
