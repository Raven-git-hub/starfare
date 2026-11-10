'use strict';

// maintenance-tab-client.test.js — roadmap 2.6 (maintenance), slice 5 of 6: the MAINTENANCE TAB and the maintenance
// notices' words (docs/maintenance.md §7.1, docs/event-log.md §17–§19). Client only — no engine or snapshot change.
//
// As the other *-client tests do, this runs the page's OWN code, cut out of client/game.html, in a node:vm sandbox with
// a stub DOM, against REAL per-guild snapshots built by the engine (maintenance-tab-fixtures.js), each exactly as
// GET /snapshot?guild= sends it. What it proves, in the order of the slice's proof list:
//   1. THE TAB: the bar's button sits right after Operations; openTab('maintenance') shows the panel and draws it; a
//      poll while open redraws; closing (another tab, or Close) hides it and stops the redraws.
//   2. FLEET: the pool, the three figures and the refill countdown; one row per craft — flying covered, flying
//      uncovered, idle, in a bay, queued, idle with early maintenance allowed — each with its own state text.
//   3. DROIDS: a block per droidUpkeep system with its figures.
//   4. EMPTY STATES: no craft; no deployed droid.
//   5. THE CONTROLS: the exact action shapes; the engine's refusal shown; a success not shown until the next snapshot;
//      input hygiene (a whole number) only.
//   6. NO CLIENT ARITHMETIC: change one snapshot field, and exactly the figure that reads it changes.
//   7. NOTICES: the four maintenance notices and droids_spent, word for word; a cut-short entry names its destination
//      and a queued one its position; the 'maintenance' lane-end reason in Operations' strip.
//   8. FOG: only the player's own guild is drawn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { validateAction, applyAction } = require('../actions.js');
const { getSystem } = require('../seed.js');
const F = require('./maintenance-tab-fixtures.js');
const seed = require('../../data/seed.json');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');

// ---- the page's own code, cut out of game.html ------------------------------------------------------------------

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m;
}
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script')[1];
const deployWireSrc = cut(html, /<script id="deploy-kit-wire">([\s\S]*?)<\/script>/, 'the deploy popup script')[1];
const opsScript = cut(html, /<script id="operations-tab-wire">([\s\S]*?)<\/script>/, 'the Operations script')[1];
// Slice 6: the tab and Operations format condition, and the tab draws its Deep maintenance button, through the page's
// shared helpers — so the sandbox loads them first, as the page does.
const sharedMaintSrc = cut(html, /<script id="craft-maintenance-shared">([\s\S]*?)<\/script>/, 'the craft-maintenance shared helpers')[1];
// The Maintenance tab's script without its IIFE wrapper, so its state `M` and its functions (onSend) can be reached.
const maintSrc = cut(html, /<script id="maintenance-tab-wire">\n\(function\(\)\{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/, 'the Maintenance script')[1];
// The shell's tab switching: hideOverlayPanels, openTab and closeTab, as the page has them.
const shellTabsSrc = cut(html, /\nfunction hideOverlayPanels\(tp\)\{[\s\S]*?\nwindow\.closeTab = function\(\)\{[\s\S]*?\n\};\n/, 'the shell\'s tab switching')[0];
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
const guildHelpersSrc = cut(guildScript, /\n {2}function el\(id\)\{[\s\S]*?(?=\n {2}function pad4\()/, 'the Guild Hall helpers')[0];
const prettyGoodSrc = cut(guildScript, /\n {2}function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood')[0];
const noticeSrc = cut(guildScript, /\n {2}\/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n {2}function centreFor\()/, 'the notice code')[0];
const fmtEtaSrc = cut(html, /\n {2}function fmtETA\(ticks\) \{\n[\s\S]*?\n {2}\}\n/, 'the map\'s fmtETA')[0];
const countWordsSrc = cut(html, /\nfunction countWords\(n, one, many\)\{[^\n]*\n/, 'countWords')[0];
// The two bridges the page shares them through, in their own scope (as in the browser).
const bridgesSrc = `(function(){\n${fmtEtaSrc}${countWordsSrc}window.__fmtETA = fmtETA;\nwindow.__countWords = countWords;\n})();\n`;

// ---- real engine output ------------------------------------------------------------------------------------------

const FLEET = F.fleet();
const DROIDS = F.droids();
const NOTICES = F.notices();
const viewOf = (s, guildId = 'g1') => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
const meOf = (snap, guildId = 'g1') => snap.guilds.find((g) => g.id === guildId);
const clone = (x) => JSON.parse(JSON.stringify(x));
const unescape = (s) => s.replace(/&mdash;/g, '—').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const sysName = (id) => (getSystem(id) ? getSystem(id).name : id);
const outpostName = (id) => `${id} (name)`;   // the stub's resolver, so a drawn Outpost name is recognisable
// An independent copy of the formatter's rule (1 tick = 1 minute), to state expected times without the page's code.
function eta(t) {
  const d = Math.floor(t / 1440); const h = Math.floor((t % 1440) / 60); const m = t % 60;
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d > 0 ? `${d}d ${p(h)}h` : (h > 0 ? `${h}h ${p(m)}m` : `${m}m`);
}
function landmarkNameAt(q, r) {
  const on = (x) => x.coords && x.coords.q === q && x.coords.r === r;
  const hit = seed.systems.find(on) || seed.outposts.find(on);
  return hit ? hit.name : null;
}

// ---- the page, on a stub DOM -----------------------------------------------------------------------------------

function stubNode(id) {
  const classes = new Set();
  let inner = '';
  return {
    id, textContent: '', style: {}, hidden: false, writes: 0, listeners: {},
    get innerHTML() { return inner; },
    set innerHTML(v) { inner = v; this.writes += 1; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelectorAll: () => [],
    getAttribute: () => null,
  };
}
// The bar's buttons, in the page's own order, as stubs openTab can mark active.
const TAB_KEYS = [...html.matchAll(/<button class="rtab[^"]*"[^>]*onclick="openTab\('([a-z]+)', this\)">/g)].map((m) => m[1]);

// tabPage(snapshot, opts) -> the shell's tab switching, the Operations hub and the Maintenance tab, running for the
// player `g1` on a stub DOM. `send` answers __sendAction (default: accept); `sent` records every action posted and
// `refreshes` every __refreshNow. `poll(next)` is the shell's next poll on a new snapshot.
function tabPage(snapshot, { guildId = 'g1', send } = {}) {
  let current = snapshot;
  const nodes = {};
  const node = (id) => nodes[id] || (nodes[id] = stubNode(id));
  const tabs = TAB_KEYS.map((k) => { const b = stubNode(`rtab:${k}`); b.key = k; return b; });
  const sent = [];
  let refreshes = 0;
  const sandbox = {
    document: {
      getElementById: node,
      addEventListener() {},
      querySelectorAll: (sel) => (sel === '.rtab' ? tabs : []),
      querySelector: (sel) => (sel === '.rtab' ? tabs[0] : null),
      activeElement: null,
    },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => current,
      __systemName: sysName,
      __outpostName: outpostName,
      __landmarkNameAt: landmarkNameAt,
      // The action as it would cross the wire (JSON), so it is a plain object of this realm, not the sandbox's.
      __sendAction: (a) => { const wire = clone(a); sent.push(wire); return Promise.resolve(send ? send(wire) : { accepted: true }); },
      __refreshNow: () => { refreshes += 1; return Promise.resolve(); },
    },
    Promise,
  };
  sandbox.window.openTab = null;
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + sharedMaintSrc + kitKindsSrc + opsScript, sandbox);
  vm.runInContext(deployWireSrc, sandbox);
  vm.runInContext(maintSrc + shellTabsSrc, sandbox);
  return {
    page: sandbox,
    node,
    tabs,
    sent,
    refreshes: () => refreshes,
    open: () => sandbox.openTab('maintenance', tabs[TAB_KEYS.indexOf('maintenance')]),
    poll: (next) => { current = next; sandbox.window.__maintRefresh(); sandbox.window.__opsRefresh(); },
    fleet: () => node('mt-fleet').innerHTML,
    droids: () => node('mt-droids').innerHTML,
    type: (key, value) => { sandbox.M.drafts[key] = value; },
    press: (key) => sandbox.onSend(key),
  };
}

// ---- reading what is drawn --------------------------------------------------------------------------------------

const COLS = ['craft', 'where', 'condition', 'state', 'flightLeft', 'deep'];   // 'deep': slice 6's Deep maintenance column
const text = (cell) => unescape(cell.replace(/<\/span><span[^>]*>/g, ' + ').replace(/<[^>]*>/g, ''));
// drawn(page) -> every figure on the tab, keyed by where it stands: 'fig:<label>' (the pool's figures),
// '<craftId>:<column>' (a craft row's cells), '<systemId>:<label>' (a droid block's rows).
function drawn(p) {
  const out = {};
  for (const m of p.fleet().matchAll(/<div class="k">([^<]*)<\/div><div class="v">([^<]*)<\/div>/g)) out[`fig:${m[1]}`] = unescape(m[2]);
  for (const m of p.fleet().matchAll(/<tr data-craft="([^"]*)">([\s\S]*?)<\/tr>/g)) {
    [...m[2].matchAll(/<td>([\s\S]*?)<\/td>/g)].forEach((c, i) => { out[`${m[1]}:${COLS[i]}`] = text(c[1]); });
  }
  for (const b of p.droids().split('<div class="mt-sys" data-system="').slice(1)) {
    const sys = b.slice(0, b.indexOf('"'));
    for (const m of b.matchAll(/<div class="mt-kv"><span class="k">([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)) out[`${sys}:${m[1]}`] = unescape(m[2]);
  }
  return out;
}
const changed = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).sort();

// ---- 1. the tab -------------------------------------------------------------------------------------------------

test('tab: the bar\'s Maintenance button sits right after Operations, and opens a full-viewport panel', () => {
  const i = TAB_KEYS.indexOf('operations');
  assert.equal(TAB_KEYS[i + 1], 'maintenance', `the bar reads ${TAB_KEYS.join(', ')}`);
  assert.match(html, /<button class="rtab" onclick="openTab\('maintenance', this\)">Maintenance<\/button>/);
  assert.match(html, /<div id="tp-maint">/);
  // Fills the viewport as Operations does: the overlay stops scrolling, the panel scrolls itself.
  assert.match(html, /#tabPanel\.maint\{overflow:hidden;\}/);
});

test('tab: it opens from the bar and draws; a poll while open redraws; another tab or Close hides it and stops the redraws', () => {
  const snap = viewOf(FLEET.s);
  const p = tabPage(snap);
  assert.equal(p.fleet(), '', 'nothing is drawn before it opens');
  p.open();
  const panel = p.node('tp-maint'); const overlay = p.node('tabPanel');
  assert.ok(panel.classList.contains('show') && overlay.classList.contains('show') && overlay.classList.contains('maint'));
  assert.ok(p.tabs[TAB_KEYS.indexOf('maintenance')].classList.contains('active'), 'its button is the active one');
  assert.ok(p.fleet().includes('<div class="k">Pool</div>'), 'the Fleet half is drawn on open');
  assert.ok(p.droids().length > 0, 'the Droids half is drawn on open');
  // A poll with the next tick redraws (the countdowns run) …
  const before = p.node('mt-fleet').writes;
  const next = clone(snap); next.tick += 1;
  p.poll(next);
  assert.equal(p.node('mt-fleet').writes, before + 1);
  // … and a poll that moves nothing writes nothing, so a field being typed in is not replaced under the cursor.
  p.poll(clone(next));
  assert.equal(p.node('mt-fleet').writes, before + 1);
  // Another tab hides it cleanly: the panel, the overlay's class, and no more redraws.
  p.page.openTab('operations', p.tabs[TAB_KEYS.indexOf('operations')]);
  assert.equal(panel.classList.contains('show'), false);
  assert.equal(overlay.classList.contains('maint'), false);
  assert.ok(p.node('tp-ops').classList.contains('show'));
  const writes = p.node('mt-fleet').writes;
  const later = clone(next); later.tick += 5;
  p.poll(later);
  assert.equal(p.node('mt-fleet').writes, writes, 'closed: a poll does not redraw it');
  // Reopen, then Close.
  p.open();
  assert.ok(panel.classList.contains('show'));
  p.page.window.closeTab();
  assert.equal(panel.classList.contains('show'), false);
  assert.equal(overlay.classList.contains('show'), false);
  assert.equal(p.page.M.open, false);
});

// ---- 2. Fleet ---------------------------------------------------------------------------------------------------

test('fleet: the pool, its three figures and the refill countdown, each the snapshot\'s', () => {
  const snap = viewOf(FLEET.s);
  const pool = meOf(snap).craftMaintenance;
  assert.deepEqual(pool, { pool: 2, budget: 500, ceiling: pool.ceiling, spentLastCycle: 0, nextRefillTick: 1440 }, 'premise');
  const p = tabPage(snap); p.open();
  const d = drawn(p);
  assert.equal(d['fig:Pool'], '2');
  assert.equal(d['fig:Budget'], '500');
  assert.equal(d['fig:Ceiling'], pool.ceiling.toLocaleString('en-US'));
  assert.equal(d['fig:Spent last cycle'], '0');
  assert.equal(d['fig:Next refill'], eta(1440 - snap.tick));
  // Labelled so over- or under-funding reads off them.
  for (const words of ['every craft flying the whole cycle', 'moved in at each refill', 'what the pool actually paid']) {
    assert.ok(p.fleet().includes(words), words);
  }
  // The two controls; no withdraw control (ruled).
  assert.ok(p.fleet().includes('data-mt-field="budget"') && p.fleet().includes('data-mt-field="topup"'));
  assert.equal(/withdraw/i.test(p.fleet()), false);
});

test('fleet: one row per craft, each with its own state — covered, uncovered, idle, in a bay, queued, early allowed', () => {
  const snap = viewOf(FLEET.s);
  const rows = Object.fromEntries(meOf(snap).vehicles.map((v) => [v.id, v]));
  const p = tabPage(snap); p.open();
  const d = drawn(p);
  const ids = [...p.fleet().matchAll(/<tr data-craft="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(ids, Object.keys(rows).sort(), 'one row per craft of the guild\'s, by id');
  const home = sysName(F.H);
  const dest = `En route to Deep Space (${F.D.q}, ${F.D.r})`;
  const cm = (id) => rows[id].craftMaintenance;
  // Flying, covered: maintained, and its flight time at the maintained rate. RE-PINNED, slice 6: it has flown one tick,
  // so it is a hair under 100% — slice 5 rounded that to "100%", the one display rule (rounded down) reads "99%".
  assert.equal(cm(FLEET.slow).covered, true, 'premise');
  assert.ok(rows[FLEET.slow].maintenanceCondition < 1 && rows[FLEET.slow].maintenanceCondition > 0.99, 'premise: just under 100%');
  assert.deepEqual([d[`${FLEET.slow}:craft`], d[`${FLEET.slow}:where`], d[`${FLEET.slow}:condition`], d[`${FLEET.slow}:state`], d[`${FLEET.slow}:flightLeft`]],
    ['Light Transport #09', dest, '99%', 'Maintained', `${eta(cm(FLEET.slow).flightTicksLeftMaintained)} (maintained)`]);
  // Flying, uncovered: wearing fast, at the unmaintained rate. RE-PINNED, slice 6: it left at 50% and has flown a tick,
  // so it is a hair under — slice 5 rounded that to "50%", rounded down it reads "49%".
  assert.equal(cm(FLEET.worn).covered, false, 'premise');
  assert.ok(rows[FLEET.worn].maintenanceCondition < 0.5 && rows[FLEET.worn].maintenanceCondition > 0.49, 'premise: just under 50%');
  assert.deepEqual([d[`${FLEET.worn}:where`], d[`${FLEET.worn}:condition`], d[`${FLEET.worn}:state`], d[`${FLEET.worn}:flightLeft`]],
    [dest, '49%', 'Wearing fast — not covered', `${eta(cm(FLEET.worn).flightTicksLeftUnmaintained)} (unmaintained)`]);
  // Idle: no wear, both rates.
  assert.deepEqual([d[`${FLEET.idle}:where`], d[`${FLEET.idle}:state`], d[`${FLEET.idle}:flightLeft`]],
    [home, 'Not flying — no wear', `${eta(80_640)} maintained · ${eta(40_320)} unmaintained`]);
  // In a bay: ready in (ready tick less the snapshot's tick), named by its point — the Outpost, not its bare hex.
  for (const id of FLEET.bays) {
    assert.deepEqual([d[`${id}:where`], d[`${id}:condition`], d[`${id}:state`], d[`${id}:flightLeft`]],
      [outpostName(F.OUTPOST), '0%', `In deep maintenance — ready in ${eta(930 - snap.tick)}`, '—']);
  }
  // Queued: its position.
  assert.equal(d[`${FLEET.queued}:state`], 'Queued for a maintenance bay (position 1)');
  assert.equal(d[`${FLEET.queued}:where`], outpostName(F.OUTPOST));
  // Idle at 10% at HOME: early maintenance allowed. RE-PINNED, slice 6 (RULED 10-11-26): slice 5's plain text "Early deep
  // maintenance available" is now the row's enabled Deep maintenance button (sim/tests/maintenance-slice6-client.test.js
  // covers the button); the state cell reads as any idle craft's.
  assert.equal(cm(FLEET.low).earlyMaintenanceAllowed, true, 'premise');
  assert.equal(d[`${FLEET.low}:state`], 'Not flying — no wear');
  assert.equal(d[`${FLEET.low}:condition`], '10%');
  assert.equal(d[`${FLEET.low}:deep`], 'Deep maintenance');
  assert.equal(Object.keys(rows).filter((id) => cm(id).earlyMaintenanceAllowed).length, 1, 'only that one');
  assert.equal(p.fleet().split('Early deep maintenance available').length - 1, 0, 'slice 5\'s text is gone');
});

// ---- 3. Droids --------------------------------------------------------------------------------------------------

test('droids: one block per droidUpkeep system, with its figures and its reserve control', () => {
  const snap = viewOf(DROIDS.s);
  const upkeep = meOf(snap).droidUpkeep;
  assert.deepEqual(Object.keys(upkeep).sort(), [DROIDS.home, DROIDS.second].sort(), 'premise: two systems');
  const p = tabPage(snap); p.open();
  const d = drawn(p);
  const blocks = [...p.droids().matchAll(/<div class="mt-sys" data-system="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(blocks, Object.keys(upkeep).sort());
  for (const sys of blocks) {
    const u = upkeep[sys];
    assert.ok(p.droids().includes(`<div class="nm">${sysName(sys)}</div>`), 'the system\'s name');
    assert.deepEqual({
      stock: d[`${sys}:Droid components in stock`], reserve: d[`${sys}:Reserve (kept for building)`],
      need: d[`${sys}:Weekly need`], maintained: d[`${sys}:Maintained`], fast: d[`${sys}:Wearing fast`],
      runway: d[`${sys}:Runway`], next: d[`${sys}:Next weekly upkeep`],
    }, {
      stock: String(u.stock), reserve: String(u.reserve), need: `${u.weeklyUpkeep} a week`, maintained: String(u.maintained),
      fast: String(u.unmaintained), runway: `${u.runwayWeeks} ${u.runwayWeeks === 1 ? 'week' : 'weeks'}`, next: eta(u.nextUpkeepTick - snap.tick),
    });
    assert.ok(p.droids().includes(`data-mt-field="reserve:${sys}"`), 'its reserve field');
  }
  assert.equal(d[`${DROIDS.home}:Reserve (kept for building)`], '2', 'the reserve set through the action');
  assert.ok(p.droids().includes('Keep this many for building'));
});

// ---- 4. empty states --------------------------------------------------------------------------------------------

test('empty states: a guild with no craft says so; so does one with no deployed droid', () => {
  const p = tabPage(viewOf(DROIDS.s)); p.open();   // the droid galaxy: g1 has no craft
  assert.equal(meOf(viewOf(DROIDS.s)).vehicles.length, 0, 'premise');
  assert.ok(p.fleet().includes('<div class="mt-empty">Your guild has no craft.</div>'));
  assert.equal(p.fleet().includes('<tr data-craft='), false);
  // No craft and no pool record: no readout, so every figure reads "—" — none is made up.
  assert.equal(meOf(viewOf(DROIDS.s)).craftMaintenance, undefined, 'premise: no readout');
  const d = drawn(p);
  for (const k of ['Pool', 'Budget', 'Ceiling', 'Spent last cycle', 'Next refill']) assert.equal(d[`fig:${k}`], '—', k);
  const q = tabPage(viewOf(FLEET.s)); q.open();    // the fleet galaxy: g1 has no droids
  assert.equal(meOf(viewOf(FLEET.s)).droidUpkeep, undefined, 'premise');
  assert.equal(q.droids(), '<div class="mt-empty">No system has a deployed droid.</div>');
});

// ---- 5. the controls --------------------------------------------------------------------------------------------

// engineSend(state) -> an __sendAction answer that is the real engine's: validate, and apply on accept (kept in
// `applied`, so the test can build the NEXT snapshot from it). The page never sees `applied` until the test polls.
function engineSend(state) {
  const box = { applied: state };
  box.send = (action) => {
    const { valid, reason } = validateAction(box.applied, action);
    if (valid) box.applied = applyAction(box.applied, action);
    return { accepted: valid, reason: valid ? null : reason };
  };
  return box;
}

test('controls: budget, top-up and reserve post exactly the engine\'s action shapes, which the engine accepts', async () => {
  const fleetBox = engineSend(FLEET.s);
  const p = tabPage(viewOf(FLEET.s), { send: fleetBox.send }); p.open();
  p.type('budget', '250'); await p.press('budget');
  p.type('topup', ' 40 '); await p.press('topup');
  assert.deepEqual(p.sent, [
    { type: 'setCraftMaintenanceBudget', guildId: 'g1', budget: 250 },
    { type: 'topUpCraftMaintenancePool', guildId: 'g1', amount: 40 },
  ]);
  assert.equal(p.fleet().includes('Refused'), false, 'both accepted');
  const droidBox = engineSend(DROIDS.s);
  const q = tabPage(viewOf(DROIDS.s), { send: droidBox.send }); q.open();
  q.type(`reserve:${DROIDS.second}`, '3'); await q.press(`reserve:${DROIDS.second}`);
  assert.deepEqual(q.sent, [{ type: 'setDroidComponentReserve', guildId: 'g1', systemId: DROIDS.second, reserve: 3 }]);
  assert.equal(q.droids().includes('Refused'), false);
});

test('controls: a success is not shown until the next snapshot — then the new figure is the snapshot\'s', async () => {
  const box = engineSend(FLEET.s);
  const p = tabPage(viewOf(FLEET.s), { send: box.send }); p.open();
  p.type('budget', '250'); await p.press('budget');
  p.type('topup', '40'); await p.press('topup');
  assert.equal(p.refreshes(), 2, 'each success asks the shell for the next snapshot');
  assert.deepEqual([drawn(p)['fig:Budget'], drawn(p)['fig:Pool']], ['500', '2'], 'unchanged: the client adjusted nothing');
  assert.ok(p.fleet().includes('data-mt-field="budget" value=""'), 'the field is cleared');
  p.poll(viewOf(box.applied));
  assert.deepEqual([drawn(p)['fig:Budget'], drawn(p)['fig:Pool']], ['250', '42'], 'the next snapshot\'s figures');
  // The reserve the same way.
  const dbox = engineSend(DROIDS.s);
  const q = tabPage(viewOf(DROIDS.s), { send: dbox.send }); q.open();
  q.type(`reserve:${DROIDS.home}`, '5'); await q.press(`reserve:${DROIDS.home}`);
  assert.equal(drawn(q)[`${DROIDS.home}:Reserve (kept for building)`], '2');
  q.poll(viewOf(dbox.applied));
  assert.equal(drawn(q)[`${DROIDS.home}:Reserve (kept for building)`], '5');
});

test('controls: a refusal shows the engine\'s own reason, until the tick moves on', async () => {
  const box = engineSend(FLEET.s);
  const p = tabPage(viewOf(FLEET.s), { send: box.send }); p.open();
  const tooMuch = { type: 'topUpCraftMaintenancePool', guildId: 'g1', amount: 99_999_999 };
  const { valid, reason } = validateAction(FLEET.s, tooMuch);
  assert.equal(valid, false, 'premise: the engine refuses a top-up above the credits');
  p.type('topup', '99999999'); await p.press('topup');
  assert.deepEqual(p.sent, [tooMuch]);
  assert.ok(p.fleet().includes(`<div class="mt-msg">Refused: ${reason.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</div>`), 'the engine\'s reason, verbatim');
  assert.ok(p.fleet().includes('data-mt-field="topup" value="99999999"'), 'the draft is kept to correct');
  assert.equal(box.applied, FLEET.s, 'nothing applied');
  const next = viewOf(FLEET.s); next.tick += 1;
  p.poll(next);
  assert.equal(p.fleet().includes('Refused'), false, 'gone once the tick moves on');
});

test('controls: only "is a whole number" is checked here — anything else is sent nowhere', async () => {
  const p = tabPage(viewOf(FLEET.s)); p.open();
  for (const bad of ['', 'abc', '1.5', '-3', '1e3', '99999999999999999999']) {
    p.type('budget', bad); await p.press('budget');
    assert.ok(p.fleet().includes('<div class="mt-msg">Enter a whole number.</div>'), JSON.stringify(bad));
  }
  assert.deepEqual(p.sent, []);
  // 0 is a whole number: it goes to the engine (which accepts it as "clear the budget").
  p.type('budget', '0'); await p.press('budget');
  assert.deepEqual(p.sent, [{ type: 'setCraftMaintenanceBudget', guildId: 'g1', budget: 0 }]);
});

// ---- 6. no client arithmetic ------------------------------------------------------------------------------------

// Each case changes ONE snapshot field; exactly the figures listed may change on the tab, and they must.
test('no arithmetic: change one snapshot field and exactly the figure that reads it changes', () => {
  const fleetSnap = viewOf(FLEET.s);
  const droidSnap = viewOf(DROIDS.s);
  const v = (snap, id) => meOf(snap).vehicles.find((x) => x.id === id);
  const sys = DROIDS.home;
  const cases = [
    ['pool', fleetSnap, (s) => { meOf(s).craftMaintenance.pool = 98_765; }, ['fig:Pool']],
    ['budget', fleetSnap, (s) => { meOf(s).craftMaintenance.budget = 4_321; }, ['fig:Budget']],
    ['ceiling', fleetSnap, (s) => { meOf(s).craftMaintenance.ceiling = 7; }, ['fig:Ceiling']],
    ['spentLastCycle', fleetSnap, (s) => { meOf(s).craftMaintenance.spentLastCycle = 11; }, ['fig:Spent last cycle']],
    ['nextRefillTick', fleetSnap, (s) => { meOf(s).craftMaintenance.nextRefillTick += 60; }, ['fig:Next refill']],
    ['maintenanceCondition', fleetSnap, (s) => { v(s, FLEET.idle).maintenanceCondition = 0.37; }, [`${FLEET.idle}:condition`]],
    ['flightTicksLeftMaintained', fleetSnap, (s) => { v(s, FLEET.idle).craftMaintenance.flightTicksLeftMaintained = 90; }, [`${FLEET.idle}:flightLeft`]],
    ['flightTicksLeftUnmaintained', fleetSnap, (s) => { v(s, FLEET.worn).craftMaintenance.flightTicksLeftUnmaintained = 45; }, [`${FLEET.worn}:flightLeft`]],
    ['covered', fleetSnap, (s) => { v(s, FLEET.worn).craftMaintenance.covered = true; }, [`${FLEET.worn}:flightLeft`, `${FLEET.worn}:state`]],
    ['readyTick', fleetSnap, (s) => { v(s, FLEET.bays[0]).craftMaintenance.deepMaintenance.readyTick += 5; }, [`${FLEET.bays[0]}:state`]],
    ['queuePosition', fleetSnap, (s) => { v(s, FLEET.queued).craftMaintenance.deepMaintenance.queuePosition = 4; }, [`${FLEET.queued}:state`]],
    ['deepMaintenance.point', fleetSnap, (s) => { v(s, FLEET.bays[0]).craftMaintenance.deepMaintenance.point = { kind: 'system', systemId: F.H }; }, [`${FLEET.bays[0]}:where`]],
    // RE-PINNED, slice 6: the flag now drives the Deep maintenance column (the button), not the state text.
    ['earlyMaintenanceAllowed', fleetSnap, (s) => { v(s, FLEET.low).craftMaintenance.earlyMaintenanceAllowed = false; }, [`${FLEET.low}:deep`]],
    ['location', fleetSnap, (s) => { v(s, FLEET.idle).location = { landmarkKind: 'system', landmarkId: DROIDS.second }; }, [`${FLEET.idle}:where`]],
    ['class', fleetSnap, (s) => { v(s, FLEET.idle)['class'] = 'spycraft'; }, [`${FLEET.idle}:craft`]],
    ['tick', fleetSnap, (s) => { s.tick += 1; }, ['fig:Next refill', ...FLEET.bays.map((id) => `${id}:state`)]],
    ['stock', droidSnap, (s) => { meOf(s).droidUpkeep[sys].stock = 70; }, [`${sys}:Droid components in stock`]],
    ['reserve', droidSnap, (s) => { meOf(s).droidUpkeep[sys].reserve = 9; }, [`${sys}:Reserve (kept for building)`]],
    ['weeklyUpkeep', droidSnap, (s) => { meOf(s).droidUpkeep[sys].weeklyUpkeep = 6; }, [`${sys}:Weekly need`]],
    ['maintained', droidSnap, (s) => { meOf(s).droidUpkeep[sys].maintained = 8; }, [`${sys}:Maintained`]],
    ['unmaintained', droidSnap, (s) => { meOf(s).droidUpkeep[sys].unmaintained = 8; }, [`${sys}:Wearing fast`]],
    ['runwayWeeks', droidSnap, (s) => { meOf(s).droidUpkeep[sys].runwayWeeks = 12; }, [`${sys}:Runway`]],
    ['nextUpkeepTick', droidSnap, (s) => { meOf(s).droidUpkeep[sys].nextUpkeepTick += 60; }, [`${sys}:Next weekly upkeep`]],
    // A week away, the countdown reads in days and hours, so the tick moves by two hours to show in it.
    ['droid tick', droidSnap, (s) => { s.tick += 120; }, Object.keys(meOf(droidSnap).droidUpkeep).map((x) => `${x}:Next weekly upkeep`).sort()],
  ];
  for (const [field, base, mutate, expected] of cases) {
    const p = tabPage(base); p.open();
    const before = drawn(p);
    const next = clone(base); mutate(next);
    p.poll(next);
    assert.deepEqual(changed(before, drawn(p)), [...expected].sort(), `changing ${field} moves exactly ${expected.join(', ')}`);
  }
});

// ---- 7. notices -------------------------------------------------------------------------------------------------

function noticePage(snapshot) {
  const nodes = {};
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stubNode(id)) },
    window: {
      __player: () => ({ guildId: 'g1' }),
      __snapshot: () => snapshot,
      __sendAction: () => Promise.resolve({ accepted: true }),
      __refreshNow: () => Promise.resolve(),
      __systemName: sysName,
      __outpostName: outpostName,
      __landmarkNameAt: landmarkNameAt,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgesSrc + kitKindsSrc + guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const el = (id) => sandbox.document.getElementById(id);
  return {
    // open(n) -> the card as drawn: who speaks, the title, the paragraphs, the facts, the buttons.
    open(n) {
      sandbox.openNotice(n.id);
      return {
        speaker: el('noticeEyebrow').textContent,
        art: el('noticeArt').style.backgroundImage,
        title: el('noticeTitle').textContent,
        row: unescape(sandbox.noticeRowTitle(n).replace(/<[^>]*>/g, '')),
        body: [...el('noticeBody').innerHTML.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => unescape(m[1])),
        facts: [...el('noticeFacts').innerHTML.matchAll(/<span class="k">([^<]*)<\/span><span class="v">([^<]*)<\/span>/g)].map((m) => [unescape(m[1]), unescape(m[2])]),
        buttons: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].filter((id) => !el(id).hidden),
      };
    },
  };
}
const PILOT = 'Fleet — Dispatch';
const SYNDICATE = 'Syndicate Notice';
const eventsIn = (snap, type) => meOf(snap).events.filter((e) => e.type === type);
const label = (id) => { const parts = id.split('_'); return `${parts[2].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase())} · #${parts[3]}`; };

test('notices: maintenance_pool_dry names the craft left uncovered and when the pool refills', () => {
  const snap = viewOf(FLEET.s);
  const [n] = eventsIn(snap, 'maintenance_pool_dry');
  assert.deepEqual(n.payload, { pool: 2, vehicleIds: [FLEET.worn], nextRefillTick: 1440 }, 'premise');
  const c = noticePage(snap).open(n);
  assert.equal(c.speaker, PILOT);
  assert.equal(c.title, 'Maintenance pool dry — 1 craft uncovered');
  assert.equal(c.row, c.title);
  assert.deepEqual(c.body, [
    `The maintenance pool could not pay for every craft in flight, so ${label(FLEET.worn)} is wearing at the fast, unmaintained rate.`,
    `The pool refills from your budget in ${eta(1440 - n.tick)}. To cover them sooner, top it up from the Maintenance tab.`,
  ]);
  assert.deepEqual(c.facts, [['Pool left', '2 credits'], ['Uncovered', 'Heavy Transport · #10'], ['Next refill', `in ${eta(1440 - n.tick)}`], ['Ran dry', `Day ${n.whenDay}`]]);
  assert.deepEqual(c.buttons, [], 'passive: Dismiss alone');
});

test('notices: craft_reached_zero, and deep maintenance entered — at 0%, cut short naming its destination, early', () => {
  const snap = viewOf(NOTICES.entered);
  const page = noticePage(snap);
  const home = sysName(F.H);
  const zero = eventsIn(snap, 'craft_reached_zero').find((e) => e.payload.craftId === NOTICES.cut);
  let c = page.open(zero);
  assert.equal(c.speaker, PILOT);
  assert.equal(c.title, `Craft at 0% — ${label(NOTICES.cut)}`);
  assert.deepEqual(c.body, [`${label(NOTICES.cut)} has worn down to 0%. It flies on, and goes into deep maintenance at the first maintenance point it stops at — a system you hold, or one of your Outposts.`]);
  assert.deepEqual(c.facts, [['Craft', label(NOTICES.cut)], ['Reached 0%', `Day ${zero.whenDay}`]]);
  // Cut short: where it had been heading — a bare hex, named as Operations names one.
  const entered = (id) => eventsIn(snap, 'deep_maintenance_entered').find((e) => e.payload.craftId === id);
  const cutShort = entered(NOTICES.cut);
  assert.equal(cutShort.payload.tripCutShort, true, 'premise');
  const destination = `Deep Space (${F.D.q}, ${F.D.r})`;
  c = page.open(cutShort);
  assert.equal(c.title, `In deep maintenance — ${label(NOTICES.cut)}`);
  assert.deepEqual(c.body, [
    `${label(NOTICES.cut)} reached ${home} at 0% and has gone into deep maintenance. It will be back at 100% in ${eta(720)}.`,
    `It was on its way to ${destination}. The rest of that trip was dropped.`,
  ]);
  assert.deepEqual(c.facts, [['Craft', label(NOTICES.cut)], ['At', home], ['Ready in', eta(720)], ['Was heading to', destination], ['Entered', `Day ${cutShort.whenDay}`]]);
  // On a lane: no cut-short line (its lane end is the record).
  c = page.open(entered(NOTICES.laned));
  assert.deepEqual(c.body, [`${label(NOTICES.laned)} reached ${home} at 0% and has gone into deep maintenance. It will be back at 100% in ${eta(720)}.`]);
  // Early: the player asked.
  const early = entered(NOTICES.early);
  assert.equal(early.payload.early, true, 'premise');
  c = page.open(early);
  assert.deepEqual(c.body, [`${label(NOTICES.early)} has gone into deep maintenance early at ${home}, as you asked. It will be back at 100% in ${eta(early.payload.readyTick - early.tick)}.`]);
  assert.deepEqual(c.buttons, []);
});

test('notices: a queued entry names its position; a finished one says it is back at 100%', () => {
  const fleetSnap = viewOf(FLEET.s);
  const queued = eventsIn(fleetSnap, 'deep_maintenance_entered').find((e) => e.payload.bay === false);
  assert.equal(queued.payload.queuePosition, 1, 'premise');
  let c = noticePage(fleetSnap).open(queued);
  const at = outpostName(F.OUTPOST);
  assert.equal(c.title, `Queued for maintenance — ${label(FLEET.queued)}`);
  assert.deepEqual(c.body, [`${label(FLEET.queued)} reached ${at} at 0%, but every maintenance bay there is taken. It is waiting in the queue, position 1, and cannot fly or unload until it has been through maintenance.`]);
  assert.deepEqual(c.facts, [['Craft', label(FLEET.queued)], ['At', at], ['Queue position', '1'], ['Entered', `Day ${queued.whenDay}`]]);
  // A different position reads through.
  const moved = clone(fleetSnap);
  eventsIn(moved, 'deep_maintenance_entered').find((e) => e.payload.bay === false).payload.queuePosition = 3;
  assert.ok(noticePage(moved).open(queued).body[0].includes('position 3,'));
  const snap = viewOf(NOTICES.finished);
  const done = eventsIn(snap, 'deep_maintenance_finished').find((e) => e.payload.craftId === NOTICES.cut);
  c = noticePage(snap).open(done);
  assert.equal(c.speaker, PILOT);
  assert.equal(c.title, `Maintenance finished — ${label(NOTICES.cut)}`);
  assert.deepEqual(c.body, [`${label(NOTICES.cut)} is out of deep maintenance at ${sysName(F.H)}, back at 100% and ready to fly.`]);
  assert.deepEqual(c.facts, [['Craft', label(NOTICES.cut)], ['At', sysName(F.H)], ['Finished', `Day ${done.whenDay}`]]);
});

test('notices: droids_spent — the Syndicate adviser, the count and the system', () => {
  const snap = viewOf(DROIDS.s);
  const [n] = eventsIn(snap, 'droids_spent');
  const name = n.payload.systemName;
  const c = noticePage(snap).open(n);
  assert.equal(c.speaker, SYNDICATE);
  assert.equal(c.title, `Droids spent — ${name}`);
  assert.deepEqual(c.body, [
    `1 droid wore out at ${name} and was destroyed.`,
    'A droid kept maintained from its system\'s droid components lasts longer. The Maintenance tab shows each system\'s stock and runway.',
  ]);
  assert.deepEqual(c.facts, [['System', name], ['Droids spent', '1'], ['Spent', `Day ${n.whenDay}`]]);
  // Two spent: plural.
  const two = clone(snap);
  eventsIn(two, 'droids_spent')[0].payload.spent.push({ droidId: 'asset_g1_droid_99', source: 'guild', ventureId: 'm' });
  assert.equal(noticePage(two).open(n).body[0], `2 droids wore out at ${name} and were destroyed.`);
});

test('lane end: a lane ended for maintenance reads in words in Operations\' strip, not the raw reason', () => {
  const snap = viewOf(NOTICES.entered);
  assert.deepEqual(meOf(snap).vehicles.find((x) => x.id === NOTICES.laned).laneEnded, { reason: 'maintenance', tick: 210 }, 'premise');
  const p = tabPage(snap);
  p.page.window.__opsOpen();
  const strip = unescape(p.node('ops-lane-notices').innerHTML);
  assert.ok(strip.includes(`Light #${NOTICES.laned.split('_')[3]}'s lane stopped at ${sysName(F.H)} — the craft went into deep maintenance.`), strip);
  assert.equal(strip.includes('— maintenance.'), false);
});

// ---- 8. fog -----------------------------------------------------------------------------------------------------

test('fog: only the player\'s own guild is drawn — a rival\'s pool, craft and droids never appear', () => {
  // The real views: g2's own tab shows its own (empty) fleet, none of g1's craft.
  const rivalView = viewOf(FLEET.s, 'g2');
  const p = tabPage(rivalView, { guildId: 'g2' }); p.open();
  assert.ok(p.fleet().includes('Your guild has no craft.'));
  for (const id of [...FLEET.bays, FLEET.slow, FLEET.worn]) assert.equal(p.fleet().includes(id), false, id);
  assert.equal(drawn(p)['fig:Pool'], '—');
  // And were a rival's row ever to carry these fields, g1's tab would still not draw them.
  const snap = viewOf(FLEET.s);
  const rival = snap.guilds.find((g) => g.id === 'g2');
  rival.craftMaintenance = { pool: 777_777, budget: 1, ceiling: 1, spentLastCycle: 1, nextRefillTick: 1440 };
  rival.vehicles = [{ ...clone(meOf(snap).vehicles[0]), id: 'vehicle_g2_spycraft_77' }];
  rival.droidUpkeep = { [DROIDS.second]: { stock: 1, reserve: 0, weeklyUpkeep: 1, maintained: 1, unmaintained: 0, runwayWeeks: 1, nextUpkeepTick: 10_080 } };
  const q = tabPage(snap); q.open();
  assert.equal(q.fleet().includes('777,777'), false);
  assert.equal(q.fleet().includes('vehicle_g2_spycraft_77'), false);
  assert.equal(q.droids(), '<div class="mt-empty">No system has a deployed droid.</div>');
  assert.equal(drawn(q)['fig:Pool'], '2', 'its own pool');
});
