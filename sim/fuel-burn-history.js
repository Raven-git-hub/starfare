'use strict';

// fuel-burn-history.js — the per-guild FUEL-BURN history: engine-owned, serialized,
// sparse stored state, so the DEUTERIUM tab's "fuel-burn habits" graph has a series to
// draw and every viewer sees the same curve.
//
// WHY this exists. A snapshot is a single instant; the burn-habits graph is the guild's
// fuel spend OVER TIME — the last N cycles of total burn set against the legal fuel it was
// granted (docs/guild-hall.md, the fuel-burn-history subsection). Nothing in the engine
// carried a per-cycle burn total before this slice: `fuelHoard` is the live hoard, and the
// grant record is only the last boundary's. Neither is a series. This gives it a home with
// the SAME discipline `sim/modifier-history.js` already follows.
//
// A DIRECT SIBLING OF modifier-history, ON PURPOSE. The modifier ring keeps ONE float per
// cycle; this keeps ONE small OBJECT per cycle — `{ burn, granted, contrabandBurned }`, all
// integer fuel QUANTITIES (deliberately NOT credits, so the burn/allotment series stays
// comparable across price moves) — appended at the window boundary, oldest → newest, no
// coarsening:
//     guild.fuelBurnHistory: [ { burn, granted, contrabandBurned }, ... ]   // oldest → newest
//
// WHAT AN ENTRY IS — the CLOSING cycle's fuel accounting, computed at the boundary in
// tick.js step 6 BEFORE the new grant lands (the boundary order is load-bearing — see there):
//   - `burn`             total fuel burned this cycle (legal + contraband), the accumulator
//                        `fuelBurnedThisCycle` funnelled through `burnFuel`.
//   - `granted`          the legal fuel that FUNDED this cycle — the PREVIOUS boundary's grant
//                        (`lastFuelGrant.granted`), post-rationing, i.e. what was actually
//                        received, not what was desired.
//   - `contrabandBurned` the red half of the burn: `max(0, burn − legalBurned)`. Legal-first
//                        `burnFuel` only touches contraband once legal is dry, so this is the
//                        fuel drained from `deuteriumFuel` this cycle.
//
// SPARSE, exactly like modifierHistory / productionHistory. `pushFuelBurnEntry` is the ONLY
// place a `fuelBurnHistory` key is minted, and step 6 calls it only for a guild that BURNED
// this cycle or was DUE a grant — an inert guild (no burn, no grant) gets no key, so a
// holdings-less galaxy with no fuel burn serializes byte-identically to before this slice.
//
// DETERMINISM (invariant 9). This is stored state, so it IS serialized and DOES enter the
// determinism hash — intended. Every field is an integer already moving through the engine
// (the accumulator, the grant record, the two hoards); nothing here reads a clock or a
// random, so the twice-run determinism check reproduces it byte for byte.

// FUEL_BURN_HISTORY_N — how many recent cycles the ring keeps.
//
// 10 — NOT a new game number: it is the DISPLAY DEPTH the DEUTERIUM tab's burn-habits graph
// draws (docs/guild-hall.md), the same 10-cycle window the Standing panel's Performance line
// shows. It feeds no rate, no price, no grant and no commitment — changing it changes only how
// far back the graph can look. The modifier ring keeps 12 (10 + a two-cycle headroom); this
// keeps exactly the 10 the graph draws, because a burn entry is only ever read by that graph
// and there is no second consumer that would want the headroom. Single-sourced here so the
// client plots what it is sent rather than hard-coding a depth. Recorded in docs/phase-1-tuning.md.
const FUEL_BURN_HISTORY_N = 10;

// getFuelBurnHistory(guild) -> the guild's burn ring as stored, or null before any entry has
// landed. Returns the LIVE array (no copy): read-only for callers, exactly as
// sim/modifier-history.js's getModifierHistory is.
function getFuelBurnHistory(guild) {
  return guild.fuelBurnHistory || null;
}

// pushFuelBurnEntry(guild, entry) — append one cycle's `{ burn, granted, contrabandBurned }`,
// creating the ring as needed and dropping the oldest once it is full. The ONLY place a
// `fuelBurnHistory` key is minted, which is what keeps a holdings-less, burn-free galaxy
// byte-identical to pre-slice.
//
// Every field is an integer fuel QUANTITY (§15.2), so each is coerce-checked to a non-negative
// finite integer and a corrupt entry is refused rather than written — a NaN or a fraction in
// serialized state would poison the determinism hash, exactly the guard pushModifierSample runs.
// The stored entry is a FRESH object holding only the three fields, so a caller's object can
// never alias into engine state and no stray key can ride along.
function pushFuelBurnEntry(guild, entry) {
  const { burn, granted, contrabandBurned } = entry || {};
  for (const [name, v] of [['burn', burn], ['granted', granted], ['contrabandBurned', contrabandBurned]]) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new Error(`pushFuelBurnEntry: refusing to record a non-integer/negative ${name} (${v}) for guild ${guild && guild.id}`);
    }
  }
  const ring = guild.fuelBurnHistory || (guild.fuelBurnHistory = []);
  ring.push({ burn, granted, contrabandBurned });
  if (ring.length > FUEL_BURN_HISTORY_N) ring.shift();
  return ring;
}

// cloneFuelBurnHistory(list) -> a deep copy so a caller's array (a scenario or a restored save)
// can never alias into engine state (createGuild uses it, parallel to cloneModifierHistory).
// Each entry is copied field-by-field — a fresh object, not a shared reference — so a later
// mutation of the ring cannot reach back into the seed. Returns a fresh array, empty when there
// is no history.
function cloneFuelBurnHistory(list) {
  return (Array.isArray(list) ? list : []).map((e) => ({
    burn: e.burn,
    granted: e.granted,
    contrabandBurned: e.contrabandBurned,
  }));
}

module.exports = {
  FUEL_BURN_HISTORY_N,
  getFuelBurnHistory,
  pushFuelBurnEntry,
  cloneFuelBurnHistory,
};
