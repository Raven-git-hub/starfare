'use strict';

// droid-decay.test.js — roadmap 2.6, droid engine slice 5: DECAY, the weekly droid_components UPKEEP, and
// DESTRUCTION AT ZERO (docs/droids.md §5/§9/§10; the numbers docs/phase-1-tuning.md §Droids).
//
// The tripwires, in order:
//   1. THE NUMBERS: the lives, the upkeep, the default reserve and the week, typed from the doc.
//   2. NO-OP BYTE-IDENTICAL: a galaxy with no DEPLOYED droid hashes exactly as it did at 8ffbd21.
//   3. DECAY: a deployed droid wears to exactly 0 in exactly its ruled life — guild 4 wk / 16 wk, Syndicate
//      2 wk / 4 wk (uncovered / covered; the guild's 16 is the 09-11-26 retune, docs/maintenance.md §1b); idle
//      droids never wear; decay only goes down; a droid worn under the OLD scale rescales exactly on restore.
//   4. DESTROY AT ZERO: the droid is removed the tick it reaches 0, the loss is recorded, its id is never
//      reissued (even the TOP-numbered one), the boost drops, and its cap slot frees.
//   5. UPKEEP: each week boundary draws 1 droid_components per deployed droid, EITHER source (09-11-26), from
//      the droid's OWN system, lowest-condition-first when short, never below the reserve floor; a droid
//      deployed mid-week is unmaintained until the next boundary; unassign clears coverage.
//   6. NEUTRALITY: wear and upkeep move nothing but the droids, droid_components and the notice — no GP, no
//      mean line, no fee, no credit, no fuel.
//   7. DETERMINISM (invariant 9): two runs, and a save/restore, are byte-identical.
//   8. SNAPSHOT: maintained flags and the per-system upkeep row; omitted when absent; fogged from rivals.
//   9. THE NEW INVARIANTS bite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { stepDroidUpkeep } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints } = require('../points.js');
const { issuanceModifier, expectedReputation } = require('../meanline.js');
const {
  DROID_WEEK_TICKS, DROID_COMPONENTS, DROID_LIFE_TICKS, DROID_UPKEEP_PER_WEEK, DROID_COMPONENT_RESERVE_DEFAULT,
  DROID_WEAR_SCALE, wearPerTick, decayedCondition, decayDroidsIn, fundDroidUpkeep, mintDroid, assignedDroidCount,
} = require('../droids.js');
const {
  validateAction, applyAction, createAssignDroidAction, createUnassignDroidAction, createApplyForLicenceAction, intake,
} = require('../actions.js');
const { droidlessDecayScript } = require('./droid-decay-noop-script.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const WEEK = 10_080;
const droidIdFor = (n) => `asset_g1_droid_${String(n).padStart(2, '0')}`;

// droid(n, source, extra) -> a droid row DEPLOYED to venture 'm' at tick 0 (pass { idle: true } for an idle one).
function droid(n, source = 'guild', { condition = 1, idle = false, maintained, systemId = SYS, ventureId = 'm' } = {}) {
  return {
    id: droidIdFor(n), systemId, source, condition, updatedAtTick: 0,
    ...(idle ? {} : { assignedToVentureId: ventureId, deployedAtTick: 0 }),
    ...(maintained ? { maintained: true } : {}),
  };
}
const mine = (id, good = 'titanium', productionRate = 5, systemId = SYS) => (
  { id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: good, productionRate }
);

// galaxy({ droids, stock, ventures, tick, reserve }) -> one guild, every invariant checked before it is returned.
// `tick` puts the galaxy at that tick, so a test can sit just before a week boundary without running 10,080 ticks.
function galaxy({ droids = [], stock = {}, ventures = [mine('m')], tick = 0, reserve, extraGuilds = [] } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 100_000, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures,
      ...(droids.length ? { droids, droidSerial: Math.max(...droids.map((d) => Number(d.id.split('_').pop()))) } : {}),
      ...(reserve ? { droidComponentReserve: reserve } : {}),
    }, ...extraGuilds],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  s.tick = tick;
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fixture itself is legal');
  return s;
}
// run(s, n) — advance() asserts EVERY invariant on EVERY tick and throws naming the tick, so every run below is
// also the "integer goods, galactic supply and the droid rules hold every tick" proof.
function run(s, n) {
  let out = s;
  for (let i = 0; i < n; i += 1) out = advance(out).state;
  return out;
}
const g1Of = (s) => s.guilds[0];
const droidOf = (s, id) => (g1Of(s).droids || []).find((d) => d.id === id);
const held = (s, good, sys = SYS) => ((g1Of(s).stockpiles || {})[sys] || {})[good] || 0;
const units = (condition) => Math.round(condition * DROID_WEAR_SCALE);
function accept(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected ${action.type} accepted, got: ${reason}`);
  const next = applyAction(s, action);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
}

// --- 1. the numbers -----------------------------------------------------------------------------------------

test('numbers: the ruled lives, upkeep, reserve default and week — typed from docs/phase-1-tuning.md §"Maintenance"', () => {
  // Retune there and here together. RETUNED 09-11-26 (docs/maintenance.md §1, maintenance slice 1) — on purpose:
  // the guild droid's covered life 8 → 16 weeks, and the upkeep one rate (the Syndicate's 2 dropped to 1).
  assert.equal(DROID_WEEK_TICKS, WEEK, 'the maintenance week is the Tier-3 week, 10,080 ticks');
  assert.deepEqual(DROID_LIFE_TICKS, {
    guild: { uncovered: 4 * WEEK, covered: 16 * WEEK },
    syndicate: { uncovered: 2 * WEEK, covered: 4 * WEEK },
  });
  assert.equal(DROID_LIFE_TICKS.guild.covered, 161_280, 'a maintained guild droid: 16 weeks');
  assert.equal(DROID_LIFE_TICKS.guild.uncovered, 40_320);
  assert.equal(DROID_LIFE_TICKS.syndicate.covered, 40_320);
  assert.equal(DROID_LIFE_TICKS.syndicate.uncovered, 20_160);
  assert.equal(DROID_UPKEEP_PER_WEEK, 1, 'one rate, both sources');
  assert.equal(DROID_COMPONENT_RESERVE_DEFAULT, 0);
  assert.equal(DROID_COMPONENTS, 'droid_components');
  // The wear scale is DERIVED (the least common multiple of the lives), and every rate is a whole number of it.
  assert.equal(DROID_WEAR_SCALE, 161_280);
  assert.equal(wearPerTick('guild', false), 4);
  assert.equal(wearPerTick('guild', true), 1, 'maintenance quarters a guild droid\'s wear (×4 life)');
  assert.equal(wearPerTick('syndicate', false), 8);
  assert.equal(wearPerTick('syndicate', true), 4, 'maintenance halves a Syndicate droid\'s wear (×2 life)');
  assert.throws(() => wearPerTick('pirate', false), /unknown droid source/);
});

test('decayedCondition: whole-unit steps, never below 0, ALWAYS strictly down — even off the grid', () => {
  assert.equal(decayedCondition(1, 4), (161_280 - 4) / 161_280);
  assert.equal(decayedCondition(4 / 161_280, 4), 0, 'lands on exactly 0');
  assert.equal(decayedCondition(1 / 161_280, 4), 0, 'clamped at 0, never negative');
  assert.equal(decayedCondition(0, 1), 0);
  // A hand-built condition that is not a whole number of units still only goes down.
  for (const c of [0.3, 0.123456789, 1e-7, 0.99999999]) {
    for (const w of [1, 2, 4]) assert.ok(decayedCondition(c, w) < c, `${c} - ${w} units goes down`);
  }
});

// --- 2. no-op byte-identical --------------------------------------------------------------------------------

// RECORDED AT 8ffbd21 (main, before this slice's code existed) by running droid-decay-noop-script.js there: two
// idle droids (one per source) beside 30 droid_components, a droidless second guild, production running, and the
// run crossing the tick-10,080 week boundary.
const DROIDLESS_GOLDEN_8FFBD21 = '041dcf19b17f93692aea28346209c46e2d4fc78b74b59166db556d8730c518e0';

test('no-op: a galaxy with no DEPLOYED droid is byte-identical to 8ffbd21 — idle droids neither wear nor draw', () => {
  const s = droidlessDecayScript();
  assert.ok(s.tick > WEEK, 'the run crossed the week boundary, where upkeep would draw');
  assert.equal(droidOf(s, droidIdFor(1)).condition, 1, 'the idle guild droid did not wear');
  assert.equal(droidOf(s, droidIdFor(2)).condition, 0.75, 'the idle Syndicate droid did not wear');
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined, 'an idle droid is never maintained');
  assert.equal(held(s, DROID_COMPONENTS), 30, 'no component was drawn');
  assert.equal(hashState(s), DROIDLESS_GOLDEN_8FFBD21);
});

// --- 3. decay: the ruled lives ------------------------------------------------------------------------------

// lifeOf(source, covered) -> the producing tick a NEW deployed droid is destroyed on, driving the real per-system
// step (stepDroidUpkeep) tick by tick over a bare state — the whole life without 160,000 full ticks. With `covered`
// the droid starts maintained on a week boundary and the system holds enough components for every boundary after.
function lifeOf(source, covered) {
  const start = covered ? WEEK : 0; // a covered droid starts the tick after a boundary, already paid for
  const guild = {
    id: 'g1', droidSerial: 1,
    droids: [droid(1, source, { maintained: covered })],
    stockpiles: { [SYS]: { [DROID_COMPONENTS]: covered ? 100 : 0 } },
  };
  const state = { tick: start, dayAnchorTick: 0, guilds: [guild] };
  let destroyedOn = null;
  let last = 1;
  while (destroyedOn === null) {
    stepDroidUpkeep(state, guild, SYS);
    state.tick += 1;
    const d = (guild.droids || [])[0];
    if (!d) { destroyedOn = state.tick; break; }
    assert.ok(d.condition < last, 'decay is monotonic: down every deployed tick');
    if (covered) assert.equal(d.maintained, true, `still maintained at tick ${state.tick}`);
    last = d.condition;
    if (state.tick > start + 17 * WEEK) throw new Error('never wore out');
  }
  return { ticks: destroyedOn - start, guild };
}

test('decay: a deployed GUILD droid wears out in exactly 4 weeks unmaintained, 16 weeks maintained', () => {
  assert.equal(lifeOf('guild', false).ticks, 40_320);
  const covered = lifeOf('guild', true);
  assert.equal(covered.ticks, 161_280, '16 weeks — the 09-11-26 retune (was 8)');
  // Paid on each of the 15 boundaries it lived through after its first (pre-paid) week, 1 a week: 100 - 15.
  // So a fully maintained guild droid uses 16 components over its life (docs/maintenance.md §1b).
  assert.equal(covered.guild.stockpiles[SYS][DROID_COMPONENTS], 85);
});

test('decay: a deployed SYNDICATE droid wears out in exactly 2 weeks unmaintained, 4 weeks maintained', () => {
  assert.equal(lifeOf('syndicate', false).ticks, 20_160);
  const covered = lifeOf('syndicate', true);
  assert.equal(covered.ticks, 40_320);
  // 3 boundaries after the pre-paid week, now 1 a week (was 2 — the premium dropped 09-11-26): 100 - 3.
  assert.equal(covered.guild.stockpiles[SYS][DROID_COMPONENTS], 97);
});

test('decay through the real tick: one tick of wear per deployed droid, idle droids untouched, no restamp', () => {
  let s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'syndicate'), droid(3, 'guild', { idle: true, condition: 0.5 })],
  });
  s = run(s, 25);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), 161_280 - 25 * 4, 'guild: 4 units a tick');
  assert.equal(units(droidOf(s, droidIdFor(2)).condition), 161_280 - 25 * 8, 'Syndicate: 8 units a tick');
  assert.equal(droidOf(s, droidIdFor(3)).condition, 0.5, 'idle: no wear');
  for (const n of [1, 2, 3]) {
    assert.equal(droidOf(s, droidIdFor(n)).updatedAtTick, 0, 'wear is ambient — it does not restamp the row');
  }
});

test('retune: a droid worn under the OLD 80,640 scale restores with its fraction and wears to 0 on the predicted tick', () => {
  // The 09-11-26 retune (docs/maintenance.md §1b) moved DROID_WEAR_SCALE 80,640 → 161,280. A save stores the
  // condition FRACTION, never the units, so no migration is needed: on restore the fraction's units simply double,
  // exactly. These three droids sit at conditions only the OLD rates could produce (whole OLD units, mid-life):
  const OLD_SCALE = 80_640;
  const oldGuild = OLD_SCALE - 12_345 * 2; // a guild droid after 12,345 unmaintained ticks at the old 2 units a tick
  const oldSynd = OLD_SCALE - 5_001 * 4; // a Syndicate droid after 5,001 unmaintained ticks at the old 4 a tick
  const oldCovered = 30_001; // a maintained guild droid, an ODD unit count (the old covered rate was 1 a tick)
  // Droids 1 and 2 stand in sysB, which has no droid_components, so every boundary leaves them unmaintained.
  // Droid 3 stands in sysA beside 100 components, so every boundary keeps it maintained.
  const s = galaxy({
    droids: [
      droid(1, 'guild', { condition: oldGuild / OLD_SCALE, systemId: SYS_B, ventureId: 'm_b' }),
      droid(2, 'syndicate', { condition: oldSynd / OLD_SCALE, systemId: SYS_B, ventureId: 'm_b' }),
      droid(3, 'guild', { condition: oldCovered / OLD_SCALE, maintained: true }),
    ],
    ventures: [mine('m'), mine('m_b', 'copper', 4, SYS_B)],
    stock: { [DROID_COMPONENTS]: 100 },
    tick: WEEK, // on a boundary, so droid 3's `maintained` is this week's, paid
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-retune-'));
  let restored;
  try {
    saveState(s, dir);
    restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(hashState(restored), hashState(s), 'the save restores byte-identically — nothing migrated');
  const g = g1Of(restored);
  // The fraction is unchanged, and its units at the new scale are EXACTLY double the old (whole numbers).
  assert.equal(units(droidOf(restored, droidIdFor(1)).condition), oldGuild * 2);
  assert.equal(units(droidOf(restored, droidIdFor(2)).condition), oldSynd * 2);
  assert.equal(units(droidOf(restored, droidIdFor(3)).condition), oldCovered * 2);
  // Predicted at the NEW rates: guild unmaintained 4 a tick, Syndicate unmaintained 8, guild maintained 1.
  const predicted = {
    [droidIdFor(1)]: (oldGuild * 2) / 4, // 27,975 ticks
    [droidIdFor(2)]: (oldSynd * 2) / 8, // 15,159 ticks
    [droidIdFor(3)]: oldCovered * 2, // 60,002 ticks, maintained every week from the stock
  };
  for (const ticks of Object.values(predicted)) assert.ok(Number.isInteger(ticks), 'every prediction is a whole tick');
  // Drive the real per-system step tick by tick, both systems (as lifeOf does — the whole life without 60,000
  // full ticks).
  const state = { tick: restored.tick, dayAnchorTick: 0, guilds: [g] };
  const start = state.tick;
  const diedAfter = {};
  while (Object.keys(diedAfter).length < 3) {
    stepDroidUpkeep(state, g, SYS);
    stepDroidUpkeep(state, g, SYS_B);
    state.tick += 1;
    for (const d of g.droids || []) {
      assert.equal(d.maintained, d.id === droidIdFor(3) ? true : undefined, `${d.id}'s coverage (tick ${state.tick})`);
    }
    for (const id of Object.keys(predicted)) {
      if (diedAfter[id] === undefined && !(g.droids || []).some((d) => d.id === id)) diedAfter[id] = state.tick - start;
    }
    if (state.tick > start + 7 * WEEK) throw new Error('a droid never wore out');
  }
  assert.deepEqual(diedAfter, predicted, 'each lands on exactly 0 on exactly the tick the new rates predict');
});

// --- 4. destroy at zero -------------------------------------------------------------------------------------

test('destroy: a droid is removed the tick it reaches 0, the loss is recorded, and the boost drops at once', () => {
  // 20 guild droids, all 3 ticks from the end: a full complement doubles the mine (10 a tick) until they go.
  const droids = Array.from({ length: 20 }, (_, i) => droid(i + 1, 'guild', { condition: 12 / 161_280 }));
  let s = galaxy({ droids });
  s = run(s, 2);
  assert.equal(g1Of(s).droids.length, 20, 'two ticks in: worn but alive');
  assert.equal(held(s, 'titanium'), 20, 'boosted: 10 a tick');
  s = run(s, 1);
  assert.equal(g1Of(s).droids, undefined, 'tick 3: all twenty reached 0 and are gone — the key omitted when empty');
  assert.equal(held(s, 'titanium'), 30, 'they still boosted the tick they wore out on');
  assert.equal(g1Of(s).droidSerial, 20, 'the serial is untouched — it only climbs');
  const notices = g1Of(s).events.filter((e) => e.type === 'droids_spent');
  assert.equal(notices.length, 1, 'one notice for the system, not one per droid');
  assert.equal(notices[0].tick, 3);
  assert.equal(notices[0].payload.systemId, SYS);
  assert.equal(notices[0].payload.systemName, SYS, 'an unseeded system falls back to its id');
  assert.deepEqual(notices[0].payload.spent.map((x) => x.droidId), droids.map((d) => d.id).sort());
  assert.deepEqual(notices[0].payload.spent[0], { droidId: droidIdFor(1), source: 'guild', ventureId: 'm' });
  s = run(s, 1);
  assert.equal(held(s, 'titanium'), 35, 'the boost is gone: back to the droidless 5 a tick');
});

test('destroy: the TOP-numbered droid\'s id is never reissued — the serial does not read live rows', () => {
  let s = galaxy({
    droids: [droid(1, 'guild', { idle: true }), droid(2, 'guild'), droid(3, 'syndicate', { condition: 8 / 161_280 })],
  });
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(3)), undefined, 'droid 03, the highest number, wore out');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a serial above every live droid is legal');
  const next = structuredClone(s);
  const minted = mintDroid(g1Of(next), 'guild', SYS, next.tick);
  assert.equal(minted.id, droidIdFor(4), 'the next droid is 04, never 03 again');
});

test('destroy: a spent droid frees its cap slot — "assigned" and "alive" coincide (docs/droids.md §10)', () => {
  const droids = Array.from({ length: 20 }, (_, i) => droid(i + 1, 'guild', { condition: i === 0 ? 4 / 161_280 : 1 }));
  droids.push(droid(21, 'guild', { idle: true }));
  let s = galaxy({ droids });
  assert.equal(validateAction(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(21), ventureId: 'm' })).valid, false, 'full');
  s = run(s, 1);
  assert.equal(assignedDroidCount(g1Of(s), 'm'), 19);
  s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(21), ventureId: 'm' }));
  assert.equal(assignedDroidCount(g1Of(s), 'm'), 20);
});

// --- 5. upkeep ----------------------------------------------------------------------------------------------

test('upkeep: the week boundary draws 1 per droid of EITHER source, and the slow rate follows', () => {
  let s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'syndicate'), droid(3, 'guild', { idle: true })],
    stock: { [DROID_COMPONENTS]: 10 },
    tick: WEEK - 2, // the next two producing ticks are 10,079 and 10,080 (the boundary)
  });
  s = run(s, 1);
  assert.equal(held(s, DROID_COMPONENTS), 10, 'off the boundary nothing is drawn');
  const atBoundary = { g: units(droidOf(s, droidIdFor(1)).condition), y: units(droidOf(s, droidIdFor(2)).condition) };
  s = run(s, 1);
  assert.equal(s.tick, WEEK);
  assert.equal(held(s, DROID_COMPONENTS), 10 - 1 - 1, 'one guild + one Syndicate droid: 1 each, 2 drawn (was 1 + 2)');
  assert.equal(droidOf(s, droidIdFor(1)).maintained, true);
  assert.equal(droidOf(s, droidIdFor(2)).maintained, true);
  assert.equal(droidOf(s, droidIdFor(3)).maintained, undefined, 'the idle droid is not paid for');
  assert.equal(droidOf(s, droidIdFor(1)).updatedAtTick, WEEK - 1, 'the coverage set is a discrete mutation: stamped');
  assert.equal(droidOf(s, droidIdFor(3)).updatedAtTick, 0, 'the idle droid is not touched');
  // The boundary tick itself still wore at LAST week's (fast) rate; the slow rate starts the tick after.
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), atBoundary.g - 4);
  assert.equal(units(droidOf(s, droidIdFor(2)).condition), atBoundary.y - 8);
  s = run(s, 10);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), atBoundary.g - 4 - 10, 'maintained guild: 1 a tick');
  assert.equal(units(droidOf(s, droidIdFor(2)).condition), atBoundary.y - 8 - 40, 'maintained Syndicate: 4 a tick');
  assert.equal(held(s, DROID_COMPONENTS), 8, 'nothing more drawn mid-week');
});

test('upkeep: when short, the LOWEST-condition droids are covered first, ties broken by id', () => {
  const s = galaxy({
    droids: [
      droid(1, 'guild', { condition: 0.5 }),
      droid(2, 'guild', { condition: 0.25 }),
      droid(3, 'guild', { condition: 0.25 }),
      droid(4, 'guild', { condition: 0.75 }),
    ],
    stock: { [DROID_COMPONENTS]: 2 },
  });
  const g = structuredClone(g1Of(s));
  assert.deepEqual(fundDroidUpkeep(g, SYS, 7), { drawn: 2, covered: 2, uncovered: 2 });
  assert.deepEqual(g.droids.filter((d) => d.maintained).map((d) => d.id), [droidIdFor(2), droidIdFor(3)],
    'the two at 0.25, not 0.5 or 0.75');
  assert.equal(g.stockpiles[SYS][DROID_COMPONENTS], 0);
  for (const d of g.droids) assert.equal(d.updatedAtTick, 7, 'every deployed droid\'s coverage was set, so stamped');
});

test('upkeep: one rate — the triage ranks by condition alone, whatever the source; the rest are skipped', () => {
  // REWRITTEN 09-11-26 (maintenance slice 1): this test used to show a Syndicate droid (cost 2) skipped and a
  // cheaper guild droid (cost 1) after it still covered. With one rate that case cannot arise, so it now pins
  // what replaced it: the source buys no priority — the worn Syndicate droid is covered first, the healthier
  // guild droids after it are skipped once the stock is gone.
  const s = galaxy({
    droids: [droid(1, 'guild', { condition: 0.9 }), droid(2, 'syndicate', { condition: 0.1 }), droid(3, 'guild', { condition: 0.5 })],
    stock: { [DROID_COMPONENTS]: 1 },
  });
  const g = structuredClone(g1Of(s));
  assert.deepEqual(fundDroidUpkeep(g, SYS, 0), { drawn: 1, covered: 1, uncovered: 2 });
  assert.equal(g.droids[1].maintained, true, 'the Syndicate droid at 0.1 — the lowest — costs 1 and takes the 1');
  assert.equal(g.droids[0].maintained, undefined, 'skipped');
  assert.equal(g.droids[2].maintained, undefined, 'skipped');
  // With 2, the next-lowest (the guild droid at 0.5) is covered too; the healthiest is still skipped.
  const g2 = structuredClone(g1Of(s));
  g2.stockpiles[SYS][DROID_COMPONENTS] = 2;
  assert.deepEqual(fundDroidUpkeep(g2, SYS, 0), { drawn: 2, covered: 2, uncovered: 1 });
  assert.deepEqual(g2.droids.filter((d) => d.maintained).map((d) => d.id), [droidIdFor(2), droidIdFor(3)]);
});

test('upkeep: a boundary that cannot pay UNCOVERS last week\'s maintained droids', () => {
  let s = galaxy({ droids: [droid(1, 'guild', { maintained: true })], tick: WEEK - 1 });
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined, 'no stock: the new week is unmaintained');
  const before = units(droidOf(s, droidIdFor(1)).condition);
  s = run(s, 1);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), before - 4, 'back to the fast rate');
});

test('upkeep: never draws below the system\'s reserve floor', () => {
  const s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'guild'), droid(3, 'guild')],
    stock: { [DROID_COMPONENTS]: 5 },
    reserve: { [SYS]: 4 },
  });
  const g = structuredClone(g1Of(s));
  assert.deepEqual(fundDroidUpkeep(g, SYS, 0), { drawn: 1, covered: 1, uncovered: 2 }, 'only 5 - 4 = 1 is spendable');
  assert.equal(g.stockpiles[SYS][DROID_COMPONENTS], 4, 'the floor is left standing');
  // Stock already below the floor: nothing is spendable, nothing drawn, nothing goes negative.
  const low = structuredClone(g1Of(s));
  low.stockpiles[SYS][DROID_COMPONENTS] = 2;
  assert.deepEqual(fundDroidUpkeep(low, SYS, 0), { drawn: 0, covered: 0, uncovered: 3 });
  assert.equal(low.stockpiles[SYS][DROID_COMPONENTS], 2);
});

test('upkeep: droids are maintained from their OWN system\'s stock only — another system\'s is never touched', () => {
  let s = galaxy({
    droids: [droid(1, 'guild')],
    ventures: [mine('m'), mine('m_b', 'copper', 4, SYS_B)],
    tick: WEEK - 1,
  });
  g1Of(s).stockpiles[SYS_B] = { [DROID_COMPONENTS]: 50 };
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined, 'sysA has none, so its droid is unmaintained');
  assert.equal(held(s, DROID_COMPONENTS, SYS_B), 50, 'sysB\'s stock is untouched');
});

test('upkeep: a droid deployed mid-week is unmaintained until the next boundary pays for it', () => {
  let s = galaxy({ droids: [droid(1, 'guild', { idle: true })], stock: { [DROID_COMPONENTS]: 5 }, tick: WEEK + 3 });
  s = accept(s, createAssignDroidAction({ guildId: 'g1', droidId: droidIdFor(1), ventureId: 'm' }));
  s = run(s, 10);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined);
  assert.equal(units(droidOf(s, droidIdFor(1)).condition), 161_280 - 40, 'the fast rate: 4 units a tick');
  assert.equal(held(s, DROID_COMPONENTS), 5);
  s.tick = 2 * WEEK - 1; // jump to just before the next boundary (deployedAtTick stays in the past)
  s = run(s, 1);
  assert.equal(droidOf(s, droidIdFor(1)).maintained, true, 'the next boundary covers it');
  assert.equal(held(s, DROID_COMPONENTS), 4);
});

test('upkeep: unassigning a maintained droid clears its coverage; the spent component is not refunded', () => {
  let s = galaxy({ droids: [droid(1, 'guild', { maintained: true })], stock: { [DROID_COMPONENTS]: 3 } });
  s = accept(s, createUnassignDroidAction({ guildId: 'g1', droidId: droidIdFor(1) }));
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined);
  assert.equal(held(s, DROID_COMPONENTS), 3);
});

test('upkeep: the draw is conserved — stock falls by exactly what the covered droids cost, every boundary', () => {
  const droids = [
    droid(1, 'guild'), droid(2, 'guild', { condition: 0.4 }), droid(3, 'syndicate'), droid(4, 'syndicate', { condition: 0.3 }),
  ];
  let s = galaxy({ droids, stock: { [DROID_COMPONENTS]: 3 }, tick: WEEK - 1 });
  s = run(s, 1);
  // 3 to spend, 1 each, lowest first: Syndicate 04 (0.3), guild 02 (0.4), then Syndicate 03 — it wore 8 units a
  // tick against guild 01's 4, so it sits LOWER than 01 — and that is the last of the stock. (Stock was 5 when a
  // Syndicate droid cost 2; 3 keeps the same three covered at one rate — changed on purpose 09-11-26.)
  const covered = g1Of(s).droids.filter((d) => d.maintained);
  assert.deepEqual(covered.map((d) => d.id), [droidIdFor(2), droidIdFor(3), droidIdFor(4)]);
  const cost = covered.length * DROID_UPKEEP_PER_WEEK;
  assert.equal(3 - held(s, DROID_COMPONENTS), cost, 'drawn = Σ the covered droids\' upkeep');
  assert.equal(held(s, DROID_COMPONENTS), 0, 'nothing left for guild 01, the healthiest');
  assert.equal(droidOf(s, droidIdFor(1)).maintained, undefined);
  // The galactic supply cache moved with the stock (advance() checked it; here it is spelled out).
  assert.equal(s.galacticSupply.resources[DROID_COMPONENTS], 0);
});

// --- 6. neutrality ------------------------------------------------------------------------------------------

// The step's whole footprint: everything but the droids, droid_components and the notice log must be untouched.
function strip(st) {
  const c = structuredClone(st);
  for (const g of c.guilds) {
    delete g.droids; delete g.events; delete g.eventSeq;
    for (const pool of Object.values(g.stockpiles || {})) delete pool[DROID_COMPONENTS];
  }
  return c;
}

test('neutrality: wear, destruction and upkeep move no GP, no mean line, no fee, no credit and no fuel', () => {
  // A licensed venture staffed with droids, on a week boundary, with one droid wearing out on that very tick.
  let s = galaxy({
    droids: [droid(1, 'syndicate', { condition: 8 / 161_280 }), droid(2, 'guild'), droid(3, 'syndicate')],
    stock: { [DROID_COMPONENTS]: 9 },
    tick: WEEK - 1,
  });
  const out = intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm', committedOutputPct: 0.5, windowDays: 7 })]);
  assert.ok(out.results[0].accepted, out.results[0].reason);
  s = out.state;
  const before = structuredClone(s);
  const g = g1Of(s);
  const pointsBefore = guildPoints(before, 'g1');
  const modBefore = issuanceModifier(before, 'g1');
  const rpBefore = expectedReputation(before, 'g1');
  stepDroidUpkeep(s, g, SYS); // the producing tick is WEEK: a boundary
  assert.equal(droidOf(s, droidIdFor(1)), undefined, 'one wore out');
  assert.equal(droidOf(s, droidIdFor(2)).maintained, true, 'and the rest were paid for');
  assert.ok(held(s, DROID_COMPONENTS) < 9, 'components were drawn');
  assert.deepEqual(strip(s), strip(before), 'nothing else in the whole state moved');
  assert.deepEqual(guildPoints(s, 'g1'), pointsBefore, 'no GP');
  assert.deepEqual(issuanceModifier(s, 'g1'), modBefore, 'no mean-line modifier');
  assert.deepEqual(expectedReputation(s, 'g1'), rpBefore, 'no RP');
  assert.deepEqual(g.ventures[0].licence, before.guilds[0].ventures[0].licence, 'the licence (and its fee) untouched');
});

// --- 7. determinism -----------------------------------------------------------------------------------------

function decayRun(n) {
  let s = galaxy({
    droids: [
      droid(1, 'guild', { condition: 0.001 }), droid(2, 'syndicate', { condition: 0.0005 }),
      droid(3, 'guild'), droid(4, 'syndicate'), droid(5, 'guild', { idle: true }),
    ],
    stock: { [DROID_COMPONENTS]: 3 },
    tick: WEEK - 30,
  });
  return run(s, n);
}

test('determinism (invariant 9): two runs across a boundary and a destruction are byte-identical', () => {
  const a = decayRun(60);
  assert.ok(g1Of(a).events.some((e) => e.type === 'droids_spent'), 'the run destroyed droids');
  assert.ok(g1Of(a).droids.some((d) => d.maintained), 'the run funded upkeep');
  assert.equal(hashState(a), hashState(decayRun(60)));
});

test('determinism (invariant 9): a save/restore mid-run continues byte-identically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-decay-'));
  try {
    const mid = decayRun(35); // past the boundary, with maintained flags and a worn condition on the books
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
    assert.equal(hashState(restored), hashState(mid), 'the save holds every field');
    assert.equal(hashState(run(restored, 25)), hashState(decayRun(60)), 'and continues as if never stopped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 8. snapshot --------------------------------------------------------------------------------------------

test('snapshot: each droid row shows maintained; the per-system upkeep row shows stock, need, coverage and runway', () => {
  let s = galaxy({
    droids: [droid(1, 'guild'), droid(2, 'syndicate'), droid(3, 'guild', { idle: true })],
    stock: { [DROID_COMPONENTS]: 12 },
    reserve: { [SYS]: 2 },
    tick: WEEK - 1,
  });
  s = run(s, 1); // the boundary draws 1 + 1 = 2 (one rate, 09-11-26 — was 1 + 2), leaving 10
  const row = buildSnapshot(s).guilds[0];
  assert.equal(row.droids.find((d) => d.id === droidIdFor(1)).maintained, true);
  assert.equal(row.droids.find((d) => d.id === droidIdFor(3)).maintained, undefined, 'omitted when not maintained');
  assert.equal(typeof row.droids[0].condition, 'number');
  assert.deepEqual(row.droidUpkeep, {
    [SYS]: {
      stock: 10, reserve: 2, weeklyUpkeep: 2, maintained: 2, unmaintained: 0,
      runwayWeeks: 4, // floor((10 - 2) / 2)
      nextUpkeepTick: 2 * WEEK,
    },
  });
  // Fogged: a rival never sees the upkeep row (its guild row is cut to the public fields).
  const two = galaxy({
    droids: [droid(1, 'guild')],
    extraGuilds: [{ id: 'g2', credits: 0, fuelHoard: 0, stockpiles: {}, ventures: [] }],
  });
  const asRival = buildSnapshot(two, 'g2').guilds.find((g) => g.id === 'g1');
  assert.equal(asRival.droidUpkeep, undefined);
  assert.ok(buildSnapshot(two, 'g1').guilds.find((g) => g.id === 'g1').droidUpkeep, 'the owner sees it');
});

test('snapshot: no deployed droid → no droidUpkeep key (omit-when-absent)', () => {
  const s = galaxy({ droids: [droid(1, 'guild', { idle: true })], stock: { [DROID_COMPONENTS]: 4 } });
  assert.equal(buildSnapshot(s).guilds[0].droidUpkeep, undefined);
  assert.equal(buildSnapshot(galaxy()).guilds[0].droidUpkeep, undefined);
});

// --- 9. the new invariants ----------------------------------------------------------------------------------

test('invariants: maintained only on a deployed droid and only `true`; no deployed droid at 0; a whole reserve', () => {
  const rules = (mutate) => {
    const s = galaxy({ droids: [droid(1, 'guild'), droid(2, 'guild', { idle: true })] });
    mutate(g1Of(s));
    return checkInvariants(s, s.tick).map((v) => v.rule);
  };
  assert.ok(rules((g) => { g.droids[1].maintained = true; }).some((r) => r.startsWith('droid-maintained-valid')), 'idle');
  assert.ok(rules((g) => { g.droids[0].maintained = 'yes'; }).some((r) => r.startsWith('droid-maintained-valid')), 'not true');
  assert.ok(rules((g) => { g.droids[0].condition = 0; }).some((r) => r.startsWith('droid-deployed-alive')), 'undead');
  assert.deepEqual(rules((g) => { g.droids[1].condition = 0; }), [], 'an IDLE droid at 0 is legal (it never wears)');
  for (const bad of [-1, 1.5, '3']) {
    assert.ok(rules((g) => { g.droidComponentReserve = { [SYS]: bad }; }).includes('droid-component-reserve-valid'), String(bad));
  }
  assert.ok(rules((g) => { g.droidComponentReserve = [1]; }).includes('droid-component-reserve-valid'));
  assert.deepEqual(rules((g) => { g.droidComponentReserve = { [SYS]: 3 }; }), []);
});

test('tripwire: fundDroidUpkeep halts if the draw and the coverage ever disagree', () => {
  const s = galaxy({ droids: [droid(1, 'guild')], stock: { [DROID_COMPONENTS]: 3 } });
  const g = structuredClone(g1Of(s));
  // A getter that lies about the stock after the draw: the conservation check must notice.
  let reads = 0;
  const pool = g.stockpiles[SYS];
  let real = pool[DROID_COMPONENTS];
  Object.defineProperty(pool, DROID_COMPONENTS, {
    get() { reads += 1; return reads > 1 ? real + 1 : real; },
    set(v) { real = v; },
    enumerable: true, configurable: true,
  });
  assert.throws(() => fundDroidUpkeep(g, SYS, 0), /drew 1 droid_components/);
});

test('decayDroidsIn: a system with no deployed droid returns nothing and changes nothing', () => {
  const g = { id: 'g1', droids: [droid(1, 'guild', { idle: true })], stockpiles: {} };
  const before = structuredClone(g);
  assert.deepEqual(decayDroidsIn(g, SYS), []);
  assert.deepEqual(decayDroidsIn(g, 'elsewhere'), []);
  assert.deepEqual(g, before);
});
