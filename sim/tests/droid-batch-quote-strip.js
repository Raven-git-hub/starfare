'use strict';

// droid-batch-quote-strip.js — the Syndicate droid batch-buy slice's STRIP-AND-PROVE helper (roadmap 2.6;
// docs/droids.md §3, RE-RULED 07-11-26). The installation-quote-strip.js pattern.
//
// The slice changed no serialized byte for a galaxy that never buys a droid batch. What it DID change is derived
// on read: the snapshot gained ONE public top-level block, `droidBatchQuote` (sim/fog.js passes it to every
// per-guild view too). So every golden that hashes a snapshot or a view moved by exactly that block.
//
// Each such golden is still asserted against the hash pinned before this slice, through this strip: take the
// block back out and the old bytes must come back exactly. That is the proof the block is the slice's ONLY
// snapshot delta. The block itself is pinned in tests/droid-batch-buy.test.js.
//
// The strip REFUSES to remove nothing — a snapshot without the block throws — because a strip that took nothing
// away would prove nothing.

function withoutDroidBatchQuote(snap) {
  if (!snap || !('droidBatchQuote' in snap)) {
    throw new Error('droid-batch-quote-strip: the snapshot has no droidBatchQuote — nothing to strip, so it would prove nothing');
  }
  const out = structuredClone(snap);
  delete out.droidBatchQuote;
  return out;
}

module.exports = { withoutDroidBatchQuote };
