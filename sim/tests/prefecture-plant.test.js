'use strict';

// prefecture-plant.test.js — THE CLAIM ACT (roadmap 2.5, the first Prefecture / claims slice, engine PR 1;
// docs/territory-model.md §4 "The plant action"; docs/exploration-model.md §8). An idle Prefecture kit, ferried into a
// system's idle list, is planted on a settlement slot there: the kit is consumed, a Prefecture stands on the slot, and
// the guild comes to hold the whole system through one `landmarkKind: 'system'` claim row.
//
// The tripwires:
//   1. THE PLANT: the kit is gone, the Prefecture row and the claim row are exactly what the ruling says, the guild
//      holds the system (guildHolds / heldSystemIds), and nothing priced moved (credits, fuel, ledger, supply).
//   2. GATE 3 OPENS: a factory refused in the unheld system before the plant is accepted after it.
//   3. THE SURVEY GATE (first ENFORCED here): no survey → refused; a different planet surveyed → refused; the planet
//      surveyed → accepted. `knowsSlot` is the read.
//   4. THE REFUSALS, in the ruled order: not an idle Prefecture kit (unknown, a rival's, an Outpost kit, a machine);
//      not a real settlement slot (a node, nothing); the kit in another system; the slot occupied (a venture, another
//      Prefecture); the system held (a rival, itself — including its home); and first-to-plant wins in one batch.
//   5. OCCUPANCY: a planted Prefecture is a NON-VENTURE OCCUPANT — every establish refuses its slot.
//   6. THE SNAPSHOT AND THE VIEWS: a `prefectures` block (omitted while there is none), the slot in `occupancy`; the
//      planter sees its row whole, a rival sees the public allow-list.
//   7. THE INVARIANT FIRES on every corruption it names.
//   8. PERSISTENCE: a journalled plant replays to the same bytes; a saved Prefecture restores.
//   9. THE ROUND TRIP, end to end: build the kit at a dockyard → survey with a real Deep Scan Array → load → ferry →
//      plant → the claim, with conservation checked across it.

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
const { computeOccupancy, siteOccupantOf } = require('../occupancy.js');
const { guildHolds, heldSystemIds, systemHolder } = require('../claims.js');
const { knowsSlot } = require('../exploration.js');
const { PREFECTURE_KIT_KIND, prefectureId, prefectureClaimId } = require('../prefectures.js');
const { INSTALLATION_BILLS, BUILD_TICKS } = require('../asset-recipes.js');
const { getSystemLayout } = require('../seed.js');
const { getStock } = require('../stock.js');
const { kitCount } = require('./kit-fixtures.js');
const {
  intake, createGrantAssetAction, createEstablishVentureAction, createEstablishDockyardAction,
  createEstablishDeuteriumRefineryAction, createCommissionBuildAction, createQueueScanAction, createLoadKitAction,
  createGrantKitAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');

const { accept, refuse, tickUntil, heavyOf, g1Of, HEAVY, HOME, TARGET, AT_TARGET, PLANET_A, PLANET_B, SLOT_A1, SLOT_A2, SLOT_B1 } = P;

// planted() -> the galaxy after g1 ferries a kit to TARGET, surveys PLANET_A, and plants on SLOT_A1.
function planted() {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  const before = s;
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  return { before, s, kitId };
}
// A factory machine granted (operator lever) into `systemId`, and an establish of it on `slotId`.
function factoryAt(s, guildId, systemId) {
  s = accept(s, createGrantAssetAction({ guildId, kind: 'factory', systemId }));
  const guild = s.guilds.find((g) => g.id === guildId);
  return { s, assetId: guild.assets.filter((a) => a.kind === 'factory').slice(-1)[0].id };
}
const establish = (guildId, assetId, slotId) => createEstablishVentureAction({
  guildId, ventureId: `${guildId}_${slotId}`, type: 'refining', siteId: slotId, recipeId: 'titanium_alloy', assetId,
});
const g2Planted = (s) => {
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_A);
  return accept(s, P.plant('g2', kitId, SLOT_A1));
};

// --- 1. the plant ----------------------------------------------------------------------------------------------

test('the plant: the kit is consumed, the Prefecture stands on the slot, the claim row is written — and the guild holds the system', () => {
  const { before, s, kitId } = planted();
  const tick = s.tick;
  assert.equal(PREFECTURE_KIT_KIND, 'prefecture');
  assert.equal((g1Of(s).assets || []).some((a) => a.id === kitId), false, 'the kit is gone from the idle list');
  assert.deepEqual(s.prefectures, [{
    id: prefectureId('g1', 1), ownerGuildId: 'g1', systemId: TARGET, planetId: PLANET_A, slotId: SLOT_A1,
    claimId: prefectureClaimId('g1', 1), plantedAtTick: tick,
  }]);
  assert.equal(prefectureId('g1', 1), 'prefecture_g1_01');
  assert.equal(prefectureClaimId('g1', 1), 'claim_prefecture_g1_01');
  assert.deepEqual(s.claims[s.claims.length - 1], {
    claimId: 'claim_prefecture_g1_01', ownerGuildId: 'g1', landmarkId: TARGET, landmarkKind: 'system', claimedAtTick: tick, contested: false,
  });
  assert.equal(s.claims.length, before.claims.length + 1, 'exactly one claim row');
  assert.equal(g1Of(s).prefectureSerial, 1);
  assert.equal(guildHolds(s, 'g1', TARGET), true);
  assert.deepEqual(heldSystemIds(s, 'g1'), [HOME.id, TARGET].sort());
  assert.equal(systemHolder(s, TARGET), 'g1');
  // Nothing priced moved: a kit is no good and no supply, nor is a flag.
  assert.equal(g1Of(s).credits, g1Of(before).credits);
  assert.equal(g1Of(s).fuelHoard, g1Of(before).fuelHoard);
  assert.equal(s.syndicate.ledger, before.syndicate.ledger);
  assert.deepEqual(computeGalacticSupply(s), computeGalacticSupply(before));
  // Kit conservation: the plant is the one thing that consumes a kit.
  assert.equal(kitCount(s, 'g1').total, kitCount(before, 'g1').total - 1);
});

test('GATE 3 OPENS: a factory refused in the unheld system before the plant is accepted on another slot after it', () => {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  let assetId;
  ({ s, assetId } = factoryAt(s, 'g1', TARGET));
  assert.match(refuse(s, establish('g1', assetId, SLOT_A2)), new RegExp(`does not hold system "${TARGET}" — a venture may only be deployed in a system you hold`));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  s = accept(s, establish('g1', assetId, SLOT_A2));
  assert.equal(g1Of(s).ventures.find((v) => v.siteId === SLOT_A2).systemId, TARGET);
  s = P.ticks(s, 5); // invariants every tick, with a factory beside a flag
});

// --- 2. the survey gate ----------------------------------------------------------------------------------------

test('THE SURVEY GATE: unsurveyed → refused; another planet surveyed → still refused; this planet surveyed → planted', () => {
  let { s, kitId } = P.ferried();
  assert.equal(knowsSlot(g1Of(s), SLOT_A1), false);
  const unsurveyed = `guild "g1" has not surveyed planet "${PLANET_A}" — slot "${SLOT_A1}" is not in its exploration record, and a Prefecture plants only on a planet its guild has surveyed to full L2 (docs/exploration-model.md §8)`;
  assert.equal(refuse(s, P.plant('g1', kitId, SLOT_A1)), unsurveyed);
  s = P.survey(s, 'g1', PLANET_B);
  assert.equal(knowsSlot(g1Of(s), SLOT_B1), true);
  assert.equal(refuse(s, P.plant('g1', kitId, SLOT_A1)), unsurveyed, 'knowing P\'s neighbour Q does not open P');
  s = P.survey(s, 'g1', PLANET_A);
  accept(s, P.plant('g1', kitId, SLOT_A1));
});

test('knowsSlot reads the record\'s slot track only: a node id, a stranger\'s id and a nameless guild are not known slots', () => {
  let { s } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  const g1 = g1Of(s);
  assert.equal(knowsSlot(g1, SLOT_A1), true);
  assert.equal(knowsSlot(g1, SLOT_A2), true, 'a survey reveals the whole surface');
  const node = getSystemLayout(TARGET).planets.find((p) => p.id === PLANET_A).resourceNodes[0];
  if (node) assert.equal(knowsSlot(g1, node.id), false, 'a node is not a slot');
  assert.equal(knowsSlot(g1, 'pl_nope_s01'), false);
  assert.equal(knowsSlot({ id: 'g9' }, SLOT_A1), false);
});

// --- 3. the refusals, in the ruled order -----------------------------------------------------------------------

test('refused — not an idle Prefecture kit: an unknown id, a rival\'s kit, an Outpost kit, a machine', () => {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  assert.equal(refuse(s, P.plant('g1', 'asset_g1_prefecture_99', SLOT_A1)), 'guild "g1" owns no asset "asset_g1_prefecture_99"');
  let rivalKit;
  ({ s, kitId: rivalKit } = P.grantPrefectureKit(s, 'g2', TARGET));
  assert.equal(refuse(s, P.plant('g1', rivalKit, SLOT_A1)), `guild "g1" owns no asset "${rivalKit}"`);
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const outpostKit = g1Of(s).assets.find((a) => a.kind === 'outpost').id;
  assert.equal(refuse(s, P.plant('g1', outpostKit, SLOT_A1)), `asset "${outpostKit}" is a outpost, not a Prefecture kit — only a Prefecture kit is planted`);
  let machine;
  ({ s, assetId: machine } = factoryAt(s, 'g1', TARGET));
  assert.match(refuse(s, P.plant('g1', machine, SLOT_A1)), /is a factory, not a Prefecture kit/);
  assert.match(refuse(s, P.plant('g1', '', SLOT_A1)), /assetId must be a non-empty string/);
  accept(s, P.plant('g1', kitId, SLOT_A1)); // and the real kit still plants
});

test('refused — not a real settlement slot of the kit\'s system: a node, nothing, a slot in another system', () => {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  const node = getSystemLayout(TARGET).planets.flatMap((p) => p.resourceNodes)[0];
  assert.equal(refuse(s, P.plant('g1', kitId, node.id)), `site "${node.id}" is a resource site, not a settlement slot — a Prefecture plants on a settlement slot`);
  assert.equal(refuse(s, P.plant('g1', kitId, 'pl_nope_s01')), 'site "pl_nope_s01" does not exist in the seed');
  assert.match(refuse(s, P.plant('g1', kitId, '')), /slotId must be a non-empty string/);
  // A kit at HOME cannot plant in TARGET: it plants only where it was ferried.
  let homeKit;
  ({ s, kitId: homeKit } = P.grantPrefectureKit(s, 'g1', HOME.id));
  assert.equal(refuse(s, P.plant('g1', homeKit, SLOT_A1)),
    `kit "${homeKit}" sits in system "${HOME.id}" but slot "${SLOT_A1}" is in system "${TARGET}" — a Prefecture plants only in the system its kit sits in; ferry the kit there first (§4)`);
});

test('refused — the slot is occupied (by a rival\'s Prefecture, by a venture) or the system is held (a rival, itself, its home)', () => {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  s = P.survey(s, 'g1', PLANET_B);
  s = g2Planted(s); // g2 holds TARGET now, its flag on SLOT_A1
  let g2Factory;
  ({ s, assetId: g2Factory } = factoryAt(s, 'g2', TARGET));
  s = accept(s, establish('g2', g2Factory, SLOT_A2)); // g2 holds TARGET, so Gate 3 lets it build
  // Occupancy is asked BEFORE the holder: the player learns the slot is taken.
  assert.equal(refuse(s, P.plant('g1', kitId, SLOT_A1)), `site "${SLOT_A1}" is already occupied by Prefecture "prefecture_g2_01" — a settlement slot holds one occupant`);
  assert.equal(refuse(s, P.plant('g1', kitId, SLOT_A2)), `site "${SLOT_A2}" is already occupied by venture "g2_${SLOT_A2}"`);
  assert.equal(refuse(s, P.plant('g1', kitId, SLOT_B1)), `system "${TARGET}" is already held by guild "g2" — a Prefecture plants only in an unclaimed system`);
});

test('refused — one per system: a guild never plants a second in a system it holds, nor in its home', () => {
  let { s } = planted();
  let second;
  ({ s, kitId: second } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = P.survey(s, 'g1', PLANET_B);
  assert.equal(refuse(s, P.plant('g1', second, SLOT_B1)), `guild "g1" already holds system "${TARGET}" — one Prefecture claims a whole system, so a guild never plants one in a system it holds`);
  // Its HOME: held by the founding claim, which has no Prefecture.
  const homePlanet = getSystemLayout(HOME.id).planets.find((p) => p.settlementSlots.length);
  let homeKit;
  ({ s, kitId: homeKit } = P.grantPrefectureKit(s, 'g1', HOME.id));
  s = P.survey(s, 'g1', homePlanet.id);
  assert.match(refuse(s, P.plant('g1', homeKit, homePlanet.settlementSlots[0].id)), new RegExp(`guild "g1" already holds system "${HOME.id}"`));
});

test('first to plant wins: two plants in one batch — the second finds the system held, whichever goes first', () => {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  let g2Kit;
  ({ s, kitId: g2Kit } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_A);
  const a = intake(s, [P.plant('g1', kitId, SLOT_A1), P.plant('g2', g2Kit, SLOT_A2)]);
  assert.deepEqual(a.results.map((r) => r.accepted), [true, false]);
  assert.match(a.results[1].reason, /is already held by guild "g1"/);
  const b = intake(s, [P.plant('g2', g2Kit, SLOT_A2), P.plant('g1', kitId, SLOT_A1)]);
  assert.deepEqual(b.results.map((r) => r.accepted), [true, false]);
  assert.equal(systemHolder(b.state, TARGET), 'g2');
  assert.deepEqual(checkInvariants(a.state, a.state.tick), []);
  assert.deepEqual(checkInvariants(b.state, b.state.tick), []);
});

// --- 4. occupancy ----------------------------------------------------------------------------------------------

test('OCCUPANCY: a planted Prefecture is a non-venture occupant — every establish refuses its slot', () => {
  let { s } = planted();
  assert.equal(computeOccupancy(s)[SLOT_A1], 'prefecture_g1_01');
  assert.deepEqual(siteOccupantOf(s, SLOT_A1), { kind: 'prefecture', id: 'prefecture_g1_01' });
  assert.equal(siteOccupantOf(s, SLOT_A2), null);
  let factory;
  ({ s, assetId: factory } = factoryAt(s, 'g1', TARGET));
  const taken = `site "${SLOT_A1}" is already occupied by Prefecture "prefecture_g1_01" — a settlement slot holds one occupant`;
  assert.equal(refuse(s, establish('g1', factory, SLOT_A1)), taken);
  assert.equal(refuse(s, createEstablishDockyardAction({ guildId: 'g1', ventureId: 'dy', siteId: SLOT_A1, assetId: factory })), taken);
  assert.equal(refuse(s, createEstablishDeuteriumRefineryAction({ guildId: 'g1', ventureId: 'dr', siteId: SLOT_A1, assetId: factory, productionRate: 5 })), taken);
  accept(s, establish('g1', factory, SLOT_A2)); // the slot beside it is free
});

// --- 5. the snapshot and the views -----------------------------------------------------------------------------

test('the snapshot: a `prefectures` block (absent while there is none) and the slot in `occupancy`; the planter sees its row whole, a rival the allow-list', () => {
  const { before, s } = planted();
  assert.equal('prefectures' in buildSnapshot(before), false, 'omitted while no Prefecture stands');
  const row = s.prefectures[0];
  const god = buildSnapshot(s);
  assert.deepEqual(god.prefectures, [row]);
  assert.equal(god.occupancy[SLOT_A1], row.id);
  assert.ok(god.claims.some((c) => c.claimId === row.claimId && c.landmarkId === TARGET));
  const own = buildSnapshot(s, 'g1');
  assert.deepEqual(own.prefectures, [row]);
  assert.equal(own.occupancy[SLOT_A1], row.id);
  const rival = buildSnapshot(s, 'g2');
  assert.deepEqual(rival.prefectures, [row], 'every field of today\'s row is public (fog.js RIVAL_PREFECTURE_FIELDS)');
  assert.equal(rival.occupancy[SLOT_A1], row.id, 'a rival sees the slot is taken');
  // The claimed system's whole surface is public live (exploration-model.md §4 ruling 11) — the rival sees it.
  assert.ok(rival.geography.known[TARGET] && rival.geography.known[TARGET][PLANET_A].slots[SLOT_A1]);
});

// --- 6. the invariant ------------------------------------------------------------------------------------------

test('THE INVARIANT fires on every corruption it names — and is clean on the real thing', () => {
  const { s } = planted();
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const rules = (mutate) => {
    const c = structuredClone(s);
    mutate(c);
    return checkInvariants(c, c.tick).map((v) => v.rule);
  };
  const g1 = (c) => c.guilds.find((g) => g.id === 'g1');
  assert.ok(rules((c) => { c.claims = c.claims.filter((x) => x.claimId !== 'claim_prefecture_g1_01'); }).includes('prefecture-claim-row-exists-once'));
  assert.ok(rules((c) => { c.claims.find((x) => x.claimId === 'claim_prefecture_g1_01').landmarkId = HOME.id; }).includes('prefecture-claim-row-matches'));
  assert.ok(rules((c) => { c.claims.push({ claimId: 'claim_x', ownerGuildId: 'g2', landmarkId: TARGET, landmarkKind: 'system', claimedAtTick: 0, contested: false }); })
    .includes('prefecture-system-claimed-once (territory-model.md §4)'));
  assert.ok(rules((c) => { c.prefectures[0].planetId = PLANET_B; }).includes('prefecture-system-and-planet-match-slot'));
  assert.ok(rules((c) => { c.prefectures[0].slotId = getSystemLayout(TARGET).planets.flatMap((p) => p.resourceNodes)[0].id; })
    .includes('prefecture-on-a-settlement-slot (seed.js)'));
  assert.ok(rules((c) => { c.prefectures[0].plantedAtTick = c.tick + 1; }).includes('prefecture-plantedAtTick-is-a-past-tick (§15.2)'));
  assert.ok(rules((c) => { c.prefectures[0].claimId = 'claim_prefecture_g1_02'; }).includes('prefecture-claimId-shares-its-number (prefectures.js)'));
  assert.ok(rules((c) => { c.prefectures[0].id = 'prefecture_g2_01'; }).includes('prefecture-id-names-its-owner (prefectures.js)'));
  assert.ok(rules((c) => { delete g1(c).prefectureSerial; }).includes('prefecture-serial-monotonic'));
  assert.ok(rules((c) => { delete g1(c).exploration[PLANET_A].slots[SLOT_A1]; }).includes('prefecture-slot-surveyed-by-owner (exploration-model.md §8)'));
  assert.ok(rules((c) => { c.prefectures.push({ ...c.prefectures[0] }); }).includes('prefecture-one-per-system (territory-model.md §4)'));
  assert.ok(rules((c) => { g1(c).ventures.push({ id: 'squat', ownerGuildId: 'g1', type: 'refining', siteId: SLOT_A1, systemId: TARGET, recipeId: 'titanium_alloy', productionRate: 5 }); })
    .includes('prefecture-slot-unshared (design.md §2)'));
  assert.ok(rules((c) => { c.prefectures = []; }).includes('prefectures-is-a-non-empty-array (omit-when-empty)'));
});

// --- 7. persistence --------------------------------------------------------------------------------------------

test('PERSISTENCE: a journalled plant replays to the same bytes, and a saved Prefecture restores through createState', () => {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  const action = P.plant('g1', kitId, SLOT_A1);
  const direct = accept(s, action);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefecture-plant-'));
  try {
    saveState(s, dir);
    appendJournal(s.tick, action, dir);
    const replayed = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(replayed), hashState(direct));
    assert.equal(hashState(P.ticks(replayed, 10)), hashState(P.ticks(direct, 10)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // A scenario / save that hands rows in keeps them, copied (the createOutpost discipline).
  const rebuilt = createState({ ...structuredClone(direct) });
  assert.deepEqual(rebuilt.prefectures, direct.prefectures);
  assert.notEqual(rebuilt.prefectures[0], direct.prefectures[0], 'copied, not aliased');
  // And a galaxy that plants none carries no key at all (omit-when-empty).
  assert.equal('prefectures' in s, false);
});

// --- 8. the round trip -----------------------------------------------------------------------------------------

test('THE ROUND TRIP: dockyard build → a real Deep Scan Array survey → load → ferry → plant → the claim, Gate 3 open, ledger balanced', () => {
  const bill = INSTALLATION_BILLS.prefecture;
  // A dockyard at home stocked with exactly one Prefecture bill, and a Deep Scan Array standing beside home.
  let s = P.kitGalaxy({ fuelHoard: 5_000, stock: { ...bill } });
  s = structuredClone(s);
  s.deepScanArrays = [{ id: 'deepScanArray_g1_01', ownerGuildId: 'g1', coords: { ...P.ATTACHED_HEX }, anchorSystemId: HOME.id, createdAtTick: 0 }];
  g1Of(s).deepScanArraySerial = 1;
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const creditsAndLedger = (x) => x.guilds.reduce((n, g) => n + g.credits, 0) + x.syndicate.ledger;
  const money = creditsAndLedger(s);

  // 1. ACQUIRE — the build consumes exactly the bill and finishes, BUILD_TICKS later, as one idle prefecture kit.
  s = accept(s, createCommissionBuildAction({ guildId: 'g1', ventureId: P.YARD, assetKind: 'prefecture' }));
  s = P.ticks(s, 1);
  // The home pool held exactly one bill, so the build start leaves none of any module: consumed whole, once.
  for (const module of Object.keys(bill)) assert.equal(getStock(g1Of(s), HOME.id, module), 0, `${module} consumed`);
  assert.equal(P.yardOf(s).buildQueue[0].remainingTicks, BUILD_TICKS.prefecture);
  s = tickUntil(s, (x) => (g1Of(x).assets || []).some((a) => a.kind === 'prefecture'), BUILD_TICKS.prefecture + 5);
  const built = g1Of(s).assets.find((a) => a.kind === 'prefecture');
  assert.equal(built.systemId, HOME.id);
  assert.equal((P.yardOf(s).buildQueue || []).length, 0);

  // 2. SURVEY — the array's L1 scan of TARGET, then L2 of the planet: the slot enters the record.
  s = accept(s, createQueueScanAction({ guildId: 'g1', arrayId: 'deepScanArray_g1_01', level: 'L1', targetSystemId: TARGET }));
  s = tickUntil(s, (x) => !x.deepScanArrays[0].scan);
  s = accept(s, createQueueScanAction({ guildId: 'g1', arrayId: 'deepScanArray_g1_01', level: 'L2', targetPlanetId: PLANET_A }));
  s = tickUntil(s, (x) => !x.deepScanArrays[0].scan);
  assert.equal(knowsSlot(g1Of(s), SLOT_A1), true, 'surveyed to full L2');

  // 3. FERRY — load at home, fly to TARGET on an unload route; the kit lands in TARGET's idle list.
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: built.id }));
  s = accept(s, P.unloadRoute(AT_TARGET));
  s = tickUntil(s, (x) => heavyOf(x).status === 'idle');
  const kit = g1Of(s).assets.find((a) => a.kind === 'prefecture' && a.systemId === TARGET);
  assert.ok(kit, 'the kit is idle in TARGET');
  assert.equal(guildHolds(s, 'g1', TARGET), false);

  // 4. PLANT — the claim.
  s = accept(s, P.plant('g1', kit.id, SLOT_A1));
  assert.equal(guildHolds(s, 'g1', TARGET), true, 'g1 holds TARGET');
  assert.equal(s.prefectures[0].slotId, SLOT_A1);
  assert.equal(kitCount(s, 'g1').total, 0, 'the one kit was consumed exactly once');

  // 5. GATE 3 OPENS — a factory in TARGET.
  let factory;
  ({ s, assetId: factory } = factoryAt(s, 'g1', TARGET));
  s = accept(s, establish('g1', factory, SLOT_A2));
  s = P.ticks(s, 10);
  // Invariant 2 held at every tick (advance asserts it); the round trip moved no credit in or out.
  assert.equal(creditsAndLedger(s), money);
});
