'use strict';

// starter-package.test.js — the HUMAN founding starter package (design.md §13 "The human founding
// starter package", RULED 04-10-26; sim/starter-package.js; docs/phase-1-tuning.md "Guild starts").
//
// THE RULING. A guild founded by a human (`isBot === false`) opens on STARTER_HUMAN_CREDITS (8,000,000)
// instead of the founding action's `credits`, and is gifted 1 heavy + 3 light transports and one
// Outpost kit, all idle at its home system. A bot founding (`isBot: true`) is untouched: the passed
// `credits`, no craft, no kit.
//
// The tripwires:
//   1. HUMAN: the credits, the ledger debit (invariant 2), the exact fleet and kit, every invariant;
//   2. THE PACKAGE IS THE ONLY DIFFERENCE: a human founding with the package undone is byte-identical
//      to a bot founding at the same home — fuel, supply, endowment and entitlement are untouched;
//   3. BOT: byte-identical to the bot founding BEFORE this slice (two goldens recorded on main);
//   4. DETERMINISM (invariant 9): two runs agree, and a save/restore gives back the same bytes;
//   5. THE SEQUENCES CONTINUE: a later spawn / grant numbers above the package, never over it;
//   6. THE PACKAGE WORKS: the starter heavy can load the starter kit (only a heavy can);
//   7. `isBot` MUST MEAN WHAT IT SAYS: a non-boolean is refused, not guessed at.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');
const { withoutRecordSlots, stripRecordSlots } = require('./slot-strip.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const {
  intake, validateAction, applyAction,
  createFoundGuildAction, createSpawnVehicleAction, createGrantKitAction, createLoadKitAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');
const { VEHICLE_SPECS } = require('../vehicles.js');
const {
  STARTER_MINERS, STARTER_FACTORIES, ASSET_CONDITION_NEW, deployedAssetIds,
} = require('../assets.js');
const {
  STARTER_HUMAN_CREDITS, STARTER_HEAVY_CONDITION, STARTER_HUMAN_FLEET, STARTER_HUMAN_KITS,
} = require('../starter-package.js');

const GUILD = 'g1';
const HOME = { landmarkKind: 'system', landmarkId: HOME_SYSTEM };

// The package's ids, spelled out once. The heavy is minted first, so it takes serial 01.
const HEAVY_ID = `vehicle_${GUILD}_heavyTransport_01`;
const LIGHT_IDS = [`vehicle_${GUILD}_lightTransport_02`, `vehicle_${GUILD}_lightTransport_03`, `vehicle_${GUILD}_lightTransport_04`];
const KIT_ID = `asset_${GUILD}_outpost_01`;

// Found ONE guild through `intake` — the drain POST /action uses — so the state under test is the
// one that exists BETWEEN ticks, where every invariant must already hold.
function found(over = {}) {
  const action = createFoundGuildAction({ guildId: GUILD, name: 'G1', credits: 2000, influence: 100, homeSystemId: HOME_SYSTEM, ...over });
  const { state, results } = intake(createZeroState(), [action]);
  assert.equal(results[0].accepted, true, `founding refused: ${results[0].reason}`);
  return state;
}
const humanFounded = (over = {}) => found(over);                 // `isBot` absent = human
const botFounded = (over = {}) => found({ isBot: true, ...over });
const guildOf = (state) => state.guilds.find((g) => g.id === GUILD);

// --- 1. a human founding -------------------------------------------------------------------------

test('human: founded on STARTER_HUMAN_CREDITS (8,000,000), not the credits the action passed', () => {
  assert.equal(STARTER_HUMAN_CREDITS, 8_000_000, 'the ruled figure (design.md §13, 04-10-26)');
  const s = humanFounded({ credits: 2000 });
  assert.equal(guildOf(s).isBot, false);
  assert.equal(guildOf(s).credits, STARTER_HUMAN_CREDITS);
  assert.ok(Number.isInteger(guildOf(s).credits), 'integer credits (§15.2)');
});

test('human: the ledger is debited by exactly 8,000,000 and invariant 2 holds', () => {
  const before = createZeroState();
  const s = humanFounded();
  assert.equal(s.syndicate.ledger, before.syndicate.ledger - STARTER_HUMAN_CREDITS, 'the credits MOVED from the ledger');
  assert.equal(s.audit.expectedCreditTotal, before.audit.expectedCreditTotal, 'nothing was minted: the sanctioned total is unchanged');
  assert.equal(guildOf(s).credits + s.syndicate.ledger, s.audit.expectedCreditTotal, 'invariant 2 by hand');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('human: the action\'s own credits make no difference — 0 and 999,999 found the same guild', () => {
  // Engine policy, not an action field: `credits` is still required and validated, but for a human it
  // is not what the guild gets. Two different figures, one identical state.
  assert.equal(hashState(humanFounded({ credits: 0 })), hashState(humanFounded({ credits: 999_999 })));
});

test('human: exactly 1 heavy + 3 light transports, idle at the home system, ids serialled 01..04', () => {
  const g = guildOf(humanFounded());
  assert.deepEqual(g.vehicles.map((v) => v.id), [HEAVY_ID, ...LIGHT_IDS], 'the heavy first, then the three lights');
  assert.deepEqual(g.vehicles.map((v) => v.class), ['heavyTransport', 'lightTransport', 'lightTransport', 'lightTransport']);
  assert.equal(new Set(g.vehicles.map((v) => v.id)).size, 4, 'four distinct ids (§15.2)');
  assert.equal(g.vehicleSerial, 4, 'the guild\'s craft serial sits at the last id it minted');
  for (const v of g.vehicles) {
    assert.equal(v.status, 'idle', `${v.id} is idle`);
    assert.deepEqual(v.location, HOME, `${v.id} is berthed at the home system`);
    assert.equal(v.ownerGuildId, GUILD);
    assert.equal(v.cargo, undefined, `${v.id} carries nothing`);
    assert.equal(v.trip, undefined, `${v.id} is flying no trip`);
    // The stats are the class's own (VEHICLE_SPECS), exactly as spawn / buy / build stamp them.
    const spec = VEHICLE_SPECS[v.class];
    assert.deepEqual(
      { speed: v.speed, capacity: v.capacity, fuelCostToRun: v.fuelCostToRun, defenseRating: v.defenseRating },
      { speed: spec.speed, capacity: spec.capacity, fuelCostToRun: spec.fuelCostToRun, defenseRating: spec.defenseRating },
    );
  }
});

test('human: the heavy starts at the ruled 0.5 condition (territory-model.md §7), the lights new', () => {
  const g = guildOf(humanFounded());
  assert.equal(STARTER_HEAVY_CONDITION, 0.5);
  assert.equal(g.vehicles[0].maintenanceCondition, STARTER_HEAVY_CONDITION);
  assert.deepEqual(g.vehicles.slice(1).map((v) => v.maintenanceCondition), [ASSET_CONDITION_NEW, ASSET_CONDITION_NEW, ASSET_CONDITION_NEW]);
  // The constant table and what was minted agree, craft by craft.
  assert.deepEqual(g.vehicles.map((v) => ({ class: v.class, condition: v.maintenanceCondition })), STARTER_HUMAN_FLEET.map((c) => ({ ...c })));
});

test('human: exactly one idle Outpost kit at the home system, beside the unchanged 15 + 10 machines', () => {
  const g = guildOf(humanFounded());
  const kits = g.assets.filter((a) => a.kind === 'outpost');
  assert.deepEqual(kits, [{ id: KIT_ID, kind: 'outpost', systemId: HOME_SYSTEM, maintenanceCondition: ASSET_CONDITION_NEW }]);
  assert.equal(STARTER_HUMAN_KITS.length, kits.length);
  assert.equal(g.kitAssetSerial, 1, 'the guild\'s kit serial sits at the kit it minted');
  assert.equal(deployedAssetIds(g).has(KIT_ID), false, 'the kit is idle — no venture names it');
  // The older, every-founding starter machines are exactly what they were.
  assert.equal(g.assets.filter((a) => a.kind === 'miner').length, STARTER_MINERS);
  assert.equal(g.assets.filter((a) => a.kind === 'factory').length, STARTER_FACTORIES);
  assert.equal(g.assets.length, STARTER_MINERS + STARTER_FACTORIES + 1);
});

test('human: every invariant holds between ticks and over five ticks (occupancy, fuel, supply, integrality)', () => {
  let s = humanFounded();
  // checkInvariants runs every check — among them checkAssetOccupancy, checkVehicleIntegrity,
  // checkFuelConservation (1), checkCreditConservation (2), checkNonNegativityAndIntegrality and
  // checkGalacticSupplyConsistency — so [] here is all of them at once.
  assert.deepEqual(checkInvariants(s, s.tick), [], 'between ticks, exactly where POST /action asserts');
  for (let t = 0; t < 5; t += 1) {
    s = advance(s, []).state;
    assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
  }
  assert.equal(guildOf(s).vehicles.length, 4, 'the fleet is still there, still idle');
  assert.ok(guildOf(s).vehicles.every((v) => v.status === 'idle'));
});

test('human: the invariants really SEE the package — corrupt it and the right check fires', () => {
  const s = humanFounded();
  const rulesAfter = (mutate) => {
    const bad = structuredClone(s);
    mutate(bad);
    return checkInvariants(bad, bad.tick).map((v) => v.rule);
  };
  // A credit that came from nowhere (the guild holds 1 more than the ledger paid out).
  assert.ok(rulesAfter((x) => { guildOf(x).credits += 1; }).includes('conservation-of-credits (invariant 2)'));
  // A starter craft berthed at a system that does not exist.
  assert.ok(rulesAfter((x) => { guildOf(x).vehicles[0].location = { landmarkKind: 'system', landmarkId: 'sys_not_real' }; }).includes('vehicle-location-resolves'));
  // Two craft sharing one id.
  assert.ok(rulesAfter((x) => { guildOf(x).vehicles[1].id = HEAVY_ID; }).includes('vehicle-id-unique'));
  // A craft serial behind the craft it minted (the next spawn would reissue `_04`).
  assert.ok(rulesAfter((x) => { guildOf(x).vehicleSerial = 3; }).includes('vehicle-serial-monotonic'));
  // A kit serial behind the kit it minted.
  assert.ok(rulesAfter((x) => { guildOf(x).kitAssetSerial = 0; }).includes('kit-asset-serial-monotonic'));
});

test('human: the snapshot shows the four craft and the idle kit', () => {
  const g = buildSnapshot(humanFounded()).guilds.find((x) => x.id === GUILD);
  assert.deepEqual(g.vehicles.map((v) => [v.id, v.status]), [[HEAVY_ID, 'idle'], ...LIGHT_IDS.map((id) => [id, 'idle'])]);
  const kit = g.assets.find((a) => a.id === KIT_ID);
  assert.equal(kit.kind, 'outpost');
  assert.equal(kit.deployedToVentureId, null, 'the engine reports it idle');
});

test('human: inline ventures still take their starter machines — the kit is never one of them', () => {
  const s = humanFounded({
    ventures: [{ id: 'mine_1', ownerGuildId: GUILD, type: 'mining', siteId: HOME_MINE, resourceType: 'titanium', productionRate: 5 }],
  });
  const g = guildOf(s);
  assert.equal(g.ventures[0].assetId, `asset_${GUILD}_miner_01`, 'the inline mine runs the first starter miner, as before');
  assert.equal(deployedAssetIds(g).has(KIT_ID), false);
  assert.equal(g.vehicles.length, 4);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. the package is the ONLY difference between a human and a bot founding ---------------------

test('a human founding with the package undone is byte-identical to a bot founding at the same home', () => {
  const human = humanFounded();
  const bot = botFounded({ credits: 2000 });

  // Undo exactly the package: the four craft, the kit, their two serials, the credits, and the flag.
  const undone = structuredClone(human);
  const g = guildOf(undone);
  g.isBot = true;
  g.vehicles = [];
  delete g.vehicleSerial;
  g.assets = g.assets.filter((a) => a.id !== KIT_ID);
  delete g.kitAssetSerial;
  g.credits = 2000;
  undone.syndicate.ledger += STARTER_HUMAN_CREDITS - 2000;

  // So fuel, the supply cache, the claim, the endowment and the entitlement all matched already.
  assert.equal(hashState(undone), hashState(bot));
  // Spelled out, for the four the ruling names as untouched:
  assert.equal(guildOf(human).fuelHoard, GUILD_STARTING_FUEL, 'starting fuel unchanged');
  assert.equal(guildOf(human).fuelHoard, guildOf(bot).fuelHoard);
  assert.equal(guildOf(human).foundingEndowment, guildOf(bot).foundingEndowment, 'the endowment is sized off held systems — craft score nothing');
  assert.equal(guildOf(human).foundingEntitlement, guildOf(bot).foundingEntitlement, 'and so is the entitlement');
  assert.deepEqual(human.galacticSupply, bot.galacticSupply, 'craft and kits are not in galactic supply');
  assert.deepEqual(human.audit.totalProduced, bot.audit.totalProduced, 'and no fuel was minted for them');
});

// --- 3. a bot founding is byte-identical to before this slice ------------------------------------

// GOLDENS recorded on main at 074e4d1, BEFORE this slice's code existed, with exactly these two
// actions on the zero-state. If a later ruling legitimately changes a bot founding, re-record them
// and say why; if anything else moves them, the bot path has been touched by accident.
const BOT_FOUNDING_GOLDEN = 'aac003c6384ef74b615ace9ca963e67e3b7070260d39c71f53874774ae2bd971';
const BOT_INLINE_FOUNDING_GOLDEN = '5925d6ad724ccfe8aed5f6e866b59d29676c37dd931f11ef6e0b333109149d47';
// ⤳ 05-10-26 (roadmap 2.5, the exploration record): EVERY founding — bot included — now seeds the
// guild's `exploration` record with its home system (docs/exploration-model.md §6), so both full
// hashes moved. They are re-pinned below, and the two goldens above are KEPT and asserted against the
// state with that one added key stripped — the proof that the record is the only thing that moved.
const BOT_FOUNDING_GOLDEN_WITH_EXPLORATION = 'fbf7f22cfa88719c8e68035c4a13d4505d1b66fd9db916815c85a7effd7a65ca';
const BOT_INLINE_FOUNDING_GOLDEN_WITH_EXPLORATION = 'ee23d4a166c0ffcfd7e3e392d904c3071c060da061d074f18209be25cb38c3be';
const withoutExploration = (state) => ({
  ...state,
  guilds: state.guilds.map((g) => { const { exploration, ...rest } = g; return rest; }),
});
// ⤳ 09-10-26 (roadmap 2.5, the settlement-surface engine slice): every record entry now carries a `slots`
// map and founding fills the home system's slots, so both full hashes moved again. Re-pinned below; the two
// `…_WITH_EXPLORATION` values above are KEPT and asserted with the slots stripped (tests/slot-strip.js) —
// the proof that the slots are the only thing that moved.
const BOT_FOUNDING_GOLDEN_WITH_SLOTS = '6632f1245c7ae21e3e9164e5b036fa8f604195dda59551cf1b1c62595af7a55f';
const BOT_INLINE_FOUNDING_GOLDEN_WITH_SLOTS = 'fa3c4b3e6c5cd6304904dd8a1e24a40c4d1ef510ba63b511d3a9e2e43a0b3420';

test('bot: founding is byte-identical to the pre-slice golden (bare, and with an inline venture)', () => {
  const z = createZeroState();
  const bare = createFoundGuildAction({ guildId: 'bot_a', name: 'Bot A', isBot: true, credits: 2000, influence: 100, homeSystemId: HOME_SYSTEM });
  assert.equal(validateAction(z, bare).valid, true);
  const bareState = applyAction(z, bare);
  assert.equal(hashState(bareState), BOT_FOUNDING_GOLDEN_WITH_SLOTS, 'the full bot founding, record and its slots included, is pinned');
  const bareSlots = withoutRecordSlots(bareState);
  assert.ok(bareSlots.count > 0, 'the home slots really landed, so the slot strip is a real proof');
  assert.equal(hashState(bareSlots.state), BOT_FOUNDING_GOLDEN_WITH_EXPLORATION, 'the slots are the settlement-surface slice\'s ONLY delta');
  assert.ok(bareState.guilds[0].exploration, 'the record really landed, so the strip below is a real proof');
  assert.equal(hashState(withoutExploration(bareState)), BOT_FOUNDING_GOLDEN, 'and the record is its ONLY delta');

  const inline = createFoundGuildAction({
    guildId: 'bot_b', name: 'Bot B', isBot: true, credits: 2000, influence: 100, homeSystemId: HOME_SYSTEM,
    ventures: [{ id: 'bot_b_mine', ownerGuildId: 'bot_b', type: 'mining', siteId: HOME_MINE, resourceType: 'titanium', productionRate: 5 }],
  });
  assert.equal(validateAction(z, inline).valid, true);
  const inlineState = applyAction(z, inline);
  assert.equal(hashState(inlineState), BOT_INLINE_FOUNDING_GOLDEN_WITH_SLOTS, 'the full inline founding, record and its slots included, is pinned');
  assert.equal(hashState(stripRecordSlots(inlineState)), BOT_INLINE_FOUNDING_GOLDEN_WITH_EXPLORATION, 'the slots are its only delta from the record slice');
  assert.equal(hashState(withoutExploration(inlineState)), BOT_INLINE_FOUNDING_GOLDEN, 'and the record is its ONLY delta');
});

test('bot: the passed credits, no craft, no kit, no serials', () => {
  const before = createZeroState();
  const s = botFounded({ credits: 2000 });
  const g = guildOf(s);
  assert.equal(g.isBot, true);
  assert.equal(g.credits, 2000, 'a bot gets exactly what it passed');
  assert.equal(s.syndicate.ledger, before.syndicate.ledger - 2000);
  assert.deepEqual(g.vehicles, []);
  assert.equal('vehicleSerial' in g, false);
  assert.equal('kitAssetSerial' in g, false);
  assert.equal(g.assets.some((a) => a.kind === 'outpost'), false);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. determinism (invariant 9) ----------------------------------------------------------------

test('determinism: two runs of the same human founding give identical ids and identical state', () => {
  const a = humanFounded();
  const b = humanFounded();
  assert.equal(hashState(a), hashState(b));
  assert.deepEqual(guildOf(a).vehicles.map((v) => v.id), guildOf(b).vehicles.map((v) => v.id));
  // And over ticks too.
  const run = () => {
    let s = humanFounded();
    for (let t = 0; t < 3; t += 1) s = advance(s, []).state;
    return s;
  };
  assert.equal(hashState(run()), hashState(run()));
});

test('determinism: a founded human guild saves and restores byte-identical, fleet and kit included', () => {
  const s = humanFounded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-starter-'));
  try {
    saveState(s, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(s));
    assert.deepEqual(guildOf(restored).vehicles.map((v) => v.id), [HEAVY_ID, ...LIGHT_IDS]);
    assert.ok(guildOf(restored).assets.some((a) => a.id === KIT_ID));
    assert.equal(guildOf(restored).vehicleSerial, 4);
    assert.equal(guildOf(restored).kitAssetSerial, 1);
    assert.deepEqual(checkInvariants(restored, restored.tick), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. the guild's id sequences continue above the package --------------------------------------

test('a later spawn and a later kit grant number ABOVE the package, never over it', () => {
  let s = humanFounded();
  ({ state: s } = intake(s, [
    createSpawnVehicleAction({ guildId: GUILD, class: 'lightTransport', location: HOME }),
    createGrantKitAction({ guildId: GUILD, systemId: HOME_SYSTEM, kind: 'outpost' }),
  ]));
  const g = guildOf(s);
  assert.equal(g.vehicles[g.vehicles.length - 1].id, `vehicle_${GUILD}_lightTransport_05`);
  assert.equal(g.assets[g.assets.length - 1].id, `asset_${GUILD}_outpost_02`);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 6. the package is usable as a set ----------------------------------------------------------

test('the starter heavy can load the starter kit; a starter light cannot (only a heavy has the hold)', () => {
  const s = humanFounded();
  const loadOnto = (vehicleId) => createLoadKitAction({ guildId: GUILD, vehicleId, assetId: KIT_ID });
  assert.equal(validateAction(s, loadOnto(LIGHT_IDS[0])).valid, false, 'a light transport is refused');
  const check = validateAction(s, loadOnto(HEAVY_ID));
  assert.equal(check.valid, true, check.reason);
  const loaded = applyAction(s, loadOnto(HEAVY_ID));
  assert.deepEqual(guildOf(loaded).vehicles[0].cargo, { outpost_kit: 1 });
  assert.equal(guildOf(loaded).assets.some((a) => a.id === KIT_ID), false, 'the kit left the inventory for the hold');
  assert.deepEqual(checkInvariants(loaded, loaded.tick), []);
});

// --- 7. `isBot` must mean what it says ----------------------------------------------------------

test('a non-boolean isBot is refused — the string "false" must not found a human as a bot', () => {
  const z = createZeroState();
  for (const isBot of ['false', 'true', 0, 1, null]) {
    const v = validateAction(z, { ...createFoundGuildAction({ guildId: GUILD, credits: 2000, homeSystemId: HOME_SYSTEM }), isBot });
    assert.equal(v.valid, false, `isBot ${JSON.stringify(isBot)} must be refused`);
    assert.match(v.reason, /isBot must be true or false/);
  }
  // Absent is the human default, exactly as createGuild defaults it.
  const raw = { type: 'foundGuild', guildId: GUILD, credits: 2000, homeSystemId: HOME_SYSTEM };
  assert.equal(validateAction(z, raw).valid, true);
  assert.equal(guildOf(applyAction(z, raw)).credits, STARTER_HUMAN_CREDITS);
});
