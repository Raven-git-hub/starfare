'use strict';

// licence-fee-charge.test.js — licence Slice 3b-iii: the fee is CHARGED
// (design.md §5 "LICENCE FEE MECHANICS — RULED"; build note docs/licence-fee.md §"The
// charge"). The socket, not a new circuit: every number this slice moves was computed by
// a slice that shipped before it — `basicFee`/`discountedFee` locked at signing (3b-i),
// the per-venture met/breach verdict from the pursue fill (the distribution slice), the
// `windowFraction` that pro-rates a mid-joiner (3b-ii). This file proves the debit.
//
// THE TWO LAYERS (§5, and the thing to get wrong):
//   Layer 1 — the VERDICT and the owed amount are per (system, good), per VENTURE:
//             `round((met ? discountedFee : basicFee) × windowFraction)`.
//   Layer 2 — the CHARGE is guild-level: every venture's owed, across every system and
//             good, sums into ONE lump debited from the guild's one credit pool.
// The total is DERIVED from the individuals — rounded per venture, then added. There is
// no (system, good) fee pot to split, and the multi-system test below pins the sum.
//
// The mid-window pro-rate's own charge arithmetic (a partial first window pays
// `round(fee × fraction)` and every later window the whole fee) is tested where the
// pro-rate's fixtures live — `mid-window-prorate.test.js`, "a mid-window licence pays a
// PRO-RATED fee at its first boundary and the full fee after".

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { MINE_BASELINE } = require('../baseline.js');
const { BASE_PRICE } = require('../prices.js');
const { FEE_RATE, feeOwed } = require('../licence.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const GOOD = 'titanium';
const N = 4;                                  // a short window, so a boundary is 4 ticks away

// The two locked fees a full-commitment, no-equity licence carries in these fixtures,
// stated as arithmetic rather than read back off the code under test:
//   basicFee = round(FEE_RATE × baseline-per-tick × N × the posted price at signing)
//   discountedFee = 75% of it (§5's grid: commit max, offer min buys 25 points of relief)
const BASIC_FEE = Math.round(FEE_RATE * MINE_BASELINE[GOOD] * N * BASE_PRICE);
const DISCOUNTED_FEE = Math.round(BASIC_FEE * 0.75);

const mine = (id, { systemId = SYS, productionRate = 10, commitment } = {}) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: GOOD, productionRate,
  ...(commitment === undefined ? {} : { syndicateCommitment: commitment }),
});

function fixture(ventures, { credits = 0 } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}

const guild = (s) => s.guilds[0];
const fee = (s) => guild(s).lastLicenceFee;
const licence = (s, id) => guild(s).ventures.find((v) => v.id === id).licence;

// Licence a venture at tick 0, before any window has opened — so `committedFromTick` is
// 1, the first tick of the first window, and every window it is judged on is FULL
// (`windowFraction` 1). The pro-rate is a separate axis, tested in its own file.
const licenceAll = (s, ids, committedOutputPct = 1) => intake(s, ids.map((id) =>
  createApplyForLicenceAction({ guildId: 'g1', ventureId: id, committedOutputPct, windowDays: 7 }))).state;

// Pin the Syndicate send to a flat rate, so the pile at the boundary is a fact of the
// fixture rather than whatever the paced default converges on (it converges on `Q`
// exactly, which is the wrong thing for a test about what a SHORTFALL costs).
const setSend = (s, value, systemId = SYS) => intake(s, [createSetProductionProfileAction({
  guildId: 'g1', systemId, goods: { [GOOD]: { syndicate: { mode: 'absolute', value } } },
})]).state;

const setPursue = (s, pursue) => intake(s, [createSetProductionProfileAction({
  guildId: 'g1', systemId: SYS, goods: { [GOOD]: { pursue } },
})]).state;

// Run to the next boundary (producing tick N, 2N, …) and stop there.
const runToBoundary = (s) => {
  do { s = tick(s); } while (s.tick % N !== 0);
  return s;
};

// --- 1. met pays the discount, breach pays the full basic fee ---------------------

test('a MET licence is charged its discounted fee at the boundary', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  assert.deepEqual(
    { basicFee: licence(s, 'm').basicFee, discountedFee: licence(s, 'm').discountedFee },
    { basicFee: BASIC_FEE, discountedFee: DISCOUNTED_FEE },
    'the fixture really does carry the two fees this file reasons about',
  );

  s = runToBoundary(s);                       // the paced default delivers Q exactly ⇒ met
  assert.equal(s.tick, N);
  assert.equal(fee(s).tick, N);
  assert.equal(fee(s).ventures.m.status, 'met');
  assert.equal(fee(s).ventures.m.owed, DISCOUNTED_FEE);
  assert.equal(fee(s).charged, DISCOUNTED_FEE, 'the guild-wide lump is the one venture’s owed');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a BREACHED licence is charged the FULL basic fee — the discount is voided', () => {
  // The send is pinned below the pace, so the pile falls short of Q and the licence
  // breaches. Same licence, same locked fees; only the verdict differs.
  let s = setSend(licenceAll(fixture([mine('m')]), ['m']), 2);
  s = runToBoundary(s);
  assert.equal(fee(s).ventures.m.status, 'breach');
  assert.equal(fee(s).ventures.m.owed, BASIC_FEE);
  assert.ok(BASIC_FEE > DISCOUNTED_FEE, 'the two really are different numbers');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('ONE UNIT SHORT is a breach and pays the full fee — no partial-delivery credit', () => {
  // alpha owes 20 (pct 1), beta owes 1 (pct 0.05) ⇒ Q = 21, and the send is pinned so the
  // window's pile is exactly 20 — one unit short of the pair's total. Ranking beta first
  // feeds it its whole 1 and leaves alpha with 19 of 20: 95% delivered, one unit short.
  let s = fixture([mine('alpha'), mine('beta')]);
  s = intake(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'alpha', committedOutputPct: 1, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'beta', committedOutputPct: 0.05, windowDays: 7 }),
  ]).state;
  s = setPursue(setSend(s, 5), ['beta', 'alpha']);

  s = runToBoundary(s);
  const rows = fee(s).ventures;
  assert.equal(rows.beta.status, 'met');
  assert.equal(rows.alpha.status, 'breach', 'nineteen of twenty is a breach');
  assert.equal(rows.alpha.owed, licence(s, 'alpha').basicFee, 'and it pays the FULL fee, not 95% of it');
  assert.equal(rows.alpha.owed, rows.alpha.basicFee);
  assert.ok(rows.alpha.owed > rows.alpha.discountedFee, 'the discount it was one unit from is simply gone');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. §5's 0% commitment floor: licensed, met, and it PAYS ----------------------

test('a 0%-commitment licence is MET every window and pays its (undiscounted) fee', () => {
  // §5's floor: "a licensed venture may commit nothing and pay the full fee for the
  // licence's other benefits". Committing nothing means no `Q`, so the good is never
  // routed and the venture appears in no `perVenture` row at all — it owed zero units,
  // delivered zero, and is `met` (0 ≥ 0). At the grid's `c = 0` / no-equity corner the
  // discount is 100% of basic, so this is a real, substantial charge, every boundary.
  let s = licenceAll(fixture([mine('m')]), ['m'], 0);
  const lic = licence(s, 'm');
  assert.equal(guild(s).ventures[0].syndicateCommitment, 0, 'it committed nothing');
  assert.equal(lic.discountedFee, lic.basicFee, 'and at c = 0 the "discount" is the full fee');

  for (const boundary of [N, 2 * N, 3 * N]) {
    s = runToBoundary(s);
    assert.equal(s.tick, boundary);
    assert.equal(fee(s).ventures.m.status, 'met', 'zero units is exactly what it owed — never a breach');
    assert.equal(fee(s).charged, lic.discountedFee);
  }
  assert.equal(guild(s).credits, -3 * lic.discountedFee, 'three windows, three charges, no income');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a COMMITTED licence with no boundary verdict HALTS — it is never read as met', () => {
  // The counterfactual to the test above, and the guard that makes "absent row ⇒ met"
  // safe. `resolveProduction` routes every good whose aggregate `Q` is positive and emits
  // a target row for every venture contributing to it, so a committed licence always has
  // a real verdict — a missing one is a broken state. Reading it as `met` would charge the
  // DISCOUNT on a contract that was never judged: an undercharge invisible in every
  // balance and every other test, which is exactly the silent violation §15.5 forbids.
  //
  // Corrupt the state the way the tripwire is aimed at: strip the licensed venture's
  // `resourceType` after signing, leaving `syndicateCommitment` at its full 20 units. The
  // resolver skips a venture with no good, so no target, no `Q`, no window block and no
  // row — while the licence still owes twenty units.
  let s = licenceAll(fixture([mine('m')]), ['m']);
  assert.ok(guild(s).ventures[0].syndicateCommitment > 0, 'it really is committed');
  delete guild(s).ventures[0].resourceType;

  assert.throws(() => runToBoundary(s), (err) => {
    assert.match(err.message, /owed 20 units/, 'names the offending quantity');
    assert.match(err.message, new RegExp(`tick ${N}`), 'and the tick it halted on (§15.5)');
    assert.match(err.message, /never judged/);
    return true;
  });

  // And it halts ONLY at the boundary — the ticks before it are untouched, so the guard
  // cannot be passing for the trivial reason that this fixture breaks everything.
  let ok = s;
  for (let i = 1; i < N; i += 1) ok = tick(ok);
  assert.equal(ok.tick, N - 1);
  assert.equal(ok.guilds[0].lastLicenceFee, undefined, 'no charge attempted before the boundary');
});

// --- 3. a licence-less commitment is charged nothing ------------------------------

test('a SCAFFOLD-committed venture beside a licensed one is charged nothing', () => {
  // `scaffold` carries a commitment but no `licence` — the dev-scaffold shape. It is
  // judged (it has a `perVenture` row and a real verdict) and charged NOTHING, because
  // there is no stored fee to charge. Only the licensed mine appears on the record.
  let s = fixture([mine('licensed'), mine('scaffold', { commitment: 8 })]);
  s = licenceAll(s, ['licensed']);
  s = runToBoundary(s);

  assert.deepEqual(Object.keys(fee(s).ventures), ['licensed'], 'the scaffold venture is not on the bill');
  assert.equal(fee(s).charged, fee(s).ventures.licensed.owed, 'and the lump is the licensed venture’s alone');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. Layer 2: one guild, several systems, ONE debit ----------------------------

test('a guild licensed in TWO systems is debited ONE lump equal to the sum of its ventures', () => {
  // Every window in the galaxy closes on the same anchored boundary, so both systems'
  // verdicts fall due on the same tick. `a` is paced (met, discounted); `b`'s send is
  // pinned short (breach, full basic) — so the lump is not a multiple of one fee and a
  // sum is the only arithmetic that produces it.
  let s = fixture([mine('a'), mine('b', { systemId: SYS_B })]);
  s = licenceAll(s, ['a', 'b']);
  s = setSend(s, 2, SYS_B);

  while (s.tick < N - 1) s = tick(s);           // stop one short, so `before` is the boundary's own start
  const before = { credits: guild(s).credits, ledger: s.syndicate.ledger };
  s = tick(s);
  assert.equal(s.tick, N);

  const rows = fee(s).ventures;
  assert.deepEqual(Object.keys(rows).sort(), ['a', 'b'], 'both systems’ ventures on one bill');
  assert.equal(rows.a.status, 'met');
  assert.equal(rows.b.status, 'breach');
  assert.equal(rows.a.owed, DISCOUNTED_FEE);
  assert.equal(rows.b.owed, BASIC_FEE);
  assert.equal(fee(s).charged, DISCOUNTED_FEE + BASIC_FEE, 'the lump is the SUM of the per-venture oweds');

  // And it moved once, as one number, in both directions.
  const sale = guild(s).lastSyndicateSale;
  const soldThisTick = sale && sale.tick === s.tick ? sale.credited : 0;
  assert.equal(guild(s).credits - before.credits, soldThisTick - fee(s).charged);
  assert.equal(s.syndicate.ledger - before.ledger, fee(s).charged - soldThisTick);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. the debt state, and conservation through it -------------------------------

test('the fee MAY drive a guild negative — invariant 3 permits it, invariant 2 stays exact', () => {
  // A 0%-commitment licence earns nothing and owes a full fee, so the guild is in debt
  // from its first boundary. §5: "a breach fee may drive a guild's credits negative —
  // guild credits join the Syndicate ledger as exempt from the non-negativity invariant".
  let s = licenceAll(fixture([mine('m')], { credits: 5 }), ['m'], 0);
  s = runToBoundary(s);

  assert.ok(guild(s).credits < 0, 'the guild really is in debt');
  assert.equal(guild(s).credits, 5 - BASIC_FEE);
  assert.equal(s.syndicate.ledger, BASIC_FEE, 'every credit it could not pay is in the ledger');
  assert.equal(guild(s).credits + s.syndicate.ledger, 5, 'invariant 2 is EXACT through the debt');
  assert.deepEqual(checkInvariants(s, s.tick), [],
    'and invariant 3 does not trip: negative guild credits are a pressure state, not a break');

  // Still an integer, and still checked as one — the carve-out freed the sign, not the type.
  assert.ok(Number.isInteger(guild(s).credits));
});

test('a fractional credit balance still trips the §15.2 integer rule', () => {
  // The counterfactual to the carve-out above: it exempted guild credits from
  // NON-NEGATIVITY and nothing else. If it had loosened the field wholesale this passes
  // silently and a fractional-credit drift would rot unnoticed.
  const s = licenceAll(fixture([mine('m')]), ['m']);
  const broken = structuredClone(s);
  broken.guilds[0].credits = 0.5;
  const trips = checkInvariants(broken, broken.tick);
  assert.ok(trips.some((t) => /integer/.test(t.rule) && t.where === 'guild:g1.credits'),
    'the integer rule still names the field the carve-out touched');
});

// --- 6. the sale is untouched: two movements on the boundary tick ------------------

test('the boundary tick runs BOTH the per-tick sale and the fee, and conserves', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  let sold = 0;
  let charged = 0;
  for (let i = 0; i < 2 * N; i += 1) {
    const before = guild(s).credits;
    s = tick(s);
    const sale = guild(s).lastSyndicateSale;
    const saleNow = sale && sale.tick === s.tick ? sale.credited : 0;
    const feeNow = fee(s) && fee(s).tick === s.tick ? fee(s).charged : 0;

    if (s.tick % N === 0) {
      assert.ok(saleNow > 0, `tick ${s.tick}: the sale still runs on a boundary tick`);
      assert.ok(feeNow > 0, `tick ${s.tick}: and the fee fires beside it`);
    } else {
      assert.equal(feeNow, 0, `tick ${s.tick}: no fee off a boundary`);
    }
    assert.equal(guild(s).credits - before, saleNow - feeNow,
      `tick ${s.tick}: two independent movements, neither folded into the other`);
    assert.equal(guild(s).credits + s.syndicate.ledger, 0, `tick ${s.tick}: invariant 2 to the credit`);
    sold += saleNow;
    charged += feeNow;
  }
  assert.ok(sold > 0 && charged > 0, 'the run both traded and paid');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 7. the record is LAZY, and the snapshot surfaces it ---------------------------

test('the charge record exists ONLY at a charging boundary — and replaces, never accumulates', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(guild(s).lastLicenceFee, undefined, `tick ${s.tick}: no boundary, no key at all`);
  }
  s = tick(s);
  assert.equal(fee(s).tick, N, 'minted at the boundary');
  const first = structuredClone(fee(s));

  s = tick(s);
  assert.deepEqual(fee(s), first, 'and it SURVIVES the window roll — the verdict is gone from everywhere else');

  s = runToBoundary(s);
  assert.equal(fee(s).tick, 2 * N, 'the next boundary REPLACES it');
  assert.equal(fee(s).charged, first.charged, 'and charges the same fee again, this window’s own verdict');
});

test('an UNLICENSED guild never grows the key, boundary or not — the lazy no-op', () => {
  let s = fixture([mine('m')]);
  for (let i = 0; i < 3 * N; i += 1) s = tick(s);
  assert.equal(s.tick % N, 0, 'the run really did land on boundaries');
  assert.equal('lastLicenceFee' in guild(s), false, 'the key is omitted, not defaulted to null');
  assert.equal(guild(s).credits, 0, 'and not one credit moved');
});

test('the snapshot surfaces the charge additively, schema still 7', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  const before = buildSnapshot(s);
  assert.equal(before.schemaVersion, 7);
  assert.equal(before.guilds[0].licenceFee, null, 'null before the first boundary, like syndicateSale');

  s = runToBoundary(s);
  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
  assert.deepEqual(snap.guilds[0].licenceFee, {
    tick: N,
    thisTick: true,
    charged: DISCOUNTED_FEE,
    ventures: { m: { status: 'met', owed: DISCOUNTED_FEE, basicFee: BASIC_FEE, discountedFee: DISCOUNTED_FEE } },
  });

  s = tick(s);
  assert.equal(buildSnapshot(s).guilds[0].licenceFee.thisTick, false,
    'and the engine says when the record is stale, so the browser never compares ticks itself');
});

// --- 8. the arithmetic helper, and determinism ------------------------------------

test('feeOwed is §5’s formula and REFUSES to price a non-verdict', () => {
  const lic = { basicFee: 100, discountedFee: 60 };
  assert.equal(feeOwed(lic, 'met', 1), 60);
  assert.equal(feeOwed(lic, 'breach', 1), 100, 'breach voids the discount');
  assert.equal(feeOwed(lic, 'met', 0.5), 30, 'the pro-rate scales it');
  assert.equal(feeOwed(lic, 'breach', 0.75), 75);
  assert.equal(feeOwed({ basicFee: 7, discountedFee: 5 }, 'met', 0.5), 3, 'and rounds to whole credits (§15.2)');
  // A fee is owed only at a boundary; an `accruing` here would mean the charge fired on a
  // tick where nothing was judged, and a silent 0 would under-charge forever.
  assert.throws(() => feeOwed(lic, 'accruing', 1), /boundary verdict/);
});

// STRIP-AND-PROVE. The goldens this repo pins do not cross a boundary under a LICENCE
// (the committed one is dev-scaffold shape, licence-less), so they are byte-identical
// after this slice — which is a proof of the lazy record and the licence-less skip, but
// says nothing about what the charge did to a run that IS licensed. This is that proof,
// and it is stronger than a re-pinned number: run the SAME fixture twice, once with the
// licence stored (so the fee is charged) and once with the licence object deleted after
// signing — which is exactly the pre-3b-iii engine's behaviour for this run, since every
// other stored field (`syndicateCommitment`, `committedFromTick`, the windows, the
// history, the sale) is untouched. Undo the charge on the first — add the lump back to
// credits, take it back out of the ledger, drop the record and the licence key — and the
// two states must hash the same. If this slice moved ONE other byte, this goes red.
test('STRIP-AND-PROVE: the charge moved the two balances and the record, and nothing else', () => {
  const WINDOWS = 3;
  const run = (keepLicence) => {
    let s = licenceAll(fixture([mine('m')]), ['m']);
    if (!keepLicence) delete s.guilds[0].ventures[0].licence;
    for (let i = 0; i < WINDOWS * N; i += 1) s = tick(s);
    return s;
  };

  const charged = run(true);
  const uncharged = run(false);

  // The expected lump, by hand: the paced default delivers Q exactly, so the licence is
  // met every window and owes its discounted fee at each of the three boundaries.
  const expectedLump = DISCOUNTED_FEE;
  assert.equal(charged.guilds[0].lastLicenceFee.charged, expectedLump);
  assert.equal(charged.guilds[0].lastLicenceFee.ventures.m.status, 'met');
  const total = WINDOWS * expectedLump;
  assert.equal(charged.guilds[0].credits, uncharged.guilds[0].credits - total,
    'credits: exactly the fee, three times, and no more');
  assert.equal(charged.syndicate.ledger, uncharged.syndicate.ledger + total,
    'ledger: the exact mirror — an internal transfer, so invariant 2 never moved');

  // Undo the charge and drop the two keys the uncharged run cannot have.
  const undone = structuredClone(charged);
  delete undone.guilds[0].lastLicenceFee;
  delete undone.guilds[0].ventures[0].licence;
  undone.guilds[0].credits += total;
  undone.syndicate.ledger -= total;

  const bare = structuredClone(uncharged);
  delete bare.guilds[0].ventures[0].licence;   // absent already, but say so explicitly

  assert.equal(hashState(undone), hashState(bare),
    'every other byte — goods, pools, windows, carries, history, the sale record — is untouched');
});

test('determinism (invariant 9): the same licensed run twice is byte-identical', () => {
  const run = () => {
    let s = fixture([mine('a'), mine('b', { systemId: SYS_B })]);
    s = licenceAll(s, ['a', 'b']);
    s = setSend(s, 2, SYS_B);
    for (let i = 0; i < 3 * N; i += 1) s = tick(s);
    return hashState(s);
  };
  assert.equal(run(), run());
});
