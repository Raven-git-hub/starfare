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

// --- where a craft IS, mid-leg (transport-model.md §2.3 / §2.4) ---------------------------------
// The two functions below answer "which hex is this craft over, right now?" for a craft flying a
// straight leg. The one caller today is the Cancel control (§11.10): a cancelled craft SNAPS to that
// hex and goes idle there. They are pure geometry — interpolation and rounding — with no game number.

// roundHalfUp(n, d) -> the whole number nearest to the fraction n / d (d > 0). An exact half rounds UP,
// towards +infinity (so 2.5 → 3 and −2.5 → −2), the same rule Math.round uses. Written as
// floor((2n + d) / 2d), i.e. floor(n/d + 1/2), so it works on the two integers and never needs n / d as
// a decimal: the numbers here are small enough (hex coords × leg ticks) for that division to be exact.
function roundHalfUp(n, d) {
  return Math.floor((2 * n + d) / (2 * d));
}

// cubeRound(qScaled, rScaled, d) -> { q, r } — the hex that CONTAINS a point lying between hex centres
// (transport-model.md §2.4 `cubeRound`). The point is passed as two whole numbers over one shared
// denominator: its fractional coordinates are qScaled / d and rScaled / d. Keeping it as fractions of
// integers, rather than decimals, makes every comparison below exact, so the same point always gives
// the same hex, even when it sits exactly on the edge between two hexes (§15.5 invariant 9).
//
// WHY NOT JUST ROUND q AND r? Axial coords name a hex with two numbers, but the grid has THREE axes. The
// third is s = −q − r (so q + r + s = 0 for every hex — the "cube" form). Rounding q and r on their own
// ignores s, and near a corner where three hexes meet it can pick a hex the point is not in. Example:
// the point (0.45, 0.35) is inside hex (1, 0), but rounding q and r alone gives (0, 0).
//
// THE FIX, in three steps:
//   1. Round all three coords — q, r and s — to the nearest whole number.
//   2. The three rounded numbers may no longer add up to 0 (each moved by up to a half, independently).
//   3. So distrust the ONE that moved furthest when it was rounded, and rebuild it from the other two
//      (q = −r − s, or r = −q − s). The two that moved least are the most trustworthy.
// On the example: q 0.45 → 0 (moved 0.45), r 0.35 → 0 (moved 0.35), s −0.8 → −1 (moved 0.2). They add up
// to −1, not 0. q moved furthest, so rebuild it: q = −r − s = 0 + 1 = 1. The hex is (1, 0).
//
// A TIE (two coords moved exactly as far — the point is on an edge) is settled by the fixed order of the
// checks below, so the answer never depends on anything but the point itself.
function cubeRound(qScaled, rScaled, d) {
  const sScaled = -qScaled - rScaled; // the third cube coordinate, over the same denominator
  // Step 1: round each coordinate.
  let q = roundHalfUp(qScaled, d);
  let r = roundHalfUp(rScaled, d);
  const s = roundHalfUp(sScaled, d);
  // How far each moved when rounded, times d — so still a whole number, and exact to compare.
  const qMoved = Math.abs(q * d - qScaled);
  const rMoved = Math.abs(r * d - rScaled);
  const sMoved = Math.abs(s * d - sScaled);
  // Step 3: rebuild the one that moved furthest. If it is s, there is nothing to do — s is not returned.
  if (qMoved > rMoved && qMoved > sMoved) q = -r - s;
  else if (rMoved > sMoved) r = -q - s;
  // `+ 0` turns JavaScript's "negative zero" (which −r − s gives when r and s are both 0) into a plain 0.
  // The two print the same, but a deep-equality check tells them apart, so a hex at q = 0 is always 0.
  return { q: q + 0, r: r + 0 };
}

// legHexAtTick(from, to, departureTick, arrivalTick, tick) -> { q, r } — the hex a craft flying the
// straight leg `from` → `to` (two hex coords { q, r }) is over at `tick` (transport-model.md §2.3 + §2.4).
//
// §2.3: speed is constant along a leg, so the share of the leg FLOWN equals the share of its TIME gone:
//   legProgress = clamp01((tick − departureTick) / (arrivalTick − departureTick))
//   position    = from + legProgress × (to − from)
// then §2.4 rounds that position to a hex (cubeRound above). The clamp makes a tick before departure read
// as `from` and a tick at or after arrival read as `to`.
//
// Everything is multiplied through by the leg's length in ticks (`span`), so no fraction is ever formed:
// `elapsed` / `span` IS legProgress, and qScaled / span is the craft's fractional q. (§2.3 interpolates in
// the drawing plane; that conversion is linear, so interpolating q and r directly lands on the same point.)
//
// It returns the nearest hex on the unbounded grid. Whether that hex is inside the galaxy is the
// caller's question (isHexInBounds). All inputs must be whole numbers and the leg must take at least one
// tick — both always true of a real leg (legTicks ceils, a zero-length leg is refused). Anything else
// throws, rather than handing back a hex computed from a bad schedule.
function legHexAtTick(from, to, departureTick, arrivalTick, tick) {
  const inputs = [from.q, from.r, to.q, to.r, departureTick, arrivalTick, tick];
  if (!inputs.every(Number.isInteger) || !(arrivalTick > departureTick)) {
    throw new Error(`legHexAtTick: needs whole-number coords and ticks, and a leg that takes at least one tick — got ${JSON.stringify({ from, to, departureTick, arrivalTick, tick })}`);
  }
  const span = arrivalTick - departureTick;
  const elapsed = Math.min(Math.max(tick - departureTick, 0), span); // clamped to [0, span]
  const qScaled = from.q * span + (to.q - from.q) * elapsed;
  const rScaled = from.r * span + (to.r - from.r) * elapsed;
  return cubeRound(qScaled, rScaled, span);
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
  CRAFT_SPEED, TOLL_BUFF, hexDistance, cubeRound, legHexAtTick, legTicks, legFuelBurn, nearestWaystation,
  arrivalTickFor,
};
