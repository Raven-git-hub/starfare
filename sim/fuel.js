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
// SCOPE TODAY (fuel Slice 1): the founding grant, and a flat unit price for
// display. There is no pool, no issuance, no cycle allowance and no fuel
// SPENDING yet — a hoard is seeded at founding and then simply sits there. The
// real fuel economy (the commons and its reserve, mean-line issuance sized by
// reputation against Points, and the reserve/flow price controller under it) is
// designed in docs/fuel-supply-and-allocation.md and is NOT built; do not read
// either constant below as a stand-in for it. That doc's §8 names the two
// slices that come next: the route fuel-cost quote, then deducting it on a
// Syndicate trade.

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

module.exports = { GUILD_STARTING_FUEL, FLAT_FUEL_PRICE_PER_UNIT };
