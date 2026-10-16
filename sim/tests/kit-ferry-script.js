'use strict';

// kit-ferry-script.js — one scripted run of the PRE-SLICE kit ferry and slot paths, end to end through the real
// validate → apply → tick path, for the Prefecture / claims slice's byte proof (roadmap 2.5; read by
// tests/rebanded-goods-delta.test.js). The slice changed three things these paths touch: the unload rule (a
// Prefecture kit may unload into an unclaimed system), the arrival unload (it may now retreat), and the occupancy
// question every establish asks (a Prefecture is an occupant). For every kit that is NOT a Prefecture, and every
// slot no Prefecture stands on, none of that may move a byte — so this script runs exactly those paths:
//   1. an Outpost kit flown to an UNHELD system and refused there (standalone unload), then flown home on a route
//      ending `{ type: 'unload' }` — the on-arrival unload into a held system;
//   2. the same kit loaded again and unloaded by hand at home (the standalone unload);
//   3. a factory established on a home settlement slot, and a second establish on that slot refused;
//   4. the dispatch refusing an unload route to the unheld system up front.
//
// It uses ONLY engine APIs that already existed on main at 79807db, so this very file was copied into a checkout
// of 79807db and run there to record the digests the delta test pins. Keep it that way: if it ever needs a newer
// API, the recorded digests can no longer be re-made from that commit.

const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const A_ = require('../actions.js');
const { getStarterSystems, getSystem, getSystemLayout } = require('../seed.js');
const { hexDistance } = require('../transport.js');
const seed = require('../../data/seed.json');

const G = 'player-guild';
const HOME = getStarterSystems()[0].id;
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME };
const HEAVY = `vehicle_${G}_heavyTransport_01`; // the human founding's starter heavy
const KIT = `asset_${G}_outpost_01`;            // ... and its starter Outpost kit

// The nearest other system to home (a tie → the lower id) — unheld by anyone in this script.
const HOME_HEX = getSystem(HOME).coords;
const AWAY = seed.systems
  .filter((sys) => sys.id !== HOME)
  .map((sys) => ({ id: sys.id, d: hexDistance(HOME_HEX, sys.coords) }))
  .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))[0].id;
const AT_AWAY = { landmarkKind: 'system', landmarkId: AWAY };

// A home settlement slot (the first, in seed order), for the factory.
const SLOT = getSystemLayout(HOME).planets.find((p) => p.settlementSlots.length).settlementSlots[0].id;

function act(s, action) {
  const { valid, reason } = A_.validateAction(s, action);
  if (!valid) throw new Error(`kit ferry script: ${action.type} refused at tick ${s.tick} — ${reason}`);
  return A_.applyAction(s, action);
}
function ask(s, action) {
  const { valid, reason } = A_.validateAction(s, action);
  return valid ? { valid } : { valid, reason };
}
function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds[0].vehicles.every((v) => v.status === 'idle')) return s;
    s = advance(s, []).state;
  }
  throw new Error('kit ferry script: a craft never landed');
}
const unloadRoute = (anchor) => A_.createDispatchRouteWithActionsAction({
  guildId: G, vehicleId: HEAVY, waypoints: [{ anchor, action: { type: 'unload' } }],
});
const newestKitId = (s) => `asset_${G}_outpost_${String(s.guilds[0].kitAssetSerial).padStart(2, '0')}`;

// kitFerryScript() -> { steps: { name: state }, reasons: { name: { valid, reason? } } }
function kitFerryScript() {
  const steps = {};
  const reasons = {};
  let s = act(createZeroState(), A_.createFoundGuildAction({ guildId: G, name: 'Player', credits: 2000, influence: 100, homeSystemId: HOME }));
  s = act(s, A_.createAdjustFuelAction({ guildId: G, delta: 5000 }));

  // 1. Away and refused, then home on an unload route.
  s = act(s, A_.createLoadKitAction({ guildId: G, vehicleId: HEAVY, assetId: KIT }));
  s = tickToIdle(act(s, A_.createDispatchVehicleAction({ guildId: G, vehicleId: HEAVY, waypoints: [AT_AWAY] })));
  reasons.unloadAtUnheld = ask(s, A_.createUnloadKitAction({ guildId: G, vehicleId: HEAVY }));
  s = tickToIdle(act(s, unloadRoute(AT_HOME)));
  steps.unloadOnArrival = s;

  // 2. Loaded again, unloaded by hand at home.
  s = act(s, A_.createLoadKitAction({ guildId: G, vehicleId: HEAVY, assetId: newestKitId(s) }));
  reasons.unloadRouteToUnheld = ask(s, unloadRoute(AT_AWAY));
  s = act(s, A_.createUnloadKitAction({ guildId: G, vehicleId: HEAVY }));
  steps.standaloneUnload = s;

  // 3. A factory on a home slot, and a second establish on it refused.
  s = act(s, A_.createGrantAssetAction({ guildId: G, kind: 'factory', systemId: HOME }));
  const factory = s.guilds[0].assets.find((a) => a.kind === 'factory').id;
  s = act(s, A_.createEstablishVentureAction({
    guildId: G, ventureId: `${G}_${SLOT}`, siteId: SLOT, type: 'refining', recipeId: 'titanium_alloy', assetId: factory,
  }));
  s = act(s, A_.createGrantAssetAction({ guildId: G, kind: 'factory', systemId: HOME }));
  const second = s.guilds[0].assets.filter((a) => a.kind === 'factory').map((a) => a.id).find((id) => id !== factory);
  reasons.secondOnSlot = ask(s, A_.createEstablishVentureAction({
    guildId: G, ventureId: `${G}_${SLOT}_b`, siteId: SLOT, type: 'refining', recipeId: 'titanium_alloy', assetId: second,
  }));
  for (let i = 0; i < 30; i += 1) s = advance(s, []).state;
  steps.factoryOnSlot = s;
  return { steps, reasons };
}

module.exports = { kitFerryScript };
