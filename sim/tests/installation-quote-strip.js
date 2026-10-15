'use strict';

// installation-quote-strip.js — the installation-kit acquire slice's STRIP-AND-PROVE helper (roadmap 2.5,
// the Deep Scan Array acquire half; docs/asset-purchase.md §"Installation kits", RULED 15-10-26).
//
// The slice changed no serialized byte: a galaxy that never builds or buys an installation saves exactly
// what it did before. What it DID change is derived on read. The snapshot's `assetPurchaseQuote` — the
// Syndicate's sell catalog, a PUBLIC block (sim/fog.js), so every god's-eye snapshot AND every per-guild
// view carries it — gained two rows, `deep_scan_array` and `outpost`. Every golden that hashes a snapshot
// or a view therefore moved by exactly those two rows.
//
// Each such golden is still asserted against the hash pinned before this slice, through this strip: take
// the two rows back out and the old bytes must come back exactly. That is the proof the two rows are the
// slice's ONLY snapshot delta. The rows themselves are pinned in tests/installation-kit-acquire.test.js.
//
// The strip REFUSES to remove nothing — a snapshot missing either row throws — because a strip that took
// nothing away would prove nothing.

const { DEEP_SCAN_ARRAY, OUTPOST } = require('../asset-recipes.js');

const NEW_QUOTE_ROWS = [DEEP_SCAN_ARRAY, OUTPOST];

// withoutInstallationQuotes(snap) -> a COPY of a snapshot (or a per-guild view) with the two installation
// rows deleted from `assetPurchaseQuote`. Nothing else is touched, and a copy keeps the remaining keys in
// their order, so the block is the five-kind block it used to serialize as.
function withoutInstallationQuotes(snap) {
  const quote = snap && snap.assetPurchaseQuote;
  const missing = NEW_QUOTE_ROWS.filter((kind) => !quote || !(kind in quote));
  if (missing.length > 0) {
    throw new Error(`installation-quote-strip: the snapshot has no assetPurchaseQuote row for ${missing.join(', ')} — nothing to strip, so it would prove nothing`);
  }
  const out = structuredClone(snap);
  for (const kind of NEW_QUOTE_ROWS) delete out.assetPurchaseQuote[kind];
  return out;
}

module.exports = { withoutInstallationQuotes, NEW_QUOTE_ROWS };
