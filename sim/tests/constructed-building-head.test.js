'use strict';

// constructed-building-head.test.js — the TRADE tab's "4 · Constructed" view puts the Current
// Build donut, the "Building" art and the In Progress highlight on the row the Syndicate is
// ACTUALLY building (the snapshot's `building` head), not on whichever row arrives soonest
// (docs/asset-purchase.md §"Build concurrency"; roadmap 2.1d, the head/queued client slice).
//
// The bug this pins: a guild commissions a MINER (slow — it rides the Syndicate hauler) and then a
// LIGHT TRANSPORT (quick build, flies itself in faster). Far enough from a waystation, the queued
// transport ARRIVES before the building miner, and the view — sorting by arrival — showed the
// transport as the one "building".
//
// Unlike trade-constructed.test.js (which pins source text), this one RUNS the view: it builds that
// exact case in the real engine, takes the real snapshot, and runs the page's own
// `renderConstructed` source against it in a small sandbox (node:vm) with a stub DOM. So it proves
// the seam end to end — the engine's flag → what the player sees.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { LIGHT_TRANSPORT } = require('../vehicles.js');
const { MINER } = require('../assets.js');
const { validateAction, applyAction, createBuyAssetFromSyndicateAction } = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

// ---- the page's own Constructed-view code, cut out of game.html ----
// From cnDur (the first Constructed helper) up to the Add-commission handler that follows
// renderConstructed — the helpers, the art map and the render. `pretty` is the TRADE module's
// display-name helper; taking the real one means the labels checked below are the real labels.
const viewSrc = html.match(/\n  function cnDur\(ticks\)\{[\s\S]*?(?=\n  \/\/ Add a commission:)/);
const prettySrc = html.match(/\n  function pretty\(key\)\{[\s\S]*?\n  \}\n/);
assert.ok(viewSrc, 'the Constructed view source (cnDur … renderConstructed) is present in game.html');
assert.ok(prettySrc, 'the TRADE pretty() helper is present in game.html');

// Render the view for `guildId` off `snapshot` and return the HTML it would put on the page.
// The snapshot goes through JSON first, exactly as the browser receives it from GET /snapshot.
function renderFor(snapshot, guildId) {
  const s = JSON.parse(JSON.stringify(snapshot));
  const container = { innerHTML: '' };
  const sandbox = {
    T: { tier: 4, cnOpen: null, cnNote: '', cnNoteKind: '', cnNoteTimer: null },
    el: (id) => (id === 'tw-cn' ? container : null),
    snap: () => s,
    meGuild: () => s.guilds.find((g) => g.id === guildId) || null,
    fmt: (n) => String(Math.round(n)),
  };
  vm.runInNewContext(prettySrc[0] + viewSrc[0] + '\nrenderConstructed();', sandbox);
  return container.innerHTML;
}

// Pull the parts of the rendered HTML the player reads.
function readView(out) {
  const donutHeader = out.match(/<span class="t">Current Build<\/span><span class="n">([^<]*)<\/span>/);
  const hero = out.match(/<div class="dk-card dk-hero( dim)?"><div class="art" style="background-image:url\('([^']*)'\)"><\/div><div class="scrim"><\/div><div class="ttop"><div class="zhead">Building<\/div><\/div><div class="role">([^<]*)<\/div>/);
  const queueHeader = out.match(/<span class="t">In Progress<\/span><span class="n">([^<]*)<\/span>/);
  const rowRe = /<div class="ip-item( cur)?"><span class="k">([^<]*)<span class="sub">arrives in ([^<]*)<\/span><\/span><span class="eta">([^<]*)<\/span>/g;
  const rows = [...out.matchAll(rowRe)].map((m) => ({ cur: !!m[1], name: m[2], arrives: m[3], cell: m[4] }));
  assert.ok(donutHeader && hero && queueHeader, 'the Current Build, Building and In Progress panels rendered');
  return {
    donutHeader: donutHeader[1],
    heroDim: !!hero[1], heroArt: hero[2], heroRole: hero[3],
    queueHeader: queueHeader[1],
    rows,
  };
}

// ---- the galaxy: one guild, homed 12 hexes from its nearest waystation ----
// At 12 hexes the miner's hauled delivery is slow enough that a light transport commissioned
// AFTER it still arrives first (checked from the snapshot below, not assumed).
const HOME = starterHomeAtDistance(12);

function guildState() {
  const credits = 200_000_000;
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: GUILD_STARTING_FUEL, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims: [{
      claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: HOME.id,
      landmarkKind: 'system', claimedAtTick: 0, contested: false,
    }],
  });
}

// The POST /action path in-process: validate, apply, then every invariant with no tick between.
function accept(state, action) {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  const next = applyAction(state, action);
  assert.deepEqual(checkInvariants(next, next.tick), [], `invariants after ${action.type}`);
  return next;
}

const buy = (assetKind) =>
  createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind, destinationSystemId: HOME.id });

// The miner first (so it is the head), then the light transport queued behind it.
function minerThenLightTransport() {
  let s = guildState();
  s = accept(s, buy(MINER));
  s = accept(s, buy(LIGHT_TRANSPORT));
  return s;
}

test('the queued light transport really does arrive BEFORE the building miner (the repro holds)', () => {
  const s = tick(minerThenLightTransport()); // one tick: the miner starts building
  const snap = buildSnapshot(s);
  const [minerRow, ltRow] = snap.syndicateBuilds;
  assert.equal(minerRow.assetKind, MINER);
  assert.equal(minerRow.building, true, 'the miner is the building head');
  assert.equal(ltRow.assetKind, LIGHT_TRANSPORT);
  assert.equal(ltRow.building, false, 'the light transport is queued');
  // Arrival = queue-aware build remaining + the row's own delivery leg — both snapshot fields.
  const route = snap.guilds.find((g) => g.id === 'g1').fuelCost[HOME.id];
  const minerArrives = minerRow.ticksRemaining + route.travelTicks;
  const ltArrives = ltRow.ticksRemaining + route.vehicleTravelTicks[LIGHT_TRANSPORT];
  assert.ok(ltArrives < minerArrives,
    `the queued light transport must arrive first for this test to mean anything (lt ${ltArrives} vs miner ${minerArrives})`);
});

test('the donut, the Building art and the highlight all show the MINER — the light transport reads "queued"', () => {
  const v = readView(renderFor(buildSnapshot(tick(minerThenLightTransport())), 'g1'));

  // Panel 3 — the Current Build donut is the miner's, tagged "building" (not "soonest").
  assert.equal(v.donutHeader, 'Miner &middot; building');
  // Panel 4 — the Building art and its label are the miner's (not the light transport portrait).
  assert.equal(v.heroDim, false);
  assert.equal(v.heroRole, 'Miner');
  assert.equal(v.heroArt, 'assets/industrial/factoryConstruction.jpg');
  // Panel 2 — queue order (miner first), the miner highlighted with a %, the transport "queued".
  assert.equal(v.queueHeader, '2 in queue');
  assert.deepEqual(v.rows.map((r) => [r.name, r.cur, r.cell]), [
    ['Miner', true, '0%'],
    ['Light Transport', false, 'queued'],
  ]);
});

test('the head is the miner even the tick BEFORE its countdown starts (the flag, not the clock)', () => {
  // No tick yet: neither entry has started, but the snapshot already flags the miner as the head.
  const v = readView(renderFor(buildSnapshot(minerThenLightTransport()), 'g1'));
  assert.equal(v.donutHeader, 'Miner &middot; building');
  assert.equal(v.heroRole, 'Miner');
  assert.deepEqual(v.rows.map((r) => [r.name, r.cur, r.cell]), [
    ['Miner', true, '0%'],
    ['Light Transport', false, 'queued'],
  ]);
});

test('with nothing commissioned the view is IDLE — no head, dimmed art, no rows', () => {
  const out = renderFor(buildSnapshot(guildState()), 'g1');
  const v = readView(out);
  assert.equal(v.donutHeader, 'idle');
  assert.equal(v.heroDim, true);
  assert.equal(v.heroRole, 'Idle');
  assert.equal(v.queueHeader, 'idle');
  assert.deepEqual(v.rows, []);
  assert.match(out, /class="big grey">IDLE/);
});
