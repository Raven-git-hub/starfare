'use strict';

// factory-commitment.test.js — the factory-commitment slice (28-08-26): a FACTORY is a
// committing producer of its output good, exactly as a mine is of the good it digs
// (design.md §5 "The Syndicate commitment is a per-good windowed accrual" + "LICENCE FEE
// MECHANICS — RULED", the factory-commitment ruling; build note docs/licence-fee.md).
//
// The seam this file exists to pin is ONE line of arithmetic in two places:
//   - the §5 commitment target is summed over the good's PRODUCERS, keyed on
//     `producedGoodFor` (sim/baseline.js) — a mine's `resourceType`, a factory's recipe
//     OUTPUT — instead of over ventures with a `resourceType`;
//   - the Syndicate fork's FRESH-ONLY cap for a refined good is its factories' `minted`,
//     read in the finalize pass because minting depends on the input allocations the
//     routing pass produces.
//
// ── THE CASCADE IS THE RULING, NOT A BUG ──────────────────────────────────────────
// Because that cap reads the REAL minted number, a guild that commits its titanium to
// the Syndicate and thereby starves its own alloy factory delivers less alloy, breaches,
// and pays the FULL fee. That is intended pressure — bad supply-chain management has a
// price — and the test "the CASCADE" below is that ruling made mechanical, with the
// counterfactual beside it so it cannot pass for another reason. There is deliberately
// NO double-commit prevention, NO starvation grace and NO input reservation. A future
// reader must not "fix" this; deleting the cascade test is deleting the ruling.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction,
  createSetSyndicateCommitmentAction,
} = require('../actions.js');
const { resolveProduction } = require('../production.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { BASE_PRICE } = require('../prices.js');
const { getRecipe } = require('../recipes.js');
const { REFINERY_BASELINE, MINE_BASELINE, producedGoodFor } = require('../baseline.js');
const { FEE_RATE } = require('../licence.js');

const SYS = 'sysA';
const OUT = 'titanium_alloy';                 // the recipe: 3 titanium + 1 carbon → 1 alloy
const N = 4;                                  // a short window, so a boundary is 4 ticks away

// What a factory's droidless baseline output of its OUTPUT good is: batches/tick × the
// recipe's output qty (sim/baseline.js). Stated as arithmetic, not read off the code
// under test, so a changed baseline moves this file loudly rather than silently.
const FACTORY_UNITS = REFINERY_BASELINE[OUT] * getRecipe(OUT).output.qty;   // 5/tick
const FACTORY_Q = FACTORY_UNITS * N;                                       // 20 a window
const FACTORY_BASIC_FEE = Math.round(FEE_RATE * FACTORY_UNITS * N * BASE_PRICE);
const FACTORY_DISCOUNTED_FEE = Math.round(FACTORY_BASIC_FEE * 0.75); // commit max, no equity

const mine = (id, good, productionRate, extra = {}) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good,
  productionRate, ...extra,
});

const factory = (id, productionRate, extra = {}) => ({
  id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: OUT,
  productionRate, ...extra,
});

function fixture(ventures, { credits = 0, windowN = N } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

// A supply chain that runs the factory FLAT OUT at its baseline: 5 batches/tick needs 15
// titanium and 5 carbon, and the mines deliver exactly that. Every shortfall in this file
// is therefore something the fixture did on purpose.
const suppliedChain = (factories) => [mine('tm', 'titanium', 15), mine('cm', 'carbon_products', 5), ...factories];

const guild = (s) => s.guilds[0];
const windows = (s) => (guild(s).syndicateWindows || {})[SYS] || {};
// The report for the tick that would run NEXT from this state — the same
// `state.tick + 1` framing `previewProduction` and `applyProduction` both use, so the
// numbers read here are the ones the engine is about to move.
const preview = (s) => resolveProduction(guild(s), SYS, { tick: s.tick + 1, windowN: N });

// The REAL player path (Slice 3b-i): licensed at tick 0, so `committedFromTick` is 1 —
// the first tick of the first window — and every window judged here is full.
const licenceAll = (s, ids, committedOutputPct = 1) => intake(s, ids.map((id) =>
  createApplyForLicenceAction({ guildId: 'g1', ventureId: id, committedOutputPct, windowDays: 7 }))).state;

const runToBoundary = (s) => {
  do { s = tick(s); } while (s.tick % N !== 0);
  return s;
};

// --- 1. the commitment target is producer-general ---------------------------------

test('a committed FACTORY contributes Q under the good it PRODUCES, not its inputs', () => {
  const s = licenceAll(fixture(suppliedChain([factory('f', 5)])), ['f']);
  const v = guild(s).ventures.find((x) => x.id === 'f');
  assert.equal(producedGoodFor(v), OUT, 'the identity the target is keyed on');
  assert.equal(v.syndicateCommitment, FACTORY_Q);

  const r = preview(s);
  assert.equal(r.goods[OUT].window.Q, FACTORY_Q, 'the alloy carries the target');
  assert.deepEqual(Object.keys(r.goods[OUT].window.perVenture), ['f'],
    'and the factory has a real per-licence row, exactly as a mine would');
  assert.equal(r.goods.titanium.window, undefined,
    'its INPUT carries no commitment — a factory commits what it makes, not what it eats');
  assert.equal(r.mines.some((m) => m.ventureId === 'f'), false, 'a factory is still not a mine');
});

test('a factory with NO commitment triggers none of the new paths', () => {
  // This is the mechanism by which every existing golden stays byte-identical: an
  // uncommitted producer contributes 0, so the good is never routed, no window state is
  // ever minted, and the serialized bytes are the pre-slice ones. (The standing proof is
  // the pinned GOLDEN_UNLICENSED / GOLDEN_COMMITTED hashes in commitment-scaffold.test.js
  // and persist.test.js, which are untouched by this slice.)
  let s = fixture(suppliedChain([factory('f', 5)]));
  const twice = hashState(runToBoundary(fixture(suppliedChain([factory('f', 5)]))));
  s = runToBoundary(s);
  assert.equal(guild(s).syndicateWindows, undefined, 'no window state is created at all');
  assert.equal(preview(s).goods[OUT], undefined, 'the alloy is not even routed');
  assert.equal(guild(s).credits, 0, 'not one credit moves');
  assert.equal(hashState(s), twice, 'and the run is deterministic (invariant 9)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. the fork draws on MINTED output ------------------------------------------

test('the Syndicate fork’s fresh cap for a refined good is its factories’ MINTED output', () => {
  const s = licenceAll(fixture(suppliedChain([factory('f', 5)])), ['f']);
  const r = preview(s);                       // what the next tick will do…
  const minted = r.refineries.find((x) => x.ventureId === 'f').minted;

  assert.equal(minted, FACTORY_UNITS, 'the fully-supplied factory mints its baseline');
  assert.equal(r.goods[OUT].fresh, minted, '`fresh` for a refined good IS the minted total');
  assert.equal(r.goods[OUT].pot, minted, 'and it is part of THIS tick’s pot, like a mine’s fresh');
  assert.equal(r.goods[OUT].fork.syndicate, minted, 'which is what the fork is allowed to draw');
  assert.equal(windows(tick(s))[OUT].delivered, minted, '…and that is what it delivers');
});

test('the fork can never draw more alloy than was minted — a starved tick delivers less', () => {
  // Titanium is cut to a third, so the factory runs at 1⅔ batches/tick. The paced send
  // asks for 5; the cap hands over what actually exists.
  const s = licenceAll(fixture([
    mine('tm', 'titanium', 5), mine('cm', 'carbon_products', 5), factory('f', 5),
  ]), ['f']);
  const r = preview(s);
  const minted = r.refineries.find((x) => x.ventureId === 'f').minted;
  assert.equal(minted, 1, 'floor(5/3) batches on tick 1, the rest carried');
  assert.equal(r.goods[OUT].window.requiredRate, 5, 'the pace still asks for its 5');
  assert.equal(r.goods[OUT].fork.syndicate, minted, 'and gets only what was made');
});

test('a good may not be both mined and minted here — the fresh cap halts rather than guess', () => {
  // Hand-built and impossible in play (no node yields a processed good), which is the
  // point: if raw and processed ever stopped being disjoint the fork's one fresh cap
  // would be assembled from two unrelated sources, and a silent wrong cap is worse than
  // a crash (§15.5).
  const s = fixture([...suppliedChain([factory('f', 5, { syndicateCommitment: FACTORY_Q })]), mine('bad', OUT, 3)]);
  assert.throws(() => tick(s), /was both mined \(3\) and minted \(5\)/);
});

// --- 3. the full flow: licence → per-tick sale → boundary fee ----------------------

test('THE HEADLINE: a licensed factory sells its output every tick and MEETS at the boundary', () => {
  let s = licenceAll(fixture(suppliedChain([factory('f', 5)])), ['f']);
  const lic = guild(s).ventures.find((v) => v.id === 'f').licence;
  assert.deepEqual(
    { basicFee: lic.basicFee, discountedFee: lic.discountedFee, lockedPrice: lic.lockedPrice },
    { basicFee: FACTORY_BASIC_FEE, discountedFee: FACTORY_DISCOUNTED_FEE, lockedPrice: BASE_PRICE },
    'the fee is priced off the OUTPUT good’s posted price and the recipe baseline',
  );

  let delivered = 0;
  for (let i = 0; i < N; i += 1) {
    const before = { credits: guild(s).credits, ledger: s.syndicate.ledger };
    s = tick(s);
    const sale = guild(s).lastSyndicateSale;
    const units = sale ? sale.goods[OUT].units : 0;
    delivered += units;
    assert.ok(units > 0, `tick ${s.tick}: the factory’s output really is sold`);
    if (s.tick % N !== 0) {
      // Away from the boundary the ONLY credit movement is the sale, and invariant 2 is
      // exact: the guild's gain is the ledger's debit, to the credit.
      assert.equal(guild(s).credits - before.credits, sale.credited);
      assert.equal(before.ledger - s.syndicate.ledger, sale.credited);
      assert.equal(guild(s).credits + s.syndicate.ledger, before.credits + before.ledger);
    }
    assert.ok(Number.isInteger(guild(s).credits), 'integer credits (§15.2)');
  }

  assert.equal(delivered, FACTORY_Q, 'the paced default lands exactly on Q');
  assert.equal(windows(s)[OUT].delivered, FACTORY_Q);
  const fee = guild(s).lastLicenceFee;
  assert.equal(fee.tick, N);
  assert.deepEqual(fee.ventures.f, {
    status: 'met', owed: FACTORY_DISCOUNTED_FEE,
    basicFee: FACTORY_BASIC_FEE, discountedFee: FACTORY_DISCOUNTED_FEE,
  });
  assert.equal(fee.charged, FACTORY_DISCOUNTED_FEE);
  assert.equal(guild(s).credits + s.syndicate.ledger, 0, 'conservation holds across the boundary too');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a licensed factory that under-sends BREACHES and pays the full basic fee', () => {
  // Same licence, same supply — only the send control differs, so nothing but the
  // verdict can explain the different fee.
  let s = licenceAll(fixture(suppliedChain([factory('f', 5)])), ['f']);
  s = intake(s, [createSetProductionProfileAction({
    guildId: 'g1', systemId: SYS, goods: { [OUT]: { syndicate: { mode: 'absolute', value: 2 } } },
  })]).state;
  s = runToBoundary(s);

  assert.equal(windows(s)[OUT].delivered, 2 * N);
  assert.deepEqual(guild(s).lastLicenceFee.ventures.f, {
    status: 'breach', owed: FACTORY_BASIC_FEE,
    basicFee: FACTORY_BASIC_FEE, discountedFee: FACTORY_DISCOUNTED_FEE,
  });
  assert.ok(FACTORY_BASIC_FEE > FACTORY_DISCOUNTED_FEE, 'the two really are different numbers');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. THE CASCADE (the ruling, made mechanical) ---------------------------------

test('THE CASCADE: committing the INPUT starves the factory, which breaches and pays in full', () => {
  // Two runs, identical but for ONE thing: whether the titanium mine is also licensed.
  // The counterfactual proves the alloy licence is meetable in this fixture, so the
  // breach below can only be the starvation.
  const chain = () => suppliedChain([factory('f', 5)]);

  const fed = runToBoundary(licenceAll(fixture(chain()), ['f']));
  const starved = runToBoundary(licenceAll(fixture(chain()), ['f', 'tm']));

  // The counterfactual: alloy alone committed ⇒ the factory is fully fed and MEETS.
  assert.equal(windows(fed)[OUT].delivered, FACTORY_Q);
  assert.equal(guild(fed).lastLicenceFee.ventures.f.status, 'met');
  assert.equal(guild(fed).lastLicenceFee.ventures.f.owed, FACTORY_DISCOUNTED_FEE);

  // The cascade: the titanium the Syndicate now takes first is titanium the factory does
  // not get. Its rate drops, it mints less, the fork's fresh cap drops with it, the
  // window under-delivers, and the boundary charges the FULL fee. Nothing in the engine
  // detects or forgives this — it is the arithmetic doing what it was told.
  const mintedOf = (s0) => preview(s0).refineries.find((r) => r.ventureId === 'f').minted;
  assert.equal(mintedOf(licenceAll(fixture(chain()), ['f'])), FACTORY_UNITS);
  assert.ok(mintedOf(licenceAll(fixture(chain()), ['f', 'tm'])) < FACTORY_UNITS,
    'the starved factory really does mint less, on the very first tick');
  assert.ok(windows(starved)[OUT].delivered < FACTORY_Q, 'so the alloy window under-delivers');
  assert.equal(windows(starved)[OUT].delivered, 13, 'the exact pile this fixture produces');

  const fee = guild(starved).lastLicenceFee;
  assert.equal(fee.ventures.f.status, 'breach', 'the alloy licence breaches…');
  assert.equal(fee.ventures.f.owed, FACTORY_BASIC_FEE, '…and pays the full fee, discount voided');
  assert.equal(fee.ventures.tm.status, 'met', 'while the titanium licence it starved for is MET');
  assert.equal(fee.charged, FACTORY_BASIC_FEE + fee.ventures.tm.owed, 'the guild pays for both');

  // No double-commit prevention: the guild committed titanium AND the alloy that titanium
  // becomes, and the engine let it. That is the ruling.
  assert.equal(guild(starved).ventures.find((v) => v.id === 'tm').syndicateCommitment,
    MINE_BASELINE.titanium * N);
  assert.deepEqual(checkInvariants(starved, starved.tick), []);
});

// --- 5. several factories on one good ---------------------------------------------

test('two factories committing the same good fill in pursue order, met/breach per venture', () => {
  // Titanium is short of what two flat-out factories want (30/tick), so Gate 3's FCFS
  // default feeds the first and the second takes the remainder — exactly as two mines
  // sharing a constrained good behave.
  let s = licenceAll(fixture([
    mine('tm', 'titanium', 18), mine('cm', 'carbon_products', 10), factory('f1', 5), factory('f2', 5),
  ]), ['f1', 'f2']);
  for (let i = 0; i < N - 1; i += 1) s = tick(s);
  const w = preview(s).goods[OUT].window;     // the BOUNDARY tick's verdicts
  s = tick(s);
  assert.equal(w.Q, 2 * FACTORY_Q, 'the target is the SUM over both producers');
  assert.equal(w.perVenture.f1.status, 'met', 'the pile fills the first to its full target…');
  assert.equal(w.perVenture.f1.delivered, FACTORY_Q);
  assert.equal(w.perVenture.f2.status, 'breach', '…before the second is fed at all');
  assert.ok(w.perVenture.f2.delivered < FACTORY_Q);

  const fee = guild(s).lastLicenceFee;
  assert.equal(fee.ventures.f1.owed, FACTORY_DISCOUNTED_FEE);
  assert.equal(fee.ventures.f2.owed, FACTORY_BASIC_FEE);
  assert.equal(fee.charged, FACTORY_DISCOUNTED_FEE + FACTORY_BASIC_FEE);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the equity split reads a FACTORY too — the owner keeps (1 − o) of its sale', () => {
  // `ownerFraction` used to match producers by `resourceType`, so a committed factory
  // matched nothing, the weight summed to 0 and the owner silently kept 100% of a sale
  // its equity terms had already sold a share of. Pinned here so it cannot come back.
  const chain = (equityPct) => suppliedChain([factory('f', 5, { syndicateCommitment: FACTORY_Q, equityPct })]);
  const plain = tick(fixture(chain(0)));
  const offered = tick(fixture(chain(0.4)));

  const gross = FACTORY_UNITS * BASE_PRICE;
  assert.equal(guild(plain).credits, Math.round(gross), 'no offer ⇒ the owner keeps the lot');
  assert.equal(guild(offered).credits, Math.round(0.6 * gross), 'a 40% offer costs the owner 40%');
  assert.equal(guild(offered).credits + offered.syndicate.ledger, 0,
    'and invariant 2 is exact either way — the o share simply never leaves the ledger');
});

// --- 6. the console reads a licensed factory with no reshaping --------------------

test('the snapshot carries a licensed factory’s roster row exactly as it does a mine’s', () => {
  const s = tick(licenceAll(fixture(suppliedChain([factory('f', 5)])), ['f']));
  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, 7, 'nothing here needed a schema bump');

  // The snapshot's production block PREVIEWS the next tick, so `delivered` is the units
  // already banked in this window plus the send that preview would make.
  const w = snap.production[0].systems[0].goods[OUT].window;
  assert.equal(w.Q, FACTORY_Q);
  assert.deepEqual(w.perVenture.f, { commitment: FACTORY_Q, delivered: 2 * FACTORY_UNITS, status: 'accruing' });

  const row = snap.ventures.find((v) => v.id === 'f');
  assert.equal(row.syndicateCommitment, FACTORY_Q, 'the roster’s "licensed" flag reads true off this');
  assert.equal(row.licence.basicFee, FACTORY_BASIC_FEE);
  assert.equal(snap.guilds[0].syndicateSale.goods[OUT].units, FACTORY_UNITS,
    'and the tick’s sale is on the guild row, keyed by the refined good');
});

// --- 7. the dev scaffold, and the one deferral ------------------------------------

test('the dev scaffold commits a factory too, and it behaves as a full-window licence', () => {
  let s = intake(fixture(suppliedChain([factory('f', 5)])),
    [createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 'f', commitment: 12 })]).state;
  s = runToBoundary(s);
  assert.equal(windows(s)[OUT].delivered, 12, 'the scaffold’s target is delivered in full');
  assert.equal(guild(s).lastLicenceFee, undefined, 'and charges nothing — there is no stored licence');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('DEFERRED, PINNED: "percent" send mode on a refined good still sends nothing', () => {
  // The percent control is a % of THIS tick's fresh, resolved in the routing pass — and a
  // refined good's real fresh (its `minted`) does not exist until after it. Threading it
  // there would mean resolving one good's window in two different places depending on how
  // it is produced, so the gap is left OPEN and VISIBLE rather than guessed at: paced (the
  // default) and absolute are exact for a factory, percent intends 0 and will breach.
  // Recorded on the decision checklist (docs/roadmap.md). Delete this test only when the
  // gap is actually closed.
  let s = fixture(suppliedChain([factory('f', 5, { syndicateCommitment: FACTORY_Q })]));
  s = intake(s, [createSetProductionProfileAction({
    guildId: 'g1', systemId: SYS, goods: { [OUT]: { syndicate: { mode: 'percent', value: 100 } } },
  })]).state;
  s = runToBoundary(s);
  assert.equal(windows(s)[OUT].delivered, 0, 'the known gap — NOT the intended behaviour');
});

// --- 8. determinism (invariant 9) -------------------------------------------------

test('a committed-factory galaxy is deterministic, twice-run byte-identical', () => {
  const run = () => {
    let s = licenceAll(fixture(suppliedChain([factory('f1', 5), factory('f2', 3)])), ['f1', 'f2']);
    for (let i = 0; i < 3 * N; i += 1) s = tick(s);
    return s;
  };
  const a = run();
  const b = run();
  assert.equal(hashState(a), hashState(b));
  assert.deepEqual(checkInvariants(a, a.tick), []);

  // The minted-per-good aggregation and the fork walk stay in sorted-good order, so the
  // report a client renders is stable too.
  const goods = Object.keys(preview(a).goods);
  assert.deepEqual(goods, [...goods].sort(), 'goods are reported in sorted order');
});
