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

// Seed geometry for `controlNear` below (the footprints' centres and radii). Both
// modules are seed-only and never require this one, so there is no require cycle.
const { getSystem, getClaimRadius } = require('./seed.js');
const { hexDistance } = require('./transport.js');

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

// controlNear(state, coords, within) -> every guild CONTROL FOOTPRINT that reaches to within `within` hexes of
// hex `coords`. THE ONE answer to "which guild, if any, controls this hex?" (`within` 0) and to "whose control
// is this hex in or beside?" (`within` 1), so the two questions cannot drift apart (roadmap 2.5 slice 15; the
// Deep Scan Array's placement rule, docs/exploration-model.md §5 REVISED 15-10-26, is its first caller).
//
// Today's footprints (docs/territory-model.md §2):
//   - a held SYSTEM controls every hex within its seed `claimRadius` of its centre, the centre included;
//   - a guild OUTPOST controls only its own hex: radius 0, because it has no aura yet. When the aura radii are
//     ruled, "controlled" grows with them — here, and nowhere else.
// So a hex is within `within` of a footprint exactly when it is within (radius + `within`) of its centre.
//
// Each footprint is { guildId, kind: 'system' | 'outpost', id, anchorSystemId }: a system is its own anchor, an
// Outpost hangs off its stored `anchorSystemId`. Held systems come first, then Outposts, each in id order, so the
// first one a caller picks is stable (invariant 9). Holding is read through `isSystemClaim`, the same match the
// questions above use — never a second notion of holding.
//
// MORE THAN ONE GUILD can come back for a single hex: two held disks may overlap (§2 keeps overlap "as a
// feature"). The seniority rule that would award such a hex to one guild is design-ahead and not built, so this
// hands back every footprint and lets the caller decide.
function controlNear(state, coords, within) {
  const systems = new Map();   // "guild|system" -> footprint: a Map, so a repeated claim row counts once
  for (const c of state.claims || []) {
    if (!isSystemClaim(c)) continue;
    const claimRadius = getClaimRadius(c.landmarkId);
    if (claimRadius === null) {
      // A held system with no footprint radius is a broken seed, not a hex that "happens to be outside" it —
      // HALT rather than quietly answer (design.md §15.5: a silent violation is worse than a crash).
      throw new Error(`hex control: guild ${JSON.stringify(c.ownerGuildId)} holds system ${JSON.stringify(c.landmarkId)}, whose seed row carries no whole-number claimRadius`);
    }
    if (hexDistance(coords, getSystem(c.landmarkId).coords) <= claimRadius + within) {
      systems.set(`${c.ownerGuildId}|${c.landmarkId}`,
        { guildId: c.ownerGuildId, kind: 'system', id: c.landmarkId, anchorSystemId: c.landmarkId });
    }
  }
  const outposts = (state.outposts || [])
    .filter((o) => hexDistance(coords, o.coords) <= within)
    .map((o) => ({ guildId: o.ownerGuildId, kind: 'outpost', id: o.id, anchorSystemId: o.anchorSystemId }));
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...[...systems.values()].sort(byId), ...outposts.sort(byId)];
}

module.exports = { guildHolds, heldSystemIds, systemControllers, controlNear };
