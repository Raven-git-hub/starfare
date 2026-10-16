'use strict';

// asset-recipes-final.test.js — the ten FINAL Tier-4 bills and their assembly times
// (docs/asset-recipes.md "Tier-4 asset bills (3→4 recipes) — FINAL", RULED 27-09-26; the tenth, the
// Prefecture, RULED 16-10-26), as carried by sim/asset-recipes.js.
//
// The tripwires:
//   - DOC ↔ CODE: every row of the doc's FINAL table is read from the doc itself and checked
//     against the code — each bill part for part and quantity for quantity, and each assembly
//     time against BUILD_TICKS. The doc is the authority (CLAUDE.md), so a drift on EITHER side
//     fails here, not in a playtest.
//   - BUILD_TICKS: the three new installation times are present, and the existing six did not
//     move.
//   - INSTALLATIONS: the outpost and the deep scan array are buildable and sellable (⤳ 15-10-26);
//     the Prefecture is buildable but NOT sellable — build-only (⤳ 16-10-26); the toll gate's bill is
//     still data only, with no build or buy path.
//   - AT REST: under the new bills and the 27-09-26 Tier-3 prices, every SELLABLE kind's parts
//     cost still sits below its purchase baseline, so a fresh galaxy's Syndicate buy prices are
//     unchanged. (The build-only kinds have no buy price to keep.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createState } = require('../state.js');
const {
  ASSET_BILLS, VEHICLE_BILLS, INSTALLATION_BILLS, ALL_BILLS, OUTPOST, DEEP_SCAN_ARRAY, TOLL_GATE, PREFECTURE,
  BUILD_TICKS, BUILDABLE_KINDS, SYNDICATE_SELLABLE_KINDS, INSTALLATION_KIT_BUY_BASELINE, kitKindForBill,
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
  Prefecture: PREFECTURE,
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

test('the doc\'s FINAL table has exactly the ten billed assets', () => {
  const names = readFinalTable().map((r) => r.name);
  assert.deepEqual(names.sort(), Object.keys(KIND_OF_ROW).sort());
});

test('each of the ten bills matches the doc exactly — every part and every quantity', () => {
  for (const { name, bill } of readFinalTable()) {
    const kind = KIND_OF_ROW[name];
    const inCode = ALL_BILLS[kind] || INSTALLATION_BILLS[kind];
    assert.ok(inCode, `${name} (${kind}) has a bill in sim/asset-recipes.js`);
    assert.deepEqual(inCode, bill, `${name}'s bill matches docs/asset-recipes.md`);
  }
});

test('each of the ten assembly times in the doc is BUILD_TICKS', () => {
  for (const { name, assemblyTicks } of readFinalTable()) {
    assert.equal(BUILD_TICKS[KIND_OF_ROW[name]], assemblyTicks, `${name}: the doc's assembly time is BUILD_TICKS`);
  }
});

test('the code carries exactly the ten bills, split across its three catalogs', () => {
  assert.deepEqual(Object.keys(ASSET_BILLS).sort(), [FACTORY, MINER].sort());
  assert.deepEqual(Object.keys(VEHICLE_BILLS).sort(), [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, HEAVY_TRANSPORT, SPYCRAFT].sort());
  assert.deepEqual(Object.keys(INSTALLATION_BILLS).sort(), [DEEP_SCAN_ARRAY, OUTPOST, PREFECTURE, TOLL_GATE].sort());
  // Every quantity a positive integer (§15.2: integer goods).
  for (const bill of [...Object.values(ALL_BILLS), ...Object.values(INSTALLATION_BILLS)]) {
    for (const [module, qty] of Object.entries(bill)) {
      assert.ok(Number.isInteger(qty) && qty > 0, `${module}: ${qty} is a positive integer`);
    }
  }
});

// --- 2. BUILD_TICKS -----------------------------------------------------------------------

test('BUILD_TICKS: the four installation times are present, and the existing six did not move', () => {
  // Typed ON PURPOSE (the ruled numbers), not derived from the doc like the test above.
  assert.equal(BUILD_TICKS[OUTPOST], 12960, 'outpost: 9 days');
  assert.equal(BUILD_TICKS[DEEP_SCAN_ARRAY], 10080, 'deep scan array: 7 days');
  assert.equal(BUILD_TICKS[TOLL_GATE], 8640, 'toll gate: 6 days');
  assert.equal(BUILD_TICKS[PREFECTURE], 20160, 'Prefecture: 14 days (RULED 16-10-26)');
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
    [PREFECTURE]: 20160,
  }, 'ten entries: the six existing values unchanged, plus the four installations');
});

// --- 3. two installations are buildable, the toll gate is still data only -------------------
// ⤳ 15-10-26 (docs/asset-purchase.md §"Installation kits"): this test used to pin all three as DATA
// ONLY. The ruling made the outpost and the deep scan array buildable AND sellable; the toll gate
// stays data only, because it has no entity and no kit.

test('installations: the outpost and the deep scan array are buildable and sellable; the toll gate is still DATA ONLY', () => {
  const s = createState({ guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  for (const kind of [OUTPOST, DEEP_SCAN_ARRAY]) {
    assert.equal(assetBill(kind), INSTALLATION_BILLS[kind], `${kind}: assetBill finds the doc's bill`);
    assert.equal(ALL_BILLS[kind], INSTALLATION_BILLS[kind], `${kind}: in the buildable catalog`);
    assert.equal(BUILDABLE_KINDS.includes(kind), true, `${kind}: a dockyard builds it`);
    assert.equal(SYNDICATE_SELLABLE_KINDS.includes(kind), true, `${kind}: the Syndicate sells it`);
    assert.equal(priceAssetForPurchase(s, kind, s.tick), assetPurchaseBaseline(kind), `${kind}: priced, at its baseline at rest`);
  }
  assert.equal(assetBill(TOLL_GATE), null, 'toll gate: assetBill finds no buildable bill');
  assert.equal(ALL_BILLS[TOLL_GATE], undefined, 'toll gate: not in the buildable catalog');
  assert.equal(BUILDABLE_KINDS.includes(TOLL_GATE), false, 'toll gate: a dockyard cannot build it');
  assert.equal(SYNDICATE_SELLABLE_KINDS.includes(TOLL_GATE), false, 'toll gate: the Syndicate does not sell it');
  assert.equal(priceAssetForPurchase(s, TOLL_GATE, s.tick), null, 'toll gate: cannot be priced for purchase');
  // The same Tier-3 tripwire covers all four bills (it also ran at load time).
  assert.doesNotThrow(() => assertBillModulesAreTier3(INSTALLATION_BILLS));
});

// ⤳ 16-10-26 (docs/asset-recipes.md, the Prefecture note; docs/territory-model.md §4): the Prefecture is the
// tenth billed asset and the second BUILD-ONLY kind — a dockyard builds it, the Syndicate never sells it.
test('the Prefecture: buildable (its bill, finishing as one idle prefecture kit), but NOT sellable — build-only, with no buy baseline', () => {
  assert.equal(assetBill(PREFECTURE), INSTALLATION_BILLS[PREFECTURE], 'assetBill finds the doc\'s bill');
  assert.equal(ALL_BILLS[PREFECTURE], INSTALLATION_BILLS[PREFECTURE], 'in the buildable catalog');
  assert.equal(BUILDABLE_KINDS.includes(PREFECTURE), true, 'a dockyard builds it');
  assert.equal(kitKindForBill(PREFECTURE), 'prefecture', 'a finished build mints one idle prefecture kit');
  assert.equal(SYNDICATE_SELLABLE_KINDS.includes(PREFECTURE), false, 'the Syndicate does NOT sell it');
  assert.equal(PREFECTURE in INSTALLATION_KIT_BUY_BASELINE, false, 'so it has no buy baseline');
  // It is the one bill that uses the two former orphans (design.md §19 #68).
  assert.equal(INSTALLATION_BILLS[PREFECTURE].claim_beacon, 2);
  assert.equal(INSTALLATION_BILLS[PREFECTURE].habitation_module, 2);
});

// --- 4. the seam with the Syndicate purchase price ------------------------------------------

test('at rest, every buildable kind\'s parts cost stays below its baseline, so its buy price is unchanged', () => {
  // A fresh galaxy prices every module at its base. Under the FINAL bills and the 27-09-26
  // Tier-3 prices, `round(partsCost × 0.8)` must still lose to the baseline for every kind,
  // so the purchase price at rest is exactly the baseline it was before this slice.
  // ⤳ 16-10-26: every buildable kind EXCEPT the Prefecture. It is build-only with no buy baseline (above), so it
  // has no buy price to keep; its parts at rest (5 deep_scan_mast alone are 100M) are far above the flat floor
  // assetPurchaseBaseline would fall back to, which is why a Prefecture buy must stay refused at the gate.
  const s = createState({ guilds: [], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  for (const kind of BUILDABLE_KINDS.filter((k) => k !== PREFECTURE)) {
    let partsCost = 0;
    for (const [module, qty] of Object.entries(ALL_BILLS[kind])) partsCost += qty * basePriceFor(module);
    assert.ok(partsCost * 0.8 < assetPurchaseBaseline(kind),
      `${kind}: parts at rest ${partsCost} × 0.8 stays below the baseline ${assetPurchaseBaseline(kind)}`);
    assert.equal(priceAssetForPurchase(s, kind, s.tick), assetPurchaseBaseline(kind), `${kind} costs its baseline at rest`);
  }
});
