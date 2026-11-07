'use strict';

// droid-batch-card.test.js — the Droids card in the TRADE tab's "4 · Constructed" Commission Assets list (roadmap
// 2.6, the Syndicate droid batch-buy slice; docs/droids.md §3, RE-RULED 07-11-26).
//
// Like constructed-building-head.test.js, this RUNS the page: it cuts the Constructed view's own source out of
// client/game.html, renders it in a node:vm sandbox with a stub DOM against a REAL engine snapshot, and checks
// what the player reads. Then it runs the card's own order code, captures the action it would POST, and hands
// that to the engine's validateAction — so the seam engine quote → card → action → engine is proven end to end.
//
// The tripwires:
//   1. the card renders from droidBatchQuote: three chips, the lit chip's price, the per-droid figure, and the
//      "Ready — ships by medium · ~Xh" line whose Xh is the snapshot's own delivery leg (not a client number);
//   2. a chip lights another batch and its price; the Add shows only on the open card;
//   3. the Add sends exactly `buyDroidBatch { guildId, batch, destinationSystemId: home }`, which the engine
//      accepts; a guild short of credits gets the "cannot afford" popup and no action;
//   4. without a droidBatchQuote (an older snapshot) the card is simply absent and nothing else changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildSnapshot } = require('../snapshot.js');
const { validateAction } = require('../actions.js');
const { HOME, kitGalaxy, g1Of } = require('./installation-kit-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');
// The same cut constructed-building-head.test.js makes (cnDur … renderConstructed), plus the order code.
const viewSrc = html.match(/\n  function cnDur\(ticks\)\{[\s\S]*?(?=\n  \/\/ Add a commission:)/);
const orderSrc = html.match(/\n  function cnDroidOrder\(\)\{[\s\S]*?(?=\n  \/\/ Delegated once, on the panel)/);
const prettySrc = html.match(/\n  function pretty\(key\)\{[\s\S]*?\n  \}\n/);
const kitKindsSrc = html.match(/<script id="kit-kinds">([\s\S]*?)<\/script>/);
assert.ok(viewSrc && orderSrc && prettySrc && kitKindsSrc, 'the Constructed view, the droid order code and their helpers are in game.html');

// sandboxFor(snapshot, T) -> a vm context running the page's code against `snapshot` (through JSON, as the
// browser receives it), with a stub DOM, a recording __sendAction and an __adviserConfirm that confirms at once.
function sandboxFor(snapshot, T = {}) {
  const s = JSON.parse(JSON.stringify(snapshot));
  const container = { innerHTML: '' };
  const sent = [];
  const popups = [];
  const sandbox = {
    T: { tier: 4, cnOpen: null, cnNote: '', cnNoteKind: '', cnNoteTimer: null, ...T },
    el: (id) => (id === 'tw-cn' ? container : null),
    snap: () => s,
    meGuild: () => s.guilds.find((g) => g.id === 'g1') || null,
    fmt: (n) => Math.round(n).toLocaleString('en-US'),
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: {
      __player: () => ({ guildId: 'g1' }),
      __sendAction: (a) => { sent.push(a); return { then: () => ({ catch: () => {} }) }; },
      __adviserConfirm: (p) => { popups.push(p); p.onConfirm(); },
    },
  };
  vm.runInNewContext(kitKindsSrc[1] + prettySrc[0] + viewSrc[0] + orderSrc[0], sandbox);
  return { sandbox, container, sent, popups };
}
const render = (snapshot, T) => {
  const box = sandboxFor(snapshot, T);
  vm.runInContext('renderConstructed();', box.sandbox);
  return box.container.innerHTML;
};
// droidCard(snapshot, T) -> the Droids card exactly as the page's own cnDroidCard builds it for this view, after
// checking the full render really contains it (inside the Commission Assets list, after the asset kinds).
const droidCard = (snapshot, T) => {
  const box = sandboxFor(snapshot, T);
  vm.runInContext('renderConstructed();', box.sandbox);
  const full = box.container.innerHTML;
  const card = vm.runInContext("cnDroidCard(snap().droidBatchQuote, meGuild(), T.cnOpen === 'droid')", box.sandbox);
  const list = full.slice(full.indexOf('<div class="am-list">'), full.indexOf('<div class="dk-card"><div class="dk-h">'));
  assert.ok(list.endsWith(card + '</div></div>'), 'the Droids card is the last entry of the Commission Assets list');
  return { open: card.startsWith('<div class="am-item open"'), body: card, full };
};

const galaxy = (credits = 1_000_000) => kitGalaxy({ credits, fuelHoard: 100 });

test('card: three chips, the smallest lit, its price, the per-droid figure and the ready line — all from the snapshot', () => {
  const snap = buildSnapshot(galaxy(), 'g1');
  const travel = snap.guilds.find((g) => g.id === 'g1').fuelCost[HOME.id].travelTicks;
  assert.equal(travel, 900, 'a 6-hex leg at the flat Syndicate craft speed');
  const { open, body } = droidCard(snap);
  assert.equal(open, false, 'closed until chosen (the list opens on its first asset kind)');
  assert.match(body, /<div class="anm">Droids<\/div>/);
  assert.deepEqual([...body.matchAll(/<button class="dq-chip( on)?" data-batch="(\d+)">(\d+)<\/button>/g)].map((m) => [m[2], !!m[1]]),
    [['5', true], ['10', false], ['50', false]]);
  assert.match(body, /<span class="amt"><span class="c">&#162;<\/span>50,000<\/span><span class="abt">&#162;10,000\/droid<\/span>/);
  assert.match(body, /<div class="dq-ready">Ready &mdash; ships by medium &middot; ~15h<\/div>/, '900 ticks = 15h, the published leg');
  assert.doesNotMatch(body, /dq-add/, 'no Add on a closed card');
});

test('card: a lit chip shows that batch\'s price; the open card carries the Add', () => {
  const snap = buildSnapshot(galaxy(), 'g1');
  const fifty = droidCard(snap, { cnOpen: 'droid', cnDroidBatch: 50 });
  assert.equal(fifty.open, true);
  assert.match(fifty.body, /<button class="dq-chip on" data-batch="50">50<\/button>/);
  assert.match(fifty.body, /&#162;<\/span>500,000<\/span>/);
  assert.match(fifty.body, /<button class="am-add dq-add">\+ Add commission<\/button>/);
  // A remembered size the snapshot no longer offers falls back to the smallest.
  assert.match(droidCard(snap, { cnDroidBatch: 7 }).body, /<button class="dq-chip on" data-batch="5">/);
});

test('order: the Add sends exactly buyDroidBatch to the home system, and the engine accepts it', () => {
  const s = galaxy();
  for (const batch of [5, 10, 50]) {
    const box = sandboxFor(buildSnapshot(s, 'g1'), { cnOpen: 'droid', cnDroidBatch: batch });
    vm.runInContext('cnDroidOrder();', box.sandbox);
    // Through JSON: the action is what the browser would POST (and a vm-realm object is not reference-equal here).
    assert.deepEqual(JSON.parse(JSON.stringify(box.sent)), [{ type: 'buyDroidBatch', guildId: 'g1', batch, destinationSystemId: HOME.id }]);
    assert.match(box.popups[0].title, new RegExp(`^Buy ${batch} droids\\?$`));
    assert.deepEqual(validateAction(s, box.sent[0]), { valid: true });
  }
});

test('order: short of the lit batch\'s price — the "cannot afford" popup, and no action', () => {
  const s = galaxy(99_999);
  const box = sandboxFor(buildSnapshot(s, 'g1'), { cnOpen: 'droid', cnDroidBatch: 10 });
  vm.runInContext('cnDroidOrder();', box.sandbox);
  assert.deepEqual(box.sent, []);
  assert.equal(box.popups[0].title, 'Insufficient credits');
  assert.match(box.popups[0].body, /<b>&#162;100,000<\/b>/);
  // The smaller batch is affordable and goes through.
  const ok = sandboxFor(buildSnapshot(s, 'g1'), { cnOpen: 'droid', cnDroidBatch: 5 });
  vm.runInContext('cnDroidOrder();', ok.sandbox);
  assert.equal(ok.sent.length, 1);
  assert.equal(g1Of(s).credits, 99_999);
});

test('card: an older snapshot with no droidBatchQuote renders no Droids card and the list is otherwise unchanged', () => {
  const snap = buildSnapshot(galaxy(), 'g1');
  const without = { ...snap };
  delete without.droidBatchQuote;
  const out = render(without);
  assert.doesNotMatch(out, /data-kind="droid"/);
  // Everything but the card is the same HTML, byte for byte.
  const { body, full } = droidCard(snap);
  assert.equal(full.replace(body, ''), out);
});
