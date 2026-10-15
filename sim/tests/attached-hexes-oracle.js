'use strict';

// attached-hexes-oracle.js — the slow, obviously-right answer the `deployRange.deepScan` lane is checked
// against (roadmap 2.5, slice 14b; REWRITTEN slice 15; the centre added slice 16; docs/territory-model.md §5
// "Painting the range"; docs/exploration-model.md §5 "Deploy placement", REVISED and AMENDED 15-10-26).
//
// The snapshot finds the lane's hexes FAST: it only asks the deploy rule about hexes near the guild's own
// footprints (sim/snapshot.js `attachedHexes`, its "net"), and the rule itself asks the one control helper
// (sim/claims.js `controlNear`). This file shares NEITHER. It writes the ruled placement out again, in its own
// words, and asks it of EVERY hex in the galaxy, with no net at all:
//
//   a hex is legal for guild G when no RIVAL controls it, and EITHER G controls it, OR nobody controls it and
//   one of its six neighbours is a hex G controls.
//   "Controls": a held system controls every hex within its claimRadius of its centre; an Outpost controls
//   its own hex (no aura yet).
//   A hex with a SEED LANDMARK on it is legal only when it is the centre of a system G ITSELF holds (and, as
//   for any hex, no rival controls it) — the one exception (AMENDED 15-10-26, slice 16). A waystation, the
//   Citadel, a system nobody holds and a rival's system are never legal.
//
// It reads only the seed data and the state rows, and spells out its own hex distance and neighbours. So if
// the net misses a hex, or the helper and the rule ever drift from the ruling, the lists differ and a test
// fails. It is far too slow for a live poll, and fine for a test.

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

// The oracle's own hex geometry — deliberately NOT sim/transport.js's: axial distance is the cube distance,
// and a hex's six neighbours are the six axial unit steps.
const distance = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const STEPS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const neighbours = (h) => STEPS.map(([dq, dr]) => ({ q: h.q + dq, r: h.r + dr }));

// footprintsOf(state) -> every control footprint in the galaxy as { guildId, centre, radius }: one per system
// claim row (its seed centre and claimRadius, read straight off the seed board), one per guild Outpost (its own
// hex, radius 0).
function footprintsOf(state) {
  const systems = new Map(getBoard().systems.map((s) => [s.id, s]));
  const held = (state.claims || [])
    .filter((c) => c.landmarkKind === 'system')
    .map((c) => ({ guildId: c.ownerGuildId, centre: systems.get(c.landmarkId).coords, radius: systems.get(c.landmarkId).claimRadius }));
  const outposts = (state.outposts || []).map((o) => ({ guildId: o.ownerGuildId, centre: o.coords, radius: 0 }));
  return [...held, ...outposts];
}

// attachedByRule(state, guildId) -> [ { q, r } ] — every in-bounds hex the RULED placement (above) accepts for
// this guild — a bare hex, or the centre of a system it holds — sorted by q then r. What the lane must equal,
// exactly.
function attachedByRule(state, guildId) {
  const footprints = footprintsOf(state);
  // The systems THIS guild holds, read straight off its claim rows.
  const heldByGuild = new Set((state.claims || [])
    .filter((c) => c.landmarkKind === 'system' && c.ownerGuildId === guildId)
    .map((c) => c.landmarkId));
  const isGround = (hex) => {
    const landmark = seedLandmarkAtHex(hex.q, hex.r);
    return !landmark || (landmark.kind === 'system' && heldByGuild.has(landmark.id));
  };
  const controllers = (hex) => footprints.filter((f) => distance(hex, f.centre) <= f.radius).map((f) => f.guildId);
  const legal = (hex) => {
    const here = controllers(hex);
    if (here.some((g) => g !== guildId)) return false;   // inside a rival's control: never
    if (here.includes(guildId)) return true;             // inside the guild's own control
    return neighbours(hex).some((n) => controllers(n).includes(guildId));   // nobody's, beside the guild's own
  };
  return latticeHexes()
    .filter((hex) => isGround(hex) && legal(hex))
    .sort((a, b) => a.q - b.q || a.r - b.r);
}

module.exports = { latticeHexes, latticeIsWhole, attachedByRule };
