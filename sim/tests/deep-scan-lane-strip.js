'use strict';

// deep-scan-lane-strip.js — slice 14b's STRIP-AND-PROVE helper (roadmap 2.5, the Deep Scan Array acquire half,
// client slice; docs/territory-model.md §5 "Painting the range"). The same discipline as
// installation-quote-strip.js, for 14b's one engine change.
//
// The slice changed no serialized byte. What it DID change is derived on read: every guild row that holds a
// system (or owns an Outpost) gained `deployRange.deepScan = { hexes }`, the hexes a Deep Scan Array may be
// deployed on. A guild's own row survives into its per-guild view (sim/fog.js keeps it whole), so the god's-eye
// lens AND the viewer's own view both moved — by exactly that lane.
//
// Each such golden is still asserted against the hash pinned before this slice, through this strip: take the
// lane back out and the old bytes must come back exactly. That is the proof the lane is the slice's ONLY
// snapshot delta. The lane itself is pinned in tests/deploy-range-deep-scan.test.js.
//
// The strip REFUSES to be vacuous: a guild row with an `outpost` lane holds a system, so it must carry a
// `deepScan` lane too (the ring just outside a held system's control disk always has a free, in-bounds hex). A
// row like that WITHOUT one throws, because a strip that took nothing away would prove nothing. A row with no
// `deployRange` at all (a guild holding nothing, or a rival's fogged row) has nothing to strip and is left alone.

// withoutDeepScanLanes(snap) -> a COPY of a snapshot (or a per-guild view) with `deployRange.deepScan` deleted
// from every guild row — and `deployRange` itself deleted when that leaves it empty, which is the row's
// pre-slice shape (it carried no key when it had no outpost lane). Nothing else is touched, and a copy keeps the
// remaining keys in their order.
function withoutDeepScanLanes(snap) {
  const out = structuredClone(snap);
  for (const row of out.guilds || []) {
    const range = row.deployRange;
    if (!range) continue;
    if (range.outpost && !range.deepScan) {
      throw new Error(`deep-scan-lane-strip: guild row ${JSON.stringify(row.id)} holds a system but carries no deployRange.deepScan — nothing to strip, so it would prove nothing`);
    }
    delete range.deepScan;
    if (Object.keys(range).length === 0) delete row.deployRange;
  }
  return out;
}

module.exports = { withoutDeepScanLanes };
