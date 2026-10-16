'use strict';

// prefecture-fixtures.js — the small galaxy the Prefecture / claims tests share (roadmap 2.5, the first Prefecture /
// claims slice, engine PR 1; docs/territory-model.md §4). Built on installation-kit-fixtures.js: g1 holds HOME (with
// a dockyard and one idle, empty heavy), and g2, a rival, holds its own starter far away.
//
// What this adds is the GROUND TO CLAIM: TARGET, the nearest system to HOME that is unclaimed, not a starter (so no
// founding ever lands there), and has at least two settleable planets, the first with at least two slots — so one
// test can put a factory and a flag on one planet, and another can survey one planet and try to plant on the other.
// All of it is DERIVED from the seed, so a regen carries the tests.
//
// Every action goes through the real validate → apply path (installation-kit-fixtures.js `accept`, which also checks
// every invariant after it); a refusal THROWS, so a fixture never builds a state the engine would not.

const { getStarterSystems, getSystem, getSystemLayout } = require('../seed.js');
const { hexDistance } = require('../transport.js');
const { assetId } = require('../assets.js');
const {
  createGrantKitAction, createLoadKitAction, createRevealAction, createPlantPrefectureAction,
  createDispatchRouteWithActionsAction,
} = require('../actions.js');
const K = require('./installation-kit-fixtures.js');
const seed = require('../../data/seed.json');

const STARTERS = new Set(getStarterSystems().map((s) => s.id));
const TARGET = seed.systems
  .filter((sys) => sys.id !== K.HOME.id && sys.id !== K.RIVAL && !STARTERS.has(sys.id))
  .map((sys) => ({ id: sys.id, d: hexDistance(K.HOME_HEX, sys.coords), planets: getSystemLayout(sys.id).planets.filter((p) => p.settlementSlots.length) }))
  .filter((x) => x.planets.length >= 2 && x.planets[0].settlementSlots.length >= 2)
  .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))[0].id;
const AT_TARGET = { landmarkKind: 'system', landmarkId: TARGET };
const SETTLED = getSystemLayout(TARGET).planets.filter((p) => p.settlementSlots.length);
const PLANET_A = SETTLED[0].id;                        // two or more slots
const SLOT_A1 = SETTLED[0].settlementSlots[0].id;
const SLOT_A2 = SETTLED[0].settlementSlots[1].id;
const PLANET_B = SETTLED[1].id;                        // another planet of TARGET
const SLOT_B1 = SETTLED[1].settlementSlots[0].id;

// grantPrefectureKit(s, guildId, systemId) -> { s, kitId }: one idle Prefecture kit minted at `systemId` (the
// operator lever — it places freely), and its id (the guild's newest kit serial).
function grantPrefectureKit(s, guildId, systemId) {
  s = K.accept(s, createGrantKitAction({ guildId, systemId, kind: 'prefecture' }));
  const guild = s.guilds.find((g) => g.id === guildId);
  return { s, kitId: assetId(guildId, 'prefecture', guild.kitAssetSerial) };
}

// survey(s, guildId, planetId) -> `s` with that planet's whole surface in the guild's record (the operator reveal —
// the same `reveal` path a Deep Scan Array's L2 scan writes through). The round-trip test surveys with a real array.
const survey = (s, guildId, planetId) => K.accept(s, createRevealAction({ guildId, planetId }));

const plant = (guildId, assetId_, slotId) => createPlantPrefectureAction({ guildId, assetId: assetId_, slotId });
const unloadRoute = (anchor) => createDispatchRouteWithActionsAction({
  guildId: 'g1', vehicleId: K.HEAVY, waypoints: [{ anchor, action: { type: 'unload' } }],
});

// laden(opts) -> { s, kitId }: the shared galaxy, fuelled, with one Prefecture kit granted at HOME and loaded onto
// g1's heavy (berthed at HOME) — ready to be ferried.
function laden(opts = {}) {
  let s = K.kitGalaxy({ fuelHoard: 5_000, ...opts });
  let kitId;
  ({ s, kitId } = grantPrefectureKit(s, 'g1', K.HOME.id));
  s = K.accept(s, createLoadKitAction({ guildId: 'g1', vehicleId: K.HEAVY, assetId: kitId }));
  return { s, kitId };
}

// ferried(opts) -> the galaxy after laden() flies to TARGET on a route ending `{ type: 'unload' }`, landed: the kit
// is an idle asset in TARGET's idle list, under a NEW id (the unload mints it from the serial).
function ferried(opts = {}) {
  let { s } = laden(opts);
  s = K.accept(s, unloadRoute(AT_TARGET));
  s = K.tickUntil(s, (x) => K.heavyOf(x).status === 'idle');
  const kit = (K.g1Of(s).assets || []).find((a) => a.kind === 'prefecture' && a.systemId === TARGET);
  if (!kit) throw new Error(`prefecture fixture: the ferried kit is not in ${TARGET}'s idle list at tick ${s.tick}`);
  return { s, kitId: kit.id };
}

const held = (s, guildId, systemId) => s.claims.some((c) => c.ownerGuildId === guildId && c.landmarkKind === 'system' && c.landmarkId === systemId);

module.exports = {
  ...K,
  TARGET, AT_TARGET, PLANET_A, SLOT_A1, SLOT_A2, PLANET_B, SLOT_B1, TARGET_DISTANCE: hexDistance(K.HOME_HEX, getSystem(TARGET).coords),
  grantPrefectureKit, survey, plant, unloadRoute, laden, ferried, held,
};
