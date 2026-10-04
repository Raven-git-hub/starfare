'use strict';

// asset-id-high-water.test.js — miner / factory ids never repeat across the operator remove levers
// (design.md §15.4 "Ids never repeat"; §4 AS-BUILT "the removed high-water"; roadmap 2.2 deploy
// pipeline, engine-integrity tidy).
//
// THE BUG THIS PINS: a miner's or factory's number comes from nextAssetNumber (sim/assets.js), "the
// highest LIVE number + 1". Nothing in play deletes one, so that was safe — but the operator levers
// removeAsset and removeVenture { asset: 'remove' } DO. Delete the top-numbered miner, grant or build
// another, and the live max handed the deleted id straight back out.
//
// THE FIX: both levers delete through ONE helper (sim/actions.js deleteAsset), which first records the
// deleted number in `guild.removedAssetHighWater[kind]`; nextAssetNumber never mints at or below it.
//
// The tripwires:
//   - EACH REMOVER: delete the top, grant (or build) again → the next number up, never the deleted one;
//   - A NON-TOP delete does not inflate the next number, and the mark never drops;
//   - KINDS ARE SEPARATE: a miner's mark does not move factory numbering; a kit is not recorded at all;
//   - DETERMINISM (invariant 9): run twice, journalled replay, and a state saved WITH a mark all agree;
//   - THE INVARIANT: a re-issued id or a malformed mark trips it; every legal state stays clean;
//   - NO-OP SHAPE: a guild that never had an asset deleted carries no key, so every golden is unmoved.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState, createGuild } = require('../state.js');
const { tick } = require('../tick.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { nextAssetNumber } = require('../assets.js');
const {
  intake,
  createFoundGuildAction, createEstablishVentureAction,
  createGrantAssetAction, createRemoveAssetAction, createRemoveVentureAction, createGrantKitAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const GUILD = 'player-guild';
const miner = (n) => `asset_${GUILD}_miner_${String(n).padStart(2, '0')}`;
const factory = (n) => `asset_${GUILD}_factory_${String(n).padStart(2, '0')}`;
// The founding gift is miners 01..15 and factories 01..10 (sim/assets.js STARTER_MINERS / _FACTORIES).
const TOP_MINER = miner(15);

// A galaxy with the player founded on the home system: its 25 starter machines idle, no ventures.
function founded() {
  const found = createFoundGuildAction({ guildId: GUILD, credits: 5_000_000, influence: 100, homeSystemId: HOME_SYSTEM });
  return intake(createZeroState(), [found]).state;
}

const guildOf = (state) => state.guilds.find((g) => g.id === GUILD);
const assetIds = (state, kind) => guildOf(state).assets.filter((a) => a.kind === kind).map((a) => a.id);

// Apply actions through intake (no tick, as POST /action applies them), asserting each was accepted.
function act(state, ...actions) {
  const { state: next, results } = intake(state, actions);
  results.forEach((r, i) => assert.equal(r.accepted, true, `${actions[i].type} refused: ${r.reason}`));
  return next;
}

const grantMiner = () => createGrantAssetAction({ guildId: GUILD, kind: 'miner', systemId: HOME_SYSTEM });
const grantFactory = () => createGrantAssetAction({ guildId: GUILD, kind: 'factory', systemId: HOME_SYSTEM });
const removeAsset = (assetId, occupied) => createRemoveAssetAction({ guildId: GUILD, assetId, occupied });
// The last asset the guild holds — where a grant pushes its new machine.
const newest = (state) => guildOf(state).assets[guildOf(state).assets.length - 1].id;

// --- 1. each remover: the deleted number is never handed out again ---------------------------------

test('removeAsset: delete the top miner, grant again → miner 16, never the deleted 15', () => {
  const removed = act(founded(), removeAsset(TOP_MINER));
  assert.deepEqual(guildOf(removed).removedAssetHighWater, { miner: 15 }, 'the deleted number is recorded');
  // WHY the mark is needed: without it, "highest live + 1" would hand 15 straight back out.
  const unmarked = structuredClone(guildOf(removed));
  delete unmarked.removedAssetHighWater;
  assert.equal(nextAssetNumber(unmarked, 'miner'), 15, 'the live max alone would reissue the deleted id');

  const s = act(removed, grantMiner());
  assert.equal(newest(s), miner(16));
  assert.equal(assetIds(s, 'miner').includes(TOP_MINER), false, 'miner 15 is not back');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // And the sequence carries on from there.
  assert.equal(newest(act(s, grantMiner())), miner(17));
});

test('removeAsset on an OCCUPIED top miner (detach and close) records it too', () => {
  for (const occupied of ['detach', 'close']) {
    let s = act(founded(), createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: TOP_MINER, resourceType: 'titanium', productionRate: 5,
    }));
    s = act(s, removeAsset(TOP_MINER, occupied), grantMiner());
    assert.equal(newest(s), miner(16), occupied);
    assert.deepEqual(guildOf(s).removedAssetHighWater, { miner: 15 }, occupied);
    assert.deepEqual(checkInvariants(s, s.tick), [], occupied);
  }
});

test('removeVenture { asset: "remove" }: delete the venture running the top miner, grant again → miner 16', () => {
  let s = act(founded(), createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: TOP_MINER, resourceType: 'titanium', productionRate: 5,
  }));
  s = act(s, createRemoveVentureAction({ guildId: GUILD, ventureId: 'mine_1', asset: 'remove' }));
  assert.equal(assetIds(s, 'miner').includes(TOP_MINER), false, 'the machine was deleted with its venture');
  assert.deepEqual(guildOf(s).removedAssetHighWater, { miner: 15 });
  s = act(s, grantMiner());
  assert.equal(newest(s), miner(16));
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // 'keep' deletes nothing, so it records nothing.
  let kept = act(founded(), createEstablishVentureAction({
    guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: TOP_MINER, resourceType: 'titanium', productionRate: 5,
  }));
  kept = act(kept, createRemoveVentureAction({ guildId: GUILD, ventureId: 'mine_1', asset: 'keep' }));
  assert.equal('removedAssetHighWater' in guildOf(kept), false);
});

test('a SELF-BUILT miner (the Dockyard) never reuses a deleted number either', () => {
  // The dockyard test's fast shape: 15 idle miners and an unseated dockyard one tick from emitting a miner.
  const miners = [];
  for (let n = 1; n <= 15; n += 1) miners.push({ id: `asset_g1_miner_${String(n).padStart(2, '0')}`, kind: 'miner', systemId: 'sysA' });
  let s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, assets: miners,
      ventures: [{ id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA', dockyard: true, nextCommissionId: 1, buildQueue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: 1 }] }],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
  s = intake(s, [createRemoveAssetAction({ guildId: 'g1', assetId: 'asset_g1_miner_15' })]).state;
  s = tick(s);
  const ids = s.guilds[0].assets.filter((a) => a.kind === 'miner').map((a) => a.id);
  assert.equal(ids[ids.length - 1], 'asset_g1_miner_16', 'the build skipped the deleted 15');
  assert.equal(ids.includes('asset_g1_miner_15'), false);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. the mark: only the top matters, it never drops, and kinds are separate ---------------------

test('deleting a NON-top miner does not inflate the next number', () => {
  const s = act(founded(), removeAsset(miner(3)), grantMiner());
  assert.equal(newest(s), miner(16), 'the same number a grant gets with no delete at all');
  assert.deepEqual(guildOf(s).removedAssetHighWater, { miner: 3 });
  // 3 is recorded while 04..16 are live: a legal state, and the invariant agrees.
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the mark only climbs: deleting a lower number after a higher one leaves it where it is', () => {
  let s = act(founded(), removeAsset(miner(15)), removeAsset(miner(14)));
  assert.deepEqual(guildOf(s).removedAssetHighWater, { miner: 15 }, 'not lowered to 14');
  s = act(s, grantMiner());
  assert.equal(newest(s), miner(16));
  // Delete the brand-new top, then everything else: the next miner is still above all of it.
  s = act(s, removeAsset(miner(16)));
  for (let n = 1; n <= 13; n += 1) s = act(s, removeAsset(miner(n)));
  assert.deepEqual(assetIds(s, 'miner'), [], 'no miner left alive');
  s = act(s, grantMiner());
  assert.equal(newest(s), miner(17), 'with no live miner at all, the mark alone keeps 16 retired');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('kinds are separate: a deleted miner does not move factory numbering, and each kind keeps its own mark', () => {
  let s = act(founded(), removeAsset(TOP_MINER), grantFactory());
  assert.equal(newest(s), factory(11), 'factories carry on from their own live max');
  s = act(s, removeAsset(factory(11)), grantFactory());
  assert.equal(newest(s), factory(12));
  assert.deepEqual(guildOf(s).removedAssetHighWater, { miner: 15, factory: 11 });
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a deleted KIT is not recorded — kits number from their own serial, which already never goes back', () => {
  // A human founding already holds its starter kit as `_outpost_01` (design.md §13, 04-10-26), so the
  // granted kit is `_02`. Deleting that TOP kit must not let the next grant reuse its number.
  let s = act(founded(), createGrantKitAction({ guildId: GUILD, systemId: HOME_SYSTEM, kind: 'outpost' }));
  assert.equal(newest(s), `asset_${GUILD}_outpost_02`, 'the grant follows the starter kit');
  s = act(s, removeAsset(`asset_${GUILD}_outpost_02`));
  assert.equal('removedAssetHighWater' in guildOf(s), false);
  s = act(s, createGrantKitAction({ guildId: GUILD, systemId: HOME_SYSTEM, kind: 'outpost' }));
  assert.equal(newest(s), `asset_${GUILD}_outpost_03`, 'the kit serial still moves on');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. determinism (invariant 9) ------------------------------------------------------------------

const SCENARIO = () => [
  removeAsset(TOP_MINER),
  grantMiner(),
  removeAsset(miner(3)),
  removeAsset(factory(10)),
  grantFactory(),
  grantMiner(),
];

test('determinism: a remove-then-grant scenario run twice is byte-identical', () => {
  const run = () => act(founded(), ...SCENARIO());
  assert.equal(hashState(run()), hashState(run()));
});

test('determinism: journalled against a SAVED state, and saved WITH a mark, it restores to the same bytes and ids', () => {
  const start = founded();
  const direct = act(start, ...SCENARIO());
  assert.deepEqual(guildOf(direct).removedAssetHighWater, { miner: 15, factory: 10 });
  // The grants took 16, then factory 11, then 17 — never a deleted number.
  assert.deepEqual(guildOf(direct).assets.slice(-3).map((a) => a.id), [miner(16), factory(11), miner(17)]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-asset-hw-'));
  try {
    // (a) The removes and grants replayed from the journal onto the saved start.
    saveState(start, dir);
    for (const a of SCENARIO()) appendJournal(start.tick, a, dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct));

    // (b) A state saved AFTER a delete carries its mark through the save, so the next grant after the
    //     restore takes the same number it would have taken live — never the deleted one.
    const mid = act(start, removeAsset(TOP_MINER));
    saveState(mid, dir);
    fs.rmSync(path.join(dir, 'journal.jsonl'), { force: true });
    appendJournal(mid.tick, grantMiner(), dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected a load'); });
    assert.deepEqual(guildOf(restored).removedAssetHighWater, { miner: 15 });
    assert.equal(newest(restored), miner(16));
    assert.equal(hashState(restored), hashState(act(mid, grantMiner())));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. the invariant --------------------------------------------------------------------------------

test('invariants: the not-reissued rule fires when the deleted id comes back', () => {
  const s = act(founded(), removeAsset(TOP_MINER));
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // Forge the bug: put miner 15 back, as the old "highest live + 1" would have.
  const bad = structuredClone(s);
  guildOf(bad).assets.push({ id: TOP_MINER, kind: 'miner', systemId: HOME_SYSTEM, maintenanceCondition: 1 });
  const hit = checkInvariants(bad, bad.tick).find((v) => v.rule === 'removed-asset-number-not-reissued');
  assert.deepEqual(hit.detail, { assetId: TOP_MINER, kind: 'miner', removedHighWater: 15 });
  assert.equal(hit.where, `guild:${GUILD}.asset:${TOP_MINER}`);
});

test('invariants: a malformed mark trips the shape rule', () => {
  const s = act(founded(), removeAsset(TOP_MINER));
  const shapeRule = (marks) => {
    const bad = structuredClone(s);
    guildOf(bad).removedAssetHighWater = marks;
    return checkInvariants(bad, bad.tick).some((v) => v.rule === 'removed-asset-high-water-valid');
  };
  for (const marks of [
    { miner: 0 }, { miner: -1 }, { miner: 1.5 }, { miner: '15' }, { miner: null },
    { outpost: 3 }, { gizmo: 3 }, null, [15], 15,
  ]) {
    assert.equal(shapeRule(marks), true, JSON.stringify(marks));
  }
  assert.equal(shapeRule({ miner: 15, factory: 4 }), false, 'a well-formed mark passes');
});

test('invariants: a founded guild stays clean ticking after a delete and a re-grant', () => {
  let s = act(founded(), removeAsset(TOP_MINER), grantMiner(), removeAsset(miner(2)));
  for (let t = 0; t < 5; t += 1) {
    s = tick(s);
    assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
  }
});

// --- 5. the no-op shape ------------------------------------------------------------------------------

test('no-op shape: no delete, no key — and a restored guild keeps its own copy of the mark', () => {
  assert.equal('removedAssetHighWater' in createGuild({ id: 'g', credits: 0, fuelHoard: 0 }), false);
  assert.equal('removedAssetHighWater' in guildOf(founded()), false, 'founding records nothing');
  assert.equal('removedAssetHighWater' in guildOf(act(founded(), grantMiner())), false, 'nor does a grant');
  const handed = { miner: 7 };
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0, removedAssetHighWater: handed });
  assert.deepEqual(g.removedAssetHighWater, { miner: 7 });
  handed.miner = 99;
  assert.equal(g.removedAssetHighWater.miner, 7, 'copied, not aliased');
  // nextAssetNumber reads the mark per kind.
  assert.equal(nextAssetNumber(g, 'miner'), 8);
  assert.equal(nextAssetNumber(g, 'factory'), 1);
});
