'use strict';

// transport.js — Syndicate delivery geometry and speed (design.md §6,
// "Syndicate Delivery — the BUY side", 29-08-26).
//
// SCOPE, and the boundary that matters: this is the SYNDICATE tier only — a
// straight line, hex to hex, at a fixed speed, no risk, no tolls, no routing.
// The GUILD tier (routing your own craft leg by leg, per-segment risk, tolls,
// interception) is the §6-intro model and is deferred to Phase 4. Nothing in
// this file is a step toward a routing engine; a Syndicate delivery needs a
// distance and a speed, and that is all there is here.
//
// Pure and seed-only: every function reads the static seed index (sim/seed.js)
// and the live state never enters. That is what makes an arrival tick a fact
// computable once, at purchase, and never recomputed (§15.6's "pure schedule").

const { getOutposts, getSystem } = require('./seed.js');

// CRAFT_SPEED — ticks per hex for a Syndicate delivery craft. `[FIRST-CUT]`,
// RULED 29-08-26 and recorded in docs/phase-1-tuning.md §"World shape"
// ("Syndicate craft speed: 150 ticks per hex"). It lives here ONCE and is never
// inlined, so retuning it is that one doc line plus this one constant.
//
// At the ruled 1 tick = 1 minute, 150 ticks is 2.5 hours per hex.
const CRAFT_SPEED = 150;

// TOLL_BUFF — the toll speed/fuel buff, RULED 2 (transport-model.md §2.2, `[FIRST-CUT]`, flat).
// A toll leg runs at 2× speed (half the ticks) AND burns half the fuel — this ONE constant drives
// BOTH buffs (§4: "the one constant drives both buffs"). SOURCED, not invented (§18 / CLAUDE.md):
// the doc rules it by name. This slice sets `isToll: false` on every dispatched leg — there is no
// toll infrastructure to select yet (§4) — but the `÷ TOLL_BUFF` path lives in the leg math from
// the start and is directly unit-tested, so the toll slice only has to supply the flag.
const TOLL_BUFF = 2;

// legTicks(length, craftSpeed, isToll) -> a leg's duration in whole ticks (transport-model.md §2.2:
// `ceil( length × craftSpeed ÷ (isToll ? TOLL_BUFF : 1) )`). `length` is HEX-STEP (hexDistance,
// §2.1); `craftSpeed` is the craft's ticks-per-hex (`Vehicle.speed`, §5). `ceil` throughout (§2.1),
// matching the built `ceil(hexDistance × speed)` arrival. A toll leg divides by TOLL_BUFF (half the
// ticks); an open-space leg divides by 1. The ONE home of the duration formula — nothing inlines it.
function legTicks(length, craftSpeed, isToll) {
  return Math.ceil((length * craftSpeed) / (isToll ? TOLL_BUFF : 1));
}

// legFuelBurn(length, fuelCostToRun, isToll) -> a leg's fuel burn in whole UNITS (§2.2 / §4). A
// craft burns its OWN per-hex `fuelCostToRun` (§5), never a hauler rate. `length` is hex-step (§2.1);
// `ceil` (§2.1). A toll leg burns half (÷ TOLL_BUFF); an open-space leg burns full. The ONE home of
// the burn formula: a dispatch sums this across every leg and burns the total from the hoard up front.
function legFuelBurn(length, fuelCostToRun, isToll) {
  return Math.ceil((length * fuelCostToRun) / (isToll ? TOLL_BUFF : 1));
}

// hexDistance(a, b) — the standard axial-coordinate hex distance:
//   (|dq| + |dr| + |dq + dr|) / 2
// Always a non-negative integer for integer axial coords (the third term is what
// makes the two axes agree about the diagonal), so no rounding is hidden here.
function hexDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

// nearestWaystation(destinationSystemId) -> { outpost, distance } | null
//
// THE WAYSTATIONS ARE THE SEED'S OUTPOSTS. Not a choice made here: the ruling
// that settled waystation count and placement (phase-1-tuning.md §"World shape",
// 03-08-26) reads "the seed's Citadel + its 9 Syndicate outposts (the
// waystations)" — the Citadel is named beside them, not among them, so it is
// NOT a candidate origin. If that is ever meant to include the Citadel it is a
// ruling, not a code change to make quietly; flagged on the decision checklist.
//
// Null when the system does not exist, carries no coords, or there is no
// coordinated outpost to sail from — the caller refuses the purchase rather than
// inventing an origin.
function nearestWaystation(destinationSystemId) {
  const system = getSystem(destinationSystemId);
  if (!system || !system.coords) return null;

  let best = null;
  // getOutposts() is sorted by outpost id, and the comparison below is STRICT,
  // so an exact distance tie is won by the lowest id — a fixed, seed-only
  // tiebreak (invariant 9), not whichever the iteration happened to reach.
  for (const outpost of getOutposts()) {
    if (!outpost.coords) continue;
    const distance = hexDistance(outpost.coords, system.coords);
    if (best === null || distance < best.distance) best = { outpost, distance };
  }
  return best;
}

// arrivalTickFor(currentTick, distance) -> the ABSOLUTE tick a delivery lands on.
// Absolute, never a countdown, is the whole persistence story (§6): the record
// goes into the save as-is and a restart mid-flight still lands it on the right
// tick with no special case. `ceil` because a tick is the engine's smallest unit
// — a part-tick of travel is a whole tick of waiting.
function arrivalTickFor(currentTick, distance) {
  return currentTick + Math.ceil(distance * CRAFT_SPEED);
}

module.exports = {
  CRAFT_SPEED, TOLL_BUFF, hexDistance, legTicks, legFuelBurn, nearestWaystation, arrivalTickFor,
};
