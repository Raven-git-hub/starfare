'use strict';

// settlement-rescue-fix.test.js — Slice A-fix (licence system), design.md §5, "SETTLEMENT RESCUE —
// three follow-up rulings (28-09-26)". Ruling (1) is as-built and not touched here. This slice
// builds the other two:
//   (2) NO LICENCE, NO RESCUE. A commitment with no stored `licence` (only the
//       `setSyndicateCommitment` dev scaffold makes one) is never rescued, exactly as the fee
//       charge never charges it. It keeps what the fill gave it and is judged on that.
//   (3) EACH TOP-UP ON ITS OWN EQUITY. A rescued unit covers one known venture's shortfall, so it
//       is paid on THAT venture's `1 − o`, not on the blend across the good's ventures that the
//       per-tick delivery uses (`rescueSale`, sim/licence.js).
//
// The named tripwires:
//   (g) NO LICENCE, NO RESCUE — a short scaffold commitment with spare stock is not rescued and is
//       judged on its un-topped-up delivery; a real licence beside it IS rescued, whichever of the
//       two the player ranks first.
//   (h) OWN EQUITY, NOT THE BLEND — two licences on one good at different equity: a rescue that
//       saves one pays that licence's owner share, not the blend; topping up both pays each its own.
//   (i) EQUAL EQUITY IS THE BLEND — with equal equity the rescue pays exactly what the blend paid.
//   (j) THE DELIVERY STILL BLENDS — on the same boundary tick, the fresh send is still paid on the
//       blend; only the rescued units are paid on their own licence.
//   (k) ONE VENTURE IS BIT-FOR-BIT THE OLD SALE — `rescueSale` over one venture is `commitmentSale`.
// Conservation (every invariant, and credits only moving between the guild and the ledger) is
// checked across each of those boundaries. Then ISOLATION: two runs of REAL play where the rescue
// fires on every boundary (one licence per good, and two licences at equal equity) reproduce the
// engine before this slice (HEAD d7ef657) byte for byte, every tick.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction, createSetSyndicateCommitmentAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { previewProduction } = require('../production.js');
const { getStock } = require('../stock.js');
const { getWindow } = require('../windows.js');
const { postedPrice } = require('../prices.js');
const { commitmentSale, rescueSale } = require('../licence.js');
const { getRecipe } = require('../recipes.js');
const { MINE_BASELINE } = require('../baseline.js');

const SYS = 'sysA';
const GOOD = 'titanium';
const N = 4;                      // a four-tick day, so a boundary is never far away
const B = MINE_BASELINE[GOOD];    // one mine's baseline, units a tick
const q = B * N;                  // what one 100% licence owes a day (its stored commitment)
const RATE = 2 * B;               // each mine runs at twice its baseline, so stock piles up

// --- fixtures ------------------------------------------------------------------------------------

function sign(s, actions) {
  const out = intake(s, actions);
  for (const r of out.results) assert.equal(r.accepted, true, `refused: ${r.reason}`);
  return out.state;
}
const guildOf = (s, id = 'g1') => s.guilds.find((g) => g.id === id);
const stock = (s) => getStock(guildOf(s), SYS, GOOD);
const win = (s) => getWindow(guildOf(s), SYS, GOOD);
function runTo(s, t) { while (s.tick < t) s = tick(s); return s; }
// The good's window as the NEXT tick will produce it — the preview the snapshot carries.
const nextWindow = (s) => previewProduction(s).find((g) => g.guildId === 'g1')
  .systems.find((x) => x.systemId === SYS).goods[GOOD].window;

// One guild with two titanium mines in one system. `ventures` gives each one's id and equity;
// `licences` are the actions that commit them (a real licence or the dev scaffold); `goods` is the
// titanium profile (the send, the floor, the pursue ranking).
function twoMines(ventures, licences, goods) {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: ventures.map(({ id, o }) => ({
      id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: RATE,
      ...(o ? { equityPct: o } : {}),
    })) }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  return sign(s, [...licences,
    createSetProductionProfileAction({ guildId: 'g1', systemId: SYS, goods: { [GOOD]: goods } })]);
}
const licence = (ventureId) => createApplyForLicenceAction({ guildId: 'g1', ventureId, committedOutputPct: 1, windowDays: 7 });
// The dev scaffold, committing q a window: what a 100% licence owes, but with no stored licence.
const scaffold = (ventureId) => createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId, commitment: q });

// Everything the boundary tick moved, and the conservation checks, read off either side of it.
function acrossTheBoundary(s) {
  const edge = runTo(s, N - 1);
  const price = postedPrice(edge, GOOD);   // the price the boundary tick sells at (already posted)
  const preview = nextWindow(edge);
  const after = tick(edge);
  assert.deepEqual(checkInvariants(after, after.tick), [], 'every invariant holds after the boundary');
  assert.equal(guildOf(after).credits + after.syndicate.ledger, guildOf(edge).credits + edge.syndicate.ledger,
    'credits only moved between the guild and the ledger');
  // The boundary tick's output went in and its send went out; whatever else left went to the rescue.
  const output = guildOf(edge).ventures.reduce((n, v) => n + v.productionRate, 0);
  return {
    edge, after, price, preview,
    moved: stock(edge) + output - preview.sendThisTick - stock(after),
    fees: (guildOf(after).lastLicenceFee || {}).ventures,   // absent when nothing here is licensed
    sale: guildOf(after).lastSyndicateSale.goods[GOOD],
  };
}

// --- (g) NO LICENCE, NO RESCUE ---------------------------------------------------------------------
//
// A real licence `r` and a scaffold `s`, each owing q. The send is pinned at a quarter of one
// mine's baseline, so by the boundary the pile of delivered units holds q/2: the first-ranked gets
// all of it and is short by q/2, the second gets nothing. Both mines piled up far more stock than
// either shortfall, above a floor of 0.

const SEND = B / 2;
const DELIVERED_FRESH = SEND * N;   // q/2

test('(g) NO LICENCE, NO RESCUE: a short scaffold commitment is not rescued and is judged on what the fill gave it; the real licence beside it is rescued, in either ranking', () => {
  for (const [pursue, fresh] of [
    [['s', 'r'], { s: DELIVERED_FRESH, r: 0 }],   // the scaffold ranked first takes the whole send
    [['r', 's'], { r: DELIVERED_FRESH, s: 0 }],   // the real licence ranked first takes it
  ]) {
    const at = `pursue ${pursue}`;
    const x = acrossTheBoundary(twoMines([{ id: 'r' }, { id: 's' }], [licence('r'), scaffold('s')],
      { syndicate: { mode: 'absolute', value: SEND }, pursue }));

    // The real licence is topped up to its target, and met.
    assert.deepEqual(x.preview.perVenture.r, { commitment: q, delivered: q, status: 'met' }, `${at}: r rescued to met`);
    assert.equal(x.fees.r.status, 'met', `${at}: and charged the met fee`);
    // The scaffold keeps exactly what the fill gave it, and breaches on that. It has no fee row:
    // the fee charge skips it for the same reason the rescue now does.
    assert.deepEqual(x.preview.perVenture.s, { commitment: q, delivered: fresh.s, status: 'breach' }, `${at}: s not rescued`);
    assert.equal(x.fees.s, undefined, `${at}: no licence, no fee row`);

    // Only the real licence's shortfall left the stockpile, and was delivered and paid (o = 0).
    const topUp = q - fresh.r;
    assert.equal(x.preview.rescued, topUp, `${at}: the rescue is r's shortfall alone`);
    assert.equal(x.moved, topUp, `${at}: exactly that many units left the stockpile`);
    assert.equal(win(x.after).delivered, DELIVERED_FRESH + topUp, `${at}: the window closes on the send plus r's top-up`);
    assert.deepEqual(x.sale, { units: SEND + topUp, price: x.price,
      credited: Math.round(SEND * x.price) + Math.round(topUp * x.price) }, `${at}: the send and the rescue, each sold once`);
  }
});

test('(g) NO LICENCE, NO RESCUE: a scaffold alone, short with stock to spare, is not rescued at all — the pile is untouched', () => {
  const x = acrossTheBoundary(twoMines([{ id: 's' }], [scaffold('s')], { syndicate: { mode: 'absolute', value: SEND } }));
  assert.equal(x.preview.rescued, undefined, 'nothing rescued, so no rescued key');
  assert.deepEqual(x.preview.perVenture.s, { commitment: q, delivered: DELIVERED_FRESH, status: 'breach' });
  assert.equal(x.moved, 0, 'not one unit of the pile moved');
  assert.equal(guildOf(x.after).lastLicenceFee, undefined, 'and, as before, no fee is charged');
});

// --- (h) OWN EQUITY, NOT THE BLEND -----------------------------------------------------------------
//
// Two real licences, `a` (o = 0.1) and `b` (o = 0.4), each owing q. Nothing is sent, so each is
// short by its whole q, and the floor leaves exactly `spare` above it: q saves only the first-ranked
// licence, 2q saves both. The boundary's only sale is then the rescue.

const OA = 0.1;
const OB = 0.4;
function equityPair(oa, ob, pursue, spare) {
  const pile = 2 * RATE * N;   // both mines' whole output: nothing is sent
  return twoMines([{ id: 'a', o: oa }, { id: 'b', o: ob }], [licence('a'), licence('b')],
    { syndicate: { mode: 'absolute', value: 0 }, reserveLevel: pile - spare, pursue });
}
// What `commitmentSale`, the good-level blend, would pay for `units` on this boundary.
function blendCredits(x, units) {
  const g = guildOf(x.edge);
  return commitmentSale({ ventures: g.ventures, good: GOOD, delivered: units, price: x.price, windowStart: 1, windowN: N }).ownerCredits;
}

test('(h) OWN EQUITY, NOT THE BLEND: a rescue that saves one of two differently-equitied licences pays THAT licence\'s owner share', () => {
  for (const [first, o, second] of [['a', OA, 'b'], ['b', OB, 'a']]) {
    const x = acrossTheBoundary(equityPair(OA, OB, [first, second], q));
    assert.equal(x.fees[first].status, 'met', `${first}, ranked first, is saved`);
    assert.equal(x.fees[second].status, 'breach', `${second} gets nothing`);
    assert.equal(x.moved, q);
    // Paid on the saved licence's own (1 − o): the owner keeps that share, the rest stays in the ledger.
    assert.deepEqual(x.sale, { units: q, price: x.price, credited: Math.round((1 - o) * q * x.price) },
      `${first}'s rescue is paid at its own 1 − ${o}`);
    // Which is not what the blend (0.75 here, the mean of 0.9 and 0.6) would have paid.
    assert.notEqual(x.sale.credited, blendCredits(x, q), `${first}'s rescue is not paid on the blend`);
  }
});

test('(h) OWN EQUITY, NOT THE BLEND: when both licences are topped up, each top-up is paid on its own equity and the good\'s sale is their sum', () => {
  // Spare for all of a's shortfall and half of b's. (Two EQUAL top-ups on equal commitments would
  // weight the blend exactly as the top-ups do, so it could not tell the two rules apart.)
  const x = acrossTheBoundary(equityPair(OA, OB, ['a', 'b'], q + q / 2));
  assert.equal(x.fees.a.status, 'met');
  assert.equal(x.fees.b.status, 'breach', 'b is topped up by half its shortfall, so it still breaches');
  assert.equal(x.moved, q + q / 2);
  assert.deepEqual(x.sale, { units: q + q / 2, price: x.price,
    credited: Math.round((1 - OA) * q * x.price + (1 - OB) * (q / 2) * x.price) }, 'one sum, rounded once');
  assert.notEqual(x.sale.credited, blendCredits(x, q + q / 2), 'not what the blend would have paid');
});

// --- (i) EQUAL EQUITY IS THE BLEND -----------------------------------------------------------------

test('(i) EQUAL EQUITY IS THE BLEND: with both licences at the same equity, the rescue pays exactly what the good-level blend paid', () => {
  for (const spare of [q, 2 * q]) {
    const x = acrossTheBoundary(equityPair(0.3, 0.3, ['a', 'b'], spare));
    assert.equal(x.moved, spare);
    assert.equal(x.sale.credited, blendCredits(x, spare), `saving ${spare / q} licence(s) at equal equity is the blend`);
  }
});

// --- (j) THE DELIVERY STILL BLENDS -----------------------------------------------------------------

test('(j) THE DELIVERY STILL BLENDS: on the same boundary the fresh send is paid on the blend, and only the rescued units on their own licence', () => {
  // The send hands `a` (ranked first) q/2 over the day; the floor leaves exactly its other half.
  const pile = (2 * RATE - SEND) * N;
  const x = acrossTheBoundary(twoMines([{ id: 'a', o: OA }, { id: 'b', o: OB }], [licence('a'), licence('b')],
    { syndicate: { mode: 'absolute', value: SEND }, reserveLevel: pile - q / 2, pursue: ['a', 'b'] }));
  assert.equal(x.fees.a.status, 'met');
  assert.equal(x.moved, q / 2);
  assert.deepEqual(x.sale, { units: SEND + q / 2, price: x.price,
    credited: blendCredits(x, SEND) + Math.round((1 - OA) * (q / 2) * x.price) },
  'the boundary\'s fresh send on the blend (as before), plus a\'s rescue at a\'s own 1 − o');
});

// --- (k) ONE VENTURE IS BIT-FOR-BIT THE OLD SALE ---------------------------------------------------

test('(k) ONE VENTURE IS BIT-FOR-BIT THE OLD SALE: rescueSale over a good with one committing venture pays exactly what commitmentSale paid', () => {
  // Over a sweep of equities (including ones binary floating point cannot hold exactly), prices,
  // units, and a mid-window joiner's pro-rated contribution. Beside the venture: an uncommitted one
  // and one making another good, which the blend skipped too.
  for (const o of [0, 0.1, 0.15, 0.2, 0.3, 1 / 3, 0.49]) {
    for (const price of [1, 7.3, 24.658, 113.07]) {
      for (const units of [1, 3, 17, 640, 4739]) {
        for (const committedFromTick of [undefined, 3]) {
          const v = { id: 'v', type: 'mining', resourceType: GOOD, syndicateCommitment: 160, equityPct: o,
            ...(committedFromTick ? { committedFromTick } : {}) };
          const ventures = [v,
            { id: 'idle', type: 'mining', resourceType: GOOD, syndicateCommitment: 0, equityPct: 0.2 },
            { id: 'other', type: 'mining', resourceType: 'carbon_products', syndicateCommitment: 50, equityPct: 0.4 }];
          const terms = { ventures, good: GOOD, price, windowStart: 1, windowN: N };
          assert.equal(rescueSale({ ...terms, topUps: { v: units } }).ownerCredits,
            commitmentSale({ ...terms, delivered: units }).ownerCredits, `o ${o}, price ${price}, ${units} units`);
        }
      }
    }
  }
  // A top-up for a venture that is not there halts, rather than paying on made-up terms.
  assert.throws(() => rescueSale({ ventures: [], topUps: { ghost: 1 }, good: GOOD, price: 1, windowStart: 1, windowN: N }),
    /topped up venture ghost, which is not among the ventures being paid/);
});

// --- ISOLATION: real play is unchanged -------------------------------------------------------------
//
// Ruling (2) can only move a run that has a licence-less commitment, and ruling (3) only a good with
// two licences at DIFFERENT equity. So a run of REAL play (every commitment from applyForLicence)
// where every good has one licence, or its licences share one equity, must reproduce the engine
// before this slice (HEAD d7ef657) byte for byte, EVEN THOUGH the rescue fires on every boundary.
// Two such runs, on a 60-tick day: 700 ticks, a jump to 180 ticks before the week's end, then 300
// more (the pattern of settlement-rescue.test.js). Every tick's state is hashed, and the production
// preview before every tick (so the boundary's rescue preview too), and the snapshot at every day
// boundary. The hashes were computed on HEAD d7ef657 by the build session and pinned here. The
// rescue and verdict counts are pinned too, so each run is known to be the case it claims to be.
//   ONE LICENCE PER GOOD — a Tier-1 mine, a Tier-2 factory and a Tier-3 factory, each licensed, each
//     with equity that binary floating point cannot hold exactly, each short with stock to spare.
//   TWO LICENCES, EQUAL EQUITY — two Tier-1 mines on one good at o = 0.3, both short, both rescued
//     from one pile on every boundary.
const WEEK = 10080;
const ISO_DAY = 60;
const ISO_JUMP_TO = WEEK - 180;
function inputSets(recipeId, n) {
  const out = {};
  for (const inp of getRecipe(recipeId).inputs) out[inp.good] = inp.qty * n;
  return out;
}
function isolationRun(rows, actions) {
  let s = createState({ guilds: rows, reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: ISO_DAY });
  s = sign(s, actions);
  const everyTick = crypto.createHash('sha256');
  const previews = crypto.createHash('sha256');
  const snapshots = crypto.createHash('sha256');
  const counts = { rescues: 0, met: 0, breach: 0 };
  const step = () => {
    const preview = previewProduction(s);
    previews.update(hashState(preview));
    for (const g of preview) for (const sys of g.systems) for (const e of Object.values(sys.goods)) {
      if (e.window && e.window.rescued) counts.rescues += 1;
    }
    s = tick(s);
    everyTick.update(hashState(s));
    if (s.tick % ISO_DAY !== 0) return;
    snapshots.update(hashState(buildSnapshot(s)));
    for (const g of s.guilds) {
      const fee = g.lastLicenceFee;
      if (fee && fee.tick === s.tick) for (const row of Object.values(fee.ventures)) counts[row.status] += 1;
    }
  };
  for (let i = 0; i < 700; i += 1) step();
  s.tick = ISO_JUMP_TO;
  for (let i = 0; i < 300; i += 1) step();
  return {
    final: hashState(s), everyTick: everyTick.digest('hex'), previews: previews.digest('hex'),
    snapshots: snapshots.digest('hex'), counts,
  };
}
function oneLicencePerGood() {
  const id = 'solo';
  return isolationRun([{ id, credits: 0, fuelHoard: 0,
    // Inputs for 5 fuel tanks against a commitment of 20, and a pile of every committed good.
    stockpiles: { [SYS]: { ...inputSets('fuel_tank', 5), titanium: 500, titanium_alloy: 50, fuel_tank: 40 } },
    ventures: [
      { id: 'tm', ownerGuildId: id, type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 400, equityPct: 0.3 },
      { id: 'cm', ownerGuildId: id, type: 'mining', systemId: SYS, resourceType: 'carbon_products', productionRate: 10 },
      { id: 'fa', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: 'titanium_alloy', productionRate: 5, equityPct: 0.15 },
      { id: 'ft', ownerGuildId: id, type: 'refining', systemId: SYS, recipeId: 'fuel_tank', productionRate: 5, equityPct: 0.2 },
    ],
    // Sends pinned at 1 a tick, far under target: every Tier-1/2 licence is short every day.
    productionProfile: { [SYS]: { goods: {
      titanium: { syndicate: { mode: 'absolute', value: 1 } },
      titanium_alloy: { syndicate: { mode: 'absolute', value: 1 } },
    } } } }],
  [
    createApplyForLicenceAction({ guildId: id, ventureId: 'tm', committedOutputPct: 0.5, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: id, ventureId: 'fa', committedOutputPct: 0.5, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: id, ventureId: 'ft', committedUnits: 20 }),
  ]);
}
function twoLicencesEqualEquity() {
  const id = 'pair';
  const mine = (vid) => ({ id: vid, ownerGuildId: id, type: 'mining', systemId: SYS, resourceType: 'titanium', productionRate: 400, equityPct: 0.3 });
  return isolationRun([{ id, credits: 0, fuelHoard: 0, stockpiles: { [SYS]: { titanium: 500 } },
    ventures: [mine('m1'), mine('m2')],
    productionProfile: { [SYS]: { goods: { titanium: { syndicate: { mode: 'absolute', value: 1 } } } } } }],
  [
    createApplyForLicenceAction({ guildId: id, ventureId: 'm1', committedOutputPct: 0.5, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: id, ventureId: 'm2', committedOutputPct: 0.5, windowDays: 7 }),
  ]);
}
// The counts: 11 day boundaries before the jump, each rescuing the short Tier-1 and Tier-2 goods,
// plus the one Tier-3 week (the jump carries the Tier-1/2 licences past their renegotiation
// deadlines, so only the Tier-3 licence is judged after it). One licence per good: 11 × 2 + 1 = 23
// rescues, and all 23 verdicts met. Equal equity: 11 boundaries, each rescuing BOTH licences from
// one pile (one rescue of the good, two top-ups), so 11 rescues and 22 verdicts, all met.
const ISO_ONE_LICENCE_PER_GOOD = {
  final: '1f12e438f60eae2993c2465d783257c0a486e4f2241a6d993441523c9a0ce312',
  everyTick: '9b7941440541e47601892d384ebb008c0db04fc224e0a385277ff3f8de7c9f75',
  previews: '0b2e68aa123c0eb231d26c1850ec63ef01f462cfcba98d3926c3870df1be0235',
  snapshots: '77749c720be4f6f548030b5055393142ab9ea387bb5d6fe44b7a3be88f0f231a',
  counts: { rescues: 23, met: 23, breach: 0 },
};
const ISO_TWO_LICENCES_EQUAL_EQUITY = {
  final: 'a9ca4dd303facb6a8a4e282df63379605b4587ebead32328f127f12a258838f2',
  everyTick: '1e18c2d1a37c05a97a3012618b65eef905fac040c5ecc502242a173d6ab63534',
  previews: 'addf5c93be7ff5d1edfc3b292fee1e6af27457e85e954c0961cd2fd64a91a6e2',
  snapshots: '32ed9be5db2cbaeebeb4db874973bca5722f2806c06a4b8c5b160cfde60a3e86',
  counts: { rescues: 11, met: 22, breach: 0 },
};

test('ISOLATION: real play with the rescue firing every boundary (one licence per good; two licences at equal equity) reproduces the engine before this slice byte for byte, every tick', () => {
  const a = oneLicencePerGood();
  const b = twoLicencesEqualEquity();
  if (process.env.PRINT_ISO_PINS) console.log('ISO_PINS', JSON.stringify({ a, b }));
  assert.ok(a.counts.rescues > 0 && b.counts.rescues > 0, 'the rescue really fires in both runs');
  assert.deepEqual(a, ISO_ONE_LICENCE_PER_GOOD);
  assert.deepEqual(b, ISO_TWO_LICENCES_EQUAL_EQUITY);
});
