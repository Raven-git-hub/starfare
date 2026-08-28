'use strict';

// history.js — the per-`(system, good)` production/consumption HISTORY buffer:
// engine-owned, serialized, sparse stored state, so the console's two trend
// sparklines survive a reload and read the same for every viewer.
//
// WHY this exists. A snapshot is a single instant. A trend is change over time, so
// until now the console kept its own rolling buffer in the browser (`TREND` in
// client/console.html): it started EMPTY on every page load, said "gathering
// history…" while it refilled, and was thrown away on reload — so no two viewers
// ever saw the same graph. That is history the ENGINE is the only honest owner of.
// This module gives it the same home the Syndicate window accumulators have:
//     guild.productionHistory: { [systemId]: { [good]: { prod: [...], cons: [...] } } }
// reached only through the three accessors below, so the nested shape lives in
// exactly ONE file — the discipline `sim/stock.js`, `sim/profile.js` and
// `sim/windows.js` already follow (design.md §15.4).
//
// WHAT A SAMPLE IS. One sample per producing tick, per `(system, good)`:
//   - `prod` — that tick's FRESH output (Σ mine output for the good, the report's
//     `goods[good].fresh`).
//   - `cons` — that tick's DOWNSTREAM DRAW (what the in-system consuming lines
//     actually took, the report's `goods[good].fork.downstream`).
// These are exactly the two numbers the old client buffer recorded, so the plotted
// line is unchanged — only its source moved from the browser into the engine.
// Oldest → newest; the newest sample is the last element.
//
// SPARSE, exactly like syndicateWindows. `push` is the ONLY place a key is minted,
// and applyProduction calls it only for a good that actually moved (or that already
// carries a series — see below). A galaxy where nothing is mined or refined never
// gets a `productionHistory` key at all, so its serialized state is byte-identical
// to before this slice — which is what makes the golden-hash regen provable.
//
// CONTIGUITY. A series must be contiguous to be a trend: a gap would draw a slope
// between two ticks that are not adjacent. So once a good HAS a series, every tick
// it is still routed pushes a sample — a `0` on a lull included. A good that stops
// being routed at all (its last mine and consumer are gone) simply stops receiving
// samples; its series freezes where it stopped rather than being back-filled with
// invented zeroes. Nothing is pruned: a once-active good keeps its (bounded, ≤ 60
// sample) tail, because "production fell to nothing" is exactly the story the graph
// is for. This is a deliberate, deterministic choice, not an oversight.
//
// DETERMINISM (invariant 9). This is stored state, so it IS serialized and DOES
// enter the determinism hash — intended. Nothing here reads a clock or a random:
// a sample is a pure function of the tick's own resolver report, so the twice-run
// determinism check reproduces it byte for byte.

// How many recent samples a series keeps. This is a DISPLAY-DEPTH constant — how
// much recent history the console can draw — not an economy number: it feeds no
// rate, no price, no commitment, and changing it changes only how far the sparkline
// looks back. Given by the human as 60 (one hour, at 1 tick = 1 minute). Single-
// sourced here; the client never hard-codes a depth, it plots what it is sent.
const HISTORY_N = 60;

// getHistory(guild, systemId, good) -> { prod, cons } as stored, or null if the good
// has no series yet. Returns the LIVE arrays (no copy): read-only for callers.
function getHistory(guild, systemId, good) {
  return (((guild.productionHistory || {})[systemId] || {})[good]) || null;
}

// pushHistory(guild, systemId, good, prod, cons) — append one tick's sample, creating
// the nesting as needed and dropping the oldest sample once the series is full. This
// is the ONLY place a `productionHistory` key is minted, which is what keeps an idle
// galaxy byte-identical to pre-slice state.
//
// `prod`/`cons` are whole units (§15.2 — goods are integers); they are floored and
// clamped at 0 here rather than trusted, so a malformed caller can never write a
// float or a negative into serialized state.
function pushHistory(guild, systemId, good, prod, cons) {
  if (!guild.productionHistory) guild.productionHistory = {};
  if (!guild.productionHistory[systemId]) guild.productionHistory[systemId] = {};
  const series = guild.productionHistory[systemId][good]
    || (guild.productionHistory[systemId][good] = { prod: [], cons: [] });

  series.prod.push(Math.max(0, Math.floor(prod || 0)));
  series.cons.push(Math.max(0, Math.floor(cons || 0)));
  // Ring-cap: the two arrays are pushed in lockstep, so they are capped in lockstep
  // and can never disagree in length (invariants.js asserts that they don't).
  if (series.prod.length > HISTORY_N) series.prod.shift();
  if (series.cons.length > HISTORY_N) series.cons.shift();
}

// cloneHistory(history) -> a deep-enough copy so a caller's object can never alias
// into engine state (createGuild uses it, parallel to cloneWindows/cloneStockpiles).
// The sample arrays are copied too — they are the mutable part.
function cloneHistory(history) {
  const out = {};
  for (const [systemId, perGood] of Object.entries(history || {})) {
    const copy = {};
    for (const [good, series] of Object.entries(perGood)) {
      copy[good] = { prod: [...(series.prod || [])], cons: [...(series.cons || [])] };
    }
    out[systemId] = copy;
  }
  return out;
}

module.exports = { HISTORY_N, getHistory, pushHistory, cloneHistory };
