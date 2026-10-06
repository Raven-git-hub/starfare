'use strict';

// kit-asset.test.js — the undeployed Outpost kit as a SYSTEM-SCOPED IDLE ASSET (roadmap 2.2 deploy
// pipeline, asset-initiated, slice 1; design.md §4 "The undeployed Outpost kit is a system-scoped idle
// asset", RULED 02-10-26; docs/territory-model.md §5 REVISED).
//
// A kit has two representations and is in exactly one at a time:
//   - in a system's inventory: an idle asset of kind 'outpost' (`asset_<guild>_outpost_NN`);
//   - aboard a heavy: the `outpost_kit` good in the hold, which the (unchanged) deploy reads.
// Three engine actions move between them:
//   - grantKit  — the operator mints one idle kit asset into a guild's inventory at a system;
//   - loadKit   — a named idle kit asset → an empty, idle heavy berthed in the kit's own system;
//   - unloadKit — a heavy's kit → a fresh idle kit asset in the HELD system it is berthed at.
//
// The tripwires, one per ruling:
//   - VOCABULARY: 'outpost' is a KIT kind, not a venture kind — ASSET_KINDS stays [factory, miner], so
//     establishVenture, the Syndicate purchase and grantAsset all refuse a kit;
//   - GRANT: exactly one idle kit asset at the system, a stable serial id, moving nothing else; it shows
//     in the snapshot's asset rows as idle, which is all `__myIdleAssets('outpost')` reads;
//   - LOAD / UNLOAD: every refusal fires; on success one kit in = one good out (and back);
//   - IDS NEVER REPEAT: a loaded kit's id is never handed to a later kit (the stored kitAssetSerial);
//   - CONSERVATION: idle kits + kits aboard is unchanged by load and unload, and drops by one on deploy;
//   - DETERMINISM (invariant 9): the same scenario mints the same ids, live and across a save/restore;
//   - INVARIANTS: a founded guild's machines and ventures stay clean with kits beside them, and the new
//     kit rules fire on corruption.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState, createGuild } = require('../state.js');
const { tick } = require('../tick.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const {
  ASSET_KINDS, KIT_ASSET_KINDS, isAssetKind, isKitAssetKind, MINER, FACTORY,
} = require('../assets.js');
const { OUTPOST_KIT, kitGoodFor, kindForKit } = require('../resources.js');
const { hexDistance } = require('../transport.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const seed = require('../../data/seed.json');
const {
  HEAVY_TRANSPORT, MEDIUM_TRANSPORT, LIGHT_TRANSPORT, SPYCRAFT,
} = require('../vehicles.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');
const { placeCraft, kitCount, assertKitsMoved } = require('./kit-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createGrantKitAction, createLoadKitAction, createUnloadKitAction,
  createDeployAssetAction, createTransferCargoAction, createSpawnOutpostAction,
  createFoundGuildAction, createEstablishVentureAction, createGrantAssetAction,
  createBuyAssetFromSyndicateAction,
} = require('../actions.js');

const HOME = starterHomeAtDistance(6); // a real starter system the guild holds
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;
// Another real system, which g1 does NOT hold — derived from the seed, so a regen carries the tests.
const ELSEWHERE = seed.systems.map((sys) => sys.id).filter((id) => id !== HOME.id).sort()[0];
const AT_ELSEWHERE = { landmarkKind: 'system', landmarkId: ELSEWHERE };
const KIT_01 = 'asset_g1_outpost_01';
const KIT_02 = 'asset_g1_outpost_02';

// The first free bare hex exactly `d` from home, in a fixed scan order (derived from the seed).
function freeHexAtDistance(d) {
  for (let q = HOME_HEX.q - d; q <= HOME_HEX.q + d; q += 1) {
    for (let r = HOME_HEX.r - d; r <= HOME_HEX.r + d; r += 1) {
      if (hexDistance({ q, r }, HOME_HEX) === d && isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) return { q, r };
    }
  }
  throw new Error(`no free hex at distance ${d} from home on this seed`);
}

const claimOf = (guildId, systemId, n) => ({
  claimId: `claim_${guildId}_${n}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected refused');
  return reason;
};

// g1 HOLDS its home system and has one idle craft of `vehicleClass` at `location`; g2 is a rival that
// holds nothing. No machines: g1's inventory is empty until a kit is granted, so `assets` is absent.
function kitState({ vehicleClass = HEAVY_TRANSPORT, location = AT_HOME, pool = {}, extraClaims = [] } = {}) {
  const g1 = { id: 'g1', credits: 0, fuelHoard: 0, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet };
  if (Object.keys(pool).length) g1.stockpiles = { [HOME.id]: { ...pool } };
  let s = createState({
    guilds: [g1, { id: 'g2', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', HOME.id, 'home'), ...extraClaims],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location }));
  return s;
}
const guildOf = (s, id = 'g1') => s.guilds.find((g) => g.id === id);
const craftOf = (s) => guildOf(s).vehicles[0];
const grant = (over = {}) => createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'outpost', ...over });
const load = (s, over = {}) => createLoadKitAction({ guildId: 'g1', vehicleId: craftOf(s).id, assetId: KIT_01, ...over });
const unload = (s, over = {}) => createUnloadKitAction({ guildId: 'g1', vehicleId: craftOf(s).id, ...over });
// g1's heavy at home with KIT_01 granted but not yet loaded.
const granted = (opts) => accept(kitState(opts), grant());
// g1's heavy at home with KIT_01 loaded aboard.
const loaded = (opts) => { const s = granted(opts); return accept(s, load(s)); };
// The same, then PLACED at `location` (kit-fixtures.js — the stand-in for a flight).
const loadedAt = (location, opts) => { const s = loaded(opts); return placeCraft(s, 'g1', craftOf(s).id, location); };

// --- 1. vocabulary: a kit kind is not a venture kind ------------------------------------------------

test('vocabulary: outpost is a KIT asset kind, and the venture kinds are untouched', () => {
  // 'deepScan' joined 2.5 (b1) by its one DEPLOYABLE_KITS row (sorted, invariant 9).
  assert.deepEqual(KIT_ASSET_KINDS, ['deepScan', 'outpost']);
  assert.equal(isKitAssetKind('outpost'), true);
  assert.deepEqual(ASSET_KINDS, [FACTORY, MINER], 'the venture-deployable set is unchanged');
  assert.equal(isAssetKind('outpost'), false, 'so establishVenture can never name a kit');
  for (const kind of [MINER, FACTORY, 'outpost_kit', 'tollGate', undefined]) {
    assert.equal(isKitAssetKind(kind), false, `${kind} is not a kit kind`);
  }
  // The kind and the good are one table read both ways.
  assert.equal(kitGoodFor('outpost'), OUTPOST_KIT);
  assert.equal(kindForKit(OUTPOST_KIT), 'outpost');
  assert.equal(kindForKit('titanium'), null);
  assert.equal(kindForKit('outpost'), null, 'the kind is not a good');
});

// --- 2. grantKit: mint into a system ----------------------------------------------------------------

test('grant: exactly one idle outpost kit asset at the system, a stable id, nothing else moved', () => {
  const before = kitState();
  const s = accept(before, grant());
  const g = guildOf(s);
  assert.deepEqual(g.assets, [{ id: KIT_01, kind: 'outpost', systemId: HOME.id, maintenanceCondition: 1 }]);
  assert.equal(g.kitAssetSerial, 1);
  // The craft is untouched — a kit no longer appears in a hold.
  assert.deepEqual(craftOf(s), craftOf(before));
  // A kit is never priced and never in Galactic Supply: no credits, fuel, supply or ledger moved.
  assert.equal(g.credits, guildOf(before).credits);
  assert.equal(g.fuelHoard, guildOf(before).fuelHoard);
  assert.equal(s.syndicate.ledger, before.syndicate.ledger);
  assert.deepEqual(computeGalacticSupply(s), computeGalacticSupply(before));
  assert.deepEqual(s.galacticSupply, before.galacticSupply, 'the supply cache needed no refresh');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // A second grant mints the next number, at any real system — the operator places freely, like grantAsset.
  const two = accept(s, grant({ systemId: ELSEWHERE }));
  assert.deepEqual(guildOf(two).assets.map((a) => [a.id, a.systemId]), [[KIT_01, HOME.id], [KIT_02, ELSEWHERE]]);
  assert.deepEqual(checkInvariants(two, two.tick), []);
});

test('grant gates: unknown guild, a system that is not on the seed, a kind with no kit — and the shape', () => {
  const s = kitState();
  assert.match(refuse(s, grant({ guildId: 'nobody' })), /no guild with id "nobody"/);
  assert.match(refuse(s, grant({ systemId: 'sys_nope' })), /system "sys_nope" is not a system on the seed/);
  assert.match(refuse(s, grant({ kind: 'tollGate' })), /"tollGate" is not a deployable kind with a kit \(known: outpost, deepScan\)/);
  assert.match(refuse(s, grant({ kind: 'outpost_kit' })), /not a deployable kind/, 'the kind, not the good id');
  assert.match(refuse(s, grant({ kind: MINER })), /not a deployable kind/, 'a machine is not a kit');
  // The action names a system now, not a vehicle.
  assert.deepEqual(grant(), { type: 'grantKit', guildId: 'g1', systemId: HOME.id, kind: 'outpost' });
  assert.throws(() => createGrantKitAction({ guildId: 'g1', kind: 'outpost' }), /systemId is required/);
  assert.throws(() => createGrantKitAction({ systemId: HOME.id, kind: 'outpost' }), /guildId is required/);
  assert.throws(() => createGrantKitAction({ guildId: 'g1', systemId: HOME.id }), /kind is required/);
});

// --- 3. the snapshot: an idle outpost -----------------------------------------------------------------

test('snapshot: the kit is an idle asset row of kind outpost — exactly what __myIdleAssets("outpost") reads', () => {
  const s = granted();
  const rows = buildSnapshot(s).guilds[0].assets;
  assert.deepEqual(rows, [{ id: KIT_01, kind: 'outpost', systemId: HOME.id, maintenanceCondition: 1, deployedToVentureId: null }]);
  // The client's own filter (client/game.html `__myIdleAssets`), applied verbatim to the row.
  const myIdleAssets = (kind) => rows.filter((a) => a.kind === kind && a.deployedToVentureId == null);
  assert.deepEqual(myIdleAssets('outpost').map((a) => a.id), [KIT_01]);
  assert.deepEqual(myIdleAssets(MINER), [], 'the establish picker (miner / factory) never offers a kit');
  // Loaded, it leaves the rows; it is now the hold's cargo instead.
  const l = accept(s, load(s));
  const snap = buildSnapshot(l).guilds[0];
  assert.deepEqual(snap.assets, []);
  assert.deepEqual(snap.vehicles[0].cargo, { [OUTPOST_KIT]: 1 });
});

// --- 4. never venture-deployable ----------------------------------------------------------------------

test('not venture-deployable: establishVenture, the Syndicate purchase and grantAsset all refuse a kit', () => {
  // A real founded guild (25 starter machines, its home held) with a kit granted at home beside them.
  let s = advance(createZeroState(), [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
  s = accept(s, createGrantKitAction({ guildId: 'player-guild', systemId: HOME_SYSTEM, kind: 'outpost' }));
  const kit = 'asset_player-guild_outpost_01';
  const establish = createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: kit, resourceType: 'titanium' });
  assert.match(refuse(s, establish), /asset "asset_player-guild_outpost_01" is a outpost; a mining venture needs a miner/);
  // A miner on the same node is fine — the kit changed nothing for the machines beside it.
  accept(s, { ...establish, assetId: 'asset_player-guild_miner_01' });
  assert.match(refuse(s, createBuyAssetFromSyndicateAction({ guildId: 'player-guild', assetKind: 'outpost', destinationSystemId: HOME_SYSTEM, issueTick: s.tick })), /is not a Syndicate-sellable kind/);
  assert.match(refuse(s, createGrantAssetAction({ guildId: 'player-guild', kind: 'outpost', systemId: HOME_SYSTEM })), /is not an asset kind \(miner \/ factory\)/);
});

// --- 5. loadKit: the happy path -----------------------------------------------------------------------

test('load: the kit leaves the inventory and exactly one outpost_kit lands in the empty heavy hold', () => {
  const before = granted();
  const s = accept(before, load(before));
  const g = guildOf(s);
  assert.equal(g.assets, undefined, 'the inventory emptied, so the key goes (omit-when-empty)');
  assert.equal(g.kitAssetSerial, 1, 'a load mints nothing — the serial does not move');
  const craft = craftOf(s);
  assert.deepEqual(craft.cargo, { [OUTPOST_KIT]: 1 });
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.location, AT_HOME, 'instant — the craft does not move');
  assert.equal(craft.updatedAtTick, s.tick, 'every mutation records its tick (§15.2)');
  assert.equal(buildSnapshot(s).guilds[0].vehicles[0].used, craft.capacity, 'the kit alone fills the heavy hold');
  assert.equal(g.credits, guildOf(before).credits);
  assert.equal(g.fuelHoard, guildOf(before).fuelHoard);
  assert.deepEqual(s.galacticSupply, before.galacticSupply);
  assertKitsMoved(before, s, 'g1', 0, 'loadKit');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('load: with other kits beside it, only the NAMED kit goes', () => {
  let s = granted();
  s = accept(s, grant());
  s = accept(s, load(s, { assetId: KIT_02 }));
  assert.deepEqual(guildOf(s).assets.map((a) => a.id), [KIT_01], 'KIT_01 stays idle in the inventory');
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 });
});

// --- 6. loadKit: every refusal --------------------------------------------------------------------------

test('load gates: unknown guild or craft; a kit the guild does not own; an asset that is not a kit', () => {
  const s = granted();
  assert.match(refuse(s, load(s, { guildId: 'nobody' })), /no guild with id "nobody"/);
  assert.match(refuse(s, load(s, { vehicleId: 'vehicle_g1_heavyTransport_99' })), /owns no vehicle/);
  assert.match(refuse(s, load(s, { assetId: 'asset_g1_outpost_09' })), /guild "g1" owns no asset "asset_g1_outpost_09"/);
  // WRONG OWNER: g2's kit, in the same system, is not in g1's inventory.
  const rival = accept(s, createGrantKitAction({ guildId: 'g2', systemId: HOME.id, kind: 'outpost' }));
  assert.match(refuse(rival, load(rival, { assetId: 'asset_g2_outpost_01' })), /guild "g1" owns no asset "asset_g2_outpost_01"/);
  // NOT A KIT: a miner in the inventory is not loadable.
  const miner = accept(s, createGrantAssetAction({ guildId: 'g1', kind: MINER, systemId: HOME.id }));
  assert.match(refuse(miner, load(miner, { assetId: 'asset_g1_miner_01' })), /asset "asset_g1_miner_01" is a miner, not a kit/);
  assert.throws(() => createLoadKitAction({ guildId: 'g1', vehicleId: 'v' }), /assetId is required/);
  assert.throws(() => createLoadKitAction({ guildId: 'g1', assetId: KIT_01 }), /vehicleId is required/);
});

test('load gates: a kit that is not idle is refused (a corrupt state — no path deploys a kit)', () => {
  const s = granted();
  guildOf(s).ventures.push({ id: 'v_bad', ownerGuildId: 'g1', type: 'mining', assetId: KIT_01 });
  assert.match(refuse(s, load(s)), /asset "asset_g1_outpost_01" is deployed to venture "v_bad" — only an idle kit loads/);
});

test('load gates: the carrier must be a heavy — a light, a medium and a spycraft are refused', () => {
  for (const vehicleClass of [LIGHT_TRANSPORT, MEDIUM_TRANSPORT, SPYCRAFT]) {
    const s = granted({ vehicleClass });
    assert.match(refuse(s, load(s)), new RegExp(`is a ${vehicleClass} — a kit fills a whole heavy hold, so only a heavy transport carries one`));
  }
});

test('load gates: the heavy must be idle, off any lane, and EMPTY', () => {
  for (const status of ['inTransit', 'loading']) {
    const s = granted();
    craftOf(s).status = status;
    assert.match(refuse(s, load(s)), new RegExp(`is not idle \\(status "${status}"\\)`));
  }
  const laned = granted();
  // An idle craft holding a route is a lane WAITING at its last stop — idle, but lane-driven.
  craftOf(laned).route = { waypoints: [{ anchor: AT_HOME }, { anchor: AT_HOME }], cursor: 1, mode: 'continuous', lapsDone: 1, waiting: { reason: 'fuel', sinceTick: 0 } };
  assert.match(refuse(laned, load(laned)), /running a lane — a deployable kit never rides one/);
  // Anything in the hold — ore, or a kit already — refuses a second load.
  let ore = granted({ pool: { titanium: 1 } });
  ore = accept(ore, createTransferCargoAction({ guildId: 'g1', vehicleId: craftOf(ore).id, manifest: [{ dir: 'load', good: 'titanium', qty: 1 }] }));
  assert.match(refuse(ore, load(ore)), /has cargo aboard \({"titanium":1}\) — a kit loads into an EMPTY heavy hold/);
  let full = loaded();
  full = accept(full, grant());
  assert.match(refuse(full, load(full, { assetId: KIT_02 })), /has cargo aboard \({"outpost_kit":1}\)/);
});

test('load gates: SAME SYSTEM — a heavy at another system, at a waystation, or on a bare hex is refused', () => {
  const kitHome = /kit "asset_g1_outpost_01" sits in system ".*" but vehicle ".*" is at .* — a kit loads only onto a heavy berthed in its own system/;
  for (const location of [AT_ELSEWHERE, { landmarkKind: 'outpost', landmarkId: HOME.waystation }, freeHexAtDistance(1), { q: HOME_HEX.q, r: HOME_HEX.r }]) {
    const s = granted({ location });
    assert.match(refuse(s, load(s)), kitHome, JSON.stringify(location));
  }
  // The other way round: a kit granted elsewhere does not load onto the heavy at home…
  const away = accept(kitState(), grant({ systemId: ELSEWHERE }));
  assert.match(refuse(away, load(away)), kitHome);
  // …but does onto a heavy berthed THERE — held or not; the load rule is same-system only.
  let there = accept(kitState({ location: AT_ELSEWHERE }), grant({ systemId: ELSEWHERE }));
  there = accept(there, load(there));
  assert.deepEqual(craftOf(there).cargo, { [OUTPOST_KIT]: 1 });
  assert.deepEqual(checkInvariants(there, there.tick), []);
});

// --- 7. unloadKit: the happy path and every refusal ---------------------------------------------------

test('unload: the kit leaves the hold and a FRESH idle kit asset appears in the held system', () => {
  const before = loaded();
  const s = accept(before, unload(before));
  const g = guildOf(s);
  assert.deepEqual(g.assets, [{ id: KIT_02, kind: 'outpost', systemId: HOME.id, maintenanceCondition: 1 }], 'a new id — KIT_01 is never reissued');
  assert.equal(g.kitAssetSerial, 2);
  const craft = craftOf(s);
  assert.equal(craft.cargo, undefined, 'the hold is empty (omit-when-empty)');
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.location, AT_HOME);
  assert.equal(craft.updatedAtTick, s.tick, 'every mutation records its tick (§15.2)');
  assert.deepEqual(s.galacticSupply, before.galacticSupply);
  assertKitsMoved(before, s, 'g1', 0, 'unloadKit');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('unload: a craft that never failed a deploy changes only its hold and its tick — no deployFailed appears', () => {
  // Fix A (RULED 02-10-26): the unload clears `deployFailed`. On a craft that never carried the flag that
  // clear must do nothing — the retreat-then-unload case is in deploy-on-arrival.test.js.
  const before = loaded();
  assert.equal('deployFailed' in craftOf(before), false);
  const s = accept(before, unload(before));
  const strip = (craft) => { const c = structuredClone(craft); delete c.cargo; delete c.updatedAtTick; return c; };
  assert.deepEqual(strip(craftOf(s)), strip(craftOf(before)), 'every other field of the craft is untouched');
  assert.equal('deployFailed' in craftOf(s), false);
});

test('unload gates: the hold must be exactly one kit and nothing else', () => {
  const empty = kitState();
  assert.match(refuse(empty, unload(empty)), /must carry exactly one kit and nothing else to unload — its hold is {}/);
  const ore = kitState();
  craftOf(ore).cargo = { titanium: 5 };
  assert.match(refuse(ore, unload(ore)), /must carry exactly one kit and nothing else to unload — its hold is {"titanium":5}/);
  const mixed = loaded();
  craftOf(mixed).cargo.titanium = 1; // a corrupt (over-capacity) hold: the gate still refuses it
  assert.match(refuse(mixed, unload(mixed)), /exactly one kit and nothing else/);
  const two = loaded();
  craftOf(two).cargo[OUTPOST_KIT] = 2; // corrupt: two kits in one heavy
  assert.match(refuse(two, unload(two)), /exactly one kit and nothing else/);
});

test('unload gates: unknown guild or craft; a craft not idle, or on a lane', () => {
  const s = loaded();
  assert.match(refuse(s, unload(s, { guildId: 'nobody' })), /no guild with id/);
  assert.match(refuse(s, unload(s, { vehicleId: 'vehicle_g1_heavyTransport_99' })), /owns no vehicle/);
  for (const status of ['inTransit', 'loading']) {
    const t = loaded();
    craftOf(t).status = status;
    assert.match(refuse(t, unload(t)), new RegExp(`is not idle \\(status "${status}"\\)`));
  }
  const laned = loaded();
  craftOf(laned).route = { waypoints: [{ anchor: AT_HOME }], cursor: 0 };
  assert.match(refuse(laned, unload(laned)), /running a lane/);
  assert.throws(() => createUnloadKitAction({ guildId: 'g1' }), /vehicleId is required/);
});

test('unload gates: only at a system the guild HOLDS — not a bare hex, an Outpost, or an unheld system', () => {
  const notBerthed = /is not berthed at a system .* a kit unloads into a held system's inventory, not on a bare hex or at an Outpost/;
  const onHex = loadedAt(freeHexAtDistance(2));
  assert.match(refuse(onHex, unload(onHex)), notBerthed);
  const atWaystation = loadedAt({ landmarkKind: 'outpost', landmarkId: HOME.waystation });
  assert.match(refuse(atWaystation, unload(atWaystation)), notBerthed);
  // Parked at the guild's OWN Outpost (on its hex): an Outpost is not a system inventory.
  const hex = freeHexAtDistance(2);
  const parked = accept(loadedAt(hex), createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: hex }));
  assert.match(refuse(parked, unload(parked)), notBerthed);
  // At a real system the guild does not hold.
  const unheld = loadedAt(AT_ELSEWHERE);
  assert.match(refuse(unheld, unload(unheld)), new RegExp(`guild "g1" does not hold system "${ELSEWHERE}" — a kit unloads only into a system its guild holds`));
  // Held, it unloads THERE — the kit asset lands in that system, not at home.
  let second = loadedAt(AT_ELSEWHERE, { extraClaims: [claimOf('g1', ELSEWHERE, 2)] });
  second = accept(second, unload(second));
  assert.deepEqual(guildOf(second).assets.map((a) => [a.id, a.systemId]), [[KIT_02, ELSEWHERE]]);
  assert.deepEqual(checkInvariants(second, second.tick), []);
});

// --- 8. the round trip, stable ids and conservation ---------------------------------------------------

test('round trip: grant → load → unload leaves one idle kit asset and an empty heavy; no id is reused', () => {
  let s = kitState();
  s = accept(s, grant());
  s = accept(s, load(s));
  s = accept(s, unload(s));
  assert.deepEqual(guildOf(s).assets.map((a) => a.id), [KIT_02]);
  assert.equal(craftOf(s).cargo, undefined);
  // And again: each fresh kit takes the next number; nothing ever comes back.
  s = accept(s, load(s, { assetId: KIT_02 }));
  s = accept(s, unload(s));
  s = accept(s, grant());
  assert.deepEqual(guildOf(s).assets.map((a) => a.id), ['asset_g1_outpost_03', 'asset_g1_outpost_04']);
  assert.equal(guildOf(s).kitAssetSerial, 4);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('conservation: kits are unchanged by load and unload, +1 on a grant, and −1 only on a deploy', () => {
  let s = kitState();
  const step = (action, change, label) => { const next = accept(s, action); assertKitsMoved(s, next, 'g1', change, label); s = next; };
  step(grant(), +1, 'grantKit');
  step(load(s), 0, 'loadKit');
  step(unload(s), 0, 'unloadKit');
  step(load(s, { assetId: KIT_02 }), 0, 'loadKit');
  assert.deepEqual(kitCount(s, 'g1'), { idle: 0, aboard: 1, total: 1 });
  // Out on a bare hex in range (placed — a real flight is covered in deploy-asset / deploy-on-arrival).
  placeCraft(s, 'g1', craftOf(s).id, freeHexAtDistance(2));
  step(createDeployAssetAction({ guildId: 'g1', vehicleId: craftOf(s).id }), -1, 'deployAsset');
  assert.deepEqual(kitCount(s, 'g1'), { idle: 0, aboard: 0, total: 0 });
  assert.equal(s.outposts.length, 1, 'the kit became the Outpost');
  // The tripwire itself fires loudly on a duplication.
  const dup = structuredClone(s);
  guildOf(dup).vehicles[0].cargo = { [OUTPOST_KIT]: 1 };
  assert.throws(() => assertKitsMoved(s, dup, 'g1', 0, 'a forged kit'), /kit conservation broken by a forged kit at tick \d+: guild g1 kits .* expected a change of 0/);
});

// --- 9. determinism (invariant 9) ------------------------------------------------------------------------

test('determinism: grant → load → unload → load, run twice, is byte-identical', () => {
  const run = () => {
    let s = kitState();
    s = accept(s, grant());
    s = accept(s, load(s));
    s = accept(s, unload(s));
    return accept(s, load(s, { assetId: KIT_02 }));
  };
  assert.equal(hashState(run()), hashState(run()));
});

test('determinism: the mints, loads and unloads journalled against a SAVED state replay to the same bytes and ids', () => {
  const start = kitState();
  const vid = craftOf(start).id;
  const actions = [
    grant(),
    grant({ systemId: ELSEWHERE }),
    createLoadKitAction({ guildId: 'g1', vehicleId: vid, assetId: KIT_01 }),
    createUnloadKitAction({ guildId: 'g1', vehicleId: vid }),
    createLoadKitAction({ guildId: 'g1', vehicleId: vid, assetId: 'asset_g1_outpost_03' }),
  ];
  let direct = start;
  for (const a of actions) direct = accept(direct, a);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-kit-'));
  try {
    saveState(start, dir);
    for (const a of actions) appendJournal(start.tick, a, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(direct));
    assert.deepEqual(guildOf(restored).assets.map((a) => a.id), [KIT_02], 'the same kit left idle');
    assert.equal(guildOf(restored).kitAssetSerial, 3);
    assert.deepEqual(craftOf(restored).cargo, { [OUTPOST_KIT]: 1 });
    // And a state SAVED with kits and a serial in it restores to the same bytes.
    saveState(direct, dir);
    fs.rmSync(path.join(dir, 'journal.jsonl'), { force: true });
    assert.equal(hashState(loadOrInit(dir, () => { throw new Error('expected a load'); })), hashState(direct));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 10. the invariants, with kits present ---------------------------------------------------------------

test('invariants: a founded guild with ventures runs clean with kits beside its machines, idle and aboard', () => {
  let s = advance(createZeroState(), [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
  const at = { landmarkKind: 'system', landmarkId: HOME_SYSTEM };
  s = accept(s, createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: HOME_MINE, assetId: 'asset_player-guild_miner_01', resourceType: 'titanium' }));
  s = accept(s, createSpawnVehicleAction({ guildId: 'player-guild', class: HEAVY_TRANSPORT, location: at }));
  for (let i = 0; i < 2; i += 1) s = accept(s, createGrantKitAction({ guildId: 'player-guild', systemId: HOME_SYSTEM, kind: 'outpost' }));
  // A human founding already holds the starter heavy (`_01`) and lights (`_02`..`_04`) and the starter
  // kit (`_outpost_01`) — design.md §13, 04-10-26. So the spawned heavy is `_05` and the granted kits
  // are `_02` and `_03`; one granted kit goes aboard the spawned heavy.
  s = accept(s, createLoadKitAction({ guildId: 'player-guild', vehicleId: 'vehicle_player-guild_heavyTransport_05', assetId: 'asset_player-guild_outpost_02' }));
  assert.equal(s.guilds[0].assets.length, 27, '25 starter machines + the starter kit + the granted kit still idle');
  for (let t = 0; t < 30; t += 1) {
    s = tick(s, []);
    assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}`);
  }
  // The venture still runs its miner, and the snapshot still answers idle-vs-deployed for every row.
  const rows = buildSnapshot(s).guilds[0].assets;
  assert.equal(rows.find((a) => a.id === 'asset_player-guild_miner_01').deployedToVentureId, 'mine_1');
  assert.equal(rows.find((a) => a.id === 'asset_player-guild_outpost_01').deployedToVentureId, null);
});

test('invariants: the kit rules fire — a venture running a kit, a serial below a live kit, a placeless kit', () => {
  const s = accept(accept(kitState(), grant()), grant());
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const rules = (mutate) => {
    const bad = structuredClone(s);
    mutate(guildOf(bad));
    return checkInvariants(bad, bad.tick);
  };
  const deployed = rules((g) => { g.ventures.push({ id: 'v_bad', ownerGuildId: 'g1', type: 'mining', assetId: KIT_01 }); });
  assert.deepEqual(deployed.find((v) => v.rule === 'kit-asset-never-deployed').detail, { assetId: KIT_01, assetKind: 'outpost', ventureType: 'mining' });
  const drifted = rules((g) => { g.kitAssetSerial = 1; });
  assert.deepEqual(drifted.find((v) => v.rule === 'kit-asset-serial-monotonic').detail, { kitAssetSerial: 1, highestLiveKitNumber: 2 });
  assert.ok(rules((g) => { delete g.kitAssetSerial; }).some((v) => v.rule === 'kit-asset-serial-monotonic'), 'an absent serial is 0');
  assert.ok(rules((g) => { delete g.assets[0].systemId; }).some((v) => v.rule === 'asset-system-present'), 'a kit must have a location');
  // An unknown kind still trips — widening the check to kits did not open it to anything else.
  assert.deepEqual(rules((g) => { g.assets[0].kind = 'gizmo'; }).find((v) => v.rule === 'asset-kind-known (assets.js)').detail, { kind: 'gizmo' });
});

test('no-op shape: a guild that never had a kit carries no kitAssetSerial; a restored one keeps it', () => {
  assert.equal('kitAssetSerial' in createGuild({ id: 'g', credits: 0, fuelHoard: 0 }), false);
  assert.equal(createGuild({ id: 'g', credits: 0, fuelHoard: 0, kitAssetSerial: 3 }).kitAssetSerial, 3);
  assert.equal('kitAssetSerial' in guildOf(kitState()), false);
});
