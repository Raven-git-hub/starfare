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
// SCOPE TODAY (fuel Slices 1-2): the founding grant, a flat unit price for
// display, and the route burn QUOTE. There is no pool, no issuance, no cycle
// allowance, and — the boundary that matters — **nothing here spends fuel**. A
// hoard is seeded at founding, sits, and can now be quoted against a route; the
// deduction is Slice 3 (docs/fuel-supply-and-allocation.md §8). The real fuel
// economy (the commons and its reserve, mean-line issuance sized by reputation
// against Points, and the reserve/flow price controller under it) is designed in
// that same doc and is NOT built; do not read any constant below as a stand-in
// for it.

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

// FLAT_FUEL_PRICE_PER_UNIT — credits per unit of `deuterium_fuel`, for DISPLAY
// only. `[FIRST-CUT]`, and a deliberate placeholder: fuel is the one good the
// price engine never prices (design.md §8 — `deuterium_fuel` has no row in
// state.prices, ever), so a hoard has no posted value to mark against and the
// client would otherwise have to invent one. A named constant here means the
// number is in exactly one place when the real fuel price controller replaces it
// (docs/fuel-supply-and-allocation.md §4: a reserve/flow controller that reads
// deuterium IN against fuel OUT and moves price to defend the reserve — its
// coefficients are that doc's open question 1, an explicit SIM job, so nothing
// here is a first cut at them). §1.3 rules this constant by name too.
//
// Nothing CHARGES this. It buys nothing and sells nothing — no credit moves
// through it — so invariant 2 cannot see it.
const FLAT_FUEL_PRICE_PER_UNIT = 10;

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

// routeFuelCost(systemId) -> { fuelBurn: int, creditCost: int }
//
// The fuel a Syndicate trade burns flying between `systemId` and its nearest
// waystation, and what that fuel is worth at the flat display rate. PURE: it
// takes no state, reads no state and mutates nothing — the geography is baked
// into the seed at generation time, which is why `nearestWaystation` takes no
// state either. ONE ARGUMENT, a system id.
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
// GRACEFUL ABSENCE: when no waystation can reach the system (it does not exist,
// carries no seed coords, or no outpost has coords) -> `{ fuelBurn: 0,
// creditCost: 0 }`, never a throw. A quote is a display figure, and the refusal
// that matters already lives in `validateAction`, which rejects the purchase on
// this same null. ⚠ Slice 3, which will DEDUCT this, must not read that 0 as
// "free": it means "no route", and such a trade is refused before fuel is ever
// considered.
function routeFuelCost(systemId) {
  const near = nearestWaystation(systemId);
  if (!near) return { fuelBurn: 0, creditCost: 0 };
  const fuelBurn = Math.ceil(near.distance * SYNDICATE_HAULER_BURN_RATE);
  return { fuelBurn, creditCost: fuelBurn * FLAT_FUEL_PRICE_PER_UNIT };
}

module.exports = {
  GUILD_STARTING_FUEL,
  FLAT_FUEL_PRICE_PER_UNIT,
  SYNDICATE_HAULER_BURN_RATE,
  routeFuelCost,
};
