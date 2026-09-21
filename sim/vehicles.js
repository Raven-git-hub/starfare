'use strict';

// vehicles.js — the guild-transport vocabulary and the deterministic id scheme
// (design.md §15.4 "Vehicle", §6; roadmap 2.2-foundation, engine slice (a)). A
// Vehicle is an ownable guild craft — built by a dockyard or bought from the
// Syndicate exactly as a ground Asset is (the buy/build machinery is kind-general)
// — minted IDLE into `guild.vehicles`. This file is the vehicle mirror of
// sim/assets.js: it holds the RULES (the four classes, the buildable list, the id
// scheme, the per-class stat table) and pure SELECTORS over a guild. It constructs
// nothing — `createVehicle` lives with the other entity constructors in state.js —
// which keeps this file free of a require cycle with state.js, exactly as assets.js is.
//
// SCOPE: buy + build + operator/Storyteller spawn/remove, all minted idle. Nothing
// MOVES a vehicle yet (dispatch/routes are slice b), so `capacity`/`defenseRating` are
// carried but read by nothing, and `speed`/`fuelCostToRun` are read only by the delivery
// flight of a Syndicate BUY (sim/actions.js + sim/tick.js). This slice (2.2 spawn) adds
// the LOCATION model (a landmark-or-hex idle position, generalising the shipped system-
// only `systemId`) and the per-guild MINT COUNTER that makes a removed id un-reissuable.

const { getLandmark, isHexInBounds } = require('./seed.js');

// The four classes. The strings are camelCase — the exact spelling design.md §15.4
// and docs/phase-1-tuning.md §"Guild transports" use — pinned here once so no other
// file spells them.
const LIGHT_TRANSPORT = 'lightTransport';
const MEDIUM_TRANSPORT = 'mediumTransport';
const HEAVY_TRANSPORT = 'heavyTransport';
const SPYCRAFT = 'spycraft';

// Every class, in a stable order. Used by the integrity invariant to test a known
// class and by the snapshot's purchase quote to enumerate the buyable classes.
const VEHICLE_CLASSES = Object.freeze([LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT]);

// The classes a guild can build (dockyard) or buy (Syndicate) this slice — all four.
// The vehicle analogue of BUILDABLE_ASSET_KINDS (sim/asset-recipes.js); named
// separately so the ground-asset list stays exactly [miner, factory].
const BUILDABLE_VEHICLE_KINDS = Object.freeze([LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT]);

// The legal stored `status` values (design.md §15.4 "status (idle / in-transit)", extended by the
// Outpost dock model, §4). `idle` (parked at a berth, or waiting in an Outpost queue — both
// re-dispatchable) and `inTransit` (flying a frozen route) are the design's pair; `loading` is the
// third, distinct state a craft holds ONLY while it occupies an Outpost DOCK SLOT (2.2 cargo engine
// slice 2). It is what makes `dispatchVehicle`'s idle gate refuse a craft mid-turnaround ("a craft in
// a slot runs to completion", §4) while a parked/queued craft stays plain `idle` and dispatches freely.
// `checkVehicleIntegrity` asserts membership; the shape-by-status rule treats `loading` like `idle`
// (a resolving location, no trip) since a docked craft sits at the Outpost's hex.
const VEHICLE_STATUSES = Object.freeze(['idle', 'inTransit', 'loading']);

// The per-class stat table — every value read VERBATIM from docs/phase-1-tuning.md
// §"Guild transports" (18-09-26, all `[FIRST-CUT]`); NONE invented here (§18 /
// CLAUDE.md "Never invent a number"). Frozen so no reader can mutate a stat at runtime.
//
//   speed         — ticks per hex, LOWER is faster (the same unit as CRAFT_SPEED = 150).
//                   spycraft's 26.25 is the exact 105 ÷ 4; the float is fine — the
//                   arrival maths is `tick + ceil(distance × speed)` (sim/tick.js).
//   capacity      — cargo SPACE (Σ qty × volumeOf). spycraft is EXACTLY 0 (carries no
//                   cargo); read by nothing this slice.
//   fuelCostToRun — the craft's OWN per-hex burn (per-craft now; only Light coincides
//                   with the Syndicate light hauler's 0.5). The delivery flight of a
//                   Syndicate BUY burns this × hexDistance up front (sim/actions.js).
//   defenseRating — inert until combat exists (placeholder); read by nothing.
const VEHICLE_SPECS = Object.freeze({
  [LIGHT_TRANSPORT]: Object.freeze({ speed: 105, capacity: 10000, fuelCostToRun: 0.5, defenseRating: 10 }),
  [MEDIUM_TRANSPORT]: Object.freeze({ speed: 150, capacity: 50000, fuelCostToRun: 1.0, defenseRating: 20 }),
  [HEAVY_TRANSPORT]: Object.freeze({ speed: 225, capacity: 6000000, fuelCostToRun: 100.0, defenseRating: 40 }),
  [SPYCRAFT]: Object.freeze({ speed: 26.25, capacity: 0, fuelCostToRun: 20.0, defenseRating: 5 }),
});

function isVehicleClass(kind) {
  return VEHICLE_CLASSES.includes(kind);
}

// vehicleSpec(class) -> the frozen per-class stat table, or null for an unknown class.
// null (not a throw) so a caller can ASK whether a class is a real vehicle and refuse
// loudly itself, the same shape `assetBill`/`getRecipe` have.
function vehicleSpec(vehicleClass) {
  return VEHICLE_SPECS[vehicleClass] || null;
}

// The id scheme is `vehicle_<guildId>_<class>_NN`, 1-based and zero-padded to two
// digits — the exact mirror of assets.js's `asset_<guildId>_<kind>_NN`. STABLE and
// DETERMINISTIC (§15.2, invariant 9): two runs of the same scenario mint byte-identical
// ids. The padding makes lexicographic order agree with numeric order.
function vehicleId(guildId, vehicleClass, n) {
  return `vehicle_${guildId}_${vehicleClass}_${String(n).padStart(2, '0')}`;
}

// vehicleNumberOf(id) -> the trailing numeric suffix minted by `vehicleId` (the integer
// NN), or null when the id carries none. Reads only the last `_NN` group, so a guildId
// containing an underscore does not confuse it — the same parse assetNumberOf uses.
function vehicleNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextVehicleSerial(guild) -> the next per-GUILD mint serial: one above the guild's stored
// `vehicleSerial` counter (absent/0 -> 1). REPLACES the old `max(existing suffix)+1`
// derivation, which removal broke: a removed craft's id must never be reissued (design.md
// §15.4 "Ids never repeat"), so the number cannot be re-derived from the LIVE vehicles —
// once the highest is removed, max+1 would hand its number to the next mint. The counter is
// STORED, monotonic and guild-wide (spanning classes: `…_light_01`, `…_heavy_02`,
// `…_light_03`), the justified stored-counter exception `guild.guildReputation` already
// makes. The CALLER bumps `guild.vehicleSerial` to this value at mint (this stays a pure
// read, the pure-selectors discipline the rest of this file keeps); it only ever increments
// and never decrements on removal, so an id is unique across the guild's whole history.
function nextVehicleSerial(guild) {
  return (guild.vehicleSerial || 0) + 1;
}

// resolveVehicleLocation(location) -> { form: 'landmark' | 'hex', coords: { q, r } } | null.
//
// A vehicle's idle location (design.md §15.4 "Location — a landmark or a bare hex") is
// EXACTLY ONE of:
//   - a landmark reference `{ landmarkKind, landmarkId }` — a SYSTEM or an OUTPOST, the two
//     anchors a transport treats identically, resolved by `getLandmark` exactly as a claim's
//     landmark is (an outpost is NOT deep space; for transports it groups as a system does);
//   - a bare hex `{ q, r }` — an in-bounds integer lattice coordinate, a craft adrift in
//     open space anchored to nothing.
// This returns the resolved coordinates for a valid location and `null` for a corrupt one:
// BOTH forms set (landmark keys AND hex keys) or NEITHER set is corruption, an unresolvable
// landmark is corruption, and an off-lattice hex is corruption. It is the ONE place the
// shape is judged, shared by the intake validator, the integrity invariant, and the dispatch
// selector below — so a system, an outpost, and a deep-space berth are ONE path with no
// special case, and dispatch/grouping key off the resolved coords, never the raw field.
function resolveVehicleLocation(location) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) return null;
  const hasLandmark = location.landmarkKind !== undefined || location.landmarkId !== undefined;
  const hasHex = location.q !== undefined || location.r !== undefined;
  // Exactly one form: both-set or both-null is corruption (design.md §15.4).
  if (hasLandmark === hasHex) return null;
  if (hasLandmark) {
    // Only a system or an outpost anchors a transport today (design.md §15.4 — toll gates /
    // guild outposts as landmarks are not built). getLandmark enforces the (id, kind) pair
    // resolves to a real landmark OF THAT KIND, so a mistagged id fails rather than resolving
    // by luck — the same strictness the claim invariant uses.
    if (location.landmarkKind !== 'system' && location.landmarkKind !== 'outpost') return null;
    const lm = getLandmark(location.landmarkId, location.landmarkKind);
    if (!lm || !lm.coords) return null;
    return { form: 'landmark', coords: { q: lm.coords.q, r: lm.coords.r } };
  }
  // Bare hex: an in-bounds integer lattice coordinate (isHexInBounds checks both).
  if (!isHexInBounds(location.q, location.r)) return null;
  return { form: 'hex', coords: { q: location.q, r: location.r } };
}

// vehicleCoords(vehicle) -> the craft's resolved coordinates { q, r }, or null when its
// location is corrupt. THE ONE SELECTOR the movement slice measures distance from and the
// client groups by — a landmark resolves to its coords, a hex is itself (design.md §15.4's
// performance contract: position is derived on read). Named as the vehicle-level convenience
// over `resolveVehicleLocation`.
function vehicleCoords(vehicle) {
  const r = resolveVehicleLocation(vehicle && vehicle.location);
  return r ? r.coords : null;
}

module.exports = {
  LIGHT_TRANSPORT,
  MEDIUM_TRANSPORT,
  HEAVY_TRANSPORT,
  SPYCRAFT,
  VEHICLE_CLASSES,
  BUILDABLE_VEHICLE_KINDS,
  VEHICLE_STATUSES,
  VEHICLE_SPECS,
  isVehicleClass,
  vehicleSpec,
  vehicleId,
  vehicleNumberOf,
  nextVehicleSerial,
  resolveVehicleLocation,
  vehicleCoords,
};
