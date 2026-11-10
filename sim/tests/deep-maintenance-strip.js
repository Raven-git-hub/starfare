'use strict';

// deep-maintenance-strip.js — maintenance slice 4's STRIP-AND-PROVE helper (roadmap 2.6 maintenance; docs/maintenance.md
// §4; the droid-batch-quote-strip.js pattern).
//
// The slice changed no serialized byte for a galaxy where no craft reaches 0% and nobody starts deep maintenance. What
// it DID change is derived on read: the snapshot gained two keys —
//   - `earlyMaintenanceAllowed` inside every vehicle row's `craftMaintenance` block (whether the early action would be
//     accepted now — the slice-6 button reads it), and
//   - `maintenance` on every Outpost row the viewer owns (its bays and queue; a rival's row is allow-listed, sim/fog.js).
// So every golden that hashes a snapshot or a view holding a craft or an own Outpost moved by exactly those keys.
//
// Each such golden is still asserted against the hash pinned before this slice, through this strip: take the two keys
// back out and the old bytes must come back exactly. That is the proof they are the slice's ONLY snapshot delta. The
// keys themselves are pinned in tests/deep-maintenance.test.js. `deepMaintenance` (present only while a craft IS in
// maintenance) is deliberately NOT stripped: a golden carrying it has really changed, and must fail.

function withoutDeepMaintenanceReadout(snap) {
  const out = structuredClone(snap);
  for (const g of out.guilds || []) {
    for (const v of g.vehicles || []) {
      if (v.craftMaintenance) delete v.craftMaintenance.earlyMaintenanceAllowed;
    }
  }
  for (const o of out.outposts || []) delete o.maintenance;
  return out;
}

module.exports = { withoutDeepMaintenanceReadout };
