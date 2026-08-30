'use strict';

// Tests the asset economy, slice 1 (design.md §4, "Asset occupancy — deploy, idle,
// and the build contract", 30-08-26): assets exist as individual entities in a
// per-guild inventory, a founding guild is GIFTED a starter pool, and
// `establishVenture` OCCUPIES an idle asset of the matching kind through three
// gates. Engine-only — no UI, no deploy panel.
//
// Real seed ids used: sys_0002 is a starter-eligible home whose Terran homeworld
// pl_00004 carries exactly 15 resource nodes (pl_00004_n01..n15) and 15 settlement
// slots (pl_00004_s01..s15). sys_0003 is NOT starter-eligible, so no founding guild
// ever claims it — pl_00005_n01 (nitrogen) is a real node in a system the player
// does not hold, which is what gate 3 is tested against.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createState, createAsset } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { hashState } = require('../serialize.js');
const { guildTotals } = require('../stock.js');
const {
  STARTER_MINERS, STARTER_FACTORIES, ASSET_CONDITION_NEW, idleAssets, deployedAssetIds,
} = require('../assets.js');
const {
  intake, validateAction, createFoundGuildAction, createEstablishVentureAction,
} = require('../actions.js');

// A galaxy with the player founded on sys_0002, no ventures yet.
function playerFounded() {
  return advance(createZeroState(), [createFoundGuildAction({
    guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002',
  })]).state;
}
const player = (state) => state.guilds.find((g) => g.id === 'player-guild');
const mineAt = (siteId, over = {}) => createEstablishVentureAction({
  guildId: 'player-guild', ventureId: `mine_${siteId}`, siteId, resourceType: 'titanium', productionRate: 5, ...over,
});
const refineryAt = (siteId, over = {}) => createEstablishVentureAction({
  guildId: 'player-guild', ventureId: `ref_${siteId}`, type: 'refining', siteId, recipeId: 'titanium_alloy', productionRate: 2, ...over,
});

// --- 1. the starter gift ----------------------------------------------------

test('a founded guild receives exactly 15 idle Miners + 10 Factories, all at full condition', () => {
  const s = playerFounded();
  const g = player(s);

  assert.equal(g.assets.length, STARTER_MINERS + STARTER_FACTORIES);
  assert.equal(g.assets.filter((a) => a.kind === 'miner').length, STARTER_MINERS);
  assert.equal(g.assets.filter((a) => a.kind === 'factory').length, STARTER_FACTORIES);
  assert.ok(g.assets.every((a) => a.maintenanceCondition === ASSET_CONDITION_NEW), 'every starter asset is new');

  // ALL IDLE: idleness is derived, so the proof is that nothing references them.
  assert.equal(deployedAssetIds(g).size, 0, 'no venture references any of them');
  assert.equal(idleAssets(g).length, STARTER_MINERS + STARTER_FACTORIES);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('starter asset ids are stable and deterministic across two runs (invariant 9)', () => {
  const a = player(playerFounded()).assets.map((x) => x.id);
  const b = player(playerFounded()).assets.map((x) => x.id);
  assert.deepEqual(a, b, 'the same scenario mints the same ids');
  assert.equal(a[0], 'asset_player-guild_miner_01');
  assert.equal(a[STARTER_MINERS - 1], 'asset_player-guild_miner_15');
  assert.equal(a[STARTER_MINERS], 'asset_player-guild_factory_01');
  assert.equal(new Set(a).size, a.length, 'ids are unique (§15.2)');
});

test('the grant is engine policy, not an action field — the action shape is unchanged', () => {
  const action = createFoundGuildAction({ guildId: 'g', credits: 0, homeSystemId: 'sys_0002' });
  assert.deepEqual(Object.keys(action).sort(), [
    'credits', 'guildId', 'homeSystemId', 'incomeRate', 'influence', 'isBot', 'name', 'type', 'ventures',
  ], 'no asset field was added to the action (like fuelHoard, the gift is the engine\'s)');
});

// --- 2. occupy through the gates --------------------------------------------

test('establishing a mine occupies an idle miner — it is referenced, NOT removed', () => {
  const before = playerFounded();
  const { state: s, results } = intake(before, [mineAt('pl_00004_n01')]);
  assert.equal(results[0].accepted, true);
  const g = player(s);

  assert.equal(g.ventures[0].assetId, 'asset_player-guild_miner_01', 'the deterministic pick is the lowest idle id');
  assert.equal(g.assets.length, STARTER_MINERS + STARTER_FACTORIES, 'OCCUPY, NOT CONSUME — the asset stays owned');
  assert.equal(idleAssets(g, 'miner').length, STARTER_MINERS - 1, 'one fewer idle miner');
  assert.equal(idleAssets(g, 'factory').length, STARTER_FACTORIES, 'the factories are untouched');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a refining venture occupies a factory, and the two pools are independent', () => {
  const { state: s } = intake(playerFounded(), [refineryAt('pl_00004_s01')]);
  const g = player(s);
  assert.equal(g.ventures[0].assetId, 'asset_player-guild_factory_01');
  assert.equal(idleAssets(g, 'factory').length, STARTER_FACTORIES - 1);
  assert.equal(idleAssets(g, 'miner').length, STARTER_MINERS);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('occupying an asset changes no game number — production is what it always was', () => {
  // The pre-slice baseline for this exact venture: establish + the same advance()'s
  // tick extracts one batch of 5 (pinned by establish-venture.test.js since 03-08-26).
  const s = advance(playerFounded(), [mineAt('pl_00004_n01')]).state;
  const g = player(s);
  assert.equal(guildTotals(g).titanium, 5, 'output is byte-for-byte the pre-asset baseline');
  assert.equal(g.credits, 120, 'and the deploy moved no credits');
  assert.equal(g.fuelHoard, 0, 'and no fuel');
});

test('two deploys take two different machines, lowest id first', () => {
  let s = playerFounded();
  ({ state: s } = intake(s, [mineAt('pl_00004_n01'), mineAt('pl_00004_n02')]));
  const ids = player(s).ventures.map((v) => v.assetId);
  assert.deepEqual(ids, ['asset_player-guild_miner_01', 'asset_player-guild_miner_02']);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. each gate rejects ----------------------------------------------------

test('GATE 1 — an already-occupied node is refused, and the state is untouched', () => {
  const { state: s } = intake(playerFounded(), [mineAt('pl_00004_n01')]);
  const before = hashState(s);
  const v = validateAction(s, mineAt('pl_00004_n01', { ventureId: 'other' }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /already occupied/);
  assert.equal(hashState(s), before, 'validation is pure — a refusal moves nothing');
});

test('GATE 2 — with every Factory deployed, an eleventh refinery is refused', () => {
  let s = playerFounded();
  // sys_0002 has 15 settlement slots but the starter gift holds only 10 factories,
  // so the machines run out before the slots do — which is the scarcity §4 wants.
  for (let n = 1; n <= STARTER_FACTORIES; n += 1) {
    const slot = `pl_00004_s${String(n).padStart(2, '0')}`;
    const { state: next, results } = intake(s, [refineryAt(slot)]);
    assert.equal(results[0].accepted, true, `refinery ${n} should deploy`);
    s = next;
  }
  assert.equal(idleAssets(player(s), 'factory').length, 0, 'the factory pool is exhausted');

  const before = hashState(s);
  const v = validateAction(s, refineryAt('pl_00004_s11')); // a VACANT slot in a HELD system
  assert.equal(v.valid, false, 'gate 1 and gate 3 both pass — only gate 2 bites');
  assert.match(v.reason, /no idle factory/);
  assert.equal(hashState(s), before);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('GATE 3 — a node in a system the guild does not hold is refused', () => {
  const s = playerFounded();
  const before = hashState(s);
  // pl_00005_n01 is a real nitrogen node in sys_0003, which is not starter-eligible
  // and so is claimed by nobody. Before this slice establish never asked.
  const v = validateAction(s, createEstablishVentureAction({
    guildId: 'player-guild', ventureId: 'trespass', siteId: 'pl_00005_n01', resourceType: 'nitrogen', productionRate: 5,
  }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /does not hold system "sys_0003"/);
  assert.equal(hashState(s), before);
});

test('GATE 2 races like GATE 1 does: two deploys for the LAST free machine, first-valid-wins', () => {
  // A guild holding exactly one idle miner, built directly (no founding grant).
  const s = createState({
    guilds: [{
      id: 'player-guild', credits: 0, fuelHoard: 0, homeSystemId: 'sys_0002', homePlanetId: 'pl_00004',
      assets: [{ id: 'asset_solo', kind: 'miner' }],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [{
      claimId: 'claim_home_player-guild', ownerGuildId: 'player-guild',
      landmarkId: 'sys_0002', landmarkKind: 'system', claimedAtTick: 0, contested: false,
    }],
  });
  const { state: after, results } = intake(s, [mineAt('pl_00004_n01'), mineAt('pl_00004_n02')]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /no idle miner/);
  assert.equal(player(after).ventures.length, 1);
  assert.deepEqual(checkInvariants(after, after.tick), []);
});

// --- 4. kind matching --------------------------------------------------------

test('a mining venture cannot occupy a Factory, and a refining venture cannot occupy a Miner', () => {
  // A guild with factories only: the mine is refused, the refinery lands.
  const factoriesOnly = createState({
    guilds: [{
      id: 'player-guild', credits: 0, fuelHoard: 0, homeSystemId: 'sys_0002', homePlanetId: 'pl_00004',
      assets: [{ id: 'asset_f1', kind: 'factory' }],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [{ claimId: 'c', ownerGuildId: 'player-guild', landmarkId: 'sys_0002', landmarkKind: 'system', claimedAtTick: 0, contested: false }],
  });
  const mine = validateAction(factoriesOnly, mineAt('pl_00004_n01'));
  assert.equal(mine.valid, false);
  assert.match(mine.reason, /no idle miner/, 'a factory is not a miner, however idle it is');
  assert.equal(validateAction(factoriesOnly, refineryAt('pl_00004_s01')).valid, true);

  // ...and the mirror: a guild with miners only cannot deploy a refinery.
  const minersOnly = JSON.parse(JSON.stringify(factoriesOnly));
  minersOnly.guilds[0].assets = [{ id: 'asset_m1', kind: 'miner', maintenanceCondition: 1 }];
  const ref = validateAction(minersOnly, refineryAt('pl_00004_s01'));
  assert.equal(ref.valid, false);
  assert.match(ref.reason, /no idle factory/);
});

// --- 5. the invariant bites --------------------------------------------------

// A legal, hand-built state: two assets, one deployed to a matching venture, one idle.
function assetState() {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      assets: [{ id: 'a_mine', kind: 'miner' }, { id: 'a_fact', kind: 'factory' }],
      ventures: [{
        id: 'v1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA',
        resourceType: 'titanium', productionRate: 5, assetId: 'a_mine',
      }],
    }, {
      id: 'g2', credits: 0, fuelHoard: 0, assets: [{ id: 'a_other', kind: 'miner' }],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const ruleNames = (state) => checkInvariants(state, state.tick).map((v) => v.rule);

test('a legal deployed/idle mix passes checkAssetOccupancy', () => {
  const s = assetState();
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // ...and so does an ASSET-LESS venture: the null assetId is a legal state (§4),
  // which is what keeps directly-constructed test ventures valid.
  delete s.guilds[0].ventures[0].assetId;
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the invariant enforces integrity, not presence');
});

test('a venture pointing at ANOTHER guild\'s asset is caught', () => {
  const s = assetState();
  s.guilds[0].ventures[0].assetId = 'a_other'; // owned by g2
  assert.deepEqual(ruleNames(s), ['venture-asset-owned-by-same-guild']);
});

test('a venture pointing at an asset that exists nowhere is caught', () => {
  const s = assetState();
  s.guilds[0].ventures[0].assetId = 'a_ghost';
  assert.deepEqual(ruleNames(s), ['venture-asset-owned-by-same-guild']);
});

test('one machine, two ventures is caught', () => {
  const s = assetState();
  s.guilds[0].ventures.push({
    id: 'v2', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA',
    resourceType: 'titanium', productionRate: 5, assetId: 'a_mine', batchCarry: {},
  });
  assert.ok(ruleNames(s).includes('one-venture-per-asset'));
});

test('a kind mismatch (a mining venture running a Factory) is caught', () => {
  const s = assetState();
  s.guilds[0].ventures[0].assetId = 'a_fact';
  assert.deepEqual(ruleNames(s), ['venture-asset-kind-matches']);
});

test('an out-of-scale maintenanceCondition is caught (§15.2 field check)', () => {
  for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
    const s = assetState();
    s.guilds[0].assets[0].maintenanceCondition = bad;
    assert.ok(ruleNames(s).includes('asset-condition-in-range'), `condition ${String(bad)} should be caught`);
  }
});

test('an unknown asset kind is caught', () => {
  const s = assetState();
  s.guilds[0].assets[1].kind = 'droid';
  assert.ok(ruleNames(s).includes('asset-kind-known (assets.js)'));
});

// --- 6. inline-founding ventures occupy too ----------------------------------

test('a founding\'s inline ventures each occupy a starter asset of their matching kind', () => {
  const s = advance(createZeroState(), [createFoundGuildAction({
    guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002',
    ventures: [
      { id: 'tmine', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 },
      { id: 'cmine', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00004_n08', resourceType: 'carbon_products', productionRate: 5 },
      { id: 'ref', ownerGuildId: 'player-guild', type: 'refining', siteId: 'pl_00004_s01', recipeId: 'titanium_alloy', productionRate: 2 },
    ],
  })]).state;
  const g = player(s);
  assert.deepEqual(g.ventures.map((v) => v.assetId), [
    'asset_player-guild_miner_01', 'asset_player-guild_miner_02', 'asset_player-guild_factory_01',
  ], 'assigned in the founding\'s own venture order, from the pool it was just granted');
  assert.equal(idleAssets(g, 'miner').length, STARTER_MINERS - 2);
  assert.equal(idleAssets(g, 'factory').length, STARTER_FACTORIES - 1);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a founding carrying more ventures of a kind than the gift holds is refused LOUDLY', () => {
  const ventures = [];
  for (let n = 1; n <= STARTER_FACTORIES + 1; n += 1) {
    ventures.push({
      id: `ref_${n}`, ownerGuildId: 'g', type: 'refining',
      siteId: `pl_00004_s${String(n).padStart(2, '0')}`, recipeId: 'titanium_alloy', productionRate: 1,
    });
  }
  const v = validateAction(createZeroState(), createFoundGuildAction({
    guildId: 'g', credits: 0, homeSystemId: 'sys_0002', ventures,
  }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /starter gift holds only 10 factory assets/);
});

// --- 7. snapshot surface -----------------------------------------------------

test('the snapshot reports each asset and whether it is deployed or idle', () => {
  const { state: s } = intake(playerFounded(), [mineAt('pl_00004_n01')]);
  const g = buildSnapshot(s).guilds[0];

  assert.equal(g.assets.length, STARTER_MINERS + STARTER_FACTORIES);
  const deployed = g.assets.filter((a) => a.deployedToVentureId !== null);
  assert.deepEqual(deployed, [{
    id: 'asset_player-guild_miner_01',
    kind: 'miner',
    maintenanceCondition: ASSET_CONDITION_NEW,
    deployedToVentureId: 'mine_pl_00004_n01',
  }], 'the engine answers idle-vs-deployed so the client never recomputes it');
  assert.equal(g.assets.filter((a) => a.deployedToVentureId === null).length, STARTER_MINERS + STARTER_FACTORIES - 1);
  // The same fact from the venture's end.
  assert.equal(buildSnapshot(s).ventures[0].assetId, 'asset_player-guild_miner_01');
  // Mutating the snapshot cannot reach back into engine state.
  g.assets[0].maintenanceCondition = 0;
  assert.equal(player(s).assets[0].maintenanceCondition, ASSET_CONDITION_NEW);
});

// --- 8. persistence + determinism --------------------------------------------

test('a state with idle AND deployed assets round-trips through serialization unchanged', () => {
  const { state: s } = intake(playerFounded(), [mineAt('pl_00004_n01'), refineryAt('pl_00004_s01')]);
  const restored = JSON.parse(JSON.stringify(s)); // what persist.js's save/load does
  assert.deepEqual(restored, s);
  assert.equal(hashState(restored), hashState(s));
  assert.deepEqual(checkInvariants(restored, restored.tick), []);
});

test('a twice-run scenario carrying assets is byte-identical (invariant 9)', () => {
  const run = () => {
    let s = advance(createZeroState(), [createFoundGuildAction({
      guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002',
    })]).state;
    s = advance(s, [mineAt('pl_00004_n01'), refineryAt('pl_00004_s01')]).state;
    return advance(s, []).state;
  };
  assert.equal(hashState(run()), hashState(run()));
});

test('a guild with NO assets carries no key at all (the omit-when-empty no-op)', () => {
  const bare = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.equal('assets' in bare.guilds[0], false, 'no assets key => byte-identical to pre-slice state');
  assert.equal(createAsset({ id: 'a', kind: 'miner' }).maintenanceCondition, ASSET_CONDITION_NEW);
  assert.throws(() => createAsset({ kind: 'miner' }), /id is required/);
  assert.throws(() => createAsset({ id: 'a' }), /kind is required/);
});
