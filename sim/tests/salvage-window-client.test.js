'use strict';

// salvage-window-client.test.js — losing ground: the salvage window, client (roadmap 2.5; design.md §2 / §19 #67,
// docs/territory-model.md §4, docs/operations-hub.md §5). The engine half (PR #204) put a lost system's salvage on a
// clock: whatever is still stranded there at its deadline is destroyed, and the owner's own guild row publishes
// `salvageWindows: { [systemId]: { deadlineTick } }`. Operations → IDLE already marked a stranded row "Stranded ·
// awaiting salvage", with no clock. This slice ends that line on the time left, `fmtETA(deadlineTick − tick)`: two
// published ticks differenced and formatted, as a craft's ETA is (design.md §18). IDLE is redrawn whenever those words
// change. Client only.
// As the other *-client tests do, this runs the Operations hub's OWN code in a node:vm sandbox on a stub DOM, against
// REAL per-guild snapshots, each exactly as GET /snapshot?guild= sends it, so every deadline here is the engine's own:
//   - salvage-script.js: g1 abandons TARGET with a miner, a factory and an Outpost kit idle there (three stranded, so a
//     9-day window), then salvages the miner and flies its heavy home and back as the ticks pass;
//   - sweep-script.js's fallow(): a built-up TARGET abandoned (four stranded, two of them factories, a 12-day window);
//   - lastTick() (below): one machine stranded (a 3-day window), run to the tick before its deadline, then one more.
// The live panel in the browser is the human's Playwright pass, outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem } = require('../seed.js');
const { SALVAGE_WINDOW_TICKS_PER_ASSET } = require('../eviction.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const X = require('./salvage-script.js');
const seed = require('../../data/seed.json');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// main's words, unchanged. This slice appends " · <time> left" to them.
const STRANDED_MARK = 'Stranded · awaiting salvage';

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m;
}
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script')[1];
// The Operations hub's whole script without its IIFE wrapper, so its own functions land at the sandbox's top level.
const opsSrc = cut(html, /<script id="operations-tab-wire">\n\(function\(\)\{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/, 'the Operations script')[1];
// A stranded machine's row asks the deploy popup's carrier list whether to offer Salvage, so the hub runs beside it.
const deployWireSrc = cut(html, /<script id="deploy-kit-wire">([\s\S]*?)<\/script>/, 'the deploy popup script')[1];

// ---- real engine output ------------------------------------------------------------------------------------

const { TARGET } = P;
const W = X.salvageRun();
const FALLOW = S.fallow();

// lastTick() -> g1 holds TARGET (sweep-script.js's planted()) with one idle miner there, and abandons it: one asset
// stranded, so a 3-day window. Three states:
//   evicted — the eviction's own tick;
//   before  — the tick before the deadline: the miner is still there, and still salvageable;
//   after   — the deadline's tick: the engine's lapse has destroyed the miner and closed the window.
function lastTick() {
  const { s: held, id: miner } = S.grantMachine(S.planted(), 'g1', 'miner', TARGET);
  const evicted = P.accept(held, S.abandon());
  const deadline = buildSnapshot(evicted, 'g1').guilds.find((g) => g.id === 'g1').salvageWindows[TARGET].deadlineTick;
  const before = P.tickUntil(evicted, (s) => s.tick === deadline - 1);
  const after = P.tickUntil(before, (s) => s.tick === deadline);
  return { evicted, before, after, miner, deadline };
}
const LAST = lastTick();

// The view exactly as the browser receives it.
const viewOf = (s, guildId) => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId) => snap.guilds.find((g) => g.id === guildId);
// noWindow(view, guildId) -> the same view without the owner's `salvageWindows`: what a snapshot that publishes no window
// for any system looks like (main's engine before PR #204, say).
const noWindow = (view, guildId) => {
  delete meOf(view, guildId).salvageWindows;
  return view;
};
// ticksLeft(view, systemId) -> the published deadline less the published tick: the one subtraction the client does.
const ticksLeft = (view, systemId) => meOf(view, 'g1').salvageWindows[systemId].deadlineTick - view.tick;
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

// ---- the Operations hub, on a stub DOM ---------------------------------------------------------------------

// The board's name for a hex, as the shell's __landmarkNameAt reads it: a system on it, else a seed waystation.
function landmarkNameAt(q, r) {
  const on = (x) => x.coords && x.coords.q === q && x.coords.r === r;
  const hit = seed.systems.find(on) || seed.outposts.find(on);
  return hit ? hit.name : null;
}
const OPS_HOSTS = ['ops-lane-notices', 'ops-transit-list', 'ops-deployed-list', 'ops-idle-list', 'ops-tp-list'];

// opsPage(snapshot, guildId, src) -> the Operations hub's code (or a mutated copy, `src`) running for the player
// `guildId`, on a stub DOM that counts each host's innerHTML writes. `open()` opens the hub on `snapshot`, `poll(next)`
// is the shell's next poll on a new snapshot, `html(id)` what a host shows now.
function opsPage(snapshot, guildId, src = opsSrc) {
  let current = snapshot;
  const nodes = {};
  const writes = {};
  const node = (id) => {
    if (!nodes[id]) {
      let inner = '';
      writes[id] = 0;
      nodes[id] = {
        id,
        get innerHTML() { return inner; },
        set innerHTML(v) { inner = v; writes[id] += 1; },
        querySelectorAll: () => [],
        addEventListener() {},
      };
    }
    return nodes[id];
  };
  const sandbox = {
    document: { getElementById: node, addEventListener() {} },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => current,
      __systemName: (id) => (getSystem(id) ? getSystem(id).name : id),
      __outpostName: (id) => id,
      __landmarkNameAt: landmarkNameAt,
    },
  };
  vm.runInNewContext(kitKindsSrc + src, sandbox);
  vm.runInNewContext(deployWireSrc, sandbox);
  return {
    open: () => sandbox.window.__opsOpen(),
    poll: (next) => { current = next; sandbox.window.__opsRefresh(); },
    html: (id) => node(id).innerHTML,
    writes: (id) => writes[id] || 0,
    hub: () => Object.fromEntries(OPS_HOSTS.map((id) => [id, node(id).innerHTML])),
  };
}
// idleOf(view, guildId, src) -> the IDLE list a freshly opened hub draws on `view`.
function idleOf(view, guildId = 'g1', src = opsSrc) {
  const p = opsPage(view, guildId, src);
  p.open();
  return p.html('ops-idle-list');
}

// lineOf(idleHtml, id) -> the state line on asset `id`'s IDLE row, or '' when its row has none. Fails when no row lists
// that asset.
function lineOf(idleHtml, id) {
  const row = idleHtml.split('<div class="ops-idle-machine').find((r) => r.includes(`<span class="mid">${id}</span>`));
  assert.ok(row, `IDLE lists ${id}`);
  const m = row.match(/<span class="mstranded">([^<]*)<\/span>/);
  return m ? m[1] : '';
}
const withLeft = (time) => `${STRANDED_MARK} · ${time} left`;

// ---- 1. the countdown --------------------------------------------------------------------------------------

test('a stranded row ends on the time left on its system\'s window: the published deadline less the published tick', () => {
  const view = viewOf(W.stranded, 'g1');
  assert.deepEqual(Object.keys(meOf(view, 'g1').salvageWindows), [TARGET], 'premise: one window, the lost system\'s');
  assert.equal(ticksLeft(view, TARGET), 3 * SALVAGE_WINDOW_TICKS_PER_ASSET, 'premise: three stranded, 3 × 3 days, on the eviction\'s own tick');
  const idle = idleOf(view);
  // The miner, the factory and the kit: one deadline for the system, so one time on all three. 12,960 ticks = 9 days.
  for (const id of [W.miner, W.factory, W.kit]) assert.equal(lineOf(idle, id), withLeft('9d 00h'), id);
  // The home miner is not stranded, so its row has no state line at all, though its guild has a window open.
  assert.equal(lineOf(idle, W.homeMiner), '');
  // Inside the marker's own span, as its last words: the row's markup is otherwise main's.
  assert.ok(idle.includes(`<span class="mstranded">${STRANDED_MARK} · 9d 00h left</span></div>`));
});

test('poll by poll, the time left follows the snapshot\'s tick; the published deadline never moves', () => {
  const steps = [
    // [state, its tick, what is still stranded, the time left]
    ['stranded', 450, [W.miner, W.factory, W.kit], '9d 00h'],   // 12,960 ticks
    ['loaded', 450, [W.factory, W.kit], '9d 00h'],              // the miner aboard the heavy has left IDLE
    ['unloaded', 900, [W.factory, W.kit], '8d 16h'],            // 12,510 ticks = 8d 16h 30m
    ['returned', 1350, [W.factory, W.kit], '8d 09h'],           // 12,060 ticks
  ];
  const deadline = meOf(viewOf(W.stranded, 'g1'), 'g1').salvageWindows[TARGET].deadlineTick;
  const p = opsPage(viewOf(W.stranded, 'g1'), 'g1');
  p.open();
  for (const [k, tick, stranded, time] of steps) {
    const view = viewOf(W[k], 'g1');
    assert.deepEqual([view.tick, meOf(view, 'g1').salvageWindows[TARGET].deadlineTick], [tick, deadline], `premise: ${k}`);
    p.poll(view);
    for (const id of stranded) assert.equal(lineOf(p.html('ops-idle-list'), id), withLeft(time), `${k}: ${id}`);
    // Every stranded row in IDLE carries the countdown, and nothing else does.
    assert.equal(p.html('ops-idle-list').split(' left</span>').length - 1, stranded.length, `${k}: one countdown per stranded row`);
  }
});

test('pooled: every stranded row in a lost system shows the same time, two factories, a miner and a kit alike', () => {
  const view = viewOf(FALLOW.s, 'g1');
  assert.equal(ticksLeft(view, TARGET), 4 * SALVAGE_WINDOW_TICKS_PER_ASSET, 'premise: four stranded, 4 × 3 days, on the eviction\'s own tick');
  const kinds = meOf(view, 'g1').assets.filter((a) => a.stranded).map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['factory', 'factory', 'miner', 'outpost'], 'premise: what the abandon stranded');
  const idle = idleOf(view);
  const ids = [FALLOW.miner, FALLOW.factory, FALLOW.idleFactory, FALLOW.outpostKit];
  // 17,280 ticks = 12 days, on every row: the window is per system, not per asset.
  assert.deepEqual(ids.map((id) => lineOf(idle, id)), ids.map(() => withLeft('12d 00h')));
});

// ---- 2. the redraw ----------------------------------------------------------------------------------------

test('IDLE redraws when the countdown\'s words change, and only then: the signature carries them', () => {
  // One tick on, and a second: the snapshot's tick moves and nothing else about g1's assets or craft does.
  const [v0, v1, v2] = [0, 1, 2].map((n) => viewOf(P.ticks(W.stranded, n), 'g1'));
  const same = (a, b) => JSON.stringify([meOf(a, 'g1').assets, meOf(a, 'g1').vehicles]) === JSON.stringify([meOf(b, 'g1').assets, meOf(b, 'g1').vehicles]);
  assert.ok(same(v0, v1) && same(v1, v2), 'premise: only the tick moves');
  assert.deepEqual([ticksLeft(v0, TARGET), ticksLeft(v1, TARGET), ticksLeft(v2, TARGET)], [12960, 12959, 12958]);

  const p = opsPage(v0, 'g1');
  p.open();
  assert.equal(lineOf(p.html('ops-idle-list'), W.factory), withLeft('9d 00h'));
  let writes = p.writes('ops-idle-list');
  p.poll(v1);   // 12,959 ticks = 8d 23h 59m: new words, so a redraw
  assert.equal(p.writes('ops-idle-list'), writes + 1, 'redrawn: the words changed');
  assert.equal(lineOf(p.html('ops-idle-list'), W.factory), withLeft('8d 23h'));
  writes = p.writes('ops-idle-list');
  p.poll(v2);   // 12,958 ticks: still 8d 23h, so nothing is redrawn
  assert.equal(p.writes('ops-idle-list'), writes, 'the same words: nothing redrawn');

  // main's signature term put back (the flag only): the hub never redraws, and the countdown freezes where it was drawn.
  const NEW_TERM = "(a.stranded ? ':' + strandedMark(a) : '')";
  const MAIN_TERM = "(a.stranded ? ':stranded' : '')";
  assert.ok(opsSrc.includes(NEW_TERM), 'the term this test swaps is there');
  const m = opsPage(v0, 'g1', opsSrc.replace(NEW_TERM, MAIN_TERM));
  m.open();
  m.poll(v1);
  assert.equal(lineOf(m.html('ops-idle-list'), W.factory), withLeft('9d 00h'), 'stale: main\'s signature never sees the time pass');
});

// ---- 3. nothing made up -----------------------------------------------------------------------------------

test('no window published for the row\'s system: the row reads as it did before, and no countdown is made up', () => {
  const ids = [W.miner, W.factory, W.kit];
  // The field absent altogether (a snapshot from before the window, say): main's words on every stranded row.
  const bare = idleOf(noWindow(viewOf(W.stranded, 'g1'), 'g1'));
  assert.deepEqual(ids.map((id) => lineOf(bare, id)), ids.map(() => STRANDED_MARK));
  assert.doesNotMatch(bare, / left</);

  // A window for another system lends nothing. Flag the home miner by hand: HOME has no window, TARGET has one.
  const view = viewOf(W.stranded, 'g1');
  meOf(view, 'g1').assets.find((a) => a.id === W.homeMiner).stranded = { tick: view.tick };
  const mixed = idleOf(view);
  assert.equal(lineOf(mixed, W.homeMiner), STRANDED_MARK, 'HOME: no window, no countdown');
  assert.equal(lineOf(mixed, W.factory), withLeft('9d 00h'), 'TARGET: its own window');

  // A record with no numeric deadline is not a published deadline.
  const odd = viewOf(W.stranded, 'g1');
  meOf(odd, 'g1').salvageWindows[TARGET] = {};
  assert.equal(lineOf(idleOf(odd), W.factory), STRANDED_MARK);

  // A deadline at or behind the tick (the engine never publishes one: its lapse closes the window on that tick) reads
  // 0m, never a negative time: fmtETA floors at zero.
  const late = viewOf(W.stranded, 'g1');
  late.tick = meOf(late, 'g1').salvageWindows[TARGET].deadlineTick + 5;
  assert.equal(lineOf(idleOf(late), W.factory), withLeft('0m'));

  // A window whose stranded rows have all gone (all salvaged, say) has nothing to hang on, so nothing shows it.
  const empty = viewOf(W.stranded, 'g1');
  meOf(empty, 'g1').assets = meOf(empty, 'g1').assets.filter((a) => !a.stranded);
  assert.ok(meOf(empty, 'g1').salvageWindows[TARGET], 'premise: the window is still published');
  assert.doesNotMatch(idleOf(empty), /awaiting salvage/);
});

// ---- 4. against the engine's own lapse ----------------------------------------------------------------------

test('the last tick before the lapse reads 1m left; on the deadline\'s tick the window has closed and the row is gone', () => {
  const evicted = viewOf(LAST.evicted, 'g1');
  assert.equal(ticksLeft(evicted, TARGET), SALVAGE_WINDOW_TICKS_PER_ASSET, 'premise: one stranded, 3 days');
  assert.equal(lineOf(idleOf(evicted), LAST.miner), withLeft('3d 00h'));

  const before = viewOf(LAST.before, 'g1');
  assert.equal(before.tick, LAST.deadline - 1);
  assert.equal(lineOf(idleOf(before), LAST.miner), withLeft('1m'), 'one tick left: still there, still salvageable');

  // One more tick: the engine destroyed the miner and closed the window, so there is no row and no countdown to show.
  const after = viewOf(LAST.after, 'g1');
  assert.equal('salvageWindows' in meOf(after, 'g1'), false, 'premise: the window has closed');
  assert.equal(meOf(after, 'g1').assets.some((a) => a.id === LAST.miner), false, 'premise: the miner is destroyed');
  const idle = idleOf(after);
  assert.equal(idle.includes(LAST.miner), false);
  assert.doesNotMatch(idle, /awaiting salvage| left</);
});

// ---- 5. GUARD: the rest of Operations, unchanged ------------------------------------------------------------

// Every Operations host, in every state below, as main's own Operations script rendered it at 2338b51 (before this
// slice), hashed there by this same test and pinned. Two halves:
//   - read WITHOUT the window (noWindow), the whole hub is main's, byte for byte;
//   - read WITH it (the real view), every host but IDLE is the same as without it, and IDLE differs only by the
//     countdown appended to its stranded rows' line: strip " · <time> left" from it and it is the no-window IDLE.
// On main, which never reads the window, the two views draw the same bytes, so this test passes there too.
const COUNTDOWN = / · (?:\d+d \d\dh|\d+h \d\dm|\d+m) left(?=<\/span>)/g;
const AS_ON_MAIN = [
  { name: 'salvage, held (g1)', state: () => W.held, guild: 'g1',
    pin: 'f82f5e5ba1952b76e20c7fcb6666f12502787a80aff16536d6af68b96e87432f' },
  { name: 'salvage, stranded (g1)', state: () => W.stranded, guild: 'g1',
    pin: 'c7fe1db37740ebe241be2224a76d6c09e905c5138e5196a30f7bc3c7e848b66d' },
  { name: 'salvage, stranded (g2)', state: () => W.stranded, guild: 'g2',
    pin: '071ce5098c1dd116c8d1da228bd9b04334a42c4f6a09fd4a20ba56840793a70c' },
  { name: 'salvage, fleet (g1)', state: () => W.fleet, guild: 'g1',
    pin: 'f7dfa96242307043a0419d6a0647f14636aae971c45379193ec697365efac486' },
  { name: 'salvage, loaded (g1)', state: () => W.loaded, guild: 'g1',
    pin: '6758f774fff6dc117648e01d18b5902702632765bdb2c24bbdffa3d0e1449e9a' },
  { name: 'salvage, inFlight (g1)', state: () => W.inFlight, guild: 'g1',
    pin: 'cfb1f51508a5e3a1616e4c46a3ca8c20acb0e365569cf9b007f6ce3e1b2914ad' },
  { name: 'salvage, home (g1)', state: () => W.home, guild: 'g1',
    pin: '81c41b072e0ebc60cbdc3e7690d6d566bd1b893eb9ef020f3dd11096c7779940' },
  { name: 'salvage, unloaded (g1)', state: () => W.unloaded, guild: 'g1',
    pin: '4cec4d52144d607b2c97ef04ee56deddcf98238d7e1a5aa2b6e0142b49699a48' },
  { name: 'salvage, returned (g1)', state: () => W.returned, guild: 'g1',
    pin: 'a82b9624cc00485c157cc9b3447c08305083d4e742681f5e0dab94610f234a27' },
  { name: 'sweep, fallow (g1)', state: () => FALLOW.s, guild: 'g1',
    pin: '5b19a0f1cb472f520c36ebb0a62e895d1957ce80c9fca540040d7f70bac92f35' },
  { name: 'last tick, evicted (g1)', state: () => LAST.evicted, guild: 'g1',
    pin: '191cfff17ef3057fcb1db76b2d159d2578b79dd843edd61f0941bbcd080ed023' },
  { name: 'last tick, before (g1)', state: () => LAST.before, guild: 'g1',
    pin: '191cfff17ef3057fcb1db76b2d159d2578b79dd843edd61f0941bbcd080ed023' },
  { name: 'last tick, after (g1)', state: () => LAST.after, guild: 'g1',
    pin: '893100628de2b02f7ee3c908c594a73cf3acacbdc97b1373787c5cf30f5324f4' },
];

test('GUARD: without the window every Operations host renders as main rendered it; with it, only the countdown is new', () => {
  for (const c of AS_ON_MAIN) {
    const bareHub = (() => { const p = opsPage(noWindow(viewOf(c.state(), c.guild), c.guild), c.guild); p.open(); return p.hub(); })();
    const realHub = (() => { const p = opsPage(viewOf(c.state(), c.guild), c.guild); p.open(); return p.hub(); })();
    assert.equal(sha(bareHub), c.pin, `${c.name}: the hub without the window, as on main`);
    for (const id of OPS_HOSTS.filter((h) => h !== 'ops-idle-list')) {
      assert.equal(realHub[id], bareHub[id], `${c.name}: ${id} does not read the window`);
    }
    assert.equal(realHub['ops-idle-list'].replace(COUNTDOWN, ''), bareHub['ops-idle-list'], `${c.name}: IDLE, bar the countdown`);
  }
});
