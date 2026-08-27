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

// The engine-wide window length in ticks — RULED 1,440 (27-08-26). This is NOT a
// first cut and NOT an invented number: it is DERIVED from two things already ruled.
// A commitment window is one day (§5 "≈24h"), and a tick is one minute (tick-duration,
// ruled 24-08-26, docs/phase-1-tuning.md) — so 24 h × 60 min/h = 1,440 ticks. See
// docs/cycle-and-calendar.md §1 for the reasoning and §7 for the slicing. The earlier
// value 24 was a placeholder standing in for "≈24h" before tick-duration was fixed;
// it is retired. Do NOT revert it to a memorable-but-wrong number.
//
// It remains only the FALLBACK, consulted when a scenario/test sets no `state.windowN`;
// every scenario and test may override it (that is the "overridable in scenarios/tests"
// requirement), which is why flipping it moves no existing golden. Do NOT bake a
// game-meaningful length into the boundary maths — the boundary is the anchored cadence
// `(tick - dayAnchorTick) % N == 0`, so N enters only as this one dial. The anchor that
// lines that boundary up with a wall-clock day is a separate per-galaxy field (below).
//
// RENAMED `FIRST_CUT_WINDOW_N` -> `DEFAULT_WINDOW_N` in the anchor slice, which had
// these files open anyway: the value is the ruled default, and had not been a first
// cut since the number was ruled. Pure rename, no behavioural change.
const DEFAULT_WINDOW_N = 1440;

// winStartFor(tick, N, dayAnchorTick): the producing tick that opened the window
// CONTAINING `tick`, under the ANCHORED cadence — the boundary falls when
// `(tick - dayAnchorTick) % N == 0`, and that tick is the window's LAST (§5 boundary
// ruling). So a window spans N producing ticks ending on a boundary, and this returns
// its first tick. E.g. N=3, anchor 0: ticks 1,2,3 → 1; 4,5,6 → 4. Pure arithmetic on
// the tick, N and the anchor — no per-commitment stopwatch, and no clock.
//
// The anchor (docs/cycle-and-calendar.md §2) is a per-galaxy integer offset that lines
// cycle boundaries up with server midnight; it defaults to 0, at which this reduces
// EXACTLY to the pre-anchor `tick - ((tick - 1) % N)` — the byte-identical no-op that
// keeps every existing scenario, test and golden unchanged (invariant 9).
//
// The modulo is the SAFE form. An anchored galaxy's anchor is NEGATIVE (see
// calendar.js's anchorForCreation for why the sign is deliberate), and JavaScript's `%`
// keeps the sign of the dividend — so the raw operator would return a negative offset
// here and hand back a window-start LATER than the tick it contains.
function winStartFor(tick, N, dayAnchorTick = 0) {
  return tick - (((tick - 1 - dayAnchorTick) % N + N) % N);
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
  DEFAULT_WINDOW_N, winStartFor, windowFraction, getWindow, setWindow, cloneWindows,
};
