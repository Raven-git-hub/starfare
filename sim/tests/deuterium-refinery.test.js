'use strict';

// deuterium-refinery.test.js — the illegal path's OUTPUT half, slice 1b
// (docs/fuel-supply-and-allocation.md §1.4 "The illegal path, made concrete", engine only).
//
// Slice 1a gave the unlicensed mine a guild-wide raw store (`guild.deuterium`). This slice
// adds the other half:
//   - the ILLEGAL REFINERY (`establishDeuteriumRefinery`) — a factory venture on a settlement
//     slot, guild-wide, inherently illegal (no licence, zero GP, zero RP);
//   - the CONVERSION — a dedicated guild-wide step in the tick that mints raw `guild.deuterium`
//     1:1 into contraband `guild.deuteriumFuel` (a fuel, recorded in `totalProduced`);
//   - LEGAL-FIRST route burn — `burnFuel` spends `fuelHoard` first, `deuteriumFuel` second,
//     and the SELL/BUY sufficiency gates count the combined total.
// The seam is the whole slice: a stockpile good is destroyed and fuel is created in one step,
// so invariant 1 must count contraband as held fuel.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { guildTotals } = require('../stock.js');
const { guildPoints, TIER_WEIGHT } = require('../points.js');
const { burnFuel, routeFuelCost } = require('../fuel.js');
const { isIllegalDeuteriumRefinery } = require('../baseline.js');
const {
  validateAction, applyAction,
  createFoundGuildAction, createEstablishDeuteriumRefineryAction,
  createLicenseDeuteriumMineAction, createBuyFromSyndicateAction,
} = require('../actions.js');
const { HOME_SYSTEM, HOME_MINE, HOME_SLOT } = require('./home-anchor.js');
const { farthestSystem, starterHomeAtDistance } = require('./waystation-fixtures.js');

const W_T1 = TIER_WEIGHT[1];
const RATE = 5;

// A factory the founding gift mints (sim/assets.js's `asset_<guild>_<kind>_NN` scheme), and a
// miner, for the wrong-kind refusal.
const F1 = 'asset_player-guild_factory_01';
const MINER1 = 'asset_player-guild_miner_01';

// ── helpers for the direct-build (conversion) tests ────────────────────────────────────────
// A guild with an illegal refinery (and optional raw store / extra ventures), built through
// createState so the venture is normalised exactly as the game builds it. The refinery is
// unseated (no siteId/assetId) — legal for a directly-built venture — so the occupancy
// invariants skip it and the conversion step is what these tests isolate.
function refineryState({ deuterium = 0, refineries = [{ id: 'r1', rate: RATE }], ventures = [] } = {}) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, deuterium,
      ventures: [
        ...refineries.map((r) => ({
          id: r.id, ownerGuildId: 'g1', type: 'refining', systemId: 'sysA',
          deuteriumRefinery: true, productionRate: r.rate,
        })),
        ...ventures,
      ],
    }],
    reserve: { reserveLevel: 100 },
    syndicate: { ledger: 0 },
  });
}

// ── helpers for the burn integration tests (a real seed, mirroring fuel-burn.test.js) ───────
const NEAR_HOME = starterHomeAtDistance(6);
const NEAR = NEAR_HOME.id;
const FAR = farthestSystem().id;
const BURN_FAR = routeFuelCost(FAR).fuelBurn;
const GOOD = 'titanium';

const claim = (systemId, i) => ({
  claimId: i === 0 ? 'claim_home_g1' : `claim_g1_${systemId}`,
  ownerGuildId: 'g1', landmarkId: systemId, landmarkKind: 'system',
  claimedAtTick: 0, contested: false,
});

// A guild homed on NEAR, holding NEAR and FAR, with the two fuel stores set independently so a
// test can put a burn across the legal/contraband boundary.
function burnState({ fuelHoard = 0, deuteriumFuel = 0, credits = 100000 } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits, fuelHoard, deuteriumFuel,
      homeSystemId: NEAR, homePlanetId: NEAR_HOME.homePlanet,
    }],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -credits },
    claims: [claim(NEAR, 0), claim(FAR, 1)],
  });
  s.prices[GOOD].posted = 10;
  return s;
}

const buy = (qty, dest) => createBuyFromSyndicateAction({ guildId: 'g1', good: GOOD, qty, destinationSystemId: dest });

// Invariant 1 restated by hand, INCLUDING contraband — so a failure names the term. This is
// the slice's whole point: `deuteriumFuel` is held fuel and belongs on the LHS.
function assertFuelBalances(state, where) {
  const held = state.guilds.reduce((sum, g) => sum + g.fuelHoard + (g.deuteriumFuel || 0), 0);
  const inTransit = (state.shipments || []).reduce((sum, sh) => sum + ((sh.cargo && sh.cargo.fuel) || 0), 0);
  const lhs = held + state.reserve.reserveLevel + inTransit;
  const rhs = state.audit.totalProduced - state.audit.totalConsumed;
  assert.equal(lhs, rhs, `${where}: held ${held} + reserve ${state.reserve.reserveLevel} + inTransit ${inTransit} = ${lhs} != produced-consumed ${rhs}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE DEPLOY ACTION
// ════════════════════════════════════════════════════════════════════════════════════════════

function playerFounded() {
  const s = createZeroState();
  return advance(s, [createFoundGuildAction({ guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: HOME_SYSTEM })]).state;
}
const refineryAction = (over = {}) => createEstablishDeuteriumRefineryAction({
  guildId: 'player-guild', ventureId: 'ref1', siteId: HOME_SLOT, assetId: F1, productionRate: RATE, ...over,
});

test('createEstablishDeuteriumRefineryAction requires guild/venture/site/asset/rate, and carries no recipe', () => {
  assert.throws(() => createEstablishDeuteriumRefineryAction({ ventureId: 'r', siteId: 's', assetId: 'a', productionRate: 5 }), /guildId is required/);
  assert.throws(() => createEstablishDeuteriumRefineryAction({ guildId: 'g', siteId: 's', assetId: 'a', productionRate: 5 }), /ventureId is required/);
  assert.throws(() => createEstablishDeuteriumRefineryAction({ guildId: 'g', ventureId: 'r', assetId: 'a', productionRate: 5 }), /siteId is required/);
  assert.throws(() => createEstablishDeuteriumRefineryAction({ guildId: 'g', ventureId: 'r', siteId: 's', productionRate: 5 }), /assetId is required/);
  assert.throws(() => createEstablishDeuteriumRefineryAction({ guildId: 'g', ventureId: 'r', siteId: 's', assetId: 'a' }), /productionRate is required/);
  // A refinery has no recipe — the conversion is fixed 1:1, not a recipe.
  assert.deepEqual(
    createEstablishDeuteriumRefineryAction({ guildId: 'g', ventureId: 'r', siteId: 's', assetId: 'a', productionRate: 5 }),
    { type: 'establishDeuteriumRefinery', guildId: 'g', ventureId: 'r', siteId: 's', assetId: 'a', productionRate: 5 },
  );
});

test('deploy: a factory on a settlement slot the guild holds is accepted', () => {
  assert.deepEqual(validateAction(playerFounded(), refineryAction()), { valid: true });
});

test('deploy: refused on a resource node (a refinery is a factory on a settlement slot)', () => {
  const r = validateAction(playerFounded(), refineryAction({ siteId: HOME_MINE }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /not a settlement slot/);
});

test('deploy: refused when the named asset is a MINER, not a factory', () => {
  const r = validateAction(playerFounded(), refineryAction({ assetId: MINER1 }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /needs a factory/);
});

test('deploy: refused in a system the guild does not hold', () => {
  // A settlement slot on a planet in a system the founded guild does not hold.
  const r = validateAction(playerFounded(), refineryAction({ siteId: 'pl_09999_s01' }));
  assert.equal(r.valid, false);
  assert.match(r.reason, /does not exist|does not hold/);
});

test('deploy apply: seats a refinery marked deuteriumRefinery, with no recipe and no resourceType', () => {
  const next = applyAction(playerFounded(), refineryAction());
  const v = next.guilds[0].ventures.find((x) => x.id === 'ref1');
  assert.equal(v.deuteriumRefinery, true);
  assert.equal(isIllegalDeuteriumRefinery(v), true);
  assert.equal(v.type, 'refining');       // a factory venture — so it occupies a factory asset
  assert.equal(v.recipeId, null);         // NOT a recipe path
  assert.equal(v.resourceType, null);     // and not a mine
  assert.equal(v.assetId, F1);            // occupies the named factory
  assert.equal(v.siteId, HOME_SLOT);
  // No licence, no equity, and it produces no identifiable good, so GP is unchanged by it.
  assert.equal(v.deuteriumLicence, undefined);
  assert.equal(v.licence, undefined);
  // All invariants hold on the seated state (between-tick, as POST /action asserts).
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE CONVERSION (the goods→fuel seam)
// ════════════════════════════════════════════════════════════════════════════════════════════

test('one tick: a refinery moves min(raw, rate) from guild.deuterium to guild.deuteriumFuel, 1:1', () => {
  const s = refineryState({ deuterium: 12, refineries: [{ id: 'r1', rate: RATE }] });
  const next = tick(s);
  assert.equal(next.guilds[0].deuterium, 12 - RATE, 'raw drawn down by the rate');
  assert.equal(next.guilds[0].deuteriumFuel, RATE, 'contraband up by exactly what was converted');
  // THE MINT: totalProduced rises by exactly `converted` — the honest fuel-genesis record.
  assert.equal(next.audit.totalProduced - s.audit.totalProduced, RATE);
  // Nothing consumed, no per-system stockpile touched.
  assert.equal(next.audit.totalConsumed, s.audit.totalConsumed);
  assert.deepEqual(next.guilds[0].stockpiles || {}, {});
  // The refinery ran, so its tick is stamped (§15.2).
  assert.equal(next.guilds[0].ventures[0].updatedAtTick, 0);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after one refine');
});

test('a refinery converts only what raw is there (raw < rate), draining the store to zero', () => {
  const s = refineryState({ deuterium: 3, refineries: [{ id: 'r1', rate: RATE }] });
  const next = tick(s);
  assert.equal(next.guilds[0].deuterium, 0);
  assert.equal(next.guilds[0].deuteriumFuel, 3);
  assert.equal(next.audit.totalProduced - s.audit.totalProduced, 3);
});

test('a refinery with no raw converts nothing — no contraband key, no negative, no throw', () => {
  const s = refineryState({ deuterium: 0 });
  const next = tick(s);
  assert.equal(next.guilds[0].deuterium, undefined, 'no raw key minted');
  assert.equal(next.guilds[0].deuteriumFuel, undefined, 'and no contraband key minted');
  assert.equal(next.audit.totalProduced, s.audit.totalProduced, 'nothing minted');
  // A refinery that did not run is not stamped (matches the mine/refinery discipline).
  assert.equal(next.guilds[0].ventures[0].updatedAtTick, null);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('multiple refineries share the ONE guild pool, drawn in sequence, and never over-draw it', () => {
  // raw 8, two refineries rate 5 each: the first takes 5 (raw → 3), the second takes min(3,5)=3
  // (raw → 0). Total converted 8, never negative.
  const s = refineryState({ deuterium: 8, refineries: [{ id: 'r1', rate: 5 }, { id: 'r2', rate: 5 }] });
  const next = tick(s);
  assert.equal(next.guilds[0].deuterium, 0, 'the shared pool empties, not below zero');
  assert.equal(next.guilds[0].deuteriumFuel, 8, 'both refineries together converted exactly the pool');
  assert.equal(next.audit.totalProduced - s.audit.totalProduced, 8);
  assert.deepEqual(checkInvariants(next, next.tick), []);
});

test('raw with NO refinery stays put (1a regression) — nothing converts it', () => {
  const s = refineryState({ deuterium: 20, refineries: [] });
  const next = tick(s);
  assert.equal(next.guilds[0].deuterium, 20, 'raw is untouched with no refinery');
  assert.equal(next.guilds[0].deuteriumFuel, undefined);
  assert.equal(next.audit.totalProduced, s.audit.totalProduced);
});

test('mine → refine pipeline: an unlicensed mine feeds the refinery, invariant 1 holds every tick', () => {
  // A guild with BOTH an unlicensed deuterium mine (rate 5) and a refinery (rate 5). The
  // conversion runs AFTER the per-system mining in the same tick (so it sees this tick's raw),
  // and the refinery's rate matches the mine's, so all 5 mined units are refined the same tick —
  // no buffer accumulates. Contraband climbs by 5 each tick; raw stays at 0.
  const s = refineryState({
    deuterium: 0,
    refineries: [{ id: 'r1', rate: 5 }],
    ventures: [{ id: 'm1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: 5 }],
  });
  let cur = s;
  for (let i = 1; i <= 10; i += 1) {
    cur = tick(cur);
    assert.deepEqual(checkInvariants(cur, cur.tick), [], `invariants after tick ${i}`);
    assertFuelBalances(cur, `after tick ${i}`);
  }
  const g = cur.guilds[0];
  assert.equal((g.deuterium || 0) + g.deuteriumFuel, 10 * 5, 'every mined unit is either raw or refined');
  assert.equal(g.deuteriumFuel, 10 * 5, 'rate matches the mine, so all mined raw is refined the same tick');
  assert.equal(g.deuterium || 0, 0, 'no raw buffer accumulates');
});

test('the conversion never reaches the fuel POOL or the goods stockpile row', () => {
  // Contraband is held by the guild, not minted into the shared reserve, and raw leaves the
  // goods cache — the crossing is entirely guild-wide.
  const s = refineryState({ deuterium: 10 });
  const next = tick(s);
  assert.equal(next.reserve.reserveLevel, s.reserve.reserveLevel, 'the shared pool is untouched');
  assert.equal(guildTotals(next.guilds[0]).deuterium, undefined, 'no per-system deuterium stockpile');
  assert.equal(next.galacticSupply.resources.deuterium, next.guilds[0].deuterium, 'the goods row tracks the raw store');
  assert.equal(next.galacticSupply.fuel.guildHeld, next.guilds[0].deuteriumFuel, 'contraband counts as held fuel');
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. LEGAL-FIRST BURN
// ════════════════════════════════════════════════════════════════════════════════════════════

test('burnFuel spends fuelHoard FIRST, dipping into contraband only for the remainder', () => {
  const g = { fuelHoard: 100, deuteriumFuel: 50 };
  assert.equal(burnFuel(g, 30), 30, 'returns the amount burned');
  assert.equal(g.fuelHoard, 70, 'legal fuel drained first');
  assert.equal(g.deuteriumFuel, 50, 'contraband untouched while legal fuel covers the burn');
});

test('burnFuel dips into contraband exactly for the shortfall', () => {
  const g = { fuelHoard: 100, deuteriumFuel: 50 };
  burnFuel(g, 120);
  assert.equal(g.fuelHoard, 0, 'legal fuel spent to the last drop');
  assert.equal(g.deuteriumFuel, 30, 'and only the 20-unit remainder came from the red');
});

test('burnFuel: a guild with only contraband burns the contraband', () => {
  const g = { fuelHoard: 0, deuteriumFuel: 50 };
  burnFuel(g, 40);
  assert.equal(g.fuelHoard, 0);
  assert.equal(g.deuteriumFuel, 10);
});

test('burnFuel: with no contraband, an all-legal burn never mints a deuteriumFuel key', () => {
  const g = { fuelHoard: 100 };
  burnFuel(g, 100);
  assert.equal(g.fuelHoard, 0);
  assert.equal(g.deuteriumFuel, undefined, 'no contraband key created for a pure-legal burn');
});

test('a real BUY drains legal fuel first, leaving contraband whole when the hoard covers it', () => {
  const s = burnState({ fuelHoard: 500, deuteriumFuel: 100 });
  const next = applyAction(s, buy(5, FAR));
  assert.equal(next.guilds[0].fuelHoard, 500 - BURN_FAR, 'legal fuel took the whole burn');
  assert.equal(next.guilds[0].deuteriumFuel, 100, 'contraband is sticky — untouched');
  assert.equal(next.audit.totalConsumed, BURN_FAR);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a legal-covered BUY');
});

test('a guild with ONLY contraband can still fly — the burn comes out of the red', () => {
  const s = burnState({ fuelHoard: 0, deuteriumFuel: 500 });
  const { valid } = validateAction(s, buy(5, FAR));
  assert.equal(valid, true, 'combined availability lets it fly');
  const next = applyAction(s, buy(5, FAR));
  assert.equal(next.guilds[0].fuelHoard, 0);
  assert.equal(next.guilds[0].deuteriumFuel, 500 - BURN_FAR, 'contraband paid the burn');
  assert.equal(next.audit.totalConsumed, BURN_FAR);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a contraband-only BUY');
});

test('the sufficiency gate counts the COMBINED total — legal + contraband', () => {
  // Neither store alone covers BURN_FAR, but together they exactly do.
  const legal = Math.floor(BURN_FAR / 2);
  const contraband = BURN_FAR - legal;
  const s = burnState({ fuelHoard: legal, deuteriumFuel: contraband });
  assert.equal(validateAction(s, buy(5, FAR)).valid, true, 'combined == burn is enough');
  const next = applyAction(s, buy(5, FAR));
  assert.equal(next.guilds[0].fuelHoard, 0, 'legal spent first, to zero');
  assert.equal(next.guilds[0].deuteriumFuel, 0, 'then contraband for the rest, to zero');
  assert.deepEqual(checkInvariants(next, next.tick), []);
  assertFuelBalances(next, 'after a combined burn');
});

test('a burn exceeding BOTH stores is refused reject-whole, and changes nothing', () => {
  const s = burnState({ fuelHoard: 1, deuteriumFuel: BURN_FAR - 2 }); // combined = BURN_FAR - 1
  const before = hashState(s);
  const { valid, reason } = validateAction(s, buy(5, FAR));
  assert.equal(valid, false);
  assert.match(reason, new RegExp(`need ${BURN_FAR}, have ${BURN_FAR - 1}`));
  assert.match(reason, /legal \+ contraband/);
  assert.equal(hashState(s), before, 'validation is pure — a refusal leaves state byte-identical');
});

test('the fuel gate still runs LAST — a trade short on credits AND fuel blames credits', () => {
  const s = burnState({ credits: 1, fuelHoard: 0, deuteriumFuel: 0 });
  const { reason } = validateAction(s, buy(5, FAR));
  assert.match(reason, /cannot pay/, 'credits is blamed');
  assert.doesNotMatch(reason, /insufficient fuel/, 'not fuel');
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. ZERO GP / ZERO RP for the refinery
// ════════════════════════════════════════════════════════════════════════════════════════════

test('GP: an illegal refinery adds ZERO — only the non-deuterium mine and systems count', () => {
  // A titanium mine (W_T1) + a refinery. The refinery adds nothing, so GP is the mine alone.
  const s = refineryState({
    deuterium: 0,
    refineries: [{ id: 'r1', rate: RATE }],
    ventures: [{ id: 'mt', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'titanium', productionRate: RATE }],
  });
  assert.equal(guildPoints(s, s.guilds[0]), W_T1, 'the refinery contributes 0 GP; only the titanium mine scores');
});

test('RP: an illegal refinery earns ZERO RP across a multi-cycle run (idle to the Syndicate)', () => {
  // A small window so many boundaries are crossed. The refinery has no licence, so no windowed
  // met/breach, no signing bump, and no deuterium-mine MET reaches it — no RP key is ever minted.
  let s = createState({
    windowN: 4,
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, deuterium: 1000,
      ventures: [{ id: 'r1', ownerGuildId: 'g1', type: 'refining', systemId: 'sysA', deuteriumRefinery: true, productionRate: RATE }],
    }],
    reserve: { reserveLevel: 1000 },
    syndicate: { ledger: 0 },
  });
  for (let i = 0; i < 5 * 4; i += 1) s = tick(s);
  assert.equal(s.guilds[0].ventures[0].reputation, undefined, 'no RP key ever minted');
  assert.equal(s.guilds[0].guildReputation, 0, 'the guild RP total stays zero');
  assert.equal(guildPoints(s, s.guilds[0]), 0, 'and GP stays zero — neither size nor standing');
  // It really did refine the whole time (so the zero-RP result is over a working refinery).
  assert.equal(s.guilds[0].deuteriumFuel, 5 * 4 * RATE);
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. INVARIANT 1 end to end, non-negativity coverage, determinism
// ════════════════════════════════════════════════════════════════════════════════════════════

test('mine → refine → burn: invariant 1 holds after the refine AND after the burn', () => {
  // One scenario on a real seed: a guild with an unlicensed deuterium mine + a refinery, homed
  // where it can fly a BUY. Tick once (mine deposits raw, refinery mints contraband), then BUY
  // (burn spends legal-first). checkFuelConservation is inside checkInvariants; assert it at
  // both crossings.
  // Mine + refinery rates comfortably above BURN_FAR, so one tick mints enough contraband to
  // cover a far burn that starts with only 3 legal fuel — the burn then crosses the
  // legal→contraband boundary, which is the point of the test.
  const bigRate = BURN_FAR + 20;
  const s = createState({
    guilds: [{
      id: 'g1', credits: 100000, fuelHoard: 3, deuterium: 0,
      homeSystemId: NEAR, homePlanetId: NEAR_HOME.homePlanet,
      ventures: [
        { id: 'm1', ownerGuildId: 'g1', type: 'mining', systemId: NEAR, resourceType: 'deuterium', productionRate: bigRate },
        { id: 'r1', ownerGuildId: 'g1', type: 'refining', systemId: NEAR, deuteriumRefinery: true, productionRate: bigRate },
      ],
    }],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -100000 },
    claims: [claim(NEAR, 0), claim(FAR, 1)],
  });
  s.prices[GOOD].posted = 10;

  const refined = tick(s);
  assert.equal(refined.guilds[0].deuteriumFuel, bigRate, 'the mined raw was refined to contraband');
  assert.deepEqual(checkInvariants(refined, refined.tick), [], 'invariant 1 (and all) hold after the refine');
  assertFuelBalances(refined, 'after the refine');

  // Now burn a far route. fuelHoard is 3; BURN_FAR is larger, so it dips into the fresh
  // contraband — a legal-first burn across the boundary. Validate first, as the server does.
  assert.equal(validateAction(refined, buy(5, FAR)).valid, true, 'combined fuel covers the burn');
  const burned = applyAction(refined, buy(5, FAR));
  const g = burned.guilds[0];
  assert.equal(g.fuelHoard, 0, 'the 3 legal fuel went first');
  assert.equal(g.deuteriumFuel, bigRate - (BURN_FAR - 3), 'contraband covered the remainder');
  assert.deepEqual(checkInvariants(burned, burned.tick), [], 'invariant 1 (and all) hold after the burn');
  assertFuelBalances(burned, 'after the burn');
});

test('the non-negativity/integrality sweep COVERS the contraband store', () => {
  const negative = refineryState({ deuterium: 0 });
  negative.guilds[0].deuteriumFuel = -1;
  assert.ok(checkInvariants(negative, 0).some((v) => v.rule.startsWith('non-negativity')), 'a negative store trips invariant 3');

  const fractional = refineryState({ deuterium: 0 });
  fractional.guilds[0].deuteriumFuel = 2.5;
  assert.ok(checkInvariants(fractional, 0).some((v) => v.rule.startsWith('integer')), 'a fractional store trips §15.2');
});

test('a mine → refine run is deterministic (byte-identical run twice)', () => {
  const build = () => {
    let s = refineryState({
      deuterium: 0,
      refineries: [{ id: 'r1', rate: 5 }],
      ventures: [{ id: 'm1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: 5 }],
    });
    for (let i = 0; i < 10; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

// A licensed deuterium MINE is not a refinery, and vice versa — the two illegal-path halves are
// distinct ventures (a mine carries no deuteriumRefinery, a refinery carries no deuteriumLicence).
test('the refinery predicate does not catch a deuterium mine (the two halves are distinct)', () => {
  const s = applyAction(
    refineryState({
      deuterium: 0, refineries: [],
      ventures: [{ id: 'm1', ownerGuildId: 'g1', type: 'mining', systemId: 'sysA', resourceType: 'deuterium', productionRate: 5 }],
    }),
    createLicenseDeuteriumMineAction({ guildId: 'g1', ventureId: 'm1' }),
  );
  assert.equal(isIllegalDeuteriumRefinery(s.guilds[0].ventures[0]), false, 'a licensed mine is not a refinery');
});
