'use strict';

// supply.js — the derived galactic-supply totals. This is the "resources
// section at the top of the state" from the design discussion, computed rather
// than authored: there is exactly ONE source of truth for how much of a good
// exists (the guilds' stockpiles, plus the fuel reserve), and this file sums
// it. Storing the result on the state is a CACHE for the viewer/telemetry, not
// a second source — invariants.js re-derives it every tick and asserts the
// cache still matches, so the two can never silently drift (design.md §15's
// "derive, don't store" applied honestly: derive, and if you cache, guard it).
//
// The fuel asymmetry is deliberate and load-bearing (design.md §3, §7,
// fuel-allocation-model.md §2):
//   - Non-fuel resources: the Syndicate has an effectively infinite backend, so
//     the only quantity that physically exists is what guilds hold. Total =
//     Σ guild stockpiles. NOT conserved — mining mints it, selling sinks it
//     into the infinite backend. So the invariant here is a CONSISTENCY check
//     (cache == live sum), never a conservation one (constant over time).
//   - Fuel (`deuterium_fuel`): finite, no infinite backend. It lives in the
//     communal Syndicate reserve and in private guild hoards. Reported here as
//     two figures — `reserve` (the communal pool, the headline "galactic fuel
//     stockpile") and `guildHeld` (Σ hoards) — kept separate because a future
//     fuel price may read one, the other, or their sum (an open pricing-time
//     decision), and because fuel conservation (invariant 1) is defined on them.

const { STOCKPILE_GOODS } = require('./resources.js');
const { guildTotals } = require('./stock.js');

// computeGalacticSupply(state) — pure. Returns a fresh totals object:
//   {
//     resources: { <every stockpile good>: <Σ guild.stockpiles[good]> }, // all
//                 // raw + processed keys always present, zero-filled, stable
//     fuel:      { reserve: <communal pool>, guildHeld: <Σ guild fuelHoard> },
//   }
function computeGalacticSupply(state) {
  const guilds = state.guilds || [];

  const resources = {};
  for (const good of STOCKPILE_GOODS) resources[good] = 0;
  for (const g of guilds) {
    // guildTotals flattens the guild's per-system pools (ruling B1, §15.2) into
    // one { good: int } — the guild-wide PRICING AGGREGATE, which is exactly what
    // galactic supply is. Unknown keys are left to invariants.js to flag; summing
    // them here would hide the error, so only fold known resources into totals.
    for (const [good, qty] of Object.entries(guildTotals(g))) {
      if (Object.prototype.hasOwnProperty.call(resources, good)) {
        resources[good] += qty;
      }
    }
  }

  const guildHeld = guilds.reduce((sum, g) => sum + (g.fuelHoard || 0), 0);
  const reserve = state.reserve ? state.reserve.reserveLevel : 0;

  return { resources, fuel: { reserve, guildHeld } };
}

module.exports = { computeGalacticSupply };
