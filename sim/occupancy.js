'use strict';

// occupancy.js — "what is on this site?" derived from live state, never
// stored on the site. This is design.md §15's rule made concrete: an occupant
// stores its own location; occupancy is a LOOKUP over the occupants, so the
// same fact never lives in two places and can't drift. The seed node/slot is
// static and knows nothing about who sits on it; this map is rebuilt from
// live state whenever anyone asks.
//
// TWO KINDS OF OCCUPANT (design.md §2 "The Prefecture", 29-09-26; roadmap 2.5, the
// Prefecture / claims slice):
//   - a VENTURE, by its `siteId` — a node or a settlement slot;
//   - a planted PREFECTURE, by its `slotId` — always a settlement slot. It is the first
//     NON-VENTURE occupant: it produces nothing, holds no licence and earns no RP, but it
//     takes the slot all the same, so no factory may be established on top of it.
// Both readers below walk the same two lists in the same order (ventures first), so the
// map and the single-site question can never disagree.

// computeOccupancy(state) -> { <siteId>: <occupantId> } for every seated venture and every
// planted Prefecture. The value is the occupant's id: a venture id, or a Prefecture id
// (`prefecture_<guild>_NN`, sim/prefectures.js) — the two id schemes never collide. A galaxy
// with no Prefecture gives exactly the venture-only map it always gave.
// If two occupants somehow claim the same site, last-writer-wins here — but that is a
// corruption the occupancy invariants (invariants.js) catch and halt on; this selector just
// reports, it does not police.
function computeOccupancy(state) {
  const bySite = {};
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.siteId) bySite[v.siteId] = v.id;
    }
  }
  for (const p of state.prefectures || []) bySite[p.slotId] = p.id;
  return bySite;
}

// siteOccupantOf(state, siteId) -> { kind: 'venture' | 'prefecture', id } for the FIRST
// occupant of `siteId` (ventures first, in guild then venture order), or null when the
// site is free. THE ONE "is this site free?" question every seating asks — the three
// venture establishes and the Prefecture plant (sim/actions.js `siteOccupiedReason`) — so
// a slot a Prefecture holds is refused to a factory, and the reverse, by one rule.
function siteOccupantOf(state, siteId) {
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.siteId === siteId) return { kind: 'venture', id: v.id };
    }
  }
  for (const p of state.prefectures || []) {
    if (p.slotId === siteId) return { kind: 'prefecture', id: p.id };
  }
  return null;
}

module.exports = { computeOccupancy, siteOccupantOf };
