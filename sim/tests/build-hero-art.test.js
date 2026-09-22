'use strict';

// build-hero-art.test.js — CLIENT-SOURCE assertions that the "Building" / current-build hero art
// FOLLOWS THE BUILD KIND instead of being hardcoded to the factory-construction image. The bug
// this pins against: a transport build (e.g. a medium transport) showed the factory image under a
// correct "Medium Transport" label because the hero art was a hardcoded literal. The fix keys each
// hero's art off the build kind via a per-file map (game.html CN_BUILD_ART, console.html DKC_ART),
// with the construction image as a graceful fallback. Same pattern as trade-constructed.test.js:
// the render lives in the HTML (no DOM in the engine), so we pin the load-bearing SOURCE seams.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gameHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'console.html'), 'utf8');

// The four transport classes each map to their own portrait — the entries whose absence was the
// bug. Keyed by the snapshot's build-kind strings (camelCase, matching sim/vehicles.js).
const TRANSPORT_ART = [
  ["lightTransport", "assets/units/lighttransport.jpg"],
  ["mediumTransport", "assets/units/mediumtransport.jpg"],
  ["heavyTransport", "assets/units/heavytransport.jpg"],
  ["spycraft", "assets/units/spycraft.jpg"],
];

test('game.html: the TRADE Constructed view has a kind-keyed build-art map with all four transports', () => {
  assert.match(gameHtml, /var CN_BUILD_ART = \{/);
  // The two ground assets share the construction image; each transport has its own portrait.
  assert.match(gameHtml, /miner: 'assets\/industrial\/factoryConstruction\.jpg'/);
  assert.match(gameHtml, /factory: 'assets\/industrial\/factoryConstruction\.jpg'/);
  for (const [kind, art] of TRANSPORT_ART) {
    assert.match(gameHtml, new RegExp(kind + ": '" + art.replace(/[/.]/g, '\\$&') + "'"));
  }
  // A graceful fallback so an unknown kind is never blank.
  assert.match(gameHtml, /var CN_BUILD_ART_FALLBACK = 'assets\/industrial\/factoryConstruction\.jpg';/);
});

test('game.html: panel 4 resolves its art from the kind map (regression guard vs a hardcoded image)', () => {
  // The art is picked by the soonest build's KIND, falling back when idle/unknown...
  assert.match(gameHtml, /var p4art = \(soonest && CN_BUILD_ART\[soonest\.kind\]\) \|\| CN_BUILD_ART_FALLBACK;/);
  // ...and the hero div interpolates that variable rather than a literal URL. If someone reverts to
  // a hardcoded factory image, `+ p4art +` disappears and this fails loudly.
  assert.match(gameHtml, /background-image:url\(\\'' \+ p4art \+ '\\'\)/);
});

test('console.html: DKC_ART is the one per-file art map, keyed by kind, with all four transports', () => {
  assert.match(consoleHtml, /var DKC_ART = \{/);
  assert.match(consoleHtml, /miner: 'assets\/industrial\/factoryConstruction\.jpg'/);
  assert.match(consoleHtml, /factory: 'assets\/industrial\/factoryConstruction\.jpg'/);
  for (const [kind, art] of TRANSPORT_ART) {
    assert.match(consoleHtml, new RegExp(kind + ": '" + art.replace(/[/.]/g, '\\$&') + "'"));
  }
  assert.match(consoleHtml, /var DKC_ART_FALLBACK = 'assets\/industrial\/factoryConstruction\.jpg';/);
});

test('console.html: the current-build hero resolves its art from DKC_ART (regression guard)', () => {
  // Idle → the construction fallback; building → the head kind's art, fallback if unwired.
  assert.match(consoleHtml, /var buildingArt = \(headState === 'idle' \? DKC_ART_FALLBACK : \(DKC_ART\[head\.assetKind\] \|\| DKC_ART_FALLBACK\)\);/);
  // The hero div interpolates that variable, not a hardcoded factory URL.
  assert.match(consoleHtml, /background-image:url\(\\'' \+ buildingArt \+ '\\'\)/);
});
