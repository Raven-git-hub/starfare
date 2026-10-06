'use strict';

// idle-array-script.js — a scripted galaxy holding an IDLE Deep Scan Array (no scan job), for the 2.5 (b2)
// byte-identical proof in deep-scan-job.test.js.
//
// The scan job is an omit-when-idle field, so a galaxy whose arrays are all idle must hash, and serve, exactly
// the bytes it did before the scan existed. This script uses ONLY what main had at 52e5e3f (2.5 (b1)) —
// founding, the kit fixtures, the manual deploy and plain ticks — so it runs unchanged on that commit, and the
// hashes it gives there are pinned in the test. Two human guilds; A deploys one array touching its home; then
// three ticks, so the end-of-tick block has run over a state holding an array.

const { createZeroState } = require('../scenarios/zero-state.js');
const A_ = require('../actions.js');
const { advance } = require('../run.js');
const { getStarterSystems, getSystem, getClaimRadius, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');

const A = 'scan-guild';
const B = 'rival-guild';

function ok(state, actions) {
  const { state: next, results } = A_.intake(state, actions);
  for (const r of results) {
    if (!r.accepted) throw new Error(`idle-array script: ${r.action.type} refused at tick ${state.tick} — ${r.reason}`);
  }
  return next;
}

// deployArrayAtHome(s, guildId, home) -> `s` with one array of `guildId`'s on the first bare hex (in a fixed
// direction order) touching its home's footprint: an array kit granted at home and loaded onto the guild's
// starter heavy, the heavy PLACED on the hex (the stand-in for a flight), then the real manual deploy.
function deployArrayAtHome(s, guildId, home) {
  const heavy = `vehicle_${guildId}_heavyTransport_01`;
  const centre = getSystem(home).coords;
  const ring = getClaimRadius(home) + 1;
  const hex = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }]
    .map((d) => ({ q: centre.q + ring * d.q, r: centre.r + ring * d.r }))
    .find((h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r));
  const laden = placeCraft(kitAboard(s, guildId, heavy, 'deepScan'), guildId, heavy, hex);
  return ok(laden, [A_.createDeployAssetAction({ guildId, vehicleId: heavy })]);
}

function idleArrayScript() {
  const [aHome, bHome] = getStarterSystems().map((s) => s.id);
  let s = ok(createZeroState(), [
    A_.createFoundGuildAction({ guildId: A, name: 'Scanner', credits: 2000, influence: 100, homeSystemId: aHome }),
    A_.createFoundGuildAction({ guildId: B, name: 'Rival', credits: 2000, influence: 100, homeSystemId: bHome }),
  ]);
  const deployed = deployArrayAtHome(s, A, aHome);
  s = deployed;
  for (let i = 0; i < 3; i += 1) s = advance(s, []).state;
  return { steps: { deployed, ticked: s }, A, B, aHome, bHome, deployArrayAtHome, ok };
}

module.exports = { idleArrayScript };
