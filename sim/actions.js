'use strict';

const {
  createGuild, createVenture, createAsset, createVehicle, createOutpost, createSavedRoute,
} = require('./state.js');
const {
  isStarterSystem, getTerranHomeworld, getSite, getSystem, isHexInBounds, seedLandmarkAtHex,
} = require('./seed.js');
const { getRecipe } = require('./recipes.js');
const {
  EQUITY_CEILING, isValidEquityPct, COMMITMENT_FLOOR, WINDOW_DAYS_MIN, WINDOW_DAYS_MAX,
  isValidCommitmentPct, isValidWindowDays, licenceFee, commitmentUnitsFor, equityOf,
  signingBump, teardownSettlement, licenceEndTick, renegotiationFee, applyLapse, applyVentureClosure,
} = require('./licence.js');
const { producedGoodFor, baselineOutputFor, baselineRateFor, isLicensedDeuteriumMine, isDockyard } = require('./baseline.js');
const {
  BUILDABLE_KINDS, SYNDICATE_SELLABLE_KINDS, MAX_QUEUE, assetBill, priceAssetForPurchase,
} = require('./asset-recipes.js');
const {
  isVehicleClass, vehicleSpec, vehicleId, nextVehicleSerial, resolveVehicleLocation,
} = require('./vehicles.js');
const { outpostId, nextOutpostSerial, outpostDockTurnaround } = require('./outposts.js');
const { resolveManifest, usedSpace, manifestAmountError, copyManifestLine } = require('./manifest.js');
const {
  REPEAT_MODES, CADENCES, copyRouteWaypoint, savedRouteId, nextSavedRouteSerial,
} = require('./routes.js');
const { postedPrice, PRICED_GOODS } = require('./prices.js');
const { checkQuote, quotedPrice } = require('./price-ring.js');
const { DEFAULT_WINDOW_N } = require('./windows.js');
const { isStockpileGood, isFuel, DEUTERIUM } = require('./resources.js');
const { setEntry } = require('./profile.js');
const { getStock, addStock } = require('./stock.js');
const { computeGalacticSupply } = require('./supply.js');
const { foundingEndowmentFor } = require('./meanline.js');
const { grantFor } = require('./issuance.js');
const { guildHolds } = require('./claims.js');
const {
  nearestWaystation, arrivalTickFor, hexDistance, legHexAtTick, legTicks, legFuelBurn,
} = require('./transport.js');
const {
  GUILD_STARTING_FUEL, routeFuelCost, burnFuel, fuelValue,
  volumeOf, haulerTierForSpace, HEAVY_HOLD, ASSET_CARGO_VOLUME,
} = require('./fuel.js');
const {
  STARTER_MINERS, STARTER_FACTORIES, starterAssetSpecs, assetKindForVentureType,
  deployedAssetIds, isAssetKind, assetId, nextAssetNumber, ASSET_CONDITION_NEW, ASSET_CONDITION_MIN,
} = require('./assets.js');

// vehicleDeliveryFuelBurn(destinationSystemId, vehicleClass) -> { fuelBurn: int }
//
// THE ONE PLACE a bought VEHICLE's delivery burn is computed (2.2-foundation), shared by the
// buy VALIDATE gate and the buy APPLY so the amount checked and the amount charged cannot drift.
// A bought craft FLIES ITSELF in (docs/phase-1-tuning.md §"Guild transports"): it is not carried
// on a Syndicate hauler, so the burn is the craft's OWN `fuelCostToRun × hexDistance`, NOT the
// heavy-hauler rate a non-movable ground asset pays (`routeFuelCost(dest, ASSET_CARGO_VOLUME)`).
//
// `near.distance` is the SAME hex distance nearestWaystation gives the arrival scheduler
// (sim/tick.js stepSyndicateBuilds), so the trip is priced and flown on one geometry. `Math.ceil`
// matches routeFuelCost's discipline — every real route costs at least 1 fuel, and fuel stays an
// integer (§15.2). GRACEFUL ABSENCE: no reachable waystation -> `{ fuelBurn: 0 }`, the same honest
// no-route value routeFuelCost reports (the waystation gate refuses such a buy up front anyway).
function vehicleDeliveryFuelBurn(destinationSystemId, vehicleClass) {
  const near = nearestWaystation(destinationSystemId);
  if (!near) return { fuelBurn: 0 };
  const spec = vehicleSpec(vehicleClass);
  return { fuelBurn: Math.ceil(near.distance * spec.fuelCostToRun) };
}

// dispatchRoute(craft, waypoints) -> { ok: true, legs: [{ from, to, length }], totalUnits,
//                                              skippedFirstLeg, actInPlace }
//                                  | { ok: false, reason }
//
// THE ONE place a guild-transport route is built and priced (transport-model.md §4), shared by the
// dispatch VALIDATE gate and APPLY so the route checked and the route flown/charged cannot drift —
// the same discipline vehicleDeliveryFuelBurn keeps for the buy. A route is an ordered list of legs
// (a polyline): leg 0 runs from the craft's current `location` to `waypoints[0]`, and leg K from
// `waypoints[K-1]` to `waypoints[K]`. Anchors are location refs (a landmark { landmarkKind,
// landmarkId } or a bare hex { q, r }) and are kept AS GIVEN — resolved coords are derived on read,
// never stored (§4). Fuel is `Σ legFuelBurn(hexDistance(resolve(from), resolve(to)), craft.
// fuelCostToRun, false)` in UNITS; `isToll` is false on every leg this slice (no toll infrastructure
// exists yet, §4 — the buff path lives in legFuelBurn regardless).
//
// The RULED failure modes (§4) each return `{ ok: false }`: an empty `waypoints`, an off-lattice /
// ill-formed waypoint (does not resolve), and a zero-length leg (its two anchors resolve to the SAME
// hex — the §2.3 interpolation would divide by zero; this also catches "first waypoint is the craft's
// own hex"). The FUEL gate is the caller's (it needs the guild's stores), so this only prices.
//
// `skipZeroLengthFirstLeg` (default false — the plain dispatch and the chained next-leg keep the refusal
// above; the actioned dispatch and the quote turn it on) is the §11.4 / §11.9 REPOSITION SKIP: when
// leg 0 (craft → W1) is zero-length because the craft already sits on W1, that leg is left out rather
// than refused, and the result says so (`skippedFirstLeg: true`) — the caller then resolves W1 in place.
// ONLY leg 0 is skippable: a later zero-length leg (two chosen waypoints on the same hex) is still a dead
// leg, refused.
// A route whose ONLY waypoint is skipped has no legs left: that is the §11.9 ACT-IN-PLACE route
// (`actInPlace: true`, `legs: []`, `totalUnits: 0`) — the craft is already at its one and only stop, so
// it does that stop's action where it stands. This helper sees bare anchors, not actions, so "an
// act-in-place route must carry an action" is the caller's check (the actioned-route validate).
function dispatchRoute(craft, waypoints, { skipZeroLengthFirstLeg = false } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    return { ok: false, reason: 'waypoints must be a non-empty ordered array of location anchors' };
  }
  // The craft's own location is leg 0's `from`; each waypoint is the next anchor in the polyline.
  const anchors = [craft.location, ...waypoints];
  const legs = [];
  let totalUnits = 0;
  let skippedFirstLeg = false;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const fromR = resolveVehicleLocation(from);
    const toR = resolveVehicleLocation(to);
    // Both endpoints must resolve. Leg 0's `from` is the craft's own location (the integrity
    // invariant guarantees it resolves), so a failure here is a bad WAYPOINT — index i is the leg,
    // and waypoints[i] is `to` (anchors is offset by the craft location at the front).
    if (fromR === null || toR === null) {
      return { ok: false, reason: `waypoint ${i} does not resolve to a valid anchor — a landmark { landmarkKind: "system"|"outpost", landmarkId } that resolves, or an in-bounds hex { q, r }` };
    }
    // Zero-length leg: the two anchors resolve to the SAME hex (§2.3 would divide by zero).
    if (fromR.coords.q === toR.coords.q && fromR.coords.r === toR.coords.r) {
      // The craft already sits on W1: an actioned route's reposition has nothing to fly, so it is not
      // built (§11.4) — no leg, no fuel. Only leg 0, and only when the caller asked.
      if (i === 0 && skipZeroLengthFirstLeg) {
        skippedFirstLeg = true;
        continue;
      }
      return { ok: false, reason: `leg ${i} is zero-length — its endpoints resolve to the same hex ${JSON.stringify(fromR.coords)} (a route may not stand still, transport-model.md §4)` };
    }
    const length = hexDistance(fromR.coords, toR.coords);
    totalUnits += legFuelBurn(length, craft.fuelCostToRun, false);
    legs.push({ from, to, length });
  }
  // Defensive only: without the skip, leg 0 is always either built or refused above, so a non-empty
  // `waypoints` never gets here with no legs. Kept so a later change cannot slip a legless route through.
  if (legs.length === 0 && !skippedFirstLeg) {
    return { ok: false, reason: 'the route has no legs — there is nothing to fly (transport-model.md §4)' };
  }
  // No legs AFTER the skip = the one-stop route dispatched from its own stop (§11.9). A craft already at
  // its only stop has nothing to fly, so it acts in place: no leg, and so no fuel (totalUnits stays 0).
  return { ok: true, legs, totalUnits, skippedFirstLeg, actInPlace: legs.length === 0 };
}

// perLapCost(craft, waypoints, fuelPrice) -> { perLapUnits, perLapCredits }
//
// What ONE LAP of a repeating lane costs, for the client to show beside the lane (roadmap 2.2 automation
// slice 3c-engine; the client computes no game number, §18). A lap is the RECURRING cycle
// (transport-model.md §11.4): from the last waypoint WN, reposition WN → W1, then run W1 → … → WN. So the
// fuel is the WN → W1 flyback plus the cycle's legs. When the player closed the loop themselves (WN == W1)
// the flyback is zero-length and skipped, so the lap is just the cycle.
//
// It is priced EXACTLY the way `startLap` charges a lap: `dispatchRoute` from the craft parked at WN, with
// the zero-length first leg skipped. So the number shown is the number each lap after the first really
// takes from the hoard — the two cannot drift. It depends only on the waypoints and the craft's per-hex
// burn, never on where the craft is now or on the launch mode. It leaves out lap 1's one-time positioning
// leg (wherever the craft launched from → W1): the run quote's `totalUnits` already carries that, and it is
// never paid again (§11.4).
//
// `waypoints` are bare anchors. A one-stop route [W1] has no leg to fly (WN is W1), so its lap costs 0.
// `perLapCredits` is the live-priced display value, `fuelValue` at the given price — the same rule as the
// run quote's `credits`. Both are null only for a list `dispatchRoute` would refuse (empty, an anchor that
// does not resolve, two stops in a row on one hex), which never reaches here from an accepted route — a
// visible null rather than a quiet 0.
function perLapCost(craft, waypoints, fuelPrice) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return { perLapUnits: null, perLapCredits: null };
  const atWN = { ...craft, location: waypoints[waypoints.length - 1] }; // the craft parked at WN
  const lap = dispatchRoute(atWN, waypoints, { skipZeroLengthFirstLeg: true });
  if (!lap.ok) return { perLapUnits: null, perLapCredits: null };
  return { perLapUnits: lap.totalUnits, perLapCredits: fuelValue(lap.totalUnits, fuelPrice) };
}

// buildSingleLegTrip(craft, toAnchor, dispatchTick) -> a ONE-LEG `trip` { legs: [scheduled],
// dispatchTick, arrivalTick } from the craft's CURRENT location to `toAnchor`, or `null` when that
// leg is not buildable (the `to` anchor no longer resolves, or the leg is zero-length). THE ONE home
// of a single-leg trip, shared by the actioned-route dispatch's FIRST leg (below) and by the chained
// execution's every-subsequent leg (sim/tick.js `advanceRoute`) — the automation's "the next leg goes"
// (transport-model.md §11.2). It reuses `dispatchRoute` for the resolution + zero-length guard (one
// home), so a chained leg is built and validated exactly as the plain dispatch's legs are. `isToll`
// false (no toll infra yet, §4); the schedule is one contiguous leg departing at `dispatchTick`. It
// burns NO fuel — a routed run is fuelled WHOLE up front (§11.3), so re-dispatching a leg is free here.
function buildSingleLegTrip(craft, toAnchor, dispatchTick) {
  const route = dispatchRoute(craft, [toAnchor]);
  if (!route.ok) return null; // anchor-gone / zero-length: the caller halts safely (§11.6), never throws
  const leg = route.legs[0];
  const arrivalTick = dispatchTick + legTicks(leg.length, craft.speed, false);
  const scheduled = {
    from: leg.from, to: leg.to, isToll: false, departureTick: dispatchTick, arrivalTick,
  };
  return { legs: [scheduled], dispatchTick, arrivalTick };
}

// --- the chained-route execution (the automation layer, transport-model.md §11.2) ---------------
// A routed craft (one carrying `route = { waypoints: [{ anchor, action? }], cursor }`) does not fly a
// frozen whole-trip; it flies leg by leg, and on ARRIVAL at each waypoint runs that stop's action —
// instant at a system, queue + turnaround at an outpost — then dispatches the next leg itself. The
// helpers below are that execution. `advanceRoute` is the ONE FUNNEL that "makes the next leg go";
// `resolveRouteArrival` is the ONE place a reached stop's action resolves. Their callers are the two tick
// hooks (sim/tick.js stepVehicleArrivals, stepOutpostDocks) and the `dispatchRouteWithActions` apply below
// (a craft already sitting on W1 resolves it in place — the §11.4 zero-length reposition skip). They live
// HERE rather than in tick.js so that apply can call them: tick.js requires this file, so the reverse edge
// would be a require cycle. It stays event-driven — a per-arrival / per-turnaround-completion / per-dispatch
// step in fixed id order — so there is no per-tick per-craft movement loop and determinism (§15.5
// invariant 9) is preserved.
//
// A REPEATING lane (slice 3a, §11.10) uses the same funnel: when the craft finishes its LAST waypoint
// (WN), `advanceRoute` reaches the lap boundary (`finishLap`) and, if the lane repeats, starts the next
// lap (`startLap`) — re-check the targets, fuel the lap up front, reposition to W1 and run the cycle again.

// advanceRoute(state, guild, craft, thisTick) — bump the cursor and dispatch the next leg, or reach the
// END OF THE LAP. The cursor points at the waypoint the craft is AT (just resolved); the next is `cursor + 1`.
//   - past the last waypoint → one lap of the waypoints is done: the craft is already idle at WN (the
//     arrival hook set its location), and `finishLap` decides what happens next (§11.10) — a one-shot
//     simply ends there (§11.2 "lands idle there"), a repeating lane goes round again.
//   - otherwise → dispatch the next single leg from the craft's current berth (buildSingleLegTrip is
//     the one home — the same builder the first leg used), with NO fuel recharge (the whole lap was
//     fuelled up front, §11.3). A null trip means the next anchor no longer resolves / the leg is
//     zero-length — a target vanished mid-run (§11.6 anchor-gone): the lane ENDS (leave the craft idle
//     at its current berth, route cleared and flagged, no throw, no bad leg).
function advanceRoute(state, guild, craft, thisTick) {
  const route = craft.route;
  const nextCursor = route.cursor + 1;
  if (nextCursor >= route.waypoints.length) {
    finishLap(state, guild, craft, thisTick); // WN was just resolved — the lap boundary
    return;
  }
  const trip = buildSingleLegTrip(craft, route.waypoints[nextCursor].anchor, thisTick);
  if (!trip) {
    endLane(craft, 'target-gone', thisTick); // anchor gone — the lane ENDS, idle where it paused (§11.6)
    return;
  }
  route.cursor = nextCursor;
  craft.status = 'inTransit';
  craft.trip = trip;
  delete craft.location; // an in-transit craft carries the trip and no bare location (§15.4)
}

// finishLap(state, guild, craft, thisTick) — the craft has just resolved WN, its LAST waypoint, so one
// lap (one full cycle of the waypoints, §11.10) is done. The lap boundary, step 1 of §11.10's fixed order:
// is the run OVER? A one-shot (`once` stores no mode) is over after its one pass, a lane the player told
// to "stop after this run" (`stopAfterRun`) is over now whatever its mode, and an N-run is over when this
// was its last lap — each way the craft ENDS idle at WN, route cleared: an ordinary completion, WN being
// a real waypoint (§11.4), and nothing flagged. Otherwise the lane repeats, and `startLap` runs steps 2–4.
// A lane that goes on does NOT always start its next lap at once: a `perCycle` lane (slice 3a.1) HOLDS here
// as a `waiting` lane (reason 'cadence'), and the fuel-cycle boundary starts its next lap (see below).
// A repeating lane COUNTS the lap here, at the end of each lap (slice 3a.1): `lapsDone` goes UP by one —
// so after lap 1 it reads 1, and the client can show "lap k" as lapsDone + 1 — and an N-run's
// `lapsRemaining` goes DOWN by one, so it is always "laps still to fly, this one included" while the lane
// is live (the lap that takes it to 0 is the last) and the two always add back to the launched `N`.
// No tick is stamped for the count: this runs on the tick the lap ended, and whatever happens next records
// that tick already — the next lap's departure, a wait's `sinceTick`, an end flag, or the route going away.
function finishLap(state, guild, craft, thisTick) {
  const route = craft.route;
  if (route.mode === undefined) {
    delete craft.route; // once — the built one-shot end, unchanged
    return;
  }
  route.lapsDone += 1;
  if (route.mode === 'nRun') route.lapsRemaining -= 1;
  if (route.stopAfterRun || (route.mode === 'nRun' && route.lapsRemaining === 0)) {
    delete craft.route; // a lane stopped after this run, or the N-th lap just finished — idle at WN
    return;
  }
  if (route.cadence === 'perCycle') {
    // A PER-CYCLE lane paces itself to one lap per fuel cycle (§11.10): rather than start the next lap
    // back to back, it holds at WN as a `waiting` lane. The fuel-cycle boundary already re-attempts
    // every waiting lane through `startLap` (resumeWaitingLanes), so its next lap starts there — the SAME
    // path a fuel-short lane resumes on, with no timer of its own. Nothing is burned while it holds.
    route.waiting = { reason: 'cadence', sinceTick: thisTick };
    return;
  }
  startLap(state, guild, craft, thisTick); // an immediate lane: the next lap starts now
}

// startLap(state, guild, craft, thisTick) — begin the NEXT lap of a repeating lane, from WN where the
// craft now sits idle. Steps 2–4 of §11.10's lap boundary, in that FIXED order:
//   2. RE-CHECK the lap's targets (§11.6): every actioned waypoint must still have its store — the SAME
//      `routeStoreAt` the arrival resolver uses, so a target this check passes is one an arrival would
//      find. Any gone → the lane ENDS: route dropped, craft idle at WN, flagged. This comes BEFORE the fuel step,
//      so a visibly doomed lap is never charged (§11.3 — a refusal to charge, not a refund).
//   3. PRICE the lap (§11.3 / §11.4): the reposition WN → W1 plus the cycle W1 → … → WN, through the SAME
//      `dispatchRoute` the launch used, from the craft's berth at WN. When WN is W1 the reposition is
//      zero-length and is SKIPPED (no leg, no fuel). If the hoard can't cover it → the lane WAITS at WN:
//      nothing burns, the route stays, and the craft sits idle (§11.6) — `resumeWaitingLanes` calls this
//      same function again at each fuel-cycle boundary, so a waiting lane re-runs steps 2–4 in full.
//      (A per-cycle lane held for its cadence arrives here the same way, from that boundary re-attempt.)
//   4. Otherwise BURN the whole lap up front (§11.3) — exactly the launch's burn: units from the hoard,
//      `totalConsumed` rising to match (invariant 1) — reset the cursor to W1 and fly there
//      (`flyToFirstStop`, the launch's own reposition).
// Every leg it dispatches departs now and lands in a later tick's arrival step; nothing here loops.
function startLap(state, guild, craft, thisTick) {
  const route = craft.route;
  if (route.waypoints.some((wp) => wp.action && routeStoreAt(state, guild.id, wp.anchor) === null)) {
    endLane(craft, 'target-gone', thisTick); // a target is gone — the lane ENDS at WN (§11.6)
    return;
  }
  const lap = dispatchRoute(craft, route.waypoints.map((wp) => wp.anchor), { skipZeroLengthFirstLeg: true });
  if (!lap.ok) {
    // Defensive: the anchors were checked at launch and seed landmarks never move, so this cannot fail
    // today. If it ever does, an anchor that no longer resolves IS a gone anchor (§11.6) — end the lane.
    endLane(craft, 'target-gone', thisTick);
    return;
  }
  if (guild.fuelHoard + (guild.deuteriumFuel || 0) < lap.totalUnits) {
    // Fuel short — the lane WAITS at WN, burning nothing (§11.6). `sinceTick` records when the FUEL wait
    // began: a lane already waiting for fuel keeps its first `sinceTick`, while a per-cycle lane that was
    // holding for its cadence — and now, at the boundary, cannot pay — becomes a fuel wait from this tick.
    if (!route.waiting || route.waiting.reason !== 'fuel') route.waiting = { reason: 'fuel', sinceTick: thisTick };
    return;
  }
  delete route.waiting; // the lap runs — whichever wait it was (fuel or cadence), it is over
  burnFuel(guild, lap.totalUnits);
  state.audit.totalConsumed += lap.totalUnits;
  route.cursor = 0;
  flyToFirstStop(state, guild, craft, lap.skippedFirstLeg, thisTick);
}

// resumeWaitingLanes(state, thisTick) — the FUEL-CYCLE BOUNDARY re-attempt (transport-model.md §11.6 /
// §11.10). Called by sim/tick.js's stepBaselineAllocation at each cycle boundary, AFTER issuance has
// grown the hoards. Every WAITING lane — short of fuel, or a per-cycle lane holding for its cadence (slice
// 3a.1) — gets one fresh try at its next lap, through the SAME `startLap` its lap boundary ran, so the
// reason it waited does not change what happens now: the target re-check comes first (a stop that vanished
// while it waited ENDS the lane, flagged), then the fuel: affordable now → burn and go; short → it waits
// for fuel (a fuel wait keeps its `sinceTick`; a cadence hold turns into a fuel wait from this tick).
// Guilds in array order, and each guild's waiting craft in FIXED id order, so when a hoard can cover only
// some of them the lower ids go first, the same way every run (§15.5 invariant 9). Bounded: one try per
// waiting craft per boundary, and no per-tick work between boundaries.
function resumeWaitingLanes(state, thisTick) {
  for (const guild of state.guilds || []) {
    const waiting = (guild.vehicles || []).filter((v) => v.route && v.route.waiting);
    waiting.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const craft of waiting) startLap(state, guild, craft, thisTick);
  }
}

// flyToFirstStop(state, guild, craft, skippedFirstLeg, thisTick) — put a routed craft (cursor 0) on its
// way to W1: the §11.4 REPOSITION. Shared by the launch (the positioning from wherever the craft was
// dispatched) and every later lap (the loop-back from WN), so both reposition exactly alike.
//   - The reposition is zero-length (`skippedFirstLeg` — the craft already sits on W1's hex): it is not
//     built (§11.4). The craft ARRIVES at W1 right here: it takes W1's anchor as its location (the same
//     hex, and exactly what landing there would set) and W1 resolves through the SAME resolver an arrival
//     uses — a system action now, then the W1 → W2 leg goes; an Outpost action queues for a dock slot and
//     W2 goes at turnaround; no action → straight on to W2; and a halt if W1's store is gone (§11.6).
//     No same-tick loop: W1 → W2 is a real leg (a dead one is refused at launch), so the craft next lands
//     in a LATER tick's arrival step. (A one-stop one-shot — act in place, §11.9 — needs nothing extra:
//     W1 is also its last waypoint, so the resolver's advanceRoute ends the run.)
//   - Otherwise fly the W1 leg (buildSingleLegTrip is the one home). It is built while the craft still
//     carries its location; then the location goes — an in-transit craft carries the `trip` and NO bare
//     `location` (§15.4), and the arrival hook restores it.
function flyToFirstStop(state, guild, craft, skippedFirstLeg, thisTick) {
  const w1 = craft.route.waypoints[0].anchor;
  if (skippedFirstLeg) {
    craft.location = { ...w1 };
    resolveRouteArrival(state, guild, craft, thisTick);
    return;
  }
  craft.trip = buildSingleLegTrip(craft, w1, thisTick);
  craft.status = 'inTransit';
  delete craft.location;
}

// resolveSystemAction(guild, craft, systemId, manifest, thisTick) — the INSTANT system-transfer path,
// the SAME one transferCargo's system branch uses (design.md §4, the system half): move goods between
// the craft's hold and the guild's (guild, system) soft-capped pool via the ONE shared resolver
// (partial-safe, §11.6), keeping the hold omit-when-empty and stamping the mutation's tick (§15.2).
function resolveSystemAction(guild, craft, systemId, manifest, thisTick) {
  const hold = craft.cargo || {};
  const store = {
    get: (good) => getStock(guild, systemId, good),
    add: (good, delta) => addStock(guild, systemId, good, delta),
    freeSpace: () => Infinity, // a system pool is soft-capped (§4) — an unload is bounded only by the hold
  };
  resolveManifest(hold, craft.capacity, store, manifest);
  if (Object.keys(hold).length) craft.cargo = hold; else delete craft.cargo;
  craft.updatedAtTick = thisTick;
}

// resolveRouteArrival(state, guild, craft, thisTick) — called from stepVehicleArrivals when a routed
// craft lands at a waypoint (its `location` already set to the arrived anchor). Resolve that waypoint's
// action (if any), then advance — EXCEPT at an outpost, where the dock step advances after turnaround.
function resolveRouteArrival(state, guild, craft, thisTick) {
  const wp = craft.route.waypoints[craft.route.cursor];
  if (!wp.action) {
    advanceRoute(state, guild, craft, thisTick); // a no-action waypoint is a pure turning point — chain straight through
    return;
  }
  // WHERE the craft sits decides HOW the action resolves — the SAME split transferCargo uses (§4), read
  // through `routeStoreAt`, the one predicate the lap-start re-check shares:
  const store = routeStoreAt(state, guild.id, craft.location);
  if (store && store.kind === 'system') {
    // A SYSTEM → INSTANT, then advance the SAME tick (no wait at a guild's own territory, §4).
    resolveSystemAction(guild, craft, store.systemId, wp.action.manifest, thisTick);
    advanceRoute(state, guild, craft, thisTick);
    return;
  }
  if (store) {
    // One of the guild's OWN Outposts → QUEUE for a dock slot, exactly as transferCargo's outpost
    // branch does (ready-tick = now; the craft stays plain `idle`, parked). Do NOT advance — the dock
    // step (running immediately after this one, the SAME tick) promotes it, and advanceRoute runs at
    // completion: the outpost turnaround IS the pause, and the next leg goes on completion (§11.2).
    const outpost = store.outpost;
    if (!outpost.queue) outpost.queue = [];
    outpost.queue.push({
      vehicleId: craft.id,
      manifest: wp.action.manifest.map(copyManifestLine), // canonical, non-aliasing copy
      readyTick: thisTick,
    });
    craft.updatedAtTick = thisTick;
    return;
  }
  // Neither a system nor an owned Outpost — the action's target vanished mid-run (an outpost torn down,
  // §11.6 anchor-gone). The lane ENDS: the craft is idle at its current berth (the now-bare hex), route
  // cleared, flagged. Goods are conserved — nothing moved for the un-resolved action.
  endLane(craft, 'target-gone', thisTick);
}

// endLane(craft, reason, thisTick) — a lane ENDS on its own (transport-model.md §11.6): the route is
// DROPPED and the craft is left an ordinary idle craft wherever it stands — at WN if caught at a lap's
// start, at the bare hex if a target vanished mid-flight. There is no resume-in-place; the player
// re-dispatches. The craft is FLAGGED `laneEnded = { reason, tick }` (a LANE_END_REASONS entry, and the
// tick it happened — §15.2) so the player can see WHY it stopped; the next dispatch of the craft clears it.
// The one place a lane is ended-and-flagged, for every halt site (the arrival resolver, a leg that can no
// longer be built, the lap-start re-check, and an Outpost torn down under a docked craft).
function endLane(craft, reason, thisTick) {
  delete craft.route;
  craft.laneEnded = { reason, tick: thisTick };
}

// cancelLanding(craft, tick) -> { ok: true, location: { q, r } } | { ok: false, reason }
//
// WHERE a craft in flight stops when the player CANCELS it (transport-model.md §11.10 "Cancel", slice 3b):
// the hex it is over at `tick`. THE ONE home of that answer, shared by the cancelRoute VALIDATE gate and
// APPLY, so the landing checked and the landing made cannot drift (the dispatchRoute discipline).
//   1. Find the ACTIVE leg — the one being flown at `tick`. A trip's legs are contiguous (leg K+1 departs
//      the tick leg K arrives), so it is the first leg that has not arrived yet. A routed craft's trip has
//      one leg; a plain dispatch's has one per waypoint. (Past the last arrival — which a live craft never
//      is, it would have landed — the last leg is used, and its clamp puts the craft at its end.)
//   2. A TOLL leg does not snap (see the stub below).
//   3. Otherwise interpolate the craft's position along the leg and round it to a hex (§2.3 / §2.4,
//      `legHexAtTick`). At the very tick one leg ends and the next begins, this is the waypoint between them.
//   4. That hex must be inside the galaxy. A leg between two in-bounds hexes near the rim can pass over a
//      hex outside the lattice, and a craft cannot be left there (it would not be a valid location). The
//      cancel is REFUSED for that tick; the craft keeps flying, so a later cancel lands. Which in-bounds hex
//      it should snap to instead is not ruled — it is on the decision checklist, not guessed here.
function cancelLanding(craft, tick) {
  const legs = craft.trip.legs;
  const leg = legs.find((l) => tick < l.arrivalTick) || legs[legs.length - 1];
  if (leg.isToll) {
    // TODO(2.3, §11.10): a TOLL leg does not snap. The craft COMPLETES the passage to the toll's exit and
    // stops there — it never snaps to a hex INSIDE a toll. Tolls are roadmap 2.3: every leg is dispatched
    // with isToll false today, so this branch cannot be reached. Until it is built it REFUSES, so a toll
    // leg can never fall through to the normal snap below.
    return { ok: false, reason: `vehicle ${JSON.stringify(craft.id)} is on a toll leg — a toll cancel completes to the toll's exit, which is not built yet (roadmap 2.3, transport-model.md §11.10)` };
  }
  const from = resolveVehicleLocation(leg.from);
  const to = resolveVehicleLocation(leg.to);
  if (!from || !to) {
    // Defensive: the trip invariant guarantees both ends resolve. Refuse rather than throw on a bad leg.
    return { ok: false, reason: `vehicle ${JSON.stringify(craft.id)}'s current leg does not resolve — cannot place it` };
  }
  const hex = legHexAtTick(from.coords, to.coords, leg.departureTick, leg.arrivalTick, tick);
  if (!isHexInBounds(hex.q, hex.r)) {
    return { ok: false, reason: `vehicle ${JSON.stringify(craft.id)} is over hex ${JSON.stringify(hex)}, outside the galaxy's lattice — it cannot stop there; cancel again once it has flown back over the lattice (transport-model.md §11.10)` };
  }
  return { ok: true, location: hex };
}

// quoteDispatch(state, { guildId, vehicleId, waypoints }) -> { ok: true, legs, totalTicks, totalUnits,
//                                                             credits, perLapUnits, perLapCredits,
//                                                             affordable, arrivalTick }
//                                                          | { ok: false, reason }
//
// The READ-ONLY PROJECTION of a dispatch (roadmap 2.2 b2b-1, transport-model.md §4/§18). It answers
// "what would this route cost the player, and can they afford it?" for the route-planner client BEFORE
// they commit — computing every game number in the engine so the client computes none (§18). It shares
// `dispatchRoute` and the leg math with the real `dispatchVehicle`, so a quote and the dispatch it
// previews can NEVER disagree. It reads state and MUTATES NOTHING — calling it any number of times
// leaves the galaxy byte-identical (no journal, no tick, no snapshot).
//
// It mirrors `dispatchVehicle`'s validate gates so the planner shows the same truth the dispatch would:
// guild exists, owns `vehicleId`, craft is idle. On any failure — those gates, or one of the ruled
// route failure modes (empty / unresolvable waypoint / zero-length leg) that `dispatchRoute` returns —
// it returns `{ ok: false, reason }` with the SAME message the dispatch validate gives. Unlike dispatch
// it does NOT gate on fuel: an unaffordable route is still a valid quote answer ("here's the cost, you
// can't afford it"), surfaced as `affordable: false` rather than a refusal.
//
// The craft → W1 leg follows the ACTIONED dispatch (slice 2a.1): when the craft already sits on W1 that
// leg is skipped, not refused (§11.4 / §11.9), so the Finalise quote shows what `dispatchRouteWithActions`
// will really fly. Known edge: the plain `dispatchVehicle` does NOT skip, so a NO-action route whose
// first waypoint is the craft's own hex now quotes ok (acting in place if it is one stop; otherwise just
// the onward legs) while a plain dispatch of it is still refused. Today's client never asks for that
// quote — it flags the craft → W1 row as a dead leg and keeps Finalise disabled; slice 2b decides how
// the client treats it.
//
// The `ok` breakdown is built from the SAME numbers a dispatch freezes — `dispatchRoute`'s `legs[].length`
// (no re-derived geometry), the §2.2 leg math (`legTicks` / `legFuelBurn`, `isToll` false this slice),
// `dispatchRoute`'s own `totalUnits` sum, `fuelValue` at the live `reserve.fuelPrice` (a display cost,
// floating with price like the snapshot's trip cost), and `state.tick` for the arrival — so the quote is
// authoritative and matches what `dispatchVehicle` + `stepVehicleArrivals` + the snapshot would produce.
//
// Beside that whole-RUN cost it gives the cost of ONE LAP if the route is launched as a repeating lane
// (`perLapUnits` / `perLapCredits`, slice 3c-engine — see `perLapCost`): the WN → W1 flyback plus the
// cycle, without the one-time positioning leg. It is a property of the waypoints, so every ok quote
// carries it; the client shows it only when the player picks a repeating mode.
function quoteDispatch(state, { guildId, vehicleId, waypoints }) {
  // The dispatch validate gates, in the same order, returning the same messages (so the planner shows
  // exactly what a real dispatch would refuse).
  const guild = findGuild(state, guildId);
  if (!guild) {
    return { ok: false, reason: `no guild with id ${JSON.stringify(guildId)}` };
  }
  const craft = (guild.vehicles || []).find((v) => v.id === vehicleId);
  if (!craft) {
    return { ok: false, reason: `guild ${JSON.stringify(guildId)} owns no vehicle ${JSON.stringify(vehicleId)}` };
  }
  if (craft.status !== 'idle') {
    return { ok: false, reason: `vehicle ${JSON.stringify(vehicleId)} is not idle (status ${JSON.stringify(craft.status)}) — only an idle craft dispatches` };
  }
  // Build + price the route through the ONE home the real dispatch uses. A ruled failure mode surfaces
  // to the planner verbatim; on ok, `route.legs[].length` is the geometry we reuse (never re-derived).
  // The quote takes the SAME §11.4 / §11.9 zero-length skip the actioned dispatch takes, because a quote
  // must preview exactly what dispatch will fly: a craft already on W1 quotes only the REAL legs
  // (W1→W2…), and a one-stop route at its own berth quotes as acting in place (no legs, 0 ticks, 0 fuel).
  // The quote never sees actions, so the "act in place needs an action" rule is the dispatch validate's.
  const route = dispatchRoute(craft, waypoints, { skipZeroLengthFirstLeg: true });
  if (!route.ok) return route;

  // Per-leg ticks + fuel from the §2.2 formula (isToll false this slice — no toll infra); totalTicks is
  // Σ per-leg ticks, exactly the contiguous schedule dispatch freezes (leg 0 departs now, legs abut).
  // After a skip there is one leg fewer than waypoints (leg k ends at waypoint k+1), and an act-in-place
  // route has none — `legs` is then [] and every total below is a clean 0 (arrivalTick is now).
  let totalTicks = 0;
  const legs = route.legs.map((leg) => {
    const ticks = legTicks(leg.length, craft.speed, false);
    const fuel = legFuelBurn(leg.length, craft.fuelCostToRun, false);
    totalTicks += ticks;
    return { length: leg.length, ticks, fuel };
  });
  // `totalUnits` is dispatchRoute's own sum (== Σ leg.fuel by construction, both being legFuelBurn with
  // isToll false) — the whole-route burn the dispatch takes from the hoard. Trust the shared helper's
  // sum so the quote and the dispatch can't drift on the number that gates the burn.
  const totalUnits = route.totalUnits;
  // The route passed dispatchRoute above, so its lap builds too (same waypoints; only the skippable
  // WN → W1 leg is new) — the per-lap figures are always numbers here.
  const lap = perLapCost(craft, waypoints, state.reserve.fuelPrice);
  return {
    ok: true,
    legs,
    totalTicks,
    totalUnits,
    // The live-priced display cost (a credit figure, not a treasury debit) — the same mark-to-market the
    // snapshot's in-flight trip uses, so a quote reads at the fuel price of the tick it was asked at.
    credits: fuelValue(totalUnits, state.reserve.fuelPrice),
    // What each lap AFTER the first would burn if this route repeats: the recurring flyback + cycle, not
    // the run's one-time positioning. Priced at the same live fuel price as `credits`. It gates nothing.
    perLapUnits: lap.perLapUnits,
    perLapCredits: lap.perLapCredits,
    // The whole-route, refuse-whole gate the dispatch applies (hoard + contraband ≥ the burn) — reported,
    // not enforced: an unaffordable route is a valid quote, and the planner gates its Dispatch button on it.
    affordable: (guild.fuelHoard + (guild.deuteriumFuel || 0)) >= totalUnits,
    // The absolute tick the craft would land — contiguous legs, first departs now — matching the apply.
    arrivalTick: state.tick + totalTicks,
  };
}

// actions.js — action constructors, and the validate-as-they-arrive intake
// discipline (design.md §15.6). This is the guard against the game's own
// named failure mode: "a guild with 100 credits gets three 'spend 80' orders
// all approved" if you validate a batch against one stale snapshot. The fix
// is sequential: validate each action against state-as-it-stands — start-of-
// batch PLUS every action already accepted earlier in this same batch — and
// apply it immediately if it passes. Contested claims resolve first-valid-
// wins under the same discipline (not exercised yet: no claims exist).
//
// SCOPE: the action types the walking skeleton + testbed need so far, each
// grounded in fields that already exist so it MEANS something without an
// economy.js/territory.js to lean on:
//   - paySyndicateFee   — credits move an OWNED balance -> the SHARED ledger
//                         (invariant 2 holds: none minted or destroyed).
//   - foundGuild        — a guild enters on a starter-eligible home (§13);
//                         starting credits are debited from the ledger, so
//                         nothing is minted, and it seats + claims the home. It
//                         also GRANTS the starter asset gift (§4, 30-08-26) —
//                         engine policy, not an action field.
//   - establishVenture  — seat a NEW venture on a real seed node so it produces
//                         on the next tick, OCCUPYING an idle asset of the
//                         matching kind. Three gates (§4): vacant node, idle
//                         asset in inventory, and the guild holds the system.
//   - setProductionProfile — store a guild's per-system Gate-1/Gate-3 policy.
//   - sellToSyndicate   — the guild sells stockpile goods to the Syndicate at the
//                         posted price (design.md §5 "SELL GOES LIVE", 29-08-26).
//                         The FIRST action that mutates a stockpile, and so the
//                         first that has to refresh the galactic-supply cache.
//   - buyFromSyndicate  — the mirror (design.md §6, "Syndicate Delivery — the BUY
//                         side", 29-08-26): the cash is debited NOW and the goods
//                         are SCHEDULED, arriving some ticks later. The first
//                         action to write the IN-FLIGHT layer (state.shipments);
//                         tick.js's stepArrivals is the half that lands it.
//   - setSyndicateCommitment / setWindowN — the THROWAWAY commitment-injection dev
//                         scaffold (design.md §15.4 "Scaffold 11-08-26", §5): they
//                         set the windowed-accrual placeholders the engine already
//                         reads (Venture.syndicateCommitment, state.windowN) so a
//                         test scenario can light the console's commitment bar and
//                         give a scripted bot real targets before the real Licence
//                         entity exists. Explicitly transitional — retired when the
//                         licence grant becomes syndicateCommitment's source.
// Every OTHER action design.md eventually needs (placing an order, setting a
// toll, casting a vote) waits for the module that would give it an effect —
// inventing them now would mean guessing at economy.js before it exists.

// --- Action constructor -----------------------------------------------

// A guild paying credits to the Syndicate (the shape of a toll, tariff, or
// fee — the specific occasion doesn't matter yet, only that credits move
// from an OWNED balance into the SHARED ledger).
function createPaySyndicateFeeAction({ guildId, amount }) {
  if (guildId === undefined) throw new Error('createPaySyndicateFeeAction: guildId is required');
  if (amount === undefined) throw new Error('createPaySyndicateFeeAction: amount is required');
  return { type: 'paySyndicateFee', guildId, amount };
}

// Founding a guild: the conservation-clean event by which a guild comes into
// being on a running galaxy -- the "owner creates their first guild" moment,
// and later any join. Starting credits are DEBITED from the Syndicate ledger
// (design.md §8: the ledger is the balancing account that funds guild credits),
// so nothing is minted and invariant 2 holds.
//
// FUEL-GENESIS IS NOW DECIDED (fuel Slice 1). This note used to read "starting
// fuelHoard is always 0 ... minting fuel into a hoard would need a fuel-genesis
// rule we have not decided". The rule is decided: a founding guild opens with
// GUILD_STARTING_FUEL (sim/fuel.js) in its hoard — the STARTER FLOOR ruled in
// docs/fuel-supply-and-allocation.md §1.3, which rules this apply by name. The
// galaxy opens already supplied because the fiction is that you are joining an
// ALREADY-RUNNING Syndicate; the trap it closes (a new guild at ~0 reputation
// with no fuel can never trade its way to any) is recorded a layer down, in
// fuel-economy.md §7, which §1.3 supersedes.
//
// Unlike credits, this fuel is MINTED, not moved: there is no fuel counterpart
// to the Syndicate ledger to debit (the reserve is a physical pool, not a
// balancing account), so genesis is honest about being genesis and pays for it
// in the audit — the apply below increments `audit.totalProduced` by exactly the
// grant, which is how invariant 1 balances from tick 0. It stays ENGINE POLICY,
// not an action field — exactly like the starter asset gift — so the action
// shape is unchanged and no caller can ask for a different hoard.
//
// homeSystemId (design.md §13, decided 03-08-26): every guild enters ON a
// starter-eligible system (one holding >=1 Terran planet), so it is REQUIRED.
// Founding claims that system for the guild and seats it on the system's Terran
// homeworld. The claim is the ownership source of truth; the guild's
// homeSystemId/homePlanetId are the denormalised pointer (invariants.js guards
// the match). The genesis home-claim deliberately does NOT grant the "+20 on
// claiming an uncontested system" earn bonus — that is for play actions, not
// setup — so a guild starts at exactly its passed influence.
function createFoundGuildAction({
  guildId, name, isBot = false, credits, influence = 0, incomeRate = 0, homeSystemId, ventures = [],
}) {
  if (guildId === undefined) throw new Error('createFoundGuildAction: guildId is required');
  if (credits === undefined) throw new Error('createFoundGuildAction: credits is required');
  if (homeSystemId === undefined) throw new Error('createFoundGuildAction: homeSystemId is required');
  return { type: 'foundGuild', guildId, name, isBot, credits, influence, incomeRate, homeSystemId, ventures };
}

// Establishing a venture: seating a NEW venture belonging to an existing guild
// onto a real seed site, so it starts producing on the next tick. Two kinds:
//   - MINING (`type: 'mining'`): on a resource NODE. `resourceType` must match
//     the node's good. Extracts `productionRate` units/tick.
//   - REFINING (`type: 'refining'`, 03-08-26): on a SETTLEMENT SLOT. `recipeId`
//     must be a known recipe (recipes.js). Runs up to `productionRate` batches/
//     tick, consuming the recipe's input good from and producing its output good
//     into the owner's stockpile (throttled by available input — tick.js).
// Each rule is validated up front, mirroring the occupancy invariant, so a bad
// request is refused cleanly rather than applied-then-halted. Deploying also has
// THREE gates (design.md §4, 30-08-26) — a vacant node, the NAMED idle asset of the
// matching kind in the guild's inventory, and the guild holding the node's system —
// and on success that named asset is OCCUPIED (the venture's `assetId` points at it).
// `assetId` is REQUIRED and the CALLER'S choice (31-08-26): which machine goes onto
// which site is a player decision, not the engine's tie-break, so the deploy names
// it and validation proves it is owned, idle and of the matching kind. (Founding is
// unaffected — a `foundGuild`'s inline ventures still draw from the starter pool that
// same founding mints, where there is no inventory for a caller to name.)
// `productionRate` is OPTIONAL (design.md §2 "A mine's yield IS its establish rate",
// 24-09-26). Omitted, the ENGINE stamps the venture's droidless baseline as its rate
// (`baselineRateFor`, sim/baseline.js): a mine's units/tick, a factory's batches/tick.
// That is the rate its licence is priced off, so a licensed venture commits a share of
// what it really makes. The game client sends no rate. Named, it is honoured as given
// (the operator, a test scenario), validated as a positive integer; capping it at the
// baseline belongs to the deferred throttle-below / droids-above refactor.
// Establishing a venture moves no credits or fuel (no licence/site cost yet).
function createEstablishVentureAction({
  guildId, ventureId, type = 'mining', siteId, assetId, resourceType, recipeId, productionRate, equityPct,
}) {
  if (guildId === undefined) throw new Error('createEstablishVentureAction: guildId is required');
  if (ventureId === undefined) throw new Error('createEstablishVentureAction: ventureId is required');
  if (siteId === undefined) throw new Error('createEstablishVentureAction: siteId is required');
  if (assetId === undefined) throw new Error('createEstablishVentureAction: assetId is required');
  // Type-specific required field: a mining venture names the good it extracts;
  // a refining venture names the recipe it runs.
  if (type === 'mining' && resourceType === undefined) throw new Error('createEstablishVentureAction: resourceType is required for a mining venture');
  if (type === 'refining' && recipeId === undefined) throw new Error('createEstablishVentureAction: recipeId is required for a refining venture');
  // `ventureType` (not `type`) in the action object, so it never collides with
  // the action's own discriminator `type: 'establishVenture'`.
  // productionRate and equityPct (`o`, §5's equity lever) are both OPTIONAL and each is
  // omitted from the action when not given, so a call that names both is byte-identical
  // to one made before either became optional (same keys, same order). With no equity
  // the venture lands at 0; with no rate the engine stamps its baseline (above).
  return {
    type: 'establishVenture', guildId, ventureId, ventureType: type, siteId, assetId, resourceType, recipeId,
    ...(productionRate === undefined ? {} : { productionRate }),
    ...(equityPct === undefined ? {} : { equityPct }),
  };
}

// establishRateFor(action) -> the productionRate an establishVenture action seats its
// venture at: the caller's own rate when it names one, else the venture's droidless
// baseline (design.md §2), or null when it names none and there is no baseline to stamp.
// ONE function, read by both validation (which refuses the null) and the apply (which
// stores the answer), so what was approved and what is written cannot disagree.
// The baseline is keyed by the venture TYPE the action declares: a mine by the good it
// extracts, a factory by the recipe it runs.
function establishRateFor(action) {
  if (action.productionRate !== undefined) return action.productionRate;
  const ventureType = action.ventureType || 'mining';
  return baselineRateFor(ventureType === 'mining'
    ? { resourceType: action.resourceType }
    : { recipeId: action.recipeId });
}

// Setting a guild's System Production Profile: storing, for ONE (guildId,
// systemId), an optional per-good Gate-1 policy and/or optional per-venture
// Gate-3 throttles (§5, §15.4) — the standing policy stepProduction will read to
// route each good through the three gates. This slice only STORES it: no tick
// step reads the profile yet (that is slice 2a-ii), so applying this action is a
// behavioural no-op on production. Both `goods` and `throttles` are optional; an
// action may set one, the other, or both, and it MERGES into the guild's profile
// (per §15.4's sparse, standing-policy shape) rather than replacing it.
function createSetProductionProfileAction({ guildId, systemId, goods, throttles }) {
  if (guildId === undefined) throw new Error('createSetProductionProfileAction: guildId is required');
  if (systemId === undefined) throw new Error('createSetProductionProfileAction: systemId is required');
  return { type: 'setProductionProfile', guildId, systemId, goods, throttles };
}

// --- Commitment-injection dev scaffold (design.md §15.4 "Scaffold 11-08-26", §5;
// roadmap Phase 1 Stage 2). Two DELIBERATELY THROWAWAY dev-scaffold actions that
// set the windowed-accrual placeholders at runtime on the live in-memory server —
// so a test scenario can light the console's commitment bar and give a scripted
// bot real targets BEFORE the real Licence entity exists. They only write existing
// state the windowed engine already reads (Venture.syndicateCommitment, state.
// windowN); NO engine/resolver/snapshot-schema change, NO fee, NO credits (breach
// stays status-only). When the real Licence grant lands it becomes
// syndicateCommitment's source and these setters retire.

// setSyndicateCommitment: write ONE venture's per-tick committed quantity — the
// venture field the resolver sums into the per-good aggregate target Q (§5). An
// integer ≥ 0; 0 clears back to unlicensed. It does NOT set committedFromTick, so a
// scaffold-committed venture stays FULL-WINDOW by design: windowFraction reads a
// missing stamp as "present since before the window opened" and returns 1. Moves no
// credits/fuel.
function createSetSyndicateCommitmentAction({ guildId, ventureId, commitment }) {
  if (guildId === undefined) throw new Error('createSetSyndicateCommitmentAction: guildId is required');
  if (ventureId === undefined) throw new Error('createSetSyndicateCommitmentAction: ventureId is required');
  if (commitment === undefined) throw new Error('createSetSyndicateCommitmentAction: commitment is required');
  return { type: 'setSyndicateCommitment', guildId, ventureId, commitment };
}

// applyForLicence: grant ONE mining venture a Syndicate Venture Licence — the real
// player path the throwaway `setSyndicateCommitment` scaffold above stands in for
// (design.md §5 "LICENCE FEE MECHANICS — RULED", Slice 3b-i). The player offers a
// share of the venture's droidless BASELINE output and a renegotiation window in days;
// the Syndicate does not negotiate — it has fixed terms keyed to what you offer, so
// everything else (the fee, and the commitment quantity the window machinery reads) is
// COMPUTED at apply time from the terms plus the posted price at that tick, and stored.
// The equity lever `o` is not set here: it is a term of the venture, offered at
// establishment (Slice 3a), and the fee simply reads it.
//
// Grants are once-only. Re-applying is RENEGOTIATION — window-gated and, with
// investors, a 75% majority (§5, #57) — which this slice does not build, so a second
// application on the same venture is refused rather than quietly re-locking the terms
// at today's price.
function createApplyForLicenceAction({ guildId, ventureId, committedOutputPct, windowDays }) {
  if (guildId === undefined) throw new Error('createApplyForLicenceAction: guildId is required');
  if (ventureId === undefined) throw new Error('createApplyForLicenceAction: ventureId is required');
  if (committedOutputPct === undefined) throw new Error('createApplyForLicenceAction: committedOutputPct is required');
  if (windowDays === undefined) throw new Error('createApplyForLicenceAction: windowDays is required');
  return { type: 'applyForLicence', guildId, ventureId, committedOutputPct, windowDays };
}

// renegotiateLicence: accept the Syndicate's new terms for a licensed venture whose
// committed window has ELAPSED, and re-lock the licence in place (design.md §5 "Licence
// renegotiation — the terms function & venture standing"; #64 Slice 1). The near-mirror
// of `applyForLicence`, with three deliberate differences: the terms are the Syndicate's
// (read off the venture's standing, `renegotiationTerms`), not the player's; the fee
// re-locks at TODAY's posted price with the Strong-band discount baked in; and there is
// NO signing bump — the venture's RP carries untouched (§5 "On accept").
//
// The player authors no terms here — after the first signing they never offer terms
// (§5) — so the action carries only which venture to renegotiate. It is player-PULL:
// invoked explicitly, no timer initiates it and nothing lapses if it is not invoked
// (both Slice 2).
function createRenegotiateLicenceAction({ guildId, ventureId }) {
  if (guildId === undefined) throw new Error('createRenegotiateLicenceAction: guildId is required');
  if (ventureId === undefined) throw new Error('createRenegotiateLicenceAction: ventureId is required');
  return { type: 'renegotiateLicence', guildId, ventureId };
}

// lapseLicence: the OTHER end of a reopened licence (design.md §5 "Accept or lapse") — the
// LAPSE-TO-UNLICENSED operation the player reaches by REJECTing a renegotiation. It shares
// `renegotiateLicence`'s gate exactly (you can only lapse a licence that is up for
// renegotiation: an ordinary, non-deuterium licence whose committed window has elapsed), and
// its apply mirrors `decommissionVenture`'s RP-forfeit + commitment-clear — but KEEPS the
// venture, its node and its assets in place (decommission removes the venture; lapse reverts
// it to unlicensed). No fee, no node lockout, no signing bump.
//
// This is a deliberate strategic escape (§5), not an exploit: the least-painful way out from
// under Syndicate terms a guild no longer wants, paid for in forfeited standing. Slice 2's
// acceptance-window timeout will reuse this SAME action to auto-lapse; here it is only the
// player-PULL half (the explicit REJECT). Shape is `{ guildId, ventureId }` — the player
// authors no terms (§5).
function createLapseLicenceAction({ guildId, ventureId }) {
  if (guildId === undefined) throw new Error('createLapseLicenceAction: guildId is required');
  if (ventureId === undefined) throw new Error('createLapseLicenceAction: ventureId is required');
  return { type: 'lapseLicence', guildId, ventureId };
}

// acknowledgeEvent: mark ONE event-log notice READ (docs/event-log.md §3). The player's
// "I've seen this" on a Notices row — it does not delete the notice, it stamps `readTick`,
// which shortens the notice's remaining display life (RETENTION_READ_TICKS, sim/events.js §4)
// and drops it from the unread badge. Shape is `{ guildId, eventId }`; `eventId` is the
// per-guild counter id `recordEvent` assigned. It is PLAYER-SET state — the tick never reads
// `readTick` to compute a game number (invariant 8 untouched: this moves no reputation, no
// credits, no goods).
function createAcknowledgeEventAction({ guildId, eventId }) {
  if (guildId === undefined) throw new Error('createAcknowledgeEventAction: guildId is required');
  if (eventId === undefined) throw new Error('createAcknowledgeEventAction: eventId is required');
  return { type: 'acknowledgeEvent', guildId, eventId };
}

// licenseDeuteriumMine: grant ONE deuterium mining venture the WINDOWLESS deuterium
// licence (§1.4 "The Deuterium Cycle", docs/fuel-supply-and-allocation.md) — the
// player-driven supply lever. This is a SEPARATE path from `applyForLicence`, not an
// option on it: the deuterium licence is 100%-committed, fee-less, window-less and
// breach-less, so it shares essentially none of that action's mechanics and must not
// route through the windowed `Venture.licence` the fee/window/breach machinery reads.
//
// It takes NO terms. Commitment is 100% implicit (a licensed deuterium mine surrenders
// all output), there is no fee and no window, and equity is whatever the venture already
// offered at establishment (`equityPct`) — this action neither sets nor changes it. So
// the shape is exactly `{ guildId, ventureId }` and nothing more.
//
// Grants are once-only and mutually exclusive with the ordinary licence — validateAction
// refuses a venture that already carries either. RP (the §1.4 T4 weighting) is DEFERRED
// to a later slice; this action grants the licence and the per-tick auto-sale, no RP.
function createLicenseDeuteriumMineAction({ guildId, ventureId }) {
  if (guildId === undefined) throw new Error('createLicenseDeuteriumMineAction: guildId is required');
  if (ventureId === undefined) throw new Error('createLicenseDeuteriumMineAction: ventureId is required');
  return { type: 'licenseDeuteriumMine', guildId, ventureId };
}

// establishDeuteriumRefinery: seat a new ILLEGAL DEUTERIUM REFINERY — a factory venture on a
// settlement slot that runs the special 1:1 `deuterium → deuterium_fuel` conversion guild-wide
// (§1.4 "The illegal path, made concrete", slice 1b). It mirrors `establishVenture` for a
// factory — it NAMES the idle factory asset it occupies (Gate 2) and a settlement slot the
// guild holds — but takes NO recipeId: there is no recipe, the conversion is a dedicated tick
// step. There is no legal guild refinery (the Syndicate's legal conversion is the abstract pool
// mint), so a guild deuterium refinery is inherently illegal — no licence, no equity, zero GP,
// zero RP. `productionRate` is the factory's per-tick conversion rate (operator-supplied, as on
// establishVenture — refinery throughput is unruled). Moves no credits or fuel.
function createEstablishDeuteriumRefineryAction({ guildId, ventureId, siteId, assetId, productionRate }) {
  if (guildId === undefined) throw new Error('createEstablishDeuteriumRefineryAction: guildId is required');
  if (ventureId === undefined) throw new Error('createEstablishDeuteriumRefineryAction: ventureId is required');
  if (siteId === undefined) throw new Error('createEstablishDeuteriumRefineryAction: siteId is required');
  if (assetId === undefined) throw new Error('createEstablishDeuteriumRefineryAction: assetId is required');
  if (productionRate === undefined) throw new Error('createEstablishDeuteriumRefineryAction: productionRate is required');
  return { type: 'establishDeuteriumRefinery', guildId, ventureId, siteId, assetId, productionRate };
}

// decommissionVenture: CLOSE a venture the guild owns (docs/venture-teardown.md §1). The
// mirror image of establishVenture — that one seats a venture and occupies an asset; this
// removes one and frees its site and asset (both DERIVED, so for free — §0). The settlement
// is COMPUTED by the engine, never passed in — the same discipline the licence fee follows —
// so the shape is exactly `{ guildId, ventureId }` and nothing more. What it costs depends on
// what the venture was (§3): an unlicensed venture closes clean; an ordinary-licensed one
// forfeits its RP (automatic), pays out its remaining contract fee, and locks its node to the
// owner until the term ends. A licensed deuterium mine is refused this slice (§6).
function createDecommissionVentureAction({ guildId, ventureId }) {
  if (guildId === undefined) throw new Error('createDecommissionVentureAction: guildId is required');
  if (ventureId === undefined) throw new Error('createDecommissionVentureAction: ventureId is required');
  return { type: 'decommissionVenture', guildId, ventureId };
}

// establishDockyard: seat a new TIER-4 BUILD YARD (docs/build-yard.md §2, roadmap 2.1b slice 1) —
// a factory venture on a settlement slot in CONSTRUCT mode, turning modules into finished assets
// via its commission queue. It mirrors `establishDeuteriumRefinery` for a factory — it NAMES the
// idle factory asset it occupies (Gate 2) and a settlement slot the guild holds — but takes NO
// `recipeId` AND NO `productionRate`: a dockyard does not produce continuously (the `createVenture`
// default rate 0, which resolveProduction skips), it builds via its queue. No licence, no equity,
// no RP this slice (GP/RP-neutral). Moves no credits or fuel. Shape is exactly
// `{ guildId, ventureId, siteId, assetId }`.
function createEstablishDockyardAction({ guildId, ventureId, siteId, assetId }) {
  if (guildId === undefined) throw new Error('createEstablishDockyardAction: guildId is required');
  if (ventureId === undefined) throw new Error('createEstablishDockyardAction: ventureId is required');
  if (siteId === undefined) throw new Error('createEstablishDockyardAction: siteId is required');
  if (assetId === undefined) throw new Error('createEstablishDockyardAction: assetId is required');
  return { type: 'establishDockyard', guildId, ventureId, siteId, assetId };
}

// commissionBuild: append a build of `assetKind` to a dockyard's queue (docs/build-yard.md §3).
// NO COST at commission — the modules are consumed only when the build actually starts (the
// reserve-and-wait step, sim/tick.js). Validated: the venture is a dockyard the guild owns, the
// kind is buildable, and the queue is not already full (MAX_QUEUE). Shape is exactly
// `{ guildId, ventureId, assetKind }`.
function createCommissionBuildAction({ guildId, ventureId, assetKind }) {
  if (guildId === undefined) throw new Error('createCommissionBuildAction: guildId is required');
  if (ventureId === undefined) throw new Error('createCommissionBuildAction: ventureId is required');
  if (assetKind === undefined) throw new Error('createCommissionBuildAction: assetKind is required');
  return { type: 'commissionBuild', guildId, ventureId, assetKind };
}

// cancelCommission: remove a commission that HAS NOT STARTED from a dockyard's queue
// (docs/build-yard.md §3) — a pending one, or the head still waiting for parts. Addressed by the
// stable `commissionId` stamped at commission time, NOT an array index (an index shifts when the
// head is consumed off). A build that has STARTED (parts consumed, ticking) cannot be cancelled —
// only tearing down the dockyard stops it. Nothing was consumed for an unstarted commission, so
// nothing is refunded. Shape is exactly `{ guildId, ventureId, commissionId }`.
function createCancelCommissionAction({ guildId, ventureId, commissionId }) {
  if (guildId === undefined) throw new Error('createCancelCommissionAction: guildId is required');
  if (ventureId === undefined) throw new Error('createCancelCommissionAction: ventureId is required');
  if (commissionId === undefined) throw new Error('createCancelCommissionAction: commissionId is required');
  return { type: 'cancelCommission', guildId, ventureId, commissionId };
}

// --- Operator adjust levers (docs/operator-adjust.md) -------------------------
//
// Six OPERATOR/DEV actions that GRANT or REMOVE a guild's producible state —
// credits, fuel, goods, assets — plus remove a venture (the dev/steward testbed
// tool, §1). They are ordinary engine actions (validate + apply), so they ride
// `POST /action` and are journaled + invariant-checked for free, the same species
// as setSyndicateCommitment/setWindowN (§5). The one rule (§2): an adjust never just
// "writes a field" — each does the CONSERVING COUNTER-MOVE its quantity requires, so
// the §15.5 tripwires stay whole. The scalar levers take a SIGNED `delta` (positive
// grants, negative removes) so one action covers both directions. The operator
// surface is tools/admin.js; the player client never surfaces them.

// adjustCredits: move credits against the Syndicate ledger, exactly as founding does
// (§3.1) — apply debits `syndicate.ledger` by the same delta it credits the guild, so
// invariant 2's total is unchanged. A non-zero integer delta.
function createAdjustCreditsAction({ guildId, delta }) {
  if (guildId === undefined) throw new Error('createAdjustCreditsAction: guildId is required');
  if (delta === undefined) throw new Error('createAdjustCreditsAction: delta is required');
  return { type: 'adjustCredits', guildId, delta };
}

// adjustFuel: the legal `fuelHoard`, framed as backend production/consumption so it is
// invisible to the market (§3.2) — a grant raises `audit.totalProduced`, a removal
// raises `audit.totalConsumed`, so invariant 1 stays closed. Targets the legal hoard
// only, never contraband `deuteriumFuel`. A non-zero integer delta.
function createAdjustFuelAction({ guildId, delta }) {
  if (guildId === undefined) throw new Error('createAdjustFuelAction: guildId is required');
  if (delta === undefined) throw new Error('createAdjustFuelAction: delta is required');
  return { type: 'adjustFuel', guildId, delta };
}

// adjustGoods: a (guild, systemId) stockpile cell (§3.3). Goods have no conservation
// ledger, so the only bookkeeping is refreshing the `galacticSupply` cache in the same
// apply (the founding precedent) so the consistency invariant passes. A non-zero
// integer delta into a real system's cell of a known good.
function createAdjustGoodsAction({ guildId, systemId, good, delta }) {
  if (guildId === undefined) throw new Error('createAdjustGoodsAction: guildId is required');
  if (systemId === undefined) throw new Error('createAdjustGoodsAction: systemId is required');
  if (good === undefined) throw new Error('createAdjustGoodsAction: good is required');
  if (delta === undefined) throw new Error('createAdjustGoodsAction: delta is required');
  return { type: 'adjustGoods', guildId, systemId, good, delta };
}

// grantAsset: mint one IDLE machine into the guild's inventory (§3.4) — a fresh
// `asset_<guildId>_<kind>_NN` id (max existing + 1), new condition, attached to no
// venture. `kind` must be a buildable asset kind; `systemId` a real system. There is
// no negative form — an asset is removed by id via removeAsset.
function createGrantAssetAction({ guildId, kind, systemId }) {
  if (guildId === undefined) throw new Error('createGrantAssetAction: guildId is required');
  if (kind === undefined) throw new Error('createGrantAssetAction: kind is required');
  if (systemId === undefined) throw new Error('createGrantAssetAction: systemId is required');
  return { type: 'grantAsset', guildId, kind, systemId };
}

// removeAsset: remove the named asset (§3.5). `occupied` decides an occupied asset's
// venture: `'detach'` (default) nulls the venture's `assetId` and leaves it dormant;
// `'close'` tears the venture down through the shared closure first. An idle asset is
// just deleted. Reject only an unknown `assetId`.
function createRemoveAssetAction({ guildId, assetId, occupied }) {
  if (guildId === undefined) throw new Error('createRemoveAssetAction: guildId is required');
  if (assetId === undefined) throw new Error('createRemoveAssetAction: assetId is required');
  return { type: 'removeAsset', guildId, assetId, ...(occupied === undefined ? {} : { occupied }) };
}

// removeVenture: tear a venture down through the shared closure, cause `'operator'`
// (§3.6). `asset` decides its machine: `'keep'` (default) drops it to idle inventory;
// `'remove'` deletes it too. Reject only an unknown `ventureId`. This removes ventures;
// it does not create them (establishVenture is the game's path).
function createRemoveVentureAction({ guildId, ventureId, asset }) {
  if (guildId === undefined) throw new Error('createRemoveVentureAction: guildId is required');
  if (ventureId === undefined) throw new Error('createRemoveVentureAction: ventureId is required');
  return { type: 'removeVenture', guildId, ventureId, ...(asset === undefined ? {} : { asset }) };
}

// spawnVehicle: mint one IDLE craft into a guild at any location — the operator/Storyteller
// primitive (design.md §15.4 "Spawn / remove"). `class` is one of the four transport classes;
// `location` is EXACTLY ONE of a landmark ref `{ landmarkKind, landmarkId }` (system | outpost)
// or a bare hex `{ q, r }`; `condition` is the optional starting maintenanceCondition (default
// new / 1). It touches no credits/fuel/points/reputation/claims — a vehicle feeds none of them.
// It MINTS craft; a craft is destroyed by id via removeVehicle.
function createSpawnVehicleAction({ guildId, class: vehicleClass, location, condition }) {
  if (guildId === undefined) throw new Error('createSpawnVehicleAction: guildId is required');
  if (vehicleClass === undefined) throw new Error('createSpawnVehicleAction: class is required');
  if (location === undefined) throw new Error('createSpawnVehicleAction: location is required');
  return {
    type: 'spawnVehicle', guildId, class: vehicleClass, location,
    ...(condition === undefined ? {} : { condition }),
  };
}

// removeVehicle: DESTROY the named craft (design.md §15.4 "Spawn / remove") — not a recall.
// Drops the row from `guild.vehicles`; the guild's mint serial is untouched (never decrements),
// so the removed id is never reissued. Reject only an unknown craft id. This removes craft; it
// does not create them (spawnVehicle / buy / build are the mint paths).
function createRemoveVehicleAction({ guildId, vehicleId: vId }) {
  if (guildId === undefined) throw new Error('createRemoveVehicleAction: guildId is required');
  if (vId === undefined) throw new Error('createRemoveVehicleAction: vehicleId is required');
  return { type: 'removeVehicle', guildId, vehicleId: vId };
}

// spawnOutpost: place one guild Outpost — the operator primitive (design.md §4 "Placed, fixed,
// destructible", §15.4; roadmap 2.2, the outpost ladder slice 1). Anchors to `anchorSystemId` (a
// real system) and occupies the single hex `coords` ({ q, r }). The operator places FREELY, exactly
// as `spawnVehicle` does: placement RANGE to the anchor and requiring the guild to HOLD the anchor
// system are DEFERRED to the real build/deploy slice (§4). It touches no credits/fuel/points/
// reputation/claims — an outpost feeds none of them this slice. It MINTS an outpost; one is destroyed
// by id via removeOutpost.
function createSpawnOutpostAction({ guildId, anchorSystemId, coords }) {
  if (guildId === undefined) throw new Error('createSpawnOutpostAction: guildId is required');
  if (anchorSystemId === undefined) throw new Error('createSpawnOutpostAction: anchorSystemId is required');
  if (coords === undefined) throw new Error('createSpawnOutpostAction: coords is required');
  return { type: 'spawnOutpost', guildId, anchorSystemId, coords };
}

// removeOutpost: TEAR DOWN the named outpost (design.md §4 "torn down permanently") — a plain delete
// this slice. Drops the row from `state.outposts`; the guild's mint serial is untouched (never
// decrements), so the removed id is never reissued. Reject an unknown outpost or one this guild does
// not own. This removes outposts; it does not create them (spawnOutpost is the mint path).
function createRemoveOutpostAction({ guildId, outpostId: oId }) {
  if (guildId === undefined) throw new Error('createRemoveOutpostAction: guildId is required');
  if (oId === undefined) throw new Error('createRemoveOutpostAction: outpostId is required');
  return { type: 'removeOutpost', guildId, outpostId: oId };
}

// dispatchVehicle: send an IDLE craft along a multi-leg route (transport-model.md §4, the polyline
// model). `waypoints` is a non-empty ordered array of location anchors — each the same shape a
// craft's `location` uses ({ landmarkKind: 'system'|'outpost', landmarkId } or { q, r }). The route
// is built from the craft's current location through the waypoints (leg 0: craft → waypoints[0];
// leg K: waypoints[K-1] → waypoints[K]); the whole route's fuel is burned from the hoard UP FRONT.
// No `isToll` in the action — there is no toll infrastructure to select yet, so every leg flies open
// space (§4); the buff path lives in the leg math for the later toll slice.
function createDispatchVehicleAction({ guildId, vehicleId: vId, waypoints }) {
  if (guildId === undefined) throw new Error('createDispatchVehicleAction: guildId is required');
  if (vId === undefined) throw new Error('createDispatchVehicleAction: vehicleId is required');
  if (waypoints === undefined) throw new Error('createDispatchVehicleAction: waypoints is required');
  return { type: 'dispatchVehicle', guildId, vehicleId: vId, waypoints };
}

// transferCargo: load/unload an IDLE craft against the SYSTEM it sits at (design.md §4 "The dock
// model", the system half; roadmap 2.2 cargo engine slice 1). `manifest` is an ordered array of
// `{ dir: 'load' | 'unload', good, qty }` lines. At a system the transfer is INSTANT — it resolves
// the tick it is issued, no slot, no wait (§4 "At a system, a transfer is instant"); the Outpost
// park/queue/slot/turnaround is a later slice, and a craft anywhere but a system is refused. Mirrors
// createDispatchVehicleAction: the constructor only enforces the required fields are present;
// validateAction judges legality (guild owns an idle craft at a system, well-formed manifest).
function createTransferCargoAction({ guildId, vehicleId: vId, manifest }) {
  if (guildId === undefined) throw new Error('createTransferCargoAction: guildId is required');
  if (vId === undefined) throw new Error('createTransferCargoAction: vehicleId is required');
  if (manifest === undefined) throw new Error('createTransferCargoAction: manifest is required');
  return { type: 'transferCargo', guildId, vehicleId: vId, manifest };
}

// dispatchRouteWithActions: send an IDLE craft along a route whose waypoints can carry a load/unload
// ACTION, executed automatically as the craft arrives at each stop (transport-model.md §11, roadmap
// 2.2 automation slice 1a — the chained-legs model). `waypoints` is a non-empty ordered array of
// `{ anchor, action? }`: `anchor` is the same location shape a plain dispatch waypoint uses
// ({ landmarkKind, landmarkId } or { q, r }); `action` (optional) is `{ type: 'dock', manifest }`, the
// §4 load/unload manifest fired on arrival. Unlike the plain frozen `dispatchVehicle` (§11.2 — left
// as-is for no-action routes), this flies leg by leg: the whole run's fuel burns UP FRONT (§11.3,
// legs are known even though timing is not), the route + a cursor are journalled onto the craft, and
// each leg is re-dispatched by the tick hooks (`advanceRoute`) as the craft completes the stop before
// it. The constructor only enforces the required fields are present; validateAction judges legality
// (idle owned craft, resolvable non-zero legs, well-formed actions, spycraft-with-an-action refused,
// lap-1 fuel affordable, a well-formed `repeat`).
//
// `repeat` (optional, slice 3a — transport-model.md §11.10) is the LAUNCH MODE: `{ mode: 'once' }` (the
// default — run the waypoints once and land idle at the last), `{ mode: 'continuous' }` (keep cycling
// until stopped or the lane ends) or `{ mode: 'nRun', n }` (exactly n full cycles). A repeating mode may
// also carry a `cadence` (slice 3a.1): 'immediate' (the default — the next lap starts the moment the
// last one finishes) or 'perCycle' (at most one lap per fuel cycle). It rides the action only when
// given, so a one-shot dispatch journals byte-identically to the pre-repeat one.
function createDispatchRouteWithActionsAction({
  guildId, vehicleId: vId, waypoints, repeat,
}) {
  if (guildId === undefined) throw new Error('createDispatchRouteWithActionsAction: guildId is required');
  if (vId === undefined) throw new Error('createDispatchRouteWithActionsAction: vehicleId is required');
  if (waypoints === undefined) throw new Error('createDispatchRouteWithActionsAction: waypoints is required');
  return {
    type: 'dispatchRouteWithActions', guildId, vehicleId: vId, waypoints,
    ...(repeat !== undefined ? { repeat } : {}),
  };
}

// stopRouteAfterRun: the "Stop after this run" control (transport-model.md §11.10, slice 3a — the engine
// half; the Operations button is slice 3c). A REPEATING lane finishes the lap it is on, lands idle at WN
// and ends — a clean stop, no snap. The constructor only enforces the required fields are present;
// validateAction judges legality (the guild's craft is running a repeating lane not already stopping).
function createStopRouteAfterRunAction({ guildId, vehicleId: vId }) {
  if (guildId === undefined) throw new Error('createStopRouteAfterRunAction: guildId is required');
  if (vId === undefined) throw new Error('createStopRouteAfterRunAction: vehicleId is required');
  return { type: 'stopRouteAfterRun', guildId, vehicleId: vId };
}

// cancelRoute: the "Cancel" control (transport-model.md §11.10, slice 3b — the engine half; the Operations
// button is slice 3c). The craft's lane ends AT ONCE: a craft in flight snaps to the hex it is over and goes
// idle there; a craft parked mid-lane (waiting at its last stop, or at an Outpost stop) just drops its route
// where it sits. The constructor only enforces the required fields are present; validateAction judges
// legality (the guild's craft is on a lane — flying, or holding a route).
function createCancelRouteAction({ guildId, vehicleId: vId }) {
  if (guildId === undefined) throw new Error('createCancelRouteAction: guildId is required');
  if (vId === undefined) throw new Error('createCancelRouteAction: vehicleId is required');
  return { type: 'cancelRoute', guildId, vehicleId: vId };
}

// saveRoute: store a NAMED, origin-free route on the guild so it can be loaded onto any craft later
// (transport-model.md §11.9, roadmap 2.2 automation slice 2a). `waypoints` is the SAME §11.1 list a
// dispatchRouteWithActions takes (`[{ anchor, action? }]`). NAME-BASED UPSERT: a name the guild is not
// yet using CREATES a saved route (a fresh `route_<guild>_NN` id); a name it already uses UPDATES that
// route's waypoints in place (same id). Pure guild-owned bookkeeping — it moves no goods, fuel or credits.
function createSaveRouteAction({ guildId, name, waypoints }) {
  if (guildId === undefined) throw new Error('createSaveRouteAction: guildId is required');
  if (name === undefined) throw new Error('createSaveRouteAction: name is required');
  if (waypoints === undefined) throw new Error('createSaveRouteAction: waypoints is required');
  return { type: 'saveRoute', guildId, name, waypoints };
}

// deleteRoute: remove one of the guild's saved routes by id (transport-model.md §11.9). The guild's
// saved-route serial is NOT decremented, so the deleted id is never reissued. Rename is delete + re-save.
function createDeleteRouteAction({ guildId, routeId }) {
  if (guildId === undefined) throw new Error('createDeleteRouteAction: guildId is required');
  if (routeId === undefined) throw new Error('createDeleteRouteAction: routeId is required');
  return { type: 'deleteRoute', guildId, routeId };
}

// setWindowN: set the single engine-wide accrual window length `state.windowN`. The
// codebase's FIRST state-scoped action — window length is engine-wide state, not a
// guild's, so there is NO guildId. An integer ≥ 1, settable ONLY before the run
// starts (setup-only knob, fixed before tick 0).
function createSetWindowNAction({ windowN }) {
  if (windowN === undefined) throw new Error('createSetWindowNAction: windowN is required');
  return { type: 'setWindowN', windowN };
}

// Selling stockpile goods to the Syndicate (design.md §5, "SELL GOES LIVE").
//
// The sale finalises the guild's HELD sell order from ONE origin (docs/syndicate-orders.md §5):
// many goods, one origin, one space-tiered leg. Which system a sale comes out of is a real
// supply-chain lever, because a factory draws its inputs from its OWN system's pile, so pulling
// stock out from under one must be the player's deliberate act — hence the finalise-time
// `originSystemId`, not an engine-picked default.
//
// `issueTick` (§8.1's quote-lock, RULED 04-09-26) is OPTIONAL: the confirm carries the
// tick the quote was ISSUED at, never a price, and the engine re-derives the resource
// price from its own per-tick ring at that tick (sim/price-ring.js). OMITTED ⇒ the
// current tick ⇒ age 0 ⇒ today's posted price ⇒ exactly the pre-quote-lock behaviour, so
// the action is byte-identical to before and every existing caller is unchanged. A PAST
// `issueTick` drives the lock; it is validated for expiry (TTL + cycle boundary) at
// intake. Omitted from the action object when not supplied, so its serialized shape is
// unchanged too.
// HELD-ORDER finalise (docs/syndicate-orders.md §5). Takes an `originSystemId`: it finalises the
// guild's `sellOrder` (many goods) from that one origin on one space-tiered leg. This is the only
// path — the legacy `good` + `allocations` multi-system form was RETIRED with the client slice (§8),
// as the deployed client sends only this shape.
function createSellToSyndicateAction({ guildId, originSystemId, issueTick }) {
  if (guildId === undefined) throw new Error('createSellToSyndicateAction: guildId is required');
  if (originSystemId === undefined) throw new Error('createSellToSyndicateAction: originSystemId is required');
  return {
    type: 'sellToSyndicate', guildId, originSystemId,
    ...(issueTick === undefined ? {} : { issueTick }),
  };
}

// Buying goods from the Syndicate, for SCHEDULED DELIVERY (design.md §6,
// "Syndicate Delivery — the BUY side").
//
// The deliberate asymmetry with SELL (§5): a sale is instant, so it can be
// pick-and-mixed across every system that holds the good; a purchase TRAVELS, so
// it commits to exactly ONE destination — one shipment, one destination, no
// splitting. Hence a single `destinationSystemId` where the sale takes a list.
//
// The destination is a PARAMETER, not something the engine picks: which system a
// player wants goods delivered to is a supply-chain decision, and there is no
// defensible default (the home system would be one invention, the largest pile
// another). The confirm popup that asks for it is the next slice; this action is
// complete and testable without it.
//
// A MULTI-GOOD CART from the HELD BUY ORDER (docs/syndicate-orders.md §5). The finalise reads
// `guild.buyOrder.lines` as the cart — several goods to ONE destination on ONE hauler, sized by
// the order's total cargo space (§5.1). This is the only path — the legacy inline `cart` and the
// single-good `{ good, qty }` forms were RETIRED with the client slice (§8), as the deployed
// client sends only this shape. `destinationSystemId` is always required.
//
// `issueTick` (§8.1's quote-lock) is OPTIONAL and behaves exactly as it does on the SELL
// side: omitted ⇒ the current tick ⇒ today's posted price; a past tick prices EACH good in the
// order from the ring at that one tick, validated for expiry. The route fuel it burns is seed
// geometry and moves only with the order's total-space tier.
function createBuyFromSyndicateAction({ guildId, destinationSystemId, issueTick }) {
  if (guildId === undefined) throw new Error('createBuyFromSyndicateAction: guildId is required');
  if (destinationSystemId === undefined) throw new Error('createBuyFromSyndicateAction: destinationSystemId is required');
  return {
    type: 'buyFromSyndicate', guildId, destinationSystemId,
    ...(issueTick === undefined ? {} : { issueTick }),
  };
}

// Buying a Tier-4 ASSET from the Syndicate (docs/asset-purchase.md, roadmap 2.1d) — the asset
// analogue of `buyFromSyndicate` above. Same shape, same gates, same quote-lock, same up-front
// fuel burn; only the price basis (a parts bill, not `qty × posted`) and the payload (an asset,
// not goods) differ. A purchase pays credits + fuel now, the Syndicate builds the asset centrally
// over `BUILD_TICKS`, then it ships as a standard delivery and mints an idle asset on arrival.
//
// `assetKind` is the machine to build (miner / factory — the only kinds with a buildable entity).
// `destinationSystemId` is where it lands: unlike the goods buy, presence is NOT required (an
// idle asset is guild inventory located at a system, like a dockyard's output — asset-purchase.md
// "Destination"). `issueTick` (§8.1 quote-lock) is OPTIONAL and behaves exactly as on the goods
// buy: omitted ⇒ current tick ⇒ today's posted parts prices.
function createBuyAssetFromSyndicateAction({ guildId, assetKind, destinationSystemId, issueTick }) {
  if (guildId === undefined) throw new Error('createBuyAssetFromSyndicateAction: guildId is required');
  if (assetKind === undefined) throw new Error('createBuyAssetFromSyndicateAction: assetKind is required');
  if (destinationSystemId === undefined) throw new Error('createBuyAssetFromSyndicateAction: destinationSystemId is required');
  return {
    type: 'buyAssetFromSyndicate', guildId, assetKind, destinationSystemId,
    ...(issueTick === undefined ? {} : { issueTick }),
  };
}

// --- The Syndicate ORDER build actions (docs/syndicate-orders.md §3) -----
//
// A Syndicate trade is now assembled as a held ORDER (a `buyOrder` / `sellOrder` on the guild,
// §2) line by line, then finalised. These three actions BUILD the order; the finalise reads it
// (buyFromSyndicate / sellToSyndicate below). They gate only on the LINE'S legality — a priced,
// non-fuel good and a positive-integer qty — NOT on capacity or stock: a draft may be built past
// a hauler's hold or a good's stock and trimmed later, and a sell line's origin (hence its stock)
// is not known until finalise (§3). `side` is `'buy'` or `'sell'`; the two orders are independent.

// addOrderLine: append `good` to the guild's `side` order, or TOP UP its existing line
// (qty += qty), keeping the order's lines one-per-good and sorted (§2). Creates the order on
// the first add (§3).
function createAddOrderLineAction({ guildId, side, good, qty }) {
  if (guildId === undefined) throw new Error('createAddOrderLineAction: guildId is required');
  if (side === undefined) throw new Error('createAddOrderLineAction: side is required');
  if (good === undefined) throw new Error('createAddOrderLineAction: good is required');
  if (qty === undefined) throw new Error('createAddOrderLineAction: qty is required');
  return { type: 'addOrderLine', guildId, side, good, qty };
}

// removeOrderLine: drop the `good` line from the guild's `side` order. When the order empties it
// is omitted (back to omit-when-empty, so it stops serializing — §3).
function createRemoveOrderLineAction({ guildId, side, good }) {
  if (guildId === undefined) throw new Error('createRemoveOrderLineAction: guildId is required');
  if (side === undefined) throw new Error('createRemoveOrderLineAction: side is required');
  if (good === undefined) throw new Error('createRemoveOrderLineAction: good is required');
  return { type: 'removeOrderLine', guildId, side, good };
}

// clearOrder: empty the guild's `side` order (also what a successful finalise does — §3).
function createClearOrderAction({ guildId, side }) {
  if (guildId === undefined) throw new Error('createClearOrderAction: guildId is required');
  if (side === undefined) throw new Error('createClearOrderAction: side is required');
  return { type: 'clearOrder', guildId, side };
}

// --- Validation -------------------------------------------------------

// orderFieldFor(side) -> the guild field a `side` names ('buyOrder' | 'sellOrder'), or null for a
// bad side. The one place `buy`/`sell` maps to a field, so the three build actions and the two
// finalises can never disagree (docs/syndicate-orders.md §2).
function orderFieldFor(side) {
  if (side === 'buy') return 'buyOrder';
  if (side === 'sell') return 'sellOrder';
  return null;
}

// compareGood(a, b) -> the stable good-id ordering the held-order lines are kept in (invariant 9),
// so the serialized order and every derived sum are reproducible (§2). Ascending by id.
function compareGood(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// buyFinalizeCart(state, action) -> the { good, qty } lines a BUY finalise ships: the guild's HELD
// buy order (`guild.buyOrder.lines`, docs/syndicate-orders.md §5). Called from BOTH validate and
// apply so they read one source. The inline `cart`/`good` intake was RETIRED with the client
// slice (§8).
function buyFinalizeCart(state, action) {
  const guild = findGuild(state, action.guildId);
  return (guild && guild.buyOrder && guild.buyOrder.lines) || [];
}

// A Gate-1 `order` is a PERMUTATION of exactly these three fork names (§15.4):
// same three, each once, any ordering. No more, no fewer, no strangers.
const FORK_NAMES = ['syndicate', 'downstream', 'stockpile'];
function isValidOrder(order) {
  if (!Array.isArray(order) || order.length !== FORK_NAMES.length) return false;
  const seen = new Set(order);
  return seen.size === order.length && FORK_NAMES.every((name) => seen.has(name));
}

function isIntInRange(n, lo, hi) {
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
}

function findGuild(state, guildId) {
  return state.guilds.find((g) => g.id === guildId);
}

// ownedOutpostAtCraft(state, guildId, craft) -> the guild's own Outpost the craft is berthed at, or
// null. A guild Outpost is NOT a location `landmarkKind` (design.md §4 / §15.4 — a first-class
// Outpost dispatch anchor is a later UX nicety); a craft is "at" an Outpost by HEX-COINCIDENCE — it
// was dispatched to the Outpost's `{q,r}`, so its idle `location` is a BARE HEX on that hex. This
// resolves the craft's coords and finds the OWN-ONLY (§4 — only the owning guild's craft dock) Outpost
// standing there. A system-berthed craft resolves to a landmark's coords, never an Outpost's (an
// Outpost cannot share a seed landmark's hex, checkOutpostIntegrity), so the system path is untouched.
function ownedOutpostAtCraft(state, guildId, craft) {
  return ownedOutpostAt(state, guildId, craft.location);
}

// ownedOutpostAt(state, guildId, anchor) -> the guild's own Outpost standing on `anchor`'s hex, or null
// — the anchor form of ownedOutpostAtCraft above (which asks it about the craft's location), so a route
// can ask the same question of a waypoint it has not reached yet.
function ownedOutpostAt(state, guildId, anchor) {
  const r = resolveVehicleLocation(anchor);
  if (!r) return null;
  const { q, r: rr } = r.coords;
  return (state.outposts || []).find(
    (o) => o.ownerGuildId === guildId && o.coords.q === q && o.coords.r === rr,
  ) || null;
}

// routeStoreAt(state, guildId, anchor) -> the STORE a route action at `anchor` works against, or null
// when there is none (transport-model.md §11.6 — the target is gone):
//   { kind: 'system', systemId } — a system landmark: the guild's (guild, system) pool (instant, §4);
//   { kind: 'outpost', outpost } — the guild's OWN Outpost on that hex (dock + turnaround, §4).
// THE ONE predicate for "does this stop still have a store", shared by the arrival resolver (the craft is
// there now) and the §11.10 lap-start re-check (the craft will be there this lap), so the re-check can
// never pass a target the arrival would then refuse, or the reverse. It mirrors transferCargo's split
// (a system, else an own Outpost, else nothing). NOTE: a system counts whoever holds it, exactly as the
// arrival always has — no path yet takes a system away from a guild (claims are a later territory item),
// so "a system lost" (§11.6) cannot happen today; when it can, this one predicate is where it goes.
function routeStoreAt(state, guildId, anchor) {
  if (anchor && anchor.landmarkKind === 'system') return { kind: 'system', systemId: anchor.landmarkId };
  const outpost = ownedOutpostAt(state, guildId, anchor);
  return outpost ? { kind: 'outpost', outpost } : null;
}

// manifestError(manifest) -> a reason string for the first thing wrong with a §4 load/unload manifest,
// or null when it is well-formed. THE ONE spelling of the manifest-shape gate, shared by the
// `transferCargo` validate (the manual/instant transfer) and the `dispatchRouteWithActions` validate
// (a waypoint's automatic action) — so a manifest fired manually and one fired on arrival are judged
// identically (transport-model.md §11.1 "validate it exactly as transferCargo does"). A manifest is a
// NON-EMPTY ordered array; each line is a { dir: 'load'|'unload', good, qty|max } with a real
// stockpile good and a well-formed amount half (the shared `manifestAmountError`).
function manifestError(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return 'manifest must be a non-empty array of { dir: "load"|"unload", good, qty } lines';
  }
  for (const line of manifest) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      return `each manifest line must be a { dir, good, qty | max } object, got ${JSON.stringify(line)}`;
    }
    if (line.dir !== 'load' && line.dir !== 'unload') {
      return `manifest line dir must be "load" or "unload", got ${JSON.stringify(line.dir)}`;
    }
    // A real stockpile good (isStockpileGood excludes fuel — a hold moves goods, never fuel, §4).
    // Every stockpile good is T1/T2/T3, so `volumeOf` can size it.
    if (typeof line.good !== 'string' || !isStockpileGood(line.good)) {
      return `${JSON.stringify(line.good)} is not a known stockpile good`;
    }
    // The amount half: a fixed positive-integer `qty` OR `max: true` (no qty) — never both, never
    // neither (design.md §4). The ONE spelling of that shape lives in sim/manifest.js.
    const amountError = manifestAmountError(line);
    if (amountError) return amountError;
  }
  return null;
}

// routeWaypointError(wp, i) -> a reason string for the first thing wrong with ONE { anchor, action? }
// route waypoint (transport-model.md §11.1), or null when it is well-formed. THE ONE spelling of the
// per-waypoint gate, shared by the `dispatchRouteWithActions` validate and the `saveRoute` validate — so
// a route saved for later and a route dispatched now are judged identically (§11.9 "the SAME per-waypoint
// checks"). It checks only what a waypoint is ON ITS OWN: the anchor resolves (a landmark that exists or
// an in-bounds hex), and the action, if present, is a { type: 'dock', manifest } with a well-formed §4
// manifest. Anything that needs a CRAFT — leg lengths, fuel, a spycraft's empty hold — is the dispatch's
// own gate, since a saved route has no craft and no origin. `i` numbers the waypoint in the reason.
function routeWaypointError(wp, i) {
  if (!wp || typeof wp !== 'object' || Array.isArray(wp)) {
    return `waypoint ${i} must be a { anchor, action? } object, got ${JSON.stringify(wp)}`;
  }
  // The same wording dispatchRoute uses for an unresolvable anchor, so either gate reads the same.
  if (resolveVehicleLocation(wp.anchor) === null) {
    return `waypoint ${i} does not resolve to a valid anchor — a landmark { landmarkKind: "system"|"outpost", landmarkId } that resolves, or an in-bounds hex { q, r }`;
  }
  if (wp.action !== undefined) {
    // The only action type today is 'dock' (§11.1 — the tag is what lets later types slot in).
    if (!wp.action || typeof wp.action !== 'object' || wp.action.type !== 'dock') {
      return `waypoint ${i} action must be { type: "dock", manifest } (the only action type is "dock", §11.1), got ${JSON.stringify(wp.action)}`;
    }
    // The manifest is judged exactly as a manual transferCargo manifest is (the shared gate).
    const mError = manifestError(wp.action.manifest);
    if (mError) return `waypoint ${i} action: ${mError}`;
  }
  return null;
}

// repeatError(repeat) -> a reason string for the first thing wrong with a dispatch's `repeat` launch
// mode (transport-model.md §11.10), or null when it is well-formed. Absent means `once` (the built
// one-shot). Otherwise it is `{ mode }` with `mode` one of the three REPEAT_MODES, and `n` — the number
// of full cycles — belongs to `nRun` alone: a whole number >= 1 there, and not present on the other two
// (a stray `n` on a continuous lane is a mistake worth refusing, not a value to quietly ignore).
// The optional `cadence` (slice 3a.1) is one of the CADENCES and belongs to a REPEATING mode only: a
// `once` run has no next lap to pace, so a cadence on it is refused for the same reason a stray `n` is.
function repeatError(repeat) {
  if (repeat === undefined) return null;
  if (!repeat || typeof repeat !== 'object' || Array.isArray(repeat)) {
    return `repeat must be { mode: "once"|"continuous"|"nRun", n?, cadence? }, got ${JSON.stringify(repeat)}`;
  }
  if (!REPEAT_MODES.includes(repeat.mode)) {
    return `repeat.mode must be one of ${REPEAT_MODES.map((m) => JSON.stringify(m)).join(' | ')}, got ${JSON.stringify(repeat.mode)}`;
  }
  if (repeat.mode === 'nRun') {
    if (!Number.isInteger(repeat.n) || repeat.n < 1) {
      return `an nRun lane needs n, a whole number of laps >= 1, got ${JSON.stringify(repeat.n)}`;
    }
  } else if (repeat.n !== undefined) {
    return `repeat.n is only for mode "nRun" — a ${JSON.stringify(repeat.mode)} lane has no lap count, got n ${JSON.stringify(repeat.n)}`;
  }
  if (repeat.cadence !== undefined) {
    if (repeat.mode === 'once') {
      return `repeat.cadence is only for a repeating lane — a "once" run has no next lap to pace, got cadence ${JSON.stringify(repeat.cadence)}`;
    }
    if (!CADENCES.includes(repeat.cadence)) {
      return `repeat.cadence must be one of ${CADENCES.map((c) => JSON.stringify(c)).join(' | ')}, got ${JSON.stringify(repeat.cadence)}`;
    }
  }
  return null;
}

// repeatStateFor(repeat) -> the repeat fields journalled onto a craft's `route` at launch (§11.10):
//   once (or absent) → {}                     — nothing: a one-shot route stays byte-identical to the
//                                               built one (omit-when-default);
//   continuous       → { mode: 'continuous', lapsDone: 0 };
//   nRun             → { mode: 'nRun', N: n, lapsRemaining: n, lapsDone: 0 }.
// `lapsDone` (slice 3a.1) counts COMPLETED laps UP from 0 on every repeating lane — the client's "lap k"
// read-out. An nRun also keeps `N`, the launched target, which never changes (the "of N" denominator), and
// `lapsRemaining`, which counts DOWN; finishLap moves the two counters together, so lapsDone +
// lapsRemaining is always N. A repeating lane launched `perCycle` also carries `cadence: 'perCycle'`;
// `immediate` is the default and is never written (omit-when-default).
// `repeat` is already validated (repeatError).
function repeatStateFor(repeat) {
  if (repeat === undefined || repeat.mode === 'once') return {};
  const cadence = repeat.cadence === 'perCycle' ? { cadence: 'perCycle' } : {};
  if (repeat.mode === 'nRun') {
    return { mode: 'nRun', N: repeat.n, lapsRemaining: repeat.n, lapsDone: 0, ...cadence };
  }
  return { mode: repeat.mode, lapsDone: 0, ...cadence };
}

// isDockedAt(outpost, vehicleId) -> true when the craft already holds a manifest at this Outpost —
// either waiting in its `queue` or serving a `slot`. The one-manifest-per-craft guard: a craft already
// queued/loading here cannot stack a second transfer (design.md §4 — I refuse rather than replace, so
// a pending manifest is never silently overwritten).
function isDockedAt(outpost, vehicleId) {
  return (outpost.queue || []).some((e) => e.vehicleId === vehicleId)
    || (outpost.slots || []).some((e) => e.vehicleId === vehicleId);
}

// cancelQueuedManifest(state, vehicleId) — drop the craft's pending Outpost manifest, if it has one
// (design.md §4 "a parked or queued craft is cancelled by being re-dispatched away — that drops its
// pending manifest"). THE ONE spelling of that cancel, shared by both dispatch applies (dispatchVehicle
// and dispatchRouteWithActions): a queued craft is plain `idle`, so it passes a dispatch's idle gate, and
// its queue entry must go before it flies — a stale entry would let the dock step later grab a craft that
// is in flight. A parked craft has no entry (a no-op); a LOADING craft never reaches a dispatch apply (the
// idle gate refused it — it runs to completion). The craft is queued at one Outpost at most, but the sweep
// is store-wide so a stray entry can never survive a dispatch. Keeps `queue` omit-when-empty. A mutator on
// the already-cloned `next`.
function cancelQueuedManifest(state, vehicleId) {
  for (const outpost of state.outposts || []) {
    if (!outpost.queue) continue;
    outpost.queue = outpost.queue.filter((e) => e.vehicleId !== vehicleId);
    if (outpost.queue.length === 0) delete outpost.queue;
  }
}

// Venture ids are unique across the whole galaxy, not just within a guild —
// scan every guild's ventures. Returns the venture or undefined.
function findVenture(state, ventureId) {
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.id === ventureId) return v;
    }
  }
  return undefined;
}

// Which venture (if any) currently sits on a site — the same lookup the
// occupancy invariant polices, used here to refuse a double-seating up front.
function siteOccupant(state, siteId) {
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      if (v.siteId === siteId) return v;
    }
  }
  return undefined;
}

// The LIVE node lockout on a site, if any (docs/venture-teardown.md §3.3). A lockout is
// written when an ordinary-licensed venture is torn down with contract time left, barring
// ANY re-establish on that node — the owner's included — until its abandoned term ends. An
// entry with `state.tick >= releaseTick` has EXPIRED: lazy expiry (§3.3) treats it as free
// here (this returns undefined for it) and the establish apply prunes the dead entry when the
// site is next built on. Returns the live entry, or undefined when the site is free.
function activeLockout(state, siteId) {
  return (state.nodeLockouts || []).find((l) => l.siteId === siteId && state.tick < l.releaseTick);
}

// pruneLockout(state, siteId) — LAZY EXPIRY (docs/venture-teardown.md §3.3): drop any node
// lockout on a site that is being established on. Validate only lets an establish through
// once its lockout has released (`activeLockout` returns undefined), so any entry still here
// for this site is dead and this is where it is swept. The key is DELETED when the last entry
// goes, keeping `state.nodeLockouts` omit-when-empty so a galaxy with no live lockouts stays
// byte-identical to one that never had any (the determinism no-op). A mutator on the already-
// cloned `next`; a no-op when there is no lockouts array or none for this site.
function pruneLockout(state, siteId) {
  if (!Array.isArray(state.nodeLockouts)) return;
  state.nodeLockouts = state.nodeLockouts.filter((l) => l.siteId !== siteId);
  if (state.nodeLockouts.length === 0) delete state.nodeLockouts;
}

// Validates ONE action against state-as-it-stands. Never mutates `state`.
// Returns { valid: true } or { valid: false, reason }.
function validateAction(state, action) {
  if (!action || typeof action.type !== 'string') {
    return { valid: false, reason: 'action must have a string type' };
  }

  if (action.type === 'paySyndicateFee') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.amount !== 'number' || !Number.isInteger(action.amount) || action.amount <= 0) {
      return { valid: false, reason: 'amount must be a positive integer (§15.2)' };
    }
    if (guild.credits < action.amount) {
      return {
        valid: false,
        reason: `guild ${guild.id} has ${guild.credits} credits, cannot pay ${action.amount}`,
      };
    }
    return { valid: true };
  }

  if (action.type === 'foundGuild') {
    if (typeof action.guildId !== 'string' || action.guildId.length === 0) {
      return { valid: false, reason: 'guildId must be a non-empty string' };
    }
    if (findGuild(state, action.guildId)) {
      return { valid: false, reason: `a guild with id ${JSON.stringify(action.guildId)} already exists` };
    }
    if (typeof action.credits !== 'number' || !Number.isInteger(action.credits) || action.credits < 0) {
      return { valid: false, reason: 'credits must be a non-negative integer (§15.2)' };
    }
    // Home must be a real starter-eligible system (§13) that no one has claimed
    // yet — checked against state-as-it-stands, so two guilds racing for the
    // same home in one batch resolve first-valid-wins like any other contest.
    if (typeof action.homeSystemId !== 'string' || action.homeSystemId.length === 0) {
      return { valid: false, reason: 'homeSystemId must be a non-empty string' };
    }
    if (!isStarterSystem(action.homeSystemId)) {
      return { valid: false, reason: `homeSystemId ${JSON.stringify(action.homeSystemId)} is not a starter-eligible system (§13)` };
    }
    if ((state.claims || []).some((c) => c.landmarkId === action.homeSystemId)) {
      return { valid: false, reason: `system ${JSON.stringify(action.homeSystemId)} is already claimed` };
    }
    // INLINE VENTURES OCCUPY TOO (design.md §4, 30-08-26). A founding may carry
    // ventures directly; in v1 every real create-path attaches an asset, so each
    // one must take a starter asset of its matching kind out of the very pool this
    // founding grants. Refused up front if the founding asks for more machines of a
    // kind than the gift holds — that is a genuine gap and it fails LOUDLY here,
    // rather than the engine quietly minting extra assets (an invented number) or
    // seating an asset-less venture (a state the real paths never produce).
    const inline = Array.isArray(action.ventures) ? action.ventures : [];
    const wanted = {};
    for (const v of inline) {
      const kind = assetKindForVentureType(v && v.type);
      if (!kind) {
        return { valid: false, reason: `inline venture ${JSON.stringify(v && v.id)} has ventureType ${JSON.stringify(v && v.type)}, which needs no known asset kind (expected 'mining' or 'refining')` };
      }
      wanted[kind] = (wanted[kind] || 0) + 1;
    }
    const pool = { miner: STARTER_MINERS, factory: STARTER_FACTORIES };
    for (const [kind, want] of Object.entries(wanted)) {
      if (want > pool[kind]) {
        return { valid: false, reason: `founding carries ${want} ventures needing a ${kind} but the starter gift holds only ${pool[kind]} ${kind} assets (docs/phase-1-tuning.md "Starter asset gift")` };
      }
    }
    return { valid: true };
  }

  if (action.type === 'establishVenture') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    if (findVenture(state, action.ventureId)) {
      return { valid: false, reason: `a venture with id ${JSON.stringify(action.ventureId)} already exists` };
    }
    if (typeof action.siteId !== 'string' || action.siteId.length === 0) {
      return { valid: false, reason: 'siteId must be a non-empty string' };
    }
    const site = getSite(action.siteId);
    if (!site) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} does not exist in the seed` };
    }
    // Checked against state-as-it-stands, so two ventures racing for the same
    // site in one batch resolve first-valid-wins (the second is refused).
    const occupant = siteOccupant(state, action.siteId);
    if (occupant) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is already occupied by venture ${JSON.stringify(occupant.id)}` };
    }
    // THE NODE-LOCKOUT GATE (docs/venture-teardown.md §3.3). A node whose former
    // ordinary-licensed venture was torn down with contract time left is locked to the
    // owner until that term elapses — self-denial, and it gates ANY establish, the owner's
    // included (only the owner could build on their own territory anyway). A vacant site
    // clears the occupant check above and is refused HERE while its lockout is live.
    const lock = activeLockout(state, action.siteId);
    if (lock) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is locked after a venture teardown until tick ${lock.releaseTick} (state.tick is ${state.tick}) — the abandoned contract term must elapse before re-establishing (docs/venture-teardown.md §3.3)` };
    }
    // GATE 3 — the guild must HOLD the node's system (design.md §4's deploy
    // contract, 30-08-26): no building on land you don't own. This closes a real
    // gap — until now establish checked the site but never the territory, so a
    // guild could seat a venture anywhere in the galaxy. Same predicate the BUY
    // side already uses for "you may only buy into a system you hold"
    // (sim/claims.js), asked the same way, so the two can never disagree.
    if (!guildHolds(state, action.guildId, site.systemId)) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} does not hold system ${JSON.stringify(site.systemId)} — a venture may only be deployed in a system you hold (§4)` };
    }
    // A rate the caller NAMES must be a positive integer, exactly as before. An absent
    // one is the engine's to stamp (design.md §2), checked below once the resource or
    // recipe it is stamped from has been proven real.
    if (action.productionRate !== undefined
      && (typeof action.productionRate !== 'number' || !Number.isInteger(action.productionRate) || action.productionRate <= 0)) {
      return { valid: false, reason: 'productionRate must be a positive integer (§15.2)' };
    }
    // The equity offer `o` (§5, Slice 3a): optional, a FRACTION in [0, 0.49] — the
    // structural ceiling that keeps the owner in control of its own venture. REFUSED
    // rather than clamped: a silently-clamped 0.8 would be the engine rewriting the
    // terms the player agreed to, and terms that are not what you set are worse than
    // a rejection (pressure over prohibition governs the GAME's rules, not the
    // engine's honesty about a contract).
    if (action.equityPct !== undefined && !isValidEquityPct(action.equityPct)) {
      return { valid: false, reason: `equityPct must be a fraction between 0 and ${EQUITY_CEILING} (§5's 49% ceiling)` };
    }
    // Type-specific placement rules, mirroring the occupancy invariant so a bad
    // request is refused here rather than applied and then halted mid-tick.
    const ventureType = action.ventureType || 'mining';
    if (ventureType === 'mining') {
      if (site.kind !== 'resource') {
        return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is a ${site.kind} site, not a resource node (mining ventures need a resource node)` };
      }
      if (typeof action.resourceType !== 'string' || action.resourceType !== site.resourceType) {
        return { valid: false, reason: `resourceType ${JSON.stringify(action.resourceType)} does not match node ${JSON.stringify(action.siteId)}'s good ${JSON.stringify(site.resourceType)}` };
      }
    } else if (ventureType === 'refining') {
      if (site.kind !== 'settlement') {
        return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is a ${site.kind} site, not a settlement slot (refining ventures sit on settlement slots)` };
      }
      if (!getRecipe(action.recipeId)) {
        return { valid: false, reason: `recipeId ${JSON.stringify(action.recipeId)} is not a known recipe (recipes.js)` };
      }
    } else {
      return { valid: false, reason: `unknown ventureType ${JSON.stringify(ventureType)} (expected 'mining' or 'refining')` };
    }
    // THE ENGINE-STAMPED RATE (design.md §2, 24-09-26). With the resource or recipe now
    // proven real, a call that named no rate takes the venture's baseline. If there is no
    // baseline to take, REFUSE: the engine never makes a rate up. Today every raw good and
    // every recipe has one (the drift guard in tests/prices.test.js), so this refusal
    // guards a future good or recipe that is added without a baseline.
    if (establishRateFor(action) === null) {
      const what = ventureType === 'mining'
        ? `resource ${JSON.stringify(action.resourceType)}`
        : `recipe ${JSON.stringify(action.recipeId)}`;
      return { valid: false, reason: `no productionRate was given and ${what} has no droidless baseline to establish at (sim/baseline.js) — name a productionRate` };
    }
    // GATE 2 — the deploy NAMES the machine, and the named one must be an IDLE asset
    // of the matching kind in this guild's inventory (design.md §4): a Miner for a
    // resource node, a Factory for a settlement slot. The asset starts in inventory,
    // not on the node — the deploy is what takes it out. "Idle" is DERIVED
    // (sim/assets.js): an owned asset no venture of this guild references.
    //
    // Four separate refusals, in this order, because the player needs to know WHICH
    // way the id was wrong — "no idle asset" would be the same message for a typo, a
    // rival's machine, a factory sent to a mine and a machine already at work.
    // Checked against state-as-it-stands, so two deploys naming the SAME idle asset
    // in one batch resolve first-valid-wins exactly as two racing for the same node
    // do: the first occupies it, the second is refused as already deployed.
    const kind = assetKindForVentureType(ventureType);
    if (typeof action.assetId !== 'string' || action.assetId.length === 0) {
      return { valid: false, reason: 'assetId must be a non-empty string' };
    }
    // Ownership is "the guild whose array holds it" (§4), so an asset belonging to
    // ANOTHER guild fails this same check — it is not in this inventory.
    const asset = (guild.assets || []).find((a) => a.id === action.assetId);
    if (!asset) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no asset ${JSON.stringify(action.assetId)}` };
    }
    const heldBy = deployedAssetIds(guild).get(action.assetId);
    if (heldBy !== undefined) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is already deployed to venture ${JSON.stringify(heldBy)}` };
    }
    if (asset.kind !== kind) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is a ${asset.kind}; a ${ventureType} venture needs a ${kind} (§4)` };
    }
    // DEPLOY IS SAME-SYSTEM (design.md §4, 12-09-26). The idle inventory is now
    // per-system: the named asset must ALSO sit in the very system the node is in —
    // you deploy from THAT system's inventory only. Its own fail-loud refusal, after
    // the owned / idle / matching-kind checks, so the player learns the machine is
    // real and free but in the wrong place. Pre-2.2 a guild holds one system, so this
    // is always satisfied and deploy behaviour is unchanged; it is the correct model
    // now, needing no migration when a second held system exists.
    if (asset.systemId !== site.systemId) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} sits in system ${JSON.stringify(asset.systemId)} but site ${JSON.stringify(action.siteId)} is in system ${JSON.stringify(site.systemId)} — an asset deploys only within its own system (§4)` };
    }
    return { valid: true };
  }

  if (action.type === 'setProductionProfile') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.systemId !== 'string' || action.systemId.length === 0) {
      return { valid: false, reason: 'systemId must be a non-empty string' };
    }
    if (action.goods !== undefined) {
      if (typeof action.goods !== 'object' || action.goods === null || Array.isArray(action.goods)) {
        return { valid: false, reason: 'goods must be an object keyed by good' };
      }
      for (const [good, policy] of Object.entries(action.goods)) {
        // Each key must be a real stockpile good (raw OR processed, NEVER
        // deuterium_fuel, which is not a stockpile good — §resources.js).
        if (!isStockpileGood(good)) {
          return { valid: false, reason: `${JSON.stringify(good)} is not a known stockpile good` };
        }
        if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
          return { valid: false, reason: `policy for good ${JSON.stringify(good)} must be an object` };
        }
        // Each field is TRI-STATE (§15.4 sparse model): ABSENT (undefined) = leave
        // untouched; a valid VALUE = set; **null = CLEAR** — delete the stored key so
        // the good reverts to that field's default (e.g. the Syndicate send back to the
        // paced required-rate). So a field is validated only where PRESENT and NOT null;
        // null is always accepted as the clear-to-default instruction (setEntry deletes).
        if (policy.order !== undefined && policy.order !== null && !isValidOrder(policy.order)) {
          return { valid: false, reason: `order for good ${JSON.stringify(good)} must be a permutation of ["syndicate","downstream","stockpile"]` };
        }
        if (policy.downstreamPct !== undefined && policy.downstreamPct !== null && !isIntInRange(policy.downstreamPct, 0, 100)) {
          return { valid: false, reason: `downstreamPct for good ${JSON.stringify(good)} must be an integer 0..100 (§15.2)` };
        }
        // reserveLevel (§5 one-pot distribution, Slice A): the quantity the Reserve
        // claimant holds back at its priority slot — an integer ≥ 0. Replaces the
        // old stockpile {mode,value} fork amount and the separate reserveFloor.
        if (policy.reserveLevel !== undefined && policy.reserveLevel !== null
            && (typeof policy.reserveLevel !== 'number' || !Number.isInteger(policy.reserveLevel) || policy.reserveLevel < 0)) {
          return { valid: false, reason: `reserveLevel for good ${JSON.stringify(good)} must be a non-negative integer (§15.2)` };
        }
        // syndicate (§5 Slice B): the Syndicate fork's per-tick send control. ABSENT =
        // the paced required-rate default; null CLEARS back to it. When present it is
        // { mode, value } with mode ∈ {absolute, percent} and value an integer ≥ 0
        // (percent = share of this tick's fresh; percent > 100 is legal — "send all fresh").
        if (policy.syndicate !== undefined && policy.syndicate !== null) {
          const syn = policy.syndicate;
          if (typeof syn !== 'object' || syn === null || Array.isArray(syn)) {
            return { valid: false, reason: `syndicate for good ${JSON.stringify(good)} must be an object { mode, value }` };
          }
          if (syn.mode !== 'absolute' && syn.mode !== 'percent') {
            return { valid: false, reason: `syndicate.mode for good ${JSON.stringify(good)} must be "absolute" or "percent"` };
          }
          if (typeof syn.value !== 'number' || !Number.isInteger(syn.value) || syn.value < 0) {
            return { valid: false, reason: `syndicate.value for good ${JSON.stringify(good)} must be a non-negative integer (§15.2)` };
          }
        }
        // pursue (§5 licence distribution): the ORDER the good's delivered pile fills
        // its licensed ventures at the window boundary. An ARRAY of venture ids, or
        // null to clear back to establishment order. Deliberately NOT checked against
        // the current ventures — exactly like `throttles` below, and for the same
        // reason: the profile is standing intent, reconciled at READ time, so ranking
        // a venture you are about to establish (or one you have just removed) is legal
        // and simply resolves at the boundary. The review flag surfaces a stale entry
        // to the player rather than the action refusing it.
        if (policy.pursue !== undefined && policy.pursue !== null) {
          if (!Array.isArray(policy.pursue)) {
            return { valid: false, reason: `pursue for good ${JSON.stringify(good)} must be an array of ventureIds` };
          }
          for (const id of policy.pursue) {
            if (typeof id !== 'string' || id.length === 0) {
              return { valid: false, reason: `pursue for good ${JSON.stringify(good)} must contain non-empty ventureId strings` };
            }
          }
        }
      }
    }
    if (action.throttles !== undefined) {
      if (typeof action.throttles !== 'object' || action.throttles === null || Array.isArray(action.throttles)) {
        return { valid: false, reason: 'throttles must be an object keyed by ventureId' };
      }
      for (const [ventureId, pct] of Object.entries(action.throttles)) {
        if (!isIntInRange(pct, 0, 100)) {
          return { valid: false, reason: `throttle for venture ${JSON.stringify(ventureId)} must be an integer 0..100 (§15.2)` };
        }
      }
    }
    // DELIBERATE NON-CHECKS (§5, §15.4): a `throttles` key naming a venture that
    // does not currently exist, and a `goods` key for a good with no current
    // producer, are BOTH accepted. The profile is advisory standing intent,
    // reconciled at READ time — storing it ahead of, or after, the ventures it
    // references is legal. Do not "fix" this into a referential check: the engine
    // ignores stale entries at read time and a future venture picks up its policy.
    return { valid: true };
  }

  if (action.type === 'setSyndicateCommitment') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // The venture must exist AND belong to THIS guild — a commitment is the guild's
    // promise on its own venture's output, so scan only this guild's ventures.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    if (typeof action.commitment !== 'number' || !Number.isInteger(action.commitment) || action.commitment < 0) {
      return { valid: false, reason: 'commitment must be a non-negative integer (§15.2)' };
    }
    // FAIL LOUD, do not accept a silent no-op: the resolver sums commitment over the
    // ventures PRODUCING a good, keyed on `producedGoodFor` (sim/baseline.js), so a
    // venture that produces nothing identifiable — neither a `resourceType` nor a
    // resolvable recipe output — would never contribute to any `Q`. Refuse it rather
    // than store an inert number. commitment === 0 is always allowed (it clears to
    // unlicensed, meaningful on any venture).
    //
    // A FACTORY IS NOW ACCEPTED (factory-commitment slice, 28-08-26). This used to read
    // `!venture.resourceType` and refuse every refining venture, because the accrual was
    // mines-only; the accrual is producer-general now, so a factory's commitment lands
    // on its recipe's OUTPUT good and is delivered, sold and judged like a mine's.
    if (action.commitment > 0 && !producedGoodFor(venture)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} produces no identifiable good (no resourceType and no resolvable recipe output), so a non-zero commitment here would be silently inert` };
    }
    return { valid: true };
  }

  if (action.type === 'applyForLicence') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // Scan only THIS guild's ventures: a licence is a contract over a venture you own.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    if (venture.licence) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is already licensed — changing agreed terms is a renegotiation (§5): use renegotiateLicence once its committed window has elapsed, not a second application`};
    }
    // DEUTERIUM IS NEVER ELIGIBLE FOR THE ORDINARY WINDOWED PATH (§1.4 "The Deuterium
    // Cycle"). Deuterium is special: it takes ONLY the windowless deuterium licence
    // (`licenseDeuteriumMine`) — 100%-committed, fee-less, breach-less, zero-GP — so
    // routing a deuterium mine through here (a fee, a breach, windowed delivery, tier-1
    // GP) would violate the ruling. This is the reverse of `licenseDeuteriumMine`'s
    // refusal of a venture that already holds an ordinary licence: with both guards the
    // two paths are mutually exclusive from either side. Refused EARLY — before any
    // fee/baseline work — and for EVERY deuterium mine (licensed or not), since no
    // deuterium mine ever belongs on this path. (`deuterium_fuel` is caught by the fuel
    // check below; this catches the RAW good, which is not fuel and would otherwise slip
    // through as a normal tier-1 mine.)
    if (venture.resourceType === DEUTERIUM) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} mines ${JSON.stringify(DEUTERIUM)}, which is special and takes only the windowless deuterium licence — use licenseDeuteriumMine, not the ordinary Syndicate licence (§1.4)` };
    }
    // The good this licence is a contract over — a mine's `resourceType`, a FACTORY's
    // recipe output (`producedGoodFor`, sim/baseline.js). The mines-only refusal that
    // stood here is GONE (factory-commitment slice, 28-08-26): it existed for a purely
    // mechanical reason — the §5 accrual summed `Q` over ventures with a `resourceType`,
    // so a factory licence could never have been delivered or judged — and that accrual
    // is producer-general now. What remains is the same check with no venture type in
    // it: a venture that produces nothing identifiable has no good to commit.
    const committedGood = producedGoodFor(venture);
    if (!committedGood) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} produces no identifiable good (no resourceType and no resolvable recipe output) — there is nothing for a licence to commit` };
    }
    // Fuel is a Syndicate MONOPOLY with no guild licence to price (§8, §5 "Fuel is
    // excluded"). `deuterium_fuel` is not minable and no recipe outputs it, so nothing
    // can produce it, but the exclusion is stated here rather than left to be implied.
    if (isFuel(committedGood)) {
      return { valid: false, reason: `${JSON.stringify(committedGood)} is Syndicate-regulated — fuel carries no venture licence (§8)` };
    }
    // The terms. Refused, not clamped — as with 3a's equity offer, a silently-adjusted
    // term would be the engine rewriting a contract the player agreed to.
    if (!isValidCommitmentPct(action.committedOutputPct)) {
      return { valid: false, reason: `committedOutputPct must be a fraction between ${COMMITMENT_FLOOR} and 1 (§5's commitment floor)` };
    }
    if (!isValidWindowDays(action.windowDays)) {
      return { valid: false, reason: `windowDays must be a whole number of days between ${WINDOW_DAYS_MIN} and ${WINDOW_DAYS_MAX} (§5's renegotiation window)` };
    }
    // The fee is priced off the POSTED price at signing, so there must be one to lock.
    // Every non-fuel good carries a price from tick 0; this catches a state whose price
    // block was removed, rather than locking a licence against `null` forever.
    if (postedPrice(state, committedGood) == null) {
      return { valid: false, reason: `${JSON.stringify(committedGood)} has no posted price to lock the fee against` };
    }
    // And the venture must have a baseline to price the fee off (sim/baseline.js). A
    // mine whose resource has no baseline entry is caught by that file's drift guard;
    // refusing here keeps a fee from being computed against a zero capacity.
    const baseline = baselineOutputFor(venture);
    if (!baseline || !(baseline.units > 0)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} has no droidless baseline output to price a fee against` };
    }
    return { valid: true };
  }

  if (action.type === 'renegotiateLicence') {
    // The near-mirror of applyForLicence's validate — a licence is a contract over a
    // venture you own, so scan only THIS guild's ventures, exactly as it does.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    // DEUTERIUM IS EXEMPT (§1.4): a deuterium mine is windowless — it takes only the
    // windowless deuterium licence, which never renegotiates. Refused EARLY and for
    // every deuterium mine, so the reason is the specific exemption rather than the
    // generic "no licence" below (a deuterium mine carries a `deuteriumLicence`, never
    // an ordinary `licence`, so the next check would otherwise catch it less clearly).
    if (venture.resourceType === DEUTERIUM) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} mines ${JSON.stringify(DEUTERIUM)}, which is windowless and exempt from renegotiation — the deuterium licence has no terms to reopen (§1.4)` };
    }
    // The OPPOSITE of applyForLicence's "already licensed" refusal: renegotiation needs
    // an EXISTING ordinary licence to reopen. An unlicensed venture signs a fresh one
    // (applyForLicence); it does not renegotiate.
    if (!venture.licence) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} has no licence to renegotiate — sign one with applyForLicence first (§5)` };
    }
    // And the committed window must have ELAPSED — terms reopen only at window-end (§5).
    // Read `windowN` the SAME way applyForLicence does, and compare against the SAME
    // end-of-term tick teardownSettlement and the snapshot use (`licenceEndTick`), so a
    // renegotiation cannot open a tick before the panel says the window is up.
    const windowN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
    if (state.tick < licenceEndTick(venture.licence, windowN)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)}'s committed window has not elapsed (ends at tick ${licenceEndTick(venture.licence, windowN)}, now ${state.tick}) — terms reopen only at window-end (§5)` };
    }
    return { valid: true };
  }

  if (action.type === 'lapseLicence') {
    // The EXACT SAME gate as renegotiateLicence — lapse and accept are the two ends of one
    // reopened licence (§5 "Accept or lapse"), so you can only lapse what you could
    // renegotiate: an ordinary, non-deuterium licence whose committed window has elapsed. The
    // checks are kept in the same order and with the same reasons so the two actions refuse
    // identically.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    // Deuterium is exempt (§1.4): a windowless deuterium licence has no terms to reopen, so
    // there is nothing to lapse. Refused EARLY with the specific exemption, exactly as
    // renegotiateLicence does.
    if (venture.resourceType === DEUTERIUM) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} mines ${JSON.stringify(DEUTERIUM)}, which is windowless and exempt from renegotiation — a deuterium licence has no terms to lapse (§1.4)` };
    }
    // Lapse needs an EXISTING ordinary licence to drop: an unlicensed venture is already in
    // the state lapse would return it to.
    if (!venture.licence) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} has no licence to lapse — it is already unlicensed (§5)` };
    }
    // And the committed window must have ELAPSED — the licence is only up for renegotiation
    // (accept OR lapse) at window-end (§5). `windowN` and `licenceEndTick` read the SAME way
    // renegotiateLicence reads them.
    const windowN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
    if (state.tick < licenceEndTick(venture.licence, windowN)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)}'s committed window has not elapsed (ends at tick ${licenceEndTick(venture.licence, windowN)}, now ${state.tick}) — terms reopen only at window-end, so there is nothing to lapse yet (§5)` };
    }
    return { valid: true };
  }

  if (action.type === 'acknowledgeEvent') {
    // Validate ONLY the guild (docs/event-log.md §3). A MISSING `eventId` is a valid no-op,
    // NOT a rejection: a notice can age out of the log (retention) between the tick the client
    // rendered it and the tick the player clicks it, and the acknowledge for a since-pruned
    // notice must not fail — it simply finds nothing to stamp (the apply is a no-op). Rejecting
    // it would surface a spurious error for a perfectly ordinary race. So the only hard
    // requirement is that the guild exists.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    return { valid: true };
  }

  if (action.type === 'licenseDeuteriumMine') {
    // REFUSE, NEVER CLAMP — as everywhere in intake, a silently-adjusted request would be
    // the engine rewriting the player's order (§15.6).
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // Scan only THIS guild's ventures: a licence is a contract over a venture you own.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    // A deuterium licence covers a MINING venture extracting DEUTERIUM and nothing else.
    // The one check refuses both a non-mining venture (a refinery carries no
    // `resourceType`) and a mine of any other good (§1.4).
    if (venture.resourceType !== DEUTERIUM) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is not a deuterium mine — a deuterium licence covers only a mining venture extracting ${JSON.stringify(DEUTERIUM)} (§1.4)` };
    }
    // Once-only.
    if (venture.deuteriumLicence) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is already deuterium-licensed — a second grant is not built` };
    }
    // Mutually exclusive with the ordinary windowed licence: a deuterium mine is not
    // eligible for `applyForLicence`, and one that somehow carried both would be judged by
    // two paths at once (§1.4). Keep the two licences from ever coexisting on a venture.
    if (venture.licence) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} already holds an ordinary Syndicate licence — a deuterium mine takes the windowless deuterium licence instead, and the two are mutually exclusive (§1.4)` };
    }
    return { valid: true };
  }

  if (action.type === 'establishDeuteriumRefinery') {
    // An illegal deuterium refinery is a FACTORY venture on a settlement slot (§1.4 slice 1b),
    // so this mirrors establishVenture's refining checks — minus the recipe (there is none) and
    // plus a factory asset. REFUSE, never clamp, throughout.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    if (findVenture(state, action.ventureId)) {
      return { valid: false, reason: `a venture with id ${JSON.stringify(action.ventureId)} already exists` };
    }
    if (typeof action.siteId !== 'string' || action.siteId.length === 0) {
      return { valid: false, reason: 'siteId must be a non-empty string' };
    }
    const site = getSite(action.siteId);
    if (!site) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} does not exist in the seed` };
    }
    // A refinery is a factory — it sits on a SETTLEMENT SLOT, exactly like a refining venture.
    if (site.kind !== 'settlement') {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is a ${site.kind} site, not a settlement slot (a deuterium refinery is a factory on a settlement slot)` };
    }
    const occupant = siteOccupant(state, action.siteId);
    if (occupant) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is already occupied by venture ${JSON.stringify(occupant.id)}` };
    }
    // THE NODE-LOCKOUT GATE (docs/venture-teardown.md §3.3), the same refusal establishVenture
    // makes: a site whose former licensed venture was torn down mid-term is barred from ANY
    // re-establish until the term elapses. A refinery seats a venture like any other, so it
    // gates here too.
    const lock = activeLockout(state, action.siteId);
    if (lock) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is locked after a venture teardown until tick ${lock.releaseTick} (state.tick is ${state.tick}) — the abandoned contract term must elapse before re-establishing (docs/venture-teardown.md §3.3)` };
    }
    // Deploy only into a system you hold (§4), the same gate establishVenture uses.
    if (!guildHolds(state, action.guildId, site.systemId)) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} does not hold system ${JSON.stringify(site.systemId)} — a venture may only be deployed in a system you hold (§4)` };
    }
    if (typeof action.productionRate !== 'number' || !Number.isInteger(action.productionRate) || action.productionRate <= 0) {
      return { valid: false, reason: 'productionRate must be a positive integer (§15.2)' };
    }
    // GATE 2 — the deploy NAMES the machine, and it must be an IDLE FACTORY in this guild's
    // inventory (the refinery is a factory venture, `assetKindForVentureType('refining')`). The
    // same four ordered refusals establishVenture uses, so the player learns WHICH way the id
    // was wrong.
    const kind = assetKindForVentureType('refining');
    if (typeof action.assetId !== 'string' || action.assetId.length === 0) {
      return { valid: false, reason: 'assetId must be a non-empty string' };
    }
    const asset = (guild.assets || []).find((a) => a.id === action.assetId);
    if (!asset) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no asset ${JSON.stringify(action.assetId)}` };
    }
    const heldBy = deployedAssetIds(guild).get(action.assetId);
    if (heldBy !== undefined) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is already deployed to venture ${JSON.stringify(heldBy)}` };
    }
    if (asset.kind !== kind) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is a ${asset.kind}; a deuterium refinery needs a ${kind} (§4)` };
    }
    // DEPLOY IS SAME-SYSTEM (design.md §4, 12-09-26), the same clause establishVenture
    // makes: the named idle factory must sit in the settlement slot's own system. A
    // refinery deploys from that system's inventory only.
    if (asset.systemId !== site.systemId) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} sits in system ${JSON.stringify(asset.systemId)} but site ${JSON.stringify(action.siteId)} is in system ${JSON.stringify(site.systemId)} — an asset deploys only within its own system (§4)` };
    }
    return { valid: true };
  }

  if (action.type === 'establishDockyard') {
    // A Dockyard is a FACTORY venture on a settlement slot in construct mode (docs/build-yard.md
    // §2). This mirrors establishDeuteriumRefinery's checks EXACTLY — same occupancy gates, same
    // ordered Gate-2 refusals — minus the recipe (there is none) and minus the `productionRate`
    // check (a dockyard builds via its queue, not a continuous rate). REFUSE, never clamp.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    if (findVenture(state, action.ventureId)) {
      return { valid: false, reason: `a venture with id ${JSON.stringify(action.ventureId)} already exists` };
    }
    if (typeof action.siteId !== 'string' || action.siteId.length === 0) {
      return { valid: false, reason: 'siteId must be a non-empty string' };
    }
    const site = getSite(action.siteId);
    if (!site) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} does not exist in the seed` };
    }
    // A dockyard is a factory — it sits on a SETTLEMENT SLOT, exactly like a refining venture.
    if (site.kind !== 'settlement') {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is a ${site.kind} site, not a settlement slot (a dockyard is a factory on a settlement slot)` };
    }
    const occupant = siteOccupant(state, action.siteId);
    if (occupant) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is already occupied by venture ${JSON.stringify(occupant.id)}` };
    }
    // THE NODE-LOCKOUT GATE (docs/venture-teardown.md §3.3), the same refusal every establish makes.
    const lock = activeLockout(state, action.siteId);
    if (lock) {
      return { valid: false, reason: `site ${JSON.stringify(action.siteId)} is locked after a venture teardown until tick ${lock.releaseTick} (state.tick is ${state.tick}) — the abandoned contract term must elapse before re-establishing (docs/venture-teardown.md §3.3)` };
    }
    // Deploy only into a system you hold (§4).
    if (!guildHolds(state, action.guildId, site.systemId)) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} does not hold system ${JSON.stringify(site.systemId)} — a venture may only be deployed in a system you hold (§4)` };
    }
    // GATE 2 — the deploy NAMES the machine, an IDLE FACTORY in this guild's inventory
    // (a dockyard is a factory venture, `assetKindForVentureType('refining')`). The same four
    // ordered refusals establishVenture / establishDeuteriumRefinery use.
    const kind = assetKindForVentureType('refining');
    if (typeof action.assetId !== 'string' || action.assetId.length === 0) {
      return { valid: false, reason: 'assetId must be a non-empty string' };
    }
    const asset = (guild.assets || []).find((a) => a.id === action.assetId);
    if (!asset) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no asset ${JSON.stringify(action.assetId)}` };
    }
    const heldBy = deployedAssetIds(guild).get(action.assetId);
    if (heldBy !== undefined) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is already deployed to venture ${JSON.stringify(heldBy)}` };
    }
    if (asset.kind !== kind) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} is a ${asset.kind}; a dockyard needs a ${kind} (§4)` };
    }
    // DEPLOY IS SAME-SYSTEM (design.md §4, 12-09-26): the named idle factory must sit in the
    // settlement slot's own system.
    if (asset.systemId !== site.systemId) {
      return { valid: false, reason: `asset ${JSON.stringify(action.assetId)} sits in system ${JSON.stringify(asset.systemId)} but site ${JSON.stringify(action.siteId)} is in system ${JSON.stringify(site.systemId)} — an asset deploys only within its own system (§4)` };
    }
    return { valid: true };
  }

  if (action.type === 'commissionBuild') {
    // Append a build to a dockyard's queue (docs/build-yard.md §3). REFUSE, never clamp.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // Scan only THIS guild's ventures: commissioning is an act on a dockyard you own.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    if (!isDockyard(venture)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is not a dockyard — only a dockyard can be commissioned to build (docs/build-yard.md §3)` };
    }
    if (!BUILDABLE_KINDS.includes(action.assetKind)) {
      return { valid: false, reason: `assetKind ${JSON.stringify(action.assetKind)} is not buildable — a dockyard builds one of ${JSON.stringify(BUILDABLE_KINDS)} (the two ground assets or the four guild transports, docs/build-yard.md §1 / phase-1-tuning §"Guild transports")` };
    }
    // Single-slot queue capped at MAX_QUEUE — a commission over the cap is refused loudly (§3).
    const queueLen = (venture.buildQueue || []).length;
    if (queueLen >= MAX_QUEUE) {
      return { valid: false, reason: `dockyard ${JSON.stringify(action.ventureId)}'s build queue is full (${queueLen}/${MAX_QUEUE}) — cancel or wait for a build before commissioning another (docs/build-yard.md §3)` };
    }
    return { valid: true };
  }

  if (action.type === 'cancelCommission') {
    // Cancel an UNSTARTED commission (docs/build-yard.md §3). REFUSE, never clamp.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    if (!isDockyard(venture)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is not a dockyard (docs/build-yard.md §3)` };
    }
    // The entry must EXIST (addressed by its stable commissionId, not an index) …
    const entry = (venture.buildQueue || []).find((e) => e.commissionId === action.commissionId);
    if (!entry) {
      return { valid: false, reason: `dockyard ${JSON.stringify(action.ventureId)} has no commission with id ${JSON.stringify(action.commissionId)}` };
    }
    // … and must NOT have started: a started build (parts consumed, ticking) is stopped only by
    // tearing down the dockyard (§3). `remainingTicks === null` is "not yet started".
    if (entry.remainingTicks !== null && entry.remainingTicks !== undefined) {
      return { valid: false, reason: `commission ${JSON.stringify(action.commissionId)} on dockyard ${JSON.stringify(action.ventureId)} has already started (${entry.remainingTicks} ticks left) — a started build cannot be cancelled, only the dockyard's teardown stops it (docs/build-yard.md §3)` };
    }
    return { valid: true };
  }

  if (action.type === 'decommissionVenture') {
    // Close a venture the guild owns (docs/venture-teardown.md §1), validated in intake
    // order: the guild exists; the venture exists AND belongs to this guild; and — this
    // slice — it is not a licensed deuterium mine (§6).
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.ventureId !== 'string' || action.ventureId.length === 0) {
      return { valid: false, reason: 'ventureId must be a non-empty string' };
    }
    // Scan ONLY this guild's ventures: closing is an act on a venture you OWN (§1). A
    // venture belonging to another guild is not found here and is refused by name, exactly
    // as applyForLicence and setSyndicateCommitment scope their lookups.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    // DEFERRED THIS SLICE (§6): a licensed deuterium mine is windowless, so "remaining
    // cycles" and "contract end" — what the §3.2 fee and §3.3 lockout compute from — are
    // undefined for it. Its real deterrent is already automatic (tearing it down vaporises
    // ~1000 RP with no GP to offset), so refusing it costs nothing but the hardening it waits
    // on. An UNLICENSED deuterium mine is NOT refused: it carries no deuterium licence, so it
    // tears down clean like any unlicensed venture (§4).
    if (isLicensedDeuteriumMine(venture)) {
      return { valid: false, reason: `venture ${JSON.stringify(action.ventureId)} is a licensed deuterium mine — its teardown is deferred to the deuterium hardening slice (docs/venture-teardown.md §6) and cannot be decommissioned yet` };
    }
    return { valid: true };
  }

  if (action.type === 'addOrderLine') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (orderFieldFor(action.side) === null) {
      return { valid: false, reason: `side ${JSON.stringify(action.side)} must be "buy" or "sell"` };
    }
    // The line's good must be one the Syndicate posts a price for (PRICED_GOODS excludes fuel and
    // any catalog-only placeholder), the same vocabulary the finalise buys/sells at. Fuel is called
    // out separately only so the refusal SAYS why (§8), exactly as the two finalises do.
    if (isFuel(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is Syndicate-regulated — fuel is never listed on the Exchange (§8)` };
    }
    if (typeof action.good !== 'string' || !PRICED_GOODS.includes(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is not a good the Syndicate posts a price for` };
    }
    // Integer qty > 0 (§15.2). NO capacity or stock gate here (§3 — a draft may exceed a hold or a
    // good's stock; finalise is where those bite).
    if (typeof action.qty !== 'number' || !Number.isInteger(action.qty) || action.qty <= 0) {
      return { valid: false, reason: `qty for ${JSON.stringify(action.good)} must be a positive integer (§15.2)` };
    }
    return { valid: true };
  }

  if (action.type === 'removeOrderLine') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const field = orderFieldFor(action.side);
    if (field === null) {
      return { valid: false, reason: `side ${JSON.stringify(action.side)} must be "buy" or "sell"` };
    }
    // FAIL LOUD, not a silent no-op: removing a line the order does not carry is a bug in the caller
    // (a UI only offers remove on a line it shows), so refuse it by name rather than quietly doing
    // nothing. An absent order (omit-when-empty) has no line either.
    const order = guild[field];
    const has = order && Array.isArray(order.lines) && order.lines.some((l) => l.good === action.good);
    if (!has) {
      return { valid: false, reason: `guild ${guild.id}'s ${action.side} order has no line for ${JSON.stringify(action.good)}` };
    }
    return { valid: true };
  }

  if (action.type === 'clearOrder') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (orderFieldFor(action.side) === null) {
      return { valid: false, reason: `side ${JSON.stringify(action.side)} must be "buy" or "sell"` };
    }
    // Clearing is IDEMPOTENT: an already-empty (omitted) order clears to itself. Always valid once
    // the guild and side are — apply deletes the key if present, a no-op otherwise.
    return { valid: true };
  }

  if (action.type === 'sellToSyndicate') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // HELD single-origin order (docs/syndicate-orders.md §5): `originSystemId` + the guild's own
    // `sellOrder.lines` — many goods, ONE origin, ONE space-tiered leg. (The legacy `good` +
    // `allocations` multi-system path was RETIRED with the client slice, §8.)
    if (typeof action.originSystemId !== 'string' || action.originSystemId.length === 0) {
      return { valid: false, reason: 'originSystemId must be a non-empty string' };
    }
    const lines = (guild.sellOrder && guild.sellOrder.lines) || [];
    // An EMPTY (or absent) held order cannot be finalised (§5).
    if (lines.length === 0) {
      return { valid: false, reason: `guild ${guild.id} has no sell order to finalise` };
    }
    // PER LINE — the goods are guaranteed priced + positive-int by addOrderLine and by
    // checkOrders, but re-checked here so apply's loud guard is the backstop, not the first line.
    // ORIGIN HOLDS THE STOCK (§5/§7): the one origin must carry every line's qty. The pile is the
    // ownership check. Short lines are named so the player can trim and retry (§7).
    const short = [];
    for (const line of lines) {
      if (typeof line.good !== 'string' || !PRICED_GOODS.includes(line.good)) {
        return { valid: false, reason: `${JSON.stringify(line.good)} is not a good the Syndicate posts a price for` };
      }
      if (postedPrice(state, line.good) == null) {
        return { valid: false, reason: `${JSON.stringify(line.good)} has no posted price to sell at` };
      }
      if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty <= 0) {
        return { valid: false, reason: `qty for ${JSON.stringify(line.good)} must be a positive integer (§15.2)` };
      }
      const held = getStock(guild, action.originSystemId, line.good);
      if (held < line.qty) {
        short.push(`${line.good} (need ${line.qty}, hold ${held})`);
      }
    }
    if (short.length > 0) {
      return { valid: false, reason: `guild ${guild.id} does not hold enough stock in system ${JSON.stringify(action.originSystemId)} for this sell order: ${short.join('; ')} (docs/syndicate-orders.md §7)` };
    }
    // THE CAPACITY GATE (§5.1 / §8.0) — the WHOLE order flies from the one origin on ONE hauler,
    // so a load whose total cargo space (`Σ qty × volumeOf(good)`) exceeds the heavy hold is
    // reject-wholed with a split-the-order message. Every good is priced above, so `volumeOf`
    // never throws.
    const totalSpace = lines.reduce((sum, line) => sum + (line.qty * volumeOf(line.good)), 0);
    if (haulerTierForSpace(totalSpace) === null) {
      return { valid: false, reason: `this sell order's total cargo space ${totalSpace} exceeds the Syndicate heavy hold (${HEAVY_HOLD}) — split the order into smaller shipments (transport-model.md §5.1)` };
    }
    // THE FUEL GATE — one leg (origin → its nearest waystation) at the total-space tier, the SAME
    // `routeFuelCost` the BUY side uses and the snapshot quotes. RUN LATE, on purpose: a sale
    // refused for stock or capacity says so rather than blaming fuel. Over-cap space cannot reach
    // here (the capacity gate above reject-wholed it); an unreachable origin contributes 0 burn.
    const { fuelBurn } = routeFuelCost(action.originSystemId, totalSpace);
    const availableFuel = guild.fuelHoard + (guild.deuteriumFuel || 0);
    if (availableFuel < fuelBurn) {
      return { valid: false, reason: `guild ${guild.id} holds ${availableFuel} fuel (legal + contraband), cannot burn ${fuelBurn} shipping this sell order from ${JSON.stringify(action.originSystemId)} — insufficient fuel: need ${fuelBurn}, have ${availableFuel} (fuel-supply-and-allocation.md §8)` };
    }
    // THE QUOTE-LOCK GATE (§8.1) — LAST, exactly as on the BUY: refuse an EXPIRED issue tick
    // (past the TTL, or a cycle boundary crossed since issue). The expiry rules are
    // good-independent but the ring guard is per-good, so every line is checked; apply
    // re-derives each line's price from the ring at this same tick.
    const issueTick = action.issueTick === undefined ? state.tick : action.issueTick;
    for (const line of lines) {
      const quote = checkQuote(state, line.good, issueTick);
      if (!quote.valid) return quote;
    }
    return { valid: true };
  }

  if (action.type === 'buyFromSyndicate') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // THE CART — the guild's HELD buy order, reading `guild.buyOrder.lines` (docs/syndicate-orders.md
    // §5). (The inline `cart` / legacy `good`/`qty` intake was RETIRED with the client slice, §8.)
    const cart = buyFinalizeCart(state, action);
    if (!Array.isArray(cart) || cart.length === 0) {
      // An EMPTY (or absent) held order cannot be finalised (§5).
      return { valid: false, reason: `guild ${guild.id} has no buy order to finalise` };
    }
    // EACH LINE, and no duplicate good. `PRICED_GOODS` is the same vocabulary a sale uses
    // (#43: one posted price serves both directions, no spread, no transport fee — §6), so
    // anything the Syndicate will not buy it will not sell. `addOrderLine` already keeps the held
    // order one-line-per-good; this is the backstop, refusing a DUPLICATE good rather than summing
    // it — two lines for one good is an ambiguous order.
    const seenGoods = new Set();
    for (const line of cart) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) {
        return { valid: false, reason: 'each cart line must be an object { good, qty }' };
      }
      if (isFuel(line.good)) {
        return { valid: false, reason: `${JSON.stringify(line.good)} is Syndicate-regulated — fuel is never listed on the Exchange (§8)` };
      }
      if (typeof line.good !== 'string' || !PRICED_GOODS.includes(line.good)) {
        return { valid: false, reason: `${JSON.stringify(line.good)} is not a good the Syndicate posts a price for` };
      }
      if (postedPrice(state, line.good) == null) {
        return { valid: false, reason: `${JSON.stringify(line.good)} has no posted price to buy at` };
      }
      if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty <= 0) {
        return { valid: false, reason: `qty for ${JSON.stringify(line.good)} must be a positive integer (§15.2)` };
      }
      if (seenGoods.has(line.good)) {
        return { valid: false, reason: `cart names ${JSON.stringify(line.good)} twice — one line per good` };
      }
      seenGoods.add(line.good);
    }
    if (typeof action.destinationSystemId !== 'string' || action.destinationSystemId.length === 0) {
      return { valid: false, reason: 'destinationSystemId must be a non-empty string' };
    }
    // YOU MAY ONLY BUY INTO A SYSTEM YOU HOLD. `guildHolds` (sim/claims.js) is the
    // ONE predicate for that question, and stepArrivals asks the SAME one at the
    // arrival tick — where a `false` is what makes the cargo vanish (§6). Two
    // different readings of "holds" would mean a delivery legal to schedule and
    // impossible to land.
    if (!guildHolds(state, action.guildId, action.destinationSystemId)) {
      return { valid: false, reason: `guild ${guild.id} does not hold system ${JSON.stringify(action.destinationSystemId)} — a delivery goes only to a system you hold (§6)` };
    }
    // ...and there must be a waystation to sail from, and a destination with real
    // coords to sail to. Refused rather than defaulted: an invented origin would
    // silently invent an arrival tick.
    if (!nearestWaystation(action.destinationSystemId)) {
      return { valid: false, reason: `no Syndicate waystation can reach system ${JSON.stringify(action.destinationSystemId)} — it resolves to no seed coordinates` };
    }
    // THE CAPACITY GATE (NEW, §5.1 / §8.0) — a STRUCTURAL check, run with the ones above
    // and BEFORE cost/fuel/quote: the whole cart flies on ONE hauler, and a load whose
    // total cargo space (`Σ qty × volumeOf(good)`) exceeds the heavy hold cannot be
    // carried. Reject-whole with a split-the-order message — no auto-split, one shipment,
    // one hauler. Every good is priced (checked above), so `volumeOf` never throws here.
    const totalSpace = cart.reduce((sum, line) => sum + (line.qty * volumeOf(line.good)), 0);
    if (haulerTierForSpace(totalSpace) === null) {
      return { valid: false, reason: `this cart's total cargo space ${totalSpace} exceeds the Syndicate heavy hold (${HEAVY_HOLD}) — split the order into smaller shipments (transport-model.md §5.1)` };
    }
    // THE CASH IS DEBITED NOW, in full, at the QUOTED prices with no fee (§6 step 3;
    // §8.1's quote-lock). Rounded PER GOOD then summed (#43's `round(qty × price)`), so a
    // one-good cart is byte-identical to the old single-good order. Each good is priced from
    // the ring at the ONE issue tick — today's posted value when `issueTick` is omitted (age
    // 0), a past tick's when the confirm carries one — so the affordability check is measured
    // against the same prices apply will charge. The `?? postedPrice` fallback covers ONLY a
    // quote not in the ring (too old / future), which the expiry gate below refuses anyway;
    // it exists so a co-occurring credits shortfall is still blamed FIRST.
    const issueTick = action.issueTick === undefined ? state.tick : action.issueTick;
    let cost = 0;
    for (const line of cart) {
      const quoted = quotedPrice(state, line.good, issueTick);
      cost += Math.round(line.qty * (quoted == null ? postedPrice(state, line.good) : quoted));
    }
    if (guild.credits < cost) {
      return { valid: false, reason: `guild ${guild.id} holds ${guild.credits} credits, cannot pay ${cost} for this cart` };
    }
    // THE FUEL GATE — no fuel, no Syndicate BUY (docs/fuel-supply-and-allocation.md §8).
    // RUN LAST (before quote-lock), ON PURPOSE: a trade refused for credits or territory
    // says so rather than blaming fuel. The burn is `routeFuelCost(dest, totalSpace)` — the
    // per-hex rate of the hauler tier the cart's TOTAL SPACE selects (§5.1), the SAME
    // function the snapshot quotes. Over-cap space cannot reach here (the capacity gate above
    // reject-wholed it). A `fuelBurn` of 0 is the no-route case, already refused above.
    const { fuelBurn } = routeFuelCost(action.destinationSystemId, totalSpace);
    // COMBINED AVAILABILITY (§1.4 slice 1b): legal `fuelHoard` + contraband `deuteriumFuel`,
    // since apply burns legal-first then contraband (`burnFuel`). Same combined-total gate the
    // SELL side uses.
    const availableFuel = guild.fuelHoard + (guild.deuteriumFuel || 0);
    if (availableFuel < fuelBurn) {
      return { valid: false, reason: `guild ${guild.id} holds ${availableFuel} fuel (legal + contraband), cannot burn ${fuelBurn} flying to ${JSON.stringify(action.destinationSystemId)} — insufficient fuel: need ${fuelBurn}, have ${availableFuel} (fuel-supply-and-allocation.md §8)` };
    }
    // THE QUOTE-LOCK GATE (docs/transport-model.md §8.1) — LAST, exactly like the fuel
    // gate above and for the same reason. Refuses an EXPIRED issue tick (past the TTL, or a
    // cycle boundary crossed since issue). The expiry rules are good-INDEPENDENT, but the
    // ring guard is per-good, so every line is checked — a cart prices each good at the one
    // issue tick, and apply re-derives each from the ring at this same tick.
    for (const line of cart) {
      const quote = checkQuote(state, line.good, issueTick);
      if (!quote.valid) return quote;
    }
    return { valid: true };
  }

  if (action.type === 'buyAssetFromSyndicate') {
    // The asset analogue of buyFromSyndicate above — mirrors its gate STRUCTURE (docs/asset-
    // purchase.md "Failure modes"). The two differences: the vocabulary is buildable asset KINDS
    // (not priced goods), and there is NO guildHolds gate — an asset lands idle at any real
    // system, presence not required (asset-purchase.md "Destination").
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // WHAT MAY BE BOUGHT — the SELL catalog, not the build catalog: SYNDICATE_SELLABLE_KINDS =
    // BUILDABLE_KINDS minus spycraft (docs/asset-purchase.md §"What the Syndicate sells", RULED
    // 22-09-26). The two catalogs deliberately DIVERGE at spycraft — a guild builds it at its own
    // dockyard (commissionBuild keeps the full BUILDABLE_KINDS gate), but the Syndicate never
    // sells it, so a spycraft buy is refused LOUDLY here (not merely hidden from the UI).
    if (typeof action.assetKind !== 'string' || !SYNDICATE_SELLABLE_KINDS.includes(action.assetKind)) {
      const spycraftNote = typeof action.assetKind === 'string' && BUILDABLE_KINDS.includes(action.assetKind)
        ? ' — the Syndicate does not sell spycraft, it is guild-build-only; commission it at a dockyard'
        : '';
      return { valid: false, reason: `${JSON.stringify(action.assetKind)} is not a Syndicate-sellable kind (miner / factory, or a cargo transport)${spycraftNote}` };
    }
    if (typeof action.destinationSystemId !== 'string' || action.destinationSystemId.length === 0) {
      return { valid: false, reason: 'destinationSystemId must be a non-empty string' };
    }
    // A REAL system to deliver to — but NO guildHolds gate (asset-purchase.md "Destination"): an
    // idle asset is guild inventory located at a system, like a dockyard's output, so it may land
    // in any system that exists. Refused (not defaulted) when the system is unknown or no
    // waystation can reach it: an invented origin would silently invent an arrival tick, exactly
    // as the goods buy refuses.
    if (!getSystem(action.destinationSystemId)) {
      return { valid: false, reason: `system ${JSON.stringify(action.destinationSystemId)} is not a system on the seed` };
    }
    if (!nearestWaystation(action.destinationSystemId)) {
      return { valid: false, reason: `no Syndicate waystation can reach system ${JSON.stringify(action.destinationSystemId)} — it resolves to no seed coordinates` };
    }
    // THE PRICE — `max(FLOOR, round(partsCost × 0.8))`, priced at the ISSUE TICK's quoted parts
    // prices (§8.1 quote-lock), so the affordability check is measured against the same price
    // apply will charge. `priceAssetForPurchase` is null when a module has no quoted price at the
    // issue tick (the ring guard); `?? today's price` falls back to the current posted parts cost
    // ONLY so a co-occurring credits shortfall is still blamed FIRST — the "blame the other gate
    // first" discipline the goods buy documents. An expired quote is refused by the gate below.
    const issueTick = action.issueTick === undefined ? state.tick : action.issueTick;
    const quotedForCost = priceAssetForPurchase(state, action.assetKind, issueTick);
    const price = quotedForCost == null ? priceAssetForPurchase(state, action.assetKind, state.tick) : quotedForCost;
    if (price != null && guild.credits < price) {
      return { valid: false, reason: `guild ${guild.id} holds ${guild.credits} credits, cannot pay ${price} for a ${action.assetKind}` };
    }
    // THE FUEL GATE — the delivery flight burns route fuel, charged UP FRONT (asset-purchase.md
    // "Cost timing and fuel"). RUN LAST, like the goods buy, so a trade refused for credits /
    // kind / destination says so rather than blaming fuel. TWO delivery models, by kind:
    //   - a VEHICLE flies ITSELF in (2.2-foundation, phase-1-tuning §"Guild transports"): the burn
    //     is the craft's OWN `fuelCostToRun × hexDistance` (vehicleDeliveryFuelBurn), NOT a hauler.
    //   - a GROUND asset can't fly, so it rides a HEAVY hauler (⤳ RULED 14-09-26 §5.1: a non-movable
    //     T4 asset fills a HEAVY hold, `routeFuelCost(dest, ASSET_CARGO_VOLUME)` — the 0.7/hex rate).
    // A 0 means no route, already turned away by the waystation gate above.
    const { fuelBurn } = isVehicleClass(action.assetKind)
      ? vehicleDeliveryFuelBurn(action.destinationSystemId, action.assetKind)
      : routeFuelCost(action.destinationSystemId, ASSET_CARGO_VOLUME);
    const availableFuel = guild.fuelHoard + (guild.deuteriumFuel || 0);
    if (availableFuel < fuelBurn) {
      return { valid: false, reason: `guild ${guild.id} holds ${availableFuel} fuel (legal + contraband), cannot burn ${fuelBurn} flying a ${action.assetKind} to ${JSON.stringify(action.destinationSystemId)} — insufficient fuel: need ${fuelBurn}, have ${availableFuel}` };
    }
    // THE QUOTE-LOCK GATE (§8.1) — LAST, exactly like the goods buy and for the same reason: a
    // purchase that also fails credits, kind or fuel blames THAT first. The expiry rules (future,
    // too-old, cycle-boundary) are good-independent; a bill's modules all ride ONE per-tick ring
    // (recordPriceRing appends every priced good together), so a representative module answers the
    // ring guard for the whole bill — and priceAssetForPurchase has already refused above if ANY
    // module was unpriced at the issue tick.
    const quote = checkQuote(state, Object.keys(assetBill(action.assetKind))[0], issueTick);
    if (!quote.valid) return quote;
    return { valid: true };
  }

  // --- Operator adjust levers (docs/operator-adjust.md §3) ---------------------
  // Each reject-wholes on any failure (state untouched, §2); a signed `delta` scalar
  // is a non-zero integer (a zero adjust is a no-op, refused — §6). The conserving
  // counter-move lives in apply; validate only proves the move is legal.

  if (action.type === 'adjustCredits') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.delta !== 'number' || !Number.isInteger(action.delta) || action.delta === 0) {
      return { valid: false, reason: 'delta must be a non-zero integer (§15.2) — a zero adjust is a refused no-op (§6)' };
    }
    // A removal may not drive the guild's credits below zero (§3.1/§6): guild credits
    // are non-negativity-enforced; only the Syndicate ledger is exempt (and it absorbs
    // the counter-move, so it may go negative — exactly as founding leaves it).
    if (guild.credits + action.delta < 0) {
      return { valid: false, reason: `guild ${guild.id} holds ${guild.credits} credits, cannot remove ${-action.delta} — it would go below zero` };
    }
    return { valid: true };
  }

  if (action.type === 'adjustFuel') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.delta !== 'number' || !Number.isInteger(action.delta) || action.delta === 0) {
      return { valid: false, reason: 'delta must be a non-zero integer (§15.2) — a zero adjust is a refused no-op (§6)' };
    }
    // Targets the LEGAL hoard only (§3.2), never contraband `deuteriumFuel`. A removal
    // may not drive it below zero (a store, never a debt); the audit counter-move keeps
    // invariant 1 closed on either side.
    if (guild.fuelHoard + action.delta < 0) {
      return { valid: false, reason: `guild ${guild.id} holds ${guild.fuelHoard} legal fuel, cannot remove ${-action.delta} — it would go below zero` };
    }
    return { valid: true };
  }

  if (action.type === 'adjustGoods') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // Unknown target first (§6): a real system, a known stockpile good. `isStockpileGood`
    // excludes fuel (`deuterium_fuel` is not a stockpile key), so a fuel adjust is refused
    // here and belongs on adjustFuel.
    if (typeof action.systemId !== 'string' || !getSystem(action.systemId)) {
      return { valid: false, reason: `system ${JSON.stringify(action.systemId)} is not a system on the seed` };
    }
    if (typeof action.good !== 'string' || !isStockpileGood(action.good)) {
      return { valid: false, reason: `${JSON.stringify(action.good)} is not a known stockpile good` };
    }
    if (typeof action.delta !== 'number' || !Number.isInteger(action.delta) || action.delta === 0) {
      return { valid: false, reason: 'delta must be a non-zero integer (§15.2) — a zero adjust is a refused no-op (§6)' };
    }
    // The cell may not go below zero (§3.3). getStock is 0 for an absent pool/good.
    if (getStock(guild, action.systemId, action.good) + action.delta < 0) {
      return { valid: false, reason: `guild ${guild.id} holds ${getStock(guild, action.systemId, action.good)} ${action.good} in system ${JSON.stringify(action.systemId)}, cannot remove ${-action.delta} — it would go below zero` };
    }
    return { valid: true };
  }

  if (action.type === 'grantAsset') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.kind !== 'string' || !isAssetKind(action.kind)) {
      return { valid: false, reason: `${JSON.stringify(action.kind)} is not an asset kind (miner / factory)` };
    }
    if (typeof action.systemId !== 'string' || !getSystem(action.systemId)) {
      return { valid: false, reason: `system ${JSON.stringify(action.systemId)} is not a system on the seed` };
    }
    return { valid: true };
  }

  if (action.type === 'removeAsset') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // `occupied` defaults to 'detach' when omitted; any other value is a caller bug —
    // reject-whole rather than silently pick a mode (§3.5).
    if (action.occupied !== undefined && action.occupied !== 'detach' && action.occupied !== 'close') {
      return { valid: false, reason: `occupied must be "detach" or "close" (default "detach"), got ${JSON.stringify(action.occupied)}` };
    }
    // Reject ONLY an unknown asset (§3.5): removal always succeeds otherwise, by keeping
    // the state consistent (detach nulls the pointer, close removes the venture).
    const asset = (guild.assets || []).find((a) => a.id === action.assetId);
    if (!asset) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no asset ${JSON.stringify(action.assetId)}` };
    }
    return { valid: true };
  }

  if (action.type === 'removeVenture') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // `asset` defaults to 'keep' when omitted; any other value is a caller bug (§3.6).
    if (action.asset !== undefined && action.asset !== 'keep' && action.asset !== 'remove') {
      return { valid: false, reason: `asset must be "keep" or "remove" (default "keep"), got ${JSON.stringify(action.asset)}` };
    }
    // Reject ONLY an unknown venture (§3.6). Scan only THIS guild's ventures — removing a
    // venture is an act on one you own, exactly as decommissionVenture scopes its lookup.
    const venture = (guild.ventures || []).find((v) => v.id === action.ventureId);
    if (!venture) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no venture with id ${JSON.stringify(action.ventureId)}` };
    }
    return { valid: true };
  }

  if (action.type === 'spawnVehicle') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    if (typeof action.class !== 'string' || !isVehicleClass(action.class)) {
      return { valid: false, reason: `${JSON.stringify(action.class)} is not a vehicle class (lightTransport / mediumTransport / heavyTransport / spycraft)` };
    }
    // The location must be EXACTLY ONE valid form — a landmark (system | outpost) that resolves,
    // or an in-bounds bare hex. resolveVehicleLocation is the one judge (both-set, both-null, an
    // unresolvable landmark and an off-lattice hex all return null); refuse-whole on anything else.
    if (resolveVehicleLocation(action.location) === null) {
      return { valid: false, reason: `location must be exactly one of a landmark { landmarkKind: "system"|"outpost", landmarkId } that resolves, or an in-bounds hex { q, r } — got ${JSON.stringify(action.location)}` };
    }
    // condition (default new / 1) is a fraction in [MIN, NEW] = [0, 1] — the maintenanceCondition
    // scale (sim/assets.js). Only refuse an explicitly-supplied bad one; omitted defaults to new.
    if (action.condition !== undefined) {
      const c = action.condition;
      if (typeof c !== 'number' || !Number.isFinite(c) || c < ASSET_CONDITION_MIN || c > ASSET_CONDITION_NEW) {
        return { valid: false, reason: `condition must be a number in [${ASSET_CONDITION_MIN}, ${ASSET_CONDITION_NEW}] (default ${ASSET_CONDITION_NEW}), got ${JSON.stringify(c)}` };
      }
    }
    return { valid: true };
  }

  if (action.type === 'removeVehicle') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // Reject ONLY an unknown craft (design.md §15.4): removal otherwise always succeeds. Scan
    // this guild's own vehicles — a craft is destroyed by the guild that owns it.
    const vehicle = (guild.vehicles || []).find((v) => v.id === action.vehicleId);
    if (!vehicle) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no vehicle ${JSON.stringify(action.vehicleId)}` };
    }
    return { valid: true };
  }

  if (action.type === 'spawnOutpost') {
    // design.md §4 / §15.4 (the outpost ladder, slice 1): place one guild Outpost. The operator
    // places FREELY (like spawnVehicle) — placement RANGE and anchor-ownership are the real
    // build/deploy slice's, DEFERRED here. The gates, in order:
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // The anchor must resolve to a REAL system (an outpost anchors ONLY to a system, §4 — never to
    // another outpost, mirroring the Toll Gate anchor rule). Reference only this slice.
    if (!getSystem(action.anchorSystemId)) {
      return { valid: false, reason: `anchorSystemId ${JSON.stringify(action.anchorSystemId)} is not a real system` };
    }
    // The hex must be a well-formed, in-bounds lattice coordinate (isHexInBounds checks integer +
    // in-radius, derived from the seed's own galaxyParams — no invented number).
    const coords = action.coords;
    if (!coords || typeof coords !== 'object' || Array.isArray(coords) || !isHexInBounds(coords.q, coords.r)) {
      return { valid: false, reason: `coords must be an in-bounds hex { q, r } of integers, got ${JSON.stringify(coords)}` };
    }
    // ONE STRUCTURE PER HEX (§4 / §2): the hex must not already hold a seed landmark (a system, a
    // Syndicate waystation, or the Citadel) ...
    const landmark = seedLandmarkAtHex(coords.q, coords.r);
    if (landmark) {
      return { valid: false, reason: `hex { q: ${coords.q}, r: ${coords.r} } is already occupied by ${landmark.kind} ${JSON.stringify(landmark.id)} — one structure per hex` };
    }
    // ... nor another guild Outpost (toll gates are not built yet, so there is none to check; a
    // claim occupies its landmark's hex, already covered by the seed-landmark check above).
    const occupied = (state.outposts || []).find((o) => o.coords && o.coords.q === coords.q && o.coords.r === coords.r);
    if (occupied) {
      return { valid: false, reason: `hex { q: ${coords.q}, r: ${coords.r} } is already occupied by outpost ${JSON.stringify(occupied.id)} — one structure per hex` };
    }
    return { valid: true };
  }

  if (action.type === 'removeOutpost') {
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // Reject an unknown outpost OR one this guild does not own (design.md §4: teardown is an act on
    // an outpost you own). Outposts are SHARED (state.outposts), so the owner check is explicit,
    // unlike the guild-nested vehicles.
    const outpost = (state.outposts || []).find((o) => o.id === action.outpostId);
    if (!outpost || outpost.ownerGuildId !== action.guildId) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no outpost ${JSON.stringify(action.outpostId)}` };
    }
    return { valid: true };
  }

  if (action.type === 'dispatchVehicle') {
    // transport-model.md §4 (the polyline model): send an IDLE craft along a multi-leg route,
    // refused whole with a clear reason (mirroring spawnVehicle's block). The order of the gates is
    // the order of the doc's ruled failure modes.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const craft = (guild.vehicles || []).find((v) => v.id === action.vehicleId);
    if (!craft) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no vehicle ${JSON.stringify(action.vehicleId)}` };
    }
    // Only an idle craft dispatches (§4: an in-transit one is already flying its frozen route). A
    // craft IN A DOCK SLOT carries the `loading` status (design.md §4 "a craft in a slot runs to
    // completion — no mid-transfer abort"), so this same idle gate refuses it; the message names the
    // dock case so an operator knows to wait for the turnaround rather than that the craft is flying.
    // A PARKED or QUEUED craft is plain `idle` and dispatches freely — the queued case CANCELS its
    // pending manifest in apply below (§4 "a parked or queued craft is cancelled by being re-dispatched").
    if (craft.status !== 'idle') {
      const why = craft.status === 'loading'
        ? 'mid-transfer in a dock slot and runs to completion — it cannot be re-dispatched (§4)'
        : `not idle (status ${JSON.stringify(craft.status)}) — only an idle craft dispatches`;
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is ${why}` };
    }
    // Build + price the route (dispatchRoute is the one home): a non-empty waypoint list, every
    // waypoint resolves, and no zero-length leg. It returns the whole-route unit burn.
    const route = dispatchRoute(craft, action.waypoints);
    if (!route.ok) {
      return { valid: false, reason: route.reason };
    }
    // The FUEL gate — the SAME combined-availability gate the buy uses (hoard + contraband), refuse
    // whole (§4: no partial dispatch, no stranding). The credit figure is display-only; units gate.
    const available = guild.fuelHoard + (guild.deuteriumFuel || 0);
    if (available < route.totalUnits) {
      return { valid: false, reason: `dispatch burns ${route.totalUnits} fuel units up front but the guild holds ${available} (hoard ${guild.fuelHoard} + contraband ${guild.deuteriumFuel || 0}) — refused whole (transport-model.md §4)` };
    }
    return { valid: true };
  }

  if (action.type === 'transferCargo') {
    // design.md §4 "The dock model" (the SYSTEM half, roadmap 2.2 cargo engine slice 1): load/unload
    // an idle craft against the system it sits at, resolved instantly. The gates, in the order a
    // failure is felt (mirroring dispatchVehicle's block):
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const craft = (guild.vehicles || []).find((v) => v.id === action.vehicleId);
    if (!craft) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no vehicle ${JSON.stringify(action.vehicleId)}` };
    }
    // Only an idle craft transfers (§4: an in-transit one is mid-flight, carrying no location; a
    // transfer is issued at a berth). The idle check also guarantees `craft.location` is present.
    if (craft.status !== 'idle') {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is not idle (status ${JSON.stringify(craft.status)}) — only an idle craft loads or unloads` };
    }
    // WHERE the craft sits decides HOW (design.md §4 "Where it happens decides how"):
    //  - at a SYSTEM landmark → the transfer is INSTANT (slice 1, unchanged): a guild's own territory
    //    has unlimited handling, so the manifest resolves the tick it is issued.
    //  - at one of the guild's OWN Outposts (reached by hex-coincidence, ownedOutpostAtCraft) → the
    //    DOCK model (slice 2): the manifest is queued for a slot and resolves after the class
    //    turnaround, NOT now. Own-only (§4 — only the owning guild's craft dock).
    //  - anywhere else (deep space, or a bare hex with no owned Outpost) → refused: no store to move.
    const atSystem = !!(craft.location && craft.location.landmarkKind === 'system');
    const outpost = atSystem ? null : ownedOutpostAtCraft(state, action.guildId, craft);
    if (!atSystem && !outpost) {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is in deep space (no system or owned Outpost at its berth) — a transfer is issued at a store (§4)` };
    }
    if (outpost) {
      // A capacity-0 craft (spycraft) carries no cargo and has no ruled dock turnaround (§4 /
      // phase-1-tuning.md), so there is nothing to transfer and no timer to size — refuse it rather
      // than invent a turnaround (§15.2 "Never invent a number").
      if (outpostDockTurnaround(craft.class) === null) {
        return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} (class ${JSON.stringify(craft.class)}) carries no cargo and cannot dock at an Outpost (§4)` };
      }
      // ONE MANIFEST PER CRAFT (§4): a craft already queued or loading here can't stack a second — I
      // refuse rather than replace, so a pending manifest is never silently overwritten. (A LOADING
      // craft is already refused by the idle gate above; this catches a QUEUED craft, which stays idle.)
      if (isDockedAt(outpost, craft.id)) {
        return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} already has a manifest queued/loading at Outpost ${JSON.stringify(outpost.id)} — cancel it (re-dispatch) before issuing another (§4)` };
      }
    }
    // A craft RUNNING A LANE is driven by its lane (transport-model.md §11.10). The one time such a craft
    // is idle and not already queued is a lane WAITING for fuel at its last stop — and a manual transfer
    // there would cut across the lane: at an Outpost, the dock completion would advance the lane as if it
    // were the lane's own stop, and the fuel re-attempt could launch a craft sitting in a dock slot. So it
    // is refused; stop the lane or re-dispatch the craft first.
    if (craft.route) {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is running a lane — a manual transfer would cut across its stops; stop the lane or re-dispatch the craft first (transport-model.md §11.10)` };
    }
    // The manifest is a NON-EMPTY ordered array of well-formed lines (a transfer with no lines is a
    // refused no-op, the adjustGoods zero-delta / dispatch empty-waypoints discipline). Refuse-whole
    // on the first bad line via the shared `manifestError` — a malformed manifest never partially applies.
    const mError = manifestError(action.manifest);
    if (mError) return { valid: false, reason: mError };
    return { valid: true };
  }

  if (action.type === 'dispatchRouteWithActions') {
    // transport-model.md §11 (the automation layer, slice 1a): send an idle craft along a route of
    // { anchor, action? } waypoints, executed leg by leg. Validate WHOLE, refuse WHOLE — the existing
    // dispatch discipline — with the gates in the order a failure is felt (mirroring dispatchVehicle).
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const craft = (guild.vehicles || []).find((v) => v.id === action.vehicleId);
    if (!craft) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no vehicle ${JSON.stringify(action.vehicleId)}` };
    }
    // Only an idle craft dispatches (an in-transit / loading one is already engaged — the same gate,
    // and the same message, dispatchVehicle uses).
    if (craft.status !== 'idle') {
      const why = craft.status === 'loading'
        ? 'mid-transfer in a dock slot and runs to completion — it cannot be re-dispatched (§4)'
        : `not idle (status ${JSON.stringify(craft.status)}) — only an idle craft dispatches`;
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is ${why}` };
    }
    // The waypoints must be a NON-EMPTY ordered array of { anchor, action? } objects (§11.1). Each is
    // checked ON ITS OWN by the shared `routeWaypointError` (the same gate `saveRoute` uses), refuse-whole
    // on the first bad one; the legs BETWEEN them are built + priced through `dispatchRoute` below.
    if (!Array.isArray(action.waypoints) || action.waypoints.length === 0) {
      return { valid: false, reason: 'waypoints must be a non-empty ordered array of { anchor, action? } waypoints' };
    }
    for (let i = 0; i < action.waypoints.length; i += 1) {
      const wp = action.waypoints[i];
      const wpError = routeWaypointError(wp, i);
      if (wpError) return { valid: false, reason: wpError };
      // A capacity-0 craft (spycraft) carries no cargo, so an action it can never perform is a
      // whole-route refusal (§11 — validate whole, refuse whole), not a silent no-op on arrival.
      if (wp.action !== undefined && craft.capacity === 0) {
        return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} (class ${JSON.stringify(craft.class)}) carries no cargo (capacity 0) and cannot run a route with an action (§11)` };
      }
    }
    // The LAUNCH MODE (§11.10): once (the default) / continuous / nRun with n >= 1, and a repeating
    // mode's optional cadence (immediate / perCycle).
    const rError = repeatError(action.repeat);
    if (rError) return { valid: false, reason: rError };
    // A REPEATING lane needs at least two waypoints. Its lap is one cycle W1 → … → WN, and with one stop
    // that cycle has NO leg — WN is W1, so every lap after the first would reposition zero-length (skipped,
    // §11.4) and resolve W1 in place again at once: the lane would lap in place, without end, inside a
    // single tick (§11.2 / §15.4 — every lap step must hang off a real arrival or turnaround). With two or
    // more stops the W1 → W2 leg is real (a dead internal leg is refused below), so every lap takes time.
    const repeating = action.repeat !== undefined && action.repeat.mode !== 'once';
    if (repeating && action.waypoints.length < 2) {
      return { valid: false, reason: `a repeating lane needs at least two waypoints — a one-stop cycle has no leg to fly, so it would lap in place within one tick (transport-model.md §11.4 / §11.10)` };
    }
    // Build + price the WHOLE route (dispatchRoute is the one home): leg 0 from the craft's location
    // through every waypoint anchor, each resolving and non-zero-length. It returns the whole-run burn.
    // A craft ALREADY on W1 has a zero-length leg 0 — the §11.4 reposition skip leaves it out (no leg, no
    // fuel) instead of refusing; any other zero-length leg is still refused. For a REPEATING lane this is
    // LAP 1 (the positioning to W1 plus the first cycle, §11.4) — each later lap is fuelled at its own
    // start, from the last waypoint (advanceRoute), so the launch only has to afford lap 1 (§11.3).
    const route = dispatchRoute(craft, action.waypoints.map((wp) => wp.anchor), { skipZeroLengthFirstLeg: true });
    if (!route.ok) {
      return { valid: false, reason: route.reason };
    }
    // ACT IN PLACE (§11.9): the route's only stop is the craft's own berth, so there is no leg — the whole
    // run is that stop's action, done where the craft stands. Without an action it would do nothing at
    // all, so it is refused. This check lives here, not in dispatchRoute, because only here can we see
    // the waypoints' actions (dispatchRoute is handed bare anchors).
    if (route.actInPlace && action.waypoints[0].action === undefined) {
      return { valid: false, reason: 'a one-stop route at the craft\'s own berth with no action does nothing — nothing to fly and nothing to do (transport-model.md §11.9 / §4)' };
    }
    // The FUEL gate — the whole run (a repeating lane: its lap 1) is fuelled UP FRONT (§11.3), so the
    // SAME combined-availability gate a plain dispatch uses (hoard + contraband ≥ Σ legFuelBurn), refused
    // WHOLE. At launch an unaffordable lap 1 is REFUSED, never left waiting (§11.6 — WAIT is mid-run only).
    const available = guild.fuelHoard + (guild.deuteriumFuel || 0);
    if (available < route.totalUnits) {
      return { valid: false, reason: `route burns ${route.totalUnits} fuel units up front but the guild holds ${available} (hoard ${guild.fuelHoard} + contraband ${guild.deuteriumFuel || 0}) — refused whole (transport-model.md §11.3)` };
    }
    return { valid: true };
  }

  if (action.type === 'saveRoute') {
    // transport-model.md §11.9: store a named, origin-free route on the guild. Refuse WHOLE on the first
    // bad field — nothing is written unless every waypoint passes.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    // The name is the upsert key, so it must be real text. It is compared and stored TRIMMED (apply
    // below), so a name that is only whitespace is as empty as "".
    if (typeof action.name !== 'string' || action.name.trim().length === 0) {
      return { valid: false, reason: `name must be a non-empty string, got ${JSON.stringify(action.name)}` };
    }
    if (!Array.isArray(action.waypoints) || action.waypoints.length === 0) {
      return { valid: false, reason: 'waypoints must be a non-empty ordered array of { anchor, action? } waypoints' };
    }
    // The SAME per-waypoint gate dispatchRouteWithActions runs (§11.9). A saved route is ORIGIN-FREE —
    // there is no craft yet — so there is deliberately no leg-length or fuel check here: those are
    // judged when the route is dispatched, from wherever the craft then is.
    for (let i = 0; i < action.waypoints.length; i += 1) {
      const wpError = routeWaypointError(action.waypoints[i], i);
      if (wpError) return { valid: false, reason: wpError };
    }
    return { valid: true };
  }

  if (action.type === 'deleteRoute') {
    // transport-model.md §11.9: remove one of the guild's saved routes by id. Reject only an id the
    // guild does not hold (scanned within this guild — a guild deletes only its own routes).
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const route = (guild.savedRoutes || []).find((r) => r.id === action.routeId);
    if (!route) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} has no saved route ${JSON.stringify(action.routeId)}` };
    }
    return { valid: true };
  }

  if (action.type === 'stopRouteAfterRun') {
    // transport-model.md §11.10 "Stop after this run" — repeating lanes only. Refuse anything it cannot
    // mean: a craft with no lane, a one-shot (it already ends after this run), or a lane already stopping
    // (a second stop would change nothing — the refused-no-op discipline).
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const craft = (guild.vehicles || []).find((v) => v.id === action.vehicleId);
    if (!craft) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no vehicle ${JSON.stringify(action.vehicleId)}` };
    }
    if (!craft.route) {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is not running a route — there is no lane to stop` };
    }
    if (craft.route.mode === undefined) {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is on a one-shot route — it already ends after this run (only a repeating lane can be stopped after its run, §11.10)` };
    }
    if (craft.route.stopAfterRun) {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is already set to stop after this run` };
    }
    return { valid: true };
  }

  if (action.type === 'cancelRoute') {
    // transport-model.md §11.10 "Cancel" — end the craft's lane now. A craft is ON A LANE when it is flying
    // (it has a `trip` — a routed leg, or a plain dispatch) or when it holds a `route` while parked (waiting
    // at its last stop, or queued / loading at an Outpost stop). A craft with neither is an ordinary idle
    // craft: there is nothing to cancel, so it is refused.
    const guild = findGuild(state, action.guildId);
    if (!guild) {
      return { valid: false, reason: `no guild with id ${JSON.stringify(action.guildId)}` };
    }
    const craft = (guild.vehicles || []).find((v) => v.id === action.vehicleId);
    if (!craft) {
      return { valid: false, reason: `guild ${JSON.stringify(action.guildId)} owns no vehicle ${JSON.stringify(action.vehicleId)}` };
    }
    if (!craft.trip && !craft.route) {
      return { valid: false, reason: `vehicle ${JSON.stringify(action.vehicleId)} is not on a lane — it is idle with no route, so there is nothing to cancel` };
    }
    // A craft in flight must have somewhere to stop: the SAME cancelLanding the apply uses.
    if (craft.trip) {
      const landing = cancelLanding(craft, state.tick);
      if (!landing.ok) return { valid: false, reason: landing.reason };
    }
    return { valid: true };
  }

  if (action.type === 'setWindowN') {
    if (typeof action.windowN !== 'number' || !Number.isInteger(action.windowN) || action.windowN < 1) {
      return { valid: false, reason: 'windowN must be an integer >= 1 (§15.2)' };
    }
    // Setup-only knob: the window length is fixed BEFORE the run. Once the galaxy
    // has advanced (tick > 0) changing it would move the boundary cadence mid-run,
    // so refuse it — no state change.
    if (state.tick > 0) {
      return { valid: false, reason: `windowN is a setup-only knob — state.tick is ${state.tick}, it can only be set before the run starts (tick 0)` };
    }
    // ...and not once any licence has been signed (Slice 3b-i). A licence's fee and
    // committed quantity are both computed over ONE WINDOW at signing and then locked;
    // moving `N` afterwards would silently make those locked terms describe a window
    // that no longer exists. Set the window length first, then license. (Reachable
    // only at tick 0, where a licence can legitimately already exist.)
    const licensed = (state.guilds || []).some((g) => (g.ventures || []).some((v) => v.licence));
    if (licensed) {
      return { valid: false, reason: 'windowN cannot change once a licence has been signed — its fee and committed quantity are locked over one window of the length in force at signing' };
    }
    return { valid: true };
  }

  return { valid: false, reason: `unknown action type: ${action.type}` };
}

// Applies ONE already-validated action. Never mutates `state` — returns a
// new state. Callers MUST validate first; this does not re-check.
function applyAction(state, action) {
  const next = structuredClone(state);
  if (action.type === 'paySyndicateFee') {
    const guild = findGuild(next, action.guildId);
    guild.credits -= action.amount;
    next.syndicate.ledger += action.amount;
    return next;
  }
  if (action.type === 'foundGuild') {
    // Seat the guild on its home: record the denormalised home pointer and add
    // the ownership claim (the source of truth). The Terran homeworld is the
    // system's lowest-id Terran planet, resolved from the seed.
    const homePlanetId = getTerranHomeworld(action.homeSystemId);
    // THE STARTER ASSET GIFT (design.md §4, docs/phase-1-tuning.md "Starter asset
    // gift"): 15 Miners + 10 Factories, idle, in inventory. It is ENGINE POLICY,
    // not an action field — exactly like the `fuelHoard` grant below — so the action shape
    // is byte-identical to before this slice and no caller can ask for a different
    // gift. The counts and the deterministic id scheme both live in sim/assets.js;
    // nothing is inlined here. Every starter asset is granted AT THE GUILD'S HOME
    // SYSTEM (design.md §4, 12-09-26) — its idle inventory location — so the home
    // id passes straight through to each spec's `systemId`.
    const assets = starterAssetSpecs(action.guildId, action.homeSystemId);
    // The pool each inline venture draws from, split by kind and consumed in order.
    const unclaimed = { miner: assets.filter((a) => a.kind === 'miner'), factory: assets.filter((a) => a.kind === 'factory') };

    // Two stamps per inline venture:
    //
    // 1. Its denormalised systemId, from its site (ruling B1, §15.2) — the pool key
    //    production deposits into. This mirrors what establishVenture does; without
    //    it an inline-founded mine would pool its goods under a `null` system
    //    instead of the one its node sits in. (The flat guild total is unaffected
    //    either way — guildTotals sums across pools — but the per-system breakdown,
    //    and any consumer keyed by system, must be right.)
    // 2. Its `assetId` — INLINE VENTURES OCCUPY TOO (§4, 30-08-26), taking a starter
    //    asset of their matching kind out of the very pool this founding grants
    //    (validateAction has already proved the pool is big enough). Deterministic
    //    by construction: the specs are minted in a fixed order and consumed in the
    //    founding's own venture order, so two runs of the same scenario attach the
    //    same machine to the same venture (invariant 9). Any `assetId` a caller put
    //    on an inline venture is OVERWRITTEN, not honoured: the pool is minted here,
    //    so a caller's id could only name a machine that does not exist.
    const ventures = (action.ventures || []).map((v) => {
      const site = v.systemId == null && v.siteId != null ? getSite(v.siteId) : null;
      return {
        ...v,
        ...(site ? { systemId: site.systemId } : {}),
        assetId: unclaimed[assetKindForVentureType(v.type)].shift().id,
      };
    });
    const guild = createGuild({
      id: action.guildId,
      name: action.name,
      isBot: action.isBot,
      credits: action.credits,
      fuelHoard: GUILD_STARTING_FUEL, // the starter floor -- see createFoundGuildAction's note
      influence: action.influence,
      incomeRate: action.incomeRate,
      homeSystemId: action.homeSystemId,
      homePlanetId,
      assets,
      ventures,
    });
    next.guilds.push(guild);
    next.claims.push({
      claimId: `claim_home_${action.guildId}`,
      ownerGuildId: action.guildId,
      landmarkId: action.homeSystemId,
      landmarkKind: 'system',
      claimedAtTick: next.tick,
      contested: false,
    });
    // THE FOUNDING ENDOWMENT (docs/points-and-reputation.md §2.5, A′). Set HERE, after the
    // home claim above, because the amount is sized off the systems the guild holds — and
    // it holds none until that claim exists.
    //
    // WHY A NEWBORN NEEDS IT: Points count held systems, reputation is earned per venture.
    // A guild founded a moment ago holds its home system (GP 12) and has no ventures — the
    // starter assets it was just gifted are IDLE INVENTORY and score nothing — so its bar
    // is 1800 against an RP of 0 and the issuance modifier pins at the FLOOR. Without this
    // grant every brand-new guild is throttled to 30% fuel before it has had any chance to
    // earn, at exactly the moment the game wants people founding.
    //
    // IT NEUTRALISES THE GRANTED HOME BASE, ONCE, AND NOTHING ELSE. Sized off the SYSTEM
    // half of Points alone (`foundingEndowmentFor`, sim/meanline.js), so:
    //   - inline ventures are NOT endowed — even the ones this very founding attaches.
    //     Ventures earn their own bar (§1.2), so they start below the line and climb;
    //   - every system claimed AFTER founding raises the bar with no matching grant, so
    //     sprawl still sinks a guild and density-beats-sprawl is untouched.
    // It is DERIVED from `MEANLINE_K` and `W_SYS`, both already ruled, so it invents no
    // number and tracks a retune of either.
    //
    // PRECEDENT: founding is already reputation-special in exactly this direction — the
    // genesis home-claim deliberately withholds the "+20 for an uncontested claim" bonus
    // just below, because that is for play actions, not founding. Founding is NEUTRAL, not
    // earned; this is the same instinct, pointed the other way.
    const endowment = foundingEndowmentFor(next, guild);
    if (endowment !== 0) guild.foundingEndowment = endowment;
    // The guild total is the sum the tripwire asserts. Inline ventures normally carry no
    // reputation, but they are summed rather than assumed away so a scenario that hands one
    // in cannot silently break `checkGuildReputationSum` on the founding tick.
    guild.guildReputation = (guild.ventures || []).reduce((n, v) => n + (v.reputation || 0), 0) + endowment;

    // THE FUEL Δ FOUNDING BASELINE (docs/guild-hall.md §2, the expected-fuel-change gauge).
    // Stamped HERE, after the home claim, the endowment and the reputation total are all in
    // place — so `grantFor` reads the guild's REAL founding GP (home system + inline ventures)
    // and the modifier its founding standing earns. It is the credit entitlement the guild
    // would be granted at this instant, and it is the gauge's DENOMINATOR until the first cycle
    // boundary records a real `fuelGrant.entitlement`: `predictedGrant` and this are computed
    // from ONE GP/modifier at founding, so the ratio opens at exactly ×1.00 and swings live as
    // the guild grows this cycle — no `—` gap before the first boundary.
    //
    // AN HONEST DEDICATED BASELINE, mirroring `foundingEndowment` right above — NOT a synthesised
    // `lastFuelGrant`: no grant happened, so the boundary machinery and the grant tripwires must
    // never see a phantom one. Integer credits (`grantFor` rounds, §15.2), tick-anchored by the
    // founding it rides. Omitted when 0 (a zero-GP founding draws nothing, so there is no baseline
    // to divide from and the gauge honestly reads `—`), exactly as `foundingEndowment` is.
    const foundingEntitlement = grantFor(next, guild);
    if (foundingEntitlement !== 0) guild.foundingEntitlement = foundingEntitlement;

    // The ledger FUNDS the starting credits: credits move Syndicate -> guild,
    // none are created. expectedCreditTotal is unchanged (guild +C, ledger -C
    // => net 0), so invariant 2 still holds. Founding does NOT grant the +20
    // claim bonus (setup, not a play action -- see createFoundGuildAction).
    next.syndicate.ledger -= action.credits;

    // FUEL-GENESIS, and the audit entry that makes it honest. Invariant 1 reads
    //   Σ guild.fuelHoard + reserve.reserveLevel + inTransit
    //     === audit.totalProduced - audit.totalConsumed
    // so a hoard that appears from nowhere must be recorded as PRODUCED, or the
    // left side grows while the right side does not and the tripwire fires on
    // the very tick a guild is born. `totalProduced` is a monotonic counter, so
    // this only ever adds. (createState does the same sum for scenario guilds --
    // see sim/state.js's `totalProduced: sumFuelHoards(guilds) + reserveLevel`.)
    next.audit.totalProduced += GUILD_STARTING_FUEL;

    // THE BETWEEN-TICK SEAM, exactly as sellToSyndicate documents it below:
    // `state.galacticSupply` is a CACHE the tick refreshes once after its eight
    // steps, and the galactic-supply-consistency invariant compares that cache
    // against a live recompute. `POST /action` asserts every invariant right
    // after apply, with no tick in between, so founding a guild with a non-zero
    // hoard and leaving `fuel.guildHeld` stale would trip that check and return
    // a 500 instead of landing the founding. Refreshed through the same one
    // selector the tick uses -- not a second derivation.
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }
  if (action.type === 'establishVenture') {
    // Seat a new venture on the guild. No credits/fuel move (no site cost yet).
    // It starts producing on the NEXT production step: because intake runs before
    // the tick's steps, establishing + ticking in the same advance() call runs
    // its first batch immediately, exactly as an inline founding venture does.
    // A mining venture carries resourceType; a refining one carries recipeId
    // (createVenture defaults the unused one to null).
    const guild = findGuild(next, action.guildId);
    // Resolve the site once more (validateAction already proved it exists) to
    // stamp the venture's systemId — the pool key production uses (ruling B1,
    // §15.2). Denormalised from the site, guarded against it by invariants.js.
    const site = getSite(action.siteId);
    // OCCUPY, NOT CONSUME (design.md §4). Gate 2 already proved the NAMED asset is
    // owned by this guild, idle, and of the matching kind, so the apply simply points
    // the new venture at it — no re-derivation here, and no second opinion about
    // which machine was meant. The asset is NOT removed from `guild.assets`: it is
    // still owned, it is simply now referenced, and that reference is the whole of
    // what "deployed" means. Deploy is one-way in this slice — nothing returns an
    // asset to idle until cancel-licence exists (§4).
    guild.ventures.push(createVenture({
      id: action.ventureId,
      ownerGuildId: action.guildId,
      type: action.ventureType || 'mining',
      siteId: action.siteId,
      systemId: site ? site.systemId : null,
      assetId: action.assetId,
      resourceType: action.resourceType,
      recipeId: action.recipeId,
      // The caller's rate, or the venture's baseline when it named none (design.md §2) —
      // the one function validation already approved it through.
      productionRate: establishRateFor(action),
      // equityPct: the ONE licence term this slice lets the establish path set (§5's
      // equity lever, validated above). Absent ⇒ createVenture's 0, and the venture
      // carries no key at all. The rest of the terms — commitment %, the fee locked
      // at issuance, the renegotiation window — arrive with the real licence entity
      // (Slice 3b); they are not invented here.
      equityPct: action.equityPct,
      // syndicateCommitment is NOT taken from the action: it is engine-owned and
      // defaults to 0 (unlicensed) in createVenture. Every venture established
      // today is unlicensed, so the establish path never supplies it — the
      // reserved placeholder shape (design.md §15.4, §5) lands at 0.
    }));
    pruneLockout(next, action.siteId);
    return next;
  }
  if (action.type === 'setProductionProfile') {
    // Merge the validated patch into the guild's profile via sim/profile.js — the
    // one file that owns the nested shape. This mutates OWNED state only; it moves
    // no credits/fuel and no tick step reads the profile yet (slice 2a-ii), so it
    // is a behavioural no-op on production. Sibling owned-state actions
    // (establishVenture) do NOT stamp a tick on the mutated entity — the profile
    // shape carries no updatedAtTick field (§15.4) — so, per §15.2's "match how
    // sibling actions handle it; if they don't stamp, don't invent it," this
    // doesn't either.
    const guild = findGuild(next, action.guildId);
    setEntry(guild, action.systemId, { goods: action.goods, throttles: action.throttles });
    return next;
  }
  if (action.type === 'setSyndicateCommitment') {
    // Write the venture's committed quantity — engine-owned state (§5/§15.4). Moves
    // no credits/fuel. It DELIBERATELY does not set committedFromTick — leaving it
    // absent keeps windowFraction at 1, so this scaffold commits for the whole window,
    // which is the behaviour its tests pin — and does not stamp updatedAtTick; the
    // sibling owned-state actions
    // (establishVenture, setProductionProfile) don't stamp the entity they mutate,
    // and §15.2 says match how the siblings handle it, don't invent a field.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    venture.syndicateCommitment = action.commitment;
    return next;
  }
  if (action.type === 'applyForLicence') {
    // Grant the licence: compute the terms ONCE, here, and store them. Everything this
    // reads is state-as-it-stands — the posted price at this tick, the venture's own
    // equity offer, its type's droidless baseline — so a licence signed at a different
    // moment is a different contract, which is exactly §5's "rewards reading the market
    // and timing your lock". Moves NO credits: 3b-iii debits the fee at a boundary.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    // The OUTPUT good — the price engine posts one for every processed good exactly as
    // it does for a raw one, so a factory's fee is priced off its own product, not its
    // inputs. `baselineOutputFor` is the single source for both halves of that (the good
    // and the droidless units/tick), for a mine and a factory alike — no number invented.
    const baseline = baselineOutputFor(venture);
    const good = baseline.good;
    const lockedPrice = postedPrice(next, good);
    // The window the terms are measured over: the engine-wide `state.windowN`, or the
    // flagged fallback the resolver itself uses when a scenario sets none — the same
    // number, read the same way, so the licence can never be priced over a different
    // window than the one its commitment accrues in.
    const windowN = next.windowN == null ? DEFAULT_WINDOW_N : next.windowN;
    const baselineUnitsPerTick = baseline.units;

    const { basicFee, discountedFee } = licenceFee({
      baselineUnitsPerTick,
      windowN,
      lockedPrice,
      committedOutputPct: action.committedOutputPct,
      equityPct: equityOf(venture),   // the term offered at establishment (Slice 3a)
    });

    venture.licence = {
      committedOutputPct: action.committedOutputPct,
      windowDays: action.windowDays,
      signedTick: next.tick,          // §15.2: every mutation records its tick
      lockedPrice,
      basicFee,
      discountedFee,
    };
    // THE SIGNING BUMP (§2.6, ruled 01-09-26; slice 2 of the rescale). Signing MINTS
    // reputation: `2 × committedOutputPct × the venture's GP weight`, so the terms the
    // guild just negotiated decide whether this venture launches above, on, or below its
    // line. At 50% the bump equals the venture's own GP and it opens exactly ON its line —
    // which is the point of the whole rescale: deploying no longer opens an instant gap
    // that throttles the guild's fuel before it has had any chance to earn.
    //
    // MINTED HERE, IN THE SIGNING APPLY, and nowhere else — it is part of the same
    // mutation, not a second event. The amount is `sim/licence.js`'s (§4: the licence
    // layer owns how RP moves; this file only applies the move it is handed).
    //
    // IT MIRRORS THE TICK'S RP MOVE EXACTLY (sim/tick.js's boundary block), on purpose:
    // the venture's own field and the guild's cached total move by the SAME amount in the
    // SAME place, so `checkGuildReputationSum` (`guildReputation == Σ venture.reputation +
    // foundingEndowment`) stays exact with no new term and no second writer.
    //
    // ⚠ AND A ZERO BUMP WRITES NOTHING — the tick's rule 5, kept here for the same reason.
    // A 0%-commitment licence is legal (§5's floor) and its bump is 0; assigning anyway
    // would MINT `reputation: 0`, a key holding its own default, into every save and every
    // determinism hash for a venture whose reputation has never moved. The field's
    // lifecycle stays "minted by the first thing that MOVES it" — which is now signing at
    // any real commitment, and no longer only the first met boundary.
    //
    // The `|| 0` is belt to that brace: re-applying is refused, so a venture reaching here
    // has never been licensed and cannot already carry RP — but the read is written the
    // safe way regardless, so it stays correct if renegotiation ever routes through here.
    const bump = signingBump(venture);
    if (bump !== 0) {
      venture.reputation = (venture.reputation || 0) + bump;
      guild.guildReputation += bump;
    }

    // The operative commitment: the share of BASELINE output promised over one window,
    // in whole units. This is the field the §5 accrual sums into `Q` and that 3a's sale
    // is paid on — so granting the licence is what switches the commitment sale on.
    venture.syndicateCommitment = commitmentUnitsFor(action.committedOutputPct, baselineUnitsPerTick, windowN);

    // The MID-WINDOW PRO-RATE (§5's join ruling, Option A; Slice 3b-ii). Stamping this
    // is what makes `windowFraction` (sim/windows.js) stop returning 1: a venture
    // licensed part-way through a window owes only the share of `Q` for the ticks it is
    // actually present, instead of a full window's target it had no chance to deliver.
    //
    // WHY `signedTick + 1` AND NOT `signedTick` — the off-by-one is load-bearing.
    // Intake runs BEFORE the tick (`advance` = intake → tick → assert), so a venture
    // licensed while `state.tick` is T is committed during intake but first produces —
    // and therefore first delivers — on the tick that yields state T+1. `windowFraction`
    // counts `present = windowStart + N − committedFromTick`, which is the number of
    // producing ticks from `committedFromTick` to the boundary INCLUSIVE. For that count
    // to equal the ticks the venture actually delivers in, the stamp must be its first
    // producing tick, which is `signedTick + 1`. Stamping `signedTick` would credit it
    // with one tick it was never able to produce in, and it would owe a unit it could
    // not deliver — the same unfairness in miniature that the pro-rate exists to fix.
    //
    // Only `applyForLicence` stamps it. An unlicensed venture, or one committed through
    // the `setSyndicateCommitment` dev scaffold, carries no `committedFromTick` at all,
    // so `windowFraction` returns 1 for it and its behaviour is exactly as before.
    venture.committedFromTick = venture.licence.signedTick + 1;
    return next;
  }

  if (action.type === 'renegotiateLicence') {
    // Accept the Syndicate's new terms and re-lock the licence IN PLACE — the near-mirror
    // of applyForLicence's apply, with three deliberate differences (the Syndicate-set
    // terms, no signing bump, and a window that resets). Everything is priced against
    // state-as-it-stands at THIS tick, exactly as a first signing is.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    // The OUTPUT good, its droidless baseline and this tick's posted price — read the
    // SAME way applyForLicence reads them (`baselineOutputFor` is the single source for
    // both the good and the units/tick, for a mine and a factory alike; no number
    // invented). The window is the engine-wide `windowN` (or the resolver's fallback).
    const baseline = baselineOutputFor(venture);
    const good = baseline.good;
    const lockedPrice = postedPrice(next, good);
    const windowN = next.windowN == null ? DEFAULT_WINDOW_N : next.windowN;
    const baselineUnitsPerTick = baseline.units;
    const windowDays = venture.licence.windowDays;   // carried unchanged (§5)

    // The Syndicate's new terms + the re-locked fee, from the ONE helper the snapshot's
    // renegotiationOffer also reads (sim/licence.js), so the offer previewed and the
    // terms locked cannot disagree. `renegotiationFee` reads the venture's standing for
    // the committed step, prices the fee at `lockedPrice`, and bakes in the Strong-band
    // discount (a no-op off Strong).
    const { committedOutputPct, basicFee, discountedFee } = renegotiationFee({
      venture,
      baselineUnitsPerTick,
      windowN,
      lockedPrice,
    });

    // Re-lock in place. `windowDays` carries; `signedTick = next.tick` RESETS the window
    // (the terms lock afresh for another `windowDays`); the fee re-locks at this tick's
    // price. Equity is NOT a licence field (it lives on the venture) and is untouched.
    venture.licence = {
      committedOutputPct,
      windowDays,
      signedTick: next.tick,          // §15.2: every mutation records its tick, and resets the window
      lockedPrice,
      basicFee,
      discountedFee,
    };

    // NO SIGNING BUMP — the load-bearing difference from applyForLicence. `signingBump`
    // is once-per-venture at FIRST licence (docs/points-and-reputation.md §2.6); a
    // renegotiation never re-applies it, so `venture.reputation` is untouched and the
    // guild's cached sum does not move (design.md §5 "On accept": RP carries). We do not
    // call it here at all.

    // Recompute the operative commitment at the new pct, and re-stamp the pro-rate anchor
    // to this window's first producing tick — the SAME `signedTick + 1` reasoning as
    // applyForLicence: a re-locked venture is "present from" its first producing tick of
    // the new window, so its first (reset) window is pro-rated for the tick it re-signed on.
    venture.syndicateCommitment = commitmentUnitsFor(committedOutputPct, baselineUnitsPerTick, windowN);
    venture.committedFromTick = venture.licence.signedTick + 1;
    return next;
  }

  if (action.type === 'lapseLicence') {
    // LAPSE TO UNLICENSED (§5 "Accept or lapse"): revert the venture to unlicensed and forfeit
    // its RP, keeping the venture, its node and its asset in place. The whole effect is the
    // shared `applyLapse` (sim/licence.js) — the RP forfeit + licence-drop + commitment-clear —
    // which the auto-lapse tick step (#64 Slice 2) calls too, so a chosen REJECT and a
    // timed-out lapse cannot diverge. No fee, no node lockout, no signing bump; the venture
    // survives, and the guild may sign a fresh licence later on its own terms.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    // cause 'rejected' (the player chose to lapse); the notice's tick is `next.tick`, the
    // current tick this apply runs on (docs/event-log.md §2).
    applyLapse(guild, venture, 'rejected', next.tick);
    return next;
  }

  if (action.type === 'acknowledgeEvent') {
    // Stamp `readTick` on the named notice, iff it is present AND still unread (docs/event-log.md
    // §3). A no-op — valid, changes nothing — when the id is absent (it aged out between render
    // and click) or already read (acknowledged twice), so an acknowledge is idempotent and never
    // resets an earlier read's retention clock. `next.tick` is when the player read it — the datum
    // the READ retention window (RETENTION_READ_TICKS) counts from. This is player-set display
    // state: no reputation, no credits, no goods move.
    const guild = findGuild(next, action.guildId);
    const event = (guild.events || []).find((e) => e.id === action.eventId);
    if (event && event.readTick == null) event.readTick = next.tick;
    return next;
  }

  if (action.type === 'licenseDeuteriumMine') {
    // Grant the windowless deuterium licence (§1.4). Moves NO credits — there is no fee —
    // and sets no terms: commitment is 100% implicit and equity stays whatever the venture
    // offered at establishment. The ONE thing recorded is the tick (§15.2). From the next
    // production tick the mine's output is auto-sold to the Syndicate and minted 1:1 into
    // the fuel pool (sim/tick.js), and it stops counting toward GP (sim/points.js).
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    // Stamp the licence FIRST — `signingBump` recognises a licensed deuterium mine by this
    // very field (isLicensedDeuteriumMine), so the bump can only read the T4 weight once
    // it is set.
    venture.deuteriumLicence = { signedTick: next.tick };

    // THE SIGNING BUMP (§1.4 "The RP accrual", slice 2): `2 · 1.0 · W_T4` = 1000 RP, minted
    // ONCE at licensing — the exact mirror of the ordinary `applyForLicence` bump above, at
    // the deuterium path's fixed full commit and T4 weight. `signingBump` owns the amount
    // (§4: the licence layer authors how RP moves); this only applies the move, onto
    // `venture.reputation` with `guild.guildReputation` tracking it by the SAME amount in the
    // SAME place, so `checkGuildReputationSum` stays exact with no new term. Unlike an
    // ordinary bump this offsets NO GP — a deuterium mine adds zero GP — so it is the
    // deliberate reputation windfall §1.4 rules, landing two-thirds up the [−500, 1500] band.
    //
    // Never zero here (2·1·500 = 1000 > 0), so it always mints — but written through the
    // same `|| 0` / non-zero guard as the ordinary bump, for one consistent RP-minting shape.
    const bump = signingBump(venture);
    if (bump !== 0) {
      venture.reputation = (venture.reputation || 0) + bump;
      guild.guildReputation += bump;
    }
    return next;
  }

  if (action.type === 'establishDeuteriumRefinery') {
    // Seat an illegal deuterium refinery (§1.4 slice 1b). Mirrors establishVenture for a
    // factory — occupy the NAMED factory asset (Gate 2 proved it owned, idle, a factory), stamp
    // the settlement slot's system — but marks the venture `deuteriumRefinery` and carries NO
    // recipeId and NO resourceType, so resolveProduction never touches it; its conversion is the
    // dedicated guild-wide tick step. Moves no credits/fuel; no licence, no equity, no RP.
    const guild = findGuild(next, action.guildId);
    const site = getSite(action.siteId);
    guild.ventures.push(createVenture({
      id: action.ventureId,
      ownerGuildId: action.guildId,
      type: 'refining', // a factory venture — so assetKindForVentureType wants a factory
      siteId: action.siteId,
      systemId: site ? site.systemId : null,
      assetId: action.assetId,
      productionRate: action.productionRate,
      deuteriumRefinery: true,
    }));
    pruneLockout(next, action.siteId);
    return next;
  }

  if (action.type === 'establishDockyard') {
    // Seat a Tier-4 build yard (docs/build-yard.md §2). Mirrors establishDeuteriumRefinery for a
    // factory — occupy the NAMED factory asset (Gate 2 proved it owned, idle, a factory), stamp
    // the settlement slot's system — but marks the venture `dockyard` (not `deuteriumRefinery`),
    // carries an empty `buildQueue`, and takes NO recipeId / NO resourceType / NO productionRate,
    // so resolveProduction never touches it; the build step advances its queue. Moves no
    // credits/fuel; no licence, no equity, no per-cycle RP. It DOES take a one-time RP bump — the
    // held Tier-4 signing bump (§5, slice 2), applied below.
    const guild = findGuild(next, action.guildId);
    const site = getSite(action.siteId);
    guild.ventures.push(createVenture({
      id: action.ventureId,
      ownerGuildId: action.guildId,
      type: 'refining', // a factory venture — so assetKindForVentureType wants a factory
      siteId: action.siteId,
      systemId: site ? site.systemId : null,
      assetId: action.assetId,
      dockyard: true,
      buildQueue: [],
    }));

    // THE HELD TIER-4 RP SIGNING BUMP (docs/build-yard.md §5, slice 2): 900 RP, minted ONCE at
    // establish — establishing the dockyard IS the grant (there is no separate licence step, so
    // unlike an ordinary venture the bump fires here, not at `applyForLicence`). The exact mirror
    // of the `licenseDeuteriumMine` bump above: `signingBump` owns the amount (§4 — the licence
    // layer authors how RP moves; it special-cases `isDockyard` to a flat 900), and this only
    // applies the move — onto `venture.reputation` with `guild.guildReputation` tracking it by the
    // SAME amount in the SAME place, so `checkGuildReputationSum` stays exact with no new term.
    // Held while the dockyard stands; forfeited on teardown (`applyVentureClosure` subtracts
    // `venture.reputation`), so it is not farmable. Written through the same `|| 0` / non-zero
    // guard as the other bumps for one consistent RP-minting shape (900 > 0, so it always mints).
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    const bump = signingBump(venture);
    if (bump !== 0) {
      venture.reputation = (venture.reputation || 0) + bump;
      guild.guildReputation += bump;
    }

    pruneLockout(next, action.siteId);
    return next;
  }

  if (action.type === 'commissionBuild') {
    // Append a build to the dockyard's queue (docs/build-yard.md §3). NO COST at commission —
    // the bill is consumed only when the build starts (sim/tick.js). Each entry gets the venture's
    // current `nextCommissionId`, which is then bumped: a per-venture monotonic, serialized id, so
    // the commission is addressed by a stable id rather than a shifting array index. `remainingTicks`
    // opens null ("not yet started").
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    const commissionId = venture.nextCommissionId || 0;
    venture.buildQueue.push({ commissionId, assetKind: action.assetKind, remainingTicks: null });
    venture.nextCommissionId = commissionId + 1;
    return next;
  }

  if (action.type === 'cancelCommission') {
    // Remove an UNSTARTED commission (validate proved it exists and has not started). Addressed
    // by commissionId, not index. Nothing was consumed for an unstarted commission, so there is
    // nothing to refund (docs/build-yard.md §3).
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    const idx = venture.buildQueue.findIndex((e) => e.commissionId === action.commissionId);
    venture.buildQueue.splice(idx, 1);
    return next;
  }

  if (action.type === 'decommissionVenture') {
    // Close the venture (docs/venture-teardown.md §1), in the §1 order. Everything here reads
    // `teardownSettlement` — the SAME pure helper the snapshot previews with — so the cost the
    // player was shown and the cost charged cannot disagree (§7).
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    const { settlementFee } = teardownSettlement(next, guild, venture);

    // 1. THE SETTLEMENT FEE (§3.2) — ordinary-licensed only, 0 past the term, so this moves
    //    nothing for an unlicensed venture. The paySyndicateFee shape exactly: guild −fee,
    //    ledger +fee, so invariant 2 stays exact. It MAY drive the guild's credits NEGATIVE —
    //    the same non-negativity carve-out §5's breach fee runs under — and is charged in full
    //    whether or not the guild can pay; there is deliberately no affordability gate (§3.2).
    //    This is the ONE thing a player teardown does that a Syndicate forced closure does NOT
    //    (docs/forced-closure.md §3.4), which is exactly why it lives HERE, around the shared
    //    closure below, rather than inside it.
    if (settlementFee > 0) {
      guild.credits -= settlementFee;
      next.syndicate.ledger += settlementFee;
    }

    // 2-4. RP FORFEIT + REMOVAL (§3.1), FREE THE SITE AND ASSET (§0, derived — nothing to do),
    //    and THE NODE LOCKOUT (§3.3) — all in `applyVentureClosure` (sim/licence.js), the SAME
    //    shared mutation the −500 forced-closure path in the tick calls, so a player teardown
    //    and a Syndicate closure cannot diverge on removal (the `applyLapse` precedent). It
    //    reads the same `teardownSettlement` for the lockout tick, so its term and the fee's
    //    above are the one number. cause 'teardown'; the notice's tick is `next.tick`, the
    //    current tick this apply runs on (docs/event-log.md §2).
    applyVentureClosure(next, guild, venture, 'teardown', next.tick);
    return next;
  }

  if (action.type === 'addOrderLine') {
    // Append the good, or TOP UP its existing line (§3), keeping lines one-per-good and sorted by
    // good (invariant 9). Creates the order on the first add (omit-when-empty until then, §2).
    const guild = findGuild(next, action.guildId);
    const field = orderFieldFor(action.side);
    const order = guild[field] || { lines: [] };
    const existing = order.lines.find((l) => l.good === action.good);
    if (existing) {
      existing.qty += action.qty;
    } else {
      order.lines.push({ good: action.good, qty: action.qty });
      order.lines.sort((a, b) => compareGood(a.good, b.good));
    }
    guild[field] = order;
    return next;
  }

  if (action.type === 'removeOrderLine') {
    // Drop the line; if the order empties, OMIT it (delete the key) so it stops serializing and the
    // guild is byte-identical to one that never held the order (§2/§3). Validate proved the line is
    // present, so the filter always removes exactly one.
    const guild = findGuild(next, action.guildId);
    const field = orderFieldFor(action.side);
    const order = guild[field];
    order.lines = order.lines.filter((l) => l.good !== action.good);
    if (order.lines.length === 0) delete guild[field];
    return next;
  }

  if (action.type === 'clearOrder') {
    // Empty the order — delete the key, keeping it omit-when-empty (§2/§3). A no-op when the order
    // is already absent (clearing is idempotent).
    const guild = findGuild(next, action.guildId);
    delete guild[orderFieldFor(action.side)];
    return next;
  }

  if (action.type === 'sellToSyndicate') {
    // HELD single-origin finalise (docs/syndicate-orders.md §5): many goods from ONE origin on ONE
    // space-tiered leg, settled immediately (no shipment — "sold goods leave the moment you place
    // them"), then clear the order. (The legacy `good` + `allocations` multi-system path was RETIRED
    // with the client slice, §8.)
    const guild = findGuild(next, action.guildId);
    const issueTick = action.issueTick === undefined ? next.tick : action.issueTick;
    // Read the held lines, sorted by good so the mutation sequence and the Σ are fixed (invariant
    // 9). Each good is priced PER LINE (#43's `round(qty × price)`) — a multi-good order at
    // several prices.
    const lines = [...guild.sellOrder.lines].sort((a, b) => compareGood(a.good, b.good));
    let totalProceeds = 0;
    for (const line of lines) {
      const price = quotedPrice(next, line.good, issueTick);
      if (price == null) {
        // Validation refused this (expiry + ring guard); reaching it means the ring/price block
        // was edited between validate and apply. Taking the goods for nothing would be a silent
        // loss, so halt loudly — the same guard, and reason, as applyProduction's Syndicate
        // delivery (§15.5).
        throw new Error(`applyAction: guild ${guild.id} sold ${line.good} to the Syndicate at tick ${next.tick} (quote issueTick ${issueTick}) but no posted price is in the ring for that tick — refusing to hand over goods for nothing`);
      }
      // Remove the stock from the one origin; the goods LEAVE THE ECONOMY (absorbed into the
      // Syndicate's inexhaustible stock, §5) — deposited nowhere.
      addStock(guild, action.originSystemId, line.good, -line.qty);
      totalProceeds += Math.round(line.qty * price);
    }
    // Credit-conservation-clean, the mirror of paySyndicateFee: the ledger FUNDS the payment, so
    // nothing is minted and invariant 2 holds to the credit.
    guild.credits += totalProceeds;
    next.syndicate.ledger -= totalProceeds;

    // THE BURN — ONE leg (origin → its nearest waystation) at the total-space tier, the SAME
    // `routeFuelCost` validate checked. Fuel LEAVES the galaxy (burned, no counterparty), so
    // invariant 1 balances only because `totalConsumed` rises to match the hoard falling. One
    // deduction across both stores (legal-first `burnFuel`), so one consumption event. A 0 is the
    // no-route case (unreachable origin), a no-op.
    const totalSpace = lines.reduce((sum, line) => sum + (line.qty * volumeOf(line.good)), 0);
    const { fuelBurn } = routeFuelCost(action.originSystemId, totalSpace);
    burnFuel(guild, fuelBurn);
    next.audit.totalConsumed += fuelBurn;

    // CLEAR THE HELD ORDER on a successful finalise (§5), keeping it omit-when-empty (§2). A
    // reject-whole never reaches apply, so the draft is left untouched on refusal for free.
    delete guild.sellOrder;

    // THE BETWEEN-TICK SEAM: a stockpile drained and fuel burned, and `POST /action` asserts every
    // invariant with no tick between, so refresh the derived cache through the SAME one selector the
    // tick uses — not a second derivation. Credits moved guild↔ledger without changing the total, so
    // `expectedCreditTotal` is untouched.
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'buyFromSyndicate') {
    // The BUY half of the Exchange (design.md §6). Two things happen here and
    // nothing else: the cash moves NOW, and a delivery is SCHEDULED. No goods are
    // deposited — that is stepArrivals' job, `arrivalTick` ticks from now.
    const guild = findGuild(next, action.guildId);
    const issueTick = action.issueTick === undefined ? next.tick : action.issueTick;
    // THE CART — the guild's HELD buy order (`guild.buyOrder.lines`, §5). (The inline `cart` /
    // legacy `good`/`qty` intake was RETIRED with the client slice, §8.)
    const cart = buyFinalizeCart(next, action);

    // ROUNDED PER GOOD then summed — #43's `round(qty × price)` per line, so a good bought
    // and immediately sold back at an UNMOVED price costs exactly nothing, and a one-good
    // cart is byte-identical to the old order. Priced at the QUOTED value (§8.1) — the ring
    // at `issueTick`, which is the current posted price when omitted — matching validate's
    // affordability check. A null price means the ring or price block was edited between
    // validate and apply; taking the money for goods with no price would be a silent theft,
    // so halt, exactly as the sale's mirror guard. There is NO transport fee and NO spread.
    let cost = 0;
    const cargo = {};
    for (const line of cart) {
      const price = quotedPrice(next, line.good, issueTick);
      if (price == null) {
        throw new Error(`applyAction: guild ${guild.id} bought ${line.good} from the Syndicate at tick ${next.tick} (quote issueTick ${issueTick}) but no posted price is in the ring for that tick — refusing to take credits for nothing`);
      }
      cost += Math.round(line.qty * price);
      cargo[line.good] = line.qty;
    }
    // The mirror of paySyndicateFee: credits leave the guild and the same integer
    // lands in the ledger, so invariant 2 holds to the credit by construction.
    guild.credits -= cost;
    next.syndicate.ledger += cost;

    // THE SCHEDULE. Nearest waystation → straight-line hex distance → an ABSOLUTE
    // arrival tick (§6 steps 1–2). Computed once, here, and never recomputed: a
    // delivery on an uncontested straight line needs no per-tick work until it
    // lands (§15.6's "pure schedule"), and an absolute tick is what lets a save
    // reloaded mid-flight land on the right tick with no special case. Speed is
    // tier-independent (§5.1), so the arrival tick does not depend on the cart's space.
    const { distance } = nearestWaystation(action.destinationSystemId);
    if (!Array.isArray(next.shipments)) next.shipments = [];
    next.shipments.push({
      ownerGuildId: action.guildId,
      // `cargo` carries the WHOLE cart — every bought good and NOTHING else, in particular
      // never a `fuel` key, so invariant 1's fuel-in-transit sum reads 0 for a BUY delivery
      // (§6's fuel-invariant note). `stepArrivals` already deposits every good in this map.
      cargo,
      destinationSystemId: action.destinationSystemId,
      arrivalTick: arrivalTickFor(next.tick, distance),
    });
    // NO origin, NO route, NO status (§6): nothing needs tracking between now and
    // arrival, and a field nobody reads is a fact with a second home waiting to
    // drift (invariant 5).
    //
    // THE BURN — the flight scheduled just above costs fuel, and this is where the guild
    // pays it: `routeFuelCost(dest, totalSpace).fuelBurn` — the per-hex rate of the hauler
    // tier the cart's TOTAL SPACE (`Σ qty × volumeOf`) selects (§5.1), from the SAME function
    // the validate gate checked and the snapshot quotes. Recomputed here (not threaded from
    // validate) because apply must be correct on its own terms, and it is a pure function of
    // the seed + cart, so the two calls cannot disagree.
    //
    // TWO FIELDS MOVE AND NO OTHERS. Fuel LEAVES the galaxy here — it is burned,
    // not transferred, so there is no counterparty to credit — and invariant 1
    // (Sum hoards + reserve + inTransit === totalProduced - totalConsumed) balances
    // only because the hoard going down is matched by `totalConsumed` going up.
    // This is the first writer of `totalConsumed` in the engine; `createState`
    // seeds it to 0, so it needs no `|| 0` guard — one would only hide a malformed
    // state. No tick stamp: the three `audit` counters carry none (see the audit
    // note in invariants.js), and inventing one here would be a second convention.
    //
    // A `fuelBurn` of 0 makes both lines no-ops — the no-route case, already
    // refused up front by validate's waystation gate.
    const totalSpace = cart.reduce((sum, line) => sum + (line.qty * volumeOf(line.good)), 0);
    const { fuelBurn } = routeFuelCost(action.destinationSystemId, totalSpace);
    // LEGAL-FIRST (§1.4 slice 1b): `burnFuel` draws `fuelHoard` first, contraband
    // `deuteriumFuel` for the remainder — the same combined burn the SELL side does. Both are
    // held fuel, so one consumption event: `totalConsumed += fuelBurn` once, invariant 1 stays
    // closed. The combined-availability gate covered it, so neither store goes negative.
    burnFuel(guild, fuelBurn);
    next.audit.totalConsumed += fuelBurn;

    // CLEAR THE HELD ORDER on a successful finalise (§5). Deleting the key keeps it OMIT-WHEN-EMPTY
    // (§2). A reject-whole never reaches apply, so the draft is left untouched on refusal for free.
    delete guild.buyOrder;

    // ⚠ THIS REPLACES THE OLD "NO galacticSupply REFRESH" NOTE, which read: not one
    // stockpile moved, so the cache still describes the galaxy correctly. That
    // reasoning was true for as long as a BUY only moved credits and scheduled
    // cargo. It STOPS being true the moment the burn above deducts `fuelHoard`,
    // because `galacticSupply.fuel.guildHeld` is the sum of exactly those hoards.
    // `POST /action` asserts every invariant right after apply with no tick in
    // between, so leaving the cache stale would trip `galactic-supply-consistency`
    // and return a 500 instead of landing the trade — the same between-tick seam
    // `sellToSyndicate` and `foundGuild` each document. Refreshed through the one
    // selector the tick uses, not a second derivation.
    next.galacticSupply = computeGalacticSupply(next);
    // The GOODS still need no cache refresh: they are a scheduled deposit, not held
    // inventory (which is also exactly why losing them later imbalances nothing —
    // §6), so no stockpile moved and the resources half of the cache was already
    // correct. `expectedCreditTotal` is untouched too: the cash moved between the
    // guild and the ledger without changing how many credits exist.
    return next;
  }

  if (action.type === 'buyAssetFromSyndicate') {
    // The BUY-AN-ASSET half (docs/asset-purchase.md). TWO costs move NOW and a build order is
    // RECORDED — nothing else (the goods buy's discipline). No shipment yet, no asset yet:
    // construction is a WAIT that stepSyndicateBuilds promotes to a delivery on completion.
    const guild = findGuild(next, action.guildId);
    const issueTick = action.issueTick === undefined ? next.tick : action.issueTick;
    const price = priceAssetForPurchase(next, action.assetKind, issueTick);
    if (price == null) {
      // Validation refused this (expiry gate + ring guard via priceAssetForPurchase), so
      // reaching it means the ring or a price row was edited between validate and apply. Taking
      // the money for an asset with no priced parts would be a silent theft — halt, exactly as
      // the goods buy's mirror guard.
      throw new Error(`applyAction: guild ${guild.id} bought a ${action.assetKind} from the Syndicate at tick ${next.tick} (quote issueTick ${issueTick}) but its bill has no quoted parts price at that tick — refusing to take credits for nothing`);
    }

    // CREDITS — the mirror of the goods buy: the price leaves the guild and the same integer
    // lands in the ledger, so invariant 2 holds to the credit by construction. Priced at the
    // QUOTED value (§8.1), matching the affordability check validate ran.
    guild.credits -= price;
    next.syndicate.ledger += price;

    // FUEL — the delivery flight burns route fuel UP FRONT (asset-purchase.md "Cost timing and
    // fuel"): charging it now removes the failure mode where construction finishes but the guild
    // can no longer afford the flight. Fuel LEAVES the galaxy (burned, not transferred), so
    // invariant 1 balances only because `totalConsumed` rises to match the hoard falling. Same
    // legal-first `burnFuel`. The burn matches the validate gate EXACTLY — the shared helpers
    // guarantee it: a VEHICLE burns its OWN `fuelCostToRun × hexDistance` (it flies itself in,
    // 2.2-foundation); a GROUND asset burns the HEAVY hauler rate (`ASSET_CARGO_VOLUME`, §5.1).
    // A 0 is a no-op (no route, refused up front); the combined-availability gate covered it, so
    // neither store goes negative.
    const { fuelBurn } = isVehicleClass(action.assetKind)
      ? vehicleDeliveryFuelBurn(action.destinationSystemId, action.assetKind)
      : routeFuelCost(action.destinationSystemId, ASSET_CARGO_VOLUME);
    burnFuel(guild, fuelBurn);
    next.audit.totalConsumed += fuelBurn;

    // THE BUILD ORDER — construction is a wait (asset-purchase.md §"Build concurrency"). No shipment
    // and no asset are created here; the order sits on `syndicateBuilds` as one entry of this guild's
    // per-guild single-slot FIFO queue. Array insertion order IS the guild's FIFO order, so a fresh
    // commission goes to the BACK. `remainingTicks: null` means "queued, not yet started": the build
    // clock is NOT started here (unlike the retired absolute `buildDoneTick` model) — stepSyndicateBuilds
    // starts a commission's `BUILD_TICKS` countdown only when it reaches the HEAD of its guild's queue,
    // mirroring the dockyard (`buildDockyards`). `boughtTick` records the mutation's tick (§15.2 — every
    // mutation records its tick). Created lazily so a galaxy that buys no asset carries no key
    // (the omit-when-empty no-op, byte-identical goldens).
    if (!Array.isArray(next.syndicateBuilds)) next.syndicateBuilds = [];
    next.syndicateBuilds.push({
      ownerGuildId: action.guildId,
      assetKind: action.assetKind,
      destinationSystemId: action.destinationSystemId,
      remainingTicks: null,
      boughtTick: next.tick,
    });

    // The SAME galacticSupply refresh the goods buy makes, and for the same reason: the burn
    // above deducted `fuelHoard`, which `galacticSupply.fuel.guildHeld` sums, and `POST /action`
    // asserts every invariant with no tick between. No goods moved (nothing to refresh there) and
    // `expectedCreditTotal` is untouched (credits moved guild↔ledger without changing the total).
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  // --- Operator adjust levers (docs/operator-adjust.md §3) ---------------------
  // Each does the CONSERVING COUNTER-MOVE its quantity needs (§2), so `POST /action`'s
  // post-apply invariant assert stays clean. Validate ran first, so every lookup below
  // resolves.

  if (action.type === 'adjustCredits') {
    // §3.1: guild ±delta, ledger ∓delta — the founding move, generalised to a signed
    // delta. Net zero, so `expectedCreditTotal` is unchanged and invariant 2 holds.
    const guild = findGuild(next, action.guildId);
    guild.credits += action.delta;
    next.syndicate.ledger -= action.delta;
    return next;
  }

  if (action.type === 'adjustFuel') {
    // §3.2: move the LEGAL hoard, recorded as backend production/consumption so invariant
    // 1 (`Σ held == totalProduced − totalConsumed`) stays closed. A grant is minted (like
    // founding's fuel-genesis) → `totalProduced`; a removal is consumed → `totalConsumed`.
    const guild = findGuild(next, action.guildId);
    guild.fuelHoard += action.delta;
    if (action.delta > 0) next.audit.totalProduced += action.delta;
    else next.audit.totalConsumed += -action.delta;
    // The between-tick seam (the founding/buy precedent): `galacticSupply.fuel.guildHeld`
    // sums `fuelHoard`, and `POST /action` asserts the consistency invariant with no tick
    // between — so refresh the cache through the one selector the tick uses.
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'adjustGoods') {
    // §3.3: add `delta` (may be negative) to the (guild, systemId) cell, then refresh the
    // galactic-supply cache in the SAME apply (the founding precedent) so the
    // galactic-supply-consistency invariant sees the cache and the recompute agree. Goods
    // have no conservation ledger, so there is no audit counter-move.
    const guild = findGuild(next, action.guildId);
    addStock(guild, action.systemId, action.good, action.delta);
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'grantAsset') {
    // §3.4: mint one IDLE asset — a fresh `asset_<guildId>_<kind>_NN` id (max existing +1
    // for this guild+kind, via nextAssetNumber), new condition, at the named system. It
    // attaches to no venture, so occupancy stays clean; no quantity is conserved, so there
    // is no counter-move.
    const guild = findGuild(next, action.guildId);
    if (!Array.isArray(guild.assets)) guild.assets = [];
    const id = assetId(action.guildId, action.kind, nextAssetNumber(guild, action.kind));
    guild.assets.push(createAsset({ id, kind: action.kind, systemId: action.systemId, maintenanceCondition: ASSET_CONDITION_NEW }));
    return next;
  }

  if (action.type === 'removeAsset') {
    // §3.5. Idle → just delete it. Occupied → `occupied` decides: 'detach' (default) nulls
    // the venture's `assetId` and leaves the venture dormant (an asset-less venture is
    // invariant-legal — checkAssetOccupancy skips `assetId == null`); 'close' tears the
    // venture down through the shared closure first. Either way the asset is then removed,
    // and no venture is ever left pointing at a deleted asset (§4 — no dangling reference).
    const guild = findGuild(next, action.guildId);
    const occupied = action.occupied === undefined ? 'detach' : action.occupied;
    const holder = (guild.ventures || []).find((v) => v.assetId === action.assetId);
    if (holder && occupied === 'close') {
      // The shared teardown (sim/licence.js), cause 'operator' — removes the venture and
      // frees its asset to idle WITHOUT deleting it, exactly as decommissionVenture reuses
      // it; the now-idle asset is deleted just below.
      applyVentureClosure(next, guild, holder, 'operator', next.tick);
    } else if (holder) {
      // 'detach' — null the pointer so the venture survives dormant. DELETE the key (not
      // set null) to keep the omit-when-null serialization discipline createVenture uses.
      delete holder.assetId;
    }
    guild.assets = (guild.assets || []).filter((a) => a.id !== action.assetId);
    return next;
  }

  if (action.type === 'removeVenture') {
    // §3.6: close the venture through the shared closure (cause 'operator'); `asset`
    // decides its machine. 'keep' (default) leaves the freed asset idle (closure frees it,
    // nothing more to do); 'remove' also deletes it — the same end state as removeAsset
    // 'close', driven from the venture side. Capture the assetId BEFORE the closure splices
    // the venture out.
    const guild = findGuild(next, action.guildId);
    const venture = guild.ventures.find((v) => v.id === action.ventureId);
    const freedAssetId = venture.assetId;
    applyVentureClosure(next, guild, venture, 'operator', next.tick);
    if (action.asset === 'remove' && freedAssetId != null) {
      guild.assets = (guild.assets || []).filter((a) => a.id !== freedAssetId);
    }
    return next;
  }

  if (action.type === 'spawnVehicle') {
    // design.md §15.4 "Spawn / remove": mint one IDLE craft at the current tick, as though
    // manufactured and delivered instantly. Bump the guild's monotonic mint serial (never
    // reused) and mint from it — the SAME serial + `vehicle_<guild>_<class>_NN` id scheme +
    // per-class VEHICLE_SPECS the buy/build seam (mintFinishedKind) uses, so a spawned craft is
    // INDISTINGUISHABLE from a delivered one the moment it lands (no updatedAtTick stamp either,
    // matching the buy/build mint and grantAsset — the tick is recorded in the journal, §15.2).
    // It moves NO fuel/credits/points/reputation/claims — a vehicle feeds none — so there is no
    // conserving counter-move and galacticSupply (stockpiles + hoards only) is untouched.
    const guild = findGuild(next, action.guildId);
    if (!Array.isArray(guild.vehicles)) guild.vehicles = [];
    const serial = nextVehicleSerial(guild);
    guild.vehicleSerial = serial;
    const id = vehicleId(action.guildId, action.class, serial);
    const spec = vehicleSpec(action.class);
    guild.vehicles.push(createVehicle({
      id,
      ownerGuildId: action.guildId,
      class: action.class,
      speed: spec.speed,
      capacity: spec.capacity,       // spycraft's 0 is legal — createVehicle checks !== undefined
      defenseRating: spec.defenseRating,
      fuelCostToRun: spec.fuelCostToRun,
      location: action.location,     // exactly-one-form, already validated; createVehicle copies it
      maintenanceCondition: action.condition === undefined ? ASSET_CONDITION_NEW : action.condition,
    }));
    return next;
  }

  if (action.type === 'removeVehicle') {
    // design.md §15.4 "Spawn / remove": DESTROY the craft — drop the row. The mint serial is
    // NOT decremented (design.md "Ids never repeat"), so the removed id is never reissued.
    //
    // GOODS-SINK CONTRACT (design.md §15.4 "Destroying a laden craft is a recorded goods sink"):
    // removal destroys whatever the craft CARRIES. Since the cargo slice (2.2 cargo, engine slice 1)
    // a craft's hold is counted in galactic supply (supply.js folds it in beside the pools), so
    // destroying a LADEN craft is a legitimate goods sink — the goods leave the galaxy. Refresh the
    // supply cache so the drop shows honestly at the between-action seam (POST /action asserts cache
    // == live sum with no tick between); an EMPTY craft folds in as nothing, so this is the pre-slice
    // no-op there. The loss is tick-stamped by the journal (the action's tick), never silent.
    const guild = findGuild(next, action.guildId);
    guild.vehicles = (guild.vehicles || []).filter((v) => v.id !== action.vehicleId);
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'spawnOutpost') {
    // design.md §4 / §15.4 (the outpost ladder, slice 1): place one guild Outpost. Bump the guild's
    // monotonic mint serial (never reused, exactly as vehicleSerial) and mint from it — the SAME
    // serial + `outpost_<guild>_NN` id scheme sim/outposts.js owns. The row is SHARED, so it lands in
    // `state.outposts`, not on the guild. `capacity`/`dockCapacity` default from the constants
    // (30 × HEAVY_HOLD and the [FIRST-CUT] 10); the stockpile is born empty. `createdAtTick` records
    // the mutation's tick (§15.2). It moves NO fuel/credits/points/reputation/claims — an outpost
    // feeds none — so there is no conserving counter-move and galacticSupply is untouched.
    const guild = findGuild(next, action.guildId);
    const serial = nextOutpostSerial(guild);
    guild.outpostSerial = serial;
    const id = outpostId(action.guildId, serial);
    if (!Array.isArray(next.outposts)) next.outposts = [];
    next.outposts.push(createOutpost({
      id,
      ownerGuildId: action.guildId,
      coords: action.coords,     // in-bounds, unoccupied — already validated; createOutpost copies it
      anchorSystemId: action.anchorSystemId,
      createdAtTick: next.tick,
    }));
    return next;
  }

  if (action.type === 'removeOutpost') {
    // design.md §4 "torn down permanently" + "On destruction its stored goods are destroyed, and any
    // craft at it (parked or docked) become idle in space carrying whatever they held at that instant".
    // The mint serial is NOT decremented (§15.4 "Ids never repeat"), so the removed id is never reissued.
    const outpost = (next.outposts || []).find((o) => o.id === action.outpostId); // validate proved it exists
    const guild = findGuild(next, outpost.ownerGuildId); // own-only docking (§4), so the owner holds every docked craft

    // EVICT the craft the Outpost holds — its SLOTS and its QUEUE. Each becomes idle-in-space: a
    // bare-hex idle craft AT the Outpost's hex (its location is already that hex — it was dispatched
    // there — so only a LOADING craft's status must flip back to idle; a queued craft is already idle).
    // Each keeps the hold it holds AT THIS INSTANT: a loader caught mid-turnaround never reached its
    // resolve, so it leaves EMPTY of the new load; an unloader leaves STILL-LADEN (the resolve-at-
    // completion rule, §4). We touch only `status` — never `cargo` — so that pre-transfer hold rides out
    // untouched. A queued craft simply drops its pending manifest (it dies with the Outpost row below).
    for (const entry of [...(outpost.slots || []), ...(outpost.queue || [])]) {
      const craft = (guild.vehicles || []).find((v) => v.id === entry.vehicleId);
      if (!craft) continue; // defensive: own-only means the owner holds it, but never throw on teardown
      craft.status = 'idle';
      // §15.2 "every mutation records its tick": eviction is a state change to the craft, so stamp it.
      craft.updatedAtTick = next.tick;
      // A ROUTED craft was here for its lane's stop — and that stop's store is what is being torn down, so
      // its lane ENDS now (§11.6), flagged. Left alone it would keep a route nothing can ever advance: the
      // dock completion it waits for dies with this Outpost.
      if (craft.route) endLane(craft, 'target-gone', next.tick);
    }

    // DESTROY the row (and with it the stockpile — the stored goods leave the galaxy, the accounted
    // goods sink, §4/§15.4) and the dock state (queue/slots). Omit-when-empty: a galaxy back to zero
    // outposts drops the key, byte-identical to pre-slice (invariant 9).
    next.outposts = (next.outposts || []).filter((o) => o.id !== action.outpostId);
    if (next.outposts.length === 0) delete next.outposts;

    // The destroyed stockpile's goods LEFT galactic supply (supply.js folds Outpost stockpiles in), so
    // refresh the cache across the between-action seam (the goods-sink discipline removeVehicle already
    // follows for a laden craft) — invariant 1 balances because non-fuel supply is a consistency check,
    // never conservation (mining mints, this destruction sinks). A no-goods Outpost drops supply by 0.
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'dispatchVehicle') {
    // transport-model.md §4: the trip departs at the dispatch tick and the WHOLE schedule is frozen
    // here. Mirrors buyFromSyndicate's fuel handling (burn the hoard, record the consumption, refresh
    // galacticSupply across the between-action seam) and spawnVehicle's craft mutation shape.
    const guild = findGuild(next, action.guildId);
    const craft = guild.vehicles.find((v) => v.id === action.vehicleId);
    // CANCEL a pending Outpost transfer (design.md §4 "a parked or queued craft is cancelled by being
    // re-dispatched away — that drops its pending manifest") — the shared sweep, see cancelQueuedManifest.
    cancelQueuedManifest(next, craft.id);
    // A fresh dispatch CLEARS an ended-lane flag (§11.6): the player has re-tasked the craft.
    delete craft.laneEnded;
    // …and DROPS any lane the idle craft was still carrying (one WAITING for fuel at its last stop, or
    // queued at an Outpost stop): re-dispatching a craft cancels what it was waiting on (§4). A plain
    // trip must not land carrying a stale route, or the arrival step would resolve that route's stop.
    delete craft.route;
    // Re-derive the route BEFORE the craft leaves its berth (dispatchRoute reads craft.location);
    // validate guaranteed { ok: true }, so this cannot fail — the shared helper keeps the legs and
    // the burn byte-identical to the ones the gate checked.
    const route = dispatchRoute(craft, action.waypoints);

    // Freeze the CONTIGUOUS schedule (§4): leg 0 departs at the dispatch tick; each leg's arrivalTick
    // = its departureTick + legTicks; leg K+1 departs exactly when leg K arrives (no pause). Absolute
    // ticks, so a restart mid-route lands on the right tick with no special case. Anchors stored AS
    // GIVEN (resolved coords are derived on read); isToll false on every leg this slice.
    let departureTick = next.tick;
    const legs = route.legs.map((leg) => {
      const arrivalTick = departureTick + legTicks(leg.length, craft.speed, false);
      const scheduled = {
        from: leg.from, to: leg.to, isToll: false, departureTick, arrivalTick,
      };
      departureTick = arrivalTick; // contiguous — the next leg leaves when this one lands
      return scheduled;
    });
    const arrivalTick = legs[legs.length - 1].arrivalTick;

    // The craft leaves its berth: an in-transit craft carries the `trip` and NO bare `location`
    // (design.md §15.4). Drop `location` (omit-when-absent) so nothing says it is still where it
    // left; the arrival step restores it at the final anchor.
    craft.status = 'inTransit';
    craft.trip = { legs, dispatchTick: next.tick, arrivalTick };
    delete craft.location;
    // No `updatedAtTick` stamp: the schedule ticks ARE the record (dispatchTick, and each leg's two
    // ticks), and the journal records the dispatch tick — a second stamp would be a redundant home
    // for the same fact (§15.4 / invariant 5). The spawn slice stamps none either.

    // FUEL — the whole route burns UP FRONT, units from the hoard (legal-first burnFuel, §4). Fuel
    // LEAVES the galaxy (burned, not transferred), so invariant 1 balances only because
    // totalConsumed rises to match the hoard falling — exactly buyFromSyndicate's discipline. The
    // combined-availability gate ran in validate, so neither store goes negative. The credit figure
    // is a display value (fuelValue in the snapshot), never a treasury debit.
    burnFuel(guild, route.totalUnits);
    next.audit.totalConsumed += route.totalUnits;

    // The SAME galacticSupply refresh buyFromSyndicate makes after a hoard burn: the burn deducted
    // fuelHoard, which galacticSupply.fuel.guildHeld sums, and POST /action asserts the consistency
    // invariant with no tick between (the between-action seam).
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'transferCargo') {
    // design.md §4 "Where it happens decides how": a SYSTEM transfer resolves INSTANTLY here; an
    // OUTPOST transfer is QUEUED for a dock slot and resolves later (at completion, in the tick step).
    const guild = findGuild(next, action.guildId);
    const craft = guild.vehicles.find((v) => v.id === action.vehicleId);
    const atSystem = !!(craft.location && craft.location.landmarkKind === 'system');

    if (!atSystem) {
      // AT AN OUTPOST — the DOCK model (design.md §4). NOTHING moves now: record the manifest and
      // enqueue it for the Outpost's slots at ready-tick = the CURRENT tick (the confirm tick of a
      // manual transfer, §4 "served by the tick a craft became ready"). The craft stays plain `idle`
      // (parked, re-dispatchable) — its distinct `loading` status is set only when the dock step
      // promotes it into a slot. Goods move at COMPLETION, resolved by stepOutpostDocks (sim/tick.js).
      const outpost = ownedOutpostAtCraft(next, action.guildId, craft); // validate proved one exists
      if (!outpost.queue) outpost.queue = [];
      // Deep-copy the manifest so the enqueued record can never alias the caller's array (the
      // createVehicle/createOutpost copy discipline). `copyManifestLine` carries each validated line in
      // its canonical shape — an AMOUNT line as { dir, good, qty }, a MAX line as { dir, good, max: true }.
      outpost.queue.push({
        vehicleId: craft.id,
        manifest: action.manifest.map(copyManifestLine),
        readyTick: next.tick,
      });
      // §15.2 "every mutation records its tick": the craft records the tick it was given a manifest
      // (the queue entry's readyTick is the same fact on the Outpost side; both are the confirm tick).
      craft.updatedAtTick = next.tick;
      // No goods moved, so galactic supply is unchanged — but refresh the cache anyway (the
      // between-action seam asserts cache == live sum with no tick between; the value is identical).
      next.galacticSupply = computeGalacticSupply(next);
      return next;
    }

    // AT A SYSTEM — INSTANT (§4 "Resolving a manifest", the system half). Move goods between the
    // craft's hold and the guild's (guild, system) pool via the ONE shared resolver (sim/manifest.js),
    // in the fixed order — ALL UNLOADS FIRST, THEN ALL LOADS — each line clamped to what fits,
    // partial-safe. It moves only goods between two of the guild's OWN stores, so galactic supply is
    // CONSERVED and both stores stay counted (supply.js folds the hold in) — no fuel, no credits.
    const systemId = craft.location.landmarkId; // validate proved it is a system landmark
    const hold = craft.cargo || {}; // the working hold (a cargo-less craft starts empty)
    // The SYSTEM store: `addStock` is the ONLY pool writer (ruling B1), and a system pool is
    // SOFT-capped (§4), so its free space for an unload is effectively unbounded (`Infinity`).
    const store = {
      get: (good) => getStock(guild, systemId, good),
      add: (good, delta) => addStock(guild, systemId, good, delta),
      freeSpace: () => Infinity,
    };
    resolveManifest(hold, craft.capacity, store, action.manifest);

    // Re-attach the hold, keeping omit-when-empty: a transfer that nets to an empty hold drops the
    // key (the createVehicle discipline), so the no-op case serializes byte-identically to pre-slice.
    if (Object.keys(hold).length) craft.cargo = hold; else delete craft.cargo;
    // §15.2 "every mutation records its tick": a transfer has no schedule ticks of its own (unlike a
    // dispatch, whose leg ticks are its record), so the craft stamps the tick it moved goods on.
    craft.updatedAtTick = next.tick;

    // Galactic supply is CONSERVED across the transfer (a load's pool−n is exactly the hold's +n, and
    // both are summed, supply.js) — but the between-action seam asserts the cache equals the live sum
    // with no tick between, so refresh it (the dispatchVehicle discipline). The value is unchanged;
    // this keeps the cache honest against the moved goods rather than leaving it stale by luck.
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'dispatchRouteWithActions') {
    // transport-model.md §11.2/§11.3: the chained-legs model. The whole run's fuel burns UP FRONT
    // (the legs are known even though the timing is not), the route + a cursor are JOURNALLED onto the
    // craft, and only the FIRST leg is dispatched here — each later leg is re-dispatched by `advanceRoute`
    // (from the sim/tick.js hooks) as the craft completes the stop before it.
    const guild = findGuild(next, action.guildId);
    const craft = guild.vehicles.find((v) => v.id === action.vehicleId);

    // CANCEL a pending Outpost transfer, exactly as the plain dispatch does (design.md §4 — a queued craft
    // is idle, so it passed the idle gate; its manual manifest is dropped when it is re-dispatched).
    cancelQueuedManifest(next, craft.id);
    // A fresh dispatch CLEARS an ended-lane flag (§11.6) — before this run starts, so a flag set below (a
    // skipped W1 whose store is gone, resolved at once) is this run's own.
    delete craft.laneEnded;

    // Re-derive + price the whole route BEFORE the craft leaves its berth (dispatchRoute reads
    // craft.location); validate guaranteed { ok: true }, so this cannot fail — the shared helper keeps
    // the legs, the whole-run burn and the skip decision byte-identical to the ones the gate checked.
    const route = dispatchRoute(craft, action.waypoints.map((wp) => wp.anchor), { skipZeroLengthFirstLeg: true });

    // Journal the plan onto the craft: a fresh, non-aliasing copy of the { anchor, action? } waypoints
    // and a cursor at 0 (the waypoint the craft is heading to, or — after the skip — standing at). The
    // `route` field is omit-when-absent on every OTHER craft, so a route-less galaxy is byte-identical
    // to pre-slice (§11.8). It is journalled state, so a mid-run restart replays byte-identically.
    // A repeating lane also journals its launch mode, its lap counters (lapsDone; an nRun's N and laps
    // still to run) and a perCycle lane its cadence — §11.10; a one-shot adds nothing, so it is
    // byte-identical to the pre-repeat route (repeatStateFor).
    craft.route = {
      waypoints: action.waypoints.map(copyRouteWaypoint), cursor: 0, ...repeatStateFor(action.repeat),
    };

    // Reposition to W1 (§11.4): fly the first leg — or, when the craft already sits on W1, SKIP that
    // zero-length leg and resolve W1 in place (§11.4 / §11.9), exactly as an arrival there would. The
    // SAME helper every later lap of a repeating lane repositions with (flyToFirstStop, above). A ONE-stop
    // route (act in place, §11.9) needs nothing extra: W1 is also the last waypoint, so the resolver's
    // advanceRoute ends the run — a system action leaves the craft idle at W1 with its route cleared now;
    // an Outpost action queues and the dock step ends the run at turnaround.
    flyToFirstStop(next, guild, craft, route.skippedFirstLeg, next.tick);

    // FUEL — the WHOLE run burns UP FRONT (§11.3), units from the hoard, exactly as dispatchVehicle
    // burns a plain route: fuel LEAVES the galaxy (burned, not transferred), so totalConsumed rises to
    // match the hoard falling (invariant 1). The combined-availability gate ran in validate. After a
    // skip this is Σ over the REAL legs only (W1→W2→…) — the skipped reposition was never a leg. An
    // act-in-place run has no legs at all, so this is 0 and burns nothing (§11.3: nothing to refund).
    // A repeating lane burns only LAP 1 here; each later lap burns its own bill at its start (§11.3).
    burnFuel(guild, route.totalUnits);
    next.audit.totalConsumed += route.totalUnits;

    // The SAME galacticSupply refresh the plain dispatch makes after a hoard burn (the between-action
    // seam asserts cache == live sum with no tick between).
    next.galacticSupply = computeGalacticSupply(next);
    return next;
  }

  if (action.type === 'saveRoute') {
    // transport-model.md §11.9 — NAME-BASED UPSERT. The name is stored TRIMMED, so " Ore run " and
    // "Ore run" are the same route (the match is otherwise exact: case and inner spaces count).
    // It moves no goods, fuel or credits, so there is nothing to conserve and no galacticSupply refresh.
    const guild = findGuild(next, action.guildId);
    const name = action.name.trim();
    const existing = (guild.savedRoutes || []).find((r) => r.name === name);
    if (existing) {
      // A name the guild already uses: UPDATE that route in place — same id, same place in the list,
      // new waypoints (fresh copies, never the caller's objects). The serial does NOT move: no id minted.
      existing.waypoints = action.waypoints.map(copyRouteWaypoint);
      existing.updatedAtTick = next.tick; // §15.2: the save is a mutation — record its tick
      return next;
    }
    // A new name: CREATE a route from the guild's monotonic serial (bumped, never reused), the same
    // mint shape spawnVehicle / spawnOutpost use. createSavedRoute deep-copies the waypoints.
    const serial = nextSavedRouteSerial(guild);
    guild.savedRouteSerial = serial;
    if (!Array.isArray(guild.savedRoutes)) guild.savedRoutes = [];
    guild.savedRoutes.push(createSavedRoute({
      id: savedRouteId(action.guildId, serial),
      name,
      waypoints: action.waypoints,
      updatedAtTick: next.tick,
    }));
    return next;
  }

  if (action.type === 'deleteRoute') {
    // transport-model.md §11.9: drop the row. The serial is NOT decremented, so the id is never reissued.
    // When the last route goes, the key goes too (omit-when-empty), so the guild is byte-identical to one
    // that never saved a route. (savedRouteSerial stays — it remembers which numbers are spent.)
    const guild = findGuild(next, action.guildId);
    guild.savedRoutes = guild.savedRoutes.filter((r) => r.id !== action.routeId);
    if (guild.savedRoutes.length === 0) delete guild.savedRoutes;
    return next;
  }

  if (action.type === 'stopRouteAfterRun') {
    // transport-model.md §11.10: the lane finishes the lap it is on, lands idle at WN and ends. Mark it;
    // `finishLap` ends it at the next WN boundary (a clean stop — the craft is never snapped anywhere).
    // A WAITING lane (for fuel, or a per-cycle lane holding for its cadence) is already AT that boundary —
    // its run is finished and it sits idle at WN — so it ends right now: the route goes and the craft is
    // an ordinary idle craft at WN.
    // Moves no goods, fuel or credits, so nothing to conserve and no galacticSupply refresh.
    const guild = findGuild(next, action.guildId);
    const craft = guild.vehicles.find((v) => v.id === action.vehicleId);
    if (craft.route.waiting) delete craft.route;
    else craft.route.stopAfterRun = true;
    craft.updatedAtTick = next.tick; // §15.2: the stop is a mutation of the craft — record its tick
    return next;
  }

  if (action.type === 'cancelRoute') {
    // transport-model.md §11.10 "Cancel": the lane ends AT ONCE and the craft is left an ORDINARY idle craft —
    // no trip, no route, and no `laneEnded` flag (a player's cancel is not a failure, §11.6's flag is for a
    // lane that ended on its own). It moves no goods, fuel or credits: the hold stays aboard, and the fuel
    // already burned for the legs it will not fly is not refunded (§11.3 — committed at launch). So there is
    // nothing to conserve and no galacticSupply refresh.
    const guild = findGuild(next, action.guildId);
    const craft = guild.vehicles.find((v) => v.id === action.vehicleId);
    if (craft.trip) {
      // IN FLIGHT → SNAP to the hex it is over now and go idle there, as a bare hex (idle-in-space is legal,
      // §11.6). The same shape the arrival step leaves: a location, `idle`, no trip.
      const landing = cancelLanding(craft, next.tick);
      if (!landing.ok) throw new Error(`cancelRoute: ${landing.reason}`); // validate refused this; unreachable
      craft.location = landing.location;
      craft.status = 'idle';
      delete craft.trip;
    }
    // PARKED mid-lane (no trip) → the craft already sits on a hex, so nothing snaps; the route just goes.
    //   - waiting at its last stop (for fuel, or a per-cycle lane between laps): now simply idle there.
    //   - QUEUED at an Outpost stop: its queue entry is swept (the shared cancelQueuedManifest — no stale
    //     entry may outlive the lane), and it is idle, parked at the Outpost.
    //   - LOADING in an Outpost dock slot: the slot is NOT touched. A craft in a slot runs to completion
    //     (design.md §4 — the same reason a dispatch refuses it), so that one transfer finishes and the craft
    //     goes idle at the Outpost. With no route left, the dock step does not send it on anywhere.
    // (The sweep is a no-op for a craft that holds no queue entry, including one that was in flight.)
    cancelQueuedManifest(next, craft.id);
    delete craft.route;
    craft.updatedAtTick = next.tick; // §15.2: the cancel is a mutation of the craft — record its tick
    return next;
  }

  if (action.type === 'setWindowN') {
    // Set the single engine-wide window length. Setup-only (validate refused it once
    // tick > 0), so this only ever writes tick-0 state. No guild is resolved — this
    // is the first state-scoped action.
    next.windowN = action.windowN;
    return next;
  }
  // Unreachable if validateAction() was checked first, since every accepted
  // type is handled above — fail loudly rather than silently no-op if not.
  throw new Error(`applyAction: unhandled action type: ${action.type}`);
}

// --- Intake -------------------------------------------------------------

// intake(state, actions) — the sequential validate-as-they-arrive pass.
// Processes `actions` IN ORDER, one at a time, against state-as-it-stands
// (i.e. reflecting every action already accepted earlier in this call).
// Never mutates the input state. Returns:
//   {
//     state:   the resulting state after every accepted action applied,
//     results: [{ action, accepted, reason? }, ...] one entry per input,
//               in the same order, so a caller can see exactly what happened
//               and why (reason is present only when accepted is false).
//   }
function intake(state, actions) {
  if (!state) throw new Error('intake: state is required');
  if (!Array.isArray(actions)) throw new Error('intake: actions must be an array');

  let working = state;
  const results = [];

  for (const action of actions) {
    const { valid, reason } = validateAction(working, action);
    if (valid) {
      working = applyAction(working, action);
      results.push({ action, accepted: true });
    } else {
      results.push({ action, accepted: false, reason });
    }
  }

  return { state: working, results };
}

module.exports = {
  createPaySyndicateFeeAction,
  createFoundGuildAction,
  createEstablishVentureAction,
  createSetProductionProfileAction,
  createSetSyndicateCommitmentAction,
  createApplyForLicenceAction,
  createRenegotiateLicenceAction,
  createLapseLicenceAction,
  createAcknowledgeEventAction,
  createLicenseDeuteriumMineAction,
  createEstablishDeuteriumRefineryAction,
  createDecommissionVentureAction,
  createEstablishDockyardAction,
  createCommissionBuildAction,
  createCancelCommissionAction,
  createSetWindowNAction,
  createSellToSyndicateAction,
  createBuyFromSyndicateAction,
  createBuyAssetFromSyndicateAction,
  createAddOrderLineAction,
  createRemoveOrderLineAction,
  createClearOrderAction,
  createAdjustCreditsAction,
  createAdjustFuelAction,
  createAdjustGoodsAction,
  createGrantAssetAction,
  createRemoveAssetAction,
  createRemoveVentureAction,
  createSpawnVehicleAction,
  createRemoveVehicleAction,
  createSpawnOutpostAction,
  createRemoveOutpostAction,
  createDispatchVehicleAction,
  createTransferCargoAction,
  createDispatchRouteWithActionsAction,
  createSaveRouteAction,
  createDeleteRouteAction,
  createStopRouteAfterRunAction,
  createCancelRouteAction,
  quoteDispatch,
  // The cost of one lap of a repeating lane — shared by the quote above and the snapshot's route row.
  perLapCost,
  // The chained-route execution (the automation layer, §11.2), called by sim/tick.js's two hooks: a
  // routed craft reached a waypoint (resolveRouteArrival), or finished its turnaround (advanceRoute).
  resolveRouteArrival,
  advanceRoute,
  resumeWaitingLanes,
  validateAction,
  applyAction,
  intake,
};
