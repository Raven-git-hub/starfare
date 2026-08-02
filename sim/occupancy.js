'use strict';

// occupancy.js — "what venture is on this site?" derived from live state, never
// stored on the site. This is design.md §15's rule made concrete: a venture
// stores its own location (siteId); occupancy is a LOOKUP over ventures, so the
// same fact never lives in two places and can't drift. The seed node/slot is
// static and knows nothing about who sits on it; this map is rebuilt from the
// ventures whenever anyone asks.

// computeOccupancy(state) -> { <siteId>: <ventureId> } for every seated venture.
// If two ventures somehow claim the same site, last-writer-wins here — but that
// is a corruption the occupancy invariant (invariants.js) catches and halts on;
// this selector just reports, it does not police.
function computeOccupancy(state) {
  const bySite = {};
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.siteId) bySite[v.siteId] = v.id;
    }
  }
  return bySite;
}

module.exports = { computeOccupancy };
