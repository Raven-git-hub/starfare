'use strict';

// abandon-script.js — the galaxies losing ground client slice 5's test shares (the abandon control; design.md §2 /
// §19 #67 / #69; docs/territory-model.md §4). Built on sweep-script.js's planted(): g1 holds HOME and TARGET (its
// Prefecture, PREFECTURE, on SLOT_A1; its heavy berthed at TARGET, empty), and g2 holds its own starter far away.
// Every state is made by the real engine:
//   bare        — planted(), nothing else of g1's in TARGET: an abandon there strands nothing;
//   position    — planted(), then a position worth losing in TARGET: a licensed mine on NODE (m1), a refinery on
//                 SLOT_A2 (f1), an idle factory and an idle Outpost kit, run 30 ticks so the pool fills — sweep-script's
//                 fallow() up to (not including) its abandon. 2 ventures, 3 machines (the two the ventures run among
//                 them) and 1 kit in TARGET; and one idle miner at HOME, which is not in TARGET and must not count;
//   carried     — position(), abandoned; the heavy loads the idle factory (loadAsset); then g1 plants a second
//                 Prefecture (SECOND) on SLOT_A1, which recovers the rest. TARGET is held again, and the factory aboard
//                 still carries TARGET as its systemId — but it is in the hold, so an abandon leaves it be;
//   centreBound — position(), plus a second heavy flying a Deep Scan Array kit from HOME to deploy on TARGET's centre:
//                 the one state in which the engine refuses the abandon (its gate 3);
//   fallow      — bare(), abandoned, and a fresh Prefecture kit of g1's granted into TARGET: what an accepted abandon
//                 leaves, with Plant offered again on the vacant slots;
//   rival       — bare(), abandoned, then g2 surveys PLANET_A and plants its own Prefecture on SLOT_A1 (RIVAL_PREFECTURE):
//                 the slot g1 gave up is a rival's now — g1 sees it, and must not be offered Abandon on it.
// It uses ONLY what `main` had at a869f6b (the fixtures, the operator levers, the salvage load, the plant and the
// abandon), so the guard's pins can be re-hashed on `main` by requiring this file there.

const {
  createGrantKitAction, createLoadAssetAction, createLoadKitAction, createSpawnVehicleAction,
  createDispatchRouteWithActionsAction, createEstablishVentureAction, createApplyForLicenceAction,
} = require('../actions.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');

const { accept, ticks, HEAVY, HOME, AT_TARGET, TARGET, PLANET_A, SLOT_A1, SLOT_A2 } = P;
const { PREFECTURE, NODE, guildOf, abandon, grantMachine } = S;

const SECOND = 'prefecture_g1_02';
const RIVAL_PREFECTURE = 'prefecture_g2_01';
const ARRAY_HEAVY = 'vehicle_g1_heavyTransport_02';

// position() -> { s, homeMiner, miner, factory, idleFactory, outpostKit }: the position described above.
function position() {
  let s = S.planted();
  let homeMiner; let miner; let factory; let idleFactory;
  ({ s, id: homeMiner } = grantMachine(s, 'g1', 'miner', HOME.id));
  ({ s, id: miner } = grantMachine(s, 'g1', 'miner', TARGET));
  ({ s, id: factory } = grantMachine(s, 'g1', 'factory', TARGET));
  ({ s, id: idleFactory } = grantMachine(s, 'g1', 'factory', TARGET));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const outpostKit = guildOf(s, 'g1').assets.find((a) => a.kind === 'outpost').id;
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm1', type: 'mining', siteId: NODE.id, assetId: miner, resourceType: NODE.resourceType }));
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f1', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' }));
  s = accept(s, createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm1', committedOutputPct: 0.5, windowDays: 7 }));
  return { s: ticks(s, 30), homeMiner, miner, factory, idleFactory, outpostKit };
}

// abandonWorld() -> every state above, and the ids the test reads.
function abandonWorld() {
  const bare = S.planted();
  const { s: held, ...ids } = position();

  let carried = accept(held, abandon());
  carried = accept(carried, createLoadAssetAction({ guildId: 'g1', vehicleId: HEAVY, assetId: ids.idleFactory }));
  let kitId;
  ({ s: carried, kitId } = P.grantPrefectureKit(carried, 'g1', TARGET));
  carried = accept(carried, P.plant('g1', kitId, SLOT_A1));

  let centreBound = accept(held, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: P.AT_HOME }));
  centreBound = accept(centreBound, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'deepScan' }));
  const arrayKit = guildOf(centreBound, 'g1').assets.find((a) => a.kind === 'deepScan').id;
  centreBound = accept(centreBound, createLoadKitAction({ guildId: 'g1', vehicleId: ARRAY_HEAVY, assetId: arrayKit }));
  centreBound = accept(centreBound, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: ARRAY_HEAVY, waypoints: [{ anchor: AT_TARGET, action: { type: 'deploy', kind: 'deepScan' } }],
  }));

  const fallow = P.grantPrefectureKit(accept(bare, abandon()), 'g1', TARGET).s;

  let rival;
  ({ s: rival, kitId } = P.grantPrefectureKit(accept(bare, abandon()), 'g2', TARGET));
  rival = P.survey(rival, 'g2', PLANET_A);
  rival = accept(rival, P.plant('g2', kitId, SLOT_A1));

  return { bare, position: held, carried, centreBound, fallow, rival, ids };
}

module.exports = { PREFECTURE, SECOND, RIVAL_PREFECTURE, ARRAY_HEAVY, abandonWorld };
