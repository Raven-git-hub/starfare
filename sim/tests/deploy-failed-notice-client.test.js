'use strict';

// deploy-failed-notice-client.test.js — the CLIENT half of slice 15 (roadmap 2.5; docs/exploration-model.md §5,
// REVISED 15-10-26, and the 14b checklist's ANSWERED 15-10-26 note): the `deploy_failed` notice's title names
// the structure in title case — "Deployment Failed — Deep Scan Array" / "Deployment Failed — Outpost" — and its
// Reason fact has a label for EVERY reason the engine can retreat on, the new 'rival-territory' included
// ("Rival territory"). Plus two source-level pins on the galaxy map's new array marker.
//
// The client has no DOM test harness, so — as scan-notice-client.test.js does — this cuts the page's OWN notice
// code (and its kit-kinds table, which names the structure) out of game.html and runs it in a node:vm sandbox on
// a stub DOM. The live page is driven by the walk harness outside the repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { DEPLOY_FAILED_REASONS } = require('../outposts.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
const kitKindsSrc = cut(html, /<script id="kit-kinds">([\s\S]*?)<\/script>/, 'the kit-kinds script').replace(/<\/?script[^>]*>/g, '');
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
const guildHelpersSrc = cut(guildScript, /\n  function el\(id\)\{[\s\S]*?(?=\n  function pad4\()/, 'the Guild Hall helpers (el … esc)');
const prettyGoodSrc = cut(guildScript, /\n  function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood');
const noticeSrc = cut(guildScript, /\n  \/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n  function centreFor\()/, 'the notice code (Notices … centreFor)');

const A = 'g1';
// A deploy_failed row in its published shape (sim/snapshot.js — the event row the view carries).
const failed = (id, kind, cause) => ({
  id, type: 'deploy_failed', tick: 10, whenDay: 1, readTick: 10, payload: {
    cause, kind, targetHex: { q: 1, r: 2 }, craftId: `vehicle_${A}_heavyTransport_01`, craftClass: 'heavyTransport',
    retreatSystemId: 'sys_0001', retreatSystemName: 'Somewhere' },
});

// noticePage(events) -> the page's notice code (and kit-kinds table) running for player A, whose view carries
// `events`, on a stub DOM.
function noticePage(events, vehicles = []) {
  const nodes = {};
  const stub = (id) => ({ id, textContent: '', innerHTML: '', style: {}, hidden: false,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} } });
  const snapshot = { guilds: [{ id: A, events, vehicles }], attention: { notices: [] } };
  const planned = [];   // every __planKitRoute call a fork makes: [craftId, action]
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stub(id)) },
    window: {
      // (copied into this realm, so deepEqual compares the action, not which vm built it)
      __planKitRoute: (craft, action) => planned.push([craft.id, JSON.parse(JSON.stringify(action))]),
      __player: () => ({ guildId: A }),
      __snapshot: () => snapshot,
      __sendAction: () => Promise.resolve({ accepted: true }),
      __refreshNow: () => Promise.resolve(),
      __outpostName: (id) => id,
    },
  };
  vm.runInNewContext(kitKindsSrc + guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const reasonFact = () => {
    const m = sandbox.document.getElementById('noticeFacts').innerHTML.match(/<span class="k">Reason<\/span><span class="v[^"]*">([^<]*)<\/span>/);
    return m ? m[1] : null;
  };
  return { page: sandbox, title: () => sandbox.document.getElementById('noticeTitle').textContent, reasonFact,
    hidden: (id) => sandbox.document.getElementById(id).hidden, planned };
}

test('the title names the structure in title case: "Deployment Failed — Deep Scan Array" / "… — Outpost"', () => {
  const array = failed(1, 'deepScan', 'rival-territory');
  const outpost = failed(2, 'outpost', 'occupied');
  const { page } = noticePage([array, outpost]);
  assert.equal(page.noticeTitle(array), 'Deployment Failed — Deep Scan Array');
  assert.equal(page.noticeTitle(outpost), 'Deployment Failed — Outpost');
  assert.equal(page.noticeRowTitle(array), 'Deployment Failed &mdash; <span class="who">Deep Scan Array</span>');
  assert.equal(page.noticeRowTitle(outpost), 'Deployment Failed &mdash; <span class="who">Outpost</span>');
});

// ⤳ 16-10-26 (the Prefecture / claims slice): engine PR 1 gave the engine a fifth retreat reason, 'system-claimed' (a
// Prefecture kit's target system claimed by a rival in flight), and pinned it here as awaiting its label. Client PR
// B1 — which lets a player ferry a Prefecture kit, so can meet that retreat — labels it "System claimed", and the
// awaited list is gone: every reason is held below.
test('the Reason fact has a label for EVERY reason the engine retreats on — "Rival territory", "System claimed"', () => {
  const { page } = noticePage([]);
  for (const reason of DEPLOY_FAILED_REASONS) {
    assert.equal(typeof page.DEPLOY_FAILED_REASON[reason], 'string', `the engine can retreat on ${JSON.stringify(reason)}, which the notice cannot name`);
  }
  assert.equal(page.DEPLOY_FAILED_REASON['rival-territory'], 'Rival territory');
  assert.equal(page.DEPLOY_FAILED_REASON['not-attached'], 'Not attached');
  assert.equal(page.DEPLOY_FAILED_REASON['system-claimed'], 'System claimed');
});

// A heavy as the retreat leaves it, in its published shape: idle, off any route, its kit aboard.
const retreated = (id, good) => ({ id, class: 'heavyTransport', status: 'idle', cargo: { [good]: 1 }, location: { q: 1, r: 2 } });

test('a retreated Prefecture kit (client PR B1): "Deployment Failed — Prefecture", "System claimed", NO Redeploy, and Return plans the unload', () => {
  const n = failed(8, 'prefecture', 'system-claimed');
  const craft = retreated(n.payload.craftId, 'prefecture_kit');
  const { page, title, reasonFact, hidden, planned } = noticePage([n], [craft]);
  page.openNotice(8);
  assert.equal(title(), 'Deployment Failed — Prefecture');
  assert.equal(reasonFact(), 'System claimed');
  // A ground kit is never deployed on a hex, so the fork that opens the deploy map is not offered…
  assert.equal(hidden('noticeRedeploy'), true, 'a Prefecture kit offers no Redeploy');
  assert.equal(hidden('noticeReturn'), false, 'its Return is offered');
  // …and even asked for, the deploy fork plans the unload, never { type:'deploy', kind:'prefecture' }.
  page.noticeFork('deploy');
  page.openNotice(8);
  page.noticeFork('unload');
  assert.deepEqual(planned, [[craft.id, { type: 'unload' }], [craft.id, { type: 'unload' }]]);
});

test('a space kit\'s notice is unchanged: both forks shown, Redeploy plans the deploy map, Return the unload', () => {
  const n = failed(9, 'outpost', 'occupied');
  const craft = retreated(n.payload.craftId, 'outpost_kit');
  const { page, hidden, planned } = noticePage([n], [craft]);
  page.openNotice(9);
  assert.equal(hidden('noticeRedeploy'), false);
  assert.equal(hidden('noticeReturn'), false);
  page.noticeFork('deploy');
  page.openNotice(9);
  page.noticeFork('unload');
  assert.deepEqual(planned, [[craft.id, { type: 'deploy', kind: 'outpost' }], [craft.id, { type: 'unload' }]]);
});

test('the popup, opened on an array that met a rival\'s territory, reads the new title and "Rival territory"', () => {
  const n = failed(7, 'deepScan', 'rival-territory');
  const { page, title, reasonFact } = noticePage([n]);
  page.openNotice(7);
  assert.equal(title(), 'Deployment Failed — Deep Scan Array');
  assert.equal(reasonFact(), 'Rival territory');
});

// --- the galaxy map's array marker (source-level: the map is a canvas, driven live by the walk harness) -------

test('the map: the player\'s arrays are drawn from the view\'s own rows, unfiltered, and never feed the territory paint', () => {
  // The territory paint knows nothing of arrays: an array changes no territory (exploration-model.md §5).
  const territory = cut(html, /\n  function computeTerritoryMap\(\) \{[\s\S]*?\n  \}\n/, 'computeTerritoryMap');
  assert.doesNotMatch(territory, /myArrays|deepScan|DeepScan/i);
  // The marker pass reads window.__myArrays() straight, with no filter of its own — a rival's array is kept out
  // by the engine's view (sim/fog.js; fog.test.js), so a leak would show on the map rather than hide.
  const pass = cut(html, /\n    const myArraysOnMap = [^\n]*\n[\s\S]*?\n    \}\);\n/, 'the array marker pass');
  assert.match(pass, /const myArraysOnMap = \(window\.__myArrays && window\.__myArrays\(\)\) \|\| \[\];/);
  assert.doesNotMatch(pass, /\.filter\(/);
});
