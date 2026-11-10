'use strict';

// droid-system-loss.test.js — DROIDS AND LOSING A SYSTEM (roadmap 2.6; docs/droids.md §14, RULED 07-11-26).
// Droids are system-local (§1), so when a guild loses a system its droids there go with it:
//   1. THE DESTRUCTION: evictSystem removes every droid of the guild standing in the lost system — deployed and idle
//      alike — from guild.droids. Destroyed, never stranded; nothing minted; the serial kept. Droids elsewhere stay.
//   2. CONSERVATION: the eviction with droids equals the eviction without them, bar the droid rows and the notice's
//      new field — no credit, fuel, GP or RP moves because of a droid. The goods forfeit (droid_components included)
//      is the existing rule.
//   3. THE NOTICE: the one system_lost names the destroyed droids (`destroyedDroidIds`), omitted when none.
//   4. NO INHERITANCE: a rival claiming the fallow system gets no droid; the old owner re-claiming it gets none back.
//   5. THE FORFEIT: a Syndicate batch bound for the system, lost before it lands, mints nothing and reverses nothing.
//   6. DETERMINISM (invariant 9): both run byte-identically twice and across a save / restore.
//   7. THE TRIPWIRES: checkDroids halts on a stranded droid, a droid in a lost (salvage-window) system and a droid in
//      a rival's system.
//   8. BYTE-IDENTITY: where nothing is lost with a droid in it, the galaxy hashes as it did at 1cfea14.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { guildHolds } = require('../claims.js');
const { getSystemLayout } = require('../seed.js');
const { DROID_COMPONENTS } = require('../droids.js');
const {
  createGrantDroidAction, createGrantAssetAction, createEstablishVentureAction, createApplyForLicenceAction,
  createAssignDroidAction, createAdjustGoodsAction, createAbandonPrefectureAction, createBuyDroidBatchAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const { heldLanding, droidlessLoss } = require('./droid-loss-noop-script.js');

const { HOME, TARGET, PLANET_A, SLOT_A1, accept, ticks, tickUntil } = P;

const PREFECTURE = 'prefecture_g1_01';
const NODE = getSystemLayout(TARGET).planets.flatMap((p) => p.resourceNodes).find((n) => n.resourceType !== 'deuterium');
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const droidsOf = (s, guildId = 'g1') => guildOf(s, guildId).droids || [];
const inSystem = (s, systemId, guildId = 'g1') => droidsOf(s, guildId).filter((d) => d.systemId === systemId);
const abandon = () => createAbandonPrefectureAction({ guildId: 'g1', prefectureId: PREFECTURE });
const lostNotice = (s) => guildOf(s, 'g1').events.filter((e) => e.type === 'system_lost').slice(-1)[0];
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));

// planted() -> g1 holds TARGET (a ferried kit planted on SLOT_A1), with credits and fuel to spare.
function planted() {
  let { s, kitId } = P.ferried({ credits: 1_000_000 });
  s = P.survey(s, 'g1', PLANET_A);
  return accept(s, P.plant('g1', kitId, SLOT_A1));
}

// droided() -> g1 holds TARGET with a LICENSED mine (m1) staffed by 2 guild droids and 1 Syndicate droid, 2 more
// droids idle there (one of each source), 2 guild droids idle at HOME (which must survive), and droid_components in
// TARGET's pool — run 30 ticks so the deployed droids have really worn. Nothing of it is lost yet.
function droided() {
  let s = planted();
  s = accept(s, createGrantAssetAction({ guildId: 'g1', kind: 'miner', systemId: TARGET }));
  const miner = guildOf(s, 'g1').assets.filter((a) => a.kind === 'miner' && a.systemId === TARGET).slice(-1)[0].id;
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm1', type: 'mining', siteId: NODE.id, assetId: miner, resourceType: NODE.resourceType }));
  s = accept(s, createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm1', committedOutputPct: 0.5, windowDays: 7 }));
  s = accept(s, createGrantDroidAction({ systemId: HOME.id, source: 'guild', count: 2 }));
  s = accept(s, createGrantDroidAction({ systemId: TARGET, source: 'guild', count: 3 }));
  s = accept(s, createGrantDroidAction({ systemId: TARGET, source: 'syndicate', count: 2 }));
  const target = inSystem(s, TARGET);
  // Deploy guild #1, guild #2 and Syndicate #1 to m1; guild #3 and Syndicate #2 stay idle.
  const guildIds = target.filter((d) => d.source === 'guild').map((d) => d.id);
  const syndIds = target.filter((d) => d.source === 'syndicate').map((d) => d.id);
  for (const droidId of [guildIds[0], guildIds[1], syndIds[0]]) {
    s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId, ventureId: 'm1' }));
  }
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: TARGET, good: DROID_COMPONENTS, delta: 7 }));
  return ticks(s, 30);
}

// lost() -> droided(), then g1 abandons TARGET. `before` is the galaxy the abandon was applied to.
function lost() {
  const before = droided();
  return { before, s: accept(before, abandon()) };
}

// --- 1. the destruction ----------------------------------------------------------------------------------------

test('THE DESTRUCTION — every droid of g1 in the lost system, deployed and idle, is gone; HOME\'s droids are untouched; the serial is kept', () => {
  const { before, s } = lost();
  const target = inSystem(before, TARGET);
  assert.equal(target.length, 5, 'premise: five droids in TARGET');
  assert.equal(target.filter((d) => d.assignedToVentureId === 'm1').length, 3, 'premise: three of them deployed');
  assert.ok(target.filter((d) => d.assignedToVentureId === 'm1').every((d) => d.condition < 1), 'premise: the deployed ones have worn');
  assert.deepEqual(inSystem(s, TARGET), [], 'none left in TARGET');
  assert.deepEqual(inSystem(s, HOME.id), inSystem(before, HOME.id), 'the HOME droids are byte-unchanged');
  assert.equal(guildOf(s, 'g1').droidSerial, guildOf(before, 'g1').droidSerial, 'nothing minted, the serial never goes back');
  assert.equal(guildHolds(s, 'g1', TARGET), false, 'premise: TARGET is lost');
  // Destroyed, NOT stranded: no droid anywhere carries the flag, and the salvage machinery lists only the miner.
  for (const g of s.guilds) for (const d of g.droids || []) assert.equal('stranded' in d, false, `${d.id} not stranded`);
  assert.equal(lostNotice(s).payload.strandedAssetIds.some((id) => id.includes('_droid_')), false);
});

test('THE DESTRUCTION — the last droid gone takes the `droids` key with it (omit-when-empty, as a §5 death does)', () => {
  let s = planted();
  s = accept(s, createGrantDroidAction({ systemId: TARGET, source: 'guild', count: 2 }));
  s = accept(s, abandon());
  assert.equal('droids' in guildOf(s, 'g1'), false);
  assert.equal(guildOf(s, 'g1').droidSerial, 2, 'the serial stays');
  assert.deepEqual(lostNotice(s).payload.destroyedDroidIds, ['asset_g1_droid_01', 'asset_g1_droid_02']);
});

// --- 2. conservation -------------------------------------------------------------------------------------------

test('CONSERVATION — the eviction with droids equals the same eviction without them, bar the droid rows and the notice field', () => {
  const { before, s } = lost();
  // The twin: the same galaxy with g1's TARGET droids simply removed before the abandon. Every other effect of the
  // eviction — the closures, the lockout, the stranding, the forfeit, the RP, the credits, the fuel — must match.
  const twinBefore = clone(before);
  const g1 = guildOf(twinBefore, 'g1');
  g1.droids = g1.droids.filter((d) => d.systemId !== TARGET);
  const twin = accept(twinBefore, abandon());
  const real = clone(s);
  delete lostNotice(real).payload.destroyedDroidIds;
  assert.equal(hashState(real), hashState(twin));
  // And the conserved quantities, spelled out (invariants 1–2).
  assert.equal(guildOf(s, 'g1').credits, guildOf(before, 'g1').credits, 'credits');
  assert.equal(s.syndicate.ledger, before.syndicate.ledger, 'Syndicate ledger');
  assert.equal(guildOf(s, 'g1').fuelHoard, guildOf(before, 'g1').fuelHoard, 'fuel');
  assert.equal(s.audit.totalConsumed, before.audit.totalConsumed, 'fuel consumed');
});

test('GOODS — TARGET\'s droid_components go with the rest of its pool (the existing forfeit, no special handling)', () => {
  const { before, s } = lost();
  const had = guildOf(before, 'g1').stockpiles[TARGET][DROID_COMPONENTS];
  assert.ok(had > 0, 'premise: components were in the TARGET pool');
  assert.equal(TARGET in guildOf(s, 'g1').stockpiles, false, 'the pool is gone');
  assert.equal(lostNotice(s).payload.goodsForfeit[DROID_COMPONENTS], had, 'named in the forfeit like any good');
});

// --- 3. the notice ---------------------------------------------------------------------------------------------

test('THE NOTICE — the one system_lost names the destroyed droids, sorted; no new event type; newest in the log', () => {
  const { before, s } = lost();
  const ids = inSystem(before, TARGET).map((d) => d.id).sort();
  const events = guildOf(s, 'g1').events;
  const newOnes = events.slice((guildOf(before, 'g1').events || []).length);
  assert.deepEqual([...new Set(newOnes.map((e) => e.type))].sort(), ['system_lost', 'venture_closed'], 'no droid event type');
  assert.equal(newOnes.filter((e) => e.type === 'system_lost').length, 1, 'exactly one notice');
  assert.equal(events.slice(-1)[0].type, 'system_lost', 'written last, so newest');
  assert.deepEqual(lostNotice(s).payload.destroyedDroidIds, ids);
  assert.equal(lostNotice(s).tick, s.tick, 'stamped with the eviction tick');
});

test('THE NOTICE — a loss with no droid in the system carries no destroyedDroidIds key at all', () => {
  const s = accept(planted(), abandon());
  assert.equal('destroyedDroidIds' in lostNotice(s).payload, false);
});

// --- 4. no inheritance -----------------------------------------------------------------------------------------

test('NO INHERITANCE — a rival claiming the fallow system gets no droid, and its assets_inherited names none', () => {
  const { s: afterLoss } = lost();
  let s = afterLoss;
  let rivalKit;
  ({ s, rivalKit } = S.rivalReady(s));
  s = accept(s, S.rivalPlant(rivalKit));
  assert.equal(guildHolds(s, 'g2', TARGET), true, 'premise: g2 holds it now');
  assert.equal('droids' in guildOf(s, 'g2'), false, 'g2 has no droids');
  assert.deepEqual(inSystem(s, TARGET), [], 'and g1 has none there');
  const inherited = guildOf(s, 'g2').events.find((e) => e.type === 'assets_inherited');
  assert.ok(inherited, 'premise: the stranded miner was swept');
  assert.equal(inherited.payload.inheritedAssetIds.some((id) => id.includes('_droid_')), false);
  ticks(s, 5); // and the galaxy runs on clean (every invariant, every tick)
});

test('NO INHERITANCE — the old owner re-claiming the system gets its machine back, but no droid', () => {
  const { s: afterLoss } = lost();
  let s = afterLoss;
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  assert.deepEqual(inSystem(s, TARGET), []);
});

// --- 5. the in-flight batch forfeit ----------------------------------------------------------------------------

// batchInFlight() -> planted(), a batch of 5 bought to TARGET, then TARGET abandoned before it lands.
function batchInFlight() {
  let s = accept(planted(), createBuyDroidBatchAction({ guildId: 'g1', batch: 5, destinationSystemId: TARGET }));
  const ship = s.shipments.find((x) => x.assetKind === 'droid');
  assert.ok(ship.arrivalTick > s.tick + 1, 'premise: the batch is still in flight');
  const afterBuy = s;
  s = accept(s, abandon());
  return { afterBuy, afterLoss: s, arrivalTick: ship.arrivalTick };
}

test('THE FORFEIT — a batch whose system is lost in flight mints nothing at arrival; the credits and fuel stay spent', () => {
  const { afterBuy, afterLoss, arrivalTick } = batchInFlight();
  // The control: the same buy with no loss lands five droids.
  const landed = tickUntil(afterBuy, (x) => x.tick >= arrivalTick);
  assert.equal(inSystem(landed, TARGET).length, 5, 'control: held, it lands');
  // The loss: the arrival tick passes, the shipment is gone, and nothing was minted.
  const before = tickUntil(afterLoss, (x) => x.tick === arrivalTick - 1);
  const after = ticks(before, 1);
  assert.equal((after.shipments || []).some((x) => x.assetKind === 'droid'), false, 'the delivery resolved');
  assert.equal('droids' in guildOf(after, 'g1'), false, 'no droid minted');
  assert.equal(guildOf(after, 'g1').droidSerial, undefined, 'no serial consumed');
  // Nothing reversed: credits, ledger and fuel as they were the tick before (the buy paid them long ago).
  assert.equal(guildOf(after, 'g1').credits, guildOf(before, 'g1').credits);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger);
  assert.equal(guildOf(after, 'g1').fuelHoard, guildOf(before, 'g1').fuelHoard);
  assert.equal(after.audit.totalConsumed, before.audit.totalConsumed);
  // And the paid price really is gone from the guild (the buy took it; the loss returned none of it).
  assert.equal(guildOf(after, 'g1').credits, guildOf(afterBuy, 'g1').credits);
});

test('THE FORFEIT — the arrival tick is identical to a twin whose shipment was simply removed (the batch moved nothing)', () => {
  const { afterLoss, arrivalTick } = batchInFlight();
  const twin = clone(afterLoss);
  // (Left as an empty list, not deleted: stepArrivals leaves `shipments: []` once its last delivery resolves.)
  twin.shipments = twin.shipments.filter((x) => x.assetKind !== 'droid');
  const a = tickUntil(afterLoss, (x) => x.tick >= arrivalTick);
  const b = tickUntil(twin, (x) => x.tick >= arrivalTick);
  assert.equal(hashState(a), hashState(b));
});

// --- 6. determinism ----------------------------------------------------------------------------------------------

test('DETERMINISM — the droid-destroying abandon and the forfeited batch run byte-identically twice', () => {
  assert.equal(hashState(lost().s), hashState(lost().s));
  const run = () => { const { afterLoss, arrivalTick } = batchInFlight(); return hashState(tickUntil(afterLoss, (x) => x.tick >= arrivalTick + 5)); };
  assert.equal(run(), run());
});

test('DETERMINISM — a save with droids about to be lost, and one with a doomed batch in flight, restore and run on identically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-droid-loss-'));
  try {
    const before = droided();
    saveState(before, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(before));
    assert.equal(hashState(ticks(accept(restored, abandon()), 10)), hashState(ticks(accept(before, abandon()), 10)));

    const { afterLoss, arrivalTick } = batchInFlight();
    saveState(afterLoss, dir);
    const back = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    const until = (x) => x.tick >= arrivalTick + 5;
    assert.equal(hashState(tickUntil(back, until)), hashState(tickUntil(afterLoss, until)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 7. the tripwires --------------------------------------------------------------------------------------------

const rulesOf = (s) => checkInvariants(s, s.tick).map((v) => v.rule);

test('TRIPWIRE — a droid carrying a stranded flag halts (a droid is destroyed with its system, never stranded)', () => {
  const s = clone(droided());
  guildOf(s, 'g1').droids[0].stranded = { tick: s.tick };
  assert.ok(rulesOf(s).includes('droid-never-stranded (docs/droids.md §14)'));
});

test('TRIPWIRE — an eviction that forgot the droids halts: a droid left in the fallow system, under its salvage window', () => {
  const { before, s } = lost();
  const forgot = clone(s);
  const ghost = clone(inSystem(before, TARGET).find((d) => d.assignedToVentureId === undefined));
  guildOf(forgot, 'g1').droids.push(ghost);
  assert.ok(forgot.salvageWindows && forgot.salvageWindows[TARGET], 'premise: the stranded miner opened a window');
  assert.ok(rulesOf(forgot).includes('droid-not-in-a-lost-system (docs/droids.md §14)'));
});

test('TRIPWIRE — a droid of g1 standing in a system the rival now holds halts', () => {
  let s = lost().s;
  let rivalKit;
  ({ s, rivalKit } = S.rivalReady(s));
  s = clone(accept(s, S.rivalPlant(rivalKit)));
  guildOf(s, 'g1').droids.push({ id: 'asset_g1_droid_01', systemId: TARGET, source: 'guild', condition: 1 });
  assert.ok(rulesOf(s).includes('droid-not-in-a-rival-system (docs/droids.md §14)'));
});

// --- 8. byte-identity --------------------------------------------------------------------------------------------

// Recorded at 1cfea14 (the branch base) by running droid-loss-noop-script.js there.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
const NOOP_PINS = {
  heldLanding: {
    tick: 1000,
    state: '8dfd3299dc71e7624774c1f791cf0c07a50fa3df158853a6cf18e455a5ed89dc',
    god: '8f8d5de4afd021c435f731c76fc1a17144da3e8db410661f4e4b650697990086',
    g1: '0305659e639714d9cc3e59d40b8fcbf93a2de9ab7bee98dfb86e8b975d5101a4',
    g2: '680565675a86425c1b73559529740cc532318820d96cc0259ee86edccf8947b5',
  },
  droidlessLoss: {
    tick: 480,
    state: 'd7f19735db6bab85ada7df2084b8a4a03fd0d9e1dbd0a75ba86b2e4a5fe457be',
    god: '3623004088b8fa33927474d7d375fb51173d3653a665ff1c01f8cedd603edcac',
    g1: 'fad56d6f6e2c2546536f5f2167467e18b2eef9b4f2dfa8aeb7a58364f7d69382',
    g2: 'c5ea4c37497e63d0efd476852c8c35656dd4afd60a10853cd071888ba91028d6',
  },
};
const digest = (s) => ({
  tick: s.tick, state: hashState(s), god: sha(buildSnapshot(s)), g1: sha(buildSnapshot(s, 'g1')), g2: sha(buildSnapshot(s, 'g2')),
});

test('BYTE-IDENTICAL — a batch landing in a held system, and a loss with no droid in it, hash exactly as at 1cfea14', () => {
  const landed = heldLanding();
  assert.equal(droidsOf(landed).length, 7, 'premise: the batch of 5 really landed beside the 2 granted');
  assert.deepEqual(digest(landed), NOOP_PINS.heldLanding);
  const lossNoDroid = droidlessLoss();
  assert.equal(guildHolds(lossNoDroid, 'g1', TARGET), false, 'premise: TARGET really was lost');
  assert.equal(inSystem(lossNoDroid, HOME.id).length, 3, 'premise: the HOME droids stood through it');
  assert.deepEqual(digest(lossNoDroid), NOOP_PINS.droidlessLoss);
});
