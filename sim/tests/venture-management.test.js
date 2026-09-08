'use strict';

// venture-management.test.js — the two PURE snapshot derives the Venture Management popup reads
// (docs/venture-management.md §7): `contractWindow` (the licence's window in CYCLES) and
// `equityPerCycle` (the investor payout projection). Both are DERIVED on read, so — like every
// snapshot derive — they touch no serialized byte and move NO determinism golden; the purity
// assertions below stand in for that (there is no golden move to re-pin).
//
// The arithmetic each test asserts against is STATED here from the licence's own stored terms and
// the snapshot's published price, not read back off the helper under test, so a test cannot pass
// by agreeing with a wrong implementation of the thing it guards.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createState } = require('../state.js');
const {
  createFoundGuildAction, createEstablishVentureAction, createApplyForLicenceAction,
  createSetWindowNAction,
} = require('../actions.js');
const { teardownSettlement } = require('../licence.js');
const { buildSnapshot } = require('../snapshot.js');
const { hashState } = require('../serialize.js');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const GUILD = 'player-guild';
const N = 4;                                    // a short accrual window, so terms resolve fast
const M1 = 'asset_player-guild_miner_01';       // one of the fifteen Miners the founding gifts

const guildOf = (s) => s.guilds.find((g) => g.id === GUILD);
const ventureOf = (s, id) => guildOf(s).ventures.find((v) => v.id === id);
const rowOf = (s, id) => buildSnapshot(s).ventures.find((v) => v.id === id);

function founded() {
  return advance(createZeroState(), [
    createSetWindowNAction({ windowN: N }),
    createFoundGuildAction({ guildId: GUILD, credits: 500, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]).state;
}

// Found, then establish a titanium mine on HOME_MINE and license it in one advance. `equityPct`
// is an ESTABLISH term (§5 Slice 3a), so it rides the establish action, not the licence.
function licensedMine({ committedOutputPct = 1, windowDays = 7, equityPct } = {}) {
  return advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5, ...(equityPct === undefined ? {} : { equityPct }),
    }),
    createApplyForLicenceAction({ guildId: GUILD, ventureId: 'mine_1', committedOutputPct, windowDays }),
  ]).state;
}

// An unlicensed titanium mine — established, never licensed.
function unlicensedMine() {
  return advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5,
    }),
  ]).state;
}

// A licensed (windowless) deuterium mine, built directly — it carries `deuteriumLicence`, never an
// ordinary `licence`, so both derives read it as "no window / no equity" (§1.4 / §6).
function deuteriumMineState() {
  return createState({
    guilds: [{
      id: GUILD, credits: 0, fuelHoard: 0,
      ventures: [
        { id: 'deut_1', ownerGuildId: GUILD, type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: 5, deuteriumLicence: { signedTick: 0 } },
      ],
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

// --- contractWindow ---------------------------------------------------------

test('contractWindow: a licensed venture publishes the term in cycles, endTick agreeing with the settlement', () => {
  const s = licensedMine();
  const lic = ventureOf(s, 'mine_1').licence;
  const cw = rowOf(s, 'mine_1').contractWindow;

  const endTick = lic.signedTick + lic.windowDays * N;
  const remaining = Math.max(0, lic.windowDays - Math.floor((s.tick - lic.signedTick) / N));
  assert.equal(cw.endTick, endTick);
  assert.equal(cw.endCycle, Math.floor(endTick / N));
  assert.equal(cw.cyclesRemaining, remaining);
  assert.equal(cw.expired, remaining === 0);
  assert.ok(remaining > 0, 'a just-signed 7-day term still has cycles left');

  // The one shared number: while the term has time left, endTick IS teardownSettlement's lockout.
  assert.equal(cw.endTick, teardownSettlement(s, guildOf(s), ventureOf(s, 'mine_1')).lockoutUntilTick);
});

test('contractWindow: cyclesRemaining decreases by one across a cycle boundary', () => {
  let s = licensedMine();
  const before = rowOf(s, 'mine_1').contractWindow.cyclesRemaining;
  for (let i = 0; i < N; i++) s = advance(s, []).state;   // exactly one cycle of ticks
  const after = rowOf(s, 'mine_1').contractWindow.cyclesRemaining;
  assert.equal(after, before - 1, 'one cycle elapsed, one fewer remaining');
});

test('contractWindow: expired flips true once the term has fully elapsed', () => {
  let s = licensedMine();
  const lic = ventureOf(s, 'mine_1').licence;
  const termEnd = lic.signedTick + lic.windowDays * N;
  while (s.tick < termEnd) s = advance(s, []).state;
  const cw = rowOf(s, 'mine_1').contractWindow;
  assert.equal(cw.cyclesRemaining, 0);
  assert.equal(cw.expired, true);
  // Past the term the settlement rolls to free: no fee, no lockout (§3.2).
  assert.equal(teardownSettlement(s, guildOf(s), ventureOf(s, 'mine_1')).settlementFee, 0);
});

test('contractWindow is null for an unlicensed venture and for a windowless deuterium mine', () => {
  assert.equal(rowOf(unlicensedMine(), 'mine_1').contractWindow, null);
  assert.equal(rowOf(deuteriumMineState(), 'deut_1').contractWindow, null);
});

// --- equityPerCycle ---------------------------------------------------------

test('equityPerCycle matches round(committedOutputPct × rate × windowN × equityPct × postedPrice)', () => {
  const s = licensedMine({ committedOutputPct: 1, equityPct: 0.4 });
  const snap = buildSnapshot(s);
  const row = snap.ventures.find((v) => v.id === 'mine_1');

  const price = snap.prices.titanium;                 // the published posted price the derive reads
  assert.equal(typeof price, 'number');
  assert.ok(price > 0, 'a fresh galaxy posts a real titanium price');
  const expected = Math.round(1 * 5 * N * 0.4 * price);
  assert.equal(row.equityPerCycle, expected);
  assert.ok(row.equityPerCycle > 0, 'a real equity offer projects a real payout');
});

test('equityPerCycle is 0 for a zero-equity, an unlicensed, and a deuterium venture', () => {
  assert.equal(rowOf(licensedMine({ equityPct: 0 }), 'mine_1').equityPerCycle, 0);   // licensed, no equity
  assert.equal(rowOf(unlicensedMine(), 'mine_1').equityPerCycle, 0);                 // no licence at all
  assert.equal(rowOf(deuteriumMineState(), 'deut_1').equityPerCycle, 0);             // deuterium: no posted price
});

// --- both are pure reads: no state golden can move on their account ----------

test('building the snapshot mutates no state — the two derives move no determinism golden', () => {
  const s = licensedMine({ equityPct: 0.4 });
  const before = hashState(s);
  const snap = buildSnapshot(s);
  // The fields are present (so this test really exercised them)…
  assert.ok(snap.ventures.find((v) => v.id === 'mine_1').contractWindow);
  assert.ok(snap.ventures.find((v) => v.id === 'mine_1').equityPerCycle > 0);
  // …and computing them changed not one byte of state.
  assert.equal(hashState(s), before);
});
