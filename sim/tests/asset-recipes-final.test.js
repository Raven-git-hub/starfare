'use strict';

// asset-recipes-final.test.js — the nine FINAL Tier-4 bills and their assembly times
// (docs/asset-recipes.md "Tier-4 asset bills (3→4 recipes) — FINAL", RULED 27-09-26), as
// carried by sim/asset-recipes.js.
//
// The tripwires:
//   - DOC ↔ CODE: every row of the doc's FINAL table is read from the doc itself and checked
//     against the code — each bill part for part and quantity for quantity, and each assembly
//     time against BUILD_TICKS. The doc is the authority (CLAUDE.md), so a drift on EITHER side
//     fails here, not in a playtest.
//   - BUILD_TICKS: the three new installation times are present, and the existing six did not
//     move.
//   - DATA ONLY: the three installation bills have no build or buy path yet.
//   - AT REST: under the new bills and the 27-09-26 Tier-3 prices, every buildable kind's parts
//     cost still sits below its purchase baseline, so a fresh galaxy's Syndicate buy prices are
//     unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createState } = require('../state.js');
const {
  ASSET_BILLS, VEHICLE_BILLS, INSTALLATION_BILLS, ALL_BILLS, OUTPOST, DEEP_SCAN_ARRAY, TOLL_GATE,
  BUILD_TICKS, BUILDABLE_KINDS, SYNDICATE_SELLABLE_KINDS,
  assetBill, assertBillModulesAreTier3, priceAssetForPurchase, assetPurchaseBaseline,
} = require('../asset-recipes.js');
const { MINER, FACTORY } = require('../assets.js');
const { LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT } = require('../vehicles.js');
const { basePriceFor } = require('../prices.js');

const DOC = path.join(__dirname, '..', '..', 'docs', 'asset-recipes.md');
const TICKS_PER_HOUR = 60;   // 1 tick = 1 game-minute (docs/cycle-and-calendar.md)
const TICKS_PER_DAY = 1440;

// The doc's row names -> the code's kind constants. Typed here, once: the doc speaks English,
// the code speaks kinds.
const KIND_OF_ROW = {
  'Light transport': LIGHT_TRANSPORT,
  Miner: MINER,
  Factory: FACTORY,
  'Medium transport': MEDIUM_TRANSPORT,
  'Heavy transport': HEAVY_TRANSPORT,
  Spycraft: SPYCRAFT,
  'Deep Scan Array': DEEP_SCAN_ARRAY,
  'Toll Gate': TOLL_GATE,
  Outpost: OUTPOST,
};

// readFinalTable() -> [{ name, assemblyTicks, bill }] for every row of the doc's FINAL table
// that has a bill. Deliberately strict: anything it cannot read THROWS rather than being
// skipped, so a reformatted doc fails loudly instead of quietly testing fewer rows.
function readFinalTable() {
  const text = fs.readFileSync(DOC, 'utf8');
  const start = text.indexOf('## Tier-4 asset bills (3→4 recipes) — FINAL');
  assert.ok(start >= 0, 'the FINAL bills section exists in docs/asset-recipes.md');
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);

  const rows = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| **')) continue; // table body rows start with a bold asset name
    const cells = line.split('|').map((c) => c.trim());
    // cells: ['', name, assembly, bill, '']
    const name = cells[1].match(/^\*\*(.+?)\*\*/)[1];
    const assembly = cells[2];
    if (name === 'Droid') {
      // The one row with no bill (design-ahead, no entity yet) — nothing to check.
      assert.equal(assembly, '—', 'the Droid row has no assembly time');
      continue;
    }
    const time = assembly.match(/^(\d+) (h|d)$/);
    if (!time) throw new Error(`asset-recipes.md: cannot read the assembly time ${JSON.stringify(assembly)} of row ${name}`);
    const assemblyTicks = Number(time[1]) * (time[2] === 'h' ? TICKS_PER_HOUR : TICKS_PER_DAY);

    // Drop a trailing italic note like "*(build-only; not Syndicate-traded)*", then split the
    // bill into "N module" parts.
    const billText = cells[3].replace(/\*\(.*\)\*/, '').trim();
    const bill = {};
    for (const part of billText.split('·')) {
      const m = part.trim().match(/^(\d+) ([a-z_]+)$/);
      if (!m) throw new Error(`asset-recipes.md: cannot read the bill part ${JSON.stringify(part.trim())} of row ${name}`);
      assert.equal(bill[m[2]], undefined, `${name}: ${m[2]} is listed once`);
      bill[m[2]] = Number(m[1]);
    }
    rows.push({ name, assemblyTicks, bill });
  }
  return rows;
}

// --- 1. doc ↔ code ------------------------------------------------------------------------

test('the doc\'s FINAL table has exactly the nine billed assets', () => {
  const names = readFinalTable().map((r) => r.name);
  assert.deepEqual(names.sort(), Object.keys(KIND_OF_ROW).sort());
});

test('each of the nine bills matches the doc exactly — every part and every quantity', () => {
  for (const { name, bill } of readFinalTable()) {
    const kind = KIND_OF_ROW[name];
    const inCode = ALL_BILLS[kind] || INSTALLATION_BILLS[kind];
    assert.ok(inCode, `${name} (${kind}) has a bill in sim/asset-recipes.js`);
    assert.deepEqual(inCode, bill, `${name}'s bill matches docs/asset-recipes.md`);
  }
});

test('each of the nine assembly times in the doc is BUILD_TICKS', () => {
  for (const { name, assemblyTicks } of readFinalTable()) {
    assert.equal(BUILD_TICKS[KIND_OF_ROW[name]], assemblyTicks, `${name}: the doc's assembly time is BUILD_TICKS`);
  }
});

test('the code carries exactly the nine bills, split across its three catalogs', () => {
  assert.deepEqual(Object.keys(ASSET_BILLS).sort(), [FACTORY, MINER].sort());
  assert.deepEqual(Object.keys(VEHICLE_BILLS).sort(), [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT].sort());
  assert.deepEqual(Object.keys(INSTALLATION_BILLS).sort(), [DEEP_SCAN_ARRAY, OUTPOST, TOLL_GATE].sort());
  // Every quantity a positive integer (§15.2: integer goods).
  for (const bill of [...Object.values(ALL_BILLS), ...Object.values(INSTALLATION_BILLS)]) {
    for (const [module, qty] of Object.entries(bill)) {
      assert.ok(Number.isInteger(qty) && qty > 0, `${module}: ${qty} is a positive integer`);
    }
  }
});

// --- 2. BUILD_TICKS -----------------------------------------------------------------------

test('BUILD_TICKS: the three new installation times are present, and the existing six did not move', () => {
  // Typed ON PURPOSE (the ruled numbers), not derived from the doc like the test above.
  assert.equal(BUILD_TICKS[OUTPOST], 12960, 'outpost: 9 days');
  assert.equal(BUILD_TICKS[DEEP_SCAN_ARRAY], 10080, 'deep scan array: 7 days');
  assert.equal(BUILD_TICKS[TOLL_GATE], 8640, 'toll gate: 6 days');
  assert.deepEqual(BUILD_TICKS, {
    [MINER]: 720,
    [FACTORY]: 960,
    [LIGHT_TRANSPORT]: 360,
    [MEDIUM_TRANSPORT]: 960,
    [HEAVY_TRANSPORT]: 10080,
    [SPYCRAFT]: 10080,
    [OUTPOST]: 12960,
    [DEEP_SCAN_ARRAY]: 10080,
    [TOLL_GATE]: 8640,
  }, 'nine entries: the six existing values unchanged, plus the three new ones');
});

// --- 3. the installations are data only ---------------------------------------------------

test('the three installation bills are DATA ONLY: no build path, no buy path, no bill lookup', () => {
  for (const kind of [OUTPOST, DEEP_SCAN_ARRAY, TOLL_GATE]) {
    assert.equal(assetBill(kind), null, `${kind}: assetBill finds no buildable bill`);
    assert.equal(BUILDABLE_KINDS.includes(kind), false, `${kind}: a dockyard cannot build it`);
    assert.equal(SYNDICATE_SELLABLE_KINDS.includes(kind), false, `${kind}: the Syndicate does not sell it`);
    assert.equal(ALL_BILLS[kind], undefined, `${kind}: not in the buildable catalog`);
  }
  const s = createState({ guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  assert.equal(priceAssetForPurchase(s, OUTPOST, s.tick), null, 'an installation cannot be priced for purchase');
  // …but the same Tier-3 tripwire covers their bills (it also ran at load time).
  assert.doesNotThrow(() => assertBillModulesAreTier3(INSTALLATION_BILLS));
});

// --- 4. the seam with the Syndicate purchase price ------------------------------------------

test('at rest, every buildable kind\'s parts cost stays below its baseline, so its buy price is unchanged', () => {
  // A fresh galaxy prices every module at its base. Under the FINAL bills and the 27-09-26
  // Tier-3 prices, `round(partsCost × 0.8)` must still lose to the baseline for every kind,
  // so the purchase price at rest is exactly the baseline it was before this slice.
  const s = createState({ guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  for (const kind of BUILDABLE_KINDS) {
    let partsCost = 0;
    for (const [module, qty] of Object.entries(ALL_BILLS[kind])) partsCost += qty * basePriceFor(module);
    assert.ok(partsCost * 0.8 < assetPurchaseBaseline(kind),
      `${kind}: parts at rest ${partsCost} × 0.8 stays below the baseline ${assetPurchaseBaseline(kind)}`);
    assert.equal(priceAssetForPurchase(s, kind, s.tick), assetPurchaseBaseline(kind), `${kind} costs its baseline at rest`);
  }
});
