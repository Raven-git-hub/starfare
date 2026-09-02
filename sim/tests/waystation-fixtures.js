'use strict';

// waystation-fixtures.js — real seed systems chosen by their NEAREST-WAYSTATION
// distance, DERIVED from the committed seed rather than pinned. The waystation
// layout regenerates (the segmented 6×16 scheme, §16 step 7), so the ids and the
// distances that hit each rounding case move with it. The fuel/transport tests need
// systems at a few specific distances to exercise the burn = ceil(distance × rate)
// rounding — the free-trip d=1 (ceil 1, not 0), an even d (rounding hidden), an odd d
// (rounding shown), and the farthest system (unmistakable magnitude) — plus a STARTER
// at a known distance to home a guild on. This module derives them so a regen carries
// the tests instead of breaking them; only "a system at this distance exists on the
// seed" is assumed, which the even 96-waystation coverage makes safe.

const { nearestWaystation } = require('../transport.js');
const { getStarterSystems, getTerranHomeworld } = require('../seed.js');
const seed = require('../../data/seed.json');

const starterIds = new Set(getStarterSystems().map((s) => s.id));

// First system (seed/id order — deterministic) whose nearest-waystation distance is
// exactly `d`; optionally restricted to starter systems (for tests that home on it).
function systemAtDistance(d, { starterOnly = false } = {}) {
  for (const sys of seed.systems) {
    if (starterOnly && !starterIds.has(sys.id)) continue;
    if (nearestWaystation(sys.id).distance === d) return sys.id;
  }
  throw new Error(`waystation-fixtures: no ${starterOnly ? 'starter ' : ''}system at nearest-waystation distance ${d} on this seed`);
}

// The system farthest from any waystation (first at the max distance, id order).
function farthestSystem() {
  let best = null;
  for (const sys of seed.systems) {
    const distance = nearestWaystation(sys.id).distance;
    if (best === null || distance > best.distance) best = { id: sys.id, distance };
  }
  return best;
}

// A guild home: a STARTER at distance `d` (even, so burn rounding is hidden there),
// with its Terran homeworld — everything the fuel tests' home guild needs.
function starterHomeAtDistance(d) {
  const id = systemAtDistance(d, { starterOnly: true });
  return { id, distance: d, homePlanet: getTerranHomeworld(id), waystation: nearestWaystation(id).outpost.id };
}

module.exports = { systemAtDistance, farthestSystem, starterHomeAtDistance };
