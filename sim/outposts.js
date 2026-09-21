'use strict';

// outposts.js — the guild-Outpost vocabulary: the carried-but-inert capacity/dock
// numbers, the deterministic id scheme, and the per-guild mint counter (design.md §4
// "The Guild Outpost", §15.4; roadmap 2.2 — the outpost ladder, slice 1). A guild
// Outpost is a SHARED, single-hex, guild-owned infrastructure claim in the Toll Gate
// family (state.outposts, NOT a per-guild inventory row) that anchors to a system and
// carries an as-yet-empty cargo-space stockpile. This slice places and destroys one via
// the operator CLI, exactly as the guild-transport vehicle was bootstrapped — no cargo,
// no dock behaviour, no client.
//
// This is the outpost mirror of sim/vehicles.js: it holds the RULES (the capacity/dock
// constants, the id scheme, the per-guild serial) and pure SELECTORS. It constructs
// nothing — `createOutpost` lives with the other entity constructors in state.js — which
// keeps this file free of a require cycle with state.js, exactly as vehicles.js is.
//
// ⚠ NOT the seed's Syndicate WAYSTATIONS. The seed calls its waystations "outposts" too
// (sim/seed.js `getOutpost`, §6/§15.4); a GUILD Outpost is a distinct, live-state entity
// (design.md §4). Nothing here touches the seed.
//
// SCOPE THIS SLICE: the entity + the operator spawn/remove primitive. `capacity` and
// `dockCapacity` are CARRIED but read by nothing — no cargo/dock behaviour yet (slice 3).

const { HEAVY_HOLD } = require('./fuel.js');
const {
  LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT,
} = require('./vehicles.js');

// OUTPOST_CAPACITY — the Outpost stockpile's hard space cap, in cargo space (the same
// `Σ qty × volumeOf` unit a transport hold uses). RULED 20-09-26 (design.md §4 "Capacity";
// recorded in docs/phase-1-tuning.md): thirty heavy-hauler holds. DERIVED from the existing
// `HEAVY_HOLD` constant, never the hardcoded product (§15.2 "Never invent a number") — so the
// cap and the hauler tier can never disagree, exactly as `HEAVY_HOLD` itself is derived from
// the `HAULER_TIERS` table. Carried on the entity and INERT this slice (nothing enforces or
// consumes it — the cargo model is slice 3).
const OUTPOST_CAPACITY = 30 * HEAVY_HOLD;

// OUTPOST_DOCK_SLOTS — the number of docking slots an Outpost has (design.md §4 "The dock
// model"). `[FIRST-CUT]`, the doc's working value 10 (recorded in docs/phase-1-tuning.md);
// carried on the entity as `dockCapacity`. Read by the dock tick step (slice 2, sim/tick.js):
// it throttles CONCURRENT transfers — at most this many craft hold a slot at once, the rest wait
// in the queue. Parking is unlimited; only ACTIVE transfers consume a slot (the deadlock-free
// guarantee, §4).
const OUTPOST_DOCK_SLOTS = 10;

// OUTPOST_DOCK_TURNAROUND — the per-class load/unload time (ticks a craft holds a dock slot),
// RULED 21-09-26 (design.md §4 "The dock model"; recorded in docs/phase-1-tuning.md): light 5,
// medium 30, heavy 120 ticks. It is the whole dock cycle's cost — one manifest, however many
// goods — and it is the LOADING TIME ITSELF: goods move at COMPLETION (the resolve-at-completion
// rule, §4), which is why an Outpost torn down mid-turnaround leaves the transfer un-happened.
// OUTPOST-ONLY: a transfer at a guild's own system is instant (slice 1), so no turnaround there.
//
// `spycraft` is DELIBERATELY ABSENT — it has capacity 0 (carries no cargo, sim/vehicles.js), so it
// never transfers and the doc rules no turnaround for it. Inventing one would be a number pulled
// from nowhere (§15.2 "Never invent a number"); instead the transfer gate refuses a capacity-0
// craft up front, so nothing without a ruled turnaround ever reaches a slot. The class names are
// imported from vehicles.js (spelled once there), never re-spelled here.
const OUTPOST_DOCK_TURNAROUND = Object.freeze({
  [LIGHT_TRANSPORT]: 5,
  [MEDIUM_TRANSPORT]: 30,
  [HEAVY_TRANSPORT]: 120,
});

// outpostDockTurnaround(vehicleClass) -> the ruled turnaround in ticks for a class, or null for a
// class with no ruled value (today only `spycraft`, capacity 0). null (not a throw) so a caller can
// ASK whether a class can dock and refuse loudly itself — the same null-means-"not a thing" shape
// `vehicleSpec` / `getRecipe` have. The dock tick step only ever promotes craft whose class HAS a
// turnaround (the transfer gate refused the rest), so `completionTick` is never sized off a null.
function outpostDockTurnaround(vehicleClass) {
  return Object.prototype.hasOwnProperty.call(OUTPOST_DOCK_TURNAROUND, vehicleClass)
    ? OUTPOST_DOCK_TURNAROUND[vehicleClass]
    : null;
}

// The id scheme is `outpost_<guildId>_NN`, 1-based and zero-padded to two digits — the exact
// mirror of vehicles.js's `vehicle_<guildId>_<class>_NN`. STABLE and DETERMINISTIC (§15.2,
// invariant 9): two runs of the same scenario mint byte-identical ids. The padding makes
// lexicographic order agree with numeric order.
function outpostId(guildId, n) {
  return `outpost_${guildId}_${String(n).padStart(2, '0')}`;
}

// outpostNumberOf(id) -> the trailing numeric suffix minted by `outpostId` (the integer NN),
// or null when the id carries none. Reads only the last `_NN` group, so a guildId containing
// an underscore does not confuse it — the same parse vehicleNumberOf uses.
function outpostNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextOutpostSerial(guild) -> the next per-GUILD mint serial: one above the guild's stored
// `outpostSerial` counter (absent/0 -> 1). The outpost mirror of `nextVehicleSerial`, and for
// the same reason (design.md §15.4 "Ids never repeat"): an Outpost can be REMOVED, so the
// number cannot be re-derived from the LIVE outposts — once the highest is torn down, a
// `max(existing)+1` derivation would re-hand its number to the next mint. The counter is
// STORED on the guild, monotonic and guild-wide, the justified stored-counter exception
// `guild.guildReputation` / `guild.vehicleSerial` already make. The CALLER bumps
// `guild.outpostSerial` to this value at mint (this stays a pure read, the pure-selectors
// discipline the rest of this file keeps); it only ever increments and never decrements on
// removal, so an id is unique across the guild's whole history.
function nextOutpostSerial(guild) {
  return (guild.outpostSerial || 0) + 1;
}

module.exports = {
  OUTPOST_CAPACITY,
  OUTPOST_DOCK_SLOTS,
  OUTPOST_DOCK_TURNAROUND,
  outpostDockTurnaround,
  outpostId,
  outpostNumberOf,
  nextOutpostSerial,
};
