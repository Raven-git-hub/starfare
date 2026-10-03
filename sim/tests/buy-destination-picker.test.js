'use strict';

// buy-destination-picker.test.js — the BUY finalise's "Deliver to" picker (docs/syndicate-orders.md
// §9.1; roadmap 2.2, trading to/from outposts client slice 3a). The picker lists every node the guild
// holds — its held systems (`fuelCost`'s keys) and its own Outposts (`outpostFuelCost`'s keys) — and
// opens on the node NEAREST a waystation, with a tie going to the lower node id. The client chooses
// that default by taking the smallest PUBLISHED leg (`travelTicks`) — it measures nothing itself (§18).
// So the choice must match the engine's own geometry, or the popup would default to a node the engine
// does not consider nearest.
//
// Like node-sell-preview.test.js, this RUNS the page's own source (node:vm, a DOM-free sandbox) against
// a real snapshot, and compares it with the engine:
//   - the list holds every held node, each with its kind, in one ordering by node id;
//   - the default is the node with the smallest `nearestWaystationToHex(hex).distance`, judged by the
//     engine, whatever its place in the list;
//   - a tie goes to the lower node id, an Outpost against a system and an Outpost against an Outpost;
//   - a guild with no Outpost lists only its systems, and one that holds nothing has no default.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { nearestWaystation, nearestWaystationToHex, systemHex } = require('../transport.js');
const { starterHomeAtDistance, farthestSystem } = require('./waystation-fixtures.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'game.html'), 'utf8');

// ---- the page's own picker code, cut out of the TRADE script ----
const tradeBlock = html.slice(html.indexOf('<script id="trade-tab-wire">'), html.indexOf('<script id="deuterium-tab-wire">'));
function cut(re, what) {
  const m = tradeBlock.match(re);
  assert.ok(m, `${what} is present in the TRADE script`);
  return m[0];
}
const fnRe = (name) => new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n');
const pageSrc = [
  cut(fnRe('txRoute'), 'txRoute'),
  cut(fnRe('txHeldNodes'), 'txHeldNodes'),
  cut(fnRe('txNearestNode'), 'txNearestNode'),
].join('\n');

// Run the page's picker against `snapshot` (through JSON first, exactly as the browser receives it).
function picker(snapshot) {
  const s = JSON.parse(JSON.stringify(snapshot));
  const sandbox = { meGuild: () => s.guilds.find((g) => g.id === 'g1') || null };
  vm.runInNewContext(pageSrc + '\nvar __out = { nodes: txHeldNodes(), nearest: txNearestNode() };', sandbox);
  return JSON.parse(JSON.stringify(sandbox.__out));
}

// ---- the fixture: g1 holds a real starter system (leg 6) and owns the Outposts it is given ----
const HOME = starterHomeAtDistance(6);
const HOME_HEX = systemHex(HOME.id);
const WAY_HEX = nearestWaystation(HOME.id).outpost.coords;
// Two hexes beside the home's waystation (leg 1 each), and the far system's centre hex (the longest leg).
const NEAR_A = { q: WAY_HEX.q + 1, r: WAY_HEX.r };
const NEAR_B = { q: WAY_HEX.q - 1, r: WAY_HEX.r };
const FAR = systemHex(farthestSystem().id);

function pickerState({ outposts = [], holdsHome = true } = {}) {
  return createState({
    guilds: [{
      id: 'g1', credits: 1000, fuelHoard: GUILD_STARTING_FUEL, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet,
      outpostSerial: outposts.length,
    }],
    outposts: outposts.map(({ id, coords }) => ({
      id, ownerGuildId: 'g1', anchorSystemId: HOME.id, coords: { ...coords }, createdAtTick: 0,
    })),
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -1000 },
    claims: holdsHome
      ? [{ claimId: 'claim_home_g1', ownerGuildId: 'g1', landmarkId: HOME.id, landmarkKind: 'system', claimedAtTick: 0, contested: false }]
      : [],
  });
}

// The ENGINE's answer: each held node's nearest-waystation distance, the smallest winning and a tie
// going to the lower id. Measured from the hexes, never from the snapshot the page reads.
function engineNearest(nodes) {
  let best = null;
  for (const n of [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const d = nearestWaystationToHex(n.hex).distance;
    if (best === null || d < best.d) best = { id: n.id, d };
  }
  return best && best.id;
}

test('the fixture hexes sit at the legs the cases rely on', () => {
  assert.equal(nearestWaystationToHex(HOME_HEX).distance, 6);
  assert.equal(nearestWaystationToHex(NEAR_A).distance, 1);
  assert.equal(nearestWaystationToHex(NEAR_B).distance, 1);
  assert.ok(nearestWaystationToHex(FAR).distance > 6, 'the far system is farther than home');
});

test('the picker lists every held node — systems and Outposts — in one ordering by node id', () => {
  const outposts = [
    { id: 'outpost_g1_02', coords: NEAR_A },
    { id: 'outpost_g1_01', coords: FAR },
  ];
  const { nodes } = picker(buildSnapshot(pickerState({ outposts })));
  assert.deepEqual(nodes, [
    { kind: 'outpost', id: 'outpost_g1_01' },
    { kind: 'outpost', id: 'outpost_g1_02' },
    { kind: 'system', id: HOME.id },
  ]);
});

test('the default is the node nearest a waystation, as the engine measures it, wherever it sits in the list', () => {
  const cases = [
    // The near Outpost is neither first nor last in id order.
    [{ id: 'outpost_g1_01', coords: FAR }, { id: 'outpost_g1_02', coords: NEAR_A }, { id: 'outpost_g1_03', coords: HOME_HEX }],
    // Every Outpost is farther than the home system: the default stays the system.
    [{ id: 'outpost_g1_01', coords: FAR }],
    // The near Outpost is the only Outpost.
    [{ id: 'outpost_g1_01', coords: NEAR_A }],
  ];
  for (const outposts of cases) {
    const { nearest } = picker(buildSnapshot(pickerState({ outposts })));
    const expected = engineNearest([{ id: HOME.id, hex: HOME_HEX }, ...outposts.map((o) => ({ id: o.id, hex: o.coords }))]);
    assert.equal(nearest.id, expected, `outposts ${JSON.stringify(outposts.map((o) => o.id))}`);
  }
  // Spelled out for the first case: the near Outpost, not the lowest id and not the home system.
  const { nearest } = picker(buildSnapshot(pickerState({ outposts: cases[0] })));
  assert.deepEqual(nearest, { kind: 'outpost', id: 'outpost_g1_02' });
});

test('a tie goes to the lower node id — an Outpost against a system, and an Outpost against an Outpost', () => {
  // An Outpost on the home system's own hex has the same leg as the system; its id sorts lower.
  const sameAsHome = picker(buildSnapshot(pickerState({ outposts: [{ id: 'outpost_g1_01', coords: HOME_HEX }] })));
  assert.deepEqual(sameAsHome.nearest, { kind: 'outpost', id: 'outpost_g1_01' });
  // Two Outposts one hex from the same waystation: the lower id wins, whichever hex it is on.
  for (const [low, high] of [[NEAR_A, NEAR_B], [NEAR_B, NEAR_A]]) {
    const outposts = [{ id: 'outpost_g1_04', coords: high }, { id: 'outpost_g1_03', coords: low }];
    const { nearest } = picker(buildSnapshot(pickerState({ outposts })));
    assert.deepEqual(nearest, { kind: 'outpost', id: 'outpost_g1_03' });
  }
});

test('a guild with no Outpost lists only its systems; a guild that holds no node has no default', () => {
  const systemsOnly = picker(buildSnapshot(pickerState()));
  assert.deepEqual(systemsOnly.nodes, [{ kind: 'system', id: HOME.id }]);
  assert.deepEqual(systemsOnly.nearest, { kind: 'system', id: HOME.id });
  const none = picker(buildSnapshot(pickerState({ holdsHome: false })));
  assert.deepEqual(none.nodes, []);
  assert.equal(none.nearest, null);
});
