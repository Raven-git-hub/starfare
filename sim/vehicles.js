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
// SCOPE THIS SLICE: buy + build, minted idle. Nothing moves a vehicle yet
// (dispatch/routes are slice b), so `capacity`/`defenseRating` are carried but read
// by nothing, and `speed`/`fuelCostToRun` are read only by the delivery flight of a
// Syndicate BUY (sim/actions.js + sim/tick.js).

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

// The legal stored `status` values (design.md §15.4 "status (idle / in-transit)").
// THIS SLICE mints only `idle` — nothing moves a vehicle yet — but the legal set is
// the full pair so slice b's dispatch needs no invariant change; `checkVehicleIntegrity`
// asserts membership, not strict idleness.
const VEHICLE_STATUSES = Object.freeze(['idle', 'inTransit']);

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

// nextVehicleNumber(guild, class) -> the next free per-(guild, class) vehicle NUMBER: one
// above the highest suffix among this guild's vehicles of that class (0 -> 1 when it owns
// none). The dockyard build and the Syndicate delivery mint a vehicle's id from this,
// exactly as nextAssetNumber does for a ground asset.
//
// DETERMINISTIC and MONOTONIC (invariant 9): vehicles are NEVER deleted this slice, so the
// max only ever grows and a minted id can never collide with an earlier build. Two emissions
// in one tick get distinct ids because each is pushed into `guild.vehicles` BEFORE the next
// id is minted, so the second read sees the first and returns a higher number.
function nextVehicleNumber(guild, vehicleClass) {
  let max = 0;
  for (const v of (guild.vehicles || [])) {
    if (v.class !== vehicleClass) continue;
    const n = vehicleNumberOf(v.id);
    if (n != null && n > max) max = n;
  }
  return max + 1;
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
  nextVehicleNumber,
};
