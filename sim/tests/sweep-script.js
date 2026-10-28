'use strict';

// sweep-script.js — the galaxy the sweep's tests share (losing ground, engine PR 4 — the sweep; design.md §19 #67,
// SETTLED 28-10-26; docs/territory-model.md §4). Built on prefecture-fixtures.js: g1 holds HOME, plants a Prefecture
// in TARGET, builds a position there worth losing, and ABANDONS it, so its machines there are left STRANDED in the
// fallow system. g2, the rival, holds its own starter (RIVAL) and owns one idle miner there — so a machine it
// inherits continues its own numbering rather than starting at 01.
//
// In its own file, apart from sweep.test.js, so the never-sweeps goldens there can be re-hashed on any commit by
// requiring this file: nothing here uses anything the sweep added.

const crypto = require('node:crypto');

const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { getSystemLayout } = require('../seed.js');
const {
  createGrantAssetAction, createGrantKitAction, createEstablishVentureAction, createApplyForLicenceAction,
  createAbandonPrefectureAction,
} = require('../actions.js');
const P = require('./prefecture-fixtures.js');

const { accept, ticks, RIVAL, TARGET, PLANET_A, PLANET_B, SLOT_A1, SLOT_A2, SLOT_B1 } = P;

const PREFECTURE = 'prefecture_g1_01';
// A mineable node in TARGET that is not deuterium (deuterium mines take their own licence path) — from the seed.
const NODE = getSystemLayout(TARGET).planets.flatMap((p) => p.resourceNodes).find((n) => n.resourceType !== 'deuterium');

const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const abandon = () => createAbandonPrefectureAction({ guildId: 'g1', prefectureId: PREFECTURE });
const rivalPlant = (rivalKit) => P.plant('g2', rivalKit, SLOT_B1);

// grantMachine(s, guildId, kind, systemId) -> { s, id }: one idle machine minted by the operator lever (it places
// freely), and its id — the newest of that kind.
function grantMachine(s, guildId, kind, systemId) {
  s = accept(s, createGrantAssetAction({ guildId, kind, systemId }));
  return { s, id: guildOf(s, guildId).assets.filter((a) => a.kind === kind).slice(-1)[0].id };
}

// planted() -> g1 has ferried a Prefecture kit to TARGET (its heavy is still berthed there, empty), surveyed
// PLANET_A and planted on SLOT_A1: it holds TARGET. g2 owns one idle miner at home.
function planted() {
  let { s, kitId } = P.ferried();
  s = P.survey(s, 'g1', PLANET_A);
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  return grantMachine(s, 'g2', 'miner', RIVAL).s;
}

// fallow() -> planted(), then g1 builds a position in TARGET — a LICENSED mine on NODE (m1), a refinery on SLOT_A2
// (f1), an idle factory and an idle Outpost kit — runs 30 ticks, and abandons it. All four are stranded in TARGET, in
// this stored order; the licensed mine's node is locked out (the shared closure writes it).
function fallow() {
  let s = planted();
  let miner; let factory; let idleFactory;
  ({ s, id: miner } = grantMachine(s, 'g1', 'miner', TARGET));
  ({ s, id: factory } = grantMachine(s, 'g1', 'factory', TARGET));
  ({ s, id: idleFactory } = grantMachine(s, 'g1', 'factory', TARGET));
  s = accept(s, createGrantKitAction({ guildId: 'g1', systemId: TARGET, kind: 'outpost' }));
  const outpostKit = guildOf(s, 'g1').assets.find((a) => a.kind === 'outpost').id;
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'm1', type: 'mining', siteId: NODE.id, assetId: miner, resourceType: NODE.resourceType }));
  s = accept(s, createEstablishVentureAction({ guildId: 'g1', ventureId: 'f1', type: 'refining', siteId: SLOT_A2, assetId: factory, recipeId: 'titanium_alloy' }));
  s = accept(s, createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm1', committedOutputPct: 0.5, windowDays: 7 }));
  s = ticks(s, 30);
  s = accept(s, abandon());
  return { s, miner, factory, idleFactory, outpostKit };
}

// rivalReady(s) -> { s, rivalKit }: g2 has an idle Prefecture kit in TARGET and has surveyed PLANET_B — every plant
// gate passes for `rivalPlant(rivalKit)`.
function rivalReady(s) {
  let rivalKit;
  ({ s, kitId: rivalKit } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_B);
  return { s, rivalKit };
}

// --- the two NEVER-SWEEPS galaxies (the byte-identity goldens) ------------------------------------------------------

// ownReclaim() -> fallow(), then g1 plants a second Prefecture in TARGET: its OWN stranded machines are recovered
// (their flags cleared, their ids kept), and nobody else's lie there, so nothing is swept. Run 20 ticks on.
function ownReclaim() {
  let { s } = fallow();
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  return ticks(s, 20);
}

// emptyFallowClaim() -> planted(); g1 abandons with nothing there to strand, and g2 plants in the empty fallow
// system — a rival's claim with nothing to sweep. Run 20 ticks on.
function emptyFallowClaim() {
  let s = accept(planted(), abandon());
  let rivalKit;
  ({ s, rivalKit } = rivalReady(s));
  s = accept(s, rivalPlant(rivalKit));
  return ticks(s, 20);
}

// digest(s) -> the tick, the state hash, and a hash of each view: the god's-eye lens, g1's own, and g2's (the rival's).
function digest(s) {
  const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  return {
    tick: s.tick, state: hashState(s), god: sha(buildSnapshot(s)), g1: sha(buildSnapshot(s, 'g1')), g2: sha(buildSnapshot(s, 'g2')),
  };
}

module.exports = {
  PREFECTURE, NODE, guildOf, abandon, rivalPlant, grantMachine, planted, fallow, rivalReady,
  ownReclaim, emptyFallowClaim, digest,
};
