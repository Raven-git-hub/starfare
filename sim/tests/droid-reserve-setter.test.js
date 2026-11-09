'use strict';

// droid-reserve-setter.test.js — roadmap 2.6 (maintenance), slice 1 of 6: the PLAYER ACTION that sets a system's
// droid_components reserve (docs/maintenance.md §1c). The reserve itself — "weekly droid upkeep never draws this
// system's stock below it" — was built in droid engine slice 5 (docs/droids.md §5); until now nothing set it.
//
// The tripwires, in order:
//   1. VALID SETS: the reserve lands on `guild.droidComponentReserve[systemId]`; a second set replaces it; two
//      systems are independent; nothing else in the galaxy moves (no credit, good, fuel, droid, profile).
//   2. ZERO CLEARS: 0 removes the system's key, and the map is omitted once empty — byte-identical to a guild that
//      never set a reserve at all.
//   3. REFUSALS (loud, at validate — never clamped): unknown guild; a system not on the seed; a seed system the
//      guild does not hold (unclaimed, or a rival's); a reserve that is not a whole number ≥ 0.
//   4. ITS OWN SETTING: it does not touch the production console's reserveLevel.
//   5. THE TICK (§15.2): the write-ahead journal line records the tick it was applied at, and replays to the
//      same bytes (the sibling setProductionProfile's precedent — the reserve map has no row to stamp).
//   6. UPKEEP HONOURS IT: a reserve set THROUGH THE ACTION holds at the next week boundary.
//   7. DETERMINISM (invariant 9): two runs of the same scenario are byte-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit, journalPath } = require('../persist.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { getStarterSystems, getTerranHomeworld } = require('../seed.js');
const { DROID_COMPONENTS, droidComponentReserveFor } = require('../droids.js');
const {
  validateAction, applyAction, createSetDroidComponentReserveAction, createSetProductionProfileAction,
} = require('../actions.js');

// Three real starter systems: g1 holds HOME (and, in some tests, SECOND); g2 holds RIVAL. Nobody holds UNHELD.
const [HOME, SECOND, RIVAL, UNHELD] = getStarterSystems().map((s) => s.id);
const WEEK = 10_080;

const claimOf = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});
const droid = (n, source, condition = 1) => ({
  id: `asset_g1_droid_${String(n).padStart(2, '0')}`, systemId: HOME, source, condition,
  assignedToVentureId: 'm', deployedAtTick: 0, updatedAtTick: 0,
});

// galaxy({ stock, droids, alsoSecond, tick }) -> g1 at HOME with a titanium mine, g2 at RIVAL. Every invariant is
// checked before it is returned.
function galaxy({ stock = 0, droids = [], alsoSecond = false, tick = 0 } = {}) {
  const s = createState({
    guilds: [
      {
        id: 'g1', credits: 5_000, fuelHoard: 0, homeSystemId: HOME, homePlanetId: getTerranHomeworld(HOME),
        stockpiles: { [HOME]: { [DROID_COMPONENTS]: stock } },
        ventures: [{ id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: HOME, resourceType: 'titanium', productionRate: 5 }],
        ...(droids.length ? { droids, droidSerial: droids.length } : {}),
      },
      { id: 'g2', credits: 0, fuelHoard: 0, homeSystemId: RIVAL, homePlanetId: getTerranHomeworld(RIVAL) },
    ],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: [claimOf('g1', HOME), claimOf('g2', RIVAL), ...(alsoSecond ? [claimOf('g1', SECOND)] : [])],
  });
  s.tick = tick;
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fixture itself is legal');
  return s;
}
const g1Of = (s) => s.guilds.find((g) => g.id === 'g1');
const setReserve = (systemId, reserve, guildId = 'g1') => createSetDroidComponentReserveAction({ guildId, systemId, reserve });

// accept / refuse — the POST /action path in-process: validate, apply, every invariant with no tick between.
function accept(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected ${action.type} accepted, got: ${reason}`);
  const next = applyAction(s, action);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
}
function refuse(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, false, `expected ${action.type} refused: ${JSON.stringify(action)}`);
  return reason;
}

// --- 1. valid sets --------------------------------------------------------------------------------------------

test('set: the reserve lands on the guild, per system; a second set replaces it; nothing else moves', () => {
  const s0 = galaxy({ stock: 9 });
  const s1 = accept(s0, setReserve(HOME, 7));
  assert.deepEqual(g1Of(s1).droidComponentReserve, { [HOME]: 7 });
  assert.equal(droidComponentReserveFor(g1Of(s1), HOME), 7, 'the upkeep reads exactly what the action wrote');
  // The whole footprint: take the reserve away and the galaxy is the one we started with.
  const without = structuredClone(s1);
  delete g1Of(without).droidComponentReserve;
  assert.equal(hashState(without), hashState(s0), 'no credit, good, fuel, droid or tick moved — only the reserve');
  assert.equal(s0.guilds[0].droidComponentReserve, undefined, 'the input state was not mutated');
  const s2 = accept(s1, setReserve(HOME, 3));
  assert.deepEqual(g1Of(s2).droidComponentReserve, { [HOME]: 3 }, 'replaced, not added to');
});

test('set: two held systems are independent — clearing one leaves the other', () => {
  let s = galaxy({ alsoSecond: true });
  s = accept(s, setReserve(HOME, 4));
  s = accept(s, setReserve(SECOND, 11));
  assert.deepEqual(g1Of(s).droidComponentReserve, { [HOME]: 4, [SECOND]: 11 });
  s = accept(s, setReserve(HOME, 0));
  assert.deepEqual(g1Of(s).droidComponentReserve, { [SECOND]: 11 });
});

test('set: a reserve larger than the stock is legal — it simply leaves nothing for upkeep', () => {
  const s = accept(galaxy({ stock: 2 }), setReserve(HOME, 50));
  assert.equal(g1Of(s).droidComponentReserve[HOME], 50);
});

// --- 2. zero clears -------------------------------------------------------------------------------------------

test('zero: 0 removes the key and the empty map is omitted — byte-identical to never having set one', () => {
  const s0 = galaxy({ stock: 5 });
  const set = accept(s0, setReserve(HOME, 6));
  const cleared = accept(set, setReserve(HOME, 0));
  assert.equal('droidComponentReserve' in g1Of(cleared), false, 'no empty {} left behind');
  assert.equal(hashState(cleared), hashState(s0));
  // 0 on a system that never had a reserve is accepted and changes nothing (the same "default" state).
  assert.equal(hashState(accept(s0, setReserve(HOME, 0))), hashState(s0));
});

// --- 3. refusals ----------------------------------------------------------------------------------------------

test('refusals: unknown guild, not a seed system, a system the guild does not hold, a reserve that is not whole', () => {
  const s = galaxy();
  assert.match(refuse(s, setReserve(HOME, 1, 'gX')), /no guild with id "gX"/);
  assert.match(refuse(s, setReserve('sys_nowhere', 1)), /is not a system on the seed/);
  assert.match(refuse(s, setReserve(42, 1)), /is not a system on the seed/);
  assert.match(refuse(s, setReserve(UNHELD, 1)), /does not hold system/, 'an unclaimed seed system');
  assert.match(refuse(s, setReserve(RIVAL, 1)), /does not hold system/, 'a rival\'s system');
  // The rival may set its own, in its own system.
  accept(s, setReserve(RIVAL, 1, 'g2'));
  for (const bad of [-1, 2.5, '3', NaN, Infinity, null, true, 2 ** 53]) {
    assert.match(refuse(s, setReserve(HOME, bad)), /reserve must be a whole number of droid_components ≥ 0/, String(bad));
  }
});

test('refusals: the action factory throws on a missing field (a caller bug, not a player input)', () => {
  assert.throws(() => createSetDroidComponentReserveAction({ systemId: HOME, reserve: 1 }), /guildId is required/);
  assert.throws(() => createSetDroidComponentReserveAction({ guildId: 'g1', reserve: 1 }), /systemId is required/);
  assert.throws(() => createSetDroidComponentReserveAction({ guildId: 'g1', systemId: HOME }), /reserve is required/);
  assert.deepEqual(setReserve(HOME, 2), { type: 'setDroidComponentReserve', guildId: 'g1', systemId: HOME, reserve: 2 });
});

// --- 4. its own setting ---------------------------------------------------------------------------------------

test('own setting: the droid reserve and the console\'s reserveLevel never touch each other', () => {
  let s = galaxy({ stock: 10 });
  s = accept(s, createSetProductionProfileAction({
    guildId: 'g1', systemId: HOME, goods: { [DROID_COMPONENTS]: { reserveLevel: 6 } },
  }));
  const profileBefore = structuredClone(g1Of(s).productionProfile);
  assert.equal(profileBefore[HOME].goods[DROID_COMPONENTS].reserveLevel, 6, 'the console reserveLevel is really set');
  s = accept(s, setReserve(HOME, 2));
  assert.deepEqual(g1Of(s).productionProfile, profileBefore, 'setting the droid reserve left reserveLevel alone');
  s = accept(s, createSetProductionProfileAction({
    guildId: 'g1', systemId: HOME, goods: { [DROID_COMPONENTS]: { reserveLevel: 1 } },
  }));
  assert.deepEqual(g1Of(s).droidComponentReserve, { [HOME]: 2 }, 'and changing reserveLevel left the droid reserve');
});

// --- 5. the tick ------------------------------------------------------------------------------------------------

test('tick (§15.2): the journal records the tick the reserve was set at, and replays it to the same bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-reserve-'));
  try {
    let s = galaxy({ tick: 4_321 });
    saveState(s, dir);
    // The server's applyOneAction path: validate → journal (state.tick) → apply.
    const action = setReserve(HOME, 8);
    assert.equal(validateAction(s, action).valid, true);
    appendJournal(s.tick, action, dir);
    s = applyAction(s, action);
    const lines = fs.readFileSync(journalPath(dir), 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.deepEqual(JSON.parse(lines[0]), { tick: 4_321, action }, 'the mutation\'s tick is on record');
    const recovered = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
    assert.equal(hashState(recovered), hashState(s), 'replays to the same bytes');
    assert.deepEqual(g1Of(recovered).droidComponentReserve, { [HOME]: 8 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6. upkeep honours a reserve set through the action -------------------------------------------------------

// reserveScript(reserve) -> run three deployed droids across the tick-10,080 week boundary with 5 components on
// hand, the reserve set THROUGH THE ACTION a few ticks before. advance() asserts every invariant on every tick.
function reserveScript(reserve) {
  let s = galaxy({
    stock: 5,
    droids: [droid(1, 'guild', 0.5), droid(2, 'syndicate', 0.25), droid(3, 'guild', 0.75)],
    tick: WEEK - 5,
  });
  s = accept(s, setReserve(HOME, reserve));
  for (let i = 0; i < 10; i += 1) s = advance(s).state;
  return s;
}

test('upkeep: a reserve set by the action holds at the next week boundary — only the stock above it is spent', () => {
  const s = reserveScript(3);
  const g = g1Of(s);
  assert.equal(g.stockpiles[HOME][DROID_COMPONENTS], 3, '5 on hand, 3 kept: only 2 spent');
  // 2 spendable at 1 each: the two LOWEST-condition droids, whatever their source.
  assert.deepEqual(g.droids.filter((d) => d.maintained).map((d) => d.id), ['asset_g1_droid_01', 'asset_g1_droid_02']);
  assert.equal(g.droids.find((d) => d.id === 'asset_g1_droid_03').maintained, undefined, 'the healthiest is skipped');
  // The readout reports it: 3 droids at 1 a week; nothing above the floor left, so 0 weeks of runway.
  assert.deepEqual(buildSnapshot(s).guilds.find((r) => r.id === 'g1').droidUpkeep[HOME], {
    stock: 3, reserve: 3, weeklyUpkeep: 3, maintained: 2, unmaintained: 1, runwayWeeks: 0, nextUpkeepTick: 2 * WEEK,
  });
  // Control: with no reserve, all three are covered.
  const control = g1Of(reserveScript(0));
  assert.equal(control.stockpiles[HOME][DROID_COMPONENTS], 2);
  assert.equal(control.droids.filter((d) => d.maintained).length, 3);
});

// --- 7. determinism -------------------------------------------------------------------------------------------

test('determinism (invariant 9): two runs of the same reserve scenario are byte-identical', () => {
  assert.equal(hashState(reserveScript(3)), hashState(reserveScript(3)));
});
