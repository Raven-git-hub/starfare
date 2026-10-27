'use strict';

// eviction-reach-script.js — the galaxy losing ground engine PR 3's tests evict (design.md §19 #67, SETTLED 19-10-26 —
// the eviction's reach; docs/territory-model.md §4). g1 holds HOME and TARGET (a planted Prefecture,
// prefecture-fixtures.js); g2, a rival, holds its own starter far away. Around TARGET stands everything the eviction
// now reaches — and everything it must leave alone:
//   - LANES, each a continuous lane just launched (in flight on its first leg):
//       stop      — g1's: a dock at TARGET and a dock at HOME, with goods aboard (a stop with an action);
//       rivalStop — g2's: TARGET as a turning point (a stop with no action — still a stop);
//       transit   — g1's: two bare hexes either side of TARGET, so each leg runs straight through its footprint;
//       inside    — g1's: a bare hex INSIDE TARGET's disk — in the footprint, but not the system.
//   - ARRAYS (Deep Scan Arrays), deployed by the real manual deploy:
//       dark      — g1's, beside TARGET's control only, running an L1 scan;
//       idleDark  — g1's, beside TARGET's control only, running nothing;
//       lit       — g1's, beside TARGET's control AND HOME's, running an L1 scan;
//       rival     — g2's, beside g2's own home, running an L1 scan.
//   - AN OUTPOST of g1's inside TARGET's disk, anchored to TARGET.
// It uses ONLY what `main` had at 291df19 (the fixtures, the operator levers, the manual deploy, queueScan, lanes),
// so it runs unchanged there, and the byte-identical test pins the hashes `main` gave for it.

const { getSystem, getClaimRadius, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { hexDistance, hexesWithin } = require('../transport.js');
const { HEAVY_TRANSPORT, LIGHT_TRANSPORT } = require('../vehicles.js');
const {
  createSpawnVehicleAction, createGrantKitAction, createLoadKitAction, createDeployAssetAction, createQueueScanAction,
  createDispatchRouteWithActionsAction, createAdjustFuelAction, createAdjustGoodsAction, createTransferCargoAction,
  createSpawnOutpostAction,
} = require('../actions.js');
const { placeCraft } = require('./kit-fixtures.js');
const P = require('./prefecture-fixtures.js');
const seed = require('../../data/seed.json');

const { accept, g1Of, HOME, AT_HOME, HOME_HEX, TARGET, AT_TARGET, RIVAL, PLANET_A, SLOT_A1 } = P;

// --- the ground, derived from the seed so a regen carries the tests ------------------------------------------------

const TARGET_HEX = getSystem(TARGET).coords;
const RIVAL_HEX = getSystem(RIVAL).coords;
const TARGET_RADIUS = getClaimRadius(TARGET);
const HOME_RADIUS = getClaimRadius(HOME.id);
const bare = (h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r);
const byQR = (a, b) => a.q - b.q || a.r - b.r;
const sameHex = (a, b) => a.q === b.q && a.r === b.r;
const step = (from, d, n) => ({ q: from.q + n * d.q, r: from.r + n * d.r });

// The axis the transit lane flies along: the first of three where the hexes just outside TARGET's disk on BOTH sides
// are bare (CROSS_A / CROSS_B, so a leg between them runs through the centre), and a hex inside the disk on it is too.
const AXIS = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: 1, r: -1 }].find((d) => bare(step(TARGET_HEX, d, TARGET_RADIUS + 1))
  && bare(step(TARGET_HEX, d, -(TARGET_RADIUS + 1))) && bare(step(TARGET_HEX, d, TARGET_RADIUS)));
if (!AXIS) throw new Error('eviction-reach script: no axis with bare hexes across TARGET on this seed');
const CROSS_A = step(TARGET_HEX, AXIS, TARGET_RADIUS + 1);
const CROSS_B = step(TARGET_HEX, AXIS, -(TARGET_RADIUS + 1));
const INSIDE = step(TARGET_HEX, AXIS, TARGET_RADIUS);

// Bare hexes beside TARGET's control (within claimRadius + 1 of its centre), off the transit axis's three hexes.
const besideTarget = hexesWithin(TARGET_HEX, TARGET_RADIUS + 1).filter(bare)
  .filter((h) => ![CROSS_A, CROSS_B, INSIDE].some((x) => sameHex(x, h))).sort(byQR);
// … touching ONLY TARGET's control: more than claimRadius + 1 from HOME's centre.
const onlyTarget = besideTarget.filter((h) => hexDistance(h, HOME_HEX) > HOME_RADIUS + 1);
const DARK_HEX = onlyTarget[0];
// The Outpost: inside TARGET's disk, and NOT beside the dark array's hex — or its control would keep that array lit.
const OUTPOST_HEX = besideTarget.find((h) => hexDistance(h, TARGET_HEX) <= TARGET_RADIUS && hexDistance(h, DARK_HEX) > 1);
// The idle dark array: touching only TARGET's control, and not beside the Outpost either.
const IDLE_DARK_HEX = onlyTarget.find((h) => !sameHex(h, DARK_HEX) && hexDistance(h, OUTPOST_HEX) > 1);
// … touching BOTH TARGET's control and HOME's, so losing TARGET leaves it attached.
const LIT_HEX = besideTarget.find((h) => hexDistance(h, HOME_HEX) <= HOME_RADIUS + 1 && !sameHex(h, OUTPOST_HEX));
// g2's array: the first bare hex on the ring just outside its home's disk.
const RIVAL_ARRAY_HEX = hexesWithin(RIVAL_HEX, getClaimRadius(RIVAL) + 1).filter(bare)
  .filter((h) => hexDistance(h, RIVAL_HEX) === getClaimRadius(RIVAL) + 1).sort(byQR)[0];
for (const [name, hex] of Object.entries({ DARK_HEX, IDLE_DARK_HEX, LIT_HEX, OUTPOST_HEX, RIVAL_ARRAY_HEX })) {
  if (!hex) throw new Error(`eviction-reach script: no ${name} on this seed`);
}

// Unclaimed systems to scan (none is held by anyone here), first by id.
const SCAN_TARGETS = seed.systems.map((sys) => sys.id).filter((id) => ![HOME.id, TARGET, RIVAL].includes(id)).sort().slice(0, 4);

// --- the builders -----------------------------------------------------------------------------------------------------

const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const newestVehicle = (s, guildId) => guildOf(s, guildId).vehicles.slice(-1)[0].id;

// spawn(s, guildId, vehicleClass, location) -> { s, id }: one more craft, minted by the operator lever, and its id.
function spawn(s, guildId, vehicleClass, location) {
  s = accept(s, createSpawnVehicleAction({ guildId, class: vehicleClass, location }));
  return { s, id: newestVehicle(s, guildId) };
}

// deployArray(s, guildId, homeId, hex) -> { s, id }: one Deep Scan Array of the guild's on `hex`, and its id. A fresh
// heavy at the guild's home loads a kit granted there, is PLACED on the hex (the stand-in for a flight the other array
// tests use), and deploys it by the real manual deploy, which judges the hex. The heavy is left parked there, empty.
function deployArray(s, guildId, homeId, hex) {
  let heavy;
  ({ s, id: heavy } = spawn(s, guildId, HEAVY_TRANSPORT, { landmarkKind: 'system', landmarkId: homeId }));
  s = accept(s, createGrantKitAction({ guildId, systemId: homeId, kind: 'deepScan' }));
  const kit = guildOf(s, guildId).assets.filter((a) => a.kind === 'deepScan').slice(-1)[0].id;
  s = accept(s, createLoadKitAction({ guildId, vehicleId: heavy, assetId: kit }));
  s = placeCraft(s, guildId, heavy, hex);
  s = accept(s, createDeployAssetAction({ guildId, vehicleId: heavy }));
  return { s, id: s.deepScanArrays.slice(-1)[0].id }; // the deploy appends the new row
}

const scanL1 = (guildId, arrayId, targetSystemId) => createQueueScanAction({ guildId, arrayId, level: 'L1', targetSystemId });
const lane = (guildId, vehicleId, waypoints) => createDispatchRouteWithActionsAction({ guildId, vehicleId, waypoints, repeat: { mode: 'continuous' } });

// planted() -> g1 has ferried a Prefecture kit to TARGET, surveyed PLANET_A and planted on SLOT_A1: it holds TARGET.
function planted() {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  return accept(s, P.plant('g1', kitId, SLOT_A1));
}

// reachGalaxy() -> the galaxy above, every action accepted on one tick (nothing has ticked since the lanes launched),
// with the ids the tests read.
function reachGalaxy() {
  let s = planted();
  s = accept(s, createAdjustFuelAction({ guildId: 'g2', delta: 5_000 }));

  // The arrays, and their scans.
  let dark; let idleDark; let lit; let rival;
  ({ s, id: dark } = deployArray(s, 'g1', HOME.id, DARK_HEX));
  ({ s, id: idleDark } = deployArray(s, 'g1', HOME.id, IDLE_DARK_HEX));
  ({ s, id: lit } = deployArray(s, 'g1', HOME.id, LIT_HEX));
  ({ s, id: rival } = deployArray(s, 'g2', RIVAL, RIVAL_ARRAY_HEX));
  s = accept(s, scanL1('g1', dark, SCAN_TARGETS[0]));
  s = accept(s, scanL1('g1', lit, SCAN_TARGETS[1]));
  s = accept(s, scanL1('g2', rival, SCAN_TARGETS[2]));

  // The Outpost inside TARGET's disk.
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: TARGET, coords: OUTPOST_HEX }));
  const outpost = s.outposts.slice(-1)[0].id;

  // The lanes. `stop` takes 10 titanium aboard at HOME first, so there are goods in its hold when the lane ends.
  let stop; let rivalStop; let transit; let inside;
  ({ s, id: stop } = spawn(s, 'g1', LIGHT_TRANSPORT, AT_HOME));
  s = accept(s, createAdjustGoodsAction({ guildId: 'g1', systemId: HOME.id, good: 'titanium', delta: 20 }));
  s = accept(s, createTransferCargoAction({ guildId: 'g1', vehicleId: stop, manifest: [{ dir: 'load', good: 'titanium', qty: 10 }] }));
  s = accept(s, lane('g1', stop, [
    { anchor: AT_TARGET, action: { type: 'dock', manifest: [{ dir: 'load', good: 'titanium', max: true }] } },
    { anchor: AT_HOME, action: { type: 'dock', manifest: [{ dir: 'unload', good: 'titanium', max: true }] } },
  ]));
  ({ s, id: rivalStop } = spawn(s, 'g2', LIGHT_TRANSPORT, CROSS_B));
  s = accept(s, lane('g2', rivalStop, [{ anchor: AT_TARGET }, { anchor: CROSS_B }]));
  ({ s, id: transit } = spawn(s, 'g1', LIGHT_TRANSPORT, CROSS_A));
  s = accept(s, lane('g1', transit, [{ anchor: CROSS_B }, { anchor: CROSS_A }]));
  ({ s, id: inside } = spawn(s, 'g1', LIGHT_TRANSPORT, CROSS_A));
  s = accept(s, lane('g1', inside, [{ anchor: INSIDE }, { anchor: CROSS_A }]));

  return { s, arrays: { dark, idleDark, lit, rival }, outpost, craft: { stop, rivalStop, transit, inside } };
}

module.exports = {
  reachGalaxy, planted, deployArray, spawn, scanL1, lane,
  TARGET_HEX, CROSS_A, CROSS_B, INSIDE, DARK_HEX, IDLE_DARK_HEX, LIT_HEX, OUTPOST_HEX, RIVAL_ARRAY_HEX, SCAN_TARGETS,
};
