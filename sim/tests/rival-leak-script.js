'use strict';

// rival-leak-script.js — two scripted galaxies for the ruling-11 cleanup's byte proof (roadmap 2.5, the
// "simplification"; docs/exploration-model.md §4 ruling 11), read by tests/rival-leak-removed.test.js.
//
// The cleanup REMOVED `observePublicRegister`, the end-of-tick step that banked a rival's licensed node into
// every other guild's exploration record. The proof needs main's bytes from BEFORE the removal, so this script
// uses ONLY what main had at 41fe84c — founding, establish, licence, decommission and plain ticks — and runs
// unchanged on that commit. The hashes it gave there are pinned in the test.
//
//   rivalLeakScript — two HUMAN guilds (so both hold the starter fleet and assets). B, the rival, runs a
//                     LICENSED mine (a node), an UNLICENSED mine, and a LICENSED refinery (a settlement slot);
//                     three ticks; then B closes the licensed mine; two more ticks. On main, the end of the
//                     first tick banked B's licensed node and planet into A's record. A has no venture, so B
//                     never learned anything of A's.
//   soloScript      — ONE guild with a licensed mine and two ticks: no rival, so the removed step had nothing
//                     to observe, and every byte must be the same on both sides of the removal.
//
// `afterTick(state)` runs after every tick (default: nothing). The test passes a copy of the removed step
// there, to show it reproduces main exactly.

const { createZeroState } = require('../scenarios/zero-state.js');
const A_ = require('../actions.js');
const { advance } = require('../run.js');
const { getStarterSystems, getTerranHomeworld, getPlanet, getSite } = require('../seed.js');
const { systemControllers } = require('../claims.js');

const A = 'player-guild';
const B = 'rival-guild';
const A_HOME = getStarterSystems()[0].id;
const B_HOME = getStarterSystems()[1].id;
const B_PLANET = getTerranHomeworld(B_HOME);
const B_MINE = `${B_PLANET}_n01`;     // titanium (a Terran homeworld opens titanium, titanium)
const B_MINE_2 = `${B_PLANET}_n02`;
const B_SLOT = `${B_PLANET}_s01`;

function ok(state, actions) {
  const { state: next, results } = A_.intake(state, actions);
  for (const r of results) {
    if (!r.accepted) throw new Error(`rival-leak script: ${r.action.type} refused at tick ${state.tick} — ${r.reason}`);
  }
  return next;
}

function ticks(s, n, afterTick) {
  let out = s;
  for (let i = 0; i < n; i += 1) {
    out = advance(out, []).state;
    afterTick(out);
  }
  return out;
}

function rivalLeakScript({ afterTick = () => {} } = {}) {
  const founded = ok(createZeroState(), [
    A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
    A_.createFoundGuildAction({ guildId: B, name: 'Rival', credits: 2000, influence: 100, homeSystemId: B_HOME }),
  ]);
  let s = ok(founded, [
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_mine', siteId: B_MINE, assetId: `asset_${B}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_mine', committedOutputPct: 1, windowDays: 7 }),
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_mine_2', siteId: B_MINE_2, assetId: `asset_${B}_miner_02`, resourceType: 'titanium', productionRate: 5 }),
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_refinery', siteId: B_SLOT, type: 'refining', recipeId: 'titanium_alloy', assetId: `asset_${B}_factory_01` }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_refinery', committedOutputPct: 1, windowDays: 7 }),
  ]);
  const licensed = ticks(s, 3, afterTick);
  s = ok(licensed, [A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]);
  const closed = ticks(s, 2, afterTick);
  return { founded, licensed, closed };
}

function soloScript({ afterTick = () => {} } = {}) {
  let s = ok(createZeroState(), [
    A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
  ]);
  s = ok(s, [
    A_.createEstablishVentureAction({ guildId: A, ventureId: 'a_mine', siteId: `${getTerranHomeworld(A_HOME)}_n01`, assetId: `asset_${A}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: A, ventureId: 'a_mine', committedOutputPct: 1, windowDays: 7 }),
  ]);
  return { solo: ticks(s, 2, afterTick) };
}

// --- the two STRIPS — the same code on main and after the cleanup, so the proof compares like with like ------

// withoutRivalFacts(state) -> a copy of `state` in which no guild's record holds a planet in a system a RIVAL
// controls. That is exactly what the removed step wrote: the public register lists ventures, and a venture
// sits on its owner's held ground, so every fact it banked lies in a rival-held system. In these scripts
// nothing else puts a rival-held planet in a record (no scans; founding writes only the home). A record left
// empty is dropped (omit-when-empty).
function withoutRivalFacts(state) {
  const controllers = systemControllers(state);
  const out = structuredClone(state);
  for (const g of out.guilds) {
    if (!g.exploration) continue;
    for (const planetId of Object.keys(g.exploration)) {
      const holder = controllers.get(getPlanet(planetId).systemId);
      if (holder && holder !== g.id) delete g.exploration[planetId];
    }
    if (Object.keys(g.exploration).length === 0) delete g.exploration;
  }
  return out;
}

// withoutRivalGround(view) -> a copy of a per-guild view with what it shows of RIVAL-HELD ground taken out:
// the `geography.known` entries of every system a rival controls, and every node lockout on a node in one.
// The cleanup is meant to change the view THERE and nowhere else.
function withoutRivalGround(view) {
  const out = structuredClone(view);
  const rivalHeld = new Set(out.geography.systems
    .filter((s) => s.controllerGuildId && s.controllerGuildId !== out.viewerGuildId)
    .map((s) => s.id));
  for (const systemId of rivalHeld) delete out.geography.known[systemId];
  out.nodeLockouts = out.nodeLockouts.filter((l) => !rivalHeld.has(getSite(l.siteId).systemId));
  return out;
}

module.exports = {
  rivalLeakScript, soloScript, withoutRivalFacts, withoutRivalGround,
  A, B, A_HOME, B_HOME, B_PLANET, B_MINE, B_MINE_2, B_SLOT,
};
