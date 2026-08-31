'use strict';

// Commitment-injection dev-scaffold layer — the runtime integration + no-op proofs
// for the two throwaway dev-scaffold actions (design.md §15.4 "Scaffold 11-08-26",
// §5; roadmap Phase 1 Stage 2 "injection-scaffold sub-slice"). The per-action unit
// checks live in actions.test.js; this file proves the actions WIRE THROUGH to the
// windowed engine (a set commitment lights a real Q and accrues over a window,
// resolving met/breach at the boundary; a set windowN moves the boundary cadence)
// and — the key guard — that a run touching NEITHER action is byte-identical to
// pre-change HEAD (the determinism-hash no-op proof).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { intake, createSetSyndicateCommitmentAction, createSetWindowNAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { DEUTERIUM_INFLUX_PER_CYCLE } = require('../issuance.js');
const { getWindow } = require('../windows.js');
const { BASE_PRICE } = require('../prices.js');
const { previewProduction } = require('../production.js');

const SYS = 'sysA';
const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate, syndicateCommitment: commitment,
});
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const w = (s, good) => getWindow(s.guilds[0], SYS, good);
// The window telemetry the NEXT tick will produce (previewProduction previews
// producing tick state.tick + 1), the surface the client reads and computes nothing.
const nextWindow = (s, good) => previewProduction(s)[0].systems[0].goods[good].window;

function sysState(ventures, windowN) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

// --- the actions wire through to a real windowed accrual ------------------------

test('a set commitment makes Q non-zero and the window accrues, resolving MET at the boundary', () => {
  // Start UNLICENSED (commitment 0, no windowN — a byte-identical zero-state). Then
  // inject via the scaffold actions: windowN=2, commitment=4 on a rate-10 mine ⇒
  // paced 2/tick ⇒ delivered reaches 4 = Q exactly at the boundary (tick 2) ⇒ met.
  let s = sysState([mine('t', 'titanium', 10, 0)]);
  assert.equal(s.windowN, undefined);

  const { state: injected, results } = intake(s, [
    createSetWindowNAction({ windowN: 2 }),
    createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 't', commitment: 4 }),
  ]);
  assert.deepEqual(results.map((r) => r.accepted), [true, true]);
  assert.equal(injected.windowN, 2);
  assert.equal(injected.guilds[0].ventures[0].syndicateCommitment, 4);
  // The injected venture still carries no committedFromTick — the fraction==1 guard.
  assert.equal('committedFromTick' in injected.guilds[0].ventures[0], false);
  // Q is now a real target the resolver sees (previewProduction reports it pre-tick).
  assert.equal(nextWindow(injected, 'titanium').Q, 4, 'Q = Σ commitment over the mines = 4');

  s = injected;
  s = tick(s); // producing tick 1: paced 2
  assert.equal(w(s, 'titanium').delivered, 2, 'accruing toward Q');
  assert.equal(nextWindow(s, 'titanium').status, 'met', 'the boundary tick (p=2) will meet Q');
  s = tick(s); // producing tick 2 = boundary
  assert.equal(w(s, 'titanium').delivered, 4, 'Q met at the boundary');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('an under-injected commitment BREACHES at the boundary (status flag only, no FEE)', () => {
  // commitment 9 over N=2 with a rate-4 mine: at most 4+4 = 8 fresh can be delivered,
  // short of Q 9 ⇒ breach.
  //
  // SLICE 3a: a delivery is now a SALE, so the 8 units that DID arrive are bought and
  // paid for — a breach does not confiscate what was delivered. The breach FEE is live
  // as of Slice 3b-iii, but it is charged against a stored `venture.licence` and this
  // venture is committed the SCAFFOLD way — no licence, no fees — so it breaches for
  // free: the only credits that move are the sale's, to the credit.
  let s = sysState([mine('t', 'titanium', 4, 0)]);
  const creditsBefore = s.guilds[0].credits;
  const ledgerBefore = s.syndicate.ledger;
  ({ state: s } = intake(s, [
    createSetWindowNAction({ windowN: 2 }),
    createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 't', commitment: 9 }),
  ]));
  s = tick(s); // p=1
  assert.equal(nextWindow(s, 'titanium').status, 'breach', 'p=2 will fall short of Q ⇒ breach');
  s = tick(s); // p=2 boundary
  assert.equal(w(s, 'titanium').delivered, 8, 'only 8 delivered against Q 9 — a breach');
  // 8 units sold at the posted price, which is still the seeded base at both ticks
  // (the 2-tick publish lag means nothing computed has been published yet), and no
  // equity offered ⇒ the owner keeps all of it.
  const sale = 8 * BASE_PRICE;
  assert.equal(s.guilds[0].credits - creditsBefore, sale, 'the delivered units were BOUGHT, not confiscated');
  assert.equal(ledgerBefore - s.syndicate.ledger, sale, 'and the Syndicate paid for them, to the credit');
  assert.equal(s.guilds[0].credits + s.syndicate.ledger, creditsBefore + ledgerBefore, 'no fee, no fine — nothing but the sale moved (invariant 2)');
  assert.equal(s.guilds[0].lastLicenceFee, undefined, 'and the licence-less breach mints no charge record');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the injected N moves the boundary cadence (the window rolls at tick % N == 0)', () => {
  // With windowN=3 injected, the boundary falls at tick 3 (the window's last), and a
  // new window-start is stamped at tick 4 — the cadence the new N sets (§5 tick % N).
  let s = sysState([mine('t', 'titanium', 10, 0)]);
  ({ state: s } = intake(s, [
    createSetWindowNAction({ windowN: 3 }),
    createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 't', commitment: 6 }),
  ]));
  s = tick(s); // tick 1
  assert.equal(w(s, 'titanium').windowStart, 1);
  s = tick(s); // tick 2
  assert.equal(w(s, 'titanium').windowStart, 1, 'still in window 1 (2 % 3 != 0)');
  s = tick(s); // tick 3 = boundary (3 % 3 == 0)
  assert.equal(w(s, 'titanium').windowStart, 1, 'the boundary tick is the last tick of window 1');
  s = tick(s); // tick 4 = first tick of the next window
  assert.equal(w(s, 'titanium').windowStart, 4, 'a new window-start is stamped after the N-tick boundary');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- the KEY no-op proof: a run touching NEITHER action is byte-identical to HEAD --

// Golden determinism hashes captured on the PRE-CHANGE engine (tick.js / state.js /
// production.js / windows.js — none of which this slice touches). The scaffold only
// ADDS action branches + a testbed control, so any run that calls neither action
// must reproduce these bytes exactly. If either hash drifts, the engine changed
// under this slice — which it must not (§5, §18: the unlicensed path stays untouched).
//
// PRICE-ENGINE SLICE (26-08-26): state now carries a `prices` block (sim/prices.js),
// which is real serialized state and therefore legitimately changes the FULL hash. The
// goldens below are asserted against the state with the price block stripped, which
// makes them a STRONGER proof than before — the price engine added prices and altered
// NOTHING else about these runs, byte for byte. The full-state hashes are pinned
// separately beside them so a future drift in the price numbers themselves is caught.
//
// LICENCE SLICE 3a (26-08-26): the COMMITTED run's pre-change bytes no longer apply,
// and should not — this slice's whole purpose is that a committed delivery now PAYS
// (credits, ledger, and the sale record all move). GOLDEN_COMMITTED is therefore
// retired and its run is pinned on its post-Slice-3a bytes instead, with the credit
// movement asserted explicitly in the licence tests rather than implied by a hash.
// The UNLICENSED golden is untouched and is where the no-op proof now lives entirely:
// with no commitment there is no delivery, so there is no sale, so not one byte of a
// commitment-free run may move.
//
// PRODUCTION-HISTORY SLICE (28-08-26): the console's trend sparklines moved out of the
// browser and into stored state (`guild.productionHistory`, sim/history.js), so both
// runs legitimately gained real serialized bytes and their FULL hashes moved. The three
// hashes above are UNCHANGED and are now asserted with the history stripped as well —
// which is the whole proof, and a stronger statement than a re-pinned number: this slice
// added a history buffer and altered NOTHING else about these runs, byte for byte. The
// new full-state hashes are pinned beside them so a drift in the recorded samples
// themselves is caught too. (`GOLDEN_UNLICENSED_WITH_PRICES` is now the price-inclusive,
// history-stripped hash — i.e. it still covers exactly what it covered before.)
//
// PRICE-HISTORY SLICE (29-08-26): `state.priceHistory` (sim/price-history.js) records the
// posted value into three coarsening rings, so both 40-tick runs cross the fine bucket at
// ticks 15 and 30 and legitimately gained bytes — their FULL hashes moved again. Same
// method, and it is the proof: the five hashes above are ALL UNCHANGED and are now
// asserted with the price history stripped too, so this slice added a price-history ring
// and altered NOTHING else about these runs, byte for byte. The new full hashes are
// pinned beside them. (A run SHORTER than 15 ticks takes no sample at all and is byte-
// identical with nothing stripped — which is why persist.test.js's 2-tick golden did not
// move and needed no regen.)
// FUEL SLICE 5a (31-08-26): fuel finally MOVES. At every window boundary the abstracted
// influx MINTS `DEUTERIUM_INFLUX_PER_CYCLE` into the Syndicate pool (recorded in
// `audit.totalProduced`) and issuance TRANSFERS a grant from that pool into each guild's
// hoard. The COMMITTED run is on `windowN = 4`, so its 40 ticks cross ten boundaries and
// its three goldens legitimately moved — the first time a commitment-scaffold golden has
// moved for anything but its own subject. They are re-pinned above, and the pre-slice
// values kept beside them, because a re-pinned number on its own proves nothing: the
// `withoutFuelFlows` test below UNDOES the fuel and asserts the OLD hashes come back, so
// the delta is proven to be **exactly** the pool, the audit and the granted fuel and
// nothing else.
//
// THE UNLICENSED GOLDENS DID NOT MOVE, AND THAT IS ITSELF A PROOF. `sysState` leaves
// `windowN` unset, so that run is on the 1,440-tick default and its 40 ticks cross NO
// boundary — no influx, no issuance, not one byte. Nothing happens off a boundary.
const GOLDEN_UNLICENSED = '682e42e0dd758ce523fea882f6560707802cdd7e7b4def794f323430a4cfcff5';
const GOLDEN_UNLICENSED_WITH_PRICES = 'ee6856cc520c23b8cc2cfdad996d463ccf35d40bb6b85b35f3a644a46d493647';
const GOLDEN_COMMITTED_WITH_PRICES = '7746582b575acf4b1e239e255317dedc9655957e15187cbb7e9e0a6e86e22dbf';
// The three values the COMMITTED goldens held before fuel slice 5a, kept so the
// un-flow proof below has something to prove against.
const COMMITTED_WITH_PRICES_BEFORE_FUEL_FLOWS = 'e0255c73292645b5b785d818ec6e045f4bfb80e4b0a12f38814acb74947f8272';
const GOLDEN_UNLICENSED_WITH_HISTORY = 'fa63aaf4cdaf8f11a38d26545f610605373acb659903fc2bf56c7869ced2dd5d';
const GOLDEN_COMMITTED_WITH_HISTORY = 'd2cbb89b17224e20eb60af7e30d55e4142dd468edef97bc9446bdd1b829eae8c';
const COMMITTED_WITH_HISTORY_BEFORE_FUEL_FLOWS = 'e145b1426637f5c53190c087a7b6727878d158d6d52715f57f879a43d367f30b';
const GOLDEN_UNLICENSED_WITH_PRICE_HISTORY = '2415bafdf6336b48a68d57b3b75e3c0c1cf254c93367a58bc48df82cd963c0c6';
const GOLDEN_COMMITTED_WITH_PRICE_HISTORY = '33021945d4660c785d2f287ba5a6c9cdb5385d541f9a4912e57fb8966ecf7d9b';
const COMMITTED_WITH_PRICE_HISTORY_BEFORE_FUEL_FLOWS = 'ab265ad191810bf91be169349ef6cc1b5c3c6e8a7bd9de5b64fd6533e80fbc3f';

// The state minus its price block — everything the pre-price-engine hash covered.
const withoutPrices = (state) => { const { prices, ...rest } = state; return rest; };
// The state minus every guild's production-history buffer — everything the pre-history
// hashes covered. Stripped per guild (it is guild-level state), leaving the rest of the
// guild row untouched, so an accidental change ANYWHERE else still fails the assertion.
const withoutHistory = (state) => ({
  ...state,
  guilds: (state.guilds || []).map((g) => { const { productionHistory, ...rest } = g; return rest; }),
});
// The state minus the price-history rings — everything the three hashes above covered
// before the price-history slice. Stripped at the TOP level, because unlike the
// production history this is global state (the posted price is galaxy-wide), and
// leaving every other top-level key in place so a change anywhere else still fails.
const withoutPriceHistory = (state) => { const { priceHistory, ...rest } = state; return rest; };

test('NO-OP PROOF: an unlicensed run (no scaffold action) is byte-identical to pre-change HEAD', () => {
  let s = sysState([mine('t', 'titanium', 10, 0), mine('c', 'carbon_products', 10, 0), refinery('r', 'titanium_alloy', 2)]);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  assert.equal(hashState(withoutPriceHistory(withoutHistory(withoutPrices(s)))), GOLDEN_UNLICENSED, 'everything but the price block and the two history buffers is byte-identical to pre-change HEAD');
  assert.equal(hashState(withoutPriceHistory(withoutHistory(s))), GOLDEN_UNLICENSED_WITH_PRICES, 'and with prices back in, the ONLY delta from the pre-history engine is productionHistory');
  assert.equal(hashState(withoutPriceHistory(s)), GOLDEN_UNLICENSED_WITH_HISTORY, 'and with the production history back in, the ONLY delta from the pre-price-history engine is priceHistory');
  assert.equal(hashState(s), GOLDEN_UNLICENSED_WITH_PRICE_HISTORY, 'and the price-history rings themselves are pinned');
  // The stripped-equals-old assertions above are only a proof if there is really
  // something to strip: an unlicensed run still MINES, so it still records history —
  // and 40 ticks crosses the fine bucket twice, so it really did record prices too.
  assert.ok(s.guilds[0].productionHistory, 'the unlicensed run really did record history');
  assert.equal(s.priceHistory.titanium.fine.length, 2, 'and the fine ring really has the samples from ticks 15 and 30');
});

test('a committed run seeded via createVenture (not the action) is pinned, and now PAYS', () => {
  // The commitment/windowN are fed in the OLD way (createVenture param + scenario
  // windowN), never through the new actions — so the windowed engine path is
  // exercised yet the bytes are identical to HEAD, proving the actions changed only
  // the intake surface, not the resolution.
  let s = sysState([mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 10, 5), refinery('r', 'titanium_alloy', 2)], 4);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  assert.equal(hashState(withoutPriceHistory(withoutHistory(s))), GOLDEN_COMMITTED_WITH_PRICES, 'with both history buffers stripped, the committed run is byte-identical to its post-Slice-3a bytes');
  assert.equal(hashState(withoutPriceHistory(s)), GOLDEN_COMMITTED_WITH_HISTORY, 'and with the production history back in, the ONLY delta is priceHistory');
  assert.equal(hashState(s), GOLDEN_COMMITTED_WITH_PRICE_HISTORY, 'and the price-history rings themselves are pinned');
  assert.equal(s.priceHistory.titanium.fine.length, 2, 'the stripped-equals-old proof is only a proof if there were samples to strip');
  // The bytes moved because the deliveries are now SALES: the guild has been paid and
  // the ledger has funded it, equal and opposite (invariant 2 is asserted every tick by
  // the driver; here we simply show the movement is real and is the sale's alone).
  assert.ok(s.guilds[0].credits > 0, 'the committed run earned credits from its deliveries');
  assert.equal(s.syndicate.ledger, -s.guilds[0].credits, 'every credit came out of the Syndicate ledger');
  assert.equal(s.guilds[0].lastSyndicateSale.credited > 0, true, 'and the sale is on the record');
});

// The fuel slice's own delta proof — the strip-and-prove idiom INVERTED, exactly as fuel
// Slice 1 inverted it, because changed VALUES cannot be stripped the way an added key can.
// Undo the four things slice 5a moved and the three pre-slice hashes must come back, byte
// for byte. If this slice moved ONE other number, this goes red.
test('no-op proof: undo the fuel flows and the pre-slice COMMITTED goldens come back', () => {
  let s = sysState([mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 10, 5), refinery('r', 'titanium_alloy', 2)], 4);
  for (let i = 0; i < 40; i += 1) s = tick(s);

  const g = s.guilds[0];
  const BOUNDARIES = 40 / 4;
  const minted = BOUNDARIES * DEUTERIUM_INFLUX_PER_CYCLE;

  // The flows really happened — otherwise "undo them and nothing changed" is vacuous.
  assert.equal(s.audit.totalProduced, minted, 'ten boundaries minted ten cycles of influx');
  assert.ok(g.fuelHoard > 0, 'and the guild really was granted fuel');
  assert.ok(s.reserve.reserveLevel > 0, 'with the rest still in the pool');
  assert.ok(g.lastFuelGrant, 'and the grant is on the record');
  // INVARIANT 1, by hand, at the end of the run: everything minted is still somewhere.
  assert.equal(s.audit.totalProduced - s.audit.totalConsumed, s.reserve.reserveLevel + g.fuelHoard,
    'conservation: produced − consumed == pool + Σ hoards');

  const granted = g.fuelHoard;
  const undone = structuredClone(s);
  undone.reserve.reserveLevel -= minted - granted;      // the pool back to the fixture's 0
  undone.audit.totalProduced -= minted;                 // the mint un-minted
  undone.guilds[0].fuelHoard -= granted;                // the transfer un-transferred
  delete undone.guilds[0].lastFuelGrant;                // the record un-recorded
  undone.galacticSupply.fuel.reserve -= minted - granted;
  undone.galacticSupply.fuel.guildHeld -= granted;

  assert.equal(undone.reserve.reserveLevel, 0, 'the undo really does return the fixture pool');
  assert.equal(undone.audit.totalProduced, 0);
  assert.equal(undone.guilds[0].fuelHoard, 0);

  assert.equal(hashState(withoutPriceHistory(withoutHistory(undone))), COMMITTED_WITH_PRICES_BEFORE_FUEL_FLOWS,
    'with the fuel undone, the pre-slice committed bytes come straight back');
  assert.equal(hashState(withoutPriceHistory(undone)), COMMITTED_WITH_HISTORY_BEFORE_FUEL_FLOWS);
  assert.equal(hashState(undone), COMMITTED_WITH_PRICE_HISTORY_BEFORE_FUEL_FLOWS,
    'so the ONLY delta this slice made to this run is the pool, the audit and the granted fuel');
});
