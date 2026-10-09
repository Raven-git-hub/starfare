'use strict';

// exploration.test.js — the per-guild EXPLORATION RECORD (docs/exploration-model.md §3/§6/§7,
// roadmap 2.5 engine slice 1; sim/exploration.js). The tripwires:
//
//   1. REVEAL — the one write path: learn-once (a known fact is a no-op that keeps its first tick),
//      a node or a settlement slot reveals its planet, and a place the seed does not hold is refused loudly.
//   2. FOUNDING seeds the home record: every home planet (L1) and its whole surface — every node and every
//      settlement slot (L2) — stamped at the founding tick, and nothing about any other system (L0 is
//      computed, never recorded).
//   2b. THE SURFACE (the settlement-surface slice, 09-10-26; §4 ruling 10): one L2 reveal learns a planet's
//      nodes AND slots together, and replaying it on a later tick learns nothing and re-stamps nothing.
//   3. A RIVAL TEACHES THE RECORD NOTHING (§4 ruling 11, 08-10-26): a rival's venture — licensed or not,
//      open or closed — never writes any guild's record. The record holds only the guild's own surveys
//      (founding + its Deep Scan Array); a controlled system's surface is shown LIVE in the view instead
//      (tests/fog.test.js). The byte proof of the removal is tests/rival-leak-removed.test.js.
//   4. KNOWN-FOREVER: what the guild did learn is never taken back — the record never shrinks.
//   5. DETERMINISM (invariant 9): the record survives save/restore byte-identically, and two runs agree.
//   6. THE INVARIANT HALTS on a corrupt record (checkExplorationRecord) — the slot track included.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createState, createGuild } = require('../state.js');
const {
  intake,
  createFoundGuildAction, createEstablishVentureAction, createApplyForLicenceAction,
  createDecommissionVentureAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const {
  getSystemLayout, getStarterSystems, getTerranHomeworld, getPlanet, getSite,
} = require('../seed.js');
const {
  reveal, revealSystem, revealSystemArchetypes, revealPlanetSurface, knowsPlanet, knowsNode, cloneExploration,
  isOnPublicRegister,
} = require('../exploration.js');
const exploration = require('../exploration.js');

// Two guilds on the seed's first two starter systems — A the observer (a human founding), B the
// rival (a bot). Both homes and B's mine sites are DERIVED from the seed, never typed in.
const A = 'player-guild';
const B = 'bot-guild';
const A_HOME = getStarterSystems()[0].id;
const B_HOME = getStarterSystems()[1].id;
const B_PLANET = getTerranHomeworld(B_HOME);
const B_MINE = `${B_PLANET}_n01`;    // a Terran homeworld always opens titanium, titanium (§2)
const B_MINE_2 = `${B_PLANET}_n02`;
const B_SLOT = `${B_PLANET}_s01`;    // a Terran homeworld carries settlement slots (15)
const B_SLOT_2 = `${B_PLANET}_s02`;
const B_MINER_1 = `asset_${B}_miner_01`;
const B_MINER_2 = `asset_${B}_miner_02`;

const guildOf = (s, id) => s.guilds.find((g) => g.id === id);

// The ids a system's planets and nodes carry in the seed, from its own layout.
function planetIdsOf(systemId) {
  return getSystemLayout(systemId).planets.map((p) => p.id).sort();
}
function nodeIdsOf(planetId) {
  const sys = getPlanet(planetId).systemId;
  return getSystemLayout(sys).planets.find((p) => p.id === planetId).resourceNodes.map((n) => n.id).sort();
}
function slotIdsOf(planetId) {
  const sys = getPlanet(planetId).systemId;
  return getSystemLayout(sys).planets.find((p) => p.id === planetId).settlementSlots.map((x) => x.id).sort();
}

// A frontier system — a starter neither guild founded on — for the guild's OWN survey, standing in here for a
// Deep Scan Array completion (tests/deep-scan-job.test.js runs the real scan; both write through `reveal`).
// FRONTIER_SURFACED is its first planet with BOTH kinds of surface (a gas giant, molten or irradiated world
// carries no settlement slot), so a surface test proves nodes and slots together.
const FRONTIER = getStarterSystems()[2].id;
const FRONTIER_PLANET = planetIdsOf(FRONTIER)[0];
const FRONTIER_SURFACED = planetIdsOf(FRONTIER).find((id) => nodeIdsOf(id).length > 0 && slotIdsOf(id).length > 0);

// Found A and B through `intake` (the POST /action drain), one tick apart from nothing.
function twoGuilds() {
  const { state, results } = intake(createZeroState(), [
    createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
    createFoundGuildAction({ guildId: B, name: 'Bot', isBot: true, credits: 200000, influence: 100, homeSystemId: B_HOME }),
  ]);
  for (const r of results) assert.equal(r.accepted, true, `founding refused: ${r.reason}`);
  return state;
}

// B seats a titanium mine on its homeworld; `licensed` decides whether it goes on the public register.
function withRivalMine(state, { licensed, ventureId = 'b_mine', siteId = B_MINE, assetId = B_MINER_1 }) {
  const actions = [createEstablishVentureAction({ guildId: B, ventureId, siteId, assetId, resourceType: 'titanium', productionRate: 5 })];
  if (licensed) actions.push(createApplyForLicenceAction({ guildId: B, ventureId, committedOutputPct: 1, windowDays: 7 }));
  const { state: next, results } = intake(state, actions);
  for (const r of results) assert.equal(r.accepted, true, `B's venture refused: ${r.reason}`);
  return next;
}

const tickOnce = (s) => advance(s, []).state;

// --- 1. reveal: the one write path -----------------------------------------------------------------

test('reveal: a guild that knows nothing carries no record key at all (omit-when-empty)', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  assert.equal('exploration' in g, false);
  assert.equal(knowsPlanet(g, B_PLANET), false);
  assert.equal(knowsNode(g, B_MINE), false);
});

test('reveal: a planet fact records L1 only; a node fact records the node AND its planet', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  assert.equal(reveal(g, { planetId: B_PLANET }, 3), 1, 'one new fact: the archetype');
  assert.deepEqual(g.exploration, { [B_PLANET]: { tick: 3, nodes: {}, slots: {} } }, 'both surface maps present, both empty');

  const g2 = createGuild({ id: 'g2', credits: 0, fuelHoard: 0 });
  assert.equal(reveal(g2, { nodeId: B_MINE }, 5), 2, 'two new facts: the planet, then the node');
  assert.deepEqual(g2.exploration, { [B_PLANET]: { tick: 5, nodes: { [B_MINE]: 5 }, slots: {} } });
  assert.equal(knowsPlanet(g2, B_PLANET), true);
  assert.equal(knowsNode(g2, B_MINE), true);
  assert.equal(knowsNode(g2, B_MINE_2), false, 'knowing one node of a planet is not knowing the others');
});

test('reveal: LEARN-ONCE — revealing a known fact is a no-op that keeps the ORIGINAL tick', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  reveal(g, { nodeId: B_MINE }, 5);
  const before = structuredClone(g.exploration);
  assert.equal(reveal(g, { nodeId: B_MINE }, 99), 0, 'nothing new learned');
  assert.equal(reveal(g, { planetId: B_PLANET }, 99), 0, 'the planet was already known');
  assert.deepEqual(g.exploration, before, 'not a byte moved — the first tick stands');
  // A SECOND node on the known planet is new; the planet keeps its tick.
  assert.equal(reveal(g, { nodeId: B_MINE_2 }, 7), 1);
  assert.equal(g.exploration[B_PLANET].tick, 5);
  assert.equal(g.exploration[B_PLANET].nodes[B_MINE_2], 7);
});

test('reveal: a SLOT fact records the slot AND its planet, learn-once, and never touches the node track', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  assert.equal(reveal(g, { slotId: B_SLOT }, 4), 2, 'two new facts: the planet, then the slot');
  assert.deepEqual(g.exploration, { [B_PLANET]: { tick: 4, nodes: {}, slots: { [B_SLOT]: 4 } } });
  assert.equal(knowsNode(g, B_SLOT), false, 'a known slot is not a known node');
  assert.equal(reveal(g, { slotId: B_SLOT }, 9), 0, 'known again is not learned again');
  assert.equal(g.exploration[B_PLANET].slots[B_SLOT], 4, 'the first tick stands');
  assert.equal(reveal(g, { slotId: B_SLOT_2 }, 6), 1, 'a second slot on the known planet is one new fact');
  assert.equal(g.exploration[B_PLANET].tick, 4, 'and the planet keeps its tick');
});

test('reveal: a place the seed does not hold, a settlement slot as a node, or a bad tick is refused loudly', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  assert.throws(() => reveal(g, { planetId: 'pl_nope' }, 1), /not a planet in the seed/);
  assert.throws(() => reveal(g, { nodeId: 'pl_nope_n01' }, 1), /not a resource node in the seed/);
  assert.throws(() => reveal(g, { nodeId: `${B_PLANET}_s01` }, 1), /not a resource node/, 'a slot is not a node');
  assert.throws(() => reveal(g, { slotId: B_MINE }, 1), /not a settlement slot in the seed/, 'a node is not a slot');
  assert.throws(() => reveal(g, { slotId: 'pl_nope_s01' }, 1), /not a settlement slot in the seed/);
  assert.throws(() => reveal(g, { planetId: B_PLANET }, -1), /whole tick/);
  assert.throws(() => reveal(g, { planetId: B_PLANET }, 1.5), /whole tick/);
  assert.equal('exploration' in g, false, 'a refused reveal leaves no empty record behind');
});

test('cloneExploration: a deep copy, null for an empty record', () => {
  assert.equal(cloneExploration(undefined), null);
  assert.equal(cloneExploration({}), null);
  const rec = { [B_PLANET]: { tick: 1, nodes: { [B_MINE]: 1 }, slots: { [B_SLOT]: 1 } } };
  const copy = cloneExploration(rec);
  assert.deepEqual(copy, rec);
  copy[B_PLANET].nodes[B_MINE_2] = 2;
  copy[B_PLANET].slots[B_SLOT_2] = 2;
  assert.equal(rec[B_PLANET].nodes[B_MINE_2], undefined, 'the copy never aliases the original');
  assert.equal(rec[B_PLANET].slots[B_SLOT_2], undefined, 'nor its slot track');
});

test('createGuild carries a handed-in record (a restored save keeps it) and never aliases it', () => {
  const rec = { [B_PLANET]: { tick: 1, nodes: { [B_MINE]: 1 }, slots: { [B_SLOT]: 1 } } };
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0, exploration: rec });
  assert.deepEqual(g.exploration, rec);
  rec[B_PLANET].tick = 42;
  assert.equal(g.exploration[B_PLANET].tick, 1);
  assert.equal('exploration' in createGuild({ id: 'h', credits: 0, fuelHoard: 0, exploration: {} }), false,
    'an empty record is omitted, not carried as {}');
});

// --- 2. founding seeds the home record --------------------------------------------------------------

test('founding: the home system is known FULLY — every planet (L1), every resource node and every settlement slot (L2)', () => {
  const s = twoGuilds();
  for (const [id, home] of [[A, A_HOME], [B, B_HOME]]) {
    const rec = guildOf(s, id).exploration;
    assert.deepEqual(Object.keys(rec).sort(), planetIdsOf(home), `${id} knows exactly its home planets`);
    let slotsSeen = 0;
    for (const planetId of planetIdsOf(home)) {
      assert.equal(rec[planetId].tick, s.tick, 'stamped with the founding tick (§15.2)');
      assert.deepEqual(Object.keys(rec[planetId].nodes).sort(), nodeIdsOf(planetId), `${id} knows every node of ${planetId}`);
      for (const nodeId of Object.keys(rec[planetId].nodes)) assert.equal(rec[planetId].nodes[nodeId], s.tick);
      assert.deepEqual(Object.keys(rec[planetId].slots).sort(), slotIdsOf(planetId), `${id} knows every settlement slot of ${planetId}`);
      for (const slotId of Object.keys(rec[planetId].slots)) assert.equal(rec[planetId].slots[slotId], s.tick);
      slotsSeen += Object.keys(rec[planetId].slots).length;
    }
    assert.ok(slotsSeen > 0, `${id}'s home has settlement slots, so "every slot" is really tested`);
  }
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('founding through revealSystem directly: the count it returns is planets + nodes + slots, and a replay learns nothing', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  const layout = getSystemLayout(A_HOME);
  const facts = layout.planets.reduce((n, p) => n + 1 + p.resourceNodes.length + p.settlementSlots.length, 0);
  assert.equal(revealSystem(g, A_HOME, 0), facts);
  assert.equal(revealSystem(g, A_HOME, 9), 0, 'learn-once');
});

// --- 2b. the surface: one L2 reveal learns nodes AND slots together ---------------------------------

test('SURFACE: one L2 reveal records every node AND every slot of the planet together, and is a no-op on replay a tick later', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  const nodes = nodeIdsOf(FRONTIER_SURFACED);
  const slots = slotIdsOf(FRONTIER_SURFACED);
  assert.ok(nodes.length > 0 && slots.length > 0, 'the planet has both kinds of surface');
  reveal(g, { planetId: FRONTIER_SURFACED }, 2); // known at L1 first — the scan's chain
  assert.equal(revealPlanetSurface(g, FRONTIER_SURFACED, 7), nodes.length + slots.length, 'every node and slot is new');
  assert.deepEqual(g.exploration[FRONTIER_SURFACED], {
    tick: 2,
    nodes: Object.fromEntries(nodes.map((n) => [n, 7])),
    slots: Object.fromEntries(slots.map((x) => [x, 7])),
  }, 'nodes and slots learned at one tick, the planet keeping its L1 tick');
  const before = structuredClone(g.exploration);
  assert.equal(revealPlanetSurface(g, FRONTIER_SURFACED, 8), 0, 'the replay a tick later learns nothing');
  assert.deepEqual(g.exploration, before, 'and re-stamps nothing (learn-once)');
  // Only that planet: its neighbours stay unknown.
  assert.deepEqual(Object.keys(g.exploration), [FRONTIER_SURFACED]);
});

test('SURFACE: a zero-slot archetype surveys to an EMPTY slot map — present, not absent', () => {
  // The first starter-system planet with nodes but no settlement slot (a gas giant, molten or irradiated
  // world), found in the seed rather than named.
  const bare = getStarterSystems().flatMap((x) => getSystemLayout(x.id).planets)
    .find((p) => p.settlementSlots.length === 0 && p.resourceNodes.length > 0);
  assert.ok(bare, 'the seed has a zero-slot planet');
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  revealPlanetSurface(g, bare.id, 3);
  assert.deepEqual(g.exploration[bare.id].slots, {});
  assert.equal(Object.keys(g.exploration[bare.id].nodes).length, bare.resourceNodes.length);
});

test('SURFACE: an L1 archetype scan reveals NO surface — no node, and no slot', () => {
  const g = createGuild({ id: 'g', credits: 0, fuelHoard: 0 });
  revealSystemArchetypes(g, FRONTIER, 1);
  for (const planetId of planetIdsOf(FRONTIER)) assert.deepEqual(g.exploration[planetId], { tick: 1, nodes: {}, slots: {} });
});

test('the L2 reveal is RENAMED revealPlanetSurface — the old name is gone, so nothing calls a half-true name by mistake', () => {
  assert.equal(typeof exploration.revealPlanetSurface, 'function');
  assert.equal('revealPlanetNodes' in exploration, false);
});

test('founding: NOTHING beyond the home system — no other system, and no L0 row is stored', () => {
  const s = twoGuilds();
  for (const [id, home] of [[A, A_HOME], [B, B_HOME]]) {
    for (const planetId of Object.keys(guildOf(s, id).exploration)) {
      assert.equal(getPlanet(planetId).systemId, home, `${id}'s record holds only home-system planets`);
    }
    // L0 (position, planet count, controller) is never fogged, so it is computed in the view — the
    // record holds planet ids only, never a system row.
    assert.equal(Object.keys(guildOf(s, id).exploration).some((k) => !getPlanet(k)), false);
  }
  assert.equal(guildOf(s, A).exploration[B_PLANET], undefined, 'A does not know the rival home');
});

test('founding: the record moves no credits, fuel or goods (it is pure knowledge)', () => {
  const s = twoGuilds();
  const stripped = structuredClone(s);
  for (const g of stripped.guilds) delete g.exploration;
  // Strip the record and every invariant still holds; the record is not in any conservation sum.
  assert.deepEqual(checkInvariants(stripped, stripped.tick), []);
  assert.equal(s.audit.expectedCreditTotal, stripped.audit.expectedCreditTotal);
});

// --- 3. a rival teaches the record nothing (ruling 11) ----------------------------------------------

test('isOnPublicRegister: an ordinary or a deuterium licence is public; no licence is private', () => {
  // Still the one definition of "licensed = public" (§0): the per-guild view uses it to decide which rival
  // ventures it SHOWS (sim/fog.js). It no longer feeds the record.
  assert.equal(isOnPublicRegister({ licence: { committedOutputPct: 1 } }), true);
  assert.equal(isOnPublicRegister({ deuteriumLicence: { signedTick: 0 } }), true);
  assert.equal(isOnPublicRegister({}), false);
  assert.equal(isOnPublicRegister({ deuteriumRefinery: true }), false, 'an illegal refinery is never declared');
});

test('the removed register observation is GONE from the module — nothing left to call by mistake', () => {
  assert.equal('observePublicRegister' in exploration, false);
  assert.equal('publicRegisterFacts' in exploration, false);
});

test('a rival LICENSED venture teaches the record NOTHING: the observer\'s record is its founding record, tick after tick', () => {
  const founded = twoGuilds();
  const atFounding = canonicalStringify(guildOf(founded, A).exploration);
  let s = withRivalMine(founded, { licensed: true });
  assert.ok(guildOf(s, B).ventures.some((v) => v.id === 'b_mine' && isOnPublicRegister(v)), 'it really is on the register');
  for (let i = 0; i < 5; i += 1) {
    s = tickOnce(s);
    assert.equal(canonicalStringify(guildOf(s, A).exploration), atFounding, `tick ${s.tick}: A's record moved`);
  }
  // Not the node, not its planet, not any planet of B's home: the record holds only A's own home.
  assert.equal(knowsNode(guildOf(s, A), B_MINE), false);
  for (const planetId of planetIdsOf(B_HOME)) assert.equal(knowsPlanet(guildOf(s, A), planetId), false, `${planetId}`);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a rival UNLICENSED venture teaches nothing either: the observer record is byte-identical after many ticks', () => {
  let s = withRivalMine(twoGuilds(), { licensed: false });
  const before = canonicalStringify(guildOf(s, A).exploration);
  for (let i = 0; i < 5; i += 1) s = tickOnce(s);
  assert.equal(canonicalStringify(guildOf(s, A).exploration), before, 'private operations write nothing');
  assert.equal(knowsNode(guildOf(s, A), B_MINE), false);
});

test('and the rival CLOSING its licensed venture moves nothing either — there was nothing banked to keep or lose', () => {
  let s = tickOnce(withRivalMine(twoGuilds(), { licensed: true }));
  const before = canonicalStringify(guildOf(s, A).exploration);
  const { state: closed, results } = intake(s, [createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]);
  assert.equal(results[0].accepted, true, results[0].reason);
  s = tickOnce(tickOnce(closed));
  assert.equal(guildOf(s, B).ventures.some((v) => v.id === 'b_mine'), false, 'the venture is really gone');
  assert.equal(canonicalStringify(guildOf(s, A).exploration), before);
});

// --- 4. known-forever: what the guild learned stays --------------------------------------------------

test('LEARN-ONCE across a run: every tick\'s record contains the last, fact for fact, tick for tick', () => {
  // A scripted run in which the rival licenses, runs an unlicensed mine and closes — every way the register
  // moves — while A surveys a frontier planet of its own in the middle. What A learned stays, first tick kept.
  let s = twoGuilds();
  const steps = [
    (x) => withRivalMine(x, { licensed: true }),
    tickOnce, tickOnce,
    (x) => { revealSurvey(x, A, FRONTIER_PLANET); return x; },
    (x) => withRivalMine(x, { licensed: false, ventureId: 'b_mine_2', siteId: B_MINE_2, assetId: B_MINER_2 }),
    tickOnce,
    (x) => intake(x, [createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]).state,
    tickOnce, tickOnce,
  ];
  for (const step of steps) {
    const prev = s.guilds.map((g) => [g.id, structuredClone(g.exploration || {})]);
    s = step(s);
    for (const [id, old] of prev) {
      const now = guildOf(s, id).exploration || {};
      for (const planetId of Object.keys(old)) {
        assert.ok(now[planetId], `tick ${s.tick}: ${id} forgot planet ${planetId}`);
        assert.equal(now[planetId].tick, old[planetId].tick, `tick ${s.tick}: ${id} re-stamped planet ${planetId}`);
        for (const nodeId of Object.keys(old[planetId].nodes)) {
          assert.equal(now[planetId].nodes[nodeId], old[planetId].nodes[nodeId], `tick ${s.tick}: ${id} lost or re-stamped node ${nodeId}`);
        }
        for (const slotId of Object.keys(old[planetId].slots)) {
          assert.equal(now[planetId].slots[slotId], old[planetId].slots[slotId], `tick ${s.tick}: ${id} lost or re-stamped slot ${slotId}`);
        }
      }
    }
  }
  assert.ok(knowsPlanet(guildOf(s, A), FRONTIER_PLANET), 'the survey is still known at the end');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// revealSurvey(state, guildId, planetId) — the guild surveys one planet's whole surface at the state's tick,
// in place, through the one write path: its archetype, then every node and every slot — exactly what an L1
// then an L2 scan completion write.
function revealSurvey(state, guildId, planetId) {
  const guild = guildOf(state, guildId);
  reveal(guild, { planetId }, state.tick);
  revealPlanetSurface(guild, planetId, state.tick);
}

// --- 5. determinism (invariant 9) -------------------------------------------------------------------

function scriptedRun() {
  let s = tickOnce(withRivalMine(twoGuilds(), { licensed: true }));
  s = intake(s, [createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]).state;
  return tickOnce(s);
}

test('determinism: two runs of the same script give identical records and identical state', () => {
  const a = scriptedRun();
  const b = scriptedRun();
  assert.equal(hashState(a), hashState(b));
  assert.equal(canonicalStringify(guildOf(a, A).exploration), canonicalStringify(guildOf(b, A).exploration));
});

test('determinism: the record survives save/restore byte-identically, and ticks on identically', (t) => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'exploration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live = scriptedRun();
  saveState(live, dir);
  const restored = loadOrInit(dir, () => { throw new Error('a saved state must load'); });
  assert.equal(hashState(restored), hashState(live), 'the restored state is byte-identical');
  assert.deepEqual(guildOf(restored, A).exploration, guildOf(live, A).exploration);
  assert.equal(hashState(tickOnce(restored)), hashState(tickOnce(live)), 'and the next tick agrees');
});

test('determinism: a scenario round-trip through createState keeps the record exactly', () => {
  const live = scriptedRun();
  const rebuilt = createState({ ...live, guilds: live.guilds });
  assert.equal(canonicalStringify(guildOf(rebuilt, A).exploration), canonicalStringify(guildOf(live, A).exploration));
});

// --- 6. the invariant halts on a corrupt record -----------------------------------------------------

function corrupted(mutate) {
  const s = twoGuilds();
  mutate(guildOf(s, A), s);
  return checkInvariants(s, s.tick).map((v) => v.rule);
}

test('invariant: a founded two-guild galaxy carries a clean record', () => {
  assert.deepEqual(corrupted(() => {}), []);
});

test('invariant: an EMPTY record object is a violation (omit-when-empty)', () => {
  assert.ok(corrupted((g) => { g.exploration = {}; }).includes('exploration-record-is-a-non-empty-object (omit-when-empty)'));
});

test('invariant: a planet the seed does not hold is a violation', () => {
  assert.ok(corrupted((g) => { g.exploration.pl_nope = { tick: 0, nodes: {} }; }).includes('exploration-planet-exists (seed.js)'));
});

test('invariant: a node filed under the WRONG planet, or a settlement slot filed as a node, is a violation', () => {
  const rule = 'exploration-node-is-a-resource-node-on-its-planet (seed.js)';
  const homePlanet = getTerranHomeworld(A_HOME);
  assert.ok(corrupted((g) => { g.exploration[homePlanet].nodes[B_MINE] = 0; }).includes(rule), 'a rival node under my planet');
  assert.ok(corrupted((g) => { g.exploration[homePlanet].nodes[`${homePlanet}_s01`] = 0; }).includes(rule), 'a slot as a node');
});

test('invariant: the SLOT track is guarded — a node filed as a slot, a slot on the WRONG planet, a slot learned before its planet', () => {
  const rule = 'exploration-slot-is-a-settlement-slot-on-its-planet (seed.js)';
  const homePlanet = getTerranHomeworld(A_HOME);
  const homeSlot = slotIdsOf(homePlanet)[0];
  assert.ok(corrupted((g) => { g.exploration[homePlanet].slots[`${homePlanet}_n01`] = 0; }).includes(rule), 'a resource node as a slot');
  assert.ok(corrupted((g) => { g.exploration[homePlanet].slots[B_SLOT] = 0; }).includes(rule), 'a rival planet\'s slot under my planet');
  assert.ok(corrupted((g) => { g.exploration[homePlanet].slots.pl_nope_s01 = 0; }).includes(rule), 'a slot the seed does not hold');
  assert.ok(corrupted((g, s) => {
    g.exploration[homePlanet].tick = s.tick;          // planet at tick 0 …
    g.exploration[homePlanet].slots[homeSlot] = -1;   // … slot "before" it
  }).includes('exploration-slot-tick-between-planet-tick-and-now'));
  assert.ok(corrupted((g, s) => { g.exploration[homePlanet].slots[homeSlot] = s.tick + 1; })
    .includes('exploration-slot-tick-between-planet-tick-and-now'), 'a slot learned in the future');
  for (const bad of [null, [], undefined, 7]) {
    assert.ok(corrupted((g) => { g.exploration[homePlanet].slots = bad; }).includes('exploration-slots-is-an-object'),
      `slots = ${JSON.stringify(bad)} — the track is ALWAYS present, an object`);
  }
});

test('invariant: a fact learned in the FUTURE, or a node learned before its planet, is a violation', () => {
  const homePlanet = getTerranHomeworld(A_HOME);
  assert.ok(corrupted((g, s) => { g.exploration[homePlanet].tick = s.tick + 1; })
    .includes('exploration-planet-tick-is-a-past-tick (§15.2)'));
  assert.ok(corrupted((g, s) => {
    g.exploration[homePlanet].tick = s.tick;          // planet at tick 0 …
    const node = Object.keys(g.exploration[homePlanet].nodes)[0];
    g.exploration[homePlanet].nodes[node] = -1;       // … node "before" it
  }).includes('exploration-node-tick-between-planet-tick-and-now'));
});

test('the fixtures are what they claim: two distinct starter homes, and B\'s mine sites are titanium nodes', () => {
  assert.notEqual(A_HOME, B_HOME);
  assert.equal(getSite(B_MINE).resourceType, 'titanium');
  assert.equal(getSite(B_MINE_2).resourceType, 'titanium');
  assert.equal(getSite(B_MINE).planetId, B_PLANET);
  for (const slot of [B_SLOT, B_SLOT_2]) {
    assert.equal(getSite(slot).kind, 'settlement');
    assert.equal(getSite(slot).planetId, B_PLANET);
  }
});
