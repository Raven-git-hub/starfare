'use strict';

// deep-maintenance.js — spacecraft DEEP MAINTENANCE (roadmap 2.6 maintenance, slice 4; docs/maintenance.md §4).
// A sibling of sim/craft-maintenance.js (slice 3: wear + the pool) rather than more of it, so neither file passes
// a few hundred lines. Wear brings a craft down to 0%; this brings it back to 100%.
//
//   MAINTENANCE POINTS (§4.1) — a system the craft's guild holds, or one of the guild's own Outposts. Nothing
//   else (a rival's system or Outpost, a fallow system, open space, a waystation). A held system has unlimited
//   room; an Outpost has OUTPOST_MAINTENANCE_BAYS bays, separate from its dock slots, plus a queue.
//
//   DEEP MAINTENANCE (§4.2) — free, time only. The craft sits at its point in status `maintenance` until its ready
//   tick, then is `idle` at condition 1. Its hold is locked the whole time (every craft action needs `idle`).
//
//   GOING IN — three ways: (1) a craft at 0% never DEPARTS from a maintenance point: a routed craft about to start
//   its next leg or lap there goes in instead, its lane ended 'maintenance' (stopForMaintenance, called from
//   sim/actions.js advanceRoute / finishLap), and a PLAIN multi-leg trip at 0% ends at an intermediate waypoint that
//   is a point (cutTripShort, called from sim/tick.js stepVehicleArrivals); (2) THE SWEEP: any idle 0% craft standing at one of its guild's
//   points goes in (sweepZeroCraft) — except one waiting in, or occupying, an Outpost dock queue / slot, whose
//   stop's actions run first; (3) the player sends a craft below 20% in early (the `startDeepMaintenance` action).
//
// THE STORED SHAPE — the facts live on the VEHICLE only (RULED for slice 4; invariant 5, one fact one place):
//   vehicle.status = 'maintenance'
//   vehicle.deepMaintenance = { readyTick }   — in a bay: idle again at condition 1 on this tick;
//                           | { queuedTick }  — waiting for an Outpost bay since this tick (no clock running yet).
// WHICH point it is at is the craft's own `location`, which does not move while it is in maintenance — so the point
// is read from the location (maintenancePointAt), never stored a second time. An Outpost's bays and queue are
// DERIVED from its guild's vehicles (bayOccupants / queuedAt), never stored on the Outpost.
//
// THE SAME-TICK ORDER (RULED, §4.7): (1) craft whose ready tick has come FINISH and leave their bays; (2) freed bays
// take queue heads — earliest queued tick, id tie-break; (3) new entries (rule 1 during the arrivals and the dock
// turnarounds, then the sweep) join — a bay if one is free, else the queue. (1)–(2) run at the head of tick step 5
// (stepDeepMaintenance, before the wear and the landings), (3) during step 5 and at its end (the sweep, after the
// dock step). After every player / operator action, (2) and the sweep run once more (afterAction), so an action that
// makes a 0% craft stand at its own point (a plant, a deploy, a spawn, a cancel) or frees a bay (removeVehicle) is
// settled before the invariants are checked — there is no window in which a stale state is visible.
//
// Nothing here moves a credit, a good, fuel, GP, RP, a licence or a fee (§5): only the craft's own state.

const { HEAVY_TRANSPORT, LIGHT_TRANSPORT, MEDIUM_TRANSPORT, SPYCRAFT, VEHICLE_CLASSES } = require('./vehicles.js');
const { CRAFT_WEAR_SCALE, conditionUnits } = require('./craft-maintenance.js');
const { ASSET_CONDITION_NEW } = require('./assets.js');
const { guildHolds } = require('./claims.js');
const { ownedOutpostAt, isDockEngaged } = require('./outposts.js');
const { endLane } = require('./routes.js');
const { recordEvent, DEEP_MAINTENANCE_ENTERED, DEEP_MAINTENANCE_FINISHED } = require('./events.js');

// DEEP_MAINTENANCE_FULL_TICKS — how long deep maintenance takes from 0% to 100%, by class. `[FIRST-CUT]`,
// docs/phase-1-tuning.md §"Maintenance" (RULED 09-11-26): light 720 (12 h) · medium 720 · heavy 1,440 (24 h) ·
// spycraft 2,880 (48 h). A partial repair takes the missing share of it (deepMaintenanceTicks).
const DEEP_MAINTENANCE_FULL_TICKS = Object.freeze({
  [LIGHT_TRANSPORT]: 720,
  [MEDIUM_TRANSPORT]: 720,
  [HEAVY_TRANSPORT]: 1440,
  [SPYCRAFT]: 2880,
});
for (const cls of VEHICLE_CLASSES) {
  if (!Number.isSafeInteger(DEEP_MAINTENANCE_FULL_TICKS[cls]) || DEEP_MAINTENANCE_FULL_TICKS[cls] < 1) {
    throw new Error(`deep-maintenance: class ${cls} has no whole full deep-maintenance time`);
  }
}

// The early threshold — a craft may be sent in early only BELOW this share of a full condition (strictly: exactly 20%
// is refused). `[FIRST-CUT]` 20%, phase-1-tuning.md §"Maintenance". Its one home is the percentage; the unit figure
// the gate compares against is DERIVED from it and the wear scale (96,768 of 483,840 today), and must be whole.
const EARLY_DEEP_MAINTENANCE_BELOW_PERCENT = 20;
const EARLY_DEEP_MAINTENANCE_BELOW_UNITS = (CRAFT_WEAR_SCALE * EARLY_DEEP_MAINTENANCE_BELOW_PERCENT) / 100;
if (!Number.isSafeInteger(EARLY_DEEP_MAINTENANCE_BELOW_UNITS)) {
  throw new Error(`deep-maintenance: ${EARLY_DEEP_MAINTENANCE_BELOW_PERCENT}% of the wear scale ${CRAFT_WEAR_SCALE} is not a whole number of units`);
}

// OUTPOST_MAINTENANCE_BAYS — maintenance bays per Outpost, separate from its 10 dock slots. `[FIRST-CUT]` 5,
// phase-1-tuning.md §"Maintenance". A held system has no limit.
const OUTPOST_MAINTENANCE_BAYS = 5;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ── where ────────────────────────────────────────────────────────────────────────────────────────────────

// maintenancePointAt(state, guildId, anchor) -> where a craft of `guildId` standing at `anchor` could be maintained:
//   { kind: 'system', systemId }  — a system landmark the guild holds (guildHolds — its home, or a Prefecture);
//   { kind: 'outpost', outpost }  — one of the guild's own Outposts on that hex (ownedOutpostAt, the same
//                                   hex-coincidence the dock model uses, so "at this Outpost" means one thing);
//   null                          — anywhere else.
// The same question for a craft (its location) and for a route waypoint (its anchor), so "a waypoint is a point
// exactly when a craft standing there would be at one". "At a system" means the system landmark, the test the
// transfer and the kit actions use.
function maintenancePointAt(state, guildId, anchor) {
  if (!anchor) return null;
  if (anchor.landmarkKind === 'system') {
    return guildHolds(state, guildId, anchor.landmarkId) ? { kind: 'system', systemId: anchor.landmarkId } : null;
  }
  const outpost = ownedOutpostAt(state, guildId, anchor);
  return outpost ? { kind: 'outpost', outpost } : null;
}

// pointRef(point) -> the point as plain ids, for a notice or the snapshot (never the live Outpost row).
function pointRef(point) {
  return point.kind === 'system'
    ? { kind: 'system', systemId: point.systemId }
    : { kind: 'outpost', outpostId: point.outpost.id };
}

// ── how long ─────────────────────────────────────────────────────────────────────────────────────────────

// deepMaintenanceTicks(vehicle) -> whole ticks from the craft's condition now to 100%:
// ceil(missingUnits × fullTicks ÷ CRAFT_WEAR_SCALE), in whole wear units (§4.2). Integer arithmetic throughout — the
// ceiling is taken as floor((a + b − 1) ÷ b) — so no float decides a tick. From 0% it is the full time.
function deepMaintenanceTicks(vehicle) {
  const missing = CRAFT_WEAR_SCALE - conditionUnits(vehicle.maintenanceCondition);
  const product = missing * DEEP_MAINTENANCE_FULL_TICKS[vehicle.class];
  return Math.floor((product + CRAFT_WEAR_SCALE - 1) / CRAFT_WEAR_SCALE);
}

function isAtZero(vehicle) {
  return conditionUnits(vehicle.maintenanceCondition) === 0;
}

function inMaintenance(vehicle) {
  return vehicle.status === 'maintenance';
}

// ── the bays (derived) ───────────────────────────────────────────────────────────────────────────────────

// atOutpost(state, guild, outpost) -> the guild's craft in maintenance (bay or queue) at this Outpost.
function atOutpost(state, guild, outpost) {
  return (guild.vehicles || []).filter((v) => {
    if (!inMaintenance(v)) return false;
    const here = ownedOutpostAt(state, guild.id, v.location);
    return here !== null && here.id === outpost.id;
  });
}

// bayOccupants(state, guild, outpost) -> the craft in this Outpost's bays (they have a ready tick), by id.
function bayOccupants(state, guild, outpost) {
  return atOutpost(state, guild, outpost).filter((v) => v.deepMaintenance.readyTick !== undefined).sort(byId);
}

// queuedAt(state, guild, outpost) -> this Outpost's maintenance queue in serving order: earliest queued tick first,
// id tie-break — a total order (invariant 9).
function queuedAt(state, guild, outpost) {
  return atOutpost(state, guild, outpost)
    .filter((v) => v.deepMaintenance.queuedTick !== undefined)
    .sort((a, b) => (a.deepMaintenance.queuedTick - b.deepMaintenance.queuedTick) || byId(a, b));
}

function guildOf(state, guildId) {
  return (state.guilds || []).find((g) => g.id === guildId);
}

// ── going in ─────────────────────────────────────────────────────────────────────────────────────────────

// enterDeepMaintenance(state, guild, craft, tick, note) — MUTATES the craft. The caller has proved the craft is
// standing at one of its guild's points with no trip and no route. Held system: straight into a bay. Outpost: a
// bay if fewer than OUTPOST_MAINTENANCE_BAYS are taken, else the queue (only a 0% craft is ever sent here then —
// an early request at a full Outpost is refused at validate). Stamped, and the entered notice written; `note` holds
// any extra payload fields the caller adds to that notice (`early`, or a cut-short trip's — see cutTripShort).
function enterDeepMaintenance(state, guild, craft, tick, note = {}) {
  const point = maintenancePointAt(state, guild.id, craft.location);
  if (point === null) {
    throw new Error(`enterDeepMaintenance, tick ${tick}: vehicle ${JSON.stringify(craft.id)} of guild ${JSON.stringify(guild.id)} is not at a maintenance point (location ${JSON.stringify(craft.location)})`);
  }
  const full = point.kind === 'outpost' && bayOccupants(state, guild, point.outpost).length >= OUTPOST_MAINTENANCE_BAYS;
  craft.status = 'maintenance';
  craft.deepMaintenance = full ? { queuedTick: tick } : { readyTick: tick + deepMaintenanceTicks(craft) };
  craft.updatedAtTick = tick;
  recordEvent(guild, tick, DEEP_MAINTENANCE_ENTERED, {
    craftId: craft.id,
    craftClass: craft.class,
    point: pointRef(point),
    ...(full
      ? { bay: false, queuePosition: queuedAt(state, guild, point.outpost).findIndex((v) => v.id === craft.id) + 1 }
      : { bay: true, readyTick: craft.deepMaintenance.readyTick }),
    ...note,
  });
}

// enterAtZero(state, guild, craft, tick) — a 0% craft goes in automatically. If it still holds a lane (rule 1: it
// was about to start its next leg or lap; or the sweep found a lane waiting at its last stop) the lane ENDS
// 'maintenance' first: a craft in maintenance has no route (§4.3), and the player re-dispatches after the ready tick.
function enterAtZero(state, guild, craft, tick) {
  if (craft.route) endLane(craft, 'maintenance', tick);
  enterDeepMaintenance(state, guild, craft, tick);
}

// stopForMaintenance(state, guild, craft, tick) -> true when RULE 1 caught the craft: it is at 0% and standing at a
// maintenance point of its guild, about to depart — so its lane ends and it goes in instead. Called by
// sim/actions.js wherever a routed craft would start its next leg or lap (advanceRoute / finishLap), which is
// always AFTER that stop's actions have run (an arrival's instant action, or the Outpost turnaround).
function stopForMaintenance(state, guild, craft, tick) {
  if (!isAtZero(craft) || maintenancePointAt(state, guild.id, craft.location) === null) return false;
  enterAtZero(state, guild, craft, tick);
  return true;
}

// cutTripShort(state, guild, craft, tick) -> true when RULE 1 caught a PLAIN trip (RULED 10-11-26, maintenance slice
// 4 amendment): "a craft at 0% cannot proceed past a point where it could receive maintenance, if that point was a
// listed waypoint on its route". A plain multi-leg dispatch's waypoints are listed, so on the tick one of its
// INTERMEDIATE legs ends, a craft at 0% (however it got there — this very tick's wear included, which runs first)
// whose leg ends at a maintenance point of its guild stops there: it lands as a final arrival would — idle at that
// leg's `to`, the trip cleared — and goes in at once. The point is asked at the leg's end, not at dispatch, so a
// system that became held mid-flight counts and one that stopped being a point does not. Called by sim/tick.js
// stepVehicleArrivals before the landings, for a craft flying a plain trip (a routed craft flies one leg at a time,
// and rule 1 meets it in advanceRoute). Nothing is refunded for the legs not flown: fuel is committed at launch
// (transport-model.md §11.3). The entered notice says the trip was cut short and where it had been heading.
function cutTripShort(state, guild, craft, tick) {
  if (craft.status !== 'inTransit' || !craft.trip || craft.route || !isAtZero(craft)) return false;
  const legs = craft.trip.legs;
  const ending = legs.slice(0, -1).find((leg) => leg.arrivalTick === tick); // an intermediate leg ending now
  if (!ending || maintenancePointAt(state, guild.id, ending.to) === null) return false;
  const destination = { ...legs[legs.length - 1].to };
  craft.location = { ...ending.to };
  craft.status = 'idle';
  delete craft.trip;
  enterDeepMaintenance(state, guild, craft, tick, { tripCutShort: true, tripDestination: destination });
  return true;
}

// sweepZeroCraft(state, tick) — THE SWEEP (§4.4). MUTATES `state`. Every idle craft at 0% standing at one of its
// guild's maintenance points goes in — guilds in order, each guild's craft by id (invariant 9), so when bays are
// short the lower ids take them. RULED: a craft waiting in, or occupying, an Outpost dock queue / slot is skipped —
// its stop's actions run first, and rule 1 catches it when the turnaround ends.
function sweepZeroCraft(state, tick) {
  for (const guild of state.guilds || []) {
    for (const craft of [...(guild.vehicles || [])].sort(byId)) {
      if (craft.status !== 'idle' || !isAtZero(craft)) continue;
      if (isDockEngaged(state, craft.id)) continue;
      if (maintenancePointAt(state, guild.id, craft.location) === null) continue;
      enterAtZero(state, guild, craft, tick);
    }
  }
}

// ── coming out ───────────────────────────────────────────────────────────────────────────────────────────

// finish(state, guild, craft, tick) — the ready tick has come: idle at condition 1, where it stands, stamped.
function finish(state, guild, craft, tick) {
  const point = maintenancePointAt(state, guild.id, craft.location);
  craft.status = 'idle';
  craft.maintenanceCondition = ASSET_CONDITION_NEW;
  delete craft.deepMaintenance;
  craft.updatedAtTick = tick;
  recordEvent(guild, tick, DEEP_MAINTENANCE_FINISHED, {
    craftId: craft.id,
    craftClass: craft.class,
    // The invariant keeps every craft in maintenance at a valid point, so this is never null.
    point: pointRef(point),
  });
}

// fillFreeBays(state, guild, tick) — every Outpost of the guild with a queue gives each free bay to its queue head
// (earliest queued tick, id tie-break); the head's clock starts now: readyTick = tick + its duration. Outposts by id.
function fillFreeBays(state, guild, tick) {
  if (!(guild.vehicles || []).some((v) => inMaintenance(v) && v.deepMaintenance.queuedTick !== undefined)) return;
  const outposts = (state.outposts || []).filter((o) => o.ownerGuildId === guild.id).sort(byId);
  for (const outpost of outposts) {
    const free = OUTPOST_MAINTENANCE_BAYS - bayOccupants(state, guild, outpost).length;
    if (free <= 0) continue;
    for (const craft of queuedAt(state, guild, outpost).slice(0, free)) {
      craft.deepMaintenance = { readyTick: tick + deepMaintenanceTicks(craft) };
      craft.updatedAtTick = tick;
      recordEvent(guild, tick, DEEP_MAINTENANCE_ENTERED, {
        craftId: craft.id,
        craftClass: craft.class,
        point: { kind: 'outpost', outpostId: outpost.id },
        bay: true,
        readyTick: craft.deepMaintenance.readyTick,
        fromQueue: true,
      });
    }
  }
}

// stepDeepMaintenance(state, tick) — MUTATES `state`. Steps (1) and (2) of the same-tick order, run at the head of
// tick step 5 (sim/tick.js stepVehicleArrivals). `tick` is the tick being built. Guilds in order, craft by id.
function stepDeepMaintenance(state, tick) {
  for (const guild of state.guilds || []) {
    const due = (guild.vehicles || [])
      .filter((v) => inMaintenance(v) && v.deepMaintenance.readyTick !== undefined && v.deepMaintenance.readyTick <= tick)
      .sort(byId);
    for (const craft of due) finish(state, guild, craft, tick);
    fillFreeBays(state, guild, tick);
  }
}

// afterAction(state, tick) — MUTATES `state`. Run by sim/actions.js after every applied action: freed bays take
// queue heads, then the sweep. A no-op when nothing is queued and no idle 0% craft stands at its own point.
function afterAction(state, tick) {
  for (const guild of state.guilds || []) fillFreeBays(state, guild, tick);
  sweepZeroCraft(state, tick);
}

// abortDeepMaintenance(craft, tick) — its point has gone (§4.8): idle where it stands, condition UNCHANGED (deep
// maintenance credits nothing until the ready tick), stamped. No lane — it had none.
function abortDeepMaintenance(craft, tick) {
  craft.status = 'idle';
  delete craft.deepMaintenance;
  craft.updatedAtTick = tick;
}

// abortAtSystem(guild, systemId, tick) — the guild has just lost `systemId` (sim/eviction.js): each of its
// craft in maintenance there is aborted. Called AFTER the claim is gone, so the system is no point any more.
function abortAtSystem(guild, systemId, tick) {
  for (const craft of [...(guild.vehicles || [])].sort(byId)) {
    if (!inMaintenance(craft)) continue;
    if (craft.location.landmarkKind === 'system' && craft.location.landmarkId === systemId) abortDeepMaintenance(craft, tick);
  }
}

// ── the player's early request (§4.6) ────────────────────────────────────────────────────────────────────

// earlyRefusal(state, guildId, vehicleId) -> the reason the early action is refused now, or null when it is allowed.
// THE ONE gate, read by the action's validate and by the snapshot's `earlyMaintenanceAllowed` flag, so the button
// and the engine can never disagree.
function earlyRefusal(state, guildId, vehicleId) {
  const guild = guildOf(state, guildId);
  if (!guild) return `no guild with id ${JSON.stringify(guildId)}`;
  const craft = (guild.vehicles || []).find((v) => v.id === vehicleId);
  if (!craft) return `guild ${JSON.stringify(guildId)} owns no vehicle ${JSON.stringify(vehicleId)}`;
  const vid = JSON.stringify(vehicleId);
  if (inMaintenance(craft)) return `vehicle ${vid} is already in deep maintenance`;
  if (craft.status !== 'idle') return `vehicle ${vid} is not idle (status ${JSON.stringify(craft.status)}) — only an idle craft goes into deep maintenance`;
  if (isDockEngaged(state, craft.id)) return `vehicle ${vid} is queued at an Outpost dock — let its transfer run, or re-dispatch it to cancel, first`;
  if (craft.route) return `vehicle ${vid} is running a lane — stop the lane or cancel it before sending the craft into deep maintenance`;
  const point = maintenancePointAt(state, guildId, craft.location);
  if (point === null) return `vehicle ${vid} is not at a maintenance point — deep maintenance happens at a system its guild holds or at one of its own Outposts`;
  if (conditionUnits(craft.maintenanceCondition) >= EARLY_DEEP_MAINTENANCE_BELOW_UNITS) {
    return `vehicle ${vid} is at ${craft.maintenanceCondition} condition — a craft goes in early only below ${EARLY_DEEP_MAINTENANCE_BELOW_PERCENT}%`;
  }
  if (point.kind === 'outpost' && bayOccupants(state, guild, point.outpost).length >= OUTPOST_MAINTENANCE_BAYS) {
    return `all ${OUTPOST_MAINTENANCE_BAYS} maintenance bays at Outpost ${JSON.stringify(point.outpost.id)} are taken — an early request never queues (only a craft at 0% does)`;
  }
  return null;
}

// startEarly(state, guild, craft, tick) — the early action's apply. The gate above has passed.
function startEarly(state, guild, craft, tick) {
  enterDeepMaintenance(state, guild, craft, tick, { early: true });
}

// ── the dispatch rule (§4.5) ─────────────────────────────────────────────────────────────────────────────

// The machine-readable code a refused quote / dispatch carries, so the route builder (slice 6) can recognise it
// without reading prose.
const ZERO_CONDITION_STOP_CODE = 'zero-condition-maintenance-stop';

// zeroConditionRouteRefusal(state, guildId, craft, anchors) -> null, or { code, waypointIndex, reason } when a craft
// at 0% is sent along a route with a maintenance point BEFORE its last waypoint (it would stop there for good). It
// may END at one — it goes in on arrival. A craft above 0% has no restriction.
function zeroConditionRouteRefusal(state, guildId, craft, anchors) {
  if (!isAtZero(craft)) return null;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const point = maintenancePointAt(state, guildId, anchors[i]);
    if (point === null) continue;
    const where = point.kind === 'system' ? `system ${JSON.stringify(point.systemId)}` : `Outpost ${JSON.stringify(point.outpost.id)}`;
    return {
      code: ZERO_CONDITION_STOP_CODE,
      waypointIndex: i,
      reason: `vehicle ${JSON.stringify(craft.id)} is at 0% condition and waypoint ${i} (${where}) is a maintenance point before the route's end — it would go into deep maintenance there; a craft at 0% may only END its route at a maintenance point (docs/maintenance.md §4.5)`,
    };
  }
  return null;
}

// ── the readout (snapshot) ───────────────────────────────────────────────────────────────────────────────

// vehicleDeepMaintenanceReadout(state, guild, v) -> the keys added to the vehicle row's `craftMaintenance` block:
//   earlyMaintenanceAllowed — the early action would be accepted right now (the slice-6 button reads it);
//   deepMaintenance — only while in maintenance: { point, readyTick } in a bay, or { point, queuedTick,
//                     queuePosition } waiting (1 = next to take a bay).
function vehicleDeepMaintenanceReadout(state, guild, v) {
  const out = { earlyMaintenanceAllowed: earlyRefusal(state, guild.id, v.id) === null };
  if (!inMaintenance(v)) return out;
  const point = maintenancePointAt(state, guild.id, v.location);
  const dm = v.deepMaintenance;
  if (dm.readyTick !== undefined) {
    out.deepMaintenance = { point: pointRef(point), readyTick: dm.readyTick };
  } else {
    const position = queuedAt(state, guild, point.outpost).findIndex((c) => c.id === v.id) + 1;
    out.deepMaintenance = { point: pointRef(point), queuedTick: dm.queuedTick, queuePosition: position };
  }
  return out;
}

// outpostMaintenanceReadout(state, outpost, tick) -> the Outpost row's `maintenance` block: its bay count, who is in
// each bay (by id) with the ready tick and the ticks left (`eta`, the dock-slot differencing pattern), and the queue
// in serving order. Always the same shape; owner only (a rival's Outpost row is allow-listed, sim/fog.js).
function outpostMaintenanceReadout(state, outpost, tick) {
  const guild = guildOf(state, outpost.ownerGuildId);
  const inBays = guild ? bayOccupants(state, guild, outpost) : [];
  const queue = guild ? queuedAt(state, guild, outpost) : [];
  return {
    bays: OUTPOST_MAINTENANCE_BAYS,
    inBays: inBays.map((v) => ({ vehicleId: v.id, readyTick: v.deepMaintenance.readyTick, eta: v.deepMaintenance.readyTick - tick })),
    queue: queue.map((v) => ({ vehicleId: v.id, queuedTick: v.deepMaintenance.queuedTick })),
  };
}

module.exports = {
  DEEP_MAINTENANCE_FULL_TICKS,
  EARLY_DEEP_MAINTENANCE_BELOW_PERCENT,
  EARLY_DEEP_MAINTENANCE_BELOW_UNITS,
  OUTPOST_MAINTENANCE_BAYS,
  ZERO_CONDITION_STOP_CODE,
  maintenancePointAt,
  deepMaintenanceTicks,
  isAtZero,
  bayOccupants,
  queuedAt,
  atOutpost,
  stopForMaintenance,
  cutTripShort,
  sweepZeroCraft,
  stepDeepMaintenance,
  afterAction,
  abortDeepMaintenance,
  abortAtSystem,
  earlyRefusal,
  startEarly,
  zeroConditionRouteRefusal,
  vehicleDeepMaintenanceReadout,
  outpostMaintenanceReadout,
};
