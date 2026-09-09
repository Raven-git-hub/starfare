'use strict';

// events.js — the append-only per-guild EVENT LOG and its retention (the RULING is
// docs/event-log.md; design.md §5 "Message delivery — standing conditions vs discrete
// events"). It owns the notice vocabulary, the one writer, and the shared liveness
// predicate, the way sim/resources.js owns the goods vocabulary and sim/windows.js owns
// the windowed-accrual shape — so the event log's shape lives in exactly one file and no
// consumer re-types it.
//
// WHAT AN EVENT IS (design.md §5). A standing condition — "this venture's window has
// elapsed; here are the terms" — is re-derivable from state every tick and is NEVER stored
// (it is the derived `renegotiationOffer` / `attention.renegotiations`). A DISCRETE EVENT
// happened AT A TICK and cannot be re-derived — a licence lapsed, a venture was closed — so
// it must be RECORDED. This file is that record: an append-only per-guild log of
// `{ id, tick, type, payload }` rows, surfaced read-only in the snapshot's Notices seam
// (the client panel renders it in a following slice).
//
// THIS SLICE'S WRITERS. Only the two shared licence removers write here (sim/licence.js):
// `applyLapse` writes `licence_lapsed`, `applyVentureClosure` writes `venture_closed`. The
// storyteller / rival / disaster writers are future work (§5). Renegotiation ACCEPT writes
// nothing — an accept is a re-lock, not a discrete loss.

// --- The type vocabulary (docs/event-log.md §2) ----------------------------------
//
// The two notice types this slice can write, ONE source of truth for "what a notice type
// is", used by the writers and by the checkEventLog invariant (sim/invariants.js). Kept as
// named constants beside a frozen set, mirroring resources.js's RAW_RESOURCES / its set.
const LICENCE_LAPSED = 'licence_lapsed';   // an ordinary licence lapsed to unlicensed
const VENTURE_CLOSED = 'venture_closed';   // a venture was removed (torn down / forced-closed)

const EVENT_TYPES = Object.freeze([LICENCE_LAPSED, VENTURE_CLOSED]);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

// isEventType(id) -> is `id` a known notice type?
function isEventType(id) {
  return EVENT_TYPE_SET.has(id);
}

// --- Retention (docs/event-log.md §4) --------------------------------------------
//
// DISPLAY retention, not economy tuning — how long a notice stays visible in the Notices
// panel, keyed on read/unread. At the ruled cadence (1 tick = 1 minute, design.md §5) these
// are 10 and 2 real days: an UNREAD notice lingers ten days so a player logging in weekly
// still sees what happened; once READ it falls away in two. They live HERE, with that
// display rationale, rather than in phase-1-tuning.md, because they feed no rate, price or
// commitment — they are not a `[FIRST-CUT]` economy number. Read from event-log.md §4;
// invented here would violate §0 / CLAUDE.md, so they are cited, not chosen.
const RETENTION_UNREAD_TICKS = 14400;   // 10 real days at 1 tick = 1 minute
const RETENTION_READ_TICKS = 2880;      // 2 real days once acknowledged

// isEventLive(event, currentTick) -> should this notice still be shown/kept at `currentTick`?
// (docs/event-log.md §4, the SHARED predicate.) An UNREAD notice (`readTick` absent) lives
// while it is within RETENTION_UNREAD_TICKS of the tick it happened on; once READ it lives
// only while within RETENTION_READ_TICKS of the tick it was acknowledged on — so
// acknowledging a notice shortens its life, exactly the "seen it, let it go" behaviour §4
// rules. ONE predicate, read by BOTH the write-time prune below and the snapshot's read-time
// filter, so what the log keeps and what the panel shows can never disagree.
function isEventLive(event, currentTick) {
  if (event.readTick == null) {
    return currentTick - event.tick <= RETENTION_UNREAD_TICKS;
  }
  return currentTick - event.readTick <= RETENTION_READ_TICKS;
}

// --- The writer (docs/event-log.md §2) -------------------------------------------
//
// recordEvent(guild, tick, type, payload) -> MUTATES the guild, appending one notice.
//
//   - the ID is a per-guild MONOTONIC counter (`guild.eventSeq`), created lazily and never
//     reused — a stable, unique id (§15.2), NOT a tuning value. It is per-guild, so two
//     guilds' notices can share a small id; the notice is addressed by (guildId, eventId).
//   - the row is `{ id, tick, type, payload }` — NO `readTick` (every notice is born UNREAD;
//     acknowledgeEvent stamps `readTick` later). `tick` is the tick the event happened on,
//     so retention and the client's "when" both read one number.
//   - after appending, the log is PRUNED with `isEventLive` at this same `tick`, so a write
//     also sheds anything that has aged out since the last write. The just-appended notice is
//     always live at its own tick (age 0, unread), so the log is never left empty here — the
//     omit-when-empty key is only ever absent because nothing was ever written, which keeps a
//     guild that never lapses/closes byte-identical (invariant 9).
//
// `guild.events` and `guild.eventSeq` are both created LAZILY — a guild that has recorded
// nothing carries NEITHER key, so its serialized state is identical to pre-slice (the
// determinism no-op proof, the same discipline `syndicateWindows` / `productionHistory`
// follow). Mutates in place; the caller (a tick step or an action apply) already holds a
// mutable clone.
function recordEvent(guild, tick, type, payload) {
  const id = guild.eventSeq || 0;
  guild.eventSeq = id + 1;
  if (!Array.isArray(guild.events)) guild.events = [];
  guild.events.push({ id, tick, type, payload });
  guild.events = guild.events.filter((e) => isEventLive(e, tick));
}

// liveEvents(guild, currentTick) -> the guild's live notices, NEWEST FIRST — the read-model
// the snapshot surfaces and the attention derive filters. Pure: reads, mutates nothing. A
// guild with no `events` key returns []. Newest-first by descending id (the monotonic write
// order), so the panel shows the most recent notice at the top without the client sorting.
function liveEvents(guild, currentTick) {
  return (guild.events || [])
    .filter((e) => isEventLive(e, currentTick))
    .sort((a, b) => b.id - a.id);
}

module.exports = {
  LICENCE_LAPSED, VENTURE_CLOSED, EVENT_TYPES, isEventType,
  RETENTION_UNREAD_TICKS, RETENTION_READ_TICKS, isEventLive,
  recordEvent, liveEvents,
};
