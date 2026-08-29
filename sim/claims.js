'use strict';

// claims.js — the accessor layer over the SHARED territory rows (`state.claims`,
// design.md §15.1 / §15.4). One row is
//     { claimId, ownerGuildId, landmarkId, landmarkKind, claimedAtTick, contested }
// and it is the SOURCE OF TRUTH for who holds what (foundGuild pushes one; the
// guild-home invariant checks the denormalised `homeSystemId` against it, never
// the other way round).
//
// It exists so ONE predicate answers "does this guild hold this system?" for
// every caller. The BUY side needs that question twice — once when the purchase
// is validated (you may only buy into a system you hold) and once at the arrival
// tick (if it now answers false, the cargo is lost, §6) — and those two must be
// the SAME question, or a delivery could be legal to schedule and impossible to
// land, or vice versa.

// guildHolds(state, guildId, systemId) -> boolean. A claim on that exact system,
// of kind 'system', owned by that guild. `landmarkKind` is part of the match for
// the same reason getLandmark demands it: an outpost id must never resolve as a
// system by luck.
function guildHolds(state, guildId, systemId) {
  return (state.claims || []).some((c) => (
    c.ownerGuildId === guildId
    && c.landmarkKind === 'system'
    && c.landmarkId === systemId
  ));
}

module.exports = { guildHolds };
