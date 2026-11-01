'use strict';

// salvage-marker-client.test.js — losing ground: the salvage window's galaxy-map marker (roadmap 2.5; design.md §2 /
// §19 #67, docs/territory-model.md §4, "AS-BUILT — the salvage map marker"). Client only.
//
// A lost system where the player's machines (or kits) still lie stranded has a salvage window running: at its deadline
// whatever is still there is destroyed. Operations shows the time left on each stranded row (PR #205). The galaxy map
// now marks each such system too: an amber clock dial at every zoom, and from the label zoom up a tag naming the
// system, AWAITING SALVAGE, and the time left. The marker draws from ONE selector, the shell's salvageOnMap, re-read
// every frame. The tripwires:
//   1. THE SET: one row per system where the guild has an asset carrying `stranded`, with that system's published
//      `deadlineTick` and its centre hex — held to the engine's own state in every galaxy below. Two stranded in one
//      system give one row. A system whose stranded assets have all been salvaged gives none, though its window stands.
//   2. OWN-ONLY: a rival's view has no rows (neither the stranded rows nor the windows reach it), both ways round.
//   3. THE COUNTDOWN: the row carries the absolute deadline, and the tag differences it against the snapshot's tick,
//      so poll by poll the time falls as the tick climbs while the deadline never moves. Nothing is made up: with no
//      window published, or no tick, the tag has no time line.
//   4. THE FRAME: the map's own two passes, on stubs: a dial on each row's centre hex at every zoom, a tag only from
//      WAYSTATION_LABEL_ZOOM, in the salvage amber, hanging down-left.
//   5. THE DIAL: twelve segments going out clockwise from twelve o'clock, in the amber, never the beacon's teal.
//
// The client has no DOM test harness, so, as prefecture-beacon-client.test.js does, this cuts the page's OWN code out
// of game.html and runs it in a node:vm sandbox over real per-guild snapshots, each exactly as GET /snapshot?guild=
// sends it. The canvas draw itself is checked only as the calls it makes on a stub context; the pixels are the human's
// Playwright pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createGrantKitAction, createLoadAssetAction, createAbandonPrefectureAction } = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const { getBoard, getSystem } = require('../seed.js');
const { SALVAGE_WINDOW_TICKS_PER_ASSET, SALVAGE_WINDOW_CAP_TICKS } = require('../eviction.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const X = require('./salvage-script.js');
const A = require('./abandon-script.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(re, what) {
  const m = html.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// One column-0 function of the shell, by name, through its closing brace at column 0.
const fn = (name) => cut(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\{\\n[\\s\\S]*?\\n\\}\\n`), name);

// The shell: the selector and its window door, and applySnapshot's own reads of what the door reads.
const shellSrc = fn('salvageOnMap') + cut(/\nwindow\.__salvageOnMap = function\(\)\{\n[\s\S]*?\n\};\n/, 'window.__salvageOnMap');
const snapReadSrc = cut(/\n {2}LIVE\.snap = snap;\n/, 'the shell\'s snapshot read');
const assetsReadSrc = cut(/\n {2}LIVE\.myAssets = \(me && me\.assets\) \|\| \[\];\n/, 'the shell\'s assets read');
// The beacon's shell, for the one galaxy where both markers fall on one system.
const kitKindsSrc = cut(/<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
const beaconShellSrc = kitKindsSrc + fn('myIdleGroundKits') + fn('pendingPrefectures')
  + cut(/\nwindow\.__pendingPrefectures = function\(\)\{\n[\s\S]*?\n\};\n/, 'window.__pendingPrefectures');
const claimsReadSrc = cut(/\n {2}LIVE\.systemClaims = \{\};\n[\s\S]*?\n {2}\}\);\n/, 'the shell\'s claims read');
// The map: the colours, the tilt, the ETA format, the tag's words, the dial, and the marker's two passes in the frame.
const colourSrc = cut(/\n {2}const COLOR_RGB = [^\n]*\n {2}function col\(key, a\) [^\n]*\n/, 'COLOR_RGB / col');
const squashSrc = cut(/\n {2}const SQUASH = [^\n]*\n/, 'SQUASH');
const etaSrc = cut(/\n {2}function fmtETA\(ticks\) \{\n[\s\S]*?\n {2}\}\n/, 'the map\'s fmtETA');
const tagWordsSrc = cut(/\n {2}function salvageMapTag\(name, deadlineTick, nowTick\) \{\n[\s\S]*?\n {2}\}\n/, 'salvageMapTag');
const dialSrc = cut(/\n {2}const SALVAGE_DIAL_PERIOD_MS = [\s\S]*?\n {2}function drawSalvageDial\(scr, rim, now\) \{\n[\s\S]*?\n {2}\}\n/, 'the dial');
const markerPassSrc = cut(/\n {4}const salvageRows = [^\n]*\n {4}if \(salvageRows\.length[^\n]*\) \{\n[\s\S]*?\n {4}\}\n/, 'the marker pass');
const tagPassSrc = cut(/\n {4}if \(zoom [^\n]*\) \{\n {6}const snapNow = [^\n]*\n[\s\S]*?\n {4}\}\n/, 'the tag pass');

// The board the page loads from GET /board, crossed as JSON as it crosses the wire.
const BOARD = JSON.parse(JSON.stringify(getBoard()));
const { TARGET, HOME } = P;
const NAME = getSystem(TARGET).name.toUpperCase();
const AT = { q: getSystem(TARGET).coords.q, r: getSystem(TARGET).coords.r };

// ---- real engine output ------------------------------------------------------------------------------------

const W = X.salvageRun();      // three stranded in TARGET (a miner, a factory, an Outpost kit), then the salvage run
const FALLOW = S.fallow();     // four stranded in TARGET (two factories, a miner, an Outpost kit)
const AW = A.abandonWorld();   // abandon-script's states

// salvagedOut() -> one machine stranded in TARGET, then salvaged aboard g1's heavy (still berthed there). The window
// still stands (it closes at its deadline, or on a claim), but nothing in TARGET is stranded any more.
function salvagedOut() {
  const { s: held, id: miner } = S.grantMachine(S.planted(), 'g1', 'miner', TARGET);
  const evicted = P.accept(held, S.abandon());
  const loaded = P.accept(evicted, createLoadAssetAction({ guildId: 'g1', vehicleId: P.HEAVY, assetId: miner }));
  return { evicted, loaded, miner };
}
// kitOnly() -> only an Outpost kit stranded in TARGET: a kit counts toward the window, so it is marked too.
function kitOnly() {
  return P.accept(P.accept(S.planted(), createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' })), S.abandon());
}
// prefectureKit() -> a spare Prefecture kit of g1's idle in TARGET when it is abandoned: stranded, so marked, and also a
// kit waiting in an unclaimed system, so the claim-pending beacon marks TARGET too.
function prefectureKit() {
  return P.accept(P.grantPrefectureKit(S.planted(), 'g1', TARGET).s, S.abandon());
}
// swept() -> fallow(), then g2 claims TARGET: g1's stranded assets are swept to g2, and the window closes.
function swept() {
  const { s, rivalKit } = S.rivalReady(FALLOW.s);
  return P.accept(s, S.rivalPlant(rivalKit));
}
// rivalLost() -> the other way round: g2 holds TARGET (abandon-script's `rival`), has a miner there, and abandons it.
function rivalLost() {
  const s = S.grantMachine(AW.rival, 'g2', 'miner', TARGET).s;
  return P.accept(s, createAbandonPrefectureAction({ guildId: 'g2', prefectureId: A.RIVAL_PREFECTURE }));
}
// lastTick() -> one machine stranded (a 3-day window), at the tick before its deadline and on it (the lapse).
function lastTick() {
  const { s: held } = S.grantMachine(S.planted(), 'g1', 'miner', TARGET);
  const evicted = P.accept(held, S.abandon());
  const deadline = evicted.salvageWindows[TARGET].deadlineTick;
  const before = P.tickUntil(evicted, (s) => s.tick === deadline - 1);
  return { before, after: P.tickUntil(before, (s) => s.tick === deadline), deadline };
}
const SO = salvagedOut();

// The view exactly as the browser receives it.
const viewOf = (s, guildId) => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (view, guildId) => view.guilds.find((g) => g.id === guildId);

// ---- the shell, in a sandbox ---------------------------------------------------------------------------------

// page(view, guildId) -> the shell as it stands after applySnapshot read `view`. `p.rows()` is what the map draws this
// frame; `p.read(next)` is the next poll.
function page(view, guildId = 'g1') {
  const sandbox = { window: {}, GAME: { guildId, galaxy: BOARD }, LIVE: { myAssets: [], snap: null } };
  vm.createContext(sandbox);
  vm.runInContext(shellSrc + 'function applyRead(snap){' + snapReadSrc
    + 'var me = (snap.guilds || []).filter(function(g){ return g.id === GAME.guildId; })[0] || null;' + assetsReadSrc + '}', sandbox);
  const p = {
    view: null,
    read(v) { p.view = v; sandbox.applyRead(v); return p; },
    rows: () => JSON.parse(JSON.stringify(sandbox.window.__salvageOnMap())),
    ids: () => p.rows().map((row) => row.systemId),
  };
  return p.read(view);
}
const pageOf = (s, guildId = 'g1') => page(viewOf(s, guildId), guildId);

// The engine's own answer, written out again from the STATE (not the view): one row per system where `guildId` has an
// asset carrying `stranded`, with the deadline of the window the engine keeps for that system.
function engineMarks(s, guildId) {
  const assets = s.guilds.find((g) => g.id === guildId).assets || [];
  const ids = [...new Set(assets.filter((a) => a.stranded).map((a) => a.systemId))].sort();
  return ids.map((id) => {
    const w = (s.salvageWindows || {})[id];
    assert.ok(w && w.ownerGuildId === guildId, `premise: ${guildId}'s stranded assets in ${id} sit under its own window`);
    return { systemId: id, q: getSystem(id).coords.q, r: getSystem(id).coords.r, deadlineTick: w.deadlineTick };
  });
}
// agree(s, what) -> g1's rows, after checking both guilds' rows against the engine's.
function agree(s, what) {
  for (const guildId of ['g1', 'g2']) {
    const rows = pageOf(s, guildId).rows().sort((a, b) => a.systemId.localeCompare(b.systemId));
    assert.deepEqual(rows, engineMarks(s, guildId), `${what}, ${guildId}`);
  }
  return pageOf(s, 'g1').rows();
}
const row = (s, deadlineTick = s.salvageWindows[TARGET].deadlineTick) => ({ systemId: TARGET, ...AT, deadlineTick });

// ---- the map's two passes, on stubs -----------------------------------------------------------------------------

// recorder() -> a stub canvas context that records every method call as [name, ...args] and every property set as
// ['=name', value].
function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (...args) => calls.push([k, ...args]),
    set: (_, k, v) => { calls.push([`=${String(k)}`, v]); return true; },
  });
  return { calls, ctx };
}
// mapCode(extra) -> the map's salvage code in a fresh sandbox on a stub canvas: the colours, the tilt, the ETA format,
// the tag's words, the dial, and `extra`.
function mapCode(extra = {}) {
  const r = recorder();
  const sandbox = { ctx: r.ctx, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(colourSrc + squashSrc + etaSrc + tagWordsSrc + dialSrc
    + ';this.map = { salvageDial, drawSalvageDial, salvageMapTag, fmtETA, COLOR_RGB, SQUASH, SALVAGE_DIAL_PERIOD_MS, '
    + 'SALVAGE_DIAL_SEGMENTS, SALVAGE_DIAL_MIN_RIM_PX };', sandbox);
  return { calls: r.calls, sandbox, ...sandbox.map };
}
// frame(p, zoom, view) -> one frame of the map's marker pass and tag pass, over the rows the page's own door returns
// now, with `view` as window.__snapshot() (the page's last read, by default). The hex→screen transforms are stand-ins
// (no culling); everything else is the page's own. Returns where each dial was centred and how big, and each tag.
function frame(p, zoom, view = p.view) {
  const tags = [];
  const m = mapCode({
    window: { __salvageOnMap: () => p.rows(), __snapshot: () => view, innerWidth: 1e6, innerHeight: 1e6 },
    performance: { now: () => 0 },
    galaxy: { galaxyParams: { hexSize: 10 } },
    zoom,
    WAYSTATION_LABEL_ZOOM: 1.5,
    hexToPixel: (q, r) => ({ x: 4000 + 10 * q, y: 4000 + 10 * r }),
    worldToScreen: (x, y) => ({ x, y }),
    systemById: new Map(BOARD.systems.map((s) => [s.id, s])),
    drawLabelBox: (scr, lines, colorKey, downLeft) => tags.push({ at: [scr.x, scr.y], lines, colorKey, downLeft }),
  });
  vm.runInContext(`(function(){${markerPassSrc}${tagPassSrc}})();`, m.sandbox);
  const dials = m.calls.filter((c) => c[0] === 'translate').map((c) => ({ at: [c[1], c[2]] }));
  const rims = m.calls.filter((c) => c[0] === 'arc').map((c) => c[3]);
  return JSON.parse(JSON.stringify({ dials, rims: [...new Set(rims)], tags }));
}
const screenOf = (q, r) => [4000 + 10 * q, 4000 + 10 * r];
const tagLines = (time) => [NAME, 'AWAITING SALVAGE', ...(time ? [`${time} left`] : [])];

// ---- 1. the set -------------------------------------------------------------------------------------------------

test('one row per system with a stranded asset of ours, carrying its published deadline and its centre hex — as the engine says', () => {
  assert.deepEqual(agree(W.stranded, 'abandoned with a miner, a factory and a kit in TARGET'), [row(W.stranded)]);
  assert.equal(row(W.stranded).deadlineTick, W.stranded.tick + 3 * SALVAGE_WINDOW_TICKS_PER_ASSET, 'premise: three stranded, 9 days');
  // One salvaged aboard the heavy: two still stranded, so the system is still marked, with the same deadline.
  assert.deepEqual(agree(W.loaded, 'the miner salvaged, the factory and the kit still there'), [row(W.stranded)]);
  for (const k of ['inFlight', 'home', 'unloaded', 'returned', 'fleet']) {
    assert.deepEqual(agree(W[k], k), [row(W.stranded)], `${k}: the factory and the kit still lie in TARGET`);
  }
  // A kit alone counts: the window counts machines and kits alike, and a kit left there is destroyed at its deadline.
  const k = kitOnly();
  assert.deepEqual(agree(k, 'only an Outpost kit stranded'), [row(k)]);
  assert.equal(row(k).deadlineTick, k.tick + SALVAGE_WINDOW_TICKS_PER_ASSET, 'premise: one stranded, 3 days');
});

test('no row where nothing of ours lies stranded: held, re-claimed, swept, a rival\'s, or abandoned empty', () => {
  assert.deepEqual(agree(W.held, 'TARGET still held'), []);
  assert.deepEqual(agree(AW.position, 'abandon-script, held'), []);
  assert.deepEqual(agree(AW.carried, 'abandoned, one salvaged, then re-claimed: the rest recovered'), []);
  assert.deepEqual(agree(S.ownReclaim(), 'abandoned, then re-claimed by its owner'), []);
  assert.deepEqual(agree(swept(), 'abandoned, then claimed by a rival: everything swept'), []);
  assert.deepEqual(agree(AW.rival, 'abandoned with nothing to strand, then a rival\'s'), []);
  assert.deepEqual(agree(S.emptyFallowClaim(), 'abandoned with nothing to strand, then claimed by a rival'), []);
  assert.deepEqual(agree(AW.fallow, 'abandoned with nothing to strand, a fresh kit granted after'), []);
});

test('two or more stranded in one system give ONE row, not one per asset', () => {
  const stranded = meOf(viewOf(FALLOW.s, 'g1'), 'g1').assets.filter((a) => a.stranded);
  assert.deepEqual(stranded.map((a) => a.kind).sort(), ['factory', 'factory', 'miner', 'outpost'], 'premise: four stranded');
  assert.ok(stranded.every((a) => a.systemId === TARGET), 'premise: all in TARGET');
  assert.deepEqual(agree(FALLOW.s, 'four stranded in TARGET'), [row(FALLOW.s)]);
  assert.equal(row(FALLOW.s).deadlineTick, FALLOW.s.tick + 4 * SALVAGE_WINDOW_TICKS_PER_ASSET, 'premise: 12 days');
});

test('all salvaged out: the window record stands, but with nothing stranded there the system is not marked', () => {
  const view = viewOf(SO.loaded, 'g1');
  assert.ok(meOf(view, 'g1').salvageWindows[TARGET], 'premise: the window is still published');
  assert.equal(meOf(view, 'g1').assets.some((a) => a.stranded), false, 'premise: nothing is stranded');
  assert.equal(meOf(view, 'g1').assets.find((a) => a.id === SO.miner).inTransitOnVehicleId, P.HEAVY, 'premise: the miner is aboard');
  assert.deepEqual(agree(SO.loaded, 'the one machine salvaged'), []);
  // The same page, poll to poll: marked while the miner lies there, gone the poll after it is loaded.
  const p = pageOf(SO.evicted);
  assert.deepEqual(p.rows(), [row(SO.evicted)]);
  assert.deepEqual(p.read(view).rows(), [], 'the next snapshot drops it; nothing is kept by hand');
});

test('the next snapshot drops the row when the system is re-claimed, swept, or its window lapses', () => {
  const p = pageOf(FALLOW.s);
  assert.deepEqual(p.ids(), [TARGET]);
  assert.deepEqual(p.read(viewOf(S.ownReclaim(), 'g1')).ids(), [], 'the owner re-planted: recovered');
  assert.deepEqual(p.read(viewOf(FALLOW.s, 'g1')).read(viewOf(swept(), 'g1')).ids(), [], 'a rival claimed it: swept');

  const L = lastTick();
  const before = viewOf(L.before, 'g1');
  assert.equal(before.tick, L.deadline - 1, 'premise: the tick before the deadline');
  const q = page(before);
  assert.deepEqual(q.rows(), [row(L.before)], 'still there on the last tick');
  assert.deepEqual(frame(q, 2).tags.map((t) => t.lines), [tagLines('1m')], 'one minute left');
  assert.deepEqual(q.read(viewOf(L.after, 'g1')).rows(), [], 'on the deadline the engine destroyed it: no row');
});

// ---- 2. own-only ------------------------------------------------------------------------------------------------

test('own-only: a rival\'s view marks nothing of ours, and ours marks nothing of a rival\'s', () => {
  for (const [what, s] of [['three stranded', W.stranded], ['four stranded', FALLOW.s]]) {
    const theirs = viewOf(s, 'g2');
    const g1Row = meOf(theirs, 'g1');
    assert.equal('salvageWindows' in g1Row || 'assets' in g1Row, false, `premise, ${what}: g1's row is fogged in g2's view`);
    assert.deepEqual(page(theirs, 'g2').rows(), [], `${what}: g2 marks nothing`);
  }
  // The other way round: g2 lost TARGET with a miner there. Its own view marks it, with its own deadline; g1's does not.
  const s = rivalLost();
  assert.ok(s.salvageWindows[TARGET] && s.salvageWindows[TARGET].ownerGuildId === 'g2', 'premise: g2\'s window');
  assert.deepEqual(agree(s, 'g2 lost TARGET'), []);
  assert.deepEqual(pageOf(s, 'g2').rows(), [row(s)], 'g2 marks its own loss');
});

// ---- 3. the countdown ---------------------------------------------------------------------------------------------

test('the row carries the absolute deadline; poll by poll the tick climbs and the tag\'s time left falls', () => {
  const p = pageOf(W.stranded);
  const deadline = W.stranded.salvageWindows[TARGET].deadlineTick;
  const steps = [
    // [state, its tick, the time left]
    ['stranded', 450, '9d 00h'],    // 12,960 ticks
    ['loaded', 450, '9d 00h'],
    ['unloaded', 900, '8d 16h'],    // 12,510 ticks
    ['returned', 1350, '8d 09h'],   // 12,060 ticks
  ];
  for (const [k, tick, time] of steps) {
    p.read(viewOf(W[k], 'g1'));
    assert.equal(p.view.tick, tick, `premise: ${k}'s tick`);
    assert.deepEqual(p.rows(), [row(W[k], deadline)], `${k}: the same deadline, the published one`);
    assert.notEqual(p.rows()[0].deadlineTick, p.view.tick, `${k}: an absolute tick, not the time left`);
    assert.deepEqual(frame(p, 2).tags.map((t) => t.lines), [tagLines(time)], `${k}: the tag`);
  }
  // One tick on: only the tick moves, and the time left falls with it.
  p.read(viewOf(P.ticks(W.stranded, 1), 'g1'));
  assert.deepEqual([p.view.tick, p.rows()[0].deadlineTick], [451, deadline]);
  assert.deepEqual(frame(p, 2).tags[0].lines, tagLines('8d 23h'), '12,959 ticks');
});

test('nothing made up: no window or no tick published gives no time line; a window lends nothing to another system', () => {
  // The field absent (a snapshot from before the window, say): the system is still marked, with no deadline.
  const bare = viewOf(W.stranded, 'g1');
  delete meOf(bare, 'g1').salvageWindows;
  const p = page(bare);
  assert.deepEqual(p.rows(), [row(W.stranded, null)]);
  assert.deepEqual(frame(p, 2).tags.map((t) => t.lines), [tagLines(null)], 'the tag has no time line');
  // A record with no numeric deadline is not a deadline.
  const odd = viewOf(W.stranded, 'g1');
  meOf(odd, 'g1').salvageWindows[TARGET] = { deadlineTick: '13410' };
  assert.deepEqual(page(odd).rows(), [row(W.stranded, null)]);
  // No snapshot tick to difference against: no time line either.
  const q = page(viewOf(W.stranded, 'g1'));
  assert.deepEqual(frame(q, 2, { tick: undefined }).tags[0].lines, tagLines(null));
  assert.deepEqual(frame(q, 2, null).tags[0].lines, tagLines(null));

  // Two systems, each with its own deadline: flag the home miner stranded by hand. With no window for HOME, HOME's row
  // carries none; given one, HOME's row carries HOME's and TARGET's keeps its own.
  const two = viewOf(W.stranded, 'g1');
  meOf(two, 'g1').assets.find((a) => a.id === W.homeMiner).stranded = { tick: two.tick };
  const homeRow = (deadlineTick) => ({ systemId: HOME.id, q: getSystem(HOME.id).coords.q, r: getSystem(HOME.id).coords.r, deadlineTick });
  const byId = (rows) => rows.sort((a, b) => a.systemId.localeCompare(b.systemId));
  assert.deepEqual(byId(page(two).rows()), byId([row(W.stranded), homeRow(null)]));
  meOf(two, 'g1').salvageWindows[HOME.id] = { deadlineTick: two.tick + 60 };
  assert.deepEqual(byId(page(two).rows()), byId([row(W.stranded), homeRow(two.tick + 60)]));
});

test('the tag\'s words: the name, AWAITING SALVAGE, then the time left; each line fits the label box', () => {
  const m = mapCode();
  const tag = (...a) => JSON.parse(JSON.stringify(m.salvageMapTag(...a)));
  assert.deepEqual(tag('Nyx', 13410, 450), ['NYX', 'AWAITING SALVAGE', '9d 00h left']);
  assert.deepEqual(tag('Nyx', 13410, 13409), ['NYX', 'AWAITING SALVAGE', '1m left']);
  assert.deepEqual(tag('Nyx', 13410, 13415), ['NYX', 'AWAITING SALVAGE', '0m left'], 'never a negative time (fmtETA floors at 0)');
  assert.deepEqual(tag('Nyx', null, 450), ['NYX', 'AWAITING SALVAGE']);
  assert.deepEqual(tag('Nyx', 13410, null), ['NYX', 'AWAITING SALVAGE']);
  // drawLabelBox draws a 150px box with text from 8px in, so a detail line in 10px JetBrains Mono (6px a character)
  // fits 23 characters. The longest window the engine opens is the cap: its time line, and the words, fit.
  const longest = tag('Nyx', SALVAGE_WINDOW_CAP_TICKS, 0);
  assert.equal(longest[2], '18d 00h left');
  longest.slice(1).forEach((line) => assert.ok(line.length <= 23, `"${line}" fits the box`));
  assert.ok(`AWAITING SALVAGE · ${longest[2]}`.length > 23, 'premise: on one line it would not');
});

// ---- 4. the frame -------------------------------------------------------------------------------------------------

test('the frame: a dial on each row\'s centre hex at every zoom; its tag only from the label zoom, amber, down-left', () => {
  const p = pageOf(W.stranded);
  const centre = screenOf(AT.q, AT.r);
  const far = frame(p, 1);   // the whole-galaxy view, under WAYSTATION_LABEL_ZOOM
  assert.deepEqual(far.dials, [{ at: centre }], 'the dial is there zoomed out');
  assert.deepEqual(far.rims, [mapCode().SALVAGE_DIAL_MIN_RIM_PX], 'never smaller than its floor on screen');
  assert.deepEqual(far.tags, [], 'no tag below the label zoom');
  const near = frame(p, 1.5);
  assert.deepEqual(near.dials, [{ at: centre }]);
  assert.deepEqual(near.tags, [{ at: centre, lines: tagLines('9d 00h'), colorKey: 'salvage', downLeft: true }]);
  const close = frame(p, 4);
  assert.deepEqual(close.rims, [10 * 4 * 0.85], 'zoomed in, the dial sits just inside the centre hex, as the beacon does');
  // Nothing of ours stranded: nothing drawn at all.
  assert.deepEqual(frame(pageOf(W.held), 2), { dials: [], rims: [], tags: [] });
});

test('a stranded Prefecture kit lights both markers on its system; the salvage tag is drawn after the beacon\'s', () => {
  const s = prefectureKit();
  assert.deepEqual(agree(s, 'a spare Prefecture kit stranded in TARGET'), [row(s)]);
  // The beacon's own selector, over the same view: the kit waits, idle, in a system nobody holds.
  const sandbox = { window: {}, GAME: { guildId: 'g1', galaxy: BOARD }, LIVE: { systemClaims: {}, myAssets: [] } };
  vm.createContext(sandbox);
  vm.runInContext(beaconShellSrc + 'function applyRead(snap){ var me = (snap.guilds || []).filter(function(g){ return g.id === GAME.guildId; })[0] || null;'
    + assetsReadSrc + claimsReadSrc + '}', sandbox);
  sandbox.applyRead(viewOf(s, 'g1'));
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.__pendingPrefectures())), [{ systemId: TARGET, ...AT }]);
  // Both tags hang down-left from the same point; the one on a clock is drawn last, so it is on top.
  const beaconTag = html.indexOf("drawLabelBox(scr, [sys.name.toUpperCase(), 'CLAIM PENDING'], 'player', true);");
  assert.ok(beaconTag > 0 && html.indexOf(tagPassSrc) > beaconTag, 'the salvage tag pass follows the beacon\'s');
});

// ---- 5. the dial --------------------------------------------------------------------------------------------------

test('the dial: twelve segments going out one by one, clockwise from twelve o\'clock, until one is left; then it relights', () => {
  const m = mapCode();
  const T = m.SALVAGE_DIAL_PERIOD_MS;
  const N = m.SALVAGE_DIAL_SEGMENTS;
  assert.equal(N, 12, 'a clock face\'s twelve');
  const span = (2 * Math.PI) / N;
  const segs = m.salvageDial(0);
  assert.equal(segs.length, N);
  segs.forEach((seg, i) => {
    // Clockwise from twelve o'clock (-PI/2 on the canvas), each inside its own twelfth with a gap at both ends.
    assert.ok(seg.from > -Math.PI / 2 + i * span && seg.to < -Math.PI / 2 + (i + 1) * span && seg.from < seg.to, `segment ${i}`);
  });
  const lit = (now) => m.salvageDial(now).map((seg) => seg.lit);
  for (let k = 0; k < N; k++) {
    const now = (k + 0.5) * (T / N);
    // k twelfths in: the first k are out, the rest lit. So it starts full, and the last lit is the one before twelve.
    assert.deepEqual(lit(now), segs.map((_, i) => i >= k), `${k} twelfths into the period`);
  }
  assert.deepEqual(lit(T - 1), segs.map((_, i) => i === N - 1), 'never all out: the last one is lit to the end');
  assert.deepEqual(lit(T), segs.map(() => true), 'then it relights');
  assert.deepEqual(lit(7 * T + 1), lit(1), 'the same every period');
});

test('the draw: segments of one ring, centred on the hex, flat in the map\'s tilt, in the salvage amber, never the beacon\'s teal', () => {
  const m = mapCode();
  m.drawSalvageDial({ x: 200, y: 120 }, 30, 0.5 * m.SALVAGE_DIAL_PERIOD_MS);
  const names = m.calls.map((c) => c[0]);
  assert.deepEqual(m.calls.find((c) => c[0] === 'translate'), ['translate', 200, 120], 'centred on the hex');
  assert.deepEqual(m.calls.find((c) => c[0] === 'scale'), ['scale', 1, m.SQUASH], 'flat in the tilted plane');
  const arcs = m.calls.filter((c) => c[0] === 'arc');
  assert.equal(arcs.length, m.SALVAGE_DIAL_SEGMENTS, 'one arc per segment');
  arcs.forEach((a) => assert.deepEqual(a.slice(1, 4), [0, 0, 30], 'every segment on the one ring, at the rim'));
  assert.ok(!names.includes('fill') && !names.includes('fillRect'), 'hollow: nothing filled, unlike a settled claim\'s territory');
  const colours = m.calls.filter((c) => c[0] === '=strokeStyle').map((c) => String(c[1]));
  const amber = colours.filter((c) => c.startsWith('rgba(227,192,74,'));
  assert.equal(amber.length, m.SALVAGE_DIAL_SEGMENTS, 'each segment stroked in the salvage amber, over its dark under-stroke');
  assert.equal(amber.filter((c) => c === 'rgba(227,192,74,0.95)').length, 6, 'half a period in: six lit');
  assert.equal(colours.some((c) => c.startsWith('rgba(67,217,200,')), false, 'never the player teal the beacon is drawn in');
  assert.equal(names[names.length - 1], 'restore', 'the canvas state is put back');
  // The amber is Operations' own: --ops-amber2, the colour a stranded row's line is drawn in.
  const opsAmber2 = html.match(/--ops-amber2:#([0-9a-f]{6});/i)[1].match(/../g).map((h) => parseInt(h, 16));
  assert.deepEqual([...m.COLOR_RGB.salvage], opsAmber2);
  assert.notDeepEqual([...m.COLOR_RGB.salvage], [...m.COLOR_RGB.player]);
});
