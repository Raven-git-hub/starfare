'use strict';

// prefecture-ferry.test.js — the FERRY half of the claim action (roadmap 2.5, the first Prefecture / claims slice,
// engine PR 1; docs/territory-model.md §4 "The ferry" and "Arrival retreat", §5). A Prefecture is a GROUND asset: its
// kit rides the existing load → route → unload pipeline unchanged, with ONE exception and ONE new failure.
//
// The tripwires:
//   1. THE EXCEPTION: a Prefecture kit unloads into an UNCLAIMED system (on arrival, or by hand) — the kit lands in
//      that system's idle list and the unload claims nothing; into a system its guild holds it unloads as any kit
//      does; every OTHER kit keeps the held-system gate, word for word.
//   2. NEVER A RIVAL'S: an unload into a rival-held system is refused up front — at the dispatch (nothing flown,
//      nothing burned) and by hand.
//   3. NOT A SPACE KIT: a deploy can never carry it — refused at the dispatch and by the manual deploy, by name.
//   4. THE ARRIVAL RETREAT: a rival claims the target while the craft flies → the craft RETREATS exactly as a failed
//      deploy does — the retreat landing, the kit aboard, `deployFailed = { reason: 'system-claimed', tick }`, the
//      `deploy_failed` notice — and both forks then work (Return: unload home; Redeploy: on to other unclaimed ground).
//   5. THE RESIDUAL EDGE: a clean unload, then a rival claims the system → the kit sits idle in rival ground; it can
//      be loaded and hauled out (the plant's refusal is in prefecture-plant.test.js).
//   6. KIT CONSERVATION: the load, the unload, the retreat and the return each move NO kit — only the plant
//      consumes one.
//   7. DETERMINISM: the ferry-and-retreat run replays byte-identically, and a mid-flight save resumes identically.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { getSystem, getStarterSystems, getSystemLayout, isHexInBounds } = require('../seed.js');
const { hexDistance, hexStepToward } = require('../transport.js');
const { DEPLOY_RETREAT_HEXES } = require('../outposts.js');
const { kitCount, assertKitsMoved, placeCraft } = require('./kit-fixtures.js');
const {
  createUnloadKitAction, createDeployAssetAction, createDispatchRouteWithActionsAction, createGrantKitAction,
  createLoadKitAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');
const seed = require('../../data/seed.json');

const { accept, refuse, tickUntil, heavyOf, g1Of, HEAVY, HOME, AT_HOME, TARGET, AT_TARGET, RIVAL } = P;
const landed = (s) => tickUntil(s, (x) => heavyOf(x).status === 'idle');
const unloadBy = (guildId = 'g1') => createUnloadKitAction({ guildId, vehicleId: HEAVY });
const kitsIn = (s, systemId) => (g1Of(s).assets || []).filter((a) => a.kind === 'prefecture' && a.systemId === systemId).map((a) => a.id);

// g2 claims TARGET the real way: a Prefecture kit granted at TARGET, the planet surveyed, the flag planted.
function rivalClaimsTarget(s) {
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', P.PLANET_A);
  return accept(s, P.plant('g2', kitId, P.SLOT_A1));
}

// --- 1. the exception ------------------------------------------------------------------------------------------

test('the ferry: a Prefecture kit flown to an UNCLAIMED system on an unload route lands in its idle list — and claims nothing', () => {
  const { s: before } = P.laden();
  assert.equal(P.held(before, 'g1', TARGET), false, 'TARGET is unclaimed');
  const { s, kitId } = P.ferried();
  const craft = heavyOf(s);
  assert.deepEqual(craft.location, AT_TARGET, 'the heavy is berthed at TARGET');
  assert.equal(craft.cargo, undefined, 'the hold is empty');
  assert.equal(craft.route, undefined, 'the one-shot run ended');
  assert.equal(craft.deployFailed, undefined);
  assert.deepEqual(g1Of(s).assets.find((a) => a.id === kitId), { id: kitId, kind: 'prefecture', systemId: TARGET, maintenanceCondition: 1 });
  assert.equal(P.held(s, 'g1', TARGET), false, 'unloading the kit is not the claim — the plant is');
  assert.equal(s.claims.length, before.claims.length, 'no claim row written');
});

test('by hand: a Prefecture kit unloads at an unclaimed system; an Outpost kit there is still refused, word for word', () => {
  let { s } = P.laden();
  s = placeCraft(s, 'g1', HEAVY, AT_TARGET); // the stand-in for the flight (kit-fixtures.js)
  const after = accept(s, unloadBy());
  assert.deepEqual(kitsIn(after, TARGET).length, 1);

  // The same heavy and berth with an Outpost kit aboard: the held-system gate is unchanged for every other kit.
  let o = P.kitGalaxy({ fuelHoard: 5_000 });
  o = accept(o, createGrantKitAction({ guildId: 'g1', systemId: HOME.id, kind: 'outpost' }));
  o = accept(o, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: g1Of(o).assets[0].id }));
  o = placeCraft(o, 'g1', HEAVY, AT_TARGET);
  assert.equal(refuse(o, unloadBy()), `guild "g1" does not hold system "${TARGET}" — a kit unloads only into a system its guild holds`);
});

test('into a system its guild holds, a Prefecture kit unloads as any kit does — at home, by hand', () => {
  const { s } = P.laden();
  const after = accept(s, unloadBy());
  assert.equal(kitsIn(after, HOME.id).length, 1);
  assert.equal(heavyOf(after).cargo, undefined);
});

// --- 2. never a rival's ----------------------------------------------------------------------------------------

test('never a rival\'s: the dispatch refuses an unload route into rival-held ground UP FRONT — nothing flies, nothing burns', () => {
  let { s } = P.laden();
  s = rivalClaimsTarget(s);
  const fuel = g1Of(s).fuelHoard;
  assert.equal(refuse(s, P.unloadRoute(AT_TARGET)),
    `the unload at waypoint 0 would fail now — system "${TARGET}" is held by guild "g2" — a Prefecture kit unloads into an unclaimed system or one its guild holds, never into a rival's`);
  // The rival's HOME is refused the same way (a founding claim is a hold like any other).
  assert.match(refuse(s, P.unloadRoute({ landmarkKind: 'system', landmarkId: RIVAL })), new RegExp(`system "${RIVAL}" is held by guild "g2"`));
  assert.equal(g1Of(s).fuelHoard, fuel, 'no fuel burned');
  assert.deepEqual(heavyOf(s).location, AT_HOME, 'the heavy never left');
});

test('never a rival\'s, by hand: a heavy berthed in rival-held ground cannot drop the kit there', () => {
  let { s } = P.laden();
  s = rivalClaimsTarget(s);
  s = placeCraft(s, 'g1', HEAVY, AT_TARGET);
  assert.match(refuse(s, unloadBy()), new RegExp(`system "${TARGET}" is held by guild "g2" — a Prefecture kit unloads into an unclaimed system or one its guild holds, never into a rival's`));
});

// --- 3. not a space kit ----------------------------------------------------------------------------------------

test('not a space kit: a deploy waypoint can never name it, and the manual deploy refuses it by name', () => {
  const { s } = P.laden();
  const bare = P.ATTACHED_HEX;
  assert.equal(refuse(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: HEAVY, waypoints: [{ anchor: bare, action: { type: 'deploy', kind: 'prefecture' } }],
  })), 'waypoint 0 deploy action: a "prefecture" kit is not deployed on a hex — end the route at a system with { type: "unload" } and plant it there (plantPrefecture)');
  // An unknown kind keeps its old refusal — listing the SPACE kinds only, as before.
  assert.equal(refuse(s, createDispatchRouteWithActionsAction({
    guildId: 'g1', vehicleId: HEAVY, waypoints: [{ anchor: bare, action: { type: 'deploy', kind: 'tollGate' } }],
  })), 'waypoint 0 deploy action: "tollGate" is not a deployable kind with a kit (known: outpost, deepScan)');
  const onHex = placeCraft(s, 'g1', HEAVY, bare);
  assert.equal(refuse(onHex, createDeployAssetAction({ guildId: 'g1', vehicleId: HEAVY })),
    `vehicle "${HEAVY}" carries a prefecture_kit — a Prefecture is not deployed on a hex; unload it into a system and plant it on a settlement slot (plantPrefecture)`);
});

// --- 4. the arrival retreat ------------------------------------------------------------------------------------

// The retreat the ruling names: g1's heavy is in flight to TARGET when g2 claims it.
function retreated() {
  let { s } = P.laden();
  s = accept(s, P.unloadRoute(AT_TARGET));
  assert.equal(heavyOf(s).status, 'inTransit');
  s = rivalClaimsTarget(s); // while the craft flies
  return landed(s);
}

test('ARRIVAL RETREAT: a rival claims the target in flight — the craft pulls back exactly as a failed deploy does', () => {
  const s = retreated();
  const craft = heavyOf(s);
  const arrivalTick = craft.deployFailed.tick;
  // TARGET is within DEPLOY_RETREAT_HEXES of home, so the snap lands AT home, parked (the retreat rule).
  assert.ok(P.TARGET_DISTANCE <= DEPLOY_RETREAT_HEXES, 'this fixture\'s target is inside one retreat step of home');
  assert.deepEqual(craft.location, AT_HOME);
  assert.equal(craft.status, 'idle');
  assert.deepEqual(craft.cargo, { prefecture_kit: 1 }, 'the kit stays aboard');
  assert.equal(craft.route, undefined, 'the one-shot run ended');
  assert.deepEqual(craft.deployFailed, { reason: 'system-claimed', tick: arrivalTick });
  assert.equal(craft.updatedAtTick, arrivalTick, '§15.2: the retreat records its tick');
  assert.equal(kitsIn(s, TARGET).length, 0, 'nothing was dropped in rival ground');
  // THE NOTICE — the outpost's own `deploy_failed`, with the new cause.
  const notice = g1Of(s).events.filter((e) => e.type === 'deploy_failed');
  assert.equal(notice.length, 1);
  assert.equal(notice[0].tick, arrivalTick);
  assert.deepEqual(notice[0].payload, {
    cause: 'system-claimed',
    kind: 'prefecture',
    targetHex: getSystem(TARGET).coords,
    craftId: HEAVY,
    craftClass: 'heavyTransport',
    retreatSystemId: HOME.id,
    retreatSystemName: getSystem(HOME.id).name || HOME.id,
  });
});

test('ARRIVAL RETREAT, far target: the snap lands DEPLOY_RETREAT_HEXES from the target, toward home, on a bare hex', () => {
  const starters = new Set(getStarterSystems().map((x) => x.id));
  // The nearest unclaimed, non-starter system more than one retreat step from home — derived from the seed.
  const far = seed.systems
    .filter((x) => !starters.has(x.id) && x.id !== TARGET && hexDistance(P.HOME_HEX, x.coords) > DEPLOY_RETREAT_HEXES + 1)
    .map((x) => ({ id: x.id, d: hexDistance(P.HOME_HEX, x.coords) }))
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))[0].id;
  const planet = getSystemLayout(far).planets.find((p) => p.settlementSlots.length);
  let { s } = P.laden();
  s = accept(s, P.unloadRoute({ landmarkKind: 'system', landmarkId: far }));
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', far));
  s = P.survey(s, 'g2', planet.id);
  s = accept(s, P.plant('g2', kitId, planet.settlementSlots[0].id));
  s = landed(s);
  const step = hexStepToward(getSystem(far).coords, P.HOME_HEX, DEPLOY_RETREAT_HEXES);
  assert.equal(step.reached, false);
  assert.ok(isHexInBounds(step.hex.q, step.hex.r));
  assert.deepEqual(heavyOf(s).location, step.hex, 'three hexes from the target, straight toward home');
  assert.equal(heavyOf(s).deployFailed.reason, 'system-claimed');
});

test('after the retreat, both forks work: Return (unload home) clears the flag; Redeploy flies on to other unclaimed ground', () => {
  const s = retreated();
  // Return: the heavy is already at home, so the unload acts in place (transport-model.md §11.9).
  const home = landed(accept(s, P.unloadRoute(AT_HOME)));
  assert.equal(kitsIn(home, HOME.id).length, 1, 'the kit is back in the home idle list');
  assert.equal(heavyOf(home).deployFailed, undefined, 'the unload clears the flag (kitIntoInventory)');
  // Redeploy: the same kit, aboard, to another unclaimed system — the exception again.
  const other = seed.systems.map((x) => x.id).find((id) => id !== TARGET && !s.claims.some((c) => c.landmarkId === id)
    && hexDistance(P.HOME_HEX, getSystem(id).coords) <= 4);
  const redeployed = landed(accept(s, P.unloadRoute({ landmarkKind: 'system', landmarkId: other })));
  assert.equal(kitsIn(redeployed, other).length, 1);
  assert.equal(heavyOf(redeployed).deployFailed, undefined);
});

// --- 5. the residual edge ----------------------------------------------------------------------------------------

test('the residual edge: a clean unload, then a rival claims — the kit idles in rival ground, and can be loaded and hauled out', () => {
  let { s, kitId } = P.ferried();
  s = rivalClaimsTarget(s);
  assert.deepEqual(kitsIn(s, TARGET), [kitId], 'the kit is still idle in TARGET');
  s = accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: HEAVY, assetId: kitId }));
  s = landed(accept(s, P.unloadRoute(AT_HOME)));
  assert.equal(kitsIn(s, HOME.id).length, 1, 'hauled home');
});

// --- 6. kit conservation -----------------------------------------------------------------------------------------

test('kit conservation: load, unload, the retreat and the return each move no kit — the total stays one throughout', () => {
  let { s } = P.laden();
  assert.deepEqual(kitCount(s, 'g1'), { idle: 0, aboard: 1, total: 1 });
  let next = accept(s, P.unloadRoute(AT_TARGET));
  assertKitsMoved(s, next, 'g1', 0, 'the dispatch');
  next = rivalClaimsTarget(next);
  const back = landed(next);
  assertKitsMoved(next, back, 'g1', 0, 'the retreat');
  const returned = landed(accept(back, P.unloadRoute(AT_HOME)));
  assertKitsMoved(back, returned, 'g1', 0, 'the return');
  assert.deepEqual(kitCount(returned, 'g1'), { idle: 1, aboard: 0, total: 1 });
});

// --- 7. determinism ----------------------------------------------------------------------------------------------

test('determinism: the ferry-and-retreat run replays byte-identically, and a mid-flight save resumes to the same bytes', () => {
  assert.equal(hashState(retreated()), hashState(retreated()));
  let { s } = P.laden();
  s = accept(s, P.unloadRoute(AT_TARGET));
  s = rivalClaimsTarget(s);
  s = P.ticks(s, 100); // mid-flight
  assert.equal(heavyOf(s).status, 'inTransit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefecture-ferry-'));
  try {
    saveState(s, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(landed(restored)), hashState(landed(s)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
