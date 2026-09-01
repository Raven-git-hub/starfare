'use strict';

// fuel.js — the fuel system's home: the constants the fuel economy is
// denominated in, and (later) the rules that move fuel.
//
// WHY A MODULE AND NOT A CONSTANTS FILE: there is no `sim/constants.js` in this
// repo and deliberately so — a constant lives in the module that owns the rule
// it belongs to (`CRAFT_SPEED` in transport.js, `BASE_PRICE` in prices.js). Fuel
// is now a system with rules of its own, so it gets a module, and every number
// it needs lives here ONCE and is never inlined.
//
// SCOPE TODAY: the founding grant, the fuel economy's CALIBRATION price, the route
// burn, and the one function that marks physical fuel to money. Everything that
// MOVES fuel lives elsewhere and reads from here — the grant and the pool in
// sim/issuance.js and tick.js's step 6, the burn's deduction in sim/actions.js.
//
// ⚠ THE MARKET PRICE IS NOT IN THIS FILE, AND THAT IS THE POINT (01-09-26, slice
// 5b-i). `REFERENCE_FUEL_PRICE` below is a CONSTANT — the anchor the economy was
// calibrated at. The live price of fuel is `state.reserve.fuelPrice`, serialized
// galaxy state (sim/state.js), because 5b-ii's controller has to MOVE it cycle to
// cycle and a constant cannot move. There is exactly one of it (§15.5 invariant 5),
// it is what `fuelValue` marks against, and 5b-i holds it AT the reference so the
// whole slice is byte-identical to 5a. The controller that moves it is NOT built;
// do not read any constant below as a stand-in for it.
//
// ⚠ TWO MORE PIECES OF THE FUEL ECONOMY ARE NOT HERE EITHER, deliberately:
// **mean-line issuance** (the RP-against-Points judgement that SIZES a grant) lives
// in **sim/meanline.js**, and the pool, the influx and the grant itself live in
// **sim/issuance.js**. §4 of points-and-reputation.md rules issuance the fuel
// layer's, and "the fuel layer" is a concept rather than a filename: those modules
// read Points and reputation and no geometry at all, which is a different rule from
// the burn and the valuation below.

const { nearestWaystation } = require('./transport.js');

// GUILD_STARTING_FUEL — the fuel a guild's hoard opens with at founding.
//
// `[FIRST-CUT]` — tune after the waystation rebalance lands (roadmap: 9 -> 96
// waystations), which changes how far a delivery has to travel and therefore
// what a starting hoard is worth.
//
// THE RULING it implements: docs/fuel-supply-and-allocation.md §1.3
// ("Bootstrapping — the day-0 deadlock"), which rules this constant by name:
// minted into the guild's `fuelHoard` in the `foundGuild` apply and recorded in
// `state.audit.totalProduced` so invariant 1 closes from tick 0. The galaxy
// opens already supplied, because the fiction is that you are joining an
// ALREADY-RUNNING Syndicate — so a new guild arrives with a baseline balance it
// can stumble onto viable fuel with while finding its feet.
//
// WHY the rule exists is recorded a layer down, in the doc §1.3 supersedes:
// fuel-economy.md §7 ("New-guild death spiral") — a new guild starts at ~0
// Guild Points and ~0 reputation, so the no-fuel -> no-trade -> no-reputation
// trap is closed by an early-game starter floor, anchored on design.md §8's
// survival floor, rather than by a structural redesign.
const GUILD_STARTING_FUEL = 500;

// REFERENCE_FUEL_PRICE — the price at which the fuel economy is CALIBRATED, in
// credits per unit of `deuterium_fuel`.
//
// `[FIRST-CUT]` 10, and it invents nothing: it takes the value of the retired
// `FLAT_FUEL_PRICE_PER_UNIT`, which is why slice 5b-i is byte-identical to 5a
// (docs/fuel-supply-and-allocation.md §4.2; recorded in phase-1-tuning.md).
//
// ⚠ IT IS NOT THE MARKET PRICE. The one market price of fuel is
// `state.reserve.fuelPrice` — serialized, and the only thing anything ever marks
// fuel against (§15.5 invariant 5: one fuel price, one home). This constant is the
// fixed ANCHOR that price is measured from: it is where `BASE_GRANT_PER_GP`'s
// "5 fuel per Guild Point" was calibrated, so a guild sitting at exactly this price
// draws its full entitlement, and `reserve.fuelPrice` is seeded here at galaxy
// creation (state.js `createReserve`).
//
// The two therefore mean different things and must never be swapped: the constant is
// the calibration, the state field is today's price. 5b-i holds the state field AT
// the constant — the ratio between them is exactly 1.0 and nothing moves — and 5b-ii's
// reserve/flow controller is what finally makes them differ.
const REFERENCE_FUEL_PRICE = 10;

// SYNDICATE_HAULER_BURN_RATE — fuel units burned per unit of route distance.
//
// `[FIRST-CUT]`, and the only new number in fuel Slice 2. RULED 31-08-26
// (docs/fuel-supply-and-allocation.md §8, Slice 2): `fuel = distance x craftBurnRate`,
// **cargo-independent** — a hauler burns what the trip costs, not what it carries.
// Tune after the waystation rebalance lands (roadmap: 9 -> 96 waystations), which
// moves every distance in the galaxy and so moves every burn with it.
//
// ONE HAULER, ONE RATE. Syndicate trades all fly the same Syndicate hauler, so a
// per-craft table would be a table of one. It arrives with the guild transport
// tier (Phase 4), where craft actually differ.
//
// THE STAND-IN NOTE: design.md §15.4 defines `Vehicle.fuelCostToRun` and names the
// Syndicate Hauler as an instance of that shape. No such Vehicle row exists in
// state — minting one is out of scope here — so this module constant stands in
// for the field until it does. When a real hauler row lands this constant is what
// it replaces, and the replacement is one line because nothing inlines it.
const SYNDICATE_HAULER_BURN_RATE = 0.5;

// routeFuelCost(systemId) -> { fuelBurn: int }
//
// The fuel a Syndicate trade burns flying between `systemId` and its nearest
// waystation. PURE: it takes no state, reads no state and mutates nothing — the
// geography is baked into the seed at generation time, which is why
// `nearestWaystation` takes no state either. ONE ARGUMENT, a system id.
//
// DISTANCE COMES FROM `nearestWaystation`, NOT FROM A SECOND MEASUREMENT.
// `near.distance` is the value that function already computed, and it is the very
// value `buyFromSyndicate` reads to schedule a delivery's arrival tick. Calling
// `hexDistance` again here would be a second derivation of one fact, and the two
// could drift — a trip priced on one geometry and timed on another. One call, one
// distance, one geometry, by construction.
//
// CARGO-INDEPENDENT BY CONSTRUCTION: no good and no quantity appears anywhere in
// this function, so a caller cannot make the burn depend on the load even by
// accident. The ruling is made structural rather than merely obeyed.
//
// `Math.ceil` so every REAL route costs at least 1 fuel: the closest system in the
// seed sits 1 hex out, and 1 x 0.5 = 0.5 would floor to a free trip. Zero is
// reserved for the one honest case below.
//
// ⚠ IT NO LONGER QUOTES A PRICE (slice 5b-i, §4.2). It used to return a `creditCost`
// beside the burn, computed from the retired flat constant. A burn is GEOMETRY — a
// distance times a rate — and it is what the engine actually CHARGES; what that burn
// is WORTH in credits is a valuation at the market price, which is display, changes
// every cycle once 5b-ii lands, and needs state this pure function must not read. So
// the two are split: the burn stays here, and the valuation is `fuelValue(fuelBurn,
// reserve.fuelPrice)` at the display site (sim/snapshot.js), exactly parallel to the
// hoard's mark-to-market. The RETURN SHAPE STAYS AN OBJECT so every caller's
// `const { fuelBurn } = routeFuelCost(id)` keeps working untouched.
//
// GRACEFUL ABSENCE: when no waystation can reach the system (it does not exist,
// carries no seed coords, or no outpost has coords) -> `{ fuelBurn: 0 }`, never a
// throw. A quote is a display figure, and the refusal that matters already lives in
// `validateAction`, which rejects the purchase on this same null. ⚠ The DEDUCTION
// (slice 3, sim/actions.js) must not read that 0 as "free": it means "no route", and
// such a trade is refused before fuel is ever considered.
function routeFuelCost(systemId) {
  const near = nearestWaystation(systemId);
  if (!near) return { fuelBurn: 0 };
  return { fuelBurn: Math.ceil(near.distance * SYNDICATE_HAULER_BURN_RATE) };
}

// fuelValue(units, fuelPrice) -> integer credits.
//
// THE ONE PLACE PHYSICAL FUEL IS MARKED TO MONEY (§15.5 invariant 5). Both consumers
// — a guild's hoard and a route's burn — go through this, so there is exactly one
// answer to "what is this fuel worth", and it moves for both of them together the
// moment 5b-ii moves the price.
//
// `Math.round` because credits are integers (§15.2) and `fuelPrice` is the sanctioned
// float: it SCALES a quantity, and the rounding belongs where the float meets the
// integer, which is here.
//
// PURE, and it takes the price as an ARGUMENT rather than reading state: this module
// owns the fuel RULES and knows nothing about where a galaxy keeps its state. The
// caller passes `state.reserve.fuelPrice` — the only fuel price there is.
function fuelValue(units, fuelPrice) {
  return Math.round(units * fuelPrice);
}

module.exports = {
  GUILD_STARTING_FUEL,
  REFERENCE_FUEL_PRICE,
  SYNDICATE_HAULER_BURN_RATE,
  routeFuelCost,
  fuelValue,
};
