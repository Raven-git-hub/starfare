'use strict';

// node-sell-preview.test.js — the node SELL popup's preview (docs/syndicate-orders.md §9.2; roadmap 2.2,
// trading to/from outposts client slice 2). SELL is started at the node, and the player picks
// quantities from the node's own pile BEFORE any order exists in the engine — the popup posts nothing
// until confirm. So for the preview the client sizes the would-be order itself: Σ qty × goodVolumes[good],
// mapped to the smallest `haulerTiers` hold it fits. That tier picks the route fuel the ledger shows,
// and the fuel / over-capacity gates on the confirm. It must therefore be the tier the ENGINE uses for
// the same lines, or the popup quotes one leg and the engine burns another.
//
// Like constructed-building-head.test.js, this RUNS the page's own source (node:vm, a stub DOM-free
// sandbox) against a real snapshot, and compares it with the engine:
//   - at every hauler-tier boundary (space = hold, and hold + 1), the preview's tier, space and overCap
//     equal `haulerTierForSpace` / Σ qty × volumeOf;
//   - for a real multi-good order built with the engine's own actions, the preview equals the engine's
//     snapshot echo of that order (`sellOrder.totalSpace` / `haulerTier` / `overCap`) line for line;
//   - a pick above what the node holds is capped at the pile, and only the node's own pile counts (a
//     system's pool, or an Outpost's `stockpile`) — sellable goods only;
//   - an empty node offers no SELL.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { volumeOf, haulerTierForSpace, HAULER_TIERS, GUILD_STARTING_FUEL } = require('../fuel.js');
const { validateAction, applyAction, createAddOrderLineAction } = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

// ---- the page's own node-SELL code, cut out of the TRADE script ----
const tradeBlock = html.slice(html.indexOf('<script id="trade-tab-wire">'), html.indexOf('<script id="deuterium-tab-wire">'));
function cut(re, what) {
  const m = tradeBlock.match(re);
  assert.ok(m, `${what} is present in the TRADE script`);
  return m[0];
}
const fnRe = (name) => new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n');
const pageSrc = [
  cut(/\n  var HIDDEN_GOODS = \{[^}]*\};/, 'HIDDEN_GOODS'),
  cut(fnRe('priceOf'), 'priceOf'),
  cut(fnRe('txRoute'), 'txRoute'),
  cut(fnRe('nodeStock'), 'nodeStock'),
  cut(/\n  function nodeSellable\(node\)\{[^\n]*\}\n/, 'nodeSellable'),
  cut(fnRe('nodeOrder'), 'nodeOrder'),
].join('\n');

// Run the page's preview for `node` with the player's `pick` against `snapshot` (through JSON first,
// exactly as the browser receives it from GET /snapshot).
function preview(snapshot, node, pick) {
  const s = JSON.parse(JSON.stringify(snapshot));
  const sandbox = {
    TX: { node, pick },
    snap: () => s,
    meGuild: () => s.guilds.find((g) => g.id === 'g1') || null,
  };
  vm.runInNewContext(pageSrc + '\nvar __out = { order: nodeOrder(), stock: nodeStock(TX.node), sellable: nodeSellable(TX.node) };', sandbox);
  return JSON.parse(JSON.stringify(sandbox.__out));
}

// ---- the fixture: g1 holds a real starter system and owns one Outpost ----
const HOME = starterHomeAtDistance(6);
const T1 = 'titanium';        // volume 1 — lands exactly on any boundary
const T2 = 'battery_cells';   // volume 100
const LAST_HOLD = HAULER_TIERS[HAULER_TIERS.length - 1].hold;
function nodeState({ homeStock, outpostStock } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 1000, fuelHoard: GUILD_STARTING_FUEL, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet,
      outpostSerial: 1,
      ...(homeStock ? { stockpiles: { [HOME.id]: { ...homeStock } } } : {}),
    }],
    outposts: [{
      id: 'outpost_g1_01', ownerGuildId: 'g1', anchorSystemId: HOME.id, coords: { ...HOME.coords }, createdAtTick: 0,
      ...(outpostStock ? { stockpile: { ...outpostStock } } : {}),
    }],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -1000 },
    claims: [{ claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: HOME.id, landmarkKind: 'system', claimedAtTick: 0, contested: false }],
  });
  return s;
}
// The Outpost sits on the home system's own hex here only to be a valid node; its leg is not under test.
const SYSTEM = { kind: 'system', id: HOME.id };
const OUTPOST = { kind: 'outpost', id: 'outpost_g1_01' };

test('the preview sizes the tier exactly as the engine does, at every hauler-tier boundary', () => {
  const snap = buildSnapshot(nodeState({ homeStock: { [T1]: LAST_HOLD + 1 } }));
  for (const { hold } of HAULER_TIERS) {
    for (const qty of [hold, hold + 1]) {
      const { order } = preview(snap, SYSTEM, { [T1]: qty });
      const space = qty * volumeOf(T1);
      const engineTier = haulerTierForSpace(space);
      assert.equal(order.totalSpace, space, `space for ${qty} ${T1}`);
      assert.equal(order.haulerTier, engineTier, `tier for space ${space}: page ${order.haulerTier}, engine ${engineTier}`);
      assert.equal(order.overCap, engineTier === null, `overCap for space ${space}`);
    }
  }
});

test('the preview equals the engine\'s own echo of the same order, built with the engine\'s actions', () => {
  const cases = [
    { [T1]: 300, [T2]: 50 },
    { [T1]: 9_999, [T2]: 1 },
    { [T2]: 60_000 },
    { [T1]: LAST_HOLD, [T2]: 1 },   // one battery cell over the heaviest hold
  ];
  for (const pick of cases) {
    const state = nodeState({ homeStock: { [T1]: LAST_HOLD + 1, [T2]: 100_000 } });
    const { order } = preview(buildSnapshot(state), SYSTEM, pick);
    let live = state;
    for (const good of Object.keys(pick)) {
      const action = createAddOrderLineAction({ guildId: 'g1', side: 'sell', good, qty: pick[good] });
      assert.equal(validateAction(live, action).valid, true);
      live = applyAction(live, action);
    }
    const echo = buildSnapshot(live).guilds.find((g) => g.id === 'g1').sellOrder;
    assert.deepEqual(order.lines, echo.lines, `lines for ${JSON.stringify(pick)}`);
    assert.equal(order.totalUnits, echo.totalUnits);
    assert.equal(order.totalSpace, echo.totalSpace);
    assert.equal(order.haulerTier, echo.haulerTier, `tier for ${JSON.stringify(pick)}`);
    assert.equal(order.overCap, echo.overCap);
  }
});

test('the pile is the node\'s own, sellable goods only, and a pick is capped at what the node holds', () => {
  const snap = buildSnapshot(nodeState({
    homeStock: { [T1]: 500, deuterium: 40 },
    outpostStock: { [T1]: 70, [T2]: 3 },
  }));
  // A system sells from its own pool; deuterium is untradeable (the TRADE tab's HIDDEN_GOODS), so it
  // is not offered even though the engine prices it.
  const sys = preview(snap, SYSTEM, { [T1]: 9_999 });
  assert.deepEqual(sys.stock, { [T1]: 500 });
  assert.deepEqual(sys.order.lines, [{ good: T1, qty: 500, space: 500 * volumeOf(T1) }], 'the pick is capped at the pool');
  // An Outpost sells from its own stockpile, never the system pool.
  const out = preview(snap, OUTPOST, { [T1]: 70, [T2]: 3 });
  assert.deepEqual(out.stock, { [T2]: 3, [T1]: 70 });
  assert.equal(out.order.totalSpace, 70 * volumeOf(T1) + 3 * volumeOf(T2));
  // A node the guild does not hold has nothing to sell.
  const stranger = preview(snap, { kind: 'outpost', id: 'outpost_nobody_01' }, { [T1]: 1 });
  assert.deepEqual(stranger.stock, {});
  assert.equal(stranger.sellable, false);
});

test('an empty node offers no SELL', () => {
  const snap = buildSnapshot(nodeState({}));
  assert.equal(preview(snap, SYSTEM, {}).sellable, false, 'an empty system pool');
  assert.equal(preview(snap, OUTPOST, {}).sellable, false, 'an empty Outpost');
  const stocked = buildSnapshot(nodeState({ homeStock: { [T1]: 1 }, outpostStock: { [T2]: 1 } }));
  assert.equal(preview(stocked, SYSTEM, {}).sellable, true);
  assert.equal(preview(stocked, OUTPOST, {}).sellable, true);
});
