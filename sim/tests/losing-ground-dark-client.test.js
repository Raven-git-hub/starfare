'use strict';

// losing-ground-dark-client.test.js — losing ground, client slice 3, the CLIENT half: a DARK Deep Scan Array shown as
// dark (roadmap 2.5; docs/exploration-model.md §5, docs/operations-hub.md §5, docs/territory-model.md §4 / §5). The
// snapshot now carries `dark: true` on an array row whose array is not attached to its owner's control
// (dark-array-snapshot.test.js proves the field). The client reads that flag as sent — it never works the attachment
// out (design.md §18) — in three places:
//   - Operations → DEPLOYED: a dark array's state line reads "dark · touches no territory you hold" (amber), where it
//     read "idle · anchored to <system>";
//   - the galaxy map: a dark array's triangle edge is slate, not the player teal, and its tag gains a DARK line;
//   - the detail screen's redraw signature carries the flag (arraysSignature), because an array can go dark while
//     IDLE — no job to void — so a signature of id and job alone never moved (the slice-2 lesson).
// As losing-ground-ops-client.test.js does, this runs the page's OWN code, cut out of game.html, in a node:vm sandbox
// on a stub DOM, against REAL per-guild snapshots exactly as GET /snapshot?guild= sends them (dark-array-script.js):
// an eviction that darkens a scanning array and an idle one, an Outpost removed from under an idle array, and the
// re-plant that wakes them. The live map and panel in the browser are the Playwright harness's, outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { getSystem } = require('../seed.js');
const D = require('./dark-array-script.js');
const seed = require('../../data/seed.json');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

// This slice's words, verbatim from game.html. Draft copy, to be tuned (roadmap checklist).
const DARK_LINE = 'dark · touches no territory you hold';
const DARK_TAG = 'DARK';
// main's look, unchanged: a live array's edge is the player teal, col('player', 0.95).
const TEAL_EDGE = 'rgba(67,217,200,0.95)';

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

function cut(re, what) {
  const m = html.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m;
}
// maybe(re) -> a piece this slice added, or '' where it is absent (on main's game.html), so the pins below can be
// re-checked against main's client: there the slice's own tests go red, and the guard must not.
const maybe = (re) => (html.match(re) || [''])[0];

const kitKindsSrc = cut(/<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script')[1];
// The Operations hub's whole script, without its IIFE wrapper, so its own functions land at the sandbox's top level.
const opsSrc = cut(/<script id="operations-tab-wire">\n\(function\(\)\{\n([\s\S]*?)\n\}\)\(\);\n<\/script>/, 'the Operations script')[1];
// The galaxy map's array passes: the colours, the array's name, this slice's look, the marker pass and the tag pass.
const colourSrc = cut(/\n {2}const COLOR_RGB = [^\n]*\n {2}function col\(key, a\) [^\n]*\n/, 'COLOR_RGB / col')[0];
const arrayNameSrc = cut(/\n {2}function arrayMapName\(a\) \{[^\n]*\n/, 'arrayMapName')[0];
const darkLookSrc = maybe(/\n {2}const DARK_ARRAY_EDGE = [\s\S]*?\n {2}function arrayMapTag\(a\) \{[\s\S]*?\n {2}\}\n/);
const markerSrc = cut(/\n {4}const myArraysOnMap = \(window\.__myArrays && window\.__myArrays\(\)\) \|\| \[\];\n {4}myArraysOnMap\.forEach\(\(a\) => \{\n[\s\S]*?\n {4}\}\);\n/, 'the array marker pass')[0];
const tagSrc = cut(/\n {4}if \(zoom >= WAYSTATION_LABEL_ZOOM\) \{\n {6}myArraysOnMap\.forEach\(\(a\) => \{\n[\s\S]*?\n {6}\}\);\n {4}\}\n/, 'the array tag pass')[0];
// The shell (applySnapshot): its reads of what the detail screen's signature reads, and the signature itself.
const assetsReadSrc = cut(/\n {2}LIVE\.myAssets = \(me && me\.assets\) \|\| \[\];\n/, 'the shell\'s assets read')[0];
const claimsReadSrc = cut(/\n {2}LIVE\.systemClaims = \{\};\n[\s\S]*?\n {2}\}\);\n/, 'the shell\'s claims read')[0];
const knownReadSrc = cut(/\n {2}LIVE\.known = \(snap\.geography && snap\.geography\.known\) \|\| \{\};\n/, 'the shell\'s known read')[0];
const arraysReadSrc = cut(/\n {2}LIVE\.myArrays = \(snap\.deepScanArrays \|\| \[\]\)\.filter\([^\n]*\n/, 'the shell\'s arrays read')[0];
const occupancyReadSrc = cut(/\n {2}LIVE\.occupancy = snap\.occupancy \|\| \{\};\n/, 'the shell\'s occupancy read')[0];
const groundKitsSrc = cut(/\nfunction myIdleGroundKits\(\)\{\n[\s\S]*?\n\}\n/, 'myIdleGroundKits')[0];
const arraysSigSrc = maybe(/\nfunction arraysSignature\(arrays\)\{\n[\s\S]*?\n\}\n/);
const sigSrc = cut(/\n {2}var sig = Object\.keys\(LIVE\.occupancy\)[\s\S]*?\n {2}if \(sig !== LIVE\.siteSig\)\{\n[\s\S]*?\n {2}\}\n/, 'the detail screen\'s signature')[0];

// The arrays' term of that signature as main had it (at 1c28fe4), and as this slice has it — the mutation test swaps
// one for the other, to show main's would never redraw.
const MAIN_TERM = "'|' + JSON.stringify(LIVE.myArrays.map(function(a){ return [a.id, a.scan || null]; })) +";
const NEW_TERM = "'|' + arraysSignature(LIVE.myArrays) +";

// ---- real engine output ------------------------------------------------------------------------------------

const EVICTED = D.evicted();
const OUTPOST = D.outpostGone();
const REWOKEN = D.rewoken();

// The view exactly as the browser receives it.
const viewOf = (s, guildId) => JSON.parse(JSON.stringify(buildSnapshot(s, guildId)));
// stripDark(view) -> the view with every array row's `dark` key taken out: exactly main's view of the same galaxy
// (dark-array-snapshot.test.js pins that), so what the client draws from it is what main's client drew.
function stripDark(view) {
  const copy = JSON.parse(JSON.stringify(view));
  for (const row of copy.deepScanArrays || []) delete row.dark;
  return copy;
}
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const num = (id) => String(id).split('_').slice(-1)[0];
const systemName = (id) => (getSystem(id) ? getSystem(id).name : id);
const darkRows = (view) => (view.deepScanArrays || []).filter((a) => a.dark);

// ---- the Operations hub, on a stub DOM -----------------------------------------------------------------------

// The board's name for a hex, as the shell's __landmarkNameAt reads it: a system on it, else a seed waystation.
function landmarkNameAt(q, r) {
  const on = (x) => x.coords && x.coords.q === q && x.coords.r === r;
  const hit = seed.systems.find(on) || seed.outposts.find(on);
  return hit ? hit.name : null;
}
const OPS_HOSTS = ['ops-lane-notices', 'ops-transit-list', 'ops-deployed-list', 'ops-idle-list', 'ops-tp-list'];

// opsPage(snapshot, guildId) -> the Operations hub's code running for the player `guildId`, on a stub DOM that counts
// each host's innerHTML writes. `open()` opens the hub on `snapshot`; `poll(next)` is the shell's next poll.
function opsPage(snapshot, guildId) {
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
    document: { getElementById: node },
    window: {
      __player: () => ({ guildId }),
      __snapshot: () => current,
      __systemName: systemName,
      __outpostName: (id) => id,
      __landmarkNameAt: landmarkNameAt,
    },
  };
  vm.runInNewContext(kitKindsSrc + opsSrc, sandbox);
  sandbox.window.__opsOpen();
  return {
    page: sandbox,
    poll: (next) => { current = next; sandbox.window.__opsRefresh(); },
    html: (id) => node(id).innerHTML,
    writes: (id) => writes[id] || 0,
    hub: () => Object.fromEntries(OPS_HOSTS.map((id) => [id, node(id).innerHTML])),
  };
}

// One DEPLOYED row as deployedHtml draws it: the name and hex over the state line, `tone` its extra class.
const depRow = (a, state, tone = '') => `<div class="ops-dep"><div class="hd"><span class="nm">Deep Scan Array ${num(a.id)}</span>`
  + `<span class="kd">hex ${a.coords.q}, ${a.coords.r}</span></div><div class="st${tone ? ` ${tone}` : ''}">${state}</div></div>`;
const idleLine = (a) => `idle · anchored to ${systemName(a.anchorSystemId)}`;

// ---- the galaxy map's array passes, on a stub canvas ---------------------------------------------------------

// mapFrame(view, guildId) -> one frame of the map's array passes over `view`, read as the shell reads it
// (LIVE.myArrays, behind window.__myArrays): per array, its two strokes in order — the dark under-stroke, then the
// edge — each with its path and width, and its tag's lines. The hex→screen transforms are stand-ins (no culling); the
// marker's shape, widths and colours are the page's own.
function mapFrame(view, guildId) {
  const strokes = [];
  const tags = [];
  let pathNow = [];
  const ctx = {
    save() {}, restore() {}, closePath() {},
    beginPath() { pathNow = []; },
    moveTo(x, y) { pathNow.push(['M', x, y]); },
    lineTo(x, y) { pathNow.push(['L', x, y]); },
    stroke() { strokes.push({ path: pathNow.slice(), lineWidth: this.lineWidth, strokeStyle: this.strokeStyle }); },
  };
  const sandbox = {
    GAME: { guildId }, LIVE: {}, ctx, zoom: 2, WAYSTATION_LABEL_ZOOM: 1.5,
    galaxy: { galaxyParams: { hexSize: 10 } },
    hexToPixel: (q, r) => ({ x: 4000 + 10 * q, y: 4000 + 10 * r }),
    worldToScreen: (x, y) => ({ x, y }),
    systemByKey: new Map(),
    drawLabelBox: (scr, lines, colorKey, downLeft) => tags.push({ lines, colorKey, downLeft }),
    window: { innerWidth: 1e6, innerHeight: 1e6 },
  };
  sandbox.window.__myArrays = () => sandbox.LIVE.myArrays;
  vm.runInNewContext(colourSrc + arrayNameSrc + darkLookSrc
    + `function read(snap){${arraysReadSrc}}\nfunction frame(){${markerSrc}${tagSrc}}`, sandbox);
  sandbox.read(view);
  sandbox.frame();
  const rows = sandbox.LIVE.myArrays;
  assert.equal(strokes.length, 2 * rows.length, 'two strokes per array');
  // Through JSON, so the sandbox's own arrays compare as plain ones.
  return JSON.parse(JSON.stringify(rows.map((a, i) => ({ id: a.id, dark: !!a.dark, under: strokes[2 * i], edge: strokes[2 * i + 1], tag: tags[i] }))));
}

// ---- the detail screen's redraw signature ----------------------------------------------------------------------

// detailPage(guildId, sig) -> the shell's reads and the detail screen's signature (or a mutated copy, `sig`), as
// applySnapshot runs them: `poll(view)` files the view and re-renders the detail screen when the signature moved.
function detailPage(guildId, sig = sigSrc) {
  let refreshes = 0;
  const sandbox = { window: { __refreshDetail: () => { refreshes += 1; } }, GAME: { guildId }, LIVE: {} };
  vm.createContext(sandbox);
  vm.runInContext(kitKindsSrc + groundKitsSrc + arraysSigSrc
    + 'function poll(snap){ var me = (snap.guilds || []).filter(function(g){ return g.id === GAME.guildId; })[0] || null;'
    + assetsReadSrc + claimsReadSrc + knownReadSrc + arraysReadSrc + occupancyReadSrc + sig + '}', sandbox);
  return { poll: (view) => sandbox.poll(view), refreshes: () => refreshes, sig: () => sandbox.LIVE.siteSig };
}

// ---- 1. Operations → DEPLOYED -----------------------------------------------------------------------------------

test('DEPLOYED: a dark array reads dark; a live idle one and a surveying one read exactly as main drew them', () => {
  const { dark, idleDark, lit } = EVICTED.arrays;
  const before = viewOf(EVICTED.before, 'g1');
  const after = viewOf(EVICTED.s, 'g1');
  const row = (view, id) => view.deepScanArrays.find((a) => a.id === id);
  assert.deepEqual(darkRows(after).map((a) => a.id), [dark, idleDark], 'premise: the abandon darkened two');
  const was = opsPage(before, 'g1').html('ops-deployed-list');
  const now = opsPage(after, 'g1').html('ops-deployed-list');
  // One array's row in the list, by its name.
  const rowHtml = (list, id) => list.split('<div class="ops-dep">').find((r) => r.includes(`Deep Scan Array ${num(id)}<`));
  const surveying = (a) => `<div class="st busy">surveying ${systemName(a.scan.targetSystemId)} · `;
  // Before: the idle one is idle, the other two are surveying (teal) — main's rows.
  assert.ok(was.includes(depRow(row(before, idleDark), idleLine(row(before, idleDark)))), 'the live idle array, as main drew it');
  for (const id of [dark, lit]) assert.ok(rowHtml(was, id).includes(surveying(row(before, id))), `${id} surveying`);
  // After: both dark, in the dark words and tone; `lit` still surveying, byte for byte as before.
  for (const id of [dark, idleDark]) assert.ok(now.includes(depRow(row(after, id), DARK_LINE, 'dark')), `${id} reads dark`);
  assert.equal(rowHtml(now, lit), rowHtml(was, lit), 'the array still touching HOME reads exactly as it did');
  assert.equal(now.split(DARK_LINE).length - 1, 2);
  assert.doesNotMatch(now, /undefined|null/);
});

test('DEPLOYED reads the flag, never the ground: a lit row given `dark` reads dark; a dark row without it reads idle', () => {
  const view = viewOf(EVICTED.s, 'g1');
  const { idleDark, lit } = EVICTED.arrays;
  const litRow = view.deepScanArrays.find((a) => a.id === lit);
  const darkRow = view.deepScanArrays.find((a) => a.id === idleDark);
  delete darkRow.dark;            // the hex still touches nothing g1 holds
  delete litRow.scan;             // idle, so its dark line has no job to stand beside
  litRow.dark = true;             // the hex still touches HOME's control
  const html = opsPage(view, 'g1').html('ops-deployed-list');
  assert.ok(html.includes(depRow(litRow, DARK_LINE, 'dark')));
  assert.ok(html.includes(depRow(darkRow, idleLine(darkRow))));
});

test('DEPLOYED, open across the loss: an idle array going dark redraws the list on the next poll, and an unchanged poll writes nothing', () => {
  const { alone, homeSide } = OUTPOST;
  const before = viewOf(OUTPOST.before, 'g1');
  const after = viewOf(OUTPOST.s, 'g1');
  const row = (view, id) => view.deepScanArrays.find((a) => a.id === id);
  assert.equal('scan' in row(before, alone), false, 'premise: idle');
  assert.equal(row(after, alone).dark, true, 'premise: dark once the Outpost is gone');
  const p = opsPage(before, 'g1');
  assert.ok(p.html('ops-deployed-list').includes(depRow(row(before, alone), idleLine(row(before, alone)))));
  const writes = p.writes('ops-deployed-list');
  p.poll(after);
  assert.equal(p.writes('ops-deployed-list'), writes + 1, 'the list diffs its own html, so it needs no signature');
  assert.ok(p.html('ops-deployed-list').includes(depRow(row(after, alone), DARK_LINE, 'dark')));
  assert.match(p.html('ops-deployed-list'), new RegExp(`Deep Scan Array ${num(homeSide)}<[\\s\\S]*?<div class="st busy">surveying `));
  p.poll(after);
  assert.equal(p.writes('ops-deployed-list'), writes + 1, 'an unchanged poll rebuilds nothing');
});

test('DEPLOYED: the dark state line is styled, in the page\'s CSS', () => {
  assert.match(html, /#tp-ops \.ops-dep \.st\.dark\{/);
});

// ---- 2. the galaxy map -------------------------------------------------------------------------------------------

test('MAP: a dark array\'s edge is not the teal a live one (idle or surveying) is drawn in, and its tag reads DARK', () => {
  const { dark, idleDark, lit } = EVICTED.arrays;
  const marks = mapFrame(viewOf(EVICTED.s, 'g1'), 'g1');
  assert.deepEqual(marks.map((m) => [m.id, m.dark]), [[dark, true], [idleDark, true], [lit, false]], 'the marker pass receives the flag, as sent');
  const byId = Object.fromEntries(marks.map((m) => [m.id, m]));
  assert.equal(byId[lit].edge.strokeStyle, TEAL_EDGE, 'the surveying array: main\'s teal');
  assert.deepEqual(byId[lit].tag.lines, [`DEEP SCAN ARRAY ${num(lit)}`]);
  for (const id of [dark, idleDark]) {
    assert.notEqual(byId[id].edge.strokeStyle, TEAL_EDGE, `${id}: not teal`);
    assert.deepEqual(byId[id].tag.lines, [`DEEP SCAN ARRAY ${num(id)}`, DARK_TAG], `${id}: its tag says so`);
  }
  assert.equal(byId[dark].edge.strokeStyle, byId[idleDark].edge.strokeStyle, 'one dark look, whatever the array was doing');
  // The live idle array the Outpost galaxy starts with: teal too.
  const idle = mapFrame(viewOf(OUTPOST.before, 'g1'), 'g1').find((m) => m.id === OUTPOST.alone);
  assert.deepEqual([idle.dark, idle.edge.strokeStyle, idle.tag.lines], [false, TEAL_EDGE, [`DEEP SCAN ARRAY ${num(OUTPOST.alone)}`]]);
});

test('MAP: dark is a look, not geometry — a dark marker is the same shape, under-stroke and widths as the same row drawn lit, and only its edge colour and tag differ', () => {
  for (const [view, guildId] of [[viewOf(EVICTED.s, 'g1'), 'g1'], [viewOf(OUTPOST.s, 'g1'), 'g1']]) {
    const drawn = mapFrame(view, guildId);
    const lit = mapFrame(stripDark(view), guildId);
    assert.ok(drawn.some((m) => m.dark), 'premise: a dark array is drawn');
    drawn.forEach((m, i) => {
      assert.deepEqual(m.under, lit[i].under, `${m.id}: the under-stroke`);
      assert.deepEqual([m.edge.path, m.edge.lineWidth], [lit[i].edge.path, lit[i].edge.lineWidth], `${m.id}: the edge's path and width`);
      assert.deepEqual([m.tag.colorKey, m.tag.downLeft, m.tag.lines[0]], [lit[i].tag.colorKey, lit[i].tag.downLeft, lit[i].tag.lines[0]]);
      if (!m.dark) assert.deepEqual(m, lit[i], `${m.id}: a live array is drawn exactly as before`);
    });
  }
});

test('MAP reads the flag, never the ground: a lit row given `dark` is drawn dark; a dark row without it is drawn teal', () => {
  const view = viewOf(EVICTED.s, 'g1');
  const { idleDark, lit } = EVICTED.arrays;
  delete view.deepScanArrays.find((a) => a.id === idleDark).dark;
  view.deepScanArrays.find((a) => a.id === lit).dark = true;
  const byId = Object.fromEntries(mapFrame(view, 'g1').map((m) => [m.id, m]));
  assert.notEqual(byId[lit].edge.strokeStyle, TEAL_EDGE);
  assert.equal(byId[idleDark].edge.strokeStyle, TEAL_EDGE);
});

// ---- 3. the detail screen's redraw signature -------------------------------------------------------------------

test('SIGNATURE: an idle array going dark redraws the detail screen, which main\'s signature never saw', () => {
  const before = viewOf(OUTPOST.before, 'g1');
  const after = viewOf(OUTPOST.s, 'g1');
  assert.ok(sigSrc.includes(NEW_TERM), 'the arrays term this test swaps is there');
  const mainSig = sigSrc.replace(NEW_TERM, MAIN_TERM);
  // The bug's premise: the Outpost going takes nothing the signature's other terms read (occupancy, known, claims,
  // ground kits), and the array had no job to void, so main's signature is one string across the loss.
  const m = detailPage('g1', mainSig);
  m.poll(before);
  const mainBefore = m.sig();
  m.poll(after);
  assert.equal(m.sig(), mainBefore, 'main\'s signature does not move');
  assert.equal(m.refreshes(), 1, 'main\'s signature: the detail screen is never redrawn for it');
  // This slice: the signature moves with the flag, once; an unchanged poll still redraws nothing.
  const p = detailPage('g1');
  p.poll(before);
  assert.equal(p.refreshes(), 1, 'the first poll draws');
  p.poll(before);
  assert.equal(p.refreshes(), 1);
  p.poll(after);
  assert.equal(p.refreshes(), 2, 'the poll after the Outpost goes redraws');
  p.poll(after);
  assert.equal(p.refreshes(), 2, 'the guard still guards');
  // And back: the eviction's dark arrays waking on the re-plant move it again.
  const q = detailPage('g1');
  q.poll(viewOf(EVICTED.s, 'g1'));
  const asleep = q.sig();
  q.poll(viewOf(REWOKEN.s, 'g1'));
  assert.notEqual(q.sig(), asleep);
});

test('SIGNATURE: arraysSignature carries each array\'s id, job and dark flag, and nothing else', () => {
  const sandbox = {};
  vm.runInNewContext(arraysSigSrc, sandbox);
  const rows = viewOf(EVICTED.s, 'g1').deepScanArrays;
  assert.deepEqual(JSON.parse(sandbox.arraysSignature(rows)), rows.map((a) => [a.id, a.scan || null, !!a.dark]));
  assert.equal(sandbox.arraysSignature([]), '[]');
});

// ---- 4. everything else, as main drew it ---------------------------------------------------------------------

// Each state's view with its `dark` keys taken out is main's view of the same galaxy; drawn by this page, every
// Operations host and the map's array passes must come out exactly as main's own client drew that view at 1c28fe4 —
// hashed and pinned. So a dark row is the only thing this slice changes; the test after this one proves which bytes
// it changes. It touches nothing the slice added, so it passes on main's game.html too.
// (The map hash repeats across the reach states: with the dark keys out, the same three arrays draw the same way.)
const AS_ON_MAIN = [
  { name: 'reach, before the abandon (g1)', state: () => EVICTED.before, guild: 'g1',
    hub: 'db924698110e27a956d4b0d44807a59e98619a519f0b46bc41b66358bb167458',
    map: 'cbec0d8cf4b74835d5250054c1d2f6a7bcf52c86c434cdf636e1c31312ad03d4' },
  { name: 'reach, before the abandon (g2)', state: () => EVICTED.before, guild: 'g2',
    hub: '700ec0791f447918a455e8261699edf7616dc7504b885376066f8bf3aec7de70',
    map: '5b269ad6d74ca7f369f4efeeb900858718e7f8cc99a19a41c08ec343193f8282' },
  { name: 'reach, abandoned (g1)', state: () => EVICTED.s, guild: 'g1',
    hub: '47a79434899b9cf2400d170d70c206e490d420c202e2d3c1d72d18871afaaaf3',
    map: 'cbec0d8cf4b74835d5250054c1d2f6a7bcf52c86c434cdf636e1c31312ad03d4' },
  { name: 'reach, abandoned (g2)', state: () => EVICTED.s, guild: 'g2',
    hub: '654fe14af9b8313d7a456bfe0a9c2b2536e537b21d5215c3b01368f759a1f305',
    map: '5b269ad6d74ca7f369f4efeeb900858718e7f8cc99a19a41c08ec343193f8282' },
  { name: 'outpost, standing (g1)', state: () => OUTPOST.before, guild: 'g1',
    hub: 'a7d0883445c0fa5fb31aca6fc01d4ed94e4ba87a6522223ddc4bfe592ce36a2b',
    map: '5d8352ea22d3786316666efe66e0f566bb2e6262c610304753ab25485c1b78d5' },
  { name: 'outpost, removed (g1)', state: () => OUTPOST.s, guild: 'g1',
    hub: 'f4104d64ad1ecf9cbbcfe9a209e597c0d811b93d7dbf576e9d890747603f9e7f',
    map: '5d8352ea22d3786316666efe66e0f566bb2e6262c610304753ab25485c1b78d5' },
  { name: 'reach, re-planted (g1)', state: () => REWOKEN.s, guild: 'g1',
    hub: '47a79434899b9cf2400d170d70c206e490d420c202e2d3c1d72d18871afaaaf3',
    map: 'cbec0d8cf4b74835d5250054c1d2f6a7bcf52c86c434cdf636e1c31312ad03d4' },
  { name: 'reach, re-planted (g2)', state: () => REWOKEN.s, guild: 'g2',
    hub: '654fe14af9b8313d7a456bfe0a9c2b2536e537b21d5215c3b01368f759a1f305',
    map: '5b269ad6d74ca7f369f4efeeb900858718e7f8cc99a19a41c08ec343193f8282' },
];

test('GUARD: with the dark keys taken out, every Operations host and the map\'s array passes render exactly as main rendered them, in every state', () => {
  for (const c of AS_ON_MAIN) {
    const view = stripDark(viewOf(c.state(), c.guild));
    assert.equal(sha(opsPage(view, c.guild).hub()), c.hub, `${c.name}: the Operations hub as on main`);
    assert.equal(sha(mapFrame(view, c.guild)), c.map, `${c.name}: the map's array passes as on main`);
  }
});

test('ONLY THE DARK ROWS MOVE: against the same view without its dark keys, each dark array\'s DEPLOYED state line is the one change in the hub', () => {
  for (const c of AS_ON_MAIN) {
    const view = viewOf(c.state(), c.guild);
    const plain = opsPage(stripDark(view), c.guild).hub();
    const drawn = opsPage(view, c.guild).hub();
    // Every dark array in these galaxies is idle (a dark one never carries a job), so without the key it reads idle.
    let expected = plain['ops-deployed-list'];
    for (const a of darkRows(view)) {
      const idle = depRow(a, idleLine(a));
      assert.ok(expected.includes(idle), `${c.name}: ${a.id} reads idle without its key`);
      expected = expected.replace(idle, depRow(a, DARK_LINE, 'dark'));
    }
    assert.deepEqual(drawn, { ...plain, 'ops-deployed-list': expected }, `${c.name}: nothing else moved`);
  }
});

// ---- 5. the wiring --------------------------------------------------------------------------------------------

test('wiring: the marker pass and the tag pass read this slice\'s two helpers, and the edge reads the flag alone', () => {
  assert.match(markerSrc, /ctx\.strokeStyle = arrayMarkerEdge\(a\);/);
  assert.match(tagSrc, /drawLabelBox\(scr, arrayMapTag\(a\), 'player', true\);/);
  assert.match(darkLookSrc, /function arrayMarkerEdge\(a\) \{ return a\.dark \? DARK_ARRAY_EDGE : col\('player', 0\.95\); \}/);
});
