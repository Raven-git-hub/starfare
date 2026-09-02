'use strict';

// home-anchor.js — the demo/test HOME, DERIVED from the committed seed rather than
// hardcoded. Every test that founds the player guild on "the starter home" and
// seats ventures on its Terran homeworld used to write the literal ids that seed
// 7331 happens to produce (sys_0002 / pl_00004 / pl_00004_n01 ...). Those ids are
// an accident of the seed: regenerate it and the first starter — and its
// homeworld — move. This module names the home the way the live game already does
// (getStarterSystems()[0] + its Terran homeworld, design.md §13), so a
// regenerated seed carries the tests with it instead of breaking them.
//
// The equivalence tripwire in home-anchor.test.js pins these to the seed-7331
// ids — it is the one place that updates when the seed is regenerated.

const { getStarterSystems, getTerranHomeworld } = require('../seed.js');

// The first starter system (id-sorted, like getOutposts) and its Terran homeworld.
const HOME_SYSTEM = getStarterSystems()[0].id;
const HOME_PLANET = getTerranHomeworld(HOME_SYSTEM);

// Sites on the homeworld, by the seed's own id convention (`<planet>_nNN` / `_sNN`).
// A Terran homeworld ALWAYS opens its node list titanium, titanium (§2's guaranteed
// spread), so _n01 and _n02 are titanium on any seed; _s01 is its first settlement
// slot (Terran always carries 15). Tests needing other homeworld sites build them
// from HOME_PLANET the same way (e.g. `${HOME_PLANET}_n08`).
const HOME_MINE = `${HOME_PLANET}_n01`;   // titanium node (the primary mine site)
const HOME_MINE_2 = `${HOME_PLANET}_n02`; // titanium node (a second mine site)
const HOME_SLOT = `${HOME_PLANET}_s01`;   // settlement slot (no resourceType)

module.exports = { HOME_SYSTEM, HOME_PLANET, HOME_MINE, HOME_MINE_2, HOME_SLOT };
