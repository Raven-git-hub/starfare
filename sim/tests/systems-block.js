'use strict';

// systems-block.js — the L0-board slice's PUT-BACK-AND-PROVE helper (roadmap 2.5, the L0-board engine slice —
// ruling 12 slice 2; docs/exploration-model.md §4 ruling 12, §7).
//
// The slice REMOVED one thing from the per-guild view: `geography.systems`, the L0 row for every system that
// slice 1 rebuilt on every view — { id, name, coords, planetCount, controllerGuildId }. Every view golden
// pinned before the slice is still asserted, through `withSystemsBlock`: put the block back and the old bytes
// must come back exactly. That is the proof the removal is the slice's ONLY delta.
//
// The block is rebuilt from exactly two things, and nothing else:
//   - the BOARD (`getBoard`) — the static half: id, name, coords, and planetCount = planets.length;
//   - the view's own CLAIMS — the live half: who controls each system.
// So if the old bytes come back, nothing the old block carried is lost to a client that holds the board
// and polls the slim view. Its shape is copied from sim/fog.js `geographyFor` at 348e0fc (just before the
// slice). Test-only: nothing in sim/ calls it.

const { getBoard } = require('../seed.js');

// controllersFromClaims(view) -> Map systemId -> the guild holding it, read off a view's `claims` exactly the
// way sim/claims.js `systemControllers` reads `state.claims`: system claims only, the first row for a system
// wins. The per-guild view keeps every claim row (ownership is public), so this is the whole answer.
function controllersFromClaims(view) {
  const out = new Map();
  for (const c of view.claims) {
    if (c.landmarkKind === 'system' && !out.has(c.landmarkId)) out.set(c.landmarkId, c.ownerGuildId);
  }
  return out;
}

// legacySystemsBlock(view) -> slice 1's `geography.systems` for this view, rebuilt from the board + its claims.
function legacySystemsBlock(view) {
  const controllers = controllersFromClaims(view);
  return getBoard().map((b) => ({
    id: b.id,
    name: b.name,
    coords: { q: b.coords.q, r: b.coords.r },
    planetCount: b.planets.length,
    controllerGuildId: controllers.get(b.id) || null,
  }));
}

// withSystemsBlock(view) -> a COPY of a slim per-guild view with `geography` put back to slice 1's
// `{ systems, known }` — in that key order, so the bytes can match. A view that still HAS a systems block
// throws: there is nothing to put back, and a silent overwrite would let a broken slim pass.
function withSystemsBlock(view) {
  if ('systems' in view.geography) throw new Error('withSystemsBlock: this view still has geography.systems');
  const out = structuredClone(view);
  out.geography = { systems: legacySystemsBlock(view), known: out.geography.known };
  return out;
}

module.exports = { controllersFromClaims, legacySystemsBlock, withSystemsBlock };
