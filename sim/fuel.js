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
// burn — now SPACE-TIERED across three Syndicate hauler tiers (transport-model.md
// §5.1: a leg flies on the smallest hold its cargo SPACE fits, and the tier sets the
// per-hex rate) — the cargo-space primitives that size a load (`volumeOf`,
// `haulerTierForSpace`), and the one function that marks physical fuel to money.
// Everything that MOVES fuel lives elsewhere and reads from here — the grant and the
// pool in sim/issuance.js and tick.js's step 6, the burn's deduction in sim/actions.js.
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
const { tierOf } = require('./points.js');

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

// SYNDICATE_HAULER_BURN_RATE — the LIGHT-tier per-hex burn rate, in fuel units.
//
// `[FIRST-CUT]`, RULED 31-08-26 (docs/fuel-supply-and-allocation.md §8, Slice 2) as the
// single flat rate; ⤳ REFINED 11-09-26 / REVISED 14-09-26 (transport-model.md §5.1) — the
// one hauler became THREE space-tiered ones, and this constant is now the LIGHT row of the
// rate table (`HAULER_TIERS` below), unchanged in value so a leg that fits a light hold in
// SPACE is byte-identical to the pre-tier burn. The medium/heavy rates live beside it in the
// table; nothing inlines any of them. Tune after the waystation rebalance lands (roadmap:
// 9 -> 96 waystations), which moves every distance in the galaxy and so moves every burn.
//
// THE STAND-IN NOTE: design.md §15.4 defines `Vehicle.fuelCostToRun` and names the
// Syndicate Hauler as an instance of that shape. No such Vehicle row exists in
// state — minting one is out of scope here — so these module constants stand in
// for the field until it does.
const SYNDICATE_HAULER_BURN_RATE = 0.5;

// HAULER_TIERS — the three Syndicate-hauler tiers, RULED (transport-model.md §5.1; the
// numbers are `phase-1-tuning.md`'s, the authority on the values). A shipment flies on the
// SMALLEST tier whose hold fits its load, and the tier moves fuel, never time (speed is
// identical across tiers). Two things vary per tier and nothing else:
//   - `hold`  — capacity, measured in cargo SPACE (`Σ qty × volumeOf(good)`, REVISED 14-09-26
//               from unit-count). Light 10,000 / medium 50,000 / heavy 6,000,000.
//   - `rate`  — per-hex burn. Light 0.5 (== SYNDICATE_HAULER_BURN_RATE) / medium 0.6 / heavy 0.7.
// Ordered smallest → largest hold; `haulerTierForSpace` walks it in that order. `[FIRST-CUT]`:
// the human's anchors fixed the ratios (100 T2 fill a light; a T3 will not fit a medium; 100
// T3 fill a heavy; a non-movable T4 asset fills a heavy hold), the scale is provisional. The
// heavy hold is ~100× a medium's — lopsided on purpose (§5.1: a heavy is the only hauler that
// moves modules or assets). Frozen rows so nothing mutates the ruled table.
const HAULER_TIERS = Object.freeze([
  Object.freeze({ tier: 'light', hold: 10000, rate: SYNDICATE_HAULER_BURN_RATE }),
  Object.freeze({ tier: 'medium', hold: 50000, rate: 0.6 }),
  Object.freeze({ tier: 'heavy', hold: 6000000, rate: 0.7 }),
]);

// HEAVY_HOLD — the largest hold's capacity, the reject-whole cap (§5.1 / §8.0). A load whose
// total space exceeds this is refused with a split-the-order message; no auto-split. Derived
// from the table's last row so the cap and the tier can never disagree (invariant 5).
const HEAVY_HOLD = HAULER_TIERS[HAULER_TIERS.length - 1].hold;

// TIER_VOLUME — cargo space per UNIT of a good, keyed by its manufacturing tier (`tierOf`,
// sim/points.js — a function of the tier ONLY, not per-good: two T3 modules take the same
// room). RULED (transport-model.md §5.1). T1 raw = 1, T2 processed = 100, T3 module = 60,000.
const TIER_VOLUME = Object.freeze({ 1: 1, 2: 100, 3: 60000 });

// ASSET_CARGO_VOLUME — the cargo space a non-movable Tier-4 asset (a bought outpost / rig)
// fills: a WHOLE heavy hold (== HEAVY_HOLD). So a bought asset (2.1d, buyAssetFromSyndicate)
// flies heavy, alone, and its delivery burns the heavy rate (§5.1, RULED 14-09-26 — superseding
// asset-purchase.md's light-rate placeholder). Its own constant, not a `TIER_VOLUME[4]`, because
// a T4 asset is not a stockpile good `tierOf` ever resolves — it never rides a cart.
const ASSET_CARGO_VOLUME = HEAVY_HOLD;

// volumeOf(good) -> the cargo space ONE unit of `good` takes, from its manufacturing
// tier (`tierOf`). T1 -> 1, T2 -> 100, T3 -> 60,000. THROWS for a good with no ruled
// cargo volume — fuel, an unknown name, anything `tierOf` returns null for. FAIL-LOUD:
// a cart is only ever priced goods (validate refuses fuel and non-priced names up
// front), so a good reaching here without a volume is a bug, and under-sizing a load
// by scoring it 0 would be the quietest possible under-charge (§18 / §15.5).
function volumeOf(good) {
  const tier = tierOf(good);
  const volume = tier === null ? undefined : TIER_VOLUME[tier];
  if (volume === undefined) {
    throw new Error(
      `volumeOf: "${good}" has no cargo volume — its tier is ${tier === null ? 'UNKNOWN (not a priced cargo good)' : tier}, `
      + 'and only T1/T2/T3 goods ride a Syndicate cart (transport-model.md §5.1). Refusing to size it as 0, '
      + 'which would understate the load and under-charge the burn',
    );
  }
  return volume;
}

// haulerTierForSpace(space) -> 'light' | 'medium' | 'heavy' | null.
//
// The SMALLEST hold whose capacity is >= `space` (§5.1's whole rule — the tier
// restrictions fall out of the volumes, there are no separate ones). Inclusive at each
// boundary: 10,000 -> light, 10,001 -> medium, 50,000 -> medium, 50,001 -> heavy,
// 6,000,000 -> heavy, 6,000,001 -> null. `null` = over the heavy hold: no hauler carries
// it, and the caller reject-wholes (split the order).
function haulerTierForSpace(space) {
  for (const t of HAULER_TIERS) {
    if (space <= t.hold) return t.tier;
  }
  return null;
}

// rateForTier(tier) -> the per-hex burn rate for a tier name. The one lookup, so no rate
// is ever inlined. Throws on an unknown tier (a caller passing a bad name is a bug).
function rateForTier(tier) {
  const row = HAULER_TIERS.find((t) => t.tier === tier);
  if (!row) throw new Error(`rateForTier: no such Syndicate hauler tier ${JSON.stringify(tier)}`);
  return row.rate;
}

// routeFuelCost(systemId, space) -> { fuelBurn: int }
//
// The fuel a Syndicate trade burns flying between `systemId` and its nearest waystation,
// on the tier the LOAD'S SPACE selects. PURE: the geography is baked into the seed, and
// the tier is a function of `space` alone.
//
// `space` IS REQUIRED (throws if undefined). ⤳ REVISED 14-09-26 (transport-model.md
// §5.1): the burn is no longer cargo-independent — which hauler tier flies, and so which
// per-hex rate applies, is chosen by the leg's total cargo space (`Σ qty × volumeOf`). A
// charge site that forgot to pass the load would silently under-charge at whatever a
// missing argument defaulted to, so a missing `space` is a fail-loud bug, not a light-tier
// default. Every caller (BUY, SELL, asset, snapshot) passes an explicit space.
//
// DISTANCE COMES FROM `nearestWaystation`, NOT A SECOND MEASUREMENT — `near.distance` is
// the value that function already computed and the one `buyFromSyndicate` schedules the
// arrival tick on, so a trip cannot be priced on one geometry and flown on another.
//
// `Math.ceil` so every REAL route costs at least 1 fuel (the closest seed system is 1 hex
// out; 1 × 0.5 = 0.5 would floor to a free trip). Zero is reserved for the no-route case.
//
// ⚠ IT QUOTES A BURN, NOT A PRICE (slice 5b-i, §4.2): what the burn is WORTH in credits is
// `fuelValue(fuelBurn, reserve.fuelPrice)` at the display site (sim/snapshot.js). The return
// shape stays an object so every `const { fuelBurn } = routeFuelCost(...)` caller is untouched.
//
// GRACEFUL ABSENCE: no reachable waystation -> `{ fuelBurn: 0 }` (checked BEFORE the tier, so
// a no-route quote never depends on the load). An OVER-CAP space (> heavy hold) THROWS: it must
// be reject-wholed by the caller before the fuel gate, so reaching here with one is a bug, and
// returning a burn would price a trip no hauler can fly.
function routeFuelCost(systemId, space) {
  if (space === undefined) {
    throw new Error('routeFuelCost: space is required — a charge site that omits the load would silently under-charge (transport-model.md §5.1)');
  }
  const near = nearestWaystation(systemId);
  if (!near) return { fuelBurn: 0 };
  const tier = haulerTierForSpace(space);
  if (tier === null) {
    throw new Error(`routeFuelCost: load space ${space} exceeds the heavy hold (${HEAVY_HOLD}) — the reject-whole gate must refuse it before the fuel charge (transport-model.md §8.0)`);
  }
  return { fuelBurn: Math.ceil(near.distance * rateForTier(tier)) };
}

// routeFuelBurnByTier(systemId) -> { light, medium, heavy } — the per-hex burn for THIS
// system's route at each of the three tiers, three ints. The snapshot publishes it so the
// client can read the burn for whichever tier its cart's space maps to (§18: the client
// picks the tier from `goodVolumes` + `haulerTiers`, reads the matching burn, computes none).
// A system with no reachable waystation reads 0 at every tier, the same honest no-route value
// `routeFuelCost` reports. Every tier here is a plain `ceil(distance × rate)`, never a
// re-derivation — the same geometry `routeFuelCost` uses.
function routeFuelBurnByTier(systemId) {
  const near = nearestWaystation(systemId);
  const out = {};
  for (const t of HAULER_TIERS) {
    out[t.tier] = near ? Math.ceil(near.distance * t.rate) : 0;
  }
  return out;
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

// burnFuel(guild, amount) -> the amount burned (== `amount`), having MUTATED the guild.
//
// LEGAL-FIRST route burn (§1.4 "The illegal path, made concrete", slice 1b). A guild now
// holds fuel in TWO stores — legal `fuelHoard` (blue) and contraband `deuteriumFuel` (red,
// refined by an illegal refinery) — and both are burnable. This is the ONE place a burn is
// split across them, so every route-burn site (SELL + BUY, sim/actions.js) spends them in
// the same order: `fuelHoard` FIRST, `deuteriumFuel` only for the remainder.
//
// Burn-legal-first is DELIBERATE and load-bearing (§1.4): a guild still holding legal fuel
// never touches its red, so contraband is STICKY — it depletes only once legal fuel is dry —
// and accumulates as a visible liability rather than being quietly consumed. It is the
// intended tension, not an accident of order.
//
// THE CALLER OWNS THE GATE AND THE COUNTER. This does NOT check sufficiency: the validate
// gate refuses reject-whole when `fuelHoard + deuteriumFuel < amount`, so by the time apply
// calls this the combined stores cover it and neither store is driven negative. And this does
// NOT touch `audit.totalConsumed`: both stores are held fuel, so burning `amount` from either
// is one consumption event — the caller does `totalConsumed += amount` once, keeping invariant
// 1 closed (held −amount, consumed +amount). Returning `amount` lets the caller write that in
// one line without re-summing.
//
// `deuteriumFuel` is decremented WITHOUT deleting a resulting 0 — the same discipline
// `addStock` (a drained stockpile cell stays at 0) and the 1a raw store already follow; a
// restore normalises a 0 back to absent via createGuild's omit-when-0. It is only ever touched
// when there is a remainder, so a guild with no contraband never has the key minted.
//
// THE BURN COUNTER (the fuel-burn-history slice, docs/guild-hall.md). Every route burn funnels
// through here, so this is the one place to accumulate the cycle's TOTAL burn — legal AND
// contraband together — for the DEUTERIUM tab's burn-habits graph. `fuelBurnedThisCycle` is a
// STATISTIC, never held fuel: it is NOT summed by invariant 1's conservation nor by
// `computeGalacticSupply`'s `guildHeld` (both count only the two hoards), and it is RESET at
// each cycle boundary (tick.js step 6) after the closing cycle's entry is recorded. Minted
// only when a burn actually happens (`+= amount` on a real burn), so a guild that never burns
// carries no key — omit-when-0, like the two stores above.
function burnFuel(guild, amount) {
  const fromHoard = Math.min(guild.fuelHoard, amount);
  guild.fuelHoard -= fromHoard;
  const remainder = amount - fromHoard;
  if (remainder > 0) guild.deuteriumFuel = (guild.deuteriumFuel || 0) - remainder;
  if (amount > 0) guild.fuelBurnedThisCycle = (guild.fuelBurnedThisCycle || 0) + amount;
  return amount;
}

module.exports = {
  GUILD_STARTING_FUEL,
  REFERENCE_FUEL_PRICE,
  SYNDICATE_HAULER_BURN_RATE,
  HAULER_TIERS,
  HEAVY_HOLD,
  TIER_VOLUME,
  ASSET_CARGO_VOLUME,
  volumeOf,
  haulerTierForSpace,
  rateForTier,
  routeFuelCost,
  routeFuelBurnByTier,
  fuelValue,
  burnFuel,
};
