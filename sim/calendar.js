'use strict';

// calendar.js — the pure calendar layer (docs/cycle-and-calendar.md §5).
//
// The tick stays a PLAIN MONOTONIC INTEGER. §5 considered and REJECTED packing the
// day and minute into the counter itself (`00001439` = day 0, minute 1439): it reads
// beautifully and silently corrupts elapsed time, because `+`, `-` and `%` stop
// meaning what they mean in the ~52 places the engine does arithmetic on a tick. So
// the calendar is a DERIVATION on top of the counter, never an encoding inside it.
//
// Everything here is PURE: no state, no clock, no I/O. These functions take a tick
// and give back a day/minute, or take a day/minute and give back a tick. Nothing in
// this file may ever read `Date.now()` — the single wall-clock read in the whole
// system lives at the galaxy-creation seam in sim/server.js, and it calls
// `anchorForCreation` (below) with a number it has already read.
//
// THE `(tick - 1)` PHASE IS LOAD-BEARING. It is the same phase `winStartFor`
// (sim/windows.js) uses, and the same "the boundary tick is the window's LAST" rule
// (§5). Because both derive from that one phase, the calendar's day-roll and the
// engine's met/breach boundary are THE SAME EVENT by construction and cannot drift
// apart. Change the phase here and you silently desynchronise the clock the players
// read from the boundary the engine actually judges on.
//
//   engine tick 0  is the pre-game initial state and is never displayed.
//   engine tick 1  is the first PRODUCING tick, and reads 0000:0000 at anchor 0.

// The safe modulo. JavaScript's `%` is a REMAINDER, not a modulus: it keeps the sign
// of the dividend, so `-570 % 1440` is `-570`, not `870`. Every phase computation
// here can go negative (an anchored galaxy's anchor IS negative — see
// `anchorForCreation`), so the raw operator would hand back negative minutes.
function mod(n, m) {
  return ((n % m) + m) % m;
}

// minuteOf(tick, N, anchor) -> the minute WITHIN the day, in [0, N).
// At anchor 0: tick 1 -> 0, tick N -> N-1 (the day's last minute, and the boundary).
function minuteOf(tick, N, anchor = 0) {
  return mod(tick - 1 - anchor, N);
}

// dayOf(tick, N, anchor) -> which day the tick falls in. Day 0 is the day the galaxy
// was created, whatever time of day that was — which is exactly why `anchorForCreation`
// returns a NEGATIVE anchor rather than its positive congruent twin. See there.
function dayOf(tick, N, anchor = 0) {
  return Math.floor((tick - 1 - anchor) / N);
}

// tickAt(day, minute, N, anchor) -> the tick a (day, minute) names. The exact inverse
// of dayOf/minuteOf, and the scheduling primitive §5 exists to give transports, the
// storyteller and renegotiation deadlines one shared timeline: `tickAt(42, 0)` is
// "day 42, midnight". No range-checking on `minute` on purpose — `tickAt(d, N)` is a
// legitimate way to name the first tick of day d+1, and the arithmetic is exact.
function tickAt(day, minute, N, anchor = 0) {
  return anchor + (day * N) + minute + 1;
}

const pad4 = (n) => String(n).padStart(4, '0');

// format(tick, N, anchor) -> "DDDD:TTTT". DISPLAY NOTATION ONLY — never stored, never
// arithmetic'd on, never parsed back by the engine (§5). Storage is always the plain
// integer tick. A negative day (possible only for a tick before the galaxy's creation,
// which nothing real produces) formats with its sign rather than being clamped: a
// wrong-looking label beats a silently plausible one.
function format(tick, N, anchor = 0) {
  return `${pad4(dayOf(tick, N, anchor))}:${pad4(minuteOf(tick, N, anchor))}`;
}

// anchorForCreation(minuteOfDayNow, N) -> the `dayAnchorTick` that lines this galaxy's
// cycle boundaries up with server midnight (§2). Pure arithmetic: the caller does the
// one wall-clock read and passes the minute-of-day in.
//
// The requirement is that the FIRST PRODUCING TICK (engine tick 1) reads the wall
// clock's current minute-of-day, so from then on minute 0 of each derived day IS
// midnight. Setting minuteOf(1) == minuteOfDayNow gives anchor ≡ -minuteOfDayNow (mod N).
//
// WHY THE NEGATIVE REPRESENTATIVE, not its positive congruent twin. Both satisfy the
// boundary — `(tick - anchor) % N` is identical mod N either way — so the two are
// interchangeable for MET/BREACH. They are NOT interchangeable for `dayOf`, which
// divides rather than reducing: a galaxy created at minute 870 with anchor -870 has
// its creation tick on DAY 0, while the congruent anchor +570 puts the same tick on
// DAY -1. Day 0 is the day the galaxy was created; a galaxy that opens on day -1 and
// reaches day 0 nine hours later is just wrong on the label. So the sign is deliberate,
// and every consumer uses the safe modulo above to cope with it.
//
// Created exactly at midnight -> minuteOfDayNow 0 -> anchor 0, the unanchored default:
// nothing to correct, the first boundary is a full N ticks away. That is also why the
// default anchor is a no-op rather than a special case.
function anchorForCreation(minuteOfDayNow, N) {
  const phase = mod(minuteOfDayNow, N);
  // `-0` is a real JavaScript value, distinct from `0` under Object.is and strict
  // assert, and it has no business reaching state. The midnight case returns a clean 0.
  return phase === 0 ? 0 : -phase;
}

// minuteOfDayFromDate(date) -> the wall clock's minute-of-day, 0..1439. The ONE
// impure input to this module, and it is impure only in its ARGUMENT: the caller
// supplies the Date. Kept here so the clock-to-calendar conversion is stated once,
// beside the arithmetic that consumes it, rather than inlined at the server seam.
// Uses LOCAL server time — "server midnight" in §2 means the server's own midnight.
function minuteOfDayFromDate(date) {
  return (date.getHours() * 60) + date.getMinutes();
}

module.exports = {
  minuteOf, dayOf, tickAt, format, anchorForCreation, minuteOfDayFromDate,
};
