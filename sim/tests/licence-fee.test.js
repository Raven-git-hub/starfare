'use strict';

// licence-fee.test.js — licence Slice 3b-i: the licence entity + the fee math
// (design.md §5 "LICENCE FEE MECHANICS — RULED" and its four-corner grid;
// docs/licence-and-price-system.md Part 4's 3b-i bullet; build note docs/licence-fee.md).
//
// The mechanical tripwires: the grid's four corners are exact, the `o^k` shaping bites
// in the interior, a licence grants and LOCKS its terms at the posted price at signing,
// the terms it sets are what switches 3a's commitment sale on — and NOTHING IS CHARGED.
// That last one is the whole point of splitting 3b: this slice must be a provable no-op
// on credits beyond the sale it enables.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { advance } = require('../run.js');
const {
  intake, createApplyForLicenceAction, createSetWindowNAction, createEstablishVentureAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { BASE_PRICE, PRICED_GOODS } = require('../prices.js');
const { MINE_BASELINE, REFINERY_BASELINE, baselineUnitsForGood } = require('../baseline.js');
const { getRecipe } = require('../recipes.js');
const {
  EQUITY_CEILING, FEE_RATE, EQUITY_SHAPE_K, COMMITMENT_FLOOR,
  WINDOW_DAYS_MIN, WINDOW_DAYS_MAX,
  feeFraction, licenceFee, commitmentUnitsFor, isValidCommitmentPct, isValidWindowDays,
} = require('../licence.js');

const SYS = 'sysA';
const N = 24; // the engine-wide window these fixtures run on

const mine = (id, good, rate, equityPct = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good,
  productionRate: rate, equityPct,
});

const factory = (id, recipeId, rate, equityPct = 0) => ({
  id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId,
  productionRate: rate, equityPct,
});

function sysState(ventures, { windowN = N, credits = 0, ledger = 0 } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger },
    windowN,
  });
}

const guild = (s) => s.guilds[0];
const venture = (s, id = 'm') => guild(s).ventures.find((v) => v.id === id);
const apply = (s, opts) => intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'm', ...opts })]);
const grant = (s, opts) => apply(s, opts).state;

// --- 1. the four-corner grid ------------------------------------------------------

test('the grid’s four corners are exactly §5’s 100 / 75 / 75 / 0', () => {
  assert.equal(feeFraction(0, 0), 1.00, 'commit min, offer min — the full fee');
  assert.equal(feeFraction(1, 0), 0.75, 'commit max alone buys 25 points');
  assert.equal(feeFraction(0, 1), 0.75, 'offer max alone buys 25 points');
  assert.equal(feeFraction(1, 1), 0.00, 'both pulled buys the whole 100 — the corner the shaping must not disturb');
});

test('an interior point matches the bilinear formula with the shaped equity axis', () => {
  const c = 0.4;
  const oNorm = 0.7;
  const o = oNorm ** EQUITY_SHAPE_K;
  const expected = ((100 * (1 - c) * (1 - o)) + (75 * c * (1 - o)) + (75 * (1 - c) * o) + (0 * c * o)) / 100;
  assert.equal(feeFraction(c, oNorm), expected);
});

test('the discounted fee never exceeds the basic fee, across a spread of terms', () => {
  for (const pct of [0, 0.05, 0.25, 0.5, 0.75, 1]) {
    for (const eq of [0, 0.1, 0.245, 0.4, EQUITY_CEILING]) {
      const { basicFee, discountedFee } = licenceFee({
        baselineUnitsPerTick: 5, windowN: N, lockedPrice: 13.7, committedOutputPct: pct, equityPct: eq,
      });
      assert.ok(Number.isInteger(basicFee) && Number.isInteger(discountedFee), 'integer credits (§15.2)');
      assert.ok(discountedFee <= basicFee, `pct ${pct}, equity ${eq}: ${discountedFee} must not exceed ${basicFee}`);
      assert.ok(discountedFee >= 0);
    }
  }
});

test('the basic fee is feeRate × baseline-over-one-window × the locked price', () => {
  const { basicFee } = licenceFee({
    baselineUnitsPerTick: 5, windowN: N, lockedPrice: 10, committedOutputPct: 0, equityPct: 0,
  });
  assert.equal(basicFee, Math.round(FEE_RATE * 5 * N * 10));
  // ...and it is priced off the BASELINE, so it cannot be shrunk by throttling: two
  // ventures of the same type carry the same basic fee whatever their productionRate.
  let s = sysState([mine('m', 'titanium', 1)]);       // throttled to a trickle
  s = grant(s, { committedOutputPct: 0, windowDays: 14 });
  assert.equal(venture(s).licence.basicFee, basicFee, 'a throttled mine owes the same as a flat-out one');
});

// --- 2. the o^k shaping -----------------------------------------------------------

test('mid equity buys LESS relief than linear, and the payoff accelerates toward the ceiling', () => {
  const c = 0;                                   // hold commitment at the floor
  const relief = (oNorm) => 1 - feeFraction(c, oNorm);
  const linearRelief = (oNorm) => 0.25 * oNorm;  // the un-shaped bilinear reference

  assert.ok(relief(0.5) < linearRelief(0.5), 'toe-dipping is deliberately poor value');
  assert.equal(0.5 ** EQUITY_SHAPE_K < 0.5, true);
  // Accelerating: each further step toward the ceiling buys more than the one before.
  const steps = [0, 0.25, 0.5, 0.75, 1].map(relief);
  for (let i = 2; i < steps.length; i += 1) {
    assert.ok(steps[i] - steps[i - 1] > steps[i - 1] - steps[i - 2],
      `step ${i}: relief must accelerate toward the 49% ceiling`);
  }
  assert.equal(relief(1), 0.25, 'and the ceiling still lands exactly on the corner');
});

// --- 3. applyForLicence grants, locks, and sets the commitment ---------------------

test('a valid application stores the licence, locks both fees, and sets the commitment', () => {
  let s = sysState([mine('m', 'titanium', 5, 0.245)]);
  assert.equal('licence' in venture(s), false, 'an unlicensed venture carries no key at all');

  s = grant(s, { committedOutputPct: 0.5, windowDays: 14 });
  const lic = venture(s).licence;
  const expected = licenceFee({
    baselineUnitsPerTick: MINE_BASELINE.titanium, windowN: N, lockedPrice: BASE_PRICE,
    committedOutputPct: 0.5, equityPct: 0.245,
  });

  assert.deepEqual(lic, {
    committedOutputPct: 0.5,
    windowDays: 14,
    signedTick: 0,
    lockedPrice: BASE_PRICE,
    basicFee: expected.basicFee,
    discountedFee: expected.discountedFee,
  });
  assert.ok(lic.discountedFee < lic.basicFee, 'the four-corner discount is visibly applied');
  assert.equal(venture(s).syndicateCommitment,
    commitmentUnitsFor(0.5, MINE_BASELINE.titanium, N),
    'the commitment is a share of BASELINE output over one window, in whole units');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the licence reads the equity offered at establishment — it does not set it', () => {
  const plain = grant(sysState([mine('m', 'titanium', 5, 0)]), { committedOutputPct: 0.5, windowDays: 14 });
  const offered = grant(sysState([mine('m', 'titanium', 5, 0.49)]), { committedOutputPct: 0.5, windowDays: 14 });
  assert.equal(plain.guilds[0].ventures[0].licence.basicFee, offered.guilds[0].ventures[0].licence.basicFee,
    'the same venture type owes the same basic fee either way');
  assert.ok(offered.guilds[0].ventures[0].licence.discountedFee < plain.guilds[0].ventures[0].licence.discountedFee,
    'but the equity already on the venture buys a deeper discount');
  assert.equal(offered.guilds[0].ventures[0].equityPct, 0.49, 'and the offer itself is untouched by licensing');
});

test('every invalid application is refused, and changes nothing', () => {
  const base = sysState([mine('m', 'titanium', 5)]);
  const refusals = [
    [{ committedOutputPct: 1.5, windowDays: 14 }, /committedOutputPct/],
    [{ committedOutputPct: -0.1, windowDays: 14 }, /committedOutputPct/],
    [{ committedOutputPct: 0.5, windowDays: 3 }, /windowDays/],
    [{ committedOutputPct: 0.5, windowDays: 90 }, /windowDays/],
    [{ committedOutputPct: 0.5, windowDays: 14.5 }, /windowDays/],
  ];
  for (const [terms, pattern] of refusals) {
    const { state: after, results } = apply(base, terms);
    assert.equal(results[0].accepted, false, `${JSON.stringify(terms)} must be refused`);
    assert.match(results[0].reason, pattern);
    assert.equal(hashState(after), hashState(base), 'a refusal leaves state byte-identical');
  }
});

// A FACTORY IS LICENSABLE (factory-commitment slice, 28-08-26). This test used to pin
// the opposite — the refusal existed only because the §5 accrual summed `Q` over mines,
// so a factory licence could never have been delivered or judged. The accrual is
// producer-general now, so the licence is granted on the FACTORY'S OUTPUT good, priced
// off that good's posted price and its recipe's droidless baseline (batches/tick × the
// recipe's output qty, sim/baseline.js) — no number invented for the factory case.
test('a FACTORY can be licensed — the terms are priced off its recipe OUTPUT', () => {
  const s = sysState([factory('m', 'titanium_alloy', 2)]);
  const granted = grant(s, { committedOutputPct: 0.5, windowDays: 14 });
  const lic = venture(granted).licence;

  const outUnits = REFINERY_BASELINE.titanium_alloy * getRecipe('titanium_alloy').output.qty;
  assert.deepEqual(lic, {
    committedOutputPct: 0.5,
    windowDays: 14,
    signedTick: 0,
    lockedPrice: BASE_PRICE,          // titanium_alloy's posted price, not titanium's
    ...licenceFee({
      baselineUnitsPerTick: outUnits, windowN: N, lockedPrice: BASE_PRICE,
      committedOutputPct: 0.5, equityPct: 0,
    }),
  });
  assert.equal(venture(granted).syndicateCommitment, commitmentUnitsFor(0.5, outUnits, N),
    'the committed quantity is a share of the FACTORY baseline over one window');
  assert.equal(venture(granted).committedFromTick, 1, 'and it is stamped like any licence');
  assert.deepEqual(checkInvariants(granted, granted.tick), []);
});

test('a venture that produces nothing identifiable still cannot be licensed', () => {
  // A dangling recipeId — the occupancy invariant already halts on it; the licence path
  // refuses it rather than pricing a contract over a good that does not exist.
  const s = sysState([{ id: 'm', ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId: 'no_such_recipe', productionRate: 2 }]);
  const { results } = apply(s, { committedOutputPct: 0.5, windowDays: 14 });
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /produces no identifiable good/);
});

test('fuel carries no venture licence (§8)', () => {
  // Hand-built: no node mines fuel, so this state is impossible in play — which is the
  // point. The exclusion is stated, not left to be implied by the seed's geology.
  const s = sysState([mine('m', 'deuterium_fuel', 5)]);
  const { results } = apply(s, { committedOutputPct: 0.5, windowDays: 14 });
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /Syndicate-regulated/);
});

test('a second application is refused — changing agreed terms is renegotiation', () => {
  let s = grant(sysState([mine('m', 'titanium', 5)]), { committedOutputPct: 0.25, windowDays: 14 });
  const { state: after, results } = apply(s, { committedOutputPct: 1, windowDays: 42 });
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /already licensed/);
  assert.equal(hashState(after), hashState(s), 'the standing terms are untouched');
});

test('an application against a venture you do not own, or that does not exist, is refused', () => {
  const s = sysState([mine('m', 'titanium', 5)]);
  const missing = intake(s, [createApplyForLicenceAction({ guildId: 'g1', ventureId: 'nope', committedOutputPct: 0.5, windowDays: 14 })]);
  assert.equal(missing.results[0].accepted, false);
  const noGuild = intake(s, [createApplyForLicenceAction({ guildId: 'ghost', ventureId: 'm', committedOutputPct: 0.5, windowDays: 14 })]);
  assert.equal(noGuild.results[0].accepted, false);
});

// --- 4. locked at issuance --------------------------------------------------------

test('the stored fees do NOT move when the market does', () => {
  let s = grant(sysState([mine('m', 'titanium', 5, 0.2)]), { committedOutputPct: 0.5, windowDays: 14 });
  const locked = { ...venture(s).licence };
  assert.equal(locked.lockedPrice, BASE_PRICE);

  // The market moves hard, in both directions, and the ticks roll on.
  s.prices.titanium.posted = BASE_PRICE * 9;
  for (let i = 0; i < 5; i += 1) s = tick(s);
  assert.deepEqual(venture(s).licence, locked, 'a signed licence is a fixed contract, not a live quote');

  s.prices.titanium.posted = BASE_PRICE / 4;
  for (let i = 0; i < 5; i += 1) s = tick(s);
  assert.deepEqual(venture(s).licence, locked);
});

test('signing at a different price is a different contract', () => {
  const cheap = sysState([mine('m', 'titanium', 5)]);
  const dear = sysState([mine('m', 'titanium', 5)]);
  dear.prices.titanium.posted = BASE_PRICE * 3;

  const a = grant(cheap, { committedOutputPct: 0.5, windowDays: 14 });
  const b = grant(dear, { committedOutputPct: 0.5, windowDays: 14 });
  assert.equal(b.guilds[0].ventures[0].licence.basicFee, a.guilds[0].ventures[0].licence.basicFee * 3,
    'timing your signature is a real decision (§5)');
});

test('the window length cannot change once a licence is signed', () => {
  let s = grant(sysState([mine('m', 'titanium', 5)]), { committedOutputPct: 0.5, windowDays: 14 });
  const { state: after, results } = intake(s, [createSetWindowNAction({ windowN: 3 })]);
  assert.equal(results[0].accepted, false, 'a locked fee is priced over ONE window — moving N would silently invalidate it');
  assert.match(results[0].reason, /licence/);
  assert.equal(hashState(after), hashState(s));
});

// --- 5. the licence is what turns 3a’s sale on ------------------------------------

test('licensing switches the commitment sale on, and invariant 2 stays exact', () => {
  let s = sysState([mine('m', 'titanium', 5)]);
  s = tick(s);
  assert.equal(guild(s).credits, 0, 'an unlicensed mine earns nothing');

  s = grant(s, { committedOutputPct: 1, windowDays: 14 });
  const before = { credits: guild(s).credits, ledger: s.syndicate.ledger };
  s = tick(s);

  const sale = guild(s).lastSyndicateSale;
  assert.ok(sale && sale.credited > 0, 'the licence set the commitment, and the commitment sold');
  assert.equal(guild(s).credits - before.credits, sale.credited);
  assert.equal(before.ledger - s.syndicate.ledger, sale.credited, 'every credit came out of the ledger (invariant 2)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 6. THE FEE IS CHARGED — AT THE BOUNDARY, AND NOWHERE ELSE --------------------

// This test shipped with 3b-i as "the ONLY credit movement is the sale — no fee is ever
// debited". Slice 3b-iii makes that false, on exactly ONE tick in every window, and the
// flipped assertion is the headline proof of this slice: the credit change is the sale
// on every ordinary tick, and the sale MINUS the fee on the boundary. Kept as one test,
// walking the same 30 ticks, so the two halves can never drift apart.
test('the fee is debited at the boundary and NOWHERE else — every other tick is the sale alone', () => {
  let s = sysState([mine('m', 'titanium', 5, 0.3)]);
  s = grant(s, { committedOutputPct: 0.75, windowDays: 21 });
  const lic = venture(s).licence;
  assert.ok(lic.discountedFee > 0, 'there IS a fee on the books, and now it is charged');

  let earned = 0;
  let charged = 0;
  let boundaries = 0;
  // Run well past a window boundary (N = 24), which falls at producing tick 24.
  for (let i = 0; i < 30; i += 1) {
    const creditsBefore = guild(s).credits;
    s = tick(s);
    const sale = guild(s).lastSyndicateSale;
    const soldThisTick = sale && sale.tick === s.tick ? sale.credited : 0;
    const fee = guild(s).lastLicenceFee;
    const feeThisTick = fee && fee.tick === s.tick ? fee.charged : 0;

    if (s.tick % N === 0) {
      boundaries += 1;
      assert.ok(feeThisTick > 0, `tick ${s.tick} is a boundary — the fee must fire here`);
    } else {
      assert.equal(feeThisTick, 0, `tick ${s.tick} is not a boundary — nothing may be charged`);
    }
    assert.equal(guild(s).credits - creditsBefore, soldThisTick - feeThisTick,
      `tick ${s.tick}: the credit change is the sale minus the fee, and nothing else`);
    earned += soldThisTick;
    charged += feeThisTick;
  }
  assert.equal(boundaries, 1, 'the run crossed exactly one boundary (N = 24 over 30 ticks)');
  assert.ok(earned > 0, 'the run really did trade');
  assert.equal(guild(s).credits, earned - charged, 'the guild kept its sales less its one fee');
  assert.equal(s.syndicate.ledger, charged - earned, 'and the ledger is the exact mirror (invariant 2)');
  assert.equal(guild(s).credits + s.syndicate.ledger, 0, 'invariant 2, to the credit');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('NO-OP PROOF: an unlicensed boot+ticks is hash-identical, and carries no licence key', () => {
  const run = () => {
    let s = createZeroState();
    for (let i = 0; i < 5; i += 1) s = advance(s, []).state;
    return s;
  };
  const a = run();
  assert.equal(hashState(a), hashState(run()), 'determinism (invariant 9)');
  assert.equal(a.syndicate.ledger, 0, 'a slice that charges nothing moves nothing');
  for (const g of a.guilds) for (const v of g.ventures || []) assert.equal('licence' in v, false);
});

test('an unlicensed venture is byte-identical to one built before this slice existed', () => {
  const s = sysState([mine('m', 'titanium', 5)]);
  const keys = Object.keys(s.guilds[0].ventures[0]);
  assert.equal(keys.includes('licence'), false, 'the key is omitted, not defaulted');
  assert.equal(keys.includes('equityPct'), false);
});

// --- 7. determinism, the snapshot, and the tripwire -------------------------------

test('determinism (invariant 9): a licensed run is byte-identical run twice', () => {
  const build = () => {
    let s = grant(sysState([mine('a', 'titanium', 7, 0.25), mine('b', 'titanium', 5, 0)]),
      { committedOutputPct: 0.6, windowDays: 30 });
    for (let i = 0; i < 20; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

test('the snapshot carries the licence, and null when unlicensed', () => {
  let s = sysState([mine('m', 'titanium', 5, 0.245)]);
  assert.equal(buildSnapshot(s).ventures[0].licence, null);

  s = grant(s, { committedOutputPct: 0.5, windowDays: 14 });
  const row = buildSnapshot(s).ventures[0];
  assert.deepEqual(row.licence, venture(s).licence, 'the lens reports the stored terms verbatim');
  assert.equal(row.syndicateCommitment, venture(s).syndicateCommitment);
  // The snapshot must not alias into engine state.
  row.licence.basicFee = 1;
  assert.notEqual(venture(s).licence.basicFee, 1);
});

test('a corrupted licence trips the tripwire', () => {
  const base = grant(sysState([mine('m', 'titanium', 5)]), { committedOutputPct: 0.5, windowDays: 14 });
  assert.deepEqual(checkInvariants(base, base.tick), []);

  const cases = [
    (v) => { v.licence.discountedFee = v.licence.basicFee + 1; },   // a discount that is a surcharge
    (v) => { v.licence.basicFee = 12.5; },                          // fractional credits
    (v) => { v.licence.committedOutputPct = 2; },                   // a 200% commitment
    (v) => { v.licence.windowDays = 90; },                          // outside §5's bounds
    (v) => { v.licence.lockedPrice = 0; },                          // a fee priced off nothing
  ];
  for (const corrupt of cases) {
    const s = JSON.parse(JSON.stringify(base));
    corrupt(s.guilds[0].ventures[0]);
    assert.ok(checkInvariants(s, s.tick).length >= 1, `${corrupt} must trip`);
  }
});

test('the terms validators are the ones §5 names', () => {
  assert.equal(COMMITMENT_FLOOR, 0, '§5: a licensed venture may commit nothing');
  assert.equal(EQUITY_CEILING, 0.49);
  assert.equal(isValidCommitmentPct(COMMITMENT_FLOOR), true);
  assert.equal(isValidCommitmentPct(1), true);
  assert.equal(isValidCommitmentPct(1.01), false);
  assert.equal(isValidWindowDays(WINDOW_DAYS_MIN), true);
  assert.equal(isValidWindowDays(WINDOW_DAYS_MAX), true);
  assert.equal(isValidWindowDays(WINDOW_DAYS_MIN - 1), false);
  assert.equal(isValidWindowDays(WINDOW_DAYS_MAX + 1), false);
});

// --- the establish → license path, end to end -------------------------------------

test('establish with an equity offer, then license: the offer is what deepens the discount', () => {
  let s = createZeroState();
  ({ state: s } = intake(s, [{
    type: 'foundGuild', guildId: 'g1', name: 'G1', credits: 0, influence: 0, homeSystemId: HOME_SYSTEM, ventures: [],
  }]));
  ({ state: s } = intake(s, [createEstablishVentureAction({
    guildId: 'g1', ventureId: 'm', siteId: HOME_MINE, assetId: 'asset_g1_miner_01', resourceType: 'titanium', productionRate: 5, equityPct: 0.49,
  })]));
  const { state: licensed, results } = intake(s, [createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'm', committedOutputPct: 1, windowDays: 7,
  })]);
  assert.equal(results[0].accepted, true);
  // Both levers at maximum is §5's deep-entanglement corner: the fee falls to zero.
  assert.equal(licensed.guilds[0].ventures[0].licence.discountedFee, 0);
  assert.ok(licensed.guilds[0].ventures[0].licence.basicFee > 0, 'from a real basic fee');
  assert.deepEqual(checkInvariants(licensed, licensed.tick), []);
});


// --- 8. the snapshot's FEE QUOTE — the number the panel shows before you sign --------
//
// `feeQuote[good]` is the BASIC fee in credits a licence signed right now would lock, for
// a venture producing that good. The client cannot derive it (it holds neither the
// baseline, nor `FEE_RATE`, nor the window), which is why the engine publishes it — and
// the tests below are the reason it can be TRUSTED: the quote is pinned to what
// `applyForLicence` actually charges, not merely to the same arithmetic written twice.

const quoteFor = (s, good) => buildSnapshot(s).feeQuote[good];

test('QUOTE == CHARGE (a MINE): the quoted fee is exactly what applying locks, same tick', () => {
  const s = sysState([mine('m', 'titanium', 5, 0.245)]);
  const quoted = quoteFor(s, 'titanium');      // read BEFORE the licence exists

  const granted = grant(s, { committedOutputPct: 0.5, windowDays: 14 });
  assert.equal(venture(granted).licence.basicFee, quoted,
    'the display can never drift from the contract — both come out of licenceFee');
  // ...and the discount is the player's own business: the quote is the UN-discounted fee,
  // which is strictly the larger of the two here.
  assert.ok(venture(granted).licence.discountedFee < quoted);
});

test('QUOTE == CHARGE (a FACTORY): priced off the recipe OUTPUT, same equality', () => {
  const s = sysState([factory('m', 'titanium_alloy', 2)]);
  const quoted = quoteFor(s, 'titanium_alloy');

  const granted = grant(s, { committedOutputPct: 1, windowDays: 14 });
  assert.equal(venture(granted).licence.basicFee, quoted);
  // The quote is the FACTORY's own baseline (batches × the recipe's output qty), not the
  // titanium it eats — a factory quoted off its inputs would be a different contract.
  assert.equal(quoted, licenceFee({
    baselineUnitsPerTick: REFINERY_BASELINE.titanium_alloy * getRecipe('titanium_alloy').output.qty,
    windowN: N, lockedPrice: BASE_PRICE, committedOutputPct: 0, equityPct: 0,
  }).basicFee);
});

test('the equality holds after the market has MOVED — the quote is live, the licence is not', () => {
  let s = sysState([mine('m', 'titanium', 5)]);
  s.prices.titanium.posted = BASE_PRICE * 3;

  const quoted = quoteFor(s, 'titanium');
  const granted = grant(s, { committedOutputPct: 0.25, windowDays: 14 });
  assert.equal(venture(granted).licence.basicFee, quoted, 'signing at the quoted moment charges the quoted fee');

  // The price moves again: the SIGNED licence stays put (it is a contract) while the
  // quote for the next signature follows the market. Both behaviours in one place, since
  // it is exactly the difference a panel showing both must not blur.
  granted.prices.titanium.posted = BASE_PRICE;
  assert.equal(venture(granted).licence.basicFee, quoted, 'a locked fee does not re-quote');
  assert.equal(quoteFor(granted, 'titanium'), quoted / 3, 'but the quote does');
});

test('the quote tracks the POSTED price, proportionally', () => {
  const s = sysState([mine('m', 'titanium', 5)]);
  s.prices.titanium.posted = 10;
  const at10 = quoteFor(s, 'titanium');
  s.prices.titanium.posted = 20;
  const at20 = quoteFor(s, 'titanium');

  assert.ok(at10 > 0);
  assert.equal(at20, at10 * 2, 'double the price, double the fee');
  assert.equal(at10, Math.round(FEE_RATE * MINE_BASELINE.titanium * N * 10),
    'and the figure is §5’s own formula — asserted here once, against the constants');
  // The scarcity of the good is the price’s business; a good at a different price quotes
  // differently in the same snapshot.
  s.prices.gold.posted = 40;
  assert.equal(quoteFor(s, 'gold'), at10 * 4);
});

test('the quote tracks the WINDOW — the same scaling the charge takes', () => {
  const short = sysState([mine('m', 'titanium', 5)], { windowN: 24 });
  const long = sysState([mine('m', 'titanium', 5)], { windowN: 48 });
  assert.equal(quoteFor(long, 'titanium'), quoteFor(short, 'titanium') * 2,
    'the fee is measured over one window, so twice the window is twice the fee');
  // ...and the charge scales identically, which is the equality restated under a second N.
  assert.equal(grant(long, { committedOutputPct: 0.5, windowDays: 14 }).guilds[0].ventures[0].licence.basicFee,
    quoteFor(long, 'titanium'));
});

test('a state with no window of its own quotes over the same DEFAULT the licence path uses', () => {
  // `windowN` unset — the fallback both readers consult (sim/windows.js). Reading it two
  // different ways is exactly the drift this equality exists to catch.
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [mine('m', 'titanium', 5)] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const quoted = quoteFor(s, 'titanium');
  assert.equal(grant(s, { committedOutputPct: 0.5, windowDays: 14 }).guilds[0].ventures[0].licence.basicFee, quoted);
});

test('the per-good baseline is the licence path’s own, and null where nothing makes the good', () => {
  // The quote's baseline half. It answers for a good the way `baselineOutputFor` answers
  // for a venture — the mine table for a raw good, batches × output qty for a refined one.
  assert.equal(baselineUnitsForGood('titanium'), MINE_BASELINE.titanium);
  assert.equal(baselineUnitsForGood('titanium_alloy'),
    REFINERY_BASELINE.titanium_alloy * getRecipe('titanium_alloy').output.qty);
  for (const good of PRICED_GOODS) {
    assert.ok(baselineUnitsForGood(good) > 0, `${good} is priced, so something must be able to make it`);
  }
  // Nothing produces these, so there is no fee to quote and none is invented.
  assert.equal(baselineUnitsForGood('deuterium_fuel'), null, 'fuel is not a licensable output (§8)');
  assert.equal(baselineUnitsForGood('small_reactor_engine'), null, 'a Tier-3 placeholder has no recipe yet');
  assert.equal(baselineUnitsForGood('no_such_good'), null);
  assert.equal(baselineUnitsForGood(null), null);
});
