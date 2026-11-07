'use strict';

// salvage-notice-client.test.js — losing ground: the salvage window, client — the words for its two notices (roadmap
// 2.5; docs/event-log.md §16). The engine already writes `salvage_window_reminder` (#207: once a day while a lost
// system's window is open and something of the owner's is still stranded there) and `salvage_window_lapsed` (#204: the
// window ran out, and whatever was left was destroyed). The client had no words for either, so both fell through to
// "Licence lapsed — Venture". Now the Chief Pilot reports them — her crews fly the salvage — on the pilot's card, in the
// human's words, with Show on map to the system. Client only.
//
// As the other *-notice-client tests do, this cuts the page's OWN notice code out of game.html, with the two helpers from
// other scripts it now calls (the map's fmtETA and the plural countWords, which the page shares as window.__fmtETA and
// window.__countWords), and runs it in a node:vm sandbox on a stub DOM, against REAL engine output — each guild's view
// exactly as GET /snapshot?guild= sends it:
//   - ONE: g1 abandons TARGET with one idle miner there (tick 450): one machine stranded, a 3-day window, deadline 4770.
//     Run to the deadline: a reminder at each midnight between (1440, 2880, 4320), then the lapse destroying the miner.
//   - THREE: salvage-script.js's `stranded` — g1 abandoned TARGET with a miner, a factory and an Outpost kit there (tick
//     450): three stranded, a 9-day window, deadline 13410. Run to the first midnight (a reminder naming three) and on
//     to the deadline (the lapse destroying three).
// The live popup in the browser is the human's Playwright pass, outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem } = require('../seed.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const X = require('./salvage-script.js');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// ---- the Chief Pilot's words, verbatim (the human's) ---------------------------------------------------------------

// The reminder: the count, the time left as of the reminder's own tick, and the pronouns that follow the count.
const reminderWords = (system, machines, time, their, them) =>
  `Still got ${machines} cooling ${their} heels out at ${system}, Guildmaster. We still have another ${time} to get ${them}, but I wouldn't dawdle. Space is pretty big, as I'm sure you're aware, so it's going to take some time to get the crews together and the transports moving. Just say the word and I'll get some heavies out there to haul ${them} home before the clock runs dry.`;
// The lapse: the count alone, no time.
const lapseWords = (system, machines) =>
  `That's the salvage window shut on ${system}, Guildmaster. Unfortunately the guys just couldn't get it done — we lost ${machines}. It is what it is I guess. We're haulers, not miracle workers.`;

// ---- the page's own code, cut out of game.html ----------------------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
assert.ok(guildScript.length < html.length, 'the Guild Hall script is found');
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
const guildHelpersSrc = cut(guildScript, /\n  function el\(id\)\{[\s\S]*?(?=\n  function pad4\()/, 'the Guild Hall helpers (el … esc)');
const prettyGoodSrc = cut(guildScript, /\n  function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood');
const noticeSrc = cut(guildScript, /\n  \/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n  function centreFor\()/, 'the notice code (Notices … centreFor)');
// The map's ETA formatter (the one with a space before its brace; Operations keeps its own copy) and the plural helper.
const fmtEtaSrc = cut(html, /\n  function fmtETA\(ticks\) \{\n[\s\S]*?\n  \}\n/, 'the map\'s fmtETA');
const countWordsSrc = cut(html, /\nfunction countWords\(n, one, many\)\{[^\n]*\n/, 'countWords');
// They live in other scripts, so the sandbox keeps them in their own scope too and hands them over only as the page
// does, through the two bridges: notice code that called fmtETA or countWords by name would fail here as in the browser.
const bridgesSrc = `(function(){\n${fmtEtaSrc}${countWordsSrc}window.__fmtETA = fmtETA;\nwindow.__countWords = countWords;\n})();\n`;

// ---- real engine output ----------------------------------------------------------------------------------------------

const { TARGET, HOME } = P;
const TARGET_NAME = getSystem(TARGET).name;
const TARGET_HEX = getSystem(TARGET).coords;

const eventsOf = (s, type) => (S.guildOf(s, 'g1').events || []).filter((e) => e.type === type);
const remindersIn = (s) => eventsOf(s, 'salvage_window_reminder');

// ONE: one machine stranded, run to its deadline.
const ONE = (() => {
  const { s: held, id: miner } = S.grantMachine(S.planted(), 'g1', 'miner', TARGET);
  const evicted = P.accept(held, S.abandon());
  const { deadlineTick } = evicted.salvageWindows[TARGET];
  return { evicted, miner, deadlineTick, atDeadline: P.tickUntil(evicted, (s) => s.tick === deadlineTick) };
})();
// THREE: three stranded (a miner, a factory and an Outpost kit), run to the first midnight, then to the deadline.
const THREE = (() => {
  const { stranded } = X.salvageRun();
  const { deadlineTick } = stranded.salvageWindows[TARGET];
  const firstMidnight = P.tickUntil(stranded, (s) => remindersIn(s).length === 1);
  return { stranded, deadlineTick, firstMidnight, atDeadline: P.tickUntil(firstMidnight, (s) => s.tick === deadlineTick) };
})();

// The view exactly as the browser receives it.
const viewOf = (s, guildId = 'g1') => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId = 'g1') => snap.guilds.find((g) => g.id === guildId);
const rowsOf = (snap, type) => meOf(snap).events.filter((e) => e.type === type);
const plain = (x) => JSON.parse(JSON.stringify(x));
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

// The speakers, as the card is dressed for them.
const PILOT = ['Fleet — Dispatch', "url('assets/characters/pilot.jpg')"];
const SYNDICATE = ['Syndicate Notice', "url('assets/characters/advisor.jpg')"];

// ---- the notice card, on a stub DOM -----------------------------------------------------------------------------------

function stubNode(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', style: {},
    hidden: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].includes(id),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
  };
}
// noticePage(snapshot, guildId) -> the page's notice code running against `snapshot` for the player `guildId`. The shell
// bridges it reads are given the seed's own answers (__boardSystem: the board row and its centre hex). `sent` records every
// action posted, `flown` every __flyTo.
function noticePage(snapshot, guildId = 'g1') {
  const nodes = {};
  const sent = [];
  const flown = [];
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stubNode(id)) },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => snapshot,
      __sendAction: (a) => { sent.push(a); return Promise.resolve({ accepted: true }); },
      __refreshNow: () => Promise.resolve(),
      __flyTo: (q, r, z) => { flown.push([q, r, z]); },
      __outpostName: (id) => id,
      __boardSystem: (id) => getSystem(id),
      __planetDesignation: (planetId) => planetId,
    },
  };
  vm.runInNewContext(bridgesSrc + kitKindsSrc + guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const node = (id) => sandbox.document.getElementById(id);
  // What the player sees on the card right now.
  const view = () => ({
    open: node('notice-overlay').classList.contains('open'),
    eyebrow: node('noticeEyebrow').textContent,
    art: node('noticeArt').style.backgroundImage,
    title: node('noticeTitle').textContent,
    paragraphs: [...node('noticeBody').innerHTML.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => unescape(m[1])),
    facts: [...node('noticeFacts').innerHTML.matchAll(/<span class="k">([^<]*)<\/span><span class="v[^"]*">([^<]*)<\/span>/g)]
      .map((m) => [unescape(m[1]), unescape(m[2])]),
    buttons: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].filter((id) => !node(id).hidden),
    note: node('noticeNote').textContent,
  });
  return { page: sandbox, sent, flown, view };
}
// timeIn(paragraph) -> the {TIME} a reminder's words carry.
const timeIn = (paragraph) => /We still have another (.+?) to get/.exec(paragraph)[1];

// ---- 1. the rows ------------------------------------------------------------------------------------------------------

test('rows and titles: "Awaiting salvage — <system>" and "Machines lost — <system>", the name in the row\'s .who span; neither falls back to the licence lapse', () => {
  const snap = viewOf(THREE.atDeadline);
  // The inbox, newest first, as the engine wrote it: the lapse on top, a reminder for each midnight, the loss at the bottom.
  assert.deepEqual(meOf(snap).events.map((e) => e.type),
    ['salvage_window_lapsed', ...Array(9).fill('salvage_window_reminder'), 'system_lost'], 'premise: the engine\'s own log');
  const { page } = noticePage(snap);
  const cases = [[rowsOf(snap, 'salvage_window_reminder')[0], 'Awaiting salvage'], [rowsOf(snap, 'salvage_window_lapsed')[0], 'Machines lost']];
  for (const [n, prefix] of cases) {
    assert.equal(n.payload.systemName, TARGET_NAME, 'premise: the engine wrote the seed name');
    assert.equal(page.noticeTitle(n), `${prefix} — ${TARGET_NAME}`);
    assert.equal(page.noticeRowTitle(n), `${prefix} &mdash; <span class="who">${TARGET_NAME}</span>`);
    assert.doesNotMatch(page.noticeRowTitle(n) + page.noticeTitle(n), /Licence|lapsed|Venture/);
    assert.equal(page.isSalvageNotice(n), true);
    assert.equal(page.isTerritoryNotice(n) || page.isDeliveryNotice(n) || page.isScanNotice(n), false, 'no other lane\'s notice');
  }
  // Every one is born unread, so every one lights the badge.
  assert.equal(page.myUnreadNotices(snap).length, 11);
});

// ---- 2. the reminder --------------------------------------------------------------------------------------------------

test('popup, the reminder for three: the Chief Pilot, "3 machines … their heels … get them … haul them home", the time left as of its own midnight, the day tag "Awaiting", and Show on map', () => {
  const snap = viewOf(THREE.firstMidnight);
  const [n] = rowsOf(snap, 'salvage_window_reminder');
  // The fixture's known ticks: abandoned at 450 with three stranded (9 days), reminded at the first midnight.
  assert.equal(THREE.stranded.tick, 450, 'premise: the eviction tick');
  assert.equal(n.tick, 1440, 'premise: the first midnight');
  assert.equal(n.payload.deadlineTick, 13410, 'premise: 450 + 3 × 4,320');
  assert.equal(n.payload.strandedAssetIds.length, 3, 'premise: a miner, a factory and the Outpost kit');
  const { page, view, flown } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(view(), {
    open: true,
    eyebrow: PILOT[0],
    art: PILOT[1],
    title: `Awaiting salvage — ${TARGET_NAME}`,
    // 13410 − 1440 = 11,970 ticks = 8 days, 7 hours and 30 minutes, which the ETA format writes "8d 07h".
    paragraphs: [reminderWords(TARGET_NAME, '3 machines', '8d 07h', 'their', 'them')],
    facts: [['Awaiting', `Day ${n.whenDay}`]],
    buttons: ['noticeShowMap'],
    note: '',
  });
  page.noticeShowMap();
  assert.equal(view().open, false, 'the popup closes');
  assert.deepEqual(flown, [[TARGET_HEX.q, TARGET_HEX.r, 9]], 'to the lost system\'s centre hex, at the Dispatch popup\'s zoom');
});

test('popup, the reminder for one: "1 machine cooling its heels … get it … haul it home" — the grammar follows the count', () => {
  const snap = viewOf(ONE.atDeadline);
  const n = rowsOf(snap, 'salvage_window_reminder').find((e) => e.tick === 1440);
  assert.deepEqual(n.payload.strandedAssetIds, [ONE.miner], 'premise: the one miner');
  assert.equal(n.payload.deadlineTick, 4770, 'premise: 450 + 4,320');
  const { page, view } = noticePage(snap);
  page.openNotice(n.id);
  const v = view();
  assert.deepEqual([v.eyebrow, v.art, v.title, v.facts, v.buttons],
    [...PILOT, `Awaiting salvage — ${TARGET_NAME}`, [['Awaiting', `Day ${n.whenDay}`]], ['noticeShowMap']]);
  // 4770 − 1440 = 3,330 ticks = 2 days, 7 hours and 30 minutes.
  assert.deepEqual(v.paragraphs, [reminderWords(TARGET_NAME, '1 machine', '2d 07h', 'its', 'it')]);
  assert.doesNotMatch(v.paragraphs[0], /1 machines|their|them/, 'nothing plural is left over');
});

// ---- 3. the lapse -----------------------------------------------------------------------------------------------------

test('popup, the lapse: "Machines lost — <system>", her words with the count — "1 machine" and "3 machines" — the day tag "Lost", and Show on map', () => {
  for (const [galaxy, count, machines] of [[ONE, 1, '1 machine'], [THREE, 3, '3 machines']]) {
    const snap = viewOf(galaxy.atDeadline);
    const [n] = rowsOf(snap, 'salvage_window_lapsed');
    assert.equal(n.tick, galaxy.deadlineTick, 'premise: written on the deadline');
    assert.equal(n.payload.destroyedAssetIds.length, count, 'premise: the count destroyed');
    const { page, view, flown } = noticePage(snap);
    page.openNotice(n.id);
    assert.deepEqual(view(), {
      open: true,
      eyebrow: PILOT[0],
      art: PILOT[1],
      title: `Machines lost — ${TARGET_NAME}`,
      paragraphs: [lapseWords(TARGET_NAME, machines)],
      facts: [['Lost', `Day ${n.whenDay}`]],
      buttons: ['noticeShowMap'],
      note: '',
    }, machines);
    page.noticeShowMap();
    assert.deepEqual(flown, [[TARGET_HEX.q, TARGET_HEX.r, 9]]);
  }
  // THREE's list holds the Outpost kit: "machines" covers it (the human's word, accepted as a slight generalisation).
  assert.ok(rowsOf(viewOf(THREE.atDeadline), 'salvage_window_lapsed')[0].payload.destroyedAssetIds.some((id) => /_outpost_/.test(id)));
});

// ---- 4. the time is the notice's own ----------------------------------------------------------------------------------

test('the reminder\'s time is deadlineTick − n.tick, the notice\'s OWN tick: a later snapshot leaves a past reminder\'s words unchanged', () => {
  // ONE, seen on its deadline tick: three reminders, each with the time left at the midnight it was written on. Read off
  // the snapshot's tick instead, all three would say the same thing — "0m", since the snapshot's tick IS the deadline.
  // times(snap) -> [the reminder's tick, the time its words carry], for every reminder in the view, newest first.
  const times = (snap) => {
    const { page, view } = noticePage(snap);
    return rowsOf(snap, 'salvage_window_reminder').map((n) => { page.openNotice(n.id); return [n.tick, timeIn(view().paragraphs[0])]; });
  };
  const one = viewOf(ONE.atDeadline);
  assert.equal(one.tick, ONE.deadlineTick, 'premise: the snapshot is on the deadline');
  assert.deepEqual(times(one), [[4320, '7h 30m'], [2880, '1d 07h'], [1440, '2d 07h']], 'newest first: 450, 1,890 and 3,330 ticks left');

  // THREE: its first reminder, read at the midnight it was written and again eleven days of ticks later, on the deadline.
  const early = viewOf(THREE.firstMidnight);
  const late = viewOf(THREE.atDeadline);
  const first = (snap) => rowsOf(snap, 'salvage_window_reminder').find((e) => e.tick === 1440);
  const read = (snap) => { const q = noticePage(snap); q.page.openNotice(first(snap).id); return q.view().paragraphs; };
  assert.notEqual(early.tick, late.tick, 'premise: two different snapshot ticks');
  assert.deepEqual(read(late), read(early), 'the same words, word for word');
  assert.equal(timeIn(read(late)[0]), '8d 07h');
  // And every one of its nine, each as of its own midnight: one day less each time, the last with 450 ticks to go.
  assert.deepEqual(times(late).map((x) => x[1]),
    ['7h 30m', '1d 07h', '2d 07h', '3d 07h', '4d 07h', '5d 07h', '6d 07h', '7d 07h', '8d 07h']);
});

// ---- 5. the speaker and the button ------------------------------------------------------------------------------------

test('the Chief Pilot speaks both, on a card re-dressed on every open — salvage → deploy_failed → salvage → system_lost → closure — and Show on map flies to payload.systemId', () => {
  // The portrait is the Chief Pilot's: the Operations hero that carries her role draws the same picture.
  assert.match(html, /#tp-ops \.ops-thero \.art\{[^}]*url\("assets\/characters\/pilot\.jpg"\)/);
  assert.match(html, /<aside class="ops-hero ops-thero">[\s\S]{0,300}?<div class="role">Chief Pilot<\/div>/);

  const snap = viewOf(ONE.atDeadline);
  const reminder = rowsOf(snap, 'salvage_window_reminder')[0];
  const lapse = rowsOf(snap, 'salvage_window_lapsed')[0];
  const lost = rowsOf(snap, 'system_lost')[0];
  meOf(snap).events.push(
    { id: 901, type: 'deploy_failed', tick: 0, whenDay: 5, readTick: 0, payload: { cause: 'occupied', kind: 'outpost',
      targetHex: { q: 1, r: 2 }, craftId: 'vehicle_g1_heavyTransport_01', craftClass: 'heavyTransport', retreatSystemId: HOME.id, retreatSystemName: 'Home' } },
    { id: 902, type: 'venture_closed', tick: 0, whenDay: 3, readTick: 0, payload: { cause: 'teardown', good: 'titanium', ventureType: 'mining', ventureName: 'Somewhere · Node 1' } },
  );
  const { page, view, flown } = noticePage(snap);
  const dress = () => { const v = view(); return [v.eyebrow, v.art, v.buttons]; };
  page.openNotice(reminder.id);
  assert.deepEqual(dress(), [...PILOT, ['noticeShowMap']]);
  page.openNotice(901);
  assert.deepEqual(dress(), [...PILOT, ['noticeRedeploy', 'noticeReturn']], 'the forks, and Show on map hidden again');
  page.openNotice(lapse.id);
  assert.deepEqual(dress(), [...PILOT, ['noticeShowMap']], 'the forks hidden again');
  page.openNotice(lost.id);
  assert.deepEqual(dress(), [...SYNDICATE, ['noticeShowMap']], 'the adviser back for the loss itself');
  page.openNotice(902);
  assert.deepEqual(dress(), [...SYNDICATE, []]);

  // Show on map reads payload.systemId: point a copy at HOME and it flies to HOME; at a system the board does not hold,
  // the popup closes and the map stays put.
  for (const n of [reminder, lapse]) {
    n.payload.systemId = HOME.id;
    page.openNotice(n.id);
    page.noticeShowMap();
    n.payload.systemId = 'sys_not_on_this_board';
    page.openNotice(n.id);
    page.noticeShowMap();
    assert.equal(view().open, false);
  }
  const home = getSystem(HOME.id).coords;
  assert.notDeepEqual(home, TARGET_HEX, 'premise: a different hex');
  assert.deepEqual(flown, [[home.q, home.r, 9], [home.q, home.r, 9]]);
});

// ---- 6. degradation and read-on-open ----------------------------------------------------------------------------------

test('a payload with its fields missing reads plain words — the id, "Unknown system", "—" for the time — never "null", "undefined", "NaN" or a made-up time', () => {
  const snap = viewOf(ONE.atDeadline);
  const reminder = rowsOf(snap, 'salvage_window_reminder')[0];
  const lapse = rowsOf(snap, 'salvage_window_lapsed')[0];
  const { page, view } = noticePage(snap);
  reminder.payload = { systemId: TARGET, strandedAssetIds: [ONE.miner] };
  page.openNotice(reminder.id);
  assert.equal(view().title, `Awaiting salvage — ${TARGET}`, 'the name falls back to the id');
  assert.deepEqual(view().paragraphs, [reminderWords(TARGET, '1 machine', '—', 'its', 'it')], 'no deadline: no time is made up');
  reminder.payload = {};
  lapse.payload = {};
  for (const n of [reminder, lapse]) {
    page.openNotice(n.id);
    const v = view();
    assert.match(v.title, / — Unknown system$/);
    assert.doesNotMatch(JSON.stringify(v), /null|undefined|NaN|0m/);
  }
});

test('read-on-open is unchanged: an unread salvage notice sends one acknowledgeEvent by numeric id; a reopen of a read one sends none', () => {
  const snap = viewOf(ONE.atDeadline);
  const n = rowsOf(snap, 'salvage_window_lapsed')[0];
  assert.equal(n.readTick, undefined, 'premise: born unread');
  const { page, sent } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(plain(sent), [{ type: 'acknowledgeEvent', guildId: 'g1', eventId: n.id }]);
  assert.equal(typeof sent[0].eventId, 'number');
  n.readTick = n.tick;   // as the next poll would show it
  page.openNotice(n.id);
  assert.equal(sent.length, 1);
});

test('wiring: the page shares the two helpers through the bridges the sandbox stands in for', () => {
  assert.match(html, /\n  window\.__fmtETA = fmtETA;\n/, 'the map\'s fmtETA, shared');
  assert.match(html, /\nfunction countWords\(n, one, many\)\{[^\n]*\n(\/\/[^\n]*\n)*window\.__countWords = countWords;\n/,
    'countWords, shared beside its definition');
});

// ---- 7. the GUARD: every notice the client already had words for, unchanged -------------------------------------------

// Each type MESSAGES rendered before this slice, in its published shape (event-log.md §2, §10–§15), several causes each,
// plus the real `system_lost` rows of the two galaxies above. Its row title, the whole card and Show on map's flight are
// hashed. The pin was made on a `main` worktree at 78bb7a4 — before this slice — and passes there too: a change to the
// shared code (the day-word map moved, a branch stealing a type, a body, a speaker or a button changed) moves it.
const EXISTING = [
  { id: 101, type: 'venture_closed', tick: 0, whenDay: 3, unlockDay: 7, readTick: 0, payload: {
    cause: 'teardown', good: 'titanium', ventureType: 'mining', ventureName: 'Nyx IV · Node 1', lockoutUntilTick: 9000 } },
  { id: 102, type: 'venture_closed', tick: 0, whenDay: 3, readTick: 0, payload: {
    cause: 'forced', good: 'copper', ventureType: 'refining', ventureName: 'Nyx IV · Slot 2' } },
  { id: 103, type: 'venture_closed', tick: 0, whenDay: 3, readTick: 0, payload: {
    cause: 'evicted', good: null, ventureType: 'mining', ventureName: 'Nyx IV · Node 3', lockoutUntilTick: 9000 } },
  { id: 104, type: 'licence_lapsed', tick: 0, whenDay: 4, readTick: 0, payload: {
    cause: 'timeout', good: 'copper', ventureType: 'mining', ventureName: 'Nyx IV · Node 2' } },
  { id: 105, type: 'licence_lapsed', tick: 0, whenDay: 4, readTick: 0, payload: {
    cause: 'lapse', good: 'gold', ventureType: 'mining', ventureName: 'Nyx IV · Node 4' } },
  { id: 106, type: 'deploy_failed', tick: 0, whenDay: 5, readTick: 0, payload: {
    cause: 'occupied', kind: 'outpost', targetHex: { q: 1, r: 2 }, craftId: 'vehicle_g1_heavyTransport_01',
    craftClass: 'heavyTransport', retreatSystemId: 'sys_0001', retreatSystemName: 'Nyx' } },
  { id: 107, type: 'deploy_failed', tick: 0, whenDay: 5, readTick: 0, payload: {
    cause: 'system-claimed', kind: 'prefecture', targetHex: { q: 3, r: 2 }, craftId: 'vehicle_g1_heavyTransport_04',
    craftClass: 'heavyTransport', retreatSystemId: 'sys_0001', retreatSystemName: 'Nyx' } },
  { id: 108, type: 'delivery_space_warning', tick: 0, whenDay: 6, readTick: 0, payload: {
    guildId: 'g1', outpostId: 'outpost_g1_02', cargo: { iron: 30, titanium: 10 }, units: 40, space: 40, freeSpace: 25,
    shortfall: 15, arrivalTick: 999 } },
  { id: 109, type: 'delivery_turned_back', tick: 0, whenDay: 7, readTick: 0, payload: {
    guildId: 'g1', outpostId: 'outpost_g1_09', cause: 'outpost-gone', cargo: { iron: 30 }, units: 30, space: 30 } },
  { id: 110, type: 'outpost_packed', tick: 0, whenDay: 8, readTick: 0, payload: {
    outpostId: 'outpost_g1_01', anchorSystemId: 'sys_0001', anchorSystemName: 'Nyx', hex: { q: 3, r: 4 },
    craftId: 'vehicle_g1_heavyTransport_02', craftClass: 'heavyTransport' } },
  { id: 111, type: 'scan_complete', tick: 0, whenDay: 9, readTick: 0, payload: {
    arrayId: 'deepScanArray_g1_03', level: 'L1', targetSystemId: 'sys_0002', targetName: 'Vel', newFacts: 4 } },
  { id: 112, type: 'scan_voided', tick: 0, whenDay: 10, readTick: 0, payload: {
    arrayId: 'deepScanArray_g1_03', level: 'L2', targetPlanetId: 'pl_00009', targetName: 'Vel II',
    byGuildId: 'g9', byGuildName: 'Rival Co' } },
  { id: 113, type: 'scan_voided', tick: 0, whenDay: 10, readTick: 0, payload: {
    arrayId: 'deepScanArray_g1_05', level: 'L1', targetSystemId: 'sys_0002', targetName: 'Vel', reason: 'anchor-lost' } },
  { id: 114, type: 'system_lost', tick: 0, whenDay: 11, readTick: 0, payload: {
    cause: 'storyteller', prefectureId: 'prefecture_g1_01', claimId: 'claim_01', systemId: TARGET, systemName: 'Nyx',
    planetId: 'pl_00001', slotId: 'pl_00001_s02', ventureIds: [], strandedAssetIds: [], goodsForfeit: {} } },
  { id: 115, type: 'assets_inherited', tick: 0, whenDay: 12, readTick: 0, payload: {
    systemId: TARGET, systemName: 'Nyx', prefectureId: 'prefecture_g1_02',
    inheritedAssetIds: ['asset_g1_factory_07', 'asset_g1_miner_08', 'asset_g1_outpost_09'] } },
  { id: 116, type: 'assets_swept', tick: 0, whenDay: 13, readTick: 0, payload: {
    systemId: TARGET, systemName: 'Nyx', sweptAssetIds: ['asset_g1_deepScan_04', 'asset_g1_miner_02'], byGuildId: 'g2', byGuildName: 'Vantor' } },
];
// render(snapshot, rows) -> what the page shows for each row: its inbox title, the whole card, and where Show on map goes.
function render(snapshot, rows) {
  const { page, view, flown } = noticePage(snapshot);
  return rows.map((n) => {
    page.openNotice(n.id);
    const v = view();
    if (v.buttons.includes('noticeShowMap')) page.noticeShowMap();
    return { type: n.type, row: page.noticeRowTitle(n), ...v, flown: flown.splice(0) };
  });
}
const GUARD_PIN = '3714366e9b827b78e7a8b0254b954c5e4b8c3a748ca80aac300ba31d4f46d9e7';   // hashed on main at 78bb7a4

test('GUARD: every notice the client already had words for renders exactly as on main — row, title, speaker, words, facts, buttons, Show on map', () => {
  const hand = { guilds: [{ id: 'g1', events: plain(EXISTING) }], attention: { notices: [] } };
  const one = viewOf(ONE.atDeadline);
  const three = viewOf(THREE.atDeadline);
  const rendered = [
    ...render(hand, EXISTING),
    ...render(one, rowsOf(one, 'system_lost')),
    ...render(three, rowsOf(three, 'system_lost')),
  ];
  assert.equal(rendered.length, EXISTING.length + 2);
  // Sanity, so the hash cannot pin an empty card: every one has a title and words.
  for (const r of rendered) assert.ok(r.title && r.paragraphs.length && r.row, `${r.type} rendered`);
  // ⤳ 07-11-26 (roadmap 2.6, droids and losing a system — docs/droids.md §14): the system_lost card gained ONE
  // sentence in its aftermath line and ONE fact row, "Droids lost". With exactly those two taken back out, every card
  // renders as it did on main — so the old pin still stands as the proof that nothing else moved; the new pin holds
  // the card as it reads now.
  assert.equal(sha(withoutDroidLoss(rendered)), GUARD_PIN, 'only the droid-loss sentence and fact changed');
  assert.equal(sha(rendered), GUARD_PIN_DROIDS);
});

const DROID_LOSS_SENTENCE = ' Any droids you had there were lost with it — a droid cannot leave its system.';
const GUARD_PIN_DROIDS = '5e7ec424879314827c735ec2343797bb8c2f0da654cca8e37c5ff88eeaa6667c'; // the card with the droid loss, 07-11-26
// withoutDroidLoss(rendered) -> a copy with the §14 delta removed from each system_lost card (and only from those).
function withoutDroidLoss(rendered) {
  return rendered.map((r) => (r.type !== 'system_lost' ? r : {
    ...r,
    paragraphs: r.paragraphs.map((t) => t.replace(DROID_LOSS_SENTENCE, '')),
    facts: r.facts.filter((f) => f[0] !== 'Droids lost'),
  }));
}
