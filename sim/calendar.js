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

// displayLabel(tick, N, anchor) -> what a SCREEN shows for this tick: `format` above for
// any real, producing tick, and an em-dash for the pre-game `tick 0`.
//
// Tick 0 is the initial state and "is never displayed" (the header note above) — but it
// is reachable on screen the moment a galaxy is created and not yet ticked, and `format`
// answers it honestly with `00-1:1439` (`00-1:0023` on an anchored galaxy): day -1,
// because day 0 starts at the FIRST PRODUCING tick. That label is not wrong, it is just not a moment. So the guard is here,
// at the DISPLAY seam, and `format`/`dayOf` keep answering exactly as before — the
// arithmetic stays exact and un-clamped (a clamped day would silently corrupt elapsed
// time, which is the mistake this whole file exists to avoid).
function displayLabel(tick, N, anchor = 0) {
  return tick < 1 ? '—' : format(tick, N, anchor);
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

// The length of a day in minutes. Not an invented number: the cycle is one 24-hour day
// and a tick is one minute (§1), so a day is 24 x 60. It is the modulus for wall-clock
// minute-of-day arithmetic, which is a property of the CLOCK, not of the window length
// `N` — an operator who shortens `N` for a test galaxy does not shorten the day.
const MINUTES_PER_DAY = 1440;

// The legal range of a galaxy's `utcOffsetMinutes`: UTC-12:00 .. UTC+14:00, the real
// span of civil time offsets in use. A FIXED numeric offset by ruling (§2): no named
// zones, no tzdata, no daylight-saving shift.
const UTC_OFFSET_MIN_MINUTES = -720;
const UTC_OFFSET_MAX_MINUTES = 840;

// isUtcOffsetMinutes(v) -> is this a value we would store as a galaxy's offset?
// Exported so the ONE validating seam (the create endpoint) and the tests agree on the
// rule instead of each spelling it out.
function isUtcOffsetMinutes(v) {
  return Number.isInteger(v) && v >= UTC_OFFSET_MIN_MINUTES && v <= UTC_OFFSET_MAX_MINUTES;
}

// minuteOfDayFromDate(date) -> the UTC minute-of-day, 0..1439. The ONE impure input to
// this module, and it is impure only in its ARGUMENT: the caller supplies the Date.
//
// UTC, deliberately (28-08-26). It used to read `getHours()`, the CONTAINER's local
// time, which made "server midnight" whatever timezone the box happened to be set to —
// an accident of deployment, and one that disagreed with every display, which renders
// the server clock from a UTC ISO string. The zone is now an explicit per-galaxy choice
// (`utcOffsetMinutes`, §2), so this function answers in the one frame that needs no
// configuration, and `localMinuteOfDay` below applies the galaxy's chosen offset to it.
function minuteOfDayFromDate(date) {
  return (date.getUTCHours() * 60) + date.getUTCMinutes();
}

// localMinuteOfDay(utcMinuteOfDay, utcOffsetMinutes) -> the minute-of-day at the
// galaxy's chosen offset, 0..1439, wrapping across the date line at either end.
// Pure: it is the shift that turns the UTC read above into the local time whose
// midnight `anchorForCreation` then anchors the cycle to.
//
// At offset 0 it is the identity on an already-in-range minute, which is the whole
// no-op proof for an unconfigured galaxy.
function localMinuteOfDay(utcMinuteOfDay, utcOffsetMinutes = 0) {
  return mod(utcMinuteOfDay + utcOffsetMinutes, MINUTES_PER_DAY);
}

module.exports = {
  minuteOf, dayOf, tickAt, format, displayLabel, anchorForCreation, minuteOfDayFromDate,
  localMinuteOfDay, isUtcOffsetMinutes,
  MINUTES_PER_DAY, UTC_OFFSET_MIN_MINUTES, UTC_OFFSET_MAX_MINUTES,
};
