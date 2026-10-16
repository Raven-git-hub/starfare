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
function noticePage(events) {
  const nodes = {};
  const stub = (id) => ({ id, textContent: '', innerHTML: '', style: {}, hidden: false,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} } });
  const snapshot = { guilds: [{ id: A, events, vehicles: [] }], attention: { notices: [] } };
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stub(id)) },
    window: {
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
  return { page: sandbox, title: () => sandbox.document.getElementById('noticeTitle').textContent, reasonFact };
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

// ⤳ 16-10-26 (the Prefecture / claims slice, ENGINE PR 1): the engine gained a fifth retreat reason, 'system-claimed'
// (a Prefecture kit's target system claimed by a rival in flight). This PR is engine + operator CLI only, so the
// notice does not name it yet — it reads "—", as 'not-attached' once did. It is listed HERE, by name, so the gap is
// pinned rather than hidden: the client PR labels it and empties this list, and the test below then holds it to that.
const AWAITING_CLIENT_LABEL = ['system-claimed'];

test('the Reason fact has a label for EVERY reason the engine retreats on — "Rival territory" for the new one', () => {
  const { page } = noticePage([]);
  for (const reason of DEPLOY_FAILED_REASONS) {
    if (AWAITING_CLIENT_LABEL.includes(reason)) {
      assert.equal(page.DEPLOY_FAILED_REASON[reason], undefined, `${JSON.stringify(reason)} is labelled now — take it off AWAITING_CLIENT_LABEL`);
      continue;
    }
    assert.equal(typeof page.DEPLOY_FAILED_REASON[reason], 'string', `the engine can retreat on ${JSON.stringify(reason)}, which the notice cannot name`);
  }
  assert.equal(page.DEPLOY_FAILED_REASON['rival-territory'], 'Rival territory');
  assert.equal(page.DEPLOY_FAILED_REASON['not-attached'], 'Not attached');
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
