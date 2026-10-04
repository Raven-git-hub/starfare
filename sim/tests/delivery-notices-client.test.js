'use strict';

// delivery-notices-client.test.js — the Trader's two delivery notices in MESSAGES (docs/event-log.md §11;
// roadmap 2.2, trading to/from outposts client slice 3b). The engine writes `delivery_space_warning` when a
// BUY leaves for an Outpost that cannot hold it now, and `delivery_turned_back` when a delivery is lost on
// arrival (cause 'full' or 'outpost-gone'). The client renders each as a row title, a popup title, the
// Trader's words and a facts block — and computes no game number (§18).
//
// Like buy-destination-picker.test.js, this RUNS the page's own code (node:vm, a DOM-free sandbox) against
// notices the ENGINE wrote, read through the real snapshot:
//   - every fact is a payload field (or the engine's whenDay), formatted — never a sum or a difference;
//   - the Outpost is named by the shell's one outpost resolver, cut from the page too, so a torn-down
//     Outpost (gone from the snapshot) falls back to its raw id, as it would on any screen;
//   - the body is the Trader's copy, keyed on type + cause;
//   - no title, fact or body line is an emoji, and the other notice types are not delivery notices.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { OUTPOST_CAPACITY } = require('../outposts.js');
const { isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { nearestWaystation } = require('../transport.js');
const {
  createAddOrderLineAction, createBuyFromSyndicateAction, createRemoveOutpostAction, validateAction, applyAction,
} = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

// ---- the page's own code: the notice titles + the trade lane, and the shell's outpost resolver ----
const guildBlock = html.slice(html.indexOf('<script id="guild-tab-wire">'), html.indexOf('<script id="ind-hero-wire">'));
function cut(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what} is present in the page`);
  return m[0];
}
const fnRe = (name) => new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n');
const pageSrc = [
  cut(guildBlock, /\n  function fmt\(n\)\{.*\}\n/, 'fmt'),
  cut(guildBlock, /\n  function esc\(s\)\{[\s\S]*?\}\n/, 'esc'),
  cut(guildBlock, fnRe('noticeTitle'), 'noticeTitle'),
  cut(guildBlock, fnRe('noticeRowTitle'), 'noticeRowTitle'),
  cut(guildBlock, /\n {2}\/\/ --- The delivery notices[\s\S]*?(?=\n {2}\/\/ The player guild's UNREAD live notices)/, 'the trade lane'),
  cut(html, /\nwindow\.__outpostName = function\(id\)\{[\s\S]*?\n\};\n/, 'window.__outpostName'),
].join('\n');

const SYSTEM_NAME = 'HOME-SYS';   // what the shell's __systemName would resolve the anchor to

// Render every notice in `snapshot`'s g1 log through the page (through JSON first, as the browser gets it).
function render(snapshot) {
  const s = JSON.parse(JSON.stringify(snapshot));
  const window = {
    __snapshot: () => s,
    __systemName: (id) => (id === HOME.id ? SYSTEM_NAME : id),
  };
  const sandbox = { window, GAME: { galaxy: { outposts: [] } }, events: s.guilds.find((g) => g.id === 'g1').events };
  vm.runInNewContext(pageSrc + `
    var __out = events.map(function(n){
      var trade = isDeliveryNotice(n);
      return { id: n.id, type: n.type, trade: trade, row: noticeRowTitle(n), title: noticeTitle(n),
               paras: trade ? deliveryBody(n) : null, facts: trade ? deliveryFacts(n) : null };
    });`, sandbox);
  return JSON.parse(JSON.stringify(sandbox.__out));
}

// ---- the fixture: g1 holds a real starter system and owns two Outposts beside its waystation ----
const HOME = starterHomeAtDistance(6);
const WAY_HEX = nearestWaystation(HOME.id).outpost.coords;
const NEAR_A = { q: WAY_HEX.q + 1, r: WAY_HEX.r };   // outpost_g1_01: filled to 1,000 free
const NEAR_B = { q: WAY_HEX.q - 1, r: WAY_HEX.r };   // outpost_g1_02: torn down while a delivery flies

test('the fixture hexes are free, in-bounds hexes', () => {
  for (const h of [NEAR_A, NEAR_B]) {
    assert.ok(isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r), `${h.q},${h.r} is a bare hex`);
  }
});

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const buy = (state, lines, destinationOutpostId) => accept(
  lines.reduce((s, [good, qty]) => accept(s, createAddOrderLineAction({ guildId: 'g1', side: 'buy', good, qty })), state),
  createBuyFromSyndicateAction({ guildId: 'g1', destinationOutpostId }),
);

// The engine writes all three notices for real: a 2,000-titanium buy to an Outpost with 1,000 free (the
// warning, then the 'full' turn-back), and a two-good buy to an Outpost torn down in flight ('outpost-gone').
function engineNotices() {
  const outpost = (id, coords, stockpile) => ({
    id, ownerGuildId: 'g1', anchorSystemId: HOME.id, coords: { ...coords }, createdAtTick: 0, ...(stockpile ? { stockpile } : {}),
  });
  let s = createState({
    guilds: [{ id: 'g1', credits: 1000000, fuelHoard: GUILD_STARTING_FUEL, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet, outpostSerial: 2 }],
    outposts: [
      outpost('outpost_g1_01', NEAR_A, { titanium: OUTPOST_CAPACITY - 1000 }),
      outpost('outpost_g1_02', NEAR_B, null),
    ],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -1000000 },
    claims: [{ claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: HOME.id, landmarkKind: 'system', claimedAtTick: 0, contested: false }],
  });
  s.prices.titanium.posted = 12;
  s.prices.battery_cells.posted = 7;
  s = buy(s, [['titanium', 2000]], 'outpost_g1_01');
  s = buy(s, [['titanium', 300], ['battery_cells', 50]], 'outpost_g1_02');
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_02' }));
  // Both legs are one hex, so both deliveries land on the same tick.
  const arrivals = [...new Set(s.shipments.map((x) => x.arrivalTick))];
  assert.equal(arrivals.length, 1, 'fixture premise: both deliveries land together');
  s = tick({ ...s, tick: arrivals[0] - 1 }, []);
  assert.deepEqual(s.shipments, [], 'both deliveries were judged on arrival');
  return buildSnapshot(s);
}

const SNAP = engineNotices();
const EVENTS = SNAP.guilds.find((g) => g.id === 'g1').events;
const byType = (type, cause) => EVENTS.find((e) => e.type === type && (cause === undefined || e.payload.cause === cause));
const n = (v) => v.toLocaleString('en-US');

test('the engine wrote the three notices the client renders', () => {
  assert.deepEqual(EVENTS.map((e) => [e.type, e.payload.cause || null]).sort(), [
    ['delivery_space_warning', null],
    ['delivery_turned_back', 'full'],
    ['delivery_turned_back', 'outpost-gone'],
  ]);
});

test('the space warning: row, title, the Trader\'s three lines, and facts read from its payload', () => {
  const e = byType('delivery_space_warning');
  const out = render(SNAP).find((r) => r.id === e.id);
  assert.equal(out.row, `No room at the outpost &mdash; <span class="who">${SYSTEM_NAME} Outpost</span>`);
  assert.equal(out.title, 'No room at the outpost');
  assert.deepEqual(out.paras, [
    "Guildmaster, I just saw the manifest for your latest order from the Syndicate and I just need to let you know that we don't currently have enough space at the outpost.",
    "You'll have to tell me what you want to do with the units we have on hand, otherwise - if the Syndicate can't unload - they'll just turn back with everything with no refund.",
    'What would you like me to do?',
  ]);
  const p = e.payload;
  assert.deepEqual([p.units, p.space, p.freeSpace, p.shortfall], [2000, 2000, 1000, 1000], 'fixture premise');
  assert.deepEqual(out.facts, [
    ['Outpost', `${SYSTEM_NAME} Outpost`, false],
    ['Consignment', `1 good × ${n(p.units)} u · ${n(p.space)} space`, false],
    ['Room short', n(p.shortfall), false],
    ['Free space', n(p.freeSpace), false],
    ['Ordered', `Day ${e.whenDay}`, false],
  ]);
});

test('a turn-back for want of room: the Reason, the room it found, and the Trader\'s line for "full"', () => {
  const e = byType('delivery_turned_back', 'full');
  const out = render(SNAP).find((r) => r.id === e.id);
  assert.equal(out.row, `Delivery turned back &mdash; <span class="who">${SYSTEM_NAME} Outpost</span>`);
  assert.equal(out.title, 'Delivery turned back');
  assert.deepEqual(out.paras, [
    "Guildmaster — the Syndicate reached the outpost and there still wasn't room for your order, so they've turned back with the lot. No refund — the consignment's gone.",
  ]);
  const p = e.payload;
  assert.deepEqual(out.facts, [
    ['Outpost', `${SYSTEM_NAME} Outpost`, false],
    ['Consignment', `1 good × ${n(p.units)} u · ${n(p.space)} space`, false],
    ['Reason', 'No room', false],
    ['Room short', n(p.shortfall), false],
    ['Free space', n(p.freeSpace), false],
    ['Turned back', `Day ${e.whenDay}`, false],
  ]);
});

test('a turn-back for a gone Outpost: the resolver falls back to the raw id, no room figures, the "outpost-gone" line', () => {
  const e = byType('delivery_turned_back', 'outpost-gone');
  const out = render(SNAP).find((r) => r.id === e.id);
  assert.ok(!SNAP.outposts.some((o) => o.id === 'outpost_g1_02'), 'fixture premise: the Outpost is gone from the snapshot');
  assert.equal(out.row, 'Delivery turned back &mdash; <span class="who">outpost_g1_02</span>');
  assert.deepEqual(out.paras, [
    "Guildmaster — the Syndicate carried your order out to the outpost, but it wasn't there to receive it. They've turned back with the lot. No refund.",
  ]);
  const p = e.payload;
  assert.deepEqual(out.facts, [
    ['Outpost', 'outpost_g1_02', false],
    ['Consignment', `2 goods × ${n(p.units)} u · ${n(p.space)} space`, false],
    ['Reason', 'Outpost gone', false],
    ['Turned back', `Day ${e.whenDay}`, false],
  ]);
});

test('the facts are the payload\'s numbers as published — the client derives none of them', () => {
  // A payload whose numbers do not add up (as no engine row would) still renders each figure as given:
  // were any fact computed (space − shortfall, Σ cargo), it would show here.
  const snap = JSON.parse(JSON.stringify(SNAP));
  const e = snap.guilds.find((g) => g.id === 'g1').events.find((x) => x.type === 'delivery_space_warning');
  Object.assign(e.payload, { units: 11, space: 22, freeSpace: 7, shortfall: 5 });
  const facts = Object.fromEntries(render(snap).find((r) => r.id === e.id).facts.map(([k, v]) => [k, v]));
  assert.equal(facts['Consignment'], '1 good × 11 u · 22 space');
  assert.equal(facts['Free space'], '7');
  assert.equal(facts['Room short'], '5');
});

test('nothing rendered is an emoji, and only the two delivery types take the Trader\'s lane', () => {
  const out = render(SNAP);
  assert.ok(!/\p{Extended_Pictographic}/u.test(JSON.stringify(out)), 'emoji-free titles, facts and body');
  assert.ok(out.every((r) => r.trade), 'every notice in this log is a delivery notice');
  const sandbox = { window: {}, GAME: {} };
  vm.runInNewContext(pageSrc + `
    var __out = ['licence_lapsed', 'venture_closed', 'deploy_failed'].map(function(t){ return isDeliveryNotice({ type: t }); });`,
  sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__out)), [false, false, false], 'the other three keep their own voices');
});
