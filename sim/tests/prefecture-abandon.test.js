'use strict';

// prefecture-abandon.test.js — LOSING GROUND, the destroyed path, engine PR 1 (design.md §2 "Losing it evicts the
// system"; §19 #67 and #69, RULED 17-10-26; docs/territory-model.md §4 "AS-BUILT — losing ground, engine PR 1").
// The owner abandons one of its Prefectures: it is DESTROYED, the system goes fallow, the guild's ventures there are
// torn down, its machines there are left STRANDED awaiting salvage, and its goods there are forfeit. Its intel stays.
//
// The tripwires:
//   1. THE EVICTION: unclaimed (guildHolds, the control map, the snapshot's controlMap, the slot free, no row left);
//      every venture closed through the shared closure (cause `evicted`, no fee); every machine there stranded —
//      idle, still in that system, tick-stamped — kits included; the pool there gone and Galactic Supply lower by
//      exactly it; the exploration record byte-unchanged; ONE `system_lost` notice with a self-contained payload.
//   2. THE REFUSALS: no guild, no id, no such Prefecture, a rival's, the same one twice; the home (it has no
//      Prefecture — and a corrupt one there is refused and halts the helper); an array bound for the centre.
//   3. NOTHING COMES BACK: no kit is returned, the serial never goes back.
//   4. THE INVARIANT + THE TEMPORARY GUARD: a stranded asset only in an unclaimed system — a rival's plant there is
//      refused, and forcing it past the guard turns the invariant red; the owner's own re-plant recovers its machines.
//   5. THE SNAPSHOT: `stranded` on the guild's own asset rows only; a rival sees no assets.
//   6. BYTE-IDENTITY: a galaxy that never abandons hashes exactly as it did before this slice (pinned goldens).
//   7. PERSISTENCE + DETERMINISM: a journalled abandon replays to the same bytes; a createState hand-in keeps the flag.
//   8. THE SEAMS a lost system now reaches: an array bound for the centre (gated — without the gate its arrival halts);
//      a kit flying home to the lost system ends its lane (no halt); a BUY in flight there is lost on arrival.
//   9. THE OPERATOR CLI against a real server process: exit 0 on an abandon, exit 1 on a refusal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { hashState } = require('../serialize.js');
const { createState } = require('../state.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { checkInvariants } = require('../invariants.js');
const { computeOccupancy } = require('../occupancy.js');
const { guildHolds, heldSystemIds, systemHolder, resolveControl, controlledBy } = require('../claims.js');
const { getSystem, getSystemLayout } = require('../seed.js');
const { hexDistance } = require('../transport.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { evictSystem, strandedAssetsIn } = require('../eviction.js');
const { kitCount } = require('./kit-fixtures.js');
const {
  validateAction, applyAction, intake, createAbandonPrefectureAction, createGrantAssetAction, createGrantKitAction,
  createEstablishVentureAction, createApplyForLicenceAction, createAdjustGoodsAction, createSpawnVehicleAction,
  createLoadKitAction, createDispatchRouteWithActionsAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');

const { accept, refuse, ticks, tickUntil, g1Of, HOME, AT_HOME, TARGET, AT_TARGET, PLANET_A, PLANET_B, SLOT_A1, SLOT_A2, SLOT_B1 } = P;

const PREFECTURE = 'prefecture_g1_01';
const CLAIM = 'claim_prefecture_g1_01';
// A mineable node in TARGET that is not deuterium (deuterium mines take their own licence path) — from the seed.
const NODE = getSystemLayout(TARGET).planets.flatMap((p) => p.resourceNodes).find((n) => n.resourceType !== 'deuterium');
const abandon = (guildId, prefectureId) => createAbandonPrefectureAction({ guildId, prefectureId });
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);

// grantMachine(s, guildId, kind, systemId) -> { s, id }: one idle machine minted by the operator lever (it places
// freely), and its id — the newest of that kind.
function grantMachine(s, guildId, kind, systemId) {
  s = accept(s, createGrantAssetAction({ guildId, kind, systemId }));
  return { s, id: guildOf(s, guildId).assets.filter((a) => a.kind === kind).slice(-1)[0].id };
}

// planted() -> g1 has ferried a kit to TARGET, surveyed PLANET_A, and planted on SLOT_A1: it holds TARGET.
function planted() {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  return accept(s, P.plant('g1', kitId, SLOT_A1));
}

// heldGalaxy() -> g1 holding TARGET with a position worth losing: a LICENSED mine on NODE (m1), a factory on SLOT_A2
// (f1), an idle factory, an idle Outpost kit, goods in its TARGET pool (some produced, some granted) and goods at HOME
// — run on 30 ticks, so the pool is the engine's own.
function heldGalaxy() {
  let s = planted();
  let miner; let factory; let idleFactory;
  ({ s, id: miner } = grantMachine(s, 'g1', 'miner', TARGET));
  ({ s, id: factory } = grantMachine(s, 'g1', 'factory', TARGET));
  ({ s, id: idleFactory } = grantMachine(s, 'g1', 'factory', TARGET));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const outpostKit = g1Of(s).assets.find((a) => a.kind === 'outpost').id;
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm1', type: 'mining', siteId: NODE.id, assetId: miner, resourceType: NODE.resourceType }));
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f1', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' }));
  s = accept(s, createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm1', committedOutputPct: 0.5, windowDays: 7 }));
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: TARGET, good: 'titanium', delta: 40 }));
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: HOME.id, good: 'titanium', delta: 25 }));
  s = ticks(s, 30);
  return { s, miner, factory, idleFactory, outpostKit };
}

// evicted() -> heldGalaxy(), then g1 abandons its Prefecture. `before` is the galaxy the abandon was applied to.
function evicted() {
  const held = heldGalaxy();
  return { ...held, before: held.s, s: accept(held.s, abandon('g1', PREFECTURE)) };
}

// --- 1. the eviction -------------------------------------------------------------------------------------------

test('THE EVICTION — unclaim: the system is unheld, its footprint gone from the control map and the snapshot, the slot free, the row gone, the serial kept', () => {
  const { before, s } = evicted();
  assert.equal(guildHolds(before, 'g1', TARGET), true, 'held before');
  assert.equal(guildHolds(s, 'g1', TARGET), false);
  assert.equal(systemHolder(s, TARGET), null, 'unclaimed — fallow, not passed to anyone');
  assert.deepEqual(heldSystemIds(s, 'g1'), [HOME.id]);
  assert.equal(s.claims.some((c) => c.claimId === CLAIM), false, 'the claim row is gone');
  assert.equal(s.claims.length, before.claims.length - 1, 'exactly that one row');
  assert.equal('prefectures' in s, false, 'the last Prefecture gone, the key goes (omit-when-empty)');
  // The control map: the footprint the claim won is gone, from the engine's map and from every view of it.
  assert.ok(resolveControl(before).some((r) => r.claimId === CLAIM));
  assert.equal(resolveControl(s).some((r) => r.claimId === CLAIM), false);
  assert.equal(controlledBy(s, getSystem(TARGET).coords), null, 'nobody controls the centre now');
  for (const view of [buildSnapshot(s), buildSnapshot(s, 'g1'), buildSnapshot(s, 'g2')]) {
    assert.equal(view.controlMap.some((r) => r.claimId === CLAIM), false);
    assert.equal('prefectures' in view, false);
  }
  // The slot the flag stood on is free (occupancy is derived from the row).
  assert.equal(computeOccupancy(before)[SLOT_A1], PREFECTURE);
  assert.equal(computeOccupancy(s)[SLOT_A1], undefined);
  // Ids are never reused: the serial does not go back.
  assert.equal(g1Of(s).prefectureSerial, 1);
});

test('THE EVICTION — uproot: every venture there is closed through the shared closure (cause "evicted", no fee); every machine there is STRANDED — idle, still in that system, tick-stamped, its condition kept', () => {
  const { before, s, miner, factory, idleFactory, outpostKit } = evicted();
  const tick = s.tick;
  assert.deepEqual(g1Of(s).ventures.map((v) => v.id), [P.YARD], 'm1 and f1 gone; the home yard untouched');
  // The shared closure's notice per venture, cause `evicted`.
  const closed = g1Of(s).events.filter((e) => e.type === 'venture_closed' && e.tick === tick);
  assert.deepEqual(closed.map((e) => [e.payload.ventureId, e.payload.cause]), [['m1', 'evicted'], ['f1', 'evicted']]);
  // RP: the ventures' standing leaves the guild sum with them (checkGuildReputationSum stays exact — accept checked it).
  const rpOf = (x, id) => g1Of(x).ventures.find((v) => v.id === id).reputation || 0;
  assert.equal(g1Of(s).guildReputation, g1Of(before).guildReputation - rpOf(before, 'm1') - rpOf(before, 'f1'));
  // NO settlement fee (the closure's caller charges one; forced closure charges none either) — nothing priced in credits moved.
  assert.equal(g1Of(s).credits, g1Of(before).credits);
  assert.equal(s.syndicate.ledger, before.syndicate.ledger);
  // Every machine in TARGET — the two freed, the one already idle, and the idle kit — is stranded, nothing else.
  const strandedIds = [miner, factory, idleFactory, outpostKit];
  for (const id of strandedIds) {
    const was = g1Of(before).assets.find((a) => a.id === id);
    const now = g1Of(s).assets.find((a) => a.id === id);
    assert.deepEqual(now, { ...was, stranded: { tick } }, `${id}: same kind, same system, same condition — plus the flag`);
    assert.equal(now.systemId, TARGET, 'system-scoped: it keeps its systemId, a system its owner no longer holds');
  }
  assert.deepEqual(strandedAssetsIn(s, TARGET).map((x) => x.assetId).sort(), [...strandedIds].sort());
  assert.equal(g1Of(s).assets.filter((a) => a.systemId !== TARGET).some((a) => 'stranded' in a), false, 'nothing outside TARGET');
  // Idle, in the engine's own words.
  const rows = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1').assets;
  for (const id of strandedIds) assert.equal(rows.find((r) => r.id === id).deployedToVentureId, null);
});

test('THE EVICTION — the licensed mine\'s node lockout comes from the shared closure, unchanged (pinned for the decision checklist)', () => {
  const { before, s } = evicted();
  const m1 = g1Of(before).ventures.find((v) => v.id === 'm1');
  const lockout = (s.nodeLockouts || []).find((l) => l.siteId === NODE.id);
  assert.deepEqual(lockout, { siteId: NODE.id, releaseTick: m1.licence.signedTick + 7 * (before.windowN || 1440), lockedAtTick: before.tick });
  const notice = g1Of(s).events.find((e) => e.type === 'venture_closed' && e.payload.ventureId === 'm1');
  assert.equal(notice.payload.lockoutUntilTick, lockout.releaseTick);
});

test('THE EVICTION — forfeit: the TARGET pool is dropped whole, HOME\'s untouched, and Galactic Supply falls by exactly those goods', () => {
  const { before, s } = evicted();
  const pool = g1Of(before).stockpiles[TARGET];
  const lost = Object.fromEntries(Object.entries(pool).filter(([, q]) => q > 0));
  assert.ok(Object.keys(lost).length >= 2, 'a real pool was there to lose (produced and granted goods)');
  assert.equal(TARGET in g1Of(s).stockpiles, false, 'the system key is gone');
  assert.deepEqual(g1Of(s).stockpiles[HOME.id], g1Of(before).stockpiles[HOME.id]);
  const was = computeGalacticSupply(before).resources;
  const now = computeGalacticSupply(s).resources;
  for (const good of Object.keys(was)) {
    assert.equal(now[good], was[good] - (lost[good] || 0), `${good}: supply lower by exactly the forfeit`);
  }
  assert.deepEqual(s.galacticSupply, computeGalacticSupply(s), 'the cache was refreshed in the same apply');
});

test('THE EVICTION — intel kept: the exploration record is byte-unchanged; the view keeps what was surveyed and loses only what control showed', () => {
  const { before, s } = evicted();
  assert.equal(JSON.stringify(g1Of(s).exploration), JSON.stringify(g1Of(before).exploration));
  const knownBefore = buildSnapshot(before, 'g1').geography.known[TARGET];
  const knownAfter = buildSnapshot(s, 'g1').geography.known[TARGET];
  // What the guild surveyed (PLANET_A, in its record) it still sees, byte for byte.
  assert.deepEqual(knownAfter[PLANET_A], knownBefore[PLANET_A]);
  // The rest it saw only because it CONTROLLED the system (exploration-model.md §4 ruling 11 — control ⇒ full L2,
  // live), and that goes with control: every planet still shown is one in its record.
  for (const planetId of Object.keys(knownAfter)) assert.ok(g1Of(s).exploration[planetId], `${planetId} is in the record`);
  assert.ok(Object.keys(knownBefore).length > Object.keys(knownAfter).length, 'the live control surface lapsed');
});

test('THE EVICTION — one notice: a single `system_lost` with a self-contained payload, newest in the log', () => {
  const { before, s, miner, factory, idleFactory, outpostKit } = evicted();
  const lost = g1Of(s).events.filter((e) => e.type === 'system_lost');
  assert.equal(lost.length, 1);
  const pool = g1Of(before).stockpiles[TARGET];
  const goodsForfeit = Object.fromEntries(Object.keys(pool).sort().filter((g) => pool[g] > 0).map((g) => [g, pool[g]]));
  assert.deepEqual(lost[0], {
    id: g1Of(s).eventSeq - 1, tick: s.tick, type: 'system_lost',
    payload: {
      cause: 'abandoned', prefectureId: PREFECTURE, claimId: CLAIM, systemId: TARGET, systemName: getSystem(TARGET).name,
      planetId: PLANET_A, slotId: SLOT_A1, ventureIds: ['f1', 'm1'],
      strandedAssetIds: [miner, factory, idleFactory, outpostKit].sort(), goodsForfeit,
    },
  });
  // Surfaced read-only through the guild's own notices, newest first.
  const own = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1');
  assert.equal(own.events[0].type, 'system_lost');
});

test('THE EVICTION — every invariant holds every tick after it (advance asserts them), and the stranded machines simply persist', () => {
  let { s } = evicted();
  const strandedAt = s.tick;
  s = ticks(s, 60);
  const flagged = g1Of(s).assets.filter((a) => a.stranded);
  assert.equal(flagged.length, 4, 'no timer lapses them in this slice — the salvage run is the next');
  for (const a of flagged) assert.deepEqual(a.stranded, { tick: strandedAt });
  assert.equal(TARGET in g1Of(s).stockpiles, false, 'nothing produces into the lost system');
});

test('an eviction of an EMPTY position: no ventures, no machines, no goods — the claim still goes and the notice says so', () => {
  let s = planted();
  // The heavy that ferried the kit is still berthed at TARGET; it is a craft, not an asset, and is never stranded.
  const craftBefore = structuredClone(P.heavyOf(s));
  s = accept(s, abandon('g1', PREFECTURE));
  assert.equal(systemHolder(s, TARGET), null);
  const notice = g1Of(s).events.find((e) => e.type === 'system_lost');
  assert.deepEqual([notice.payload.ventureIds, notice.payload.strandedAssetIds, notice.payload.goodsForfeit], [[], [], {}]);
  assert.deepEqual(P.heavyOf(s), craftBefore, 'the craft is untouched — it can fly away');
});

// --- 2. the refusals -------------------------------------------------------------------------------------------

test('refused — no such guild, no id, no such Prefecture, a rival\'s, and the same one twice', () => {
  let s = planted();
  assert.equal(refuse(s, abandon('g9', PREFECTURE)), 'no guild with id "g9"');
  assert.equal(refuse(s, abandon('g1', '')), 'prefectureId must be a non-empty string');
  assert.equal(refuse(s, { type: 'abandonPrefecture', guildId: 'g1' }), 'prefectureId must be a non-empty string');
  assert.equal(refuse(s, abandon('g1', 'prefecture_g1_09')), 'there is no Prefecture "prefecture_g1_09"');
  assert.equal(refuse(s, abandon('g2', PREFECTURE)), `Prefecture "${PREFECTURE}" belongs to guild "g1" — a guild abandons only its own`);
  assert.throws(() => createAbandonPrefectureAction({ guildId: 'g1' }), /prefectureId is required/);
  assert.throws(() => createAbandonPrefectureAction({ prefectureId: PREFECTURE }), /guildId is required/);
  s = accept(s, abandon('g1', PREFECTURE));
  assert.equal(refuse(s, abandon('g1', PREFECTURE)), `there is no Prefecture "${PREFECTURE}"`, 'destroyed is destroyed');
});

test('HOME CANNOT BE ABANDONED: founding gives it no Prefecture to name — and a corrupt Prefecture there is refused, and halts the helper', () => {
  let s = planted();
  // The home has no Prefecture: no row names it, so there is nothing an abandon could name.
  assert.equal(s.prefectures.some((p) => p.systemId === HOME.id), false);
  assert.equal(guildHolds(s, 'g1', HOME.id), true, 'held by the founding claim alone');
  // Asserted, not assumed: hand-corrupt the row into the home (the invariant already flags the state — a second
  // system claim on the home), and the action still refuses, and the helper still will not evict a home.
  const corrupt = structuredClone(s);
  const homePlanet = getSystemLayout(HOME.id).planets.find((p) => p.settlementSlots.length);
  Object.assign(corrupt.prefectures[0], { systemId: HOME.id, planetId: homePlanet.id, slotId: homePlanet.settlementSlots[0].id });
  assert.ok(checkInvariants(corrupt, corrupt.tick).length > 0, 'a Prefecture in its owner\'s home is already a broken state');
  assert.equal(validateAction(corrupt, abandon('g1', PREFECTURE)).reason,
    `Prefecture "${PREFECTURE}" stands in guild "g1"'s home system "${HOME.id}" — a guild is never evicted from its home (design.md §2)`);
  assert.throws(() => evictSystem(corrupt, guildOf(corrupt, 'g1'), corrupt.prefectures[0], 'abandoned', corrupt.tick),
    /a home is never evicted \(design\.md §2\)/);
  assert.equal(guildHolds(corrupt, 'g1', HOME.id), true, 'and the home claim was never touched');
});

test('the helper fails loud on a cause it does not know and on a Prefecture that is not the guild\'s', () => {
  const s = structuredClone(planted());
  assert.throws(() => evictSystem(s, guildOf(s, 'g1'), s.prefectures[0], 'storyteller', s.tick), /unknown cause "storyteller"/);
  assert.throws(() => evictSystem(s, guildOf(s, 'g2'), s.prefectures[0], 'abandoned', s.tick), /belongs to guild "g1", not "g2"/);
  assert.equal(systemHolder(s, TARGET), 'g1', 'nothing was half-applied');
});

// --- 3. nothing comes back -------------------------------------------------------------------------------------

test('NO RECLAIM-TO-KIT: abandoning returns nothing to inventory — no Prefecture kit appears, and the kits there are stranded, not added', () => {
  const { before, s } = evicted();
  assert.deepEqual(kitCount(s, 'g1'), kitCount(before, 'g1'), 'the same kits, no new one');
  assert.equal(g1Of(s).assets.some((a) => a.kind === 'prefecture'), false);
  assert.equal(g1Of(s).assets.length, g1Of(before).assets.length, 'not one asset added or removed');
});

// --- 4. the invariant and the TEMPORARY guard --------------------------------------------------------------------

// fallowWithRivalKit() -> g1 has abandoned TARGET (its machines stranded there), and g2 has a Prefecture kit idle in
// TARGET and has surveyed PLANET_B — every plant gate passes but the TEMPORARY one.
function fallowWithRivalKit() {
  let { s } = evicted();
  let rivalKit;
  ({ s, kitId: rivalKit } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_B);
  return { s, rivalKit };
}

test('THE GUARD (TEMPORARY): a rival may not plant in a fallow system while another guild\'s stranded machines lie there — and the reason names neither', () => {
  const { s, rivalKit } = fallowWithRivalKit();
  const reason = refuse(s, P.plant('g2', rivalKit, SLOT_B1));
  assert.equal(reason, `system "${TARGET}" still holds another guild's stranded machines awaiting salvage — a Prefecture cannot be planted there while they lie there`);
  assert.equal(reason.includes('g1'), false, 'the owner is not named');
  assert.equal(reason.includes('asset_'), false, 'nor the machines');
});

test('THE INVARIANT is red without the guard: forced past it, the plant leaves stranded machines in a held system', () => {
  const { s, rivalKit } = fallowWithRivalKit();
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fallow galaxy itself is sound');
  // applyAction does not validate — this is the plant the guard refuses, applied anyway.
  const forced = applyAction(s, P.plant('g2', rivalKit, SLOT_B1));
  const red = checkInvariants(forced, forced.tick).filter((v) => v.rule === 'stranded-asset-only-in-an-unclaimed-system (design.md §19 #67)');
  assert.equal(red.length, 4, 'one violation per stranded machine');
  assert.deepEqual(red[0].detail.heldBy, 'g2');
  assert.equal(red[0].detail.systemId, TARGET);
});

test('a fallow system with NO stranded machines is open to anyone: the rival plants', () => {
  let s = planted();
  s = accept(s, abandon('g1', PREFECTURE)); // g1 had nothing there to strand
  let rivalKit;
  ({ s, kitId: rivalKit } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_A);
  s = accept(s, P.plant('g2', rivalKit, SLOT_A1)); // the very slot g1's flag stood on — and its id is g2's own
  assert.equal(systemHolder(s, TARGET), 'g2');
  assert.equal(s.prefectures[0].id, 'prefecture_g2_01');
});

test('THE OWNER RE-CLAIMS: its own stranded machines do not block its plant, and the plant recovers them — Gate 3 open again', () => {
  let { s, factory, idleFactory } = evicted();
  let kit;
  ({ s, kitId: kit } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kit, SLOT_A1)); // the survey is still in its record
  assert.equal(systemHolder(s, TARGET), 'g1');
  assert.equal(s.prefectures[0].id, 'prefecture_g1_02', 'a new id — the old one is never reissued');
  assert.equal(s.prefectures[0].claimId, 'claim_prefecture_g1_02');
  assert.equal(g1Of(s).assets.some((a) => 'stranded' in a), false, 'every machine recovered');
  assert.deepEqual(strandedAssetsIn(s, TARGET), []);
  // The recovered machine goes back to work on the same slot.
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f2', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' }));
  assert.equal(g1Of(s).assets.find((a) => a.id === idleFactory).systemId, TARGET);
  s = ticks(s, 5);
});

test('THE INVARIANT fires on every corruption it names — and is clean on the real thing', () => {
  const { s, miner } = evicted();
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const rules = (mutate) => {
    const c = structuredClone(s);
    mutate(c);
    return checkInvariants(c, c.tick).map((v) => v.rule);
  };
  const asset = (c) => guildOf(c, 'g1').assets.find((a) => a.id === miner);
  const shape = 'stranded-asset-flag-is-a-past-tick (§15.2)';
  assert.ok(rules((c) => { asset(c).stranded = { tick: c.tick + 1 }; }).includes(shape), 'a future tick');
  assert.ok(rules((c) => { asset(c).stranded = { tick: -1 }; }).includes(shape), 'a negative tick');
  assert.ok(rules((c) => { asset(c).stranded = { tick: 1.5 }; }).includes(shape), 'a fractional tick');
  assert.ok(rules((c) => { asset(c).stranded = true; }).includes(shape), 'a bare boolean');
  assert.ok(rules((c) => { asset(c).stranded = null; }).includes(shape), 'null');
  assert.ok(rules((c) => { asset(c).stranded = { tick: 1, by: 'g2' }; }).includes(shape), 'an extra key');
  assert.ok(rules((c) => {
    guildOf(c, 'g1').ventures.push({ id: 'ghost', ownerGuildId: 'g1', type: 'mining', siteId: NODE.id, systemId: TARGET, resourceType: NODE.resourceType, productionRate: 1, assetId: miner });
  }).includes('stranded-asset-is-idle (sim/eviction.js)'));
  assert.ok(rules((c) => {
    c.claims.push({ claimId: 'claim_x', ownerGuildId: 'g2', landmarkId: TARGET, landmarkKind: 'system', claimedAtTick: 0, contested: false });
  }).includes('stranded-asset-only-in-an-unclaimed-system (design.md §19 #67)'));
});

// --- 5. the snapshot ---------------------------------------------------------------------------------------------

test('THE SNAPSHOT: `stranded` rides on the guild\'s own asset rows (and the god\'s-eye), copied; a rival sees no assets; unstranded rows carry no key', () => {
  const { s, miner } = evicted();
  const ownRows = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1').assets;
  const row = ownRows.find((r) => r.id === miner);
  assert.deepEqual(row.stranded, { tick: s.tick });
  assert.notEqual(row.stranded, g1Of(s).assets.find((a) => a.id === miner).stranded, 'copied, not aliased');
  assert.deepEqual(buildSnapshot(s).guilds.find((g) => g.id === 'g1').assets.find((r) => r.id === miner).stranded, { tick: s.tick });
  const rivalView = buildSnapshot(s, 'g2').guilds.find((g) => g.id === 'g1');
  assert.equal('assets' in rivalView, false, 'a rival guild row carries no assets (fog.js RIVAL_GUILD_FIELDS)');
  // A machine at home, never stranded, carries no key at all.
  let t = s;
  ({ s: t } = grantMachine(t, 'g1', 'miner', HOME.id));
  const homeRow = buildSnapshot(t, 'g1').guilds.find((g) => g.id === 'g1').assets.find((r) => r.systemId === HOME.id);
  assert.equal('stranded' in homeRow, false);
});

// --- 6. byte-identity ----------------------------------------------------------------------------------------------

// Pinned from `main` at 6bbe114 (before this slice), running the very scenario below: a galaxy that plants, builds,
// produces and never abandons. The state hash and all three views must not move by a byte — `stranded` is
// omit-when-absent, and claims / stockpiles / prefectures are touched only by an abandon.
const GOLDEN_NO_ABANDON = {
  tick: 490,
  state: '79ed47214b47ac8c4454893800b87dd8de128437d7bf129d107015b26090db8c',
  god: '0b4c0ef26fcc7763f3f269b3e9d4fb44b07972f0cd79a839ce2a3acbea9bae5e',
  own: '86b29de3a10c0806ed46bce7244a6b78c263bc1dc4c390bf2674893ca76533fc',
  rival: '8fc7a0530d3d4a4d61d157cd4382f3e7aa22e77a158a65e7d84d8b4b65635618',
};

test('BYTE-IDENTICAL: a galaxy that never abandons serializes exactly as it did before this slice (state and every view)', () => {
  let s = planted();
  let factory;
  ({ s, id: factory } = grantMachine(s, 'g1', 'factory', TARGET));
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f1', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' }));
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: TARGET, good: 'titanium', delta: 40 }));
  s = ticks(s, 40);
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.deepEqual({
    tick: s.tick, state: hashState(s), god: sha(buildSnapshot(s)), own: sha(buildSnapshot(s, 'g1')), rival: sha(buildSnapshot(s, 'g2')),
  }, GOLDEN_NO_ABANDON);
});

// --- 7. persistence and determinism --------------------------------------------------------------------------------

test('PERSISTENCE: a journalled abandon replays to the same bytes (and ticks on identically); a createState hand-in keeps the flag, copied', () => {
  const { s: held } = heldGalaxy();
  const action = abandon('g1', PREFECTURE);
  const direct = accept(held, action);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefecture-abandon-'));
  try {
    saveState(held, dir);
    appendJournal(held.tick, action, dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct));
    assert.equal(hashState(ticks(replayed, 10)), hashState(ticks(direct, 10)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const rebuilt = createState({ ...structuredClone(direct) });
  const was = g1Of(direct).assets.filter((a) => a.stranded);
  const now = g1Of(rebuilt).assets.filter((a) => a.stranded);
  assert.deepEqual(now, was);
  assert.notEqual(now[0].stranded, was[0].stranded, 'copied, not aliased');
});

test('DETERMINISM: the same galaxy and the same abandon give the same bytes, and an abandon racing a plant in one batch resolves first-valid-wins', () => {
  const a = evicted().s;
  const b = evicted().s;
  assert.equal(hashState(a), hashState(b));
  // g1 abandons and g2 plants in ONE batch: in that order the plant finds g1's machines stranded and is refused (the
  // TEMPORARY guard); the other way round the plant finds the system held and is refused. Never both, never a halt.
  let { s } = heldGalaxy();
  let rivalKit;
  ({ s, kitId: rivalKit } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_B);
  const first = intake(s, [abandon('g1', PREFECTURE), P.plant('g2', rivalKit, SLOT_B1)]);
  assert.deepEqual(first.results.map((r) => r.accepted), [true, false]);
  assert.match(first.results[1].reason, /stranded machines awaiting salvage/);
  const second = intake(s, [P.plant('g2', rivalKit, SLOT_B1), abandon('g1', PREFECTURE)]);
  assert.deepEqual(second.results.map((r) => r.accepted), [false, true]);
  assert.match(second.results[0].reason, /already held by guild "g1"/);
  assert.deepEqual(checkInvariants(first.state, first.state.tick), []);
  assert.deepEqual(checkInvariants(second.state, second.state.tick), []);
});

// --- 8. the seams a lost system now reaches ---------------------------------------------------------------------

// secondHeavyAtHome(s) -> `s` with a second empty heavy for g1, idle at HOME, and its id.
function secondHeavyAtHome(s) {
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  return { s, heavy: 'vehicle_g1_heavyTransport_02' };
}

test('SEAM — a Deep Scan Array bound for the system\'s centre: the abandon waits for it (its arrival would otherwise halt), then goes ahead once it has landed', () => {
  let s = planted();
  let heavy;
  ({ s, heavy } = secondHeavyAtHome(s));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'deepScan' }));
  const arrayKit = g1Of(s).assets.find((a) => a.kind === 'deepScan').id;
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: heavy, assetId: arrayKit }));
  s = accept(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: heavy, waypoints: [{ anchor: AT_TARGET, action: { type: 'deploy', kind: 'deepScan' } }],
  }));
  assert.equal(refuse(s, abandon('g1', PREFECTURE)),
    `vehicle "${heavy}" is flying a Deep Scan Array to deploy on the centre of system "${TARGET}", which needs the system held when it lands — let it land, or re-dispatch it, before abandoning the Prefecture`);
  // Without the gate the arrival HALTS: abandon anyway (applyAction does not validate) and fly on.
  const forced = applyAction(s, abandon('g1', PREFECTURE));
  assert.throws(() => tickUntil(forced, (x) => !g1Of(x).vehicles.find((v) => v.id === heavy).route), /deploy on arrival, tick \d+: .*"not-bare-hex" check/);
  // With it: let the craft land and plant the array on the held centre, then abandon. The array stands on.
  s = tickUntil(s, (x) => !g1Of(x).vehicles.find((v) => v.id === heavy).route);
  assert.equal(s.deepScanArrays.length, 1);
  s = accept(s, abandon('g1', PREFECTURE));
  assert.equal(s.deepScanArrays.length, 1, 'a standing structure is not the guild\'s machines in the system — untouched');
  s = ticks(s, 5);
});

test('SEAM — a kit flying HOME to the lost system: on arrival the lane ends `target-gone`, the kit still aboard — no halt, nothing minted', () => {
  let s = planted();
  let heavy;
  ({ s, heavy } = secondHeavyAtHome(s));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'outpost' }));
  const kit = g1Of(s).assets.find((a) => a.kind === 'outpost').id;
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: heavy, assetId: kit }));
  s = accept(s, createDispatchRouteWithActionsAction({ guildId: 'g1', vehicleId: heavy, waypoints: [{ anchor: AT_TARGET, action: { type: 'unload' } }] }));
  s = accept(s, abandon('g1', PREFECTURE)); // an unload is not a centre deploy — no gate
  const craftOf = (x) => g1Of(x).vehicles.find((v) => v.id === heavy);
  s = tickUntil(s, (x) => !craftOf(x).route);
  assert.deepEqual(craftOf(s).location, AT_TARGET);
  assert.deepEqual(craftOf(s).cargo, { outpost_kit: 1 }, 'the kit is safe aboard, never dropped into the lost system');
  assert.equal(craftOf(s).laneEnded.reason, 'target-gone');
  assert.equal((g1Of(s).assets || []).some((a) => a.kind === 'outpost'), false, 'nothing minted there');
});

test('SEAM — a Syndicate BUY in flight to the lost system: lost on arrival by its existing vanish check — no pool re-created there', () => {
  const { createAddOrderLineAction, createBuyFromSyndicateAction, createAdjustCreditsAction } = require('../actions.js');
  let s = planted();
  s = accept(s, createAdjustCreditsAction({ guildId: 'g1', delta: 1_000_000 }));
  s = accept(s, createAddOrderLineAction({ guildId: 'g1', side: 'buy', good: 'titanium', qty: 5 }));
  s = accept(s, createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: TARGET }));
  assert.equal(s.shipments.length, 1, 'a delivery is on its way');
  s = accept(s, abandon('g1', PREFECTURE));
  s = tickUntil(s, (x) => (x.shipments || []).length === 0);
  assert.equal(TARGET in g1Of(s).stockpiles, false, 'nothing deposited into the lost system');
});

// --- 9. the operator CLI, against a real server process ---------------------------------------------------------

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const ADMIN_JS = path.join(__dirname, '..', '..', 'tools', 'admin.js');

// freePort / boot — the boot-test shape in server.test.js: the CLI talks HTTP, so it needs a real listening server.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('THE OPERATOR CLI: abandon-prefecture exits 0 and reports the eviction; a refusal (no such Prefecture, a missing flag, the same one twice) exits 1', async () => {
  const { HOME_SYSTEM } = require('./home-anchor.js');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.STARFARE_TICK_MS;
  delete env.STARFARE_PERSIST_DIR;
  const server = spawn(process.execPath, [SERVER_JS], { env });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => (await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const cli = (...args) => spawnSync(process.execPath, [ADMIN_JS, ...args, '--base', base], { encoding: 'utf8' });
  try {
    for (let i = 0; ; i += 1) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not listening yet */ }
      if (i > 200) throw new Error('the server never answered /health');
      await new Promise((r) => setTimeout(r, 25));
    }
    // A guild at the seed's first starter, and a Prefecture planted in the nearest system with a settlement slot.
    assert.equal((await post('/action', { type: 'foundGuild', guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM, isBot: true })).accepted, true);
    const homeHex = getSystem(HOME_SYSTEM).coords;
    const target = require('../../data/seed.json').systems
      .filter((x) => x.id !== HOME_SYSTEM && getSystemLayout(x.id).planets.some((p) => p.settlementSlots.length))
      .sort((a, b) => hexDistance(a.coords, homeHex) - hexDistance(b.coords, homeHex) || a.id.localeCompare(b.id))[0].id;
    const planet = getSystemLayout(target).planets.find((p) => p.settlementSlots.length);
    const grant = await post('/admin/guild/grant-kit', { guildId: 'player-guild', systemId: target, kind: 'prefecture' });
    const kit = grant.snapshot.guilds[0].assets.find((a) => a.kind === 'prefecture').id;
    await post('/action', { type: 'reveal', guildId: 'player-guild', planetId: planet.id });
    const planted_ = await post('/admin/guild/plant-prefecture', { guildId: 'player-guild', assetId: kit, slotId: planet.settlementSlots[0].id });
    assert.equal(planted_.accepted, true, planted_.reason);
    await post('/action', { type: 'adjustGoods', guildId: 'player-guild', systemId: target, good: 'titanium', delta: 12 });

    // Refusals exit 1, with the engine's own reason on stderr.
    const none = cli('abandon-prefecture', '--guild', 'player-guild', '--id', 'prefecture_player-guild_07');
    assert.equal(none.status, 1);
    assert.match(none.stderr, /abandon-prefecture refused: there is no Prefecture "prefecture_player-guild_07"/);
    const missing = cli('abandon-prefecture', '--guild', 'player-guild');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /abandon-prefecture: --id is required/);

    // The abandon itself: exit 0, the eviction reported from the engine's own notice.
    const ok = cli('abandon-prefecture', '--guild', 'player-guild', '--id', 'prefecture_player-guild_01');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /action\s+abandonPrefecture/);
    assert.match(ok.stdout, new RegExp(`lost\\s+${target} \\(.+\\) — now unclaimed; claim claim_prefecture_player-guild_01 removed`));
    assert.match(ok.stdout, /forfeit\s+titanium 12/);
    assert.match(ok.stdout, new RegExp(`holds\\s+${HOME_SYSTEM}\\n`));
    const snap = await (await fetch(`${base}/snapshot`)).json();
    assert.equal(snap.tick, 0, 'an abandon does not tick');
    assert.equal(snap.claims.some((c) => c.landmarkId === target), false);

    // Twice: the Prefecture is gone, so it is a refusal — exit 1.
    const again = cli('abandon-prefecture', '--guild', 'player-guild', '--id', 'prefecture_player-guild_01');
    assert.equal(again.status, 1);
    assert.match(again.stderr, /there is no Prefecture "prefecture_player-guild_01"/);

    // The endpoint itself: a half body is a 400 (the constructor refuses it).
    const bad = await fetch(`${base}/admin/guild/abandon-prefecture`, { method: 'POST', body: JSON.stringify({ guildId: 'player-guild' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /malformed abandon-prefecture/);
  } finally {
    server.kill('SIGKILL');
  }
});
