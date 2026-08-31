'use strict';

// fuel.test.js — the tripwires for fuel Slice 1: fuel is real and seeded.
//
// WHAT THIS SLICE ACTUALLY DID: one line. `foundGuild` stopped writing
// `fuelHoard: 0` and started writing `GUILD_STARTING_FUEL` — the early-game
// starter floor ruled in docs/fuel-economy.md §7. A one-line change to a
// CONSERVED quantity is exactly the kind that rots silently, because minting
// fuel touches two bookkeeping surfaces that are nowhere near the line that
// mints it:
//
//   1. `audit.totalProduced` — invariant 1 says
//        Σ fuelHoard + reserve.reserveLevel + inTransit === totalProduced − totalConsumed
//      so a hoard that appears without a matching PRODUCED entry unbalances the
//      ledger the instant a guild is born.
//   2. `galacticSupply.fuel.guildHeld` — a CACHE, re-derived and compared every
//      assert by the `galactic-supply-consistency` invariant. `POST /action`
//      asserts after every apply with NO tick in between, so a stale cache here
//      is an HTTP 500 on the founding, not a slow drift.
//
// Every test below therefore asserts the FULL invariant sweep (all nine) rather
// than a hand-picked one — and then re-does invariant 1's arithmetic by hand, so
// a failure names the term that is wrong instead of just saying "violated".
//
// NOT PROVEN HERE, because it does not exist yet: any fuel being SPENT. Nothing
// in the engine consumes fuel, so `totalConsumed` is 0 throughout and a hoard,
// once seeded, simply sits. That is the slice's boundary, and the "one tick moves
// no fuel" test below is the assertion that it really is the boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createFoundGuildAction, intake } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { GUILD_STARTING_FUEL, FLAT_FUEL_PRICE_PER_UNIT } = require('../fuel.js');

const found = (guildId, homeSystemId) => createFoundGuildAction({
  guildId, name: guildId, credits: 120, influence: 100, homeSystemId,
});

// Found a guild through `intake` — the drain `POST /action` uses — so the state
// under test is the one that exists BETWEEN ticks: the action applied, nothing
// advanced. That is deliberately the harder case. `advance()` would run a full
// tick afterwards, and `tick.js` refreshes `galacticSupply` at the end of its
// eight steps, which would paper over a missing refresh in the apply itself.
function foundVia(state, guildId, homeSystemId) {
  const { state: next, results } = intake(state, [found(guildId, homeSystemId)]);
  assert.equal(results[0].accepted, true, `founding ${guildId} was rejected: ${results[0].reason}`);
  assert.equal(next.tick, state.tick, 'intake applies without ticking — this is the between-tick seam');
  return next;
}

// Invariant 1's arithmetic, re-done here rather than imported: the point is for a
// failure to name the offending TERM ("hoards 500, produced 30") instead of
// handing back an opaque violation record. `inTransit` is fuel riding a shipment
// (there are none in this slice — no fuel ships — but the term is real and left in
// so this stays a full restatement of the invariant, not a convenient subset).
function assertFuelBalances(state, where) {
  const hoards = state.guilds.reduce((sum, g) => sum + g.fuelHoard, 0);
  const inTransit = (state.shipments || []).reduce((sum, s) => sum + ((s.cargo && s.cargo.fuel) || 0), 0);
  const lhs = hoards + state.reserve.reserveLevel + inTransit;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  assert.equal(lhs, rhs,
    `${where}: Σ hoards (${hoards}) + reserve (${state.reserve.reserveLevel}) + inTransit (${inTransit}) `
    + `= ${lhs}, but totalProduced (${state.audit.totalProduced}) − totalConsumed (${state.audit.totalConsumed}) = ${rhs}`);
}

// --- the grant itself ------------------------------------------------------

test('founding seeds the starter hoard, and every invariant still holds at that instant', () => {
  const zero = createZeroState();
  // The pre-condition the whole slice hangs off: a guild-less galaxy holds fuel
  // only in the communal reserve, and that is exactly what the audit says.
  assert.equal(zero.audit.totalProduced, zero.reserve.reserveLevel);
  assert.equal(zero.audit.totalConsumed, 0);

  const s = foundVia(zero, 'player-guild', 'sys_0002');
  const g = s.guilds[0];

  assert.equal(g.fuelHoard, GUILD_STARTING_FUEL);
  assert.equal(g.fuelHoard, 500, 'the [FIRST-CUT] starter floor, pinned so a silent retune is visible here');

  // ALL NINE, immediately after the apply with NO tick in between — the exact
  // moment `POST /action` asserts at, and the one this slice could break.
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assertFuelBalances(s, 'after founding one guild');

  // The two surfaces the grant had to touch, named individually so a failure says
  // WHICH one was missed rather than pointing at the sweep above.
  assert.equal(s.audit.totalProduced, zero.reserve.reserveLevel + GUILD_STARTING_FUEL,
    'the grant was recorded as PRODUCED — this is what makes invariant 1 balance');
  assert.equal(s.audit.totalConsumed, 0, 'and nothing consumes fuel in this slice');
  assert.equal(s.galacticSupply.fuel.guildHeld, GUILD_STARTING_FUEL,
    'and the galacticSupply cache was refreshed in the same apply');
  assert.deepEqual(s.galacticSupply, computeGalacticSupply(s),
    'the cache is exactly what a live re-derivation gives — the galactic-supply-consistency contract');
});

test('a second founding grows the total by exactly one more grant', () => {
  let s = foundVia(createZeroState(), 'player-guild', 'sys_0002');
  s = foundVia(s, 'rival', 'sys_0009');

  assert.equal(s.guilds.length, 2);
  assert.equal(s.guilds[0].fuelHoard, GUILD_STARTING_FUEL);
  assert.equal(s.guilds[1].fuelHoard, GUILD_STARTING_FUEL);

  assert.deepEqual(checkInvariants(s, s.tick), []);
  assertFuelBalances(s, 'after founding two guilds');

  const reserve = s.reserve.reserveLevel;
  assert.equal(s.audit.totalProduced, reserve + 2 * GUILD_STARTING_FUEL,
    'two grants, two production entries — the counter is per-founding, not per-galaxy');
  assert.equal(s.galacticSupply.fuel.guildHeld, 2 * GUILD_STARTING_FUEL);
});

test('a tick moves no fuel — the hoard just sits (nothing spends it in this slice)', () => {
  let s = foundVia(createZeroState(), 'player-guild', 'sys_0002');
  const producedAtFounding = s.audit.totalProduced;

  s = advance(s, []).state;

  assert.equal(s.tick, 1);
  assert.equal(s.guilds[0].fuelHoard, GUILD_STARTING_FUEL, 'the tick neither burned nor added fuel');
  assert.equal(s.audit.totalProduced, producedAtFounding, 'and minted none: totalProduced is unmoved');
  assert.equal(s.audit.totalConsumed, 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assertFuelBalances(s, 'one tick after founding');
});

// --- the snapshot field ----------------------------------------------------

test('the snapshot reports the hoard and its mark-to-market credit value', () => {
  const s = foundVia(createZeroState(), 'player-guild', 'sys_0002');
  const guild = buildSnapshot(s).guilds[0];

  assert.equal(guild.fuelHoard, 500);
  assert.equal(guild.fuelHoardValue, 5000, '500 units at the [FIRST-CUT] flat 10 ¢/unit');
  // Stated as the relationship as well as the number, so retuning either constant
  // moves the pinned figures above and leaves this one honest.
  assert.equal(guild.fuelHoardValue, guild.fuelHoard * FLAT_FUEL_PRICE_PER_UNIT);
  assert.ok(Number.isInteger(guild.fuelHoardValue), 'integer credits (§15.2)');
});

test('fuelHoardValue is derived telemetry — it reaches no stored byte and charges nothing', () => {
  const s = foundVia(createZeroState(), 'player-guild', 'sys_0002');

  assert.equal(s.guilds[0].fuelHoardValue, undefined, 'the value is computed on read, never stored');
  // Fuel is the one good the price engine never prices (design.md §8), which is the
  // whole reason the flat rate exists — if a posted row ever appears, this constant
  // is the thing to delete, and this assertion is the reminder.
  assert.equal(s.prices.deuterium_fuel, undefined, 'fuel still has no posted price');
  // Marking the hoard to market moves no credits: the ledger and every guild balance
  // are exactly what founding left them, so invariant 2 cannot see this field at all.
  assert.equal(s.guilds[0].credits, 120);
  assert.equal(s.syndicate.ledger, -120);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
