'use strict';

// outpost-teardown-client.test.js — the CLIENT half of the Outpost teardown (roadmap 2.2 Outpost teardown /
// redeploy, client slice; docs/outpost-teardown.md §10 AS-BUILT, docs/event-log.md §12).
//
// Two pieces of client/game.html are under test:
//   - THE TEARDOWN STRIP in the Outpost Manager: on the player's own Outpost, a Teardown button with a static
//     hint, an inline confirm, and ONE reclaimOutpost sent on Confirm. The engine is the only judge of the
//     gate, so a refusal shows the engine's reason word for word, and an accept re-reads the snapshot (the
//     manager closes itself) and opens the pilot's notice.
//   - THE outpost_packed NOTICE in MESSAGES: its row title, its popup in the pilot's voice, its facts, and its
//     one control, Show on map. The pilot now speaks for two notices with different buttons, so the speaker
//     (`pilot`) and the deploy_failed forks (`fleet`) are separate flags.
//
// The client has no DOM test harness, so — as constructed-building-head.test.js does — these tests cut the
// page's OWN code out of game.html and run it in a node:vm sandbox with a stub DOM, against REAL engine
// output: a guild that really reclaimed an Outpost, its real snapshot, and the engine's real refusal reasons.
// A handful of plain source checks pin the wiring the sandbox cannot reach (markup, listeners, CSS).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { buildSnapshot } = require('../snapshot.js');
const { hexDistance } = require('../transport.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT } = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction,
  createReclaimOutpostAction, createSpawnOutpostAction, createSpawnVehicleAction, createDispatchVehicleAction,
} = require('../actions.js');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'client', 'game.html'), 'utf8');
const eventLogDoc = fs.readFileSync(path.join(ROOT, 'docs', 'event-log.md'), 'utf8');

// The pilot's line, verbatim from docs/event-log.md §12 (and outpost-teardown.md §8).
const PILOT_LINE = 'The outpost has been packed up, ready to be deployed, Guildmaster. Where do you want me to take it?';

// ---- the page's own code, cut out of game.html -----------------------------------------------------------

// cut(src, re, what) -> the first match of `re` in `src`, or a loud failure naming what went missing.
function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in game.html`);
  return m[0];
}
// Each IIFE declares its own el / esc / snap helpers, so every cut is scoped to its own <script> first.
const guildScript = html.slice(html.indexOf('<script id="guild-tab-wire">'));
const managerScript = html.slice(html.indexOf('THE OUTPOST MANAGER (read-only)'));
assert.ok(guildScript.length < html.length && managerScript.length < html.length, 'both scripts are found');

// The Guild Hall's helpers (el, snap, meGuild, fmt, esc), its prettyGood, and the whole notice block — from
// the Notices comment to centreFor, which takes in every title / body / facts helper, openNotice, the forks
// and Show on map.
const guildHelpersSrc = cut(guildScript, /\n  function el\(id\)\{[\s\S]*?(?=\n  function pad4\()/, 'the Guild Hall helpers (el … esc)');
const prettyGoodSrc = cut(guildScript, /\n  function prettyGood\(g\)\{[^\n]*\n/, 'the Guild Hall prettyGood');
const noticeSrc = cut(guildScript, /\n  \/\/ --- Notices \(docs\/event-log\.md §9[\s\S]*?(?=\n  function centreFor\()/, 'the notice code (Notices … centreFor)');
// The Outpost Manager's TEARDOWN block — from its banner to the tab clicks that follow it.
const teardownSrc = cut(managerScript, /\n  \/\* =+\n     TEARDOWN \(docs\/outpost-teardown\.md[\s\S]*?(?=\n  \/\/ tab clicks)/, 'the Outpost Manager TEARDOWN block');

// ---- a real galaxy: g1 holds its home and owns an Outpost with craft parked on it ---------------------------

const HOME = starterHomeAtDistance(6);
const HOME_HEX = getSystem(HOME.id).coords;
const HOME_NAME = getSystem(HOME.id).name;

// The first in-bounds hex exactly `d` from home holding no seed landmark (`skip` asks for a later one) —
// the outpost-teardown.test.js helper, so a regenerated seed carries these tests instead of breaking them.
function freeHexAtDistance(d, skip = 0) {
  let seen = 0;
  for (let q = HOME_HEX.q - d; q <= HOME_HEX.q + d; q += 1) {
    for (let r = HOME_HEX.r - d; r <= HOME_HEX.r + d; r += 1) {
      if (hexDistance({ q, r }, HOME_HEX) !== d || !isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      if (seen === skip) return { q, r };
      seen += 1;
    }
  }
  throw new Error(`no free hex at distance ${d} on this seed`);
}
const OUT_HEX = freeHexAtDistance(2);
const SECOND_HEX = freeHexAtDistance(2, 1);
const OUTPOST_01 = 'outpost_g1_01';
const OUTPOST_02 = 'outpost_g1_02';
const HEAVY_01 = 'vehicle_g1_heavyTransport_01';

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};

// galaxy({ craft }) -> g1 holds its home and owns outpost_g1_01 on OUT_HEX with one idle craft of each class
// in `craft` parked on it; g2 owns an Outpost too (a rival's, for the not-own case).
function galaxy({ craft = [HEAVY_TRANSPORT], fuelHoard = 0 } = {}) {
  let s = createState({
    guilds: [
      { id: 'g1', credits: 0, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet },
      { id: 'g2', credits: 0, fuelHoard: 0 },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [{ claimId: 'claim_g1_home', ownerGuildId: 'g1', landmarkId: HOME.id, landmarkKind: 'system', claimedAtTick: 0, contested: false }],
  });
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: OUT_HEX }));
  s = accept(s, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: HOME.id, coords: SECOND_HEX }));
  for (const vehicleClass of craft) {
    s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location: OUT_HEX }));
  }
  return s;
}
const reclaim = (outpostId = OUTPOST_01) => createReclaimOutpostAction({ guildId: 'g1', outpostId });
const refusalOf = (s) => {
  const v = validateAction(s, reclaim());
  assert.equal(v.valid, false, 'premise: the engine refuses this reclaim');
  return v.reason;
};
// The snapshot exactly as the browser receives it from GET /snapshot.
const snapOf = (s) => JSON.parse(JSON.stringify(buildSnapshot(s)));
const g1Of = (snap) => snap.guilds.find((g) => g.id === 'g1');
const packedOf = (snap) => g1Of(snap).events.find((e) => e.type === 'outpost_packed');

// HTML text -> the plain text the browser shows (the four entities the page's esc writes).
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// An object built inside the sandbox has the sandbox's own Object prototype, so strict deep-equality would
// call it different from the same fields built here. Compare its JSON form, which is what POST /action sends.
const plain = (x) => JSON.parse(JSON.stringify(x));
// Let every pending promise callback run (the action's answer, then the refresh).
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---- sandbox 1: the notice popup ------------------------------------------------------------------------------

// A stub DOM node with the few things openNotice touches. The three optional buttons start hidden, as their
// markup does.
function stubNode(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', style: {},
    hidden: ['noticeRedeploy', 'noticeReturn', 'noticeShowMap'].includes(id),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
  };
}

// noticePage(snapshot) -> the page's notice code running against `snapshot` for player g1, with a stub DOM.
// `sent` records every action posted, `flown` every __flyTo call.
function noticePage(snapshot) {
  const nodes = {};
  const sent = [];
  const flown = [];
  const sandbox = {
    document: { getElementById: (id) => nodes[id] || (nodes[id] = stubNode(id)) },
    window: {
      __player: () => ({ guildId: 'g1' }),
      __snapshot: () => snapshot,
      __sendAction: (a) => { sent.push(a); return Promise.resolve({ accepted: true }); },
      __refreshNow: () => Promise.resolve(),
      __flyTo: (q, r, z) => { flown.push([q, r, z]); },
      __outpostName: (id) => id,
    },
  };
  vm.runInNewContext(guildHelpersSrc + prettyGoodSrc + noticeSrc, sandbox);
  const node = (id) => sandbox.document.getElementById(id);
  // What the player sees on the card right now.
  const view = () => ({
    open: node('notice-overlay').classList.contains('open'),
    eyebrow: node('noticeEyebrow').textContent,
    art: node('noticeArt').style.backgroundImage,
    title: node('noticeTitle').textContent,
    paragraphs: [...node('noticeBody').innerHTML.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => unescape(m[1])),
    facts: [...node('noticeFacts').innerHTML.matchAll(/<span class="k">([^<]*)<\/span><span class="v[^"]*">([^<]*)<\/span>/g)]
      .map((m) => [unescape(m[1]), unescape(m[2])]),
    redeploy: !node('noticeRedeploy').hidden,
    returnFork: !node('noticeReturn').hidden,
    showMap: !node('noticeShowMap').hidden,
    note: node('noticeNote').textContent,
  });
  return { page: sandbox, sent, flown, view };
}

// A snapshot in which g1 really reclaimed outpost_g1_01 (one outpost_packed row, unread), plus two rows of
// the other kinds the popup must still dress correctly. Those two are spelled out in their published
// shapes (event-log.md §2 / §10); their ids sit clear of the engine's counter.
const DEPLOY_FAILED_ID = 900;
const VENTURE_CLOSED_ID = 901;
function reclaimedSnapshot(s = accept(galaxy(), reclaim())) {
  const snap = snapOf(s);
  g1Of(snap).events.push(
    { id: DEPLOY_FAILED_ID, type: 'deploy_failed', tick: 0, whenDay: 0, readTick: 0, payload: {
      cause: 'occupied', kind: 'outpost', targetHex: { q: 1, r: 2 }, craftId: HEAVY_01, craftClass: HEAVY_TRANSPORT,
      retreatSystemId: HOME.id, retreatSystemName: HOME_NAME } },
    { id: VENTURE_CLOSED_ID, type: 'venture_closed', tick: 0, whenDay: 0, readTick: 0, payload: {
      cause: 'teardown', good: 'titanium', ventureType: 'mining', ventureName: 'Somewhere · Node 1' } },
  );
  return snap;
}

// ---- 1. the notice: row, popup, facts ------------------------------------------------------------------------

test('the engine writes the line the client shows: the pilot line is in event-log.md §12 and in game.html, once', () => {
  assert.ok(eventLogDoc.includes(`> ${PILOT_LINE}`), 'docs/event-log.md §12 quotes the line');
  assert.equal(html.split(PILOT_LINE).length - 1, 1, 'game.html carries it exactly once, as OUTPOST_PACKED_BODY');
  assert.match(html, /var OUTPOST_PACKED_BODY = \[\n\s+"The outpost has been packed up/);
});

test('row and title: "Outpost packed up — <anchor> Outpost", never the licence-lapse fallback', () => {
  const snap = reclaimedSnapshot();
  const n = packedOf(snap);
  const { page } = noticePage(snap);
  assert.equal(page.noticeTitle(n), 'Outpost packed up');
  assert.equal(page.noticeRowTitle(n), `Outpost packed up &mdash; <span class="who">${HOME_NAME} Outpost</span>`);
  // The Outpost is gone, so the name comes from the payload: the seed name, else the system id.
  const noName = { ...n, payload: { ...n.payload, anchorSystemName: undefined } };
  assert.equal(page.noticeRowTitle(noName), `Outpost packed up &mdash; <span class="who">${HOME.id} Outpost</span>`);
  assert.doesNotMatch(page.noticeRowTitle(n) + page.noticeTitle(n), /Licence|lapsed/);
  assert.equal(page.isDeliveryNotice(n), false, 'it is not a Trader notice');
});

test('the unread count: an unread outpost_packed lights the Messages badge like any notice', () => {
  const snap = reclaimedSnapshot();
  const { page } = noticePage(snap);
  const unread = page.myUnreadNotices(snap);
  assert.equal(unread.length, 1, 'the one unread row is the packed notice (the two fixtures are read)');
  assert.equal(unread[0].type, 'outpost_packed');
});

test('popup: the pilot speaks, the line is verbatim, the facts are the payload, and Show on map is the one control', () => {
  const snap = reclaimedSnapshot();
  const n = packedOf(snap);
  const { page, view } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(view(), {
    open: true,
    eyebrow: 'Fleet — Dispatch',
    art: "url('assets/characters/pilot.jpg')",
    title: 'Outpost packed up',
    paragraphs: [PILOT_LINE],
    facts: [
      ['Craft', 'Heavy Transport · #01'],
      ['Packed at', `${HOME_NAME} · hex ${OUT_HEX.q}, ${OUT_HEX.r}`],
      ['When', `Day ${n.whenDay}`],
    ],
    redeploy: false,
    returnFork: false,
    showMap: true,
    note: '',
  });
});

test('pilot / fleet split: a deploy_failed keeps its two forks, an outpost_packed shows neither, and nothing carries over', () => {
  const snap = reclaimedSnapshot();
  const packedId = packedOf(snap).id;
  const { page, view } = noticePage(snap);
  // In an order that would expose any leftover: forks → packed → Syndicate → forks again.
  page.openNotice(DEPLOY_FAILED_ID);
  let v = view();
  assert.equal(v.eyebrow, 'Fleet — Dispatch');
  assert.equal(v.art, "url('assets/characters/pilot.jpg')");
  assert.deepEqual([v.redeploy, v.returnFork, v.showMap], [true, true, false], 'deploy_failed: its two forks, no Show on map');
  assert.equal(v.paragraphs.length, 2, 'the failed deploy still speaks its two beats');

  page.openNotice(packedId);
  v = view();
  assert.deepEqual([v.redeploy, v.returnFork, v.showMap], [false, false, true], 'outpost_packed: Show on map, no forks');
  assert.deepEqual(v.paragraphs, [PILOT_LINE]);

  page.openNotice(VENTURE_CLOSED_ID);
  v = view();
  assert.equal(v.eyebrow, 'Syndicate Notice');
  assert.equal(v.art, "url('assets/characters/advisor.jpg')", 'the pilot is handed back to the adviser');
  assert.deepEqual([v.redeploy, v.returnFork, v.showMap], [false, false, false], 'a Syndicate notice: Dismiss alone');

  page.openNotice(DEPLOY_FAILED_ID);
  v = view();
  assert.deepEqual([v.redeploy, v.returnFork, v.showMap], [true, true, false]);
});

test('read-on-open is unchanged: an unread packed notice sends one acknowledgeEvent by numeric id; a reopen sends none', () => {
  const snap = reclaimedSnapshot();
  const n = packedOf(snap);
  assert.equal(n.readTick, undefined, 'premise: born unread');
  const { page, sent } = noticePage(snap);
  page.openNotice(n.id);
  assert.deepEqual(plain(sent), [{ type: 'acknowledgeEvent', guildId: 'g1', eventId: n.id }]);
  assert.equal(typeof sent[0].eventId, 'number');
  page.openNotice(DEPLOY_FAILED_ID);   // already read
  assert.equal(sent.length, 1, 'a read notice dispatches nothing');
});

// ---- 2. Show on map --------------------------------------------------------------------------------------------

test('Show on map: closes the popup and flies to the heavy where it idles on a bare hex, at zoom 9', () => {
  const snap = reclaimedSnapshot();
  const { page, flown, view } = noticePage(snap);
  page.openNotice(packedOf(snap).id);
  page.noticeShowMap();
  assert.equal(view().open, false, 'the popup closes');
  assert.deepEqual(flown, [[OUT_HEX.q, OUT_HEX.r, 9]], 'the packed heavy sits idle where the Outpost stood');
});

test('Show on map: the heavy idling on a DIFFERENT bare hex is followed there (its current hex, not payload.hex)', () => {
  const snap = reclaimedSnapshot();
  const heavy = g1Of(snap).vehicles.find((v) => v.id === HEAVY_01);
  heavy.location = { q: SECOND_HEX.q, r: SECOND_HEX.r };   // as if flown on and parked elsewhere
  const { page, flown } = noticePage(snap);
  page.openNotice(packedOf(snap).id);
  page.noticeShowMap();
  assert.deepEqual(flown, [[SECOND_HEX.q, SECOND_HEX.r, 9]]);
});

test('Show on map falls back to payload.hex when the heavy is flying, at a system, or gone', () => {
  // Flying: really dispatched home by the engine, so its row has a trip and no location.
  let s = accept(galaxy({ fuelHoard: 10_000 }), reclaim());
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY_01, waypoints: [{ landmarkKind: 'system', landmarkId: HOME.id }] }));
  let snap = reclaimedSnapshot(s);
  assert.equal(g1Of(snap).vehicles[0].status, 'inTransit', 'premise: in flight');
  let p = noticePage(snap);
  p.page.openNotice(packedOf(snap).id);
  p.page.noticeShowMap();
  assert.deepEqual(p.flown, [[OUT_HEX.q, OUT_HEX.r, 9]], 'flying → where the Outpost stood');

  // Landed at the system: a landmark, not a bare hex.
  for (let i = 0; i < 20_000 && s.guilds[0].vehicles[0].status !== 'idle'; i += 1) s = advance(s, []).state;
  snap = reclaimedSnapshot(s);
  assert.deepEqual(g1Of(snap).vehicles[0].location, { landmarkKind: 'system', landmarkId: HOME.id }, 'premise: landed home');
  p = noticePage(snap);
  p.page.openNotice(packedOf(snap).id);
  p.page.noticeShowMap();
  assert.deepEqual(p.flown, [[OUT_HEX.q, OUT_HEX.r, 9]], 'at a system → where the Outpost stood');

  // Gone from the snapshot.
  snap = reclaimedSnapshot();
  g1Of(snap).vehicles = [];
  p = noticePage(snap);
  p.page.openNotice(packedOf(snap).id);
  p.page.noticeShowMap();
  assert.deepEqual(p.flown, [[OUT_HEX.q, OUT_HEX.r, 9]], 'gone → where the Outpost stood');
});

// ---- sandbox 2: the Teardown strip -----------------------------------------------------------------------------

// managerPage({ before, after, answer }) -> the Outpost Manager's TEARDOWN block running with the manager open on
// outpost_g1_01. `before` is the snapshot shown now; `answer(action)` is what POST /action returns (a promise);
// `after` is what the refresh reads. The refresh does what the page's applySnapshot → render does when the
// Outpost has left the snapshot: closeManager (pinned below, in the source checks).
function managerPage({ before, after = before, answer = () => Promise.resolve({ accepted: true }), outpostId = OUTPOST_01 }) {
  const foot = { innerHTML: '', handler: null, addEventListener(type, fn) { this.handler = fn; } };
  const sent = [];
  const opened = [];
  let current = before;
  let refreshes = 0;
  const sandbox = {
    OM: { open: true, id: outpostId },
    $: (id) => (id === 'omTeardown' ? foot : null),
    paint: (id, h) => { assert.equal(id, 'omTeardown'); foot.innerHTML = h; },
    esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
    snap: () => current,
    outpostRow: () => (current.outposts || []).find((o) => o.id === sandbox.OM.id) || null,
    window: {
      __player: () => ({ guildId: 'g1' }),
      __sendAction: (a) => { sent.push(a); return answer(a); },
      __refreshNow: () => {
        refreshes += 1;
        current = after;
        if (!sandbox.outpostRow()) { sandbox.OM.open = false; sandbox.OM.id = null; sandbox.OM.teardown = sandbox.freshTeardown(); }
        return Promise.resolve();
      },
      __openNotice: (id) => { opened.push(id); },
    },
  };
  vm.runInNewContext(teardownSrc, sandbox);
  sandbox.OM.teardown = sandbox.freshTeardown();
  // The strip as the player reads it.
  const strip = () => {
    const h = foot.innerHTML;
    const why = h.match(/<div class="why">([^<]*)<\/div>/);
    const buttons = [...h.matchAll(/<button[^>]*data-tear="([a-z]+)"([^>]*)>([^<]*)<\/button>/g)]
      .map((m) => ({ act: m[1], disabled: / disabled/.test(m[2]), label: m[3] }));
    return { html: h, buttons, reason: why ? unescape(why[1]) : null };
  };
  // A click on a strip button, as the delegated listener receives it; a disabled button takes no click.
  const click = (act) => {
    const b = strip().buttons.find((x) => x.act === act);
    assert.ok(b, `the strip shows a ${act} button`);
    const target = { disabled: b.disabled, getAttribute: () => act };
    foot.handler({ target: { closest: () => target } });
  };
  const render = () => { const row = sandbox.outpostRow(); if (row) sandbox.renderTeardown(row); };
  return { page: sandbox, foot, sent, opened, strip, click, render, refreshes: () => refreshes };
}

const HINT = 'Needs an empty stockpile, nothing docked, and one empty heavy parked here.';

test('strip: an own Outpost shows Teardown and the static hint; a rival\'s Outpost shows nothing at all', () => {
  const before = snapOf(galaxy());
  const m = managerPage({ before });
  m.render();
  assert.deepEqual(m.strip().buttons, [{ act: 'start', disabled: false, label: 'Teardown' }]);
  assert.ok(m.strip().html.includes(`<div class="hint">${HINT}</div>`));
  // The rival's Outpost: an empty strip (CSS :empty hides it), so that manager is exactly as before.
  const rival = managerPage({ before, outpostId: 'outpost_g2_01' });
  rival.render();
  assert.equal(rival.foot.innerHTML, '');
});

test('strip: the button is live whatever the gate would say — the client checks nothing (§2)', () => {
  // Nothing parked: the engine would refuse, and the button is still live with the same hint.
  const m = managerPage({ before: snapOf(galaxy({ craft: [] })) });
  m.render();
  assert.deepEqual(m.strip().buttons, [{ act: 'start', disabled: false, label: 'Teardown' }]);
  // And the block reads none of the gate's inputs.
  assert.doesNotMatch(teardownSrc, /\.stockpile\b|\.queue\b|\.slots\b|\.cargo\b|\.vehicles\b|\.status\b|parkedCraft\(/);
});

test('confirm: Teardown asks first, Cancel folds it back, Confirm sends ONE reclaimOutpost — the engine\'s own shape', async () => {
  const s = galaxy();
  const after = snapOf(accept(s, reclaim()));
  let release;
  const m = managerPage({ before: snapOf(s), after, answer: () => new Promise((r) => { release = r; }) });
  m.render();
  m.click('start');
  assert.ok(m.strip().html.includes('<span class="ask">Pack up this Outpost?</span>'));
  assert.deepEqual(m.strip().buttons.map((b) => b.label), ['Confirm', 'Cancel']);
  m.click('cancel');
  assert.deepEqual(m.strip().buttons.map((b) => b.label), ['Teardown']);
  assert.equal(m.sent.length, 0, 'nothing is sent without Confirm');

  m.click('start');
  m.click('confirm');
  assert.deepEqual(plain(m.sent), [reclaim()], 'exactly the action createReclaimOutpostAction builds');
  assert.equal(validateAction(s, m.sent[0]).valid, true, 'and the engine accepts it as sent');
  // While the answer is on its way both buttons are off, and a second Confirm sends nothing.
  assert.deepEqual(m.strip().buttons, [
    { act: 'confirm', disabled: true, label: 'Packing up…' },
    { act: 'cancel', disabled: true, label: 'Cancel' },
  ]);
  m.click('confirm');
  m.page.teardownConfirm();
  assert.equal(m.sent.length, 1, 'no double-send');
  release({ accepted: true });
  await settle();
  assert.equal(m.sent.length, 1);
});

test('accepted: the snapshot is re-read, the manager closes, and the pilot\'s notice for THIS Outpost opens', async () => {
  // g1 already packed one Outpost earlier, so the snapshot holds an older outpost_packed row for another id.
  let s = galaxy();
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: freeHexAtDistance(3) }));
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: freeHexAtDistance(3) }));
  s = accept(s, reclaim(OUTPOST_02));
  const after = snapOf(accept(s, reclaim(OUTPOST_01)));
  const rows = g1Of(after).events.filter((e) => e.type === 'outpost_packed');
  assert.equal(rows.length, 2, 'premise: two packed notices');
  const mine = rows.find((e) => e.payload.outpostId === OUTPOST_01);

  const m = managerPage({ before: snapOf(s), after });
  m.render();
  m.click('start');
  m.click('confirm');
  await settle();
  assert.equal(m.refreshes(), 1, 'one re-read of the snapshot');
  assert.equal(m.page.OM.open, false, 'the Outpost is gone, so the manager closed');
  assert.deepEqual(m.opened, [mine.id], 'the notice for the Outpost just packed, not the older one');
  assert.equal(m.strip().reason, null, 'no refusal was ever shown');
});

test('accepted, but no matching notice in the snapshot: nothing opens', async () => {
  const s = galaxy();
  const after = snapOf(accept(s, reclaim()));
  g1Of(after).events = [];
  const m = managerPage({ before: snapOf(s), after });
  m.render();
  m.click('start');
  m.click('confirm');
  await settle();
  assert.equal(m.page.OM.open, false);
  assert.deepEqual(m.opened, []);
});

test('refused: the manager stays open and shows the engine\'s reason word for word — the four everyday refusals', async () => {
  const goods = galaxy();
  goods.outposts.find((o) => o.id === OUTPOST_01).stockpile = { titanium: 5 };
  const cases = [
    ['nothing parked', galaxy({ craft: [] })],
    ['a non-heavy parked', galaxy({ craft: [LIGHT_TRANSPORT] })],
    ['two craft parked', galaxy({ craft: [HEAVY_TRANSPORT, HEAVY_TRANSPORT] })],
    ['a non-empty stockpile', goods],
  ];
  for (const [what, s] of cases) {
    const reason = refusalOf(s);
    const m = managerPage({ before: snapOf(s), answer: () => Promise.resolve({ accepted: false, reason }) });
    m.render();
    m.click('start');
    m.click('confirm');
    await settle();
    assert.equal(m.page.OM.open, true, `${what}: still open`);
    assert.equal(m.strip().reason, reason, `${what}: the reason, verbatim`);
    assert.deepEqual(m.strip().buttons.map((b) => b.label), ['Teardown'], `${what}: back to the button`);
    assert.equal(m.refreshes(), 0);
    assert.deepEqual(m.opened, []);
    // The next click clears it.
    m.click('start');
    assert.equal(m.strip().reason, null, `${what}: cleared on the next click`);
  }
});

test('refused: a tab change clears the reason; a network failure reads as the SELL\'s does', async () => {
  const s = galaxy({ craft: [] });
  const reason = refusalOf(s);
  let m = managerPage({ before: snapOf(s), answer: () => Promise.resolve({ accepted: false, reason }) });
  m.render();
  m.click('start');
  m.click('confirm');
  await settle();
  assert.equal(m.strip().reason, reason);
  m.page.clearTeardownReason(m.page.outpostRow());   // what both tab handlers call
  assert.equal(m.strip().reason, null);

  m = managerPage({ before: snapOf(s), answer: () => Promise.reject(new Error('Failed to fetch')) });
  m.render();
  m.click('start');
  m.click('confirm');
  await settle();
  assert.equal(m.strip().reason, 'the Syndicate could not be reached: Failed to fetch');
  assert.equal(m.page.OM.open, true);
});

test('closed or reopened before the answer: the answer changes nothing', async () => {
  for (const answer of [{ accepted: true }, { accepted: false, reason: 'refused' }]) {
    let release;
    const s = galaxy();
    const m = managerPage({ before: snapOf(s), after: snapOf(accept(s, reclaim())), answer: () => new Promise((r) => { release = r; }) });
    m.render();
    m.click('start');
    m.click('confirm');
    // The player closes the manager (closeManager hands OM a fresh teardown state) and opens it again.
    m.page.OM.teardown = m.page.freshTeardown();
    m.render();
    const shown = m.foot.innerHTML;
    release(answer);
    await settle();
    assert.equal(m.foot.innerHTML, shown, 'the strip is not repainted');
    assert.equal(m.refreshes(), 0, 'no re-read');
    assert.deepEqual(m.opened, [], 'no notice opened');
  }
});

// ---- 3. the wiring the sandboxes cannot reach ------------------------------------------------------------------

test('wiring: the markup, the listeners, the self-close path and the CSS that hides a rival\'s strip', () => {
  // The Show on map button sits in the notice footer, hidden until an outpost_packed opens, and is wired.
  assert.match(html, /<button class="btn accept" id="noticeShowMap" type="button" hidden>Show on map<\/button>\n\s+<button class="btn accept" id="noticeDismiss"/);
  assert.match(guildScript, /el\('noticeShowMap'\)\.hidden = !packed;/);
  assert.match(guildScript, /noticeShowMapBtn\.addEventListener\('click', noticeShowMap\)/);
  // The forks stay deploy_failed-only, the speaker is the pilot flag.
  assert.match(guildScript, /var fleet = n\.type === 'deploy_failed';\n\s+var packed = n\.type === 'outpost_packed';\n\s+var pilot = fleet \|\| packed;/);
  assert.match(guildScript, /el\('noticeRedeploy'\)\.hidden = !fleet;\n\s+el\('noticeReturn'\)\.hidden = !fleet;/);
  // The strip's markup, in the head just before ✕, and its CSS: an empty strip is hidden.
  assert.match(html, /<div class="om-tear" id="omTeardown"><\/div>\n\s+<button class="est-close" id="omClose"/);
  assert.match(html, /#outpost-overlay \.om-tear:empty\{display:none\}/);
  // The manager paints the strip on every render, and still closes itself when its Outpost leaves the snapshot.
  assert.match(managerScript, /renderRight\(row\);\n\s+renderTeardown\(row\);\n\s+\}/);
  assert.match(managerScript, /var row = outpostRow\(\);\n\s+if\(!row\)\{ closeManager\(\); return; \}/);
  // Open and close both reset the strip; both tab handlers clear a reason.
  assert.match(managerScript, /OM\.teardown = freshTeardown\(\);\s+\/\/ …and no pending confirm or old refusal/);
  assert.match(managerScript, /OM\.sell = freshSell\(\); OM\.teardown = freshTeardown\(\);/);
  assert.equal(managerScript.split('renderLeft(r); clearTeardownReason(r);').length - 1, 2);
});
