'use strict';

// prefectures.js — the Prefecture vocabulary: the kit kind, the deterministic id scheme for the
// Prefecture and for the claim row it writes, and the per-guild mint counter (design.md §2 "The
// Prefecture"; docs/territory-model.md §4; roadmap 2.5, the Prefecture / claims slice, engine PR 1).
// The outpost mirror is sim/outposts.js, the array mirror sim/deep-scan-arrays.js.
//
// A Prefecture is the TERRITORIAL CLAIM ANCHOR: a guild structure planted on one SETTLEMENT SLOT, and
// one anywhere in a system claims the whole system. It lives in its own top-level list,
// `state.prefectures`, beside `state.outposts` and `state.deepScanArrays`. It is made in two steps
// (territory-model.md §4, "the two-step ground flow"):
//   1. the FERRY — a `prefecture` kit is loaded onto a heavy, flown, and unloaded into a system's idle
//      list. That system may be one the guild does NOT hold (the one exception to the unload's held-system
//      gate), but never one a rival holds (sim/actions.js `unloadKitCheck`);
//   2. the PLANT — `plantPrefecture` (sim/actions.js) consumes the idle kit, mints the Prefecture row here
//      described, and writes the one `landmarkKind: 'system'` claim row. That claim row is what every
//      "does guild G hold system S?" question reads (sim/claims.js); the Prefecture is what makes it.
//
// Like outposts.js, this file constructs no entity — `createPrefecture` lives with the other entity
// constructors in state.js — so it stays free of a require cycle with state.js. It holds RULES only.

// PREFECTURE_KIT_KIND — the kit kind of a Prefecture (its DEPLOYABLE_KITS key, sim/resources.js; the bill
// kind `prefecture` finishes as it, sim/asset-recipes.js KIT_KIND_FOR_BILL). It is the one GROUND kit:
// it is never deployed on a hex (the space lane, `deployCheck`), it is PLANTED on a slot. Spelled here
// once so the deploy rule, the unload rule and the plant all read the same name.
const PREFECTURE_KIT_KIND = 'prefecture';

// The id scheme is `prefecture_<guildId>_NN`, 1-based and zero-padded to two digits — the exact mirror of
// `outpost_<guildId>_NN`. STABLE and DETERMINISTIC (§15.2, invariant 9): two runs of the same scenario
// mint byte-identical ids. The padding makes lexicographic order agree with numeric order.
function prefectureId(guildId, n) {
  return `prefecture_${guildId}_${String(n).padStart(2, '0')}`;
}

// prefectureClaimId(guildId, n) -> the id of the claim row the guild's Prefecture number `n` writes:
// `claim_prefecture_<guildId>_NN`. It shares the Prefecture's own serial, so ONE stored counter numbers
// both and they can never drift apart; a Prefecture and its claim read as a pair (`..._<guild>_NN`).
// It never collides with a founding claim (`claim_home_<guildId>`, sim/actions.js foundGuild), and
// because the serial never goes back, a claim id is never reissued — not even after a future teardown
// and re-plant (design.md §15.4 "Ids never repeat"). NOTE for the seniority map (territory-model.md §2,
// engine PR 2): its tie-break is "the lower `claimId`", and under this scheme a home claim sorts below
// every Prefecture claim ('h' < 'p'). On the decision checklist, not decided here.
function prefectureClaimId(guildId, n) {
  return `claim_${prefectureId(guildId, n)}`;
}

// prefectureNumberOf(id) -> the trailing NN minted by `prefectureId`, or null when the id carries none.
// Reads only the last `_NN` group, so a guildId containing an underscore does not confuse it — the same
// parse outpostNumberOf uses.
function prefectureNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextPrefectureSerial(guild) -> the next per-GUILD mint serial: one above the guild's stored
// `prefectureSerial` (absent/0 -> 1). STORED, like `outpostSerial`, for the same reason (design.md §15.4
// "Ids never repeat"): once teardown exists (§19 #67, deferred), a `max(live) + 1` derivation would
// re-hand a removed Prefecture's number — and its claim's. The CALLER bumps `guild.prefectureSerial` at
// the plant (this stays a pure read); it never decrements.
function nextPrefectureSerial(guild) {
  return (guild.prefectureSerial || 0) + 1;
}

module.exports = {
  PREFECTURE_KIT_KIND,
  prefectureId,
  prefectureClaimId,
  prefectureNumberOf,
  nextPrefectureSerial,
};
