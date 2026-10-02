'use strict';

// kit-fixtures.js — how the deploy tests put an outpost kit aboard a heavy, now that the kit is a
// system-scoped idle asset (design.md §4, RULED 02-10-26; docs/territory-model.md §5 REVISED).
//
// A kit no longer appears straight in a hold. It is GRANTED into a system's inventory as an idle
// 'outpost' asset, then LOADED onto an empty, idle heavy berthed in that same system. `kitAboard` does
// both, through the real validate → apply path; a refusal throws with the engine's reason, so a fixture
// can never quietly build a state the engine would not.
//
// `placeCraft` is the other half. A real flight is 225 ticks a hex, and many deploy rules are about
// WHERE a laden craft sits, not how it got there. So a test that needs a laden heavy out on some hex
// loads it at home and then places it there directly — the stand-in for the flight, the same way these
// tests already set a craft's `status` or `route` by hand to reach an edge case. The tests that fly for
// real (deploy-asset's happy path, every deploy-on-arrival trip) do not use it.
//
// `kitCount` is the kit-conservation tripwire's measure: a kit is in exactly ONE representation at a
// time, so idle kit assets + kit goods aboard craft is unchanged by a load or an unload, and falls by
// one only when a deploy consumes a kit.

const { validateAction, applyAction, createGrantKitAction, createLoadKitAction } = require('../actions.js');
const { assetId, isKitAssetKind } = require('../assets.js');
const { isDeployableGood } = require('../resources.js');

function act(state, action) {
  const { valid, reason } = validateAction(state, action);
  if (!valid) throw new Error(`kit fixture: ${action.type} refused at tick ${state.tick} — ${reason}`);
  return applyAction(state, action);
}

const guildOf = (state, guildId) => state.guilds.find((g) => g.id === guildId);
const craftOf = (state, guildId, vehicleId) => guildOf(state, guildId).vehicles.find((v) => v.id === vehicleId);

// kitAboard(state, guildId, vehicleId) -> the state after one outpost kit is granted into the system the
// heavy is berthed at and loaded onto it. The heavy must be berthed at a system (loadKit's same-system
// rule needs one), idle and empty — loadKit's own gates refuse anything else, loudly.
function kitAboard(state, guildId, vehicleId) {
  const at = craftOf(state, guildId, vehicleId).location;
  if (!at || at.landmarkKind !== 'system') {
    throw new Error(`kit fixture: ${vehicleId} must be berthed at a system to load a kit, but it is at ${JSON.stringify(at)}`);
  }
  let s = act(state, createGrantKitAction({ guildId, systemId: at.landmarkId, kind: 'outpost' }));
  // The kit just minted carries the guild's newest kit serial (sim/assets.js nextKitAssetSerial).
  const kitId = assetId(guildId, 'outpost', guildOf(s, guildId).kitAssetSerial);
  s = act(s, createLoadKitAction({ guildId, vehicleId, assetId: kitId }));
  return s;
}

// placeCraft(state, guildId, vehicleId, location) -> the same state, the craft moved to `location`
// (a landmark ref or a bare hex). Mutates and returns `state`, like the tests' other direct edits.
function placeCraft(state, guildId, vehicleId, location) {
  craftOf(state, guildId, vehicleId).location = { ...location };
  return state;
}

// kitCount(state, guildId) -> { idle, aboard, total }: the guild's idle kit assets, and the kit goods in
// its craft's holds.
function kitCount(state, guildId) {
  const guild = guildOf(state, guildId);
  const idle = (guild.assets || []).filter((a) => isKitAssetKind(a.kind)).length;
  let aboard = 0;
  for (const v of guild.vehicles || []) {
    for (const [good, qty] of Object.entries(v.cargo || {})) {
      if (isDeployableGood(good)) aboard += qty;
    }
  }
  return { idle, aboard, total: idle + aboard };
}

// assertKitsMoved(before, after, guildId, expectedChange, label) — the conservation tripwire. Throws with
// the tick and both counts unless the guild's kit total changed by exactly `expectedChange` (0 for a load
// or an unload, -1 for a deploy, +1 for a grant). A silent kit duplication or loss is what it exists to catch.
function assertKitsMoved(before, after, guildId, expectedChange, label) {
  const was = kitCount(before, guildId);
  const now = kitCount(after, guildId);
  if (now.total - was.total !== expectedChange) {
    throw new Error(`kit conservation broken by ${label} at tick ${after.tick}: guild ${guildId} kits ${JSON.stringify(was)} -> ${JSON.stringify(now)}, expected a change of ${expectedChange}`);
  }
  return now;
}

module.exports = { kitAboard, placeCraft, kitCount, assertKitsMoved };
