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
// stays the single source (invariant 5). `N` is NOT stored here either: it is the
// engine-wide `state.windowN` (below) for every good EXCEPT a timed Tier-3 good, which
// settles weekly — and that is DERIVED from the good on every read (`windowNForGood`,
// below), never stored, so it too is not a field here.
//
// CRUCIAL for the no-op proof: the field is created LAZILY — only apply, and only
// for a good with a non-zero aggregate commitment, ever writes it. A guild whose
// every commitment is 0 never gets a `syndicateWindows` key, so its serialized state
// is byte-identical to pre-Slice-B (the determinism hash is unchanged).

// The one "is this good made on a timer?" answer (sim/baseline.js) — read to decide which
// goods settle on the Tier-3 week (windowNForGood, below).
const { ticksPerUnitFor } = require('./baseline.js');

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

// ── THE TIER-3 WEEK (Slice 3a of the Tier-3 economy build) ────────────────────────────
//
// A Tier-3 good is made one whole unit at a time on a timer (docs/tier3-timed-production.md),
// and a slow one makes only a handful a DAY (a heavy reactor engine makes 0.5). So a Tier-3
// commitment is not judged daily: its contract and its settlement window are one WEEK —
// RULED 27-09-26, "Contract & settlement": "exactly one 7-day window (10,080 ticks)". Not a
// new number: 7 days × 1,440 ticks a day at the ruled 1 tick = 1 minute.
const TIER3_WINDOW_N = 10080;

// windowNForGood(good, engineWindowN) -> the length, in ticks, of the window a commitment
// on `good` accrues, settles and is charged over:
//   - a TIMED Tier-3 good (it has a `TICKS_PER_UNIT` timer) -> TIER3_WINDOW_N, the week;
//   - every other good -> `engineWindowN` (the galaxy's `state.windowN`, the day), as always.
//
// DERIVED, NEVER STORED. The good alone decides, through the same `ticksPerUnitFor` that
// decides "timed or continuous?" for production, capacity and the invariants — so the window a
// good settles on can never disagree with how it is made, and no new field enters a save.
// Because the good decides (not the venture), every venture making one good in one system
// shares one window, which is what lets their commitments sum into the good's single `Q`.
//
// THE TWO WINDOWS MUST NEST. The fee charge and the verdicts run inside the daily boundary
// (sim/tick.js), so a week that ended part-way through a day would never be judged at all.
// At the ruled day it nests (10,080 = 7 × 1,440), and so it does for any day length that
// divides 10,080 — but `state.windowN` is a setup knob a test or scenario may set to anything.
// So a timed good under a day that does NOT divide the week THROWS here rather than settle on
// a clock nothing is watching (§15.5: fail loud). Only a COMMITTED or LICENSED timed good ever
// asks, so a galaxy with no Tier-3 licence never reaches the throw.
function windowNForGood(good, engineWindowN) {
  if (ticksPerUnitFor(good) === null) return engineWindowN;
  if (!tier3WindowNests(engineWindowN)) {
    throw new Error(`windowNForGood: ${JSON.stringify(good)} settles on the ${TIER3_WINDOW_N}-tick Tier-3 week, which does not divide into this galaxy's ${engineWindowN}-tick day — a Tier-3 boundary would fall mid-day and never be judged`);
  }
  return TIER3_WINDOW_N;
}

// tier3WindowNests(engineWindowN) -> true iff every Tier-3 week boundary is also a day
// boundary, i.e. the day divides the week exactly. Asked by windowNForGood above (which halts
// when it is false), and by the places that must REFUSE rather than halt: licensing a Tier-3
// venture (sim/actions.js), its fee quote (sim/snapshot.js) and the invariant (sim/invariants.js).
function tier3WindowNests(engineWindowN) {
  return Number.isInteger(engineWindowN) && engineWindowN >= 1 && TIER3_WINDOW_N % engineWindowN === 0;
}

// goodWindow(good, tick, engineWindowN, dayAnchorTick) -> { windowN, windowStart }: the window
// a commitment on `good` is in at producing tick `tick` — its length and the tick it opened on.
// The ONE place the pair is built, so the resolver (which accrues and judges in it) and the tick
// (which sells and charges in it) can never read a good's window differently.
function goodWindow(good, tick, engineWindowN, dayAnchorTick = 0) {
  const windowN = windowNForGood(good, engineWindowN);
  return { windowN, windowStart: winStartFor(tick, windowN, dayAnchorTick) };
}

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

// isWindowBoundary(tick, N, dayAnchorTick): is this producing tick a window's LAST —
// the tick the accrual resolves met/breach on (§5 boundary ruling) and, as of Slice
// 3b-iii, the tick the licence fee is charged on. The ANCHORED cadence
// (docs/cycle-and-calendar.md §2): `(tick - dayAnchorTick) % N == 0`, written with the
// same sign-safe double modulo `winStartFor` uses and for the same reason — an anchored
// galaxy's anchor is NEGATIVE and JavaScript's `%` keeps the DIVIDEND's sign, so the raw
// operator would never see a boundary in such a galaxy at all. §5 writes the test as
// `tick % N == 0` for brevity; this IS that, at the default anchor 0.
//
// Extracted here (from the inline copy in `resolveProduction`) because the formula now
// has TWO readers: the resolver, which resolves the verdicts on this tick, and the tick,
// which charges the fee off them. Two copies of a boundary test is two chances to charge
// on a tick the verdicts were never resolved on.
function isWindowBoundary(tick, N, dayAnchorTick = 0) {
  return (((tick - dayAnchorTick) % N) + N) % N === 0;
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
  DEFAULT_WINDOW_N, TIER3_WINDOW_N, windowNForGood, tier3WindowNests, goodWindow,
  winStartFor, isWindowBoundary, windowFraction, getWindow, setWindow, cloneWindows,
};
