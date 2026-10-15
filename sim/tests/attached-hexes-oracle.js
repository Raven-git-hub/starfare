'use strict';

// attached-hexes-oracle.js — the slow, obviously-right answer the `deployRange.deepScan` lane is checked
// against (roadmap 2.5, slice 14b; docs/territory-model.md §5 "Painting the range").
//
// The snapshot finds the lane's hexes FAST: it only asks the deploy rule about hexes near the guild's own
// footprints (sim/snapshot.js `attachedHexes`, its "net"). This file asks the SAME rule about EVERY hex in the
// galaxy, with no net at all. It shares no code with the snapshot's net, so if the net ever misses a hex the
// rule accepts, the two lists differ and a test fails. It is far too slow for a live poll, and fine for a test.

const { attachedPlacement } = require('../actions.js');
const { getBoard, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');

let lattice = null;   // every in-bounds hex, built once per test process

// latticeHexes() -> every hex inside the galaxy, as { q, r }. It scans a box of axial coordinates that is
// comfortably bigger than the galaxy disc, and keeps what `isHexInBounds` — the engine's own membership test —
// accepts. The box is worked out from the seed's own `galaxyParams` (a hex's world x is 1.5·hexSize·q, and its
// world y is hexSize·√3·(r + q/2)), with a margin; `latticeIsWhole` below proves it missed nothing.
function latticeHexes() {
  if (lattice) return lattice;
  const { radius, hexSize } = getBoard().galaxyParams;
  const maxQ = Math.ceil(radius / (1.5 * hexSize)) + 1;
  const maxR = Math.ceil(radius / (Math.sqrt(3) * hexSize)) + Math.ceil(maxQ / 2) + 1;
  lattice = [];
  for (let q = -maxQ; q <= maxQ; q += 1) {
    for (let r = -maxR; r <= maxR; r += 1) {
      if (isHexInBounds(q, r)) lattice.push({ q, r });
    }
  }
  return lattice;
}

// latticeIsWhole() -> true when the scan found exactly as many hexes as the seed's generator says the galaxy
// has (`stats.totalHexesInGalaxy`). If the box were ever too small, this is what would say so.
function latticeIsWhole() {
  return latticeHexes().length === getBoard().stats.totalHexesInGalaxy;
}

// attachedByRule(state, guildId) -> [ { q, r } ] — every in-bounds hex with no seed landmark on it that
// `attachedPlacement` accepts for this guild, sorted by q then r. What the lane must equal, exactly.
function attachedByRule(state, guildId) {
  return latticeHexes()
    .filter((hex) => !seedLandmarkAtHex(hex.q, hex.r) && attachedPlacement(state, guildId, hex).ok)
    .sort((a, b) => a.q - b.q || a.r - b.r);
}

module.exports = { latticeHexes, latticeIsWhole, attachedByRule };
