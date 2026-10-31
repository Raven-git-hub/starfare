'use strict';

// sweep.test.js — LOSING GROUND, engine PR 4: THE SWEEP (design.md §19 #67, SETTLED 28-10-26; docs/territory-model.md
// §4; sim/eviction.js `sweepStrandedAssets`). g1 abandons TARGET and its machines there are stranded; g2 plants a
// Prefecture in the fallow system, and every machine of g1's still lying there CHANGES HANDS to g2 — retired from g1
// (its number recorded, never reissued) and re-minted as g2's own idle asset, with both guilds told.
//
// The tripwires:
//   1. THE TRANSFER, field by field: g2's new ids continue g2's own numbering; same kind, same system, the SAME
//      maintenanceCondition, stamped, unflagged, idle; g1 no longer lists them and cannot reissue their numbers;
//      one notice each side; nothing priced moved.
//   2. KITS TOO (a reading beyond the brief, flagged): a stranded kit is re-minted through the kit serial, and works.
//   3. THE REFUSAL IS GONE: the very plant engine PR 1 refused is legal.
//   4. THE OWN-MACHINE PATH IS UNTOUCHED: an owner's re-plant recovers its own (ids kept, no notice, nothing swept).
//   5. ORDER + DETERMINISM: several former owners, several machines, in guild-then-asset order, distinct new ids; a
//      plant that recovers its own AND sweeps another's; byte-identical on a second run.
//   6. OUT OF REACH: a machine aboard a heavy mid-ferry, and one already ferried home, are not swept.
//   7. SPOILED GROUND: the eviction's node lockout still stands after the plant; the inherited miner works elsewhere.
//   8. THE TRIPWIRES BITE: a claim that missed a stranded machine, and a swept row that kept its old id, each red.
//   9. THE SNAPSHOT + FOG: the new owner sees ordinary idle rows; each guild sees only its own notice.
//  10. BYTE-IDENTITY: two galaxies that never sweep hash exactly as on `main` (pinned goldens).
//  11. PERSISTENCE: a journalled sweep replays to the same bytes; a createState hand-in keeps the stamp.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hashState } = require('../serialize.js');
const { createState } = require('../state.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { checkInvariants } = require('../invariants.js');
const { systemHolder } = require('../claims.js');
const { getSystem, getSystemLayout } = require('../seed.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { strandedAssetsIn } = require('../eviction.js');
const { idleAssets } = require('../assets.js');
const {
  validateAction, createGrantAssetAction, createEstablishVentureAction, createSpawnVehicleAction, createLoadKitAction,
  createLoadAssetAction, createUnloadAssetAction, createDispatchVehicleAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');

const { accept, refuse, ticks, tickUntil, HEAVY, AT_HOME, HOME, TARGET, AT_TARGET, PLANET_B, SLOT_A1 } = P;
const { NODE, guildOf, fallow, rivalReady, rivalPlant, digest } = S;

const SWEPT = 'assets_swept';
const INHERITED = 'assets_inherited';
const assetsOf = (s, guildId) => guildOf(s, guildId).assets || [];
const inTarget = (s, guildId) => assetsOf(s, guildId).filter((a) => a.systemId === TARGET);
const newestEvent = (s, guildId) => (guildOf(s, guildId).events || []).slice(-1)[0];

// swept({ condition }) -> fallow(); optionally g1's stranded miner's (inert) condition set by hand, since no engine path
// changes it; then g2 plants in TARGET. `before` is the galaxy the plant was applied to.
function swept({ condition } = {}) {
  const f = fallow();
  let s = f.s;
  if (condition !== undefined) {
    s = structuredClone(s);
    guildOf(s, 'g1').assets.find((a) => a.id === f.miner).maintenanceCondition = condition;
  }
  let rivalKit;
  ({ s, rivalKit } = rivalReady(s));
  return { ...f, before: s, s: accept(s, rivalPlant(rivalKit)) };
}

// --- 1. the transfer -------------------------------------------------------------------------------------------------

test('THE TRANSFER — each of g1\'s stranded machines is now g2\'s: a new id in g2\'s own sequence, same kind and system, the SAME condition, stamped, unflagged, idle', () => {
  const { before, s, miner, factory, idleFactory } = swept({ condition: 0.75 });
  assert.equal(systemHolder(s, TARGET), 'g2');
  assert.deepEqual(strandedAssetsIn(before, TARGET).map((x) => x.guildId), ['g1', 'g1', 'g1', 'g1'], 'four were lying there');
  assert.deepEqual(strandedAssetsIn(s, TARGET), [], 'none is left stranded');
  // g2 already owned miner 01 (at home), so the inherited miner is 02 — the sequence continues; the factories are
  // g2's first, 01 and 02. In g1's stored order (guild then asset, invariant 9), pushed one by one.
  const machines = inTarget(s, 'g2').filter((a) => a.kind !== 'outpost');
  assert.deepEqual(machines, [
    { id: 'asset_g2_miner_02', kind: 'miner', systemId: TARGET, maintenanceCondition: 0.75, updatedAtTick: s.tick },
    { id: 'asset_g2_factory_01', kind: 'factory', systemId: TARGET, maintenanceCondition: 1, updatedAtTick: s.tick },
    { id: 'asset_g2_factory_02', kind: 'factory', systemId: TARGET, maintenanceCondition: 1, updatedAtTick: s.tick },
  ], 'the condition rides along untouched (it is inert); no `stranded` key on any of them');
  assert.deepEqual(assetsOf(s, 'g2')[0], { id: 'asset_g2_miner_01', kind: 'miner', systemId: P.RIVAL, maintenanceCondition: 1 }, 'g2\'s own miner at home, untouched');
  const idle = idleAssets(guildOf(s, 'g2')).map((a) => a.id);
  for (const m of machines) assert.ok(idle.includes(m.id), `${m.id} is an ordinary idle asset of g2's`);
  // g1 lists none of them — its whole inventory was there, so its `assets` key goes (omit-when-empty).
  for (const id of [miner, factory, idleFactory]) assert.equal(assetsOf(s, 'g1').some((a) => a.id === id), false);
  assert.equal('assets' in guildOf(s, 'g1'), false);
});

test('THE TRANSFER — g1\'s removed high-water rises, so its old numbers are never reissued to it', () => {
  const { before, s } = swept();
  assert.equal('removedAssetHighWater' in guildOf(before, 'g1'), false, 'nothing was ever deleted from g1 before');
  assert.deepEqual(guildOf(s, 'g1').removedAssetHighWater, { miner: 1, factory: 2 }, 'machines only — a kit numbers from its serial');
  let t = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'miner', systemId: HOME.id }));
  t = accept(t, createGrantAssetAction({ guildId: 'g1', kind: 'factory', systemId: HOME.id }));
  assert.deepEqual(assetsOf(t, 'g1').map((a) => a.id), ['asset_g1_miner_02', 'asset_g1_factory_03'], 'above every number g1 lost');
});

test('THE TRANSFER — both sides are told: ONE `assets_swept` to g1 (naming the new holder), ONE `assets_inherited` to g2 (naming no former owner)', () => {
  const { before, s, miner, factory, idleFactory, outpostKit } = swept();
  const systemName = getSystem(TARGET).name;
  assert.equal(guildOf(s, 'g1').events.length, guildOf(before, 'g1').events.length + 1, 'exactly one new notice for g1');
  assert.deepEqual(newestEvent(s, 'g1'), {
    id: guildOf(before, 'g1').eventSeq, tick: s.tick, type: SWEPT,
    payload: {
      systemId: TARGET, systemName, sweptAssetIds: [factory, idleFactory, miner, outpostKit].sort(), byGuildId: 'g2', byGuildName: 'g2',
    },
  });
  assert.deepEqual(guildOf(s, 'g2').events, [{
    id: 0, tick: s.tick, type: INHERITED,
    payload: {
      systemId: TARGET, systemName, prefectureId: 'prefecture_g2_01',
      inheritedAssetIds: ['asset_g2_factory_01', 'asset_g2_factory_02', 'asset_g2_miner_02', 'asset_g2_outpost_02'],
    },
  }], 'g2\'s only notice — and no g1 id appears in it');
  assert.equal(JSON.stringify(guildOf(s, 'g2').events).includes('g1'), false);
});

test('THE TRANSFER — nothing priced moves: no credits, fuel, goods or Galactic Supply change', () => {
  const { before, s } = swept();
  for (const id of ['g1', 'g2']) {
    assert.equal(guildOf(s, id).credits, guildOf(before, id).credits);
    assert.equal(guildOf(s, id).fuelHoard, guildOf(before, id).fuelHoard);
    assert.deepEqual(guildOf(s, id).stockpiles, guildOf(before, id).stockpiles);
  }
  assert.deepEqual(computeGalacticSupply(s), computeGalacticSupply(before));
  assert.equal(s.tick, before.tick, 'the plant is instant');
});

// --- 2. kits too -----------------------------------------------------------------------------------------------------

test('KITS TOO (a reading beyond the brief — §19 #67\'s window covers every stranded asset): a stranded Outpost kit is re-minted through g2\'s KIT SERIAL, and loads like any kit of g2\'s', () => {
  const { before, s, outpostKit } = swept();
  assert.equal(guildOf(before, 'g2').kitAssetSerial, 1, 'g2\'s Prefecture kit took serial 1');
  assert.equal(guildOf(s, 'g2').kitAssetSerial, 2, 'the inherited kit took the next — never nextAssetNumber');
  assert.deepEqual(inTarget(s, 'g2').find((a) => a.kind === 'outpost'), {
    id: 'asset_g2_outpost_02', kind: 'outpost', systemId: TARGET, maintenanceCondition: 1, updatedAtTick: s.tick,
  });
  assert.equal(guildOf(s, 'g1').kitAssetSerial, 3, 'g1\'s kit serial never goes back, so its old kit id is never reissued');
  assert.equal(assetsOf(s, 'g1').some((a) => a.id === outpostKit), false);
  // It is a real kit of g2's: a g2 heavy berthed in TARGET loads it.
  let t = accept(s, createSpawnVehicleAction({ guildId: 'g2', class: HEAVY_TRANSPORT, location: AT_TARGET }));
  t = accept(t, createLoadKitAction({ guildId: 'g2', vehicleId: 'vehicle_g2_heavyTransport_01', assetId: 'asset_g2_outpost_02' }));
  assert.deepEqual(guildOf(t, 'g2').vehicles[0].cargo, { outpost_kit: 1 });
});

// --- 3. the refusal is gone ------------------------------------------------------------------------------------------

test('THE REFUSAL IS GONE: the exact plant engine PR 1 refused — a rival over another guild\'s stranded machines — is valid', () => {
  let { s } = fallow();
  let rivalKit;
  ({ s, rivalKit } = rivalReady(s));
  assert.ok(strandedAssetsIn(s, TARGET).length > 0, 'g1\'s machines lie there');
  assert.deepEqual(validateAction(s, rivalPlant(rivalKit)), { valid: true });
  // Every OTHER plant gate still stands: once g2 holds TARGET, nobody else may plant there.
  let again;
  const planted = accept(s, rivalPlant(rivalKit));
  ({ s: again, kitId: rivalKit } = P.grantPrefectureKit(planted, 'g1', TARGET));
  assert.equal(refuse(again, P.plant('g1', rivalKit, SLOT_A1)), `system "${TARGET}" is already held by guild "g2" — a Prefecture plants only in an unclaimed system`);
});

// --- 4. the own-machine path is untouched ----------------------------------------------------------------------------

test('THE OWN PATH: g1 re-planting the system it was evicted from just recovers its own machines — ids kept, no transfer, no notice', () => {
  let { s, miner, factory, idleFactory, outpostKit } = fallow();
  const before = s;
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  const eventsBefore = structuredClone(guildOf(s, 'g1').events);
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  assert.deepEqual(inTarget(s, 'g1').map((a) => a.id), [miner, factory, idleFactory, outpostKit], 'the same ids, in the same order');
  assert.equal(inTarget(s, 'g1').some((a) => 'stranded' in a || 'updatedAtTick' in a), false, 'flags cleared; no re-mint stamp');
  assert.deepEqual(guildOf(s, 'g1').events, eventsBefore, 'no new notice');
  assert.equal('removedAssetHighWater' in guildOf(s, 'g1'), false, 'nothing deleted');
  assert.deepEqual(guildOf(s, 'g2'), guildOf(before, 'g2'), 'the rival untouched');
});

// --- 5. order + determinism ------------------------------------------------------------------------------------------

// threeOwners() -> fallow(), then by hand (no engine path can strand two guilds' machines in one system — every claim
// sweeps — so this is built, not played): g2's home miner and a third guild g3's factory + miner, in that stored
// order, all stranded in TARGET beside g1's four. g3 is made by the real guild constructor (a homeless guild, as a
// scenario's are). Every invariant holds on it.
function threeOwners() {
  const s = structuredClone(fallow().s);
  const g2 = guildOf(s, 'g2');
  g2.assets[0] = { ...g2.assets[0], systemId: TARGET, stranded: { tick: s.tick } };
  const [g3] = createState({
    guilds: [{
      id: 'g3', name: 'Third Guild', credits: 0, fuelHoard: 0,
      assets: [
        { id: 'asset_g3_factory_01', kind: 'factory', systemId: TARGET, maintenanceCondition: 0.5, stranded: { tick: s.tick } },
        { id: 'asset_g3_miner_01', kind: 'miner', systemId: TARGET, maintenanceCondition: 0.25, stranded: { tick: s.tick } },
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  }).guilds;
  s.guilds.push(g3);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the hand-built galaxy is sound');
  return s;
}

test('ORDER: g1 re-plants over three owners\' machines — it RECOVERS its own and SWEEPS the others\', guild then asset, distinct new ids; one notice per former owner', () => {
  let s = threeOwners();
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  // g1's own four keep their ids; then g2's miner, g3's factory, g3's miner — in that order — become g1's next numbers.
  assert.deepEqual(inTarget(s, 'g1').map((a) => [a.id, a.maintenanceCondition]), [
    ['asset_g1_miner_01', 1], ['asset_g1_factory_01', 1], ['asset_g1_factory_02', 1], ['asset_g1_outpost_03', 1],
    ['asset_g1_miner_02', 1], ['asset_g1_factory_03', 0.5], ['asset_g1_miner_03', 0.25],
  ]);
  assert.equal('assets' in guildOf(s, 'g2'), false);
  assert.equal('assets' in guildOf(s, 'g3'), false);
  assert.deepEqual(guildOf(s, 'g2').removedAssetHighWater, { miner: 1 });
  assert.deepEqual(guildOf(s, 'g3').removedAssetHighWater, { factory: 1, miner: 1 });
  assert.deepEqual(newestEvent(s, 'g2').payload.sweptAssetIds, ['asset_g2_miner_01']);
  assert.deepEqual(newestEvent(s, 'g3').payload.sweptAssetIds, ['asset_g3_factory_01', 'asset_g3_miner_01']);
  assert.deepEqual([newestEvent(s, 'g2').payload.byGuildId, newestEvent(s, 'g3').payload.byGuildName], ['g1', 'g1']);
  assert.deepEqual(newestEvent(s, 'g1'), {
    id: guildOf(s, 'g1').eventSeq - 1, tick: s.tick, type: INHERITED,
    payload: {
      systemId: TARGET, systemName: newestEvent(s, 'g2').payload.systemName, prefectureId: 'prefecture_g1_02',
      inheritedAssetIds: ['asset_g1_factory_03', 'asset_g1_miner_02', 'asset_g1_miner_03'],
    },
  }, 'only the swept ids — the recovered four are its own already');
  ticks(s, 5);
});

test('DETERMINISM: the same galaxy and the same plant give the same bytes — twice over, one owner or three', () => {
  assert.equal(hashState(swept().s), hashState(swept().s));
  const run = () => {
    let s = threeOwners();
    let kitId;
    ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
    return ticks(accept(s, P.plant('g1', kitId, SLOT_A1)), 10);
  };
  assert.equal(hashState(run()), hashState(run()));
});

// --- 6. out of reach -------------------------------------------------------------------------------------------------

test('OUT OF REACH: a machine already ferried home, and one aboard a heavy mid-ferry, are not swept — only what still lies stranded', () => {
  let { s, miner, factory, idleFactory, outpostKit } = fallow();
  // The idle factory: loaded onto g1's heavy (berthed at TARGET), flown home and unloaded — ferried out.
  s = accept(s, createLoadAssetAction({ guildId: 'g1', vehicleId: HEAVY, assetId: idleFactory }));
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: HEAVY, waypoints: [AT_HOME] }));
  s = tickUntil(s, (x) => P.heavyOf(x).status === 'idle');
  s = accept(s, createUnloadAssetAction({ guildId: 'g1', vehicleId: HEAVY }));
  // The miner: loaded onto a second heavy and sent home — in flight when g2 plants.
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_TARGET }));
  const second = 'vehicle_g1_heavyTransport_02';
  s = accept(s, createLoadAssetAction({ guildId: 'g1', vehicleId: second, assetId: miner }));
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: second, waypoints: [AT_HOME] }));
  s = ticks(s, 1);
  const craft = (x) => guildOf(x, 'g1').vehicles.find((v) => v.id === second);
  assert.equal(craft(s).status, 'inTransit');
  let rivalKit;
  ({ s, rivalKit } = rivalReady(s));
  s = accept(s, rivalPlant(rivalKit));
  // Only the factory still on the ground and the kit changed hands.
  assert.deepEqual(newestEvent(s, 'g1').payload.sweptAssetIds, [factory, outpostKit].sort());
  assert.deepEqual(inTarget(s, 'g2').map((a) => a.id), ['asset_g2_factory_01', 'asset_g2_outpost_02']);
  // The ferried factory: g1's, at home, idle, its id unchanged.
  assert.deepEqual(assetsOf(s, 'g1').find((a) => a.id === idleFactory).systemId, HOME.id);
  // The miner in flight: still g1's, same id, still aboard; it reads TARGET until it is unloaded at home.
  assert.equal(craft(s).carryingAssetId, miner);
  assert.equal(assetsOf(s, 'g1').find((a) => a.id === miner).systemId, TARGET);
  s = tickUntil(s, (x) => craft(x).status === 'idle');
  s = accept(s, createUnloadAssetAction({ guildId: 'g1', vehicleId: second }));
  assert.equal(assetsOf(s, 'g1').find((a) => a.id === miner).systemId, HOME.id, 'salvaged after all');
});

// --- 7. spoiled ground -----------------------------------------------------------------------------------------------

// A second mineable node, on the planet g2 surveyed and not the locked one — from the seed.
const CLEAN_NODE = getSystemLayout(TARGET).planets.find((p) => p.id === PLANET_B).resourceNodes
  .find((n) => n.resourceType !== 'deuterium' && n.id !== NODE.id);

test('SPOILED GROUND: the eviction\'s node lockout still stands after g2\'s plant — the inherited miner cannot go there, but works on clean ground', () => {
  const { before, s } = swept();
  assert.ok(Array.isArray(before.nodeLockouts) && before.nodeLockouts.some((l) => l.siteId === NODE.id), 'g1\'s eviction locked the licensed mine\'s node');
  assert.deepEqual(s.nodeLockouts, before.nodeLockouts, 'the plant cleared nothing — galaxy-scoped, it binds the new holder too');
  const establish = (ventureId, node) => createEstablishVentureAction({
    guildId: 'g2', ventureId, type: 'mining', siteId: node.id, assetId: 'asset_g2_miner_02', resourceType: node.resourceType,
  });
  assert.match(refuse(s, establish('m2', NODE)), /is locked after a venture teardown/);
  assert.ok(CLEAN_NODE, 'the seed has a second mineable node on PLANET_B');
  const t = accept(s, establish('m2', CLEAN_NODE));
  ticks(t, 5);
});

// --- 8. the tripwires bite -------------------------------------------------------------------------------------------

test('THE TRIPWIRES BITE — a claim that left one stranded machine behind is red (checkStrandedAssets); a swept row that kept its old id is red (asset-id-names-its-owner) — and the harness halts on it', () => {
  const { s, miner } = swept();
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the real sweep is clean');
  const rules = (x) => checkInvariants(x, x.tick).map((v) => v.rule);
  // A sweep that missed one: g1's miner still lying there, flagged, in what is now g2's system.
  const missed = structuredClone(s);
  guildOf(missed, 'g1').assets = [{ id: 'asset_g1_miner_09', kind: 'miner', systemId: TARGET, maintenanceCondition: 1, stranded: { tick: s.tick } }];
  // (Since the salvage window, 31-10-26, it is also a stranded machine with no window over it — the claim closed it.)
  assert.deepEqual(rules(missed), [
    'stranded-asset-only-in-an-unclaimed-system (design.md §19 #67)', 'stranded-asset-has-a-salvage-window (design.md §19 #67)',
  ]);
  // A sweep that MOVED the row instead of re-minting: g2 holds a machine whose id still names g1.
  const moved = structuredClone(s);
  guildOf(moved, 'g2').assets.find((a) => a.id === 'asset_g2_miner_02').id = miner;
  assert.deepEqual(rules(moved), ['asset-id-names-its-owner (design.md §15.4)']);
  assert.throws(() => ticks(moved, 1), /Invariant violation at tick \d+[\s\S]*asset-id-names-its-owner/);
});

test('THE NEW INVARIANT reads every kind, and fails on every id that does not rebuild from its owner, kind and number', () => {
  const { s } = swept();
  const red = (mutate) => {
    const c = structuredClone(s);
    mutate(guildOf(c, 'g2').assets);
    return checkInvariants(c, c.tick).filter((v) => v.rule === 'asset-id-names-its-owner (design.md §15.4)').map((v) => v.detail);
  };
  const at = (assets, id) => assets.find((a) => a.id === id);
  assert.deepEqual(red((a) => { at(a, 'asset_g2_outpost_02').id = 'asset_g1_outpost_02'; }), [
    { assetId: 'asset_g1_outpost_02', owner: 'g2', kind: 'outpost', expected: 'asset_g2_outpost_02' },
  ], 'a kit naming another guild');
  assert.equal(red((a) => { at(a, 'asset_g2_miner_02').id = 'asset_g2_factory_09'; }).length, 1, 'an id naming another kind');
  assert.equal(red((a) => { at(a, 'asset_g2_miner_02').id = 'asset_g2_miner'; }).length, 1, 'no number');
  assert.equal(red((a) => { at(a, 'asset_g2_miner_02').id = 'asset_g2_miner_2'; }).length, 1, 'not the padded form the mint writes');
  assert.equal(red((a) => { at(a, 'asset_g2_miner_02').id = 'm2'; }).length, 1, 'a placeholder');
  assert.deepEqual(red(() => {}), [], 'and nothing on the real thing');
});

// --- 9. the snapshot and fog -----------------------------------------------------------------------------------------

test('THE SNAPSHOT + FOG: g2 sees the inherited machines as ordinary idle rows; g1 no longer sees them; each guild sees only its own notice', () => {
  const { s, miner } = swept();
  const own = (id) => buildSnapshot(s, id).guilds.find((g) => g.id === id);
  const row = own('g2').assets.find((a) => a.id === 'asset_g2_miner_02');
  assert.equal(row.deployedToVentureId, null);
  assert.equal(row.systemId, TARGET);
  assert.equal('stranded' in row, false);
  assert.equal((own('g1').assets || []).some((a) => a.id === miner), false);
  assert.equal(own('g1').events.find((e) => e.type === SWEPT).payload.byGuildId, 'g2');
  assert.equal(own('g2').events.find((e) => e.type === INHERITED).payload.prefectureId, 'prefecture_g2_01');
  assert.equal('assets' in buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g2'), false, 'a rival row carries no assets');
  assert.equal('events' in buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g2'), false, 'nor notices');
});

// --- 10. byte-identity -----------------------------------------------------------------------------------------------

// Pinned from `main` at 6b20d2e (before this slice), running sweep-script.js's two never-sweeps galaxies: an owner's
// re-claim of its own fallow system (its own machines recovered), and a rival's claim of an EMPTY fallow system. The
// state and every view must not move by a byte — the sweep adds no field to any existing record, and on these paths
// it finds nothing to do.
const GOLDEN_NEVER_SWEEPS = {
  ownReclaim: {
    tick: 500,
    state: '07ea199deaa8e5bf288fb571679c1c0591987f3d7454857313a1a0b51fd52608',
    god: 'b6c2b6eab38dce36764838b656707022963b2c037964b1f1310bc565653c4585',
    g1: 'd77e460152fd4492e606130def9ba6ebd10d864638967e80f0ad1d6ac8507311',
    g2: '040c14b082f38469c9dd071b712386e48a71c32f86da1875a989aa1ab2b2f659',
  },
  emptyFallowClaim: {
    tick: 470,
    state: '118a0eb5e976e85bcde29f07e5dc1b8942840932ba2f4bf625a1a0a0f8532978',
    god: '1b1a1d1c1129809b336868a5396a232be4c8dab1c9b5dfb41f52141f97a58274',
    g1: '9245da2db553ceeb60af3dc5157db48545e61a752963b5de66b6467d77878b61',
    g2: '7a668440a7c645dcea36b91cee2a6f36bba3ab9dd027eab85dc23954d0872e44',
  },
};

test('BYTE-IDENTICAL: galaxies that never sweep serialize exactly as they did before this slice (state and every view)', () => {
  assert.deepEqual(digest(S.ownReclaim()), GOLDEN_NEVER_SWEEPS.ownReclaim);
  assert.deepEqual(digest(S.emptyFallowClaim()), GOLDEN_NEVER_SWEEPS.emptyFallowClaim);
});

// --- 11. persistence -------------------------------------------------------------------------------------------------

test('PERSISTENCE: a journalled sweep replays to the same bytes (and ticks on identically); a createState hand-in keeps the re-mint\'s stamp', () => {
  let { s: held } = fallow();
  let rivalKit;
  ({ s: held, rivalKit } = rivalReady(held));
  const action = rivalPlant(rivalKit);
  const direct = accept(held, action);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  try {
    saveState(held, dir);
    appendJournal(held.tick, action, dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct));
    assert.equal(hashState(ticks(replayed, 10)), hashState(ticks(direct, 10)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const rebuilt = createState(structuredClone(direct));
  assert.deepEqual(inTarget(rebuilt, 'g2'), inTarget(direct, 'g2'));
  assert.equal(inTarget(rebuilt, 'g2')[0].updatedAtTick, direct.tick);
});
