'use strict';

// salvage-script.js — the galaxy losing ground client slice 4's tests share: the salvage run played through, from the
// abandon to the drop, every step by the real engine (territory-model.md §5, "AS-BUILT — losing ground, engine PR 2").
// Built on sweep-script.js's planted(): g1 holds HOME and TARGET, and its one heavy (P.HEAVY) is berthed at TARGET,
// empty. g1 owns an idle miner at HOME, and an idle miner, an idle factory and an idle Outpost kit at TARGET. Then:
//   held      — nothing lost yet;
//   stranded  — g1 abandons TARGET: the miner, the factory and the kit there are stranded in place, and the heavy is
//               still berthed there, empty — a carrier the pickup can use;
//   loaded    — the heavy loads the stranded miner (loadAsset): the miner is aboard, and the heavy sits idle and laden in
//               the fallow system. The factory now has no carrier: the heavy's hold is locked;
//   inFlight  — the heavy is sent home on a plain dispatch (dispatchVehicle — what the Dispatch popup sends for a route
//               with no stop actions), on its dispatch tick: flying, laden;
//   home      — it has landed at HOME, idle and laden, at a system g1 holds;
//   unloaded  — it unloads (unloadAsset): the miner is an ordinary idle machine at HOME, and the heavy is empty;
//   returned  — the empty heavy flies back to TARGET and lands: the stranded factory has a carrier again, and nothing
//               else about the factory's row has changed.
// And one more, from `stranded`:
//   fleet     — four more of g1's craft beside the heavy, each failing a different carrier gate: a light transport at
//               TARGET (not a heavy), a heavy at TARGET with goods aboard (not empty), a heavy just dispatched out of
//               TARGET (not idle), and an idle, empty heavy at HOME (not in the machine's system).
// It uses ONLY what `main` had at 367a3cf (the fixtures, the operator levers, the salvage actions, the dispatch), so the
// guard's pins can be re-hashed on `main` by requiring this file there.

const {
  createGrantKitAction, createLoadAssetAction, createUnloadAssetAction, createDispatchVehicleAction,
  createAdjustGoodsAction, createTransferCargoAction,
} = require('../actions.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT } = require('../vehicles.js');
const { placeCraft } = require('./kit-fixtures.js');
const P = require('./prefecture-fixtures.js');
const S = require('./sweep-script.js');
const R = require('./eviction-reach-script.js');

const { accept, tickUntil, HEAVY, HOME, AT_HOME, TARGET, AT_TARGET } = P;

const craftOf = (s, id) => S.guildOf(s, 'g1').vehicles.find((v) => v.id === id);
const landed = (id) => (s) => craftOf(s, id).status === 'idle';
const sendTo = (id, anchor) => createDispatchVehicleAction({ guildId: 'g1', vehicleId: id, waypoints: [anchor] });

// salvageRun() -> every state above, and the ids the tests read.
function salvageRun() {
  let s = S.planted();
  let homeMiner; let miner; let factory;
  ({ s, id: homeMiner } = S.grantMachine(s, 'g1', 'miner', HOME.id));
  ({ s, id: miner } = S.grantMachine(s, 'g1', 'miner', TARGET));
  ({ s, id: factory } = S.grantMachine(s, 'g1', 'factory', TARGET));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const kit = S.guildOf(s, 'g1').assets.find((a) => a.kind === 'outpost').id;

  const held = s;
  const stranded = accept(held, S.abandon());
  const loaded = accept(stranded, createLoadAssetAction({ guildId: 'g1', vehicleId: HEAVY, assetId: miner }));
  const inFlight = accept(loaded, sendTo(HEAVY, AT_HOME));
  const home = tickUntil(inFlight, landed(HEAVY));
  const unloaded = accept(home, createUnloadAssetAction({ guildId: 'g1', vehicleId: HEAVY }));
  const returned = tickUntil(accept(unloaded, sendTo(HEAVY, AT_TARGET)), landed(HEAVY));

  // The fleet. The goods heavy is loaded at HOME and then PLACED at TARGET — the stand-in for a flight that
  // eviction-reach-script.js's arrays use — because a fallow system has no pool to load from.
  let f = stranded;
  let light; let goods; let busy; let away;
  ({ s: f, id: light } = R.spawn(f, 'g1', LIGHT_TRANSPORT, AT_TARGET));
  ({ s: f, id: goods } = R.spawn(f, 'g1', HEAVY_TRANSPORT, AT_HOME));
  f = accept(f, createAdjustGoodsAction({ guildId: 'g1', systemId: HOME.id, good: 'titanium', delta: 10 }));
  f = accept(f, createTransferCargoAction({ guildId: 'g1', vehicleId: goods, manifest: [{ dir: 'load', good: 'titanium', qty: 10 }] }));
  f = placeCraft(f, 'g1', goods, AT_TARGET);
  ({ s: f, id: busy } = R.spawn(f, 'g1', HEAVY_TRANSPORT, AT_TARGET));
  f = accept(f, sendTo(busy, AT_HOME));
  ({ s: f, id: away } = R.spawn(f, 'g1', HEAVY_TRANSPORT, AT_HOME));

  return {
    held, stranded, loaded, inFlight, home, unloaded, returned, fleet: f,
    homeMiner, miner, factory, kit, craft: { light, goods, busy, away },
  };
}

module.exports = { salvageRun };
