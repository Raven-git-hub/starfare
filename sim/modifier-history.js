'use strict';

// modifier-history.js — the per-guild ISSUANCE-MODIFIER history: engine-owned,
// serialized, sparse stored state, so the Guild Hall's Performance line has a
// series to draw and every viewer sees the same curve.
//
// WHY this exists. A snapshot is a single instant; the Performance line is the
// guild's modifier OVER TIME — the last N cycles of "where you sat against your
// line" (docs/guild-hall.md §2.1). `issuanceModifier` recomputes on read and so
// carries only the value RIGHT NOW, and the stored `lastFuelGrant.modifier` (the
// Guild Hall slice's B) carries only the LAST boundary's. Neither is a series, so
// until this slice there was no history to plot. This gives it a home with the same
// discipline `sim/history.js` and `sim/price-history.js` already follow.
//
// SIMPLER THAN price-history, ON PURPOSE. The posted price is galaxy-wide and wants a
// 3-month chart, so it keeps three coarsening rings per good. The modifier is
// PER-GUILD and the panel wants only the recent cycles, so this is ONE small ring per
// guild, ONE sample per cycle (at the window boundary), no coarsening:
//     guild.modifierHistory: [ <modifier>, <modifier>, ... ]   // oldest → newest
//
// WHAT A SAMPLE IS — the modifier that DROVE that cycle's grant, i.e.
// `issuanceModifier(state, guild)` read at the boundary, the SAME value stamped on
// `lastFuelGrant.modifier` in the same breath (tick.js step 6). One sample per cycle,
// appended at the boundary, so the cadence is automatic. Oldest → newest.
//
// SPARSE, exactly like productionHistory / syndicateWindows. `pushModifierSample` is
// the ONLY place a `modifierHistory` key is minted, and step 6 calls it only for a
// guild that was DUE a grant this cycle (`desired > 0`) — the same condition that
// gates `recordFuelGrant` and the cycle-start hoard stamp. A guild holding nothing
// (GP 0, modifier a trivial 1.0 on its own line) is never due anything, so it never
// gets a key and a holdings-less galaxy serializes byte-identically to before this
// slice — the property the golden regen rests on.
//
// DETERMINISM (invariant 9). This is stored state, so it IS serialized and DOES enter
// the determinism hash — intended. A sample is a pure function of the guild's Points
// and reputation at the boundary; nothing here reads a clock or a random, so the
// twice-run determinism check reproduces it byte for byte.

// MODIFIER_HISTORY_N — how many recent cycles the ring keeps.
//
// `[FIRST-CUT]` 12. This is a DISPLAY-DEPTH constant — how far back the Performance
// line can look — not an economy number: it feeds no rate, no price, no grant and no
// commitment, and changing it changes only how many points the line can draw. The
// panel draws the last 10 (docs/guild-hall.md §2.1); 12 keeps that plus a two-cycle
// headroom, so a sample the panel is still showing is not dropped the instant a newer
// boundary lands, while the ring stays trivially small (≤ 12 floats per guild in the
// save and the hash). Single-sourced here so a tuning change is a one-line edit and
// the client plots what it is sent rather than hard-coding a depth. Recorded in
// docs/phase-1-tuning.md.
const MODIFIER_HISTORY_N = 12;

// getModifierHistory(guild) -> the guild's modifier ring as stored, or null before any
// sample has landed. Returns the LIVE array (no copy): read-only for callers, exactly
// as sim/history.js's getHistory and price-history's getPriceHistory are.
function getModifierHistory(guild) {
  return guild.modifierHistory || null;
}

// pushModifierSample(guild, modifier) — append one cycle's modifier, creating the ring
// as needed and dropping the oldest once it is full. The ONLY place a `modifierHistory`
// key is minted, which is what keeps a holdings-less galaxy byte-identical to pre-slice.
//
// The modifier is a COEFFICIENT (it scales a grant, it is not fuel), so it is a float by
// design (§15.2's sanctioned non-integer, exactly as `issuanceModifier` itself). It is
// coerced-checked and a non-finite value refused rather than written, so a corrupt caller
// can never put a NaN into serialized state where it would poison the determinism hash.
function pushModifierSample(guild, modifier) {
  if (typeof modifier !== 'number' || !Number.isFinite(modifier)) {
    throw new Error(`pushModifierSample: refusing to record a non-finite modifier (${modifier}) for guild ${guild && guild.id}`);
  }
  const ring = guild.modifierHistory || (guild.modifierHistory = []);
  ring.push(modifier);
  if (ring.length > MODIFIER_HISTORY_N) ring.shift();
  return ring;
}

// cloneModifierHistory(list) -> a copy so a caller's array can never alias into engine
// state (createGuild uses it, parallel to cloneHistory / clonePriceHistory). Returns a
// fresh array — empty when there is no history — so the snapshot can emit a stable
// [] for a guild that has none, the way price-history emits its rings unconditionally.
function cloneModifierHistory(list) {
  return [...(Array.isArray(list) ? list : [])];
}

module.exports = {
  MODIFIER_HISTORY_N,
  getModifierHistory,
  pushModifierSample,
  cloneModifierHistory,
};
