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
const { usedSpace } = require('./manifest.js');

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

// OUTPOST_DEPLOY_RANGE — how far, in hexes (`hexDistance`), a guild may deploy an Outpost from a system
// it HOLDS (roadmap 2.2, the deploy pipeline slice 1). INCLUSIVE: a hex exactly this far away is in
// range; one hex further is not. `[FIRST-CUT]` 10, ruled 29-09-26 (docs/territory-model.md §5 "Deploy
// ranges"; recorded in docs/phase-1-tuning.md "Territory & deployment"). Read by the one deploy rule,
// `deployCheck` (sim/actions.js) — for the manual `deployAsset` and the on-arrival deploy alike — and
// nowhere else. The operator's `spawnOutpost` still places freely, without it.
const OUTPOST_DEPLOY_RANGE = 10;

// DEPLOY_RETREAT_HEXES — how far, in hexes, a craft pulls back when its ON-ARRIVAL deploy fails (roadmap
// 2.2, the deploy pipeline slice 2; docs/territory-model.md §5, the retreat rule). The craft does not idle
// on a hex it could not deploy on — that hex may be a rival's space, where idling could draw a fine — so it
// snaps this many hexes toward the nearest system its guild holds, landing AT that system if it is this
// close or closer (never past it). `[FIRST-CUT]` 3, ruled 30-09-26 (recorded in docs/phase-1-tuning.md
// "Territory & deployment"). Read only by the retreat (`retreatLanding`, sim/actions.js), never inlined.
const DEPLOY_RETREAT_HEXES = 3;

// DEPLOY_FAILED_REASONS — why an on-arrival deploy failed, recorded on the craft as `deployFailed =
// { reason, tick }` (the `laneEnded` pattern) so the player can see why the craft pulled back:
//   'occupied'     — the target hex holds a structure now (a seed landmark, an Outpost or a Deep Scan
//                    Array placed first);
//   'out-of-range' — (an Outpost) no system the guild holds is within OUTPOST_DEPLOY_RANGE of the hex
//                    any more;
//   'not-attached' — (a Deep Scan Array, roadmap 2.5 (b1)) the hex no longer touches a footprint the guild
//                    holds — e.g. the Outpost it was attached to was packed up while the craft flew.
// These are the deploy checks a craft's flight can change. The others cannot fail on arrival — the
// dispatch proved the target is a bare hex (an anchor never moves) and the hold exactly one kit (a kit is
// never manifested) — so they have no reason here; an arrival that trips one halts loudly instead.
const DEPLOY_FAILED_REASONS = Object.freeze(['occupied', 'out-of-range', 'not-attached']);

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

// outpostFreeSpace(outpost) -> the cargo space an Outpost can still take: its own `capacity` minus what
// its stockpile already holds (`usedSpace`, the `Σ qty × volumeOf` unit). A Syndicate BUY to an Outpost
// (docs/syndicate-orders.md §9.1 / §9.4) reads it twice — at departure, to decide the space-warning, and
// on arrival, to decide all-or-nothing — so the two can never judge "room" differently. It reads the
// Outpost's own `capacity` (minted as OUTPOST_CAPACITY), the same field the dock step's unload clamp and
// the outpost-stockpile-within-capacity invariant read, so all of them agree on one cap.
function outpostFreeSpace(outpost) {
  return outpost.capacity - usedSpace(outpost.stockpile);
}

// consignmentSummary(cargo) -> { cargo, units, space } — the goods summary BOTH delivery notices carry
// (docs/event-log.md §11), so the space-warning and the turn-back describe a consignment the same way.
//   cargo — a FRESH good→qty copy, keys sorted by good id (invariant 9), so the notice never shares an
//           object with the shipment (a save would split them; a copy keeps memory and disk alike);
//   units — Σ qty, the goods count;
//   space — `usedSpace(cargo)`, the cargo space the consignment needs at the Outpost.
// A notice must still read after the shipment is gone (§1, "self-contained"), hence a copy, not a link.
function consignmentSummary(cargo) {
  const goods = Object.keys(cargo || {}).sort();
  return {
    cargo: Object.fromEntries(goods.map((good) => [good, cargo[good]])),
    units: goods.reduce((sum, good) => sum + cargo[good], 0),
    space: usedSpace(cargo),
  };
}

module.exports = {
  OUTPOST_CAPACITY,
  OUTPOST_DOCK_SLOTS,
  OUTPOST_DEPLOY_RANGE,
  DEPLOY_RETREAT_HEXES,
  DEPLOY_FAILED_REASONS,
  OUTPOST_DOCK_TURNAROUND,
  outpostDockTurnaround,
  outpostId,
  outpostNumberOf,
  nextOutpostSerial,
  outpostFreeSpace,
  consignmentSummary,
};
