'use strict';

// Tests the testbed dev-harness server (slice 2, 03-08-26). It boots the real
// server on an ephemeral port and drives it over HTTP, so this is the tripwire
// that the thin HTTP layer faithfully exposes the SAME engine — and, crucially,
// that submitting an action does NOT tick (manual tick), while POST /tick does.
//
// The server holds ONE module-level state, so tests that need a clean galaxy
// POST /reset first.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_SYSTEM, HOME_PLANET, HOME_MINE } = require('./home-anchor.js');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const { makeServer } = require('../server.js');
const { STOCKPILE_GOODS } = require('../resources.js');

let server;
let base;

before(async () => {
  server = makeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  // Close the listener and any lingering keep-alive sockets so the test process
  // can exit cleanly (fetch/undici holds connections open otherwise).
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
});

// Small helpers.
async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const reset = () => req('POST', '/reset');
const found = (over = {}) => req('POST', '/action', { type: 'foundGuild', guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM, ...over });
const mine = (over = {}) => req('POST', '/action', { type: 'establishVenture', guildId: 'player-guild', ventureId: 'm1', siteId: HOME_MINE, assetId: 'asset_player-guild_miner_01', resourceType: 'titanium', productionRate: 5, ...over });

// --- read endpoints --------------------------------------------------------

test('GET / serves the PLAYER CLIENT (HTML), not the deleted testbed', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  // The player client (client-wiring.md Slice 1: `/` is the game, `/inspect` the watcher).
  assert.match(html, /<title>STARFARE<\/title>/);
  assert.match(html, /id="connectBtn"/);          // the real found/adopt flow
  assert.match(html, /shellConnectInit/);
  assert.match(html, /id="hud-guild"/);           // identity from the snapshot, not a literal
  assert.match(html, /__setLiveTerritory/);       // territory from claims[]
  assert.match(html, /\/galaxy/);                  // the seed comes from the endpoint

  // The testbed is GONE — its file and its driver controls with it.
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'client', 'testbed.html')), false);
  for (const marker of ['SYNDICATE // TESTBED', 'id="btn-found"', 'id="btn-tick"', 'id="btn-autotick"']) {
    assert.ok(!html.includes(marker), `the player client must not carry the testbed's ${marker}`);
  }
  // And the demo galaxy + its baked identity are deleted, not bypassed (§6).
  assert.ok(!html.includes('buildDemoGalaxy'), 'the demo galaxy generator must be gone');
  assert.ok(!html.includes('Vanguard'), 'the demo guild literal must be gone');

  // Slice 4: the console is the LIVE one. The embedded mock blob is deleted — its
  // URL holder, its atob() decode and its MOCK tag — and the iframe points at the
  // served /console, carrying the player's focus as a query string.
  assert.ok(!html.includes('__consoleBlobUrl'), 'the mock console blob url must be gone');
  assert.ok(!html.includes('console-mocktag'), 'the MOCK CONSOLE tag goes with the mock');
  assert.ok(!html.includes('atob('), 'nothing is decoded into a page blob any more');
  assert.match(html, /fr\.src = src/);                       // the iframe is pointed, live
  assert.match(html, /'\/console\?embed=1&guild='/);           // …at /console, with the focus
});

test('GET / serves the WIRED licence panel — the two real actions, and no mock caveat', async () => {
  const res = await fetch(base + '/');
  const html = await res.text();

  // The two-action deploy (client-wiring, licence-panel slice): the establish carries
  // the equity term, and the licence application follows it with its own two terms.
  assert.match(html, /type: 'applyForLicence'/);
  assert.match(html, /committedOutputPct: S\.c/);
  assert.match(html, /windowDays: S\.rnDays/);
  assert.match(html, /establish\.equityPct = equityFraction\(\)/);
  // The receipt reads the venture's STORED terms back off the snapshot.
  assert.match(html, /__myVenture/);
  assert.match(html, /v\.licence\.discountedFee/);
  // The cycle length is the engine's, read live — not a second copy on the client.
  assert.match(html, /snap\.calendar && snap\.calendar\.windowN/);
  assert.ok(!html.includes('TICKS_PER_CYCLE'), 'the client must not carry its own cycle length');

  // The mock caveats this slice retired are FALSE now, so they must be gone.
  for (const dead of [
    'None of it exists in the engine yet',
    'the licence economy is not built yet',
    'The licence economy is not in the engine yet',
    'every venture is created with a commitment of zero',
    'no equity is recorded anywhere yet',
    'No terms are stored yet',
  ]) {
    assert.ok(!html.includes(dead), `the wired licence panel must not still say: ${dead}`);
  }
  // The fee used to be presented as a PERCENTAGE before signing ("of basic · locked at
  // signing"), because the credit figure was not published. It is now (`feeQuote`), so
  // this pin flips rather than being dropped: the ledger's pre-sign figure is credits off
  // the engine's quote, and the "% of basic · locked at signing" rows are gone. The
  // receipt's own "LOCKED at signing" line is asserted below and is unaffected.
  assert.ok(!html.includes('of basic · locked at signing'),
    'the ledger fee rows read credits now — the relative form must be gone');
  assert.match(html, /window\.__feeQuote/);
  // This line used to pin `NOT YET CHARGED` — "3b-iii is not built; say so". 3b-iii IS
  // built, so the tripwire flips rather than being dropped: the receipt must now say the
  // rate is locked at signing AND charged at the boundary. Kept here, beside the panel's
  // other receipt assertions, so the two can never drift; the fuller wording checks live
  // in the fee-charge copy test below.
  assert.match(html, /LOCKED at signing and CHARGED at each cycle boundary/);
  assert.ok(!html.includes('NOT YET CHARGED'), 'the charge is built — the old caveat is false');
});

// --- the asset picker goes live (client-only, 31-08-26) ---------------------------
//
// The engine has required an explicit `assetId` since f1109d3, and the panel ran on a
// four-row MOCK inventory that sent nothing — so every deploy from the game client was
// refused. This slice wires the picker to the guild's real idle assets and strips the
// copy that said the opposite of what the engine enforces. Both halves are pinned on the
// SERVED BYTES: a page that quietly reverted would still render perfectly, and only this
// would go red.
test('GET / serves the REAL asset picker — the snapshot\'s idle inventory, and the picked assetId on the deploy', async () => {
  const html = await (await fetch(base + '/')).text();

  // The mock inventory is GONE — array, ids and all.
  assert.ok(!html.includes('var INVENTORY = ['), 'the mock asset inventory must be deleted, not just unused');
  for (const fake of ['AST-114', 'AST-118', 'AST-231', 'AST-240']) {
    assert.ok(!html.includes(fake), `the mock asset id ${fake} must be gone`);
  }

  // What replaces it: the player's OWN assets off the snapshot, filtered to idle by the
  // ENGINE's own answer — the browser must not re-derive "is this one deployed?".
  assert.match(html, /LIVE\.myAssets = \(me && me\.assets\) \|\| \[\]/);
  assert.match(html, /window\.__myIdleAssets = function\(kind\)/);
  assert.match(html, /a\.kind === kind && a\.deployedToVentureId == null/);
  assert.match(html, /window\.__myIdleAssets \? window\.__myIdleAssets\(kind\) : \[\]/);
  // …and the display is derived from the real fields, not stored beside them.
  assert.match(html, /Math\.round\(\(a\.maintenanceCondition \|\| 0\) \* 100\)/);

  // The picked machine rides the deploy. This is the whole point of the slice.
  assert.match(html, /assetId: S\.asset\.id,/);
  assert.ok(!html.includes('no assetId'), 'the comment claiming the deploy sends no assetId is false now');

  // The empty pool is the CLIENT's message to own: the engine speaks only about the id
  // it was handed, so "you are out of machines" has no engine refusal behind it.
  assert.match(html, /no idle '\+kindPlural\(kind\)\+' in inventory/);

  // GATE 3 pre-gated in the browser, with the engine's refusal still the backstop.
  assert.match(html, /var held = !!\(S\.site && S\.site\.mine\);/);
  assert.match(html, /var ok = held && !!S\.asset/);
  assert.match(html, /deploy requires holding it first/);
  assert.match(html, /only deploy in a system you hold/);
  assert.match(html, /failHint\('Refused: ' \+ \(out\.reason/);
});

test('GET / serves the DE-MOCKED establish panel — every retired string, and the honest replacements', async () => {
  const html = await (await fetch(base + '/')).text();

  // The exact strings this slice removed. Pinned ABSENT so a merge cannot bring back a
  // caption that contradicts the engine — the failure mode the fee-charge slice named.
  for (const dead of [
    '— your own claim.',
    'Establishing here is allowed; leasing is not built yet.',
    'Asset inventory is design-ahead (§4 — `assetId` is reserved, not built). Nothing is consumed, and no asset is sent with the deploy.',
    'the curve below is the designed <b class="amber">shape</b> of that fee, not the figure you will owe.',
    'Indicative. The relief above is §5\'s designed grid;',
    'Reputation is design-ahead (#61) — no standing is recorded or moved yet.',
    'Licence fee — % of basic, across commitment',
    'it will be consumed to stand this venture up',
    'the inventory above is a mock, nothing is consumed',
    'Mock · no engine',
    'Real · sent to the engine',
  ]) {
    assert.ok(!html.includes(dead), `the de-mocked panel must not still say: ${dead}`);
  }
  // The tag CLASSES go with the tags: nothing on this panel is a mock any more, and a
  // "real" badge only means something beside one that says otherwise. The summary
  // ledger's green "this row is real" key is the same distinction in quieter form and
  // goes with them — a green subset would now imply the rest is less true.
  for (const cls of ['mocktag', 'mocknote', 'minitag']) {
    assert.ok(!html.includes(cls), `the ${cls} class is orphaned — it must go with the tags`);
  }
  assert.ok(!html.includes('class="row real"'), 'the ledger\'s real-vs-mock key marker is orphaned too');
  assert.ok(!html.includes('.ledger .row.real'), 'and so is the CSS behind it');
  // The fee-graph label is now just the label.
  assert.match(html, /<span class="lbl">Licence fee<\/span>/);

  // The Breach row carries a credit figure again — but the ENGINE's, not a fabricated
  // per-tier constant. The mock table stays deleted; the number comes from `feeQuote`.
  assert.ok(!html.includes("P.BASIC_FEE"), 'the invented per-tier breach amount stays gone');
  assert.ok(!html.includes('BASIC_FEE: { 1:120'), 'and so does the constant behind it');
  assert.match(html, /setRow\('tBreach', basic === null \? '—' : \('<b>'\+fmt\(basic\)\+' ¢<\/b>'\)\)/);

  // OCCUPY, NOT CONSUME — §4's rule, in the copy a player actually reads.
  assert.match(html, /occupied, not consumed/);
  assert.match(html, /Deploying <em>occupies<\/em> the machine, it does not consume it/);
  // …and condition is displayed but inert: the reel must not promise it does anything.
  assert.ok(!html.includes('a well-kept machine runs closer to its rating'),
    'condition never touches production (§4) — the reel must not say it does');
  assert.match(html, /condition never changes a production rate/);
});

// --- the fee reaches the player in CREDITS (client-only, 31-08-26) ----------------
//
// `feeQuote` (sim/snapshot.js) publishes the basic licence fee in credits per good,
// pinned equal to what `applyForLicence` charges. The panel used to show the fee as a
// PERCENTAGE of a basic nobody published, which told a player nothing. These pins are on
// the SERVED bytes: a page that reverted to the percentage would still render perfectly,
// and only this would go red.
test('GET / serves the fee in CREDITS — the ledger reads the engine\'s feeQuote', async () => {
  const html = await (await fetch(base + '/')).text();

  // The bridge: one narrow read of the snapshot's own row, like `__windowN` beside it.
  assert.match(html, /window\.__feeQuote = function\(good\)/);
  assert.match(html, /LIVE\.snap && LIVE\.snap\.feeQuote/);
  // …and the panel goes through it, keyed on the good the venture will produce.
  assert.match(html, /window\.__feeQuote\(S\.outGood\)/);

  // Breach = the WHOLE basic fee (the discount is void on a shortfall, §5); Fee = that
  // basic times the relief the sliders already draw — the client's only arithmetic.
  assert.match(html, /setRow\('tFee', basic === null \? '—' : \('<b>'\+fmt\(Math\.round\(basic \* fp \/ 100\)\)\+' ¢<\/b>'\)\)/);
  assert.match(html, /setRow\('tBreach', basic === null \? '—' : \('<b>'\+fmt\(basic\)\+' ¢<\/b>'\)\)/);

  // Graceful absence: a good with no quote shows a dash, never `NaN ¢` and never a 0
  // that would read as a free licence.
  assert.match(html, /function quotedBasicFee\(\)/);
  assert.match(html, /typeof q === 'number' && isFinite\(q\)/);

  // Untouched, deliberately: the unlicensed rows, and the relief graph's own readout —
  // a percentage is the curve's natural unit, and this slice converts only the ledger.
  assert.match(html, /setRow\('tFee','<b class="green">0 ¢<\/b>'\); setRow\('tBreach','<span class="mut">n\/a<\/span>'\)/);
  assert.match(html, /\$\('feePctBig'\)\.textContent = Math\.round\(fp\)\+'%'/);

  // The copy that said no pre-sign figure could exist is FALSE now, and gone with it.
  for (const dead of [
    'of basic · locked at signing',
    'cannot be quoted before it',
    'the % above is the designed relief, not the amount',
    'no number computed before signing can be the one charged',
  ]) {
    assert.ok(!html.includes(dead), `the fee is quoted now — the panel must not still say: ${dead}`);
  }
});


// The TRADE tab (design.md §5, "SELL GOES LIVE"). A client-render tripwire on the
// SERVED bytes: if the tab quietly reverted to the old Marketplace stub, or the sell
// wiring was dropped, the page would still render perfectly and only this fails.
test('GET / serves the TRADE tab — the renamed tab, the panel, and the sellToSyndicate wiring', async () => {
  const html = await (await fetch(base + '/')).text();

  // The tab is RENAMED, and the old name is gone.
  assert.match(html, /<button class="rtab" onclick="openTab\('market', this\)">TRADE<\/button>/);
  assert.ok(!html.includes('Syndicate Marketplace'), 'the old tab name is gone');
  // ...and `market` is no longer one of the stub tabs (the two that still are, are).
  assert.ok(!/TAB_STUBS = \{\s*market:/.test(html), 'market is no longer a stub');
  assert.ok(!html.includes('this is where the Market slice lands'), 'the stub copy is gone');

  // The panel itself: the picker, the chart, the Holdings hero, the SELL card, and
  // the two deferred placeholders.
  assert.match(html, /id="tp-trade"/);
  assert.match(html, /id="tw-tiers"/);
  assert.match(html, /id="tw-reslist"/);
  assert.match(html, /id="tw-chart"/);
  assert.match(html, /id="tw-inv"/);
  assert.match(html, /id="tw-sysalloc"/);      // the PER-SYSTEM allocation table
  assert.match(html, /id="tw-proceeds"/);
  assert.match(html, /id="tw-sellbtn"/);
  assert.match(html, />Open Market</);
  assert.match(html, />Your Listings</);

  // The sale itself: the ruled action shape, posted through the shell's own /action
  // path. `allocations` is the load-bearing word — a guild-wide qty would be the
  // rejected design.
  assert.match(html, /type:'sellToSyndicate'/);
  assert.match(html, /allocations: r\.rows/);
  assert.match(html, /window\.__sendAction\(\{ type:'sellToSyndicate'/);

  // BUY is present and DIMMED — it needs the transport system (§5, deferred).
  assert.match(html, /class="tw-mbtn na"/);

  // FUEL SLICE 3: the SELL panel carries a Fuel row, and it READS the engine's
  // per-system quote rather than pricing a route itself. `guild.fuelCost` is the
  // load-bearing string — the browser holds no seed geometry and no burn rate, so
  // a hardcoded number here would be a game figure invented in the client.
  assert.match(html, /id="tw-fuelcost"/);
  assert.match(html, /guild\.fuelCost/);
  assert.match(html, /q\.fuelBurn \|\| 0/);
  assert.match(html, /q\.creditCost \|\| 0/);
  // The short-fuel pre-gate, naming both numbers exactly as the engine's refusal does.
  assert.match(html, /Not enough fuel — need/);
  assert.ok(!/SYNDICATE_HAULER_BURN_RATE|hexDistance|nearestWaystation/.test(html),
    'the client must never carry the burn rate or the geometry — it reads fuelCost');

  // ...and BUY stays unwired in this slice: no confirm popup, no buy action posted.
  assert.ok(!html.includes("type:'buyFromSyndicate'"),
    'the BUY confirm (with its own fuel row) lands with the BUY UI slice, not here');

  // THE WIRING SEAM, pinned so it cannot silently move to the console bridge: the tab
  // reads the shell's own snapshot and posts to /action. No postMessage, no console.
  assert.match(html, /window\.__snapshot/);
  const tradeBlock = html.slice(html.indexOf('<script id="trade-tab-wire">'), html.indexOf('<script id="ind-hero-wire">'));
  assert.ok(tradeBlock.length > 1000, 'the trade wiring block is served');
  // Checked as CALLS, not as words: the block's own header says "no postMessage
  // bridge", and a prose mention must not read as a violation.
  assert.ok(!/\.postMessage\s*\(/.test(tradeBlock), 'the TRADE tab sends no postMessage — it rides no console bridge');
  assert.ok(!/contentWindow/.test(tradeBlock), 'the TRADE tab talks to no iframe');
  assert.ok(!/src\s*=\s*['"]?\/?console/.test(tradeBlock), 'the TRADE tab embeds no console');
});

// The finished TRADE chart (29-08-26). Three things a page could lose silently — it
// would still render, and only this would fail: the scale buttons reverting to the raw
// ring keys, the reference line being dropped, and the width cap coming back.
test('GET / serves the finished TRADE chart — the mapped scales, the priceBase line, full width', async () => {
  const html = await (await fetch(base + '/')).text();
  const trade = html.slice(html.indexOf('<script id="trade-tab-wire">'), html.indexOf('<script id="ind-hero-wire">'));
  const { TIER_KEYS } = require('../price-history.js');

  // THE MAPPING, exactly as docs/phase-1-tuning.md rules it. Pinned as the four
  // (button, ring, window) triples rather than as loose strings, so a mis-mapped
  // button — 1M reading `medium`, say — fails here instead of drawing the wrong
  // fortnight. `take` is the most-recent-N window: 0 = the whole ring.
  for (const [key, ring, take] of [['3D', 'fine', 0], ['2W', 'medium', 0], ['1M', 'coarse', 30], ['3M', 'coarse', 0]]) {
    assert.match(
      trade,
      new RegExp(`\\{ key:'${key}', +ring:'${ring}', +take:${take}\\b`),
      `the ${key} button must read the ${ring} ring at window ${take || 'all'}`,
    );
  }
  // ...and the ring names the mapping points at really are the engine's, so a rename
  // in sim/price-history.js breaks this rather than the chart.
  for (const ring of TIER_KEYS) assert.match(trade, new RegExp(`ring:'${ring}'`));

  // The buttons are LABELLED by scale, never by ring key. The old rendering built them
  // straight from the snapshot's keys; if that ever comes back, this fires.
  assert.match(trade, /data-scale="'\+sc\.key\+'"[^>]*>'\+sc\.key\+'<\/button>/);
  assert.ok(!/data-scale="'\+k\+'">'\+k\+'</.test(trade), 'the buttons are no longer the raw ring keys');
  assert.ok(!/hist\.keys/.test(trade), 'and the old "buttons = the snapshot ring keys" reader is gone');

  // The reference line reads the snapshot's priceBase — per good, and drawn only when
  // there is one (no invented base).
  assert.match(trade, /s\.priceBase\) \? s\.priceBase\[good\] : null/);
  assert.match(trade, /function baseOf\(good\)/);
  assert.match(trade, /base &#162;/, 'the base line carries its own label');
  assert.match(trade, /if\(base != null\)\{ lo = Math\.min\(lo, base\); hi = Math\.max\(hi, base\); \}/,
    'and the base is folded into the y-range, so it cannot be clipped off the chart');

  // Full width, and the scale row can no longer be squashed under its own buttons.
  assert.match(html, /#tp-trade \.tw-wrap\{max-width:none;/);
  assert.ok(!/#tp-trade \.tw-wrap\{max-width:1440px/.test(html), 'the width cap is gone');
  assert.match(html, /#tp-trade \.tw-scales\{[^}]*flex:0 0 auto;\}/);
  assert.ok(!/#tp-trade \.tw-scales\{[^}]*min-height:14px/.test(html), 'the under-size that caused the footer collision is gone');
});

// The panel MIRRORS four engine constants there is no endpoint to fetch (and pins its
// sliders to the ranges the engine validates). Duplication is only safe with a
// tripwire: if any of these move in sim/, this fails instead of the panel quietly
// showing the old number or offering a term the engine would refuse.
test('the served licence panel\'s mirrored constants still match the engine', async () => {
  const html = await (await fetch(base + '/')).text();
  const licence = require('../licence.js');
  const { baselineOutputFor } = require('../baseline.js');
  const { TIER_WEIGHT } = require('../points.js');

  assert.match(html, new RegExp(`EQUITY_CEIL: ${licence.EQUITY_CEILING * 100},`),
    'the equity slider ceiling must be sim/licence.js EQUITY_CEILING x 100');
  assert.match(html, new RegExp(`K: ${licence.EQUITY_SHAPE_K},`),
    'the fee curve must use the engine\'s equity shaping exponent');
  assert.match(html, new RegExp(
    `CORNERS: \\{ minCommitMinOffer:${licence.CORNERS.minCommitMinOffer}, `
    + `minCommitMaxOffer:${licence.CORNERS.minCommitMaxOffer}, `
    + `maxCommitMinOffer:${licence.CORNERS.maxCommitMinOffer}, `
    + `maxCommitMaxOffer:${licence.CORNERS.maxCommitMaxOffer} \\}`),
    'the fee curve must use the engine\'s four corners');

  // The commitment preview is round(pct x BASELINE x N): the baseline is the mirror.
  const baseline = baselineOutputFor({ type: 'mining', resourceType: 'titanium' }).units;
  assert.match(html, new RegExp(`BASELINE_RATE: ${baseline},`),
    'the commitment preview must use the engine\'s droidless mine baseline');
  // …and since the factory-commitment slice (28-08-26) that ONE mirrored constant is
  // also what the panel previews a TIER-2 licence with. It is right today only because
  // every mine and every recipe currently sits on the same uniform [FIRST-CUT] baseline.
  // The day per-resource / per-recipe baselines differentiate (phase-1-tuning.md), this
  // goes red — which is the point: the panel must then carry a per-venture baseline
  // rather than quietly previewing a commitment the engine will not store.
  const factoryBaseline = baselineOutputFor({ type: 'refining', recipeId: 'titanium_alloy' }).units;
  assert.equal(factoryBaseline, baseline,
    'the licence panel mirrors ONE baseline for both tiers — differentiate them and it must gain a second');

  // The TIER WEIGHTS (02-09-26). The reputation meter previews `metGain`, which the
  // rescale scaled by `tierFactor` = W_TIER(tier) / W_TIER(1) — so the panel has to hold
  // the weights to preview a tier-2 licence at the 1.5x the engine really pays. Mirrored
  // as the WEIGHT MAP, key for key, exactly as CORNERS above is: the panel divides by its
  // own tier-1 entry the way sim/licence.js divides by `tierWeight(1)`, so a retune that
  // moves both leaves the preview right and one that moves either alone fails HERE.
  // Built from sim/points.js' own map, so ADDING a tier (W_T3, when tier-3 goods gain
  // recipes) goes red too — the panel must then mirror it or stop previewing that tier.
  const tiers = Object.keys(TIER_WEIGHT).map((t) => `${t}:${TIER_WEIGHT[t]}`).join(', ');
  assert.match(html, new RegExp(`TIER_WEIGHT: \\{ ${tiers} \\},`),
    'the reputation meter must mirror sim/points.js TIER_WEIGHT, key for key');

  // …and it is APPLIED: the earn preview carries the tier term, and the call site passes
  // the tier the panel is deploying at. Without both, the mirror above would sit unread
  // and a factory would go back to previewing a mine's gain.
  assert.match(html, /function repGain\(c, o01, tier\)\{ return P\.REP_MAX\*tierFactor\(tier\)\*/,
    'the earn preview must be scaled by the tier factor');
  assert.match(html, /repGain\(S\.c,S\.o01,S\.tier\)/,
    'and the meter must pass the venture\'s own tier');

  // The one-time SIGNING BUMP stays out of the panel BY DESIGN (§2.6: the player's lever
  // is the commitment slider; the bump is its backend consequence). This pins that
  // decision rather than leaving a later session to read the absence as an oversight.
  assert.ok(!/signingBump/.test(html), 'the deploy panel does not preview the signing bump — deliberate, §6.1');

  // The term ranges the sliders can produce are exactly the ones intake accepts.
  assert.match(html, new RegExp(`id="rnRange" min="${licence.WINDOW_DAYS_MIN}" max="${licence.WINDOW_DAYS_MAX}"`));
  assert.match(html, new RegExp(`id="oRange" min="0" max="${licence.EQUITY_CEILING * 100}"`));
  assert.match(html, /id="cRange" min="0" max="100"/);   // commitment: a 0..1 fraction
});

// --- the MEAN LINE, per guild (slice 4, 31-08-26) ---------------------------------
//
// docs/points-and-reputation.md §3. The engine derives `expectedReputation` and
// `issuanceModifier` (sim/meanline.js) and publishes both per guild in the snapshot.
//
// ⏪ THE CONSOLE'S MEAN-LINE READOUT WAS REVERTED 01-09-26 (§6.1, Slice 1b), so the two
// served-page tripwires that guarded it went with the markup: that /console read the pair
// off the snapshot and reimplemented neither, and that its mirrored ISSUANCE_FLOOR /
// ISSUANCE_CEIL labels still matched sim/meanline.js. Both asserted MARKUP; neither
// touched the engine. The readout is deferred to the player-facing Guild Hall, and the
// snapshot test below is the standing proof that nothing engine-side moved with it.

test('GET /snapshot carries the mean line per guild, from the engine helpers', async () => {
  await reset();
  await found();
  await mine();
  const { body: snap } = await req('GET', '/snapshot');
  const g = snap.guilds.find((x) => x.id === 'player-guild');
  const { MEANLINE_K, ISSUANCE_FLOOR } = require('../meanline.js');

  // One home system + one Tier-1 mine = 300 GP (pinned by the GP slice), so the bar is
  // 300 × 1 — stated by hand rather than recomputed from the helper under test.
  // ⤳ RESCALED 01-09-26 (§2.6): GP 18 → 300, and at k = 1 the bar simply IS the GP.
  assert.equal(g.guildPoints, 300);
  assert.equal(g.expectedReputation, MEANLINE_K * 300);
  assert.equal(g.expectedReputation, 300);
  // ⚠ SUPERSEDED 31-08-26 BY THE FOUNDING ENDOWMENT (A′, points-and-reputation.md §2.5).
  // This used to assert a brand-new guild sat at the FLOOR with zero reputation — the
  // punishing-for-ambition lean, visible from the first tick. That was the defect the
  // endowment exists to fix: the mean line could not tell "just founded, hasn't had a
  // chance" from "holds territory and does nothing with it", and throttled every newborn
  // to 30% fuel before it could earn anything.
  //
  // Founding now grants `MEANLINE_K × W_SYS` once, neutralising the HOME SYSTEM's bar. So
  // this guild's 300 GP is its home system (endowed, 200) plus one established mine
  // (NOT endowed — ventures earn their own bar), and it sits just below its line rather
  // than pinned at the floor: the venture it deployed is the part it still has to earn.
  const { W_SYS } = require('../points.js');
  assert.equal(g.foundingEndowment, MEANLINE_K * W_SYS);
  assert.equal(g.foundingEndowment, 200, 'the home system, neutralised exactly once');
  assert.equal(g.guildReputation, 200, 'all of it endowment — the mine has earned nothing yet');
  assert.ok(g.issuanceModifier > ISSUANCE_FLOOR,
    'a newborn is no longer pinned at the floor');
  assert.ok(g.issuanceModifier < 1,
    'but its un-earned venture still leaves it below its line — ventures are not endowed');
  assert.ok(Number.isFinite(g.issuanceModifier));
});

// --- GUILD POINTS, per guild (GP slice 3, 31-08-26) -------------------------------
//
// docs/points-and-reputation.md §1/§1.0. GP is DERIVED by the engine (sim/points.js) and
// published per guild in the snapshot.
//
// ⏪ THE CONSOLE'S GP READOUT WAS REVERTED 01-09-26 (§6.1, Slice 1b), taking its one
// served-page tripwire with it — that /console read `guildPoints` straight and
// reimplemented no part of the weighting. That guarded markup, not the derivation. The
// number is unchanged and still published; the test below pins it against the engine
// helper, as it always did.

test('GET /snapshot carries guildPoints per guild, equal to the engine helper', async () => {
  await reset();
  await found();
  await mine();
  const { body: snap } = await req('GET', '/snapshot');
  const g = snap.guilds.find((x) => x.id === 'player-guild');

  const { W_SYS, TIER_WEIGHT } = require('../points.js');

  assert.ok(Number.isInteger(g.guildPoints), 'GP is an integer (§15.2)');
  // Stated by hand rather than recomputed: founding seats the guild on ONE home system
  // (its own claim row) and `mine()` establishes ONE titanium mine, so the size of this
  // galaxy is one system plus one Tier-1 venture and nothing else.
  assert.equal(g.guildPoints, W_SYS + TIER_WEIGHT[1]);
  assert.equal(g.guildPoints, 300);   // ⤳ RESCALED 01-09-26 (§2.6): 12 + 6 → 200 + 100

  // DERIVED, so reading it twice cannot accumulate — the failure mode a stored counter
  // would have, and the reason §1.0 rules GP a helper instead of a field.
  const { body: again } = await req('GET', '/snapshot');
  assert.equal(again.guilds[0].guildPoints, g.guildPoints);
});

// --- the console's REPUTATION readout (RP dev-panel slice, 31-08-26) ---------------
//
// ⏪ REVERTED 01-09-26 (docs/points-and-reputation.md §6.1, Slice 1b). The Production
// Console's band gauge came off with the rest of the guild-economy block, and its five
// served-page tripwires came off with it: that the console read `guild.guildReputation`
// and `ventures[].reputation` straight and never re-summed them; that the gauge's only
// arithmetic was the bar position; that a floored venture read PINNED and never "closed";
// that the mirrored RP_FLOOR / RP_TAPER_KNEE / RP_SOFT_CAP still matched sim/licence.js;
// and that the two tier marks still matched §2.1's ruling.
//
// EVERY ONE OF THOSE GUARDED MARKUP. Reputation itself is untouched: sim/licence.js still
// owns the band, the tick still moves RP off the met/breach verdict, `checkGuildReputationSum`
// still guards the total every tick, and the snapshot still carries both fields
// (sim/tests/reputation.test.js, plus the mean-line snapshot test above, which reads
// `guildReputation` off a founded guild). When the Guild Hall renders RP it gets its own
// tripwires, including fresh mirrors of those five constants — which, as of this commit,
// live in no client file at all.

test('GET /assets/<path> serves the client\'s art, and refuses a path that escapes', async () => {
  // A real file the client references (client/assets/planets/rocky.jpg).
  const ok = await fetch(base + '/assets/planets/rocky.jpg');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') || '', /image\/jpeg/);
  const bytes = Buffer.from(await ok.arrayBuffer());
  assert.ok(bytes.length > 0, 'the asset has content');
  assert.equal(bytes[0], 0xff, 'JPEG magic byte 1');   // it is the file, not an error page
  assert.equal(bytes[1], 0xd8, 'JPEG magic byte 2');

  // Traversal, in the forms a caller can actually send: a literal `..`, an
  // encoded one, and an absolute path. None may return a file.
  for (const bad of ['/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/../../sim/server.js', '/assets//etc/passwd']) {
    const res = await fetch(base + bad);
    assert.ok(res.status === 403 || res.status === 404, `${bad} must be refused, got ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('makeServer'), `${bad} must not return sim/server.js`);
  }

  // An unknown asset is a 404, not a 500.
  const miss = await fetch(base + '/assets/planets/nope.jpg');
  assert.equal(miss.status, 404);
});

test('GET /console serves the player-facing Production Console (HTML)', async () => {
  const res = await fetch(base + '/console');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  // The Archive-styled console page (not the testbed, not the JSON probe).
  assert.match(html, /System Production Console/);
  // Its driver controls + the live-wired scaffolding are present (a client-render
  // tripwire mirroring the GET / pin): tick, the resource bar, the Gate-1 arms, the
  // reserve level control, the syndicate send control, and the commitment readout —
  // all reading the schema-7 snapshot, computing no game number.
  assert.match(html, /id="btnTick"/);
  assert.match(html, /id="resbar"/);
  assert.match(html, /class="prank"/);         // Gate-1 priority selects
  assert.match(html, /rs-field/);              // reserveLevel control (the restructure's field)
  assert.match(html, /sy-rate-in/);            // Syndicate send control
  assert.match(html, /commitmentReadout/);     // the windowed-accrual readout, from `window`
  assert.match(html, /systemReport/);          // reads the snapshot production block
  // The Syndicate roster reads the PER-VENTURE licence outcome (§5's real met/breach)
  // and writes the good's `pursue` ranking — the console-rewire slice. Both are pinned
  // because both are the whole point of that panel: the row's dot must come from the
  // venture's own verdict, not the good's rollup, and the ranking must be settable.
  assert.match(html, /perVenture/);            // the per-licence verdict the rows render
  assert.match(html, /reconcilePursueIds/);    // display order mirrors the engine's fill order
  assert.match(html, /class="pu-btn pu-up"/);  // the reorder movers
  assert.match(html, /pursue: ids/);           // …POSTing setProductionProfile { pursue }
  // Auto-tick watch UI (Phase 1 Stage 2): the console's LIVE / PAUSE-VIEW toggle —
  // a client-side refresh freeze only (no /autotick control: a player cannot pause
  // a persistent real-time world).
  assert.match(html, /id="btnLive"/);
});

// --- the console/HUD legibility pass (28-08-26) -------------------------------------
// These pin the four client-side fixes as SERVED BYTES, the way every earlier client
// slice is pinned: a page that silently reverted would still render, so the tripwire has
// to be on the text itself.
test('GET /console serves the legibility pass: durations, place names, one label font', async () => {
  const html = await (await fetch(base + '/console')).text();

  // (1) `ticksRemaining` is a count of MINUTES, said as a duration. The old readout
  // printed it as hours — 60x wrong — so both the helper and the absence of the old
  // string are pinned.
  assert.match(html, /function fmtTicksAsDuration/);
  assert.ok(!html.includes("' hours remaining'"), 'ticks must never be relabelled as hours');
  assert.ok(!html.includes('u/hr'), 'a per-TICK rate must not be labelled per hour either');

  // (2) A venture is named by its PLACE, off the snapshot's `site.name` — the console
  // reads that name, it does not build one (design.md §5's display rule).
  assert.match(html, /function ventName/);
  assert.match(html, /v\.site && v\.site\.name/);
  assert.ok(!html.includes("<div class=\"sid\">' + esc(l.id)"), 'the roster row must not print the raw venture id');

  // (3) The Syndicate panel's footer is three engine figures, not a paragraph.
  assert.match(html, /function synStats/);
  assert.match(html, /class="sm-stats"/);
  assert.ok(!html.includes('the thermometer is the good\'s whole window'), 'the footer prose is retired');

  // (4) The trend column's label shares the console's one label font, and its sparkline
  // stands at the height it is drawn at (a single rule owns it now).
  assert.match(html, /\.tcard \.tc-name\{[^}]*font-family:var\(--mono\)/);
  // 66 -> 132 with the persistent-history slice: the column was a thin strip and a real
  // swing read as flat. The viewBox and this height move TOGETHER (that is what keeps the
  // vertical axis 1:1 under preserveAspectRatio="none"), so both are pinned here.
  assert.match(html, /\.tc-spark\{width:100%; height:132px/);
  assert.match(html, /var SPARK_W = 150, SPARK_H = 132;/);
  assert.ok(!html.includes('.tcard .tc-spark{width:100%; height:52px}'), 'the height conflict is gone');
});

// The persistent-history slice, pinned as SERVED BYTES for the same reason: a silent
// revert to the browser-side buffer would still render a graph, just a private one that
// empties on every reload.
test('GET /console plots the trend from ENGINE history, at the taller undistorted size', async () => {
  const html = await (await fetch(base + '/console')).text();

  // (1) The series comes off the snapshot's per-system `history` map, not a client ring.
  assert.match(html, /function trendSeries/);
  assert.match(html, /report\.history\[good\]/);
  assert.ok(!html.includes('function pushTrend'), 'the client-side accumulation is gone');
  assert.ok(!html.includes('var TREND_N'), 'and so is its cap');

  // (2) "gathering history…" is HTML over the box, never <text> inside the
  // non-uniformly scaled SVG — that is what was stretching the glyphs.
  assert.match(html, /class="tc-msg">gathering history/);
  assert.ok(!html.includes('font-family="IBM Plex Mono">gathering history'), 'the distorted in-SVG placeholder is retired');
  assert.match(html, /\.tc-empty \.tc-msg\{position:absolute/);
});

// --- the fee-charge copy catch-up (licence Slice 3b-iii, client-only) --------------
//
// Slice 3b-iii made the engine debit the licence fee at each cycle boundary, which turned
// two player-facing lines into lies: the console's Syndicate footer said the fee "is not
// charged yet", and the game's licence receipt said it was "NOT YET CHARGED". Copy that
// contradicts the engine is worse than copy that says nothing, and it rots quietly — a
// player believes it and no test goes red. So the new wording is pinned as SERVED BYTES,
// and the old strings are pinned ABSENT so they cannot creep back in a merge.
test('GET /console tells the truth about the fee: charged at the boundary, met vs breached', async () => {
  const html = await (await fetch(base + '/console')).text();

  // The stale claims — the visible footer AND the comments that asserted the charge was
  // unbuilt — are gone, every one of them.
  for (const dead of [
    'The fee is not charged yet',
    'the fee is not charged yet',
    'the charge is not built',
    'still unbuilt is the FEE',
    'does not have yet is the FEE',
  ]) {
    assert.ok(!html.includes(dead), `the console must not still say: ${dead}`);
  }

  // What it says instead: the mechanic, in §5's terms — a charge at each cycle boundary,
  // the discounted fee on met and the full basic fee on breach.
  assert.match(html, /The licence fee is charged at each cycle boundary/);
  assert.match(html, /the full basic fee if it breached/);

  // And the last charge itself, read off the snapshot's per-guild `licenceFee` record —
  // labelled GUILD-WIDE, because the lump spans every system and good while this panel is
  // one good (sim/tick.js Layer 2). The browser computes no part of it.
  assert.match(html, /function synFeeFoot/);
  assert.match(html, /g\.licenceFee/);
  assert.match(html, /across all your licences, guild-wide/);
  assert.match(html, /Nothing charged yet/);
  assert.match(html, /esc\(synFeeFoot\(\)\)/);
});

test('GET / tells the truth on the licence receipt — and leaves the STILL-TRUE caveats alone', async () => {
  const html = await (await fetch(base + '/')).text();
  for (const dead of ['NOT YET CHARGED', 'the fee debit is not built']) {
    assert.ok(!html.includes(dead), `the receipt must not still say: ${dead}`);
  }
  assert.match(html, /The rate is LOCKED at signing and CHARGED at each cycle boundary/);
  assert.match(html, /if you deliver your whole commitment that cycle/);
  assert.match(html, /if you fall short/);

  // The caveats that are STILL TRUE after 3b-iii stay put. This catch-up corrects what the
  // charge falsified and NOTHING else — a blanket sweep of every "no fee"/"not built"
  // mention would have deleted five true statements, so they are pinned present here.
  assert.match(html, /No fee is owed/);                                  // an unlicensed venture owes none
  assert.match(html, /with no fee and no commitment/);                   // …said again on the summary
  assert.match(html, /designed <em>shape<\/em> of that discount/);        // the pre-sign graph is a shape, not a quote
  assert.match(html, /Renegotiation itself is not built yet/);           // #64
  // §4 WAS on this list. The asset economy is BUILT and the panel is wired to it
  // (the asset-picker slice, 31-08-26), so the caveat is false and the assertion
  // FLIPS rather than being dropped — the same treatment `NOT YET CHARGED` got above.
  assert.ok(!html.includes('the asset economy is not built yet'),
    'the asset economy is built and the picker is wired — the old caveat is false');
});

test('GET / serves the SYNCED tick ring — the server\'s period, the observed tick\'s phase', async () => {
  const html = await (await fetch(base + '/')).text();
  // The ring is no longer a free-running 60 s sweep from page load: its period is the
  // operator's own auto-tick interval off /health, and its phase resets when the poll
  // observes the tick move. Both facts come from the server; the client counts nothing.
  assert.match(html, /function noteTick/);
  assert.match(html, /noteTick\(snap\.tick\)/);
  assert.match(html, /__tickPeriodMs = \(at && Number\.isFinite\(at\.intervalMs\)/);
  assert.ok(!html.includes('/60000)%1'), 'the hardcoded 60 s sweep must be gone');
});

test('GET /console serves the RESTRUCTURED console (the authoritative design)', async () => {
  const res = await fetch(base + '/console');
  assert.equal(res.status, 200);
  const html = await res.text();
  // The restructure's frame and columns (docs/mockups/console_restructure.html).
  assert.match(html, /composeManifest/);           // the 3-zone frame is composed at boot
  assert.match(html, /zone-celestial/);
  assert.match(html, /zone-industrial/);
  assert.match(html, /flow-r/);                    // the 7:15:10 inner flow
  assert.match(html, /grid-template-columns:7fr 15fr 10fr/);
  assert.match(html, /producersCol2/);             // trend card + venture stack
  assert.match(html, /consumersCol2/);
  assert.match(html, /reservePanel2/);             // stockpile strip + the two top-up squares
  assert.match(html, /synTherm/);                  // the Syndicate thermometer
  assert.match(html, /trendSpark/);

  // The design file's mock BACKEND must not have come along for the ride: this page
  // reads the live engine, and nothing mock may be presented as live.
  for (const marker of ['MOCK_GOODS', 'mockDerive(', 'mockTick(', 'apiLive', 'seedSeries']) {
    assert.ok(!html.includes(marker), `the console must not carry the mockup's ${marker}`);
  }
  // The two design-ahead panels that DO remain are tagged as mock on screen.
  assert.match(html, /mocktag/);
  assert.match(html, /mock · no engine/);
});

test('GET /starters lists the seed\'s startable home systems', async () => {
  const { status, body } = await req('GET', '/starters');
  assert.equal(status, 200);
  // 368 starter-eligible systems in seed 7331. Pinned on purpose: if this ever
  // changes, the seed changed under us and we want to be told loudly.
  assert.equal(body.count, 368);
  assert.equal(body.starters.length, 368);
  // Shape: each carries what the picker shows plus the homeworld a guild seats on.
  const s0 = body.starters[0];
  assert.deepEqual(Object.keys(s0).sort(), ['id', 'name', 'ring', 'terranHomeworldId']);
  // Starter-eligible ⟺ it has a Terran homeworld, so none may be null.
  assert.ok(body.starters.every((s) => typeof s.terranHomeworldId === 'string' && s.terranHomeworldId.length > 0));
  // Deterministic, id-sorted; the endpoint's first starter matches the fixture's HOME_SYSTEM.
  assert.equal(s0.id, HOME_SYSTEM);
  for (let i = 1; i < body.starters.length; i++) {
    assert.ok(body.starters[i - 1].id < body.starters[i].id, 'starters must be id-sorted');
  }
});

test('GET /system/:id returns a system\'s static layout (planets, nodes, slots)', async () => {
  const { status, body } = await req('GET', `/system/${HOME_SYSTEM}`);
  assert.equal(status, 200);
  assert.equal(body.id, HOME_SYSTEM);
  assert.equal(body.terranHomeworldId, HOME_PLANET);
  assert.equal(body.planets.length, 1);
  const hw = body.planets[0];
  assert.equal(hw.archetype, 'terran');
  assert.equal(hw.resourceNodes.length, 15);
  assert.equal(hw.settlementSlots.length, 15); // the Terran slot anchor
  assert.equal(hw.resourceNodes[0].resourceType, 'titanium');
});

test('GET /system/:id handles a multi-planet system and 404s an unknown id', async () => {
  const multi = await req('GET', '/system/sys_0009');
  assert.equal(multi.status, 200);
  assert.equal(multi.body.planets.length, 4);
  const miss = await req('GET', '/system/sys_9999');
  assert.equal(miss.status, 404);
  assert.match(miss.body.error, /no such system/);
});

test('GET /recipes returns the refining catalog', async () => {
  const { status, body } = await req('GET', '/recipes');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.recipes));
  const alloy = body.recipes.find((r) => r.id === 'titanium_alloy');
  assert.ok(alloy, 'titanium_alloy present');
  assert.deepEqual(alloy.inputs, [
    { good: 'titanium', qty: 3 },
    { good: 'carbon_products', qty: 1 },
  ]);
  assert.deepEqual(alloy.output, { good: 'titanium_alloy', qty: 1 });
});

test('GET /goods returns the vocabulary by tier', async () => {
  const { status, body } = await req('GET', '/goods');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.raw) && Array.isArray(body.processed));
  // raw + processed together are exactly the stockpile goods (resources.js).
  assert.ok(body.raw.includes('titanium'), 'a known raw good is present');
  assert.ok(body.processed.includes('titanium_alloy'), 'a known processed good is present');
  assert.ok(!body.raw.includes('titanium_alloy'), 'processed goods are not in the raw list');

  // Tier 3: the three display-only placeholders, served so the console never has
  // to type a good name of its own. Additive — raw/processed are untouched above.
  assert.deepEqual(body.tier3, ['small_reactor_engine', 'medium_reactor_engine', 'heavy_reactor_engine']);
  // …and they are NOT goods the economy knows: nothing served here may be a
  // stockpile key. (resources.test.js proves the rest of the isolation.)
  for (const g of body.tier3) {
    assert.equal(STOCKPILE_GOODS.includes(g), false, `${g} must never be a stockpile good`);
    assert.equal(body.raw.includes(g), false);
    assert.equal(body.processed.includes(g), false);
  }
});

test('GET /health reports liveness (JSON)', async () => {
  await reset();
  const { status, body } = await req('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'starfare-testbed');
});

test('GET /snapshot returns the zero-state snapshot (schema 7)', async () => {
  await reset();
  const { status, body } = await req('GET', '/snapshot');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, 7); // bumped 6->7 for the §5 Syndicate windowed-accrual telemetry
  assert.equal(body.tick, 0);
  assert.equal(body.guilds.length, 0);
  assert.equal(body.claims.length, 10); // Citadel + 9 outposts
});

test('a founded guild\'s snapshot carries per-system stockpiles and each venture the reserved commitment', async () => {
  await reset();
  await found();
  await mine();
  const { body } = await req('POST', '/tick'); // one tick so the mine mints
  const g = body.guilds[0];
  // Per-system breakdown (ruling B1): titanium pooled in the home system.
  assert.deepEqual(g.stockpilesBySystem, { [HOME_SYSTEM]: { titanium: 5 } });
  // Flat total still present and equal to the sum across systems.
  assert.equal(g.stockpiles.titanium, 5);
  // The venture carries its systemId and the reserved commitment placeholder (0).
  const v = body.ventures[0];
  assert.equal(v.systemId, HOME_SYSTEM);
  assert.equal(v.syndicateCommitment, 0);
});

// --- the manual-tick contract: actions do NOT tick -------------------------

test('POST /action applies the action but does NOT advance the tick', async () => {
  await reset();
  const { status, body } = await found();
  assert.equal(status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.snapshot.guilds.length, 1);
  assert.equal(body.snapshot.tick, 0, 'founding must not tick — manual tick only');
});

test('a venture established via /action does not produce until a /tick', async () => {
  await reset();
  await found();
  const est = await mine();
  assert.equal(est.body.accepted, true);
  assert.equal(est.body.snapshot.ventures.length, 1);
  assert.equal((est.body.snapshot.guilds[0].stockpiles.titanium) || 0, 0, 'no production before a tick');
});

test('POST /tick advances one tick and production mints', async () => {
  await reset();
  await found();
  await mine();
  let t = await req('POST', '/tick');
  assert.equal(t.body.tick, 1);
  assert.equal(t.body.guilds[0].stockpiles.titanium, 5);
  t = await req('POST', '/tick');
  assert.equal(t.body.tick, 2);
  assert.equal(t.body.guilds[0].stockpiles.titanium, 10);
});

// --- rejections are 200 with a reason, not errors --------------------------

test('an occupied node is rejected (200, accepted:false, reason)', async () => {
  await reset();
  await found();
  await mine();
  const { status, body } = await mine({ ventureId: 'm2' });
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.match(body.reason, /already occupied/);
});

test('an unknown action type is rejected with a reason', async () => {
  await reset();
  const { status, body } = await req('POST', '/action', { type: 'nonsense' });
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.match(body.reason, /unknown action type/);
});

// --- malformed input + routing --------------------------------------------

test('a non-JSON body is a 400', async () => {
  const res = await fetch(base + '/action', { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('a non-object JSON body is a 400', async () => {
  const { status } = await req('POST', '/action', [1, 2, 3]);
  assert.equal(status, 400);
});

test('an unknown route is a 404', async () => {
  const res = await fetch(base + '/nope');
  assert.equal(res.status, 404);
});

// --- reset -----------------------------------------------------------------

test('POST /reset returns to the zero-state', async () => {
  await reset();
  await found();
  await req('POST', '/tick');
  const { body } = await reset();
  assert.equal(body.tick, 0);
  assert.equal(body.guilds.length, 0);
  assert.equal(body.claims.length, 10);
});

// --- auto-tick heartbeat (Phase 1 Stage 2) ---------------------------------
// The heartbeat is a real timer, so these tests let a little wall-clock pass.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Always stop the heartbeat after a heartbeat test so it can't leak into the
// next one (the server holds one module-level timer). reset() also stops it.
async function stopAuto() { await req('POST', '/autotick/stop'); }

test('GET /health carries the auto-tick status', async () => {
  await reset();
  const { body } = await req('GET', '/health');
  assert.ok(body.autotick, 'health carries an autotick block');
  assert.equal(body.autotick.running, false);
  assert.equal(body.autotick.lastError, null);
  // It is SERVER state, not game state — it must NOT leak into the snapshot.
  const snap = await req('GET', '/snapshot');
  assert.equal(snap.body.autotick, undefined, 'snapshot stays pure game state');
});

test('POST /autotick/start advances the tick with NO manual /tick', async () => {
  await reset();
  await found();
  await mine();
  const before = (await req('GET', '/snapshot')).body.tick;
  assert.equal(before, 0);

  const started = await req('POST', '/autotick/start', { intervalMs: 10 });
  assert.equal(started.status, 200);
  assert.equal(started.body.autotick.running, true);
  assert.equal(started.body.autotick.intervalMs, 10);

  await sleep(80);
  await stopAuto();

  // The galaxy moved on its own — no POST /tick was sent — and production minted.
  const snap = (await req('GET', '/snapshot')).body;
  assert.ok(snap.tick >= 1, `expected the heartbeat to advance the tick, got ${snap.tick}`);
  assert.equal(snap.guilds[0].stockpiles.titanium, snap.tick * 5, 'titanium tracks the auto-advanced tick');
});

test('POST /autotick/stop halts the heartbeat (the tick stops moving)', async () => {
  await reset();
  await req('POST', '/autotick/start', { intervalMs: 10 });
  await sleep(50);
  const stopped = await req('POST', '/autotick/stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.autotick.running, false);

  const t1 = (await req('GET', '/snapshot')).body.tick;
  await sleep(50);
  const t2 = (await req('GET', '/snapshot')).body.tick;
  assert.equal(t1, t2, 'the tick must not advance after stop');
});

test('POST /autotick/stop is idempotent (stop-when-stopped is a 200 no-op)', async () => {
  await reset();
  const r = await req('POST', '/autotick/stop');
  assert.equal(r.status, 200);
  assert.equal(r.body.autotick.running, false);
});

test('start-while-running replaces the interval (change speed live)', async () => {
  await reset();
  await req('POST', '/autotick/start', { intervalMs: 10 });
  const replaced = await req('POST', '/autotick/start', { intervalMs: 40 });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.autotick.running, true);
  assert.equal(replaced.body.autotick.intervalMs, 40, 'the new interval replaced the old one');
  const health = await req('GET', '/health');
  assert.equal(health.body.autotick.intervalMs, 40);
  await stopAuto();
});

test('an invalid intervalMs is rejected (400) and does not start a heartbeat', async () => {
  await reset();
  for (const bad of [0, -5, 5 /* below the 10ms floor */, 3.5, 'fast', null]) {
    const r = await req('POST', '/autotick/start', { intervalMs: bad });
    assert.equal(r.status, 400, `intervalMs ${JSON.stringify(bad)} must be rejected`);
  }
  // A missing body field is a 400 too.
  const none = await req('POST', '/autotick/start', {});
  assert.equal(none.status, 400);
  // None of the rejects started anything.
  const health = await req('GET', '/health');
  assert.equal(health.body.autotick.running, false);
});

test('POST /reset stops a running heartbeat', async () => {
  await reset();
  await req('POST', '/autotick/start', { intervalMs: 10 });
  assert.equal((await req('GET', '/health')).body.autotick.running, true);
  await reset();
  const health = await req('GET', '/health');
  assert.equal(health.body.autotick.running, false, 'reset must stop the clock before zeroing');
  // Belt-and-braces: the tick genuinely stops moving after the reset.
  const t1 = (await req('GET', '/snapshot')).body.tick;
  await sleep(40);
  const t2 = (await req('GET', '/snapshot')).body.tick;
  assert.equal(t1, t2);
});

// --- client-wiring Slice 0: the seed endpoint, the watcher, the boot clock ---

test('GET /galaxy serves the committed seed geometry verbatim (JSON)', async () => {
  const res = await fetch(base + '/galaxy');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();

  // The shape the map (Slice 1) and the detail screens read: systems with
  // coordinates + ring + planets, the outposts, and the Citadel.
  assert.ok(Array.isArray(body.systems) && body.systems.length > 0, 'systems present');
  const s0 = body.systems[0];
  assert.equal(typeof s0.coords.q, 'number');
  assert.equal(typeof s0.coords.r, 'number');
  assert.equal(typeof s0.ring, 'string');
  assert.ok(Array.isArray(s0.planets), 'a system carries its planets');
  assert.ok(Array.isArray(body.outposts), 'outposts present');
  assert.ok(body.citadel, 'the Citadel is present');

  // And it is the COMMITTED seed, not a reshape: byte-for-byte the same file
  // sim/seed.js reads, so map and detail can never disagree on geometry.
  assert.deepEqual(body, require('../../data/seed.json'));
});

test('GET /inspect serves the operator watcher — and it has NO action controls', async () => {
  const res = await fetch(base + '/inspect');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  // The page itself (not the testbed, not the console, not the JSON probe).
  assert.match(html, /SYNDICATE \/\/ OPERATOR WATCH/);
  assert.match(html, /id="productionpanel"/);   // it renders the full god's-eye state
  assert.match(html, /id="occupancypanel"/);
  assert.match(html, /id="claimpanel"/);
  assert.match(html, /\/snapshot/);             // it reads the snapshot, live

  // THE WATCH-ONLY GUARANTEE (client-wiring.md §2): the served bytes name no
  // mutating route at all. If a control ever creeps in, this fails loudly.
  for (const route of ['/action', '/tick', '/reset', '/autotick']) {
    assert.ok(!html.includes(route), `/inspect must not reference ${route} — it only watches`);
  }
});

// The boot clock lives in the CLI block, so these tests boot sim/server.js as a
// REAL child process. They are the only tests here that do; everything else drives
// the in-process server above.
const SERVER_JS = path.join(__dirname, '..', 'server.js');

// Ask the OS for a free port and hand it back. The CLI reads PORT from the env and
// treats 0 as unset (Number('0') is falsy), so a boot test cannot use the
// ephemeral-port trick the in-process tests use. The tiny bind race is acceptable.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Boot the server as its own process with STARFARE_TICK_MS explicitly controlled
// (deleted, not just unset, so the ambient env can never leak into the OFF case).
// Returns the child plus accumulating stdout/stderr for the boot log assertions.
function bootServer(tickMs, port) {
  const env = { ...process.env, PORT: String(port) };
  delete env.STARFARE_TICK_MS;
  delete env.STARFARE_PERSIST_DIR; // the boot clock is what's under test, not durability
  if (tickMs !== undefined) env.STARFARE_TICK_MS = String(tickMs);
  const child = spawn(process.execPath, [SERVER_JS], { env });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  return { child, out };
}

// Poll the liveness probe until the child is answering (or give up loudly).
async function waitForHealth(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('the booted server never answered /health');
    await sleep(25);
  }
}

test('STARFARE_TICK_MS set: the clock starts on boot (no manual advance)', async () => {
  const port = await freePort();
  const { child, out } = bootServer(50, port);
  try {
    const health = await waitForHealth(port);
    assert.equal(health.autotick.running, true, 'the heartbeat runs from boot');
    assert.equal(health.autotick.intervalMs, 50);
    assert.match(out.stdout, /\[clock\] ON — auto-tick every 50 ms/);
    // And it genuinely turns: the tick climbs with nothing driving it.
    const t1 = (await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json()).tick;
    await sleep(250);
    const t2 = (await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json()).tick;
    assert.ok(t2 > t1, `expected the galaxy to advance on its own (${t1} -> ${t2})`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('STARFARE_TICK_MS unset: no heartbeat (today\'s behaviour, unchanged)', async () => {
  const port = await freePort();
  const { child, out } = bootServer(undefined, port);
  try {
    const health = await waitForHealth(port);
    assert.equal(health.autotick.running, false, 'unset must mean no clock');
    assert.equal(health.autotick.intervalMs, null);
    assert.match(out.stdout, /\[clock\] OFF — no heartbeat/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('POST /reset comes back RUNNING when the boot clock is configured', async () => {
  // Ruling 24-08-26 (client-wiring.md §5): a deployed galaxy must always turn, so a
  // reset returns a fresh RUNNING galaxy — it re-arms the boot clock rather than
  // leaving the world frozen until someone restarts the server.
  const port = await freePort();
  const { child } = bootServer(50, port);
  try {
    await waitForHealth(port);
    const reset = await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).tick, 0, 'reset still zeroes the galaxy');
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.autotick.running, true, 'the clock is re-armed after a reset');
    assert.equal(health.autotick.intervalMs, 50, 'at the interval the operator booted with');
    // And it genuinely turns again, from zero.
    await sleep(250);
    const tick = (await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json()).tick;
    assert.ok(tick >= 1, `expected the reset galaxy to advance on its own, got ${tick}`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('POST /reset leaves the clock OFF when no boot clock was configured', async () => {
  // The manual dev-rig flow is unchanged: with STARFARE_TICK_MS unset there is no
  // clock to put back, so reset must not invent one.
  const port = await freePort();
  const { child } = bootServer(undefined, port);
  try {
    await waitForHealth(port);
    await fetch(`http://127.0.0.1:${port}/autotick/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMs: 10 }),
    });
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).autotick.running, true);
    await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' });
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.autotick.running, false, 'reset stops a hand-started clock and does not re-arm');
    assert.equal(health.autotick.intervalMs, null);
  } finally {
    child.kill('SIGKILL');
  }
});

test('an invalid STARFARE_TICK_MS fails the boot loudly (non-zero exit)', async () => {
  for (const bad of ['fast', '0', '-5', '5' /* below the floor */, '3.5']) {
    const port = await freePort();
    const { child, out } = bootServer(bad, port);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.notEqual(code, 0, `STARFARE_TICK_MS=${bad} must fail the boot`);
    assert.match(out.stderr, /\[clock\] STARFARE_TICK_MS must be an integer/);
  }
});

test('GET /console serves the SYSTEM INVENTORY panel: the right hero\'s resting state', async () => {
  const html = await (await fetch(base + '/console')).text();

  // The dead placeholder is GONE — the resting hero is the inventory now.
  assert.ok(!html.includes('Select a venture'), 'the "Select a venture" blank must be gone');
  assert.ok(!html.includes('ind-blank'), 'and its markup with it');

  // The panel and its held row order.
  assert.match(html, /function inventoryPanel/);
  assert.match(html, /function inventoryOrder/);
  assert.match(html, /return inventoryPanel\(\);/);          // …wired into heroPanel's no-venture branch

  // It reads the PER-SYSTEM pool for the viewing guild, not a guild-wide total.
  assert.match(html, /stockpilesBySystem/);
  assert.match(html, /function onHand\(good\)\{[\s\S]{0,220}stockpilesBySystem/);
  assert.match(html, /onHand\(b\) - onHand\(a\)/);           // descending by quantity…
  assert.match(html, /a < b \? -1 : a > b \? 1 : 0/);          // …ties alphabetical by id

  // Three tier groups, each per-tier normalised with the number overlaid on the track.
  assert.match(html, /\[1,2,3\]\.forEach/);                   // the sort runs over all three
  assert.match(html, /\[1,2,3\]\.map/);                       // …and so does the render
  assert.match(html, /<div class="inv-h">Tier ' \+ t \+ '<\/div>/);   // rendered TIER 1/2/3 (CSS uppercases)
  assert.match(html, /max > 0 \? q \/ max : 0/);                 // divide-by-zero guarded
  assert.match(html, /\(r\.frac \* 100\)\.toFixed\(2\)/);            // …and rendered as the track's width
  assert.match(html, /class="inv-q"/);
  assert.match(html, /\.inv-q\{position:absolute/);            // the overlay is not clipped by the fill

  // Tier 3's vocabulary comes from the ENGINE (GET /goods), never a client list.
  assert.match(html, /if \(t === 3\) return STATE\.goods\.tier3 \|\| \[\];/);
  for (const g of ['small_reactor_engine', 'medium_reactor_engine', 'heavy_reactor_engine']) {
    assert.ok(!html.includes(g), `the console must not hardcode ${g} — it reads /goods`);
  }

  // The chip toggle: clicking the selected chip clears the selection, and the
  // auto-open-on-the-lead-venture respects that clear instead of undoing it.
  assert.match(html, /STATE\.selVenture = null; STATE\.invCleared = true;/);
  assert.match(html, /if \(!STATE\.invCleared && \(!STATE\.selVenture/);

  // The Tier-3 names reach the INVENTORY only. The good tabs stay keyed to goods
  // the engine actually pools, so Tier 3 remains dim and the console never opens
  // management controls on a good with no producer, policy or pool.
  assert.match(html, /function isPooledGood/);
  assert.match(html, /has = tierGoods\(t\)\.some\(isPooledGood\)/);

  // Fuel is guild-wide and is not a stockpile good, so it can never surface here.
  assert.ok(!html.includes('fuelHoard'), 'the console panel must not reach for the fuel hoard');
});

test('the EMBEDDED console\'s inventory rides the venture bridge into the game\'s right zone', async () => {
  // In `?embed=1` the console builds no side zones — the game shell owns them — so the
  // inventory panel that #36 added has nothing to render into. It travels the SAME
  // postMessage bridge the venture nameplate already rides. Two pages, one wire: if
  // either end is dropped the player silently loses the panel, hence this tripwire.
  const console_ = await (await fetch(base + '/console')).text();
  const game = await (await fetch(base + '/')).text();

  // --- the console SENDS it, embed-only, from the resting state -----------------
  assert.match(console_, /function postInventory/);
  assert.match(console_, /kind:'inventory'/);
  assert.match(console_, /rows: inventoryRows\(\)/);       // the rows are the panel's own data…
  assert.match(console_, /function inventoryRows/);       // …computed ONCE, not forked
  assert.match(console_, /if \(STATE\.embedded\)\{ if \(!sel\) postInventory\(\); return; \}/);
  // The venture half is untouched: a selection still posts the nameplate.
  assert.match(console_, /kind:'venture'/);
  // …and standalone still renders the panel locally, from the same rows.
  assert.match(console_, /var rows = inventoryRows\(\);/);
  assert.match(console_, /return inventoryPanel\(\);/);
  // Posting the inventory clears the last-sent venture, so re-picking the SAME
  // venture posts again instead of being swallowed by postVenture's repeat guard.
  assert.match(console_, /STATE\.heroVentureId = null;[\s\S]{0,200}kind:'inventory'/);

  // --- the game RENDERS it, in its own right zone -------------------------------
  assert.match(game, /d\.kind === "inventory"/);
  assert.match(game, /function paintInventoryHero/);
  assert.match(game, /function paintVentureHero/);
  assert.match(game, /id="ihInv"/);
  assert.match(game, /inv-mode/);
  // It paints what it is SENT — the fill is the console's frac, not a game number.
  assert.match(game, /Number\(r\.frac\)/);
  // Scoped to the INVENTORY HERO'S OWN wiring block, which is what this rule is
  // about: that panel paints what the console bridge sends it. It used to be checked
  // against the whole file, which was only ever a proxy — and became a false positive
  // when the TRADE tab landed, since design.md §5 requires that tab to read
  // `stockpilesBySystem` straight off the snapshot for its per-system sell rows. The
  // failure this was written to catch still fails; a sanctioned read elsewhere no
  // longer does.
  const heroBlock = game.slice(game.indexOf('<script id="ind-hero-wire">'));
  assert.ok(!heroBlock.includes('stockpilesBySystem'), 'the inventory hero must not re-derive the inventory');
  // Art dimmed and the manage button gone, so the tiered list reads cleanly.
  assert.match(game, /\.ind-hero\.inv-mode \.ih-art\{ opacity:0; \}/);
  assert.match(game, /\.ind-hero\.inv-mode \.ih-manage\{ display:none; \}/);
  // Tier 3's vocabulary still comes from the engine — neither page names a good.
  for (const g of ['small_reactor_engine', 'medium_reactor_engine', 'heavy_reactor_engine']) {
    assert.ok(!game.includes(g), `the game must not hardcode ${g} — the rows arrive named`);
  }

  // --- the panel's SHAPE, as the operator asked for it (cosmetic, but pinned) ----
  // One integrated thermometer per row: the name goes INSIDE the bar, beside the
  // fill and the quantity, not in a column of its own to the left.
  assert.match(game, /bar\.appendChild\(fill\); bar\.appendChild\(name\); bar\.appendChild\(q\);/);
  assert.match(game, /row\.appendChild\(bar\);/);
  // They are flex siblings over the fill, so the number takes the width it needs and
  // the name truncates against it — the two can never overlap as digits are added.
  assert.match(game, /\.ih-inv-name\{[^}]*flex:1; min-width:0;/);
  assert.match(game, /\.ih-inv-name\{[^}]*text-overflow:ellipsis/);
  assert.match(game, /\.ih-inv-q\{[^}]*flex:none;/);
  // Roughly doubled from the first cut (10px text on a 14px bar), so the panel reads.
  assert.match(game, /\.ih-inv-bar\{[^}]*height:28px;/);
  assert.match(game, /\.ih-inv-name\{[^}]*font-size:19px;/);
  assert.match(game, /\.ih-inv-q\{[^}]*font-size:19px;/);
  assert.match(game, /\.ih-inv-h\{[^}]*font-size:17px;/);
  // Taller rows overflow the zone, and the detail screen's `.app` is min-height, so
  // it would GROW rather than clip and the list's own scroll would never engage.
  assert.match(game, /\.ind-hero\.inv-mode\{ height:calc\(100vh - 104px\); \}/);
  assert.match(game, /\.ih-inv\{[^}]*overflow-y:auto;/);
  // The raw system id is gone from the header — the eyebrow says it all. The field
  // is still SENT (the console's payload is unchanged); the game just stops showing it.
  assert.ok(!/textContent = d\.system/.test(game), 'the inventory header must not print the raw system id');
  assert.match(game, /\.ind-hero\.inv-mode \.ih-title\{ display:none; \}/);
  assert.match(console_, /system: STATE\.sysId/);          // …still on the wire
});

test('every served response carries Cache-Control: no-cache — a redeploy needs no hard-refresh', async () => {
  // The client pages carry their JS and CSS INLINE, so a stale shell is a stale
  // APP. With no directive at all a browser heuristically caches the HTML and
  // keeps serving the old one after a redeploy. This is the mechanical guard that
  // the header cannot be dropped in a later refactor and quietly bring that back.
  for (const route of ['/', '/console', '/inspect']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, `${route} serves`);
    assert.match(res.headers.get('cache-control') || '', /no-cache/, `${route} is served no-cache`);
  }

  // The static branch too: the assets are NOT content-hashed, so a long max-age
  // would be the same staleness trap. Nothing this server serves may go stale.
  const asset = await fetch(base + '/assets/planets/rocky.jpg');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') || '', /no-cache/, 'assets are served no-cache');

  // …and the JSON APIs, which are dynamic and should never be cached at all.
  // /galaxy writes its own header rather than going through sendJson, so it is
  // checked separately — that is exactly the call site a refactor would miss.
  await reset();
  for (const route of ['/health', '/snapshot', '/goods', '/starters', '/galaxy']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, `${route} serves`);
    assert.match(res.headers.get('cache-control') || '', /no-cache/, `${route} is served no-cache`);
  }
});
