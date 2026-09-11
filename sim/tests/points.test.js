'use strict';

// points.test.js — the GP calculator (sim/points.js; docs/points-and-reputation.md §1
// and §1.0, weights in phase-1-tuning.md §"Points & Reputation").
//
// GP is a guild's SIZE: `W_SYS × held systems + Σ ventures W_TIER(tier)`. It is one half
// of a pair — slice 4's mean line will judge RP against it — so what these tests pin is
// not just the arithmetic but the four rulings §1.0 makes, each of which is a decision
// that would be invisible if it silently reversed:
//
//   1. DERIVED, never stored — no `guild.guildPoints`, nothing serialized, so the state
//      determinism goldens cannot move on GP's account.
//   2. Ventures are counted, not assets — idle inventory scores nothing, and a deployed
//      machine is never scored twice.
//   3. An EMPTY held system still counts `W_SYS` — the anti-sprawl liability.
//   4. Tier comes from `producedGoodFor`, generally — and an unweighted tier HALTS rather
//      than scoring 0.
//
// The absolute weights are `[FIRST-CUT]` and meaningless alone (slice 4's `MEANLINE_K`
// sets the scale), so the tests that matter most are about RATIOS and rulings, not about
// 12/6/8 being the right numbers.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { producedGoodFor } = require('../baseline.js');
const { RAW_RESOURCES, PROCESSED_GOODS, TIER3_GOODS, FUEL_GOOD } = require('../resources.js');
const { W_SYS, TIER_WEIGHT, tierOf, tierWeight, guildPoints } = require('../points.js');

const W_T1 = TIER_WEIGHT[1];
const W_T2 = TIER_WEIGHT[2];

const SYS_A = 'sys_0002';
const SYS_B = 'sys_0003';

const claim = (guildId, landmarkId) => ({
  claimId: `claim_${guildId}_${landmarkId}`, ownerGuildId: guildId,
  landmarkId, landmarkKind: 'system', claimedAtTick: 0, contested: false,
});

const mine = (id, { systemId = SYS_A, resourceType = 'titanium' } = {}) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType, productionRate: 5,
});
const refinery = (id, { systemId = SYS_A, recipeId = 'titanium_alloy' } = {}) => ({
  id, ownerGuildId: 'g1', type: 'refining', systemId, recipeId, productionRate: 2,
});

// A guild with the given ventures and the given HELD systems. Claims are the source of
// truth for territory (sim/claims.js), so the systems a guild "has" are the rows here —
// deliberately independent of where its ventures sit, which is what lets the tests below
// separate the two terms of the formula.
function fixture(ventures, heldSystems = [], { assets } = {}) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0, ventures,
      ...(assets ? { assets } : {}),
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: heldSystems.map((sysId) => claim('g1', sysId)),
  });
}
const gp = (s) => guildPoints(s, s.guilds[0]);

// --- 1. the ruled weights --------------------------------------------------------

test('the GP weights are the ruled [FIRST-CUT] numbers, and every one is a whole number', () => {
  // ⤳ RESCALED 01-09-26 (12 / 6 / 8 → 200 / 100 / 150), points-and-reputation.md §2.6.
  // With MEANLINE_K down to 1 these ARE the RP scale, not a bare ratio numerator.
  assert.equal(W_SYS, 200);
  assert.equal(W_T1, 100);
  assert.equal(W_T2, 150);
  // GP is an integer (§15.2 / §1.0) and it is integral BY CONSTRUCTION — an integer count
  // times an integer weight, summed, with no rounding anywhere. Nothing would round a
  // fractional weight into shape, so the wholeness of the weights is the guarantee.
  for (const [tier, w] of Object.entries(TIER_WEIGHT)) {
    assert.ok(Number.isInteger(w), `tier ${tier}'s weight must be a whole number`);
  }
  assert.ok(Number.isInteger(W_SYS));
});

test('the RATIOS are what the weights encode: systems heavy, ventures light, T2 over T1', () => {
  // These relations are the real content of the tuning row — density-beats-sprawl (§2) —
  // and the 01-09-26 rescale preserved every one of them while moving the digits.
  assert.ok(W_SYS > W_T1, 'holding a system must cost more Points than putting one mine on it');
  assert.ok(W_SYS > W_T2, '…and more than one refinery');
  assert.ok(W_T2 > W_T1, 'a refinery is a notch above the mine that feeds it');
  // The two ratios the rescale pinned deliberately (§2.6): a system stays exactly 2× a
  // tier-1 mine (the anti-sprawl bite, unchanged from 12 : 6), while the TIER spread was
  // WIDENED from 8 : 6 to the ruled 1 : 1.5 — climbing the tree is a real reward now.
  assert.equal(W_SYS / W_T1, 2, 'a held system is exactly two mines, as it was at 12 : 6');
  assert.equal(W_T2 / W_T1, 1.5, 'and the tier spread is the ruled 1 : 1.5 (was 1 : 1.33)');
});

test('the tier spread is the ruled 1 : 1.5 : 3 : 5; T3 went live in 2.1a, T4 is the deuterium-RP tier', () => {
  // §2.6 rules 100 / 150 / 300 / 500. W_T3 = 300 WENT LIVE in 2.1a: the 25 Tier-3 module goods
  // are real and producible, so a module venture scores its GP (300) instead of halting.
  // W_T4 was PULLED IN 04-09-26 (deuterium RP slice 2): a licensed deuterium mine earns RP at
  // the Tier-4 rate (sim/licence.js). It changes NO GP — tierOf('deuterium') is 1 and a
  // licensed deuterium mine is skipped in guildPoints — so no GP path reads a tier-4 weight.
  assert.deepEqual(Object.keys(TIER_WEIGHT).map(Number).sort((a, b) => a - b), [1, 2, 3, 4],
    'tiers 1, 2 and 3 (goods with recipes) plus the RP-only tier 4');
  assert.equal(TIER_WEIGHT[3], 300, 'W_T3 = 300 is now in the map (2.1a — the Tier-3 module goods are real)');
  assert.equal(TIER_WEIGHT[4], 500, 'W_T4 = 500 is in the map for the deuterium licence RP tier');
  // The spread of the four present weights is the ruled ratio 1 : 1.5 : 3 : 5.
  assert.equal(TIER_WEIGHT[3] / TIER_WEIGHT[1], 3, 'T3 is 3× T1 (the ruled 1 : 3)');
  assert.equal(TIER_WEIGHT[4] / TIER_WEIGHT[1], 5, 'T4 is 5× T1 (the ruled 1 : 5)');
});

// --- 2. tierOf: the general tier lookup ------------------------------------------

test('tierOf reads the resources vocabulary: raw -> 1, processed -> 2, module -> 3', () => {
  for (const good of RAW_RESOURCES) assert.equal(tierOf(good), 1, `${good} is Tier 1`);
  for (const good of PROCESSED_GOODS) assert.equal(tierOf(good), 2, `${good} is Tier 2`);
  // 2.1a: a Tier-3 module resolves to tier 3 (was null / halting before the catalog).
  for (const good of TIER3_GOODS) assert.equal(tierOf(good), 3, `${good} is Tier 3`);
});

test('tierOf returns null only for a good in NO tier list — fuel, nonsense', () => {
  // null is "no ruled tier weight", never a zero — the caller halts on it. Since 2.1a the
  // Tier-3 modules are weighted, so the only goods left returning null are fuel and nonsense.
  assert.equal(tierOf(FUEL_GOOD), null, 'fuel is in no stockpile list and no venture produces it');
  assert.equal(tierOf('not_a_good'), null);
  assert.equal(tierOf(null), null);
  assert.equal(tierOf(undefined), null);
});

test('every good a REAL venture can produce today has a ruled weight', () => {
  // The reachability claim behind "the halt is unreachable today": every mining resourceType
  // and every recipe output — Tier-2 refines AND (as of 2.1a) Tier-3 module manufactures —
  // resolves to a weighted tier. If a recipe is ever added whose output does not, this goes
  // red BEFORE a guild's size silently understates. Since 2.1a un-deferred W_T3, the module
  // outputs are covered by this same check with NO exception list — that is the point of the
  // un-deferral: the catalog and the score are wired together, not one ahead of the other.
  for (const good of RAW_RESOURCES) assert.ok(TIER_WEIGHT[tierOf(good)] !== undefined, good);
  const { RECIPES } = require('../recipes.js');
  for (const r of Object.values(RECIPES || {})) {
    const out = r.output.good;
    assert.ok(TIER_WEIGHT[tierOf(out)] !== undefined, `recipe output ${out} must have a ruled GP weight`);
  }
  // And explicitly: every Tier-3 module output resolves to the ruled tier-3 weight (300).
  for (const m of TIER3_GOODS) {
    assert.equal(tierOf(RECIPES[m].output.good), 3, `${m} is a Tier-3 module`);
    assert.equal(TIER_WEIGHT[tierOf(RECIPES[m].output.good)], 300, `${m} scores the ruled W_T3 = 300`);
  }
});

// --- 3. the formula ---------------------------------------------------------------

test('GP is W_SYS × held systems + Σ ventures by tier', () => {
  // Two systems, two mines and one refinery: 2×200 + 2×100 + 1×150 = 750.
  const s = fixture([mine('m1'), mine('m2', { resourceType: 'silica' }), refinery('r1')], [SYS_A, SYS_B]);
  assert.equal(gp(s), 2 * W_SYS + 2 * W_T1 + W_T2);
  assert.equal(gp(s), 750, 'stated outright, so the sum is not implied by the formula it is testing');
  assert.ok(Number.isInteger(gp(s)));
});

test('a guild holding nothing and running nothing scores exactly 0', () => {
  // §3's empty-guild guard depends on this being reachable and being a clean zero: a
  // GP of 0 is what makes `expectedRP == 0` and sends the mean line to its neutral 1.0.
  assert.equal(gp(fixture([], [])), 0);
});

test('a REFINERY outweighs a MINE — the tier really is doing work', () => {
  const oneMine = fixture([mine('m1')], [SYS_A]);
  const oneRefinery = fixture([refinery('r1')], [SYS_A]);
  assert.equal(gp(oneMine), W_SYS + W_T1);
  assert.equal(gp(oneRefinery), W_SYS + W_T2);
  assert.ok(gp(oneRefinery) > gp(oneMine), 'the higher tier scores more');
  assert.equal(gp(oneRefinery) - gp(oneMine), W_T2 - W_T1, 'and by exactly the weight difference');
});

test('RULING 3 — an EMPTY held system still counts exactly W_SYS (the anti-sprawl liability)', () => {
  const developed = fixture([mine('m1')], [SYS_A]);
  const sprawled = fixture([mine('m1')], [SYS_A, SYS_B]);   // SYS_B held, nothing in it
  assert.equal(gp(sprawled) - gp(developed), W_SYS,
    'claiming a system you put nothing in costs a full W_SYS and earns nothing back');
  // The point of the ruling, said as the model means it: territory raises the bar, and
  // only ventures earn the reputation to clear it. Sprawl is pure liability.
  assert.equal(gp(fixture([], [SYS_A, SYS_B])), 2 * W_SYS, 'two empty systems is pure GP with no producers');
});

test('systems are counted from the CLAIMS, not from where the ventures sit', () => {
  // The two terms are independent: a venture in a system the guild does not hold still
  // scores its tier, and the system does not score. `heldSystemIds` is the one predicate
  // that answers "does this guild hold this?" for every caller, so GP counts territory by
  // the same reading that gates a Syndicate delivery.
  const unheld = fixture([mine('m1', { systemId: SYS_B })], [SYS_A]);
  assert.equal(gp(unheld), W_SYS + W_T1, 'one held system, one venture — wherever the venture is');
  // A duplicate claim row on one system must not double-count: heldSystemIds dedupes.
  const s = fixture([], [SYS_A]);
  s.claims.push(claim('g1', SYS_A));
  assert.equal(gp(s), W_SYS, 'two claim rows on one system is still one system');
  // Another guild's claim is not this guild's territory.
  const other = fixture([], [SYS_A]);
  other.claims.push(claim('g2', SYS_B));
  assert.equal(gp(other), W_SYS);
});

// --- 4. ruling 2: ventures, not assets -------------------------------------------

test('RULING 2 — an IDLE asset adds nothing; only ventures score', () => {
  // §1's "deployed only, idle = 0". An idle asset is precisely one that no venture names,
  // so this falls out of counting ventures rather than needing a filter.
  const idle = [
    { id: 'asset_g1_miner_01', kind: 'miner', maintenanceCondition: 1 },
    { id: 'asset_g1_miner_02', kind: 'miner', maintenanceCondition: 1 },
    { id: 'asset_g1_factory_01', kind: 'factory', maintenanceCondition: 1 },
  ];
  const withInventory = fixture([], [SYS_A], { assets: idle });
  assert.equal(withInventory.guilds[0].assets.length, 3, 'the fixture really does hold an inventory');
  assert.equal(gp(withInventory), W_SYS, 'three idle machines score nothing at all');
});

test('RULING 2 — a DEPLOYED asset is scored ONCE, through its venture', () => {
  // The double-count this ruling exists to prevent: the venture names the asset it runs,
  // so counting assets as well as ventures would score one machine twice.
  const assets = [{ id: 'asset_g1_miner_01', kind: 'miner', maintenanceCondition: 1 }];
  const deployed = fixture(
    [{ ...mine('m1'), assetId: 'asset_g1_miner_01' }], [SYS_A], { assets },
  );
  assert.equal(deployed.guilds[0].ventures[0].assetId, 'asset_g1_miner_01', 'the venture really does run that asset');
  assert.equal(gp(deployed), W_SYS + W_T1, 'the machine scores once, as a venture — not twice');
  // And the same venture with NO asset scores identically: GP counts the operating
  // company, and the asset link is not a second source of Points.
  assert.equal(gp(fixture([mine('m1')], [SYS_A])), gp(deployed));
});

// --- 5. ruling 4: the halt ---------------------------------------------------------

test('RULING 4 — a produced good with NO ruled tier weight HALTS, naming what to fix', () => {
  // The silent-failure this refuses: scoring an unweighted tier 0 would understate the
  // guild's size, so its bar would sit below what it holds and slice 4's mean line would
  // hand it fuel it had not earned — with nothing going red anywhere.
  //
  // Since 2.1a un-deferred W_T3, raw/processed/module all resolve to a ruled weight, so the
  // halt is exercised with a good in NO tier list: `deuterium_fuel` is a real good id that is
  // in no stockpile list and no recipe outputs, and (being fuel, not raw `deuterium`) it is
  // NOT the deuterium mine `guildPoints` skips — so it reaches the guard and halts.
  const s = fixture([mine('m1')], [SYS_A]);
  s.guilds[0].ventures[0].resourceType = FUEL_GOOD;   // a real good, in no tier list
  assert.throws(() => gp(s), (err) => {
    assert.match(err.message, /no ruled GP weight/);
    assert.match(err.message, new RegExp(FUEL_GOOD), 'the message names the offending good');
    assert.match(err.message, /venture m1/, '…the venture');
    assert.match(err.message, /guild g1/, '…and the guild');
    assert.match(err.message, /phase-1-tuning/, '…and where to rule the weight');
    return true;
  });
  // Directly, too — the guard is the function's own, not the caller's. An unweighted tier
  // (null, or a tier with no entry) halts; every ruled tier passes straight through.
  assert.throws(() => tierWeight(null, {}), /no ruled GP weight/);
  assert.throws(() => tierWeight(5, {}), /no ruled GP weight/, 'a tier with no entry still halts');
  assert.equal(tierWeight(1, {}), W_T1, 'a ruled tier passes straight through');
  assert.equal(tierWeight(3, {}), TIER_WEIGHT[3], '…and tier 3 is ruled now (2.1a): 300');
});

test('a venture producing NOTHING contributes 0 — which is not the same as an unweighted tier', () => {
  // A dangling recipeId (already halted by the occupancy invariant) or a synthetic test
  // venture with no output is BROKEN or EMPTY, not a tier the model has failed to rule.
  // Scoring it 0 is the honest reading: it produces nothing, so it is not a producer.
  const dangling = fixture([{ id: 'x', ownerGuildId: 'g1', type: 'refining', systemId: SYS_A, recipeId: 'no_such_recipe', productionRate: 1 }], [SYS_A]);
  assert.equal(producedGoodFor(dangling.guilds[0].ventures[0]), null, 'it really does produce nothing');
  assert.equal(gp(dangling), W_SYS, 'so it scores nothing, and does NOT halt');

  const empty = fixture([{ id: 'y', ownerGuildId: 'g1', type: 'mining', systemId: SYS_A, productionRate: 0 }], [SYS_A]);
  assert.equal(gp(empty), W_SYS);
});

// --- 6. ruling 1: derived, never stored -------------------------------------------

test('RULING 1 — GP is stored NOWHERE: no field, no serialized byte', () => {
  let s = fixture([mine('m1'), refinery('r1')], [SYS_A, SYS_B]);
  assert.ok(gp(s) > 0, 'the guild really does have Points to store, if anything stored them');

  assert.equal(s.guilds[0].guildPoints, undefined, 'there is no guild.guildPoints field');
  assert.equal(canonicalStringify(s).includes('guildPoints'), false,
    'and the string "guildPoints" appears nowhere in serialized state');

  // Ticking does not mint it either — no step writes GP.
  for (let i = 0; i < 3; i += 1) s = tick(s);
  assert.equal(s.guilds[0].guildPoints, undefined);
  assert.equal(canonicalStringify(s).includes('guildPoints'), false);
});

test('RULING 1 — computing GP is PURE: it moves not one byte of state', () => {
  const s = fixture([mine('m1'), refinery('r1')], [SYS_A, SYS_B]);
  const before = hashState(s);
  guildPoints(s, s.guilds[0]);
  guildPoints(s, s.guilds[0]);
  buildSnapshot(s);
  assert.equal(hashState(s), before, 'reading a derived figure mutates nothing');
});

test('RULING 1 — GP tracks holdings LIVE, which is why it need not be stored', () => {
  // The positive case for deriving: a stored copy would have to be kept in step with
  // every claim and every venture. Derived, it simply cannot fall out of step.
  const s = fixture([mine('m1')], [SYS_A]);
  assert.equal(gp(s), W_SYS + W_T1);

  s.guilds[0].ventures.push(refinery('r1'));
  assert.equal(gp(s), W_SYS + W_T1 + W_T2, 'a new venture is counted the moment it exists');

  s.claims.push(claim('g1', SYS_B));
  assert.equal(gp(s), 2 * W_SYS + W_T1 + W_T2, 'and a new claim the moment it is made');

  s.guilds[0].ventures.shift();
  assert.equal(gp(s), 2 * W_SYS + W_T2, 'and a venture leaving possession stops counting');
});

// --- 7. the snapshot surface ------------------------------------------------------

test('the snapshot publishes guildPoints, from the engine helper, per guild', () => {
  const s = fixture([mine('m1'), refinery('r1')], [SYS_A, SYS_B]);
  const snap = buildSnapshot(s);
  const g = snap.guilds.find((x) => x.id === 'g1');
  assert.equal(g.guildPoints, gp(s));
  assert.equal(g.guildPoints, 2 * W_SYS + W_T1 + W_T2);
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
});

test('the snapshot reports 0 for a guild that holds and runs nothing', () => {
  const snap = buildSnapshot(fixture([], []));
  assert.equal(snap.guilds[0].guildPoints, 0, 'a number, never an absence');
});

test('GP and RP are published side by side, and are different numbers', () => {
  // They are one pair (§0: size vs contribution) and slice 4 reads one against the other,
  // so the surface must carry both — and must not confuse them.
  const s = fixture([mine('m1')], [SYS_A]);
  s.guilds[0].ventures[0].reputation = 250;
  s.guilds[0].guildReputation = 250;
  const g = buildSnapshot(s).guilds[0];
  assert.equal(g.guildPoints, W_SYS + W_T1);
  assert.equal(g.guildReputation, 250);
  assert.notEqual(g.guildPoints, g.guildReputation);
});
