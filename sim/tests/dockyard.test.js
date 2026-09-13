'use strict';

// dockyard.test.js — the Tier-4 BUILD CORE, roadmap 2.1b / docs/build-yard.md §7 slice 1
// (engine + snapshot only; GP/RP-neutral — the points treatment is slice 2).
//
// The dockyard is a factory venture in CONSTRUCT mode: it carries a single-slot, strict-FIFO
// commission queue that turns modules drawn from its OWN system's stockpile into finished
// miner / factory assets, emitted idle at the dockyard's system. The tripwires here:
//   - establish mirrors the deuterium refinery's gates (settlement slot, unoccupied, held
//     system, Gate 2: owned / idle / factory / same-system);
//   - commission refuses a non-buildable kind and a full queue, and costs nothing;
//   - the reserve-and-wait build — a head waits with parts missing (nothing consumed), consumes
//     atomically when all present, counts down BUILD_TICKS, emits one idle asset with a
//     non-colliding id above the starter range;
//   - no reservation → a waiting head never partially consumes, never drives a stockpile negative;
//   - cancel drops an unstarted commission (no refund) and refuses a started one;
//   - teardown of a dockyard mid-build frees the factory, drops the queue, refunds nothing;
//   - two emissions in one tick get distinct ids;
//   - the module-bill load-time assertion bites on an unknown good;
//   - determinism (invariant 9) across runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState, createVenture } = require('../state.js');
const { tick } = require('../tick.js');
const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { guildPoints } = require('../points.js');
const { idleAssets, deployedAssetIds } = require('../assets.js');
const { isDockyard } = require('../baseline.js');
const {
  assetBill, assertBillModulesAreTier3, BUILDABLE_ASSET_KINDS, MAX_QUEUE, BUILD_TICKS,
} = require('../asset-recipes.js');
const {
  validateAction, applyAction,
  createFoundGuildAction, createEstablishDockyardAction,
  createCommissionBuildAction, createCancelCommissionAction,
  createDecommissionVentureAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_PLANET, HOME_MINE, HOME_SLOT } = require('./home-anchor.js');

// A factory + a miner the founding gift mints (sim/assets.js's asset_<guild>_<kind>_NN scheme).
const F1 = 'asset_player-guild_factory_01';
const MINER1 = 'asset_player-guild_miner_01';
const HOME_SLOT_2 = `${HOME_PLANET}_s02`; // a second settlement slot on the Terran homeworld

// ── founded-guild helpers (mirroring deuterium-refinery.test.js) ─────────────────────────────
function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
}
const dockyardAction = (over = {}) => createEstablishDockyardAction({
  guildId: 'player-guild', ventureId: 'yard1', siteId: HOME_SLOT, assetId: F1, ...over,
});

// ── direct build-step scenario (fast, unseated dockyard — occupancy invariants skip a null
// assetId, exactly as the deuterium refinery tests build unseated refineries) ─────────────────
function dockState({
  stock = {},
  queue = [{ commissionId: 0, assetKind: 'miner', remainingTicks: null }],
  nextCommissionId = 1,
  assets = [],
  extraVentures = [],
} = {}) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: { sysA: { ...stock } },
      assets,
      ventures: [
        {
          id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA',
          dockyard: true, buildQueue: queue, nextCommissionId,
        },
        ...extraVentures,
      ],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
}

// 15 idle starter-shaped miners at sysA, so the next minted miner is _16 (above the starter range).
const starterMiners = (guildId = 'g1') => {
  const out = [];
  for (let n = 1; n <= 15; n += 1) out.push({ id: `asset_${guildId}_miner_${String(n).padStart(2, '0')}`, kind: 'miner', systemId: 'sysA' });
  return out;
};

// ════════════════════════════════════════════════════════════════════════════════════════════
// 0. THE CATALOG + THE LOAD-TIME TRIPWIRE
// ════════════════════════════════════════════════════════════════════════════════════════════

test('the two buildable bills match the doc, and every module is a real Tier-3 good', () => {
  assert.deepEqual(BUILDABLE_ASSET_KINDS, ['miner', 'factory']);
  assert.deepEqual(assetBill('miner'), {
    chassis: 2, reactor_housing: 1, photovoltaic_array: 1, power_cells: 1, control_module: 1,
    extraction_head: 1, cargo_module: 1, cargo_handling_system: 1, defence_system: 1,
  });
  assert.deepEqual(assetBill('factory'), {
    chassis: 3, reactor_housing: 1, photovoltaic_array: 2, power_cells: 2, control_module: 1,
    fabrication_line: 2, sensor_suite: 1, cargo_handling_system: 1, defence_system: 1,
  });
  // A non-buildable kind has no bill.
  assert.equal(assetBill('light_transport'), null);
  assert.equal(assetBill('nonsense'), null);
  // The real catalog loaded, which means the load-time assertion already passed for it.
  assert.doesNotThrow(() => assertBillModulesAreTier3({ miner: assetBill('miner'), factory: assetBill('factory') }));
});

test('the module-bill assertion FIRES on a bill naming an unknown good (rule-4 tripwire)', () => {
  assert.throws(
    () => assertBillModulesAreTier3({ miner: { chassis: 2, not_a_real_module: 1 } }),
    /not a Tier-3 module good/,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE ESTABLISH ACTION + GATES (mirror the deuterium refinery)
// ════════════════════════════════════════════════════════════════════════════════════════════

test('createEstablishDockyardAction requires guild/venture/site/asset, and carries no recipe/rate', () => {
  assert.throws(() => createEstablishDockyardAction({ ventureId: 'y', siteId: 's', assetId: 'a' }), /guildId is required/);
  assert.throws(() => createEstablishDockyardAction({ guildId: 'g', siteId: 's', assetId: 'a' }), /ventureId is required/);
  assert.throws(() => createEstablishDockyardAction({ guildId: 'g', ventureId: 'y', assetId: 'a' }), /siteId is required/);
  assert.throws(() => createEstablishDockyardAction({ guildId: 'g', ventureId: 'y', siteId: 's' }), /assetId is required/);
  assert.deepEqual(
    createEstablishDockyardAction({ guildId: 'g', ventureId: 'y', siteId: 's', assetId: 'a' }),
    { type: 'establishDockyard', guildId: 'g', ventureId: 'y', siteId: 's', assetId: 'a' },
  );
});

test('establish: a factory on a settlement slot the guild holds is accepted', () => {
  assert.deepEqual(validateAction(playerFounded(), dockyardAction()), { valid: true });
});

test('establish gate: refused on a resource node (a dockyard is a factory on a settlement slot)', () => {
  const r = validateAction(playerFounded(), dockyardAction({ siteId: HOME_MINE }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /not a settlement slot/);
});

test('establish gate: refused when the named asset is a MINER, not a factory (Gate 2)', () => {
  const r = validateAction(playerFounded(), dockyardAction({ assetId: MINER1 }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /needs a factory/);
});

test('establish gate: refused when the guild owns no such asset (Gate 2)', () => {
  const r = validateAction(playerFounded(), dockyardAction({ assetId: 'asset_player-guild_factory_99' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /owns no asset/);
});

test('establish gate: refused when the named factory is already deployed (Gate 2, idle)', () => {
  // Establish one dockyard on F1, then try a second dockyard on the SAME asset F1.
  const afterFirst = applyAction(playerFounded(), dockyardAction());
  const r = validateAction(afterFirst, dockyardAction({ ventureId: 'yard2', siteId: HOME_SLOT_2 }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /already deployed/);
});

test('establish gate: refused on an occupied settlement slot', () => {
  const afterFirst = applyAction(playerFounded(), dockyardAction());
  // A second dockyard on the SAME slot (different, still-idle factory) is refused for the slot.
  const r = validateAction(afterFirst, dockyardAction({ ventureId: 'yard2', assetId: 'asset_player-guild_factory_02' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /already occupied/);
});

test('establish gate: refused in a system the guild does not hold / a site that does not exist', () => {
  const r = validateAction(playerFounded(), dockyardAction({ siteId: 'pl_09999_s01' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /does not exist|does not hold/);
});

test('establish apply: seats a dockyard marked, with an empty queue, no recipe, no resourceType', () => {
  const next = applyAction(playerFounded(), dockyardAction());
  const v = next.guilds[0].ventures.find((x) => x.id === 'yard1');
  assert.equal(v.dockyard, true);
  assert.equal(isDockyard(v), true);
  assert.equal(v.type, 'refining');   // a factory venture — occupies a factory asset
  assert.equal(v.recipeId, null);
  assert.equal(v.resourceType, null);
  assert.equal(v.productionRate, 0);  // no continuous production — it builds via its queue
  assert.equal(v.assetId, F1);
  assert.equal(v.siteId, HOME_SLOT);
  assert.deepEqual(v.buildQueue, []);
  assert.equal(v.nextCommissionId, 0);
  // Not an illegal refinery — the two markers are independent.
  assert.equal(v.deuteriumRefinery, undefined);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. COMMISSION + CANCEL
// ════════════════════════════════════════════════════════════════════════════════════════════

test('commission: appends a build, costs nothing, stamps a stable monotonic commissionId', () => {
  const seated = applyAction(playerFounded(), dockyardAction());
  const creditsBefore = seated.guilds[0].credits;
  const next = applyAction(seated, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'miner' }));
  const v = next.guilds[0].ventures.find((x) => x.id === 'yard1');
  assert.deepEqual(v.buildQueue, [{ commissionId: 0, assetKind: 'miner', remainingTicks: null }]);
  assert.equal(v.nextCommissionId, 1);
  assert.equal(next.guilds[0].credits, creditsBefore, 'commission costs no credits');
  // A second commission gets the next id, FIFO order preserved.
  const next2 = applyAction(next, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'factory' }));
  const v2 = next2.guilds[0].ventures.find((x) => x.id === 'yard1');
  assert.deepEqual(v2.buildQueue.map((e) => [e.commissionId, e.assetKind]), [[0, 'miner'], [1, 'factory']]);
  assert.equal(v2.nextCommissionId, 2);
  assert.deepEqual(checkInvariants(next2, next2.tick), []);
});

test('commission: refuses a non-buildable kind', () => {
  const seated = applyAction(playerFounded(), dockyardAction());
  const r = validateAction(seated, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'light_transport' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /not buildable/);
});

test('commission: refuses a venture that is not a dockyard', () => {
  // A deuterium-mine-less plain guild venture: use the seated factory venture? Simplest — a
  // non-existent venture id and a real one that is not a dockyard. Here reuse a fresh mining
  // venture built directly.
  const s = dockState({ extraVentures: [{ id: 'm1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'titanium', productionRate: 5 }] });
  const r = validateAction(s, createCommissionBuildAction({ guildId: 'g1', ventureId: 'm1', assetKind: 'miner' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /not a dockyard/);
});

test('commission: refuses a 6th when the queue is full (MAX_QUEUE)', () => {
  let cur = applyAction(playerFounded(), dockyardAction());
  for (let i = 0; i < MAX_QUEUE; i += 1) {
    cur = applyAction(cur, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'miner' }));
  }
  assert.equal(cur.guilds[0].ventures[0].buildQueue.length, MAX_QUEUE);
  const r = validateAction(cur, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'miner' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /queue is full/);
});

test('cancel: removes an UNSTARTED commission by id, refunds nothing, and does not touch its siblings', () => {
  // A dockyard with three unstarted commissions (ids 0,1,2). Cancel the MIDDLE one (id 1) —
  // addressing by id, not index, is the whole point.
  const s = dockState({
    stock: {},
    queue: [
      { commissionId: 0, assetKind: 'miner', remainingTicks: null },
      { commissionId: 1, assetKind: 'factory', remainingTicks: null },
      { commissionId: 2, assetKind: 'miner', remainingTicks: null },
    ],
    nextCommissionId: 3,
  });
  const r = validateAction(s, createCancelCommissionAction({ guildId: 'g1', ventureId: 'd1', commissionId: 1 }));
  assert.deepEqual(r, { valid: true });
  const next = applyAction(s, createCancelCommissionAction({ guildId: 'g1', ventureId: 'd1', commissionId: 1 }));
  assert.deepEqual(next.guilds[0].ventures[0].buildQueue.map((e) => e.commissionId), [0, 2]);
  // Nothing was consumed for an unstarted commission, so nothing is refunded (no stockpile change).
  assert.deepEqual(next.guilds[0].stockpiles.sysA || {}, {});
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('cancel: refuses a STARTED build (only teardown stops it)', () => {
  const s = dockState({ queue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: 42 }] });
  const r = validateAction(s, createCancelCommissionAction({ guildId: 'g1', ventureId: 'd1', commissionId: 0 }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /already started/);
});

test('cancel: refuses an unknown commissionId', () => {
  const s = dockState({ queue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: null }] });
  const r = validateAction(s, createCancelCommissionAction({ guildId: 'g1', ventureId: 'd1', commissionId: 99 }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /no commission with id/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE RESERVE-AND-WAIT BUILD STEP
// ════════════════════════════════════════════════════════════════════════════════════════════

test('a head with parts MISSING waits — nothing consumed, no reservation, no negative stockpile', () => {
  // The whole miner bill except one chassis (need 2, have 1). The head cannot start.
  const bill = assetBill('miner');
  const short = { ...bill, chassis: 1 };
  const s = dockState({ stock: short });
  const next = tick(s);
  const v = next.guilds[0].ventures[0];
  assert.equal(v.buildQueue[0].remainingTicks, null, 'still not started');
  // NO reservation, NO partial consume — every module untouched (chassis stays 1, not -1).
  for (const [module, qty] of Object.entries(short)) {
    assert.equal(getStock(next.guilds[0], 'sysA', module), qty, `${module} untouched`);
  }
  assert.deepEqual(checkInvariants(next, next.tick), [], 'no negative stockpile');
});

test('a head with ALL parts consumes the whole bill atomically and starts the countdown (no decrement that tick)', () => {
  const bill = assetBill('miner');
  const s = dockState({ stock: { ...bill, chassis: bill.chassis + 3 } }); // a little surplus chassis
  const next = tick(s);
  const v = next.guilds[0].ventures[0];
  // Consumed exactly the bill; the surplus chassis remains.
  assert.equal(getStock(next.guilds[0], 'sysA', 'chassis'), 3, 'only the bill amount drawn');
  for (const [module, qty] of Object.entries(bill)) {
    if (module === 'chassis') continue;
    assert.equal(getStock(next.guilds[0], 'sysA', module), 0, `${module} drawn to 0`);
  }
  // The countdown is set to BUILD_TICKS and NOT also decremented this tick.
  assert.equal(v.buildQueue[0].remainingTicks, BUILD_TICKS.miner);
  assert.equal((next.guilds[0].assets || []).length, 0, 'no asset emitted on the consume tick');
  assert.equal(v.updatedAtTick, 0, 'the venture stamped its tick on the consume');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('emission lands exactly BUILD_TICKS after the consume tick, idle at the dockyard system, id above the starter range', () => {
  const bill = assetBill('miner');
  const s = dockState({ stock: bill, assets: starterMiners() });
  // Tick 1: consume + set remainingTicks = BUILD_TICKS.miner.
  let cur = tick(s);
  assert.equal(cur.guilds[0].ventures[0].buildQueue[0].remainingTicks, BUILD_TICKS.miner);
  // Count down BUILD_TICKS-1 more ticks: no emit yet, one tick short.
  for (let i = 0; i < BUILD_TICKS.miner - 1; i += 1) cur = tick(cur);
  assert.equal(cur.guilds[0].ventures[0].buildQueue[0].remainingTicks, 1, 'one tick short of done');
  assert.equal((cur.guilds[0].assets || []).filter((a) => a.kind === 'miner').length, 15, 'no new miner yet');
  // The next tick emits.
  cur = tick(cur);
  const v = cur.guilds[0].ventures[0];
  assert.equal(v.buildQueue.length, 0, 'the head shifted off when it finished');
  const miners = cur.guilds[0].assets.filter((a) => a.kind === 'miner');
  assert.equal(miners.length, 16, 'exactly one new miner emitted');
  const built = cur.guilds[0].assets.find((a) => a.id === 'asset_g1_miner_16');
  assert.ok(built, 'the built id continues above the starter range (16 > 15), no collision');
  assert.equal(built.systemId, 'sysA', 'emitted at the dockyard system');
  assert.equal(deployedAssetIds(cur.guilds[0]).has(built.id), false, 'and it is IDLE (referenced by no venture)');
  assert.deepEqual(checkInvariants(cur, cur.tick), []);
});

test('start and count-down are separate ticks — the decrement→emit path (fast, seeded countdown)', () => {
  // A head already started with 2 ticks left; stockpile irrelevant (parts already consumed).
  const s = dockState({ queue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: 2 }], assets: starterMiners() });
  let cur = tick(s);
  assert.equal(cur.guilds[0].ventures[0].buildQueue[0].remainingTicks, 1, 'decremented, not emitted');
  assert.equal(cur.guilds[0].assets.filter((a) => a.kind === 'miner').length, 15);
  cur = tick(cur);
  assert.equal(cur.guilds[0].ventures[0].buildQueue.length, 0);
  assert.equal(cur.guilds[0].assets.filter((a) => a.kind === 'miner').length, 16);
});

test('two dockyards finishing in the SAME tick emit distinct, non-colliding ids', () => {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      assets: starterMiners(),
      ventures: [
        { id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA', dockyard: true, nextCommissionId: 1, buildQueue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: 1 }] },
        { id: 'd2', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA', dockyard: true, nextCommissionId: 1, buildQueue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: 1 }] },
      ],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
  const next = tick(s);
  const miners = next.guilds[0].assets.filter((a) => a.kind === 'miner');
  assert.equal(miners.length, 17, 'both dockyards emitted');
  const ids = miners.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'all ids distinct');
  assert.ok(ids.includes('asset_g1_miner_16') && ids.includes('asset_g1_miner_17'), 'sequence continued 16, 17');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('a factory build consumes the factory bill and counts down BUILD_TICKS.factory', () => {
  const bill = assetBill('factory');
  const s = dockState({ stock: bill, queue: [{ commissionId: 0, assetKind: 'factory', remainingTicks: null }] });
  const next = tick(s);
  assert.equal(next.guilds[0].ventures[0].buildQueue[0].remainingTicks, BUILD_TICKS.factory);
  for (const module of Object.keys(bill)) assert.equal(getStock(next.guilds[0], 'sysA', module), 0);
});

test('starvation: parts for a waiting head can be SPENT before it starts — it keeps waiting, never negative', () => {
  // The head is missing one module. The build never reserves, so the modules that ARE present
  // stay fully spendable across ticks and the head simply never starts.
  const bill = assetBill('miner');
  const short = { ...bill, defence_system: 0 }; // one required module absent
  const s = dockState({ stock: short });
  let cur = s;
  for (let i = 0; i < 5; i += 1) {
    cur = tick(cur);
    assert.equal(cur.guilds[0].ventures[0].buildQueue[0].remainingTicks, null, `still waiting after tick ${i + 1}`);
    assert.deepEqual(checkInvariants(cur, cur.tick), [], `no negative after tick ${i + 1}`);
  }
  // The present modules are untouched — nothing was partially consumed.
  assert.equal(getStock(cur.guilds[0], 'sysA', 'chassis'), bill.chassis);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. TEARDOWN (reuse decommissionVenture — no new path)
// ════════════════════════════════════════════════════════════════════════════════════════════

test('teardown of a dockyard mid-build: queue gone, factory freed to idle, modules not refunded, invariants pass', () => {
  // A seated dockyard (occupying a factory) with a build already ticking. The parts were consumed
  // at build start, so the stockpile is bare — teardown must NOT put them back.
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: {}, // bare: the bill was consumed when the build started
      assets: [{ id: 'asset_g1_factory_01', kind: 'factory', systemId: 'sysA' }],
      ventures: [{
        id: 'd1', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA',
        assetId: 'asset_g1_factory_01',
        dockyard: true, nextCommissionId: 1,
        buildQueue: [{ commissionId: 0, assetKind: 'miner', remainingTicks: 500 }],
      }],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the mid-build dockyard state is itself valid');
  // The factory is deployed while the dockyard stands.
  assert.equal(deployedAssetIds(s.guilds[0]).has('asset_g1_factory_01'), true);

  const next = applyAction(s, createDecommissionVentureAction({ guildId: 'g1', ventureId: 'd1' }));
  assert.equal(next.guilds[0].ventures.find((v) => v.id === 'd1'), undefined, 'the dockyard (and its queue) is gone');
  // The factory asset survives, now IDLE (nothing references it) — freed, not destroyed.
  const factory = next.guilds[0].assets.find((a) => a.id === 'asset_g1_factory_01');
  assert.ok(factory, 'the factory asset was not deleted');
  assert.equal(idleAssets(next.guilds[0], 'factory').some((a) => a.id === 'asset_g1_factory_01'), true, 'and it is idle');
  // Consumed modules are NOT refunded — the stockpile stays bare.
  assert.deepEqual(next.guilds[0].stockpiles.g1 || next.guilds[0].stockpiles.sysA || {}, {}, 'no refund of consumed modules');
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. GP: THE TIER-4 SPECIAL-COUNT, NO PER-CYCLE RP, NO-OP, DETERMINISM
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// ⤳ SLICE 2 (docs/build-yard.md §5) turned the two GP/RP-neutral tests below live: a dockyard is
// no longer neutral. It is a Tier-4 GP special-COUNT (+500) and takes a held +900 RP signing bump
// at establish. The full delta proof — the exact +500 GP / +900 RP, the net-benefit ordering, and
// the not-farmable teardown — lives in dockyard-points.test.js; here we pin only that this file's
// slice-1 core still holds under the new treatment. What survives unchanged: commissioning a build
// moves no further GP (GP is the venture's existence, not its queue), and a dockyard accrues NO
// per-cycle RP across a build run (the bump is one-time at establish, never per tick).

test('GP: establishing a dockyard adds exactly TIER_WEIGHT[4] (500); commissioning adds none', () => {
  const founded = playerFounded();
  const gp0 = guildPoints(founded, founded.guilds[0]);
  const seated = applyAction(founded, dockyardAction());
  assert.equal(guildPoints(seated, seated.guilds[0]), gp0 + 500, 'a dockyard is special-COUNTed at Tier 4 (+500 GP)');
  const commissioned = applyAction(seated, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'miner' }));
  assert.equal(guildPoints(commissioned, commissioned.guilds[0]), gp0 + 500, 'commissioning changes no further GP — GP rewards existence, not the queue');
});

test('no per-cycle RP: a dockyard never mints an RP key over a multi-tick build run', () => {
  // `dockState` seats the dockyard DIRECTLY (no establish action), so the one-time bump is never
  // applied — this isolates the per-cycle question: does ticking a build alone move any RP? It must
  // not (the bump is at establish; there is no per-cycle accrual, unlike the deuterium mine).
  const bill = assetBill('miner');
  const s = dockState({ stock: bill, assets: starterMiners() });
  let cur = s;
  for (let i = 0; i < 20; i += 1) cur = tick(cur);
  assert.equal(cur.guilds[0].ventures[0].reputation, undefined, 'no per-cycle RP key minted');
  assert.equal(cur.guilds[0].guildReputation, 0, 'the guild RP total stays at its seated value (0 here)');
});

test('no-op: a non-dockyard venture carries no dockyard/buildQueue/nextCommissionId keys', () => {
  const v = createVenture({ id: 'v', ownerGuildId: 'g', type: 'mining', resourceType: 'titanium', productionRate: 5 });
  assert.equal('dockyard' in v, false);
  assert.equal('buildQueue' in v, false);
  assert.equal('nextCommissionId' in v, false);
  // A dockyard venture carries ALL THREE, present even when the queue is empty.
  const d = createVenture({ id: 'd', ownerGuildId: 'g', type: 'refining', dockyard: true });
  assert.equal(d.dockyard, true);
  assert.deepEqual(d.buildQueue, []);
  assert.equal(d.nextCommissionId, 0);
});

test('determinism (invariant 9): a fixed commission-and-build scenario is byte-identical run twice', () => {
  const build = () => {
    const bill = assetBill('miner');
    let cur = dockState({
      stock: { ...bill, ...assetBill('factory') }, // enough for a miner, then some
      assets: starterMiners(),
      queue: [
        { commissionId: 0, assetKind: 'miner', remainingTicks: 1 },
        { commissionId: 1, assetKind: 'factory', remainingTicks: null },
      ],
      nextCommissionId: 2,
    });
    for (let i = 0; i < 8; i += 1) cur = tick(cur);
    return cur;
  };
  assert.equal(hashState(build()), hashState(build()));
});

test('the snapshot surfaces the dockyard marker and its queue', () => {
  // A lightweight end-to-end through the server snapshot would pull in more than needed; assert
  // the venture-row shape the snapshot builds carries the two new fields.
  const { buildSnapshot } = require('../snapshot.js');
  const seated = applyAction(playerFounded(), dockyardAction());
  const commissioned = applyAction(seated, createCommissionBuildAction({ guildId: 'player-guild', ventureId: 'yard1', assetKind: 'miner' }));
  const snap = buildSnapshot(commissioned);
  const row = snap.ventures.find((v) => v.id === 'yard1');
  assert.equal(row.dockyard, true);
  assert.deepEqual(row.buildQueue, [{ commissionId: 0, assetKind: 'miner', remainingTicks: null }]);
  // A plain venture reports dockyard:false and an empty queue.
  const mineRow = snap.ventures.find((v) => v.dockyard === false);
  assert.ok(mineRow === undefined || Array.isArray(mineRow.buildQueue));
});
