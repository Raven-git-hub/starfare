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
// real fuel economy (the per-cycle allowance sized by reputation against the
// designed mean line, and the price controller under it) is designed in
// docs/fuel-economy.md and is NOT built; do not read either constant below as a
// stand-in for it.

// GUILD_STARTING_FUEL — the fuel a guild's hoard opens with at founding.
//
// `[FIRST-CUT]` — tune after the waystation rebalance lands (roadmap: 9 -> 96
// waystations), which changes how far a delivery has to travel and therefore
// what a starting hoard is worth.
//
// THE RULING it implements: docs/fuel-economy.md §7 ("New-guild death spiral —
// handled by balancing, not structure") — a new guild starts at ~0 Guild Points
// and ~0 reputation, so the no-fuel -> no-trade -> no-reputation trap is closed
// by an early-game **starter floor**, anchored on design.md §8's survival floor,
// rather than by a structural redesign. This is that starter floor: a baseline
// balance a player can function on while finding their feet.
//
// FLAGGED FOR THE HUMAN: the build prompt for this slice cited the ruling as
// `docs/fuel-supply-and-allocation.md §1.3`. No such file exists in this repo
// (the fuel docs are `fuel-economy.md` and `fuel-allocation-model.md`, and
// neither has a §1.3). The citation above is the nearest real ruling and says
// the same thing; if the intended source is a doc that has not landed yet, this
// comment is the line to correct.
const GUILD_STARTING_FUEL = 500;

// FLAT_FUEL_PRICE_PER_UNIT — credits per unit of `deuterium_fuel`, for DISPLAY
// only. `[FIRST-CUT]`, and a deliberate placeholder: fuel is the one good the
// price engine never prices (design.md §8 — `deuterium_fuel` has no row in
// state.prices, ever), so a hoard has no posted value to mark against and the
// client would otherwise have to invent one. A named constant here means the
// number is in exactly one place when the real fuel price controller replaces it
// (docs/fuel-economy.md §9 open question 4: reuse the price engine, or a
// dedicated reserve-based curve?).
//
// Nothing CHARGES this. It buys nothing and sells nothing — no credit moves
// through it — so invariant 2 cannot see it.
const FLAT_FUEL_PRICE_PER_UNIT = 10;

module.exports = { GUILD_STARTING_FUEL, FLAT_FUEL_PRICE_PER_UNIT };
