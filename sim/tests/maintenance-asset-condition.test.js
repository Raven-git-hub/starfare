'use strict';

// maintenance-asset-condition.test.js — roadmap 2.6 (maintenance), slice 2 of 6 (docs/maintenance.md §0 / §11).
// Miners and factories never wear, so Asset.maintenanceCondition is GONE; and, riding along because it touches the
// same eviction code, losing a system clears the guild's droid_components reserve there (RULED 10-11-26).
//
// The tripwires, in order:
//   1. NO ASSET HAS IT: after full scenario runs (a human founding ticked on; a strand, ferry and sweep), no asset
//      anywhere — state or snapshot — carries the key.
//   2. THE TRIPWIRE BITES: a hand-built asset that carries one is a violation, and assertInvariants halts loudly
//      with the tick.
//   3. OLD SAVES LOAD: a state.json written with asset conditions restores through loadOrInit with the field dropped,
//      invariants clean, and is byte-identical to the same save written without it; the journal replays on top. A
//      vehicle's maintenanceCondition is NOT touched by the drop.
//   4. THE RESERVE CLEAR: a guild with reserves in two systems loses one — that key goes, the other stays; a guild
//      losing its only reserved system has no droidComponentReserve key at all; a rival's reserve is untouched; a
//      loss with no reserve there changes nothing about the map.
//   5. VEHICLES UNTOUCHED: the starter heavy is still 0.5, the lights still 1, after the founding and a run.
//   6. DETERMINISM (invariant 9): two runs of the same scenario are byte-identical, and so is a save → restore.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { advance } = require('../run.js');
const { createState } = require('../state.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit, dropRetiredAssetCondition } = require('../persist.js');
const { checkInvariants, assertInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { STARTER_HEAVY_CONDITION } = require('../starter-package.js');
const { ASSET_CONDITION_NEW } = require('../assets.js');
const {
  applyAction, createFoundGuildAction, createGrantAssetAction, createSetDroidComponentReserveAction,
} = require('../actions.js');
const { HOME_SYSTEM } = require('./home-anchor.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');

const { TARGET, accept } = P;
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const RULE = 'asset-has-no-condition (docs/maintenance.md §0)';

// founded(ticks) -> a human guild founded at HOME_SYSTEM (the 25 starter machines, the Outpost kit, the four craft),
// then `ticks` more ticks (advance applies its actions and ticks once, checking every invariant each time).
function founded(ticks = 0) {
  let s = advance(createZeroState(), [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
  for (let i = 0; i < ticks; i += 1) s = advance(s).state;
  return s;
}

// everyAssetRow(state) -> every asset row in the state AND in every view of it (god's-eye and each guild's own).
function everyAssetRow(state) {
  const rows = state.guilds.flatMap((g) => g.assets || []);
  for (const view of [buildSnapshot(state), ...state.guilds.map((g) => buildSnapshot(state, g.id))]) {
    for (const g of view.guilds || []) rows.push(...(g.assets || []));
  }
  return rows;
}

// --- 1. no asset has it --------------------------------------------------------------------------------------------

test('NO ASSET HAS IT — a human founding ticked on, and a strand + sweep: no asset row, stored or published, carries maintenanceCondition', () => {
  const { s: ready, rivalKit } = S.rivalReady(S.fallow().s);
  const runs = { founded: founded(50), swept: accept(ready, S.rivalPlant(rivalKit)) };
  for (const [name, s] of Object.entries(runs)) {
    const rows = everyAssetRow(s);
    assert.ok(rows.length > 0, `${name}: premise — there are assets to look at`);
    assert.deepEqual(rows.filter((a) => 'maintenanceCondition' in a).map((a) => a.id), [], `${name}: no row carries it`);
    assert.deepEqual(checkInvariants(s, s.tick), [], `${name}: every invariant holds`);
  }
  // The sweep really re-minted something, so its new rows were checked too.
  assert.ok(guildOf(runs.swept, 'g2').assets.some((a) => a.systemId === TARGET && a.kind !== 'outpost'), 'premise: g2 inherited machines');
});

test('NO ASSET HAS IT — every mint path: the operator grant and a createState hand-in with the old key', () => {
  let s = founded();
  s = advance(s, [createGrantAssetAction({ guildId: 'player-guild', kind: 'miner', systemId: HOME_SYSTEM })]).state;
  const newest = guildOf(s, 'player-guild').assets.slice(-1)[0];
  assert.deepEqual(Object.keys(newest), ['id', 'kind', 'systemId'], 'the grant mints exactly these fields');
  // A scenario written in the old shape goes through createAsset, which reads its fields by name: the key is lost.
  const handIn = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, assets: [{ id: 'asset_g1_miner_01', kind: 'miner', systemId: HOME_SYSTEM, maintenanceCondition: 0.4 }] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.deepEqual(handIn.guilds[0].assets, [{ id: 'asset_g1_miner_01', kind: 'miner', systemId: HOME_SYSTEM }]);
});

// --- 2. the tripwire bites -----------------------------------------------------------------------------------------

test('THE TRIPWIRE BITES — a hand-built asset with a condition is a violation, and assertInvariants halts naming the tick and the asset', () => {
  const s = founded();
  const asset = guildOf(s, 'player-guild').assets[0];
  asset.maintenanceCondition = ASSET_CONDITION_NEW; // a "valid-looking" 1 is just as wrong as garbage
  const v = checkInvariants(s, s.tick);
  assert.deepEqual(v.map((x) => x.rule), [RULE]);
  assert.equal(v[0].where, `guild:player-guild.asset:${asset.id}.maintenanceCondition`);
  assert.throws(() => assertInvariants(s, 77), (err) => err.message.includes('77') && err.message.includes(RULE) && err.message.includes(asset.id));
  // A vehicle's condition is NOT an asset's: the same key on a craft is legal and live.
  delete asset.maintenanceCondition;
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assert.equal(guildOf(s, 'player-guild').vehicles[0].maintenanceCondition, STARTER_HEAVY_CONDITION);
});

// --- 3. old saves load ---------------------------------------------------------------------------------------------

// withOldAssetCondition(state) -> a deep copy shaped as a save written BEFORE this slice: every asset carries
// `maintenanceCondition: 1`, placed where createAsset used to put it (after systemId).
function withOldAssetCondition(state) {
  const old = structuredClone(state);
  for (const g of old.guilds) {
    if (!g.assets) continue;
    g.assets = g.assets.map(({ id, kind, systemId, ...rest }) => ({ id, kind, systemId, maintenanceCondition: 1, ...rest }));
  }
  return old;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-asset-cond-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('OLD SAVES LOAD — a state.json whose assets carry the retired condition restores with the field dropped, invariants clean, byte-identical to the save without it; the journal replays on top', (t) => {
  const now = founded(20);
  const old = withOldAssetCondition(now);
  assert.ok(old.guilds[0].assets.every((a) => a.maintenanceCondition === 1), 'premise: the old save carries the field');
  assert.ok(checkInvariants(old, old.tick).some((x) => x.rule === RULE), 'premise: loaded raw, it would trip the wire');

  const dir = tmpDir(t);
  saveState(old, dir);
  const grant = createGrantAssetAction({ guildId: 'player-guild', kind: 'factory', systemId: HOME_SYSTEM });
  appendJournal(old.tick, grant, dir);
  const restored = loadOrInit(dir, () => { throw new Error('a save is present — the fresh path must not run'); });

  assert.deepEqual(everyAssetRow(restored).filter((a) => 'maintenanceCondition' in a), [], 'no restored asset carries it');
  assert.deepEqual(checkInvariants(restored, restored.tick), [], 'invariants clean after restore + replay');
  // Byte-identical to the same save without the field, with the same journal applied: the drop removes the key and
  // nothing else.
  assert.equal(hashState(restored), hashState(applyAction(now, grant)));
  // The craft kept their live condition: the drop reads only guild.assets.
  assert.deepEqual(restored.guilds[0].vehicles.map((v) => v.maintenanceCondition), now.guilds[0].vehicles.map((v) => v.maintenanceCondition));
});

test('OLD SAVES LOAD — dropRetiredAssetCondition counts what it drops, leaves vehicles alone, and is a no-op on a current state', () => {
  const now = founded();
  const old = withOldAssetCondition(now);
  const n = old.guilds[0].assets.length;
  assert.equal(dropRetiredAssetCondition(old), n);
  assert.equal(hashState(old), hashState(now));
  assert.equal(dropRetiredAssetCondition(old), 0, 'a second pass finds nothing');
  assert.equal(dropRetiredAssetCondition({ tick: 0 }), 0, 'a state with no guilds is fine');
  assert.equal(old.guilds[0].vehicles[0].maintenanceCondition, STARTER_HEAVY_CONDITION, 'the heavy keeps its 0.5');
});

// --- 4. the reserve clear ------------------------------------------------------------------------------------------

const setReserve = (guildId, systemId, reserve) => createSetDroidComponentReserveAction({ guildId, systemId, reserve });

// reserved(sets) -> S.planted() (g1 holds HOME and TARGET; g2 its own RIVAL starter), with each [guildId, systemId,
// reserve] set through the real player action.
function reserved(sets) {
  let s = S.planted();
  for (const [guildId, systemId, reserve] of sets) s = accept(s, setReserve(guildId, systemId, reserve));
  return s;
}

test('THE RESERVE CLEAR — reserves in two systems, one lost: that key goes, the other stays; the rival\'s is untouched', () => {
  const before = reserved([['g1', P.HOME.id, 3], ['g1', TARGET, 5], ['g2', P.RIVAL, 7]]);
  assert.deepEqual(guildOf(before, 'g1').droidComponentReserve, { [P.HOME.id]: 3, [TARGET]: 5 }, 'premise');
  const s = accept(before, S.abandon());
  assert.deepEqual(guildOf(s, 'g1').droidComponentReserve, { [P.HOME.id]: 3 }, 'TARGET\'s floor went with TARGET');
  assert.deepEqual(guildOf(s, 'g2').droidComponentReserve, { [P.RIVAL]: 7 }, 'a rival\'s reserve is not this loss\'s business');
});

test('THE RESERVE CLEAR — losing the only reserved system leaves no droidComponentReserve key at all (omit-when-empty)', () => {
  const s = accept(reserved([['g1', TARGET, 5]]), S.abandon());
  assert.equal('droidComponentReserve' in guildOf(s, 'g1'), false);
  // …so it is byte-identical to the same loss by a guild that never set a reserve.
  assert.equal(hashState(s), hashState(accept(reserved([]), S.abandon())));
});

test('THE RESERVE CLEAR — a loss where the guild had no reserve there leaves its map exactly as it was', () => {
  const s = accept(reserved([['g1', P.HOME.id, 3]]), S.abandon());
  assert.deepEqual(guildOf(s, 'g1').droidComponentReserve, { [P.HOME.id]: 3 });
});

test('THE RESERVE CLEAR — retaking the system does not bring the old floor back', () => {
  let s = accept(reserved([['g1', TARGET, 5]]), S.abandon());
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, P.SLOT_A1));
  assert.ok(P.held(s, 'g1', TARGET), 'premise: g1 holds TARGET again');
  assert.equal('droidComponentReserve' in guildOf(s, 'g1'), false, 'no stale reserve came back with the claim');
});

// --- 5. vehicles untouched -----------------------------------------------------------------------------------------

test('VEHICLES UNTOUCHED — the starter heavy is still 0.5 and the lights 1, after the founding and a run', () => {
  const s = founded(100);
  const fleet = guildOf(s, 'player-guild').vehicles.map((v) => [v.class, v.maintenanceCondition]);
  assert.deepEqual(fleet, [['heavyTransport', STARTER_HEAVY_CONDITION], ['lightTransport', 1], ['lightTransport', 1], ['lightTransport', 1]]);
  assert.equal(STARTER_HEAVY_CONDITION, 0.5);
  // …and the snapshot still publishes it on every craft row.
  assert.deepEqual(buildSnapshot(s, 'player-guild').guilds.find((g) => g.id === 'player-guild').vehicles.map((v) => v.maintenanceCondition).sort(), [0.5, 1, 1, 1]);
});

// --- 6. determinism ------------------------------------------------------------------------------------------------

test('DETERMINISM — two runs of the same scenario are byte-identical (founding, and a loss that clears a reserve), and a save → restore is too', (t) => {
  assert.equal(hashState(founded(30)), hashState(founded(30)));
  const loss = () => accept(reserved([['g1', P.HOME.id, 3], ['g1', TARGET, 5]]), S.abandon());
  assert.equal(hashState(loss()), hashState(loss()));
  const dir = tmpDir(t);
  const s = loss();
  saveState(s, dir);
  assert.equal(hashState(loadOrInit(dir, createZeroState)), hashState(s));
});
