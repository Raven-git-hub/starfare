'use strict';

// events.test.js — the event log / MESSAGES notices ENGINE slice (docs/event-log.md;
// design.md §5 "Message delivery"). Covers the module (sim/events.js), the acknowledge
// action, retention, the four writers' causes, the snapshot surfacing, the checkEventLog
// invariant, and the omit-when-empty determinism no-op.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LICENCE_LAPSED, VENTURE_CLOSED, EVENT_TYPES, isEventType,
  RETENTION_UNREAD_TICKS, RETENTION_READ_TICKS, isEventLive,
  recordEvent, liveEvents,
} = require('../events.js');
const { applyLapse, applyVentureClosure } = require('../licence.js');
const { createState } = require('../state.js');
const { intake, createAcknowledgeEventAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { dayOf } = require('../calendar.js');

// A minimal valid galaxy — one guild, the shared fuel/syndicate/window scaffolding
// checkInvariants needs — so a test can inject events and assert only the event log.
function baseState(guildExtra = {}) {
  return createState({
    guilds: [{ id: 'g', credits: 0, fuelHoard: 0, ...guildExtra }],
    reserve: { reserveLevel: 0, fuelPrice: 1, avgDraw: 0 },
    syndicate: { ledger: 0 },
    windowN: 4,
  });
}

// ─── the vocabulary ──────────────────────────────────────────────────────────────

test('the type vocabulary is exactly the two notice types', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), ['licence_lapsed', 'venture_closed']);
  assert.equal(LICENCE_LAPSED, 'licence_lapsed');
  assert.equal(VENTURE_CLOSED, 'venture_closed');
  assert.ok(isEventType('licence_lapsed') && isEventType('venture_closed'));
  assert.ok(!isEventType('rival_bought_in') && !isEventType(undefined));
});

// ─── recordEvent: lazy id counter, shape, omit-when-empty ─────────────────────────

test('recordEvent assigns a lazy, monotonic, per-guild id and appends {id, tick, type, payload}', () => {
  const g = { id: 'g' };
  assert.equal(g.eventSeq, undefined, 'no counter until the first write');
  assert.equal(g.events, undefined, 'no log until the first write');

  recordEvent(g, 5, VENTURE_CLOSED, { cause: 'forced' });
  assert.equal(g.eventSeq, 1, 'the counter is created at 1 after the first write');
  assert.deepEqual(g.events, [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }]);
  assert.equal(g.events[0].readTick, undefined, 'born UNREAD — no readTick');

  recordEvent(g, 6, LICENCE_LAPSED, { cause: 'rejected' });
  assert.equal(g.eventSeq, 2, 'monotonic');
  assert.equal(g.events[1].id, 1, 'the second id is 1, never reused');
});

test('recordEvent PRUNES aged-out rows at write time (the shared predicate)', () => {
  const g = { id: 'g' };
  recordEvent(g, 5, VENTURE_CLOSED, { cause: 'forced' });        // id 0, unread
  // A write far enough in the future that id 0 has aged past the UNREAD window: it is pruned.
  recordEvent(g, 5 + RETENTION_UNREAD_TICKS + 1, LICENCE_LAPSED, { cause: 'timeout' });   // id 1
  assert.equal(g.events.length, 1, 'the aged-out unread row was pruned on the later write');
  assert.equal(g.events[0].id, 1, 'only the fresh row survives');
  // eventSeq never rewinds — ids stay unique for the life of the guild (§15.2).
  assert.equal(g.eventSeq, 2);
});

// ─── isEventLive: retention (docs/event-log.md §4) ────────────────────────────────

test('retention — an UNREAD notice lives to 14400 ticks and drops after', () => {
  const e = { id: 0, tick: 1000, type: 'venture_closed', payload: {} };   // no readTick
  assert.equal(RETENTION_UNREAD_TICKS, 14400);
  assert.ok(isEventLive(e, 1000), 'live on the tick it happened');
  assert.ok(isEventLive(e, 1000 + RETENTION_UNREAD_TICKS), 'live exactly at the boundary');
  assert.ok(!isEventLive(e, 1000 + RETENTION_UNREAD_TICKS + 1), 'dropped one tick past it');
});

test('retention — a READ notice lives only 2880 ticks from the tick it was READ', () => {
  const e = { id: 0, tick: 1000, type: 'venture_closed', payload: {}, readTick: 2000 };
  assert.equal(RETENTION_READ_TICKS, 2880);
  // It is measured from readTick, NOT tick — reading a notice shortens its life.
  assert.ok(isEventLive(e, 2000 + RETENTION_READ_TICKS), 'live at the read-window boundary');
  assert.ok(!isEventLive(e, 2000 + RETENTION_READ_TICKS + 1), 'dropped one tick past it');
  // And it is already gone at a tick where the UNREAD window would still have kept it, proving
  // the read clock is the shorter one that now governs.
  assert.ok(!isEventLive(e, 1000 + RETENTION_UNREAD_TICKS), 'the read clock (2880) has expired well before the unread one (14400)');
});

// ─── liveEvents: filter + newest-first ────────────────────────────────────────────

test('liveEvents filters by retention and returns NEWEST FIRST', () => {
  const g = { id: 'g' };
  recordEvent(g, 10, VENTURE_CLOSED, { cause: 'teardown' });      // id 0
  recordEvent(g, 20, LICENCE_LAPSED, { cause: 'rejected' });      // id 1
  const live = liveEvents(g, 25);
  assert.deepEqual(live.map((e) => e.id), [1, 0], 'newest (highest id) first');
  // A read notice past its read window is filtered out even though a much later unread one shows.
  g.events[0].readTick = 20;
  assert.deepEqual(liveEvents(g, 20 + RETENTION_READ_TICKS + 1).map((e) => e.id), [1], 'the aged read row drops');
});

test('liveEvents on a guild with no log is []', () => {
  assert.deepEqual(liveEvents({ id: 'g' }, 100), []);
});

// ─── the four causes land the right type + cause ──────────────────────────────────
//
// Direct calls on the two shared writers — the same functions the actions and the tick call.

test('applyLapse writes licence_lapsed with the caller\'s cause and a self-contained payload', () => {
  for (const cause of ['rejected', 'timeout']) {
    const venture = { id: 'v', ownerGuildId: 'g', type: 'mining', resourceType: 'titanium', systemId: 'sysA', reputation: 50, licence: { committedOutputPct: 0.5, windowDays: 7, signedTick: 0 } };
    const guild = { id: 'g', guildReputation: 50, ventures: [venture] };
    applyLapse(guild, venture, cause, 42);
    const e = guild.events[0];
    assert.equal(e.type, 'licence_lapsed', `${cause}: type`);
    assert.equal(e.tick, 42, `${cause}: tick is the passed producing tick`);
    assert.equal(e.readTick, undefined, `${cause}: unread`);
    // The payload now carries the captured venture KIND beside `good` (docs/event-log.md §9).
    assert.deepEqual(e.payload, { cause, ventureId: 'v', ventureName: 'v', good: 'titanium', ventureType: 'mining', systemId: 'sysA' });
    assert.ok(!venture.licence && !('reputation' in venture), `${cause}: and the lapse effect still happened`);
  }
});

test('applyVentureClosure writes venture_closed with the caller\'s cause; lockoutUntilTick present iff written', () => {
  // 'forced', licensed with term left → the payload carries the node lockout tick.
  const licVenture = { id: 'v', ownerGuildId: 'g', type: 'mining', siteId: 's', resourceType: 'titanium', systemId: 'sysA', reputation: 10, licence: { committedOutputPct: 1, windowDays: 7, signedTick: 0, discountedFee: 3 } };
  const licGuild = { id: 'g', guildReputation: 10, ventures: [licVenture] };
  const state = { tick: 0, windowN: 4 };
  applyVentureClosure(state, licGuild, licVenture, 'forced', 9);
  const forced = licGuild.events[0];
  assert.equal(forced.type, 'venture_closed');
  assert.equal(forced.payload.cause, 'forced');
  assert.equal(forced.tick, 9, 'the passed producing tick');
  assert.equal(forced.payload.good, 'titanium');
  assert.equal(forced.payload.ventureType, 'mining', 'the captured venture kind rides the notice');
  assert.equal(forced.payload.systemId, 'sysA');
  assert.equal(forced.payload.lockoutUntilTick, 7 * 4, 'a lockout was written, so the tick rides the notice');
  assert.equal(licGuild.ventures.length, 0, 'the venture was removed');

  // 'teardown', UNLICENSED → no lockout, so no lockoutUntilTick key.
  const unlicVenture = { id: 'u', ownerGuildId: 'g', type: 'mining', resourceType: 'copper', systemId: 'sysB' };
  const unlicGuild = { id: 'g', guildReputation: 0, ventures: [unlicVenture] };
  applyVentureClosure({ tick: 0, windowN: 4 }, unlicGuild, unlicVenture, 'teardown', 3);
  const teardown = unlicGuild.events[0];
  assert.equal(teardown.payload.cause, 'teardown');
  assert.equal(teardown.payload.good, 'copper');
  assert.equal(teardown.payload.ventureType, 'mining', 'the captured venture kind rides the notice');
  assert.ok(!('lockoutUntilTick' in teardown.payload), 'no lockout written → no lockout tick in the payload');
});

// ─── acknowledgeEvent (docs/event-log.md §3) ──────────────────────────────────────

test('acknowledgeEvent stamps readTick on the named unread notice', () => {
  let s = baseState({ events: [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }], eventSeq: 1 });
  s.tick = 40;
  const { results, state } = intake(s, [createAcknowledgeEventAction({ guildId: 'g', eventId: 0 })]);
  assert.equal(results[0].accepted, true);
  assert.equal(state.guilds[0].events[0].readTick, 40, 'readTick stamped with the tick the player read it');
  assert.deepEqual(checkInvariants(state, state.tick), []);
});

test('acknowledgeEvent is a valid NO-OP on an absent id (it aged out between render and click)', () => {
  let s = baseState({ events: [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }], eventSeq: 1 });
  s.tick = 40;
  const { results, state } = intake(s, [createAcknowledgeEventAction({ guildId: 'g', eventId: 999 })]);
  assert.equal(results[0].accepted, true, 'accepted — a missing notice is not an error');
  assert.equal(state.guilds[0].events[0].readTick, undefined, 'nothing was stamped');
});

test('acknowledgeEvent is idempotent — a second ack does not reset the read clock', () => {
  let s = baseState({ events: [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }], eventSeq: 1 });
  s.tick = 40;
  ({ state: s } = intake(s, [createAcknowledgeEventAction({ guildId: 'g', eventId: 0 })]));
  assert.equal(s.guilds[0].events[0].readTick, 40);
  s.tick = 100;
  ({ state: s } = intake(s, [createAcknowledgeEventAction({ guildId: 'g', eventId: 0 })]));
  assert.equal(s.guilds[0].events[0].readTick, 40, 'still the first read tick, not re-stamped at 100');
});

test('acknowledgeEvent rejects an unknown guild but requires no eventId gate', () => {
  const s = baseState();
  assert.equal(intake(s, [createAcknowledgeEventAction({ guildId: 'nope', eventId: 0 })]).results[0].accepted, false);
  // A guild with no events at all: acknowledging anything is a clean no-op, still accepted.
  assert.equal(intake(s, [createAcknowledgeEventAction({ guildId: 'g', eventId: 0 })]).results[0].accepted, true);
});

// ─── snapshot surfacing ───────────────────────────────────────────────────────────

test('the snapshot surfaces a guild\'s LIVE events newest-first, and aggregates the UNREAD into attention.notices', () => {
  const s = baseState({
    events: [
      { id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'teardown' }, readTick: 6 },   // read, still live
      { id: 1, tick: 8, type: 'licence_lapsed', payload: { cause: 'rejected' } },                 // unread, live
    ],
    eventSeq: 2,
  });
  s.tick = 10;
  const snap = buildSnapshot(s);
  const guild = snap.guilds.find((g) => g.id === 'g');
  assert.deepEqual(guild.events.map((e) => e.id), [1, 0], 'guild.events is newest-first and live');
  // attention.notices carries ONLY the unread live notice (the read one is no longer an action-item).
  assert.equal(snap.attention.notices.length, 1);
  assert.deepEqual(snap.attention.notices[0], { guildId: 'g', id: 1, tick: 8, type: 'licence_lapsed', payload: { cause: 'rejected' } });
  // The renegotiations list is still there beside it (the join the reneg slice left room for).
  assert.ok(Array.isArray(snap.attention.renegotiations));
});

test('the snapshot drops an AGED-OUT event from the live feed', () => {
  const s = baseState({
    events: [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }],  // unread
    eventSeq: 1,
  });
  s.tick = 5 + RETENTION_UNREAD_TICKS + 1;   // one tick past the unread window
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.guilds.find((g) => g.id === 'g').events, [], 'the aged-out row is not surfaced');
  assert.equal(snap.attention.notices.length, 0, 'and it is not an action-item either');
});

// ─── snapshot surfacing: the derived calendar days (docs/event-log.md §9) ──────────
//
// The engine derives each surfaced notice's calendar day(s) ON READ (the `daysToLapse`
// precedent), because the client computes no game number (§18). `baseState` runs `windowN`
// 4 and the default anchor 0; the expected day is `dayOf` over that same cadence/anchor, the
// same fallback the snapshot reads.

// The cadence/anchor a snapshot of `s` derives days over — the exact defensive read the
// surfacing uses, so a test never hard-codes a day the engine didn't actually compute.
const dayFieldsBasis = (s) => [s.windowN == null ? 4 : s.windowN, s.dayAnchorTick == null ? 0 : s.dayAnchorTick];

test('a surfaced venture_closed WITH a lockout carries whenDay AND unlockDay, each the calendar day of its own tick', () => {
  const s = baseState({
    events: [{ id: 0, tick: 8, type: 'venture_closed', payload: { cause: 'forced', lockoutUntilTick: 20 } }],
    eventSeq: 1,
  });
  s.tick = 10;
  const [N, anchor] = dayFieldsBasis(s);
  const row = buildSnapshot(s).guilds.find((g) => g.id === 'g').events[0];
  assert.equal(row.whenDay, dayOf(8, N, anchor), 'whenDay is the calendar day of the event tick');
  assert.equal(row.unlockDay, dayOf(20, N, anchor), 'unlockDay is the calendar day the lockout releases');
  // And the two are genuinely different days here — whenDay tracks `tick`, unlockDay the lockout.
  assert.notEqual(row.whenDay, row.unlockDay);
});

test('a surfaced licence_lapsed and an unlicensed-teardown closure carry whenDay and NO unlockDay', () => {
  const s = baseState({
    events: [
      { id: 0, tick: 5, type: 'licence_lapsed', payload: { cause: 'rejected' } },               // a lapse holds no node
      { id: 1, tick: 9, type: 'venture_closed', payload: { cause: 'teardown' } },                // unlicensed teardown, no lockout
    ],
    eventSeq: 2,
  });
  s.tick = 12;
  const [N, anchor] = dayFieldsBasis(s);
  const rows = buildSnapshot(s).guilds.find((g) => g.id === 'g').events;
  const lapsed = rows.find((e) => e.id === 0);
  const teardown = rows.find((e) => e.id === 1);
  assert.equal(lapsed.whenDay, dayOf(5, N, anchor), 'the lapse carries its whenDay');
  assert.ok(!('unlockDay' in lapsed), 'a lapse holds no node → no unlockDay');
  assert.equal(teardown.whenDay, dayOf(9, N, anchor), 'the unlicensed teardown carries its whenDay');
  assert.ok(!('unlockDay' in teardown), 'an unlicensed teardown wrote no lockout → no unlockDay');
});

// ─── checkEventLog invariant ──────────────────────────────────────────────────────

const tripsOn = (guildExtra, pattern) => {
  const s = baseState(guildExtra);
  return checkInvariants(s, s.tick).some((v) => pattern.test(v.rule));
};

test('checkEventLog trips on a duplicate id, a bad type, a negative/non-integer tick, and readTick < tick', () => {
  assert.ok(tripsOn({ events: [{ id: 0, tick: 5, type: 'venture_closed', payload: {} }, { id: 0, tick: 6, type: 'licence_lapsed', payload: {} }], eventSeq: 2 }, /event-id-unique/),
    'duplicate id within a guild');
  assert.ok(tripsOn({ events: [{ id: 0, tick: 5, type: 'not_a_type', payload: {} }], eventSeq: 1 }, /event-type-in-vocabulary/),
    'unknown type');
  assert.ok(tripsOn({ events: [{ id: 0, tick: -1, type: 'venture_closed', payload: {} }], eventSeq: 1 }, /event-tick/),
    'negative tick');
  assert.ok(tripsOn({ events: [{ id: 0, tick: 10, type: 'venture_closed', payload: {}, readTick: 4 }], eventSeq: 1 }, /event-readTick/),
    'read before it happened');
  // A non-array log can't reach state through createGuild (it drops a non-array events arg), so
  // inject it directly to prove the shape guard fires.
  const corrupt = baseState();
  corrupt.guilds[0].events = { not: 'an array' };
  assert.ok(checkInvariants(corrupt, corrupt.tick).some((v) => /event-log-is-an-array/.test(v.rule)), 'a non-array log');
});

test('checkEventLog passes a well-formed log and a guild with no log at all', () => {
  const ok = baseState({ events: [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }, { id: 1, tick: 6, type: 'licence_lapsed', payload: { cause: 'timeout' }, readTick: 8 }], eventSeq: 2 });
  assert.deepEqual(checkInvariants(ok, ok.tick), []);
  const none = baseState();
  assert.deepEqual(checkInvariants(none, none.tick), []);
});

// ─── determinism: omit-when-empty ─────────────────────────────────────────────────

test('a guild that has recorded nothing carries NEITHER events NOR eventSeq (byte-identical no-op)', () => {
  const g = baseState().guilds[0];
  assert.ok(!('events' in g), 'no events key');
  assert.ok(!('eventSeq' in g), 'no eventSeq key');
});

test('createState round-trips a seeded log without aliasing into engine state', () => {
  const seededEvents = [{ id: 0, tick: 5, type: 'venture_closed', payload: { cause: 'forced' } }];
  const s = baseState({ events: seededEvents, eventSeq: 1 });
  assert.deepEqual(s.guilds[0].events, seededEvents, 'carried through');
  assert.equal(s.guilds[0].eventSeq, 1);
  // Mutating the caller's array must not reach into engine state (deep-copied on the way in).
  seededEvents[0].payload.cause = 'tampered';
  assert.equal(s.guilds[0].events[0].payload.cause, 'forced', 'no aliasing');
});
