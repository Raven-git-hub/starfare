'use strict';

// outpost-deploy-script.js — one scripted run of the OUTPOST deploy path, end to end, through the real
// validate → apply → tick path: the manual deploy, the on-arrival deploy, the on-arrival failure and its
// retreat, and every refusal the outpost placement rule gives. tests/deep-scan-array.test.js runs it and
// compares the result with hashes RECORDED ON main (a60d98e) — before the Deep Scan Array generalised the
// deploy rule (roadmap 2.5 (b1)) — which is the proof that the outpost path did not move a byte.
//
// It uses ONLY engine APIs that already existed on main at a60d98e, so this very file was copied into a
// checkout of main and run there to record those hashes. Keep it that way: if it ever needs a newer API,
// the recorded hashes can no longer be re-made from main.

const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const A_ = require('../actions.js');
const { getStarterSystems, getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { hexDistance } = require('../transport.js');

const G = 'player-guild';
const HOME = getStarterSystems()[0].id;
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME };
const HOME_HEX = getSystem(HOME).coords;
const HEAVY = `vehicle_${G}_heavyTransport_01`; // the human founding's starter heavy

// act(s, action) -> the next state. A refusal THROWS with the engine's reason: the script must never
// quietly build a state the engine would not.
function act(s, action) {
  const { valid, reason } = A_.validateAction(s, action);
  if (!valid) throw new Error(`outpost deploy script: ${action.type} refused at tick ${s.tick} — ${reason}`);
  return A_.applyAction(s, action);
}

// ask(s, action) -> { valid, reason } — a refusal recorded, not thrown.
function ask(s, action) {
  const { valid, reason } = A_.validateAction(s, action);
  return valid ? { valid } : { valid, reason };
}

function tickToIdle(s) {
  for (let i = 0; i < 20_000; i += 1) {
    if (s.guilds[0].vehicles.every((v) => v.status === 'idle')) return s;
    s = advance(s, []).state;
  }
  throw new Error('outpost deploy script: a craft never landed');
}

// freeHexAt(d, skip) -> the (skip+1)-th in-bounds hex EXACTLY `d` hexes from home that holds no seed
// landmark, in a fixed scan order — derived from the seed, so the script reads the same on every run.
function freeHexAt(d, skip = 0) {
  let seen = 0;
  for (let q = HOME_HEX.q - d; q <= HOME_HEX.q + d; q += 1) {
    for (let r = HOME_HEX.r - d; r <= HOME_HEX.r + d; r += 1) {
      if (hexDistance({ q, r }, HOME_HEX) !== d || !isHexInBounds(q, r) || seedLandmarkAtHex(q, r)) continue;
      if (seen === skip) return { q, r };
      seen += 1;
    }
  }
  throw new Error(`outpost deploy script: no free hex ${d} from home`);
}

const deployTo = (hex) => A_.createDispatchRouteWithActionsAction({
  guildId: G, vehicleId: HEAVY, waypoints: [{ anchor: hex, action: { type: 'deploy', kind: 'outpost' } }],
});
const flyHome = (s) => tickToIdle(act(s, A_.createDispatchVehicleAction({ guildId: G, vehicleId: HEAVY, waypoints: [AT_HOME] })));
// grant one outpost kit at home and load it onto the heavy (which must be idle at home, empty).
function loadFreshKit(s) {
  s = act(s, A_.createGrantKitAction({ guildId: G, systemId: HOME, kind: 'outpost' }));
  const serial = s.guilds[0].kitAssetSerial;
  return act(s, A_.createLoadKitAction({ guildId: G, vehicleId: HEAVY, assetId: `asset_${G}_outpost_${String(serial).padStart(2, '0')}` }));
}

// outpostDeployScript() -> { steps: { name: state }, reasons: { name: { valid, reason? } } }
function outpostDeployScript() {
  const steps = {};
  const hexA = freeHexAt(2, 0);
  const hexB = freeHexAt(2, 1);
  const hexC = freeHexAt(2, 2);

  let s = act(createZeroState(), A_.createFoundGuildAction({ guildId: G, name: 'Player', credits: 2000, influence: 100, homeSystemId: HOME }));
  s = act(s, A_.createAdjustFuelAction({ guildId: G, delta: 5000 })); // the heavy burns 100 a hex

  // 1. MANUAL: load the starter kit, fly to hexA, deploy by hand → outpost_01.
  s = act(s, A_.createLoadKitAction({ guildId: G, vehicleId: HEAVY, assetId: `asset_${G}_outpost_01` }));
  s = tickToIdle(act(s, A_.createDispatchVehicleAction({ guildId: G, vehicleId: HEAVY, waypoints: [hexA] })));
  s = act(s, A_.createDeployAssetAction({ guildId: G, vehicleId: HEAVY }));
  steps.manualDeploy = s;

  // 2. ON ARRIVAL: home, a fresh kit, a route ending in a deploy at hexB → outpost_02 on the arrival tick.
  s = loadFreshKit(flyHome(s));
  s = tickToIdle(act(s, deployTo(hexB)));
  steps.arrivalDeploy = s;

  // 3. ON-ARRIVAL FAILURE: a route to hexC, which the operator occupies while the craft flies → the craft
  //    retreats toward home (hexC is 2 away, inside the 3-hex step, so it lands AT home), kit aboard,
  //    flagged deployFailed 'occupied', with a deploy_failed notice.
  s = loadFreshKit(flyHome(s));
  s = act(s, deployTo(hexC));
  s = act(s, A_.createSpawnOutpostAction({ guildId: G, anchorSystemId: HOME, coords: hexC }));
  s = tickToIdle(s);
  steps.arrivalRetreat = s;

  // 4. THE REFUSALS — every answer the outpost rule gives, asked of the laden heavy (kit aboard, at home).
  const reasons = {};
  reasons.dispatchToLandmark = ask(s, deployTo(AT_HOME));
  reasons.dispatchToOccupied = ask(s, deployTo(hexA));
  reasons.dispatchInRange = ask(s, deployTo(freeHexAt(10)));
  reasons.dispatchOutOfRange = ask(s, deployTo(freeHexAt(11)));
  reasons.manualAtLandmark = ask(s, A_.createDeployAssetAction({ guildId: G, vehicleId: HEAVY }));
  // The manual deploy asked of the same heavy PLACED on other hexes (the stand-in for a flight, as
  // tests/kit-fixtures.js `placeCraft` does) — a copy, so the run above is untouched.
  const placedAt = (hex) => {
    const c = JSON.parse(JSON.stringify(s));
    c.guilds[0].vehicles.find((v) => v.id === HEAVY).location = { ...hex };
    return ask(c, A_.createDeployAssetAction({ guildId: G, vehicleId: HEAVY }));
  };
  reasons.manualOnOccupied = placedAt(hexB);
  reasons.manualInRange = placedAt(freeHexAt(10, 1));
  reasons.manualOutOfRange = placedAt(freeHexAt(11, 1));
  return { steps, reasons };
}

module.exports = { outpostDeployScript };
