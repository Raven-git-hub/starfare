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
const { REFERENCE_FUEL_PRICE } = require('../fuel.js');
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
const GOLDEN_COMMITTED_WITH_PRICES = '3390c1b1fdb87b3c1b19e832c74a7a915c44e102bfca4a1dcfd1f216c7510ff2';
// The three values the COMMITTED goldens held before fuel slice 5a, kept so the
// un-flow proof below has something to prove against.
const COMMITTED_WITH_PRICES_BEFORE_FUEL_FLOWS = 'e0255c73292645b5b785d818ec6e045f4bfb80e4b0a12f38814acb74947f8272';
const GOLDEN_UNLICENSED_WITH_HISTORY = 'fa63aaf4cdaf8f11a38d26545f610605373acb659903fc2bf56c7869ced2dd5d';
const GOLDEN_COMMITTED_WITH_HISTORY = '06d2071bb5c3c186c2a74e886e1a3448046c375474622548af61d16acfe51da3';
const COMMITTED_WITH_HISTORY_BEFORE_FUEL_FLOWS = 'e145b1426637f5c53190c087a7b6727878d158d6d52715f57f879a43d367f30b';
const GOLDEN_UNLICENSED_WITH_PRICE_HISTORY = '2415bafdf6336b48a68d57b3b75e3c0c1cf254c93367a58bc48df82cd963c0c6';
const GOLDEN_COMMITTED_WITH_PRICE_HISTORY = 'a1048545e8f7bb78c11b3c5bf1b97491944511c4e6cd0a9c8ab5b67dd150f3e2';
const COMMITTED_WITH_PRICE_HISTORY_BEFORE_FUEL_FLOWS = 'ab265ad191810bf91be169349ef6cc1b5c3c6e8a7bd9de5b64fd6533e80fbc3f';

// FUEL PRICE MEDIATION (01-09-26, slice 5b-i — docs/fuel-supply-and-allocation.md §4.2).
// The reserve gains `fuelPrice`, the galaxy's ONE market price of `deuterium_fuel` — real
// serialized state, because 5b-ii's controller has to move it cycle to cycle. So the FULL
// hashes of both runs moved, and this time the ORDINARY strip works: the slice adds a key
// rather than changing a value. ALL EIGHT hashes above are UNCHANGED and are now asserted
// with the price stripped, which is the whole proof and a stronger claim than a re-pin —
// this slice added one field and moved NOT ONE GAME NUMBER. In particular the COMMITTED
// run crosses ten boundaries and issues ten cycles of grants, and its granted fuel is
// byte-identical: the grant now passes through the price, but the price is seeded AT the
// reference the grant is calibrated at, so the conversion is exactly ×1.0. The two new
// full-state hashes are pinned below so a drift in the price itself is caught too.
const GOLDEN_UNLICENSED_WITH_FUEL_PRICE = 'a1ce79e59803fac06442190980983d844cf0aec84143699f86dda7ab4aa73342';
// (its pre-controller value was 25698f31…, kept in the note above as one of the three)
const GOLDEN_COMMITTED_WITH_FUEL_PRICE = 'a8d5307368073255ed08ccd1ceb1ef2ae0dcacaabcd7a33a5af275b690312637';

// ⚠ THE FUEL PRICE CONTROLLER (01-09-26, slice 5b-ii — §4.2). THIS IS THE FIRST SLICE IN
// THIS FILE'S HISTORY WHOSE COMMITTED GOLDENS MOVED FOR A REAL BEHAVIOUR CHANGE RATHER THAN
// FOR AN ADDED FIELD, AND THAT IS CORRECT — it is the whole point of the slice. Two things
// happened at once, and they are pinned separately so they cannot hide behind each other:
//
//   1. AN ADDED KEY. The reserve gains `avgDraw`. Like `fuelPrice` before it this is real
//      serialized state, so both runs' FULL hashes moved for that reason alone, and the
//      ordinary strip handles it: `withoutControllerState` takes both fields out.
//   2. A CHANGED TRAJECTORY, on the COMMITTED run only. It runs `windowN` 4, so its 40 ticks
//      cross TEN cycle boundaries, and at the end of each the controller now posts a new
//      price. Every grant after the first is therefore a different number, the pool follows
//      a different path, and the three stripped COMMITTED hashes MOVED. They are re-pinned
//      below with the pre-controller values kept beside them.
//
// ⚠ AND THE UNLICENSED RUN'S FOUR STRIPPED HASHES DID NOT MOVE, WHICH IS ITSELF THE PROOF
// THAT NOTHING INCIDENTAL CHANGED. `sysState` leaves `windowN` unset, so that run is on the
// 1,440-tick default and its 40 ticks cross NO boundary: no influx, no issuance, no
// controller. Not one byte of it moved beyond the added key. A slice that had touched
// anything outside step 6's boundary block would have shown up there and nowhere else.
const GOLDEN_UNLICENSED_WITH_CONTROLLER = 'dce841fcc12142222713220f37d068b22a9ca8fb15c013d7dc6518ede74d97dd';
const GOLDEN_COMMITTED_WITH_CONTROLLER = 'adbd78a9978cc5db095033c1de5762fb92de9907ca88b58d5f839dd8c9f8ae8e';
// The three values the COMMITTED goldens held under 5b-i — i.e. with the price present but
// FROZEN at the reference. Kept so the re-pinning above is a comparison rather than an
// assertion, and so the test below can show the delta is the controller and nothing else.
const COMMITTED_WITH_PRICES_BEFORE_CONTROLLER = '7746582b575acf4b1e239e255317dedc9655957e15187cbb7e9e0a6e86e22dbf';
const COMMITTED_WITH_HISTORY_BEFORE_CONTROLLER = 'd2cbb89b17224e20eb60af7e30d55e4142dd468edef97bc9446bdd1b829eae8c';
const COMMITTED_WITH_PRICE_HISTORY_BEFORE_CONTROLLER = '33021945d4660c785d2f287ba5a6c9cdb5385d541f9a4912e57fb8966ecf7d9b';

// ── THE GUILD HALL ENGINE FIELDS (02-09-26 — docs/guild-hall.md §4, slices A/B/C) ──
//
// THE COMMITTED RUN'S FULL HASH MOVED; ALL FIVE STRIPPED COMMITTED GOLDENS ABOVE, AND ALL
// SIX UNLICENSED GOLDENS, DID NOT — and that split is the proof, not the re-pinning. The
// slice ADDS three per-guild fields, all stamped at the cycle boundary in step 6 under the
// SAME `desired > 0` sparsity the grant record already uses: `fuelHoardAtCycleStart` (A, the
// post-grant hoard), a `modifier` on `lastFuelGrant` (B, the modifier that drove the grant),
// and a `modifierHistory` ring (C, one sample per cycle). Because they are ADDED KEYS, the
// ordinary strip works: `withoutGuildHall` takes all three back out, and every one of the
// five committed hashes above returns byte-for-byte — this slice touched no grant, no hoard,
// no pool, no price, no window, no reputation, only these three new fields. The one new hash
// below pins the full state so a drift in the fields themselves is caught too.
//
// WHY THE COMMITTED RUN GAINED THEM AND THE UNLICENSED ONE DID NOT: the committed run is on
// `windowN = 4`, so its 40 ticks cross TEN boundaries and its guild is DUE a grant at each,
// so the fields are stamped. `sysState` leaves the unlicensed run's `windowN` unset — the
// 1,440-tick default — so its 40 ticks cross NO boundary, no grant is due, and no field is
// minted: it stays byte-identical, and its guild carries none of the three keys (asserted in
// the no-op test above). Nothing happens off a boundary.
const GOLDEN_COMMITTED_WITH_GUILD_HALL = '6efcbecc2ba0c55d6933167e313ad28ce7e346cf2715bca0413ed72dce42d211';
// §8.1 QUOTE-LOCK — THE PER-TICK PRICE RING (04-09-26). Both runs gain the always-on
// `priceRing` (sim/price-ring.js), so BOTH full hashes moved and the ordinary strip
// works: `withoutPriceRing` takes the added field back out and both GUILD_HALL goldens
// above return byte-for-byte — the whole delta. A 40-tick run fills the ring to its
// RING_DEPTH (6) most-recent posted values. Neither run's OTHER bytes moved (the ring is
// independent serialized state), which is why every stripped golden above is unchanged.
const GOLDEN_UNLICENSED_WITH_PRICE_RING = '81c78851173cb82a7bf27d7bb152d292a3f7a709abbe95f9ee91cf76b55dd888';
const GOLDEN_COMMITTED_WITH_PRICE_RING = 'a55a5efcaa11e6b743011d0c59f79d602dbe61f921fdcdfaebf7be0036068447';

// ── SLICE A′ — STAMP `fuelHoardAtCycleStart` AT FOUNDING (03-09-26 — docs/guild-hall.md §4) ──
//
// THE UNLICENSED RUN'S FULL HASH MOVED; THE COMMITTED RUN'S DID NOT — the mirror image of the
// A/B/C split above, and that inversion is the proof. Slice A now stamps `fuelHoardAtCycleStart`
// at CREATION too (= the guild's opening `fuelHoard`), not only at a boundary. So:
//   - The UNLICENSED run crosses NO boundary, so before A′ its guild carried no such key at all;
//     now it carries `fuelHoardAtCycleStart: 0` (its opening hoard) from creation. That ONE added
//     key is the whole delta — `withoutGuildHall` strips it and every pre-A′ unlicensed hash
//     returns byte-for-byte, so its full hash is re-pinned below on its post-A′ bytes.
//   - The COMMITTED run crosses ten boundaries, so its guild was RE-STAMPED at each — the founding
//     value (0) is overwritten at the first boundary and the field ends at the same post-grant
//     hoard it held before A′. Canonical serialization sorts keys, so insertion order does not
//     matter: `GOLDEN_COMMITTED_WITH_GUILD_HALL` is UNCHANGED and needs no regen (asserted below,
//     untouched). A′ moved the field's BIRTH, not its boundary value.
const GOLDEN_UNLICENSED_WITH_GUILD_HALL = 'a4401e956b7efeccaa0fc4289b2ba17a9858d2edf60a4572b415aaf1e40ddeb6';

// ── THE REPUTATION RESCALE (01-09-26, slice 1 of 2 — points-and-reputation.md §2.6) ──
//
// ALL FIVE COMMITTED GOLDENS MOVED. ALL SIX UNLICENSED GOLDENS DID NOT — and, exactly as
// with 5b-ii above, that split is the proof rather than the re-pinning.
//
// WHY THE COMMITTED RUN MOVED, AND FOR ONE REASON ONLY: **the tier-2 re-weighting.** The
// rescale is a re-denomination everywhere else — the GP weights went ×16.67 and
// `BASE_GRANT_PER_GP` was re-based 5 → 0.3 by exactly the reciprocal, so a held system and
// a tier-1 mine draw the fuel they always drew, to the unit. What is NOT reciprocal is the
// deliberately widened tier spread (§2.6: 6 : 8 → 100 : 150). This guild is two mines and
// ONE REFINERY, so its GP went 2×6 + 8 = 20 → 2×100 + 150 = 350, and its entitlement at
// par 5×20 = 100 → 0.3×350 = 105. Five more fuel a cycle, all of it the refinery's raise,
// across ten boundaries — which then walks the pool and the controller's price down a
// different path, so the whole trajectory differs.
//
// NO REPUTATION MOVED IN THIS RUN, which is worth stating because it is the surprising
// half: these ventures carry a raw `syndicateCommitment` and no `licence`, so the fee loop
// never judges them and `metGain` / `breachPenalty` are never called. The rescaled RP
// constants reach this fixture not at all. The runs that DO move reputation are in
// reputation.test.js, where the numbers are asserted directly rather than hashed.
//
// AND THE UNLICENSED RUN IS UNTOUCHED because it crosses no boundary: no issuance, so its
// identical GP change reaches no byte. A rescale that had leaked outside issuance and the
// licence layer would have shown up there.

// The state minus the reserve's fuel price — everything the eight hashes above covered
// before slice 5b-i. Stripped INSIDE `reserve`, leaving `reserveLevel` in place, so a
// change to the pool (or to anything else) still fails the assertion.
const withoutFuelPrice = (state) => {
  const { fuelPrice, ...reserve } = state.reserve;
  return { ...state, reserve };
};
// …and the controller's demand average, one slice later (5b-ii).
const withoutAvgDraw = (state) => {
  const { avgDraw, ...reserve } = state.reserve;
  return { ...state, reserve };
};
// The two together — the whole of what the reserve gained across 5b.
const withoutControllerState = (state) => withoutAvgDraw(withoutFuelPrice(state));
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
// The state minus the three GUILD HALL engine fields (02-09-26, docs/guild-hall.md §4,
// slices A/B/C) — everything the eleven hashes above covered before this slice. All three
// are ADDED keys, so the ordinary strip works: per guild, drop `fuelHoardAtCycleStart`
// (Slice A) and `modifierHistory` (Slice C), and drop `modifier` from inside `lastFuelGrant`
// (Slice B) while keeping the rest of the record. Leaving every other byte of the guild in
// place is what makes the ten unchanged hashes below a proof that ONLY these three fields
// moved — this slice stamped three per-guild fields at the boundary and altered NOTHING
// else about the committed run, byte for byte.
const withoutGuildHall = (state) => ({
  ...state,
  guilds: (state.guilds || []).map((g) => {
    const { fuelHoardAtCycleStart, modifierHistory, lastFuelGrant, ...rest } = g;
    if (!lastFuelGrant) return rest;
    const { modifier, ...grant } = lastFuelGrant;
    return { ...rest, lastFuelGrant: grant };
  }),
});
// The state minus the §8.1 quote-lock's per-tick price ring (04-09-26, sim/price-ring.js)
// — everything the hashes above covered before that slice. An ADDED top-level field, so
// the ordinary strip works: peel it and every golden above returns byte-for-byte, the
// proof it moved nothing else. Both the unlicensed and committed 40-tick runs fill the
// ring to its RING_DEPTH (6) of the most recent posted values, deterministically.
const withoutPriceRing = (state) => { const { priceRing, ...rest } = state; return rest; };

test('NO-OP PROOF: an unlicensed run (no scaffold action) is byte-identical to pre-change HEAD', () => {
  let s = sysState([mine('t', 'titanium', 10, 0), mine('c', 'carbon_products', 10, 0), refinery('r', 'titanium_alloy', 2)]);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  // §8.1 (04-09-26): the always-on `priceRing` is the OUTERMOST strip now — `bare` folds it
  // in with the Guild Hall strip so every earlier golden returns byte-for-byte.
  const bare = (x) => withoutPriceRing(withoutGuildHall(x));
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(withoutHistory(withoutPrices(s)))))), GOLDEN_UNLICENSED, 'everything but the price block, the two history buffers, the fuel price, the Guild Hall fields and the price ring is byte-identical to pre-change HEAD');
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(withoutHistory(s))))), GOLDEN_UNLICENSED_WITH_PRICES, 'and with prices back in, the ONLY delta from the pre-history engine is productionHistory');
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(s)))), GOLDEN_UNLICENSED_WITH_HISTORY, 'and with the production history back in, the ONLY delta from the pre-price-history engine is priceHistory');
  assert.equal(hashState(bare(withoutControllerState(s))), GOLDEN_UNLICENSED_WITH_PRICE_HISTORY, 'and with the price-history rings back in, the ONLY delta from the pre-5b-i engine is the two reserve fields');
  assert.equal(hashState(bare(withoutAvgDraw(s))), GOLDEN_UNLICENSED_WITH_FUEL_PRICE, 'with the price back in, the ONLY delta from the pre-5b-ii engine is reserve.avgDraw');
  assert.equal(hashState(bare(s)), GOLDEN_UNLICENSED_WITH_CONTROLLER, 'and with the controller state back in, stripping the Guild Hall fields and the price ring returns the pre-Guild-Hall bytes');
  assert.equal(hashState(withoutPriceRing(s)), GOLDEN_UNLICENSED_WITH_GUILD_HALL, 'and with the Guild Hall fields back in, stripping only the price ring returns the pre-quote-lock bytes');
  assert.equal(hashState(s), GOLDEN_UNLICENSED_WITH_PRICE_RING, 'and the full state — with the §8.1 quote-lock ring — is pinned');
  // ⚠ THE LOAD-BEARING PART. This run crosses NO boundary, so the controller never ran —
  // which is why every hash above it held while the committed run's moved. If the price or
  // the average had moved here, slice 5b-ii would have reached somewhere it must not.
  assert.equal(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'the price never moved: no boundary, no controller');
  assert.equal(s.reserve.avgDraw, DEUTERIUM_INFLUX_PER_CYCLE, 'and neither did the demand average');
  // The stripped-equals-old assertions above are only a proof if there is really
  // something to strip: an unlicensed run still MINES, so it still records history —
  // and 40 ticks crosses the fine bucket twice, so it really did record prices too.
  assert.ok(s.guilds[0].productionHistory, 'the unlicensed run really did record history');
  assert.equal(s.priceHistory.titanium.fine.length, 2, 'and the fine ring really has the samples from ticks 15 and 30');
  // And the Guild Hall no-op: crossing no boundary, this run was never due a grant, so the
  // BOUNDARY-only fields (B, C, and A's re-stamp) were never minted. Slice A′ (03-09-26) does
  // stamp `fuelHoardAtCycleStart` at CREATION, so it is present at its opening hoard (0) — the
  // one field the full hash above gained, and exactly what `withoutGuildHall` strips back out.
  assert.equal(s.guilds[0].fuelHoardAtCycleStart, 0, 'Slice A′ stamped the founding hoard (0) at creation; the boundary never re-stamped it');
  assert.equal(s.guilds[0].modifierHistory, undefined, 'Slice C minted nothing off a boundary');
  assert.equal(s.guilds[0].lastFuelGrant, undefined, 'and there is no grant record to carry Slice B');
});

test('a committed run seeded via createVenture (not the action) is pinned, and now PAYS', () => {
  // The commitment/windowN are fed in the OLD way (createVenture param + scenario
  // windowN), never through the new actions — so the windowed engine path is
  // exercised yet the bytes are identical to HEAD, proving the actions changed only
  // the intake surface, not the resolution.
  let s = sysState([mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 10, 5), refinery('r', 'titanium_alloy', 2)], 4);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  // The Guild Hall fields (§4 A/B/C) are the OUTERMOST strip now: peel them and every earlier
  // committed golden returns byte-for-byte, which is the proof that they are this slice's ONLY
  // delta to this run. `bare` composes that strip with each earlier one, exactly as before.
  // §8.1 (04-09-26): the always-on `priceRing` is the OUTERMOST strip now — `bare` folds it
  // in with the Guild Hall strip so every earlier committed golden returns byte-for-byte.
  const bare = (x) => withoutPriceRing(withoutGuildHall(x));
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(withoutHistory(s))))), GOLDEN_COMMITTED_WITH_PRICES, 'with the price ring, the Guild Hall fields, both history buffers and the controller state stripped, the committed run is pinned on its post-5b-ii bytes');
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(s)))), GOLDEN_COMMITTED_WITH_HISTORY, 'and with the production history back in, the ONLY delta is priceHistory');
  assert.equal(hashState(bare(withoutControllerState(s))), GOLDEN_COMMITTED_WITH_PRICE_HISTORY, 'and with the price-history rings back in, the deltas are the two reserve fields');
  assert.equal(hashState(bare(withoutAvgDraw(s))), GOLDEN_COMMITTED_WITH_FUEL_PRICE, 'with the price back in, the remaining delta is reserve.avgDraw');
  assert.equal(hashState(bare(s)), GOLDEN_COMMITTED_WITH_CONTROLLER, 'and with the controller state back in, the ONLY delta from the pre-Guild-Hall engine is the three §4 fields');
  assert.equal(hashState(withoutPriceRing(s)), GOLDEN_COMMITTED_WITH_GUILD_HALL, 'and with the Guild Hall fields back in, stripping only the price ring returns the pre-quote-lock bytes');
  assert.equal(hashState(s), GOLDEN_COMMITTED_WITH_PRICE_RING, 'and the full state, price ring included, is pinned');
  // The strip is only a proof if there was really something to strip: the committed run is due
  // a grant at each of its ten boundaries, so its guild really did gain all three §4 fields.
  const gh = s.guilds[0];
  assert.equal(typeof gh.fuelHoardAtCycleStart, 'number', 'Slice A: the start-of-cycle hoard was stamped');
  assert.equal(typeof gh.lastFuelGrant.modifier, 'number', 'Slice B: the grant carries the modifier that drove it');
  assert.equal(gh.modifierHistory.length, 10, 'Slice C: one modifier sample per boundary, ten boundaries');
  // ⚠ WHY THESE THREE MOVED, stated rather than left to a re-pinned number. This run crosses
  // ten cycle boundaries, so the controller ran ten times and posted a new price each time —
  // every grant after the first is a different number, and the pool followed a different
  // path. That is the behaviour change 5b-ii exists to make, and it must be visible here.
  assert.notEqual(hashState(withoutControllerState(withoutPriceHistory(withoutHistory(s)))),
    COMMITTED_WITH_PRICES_BEFORE_CONTROLLER,
    'the committed run genuinely changed — it is not a re-pin of the same bytes');
  assert.notEqual(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'because the price really moved');
  assert.notEqual(s.reserve.avgDraw, DEUTERIUM_INFLUX_PER_CYCLE, 'and the demand average with it');
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

  // The Guild Hall fields (§4 A/B/C) were stamped at every boundary too, so they are stripped
  // here alongside the fuel undo — the pre-5a goldens predate them entirely. `withoutGuildHall`
  // also drops the now-absent `lastFuelGrant` cleanly (the undo already deleted it above).
  // The §8.1 price ring is stripped here alongside the Guild Hall fields — an added field
  // that predates none of the pre-5a goldens, so it comes back out with the rest.
  const bare = (x) => withoutPriceRing(withoutGuildHall(x));
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(withoutHistory(undone))))), COMMITTED_WITH_PRICES_BEFORE_FUEL_FLOWS,
    'with the fuel, the Guild Hall fields and the price ring undone, the pre-slice committed bytes come straight back');
  assert.equal(hashState(bare(withoutControllerState(withoutPriceHistory(undone)))), COMMITTED_WITH_HISTORY_BEFORE_FUEL_FLOWS);
  assert.equal(hashState(bare(withoutControllerState(undone))), COMMITTED_WITH_PRICE_HISTORY_BEFORE_FUEL_FLOWS,
    'so the ONLY delta these slices made to this run is the pool, the audit, the granted fuel, the three §4 fields and the price ring');

  // ⚠ AND IT STILL HOLDS AFTER SLICE 5b-ii, WHICH IS WORTH MORE THAN IT LOOKS. The
  // controller changed HOW MUCH fuel this run moves — the price falls to the floor here, so
  // the guild draws several times what it drew under a frozen price — and yet subtracting
  // exactly the fuel that moved still lands on the pre-5a bytes. That is a strong statement
  // that the controller touched the fuel FLOWS and nothing else: had it disturbed a
  // stockpile, a credit, a window or a reputation, no amount of un-granting fuel would
  // recover this hash. The undo is written against `g.fuelHoard` rather than a pinned
  // number precisely so it keeps making that claim as the trajectory changes.
  assert.ok(granted > 300,
    `the controller really did change the trajectory (${granted} granted, against 300 under a frozen price)`);
  assert.notEqual(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'because the price moved off the reference');
});
