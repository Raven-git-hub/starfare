'use strict';

// tier3-console-client.test.js — the engine facts the System Production Console's Tier-3 fork
// stands on (docs/tier3-timed-production.md, "As built — the client: the System Production
// Console"). The fork is client-only (client/console.html; its served bytes are pinned in
// server.test.js). What it SHOWS, though, is only true while the engine keeps behaving this way,
// so each fact it relies on is pinned here, where an engine change would trip it:
//   1. The figures it reads: the snapshot publishes, per timed factory, a production row with
//      `timed`, `ticksPerUnit`, `unitTicksRemaining`, `minted` and `bottleneckGood`, and
//      `tier3Contract` lists exactly the goods whose factories publish such a row. The fork
//      shows "1 unit / <timer>" off the row and "up to y /week" off tier3Contract, so the two
//      must agree: ticksPerUnit × y is the week.
//   2. Why it has no Production arm and no Consumption tab: no recipe consumes a timed good.
//   3. Why its Distribution order is FIXED (RULED 28-09-26): for a committed timed good, the
//      stored order, the old send control and the reserve level move no unit during the week.
//      Only the REPORTED hold (`fork.stockpile`) changes. And an uncommitted timed good gets no
//      routing entry at all, so there is no fork to show.
//      ⤳ Slice A (the settlement-time stockpile rescue, design.md §5, RULED 28-09-26): the reserve
//      level now has one job, at the WEEK'S END only — a short week is topped up from stock above
//      it (settlement-rescue.test.js). The run below stays inside the week and meets it, so its
//      facts are unchanged; the console now says what the floor does at settlement.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { intake, createApplyForLicenceAction } = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const { ticksPerUnitFor } = require('../baseline.js');
const { getRecipe, listRecipes } = require('../recipes.js');
const { TIER3_GOODS } = require('../resources.js');

const SYS = 'sysA';
const WEEK = 10080;   // docs/tier3-timed-production.md: "exactly one 7-day window (10,080 ticks)"

const TIMED = TIER3_GOODS.filter((g) => ticksPerUnitFor(g) !== null);
const factory = (id, recipeId) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: 5 });
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
function galaxy(ventures, stock, goods) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { ...stock } }, ventures,
      ...(goods ? { productionProfile: { [SYS]: { goods } } } : {}) }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
}
function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `refused: ${r.reason}`);
  return out.state;
}
const systemOf = (snap) => snap.production[0].systems.find((x) => x.systemId === SYS);

// --- 1. the figures the fork reads ----------------------------------------------------------------

test('the fork\'s figures: every timed factory publishes its timer and its unit on the line, and they agree with tier3Contract', () => {
  // One factory of every timed good, each with one input set, so every line starts a unit on
  // tick 1. Plus the four unclassified modules, which are Tier 3 but not timed.
  const untimed = TIER3_GOODS.filter((g) => ticksPerUnitFor(g) === null);
  assert.equal(untimed.length, 4, 'the four unclassified modules');
  let stock = {};
  for (const g of TIMED) for (const [k, v] of Object.entries(inputSets(g, 1))) stock[k] = (stock[k] || 0) + v;
  let s = galaxy([...TIMED, ...untimed].map((g) => factory(`f_${g}`, g)), stock);
  s = tick(s);
  const snap = buildSnapshot(s);
  const rows = systemOf(snap).refineries;

  // The trigger set: tier3Contract lists exactly the goods whose factories publish a timed row.
  const timedRowGoods = rows.filter((r) => r.timed).map((r) => getRecipe(s.guilds[0].ventures.find((v) => v.id === r.ventureId).recipeId).output.good);
  assert.deepEqual([...timedRowGoods].sort(), Object.keys(snap.tier3Contract).sort());
  assert.deepEqual(Object.keys(snap.tier3Contract).sort(), [...TIMED].sort());
  for (const g of untimed) {
    const r = rows.find((x) => x.ventureId === `f_${g}`);
    assert.ok(r && !r.timed, `${g} is not timed, so the console keeps its Tier-1/2 panel`);
    assert.equal(snap.tier3Contract[g], undefined);
  }

  for (const g of TIMED) {
    const r = rows.find((x) => x.ventureId === `f_${g}`);
    // The fields the fork reads, by name — a rename here would silently blank the panel.
    for (const k of ['timed', 'ticksPerUnit', 'unitTicksRemaining', 'minted', 'bottleneckGood']) {
      assert.ok(k in r, `${g}: the row carries ${k}`);
    }
    // "1 unit / <timer>" and "up to y /week" are one fact said twice: the timer × y is the week.
    assert.equal(r.ticksPerUnit, ticksPerUnitFor(g), g);
    assert.equal(r.ticksPerUnit * snap.tier3Contract[g].weeklyOutput, WEEK, `${g}: timer × y = the week`);
    // A unit is on the line (it started on tick 1), and the countdown is a whole number of ticks
    // in [0, timer): the preview is the NEXT tick's, after its work.
    assert.equal(r.minted, 0, g);
    assert.ok(Number.isInteger(r.unitTicksRemaining) && r.unitTicksRemaining >= 0 && r.unitTicksRemaining < r.ticksPerUnit,
      `${g}: unit on the line, ${r.unitTicksRemaining} of ${r.ticksPerUnit} left`);
    assert.equal(r.bottleneckGood, null, g);
  }
});

// --- 2. no consumer: no Production arm, no Consumption tab -------------------------------------------

test('nothing consumes a timed good: no recipe takes one as an input (the fork drops the Production arm and the Consumption tab)', () => {
  // A Tier-3 part feeds Tier-4 assembly, which takes the whole bill from the stockpile at a build's
  // start — not a continuous line in Gate 2. If a recipe ever consumes a timed good, the console's
  // Tier-3 fork is hiding a real flow and must be revisited.
  const consumers = listRecipes().filter((r) => r.inputs.some((i) => ticksPerUnitFor(i.good) !== null));
  assert.deepEqual(consumers.map((r) => r.id), []);
});

// --- 3. the order, the send control and the reserve level move no unit ---------------------------------

test('FIXED ORDER, NO HOLDING BACK: for a committed timed good the stored order, the send control and the reserve level move no unit', () => {
  // The console draws Syndicate then Stockpile in a fixed order, offers no send control, and says
  // nothing about the reserve holding units back. That is only honest while this holds: the same
  // committed factory, under the default policy and under every lever the Tier-1/2 console offers,
  // delivers, stocks and is paid identically on EVERY tick. The one figure that moves is the
  // reported hold, `fork.stockpile` = min(reserveLevel, what is left in the pot).
  const RUN = 1200;
  const levers = {
    plain: null,
    reserveFirst: { order: ['stockpile', 'downstream', 'syndicate'], reserveLevel: 30 },
    sendOff: { syndicate: { mode: 'absolute', value: 0 }, reserveLevel: 500 },
  };
  const runs = {};
  for (const [name, policy] of Object.entries(levers)) {
    let s = galaxy([factory('f', 'fuel_tank')], inputSets('fuel_tank', 60), policy ? { fuel_tank: policy } : null);
    s = sign(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'f', committedUnits: 50 })]);
    const trace = [];
    for (let i = 0; i < RUN; i += 1) {
      const g = systemOf(buildSnapshot(s)).goods.fuel_tank;
      s = tick(s);
      const guild = s.guilds[0];
      trace.push({
        stock: guild.stockpiles[SYS].fuel_tank || 0,
        credits: guild.credits,
        delivered: g.window.delivered,
        synTake: g.fork.syndicate,
        consumers: g.fork.downstream,
        heldReported: g.fork.stockpile,
      });
    }
    runs[name] = trace;
  }
  const moved = (t) => t.map(({ heldReported, ...rest }) => rest);
  assert.deepEqual(moved(runs.reserveFirst), moved(runs.plain), 'a reserve ranked first moves no unit and no credit');
  assert.deepEqual(moved(runs.sendOff), moved(runs.plain), 'absolute 0 and a reserve of 500 move no unit and no credit');

  // It is a real run: 60 units made in 900 ticks, the first 50 to the Syndicate, the rest kept.
  const end = runs.plain[RUN - 1];
  assert.equal(end.delivered, 50);
  assert.equal(end.stock, 10);
  assert.ok(runs.plain.every((t) => t.consumers === 0), 'nothing draws a timed good downstream');
  // Only the report moves: the default holds 0; a reserve of 30 reports up to 30 held.
  assert.ok(runs.plain.every((t) => t.heldReported === 0));
  assert.equal(runs.reserveFirst[RUN - 1].heldReported, 10, 'min(30, the 10 left in the pot)');
});

test('an UNCOMMITTED timed good gets no routing entry: nothing to fork, every unit stays in the stockpile', () => {
  let s = galaxy([factory('f', 'fuel_tank')], inputSets('fuel_tank', 3), { fuel_tank: { reserveLevel: 2 } });
  for (let i = 0; i < 60; i += 1) {
    assert.equal(systemOf(buildSnapshot(s)).goods.fuel_tank, undefined, `tick ${s.tick}: no goods entry, so the console reads no fork`);
    s = tick(s);
  }
  assert.equal(s.guilds[0].stockpiles[SYS].fuel_tank, 3, 'all three units made are the guild\'s');
});
