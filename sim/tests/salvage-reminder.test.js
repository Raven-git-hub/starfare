'use strict';

// salvage-reminder.test.js — LOSING GROUND: THE SALVAGE WINDOW'S DAILY REMINDER (docs/event-log.md §16;
// sim/eviction.js remindSalvageWindows, run by sim/tick.js step 4 right after the lapse). While a lost system's salvage
// window is open and its owner still has something stranded there, the owner gets ONE `salvage_window_reminder` at every
// window boundary — the galaxy's midnight, the same `isWindowBoundary` test the licence cycle runs on. It is a notice and
// nothing more.
//
// The tripwires:
//   1. THE ORACLE, on every tick of every played run below: the reminders a tick wrote are checked against the test's
//      own reckoning from the galaxy as the tick left it — none off a boundary; on one, for each open window in systemId
//      order, its owner's still-stranded assets, if it has any.
//   2. THE MAIN LINE (the production day, 1,440 ticks; real ticks): an eviction at midnight strands one factory → a
//      reminder at each of the next two midnights, the same payload both times (the whole window, not one-shot) → the
//      deadline falls on the third midnight: the lapse's notice, and no reminder. One notice on the closing day.
//   3. A SHORT DAY (a test galaxy with a 60-tick day; real ticks): it fires every short day; a machine loaded aboard a
//      heavy is not stranded, so the list shrinks; once nothing is stranded it falls silent, though the window stands.
//   4. SEVERAL SYSTEMS, SEVERAL GUILDS on one boundary: one reminder per window, to its owner only, in systemId order
//      whatever the map's key order (the bytes match); the first comes the tick after `system_lost` (not skipped).
//   5. THE OWNER'S OWN: a rival's asset stranded in the owner's lost system (hand-built — unreachable in play) is named in
//      nobody's reminder.
//   6. A PURE ADDITION: run directly it changes only the owners' event logs; the owner sees its reminders and a rival
//      none; a galaxy that evicts nothing crosses a boundary byte-identical to `main`.
//   7. THE INVARIANTS BITE (checkSalvageReminders): each rule red on a forced row, and the harness halts on it.

// ⤳ 02-11-26 (roadmap 2.6, droid engine slice 1 — the Tier-3 reband): digests pinned below were RE-PINNED. The
// slice gave the droid's two parts their ruled sub-tier (drive_module → 3-2, droid_components → 3-2;
// docs/phase-1-tuning.md §Droids), which moves their seeded price rows (prices, price history, the quote ring, the
// snapshot's price fields and tier3Contract) in every state and view. With those two goods' keys deleted, every digest
// this file computes is the one 4bf6cbb computed, line for line (checked over all of them at the re-pin); scripted
// runs keep that proof standing in tests/rebanded-goods-delta.test.js. Read "byte-identical to main" or "the pre-slice
// engine" below as: apart from the re-banded goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { hashState } = require('../serialize.js');
const { advance } = require('../run.js');
const { tick: tickOnce } = require('../tick.js'); // one bare tick (no invariant check) — the determinism test's tool
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { getSystem, getSystemLayout, getStarterSystems } = require('../seed.js');
const { hexDistance } = require('../transport.js');
const { isWindowBoundary, DEFAULT_WINDOW_N } = require('../windows.js');
const { dayOf } = require('../calendar.js');
const { remindSalvageWindows, SALVAGE_WINDOW_TICKS_PER_ASSET } = require('../eviction.js');
const { SALVAGE_WINDOW_REMINDER, SALVAGE_WINDOW_LAPSED, SYSTEM_LOST } = require('../events.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const {
  createSetWindowNAction, createLoadKitAction, createLoadAssetAction, createSpawnVehicleAction,
  createAbandonPrefectureAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const seed = require('../../data/seed.json');

const { accept, ticks, tickUntil, heavyOf, HEAVY, HOME, HOME_HEX, RIVAL, TARGET, AT_TARGET, PLANET_A, SLOT_A1 } = P;
const { guildOf, grantMachine, abandon } = S;

// The production day: the engine's default window, 1,440 ticks (docs/cycle-and-calendar.md §1). These galaxies set no
// anchor, so midnight is every whole multiple of it.
const DAY = DEFAULT_WINDOW_N;
// A test galaxy's short day (docs/cycle-and-calendar.md: testing may set a short `windowN`). Test scaffolding, not a game
// number — 60 is the short day several suites already use, and it divides the Tier-3 week as every day must.
const SHORT_DAY = 60;

const assetsOf = (s, guildId) => guildOf(s, guildId).assets || [];
const nameOf = (systemId) => getSystem(systemId).name;
const rules = (s) => checkInvariants(s, s.tick).map((v) => v.rule);
const remindersOf = (s, guildId) => (guildOf(s, guildId).events || []).filter((e) => e.type === SALVAGE_WINDOW_REMINDER);
const load = (vehicleId, assetId) => createLoadAssetAction({ guildId: 'g1', vehicleId, assetId });

// --- the oracle ------------------------------------------------------------------------------------------------------

// remindedOn(s, tick) -> every reminder written ON `tick`, as { guildId, payload }: guilds in array order, each guild's
// in the order it wrote them (a log's ids rise with each write).
function remindedOn(s, tick) {
  return s.guilds.flatMap((g) => (g.events || [])
    .filter((e) => e.type === SALVAGE_WINDOW_REMINDER && e.tick === tick)
    .sort((a, b) => a.id - b.id)
    .map((e) => ({ guildId: g.id, payload: e.payload })));
}

// owed(s) -> the reminders the tick just built OUGHT to have written — the test's own reckoning, not the engine's code,
// made from where the tick left the galaxy. None off a boundary. On one: for each window still open, in systemId order,
// whose owner still has assets flagged stranded in that system — those ids, sorted, and the window's stored deadline.
// The tick's end is the reminder's moment: nothing after tick step 4 touches a window or a stranded flag, and a window
// that lapsed this tick is already gone from the map. Grouped by guild in array order, as remindedOn() reads them.
function owed(s) {
  const windowN = s.windowN == null ? DEFAULT_WINDOW_N : s.windowN;
  if (!isWindowBoundary(s.tick, windowN, s.dayAnchorTick || 0)) return [];
  const rows = Object.keys(s.salvageWindows || {}).sort().flatMap((systemId) => {
    const { ownerGuildId, deadlineTick } = s.salvageWindows[systemId];
    const ids = assetsOf(s, ownerGuildId).filter((a) => a.stranded && a.systemId === systemId).map((a) => a.id).sort();
    if (ids.length === 0) return [];
    return [{ guildId: ownerGuildId, payload: { systemId, systemName: nameOf(systemId), strandedAssetIds: ids, deadlineTick } }];
  });
  const order = s.guilds.map((g) => g.id);
  return rows.sort((a, b) => order.indexOf(a.guildId) - order.indexOf(b.guildId)); // stable: systemId order kept per guild
}

// play(s, n) -> { s, written }: `s` after n real ticks (run.js `advance`, so every invariant on every tick), having
// checked at EACH tick that what it reminded is exactly what was owed. `written` is every reminder on the way, with its
// tick.
function play(s, n) {
  const written = [];
  for (let i = 0; i < n; i += 1) {
    s = advance(s, []).state;
    const got = remindedOn(s, s.tick);
    assert.deepEqual(got, owed(s), `tick ${s.tick}: the reminders written are not the ones owed`);
    written.push(...got.map((r) => ({ tick: s.tick, ...r })));
  }
  return { s, written };
}

// --- the galaxies ----------------------------------------------------------------------------------------------------

// beforeMidnight() -> planted() (sweep-script.js: g1 holds HOME and TARGET, its empty heavy berthed at TARGET; g2 holds
// its own starter), run to the last tick before the first midnight. Nothing lost yet. Built once — it ticks ~990 times.
let beforeMemo = null;
function beforeMidnight() {
  if (!beforeMemo) {
    const s = S.planted();
    beforeMemo = ticks(s, DAY - 1 - s.tick);
  }
  return beforeMemo;
}

// mainLine() -> the main line, built once (4,321 real ticks, the oracle on each). At midnight (tick 1440), g1 is granted a
// factory in TARGET and abandons it: one asset stranded, so a 3-day window whose deadline is the midnight at 5760. The
// galaxy is kept at each midnight after: `first` (2880), `second` (4320) and `closing` (5760, the deadline).
let mainMemo = null;
function mainLine() {
  if (mainMemo) return mainMemo;
  let s = play(beforeMidnight(), 1).s;
  const quiet = s;
  let factory;
  ({ s, id: factory } = grantMachine(s, 'g1', 'factory', TARGET));
  const evicted = accept(s, abandon());
  const first = play(evicted, DAY);
  const second = play(first.s, DAY);
  const closing = play(second.s, DAY);
  mainMemo = {
    quiet, evicted, factory, first: first.s, second: second.s, closing: closing.s,
    written: [...first.written, ...second.written, ...closing.written],
  };
  return mainMemo;
}

// shortDayPlanted() -> planted(), but in a galaxy whose day is SHORT_DAY ticks. The day is set first, at tick 0
// (`setWindowN` is setup-only), then the same steps prefecture-fixtures.js / sweep-script.js take: a Prefecture kit
// granted at HOME and loaded onto the heavy, ferried to TARGET, PLANET_A surveyed, the kit planted on SLOT_A1.
function shortDayPlanted() {
  let s = accept(P.kitGalaxy({ fuelHoard: 5_000 }), createSetWindowNAction({ windowN: SHORT_DAY }));
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', HOME.id));
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: kitId }));
  s = accept(s, P.unloadRoute(AT_TARGET));
  s = tickUntil(s, (x) => heavyOf(x).status === 'idle');
  const kit = assetsOf(s, 'g1').find((a) => a.kind === 'prefecture' && a.systemId === TARGET).id;
  s = P.survey(s, 'g1', PLANET_A);
  return accept(s, P.plant('g1', kit, SLOT_A1));
}

// Two more systems to lose, picked from the seed the way prefecture-fixtures.js picks TARGET — not HOME, RIVAL or TARGET,
// not a starter, with a settleable planet — the two nearest HOME, so a regen carries the test.
const STARTERS = new Set(getStarterSystems().map((x) => x.id));
const [SECOND, THIRD] = seed.systems
  .filter((sys) => ![HOME.id, RIVAL, TARGET].includes(sys.id) && !STARTERS.has(sys.id))
  .filter((sys) => getSystemLayout(sys.id).planets.some((p) => p.settlementSlots.length))
  .map((sys) => ({ id: sys.id, d: hexDistance(HOME_HEX, sys.coords) }))
  .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
  .slice(0, 2)
  .map((x) => x.id);

// lose(s, guildId, systemId) -> `s` after `guildId` claims `systemId` (a Prefecture kit granted there by the operator
// lever, the first settleable planet surveyed, the kit planted on its first slot), is granted a miner there, and abandons
// it: the miner is stranded, and the system has a window. TARGET is planted already (planted()), so it is only abandoned.
function lose(s, guildId, systemId) {
  if (systemId !== TARGET) {
    const planet = getSystemLayout(systemId).planets.find((p) => p.settlementSlots.length);
    let kitId;
    ({ s, kitId } = P.grantPrefectureKit(s, guildId, systemId));
    s = P.survey(s, guildId, planet.id);
    s = accept(s, P.plant(guildId, kitId, planet.settlementSlots[0].id));
  }
  ({ s } = grantMachine(s, guildId, 'miner', systemId));
  const prefecture = s.prefectures.find((p) => p.systemId === systemId);
  return accept(s, createAbandonPrefectureAction({ guildId, prefectureId: prefecture.id }));
}

// THE LOSSES: g1 loses TARGET and SECOND, g2 loses THIRD. They are lost in DESCENDING systemId order, one tick before
// midnight, so the window map's key order (insertion order) is the reverse of the order the reminders must take.
const LOSSES = { [TARGET]: 'g1', [SECOND]: 'g1', [THIRD]: 'g2' };
let severalMemo = null;
function severalLost() {
  if (!severalMemo) {
    let s = beforeMidnight();
    for (const systemId of Object.keys(LOSSES).sort().reverse()) s = lose(s, LOSSES[systemId], systemId);
    severalMemo = s;
  }
  return severalMemo;
}

// --- 2. the main line ------------------------------------------------------------------------------------------------

test('THE MAIN LINE: an eviction at midnight opens a window whose deadline is a later midnight — the reminder fires on each midnight between, with the same payload, and never on any other tick', () => {
  const { quiet, evicted, factory, first, second, written } = mainLine();
  assert.equal(quiet.tick, DAY, 'the first midnight passes with nothing lost: no reminder');
  assert.equal(remindedOn(quiet, DAY).length, 0);
  assert.equal(evicted.tick, DAY, 'the abandon lands on the midnight tick, after that tick\'s reminders ran');
  const deadlineTick = DAY + SALVAGE_WINDOW_TICKS_PER_ASSET;
  assert.deepEqual(evicted.salvageWindows, { [TARGET]: { ownerGuildId: 'g1', evictedAtTick: DAY, deadlineTick } });
  assert.equal(deadlineTick, 4 * DAY, 'one asset is 3 whole days, so this deadline is itself a midnight');

  const payload = { systemId: TARGET, systemName: nameOf(TARGET), strandedAssetIds: [factory], deadlineTick };
  assert.deepEqual(written.filter((r) => r.tick < deadlineTick), [
    { tick: 2 * DAY, guildId: 'g1', payload },
    { tick: 3 * DAY, guildId: 'g1', payload },
  ], 'one on each midnight before the deadline — the same system, the same stranded factory, the same stored deadline');

  // The notice row itself: born unread, at the boundary tick, the guild's next id.
  const [row] = remindersOf(first, 'g1');
  assert.deepEqual(row, { id: guildOf(first, 'g1').eventSeq - 1, tick: 2 * DAY, type: SALVAGE_WINDOW_REMINDER, payload });
  // A notice, nothing more: the window record and the stranded factory are untouched by it.
  assert.deepEqual(first.salvageWindows, evicted.salvageWindows);
  assert.deepEqual(second.salvageWindows, evicted.salvageWindows);
  assert.deepEqual(assetsOf(second, 'g1').find((a) => a.id === factory), assetsOf(evicted, 'g1').find((a) => a.id === factory));
});

test('THE LAPSE COINCIDES WITH MIDNIGHT: the lapse runs first and closes the window, so the closing day carries the lapse\'s notice and no reminder — one notice, not two', () => {
  const { factory, second, closing, written } = mainLine();
  assert.equal(closing.tick, 4 * DAY);
  assert.ok(isWindowBoundary(closing.tick, DAY, 0), 'the deadline tick is a boundary');
  assert.equal(second.salvageWindows[TARGET].deadlineTick, closing.tick);
  assert.equal(written.filter((r) => r.tick === closing.tick).length, 0, 'no reminder on the closing midnight');
  const onTheDay = (guildOf(closing, 'g1').events || []).filter((e) => e.tick === closing.tick);
  assert.deepEqual(onTheDay.map((e) => e.type), [SALVAGE_WINDOW_LAPSED], 'the lapse\'s notice alone');
  assert.deepEqual(onTheDay[0].payload.destroyedAssetIds, [factory]);
  assert.equal('salvageWindows' in closing, false, 'the window is closed');
  // And nothing is left to remind: the next midnight is quiet.
  const after = play(closing, DAY);
  assert.deepEqual(after.written, []);
});

// --- 3. a short day --------------------------------------------------------------------------------------------------

test('A SHORT DAY: under a 60-tick day it fires every short day (whole-time); a machine loaded aboard a heavy is not stranded, so the list shrinks; with nothing stranded it falls silent while the window stands', () => {
  let s = shortDayPlanted();
  assert.equal(s.windowN, SHORT_DAY);
  let miner; let factory;
  ({ s, id: miner } = grantMachine(s, 'g1', 'miner', TARGET));
  ({ s, id: factory } = grantMachine(s, 'g1', 'factory', TARGET));
  s = accept(s, abandon());
  const evictedAt = s.tick;
  const { deadlineTick } = s.salvageWindows[TARGET];
  const payload = (ids) => ({ systemId: TARGET, systemName: nameOf(TARGET), strandedAssetIds: ids, deadlineTick });
  // The next short-day boundary after the eviction (the eviction tick's own boundary, if it is one, has already run).
  const midnight = Math.floor(evictedAt / SHORT_DAY) * SHORT_DAY + SHORT_DAY;

  // Both stranded: one reminder each short day. The miner was granted first, but the ids go out sorted.
  let run = play(s, midnight - evictedAt);
  const both = [factory, miner].sort();
  assert.notDeepEqual([miner, factory], both, 'stored order is not sorted order, so the sort is exercised');
  assert.deepEqual(run.written, [{ tick: midnight, guildId: 'g1', payload: payload(both) }]);
  run = play(run.s, SHORT_DAY);
  assert.deepEqual(run.written, [{ tick: midnight + SHORT_DAY, guildId: 'g1', payload: payload(both) }], 'and again the next short day');

  // The miner is salvaged — aboard the heavy, still carrying TARGET as its systemId — so it is no longer reminded.
  s = accept(run.s, load(HEAVY, miner));
  assert.equal(assetsOf(s, 'g1').find((a) => a.id === miner).systemId, TARGET, 'aboard, it keeps the system it was loaded in');
  run = play(s, SHORT_DAY);
  assert.deepEqual(run.written, [{ tick: midnight + 2 * SHORT_DAY, guildId: 'g1', payload: payload([factory]) }]);

  // The factory too, onto a second heavy: nothing of g1's is stranded. The window stands until its deadline, silent.
  s = accept(run.s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_TARGET }));
  s = accept(s, load(guildOf(s, 'g1').vehicles.slice(-1)[0].id, factory));
  run = play(s, 3 * SHORT_DAY);
  assert.deepEqual(run.written, [], 'all salvaged: no reminder');
  assert.deepEqual(run.s.salvageWindows[TARGET].deadlineTick, deadlineTick, 'though the window still stands');
});

// --- 4. several systems, several guilds ------------------------------------------------------------------------------

test('SEVERAL SYSTEMS, SEVERAL GUILDS on one midnight: one reminder per window, to its owner only, in systemId order — and the first comes the tick after system_lost (not skipped)', () => {
  const lost = severalLost();
  assert.equal(lost.tick, DAY - 1);
  assert.notDeepEqual(Object.keys(lost.salvageWindows), Object.keys(lost.salvageWindows).sort(),
    'the map\'s key order is not systemId order, so the order is exercised');
  for (const [systemId, guildId] of Object.entries(LOSSES)) {
    assert.equal(lost.salvageWindows[systemId].ownerGuildId, guildId);
  }

  const { s, written } = play(lost, 1); // the oracle checks the order and each payload
  assert.equal(s.tick, DAY);
  const g1Systems = Object.keys(LOSSES).filter((id) => LOSSES[id] === 'g1').sort();
  assert.deepEqual(written.map((r) => [r.guildId, r.payload.systemId]), [...g1Systems.map((id) => ['g1', id]), ['g2', THIRD]]);
  // Each owner's notices name only its own system's machines, and its own.
  for (const r of written) {
    for (const id of r.payload.strandedAssetIds) assert.ok(id.startsWith(`asset_${r.guildId}_`), `${id} is ${r.guildId}'s`);
  }
  // g1's two take consecutive ids in systemId order.
  const g1Rows = remindersOf(s, 'g1');
  assert.deepEqual(g1Rows.map((e) => e.payload.systemId), g1Systems);
  assert.equal(g1Rows[1].id, g1Rows[0].id + 1);
  // The same-day overlap, my call: not skipped. Each system_lost is on the tick before, the reminder on midnight.
  for (const guildId of ['g1', 'g2']) {
    const lostTicks = (guildOf(s, guildId).events || []).filter((e) => e.type === SYSTEM_LOST).map((e) => e.tick);
    assert.ok(lostTicks.length > 0 && lostTicks.every((t) => t === DAY - 1), `${guildId}'s system_lost on tick ${DAY - 1}`);
    assert.ok(remindersOf(s, guildId).every((e) => e.tick === DAY), `${guildId}'s reminders on tick ${DAY}`);
  }
});

test('DETERMINISM: the same galaxy with its window map\'s keys in either order reminds in the same order — byte-identical, twice over', () => {
  const lost = severalLost();
  const sorted = structuredClone(lost);
  sorted.salvageWindows = Object.fromEntries(Object.keys(lost.salvageWindows).sort().map((k) => [k, lost.salvageWindows[k]]));
  assert.deepEqual(Object.keys(sorted.salvageWindows), Object.keys(lost.salvageWindows).sort());
  const a = tickOnce(lost);
  const b = tickOnce(sorted);
  assert.equal(hashState(a), hashState(b), 'byte-identical');
  assert.equal(hashState(tickOnce(lost)), hashState(a), 'and the same on a second run');
  assert.equal(remindedOn(a, DAY).length, 3);
});

// --- 5. the owner's own ----------------------------------------------------------------------------------------------

test('THE OWNER\'S OWN: a rival\'s asset stranded in the owner\'s lost system (hand-built — in play every claim sweeps or recovers what lies there) is named in nobody\'s reminder', () => {
  // g2 is granted a miner in TARGET (g1's lost system, fallow) and it is flagged stranded by hand: invariant-clean, since
  // TARGET has a window and nobody holds it.
  let { s, id: rivalMiner } = grantMachine(severalLost(), 'g2', 'miner', TARGET);
  s = structuredClone(s);
  assetsOf(s, 'g2').find((a) => a.id === rivalMiner).stranded = { tick: s.tick };
  assert.deepEqual(rules(s), [], 'the hand-built galaxy breaks no rule');

  const { s: after, written } = play(s, 1);
  const target = written.find((r) => r.payload.systemId === TARGET);
  assert.equal(target.guildId, 'g1', 'TARGET\'s window is g1\'s');
  assert.ok(!target.payload.strandedAssetIds.includes(rivalMiner), 'g2\'s machine is not in g1\'s notice');
  assert.ok(target.payload.strandedAssetIds.length > 0 && target.payload.strandedAssetIds.every((id) => id.startsWith('asset_g1_')));
  assert.deepEqual(remindersOf(after, 'g2').map((e) => e.payload.systemId), [THIRD], 'and g2 is reminded only of its own window');
});

// --- 6. a pure addition ----------------------------------------------------------------------------------------------

test('A PURE ADDITION: run directly, the sweep changes only the owners\' event logs — no asset, no window record, nothing priced; with no window it changes nothing at all', () => {
  const lost = severalLost();
  const strip = (x) => {
    const c = structuredClone(x);
    for (const g of c.guilds) { delete g.events; delete g.eventSeq; }
    return c;
  };
  const c = structuredClone(lost);
  remindSalvageWindows(c, DAY);
  assert.deepEqual(strip(c), strip(lost), 'everything but the logs is exactly as it was');
  assert.equal(remindedOn(c, DAY).length, 3, 'and the logs gained the three reminders');

  const quiet = beforeMidnight();
  const q = structuredClone(quiet);
  remindSalvageWindows(q, DAY);
  assert.deepEqual(q, quiet, 'a galaxy with no window: untouched');
});

test('THE VIEW: the owner sees its reminders (with their calendar day, and counted unread); a rival\'s view carries none of them', () => {
  const { first } = mainLine();
  const own = buildSnapshot(first, 'g1');
  const row = own.guilds.find((g) => g.id === 'g1').events.find((e) => e.type === SALVAGE_WINDOW_REMINDER);
  assert.equal(row.tick, 2 * DAY);
  assert.equal(row.whenDay, dayOf(2 * DAY, DAY, 0));
  assert.ok(own.attention.notices.some((n) => n.type === SALVAGE_WINDOW_REMINDER), 'an unread notice');
  assert.equal(JSON.stringify(buildSnapshot(first, 'g2')).includes(SALVAGE_WINDOW_REMINDER), false, 'nowhere in g2\'s view');
});

// Pinned from `main` at 479894f (before this slice), by the very build below: planted() run across the first midnight. A
// galaxy that evicts nothing crosses a boundary without a byte of difference — state and every view.
const GOLDEN_NEVER_EVICTS = {
  tick: 1440,
  state: 'f27a685806a8fe349c58c8441f15ad6f56b2746d00fb0edcbc6958619b42cd9e',
  god: 'f61b673cfb6a1c8b991ebc0e4d76d95b817379ea64d2e418208be0653e6a844c',
  g1: '0e484bb98c4b30181a6cb79f4361a96ee7f19538d3a3279646b97d6669619920',
  g2: 'c504f39037e324232edb2118c80720dccc54332e3903255cfc3e0bfbfbd686a8',
};

test('BYTE-IDENTITY: a galaxy that evicts nothing crosses midnight with no reminder, hashing exactly as it did on main', () => {
  const s = ticks(beforeMidnight(), 1);
  assert.equal(remindedOn(s, DAY).length, 0);
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.deepEqual({
    tick: s.tick, state: hashState(s), god: sha(buildSnapshot(s)), g1: sha(buildSnapshot(s, 'g1')), g2: sha(buildSnapshot(s, 'g2')),
  }, GOLDEN_NEVER_EVICTS);
});

// --- 7. the invariants bite ------------------------------------------------------------------------------------------

test('THE INVARIANTS BITE: each checkSalvageReminders rule is red on its forced row, and the harness halts on it', () => {
  const { first } = mainLine();
  assert.deepEqual(rules(first), [], 'the real reminder is clean');
  const forced = (mutate) => {
    const c = structuredClone(first);
    mutate(remindersOf(c, 'g1')[0], c);
    return rules(c);
  };

  // Written off a boundary — a broken gate.
  assert.deepEqual(forced((e) => { e.tick -= 1; }), ['salvage-reminder-on-a-window-boundary (docs/event-log.md §16)']);
  // At its deadline — the reminder ran before the lapse, and the owner was told twice on its closing day.
  assert.deepEqual(forced((e) => { e.payload.deadlineTick = e.tick; }), ['salvage-reminder-before-its-deadline (docs/event-log.md §16)']);
  // About nothing; out of order; twice over; a rival's machine named in the owner's log.
  const names = 'salvage-reminder-names-the-owners-stranded-assets (docs/event-log.md §16)';
  const [id] = remindersOf(first, 'g1')[0].payload.strandedAssetIds;
  for (const [label, ids] of [
    ['empty', []],
    ['unsorted', ['asset_g1_miner_99', id]],
    ['a duplicate', [id, id]],
    ['a rival\'s id', [id, 'asset_g2_miner_01']],
    ['not an asset id', [id, 'nonsense']],
  ]) assert.deepEqual(forced((e) => { e.payload.strandedAssetIds = ids; }), [names], label);
  // The payload's shape, each defect alone.
  const shape = 'salvage-reminder-well-formed (sim/eviction.js)';
  for (const [label, mutate] of [
    ['an extra key', (e) => { e.payload.ticksLeft = 1; }],
    ['a missing key', (e) => { delete e.payload.systemName; }],
    ['no such system', (e) => { e.payload.systemId = 'sys_nope'; }],
    ['an empty name', (e) => { e.payload.systemName = ''; }],
    ['a fractional deadline', (e) => { e.payload.deadlineTick += 0.5; }],
    ['ids not a list', (e) => { e.payload.strandedAssetIds = id; }],
    ['no payload', (e) => { e.payload = null; }],
  ]) assert.deepEqual(forced(mutate), [shape], label);

  // And the running loop halts on one, naming the tick.
  const broken = structuredClone(first);
  remindersOf(broken, 'g1')[0].tick -= 1;
  assert.throws(() => ticks(broken, 1), /Invariant violation at tick \d+[\s\S]*salvage-reminder-on-a-window-boundary/);
});
