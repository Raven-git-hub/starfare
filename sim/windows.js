'use strict';

// windows.js — the Syndicate windowed-accrual state accessor (design.md §5
// "The Syndicate commitment is a per-good windowed accrual", §15.4; Slice B-i).
//
// The Syndicate fork no longer delivers its full commitment every tick (Slice A's
// engine cut). Instead a good's commitment is an AGGREGATE TARGET `Q` delivered
// over a WINDOW of `N` ticks, at a paced/absolute/percentage per-tick send. The
// bookkeeping that spans ticks is ENGINE-OWNED state, per `(guild, system, good)`:
//     guild.syndicateWindows: { [systemId]: { [good]: { windowStart, delivered, sendCarry } } }
// mirroring how `guild.stockpiles` (sim/stock.js) and `guild.productionProfile`
// (sim/profile.js) are system-scoped maps reached only through one accessor file.
// This is the field placement §15.4 deferred to the build: the clean home is a new
// guild-level map beside its two siblings, so the shape lives in exactly ONE file.
//
//   - `windowStart` (int ≥ 1): the producing tick the CURRENT window opened on.
//   - `delivered`   (int ≥ 0): units delivered to the Syndicate so far THIS window.
//   - `sendCarry`   (float in [0,1)): the fractional send remainder, floor-and-carry
//                    per the `batchCarry` discipline (§5, RULED) — the one sanctioned
//                    non-integer, fenced off the goods ledger with its own tripwire.
//
// `Q` is NOT stored here: it is DERIVED = Σ `Venture.syndicateCommitment` over the
// ventures producing the good (× the window fraction, below) — the venture field
// stays the single source (invariant 5). `N` is NOT stored here either: it is a
// single engine-wide value read from `state.windowN` (below).
//
// CRUCIAL for the no-op proof: the field is created LAZILY — only apply, and only
// for a good with a non-zero aggregate commitment, ever writes it. A guild whose
// every commitment is 0 never gets a `syndicateWindows` key, so its serialized state
// is byte-identical to pre-Slice-B (the determinism hash is unchanged).

// [FIRST-CUT] the engine-wide window length in ticks — UNRULED. Recorded here and in
// docs/phase-1-tuning.md, flagged for a ruling; NEVER invented silently in game
// logic. It is only the FALLBACK when a scenario/test sets no `state.windowN`; every
// scenario and test may override it (that is the "overridable in scenarios/tests"
// requirement). Design says a window is ≈24h once tick-duration is ruled (§5); 24
// echoes that memorably but is a pure guess — do NOT treat it as tuned, and do NOT
// bake a game-meaningful length into the boundary maths (the boundary is the GLOBAL
// cadence `tick % N == 0`, so N enters only as this one dial).
const FIRST_CUT_WINDOW_N = 24;

// winStartFor(tick, N): the producing tick that opened the window CONTAINING `tick`,
// under the GLOBAL cadence — the boundary falls when `tick % N == 0`, and that tick
// is the window's LAST (§5 boundary ruling). So window k spans producing ticks
// [(k-1)·N + 1, k·N], and this returns its first tick. E.g. N=3: ticks 1,2,3 → 1;
// 4,5,6 → 4. Pure arithmetic on the tick and N — no per-commitment stopwatch.
function winStartFor(tick, N) {
  return tick - ((tick - 1) % N);
}

// windowFraction(venture, windowStart, N): the fraction of the current window the
// venture is committed for — the term in `Q = Σ commitment × fraction` that lets a
// mid-window joiner owe only a pro-rated share of its first window (§5 join ruling,
// Option A). LIVE as of Slice 3b-ii (27-08-26): `applyForLicence` stamps the venture's
// `committedFromTick`, so a mine licensed part-way through a window owes only the share
// of `Q` for the ticks it is actually present — a share it can meet. Before that stamp
// existed this returned 1 for everything, and a tripwire asserted so; that guard is
// retired and replaced by the correctness checks in invariants.js (a fraction in
// (0, 1], never 0, never above 1) — see docs/mid-window-pro-rate.md.
//
// The math itself is unchanged from Slice B-i — this was always built, only unreached.
// `committedFromTick` is the venture's FIRST PRODUCING tick (see actions.js's stamp),
// so `present` counts the producing ticks from it to the boundary inclusive. Absent —
// an unlicensed venture, or one committed through the `setSyndicateCommitment` dev
// scaffold, which deliberately stays full-window — means "present since before the
// window opened" → 1, so their behaviour is untouched.
function windowFraction(venture, windowStart, N) {
  const from = venture.committedFromTick;
  if (from == null || from <= windowStart) return 1;
  const present = windowStart + N - from; // ticks present in this window
  return Math.max(0, Math.min(1, present / N));
}

// getWindow(guild, systemId, good) -> the stored window state, or null if none.
function getWindow(guild, systemId, good) {
  return (((guild.syndicateWindows || {})[systemId] || {})[good]) || null;
}

// setWindow(guild, systemId, good, win) -> persist one good's window state, creating
// the nesting as needed. This is the ONLY place a `syndicateWindows` key is minted
// (apply calls it, only for a committed good), which is what keeps the unlicensed
// path byte-identical. `win` = { windowStart, delivered, sendCarry }.
function setWindow(guild, systemId, good, win) {
  if (!guild.syndicateWindows) guild.syndicateWindows = {};
  if (!guild.syndicateWindows[systemId]) guild.syndicateWindows[systemId] = {};
  guild.syndicateWindows[systemId][good] = win;
}

// cloneWindows(windows) -> a deep-enough copy so a caller's object can never alias
// into engine state (createGuild uses it, parallel to cloneStockpiles/cloneProfile).
function cloneWindows(windows) {
  const out = {};
  for (const [systemId, perGood] of Object.entries(windows || {})) {
    const copy = {};
    for (const [good, win] of Object.entries(perGood)) copy[good] = { ...win };
    out[systemId] = copy;
  }
  return out;
}

module.exports = {
  FIRST_CUT_WINDOW_N, winStartFor, windowFraction, getWindow, setWindow, cloneWindows,
};
