'use strict';

// trade-constructed.test.js — CLIENT-SOURCE assertions for the TRADE tab's tier-4 "Constructed"
// buy view (roadmap 2.1d client slice A; docs/mockups/trade-4constructed.html). The rendering
// itself lives in client/game.html (no DOM in the engine), so — exactly as utc-offset.test.js and
// console-hero-venture.test.js do — these tests pin the load-bearing SOURCE seams: tier 4 is
// always live and clickable, T.tier === 4 renders the Constructed panels and hides the goods
// chips, and Add → __adviserConfirm → buyAssetFromSyndicate carries the ruled payload. The engine
// half (the snapshot `assetPurchaseQuote`) is proven in asset-purchase.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

test('tier 4 is always LIVE — never gated on a goods catalog or a dockyard', () => {
  // The one predicate both the nav and the tier-click read: tier 4 short-circuits to enabled.
  assert.match(html, /function tierEnabled\(t\)\{\s*return t === 4 \|\| tierGoods\(t\)\.length > 0;/);
  // renderNav dims a tier by tierEnabled (not the old tierGoods length), so tier 4 renders un-dim.
  assert.match(html, /var has = tierEnabled\(t\);/);
  // The tier-click handler routes on tierEnabled, so tier 4 is clickable.
  assert.match(html, /if\(tierEnabled\(t\)\)\{ T\.tier = t; T\.navSig = ''; render\(\); \}/);
});

test('T.tier === 4 renders the Constructed view in place of the goods floor and hides the chips', () => {
  // The resource-chip row is hidden on tier 4 (the Constructed view has no goods chips).
  assert.match(html, /list\.style\.display = \(T\.tier === 4\) \? 'none' : '';/);
  // render() swaps the goods body for the Constructed grid and calls renderConstructed().
  assert.match(html, /if\(T\.tier === 4\)\{/);
  assert.match(html, /if\(body\) body\.style\.display = 'none';/);
  assert.match(html, /if\(cn\) cn\.style\.display = 'grid';/);
  assert.match(html, /renderConstructed\(\);/);
  // The Constructed container is present and starts hidden.
  assert.match(html, /<div class="cn-body" id="tw-cn" style="display:none"><\/div>/);
  // The default-good picking (a tier 1–3 concern) is guarded off tier 4 so it never bounces the tab.
  assert.match(html, /if\(T\.tier !== 4 && \(T\.good == null \|\| priceOf\(T\.good\) == null\)\)\{/);
});

test('the Constructed view renders all five panels off the snapshot', () => {
  // Panel 1 — the commission-asset menu, priced from the snapshot quote (no client-side price).
  assert.match(html, /var quote = \(s && s\.assetPurchaseQuote\) \|\| \{\};/);
  assert.match(html, /class="am-item/);
  assert.match(html, /class="am-add" data-kind="/);
  // Panel 2 — In Progress, this guild's parallel syndicateBuilds, soonest-arrival first.
  assert.match(html, /s\.syndicateBuilds\) \|\| \[\]\)/);
  assert.match(html, /class="ip-item/);
  assert.match(html, /builds\.sort\(function\(a, b\)\{ return a\.arrive - b\.arrive; \}\);/);
  // Panel 3 — the Current Build donut (soonest build's countdown), with an explicit IDLE state.
  assert.match(html, /class="dk-donutwrap"/);
  assert.match(html, /class="big grey">IDLE/);
  // Panels 4 & 5 — the building art (follows the soonest build) and the buildyard hero (two lines).
  assert.match(html, /assets\/industrial\/factoryConstruction\.jpg/);
  assert.match(html, /assets\/industrial\/buildyard\.jpg/);
  assert.match(html, /class="word">SYNDICATE<br>BUILDYARD</);
});

test('the delivery leg + build time are DISPLAY derivations, never computed prices', () => {
  // The delivery duration is read WHOLE from the goods-buy route quote — no distance/speed here.
  assert.match(html, /r\.travelTicks === 'number'\) \? r\.travelTicks : 0/);
  // The menu shows the quote's price verbatim and the build time as a formatted duration.
  assert.match(html, /quote\[kind\] \|\| \{\}/);
  assert.match(html, /q\.buildTicks/);
});

test('the Constructed grid fills the tab like the goods floor — #tw-cn grows as a flex child', () => {
  // #tw-cn and .tw-body are sibling flex children of .tw-wrap; both must carry `flex:1 1 auto`
  // so they grow to fill the panel height. Without it #tw-cn stops at min-height:560px and leaves
  // dead space on a tall viewport (the compression this pins against a future regression).
  assert.match(html, /#tw-cn\{[^}]*flex:1 1 auto;[^}]*min-height:560px;\}/s);
  // The goods floor it must match still carries the same growth rule.
  assert.match(html, /#tp-trade \.tw-body\{[^}]*flex:1 1 auto; min-height:560px;\}/s);
});

test('the .tw-wrap fills the tab width — no vestigial auto side-margins to shrink-wrap and centre', () => {
  // #tp-trade is a flex column and .tw-wrap is a flex item; auto cross-axis margins would override
  // align-items:stretch, shrink-wrapping .tw-wrap to its content and centring it (blank side gutters,
  // visible on tier 4's narrower grid). The margin must be a bare `margin:0` so the wrap stretches.
  const rule = html.match(/#tp-trade \.tw-wrap\{max-width:none;[^}]*\}/);
  assert.ok(rule, 'the #tp-trade .tw-wrap max-width rule is present');
  assert.match(rule[0], /margin:0;/, '.tw-wrap must set margin:0 (full-width stretch)');
  assert.doesNotMatch(rule[0], /margin:0 auto/, '.tw-wrap must NOT re-introduce the auto-centring margin');
});

test('Add → __adviserConfirm → buyAssetFromSyndicate with the ruled payload', () => {
  // The Add button opens the shared adviser-confirm popup (not a new overlay), Commission-labelled.
  assert.match(html, /window\.__adviserConfirm\(\{/);
  assert.match(html, /confirmLabel: 'Commission ▸'/);
  // onConfirm fires buyAssetFromSyndicate via the SAME action-post path the goods buy uses,
  // to the guild's HOME system, carrying the quote's issue tick (§8.1 quote-lock).
  assert.match(html, /var dest = guild\.homeSystemId;/);
  assert.match(html, /type:'buyAssetFromSyndicate', guildId: player\.guildId, assetKind: kind, destinationSystemId: dest/);
  assert.match(html, /if\(typeof issueTick === 'number'\) action\.issueTick = issueTick;/);
  assert.match(html, /window\.__sendAction\(action\)/);
});
