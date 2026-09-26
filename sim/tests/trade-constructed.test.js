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
  // Panel 2 — In Progress, this guild's syndicateBuilds queue (its order and head are pinned in
  // the "building head" tests below).
  assert.match(html, /s\.syndicateBuilds\) \|\| \[\]\)/);
  assert.match(html, /class="ip-item/);
  // Panel 3 — the Current Build donut (the building head's countdown), with an explicit IDLE state.
  assert.match(html, /class="dk-donutwrap"/);
  assert.match(html, /class="big grey">IDLE/);
  // Panels 4 & 5 — the building art (follows the building head's KIND via CN_BUILD_ART, not a
  // hardcoded factory literal) and the buildyard hero (two lines). The map + per-kind resolution
  // are pinned in build-hero-art.test.js; here we pin that panel 4 reads the resolved art variable.
  assert.match(html, /var p4art = \(head && CN_BUILD_ART\[head\.kind\]\) \|\| CN_BUILD_ART_FALLBACK;/);
  assert.match(html, /background-image:url\(\\'' \+ p4art \+ '\\'\)/);
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

test('each commission menu item is two lines — name, then price + build time — no descriptor/arrival row', () => {
  // The compact .apr row carries the price in .amt and the build time in .abt (right-hugged by flex).
  assert.match(html, /class="apr"><span class="amt"><span class="c">&#162;<\/span>/);
  assert.match(html, /<span class="abt">' \+ cnDur\(buildT\) \+ '<\/span>/);
  // The .apr becomes a space-between flex row so .abt hugs the right edge; .amt holds the amber price.
  assert.match(html, /#tw-cn \.am-item \.apr\{display:flex; align-items:baseline; justify-content:space-between;[^}]*\}/);
  assert.match(html, /#tw-cn \.am-item \.apr \.abt\{[^}]*\}/);
  // The dropped descriptor and build/delivery/arrival lines are gone from both markup and CSS.
  assert.doesNotMatch(html, /class="asub"/);
  assert.doesNotMatch(html, /class="abuildt"/);
  assert.doesNotMatch(html, /#tw-cn \.am-item \.asub\{/);
  assert.doesNotMatch(html, /#tw-cn \.am-item \.abuildt\{/);
  // The now-dead CN_SUB descriptor map is removed too (no orphaned local).
  assert.doesNotMatch(html, /var CN_SUB =/);
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

test('cnCommission gates on guild.credits < price → single-button "cannot afford" popup, no buy', () => {
  // The affordability gate compares two snapshot values (credits vs quoted price — no game number,
  // §5) and returns before the confirm/buy path.
  assert.match(html, /if\(price != null && typeof guild\.credits === 'number' && guild\.credits < price\)\{/);
  // In that branch it opens the shared adviser-confirm popup in single-button acknowledge mode,
  // Close-labelled, with a no-op onConfirm.
  const gate = html.match(/if\(price != null && typeof guild\.credits === 'number' && guild\.credits < price\)\{[\s\S]*?\n    \}/);
  assert.ok(gate, 'the credits gate block is present');
  assert.match(gate[0], /title: 'Insufficient credits'/);
  assert.match(gate[0], /confirmLabel: 'Close'/);
  assert.match(gate[0], /singleButton: true/);
  assert.match(gate[0], /return;/);
  // The gate must NOT reach cnPostCommission (no buy fired) — the block posts no action.
  assert.doesNotMatch(gate[0], /cnPostCommission/);
  assert.doesNotMatch(gate[0], /buyAssetFromSyndicate/);
});

test('__adviserConfirm honours singleButton by hiding reelCancel (reset every call)', () => {
  // Visibility is set explicitly on every call so a normal two-button confirm always resets it.
  assert.match(html, /\$\('reelCancel'\)\.style\.display = opts\.singleButton \? 'none' : '';/);
});

test('cnPostCommission no longer shows a red refusal note — the bad note is gone', () => {
  // A refusal is now silent: no cnNote(..., 'bad') anywhere in the source, and the .cn-note.bad
  // (red) CSS rule is dropped. The green 'ok' note (and its styling) stays in use.
  assert.doesNotMatch(html, /cnNote\([^)]*,\s*'bad'\)/);
  assert.doesNotMatch(html, /#tw-cn \.cn-note\.bad\{/);
  assert.match(html, /cnNote\('Commission placed[\s\S]*?'ok'\)/);
  assert.match(html, /#tw-cn \.cn-note\.ok\{/);
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

// --- cancelling a not-yet-started commission (docs/asset-purchase.md §"Cancelling a queued
// commission"; roadmap 2.1d, the cancel CLIENT slice). The engine half — the action, and the
// snapshot's `commissionId` / `cancellable` — is proven in syndicate-queue-cancel.test.js.

// The body of one named function in the page, from its `function name(` to the next top-level
// (two-space-indented) `function` or the panel's delegated click handler — so an assertion about
// what a function does or doesn't contain reads THAT function only.
function fnBody(name) {
  const m = html.match(new RegExp('\\n  function ' + name + '\\([\\s\\S]*?(?=\\n  function |\\n  // Delegated once)'));
  assert.ok(m, `function ${name} is present`);
  return m[0];
}

test('the In Progress builds map carries commissionId + cancellable straight from the snapshot', () => {
  // A pure passthrough: the snapshot row's own fields, not a value the client derives.
  assert.match(html, /commissionId:b\.commissionId, cancellable:b\.cancellable \};/);
});

test('each In Progress row renders a data-commission ✕ ONLY when the snapshot marks it cancellable', () => {
  const rows = html.match(/ipRows = builds\.map\(function\(b\)\{[\s\S]*?\}\)\.join\(''\);/);
  assert.ok(rows, 'the panel-2 row builder is present');
  // The control is gated on the snapshot flag, carries the id, and is empty otherwise.
  assert.match(rows[0], /var x = b\.cancellable\s*\? '<button class="ip-cancel" title="cancel this commission" data-commission="' \+ b\.commissionId \+ '">&#10005;<\/button>'\s*: '';/);
  // ...and it lands inside the ip-item, after the %/queued column (right-aligned).
  assert.match(rows[0], /'<span class="eta">' \+ cell \+ '<\/span>' \+ x \+ '<\/div>'/);
  // The gate is the FLAG, never the row's position: the control's expression does not read `i`.
  const gate = rows[0].match(/var x = [\s\S]*?;/)[0];
  assert.doesNotMatch(gate, /\bi\b/);
  // Styled like the console's dockyard cancel (.dk-x): a small bordered ✕ that reddens on hover.
  assert.match(html, /#tw-cn \.ip-cancel\{[^}]*width:22px; height:22px;[^}]*\}/);
  assert.match(html, /#tw-cn \.ip-cancel:hover\{color:var\(--red\); border-color:var\(--red\);\}/);
});

test('the panel click handler routes .ip-cancel → cnCancelCommission with the NUMERIC id', () => {
  assert.match(html, /var ipCancel = e\.target\.closest\('\.ip-cancel'\);\s*if\(ipCancel\)\{ cnCancelCommission\(\+ipCancel\.getAttribute\('data-commission'\)\); return; \}/);
});

test('cnCancelCommission confirms in words — no figure — then posts cancelSyndicateCommission', () => {
  const confirm = fnBody('cnCancelCommission');
  // It re-reads the row from the snapshot and bails (repainting) if it is gone or no longer cancellable.
  assert.match(confirm, /if\(!row \|\| !row\.cancellable\)\{ if\(T\.tier === 4\) renderConstructed\(\); return; \}/);
  // The shared adviser confirm, stating the mechanic qualitatively.
  assert.match(confirm, /window\.__adviserConfirm\(\{/);
  assert.match(confirm, /refunded the baseline \(minimum\) price in credits/);
  assert.match(confirm, /the prepaid delivery fuel is not returned/);
  assert.match(confirm, /onConfirm: fire/);
  // §5: no refund figure — no price read, no number formatted, no ¢ amount in the popup.
  assert.doesNotMatch(confirm, /assetPurchaseQuote|\.price|fmt\(|&#162;/);

  const post = fnBody('cnPostCancel');
  // The ruled payload through the SAME action path as the buy...
  assert.match(post, /window\.__sendAction\(\{ type:'cancelSyndicateCommission', guildId: player\.guildId, commissionId: commissionId \}\)/);
  // ...a refusal repaints, a success shows the green note and refreshes so the row drops.
  assert.match(post, /if\(!res \|\| !res\.accepted\)\{\s*if\(T\.tier === 4\) renderConstructed\(\);\s*return;/);
  assert.match(post, /cnNote\('Commission cancelled[\s\S]*?'ok'\)/);
  assert.match(post, /if\(window\.__refreshNow\) window\.__refreshNow\(\);/);
});

// --- the BUILDING head vs the queued rows (docs/asset-purchase.md §"Build concurrency"; roadmap
// 2.1d, the head/queued CLIENT slice). The Syndicate builds one commission per guild at a time; the
// snapshot flags that row `building`. The bug these pin against: the view sorted by ARRIVAL and put
// the donut, the art and the highlight on the first row — so a quick self-flying craft queued
// behind a slow-hauled miner took the "Current Build" slot while it was still waiting its turn.
// The end-to-end render of that exact case is in constructed-building-head.test.js.

test('the builds map carries the snapshot `building` flag and keeps the snapshot (FIFO) order', () => {
  const render = fnBody('renderConstructed');
  // A pure passthrough of the engine's flag, beside the other passthroughs.
  assert.match(render, /building:b\.building, commissionId:b\.commissionId, cancellable:b\.cancellable \};/);
  // No re-sort: the list reads as the queue it is (building head first), not by arrival.
  assert.doesNotMatch(render, /builds\.sort\(/);
});

test('the head is found by the `building` flag — the donut, art and label all read `head`, never `soonest`', () => {
  const render = fnBody('renderConstructed');
  assert.match(render, /var head = builds\.filter\(function\(b\)\{ return b\.building; \}\)\[0\] \|\| builds\[0\] \|\| null;/);
  // The old soonest-arrival pick is gone entirely from the view.
  assert.doesNotMatch(render, /soonest/);
  // Panel 3 — the donut's countdown, its delivery sub-note and its header tag all come from `head`.
  assert.match(render, /if\(head\)\{\s*var bt = head\.buildTicks \|\| 0, rem = head\.remaining \|\| 0;/);
  assert.match(render, /cnDur\(head\.deliver\) \+ ' delivery &middot; arrives in ' \+ cnDur\(head\.arrive\)/);
  assert.match(render, /hn = pretty\(head\.kind\) \+ ' &middot; building';/);
  // Panel 4 — the art, the dim-when-idle, and the role label all come from `head`.
  assert.match(render, /var p4art = \(head && CN_BUILD_ART\[head\.kind\]\) \|\| CN_BUILD_ART_FALLBACK;/);
  assert.match(render, /'<div class="dk-card dk-hero' \+ \(head \? '' : ' dim'\) \+ '">'/);
  assert.match(render, /'<div class="role">' \+ \(head \? pretty\(head\.kind\) : 'Idle'\) \+ '<\/div><\/div>'/);
});

test('In Progress highlights the `building` row (not row 0) and labels the rest "queued", not 0%', () => {
  const rows = html.match(/ipRows = builds\.map\(function\(b\)\{[\s\S]*?\}\)\.join\(''\);/);
  assert.ok(rows, 'the panel-2 row builder (no index argument) is present');
  // The highlight gates on the snapshot flag — the #131 pattern: the gate never reads the index.
  const cur = rows[0].match(/'<div class="ip-item' \+ \(([^)]*)\) \+ '">'/);
  assert.ok(cur, 'the ip-item class expression is present');
  assert.equal(cur[1], "b.building ? ' cur' : ''");
  assert.doesNotMatch(cur[1], /\bi\b/);
  // The right-hand cell: a % only on the building row, the word "queued" on every other row.
  assert.match(rows[0], /var cell = b\.building \? pct \+ '%' : 'queued';/);
  assert.match(rows[0], /'<span class="eta">' \+ cell \+ '<\/span>'/);
  // The per-row arrival sub-line is kept.
  assert.match(rows[0], /'<span class="sub">arrives in ' \+ cnDur\(b\.arrive\) \+ '<\/span><\/span>'/);
  // The header counts the queue honestly — only one row is building.
  assert.match(html, /\(builds\.length \? builds\.length \+ ' in queue' : 'idle'\)/);
  assert.doesNotMatch(html, /builds\.length \+ ' building'/);
});
