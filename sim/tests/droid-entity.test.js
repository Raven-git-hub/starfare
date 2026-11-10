'use strict';

// droid-entity.test.js — roadmap 2.6, droid engine slice 2: the droid ENTITY and the GUILD dockyard build
// (docs/droids.md §1 and the guild half of §3; the bill and BUILD_TICKS from docs/phase-1-tuning.md §Droids).
//
// A droid built here just sits idle and does nothing — no assignment, boost, decay or maintenance, and no
// Syndicate buy. Those are later slices. The tripwires:
//
//   1. THE ROW: createDroid assembles { id, systemId, source, condition }; createGuild carries `droids` and
//      `droidSerial` from a scenario or save, and OMITS both when empty.
//   2. NO-OP BYTE-IDENTICAL: two droidless runs hash exactly as they did at fb550f7, before this slice.
//   3. THE BUILD: a dockyard droid build consumes the bill on its start tick, counts down 360, and mints
//      exactly ONE idle guild-source droid at the dockyard's system, condition new, id from droidSerial —
//      and nothing else (no asset, no vehicle, no kit). One part short, it waits and consumes nothing.
//   4. IDS NEVER REPEAT: a second build takes the next serial; a droid that leaves the collection never has
//      its number handed out again; mintDroid halts on a corrupted serial.
//   5. THE INVARIANT: checkDroids bites on each bad shape, naming the guild and the value.
//   6. THE GATES: a commission of a droid is accepted; (⤳ slice 3) a Syndicate buy mints a Syndicate-source one.
//   7. CONSERVATION (invariant 2): exactly the bill leaves the yard's pool and Galactic Supply; no credit
//      or fuel moves.
//   8. SNAPSHOT: the owner sees its droids; a droidless guild's row has no key; a rival never sees them.
//   9. DETERMINISM (invariant 9): two runs byte-identical; a save mid-build and after the mint restores
//      byte-identically and runs on identically.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGuild, createDroid } = require('../state.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { fogForGuild } = require('../fog.js');
const { checkInvariants, checkDroids } = require('../invariants.js');
const { ASSET_CONDITION_NEW } = require('../assets.js');
const { DROID, DROID_SOURCES, droidId, nextDroidSerial, mintDroid } = require('../droids.js');
const { DROID_BILLS, BUILD_TICKS } = require('../asset-recipes.js');
const { createCommissionBuildAction, createBuyAssetFromSyndicateAction, createBuyDroidBatchAction } = require('../actions.js');
const {
  HOME, YARD, kitGalaxy, accept, refuse, ticks, tickUntil, g1Of, yardOf,
} = require('./installation-kit-fixtures.js');
const { yardScript, foundingScript } = require('./droid-noop-script.js');

const DROID_BILL = DROID_BILLS[DROID];
const commission = () => createCommissionBuildAction({ guildId: 'g1', ventureId: YARD, assetKind: DROID });
const droidsOf = (s) => g1Of(s).droids || [];
const pool = (s) => g1Of(s).stockpiles[HOME.id];

// `n` whole droid bills, ready in the yard's pool.
function bills(n) {
  const stock = {};
  for (const [good, qty] of Object.entries(DROID_BILL)) stock[good] = qty * n;
  return stock;
}

// --- 1. the row --------------------------------------------------------------------------------------------

test('createDroid assembles exactly { id, systemId, source, condition }, condition new by default', () => {
  const d = createDroid({ id: 'asset_g1_droid_01', systemId: 'sys_x', source: 'guild' });
  assert.deepEqual(d, { id: 'asset_g1_droid_01', systemId: 'sys_x', source: 'guild', condition: ASSET_CONDITION_NEW });
  // The assignment fields (slice 3) are omitted on an idle droid, so this row is unchanged.
  assert.equal('assignedToVentureId' in d, false);
  assert.equal('deployedAtTick' in d, false);
  // Required, never defaulted: a guessed source or location would be an invented fact.
  assert.throws(() => createDroid({ systemId: 'sys_x', source: 'guild' }), /createDroid: id is required/);
  assert.throws(() => createDroid({ id: 'd', source: 'guild' }), /createDroid: systemId is required/);
  assert.throws(() => createDroid({ id: 'd', systemId: 'sys_x' }), /createDroid: source is required/);
});

test('createGuild omits droids and droidSerial when empty, and deep-copies them when handed in', () => {
  const bare = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  assert.equal('droids' in bare, false, 'no droids key on a droidless guild');
  assert.equal('droidSerial' in bare, false, 'no droidSerial key at 0');
  assert.equal('droids' in createGuild({ id: 'g1', credits: 0, fuelHoard: 0, droids: [] }), false, 'an empty list is omitted too');

  const row = { id: 'asset_g1_droid_01', systemId: 'sys_x', source: 'guild', condition: 1 };
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0, droids: [row], droidSerial: 1 });
  assert.deepEqual(g.droids, [row]);
  assert.equal(g.droidSerial, 1);
  row.systemId = 'mutated';
  assert.equal(g.droids[0].systemId, 'sys_x', 'the caller\'s row does not alias into the guild');
});

// --- 2. no-op byte-identical ------------------------------------------------------------------------------

// RECORDED AT fb550f7 (main, before this slice's code existed) by running these exact two scripts
// (droid-noop-script.js). A galaxy that builds no droid must not move by a byte.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
const YARD_SCRIPT_GOLDEN_FB550F7 = '797faf169e2d95842d71ef0e41e44e045637e35da4b10e238e0e4300ab835879';
const FOUNDING_SCRIPT_GOLDEN_FB550F7 = '954c2facaf70086b024635cb149c550c196cf24a687378c4a43c6400347225b9';

test('no-op: a droidless dockyard run (a light transport, then a miner) is byte-identical to fb550f7', () => {
  const s = yardScript();
  // The run really did build both, through the two mintFinishedKind branches the droid branch sits beside.
  assert.deepEqual(g1Of(s).vehicles.map((v) => v.id), ['vehicle_g1_heavyTransport_01', 'vehicle_g1_lightTransport_02']);
  assert.deepEqual(g1Of(s).assets.map((a) => a.id), ['asset_g1_miner_01']);
  for (const g of s.guilds) {
    assert.equal('droids' in g, false, `${g.id}: no droids key`);
    assert.equal('droidSerial' in g, false, `${g.id}: no droidSerial key`);
  }
  assert.equal(hashState(s), YARD_SCRIPT_GOLDEN_FB550F7);
});

test('no-op: a founded human guild, ticked 200, is byte-identical to fb550f7', () => {
  assert.equal(hashState(foundingScript()), FOUNDING_SCRIPT_GOLDEN_FB550F7);
});

// --- 3. the build -----------------------------------------------------------------------------------------

test('build: one droid bill → consumed on the start tick, 360 ticks later exactly ONE idle guild droid at the yard\'s system', () => {
  let s = kitGalaxy({ stock: bills(1) });
  s = accept(s, commission());
  assert.equal(yardOf(s).buildQueue[0].assetKind, DROID, 'the queue entry carries the bill kind');

  s = ticks(s, 1); // the start tick: the whole bill is consumed and the clock set, not yet decremented
  const startTick = s.tick;
  assert.equal(yardOf(s).buildQueue[0].remainingTicks, BUILD_TICKS[DROID]);
  assert.equal(BUILD_TICKS[DROID], 360, 'phase-1-tuning §Droids: 6 hours');
  for (const good of Object.keys(DROID_BILL)) assert.equal(pool(s)[good], 0, `${good}: the bill is consumed`);

  s = ticks(s, 359);
  assert.deepEqual(droidsOf(s), [], 'one tick short: nothing minted yet');
  s = ticks(s, 1);
  assert.equal(s.tick, startTick + 360, 'emission lands exactly BUILD_TICKS after the consume tick');

  const g = g1Of(s);
  // Stamped with the tick the dockyard step ran on (the pre-increment tick every tick-step stamp uses, as the
  // yard venture's own updatedAtTick does) — droid engine slice 4, §15.2.
  assert.deepEqual(g.droids, [{ id: 'asset_g1_droid_01', systemId: HOME.id, source: 'guild', condition: ASSET_CONDITION_NEW, updatedAtTick: s.tick - 1 }]);
  assert.equal(yardOf(s).updatedAtTick, s.tick - 1);
  assert.equal(g.droidSerial, 1);
  assert.deepEqual(yardOf(s).buildQueue, [], 'the head shifted off the queue');
  // NOT a kit, NOT an asset, NOT a vehicle: the only other entity is the fixture's own heavy.
  assert.equal(g.assets, undefined, 'no asset (and so no kit) was minted');
  assert.equal('kitAssetSerial' in g, false, 'the kit serial was never touched');
  assert.deepEqual(g.vehicles.map((v) => v.id), ['vehicle_g1_heavyTransport_01'], 'no vehicle was minted');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('build: a droid head ONE part short waits, consumes nothing, and starts the tick the part arrives', () => {
  let s = kitGalaxy({ stock: { ...bills(1), drive_module: 0 } });
  s = accept(s, commission());
  const before = structuredClone(pool(s));
  s = ticks(s, 50);
  assert.equal(yardOf(s).buildQueue[0].remainingTicks, null, 'not started');
  assert.deepEqual(pool(s), before, 'nothing consumed — no reservation, no partial take');
  assert.deepEqual(droidsOf(s), []);
});

// --- 4. ids never repeat ----------------------------------------------------------------------------------

test('ids: a second droid build takes the next serial', () => {
  let s = kitGalaxy({ stock: bills(2) });
  s = accept(s, commission());
  s = accept(s, commission());
  s = ticks(s, 2 * (1 + 360)); // two builds, each a start tick plus its countdown, back to back
  assert.deepEqual(droidsOf(s).map((d) => d.id), ['asset_g1_droid_01', 'asset_g1_droid_02']);
  assert.equal(g1Of(s).droidSerial, 2);
  assert.ok(droidsOf(s).every((d) => d.source === 'guild' && d.systemId === HOME.id));
});

test('ids: a droid that leaves the collection never has its number reissued (the stored droidSerial)', () => {
  // No path removes a droid in this slice — spending one at end of life is the decay slice. Remove it by hand
  // to prove the counter, not the live list, decides the next number.
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  mintDroid(g, 'guild', 'sys_x', 0);
  mintDroid(g, 'guild', 'sys_x', 0);
  g.droids = g.droids.filter((d) => d.id !== 'asset_g1_droid_02'); // the TOP number leaves
  assert.equal(nextDroidSerial(g), 3, 'the counter remembers 2');
  assert.equal(mintDroid(g, 'guild', 'sys_x', 0).id, 'asset_g1_droid_03', 'never 02 again');
  assert.deepEqual(g.droids.map((d) => d.id), ['asset_g1_droid_01', 'asset_g1_droid_03']);
  assert.deepEqual(checkDroids({ guilds: [g] }), []);
});

test('ids: mintDroid HALTS on a corrupted serial rather than share an id', () => {
  const g = createGuild({ id: 'g1', credits: 0, fuelHoard: 0 });
  mintDroid(g, 'guild', 'sys_x', 0);
  g.droidSerial = 0; // corrupted: the next mint would rebuild 01
  assert.throws(() => mintDroid(g, 'guild', 'sys_x', 0), /guild g1 minted duplicate droid id asset_g1_droid_01 — droidSerial corrupted/);
});

// --- 5. the invariant -------------------------------------------------------------------------------------

test('checkDroids bites on every bad shape, naming the guild and the offending value', () => {
  const good = () => ({ id: 'asset_g1_droid_01', systemId: 'sys_x', source: 'guild', condition: 1 });
  const run = (droid, extra = {}) => checkDroids({ guilds: [{ id: 'g1', droids: [droid], droidSerial: 1, ...extra }] });
  const rules = (vs) => vs.map((v) => v.rule);

  assert.deepEqual(run(good()), [], 'a well-formed guild droid passes');
  assert.deepEqual(run({ ...good(), source: 'syndicate' }), [], 'both ruled sources are known');
  assert.deepEqual([...DROID_SOURCES].sort(), ['guild', 'syndicate']);
  assert.deepEqual(run({ ...good(), condition: 0 }), [], 'condition 0 is in range');

  const bad = run({ ...good(), source: 'black-market' });
  assert.deepEqual(rules(bad), ['droid-source-known']);
  assert.equal(bad[0].where, 'guild:g1.droid:asset_g1_droid_01.source');
  assert.equal(bad[0].detail.source, 'black-market');

  assert.deepEqual(rules(run({ ...good(), systemId: '' })), ['droid-system-present']);
  assert.deepEqual(rules(run({ ...good(), systemId: undefined })), ['droid-system-present']);
  for (const condition of [1.5, -0.1, NaN, Infinity, '1', undefined]) {
    const v = run({ ...good(), condition });
    assert.deepEqual(rules(v), ['droid-condition-in-range'], `condition ${String(condition)}`);
    assert.deepEqual(v[0].detail.condition, condition);
  }
  // The id must rebuild from THIS guild and its own number.
  const moved = run({ ...good(), id: 'asset_g2_droid_01' });
  assert.deepEqual(rules(moved), ['droid-id-names-its-owner (design.md §15.4)']);
  assert.equal(moved[0].detail.expected, 'asset_g1_droid_01');
  assert.deepEqual(rules(run({ ...good(), id: 'asset_g1_miner_01' })), ['droid-id-names-its-owner (design.md §15.4)']);
  assert.deepEqual(rules(run({ ...good(), id: 'asset_g1_droid' })), ['droid-id-names-its-owner (design.md §15.4)']);

  // Duplicate ids.
  const dup = checkDroids({ guilds: [{ id: 'g1', droids: [good(), good()], droidSerial: 1 }] });
  assert.deepEqual(rules(dup), ['droid-id-unique (design.md §15.4)']);

  // The serial: a live droid above it (the kit-asset-serial-monotonic sibling), or a bad value.
  const behind = run({ ...good(), id: droidId('g1', 4) }, { droidSerial: 3 });
  assert.deepEqual(rules(behind), ['droid-serial-monotonic (design.md §15.4)']);
  assert.deepEqual(behind[0].detail, { droidSerial: 3, highestLiveDroidNumber: 4 });
  assert.deepEqual(rules(run(good(), { droidSerial: undefined })), ['droid-serial-monotonic (design.md §15.4)']);
  assert.deepEqual(rules(run(good(), { droidSerial: 1.5 })), ['droid-serial-valid'], 'not a whole number');
  assert.deepEqual(rules(checkDroids({ guilds: [{ id: 'g1', droidSerial: 0 }] })), ['droid-serial-valid'], 'stored 0 (it is omitted at 0)');
  assert.deepEqual(rules(checkDroids({ guilds: [{ id: 'g1', droids: {} }] })), ['droids-is-array']);

  // A droidless guild — with or without a serial — is legal.
  assert.deepEqual(checkDroids({ guilds: [{ id: 'g1' }, { id: 'g2', droidSerial: 4 }] }), []);
});

test('checkDroids runs inside checkInvariants: a corrupted droid halts the tick loop, naming the tick', () => {
  let s = kitGalaxy({ stock: bills(1) });
  s = accept(s, commission());
  s = ticks(s, 361);
  g1Of(s).droids[0].condition = 2;
  assert.throws(() => ticks(s, 1), /droid-condition-in-range/);
});

// --- 6. the gates -----------------------------------------------------------------------------------------

test('gates: a dockyard accepts a droid commission; the Syndicate SELLS droids in batches — Syndicate-source droids', () => {
  // ⤳ 02-11-26: this pinned the slice-2 refusal; droid engine slice 3 replaced it with the flat-tariff buy.
  // ⤳ 07-11-26: that instant buy is retired for the shipped batch (docs/droids.md §3, RE-RULED; its tripwires are
  // in droid-batch-buy.test.js). Here only that the two acquire paths stamp their source.
  const s = kitGalaxy({ credits: 1_000_000_000, fuelHoard: 10_000 });
  accept(s, commission());
  assert.match(refuse(s, createBuyAssetFromSyndicateAction({
    guildId: 'g1', assetKind: DROID, destinationSystemId: HOME.id, issueTick: s.tick,
  })), /send buyDroidBatch/);
  let bought = accept(s, createBuyDroidBatchAction({ guildId: 'g1', batch: 5, destinationSystemId: HOME.id }));
  bought = tickUntil(bought, (x) => droidsOf(x).length > 0);
  assert.deepEqual(droidsOf(bought).map((d) => d.source), ['syndicate', 'syndicate', 'syndicate', 'syndicate', 'syndicate']);
});

// --- 7. conservation --------------------------------------------------------------------------------------

test('conservation (invariant 2): exactly the bill leaves the yard\'s pool and Galactic Supply; no credit or fuel moves', () => {
  let s = kitGalaxy({ credits: 5, fuelHoard: 7, stock: { ...bills(1), power_cells: 9, titanium: 11 } });
  s = accept(s, commission());
  const before = structuredClone(s);
  s = ticks(s, 1); // the consume tick
  for (const good of Object.keys(pool(before))) {
    const spent = DROID_BILL[good] || 0;
    assert.equal(pool(s)[good], pool(before)[good] - spent, `${good}: the pool fell by the bill's ${spent}`);
    assert.equal(s.galacticSupply.resources[good], before.galacticSupply.resources[good] - spent, `${good}: supply fell by ${spent}`);
  }
  s = ticks(s, 360); // the mint moves no goods, credits or fuel
  assert.equal(droidsOf(s).length, 1);
  assert.deepEqual(pool(s), { power_cells: 7, titanium: 11, droid_components: 0, drive_module: 0 });
  assert.equal(g1Of(s).credits, 5);
  assert.equal(g1Of(s).fuelHoard, 7);
  assert.equal(s.syndicate.ledger, before.syndicate.ledger);
});

// --- 8. snapshot ------------------------------------------------------------------------------------------

test('snapshot: the owner sees { id, systemId, source, condition }; a droidless guild has no key; a rival sees nothing', () => {
  let s = kitGalaxy({ stock: bills(2) });
  s = accept(s, commission());
  s = accept(s, commission());
  const empty = buildSnapshot(s);
  assert.equal('droids' in empty.guilds.find((g) => g.id === 'g1'), false, 'no droids yet → no key');

  s = ticks(s, 2 * 361);
  const snap = buildSnapshot(s);
  const row = snap.guilds.find((g) => g.id === 'g1');
  assert.deepEqual(row.droids, [
    { id: 'asset_g1_droid_01', systemId: HOME.id, source: 'guild', condition: 1 },
    { id: 'asset_g1_droid_02', systemId: HOME.id, source: 'guild', condition: 1 },
  ]);
  assert.equal('droids' in snap.guilds.find((g) => g.id === 'g2'), false, 'g2 has none');
  row.droids[0].systemId = 'mutated';
  assert.equal(droidsOf(s)[0].systemId, HOME.id, 'the snapshot never aliases engine state');

  // The rival's fogged view cuts g1's row to its public fields.
  const rivalView = fogForGuild(buildSnapshot(s), s, 'g2');
  assert.equal('droids' in rivalView.guilds.find((g) => g.id === 'g1'), false, 'a rival never sees g1\'s droids');
});

// --- 9. determinism ---------------------------------------------------------------------------------------

function droidScript() {
  let s = kitGalaxy({ stock: bills(3) });
  s = accept(s, commission());
  s = accept(s, commission());
  s = accept(s, commission());
  const mid = ticks(s, 500); // droid 01 minted, droid 02 under way, droid 03 queued
  return { mid, end: ticks(mid, 700) };
}

test('determinism (invariant 9): two runs are byte-identical, ids included', () => {
  const a = droidScript();
  const b = droidScript();
  assert.equal(hashState(a.end), hashState(b.end));
  assert.deepEqual(droidsOf(a.end).map((d) => d.id), ['asset_g1_droid_01', 'asset_g1_droid_02', 'asset_g1_droid_03']);
});

test('determinism: a save mid-build (one droid minted, one under way, one queued) restores byte-identically and runs on identically', () => {
  const { mid } = droidScript();
  assert.equal(droidsOf(mid).length, 1);
  assert.equal(yardOf(mid).buildQueue.length, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-droid-'));
  try {
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(mid));
    assert.deepEqual(droidsOf(restored), droidsOf(mid), 'the droid rows survive a restore');
    assert.equal(g1Of(restored).droidSerial, 1, 'and so does the serial');
    assert.equal(hashState(ticks(restored, 700)), hashState(ticks(mid, 700)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
