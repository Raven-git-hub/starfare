'use strict';

// deep-scan-arrays.js — the Deep Scan Array vocabulary: the deterministic id scheme and the per-guild
// mint counter (docs/exploration-model.md §5; roadmap 2.5 (b1)). The outpost mirror is sim/outposts.js.
//
// A Deep Scan Array is a SHARED, single-hex, guild-owned structure. It lives in its own top-level
// list, `state.deepScanArrays`, beside `state.outposts` (NOT folded into it: an array has no stockpile,
// no capacity and no dock, and keeping the lists apart leaves every Outpost row byte-identical). It is
// placed only by a guild's DEPLOY — a heavy carrying a `deep_scan_array_kit` to a bare hex "attached" to
// its own territory (the rule is `deployCheck`, sim/actions.js) — and nothing else mints one.
//
// SCOPE (2.5 (b1)): the array is placed and SITS THERE. It scans nothing yet — the scan job, its queue
// and the reveal are slice (b2); monitoring (the watch fan) is deferred. The entity carries no scan or
// fan fields until a slice reads them (exploration-model.md §5: "dead fields only muddy the
// determinism hash").
//
// Like outposts.js, this file holds RULES and pure SELECTORS and constructs nothing — `createDeepScanArray`
// lives with the other entity constructors in state.js — so it stays free of a require cycle with state.js.

// The id scheme is `deepScanArray_<guildId>_NN`, 1-based and zero-padded to two digits — the exact mirror
// of outposts.js's `outpost_<guildId>_NN`. STABLE and DETERMINISTIC (§15.2, invariant 9): two runs of the
// same scenario mint byte-identical ids. The padding makes lexicographic order agree with numeric order.
function deepScanArrayId(guildId, n) {
  return `deepScanArray_${guildId}_${String(n).padStart(2, '0')}`;
}

// deepScanArrayNumberOf(id) -> the trailing NN minted by `deepScanArrayId`, or null when the id carries
// none. Reads only the last `_NN` group, so a guildId containing an underscore does not confuse it — the
// same parse outpostNumberOf uses.
function deepScanArrayNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextDeepScanArraySerial(guild) -> the next per-GUILD mint serial: one above the guild's stored
// `deepScanArraySerial` (absent/0 -> 1). The array mirror of `nextOutpostSerial`, and STORED for the same
// reason (design.md §15.4 "Ids never repeat"): once an array can be torn down, a `max(live) + 1`
// derivation would re-hand its number. Nothing removes an array this slice, but the counter costs nothing
// now and saves a migration later. The CALLER bumps `guild.deepScanArraySerial` at mint (this stays a pure
// read); it never decrements.
function nextDeepScanArraySerial(guild) {
  return (guild.deepScanArraySerial || 0) + 1;
}

module.exports = {
  deepScanArrayId,
  deepScanArrayNumberOf,
  nextDeepScanArraySerial,
};
