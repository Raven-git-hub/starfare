'use strict';

// dockyard-points.test.js — roadmap 2.1b / docs/build-yard.md §5 slice 2: the dockyard as a
// FULL Tier-4 venture in the mean-line economy. This slice is NOT a no-op — it changes GP and RP
// by design, and every delta below is proved exactly:
//
//   - GP: a dockyard is special-COUNTed at Tier 4 → +TIER_WEIGHT[4] (500). The mirror of the
//     deuterium mine's 0-GP special-SKIP (sim/points.js).
//   - RP: a held Tier-4 signing bump of 900, minted ONCE at establish onto venture.reputation with
//     guild.guildReputation tracking it (sim/licence.js signingBump special-cased on isDockyard;
//     applied in the establishDockyard apply, sim/actions.js).
//   - With MEANLINE_K = 1 the +500 GP lifts expectedReputation by 500, so the RP gap rises 900 − 500
//     = +400 net. That +400 is the tuning invariant's middle rung: deuterium mine (+1000) > dockyard
//     (+400) > the best Tier-1/2/3 production venture (tier-3 at 100% commit → +300 net).
//   - Not farmable: establish then decommission nets exactly 0 GP and 0 RP (the 900 forfeits, the
//     500 GP drops with the venture). checkGuildReputationSum stays exact throughout.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { guildPoints, TIER_WEIGHT } = require('../points.js');
const { signingBump, DOCKYARD_SIGNING_BUMP } = require('../licence.js');
const { expectedReputation } = require('../meanline.js');
const {
  applyAction,
  createFoundGuildAction, createEstablishDockyardAction, createDecommissionVentureAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_PLANET, HOME_SLOT } = require('./home-anchor.js');

// A founded player guild: home system (GP 200), a fistful of idle starter assets (GP 0 — idle
// inventory scores nothing), no ventures. Founding endowment = MEANLINE_K × systemPoints = 200,
// so it opens exactly on its line (guildReputation 200 == expected 200).
function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
}
const F1 = 'asset_player-guild_factory_01';
const F2 = 'asset_player-guild_factory_02';
const HOME_SLOT_2 = `${HOME_PLANET}_s02`;
const dockyardAction = (over = {}) => createEstablishDockyardAction({
  guildId: 'player-guild', ventureId: 'yard1', siteId: HOME_SLOT, assetId: F1, ...over,
});

// The RP gap the mean line judges a guild on: its stored RP minus the RP its size expects.
const rpGap = (state, guild) => guild.guildReputation - expectedReputation(state, guild);

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE EXACT DELTAS ON ESTABLISH — +500 GP, +900 RP, +400 net (this slice is NOT a no-op)
// ════════════════════════════════════════════════════════════════════════════════════════════

test('establishing a dockyard raises guildPoints by exactly 500 (TIER_WEIGHT[4])', () => {
  const founded = playerFounded();
  const gp0 = guildPoints(founded, founded.guilds[0]);
  const seated = applyAction(founded, dockyardAction());
  assert.equal(guildPoints(seated, seated.guilds[0]) - gp0, 500, 'GP rises by exactly the Tier-4 weight');
  assert.equal(guildPoints(seated, seated.guilds[0]) - gp0, TIER_WEIGHT[4], 'and that is TIER_WEIGHT[4], no new number');
});

test('establishing a dockyard mints exactly 900 RP on the venture and the guild total', () => {
  const founded = playerFounded();
  const rp0 = founded.guilds[0].guildReputation;
  const seated = applyAction(founded, dockyardAction());
  const yard = seated.guilds[0].ventures.find((v) => v.id === 'yard1');
  assert.equal(yard.reputation, 900, 'the held Tier-4 bump lands on venture.reputation');
  assert.equal(seated.guilds[0].guildReputation - rp0, 900, 'and the guild total rises by the same 900');
  assert.equal(yard.reputation, DOCKYARD_SIGNING_BUMP, 'sourced from the ruled DOCKYARD_SIGNING_BUMP');
});

test('expectedReputation rises 500 and the RP gap rises +400 (the net standing benefit)', () => {
  const founded = playerFounded();
  const exp0 = expectedReputation(founded, founded.guilds[0]);
  const gap0 = rpGap(founded, founded.guilds[0]);
  assert.equal(gap0, 0, 'a newborn opens exactly on its line');
  const seated = applyAction(founded, dockyardAction());
  assert.equal(expectedReputation(seated, seated.guilds[0]) - exp0, 500, 'the bar rises by the +500 GP (MEANLINE_K = 1)');
  assert.equal(rpGap(seated, seated.guilds[0]) - gap0, 400, 'so the net standing benefit is 900 RP − 500 bar = +400');
});

test('two dockyards → +1000 GP / +1800 RP (the deltas are additive)', () => {
  const founded = playerFounded();
  const gp0 = guildPoints(founded, founded.guilds[0]);
  const rp0 = founded.guilds[0].guildReputation;
  const one = applyAction(founded, dockyardAction());
  const two = applyAction(one, createEstablishDockyardAction({
    guildId: 'player-guild', ventureId: 'yard2', siteId: HOME_SLOT_2, assetId: F2,
  }));
  assert.equal(guildPoints(two, two.guilds[0]) - gp0, 1000, 'two Tier-4 counts → +1000 GP');
  assert.equal(two.guilds[0].guildReputation - rp0, 1800, 'two held bumps → +1800 RP');
  assert.deepEqual(checkInvariants(two, two.tick), [], 'the two-dockyard state is valid');
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. signingBump(dockyard) === 900 — the flat magnitude, and it does NOT throw
// ════════════════════════════════════════════════════════════════════════════════════════════

test('signingBump on a dockyard returns 900 and does not throw (returns before repTerms)', () => {
  // A dockyard carries no windowed `licence`, so were it to reach repTerms that would throw. The
  // isDockyard special-case must return the flat 900 FIRST.
  const dockyard = { id: 'd', ownerGuildId: 'g', type: 'refining', dockyard: true, buildQueue: [] };
  assert.doesNotThrow(() => signingBump(dockyard));
  assert.equal(signingBump(dockyard), 900);
  assert.equal(signingBump(dockyard), DOCKYARD_SIGNING_BUMP);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. NOT FARMABLE — establish then teardown nets exactly 0 GP and 0 RP
// ════════════════════════════════════════════════════════════════════════════════════════════

test('establish → decommission a dockyard nets exactly 0 GP and 0 RP', () => {
  const founded = playerFounded();
  const gp0 = guildPoints(founded, founded.guilds[0]);
  const rp0 = founded.guilds[0].guildReputation;

  const seated = applyAction(founded, dockyardAction());
  assert.equal(guildPoints(seated, seated.guilds[0]) - gp0, 500, 'while it stands: +500 GP');
  assert.equal(seated.guilds[0].guildReputation - rp0, 900, 'while it stands: +900 RP');

  // A dockyard is unlicensed — no settlement fee, no node lockout (both ordinary-licensed only).
  const torn = applyAction(seated, createDecommissionVentureAction({ guildId: 'player-guild', ventureId: 'yard1' }));
  assert.equal(torn.guilds[0].ventures.find((v) => v.id === 'yard1'), undefined, 'the dockyard is gone');
  assert.equal(guildPoints(torn, torn.guilds[0]) - gp0, 0, 'the +500 GP drops with the venture');
  assert.equal(torn.guilds[0].guildReputation - rp0, 0, 'the +900 RP forfeits — banked nothing');
  assert.deepEqual(checkInvariants(torn, torn.tick), [], 'the post-teardown state is valid');
});

test('an establish/teardown LOOP banks nothing — the bump is held, never farmed', () => {
  let cur = playerFounded();
  const gp0 = guildPoints(cur, cur.guilds[0]);
  const rp0 = cur.guilds[0].guildReputation;
  for (let i = 0; i < 5; i += 1) {
    cur = applyAction(cur, dockyardAction());
    cur = applyAction(cur, createDecommissionVentureAction({ guildId: 'player-guild', ventureId: 'yard1' }));
  }
  assert.equal(guildPoints(cur, cur.guilds[0]), gp0, 'GP is exactly back to baseline after five loops');
  assert.equal(cur.guilds[0].guildReputation, rp0, 'RP is exactly back to baseline — nothing banked');
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. checkGuildReputationSum STAYS EXACT across establish and teardown (no new RP term)
// ════════════════════════════════════════════════════════════════════════════════════════════

test('checkGuildReputationSum holds across establish and teardown of a dockyard', () => {
  const founded = playerFounded();
  const sumRule = (state) => checkInvariants(state, state.tick)
    .filter((f) => /guild-reputation-is-the-venture-sum/.test(f.rule));
  assert.deepEqual(sumRule(founded), [], 'the sum holds at founding');
  const seated = applyAction(founded, dockyardAction());
  assert.deepEqual(sumRule(seated), [], 'the sum holds with the +900 bump on the venture and the total');
  const torn = applyAction(seated, createDecommissionVentureAction({ guildId: 'player-guild', ventureId: 'yard1' }));
  assert.deepEqual(sumRule(torn), [], 'the sum holds after the forfeit');
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE TUNING INVARIANT — deuterium mine (+1000) > dockyard (+400) > tier-3 best (+300)
// ════════════════════════════════════════════════════════════════════════════════════════════

// A single-venture guild holding NO systems (systemPoints 0), so guildPoints equals exactly the
// venture's own GP contribution — the size the venture adds to its guild's bar.
function ventureGpContribution(venture) {
  // A bare state: guildPoints reads only `state.claims` (none here → 0 held systems) and the
  // guild's own ventures, so this isolates the one venture's GP with no system term.
  const guild = { id: 'g', ventures: [{ ...venture, ownerGuildId: 'g' }] };
  const state = { claims: [], guilds: [guild] };
  return guildPoints(state, guild);
}
// The net standing benefit of deploying a venture: the RP it is minted with, minus the bar its
// GP raises (MEANLINE_K = 1, so +1 GP = +1 expected RP). This is the quantity the tuning
// invariant orders — not the lone bump, not the lone GP.
function netBenefit(venture) {
  return signingBump(venture) - ventureGpContribution(venture);
}

test('net-benefit ordering: deuterium mine (+1000) > dockyard (+400) > tier-3 at 100% commit (+300)', () => {
  const deuteriumMine = {
    id: 'dm', ownerGuildId: 'g', type: 'mining', resourceType: 'deuterium',
    deuteriumLicence: { signedTick: 0 }, productionRate: 5,
  };
  const dockyard = { id: 'yd', ownerGuildId: 'g', type: 'refining', dockyard: true, buildQueue: [] };
  const tier3FullCommit = {
    id: 't3', ownerGuildId: 'g', type: 'refining', recipeId: 'cargo_handling_system',
    productionRate: 2, licence: { committedOutputPct: 1, signedTick: 0, windowDays: 7 },
  };

  // The three nets, each proved to its ruled value.
  assert.equal(netBenefit(deuteriumMine), 1000, 'deuterium: 1000 RP − 0 GP (special-skipped) = +1000');
  assert.equal(netBenefit(dockyard), 400, 'dockyard: 900 RP − 500 GP = +400');
  assert.equal(netBenefit(tier3FullCommit), 300, 'tier-3 at 100% commit: 600 RP (2·1·300) − 300 GP = +300');

  // The ordering the numbers must satisfy (docs/build-yard.md §5, docs/phase-1-tuning.md).
  assert.ok(netBenefit(deuteriumMine) > netBenefit(dockyard), 'deuterium mine out-nets the dockyard');
  assert.ok(netBenefit(dockyard) > netBenefit(tier3FullCommit), 'the dockyard out-nets the best Tier-1/2/3 venture');
});
