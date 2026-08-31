'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createState } = require('../state.js');
const { createZeroState, SYNDICATE_OWNER } = require('../scenarios/zero-state.js');
const { createFoundGuildAction, createPaySyndicateFeeAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { GUILD_STARTING_FUEL } = require('../fuel.js');

// --- the driver's guards + purity -----------------------------------------

test('advance requires state', () => {
  assert.throws(() => advance(), /state is required/);
});

test('advance rejects a non-array actions argument', () => {
  assert.throws(() => advance(createZeroState(), 'nope'), /actions must be an array/);
});

test('advance with no actions ticks exactly once and stays green', () => {
  const s = createZeroState();
  const { state: next } = advance(s);
  assert.equal(next.tick, s.tick + 1);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('advance never mutates its input state', () => {
  const s = createZeroState();
  const before = JSON.stringify(s);
  advance(s, [createFoundGuildAction({ guildId: 'g1', credits: 120, homeSystemId: 'sys_0002' })]);
  assert.equal(JSON.stringify(s), before, 'input state must be untouched');
});

// --- the zero-state boots as an honest empty galaxy ------------------------

test('the zero-state boots green with no guilds and Syndicate-owned claims', () => {
  const s = createZeroState();
  assert.equal(s.tick, 0);
  assert.equal(s.guilds.length, 0);
  assert.equal(s.reserve.reserveLevel, 30);
  assert.equal(s.syndicate.ledger, 0);
  // Citadel + one waystation per seed outpost (9) = 10 Syndicate claims,
  // every one referencing a real seed landmark.
  assert.equal(s.claims.length, 10);
  assert.ok(s.claims.every((c) => c.ownerGuildId === SYNDICATE_OWNER));
  // The world references the seed the galaxy is built over -- no invented graph.
  assert.equal(s.world.seed, 7331);
  assert.deepEqual(checkInvariants(s, 0), []);
});

// --- founding the first guild is conservation-clean ------------------------

test('foundGuild inserts the guild and debits its credits from the ledger', () => {
  const s = createZeroState();
  const action = createFoundGuildAction({ guildId: 'player-guild', name: 'Player Guild', credits: 120, influence: 100, homeSystemId: 'sys_0002' });
  const { state: next, results } = advance(s, [action]);

  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, true);

  assert.equal(next.guilds.length, 1);
  const g = next.guilds[0];
  assert.equal(g.id, 'player-guild');
  assert.equal(g.credits, 120);
  // The founding fuel grant (fuel Slice 1): a new guild opens with the starter floor
  // in its hoard (docs/fuel-economy.md §7), not the 0 this used to assert.
  assert.equal(g.fuelHoard, GUILD_STARTING_FUEL);
  assert.equal(g.influence, 100); // +20 claim bonus does NOT fire at founding

  // Home seated (design.md §13): the guild lives on sys_0002's Terran homeworld,
  // and a matching home claim -- the ownership source of truth -- was added.
  assert.equal(g.homeSystemId, 'sys_0002');
  assert.equal(g.homePlanetId, 'pl_00004');
  const home = next.claims.find((c) => c.landmarkId === 'sys_0002' && c.ownerGuildId === 'player-guild');
  assert.ok(home, 'a guild-owned home claim on sys_0002 must exist');
  assert.equal(home.landmarkKind, 'system');

  // Credits MOVED, none minted: ledger 0 -> -120, and the credit-conservation
  // invariant still holds (this is the whole point of routing founding through
  // the ledger rather than pre-loading a magic balance).
  assert.equal(next.syndicate.ledger, -120);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('foundGuild refuses a duplicate guild id (first-valid-wins)', () => {
  const s = createZeroState();
  const a = createFoundGuildAction({ guildId: 'dup', credits: 50, homeSystemId: 'sys_0002' });
  const b = createFoundGuildAction({ guildId: 'dup', credits: 999, homeSystemId: 'sys_0002' });
  const { state: next, results } = advance(s, [a, b]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /already exists/);
  assert.equal(next.guilds.length, 1);
  assert.equal(next.syndicate.ledger, -50); // only the first debit landed
});

// --- validate-as-they-arrive survives the driver (§15.6's worked example) ---

test('three "spend 80" orders on 100 credits: only the first is accepted', () => {
  // design.md §15.6's own example, now run end-to-end through advance().
  const s = createState({
    guilds: [{ id: 'g1', credits: 100, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -100 },
  });
  const spend80 = () => createPaySyndicateFeeAction({ guildId: 'g1', amount: 80 });
  const { state: next, results } = advance(s, [spend80(), spend80(), spend80()]);
  assert.deepEqual(results.map((r) => r.accepted), [true, false, false]);
  assert.equal(next.guilds[0].credits, 20);
  assert.equal(next.syndicate.ledger, -20);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// --- the tripwire actually FIRES (it is wired, not merely present) ----------

test('advance halts loudly when a resulting state breaks an invariant', () => {
  // A hand-built state that passes intake (no actions) but whose guild credits are
  // FRACTIONAL -- the §15.2 integer tripwire must fire, naming the tick.
  //
  // This fixture used to use NEGATIVE credits, which is no longer a violation: Slice
  // 3b-iii made guild credits exempt from non-negativity (§5 -- a breach fee may put a
  // guild in debt), so a negative balance is now a legal pressure state. The integer
  // rule is untouched and is the cheap, deterministic break this test wants. The credit
  // TOTAL still matches `expectedCreditTotal`, so ONLY the integer rule breaks.
  const broken = {
    tick: 7,
    guilds: [{ id: 'g1', credits: 0.5, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    world: { nodes: [] },
    claims: [],
    shipments: [],
    audit: { totalProduced: 0, totalConsumed: 0, expectedCreditTotal: 0.5 },
  };
  assert.throws(() => advance(broken), /Invariant violation at tick 8/);
});

// --- determinism through the driver ----------------------------------------

test('same zero-state + same actions, run twice, byte-identical at tick 10', () => {
  const actions = [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002' })];
  function run() {
    let s = createZeroState();
    // turn 1 founds the guild; turns 2..10 are quiet ticks.
    s = advance(s, actions).state;
    for (let i = 0; i < 9; i += 1) s = advance(s).state;
    return s;
  }
  assert.equal(hashState(run()), hashState(run()));
});
