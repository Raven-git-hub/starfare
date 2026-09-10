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

test('GET / serves the TRANSPORT-VISIBILITY overlay — own in-flight legs, tweened off engine ticks', async () => {
  const res = await fetch(base + '/');
  const html = await res.text();

  // The overlay's live-data door, wired beside __setLiveTerritory from the same poll.
  assert.match(html, /__setLiveShipments/);
  assert.match(html, /window\.__setLiveShipments\(\{/);        // called from applySnapshot

  // OWN shipments only — a rival's logistics are not free intel (slice-local ruling).
  assert.match(html, /\.filter\(\(s\) => s\.ownerGuildId === mine\)/);

  // The draw reads the engine's LEG endpoints: the surfaced origin, and the seed-resolved
  // destination coords (the engine surfaces originCoords, NOT the destination's).
  assert.match(html, /ship\.originCoords\.q/);
  assert.match(html, /systemById\.get\(ship\.destinationSystemId\)/);

  // legProgress is derived from the engine's TWO ticks — departureTick + arrivalTick.
  assert.match(html, /ship\.departureTick/);
  assert.match(html, /ship\.arrivalTick - ship\.departureTick/);

  // The tag: the CONSTANT carrier 'Syndicate' (no per-craft id this tier) + the engine's
  // own ticksRemaining, formatted. The number the player reads is the engine's.
  assert.match(html, /\['Syndicate', fmtETA\(ship\.ticksRemaining\)\]/);

  // ONE timing source — the fractional tick exposed off the clock ring, not a second clock.
  assert.match(html, /window\.__fractionalTick/);

  // NEGATIVE PIN: the ETA text must never be recomputed from the tweened legProgress (`f`)
  // or wall-clock — it is the engine's ticksRemaining, formatted (transport-model.md §3).
  assert.ok(!html.includes('fmtETA(f)'), 'the ETA must not be derived from legProgress');
  assert.ok(!html.includes('fmtETA(Tf'), 'the ETA must not be derived from the fractional tick');
});

// The OPERATIONS tab (docs/operations-hub.md) — renamed from Transport, the list-and-hub companion
// to the galaxy-map transport overlay above. IN TRANSIT is live off the snapshot; LEASED / DEPLOYED
// / IDLE are empty scaffolds this slice (§7). Pinned on the SERVED BYTES: a page that quietly reverted
// the rename, dropped the poll refresher, or recomputed the ETA from the tweened bar would still
// render perfectly, and only this would go red.
test('GET / serves the OPERATIONS tab — the rename, the #tp-ops panel, IN TRANSIT live, the scaffolds', async () => {
  const html = await (await fetch(base + '/')).text();

  // The tab is RENAMED, and the old Transport tab (button + coming-soon stub) is gone.
  assert.match(html, /<button class="rtab" onclick="openTab\('operations', this\)">Operations<\/button>/);
  assert.ok(!html.includes(">Transport</button>"), 'the old Transport tab button is gone');
  assert.ok(!html.includes("openTab('transport'"), 'the old transport tab key is gone');
  assert.ok(!/TAB_STUBS = \{\s*transport:/.test(html), 'transport is no longer a stub');
  assert.ok(!html.includes('A live status board of every vehicle you own'), 'the old Transport stub copy is gone');

  // A TOP-LEVEL panel, a peer of #tp-deut: the fill-screen recipe + the flex-column show state,
  // the openTab('operations') branch, and the panel element itself.
  assert.match(html, /#tabPanel\.ops\{overflow:hidden;\}/, 'the fill-screen recipe (like #tp-guild / #tp-deut)');
  assert.match(html, /#tp-ops\.show\{display:flex; flex-direction:column;\}/, 'the panel is a flex column');
  assert.match(html, /if \(which === 'operations'\)/, "openTab must have an 'operations' branch");
  assert.match(html, /id="tp-ops"/, 'the OPERATIONS top-level panel');

  // The lifecycle mirrors the Deuterium dashboard's: opener + poll refresher, and the refresher IS
  // called from applySnapshot so an open panel re-reads every poll (§4).
  assert.match(html, /window\.__opsOpen = function/);
  assert.match(html, /window\.__opsRefresh = function/);
  assert.match(html, /if \(window\.__opsRefresh\) window\.__opsRefresh\(\);/, '__opsRefresh is called from the poll');

  // IN TRANSIT reads the snapshot's shipments, the player's OWN only, and sorts soonest-first —
  // dropping any row missing its leg geometry (an unresolvable waystation).
  assert.match(html, /\(s && s\.shipments\) \|\| \[\]/);
  assert.match(html, /sh\.ownerGuildId === myId/);
  assert.match(html, /typeof sh\.departureTick === 'number' && typeof sh\.arrivalTick === 'number'/);
  assert.match(html, /a\.ticksRemaining - b\.ticksRemaining/, 'ascending ticksRemaining — soonest arrival first');

  // The expanded manifest: the carrier identity line (Syndicate, no craft id this tier — §3) and
  // the cargo itemised `Good: Nu`.
  assert.match(html, /Carrier: <b>Syndicate<\/b>/);
  assert.match(html, /fmt\(cargo\[g\]\) \+ ' Nu/, 'the manifest itemises the cargo');

  // Names resolved off the seed the client holds, exactly as the map resolves them — the new
  // waystation bridge beside __systemName.
  assert.match(html, /window\.__outpostName = function/);

  // The progress bar is legProgress off the engine's TWO ticks (transport-model.md §2.3) — the same
  // sanctioned derive the map tweens.
  assert.match(html, /\(Tf - sh\.departureTick\) \/ span/);

  // The ETA is the engine's own ticksRemaining, formatted — NEVER recomputed from the tweened bar.
  assert.match(html, /fmtETA\(sh\.ticksRemaining\)/);
  assert.ok(!html.includes('fmtETA(f)'), 'the ops ETA must not be derived from legProgress');
  assert.ok(!html.includes('fmtETA(Tf'), 'the ops ETA must not be derived from the fractional tick');

  // The reserved, unwired alert slot is built (dark, no trigger this slice — §4).
  assert.match(html, /class="ops-alert"/);

  // LEASED / DEPLOYED / IDLE ship as calm empty states — no rows, no Manage popups (§7).
  assert.match(html, /No transports leased/);
  assert.match(html, /Nothing deployed yet/);
  assert.match(html, /Nothing idle/);
  assert.match(html, /Nothing in transit/);

  // The pilot hero art (§2).
  assert.match(html, /assets\/characters\/pilot\.jpg/);
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
test('GET / serves the TRADE tab — the renamed tab, the panel, and the SELL & BUY popup wiring', async () => {
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
  assert.match(html, /allocations: allocations/);
  // §8.1 quote-lock (CLIENT half): the confirm builds the action and carries the FROZEN issue
  // tick — never a price (§18) — then posts it. The engine re-derives the price at that tick.
  assert.match(html, /window\.__sendAction\(sellAction\)/);
  assert.match(html, /sellAction\.issueTick = TX\.issueTick/,
    'the SELL confirm must send the frozen issueTick, so the engine prices at the quoted tick');

  // BUY IS NOW LIVE (the transaction-popup slice): the mode toggle is real (neither button
  // carries `na` any more), and the finalise popup — one .est-style overlay scoped under
  // #tw-tx-overlay — is served with both panes' confirm buttons.
  assert.match(html, /id="tw-mode-sell"[^>]*data-mode="sell"/);
  assert.match(html, /id="tw-mode-buy"[^>]*data-mode="buy"/);
  assert.ok(!/class="tw-mbtn na"/.test(html), 'Buy is no longer dimmed — the popup slice wires it');
  assert.match(html, /id="tw-tx-overlay"/);           // the shared finalise popup
  assert.match(html, /id="tw-tx-confirm"/);           // its single confirm button
  assert.match(html, /id="tw-buybtn"/);               // the BUY manifest's exec button
  assert.match(html, /id="tw-buyqty"/);               // …and its quantity ("the prior window")

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
  // THE ANTI-RECOMPUTE GUARANTEE, now covering the BUY arrival too: the popup reads
  // `fuelCost[sysId].creditCost` for money and `.travelTicks` for the arrival, formatting the
  // latter as a duration. It must carry NEITHER the burn rate, NOR the hex geometry, NOR the
  // craft speed / arrival helper — those would be game numbers invented in the client.
  assert.ok(!/SYNDICATE_HAULER_BURN_RATE|hexDistance|nearestWaystation|CRAFT_SPEED|arrivalTickFor/.test(html),
    'the client must never carry the burn rate, the geometry, or the craft speed — it reads fuelCost');
  assert.match(html, /\.travelTicks/, 'the BUY arrival is read from the snapshot, not recomputed');

  // ...and BUY IS now wired: the confirm popup posts the ruled single-destination action,
  // carrying the FROZEN issue tick (§8.1) exactly as SELL does.
  assert.match(html, /window\.__sendAction\(buyAction\)/);
  assert.match(html, /buyAction\.issueTick = TX\.issueTick/,
    'the BUY confirm must send the frozen issueTick, so the engine prices at the quoted tick');
  assert.match(html, /destinationSystemId: TX\.dest/,
    'BUY is a single order to one destination the popup carries (§6)');

  // §8.1 QUOTE-LOCK — the client mirrors the engine's TTL as a served constant, so the popup's
  // courtesy expiry timer and the engine's checkQuote can never silently drift. §18 makes a
  // client copy of an engine number safe ONLY mirrored WITH THIS TRIPWIRE.
  const { QUOTE_TTL_TICKS } = require('../price-ring.js');
  assert.match(html, new RegExp(`QUOTE_TTL_TICKS = ${QUOTE_TTL_TICKS};`),
    'the client quote-lock TTL must mirror sim/price-ring.js QUOTE_TTL_TICKS');
  // ...and the mirror is APPLIED — the expiry test reads QUOTE_TTL_TICKS, not a bare 5, and the
  // client mirrors the fuel-price cycle rule off the snapshot's calendar (windowN / dayAnchorTick).
  assert.match(html, /s\.tick - TX\.issueTick > QUOTE_TTL_TICKS/,
    'the client TTL rule must read the mirrored constant, not a hardcoded window');
  assert.match(html, /txCycleIndex\(s\.tick, N, anchor\) !== txCycleIndex\(TX\.issueTick, N, anchor\)/,
    'the client must mirror the engine cycle-boundary expiry rule off the snapshot calendar');
  // The popup FREEZES the two prices at open and stops re-pricing them — it reads the frozen
  // figures, not the live feed. (Geometry — burn, travelTicks — stays live, tested above.)
  assert.match(html, /function txFreezeQuote\(\)/);
  assert.match(html, /price: priceOf\(TX\.good\)/, 'the resource posted price is frozen at open');
  assert.match(html, /id="tw-tx-refresh"/, 'the expired state offers a Refresh control');

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

// The DEUTERIUM client (§1.4 "The Deuterium Cycle" / "The illegal path") — slice 2a. A
// client-render tripwire on the SERVED bytes: the deploy popup, the segmented bar, the removal
// from the normal lists and the placeholder tab would all still render if silently reverted, and
// only this fails.
test('GET / serves the DEUTERIUM client — deploy popup, segmented bar, removal, top-level dashboard tab', async () => {
  const html = await (await fetch(base + '/')).text();

  // 1. THE DEPLOY POPUP fires the BUILT actions — the load-bearing strings, so a reverted
  //    popup that stopped calling one is caught. A deuterium node opens the dedicated popup.
  //    (The refinery action moved to the factory popup's FUEL tier — asserted in the FUEL-tier
  //    test below — but its string is still served, so we assert it there, not here.)
  assert.match(html, /id="deut-overlay"/);
  assert.match(html, /type:'licenseDeuteriumMine'/);                 // the licensed mine's licence
  assert.match(html, /type:'establishVenture'[\s\S]{0,120}resourceType:'deuterium'/); // the mine itself
  assert.match(html, /site\.resource === 'deuterium' && window\.openDeut/,
    'a deuterium node must fork to the dedicated deuterium popup, not the generic one');
  // The licensed/unlicensed choice. The refinery is no longer reached from this popup — the old
  // red "illegal refinery instead" button (#estDeutRefinery) must be GONE (§1.4, one entry point).
  assert.match(html, /id="deutSegLic"/);
  assert.match(html, /id="deutSegUn"/);
  assert.doesNotMatch(html, /id="estDeutRefinery"/,
    'the bolt-on refinery button is retired — the FUEL tier is the single entry point');

  // 1a2. THE DEPLOY BUTTON IS GATED BY THE GUILD ADVISER CONFIRM REEL (07-09-26), like the normal
  //      popup: clicking #deutDeploy opens #est-reel in a distinct deuterium confirm mode, and only
  //      Confirm ▸ fires the real deutDeploy(). If the button ever reverts to calling deutDeploy()
  //      directly (skipping the Adviser), the wiring and the branch below both vanish and only this
  //      fails. The deuterium confirm must NOT be routed through the normal popup's doDeploy().
  assert.match(html, /deutReelConfirm\(\)/, 'the deploy button must open the deuterium confirm reel');
  assert.match(html, /reelMode='deutConfirm'/, "deutReelConfirm must set its own reel mode");
  assert.match(html, /if\(reelMode==='deutConfirm'\)\{ closeReel\(\); deutDeploy\(\); return; \}/,
    'the shared reelNext handler must fire deutDeploy() on the deuterium confirm');
  // The settled, human-approved Adviser copy (07-09-26) is served — a stable, distinctive fragment
  // of each of the TWO mine cases, so a paraphrase or a dropped case is caught. (The refinery
  // confirm now fires from the factory popup's FUEL tier — asserted in the FUEL-tier test below.)
  assert.match(html, /which ought to trouble you more than it does/, 'the licensed-mine confirm spiel');
  assert.match(html, /I am not in the room\./, 'the unlicensed-mine confirm spiel');

  // 1b. THE POPUP IS THE est-STYLE CARD (rebuilt 07-09-26), not 2a's bespoke narrow box. The
  //     two-column est shell, the Oceanic mine hero, and the fixed Terms panel (licensed terms +
  //     illegal caution) would all silently revert to the narrow single-column box, and only this
  //     fails. The old box was `#deut-overlay .est{ ... max-width:640px }` — assert it is gone.
  assert.match(html, /#deut-overlay \.est-body\{[^}]*grid-template-columns:1fr 340px/,
    'the deuterium popup must use the est two-column body');
  assert.match(html, /#deut-overlay \.est\{[^}]*max-width:980px/,
    'the deuterium card must be the 980px est shell, not the 640px box');
  assert.doesNotMatch(html, /#deut-overlay \.est\{[^}]*max-width:640px/,
    "2a's narrow #deut-overlay card must be gone");
  assert.match(html, /assets\/industrial\/OceanicMine\.jpg/, 'the popup carries the Oceanic mine hero');
  assert.match(html, /id="deutTermsLic"/, 'the fixed licensed-terms panel');
  assert.match(html, /id="deutTermsUn"[\s\S]{0,120}class="chead"/, 'the illegal caution panel');

  // 2. DEUTERIUM REMOVED from the normal good lists — the one chokepoint filter (§1.4), so it can
  //    never render as a tradeable tier-1 chip or a console-managed good.
  assert.match(html, /var HIDDEN_GOODS = \{ deuterium: 1, deuterium_fuel: 1 \};/);
  assert.match(html, /return list\.filter\(function\(g\)\{ return !HIDDEN_GOODS\[g\]; \}\);/);

  // 3. THE SEGMENTED FUEL BAR reads BOTH stores: the standing bar's red segment is the contraband
  //    value, and the trade popup's fuel now counts legal + contraband combined (the 1b catch-up).
  assert.match(html, /me\.deuteriumFuelValue/, 'the standing bar red segment reads the contraband store');
  assert.match(html, /function heldUnits\(g\)\{ return \(\(g && g\.fuelHoard\) \|\| 0\) \+ \(\(g && g\.deuteriumFuel\) \|\| 0\); \}/);
  assert.match(html, /function heldValue\(g\)\{ return \(\(g && g\.fuelHoardValue\) \|\| 0\) \+ \(\(g && g\.deuteriumFuelValue\) \|\| 0\); \}/);

  // 4. THE DEUTERIUM TAB is now a TOP-LEVEL tab (its own #tp-deut panel, a peer of TRADE and the
  //    Guild Hall), NOT a sub-tab inside TRADE — deuterium is untradeable, so it never belonged among
  //    the trade tiers, and inside the trade scroll body it could not fill the screen. Assert the
  //    top-level tab exists: the .rtab button (openTab('deuterium')) and the #tp-deut panel that fills
  //    #tabPanel like #tp-guild. Its body is the three-panel dashboard — the glance donut, the two
  //    charts (fuel-price + burn-habits), the refinery-tree container — plus the four SVG builders and
  //    the render seam, so a silent revert to the placeholder is caught.
  assert.match(html, /onclick="openTab\('deuterium', this\)"/, 'the DEUTERIUM top-level tab button');
  assert.match(html, /id="tp-deut"/, 'the DEUTERIUM top-level panel');
  assert.match(html, /if \(which === 'deuterium'\)/, "openTab must have a 'deuterium' branch");
  assert.match(html, /#tabPanel\.deut\{overflow:hidden;\}/, 'the fill-screen recipe (like #tp-guild)');
  assert.match(html, /#tp-deut\.show\{display:flex; flex-direction:column;\}/, 'the panel is a flex column');
  // 4z. THE OLD IN-TRADE SUB-TAB IS GONE — deuterium no longer rides the trade tier nav. The `.tw-tier
  //     deut` chip, its `data-deut="1"` hook, and the trade tab's `T.deut` state/branch must all be
  //     removed, or the dashboard was not actually lifted out of TRADE.
  assert.doesNotMatch(html, /class="tw-tier deut/, 'the in-TRADE deuterium tier chip must be gone');
  assert.doesNotMatch(html, /data-deut="1"/, 'the in-TRADE deuterium tier hook must be gone');
  assert.doesNotMatch(html, /T\.deut\b/, "the trade tab's T.deut state/branch must be gone");
  assert.match(html, /id="tw-deut-donut"/, 'the glance donut container');
  assert.match(html, /id="tw-deut-pricechart"/, 'the fuel-price graph container');
  assert.match(html, /id="tw-deut-burnchart"/, 'the burn-habits graph container');
  assert.match(html, /id="tw-deut-tree"/, 'the refinery-tree container');
  assert.match(html, /id="tw-deut-suspicion"/, 'the inert suspicion-gauge container');
  assert.match(html, /function deutDonut\(/, 'the donut builder');
  assert.match(html, /function deutPriceLine\(/, 'the fuel-price line builder');
  assert.match(html, /function deutBurnBars\(/, 'the burn-habits bars builder');
  assert.match(html, /function deutSuspicion\(/, 'the suspicion-gauge builder');
  assert.match(html, /function deutRender\(/, 'the dashboard render seam');
  // The refinery tree reads the guild's refineries only (deuteriumRefinery === true), grouped by
  // systemId, each row a stub → venture management (§2.7, undesigned).
  assert.match(html, /v\.deuteriumRefinery === true/, 'the tree filters to refineries');
  assert.match(html, /function openVentureManagement\(/, 'the refinery-row venture-management stub');
  // The Oceanic hero + the word DEUTERIUM (right panel), nothing else.
  assert.match(html, /assets\/industrial\/OceanicMine\.jpg/, 'the DEUTERIUM tab hero art');
  // 4a. THE 2a PLACEHOLDER IS GONE — the two raw/contraband store readouts, the "next slice" soon
  //     line, and its `tw-deut-soon` class must all have been removed, or the dashboard was not
  //     actually built over the placeholder.
  assert.doesNotMatch(html, /id="tw-deut-raw"/, "the placeholder's raw-store readout is gone");
  assert.doesNotMatch(html, /id="tw-deut-fuel"/, "the placeholder's contraband-store readout is gone");
  assert.doesNotMatch(html, /tw-deut-soon/, "the placeholder's 'soon' block is gone");
  assert.doesNotMatch(html, /the mine \/ refinery roster and per-node deploy shortcuts arrive/,
    "the placeholder's 'next slice' dashboard-deferral copy is gone");
});

// The illegal refinery as a FUEL TIER on the factory Establish popup (§1.4, 07-09-26) — the
// single entry point. This tripwire pins the fold: the FUEL option in the config, the deploy
// firing establishDeuteriumRefinery, the Adviser confirm as the sole caution migrated into the
// factory popup, and the two retired surfaces (the red button — asserted gone above — and the
// deut popup's refinery mode). Any silent revert to the bolt-on button drops one of these.
test('GET / serves the illegal refinery as the FUEL tier — single entry point, refinery mode retired', async () => {
  const html = await (await fetch(base + '/')).text();

  // 1. THE FUEL OPTION is in the factory config tier dropdown, neutral (no red / no "illegal"),
  //    and locks the lone Deuterium Fuel recipe by a sentinel that is never a number.
  assert.match(html, /f\.value='fuel'; f\.textContent='Fuel · Refine'/, 'the FUEL tier option in the config');
  assert.match(html, /S\.tier==='fuel'/, 'the FUEL sentinel drives the config/deploy branches');
  assert.match(html, /S\.outGood='deuterium_fuel'; S\.outLabel=label\('deuterium_fuel'\)/, 'FUEL locks the Deuterium Fuel output');

  // 2. THE DEPLOY fires the BUILT establishDeuteriumRefinery from the factory popup — no
  //    establishVenture, no licence — in doDeploy's FUEL branch.
  assert.match(html, /if\(S\.tier==='fuel'\)\{ await deployRefinery\(player, ventureId\); return; \}/,
    'doDeploy must branch to the refinery deploy on the FUEL tier');
  assert.match(html, /type: 'establishDeuteriumRefinery'/, 'the FUEL deploy fires the built refinery action');

  // 3. THE ADVISER CONFIRM is the SOLE caution — the refinery spiel migrated verbatim into
  //    reelConfirm()'s FUEL branch (title + the settled closing line), gating the deploy.
  assert.match(html, /Build the refinery\?/, 'the refinery confirm title, now on the factory popup');
  assert.match(html, /return to my <em>alibi<\/em>/, 'the settled refinery confirm spiel, migrated verbatim');

  // 4. THE DEUT POPUP NO LONGER CARRIES A REFINERY MODE — the caution panel and the confirm
  //    entry are gone, so the popup is mine-only (licensed / unlicensed).
  assert.doesNotMatch(html, /id="deutTermsRef"/, "the deut popup's refinery caution panel is retired");
  assert.doesNotMatch(html, /DEUT_CONFIRM\.refinery/, "the deut popup's refinery confirm is retired");
  assert.doesNotMatch(html, /mode:'refinery'/, 'no refinery mode is routed to the deut popup any more');
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

  // The EARN PREVIEW is TIER-BLIND (06-09-26, points-and-reputation.md §2.6). The engine
  // dropped `tierFactor` from `metGain`, so the meter previews `REP_MEET_MAX × (W_COMMIT·c
  // + W_EQUITY·o)` — the SAME +10 at full terms for every tier — and no longer mirrors a
  // tier weight at all. The `TIER_WEIGHT` mirror and the `tierFactor` helper the 02-09-26
  // slice added are gone with the tier term they fed; this tripwire now guards that the
  // panel's `repGain` still matches the engine's tier-blind `metGain`, term for term.
  assert.match(html, /function repGain\(c, o01\)\{ return P\.REP_MAX\*\(P\.REP_WC\*c \+ P\.REP_WO\*o01\); \}/,
    'the earn preview must mirror the engine\'s tier-blind metGain, term for term');
  assert.match(html, /repGain\(S\.c,S\.o01\)/,
    'and the meter must call it without a tier argument');
  // And the tier term is really GONE, not merely unread — the `TIER_WEIGHT` mirror
  // declaration and the `tierFactor` helper are both removed, so neither can be silently
  // reintroduced. (Matched as the code that declares them, not the prose that names them —
  // the comments still explain why the tier term left.)
  assert.ok(!/TIER_WEIGHT:/.test(html), 'the deploy panel no longer declares a tier-weight mirror (§2.6, tier-blind earn)');
  assert.ok(!/function tierFactor/.test(html), 'and its tierFactor helper is gone with the tier term');

  // The one-time SIGNING BUMP stays out of the panel BY DESIGN (§2.6: the player's lever
  // is the commitment slider; the bump is its backend consequence). This pins that
  // decision rather than leaving a later session to read the absence as an oversight.
  assert.ok(!/signingBump/.test(html), 'the deploy panel does not preview the signing bump — deliberate, §6.1');

  // The term ranges the sliders can produce are exactly the ones intake accepts.
  assert.match(html, new RegExp(`id="rnRange" min="${licence.WINDOW_DAYS_MIN}" max="${licence.WINDOW_DAYS_MAX}"`));
  assert.match(html, new RegExp(`id="oRange" min="0" max="${licence.EQUITY_CEILING * 100}"`));
  assert.match(html, /id="cRange" min="0" max="100"/);   // commitment: a 0..1 fraction
});

// The GUILD HALL Standing panel (docs/guild-hall.md §2) scales its performance line and
// its Current/Predicted gauges to the issuance modifier's clamp bounds. That axis CLAIMS
// to be the engine's bounds, so per design.md §18 the client copy is safe only mirrored
// with a tripwire: if sim/meanline.js ever re-clamps the modifier, this fails instead of
// the panel quietly drawing every gauge against the old floor/ceiling.
test('the served Guild Hall panel\'s mirrored gauge axis still matches the engine', async () => {
  const html = await (await fetch(base + '/')).text();
  const { ISSUANCE_FLOOR, ISSUANCE_CEIL } = require('../meanline.js');

  assert.match(html, new RegExp(`GH_FLOOR = ${ISSUANCE_FLOOR};`),
    'the gauge/line axis floor must be sim/meanline.js ISSUANCE_FLOOR');
  assert.match(html, new RegExp(`GH_CEIL = ${ISSUANCE_CEIL};`),
    'the gauge/line axis ceiling must be sim/meanline.js ISSUANCE_CEIL');

  // …and the mirror is APPLIED — the ported gauge helpers read GH_FLOOR/GH_CEIL as their
  // axis, not a re-typed 0.30…1.50. Without this the constants above could sit unread while
  // the SVG drew against hardcoded bounds that no tripwire guards.
  assert.match(html, /var lo=GH_FLOOR, hi=GH_CEIL/,
    'the gauge helpers must read the mirrored axis constants, not a hardcoded range');

  // The expected-fuel-change gauge (docs/guild-hall.md §2.1, Slice D) — the panel's THIRD
  // gauge, beside Current/Predicted. It reuses the same `ghVgauge` (so the axis tripwire
  // above already guards its appearance); this pins that the served panel actually draws it,
  // fed the `nxt ÷ cur` ratio of two published entitlements and nothing else.
  assert.match(html, /ghVgauge\(fuelChange, 'Fuel &Delta;'/,
    'the Standing panel must serve the third Fuel Δ gauge');
  assert.match(html, /fuelChange = \(cur != null && cur > 0 && nxt != null\) \? \(nxt \/ cur\) : null/,
    'the Fuel Δ value must be the ratio of two published entitlements (the one sanctioned derive)');
  // Slice D′ (docs/guild-hall.md §2): the denominator falls back to the founding baseline, so
  // the gauge reads live (×1.00) from founding instead of `—` until the first boundary. The
  // served page must wire that fallback — `fuelGrant.entitlement` first, then
  // `foundingEntitlement` — or a just-founded guild would still draw `—`.
  assert.match(html, /me\.fuelGrant\.entitlement[\s\S]{0,120}me\.foundingEntitlement/,
    'the Fuel Δ denominator must fall back to me.foundingEntitlement before the first boundary');
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
  // The "Renegotiation itself is not built yet" caveat WAS here (#64). The delivery UI + the
  // lapse action ship this slice (#64 Slice 1b), so the caveat is FALSE and the assertion
  // FLIPS rather than being dropped — the treatment NOT YET CHARGED / the asset economy got.
  assert.ok(!html.includes('Renegotiation itself is not built yet'),
    'renegotiation is built (accept + lapse, reached at window-end) — the old caveat is false');
  assert.match(html, /accept<\/em> the Syndicate’s terms and re-lock, or <em>reject<\/em> and let the licence lapse/,
    'the reneg-window help now describes the shipped accept/lapse decision');
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
  // 335 starter-eligible systems in seed 7331. Pinned on purpose: if this ever
  // changes, the seed changed under us and we want to be told loudly.
  assert.equal(body.count, 335);
  assert.equal(body.starters.length, 335);
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
  // Find the homeworld by id — its position among the system's planets is seed-specific.
  const hw = body.planets.find((p) => p.id === HOME_PLANET);
  assert.ok(hw, 'the Terran homeworld appears in the layout');
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
  assert.equal(body.claims.length, 97); // Citadel + 96 outposts
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
  assert.equal(body.claims.length, 97);
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
  assert.match(html, /t === 3 \? \(STATE\.goods\.tier3 \|\| \[\]\)/);
  for (const g of ['small_reactor_engine', 'medium_reactor_engine', 'heavy_reactor_engine']) {
    assert.ok(!html.includes(g), `the console must not hardcode ${g} — it reads /goods`);
  }

  // DEUTERIUM is filtered out of the console's tier lists (§1.4 "The Deuterium Cycle"): it is
  // special, untradeable and un-consoled, so `tierGoods`/`isPooledGood` drop it at one chokepoint.
  assert.match(html, /var HIDDEN_GOODS = \{ deuterium: 1, deuterium_fuel: 1 \};/);
  assert.match(html, /return list\.filter\(function\(g\)\{ return !HIDDEN_GOODS\[g\]; \}\);/);
  assert.match(html, /if \(HIDDEN_GOODS\[good\]\) return false;/);

  // The chip toggle: clicking the selected chip clears the selection, and the
  // auto-open-on-the-lead-venture respects that clear instead of undoing it. The
  // auto-open is keyed on the good ON SCREEN (its lead is a producer of that good, and
  // it fires only while nothing valid FOR THIS GOOD is selected), never on
  // report.mines[0] blind — that latched the hero onto this system's first venture even
  // when it was a HIDDEN deuterium mine (console-hero-venture.test.js).
  assert.match(html, /STATE\.selVenture = null; STATE\.invCleared = true;/);
  assert.match(html, /if \(!STATE\.invCleared && !heroSelection\(good, report\)\)\{/);
  assert.match(html, /producersOf\(report, good\)\[0\]/);

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

// The VENTURE MANAGEMENT popup (docs/venture-management.md) — the real destination of
// openVentureManagement, the mirror of the Establishment popup. This tripwire pins the shell
// (the RP band gauge, the production donut, the two sub-panels, the hero ledger + contract
// window + Close action), the mirrored RP band constants, the biome×type art table, the wiring
// of all three call sites, and that the two snapshot derives the panel reads are published. A
// silent revert to the logging stub drops one of these.
test('GET / serves the Venture Management popup shell, wired to the published fields', async () => {
  const html = await (await fetch(base + '/')).text();

  // 1. THE SUPERIMPOSED PANEL exists, headed "Venture Management".
  assert.match(html, /id="vm-overlay"/, 'the venture-management overlay');
  assert.match(html, /class="eyebrow">Venture Management</, 'the popup eyebrow');

  // 2. THE LEFT DATA — the RP gauge, the production donut, and the two sub-panels.
  assert.match(html, /id="vmRpNum"/, 'the big reputation grade');
  assert.match(html, /id="vmBand"/, 'the RP band gauge');
  assert.match(html, /id="vmDonutWrap"/, 'the production donut');
  assert.match(html, /id="vmEqBig"/, 'the equity / cycle figure');
  assert.match(html, /id="vmInvList"/, 'the investor list placeholder');
  assert.match(html, /function donutSvg\(/, 'the donut builder');

  // 3. THE RP BAND CONSTANTS are MIRRORED from sim/licence.js — pinned so they cannot drift and
  //    let the band lie about where a venture sits (as the reverted console readout was).
  assert.match(html, /RP_FLOOR = -500, RP_SOFT_CAP = 1500/, 'the RP band edges mirror the engine');

  // 4. THE HERO — the biome×type art table, the agreed-terms ledger, the contract window, actions.
  assert.match(html, /id="vmArt"/, 'the hero art element');
  assert.match(html, /id="vmLedger"/, 'the agreed-terms ledger');
  assert.match(html, /id="vmWindow"/, 'the contract-window block');
  assert.match(html, /id="vmCloseBtn"/, 'the Close-venture action');
  assert.match(html, /id="vmReneg"/, 'the Renegotiate control (expired only)');
  // #64 Slice 1b: the Renegotiate button is WIRED now (was a "coming soon" stub) — it opens the
  // shared renegotiation popup for the venture the VM popup is managing, the SECOND entry point.
  assert.ok(!html.includes('Renegotiation is coming soon'), 'the Renegotiate stub note is gone — it is wired');
  assert.match(html, /window\.__openRenegotiation\(player\.guildId, VM\.ventureId\)/,
    'VM Renegotiate opens the shared popup (§5 entry point 2)');
  assert.match(html, /reneg\.style\.display = v\.renegotiationOffer \? '' : 'none'/,
    '#64 Slice 2: the Renegotiate control shows only once an OFFER is live (after grace), not merely at window-end');
  // The explicit, irregular art filenames — a distinctive mine and a distinctive factory entry, plus
  // the documented gasfactory.jpg-is-a-gas-mine placeholder — so the table cannot silently reshuffle.
  assert.match(html, /crystalline:'crystallinemine\.jpg'/, 'a distinctive mine-art entry');
  assert.match(html, /terran:'TerranManufacture\.jpg'/, 'a distinctive factory-art entry');
  assert.match(html, /gasGiant:'gasfactory\.jpg'/, 'the mislabelled gas-mine placeholder');
  // The licensed-deuterium-mine Close is disabled with the §6 note.
  assert.match(html, /does not let go of deuterium/, 'the deferred-deuterium Close note (§6)');

  // 5. THE CLOSE CONFIRM fires the built decommissionVenture through the shared Adviser reel.
  assert.match(html, /type:'decommissionVenture'/, 'Close fires the decommission action');
  assert.match(html, /window\.__adviserConfirm/, 'Close opens the shared Guild Adviser reel');
  assert.match(html, /I am not in the room/, 'the settled Adviser closing line');

  // 6. THE PANEL READS THE TWO SNAPSHOT DERIVES — contractWindow (in cycles) and equityPerCycle.
  assert.match(html, /v\.contractWindow/, 'the popup reads contractWindow');
  assert.match(html, /v\.equityPerCycle/, 'the popup reads equityPerCycle');

  // 7. THE CALL SITES are wired to the one entry point.
  assert.match(html, /window\.__openVentureManagement = openVM/, 'the single entry point is exposed');
  assert.match(html, /if\(window\.__openVentureManagement\)\{ window\.__openVentureManagement\(ventureId\); return; \}/,
    'call site 3: the DEUTERIUM refinery row delegates to the real popup');
  assert.match(html, /closest\("#ihManage"\)/, 'call site 2: the inspect-hero manage button (the Production Console hero, embed mode)');
  assert.match(html, /S\.deployedVentureId/, 'call site 1: the post-establish button knows the venture');

  // 8. THE PLANET MANIFEST occupied-OWN node (this slice — venture-management.md entry point 4).
  //    An own occupied site routes the manifest-row click to the popup for its seated venture; a
  //    rival's site is left to openNodeOverlay (VM is own-only, §7). The classification and both
  //    node-row handlers are pinned so a revert to "occupied → overlay for everyone" goes red here.
  assert.match(html, /function isOwnSite\(state\)\{ return !!\(state && state\.kind !== 'other' && state\.ventureId\); \}/,
    'the own/rival classification that gates the manifest → VM route');
  assert.match(html, /if \(isOwnSite\(state\) && window\.__openVentureManagement\) \{ window\.__openVentureManagement\(state\.ventureId\); return; \}/,
    'an own occupied manifest node opens VM for its seated venture (guarding the hook like the sibling call sites)');
  // Both node-row handlers still fork to the read-only overlay for a RIVAL and to establishment
  // when vacant — so the own → VM branch is an addition, not a replacement of the other two paths.
  assert.match(html, /openNodeOverlay\('Resource Node '/, 'a rival Resource node keeps the read-only overlay');
  assert.match(html, /openNodeOverlay\('Settlement Slot '/, 'a rival Settlement slot keeps the read-only overlay');
});

// The Guild Hall MESSAGES panel — the email-style inbox (event-log.md §9): the renegotiation popup,
// the two reneg entry points, and the redesigned Notices (subject-line rows + a per-type notice
// popup, read on open). Pinned on the SERVED BYTES — a page that quietly reverted would still render
// and only this would go red — the same discipline the VM and asset-picker tripwires follow.
test('GET / serves the MESSAGES inbox + the renegotiation and notice popups, wired to the attention derive', async () => {
  const html = await (await fetch(base + '/')).text();

  // 1. THE MESSAGES RAIL ENTRY at the top of the Guild Hall tab list, with its count badge.
  assert.match(html, /<button class="gh-tab" data-p="messages">/, 'the Messages rail entry');
  assert.match(html, /id="gh-msgbadge"/, 'the Messages count badge');
  // The rail entry + the top-level Guild Hall tab both light from attention.renegotiations.
  assert.match(html, /id="rtab-guild"/, 'the top-level Guild Hall tab is identifiable');
  assert.match(html, /id="rtabGuildAttn"/, 'the top-level tab attention pip');
  assert.match(html, /function myRenegotiations\(s\)\{/, 'the player-guild filter over the attention derive');
  assert.match(html, /s\.attention && Array\.isArray\(s\.attention\.renegotiations\)/, 'reads the snapshot attention derive');

  // 2. THE MESSAGES PANEL renders the open offers as the pinned "Needs a decision" section (each a
  //    subject-line row opening the reneg popup), and (event-log.md §9) the NOTICES below — read +
  //    unread — off the player guild's guilds[].events. "No notices yet." is the EMPTY-log case only.
  assert.match(html, /function messagesPanel\(me\)\{/, 'the Messages panel renderer');
  assert.match(html, /Needs a decision/, 'the pinned action-item section');
  assert.match(html, /data-reneg="/, 'an action-item row carries its venture id for the reneg popup');
  assert.match(html, /data-note="/, 'a notice row carries its event id for the notice popup');
  // The Notices section renders the published rows; "No notices yet." shows ONLY when the log is
  // empty (gated on notices.length now, not printed unconditionally as the Slice-1b stub was).
  assert.match(html, /var notices = \(me && Array\.isArray\(me\.events\)\) \? me\.events : \[\];/,
    'Notices come from the player guild\'s live event-log rows (guilds[].events)');
  assert.match(html, /if\(!notices\.length\)\{\s*rows \+= '<div class="gh-msg-empty">No notices yet\.<\/div>';/,
    '"No notices yet." is the empty-log case only, no longer a hard stub');
  assert.match(html, /class="msg note'\+\(unread \? '' : ' read'\)\+'"/,
    'a notice row is a .msg.note, dimmed .read once acknowledged');
  assert.match(html, /var unread = n\.readTick == null;/, 'unread is the ABSENCE of readTick (event-log.md §3)');
  assert.match(html, /<span class="unreaddot"><\/span>/, 'an unread notice shows the amber unread dot (CSS hides it once read)');
  // 2b. THE REDESIGN (event-log.md §9): a notice row is a SUBJECT LINE that opens a per-type popup.
  //     Its title is built from payload.good + the venture kind (payload.ventureType), and its
  //     "when" is the engine-derived whenDay ("Day N") — rendered verbatim, no game number typed.
  assert.match(html, /var KIND_WORD = \{ mining:'Mine', refining:'Refinery' \};/,
    'the title kind word comes from payload.ventureType (§2)');
  assert.match(html, /function noticeLabel\(p\)\{/, 'the "{Good} {Kind}" title label (degrades gracefully)');
  assert.match(html, /function noticeTitle\(n\)\{/, 'the popup title builder');
  assert.match(html, /'Licence lapsed — '/, 'the licence_lapsed title');
  assert.match(html, /'Venture closed — '/, 'the venture_closed title');
  assert.match(html, /function noticeRowTitle\(n\)\{/, 'the subject-line row title (label in the muted .who span)');
  assert.match(html, /\('Day ' \+ n\.whenDay\)/, 'the row "when" is the engine-derived whenDay (§9), rendered verbatim');
  // 2c. THE NOTICE POPUP (§9) — the adviser-reel card, its own overlay + its own opener, filled from
  //     the row's event by id. Uniform Syndicate tone (one eyebrow, no per-type accent). A single
  //     Dismiss — NO ACKNOWLEDGE button. The body is static per (type + cause); the node-held
  //     sentence and the "Node held until" fact are gated on payload.lockoutUntilTick / unlockDay.
  assert.match(html, /id="notice-overlay"/, 'the notice popup overlay');
  assert.match(html, /Syndicate Notice/, 'the uniform Syndicate-notice eyebrow (no per-type accent, §9)');
  assert.match(html, /id="noticeTitle"/, 'the popup title slot');
  assert.match(html, /id="noticeBody"/, 'the popup body slot');
  assert.match(html, /id="noticeFacts"/, 'the popup facts block');
  assert.match(html, /id="noticeDismiss"[^>]*>Dismiss</, 'a single Dismiss control — no ACKNOWLEDGE button (§9)');
  assert.match(html, /function noticeBody\(n\)\{/, 'the popup body is keyed on type + cause (the four writers, §2)');
  assert.match(html, /Its node stays held under the Syndicate's lockout/, 'the node-held sentence is present …');
  assert.match(html, /if\(p\.lockoutUntilTick != null\)\{\s*base \+=/,
    '… and gated on payload.lockoutUntilTick — a lapse / unlicensed teardown claims no node (§9)');
  assert.match(html, /facts\.push\(\['Node held until', 'Day ' \+ n\.unlockDay, true\]\);/,
    'the facts block shows "Node held until" = unlockDay, only on a closure carrying a lockout');
  assert.match(html, /window\.__openNotice = openNotice/, 'the notice popup single entry point is exposed (§9)');
  // 2d. READ = OPENING (§9): a notice row click opens the popup, which dispatches the EXISTING
  //     acknowledgeEvent for the row's id (as a Number). There is NO inline ACKNOWLEDGE control.
  assert.ok(!/class="ack" data-ack=/.test(html), 'the inline ACKNOWLEDGE button is gone (read = opening, §9)');
  assert.match(html, /openNotice\(Number\(noteRow\.getAttribute\('data-note'\)\)\)/,
    'a notice row click opens the popup with its id sent as a Number');
  assert.match(html, /type:'acknowledgeEvent', guildId:guildId, eventId:eventId/,
    'opening a notice dispatches the existing acknowledgeEvent action');
  // The tab pip + the Messages badge light for an unread notice too (design.md §5 — highlights
  // while any offer is open OR any notice is unread), the count adding unread notices to offers.
  assert.match(html, /function myUnreadNotices\(s\)\{/, 'the player-guild unread-notice filter over attention.notices');
  assert.match(html, /s\.attention && Array\.isArray\(s\.attention\.notices\)/, 'reads the snapshot attention.notices derive');
  assert.match(html, /myRenegotiations\(s\)\.length \+ myUnreadNotices\(s\)\.length/,
    'the badge/pip count adds the player\'s unread notices to the open offers');
  // #64 Slice 2: the static "window elapsed" marker is REPLACED by the live acceptance countdown,
  // rendered from the offer's engine-derived daysToLapse (the client types no day count). The
  // last day is amber ("hot"). This flips the Slice-1b "no countdown" pin.
  assert.match(html, /function deadlineLabel\(offer\)\{/, 'the countdown label reads the offer');
  assert.match(html, /offer\.daysToLapse/, 'the countdown comes from the snapshot, not the client');
  assert.match(html, /'respond in '\+n\+' days'/, 'the row shows "respond in N days"');
  assert.match(html, /respond in 1 day/, 'the last day is phrased accordingly');

  // 3. THE POPUP exists (same modal shape as the venture popups) with the Syndicate-liaison voice,
  //    the four term rows, and ACCEPT / REJECT.
  assert.match(html, /id="reneg-overlay"/, 'the renegotiation popup overlay');
  assert.match(html, /Syndicate Liaison/, 'the one Syndicate-liaison adviser voice (no domain characters)');
  assert.match(html, /id="renegAccept"/, 'the ACCEPT action');
  assert.match(html, /id="renegReject"/, 'the REJECT action');
  // ACCEPT fires the built renegotiateLicence; REJECT confirms then fires the new lapseLicence.
  assert.match(html, /type:'renegotiateLicence', guildId:g, ventureId:id/, 'ACCEPT → renegotiateLicence (built)');
  assert.match(html, /type:'lapseLicence', guildId:g, ventureId:id/, 'REJECT → lapseLicence (the new action)');
  assert.match(html, /window\.__adviserConfirm/, 'REJECT routes through the shared Adviser confirm');
  // The popup reads the terms off the snapshot — the venture's licence and its published offer —
  // and computes no game number itself (§5).
  assert.match(html, /v\.renegotiationOffer/, 'the popup reads the published renegotiationOffer');
  assert.match(html, /offer\.committedOutputPct/, 'the offered commitment comes from the snapshot');
  assert.match(html, /offer\.discountedFee/, 'the offered fee comes from the snapshot');

  // 4. THE ONE POPUP, TWO ENTRY POINTS — a Messages row and the VM Renegotiate button both call it.
  assert.match(html, /window\.__openRenegotiation = open/, 'the single popup entry point is exposed');
  assert.match(html, /window\.__openRenegotiation\(guildId, ventureId\)/, 'entry point 1: a Messages row');
  assert.match(html, /window\.__openRenegotiation\(player\.guildId, VM\.ventureId\)/, 'entry point 2: the VM Renegotiate button');
});

// The two Venture Management snapshot derives are PUBLISHED on the venture row a licensed venture
// produces (docs/venture-management.md §7 / Part 1) — so the client renders them rather than
// computing a game number. This drives the live server end-to-end: found, establish, license, tick.
test('a licensed venture publishes contractWindow (cycles) and equityPerCycle on /snapshot', async () => {
  await reset();
  // A short cycle so the term is legible; found, establish a titanium mine with equity, license it.
  await req('POST', '/action', { type: 'setWindowN', windowN: 4 });
  await found({ credits: 500 });
  await mine({ ventureId: 'vm1', equityPct: 0.4 });
  // Tick once BEFORE signing so the licence is signed at a DAY-ALIGNED tick (tick 1, the first
  // tick of day 0). #64 Slice 2 day-aligns contractWindow onto the calendar window-end; at a
  // day-aligned signing that coincides with teardown's raw licenceEndTick, so the endTick ==
  // lockoutUntilTick agreement below still holds (they diverge only for a mid-day signing).
  await req('POST', '/tick');
  await req('POST', '/action', { type: 'applyForLicence', guildId: 'player-guild', ventureId: 'vm1', committedOutputPct: 1, windowDays: 7 });
  await req('POST', '/tick');

  const snap = (await req('GET', '/snapshot')).body;
  const v = (snap.ventures || []).find((row) => row.id === 'vm1');
  assert.ok(v, 'the licensed venture is on the snapshot');

  // contractWindow is present and in CYCLES, its endTick agreeing with the settlement's lockout.
  assert.ok(v.contractWindow, 'contractWindow is published for a licensed venture');
  assert.equal(v.contractWindow.cyclesRemaining, 7, 'a fresh 7-day term has 7 cycles left');
  assert.equal(v.contractWindow.expired, false);
  assert.equal(v.contractWindow.endTick, v.teardownSettlement.lockoutUntilTick,
    'the window end and the settlement lockout are one tick');

  // equityPerCycle is a positive integer for a real equity offer.
  assert.equal(typeof v.equityPerCycle, 'number');
  assert.ok(Number.isInteger(v.equityPerCycle), 'equityPerCycle is integer credits (§15.2)');
  assert.ok(v.equityPerCycle > 0, 'a 40% equity offer projects a real per-cycle payout');

  // #64 Slice 1b: the attention derive is published top-level as a stable shape. The window is
  // NOT yet elapsed here, so the list is empty — but the key is always present (the read model's
  // stable-shape courtesy, like nodeLockouts). The offer-surfacing itself is engine-tested.
  assert.ok(snap.attention && Array.isArray(snap.attention.renegotiations),
    'attention.renegotiations is published as an array');
  assert.equal(snap.attention.renegotiations.length, 0, 'no open offer before the window elapses');
});
