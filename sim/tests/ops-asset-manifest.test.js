'use strict';

// ops-asset-manifest.test.js — CLIENT-SOURCE assertion for the Operations "In Transit"
// manifest's asset label (roadmap 2.1d client slice B; docs/asset-purchase.md "Delivery").
// The rendering lives in client/game.html (no DOM in the engine), so — exactly as
// trade-constructed.test.js and utc-offset.test.js do — this pins the load-bearing SOURCE
// seam rather than the DOM: an in-flight ASSET delivery carries no `cargo` (the snapshot
// marks it with `assetKind` instead), so `rowHtml` MUST branch on `sh.assetKind` and emit a
// single manifest row via `craftManifestLabel`: a GROUND asset reads "<kind> asset", a guild
// TRANSPORT reads its own camelCase-split name (2.2-foundation — "Light Transport", NOT
// "Lighttransport Asset"). If a future edit drops that branch, an asset delivery falls back
// through the goods loop to "No cargo listed." — this test fails loudly first. The snapshot half
// (each shipment carries `assetKind` + leg geometry) is proven in asset-purchase.test.js and
// transport-visibility.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

test('rowHtml branches its manifest on sh.assetKind and names the asset/craft', () => {
  // The manifest is chosen off `sh.assetKind`: an asset/craft delivery names itself; a goods
  // delivery keeps the cargo loop. Pin the conditional so the asset branch cannot be dropped.
  assert.match(html, /var manRows = sh\.assetKind/);
  // The asset branch emits ONE .ops-manrow whose .g is `craftManifestLabel(sh.assetKind)`.
  assert.match(
    html,
    /'<div class="ops-manrow"><span class="g">' \+ esc\(craftManifestLabel\(sh\.assetKind\)\) \+ '<\/span><\/div>'/
  );
  // A GROUND asset keeps the literal " asset" suffix (`.ops-manrow .g` capitalizes it to
  // "Miner Asset"); a guild TRANSPORT drops it and camelCase-splits to its own name, so the
  // manifest reads "Light Transport", not "Lighttransport Asset" (2.2-foundation).
  assert.match(html, /function craftManifestLabel\(kind\)\{/);
  assert.match(html, /TP_SHORT\.hasOwnProperty\(kind\)/);
  assert.match(html, /\(kind \+ ' asset'\)/);
});

test('a goods delivery still runs the cargo loop and its empty case', () => {
  // The goods path (no assetKind) is unchanged: itemised `Good: Nu`, falling to "No cargo listed."
  assert.match(html, /esc\(g\) \+ '<\/span><span class="q">' \+ fmt\(cargo\[g\]\) \+ ' Nu<\/span>/);
  assert.match(html, /'<div class="ops-manrow ops-manempty">No cargo listed\.<\/div>'/);
});

test('the "Nothing in transit" empty state names asset commissions too', () => {
  // The empty-state copy is accurate now that assets ship: goods OR a commissioned asset.
  assert.match(
    html,
    /A Syndicate delivery appears here the moment you buy goods or commission an asset to a system you hold\./
  );
});
