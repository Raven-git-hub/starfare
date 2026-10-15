'use strict';

// installation-kit-fixtures.js — the small galaxy the installation-kit acquire tests share (roadmap 2.5, the
// Deep Scan Array acquire half; docs/asset-purchase.md §"Installation kits", RULED 15-10-26).
//
// One guild, g1, HOLDS a real starter system (HOME) and owns a DOCKYARD there (an unseated factory venture in
// construct mode — the dockyard tests' own shape: occupancy rules skip a venture with no assetId) and one idle,
// empty HEAVY berthed at home. Everything a kit's life needs is in reach: the yard builds one, the Syndicate
// sells one, the heavy loads, ferries and deploys it. A rival, g2, holds its own starter far away, so a scan has
// rival ground to be refused on and unclaimed ground to survey.
//
// Every action goes through the real validate → apply path; a refusal THROWS with the engine's reason, so a
// fixture never quietly builds a state the engine would not.

const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { checkInvariants } = require('../invariants.js');
const { hexDistance } = require('../transport.js');
const {
  getSystem, getClaimRadius, getStarterSystems, getTerranHomeworld, isHexInBounds, seedLandmarkAtHex,
} = require('../seed.js');
const { HEAVY_TRANSPORT } = require('../vehicles.js');
const { validateAction, applyAction, createSpawnVehicleAction } = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const HOME = starterHomeAtDistance(6); // a real starter system, 6 hexes from its nearest waystation
const AT_HOME = { landmarkKind: 'system', landmarkId: HOME.id };
const HOME_HEX = getSystem(HOME.id).coords;
const RIVAL = getStarterSystems().map((s) => s.id).find((id) => hexDistance(getSystem(id).coords, HOME_HEX) > 20);
const YARD = 'yard1';
const HEAVY = 'vehicle_g1_heavyTransport_01'; // the first craft spawnVehicle mints for g1

const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

// kitGalaxy({ credits, fuelHoard, stock, queue }) -> the shared galaxy. `stock` is g1's HOME pool (the yard
// builds from it); `queue` seeds the yard's build queue, for a test that needs a build already under way.
function kitGalaxy({ credits = 0, fuelHoard = 0, stock = {}, queue = [] } = {}) {
  let s = createState({
    guilds: [
      {
        id: 'g1', credits, fuelHoard, homeSystemId: HOME.id, homePlanetId: HOME.homePlanet,
        stockpiles: { [HOME.id]: { ...stock } },
        ventures: [{
          id: YARD, ownerGuildId: 'g1', type: 'refining', systemId: HOME.id,
          dockyard: true, buildQueue: queue.map((e) => ({ ...e })), nextCommissionId: queue.length,
        }],
      },
      { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: RIVAL, homePlanetId: getTerranHomeworld(RIVAL) },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', HOME.id), claimOf('g2', RIVAL)],
  });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: HEAVY_TRANSPORT, location: AT_HOME }));
  return s;
}

// accept = the POST /action path in-process: validate, apply, then every invariant with NO tick between.
function accept(state, action) {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected ${action.type} accepted at tick ${state.tick}, got: ${reason}`);
  const next = applyAction(state, action);
  assert.deepEqual(checkInvariants(next, next.tick), [], `invariants after ${action.type} at tick ${next.tick}`);
  return next;
}

// refuse -> the engine's reason; fails the test if the action is accepted.
function refuse(state, action) {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, `expected ${action.type} refused at tick ${state.tick}`);
  return reason;
}

// ticks(s, n) -> `s` advanced n ticks. advance() asserts EVERY invariant on EVERY tick and throws with the tick
// number on a violation, so a run through here is the "every invariant holds every tick" proof.
function ticks(s, n) {
  for (let i = 0; i < n; i += 1) s = advance(s, []).state;
  return s;
}

// tickUntil(s, done, limit) -> the first state (each tick through advance) for which `done(state)` is true.
// Throws, naming the tick, if it never comes — a stuck build or flight fails loudly instead of hanging.
function tickUntil(s, done, limit = 20_000) {
  for (let i = 0; i < limit; i += 1) {
    if (done(s)) return s;
    s = advance(s, []).state;
  }
  throw new Error(`installation-kit fixture: the awaited condition never held (gave up at tick ${s.tick})`);
}

const g1Of = (s) => s.guilds.find((g) => g.id === 'g1');
const yardOf = (s) => g1Of(s).ventures.find((v) => v.id === YARD);
const heavyOf = (s) => g1Of(s).vehicles.find((v) => v.id === HEAVY);
const kitsOf = (s) => (g1Of(s).assets || []).map((a) => a.id);

// The first bare, in-bounds hex `ring` steps from home along one of the six axial directions (fixed order) —
// derived from the seed, so a regen carries the tests. `ring = claimRadius + 1` is the ring of hexes touching
// home's footprint: where a Deep Scan Array may attach (docs/exploration-model.md §5).
const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
function bareHexFromHome(ring) {
  const hex = DIRS.map((d) => ({ q: HOME_HEX.q + ring * d.q, r: HOME_HEX.r + ring * d.r }))
    .find((h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r));
  if (!hex) throw new Error(`installation-kit fixture: no bare hex ${ring} from home on this seed`);
  return hex;
}
const ATTACHED_HEX = bareHexFromHome(getClaimRadius(HOME.id) + 1);

module.exports = {
  HOME, AT_HOME, HOME_HEX, RIVAL, YARD, HEAVY, ATTACHED_HEX,
  kitGalaxy, accept, refuse, ticks, tickUntil, bareHexFromHome, g1Of, yardOf, heavyOf, kitsOf,
};
