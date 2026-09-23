'use strict';

// routes.js — the automation layer's ROUTE vocabulary (transport-model.md §11; roadmap 2.2 automation).
// (Not the HTTP routes in sim/server.js — a "route" here is a craft's ordered list of waypoints.)
//
// It holds two small things several modules share, and constructs nothing:
//   - `copyRouteWaypoint` — THE ONE spelling of the { anchor, action? } waypoint copy (§11.1). It lives
//     here, not in actions.js, so state.js's `createSavedRoute` can deep-copy a saved route's waypoints
//     without requiring actions.js (which requires state.js — that would be a cycle).
//   - the SAVED-ROUTE id scheme + per-guild mint serial (§11.9) — the exact mirror of sim/outposts.js's
//     `outpostId` / `outpostNumberOf` / `nextOutpostSerial`, and for the same reason: a saved route can
//     be DELETED, so its number must come from a stored counter, never from the live rows.

const { copyManifestLine } = require('./manifest.js');

// copyRouteWaypoint(wp) -> a FRESH copy of a { anchor, action? } route waypoint (transport-model.md
// §11.1) — the anchor object copied, and any action's manifest lines copied in canonical shape
// (copyManifestLine), so a stored/snapshotted route can never alias the caller's arrays. Shared by the
// actioned-route dispatch (journalling the route onto the craft), the saved-route store (createSavedRoute)
// and the snapshot (surfacing both). Omit-when-absent: a no-action waypoint carries no `action` key,
// exactly as it was authored.
function copyRouteWaypoint(wp) {
  const copy = { anchor: { ...wp.anchor } };
  if (wp.action) {
    copy.action = { type: wp.action.type, manifest: wp.action.manifest.map(copyManifestLine) };
  }
  return copy;
}

// The saved-route id scheme is `route_<guildId>_NN`, 1-based and zero-padded to two digits — the exact
// mirror of outposts.js's `outpost_<guildId>_NN` (no new number: the same padding). STABLE and
// DETERMINISTIC (§15.2, invariant 9): two runs of the same scenario mint byte-identical ids.
function savedRouteId(guildId, n) {
  return `route_${guildId}_${String(n).padStart(2, '0')}`;
}

// savedRouteNumberOf(id) -> the trailing numeric suffix minted by `savedRouteId` (the integer NN), or
// null when the id carries none. Reads only the last `_NN` group, so a guildId containing an underscore
// does not confuse it — the same parse outpostNumberOf / vehicleNumberOf use.
function savedRouteNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextSavedRouteSerial(guild) -> the next per-GUILD mint serial: one above the guild's stored
// `savedRouteSerial` (absent/0 -> 1). The CALLER bumps `guild.savedRouteSerial` to this value when it
// mints (this stays a pure read). It only ever increments — never on delete, never on an upsert that
// updates an existing route in place — so a deleted route's id is never reissued (§11.9, design.md
// §15.2 "Every ID is stable and unique, never reused").
function nextSavedRouteSerial(guild) {
  return (guild.savedRouteSerial || 0) + 1;
}

module.exports = {
  copyRouteWaypoint,
  savedRouteId,
  savedRouteNumberOf,
  nextSavedRouteSerial,
};
