'use strict';

// routes.js — the automation layer's ROUTE vocabulary (transport-model.md §11; roadmap 2.2 automation).
// (Not the HTTP routes in sim/server.js — a "route" here is a craft's ordered list of waypoints.)
//
// It holds a few small things several modules share, and constructs nothing:
//   - `copyRouteWaypoint` — THE ONE spelling of the { anchor, action? } waypoint copy (§11.1). It lives
//     here, not in actions.js, so state.js's `createSavedRoute` can deep-copy a saved route's waypoints
//     without requiring actions.js (which requires state.js — that would be a cycle).
//   - the SAVED-ROUTE id scheme + per-guild mint serial (§11.9) — the exact mirror of sim/outposts.js's
//     `outpostId` / `outpostNumberOf` / `nextOutpostSerial`, and for the same reason: a saved route can
//     be DELETED, so its number must come from a stored counter, never from the live rows.
//   - the REPEAT vocabulary (§11.10) — the three launch modes, shared by the dispatch validate and the
//     route integrity check so the two can never disagree about which modes exist — the reasons a
//     lane can END, which the craft's `laneEnded` flag names, and the reasons a lane can WAIT.

const { copyManifestLine } = require('./manifest.js');

// REPEAT_MODES — the three LAUNCH modes a `dispatchRouteWithActions` can choose (transport-model.md
// §11.10): `once` runs the waypoints and lands idle at the last one (the built one-shot); `continuous`
// repeats the cycle until the player stops it or the lane ends; `nRun` repeats it for N full cycles.
// A mode is a launch parameter, never stored on a saved route (§11.5). On a craft's journalled `route`,
// `once` is the DEFAULT and is never written (omit-when-default), so a one-shot route stays
// byte-identical to the pre-repeat one; only `continuous` / `nRun` ever appear there.
const REPEAT_MODES = Object.freeze(['once', 'continuous', 'nRun']);

// CADENCES — how SOON a repeating lane starts its next lap (transport-model.md §11.10, a second launch
// parameter beside the mode). `immediate` starts the next lap the moment the last one finishes (back to
// back); `perCycle` holds at the last waypoint between laps and starts the next lap at the next fuel-cycle
// boundary, so the lane runs at most one lap per fuel cycle. Like the mode, it is chosen at launch and never
// stored on a saved route. On a craft's `route`, `immediate` is the DEFAULT and is never written
// (omit-when-default), so a lane launched without a cadence is byte-identical to a slice-3a lane; only
// `perCycle` ever appears there. A `once` run has no cadence at all — it has no next lap to pace.
const CADENCES = Object.freeze(['immediate', 'perCycle']);

// LANE_END_REASONS — why a lane ENDED on its own (transport-model.md §11.6), recorded on the craft as
// `laneEnded = { reason, tick }` so the player can see it. One reason today: 'target-gone' — a stop's
// store no longer exists (an Outpost torn down). A lane that simply finishes, or that the player stops,
// is not flagged: nothing went wrong.
const LANE_END_REASONS = Object.freeze(['target-gone']);

// WAIT_REASONS — why a repeating lane is WAITING at its last waypoint instead of starting its next lap,
// recorded on the route as `waiting = { reason, sinceTick }` (transport-model.md §11.6 / §11.10). Two
// reasons, and the fuel-cycle boundary re-attempts BOTH the same way (a fresh try at the next lap):
//   'fuel'    — the hoard cannot cover the next lap up front, so the lane waits (burning nothing) and
//               re-attempts at each fuel-cycle boundary until it can pay;
//   'cadence' — a `perCycle` lane between laps (slice 3a.1): it holds until the next boundary on purpose,
//               so it runs at most one lap per fuel cycle.
const WAIT_REASONS = Object.freeze(['fuel', 'cadence']);

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
  REPEAT_MODES,
  CADENCES,
  LANE_END_REASONS,
  WAIT_REASONS,
  copyRouteWaypoint,
  savedRouteId,
  savedRouteNumberOf,
  nextSavedRouteSerial,
};
