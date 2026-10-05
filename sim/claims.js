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

// The ONE match expression the two questions below share, so they are literally the
// same question rather than two spellings of it that could drift apart.
// `landmarkKind` is part of the match for the same reason getLandmark demands it:
// an outpost id must never resolve as a system by luck.
const isSystemClaim = (c) => c.landmarkKind === 'system';
const isSystemClaimFor = (c, guildId) => c.ownerGuildId === guildId && isSystemClaim(c);

// guildHolds(state, guildId, systemId) -> boolean. A claim on that exact system,
// of kind 'system', owned by that guild.
function guildHolds(state, guildId, systemId) {
  return (state.claims || []).some((c) => isSystemClaimFor(c, guildId) && c.landmarkId === systemId);
}

// heldSystemIds(state, guildId) -> the systems that guild holds, sorted, no repeats.
//
// The PLURAL of `guildHolds`, and deliberately built on the same predicate: a
// caller that wants "which systems?" must not answer it by a second, differently
// spelled reading of `state.claims`, or the list and the check could disagree —
// exactly the drift this module's header exists to prevent. `heldSystemIds(...)
// .includes(x)` and `guildHolds(..., x)` are true together, always.
//
// SORTED and DEDUPED at the source. Sorted because a consumer emitting these into
// the snapshot needs stable bytes (invariant 9) and should not have to remember to
// sort; deduped because nothing structurally forbids two claim rows on one system,
// and a repeat would silently double a keyed map's work. Claim ids are ASCII, so
// `localeCompare` and byte order agree.
function heldSystemIds(state, guildId) {
  const ids = new Set();
  for (const c of state.claims || []) {
    if (isSystemClaimFor(c, guildId)) ids.add(c.landmarkId);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// systemControllers(state) -> Map systemId -> the guild id holding it. The L0 "controlling
// guild" fact (docs/exploration-model.md §1 — never fogged, every system) for the whole galaxy at
// once, so the per-guild view does not ask `guildHolds` 1,500 × guilds times. Built on the SAME
// `isSystemClaim` test as the two questions above, so `systemControllers(s).get(x) === g` and
// `guildHolds(s, g, x)` agree. A system with no system claim is simply absent (unclaimed).
// If two claim rows ever named one system, the FIRST in `state.claims` order would answer —
// deterministic (invariant 9); nothing builds that today (founding refuses an already-claimed home).
function systemControllers(state) {
  const out = new Map();
  for (const c of state.claims || []) {
    if (isSystemClaim(c) && !out.has(c.landmarkId)) out.set(c.landmarkId, c.ownerGuildId);
  }
  return out;
}

module.exports = { guildHolds, heldSystemIds, systemControllers };
