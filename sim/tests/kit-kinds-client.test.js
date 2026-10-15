'use strict';

// kit-kinds-client.test.js — the client's copy of the kit vocabulary cannot drift from the engine's (roadmap
// 2.5, slice 14b).
//
// The engine names the installation kits in two tables: DEPLOYABLE_KITS (sim/resources.js — kit kind → the good a
// hold carries it as) and KIT_KIND_FOR_BILL (sim/asset-recipes.js — the kind a commission or a buy names → the kit
// kind it finishes as). Neither is published, so client/game.html keeps ONE copy, the `kit-kinds` script, and
// every screen asks it: the idle Deploy button, the deploy popup and map, the failed-deploy forks, the TRADE and
// Operations labels. client/console.html (its own page) keeps the two dockyard labels.
//
// A copy drifts silently — a new kit kind would get no Deploy button, or a renamed good would leave the
// Redeploy fork unable to find the kit aboard. So this runs the page's REAL table in a sandbox and checks it
// against the engine's tables, row for row, and checks the console's labels against it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { DEPLOYABLE_KITS } = require('../resources.js');
const { KIT_KIND_FOR_BILL } = require('../asset-recipes.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'client', name), 'utf8');

// The page's kit-kinds script, run on a stub `window`: hands back the two functions it defines.
function clientKitTable() {
  const src = read('game.html').match(/<script id="kit-kinds">([\s\S]*?)<\/script>/);
  assert.ok(src, 'the kit-kinds script is present in client/game.html');
  const sandbox = { window: {} };
  vm.runInNewContext(src[1], sandbox);
  return sandbox.window;
}

test('every engine kit kind has a client row, with the engine\'s kit good — and no other kind reads as a kit', () => {
  const w = clientKitTable();
  for (const [kind, good] of Object.entries(DEPLOYABLE_KITS)) {
    const row = w.__kitKind(kind);
    assert.ok(row, `kit kind ${JSON.stringify(kind)} has no client row — its idle kit would get no Deploy button`);
    assert.equal(row.good, good, `kit kind ${JSON.stringify(kind)}: the client looks for ${JSON.stringify(row.good)} aboard, the engine loads ${JSON.stringify(good)}`);
    for (const field of ['label', 'structure', 'target', 'outside']) {
      assert.equal(typeof row[field], 'string', `kit kind ${JSON.stringify(kind)} has no ${field} words`);
    }
  }
  // The other kinds the client meets — ground assets, a craft, a bill kind, an inherited name, the unbuilt toll
  // gate — are not kits (the table is private to its script, so these are probes, not a full enumeration).
  for (const kind of ['miner', 'factory', 'heavyTransport', 'toString', 'deep_scan_array', 'tollGate']) {
    assert.equal(w.__kitKind(kind), null, `${JSON.stringify(kind)} is not a kit kind`);
  }
});

test('every kit row has its own portrait, and the file is in the repo (2.5 slice 15 — the array no longer falls back to a plain panel)', () => {
  const w = clientKitTable();
  for (const kind of Object.keys(DEPLOYABLE_KITS)) {
    const art = w.__kitKind(kind).art;
    assert.equal(typeof art, 'string', `kit kind ${JSON.stringify(kind)} has no art`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'client', art)), `${art} is missing`);
  }
  assert.equal(w.__kitKind('deepScan').art, 'assets/units/deepscan.jpg');
  assert.equal(w.__kitKind('outpost').art, 'assets/units/outpost.jpg');
});

test('the deploy map\'s words for the array follow its REVISED rule: in or beside your territory, and a rival refusal (slice 15)', () => {
  const w = clientKitTable();
  const array = w.__kitKind('deepScan');
  assert.equal(array.target, 'a dashed hex in or beside your territory');
  assert.equal(array.outside, 'Not in or beside your territory');
  assert.equal(array.rival, 'Inside rival territory');
  // The Outpost's rule does not refuse a rival's control, so it has no rival words: its refusal stays "outside".
  assert.equal(w.__kitKind('outpost').rival, undefined);
});

test('every bill kind that finishes as a kit is labelled on the client, and maps to the same kit kind', () => {
  const w = clientKitTable();
  for (const [bill, kind] of Object.entries(KIT_KIND_FOR_BILL)) {
    assert.equal(w.__kitKind(kind).bill, bill, `the client's ${JSON.stringify(kind)} row names bill ${JSON.stringify(w.__kitKind(kind).bill)}, the engine's bridge ${JSON.stringify(bill)}`);
    assert.equal(w.__kitLabelForBill(bill), w.__kitKind(kind).label);
  }
  // A kind that does not finish as a kit has no kit label — the screens fall back to their plain name.
  for (const bill of ['miner', 'factory', 'lightTransport', 'spycraft', 'toll_gate']) {
    assert.equal(w.__kitLabelForBill(bill), null, `${JSON.stringify(bill)} does not finish as a kit`);
  }
  assert.equal(w.__kitLabelForBill('deep_scan_array'), 'Deep Scan Array kit');
  assert.equal(w.__kitLabelForBill('outpost'), 'Outpost kit');
});

test('the Production Console\'s dockyard labels say exactly what the game client\'s table says', () => {
  const w = clientKitTable();
  const src = read('console.html').match(/var DK_KIT_LABEL = (\{[^}]*\});/);
  assert.ok(src, 'DK_KIT_LABEL is present in client/console.html');
  const consoleLabels = vm.runInNewContext(`(${src[1]})`);
  const expected = Object.fromEntries(Object.keys(KIT_KIND_FOR_BILL).map((bill) => [bill, w.__kitLabelForBill(bill)]));
  assert.deepEqual({ ...consoleLabels }, expected);
});
