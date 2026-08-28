'use strict';

// utc-offset.test.js — the per-galaxy UTC offset (docs/cycle-and-calendar.md §2).
//
// "Server midnight" used to mean whatever midnight the CONTAINER's timezone happened to
// be set to, and it only agreed with the displays because the box happens to run UTC.
// The zone is now an explicit per-galaxy choice, `utcOffsetMinutes`, made once at
// creation and frozen with the galaxy.
//
// The load-bearing test is the FIRST one: at the default offset, on a UTC host, nothing
// about the engine moved — same key set, same bytes, same anchor. Everything else here
// is only safe because that holds (invariant 9).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { saveState, loadOrInit } = require('../persist.js');
const { DEFAULT_WINDOW_N } = require('../windows.js');
const {
  minuteOf, dayOf, anchorForCreation, minuteOfDayFromDate, localMinuteOfDay,
  isUtcOffsetMinutes, MINUTES_PER_DAY, UTC_OFFSET_MIN_MINUTES, UTC_OFFSET_MAX_MINUTES,
} = require('../calendar.js');

const N = DEFAULT_WINDOW_N; // 1440
const SYS = 'sysA';

const mine = (commitment = 0, extra = {}) => ({
  id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: SYS,
  resourceType: 'titanium', productionRate: 10, syndicateCommitment: commitment, ...extra,
});

function galaxy({ ventures = [mine()], ...extra } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    ...extra,
  });
}

// --- 1. THE NO-OP PROOF ------------------------------------------------------------

test('NO-OP: an unset offset writes no field — the goldens cannot move', () => {
  // omit-when-absent, exactly like dayAnchorTick. If this key ever appears unbidden,
  // every committed golden hash moves and the determinism proof goes with it.
  const s = galaxy();
  assert.equal('utcOffsetMinutes' in s, false, 'no offset set -> no key in state');
  assert.equal(s.utcOffsetMinutes, undefined);
});

test('NO-OP: createZeroState omits the offset at 0 — 0 IS UTC, there is nothing to record', () => {
  const bare = createZeroState();
  const utc = createZeroState({ utcOffsetMinutes: 0 });
  assert.equal('utcOffsetMinutes' in bare, false);
  assert.equal('utcOffsetMinutes' in utc, false, 'an explicit 0 is the same as none');
  assert.equal(hashState(bare), hashState(utc), 'and the bytes are identical');
  const shifted = createZeroState({ utcOffsetMinutes: 480 });
  assert.equal(shifted.utcOffsetMinutes, 480, 'a real offset IS recorded');
});

test('NO-OP: the offset is inert on the tick path — an offset galaxy runs identically', () => {
  // The offset is a DISPLAY and creation-time field. It must never reach the economy:
  // the same galaxy with and without it produces the same run, byte for byte, once the
  // field itself is set aside.
  let bare = galaxy({ windowN: 6, ventures: [mine(12)] });
  let shifted = galaxy({ windowN: 6, ventures: [mine(12)], utcOffsetMinutes: 480 });
  for (let i = 0; i < 20; i += 1) { bare = tick(bare); shifted = tick(shifted); }
  const { utcOffsetMinutes, ...shiftedRest } = shifted;
  assert.equal(utcOffsetMinutes, 480, 'the field rode through the run untouched');
  assert.equal(hashState(shiftedRest), hashState(bare), 'and changed nothing else');
});

// --- 2. the clock read is UTC, not the container's timezone -------------------------

test('minuteOfDayFromDate reads UTC — the container’s timezone no longer decides', () => {
  const at1430Z = new Date('2026-08-28T14:30:00Z');
  const saved = process.env.TZ;
  try {
    // The same instant, read on three differently-configured hosts. Before this slice
    // the answer was the LOCAL hour and these three disagreed by up to a day.
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.equal(minuteOfDayFromDate(at1430Z), (14 * 60) + 30, `TZ=${zone}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.equal(minuteOfDayFromDate(new Date('2026-08-28T00:00:00Z')), 0);
  assert.equal(minuteOfDayFromDate(new Date('2026-08-28T23:59:00Z')), MINUTES_PER_DAY - 1);
});

test('localMinuteOfDay shifts by the offset and wraps at both ends of the day', () => {
  assert.equal(localMinuteOfDay(870, 0), 870, 'offset 0 is the identity — the no-op');
  assert.equal(localMinuteOfDay(870, 480), 870 + 480, '14:30Z is 22:30 at UTC+8');
  // Wrapping FORWARD over midnight: 20:30Z at UTC+8 is 04:30 the next local day.
  assert.equal(localMinuteOfDay(1230, 480), 270);
  // …and BACKWARD: 02:00Z at UTC-5 is 21:00 the previous local day.
  assert.equal(localMinuteOfDay(120, -300), 1260);
  // The extremes are still inside one day.
  assert.equal(localMinuteOfDay(0, UTC_OFFSET_MAX_MINUTES), 840);
  assert.equal(localMinuteOfDay(0, UTC_OFFSET_MIN_MINUTES), 720);
});

test('isUtcOffsetMinutes accepts whole minutes in UTC-12:00 .. UTC+14:00 and nothing else', () => {
  for (const ok of [0, 480, 330, 345, -300, UTC_OFFSET_MIN_MINUTES, UTC_OFFSET_MAX_MINUTES]) {
    assert.equal(isUtcOffsetMinutes(ok), true, `${ok} is a legal offset`);
  }
  for (const bad of [841, -721, 8.5, NaN, Infinity, '480', null, undefined, {}]) {
    assert.equal(isUtcOffsetMinutes(bad), false, `${JSON.stringify(bad)} is not`);
  }
});

// --- 3. the anchor, computed over UTC + offset (§2) ---------------------------------

// The creation seam's arithmetic, exactly as sim/server.js does it — the one wall-clock
// read, then pure functions. Kept here so the property can be proven at a KNOWN instant,
// which a live server (whose clock the test cannot set) never allows.
function anchorAtInstant(iso, utcOffsetMinutes) {
  return anchorForCreation(localMinuteOfDay(minuteOfDayFromDate(new Date(iso)), utcOffsetMinutes), N);
}

test('a UTC+8 galaxy rolls its day at UTC+8 midnight — the whole point of the slice', () => {
  // Created 2026-08-28 20:30Z. At UTC+8 that is 04:30 on the 29th: 270 minutes into the
  // local day, so the anchor is -270 and the first boundary is 1,170 ticks away.
  const created = '2026-08-28T20:30:00Z';
  const anchor = anchorAtInstant(created, 480);
  assert.equal(anchor, -270, 'the anchor is the LOCAL minute-of-day, negated');

  // calendar.minute tracks LOCAL minute-of-day, so the clock a UTC+8 operator reads and
  // the engine's own day agree.
  assert.equal(dayOf(1, N, anchor), 0, 'the creation tick is on day 0');
  assert.equal(minuteOf(1, N, anchor), 270, 'tick 1 reads 04:30 local');
  assert.equal(minuteOf(1 + 60, N, anchor), 330, 'an hour later, 05:30 local');

  const firstBoundary = N + anchor; // 1170
  assert.equal(firstBoundary, 1170);
  assert.equal(((firstBoundary - anchor) % N + N) % N, 0, 'it is a real boundary');
  assert.equal(minuteOf(firstBoundary, N, anchor), N - 1, 'and the last minute of day 0');

  // The claim in WALL-CLOCK terms: the boundary tick is 1,170 minutes after creation,
  // and that instant is midnight at UTC+8.
  const boundaryAt = new Date(Date.parse(created) + (firstBoundary - 1) * 60 * 1000);
  assert.equal(localMinuteOfDay(minuteOfDayFromDate(boundaryAt), 480), N - 1,
    'the boundary tick IS the last minute of the local day');
  const nextLocalDay = new Date(boundaryAt.getTime() + 60 * 1000);
  assert.equal(localMinuteOfDay(minuteOfDayFromDate(nextLocalDay), 480), 0,
    'and the tick after it is local midnight');
});

test('the same instant at offset 0 anchors exactly as it always did', () => {
  // The getHours -> getUTCHours change is a no-op on a UTC host, which is what the test
  // env and the deployed container both are: the old local read and the new UTC read
  // return the same minute, so an offset-0 galaxy anchors to the same tick as before.
  const created = '2026-08-28T20:30:00Z';
  assert.equal(anchorAtInstant(created, 0), -((20 * 60) + 30));
  assert.equal(anchorAtInstant(created, 0), anchorForCreation(1230, N));
  // Created exactly at local midnight -> anchor 0, the unanchored default, at ANY offset.
  assert.equal(anchorAtInstant('2026-08-28T00:00:00Z', 0), 0);
  assert.equal(anchorAtInstant('2026-08-28T16:00:00Z', 480), 0, 'midnight at UTC+8');
  assert.equal(anchorAtInstant('2026-08-28T18:30:00Z', 330), 0, 'midnight at UTC+5:30');
});

// --- 4. frozen and persisted (§3, no re-anchor) ------------------------------------

test('the offset survives a save/load round-trip, and a reload recomputes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-utcoffset-'));
  try {
    const anchor = anchorAtInstant('2026-08-28T20:30:00Z', 480);
    let s = galaxy({ dayAnchorTick: anchor, utcOffsetMinutes: 480 });
    for (let i = 0; i < 5; i += 1) s = tick(s);
    saveState(s, dir);

    const first = loadOrInit(dir, () => { throw new Error('should not re-init'); });
    const second = loadOrInit(dir, () => { throw new Error('should not re-init'); });
    assert.equal(first.utcOffsetMinutes, 480, 'the offset came back off disk');
    assert.equal(first.dayAnchorTick, anchor, 'beside the anchor it explains');
    assert.equal(hashState(first), hashState(s), 'the whole state round-tripped');
    assert.equal(hashState(second), hashState(first), 'a second load re-derives nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. the snapshot readout -------------------------------------------------------

test('the snapshot calendar carries the offset — 0 when there is none', () => {
  let s = galaxy({ dayAnchorTick: -270, utcOffsetMinutes: 480 });
  s = tick(s);
  assert.deepEqual(buildSnapshot(s).calendar, {
    day: 0, minute: 270, label: '0000:0270', windowN: N, dayAnchorTick: -270,
    utcOffsetMinutes: 480,
  });
  let plain = galaxy();
  plain = tick(plain);
  assert.equal(buildSnapshot(plain).calendar.utcOffsetMinutes, 0,
    'a galaxy with no offset reads as UTC, not as absent');
  assert.equal(buildSnapshot(plain).schemaVersion, 7, 'additive — no schema bump');
});

// --- 6. the displays honour it (served-page tripwires) ------------------------------
//
// The client is not unit-testable here (no DOM), so these pin the WIRING in the served
// source: that both pages shift the server's UTC instant by the galaxy's offset instead
// of falling back to the viewer's own timezone, and that the Create form carries the
// input at all. A page that silently reverts to local time would otherwise show a clock
// that disagrees with the boundary the engine judges on — the exact bug this slice fixes.

const clientFile = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'client', name), 'utf8');

test('the player HUD renders the server clock at the GALAXY’s offset', () => {
  const html = clientFile('game.html');
  assert.match(html, /function fmtServerTime\(iso, offsetMinutes\)/);
  assert.match(html, /fmtServerTime\(health\.serverTime, health\.utcOffsetMinutes\)/);
  assert.match(html, /t\.getUTCHours\(\)/, 'the instant is read in UTC, then shifted');
  assert.ok(!html.includes('p2(t.getHours()) + \':\' + p2(t.getMinutes())'),
    'the HUD must not fall back to the VIEWER’s local timezone');
  assert.match(html, /function fmtUtcOffset/, 'and the offset is labelled, not implied');
});

test('the operator CLI posts the offset it was given', () => {
  // Same tripwire discipline as the two pages: the conversion and the flag parsing are
  // unit-tested in tools/admin.test.js; this pins that `new-galaxy` actually puts the
  // result on the wire, which is the seam between them.
  const cli = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'admin.js'), 'utf8');
  assert.match(cli, /'utc-offset': 'number'/, 'the flag is declared, in HOURS');
  assert.match(cli, /body\.utcOffsetMinutes = utcOffsetMinutesFromHours\(flags\['utc-offset'\]\)/);
  assert.match(cli, /--utc-offset H/, 'and the usage text says so');
});

test('the /inspect panel offers the offset on Create and tells the same time as the HUD', () => {
  const html = clientFile('inspect.html');
  assert.match(html, /id="adm-utc-offset"/, 'the Create form carries a UTC-offset input');
  assert.match(html, /body\.utcOffsetMinutes = offsetMinutes/, 'and posts it as minutes');
  assert.match(html, /function utcOffsetMinutesFromHours/, 'hours in, minutes on the wire');
  assert.match(html, /fmtClock\(health\.serverTime, health\.utcOffsetMinutes\)/);
  assert.ok(!html.includes('toLocaleTimeString'),
    'the dev console must not render the server clock in the VIEWER’s locale');
});
