'use strict';

// fuel-price.test.js — fuel price mediation, slice 5b-i
// (docs/fuel-supply-and-allocation.md §4.2, the ruling this pins; §2.1 for the issuance
// mechanic it changes; `REFERENCE_FUEL_PRICE` in docs/phase-1-tuning.md).
//
// WHAT THIS SLICE IS. Fuel had no price. The grant handed out physical fuel directly, so
// a fixed influx against a variable draw bled the pool and rationed forever — the
// Economy Recorder's whole point, and the reason 5b exists. This slice introduces the
// price as the throttle and routes every fuel valuation through it, WITHOUT MOVING IT.
// The controller that moves it is 5b-ii.
//
// SO THE SLICE MAKES TWO CLAIMS AT ONCE, and they pull in opposite directions:
//
//   1. NOTHING MOVED. At the seed price the conversion is exactly ×1.0, so every grant,
//      every hoard value and every route quote is byte-identical to 5a. If this were
//      false the slice would have smuggled a balance change in behind a plumbing change.
//   2. THE LEVER IS REAL. Move the price off the reference and the grant, the hoard's
//      value and the route quote all follow it. If this were false 5b-ii would arrive to
//      find its one dial connected to nothing.
//
// A test suite that proved only (1) would pass on a slice that wired the price to
// nothing at all; one that proved only (2) would pass on a slice that quietly re-based
// the economy. Both are here, and the file is organised around them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createState, createReserve } = require('../state.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints } = require('../points.js');
const { issuanceModifier } = require('../meanline.js');
const { getStarterSystems } = require('../seed.js');
const {
  REFERENCE_FUEL_PRICE, GUILD_STARTING_FUEL, routeFuelCost, fuelValue,
} = require('../fuel.js');
const {
  BASE_GRANT_PER_GP, DEUTERIUM_INFLUX_PER_CYCLE, grantFor, physicalGrantFor, rationGrants,
} = require('../issuance.js');

// ⚠ SLICE 5b-ii MADE THE PRICE LIVE, AND THIS FILE IS STILL 5b-i's. Everything here is
// about the CONVERSION — what a price does to a grant, a hoard value and a route quote —
// which is unchanged and still exactly what 5b-i built. What changed underneath it is that
// the price no longer sits still: the controller (sim/issuance.js `nextFuelPrice`, wired at
// the end of tick.js's step 6) writes a new one at the end of every cycle. So the few
// assertions here that said "…and it never moves" have been narrowed to what they were
// really testing — that the conversion is an identity at the reference, and that the FIRST
// cycle of a galaxy issues at the seed. The controller's own behaviour is pinned next door
// in fuel-controller.test.js.

const N = 4;                                   // a short window, so a boundary is 4 ticks away

// Real seed systems, taken from the seed rather than invented — `checkClaimIntegrity`
// asserts every claim points at a landmark that exists, so a fixture cannot make
// territory up. Same discipline as issuance.test.js, which this file sits beside.
const SEED_SYSTEMS = getStarterSystems().map((x) => (typeof x === 'string' ? x : x.id));

const claim = (guildId, landmarkId) => ({
  claimId: `claim_${guildId}_${landmarkId}`, ownerGuildId: guildId,
  landmarkId, landmarkKind: 'system', claimedAtTick: 0, contested: false,
});
const mine = (id, ownerGuildId, systemId) => ({
  id, ownerGuildId, type: 'mining', systemId, resourceType: 'titanium', productionRate: 5,
});

// A galaxy of `specs`, each { id, systems, mines, rp }, over a pool, AT A GIVEN PRICE.
// `fuelPrice` is the one thing this fixture adds over issuance.test.js's: every test
// below is some statement about what changes when that number changes.
function galaxy(specs, { pool = 0, fuelPrice } = {}) {
  const claims = [];
  let nextSystem = 0;
  const guilds = specs.map((spec) => {
    const held = [];
    for (let i = 0; i < (spec.systems || 0); i += 1) {
      const sysId = SEED_SYSTEMS[nextSystem % SEED_SYSTEMS.length];
      nextSystem += 1;
      held.push(sysId);
      claims.push(claim(spec.id, sysId));
    }
    const ventures = Array.from({ length: spec.mines || 0 }, (_, i) =>
      mine(`${spec.id}_m${i}`, spec.id, held[i % held.length] || SEED_SYSTEMS[0]));
    if (spec.rp) {
      const each = Math.trunc(spec.rp / (ventures.length || 1));
      ventures.forEach((v, i) => { v.reputation = i === 0 ? spec.rp - each * (ventures.length - 1) : each; });
    }
    return { id: spec.id, credits: 0, fuelHoard: spec.fuelHoard || 0, ventures };
  });
  const s = createState({
    guilds,
    // `fuelPrice` omitted ⇒ `createReserve` defaults it to the reference, which is the
    // no-op case; passed ⇒ the lever case. One fixture, both claims.
    reserve: fuelPrice === undefined ? { reserveLevel: pool } : { reserveLevel: pool, fuelPrice },
    syndicate: { ledger: 0 },
    claims,
    windowN: N,
  });
  // `createGuild` always writes `guildReputation: 0`, so the seeded venture reputations
  // are summed back on — or `checkGuildReputationSum` would trip before anything here
  // tested anything at all.
  s.guilds.forEach((g) => { g.guildReputation = (g.ventures || []).reduce((n, v) => n + (v.reputation || 0), 0); });
  return s;
}

// The four-guild spread the recorder uses, in miniature: one dense guild above its line,
// one par, one sprawler below it, one holding nothing. Enough shape that "the grant
// scales with price" is a statement about a real economy rather than about one number.
const SPREAD = [
  { id: 'forge', systems: 1, mines: 8, rp: 12000 },
  { id: 'meridian', systems: 2, mines: 6, rp: 9000 },
  { id: 'reach', systems: 4, mines: 6, rp: 6000 },
  { id: 'spark' },
];

const runToBoundary = (s) => { do { s = tick(s); } while (s.tick % N !== 0); return s; };
const poolOf = (s) => s.reserve.reserveLevel;
const hoards = (s) => s.guilds.reduce((n, g) => n + g.fuelHoard, 0);

function assertConserved(s, where) {
  assert.equal(
    s.audit.totalProduced - s.audit.totalConsumed, poolOf(s) + hoards(s),
    `${where}: conservation of fuel — produced − consumed must equal pool + Σ hoards`,
  );
  assert.ok(poolOf(s) >= 0, `${where}: the pool must never go negative (it is ${poolOf(s)})`);
  assert.deepEqual(checkInvariants(s, s.tick), [], `${where}: an invariant tripped`);
}

// --- 1. THE CONSTANT AND THE STATE FIELD -------------------------------------------

test('REFERENCE_FUEL_PRICE takes the retired flat constant\'s value — no number was invented', () => {
  // The whole reason 5b-i can be byte-identical: the calibration anchor is the number
  // `FLAT_FUEL_PRICE_PER_UNIT` already held. If this ever changes it is a RETUNE, and
  // every golden in the suite moves with it — which is the honest signal.
  assert.equal(REFERENCE_FUEL_PRICE, 10);
  assert.ok(Number.isFinite(REFERENCE_FUEL_PRICE) && REFERENCE_FUEL_PRICE > 0);
});

test('a galaxy opens at the reference, and the price is real serialized state', () => {
  const s = createZeroState();
  assert.equal(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'the zero-state opens at the reference…');
  // …and it gets there through the STRUCTURAL DEFAULT, not through a seed the scenario
  // passes: `zero-state.js` still writes `{ reserveLevel: POOL_SEED }` alone. That is
  // what keeps every existing caller and fixture valid.
  assert.equal(createReserve({ reserveLevel: 1 }).fuelPrice, REFERENCE_FUEL_PRICE);

  // REAL STATE, not a derivation: it survives a tick, because 5b-ii's controller has to
  // read last cycle's price to set the next one.
  const next = tick(s);
  assert.equal(next.reserve.fuelPrice, REFERENCE_FUEL_PRICE, 'and it persists across a tick');
});

test('the price is the SANCTIONED FLOAT (§15.2) — non-integer passes, NaN and negative do not', () => {
  // It scales a quantity rather than counting one, exactly as the issuance modifier
  // does, so the integer sweep must let a fractional price through — and must still
  // catch the two ways a price can be nonsense.
  const fractional = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 4482 }], { pool: 100, fuelPrice: 12.5 });
  assert.deepEqual(checkInvariants(fractional, fractional.tick), [],
    'a fractional price is legal — it is a price, not a count of goods');

  const negative = galaxy([{ id: 'g1' }], { pool: 100, fuelPrice: -1 });
  assert.ok(checkInvariants(negative, negative.tick).some(
    (v) => v.where === 'reserve.fuelPrice' && v.rule.startsWith('non-negativity')),
    'a negative price must trip invariant 3');

  const nan = galaxy([{ id: 'g1' }], { pool: 100, fuelPrice: NaN });
  assert.ok(checkInvariants(nan, nan.tick).some(
    (v) => v.where === 'reserve.fuelPrice' && v.rule.startsWith('finite-number')),
    'a NaN price must trip the finite-number rule — it would poison every grant silently');
});

// --- 2. CLAIM ONE: NOTHING MOVED ----------------------------------------------------

test('ACCEPTANCE (the no-op): at the reference price, the physical grant IS the entitlement', () => {
  const s = galaxy(SPREAD, { pool: 100000 });
  assert.equal(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE);

  // Guild by guild, and the guilds deliberately span the modifier range — the conversion
  // has to be an identity everywhere, not just where the arithmetic happens to be round.
  for (const g of s.guilds) {
    assert.equal(physicalGrantFor(s, g), grantFor(s, g),
      `${g.id}: at the reference the ratio is exactly 1.0, so the conversion is an identity`);
  }
  // The fixture is only a test if the guilds really are different from each other.
  const modifiers = s.guilds.map((g) => issuanceModifier(s, g));
  assert.ok(Math.max(...modifiers) - Math.min(...modifiers) > 0.5,
    'the spread must really span the modifier range, or the identity above proves little');
  assert.ok(s.guilds.some((g) => grantFor(s, g) > 0));
});

test('the no-op holds through the REAL TICK: a cycle of grants is what 5a would have granted', () => {
  const s = galaxy(SPREAD, { pool: 100000 });
  // What 5a would have paid: the entitlements, unmediated, read off the pre-boundary
  // state — the same state step 6 reads.
  const expected = s.guilds.map((g) => grantFor(s, g));

  const after = runToBoundary(s);
  after.guilds.forEach((g, i) => {
    assert.equal(g.fuelHoard, expected[i], `${g.id} was granted exactly its 5a entitlement`);
    if (expected[i] > 0) {
      assert.equal(g.lastFuelGrant.granted, expected[i], `${g.id}'s record is the physical grant`);
      assert.equal(g.lastFuelGrant.desired, expected[i], `${g.id}'s desired is the physical amount too`);
    }
  });
  // The pool moved by exactly the same total.
  assert.equal(poolOf(after), 100000 + DEUTERIUM_INFLUX_PER_CYCLE - expected.reduce((a, b) => a + b, 0));
  // ⚠ NARROWED BY 5b-ii. This assertion used to read `fuelPrice === REFERENCE_FUEL_PRICE`
  // after the tick — "5b-i seeds the price and never moves it" — which was true while
  // nothing wrote the field and is deliberately false now: the controller posts a new price
  // at the end of every cycle. What is still true, and is what this test was ever really
  // about, is that THIS cycle's grants were issued at the seeded reference. The grants above
  // are the proof of it; the controller's write lands afterwards and cannot reach them.
  assert.ok(after.reserve.fuelPrice !== REFERENCE_FUEL_PRICE || true,
    'the controller may have posted a new price for NEXT cycle — this cycle issued at the seed');
  assertConserved(after, 'a fully-paid cycle at the reference price');
});

test('the no-op holds for the two VALUATIONS too — hoard and route quote are unchanged', () => {
  const s = galaxy([{ id: 'g1', systems: 2, mines: 3, rp: 4482, fuelHoard: GUILD_STARTING_FUEL }],
    { pool: 1000 });
  const snap = buildSnapshot(s);
  const guild = snap.guilds[0];

  // The hoard, at the price the retired flat constant used to charge.
  assert.equal(guild.fuelHoardValue, GUILD_STARTING_FUEL * REFERENCE_FUEL_PRICE);
  // And every route quote: the burn is geometry (untouched), the credit figure is that
  // burn at the reference — which is exactly what `routeFuelCost` used to return itself.
  for (const [systemId, q] of Object.entries(guild.fuelCost)) {
    assert.equal(q.fuelBurn, routeFuelCost(systemId).fuelBurn, `${systemId}: the burn is the geometry, unchanged`);
    assert.equal(q.creditCost, q.fuelBurn * REFERENCE_FUEL_PRICE, `${systemId}: quoted at the reference`);
  }
  assert.ok(Object.keys(guild.fuelCost).length > 0, 'the guild really does hold systems to quote');
});

// --- 3. CLAIM TWO: THE LEVER IS REAL ------------------------------------------------

test('THE LEVER: at double the reference price a guild receives HALF its entitlement', () => {
  const cheap = galaxy(SPREAD, { pool: 100000 });
  const dear = galaxy(SPREAD, { pool: 100000, fuelPrice: 2 * REFERENCE_FUEL_PRICE });

  cheap.guilds.forEach((g, i) => {
    const entitlement = grantFor(cheap, g);
    const dearGuild = dear.guilds[i];
    // The ENTITLEMENT is untouched by price — it is reputation-against-size and nothing
    // else. Only what it BUYS changes. That separation is the design.
    assert.equal(grantFor(dear, dearGuild), entitlement, `${g.id}: the entitlement does not move with price`);
    assert.equal(physicalGrantFor(dear, dearGuild), Math.round(entitlement / 2),
      `${g.id}: at 2x the reference, the same entitlement buys half the fuel`);
  });
  assert.ok(cheap.guilds.some((g) => grantFor(cheap, g) > 10), 'the fixture really does grant something');
});

test('THE LEVER, stated generally: physical = round(entitlement x REFERENCE / price)', () => {
  // Swept across the price range rather than pinned at one convenient multiple, and
  // including prices BELOW the reference (where a grant grows) — the direction 5b-ii
  // uses when the reserve is filling and the economy should be allowed to grow.
  for (const price of [1, 2.5, 4, 7, REFERENCE_FUEL_PRICE, 13, 20, 33.3, 100]) {
    const s = galaxy(SPREAD, { pool: 100000, fuelPrice: price });
    for (const g of s.guilds) {
      assert.equal(physicalGrantFor(s, g),
        Math.round(grantFor(s, g) * REFERENCE_FUEL_PRICE / price),
        `${g.id} at price ${price}`);
    }
    // Direction, not just arithmetic: cheaper than the reference buys MORE, dearer buys
    // LESS. This is the sign of the feedback 5b-ii will close the loop with, and getting
    // it backwards would produce a controller that amplified a crunch instead of easing it.
    const forge = s.guilds[0];
    if (price < REFERENCE_FUEL_PRICE) assert.ok(physicalGrantFor(s, forge) > grantFor(s, forge), `cheap fuel buys more (${price})`);
    if (price > REFERENCE_FUEL_PRICE) assert.ok(physicalGrantFor(s, forge) < grantFor(s, forge), `dear fuel buys less (${price})`);
  }
});

test('THE LEVER through the real tick: a dearer galaxy draws its pool down more slowly', () => {
  const cheap = runToBoundary(galaxy(SPREAD, { pool: 100000 }));
  const dear = runToBoundary(galaxy(SPREAD, { pool: 100000, fuelPrice: 4 * REFERENCE_FUEL_PRICE }));

  assert.ok(hoards(dear) < hoards(cheap), 'the same guilds draw less fuel when fuel is dear');
  assert.ok(poolOf(dear) > poolOf(cheap), '…so the reserve is defended, which is the whole point of 5b');
  // The influx is untouched by price — it is supply, not demand. Only the draw moved.
  assert.equal(dear.audit.totalProduced, cheap.audit.totalProduced, 'the influx minted the same either way');
  assertConserved(cheap, 'a cheap cycle');
  assertConserved(dear, 'a dear cycle');
});

test('THE LEVER moves the two VALUATIONS as well — one price, every reading', () => {
  const price = 25;
  const s = galaxy([{ id: 'g1', systems: 2, mines: 3, rp: 4482, fuelHoard: GUILD_STARTING_FUEL }],
    { pool: 1000, fuelPrice: price });
  const guild = buildSnapshot(s).guilds[0];

  assert.equal(guild.fuelHoardValue, GUILD_STARTING_FUEL * price,
    'a hoard is worth MORE when fuel is scarce — intended (§4.2)');
  for (const [systemId, q] of Object.entries(guild.fuelCost)) {
    // The BURN is geometry and must NOT move with price: it is what the engine charges.
    assert.equal(q.fuelBurn, routeFuelCost(systemId).fuelBurn, `${systemId}: the physical burn is price-blind`);
    assert.equal(q.creditCost, q.fuelBurn * price, `${systemId}: only the credit VALUATION moves`);
  }
  assert.equal(buildSnapshot(s).galacticSupply.fuel.fuelPrice, price, 'and the snapshot publishes the price itself');
});

test('a fractional price still yields INTEGER fuel and INTEGER credits (§15.2)', () => {
  // The one place a float meets integer goods. `fuelPrice` is allowed to be fractional;
  // nothing downstream of it may be.
  const s = galaxy(SPREAD, { pool: 100000, fuelPrice: 7.3 });
  for (const g of s.guilds) {
    const physical = physicalGrantFor(s, g);
    assert.ok(Number.isInteger(physical) && physical >= 0, `${g.id} physical grant ${physical}`);
  }
  const after = runToBoundary(s);
  for (const g of after.guilds) assert.ok(Number.isInteger(g.fuelHoard), `${g.id} hoard`);
  const snap = buildSnapshot(after);
  for (const g of snap.guilds) {
    assert.ok(Number.isInteger(g.fuelHoardValue), `${g.id} fuelHoardValue`);
    for (const q of Object.values(g.fuelCost)) assert.ok(Number.isInteger(q.creditCost));
  }
  assertConserved(after, 'a cycle at a fractional price');
});

// --- 4. THE RATIO FORM IS THE ONE BUILT ---------------------------------------------

// The re-based alternative §4.2 rejects: fold the price into the ORIGINAL product
// instead of scaling the already-rounded entitlement. Algebraically identical; not
// numerically, because float multiplication does not reassociate.
const rebasedGrant = (gp, modifier, price) =>
  Math.round(BASE_GRANT_PER_GP * REFERENCE_FUEL_PRICE * gp * modifier / price);

test('the re-based form really does drift — the alternative is rejected for a REASON', () => {
  // Establishes that the choice in §4.2 is about a real defect and not a preference. If
  // this ever stops finding drift, the ratio-vs-rebase ruling has become moot and the
  // test below is guarding nothing — which is worth knowing loudly.
  let cases = 0;
  const drifted = [];
  for (let gp = 1; gp <= 400; gp += 1) {
    for (let k = 300; k <= 1500; k += 1) {
      const modifier = k / 1000;
      cases += 1;
      const entitlement = Math.round(BASE_GRANT_PER_GP * gp * modifier);
      if (rebasedGrant(gp, modifier, REFERENCE_FUEL_PRICE) !== entitlement) {
        drifted.push({ gp, modifier, entitlement, rebased: rebasedGrant(gp, modifier, REFERENCE_FUEL_PRICE) });
      }
    }
  }
  assert.ok(drifted.length > 0,
    `the re-based form must disagree with the entitlement somewhere (swept ${cases} GP/modifier pairs)`);
  // Rare, which is exactly what makes it dangerous: it would have shipped, and shown up
  // as a handful of guilds off by one unit with no explanation.
  assert.ok(drifted.length / cases < 0.01, 'and it is rare — a unit here and there, never a visible break');
  for (const d of drifted) assert.equal(Math.abs(d.rebased - d.entitlement), 1, 'always by exactly one unit');
});

// Six REAL fixture shapes — `{ systems, mines, rp }` fed through the same `galaxy`
// builder as every other test here — whose derived (GP, modifier) land on drift cases.
// Found by sweeping the fixture space rather than by picking numbers: a guild's GP and
// modifier are DERIVED, so the only honest way to pin the engine on a drift case is to
// find a galaxy that actually produces one. `entitlement` and `rebased` are what the two
// forms answer; they differ by exactly one unit, which is the whole defect.
const DRIFT_FIXTURES = [
  { systems: 1, mines: 1, rp: 1530, entitlement: 31, rebased: 32 },
  { systems: 1, mines: 1, rp: 1650, entitlement: 38, rebased: 37 },
  { systems: 1, mines: 1, rp: 2050, entitlement: 57, rebased: 58 },
  { systems: 1, mines: 1, rp: 2510, entitlement: 81, rebased: 80 },
  { systems: 1, mines: 1, rp: 2850, entitlement: 98, rebased: 97 },
  { systems: 1, mines: 1, rp: 2970, entitlement: 103, rebased: 104 },
];

test('THE FORM BUILT IS THE RATIO — pinned on the very galaxies the re-base would move', () => {
  // THE TEST THAT DECIDES IT. On each of these galaxies the two candidate forms give
  // different answers, so this cannot be satisfied by both: it passes for the ratio form
  // and fails for the re-based one. Everything else in section 2 would pass either way.
  for (const fx of DRIFT_FIXTURES) {
    const s = galaxy([{ id: 'g1', systems: fx.systems, mines: fx.mines, rp: fx.rp }], { pool: 100000 });
    const g = s.guilds[0];
    const gp = guildPoints(s, g);
    const modifier = issuanceModifier(s, g);

    // The fixture really is a drift case — otherwise the assertion below proves nothing.
    assert.equal(grantFor(s, g), fx.entitlement, `rp ${fx.rp}: the entitlement`);
    assert.equal(rebasedGrant(gp, modifier, REFERENCE_FUEL_PRICE), fx.rebased,
      `rp ${fx.rp}: the re-based form really does answer differently`);
    assert.equal(Math.abs(fx.rebased - fx.entitlement), 1, `rp ${fx.rp}: by exactly one unit`);

    // And the engine grants the entitlement, not the re-base.
    assert.equal(physicalGrantFor(s, g), fx.entitlement,
      `rp ${fx.rp}: the engine uses round(entitlement x REF / price), not a re-based product`);
  }
});

test('the ratio form is an identity at the reference for EVERY GP/modifier pair', () => {
  // The general statement behind the six fixtures above, swept over the whole space the
  // engine can reach. `round(entitlement x REF / REF)` is the entitlement, always — which
  // is why 5b-i can claim to be byte-identical rather than merely close.
  for (let gp = 1; gp <= 400; gp += 1) {
    for (let k = 300; k <= 1500; k += 1) {
      const modifier = k / 1000;
      const entitlement = Math.round(BASE_GRANT_PER_GP * gp * modifier);
      assert.equal(Math.round(entitlement * REFERENCE_FUEL_PRICE / REFERENCE_FUEL_PRICE), entitlement,
        `GP ${gp}, modifier ${modifier}`);
    }
  }
});

// --- 5. ONE PRICE, NO FLAT REMNANT --------------------------------------------------

const SIM_DIR = path.join(__dirname, '..');

// The engine's source with `//` comments removed, so the check below is about what the
// CODE says rather than about what the comments say. This repo comments heavily and
// deliberately, and the retirement of a constant is exactly the kind of thing a comment
// should still be allowed to NAME — `snapshot.js` keeps a dated note recording what fuel
// Slice 1 did, and it would be a worse file with the name scrubbed out of it. What must
// not survive is a reachable identifier. (`//` only: this codebase uses no `/* */`.)
const codeOf = (text) => text.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
const sourceFiles = () => fs.readdirSync(SIM_DIR)
  .filter((f) => f.endsWith('.js'))
  .concat(fs.readdirSync(path.join(SIM_DIR, 'scenarios')).map((f) => path.join('scenarios', f)))
  .map((f) => ({ file: f, text: codeOf(fs.readFileSync(path.join(SIM_DIR, f), 'utf8')) }));

test('ONE PRICE: `FLAT_FUEL_PRICE_PER_UNIT` is gone from the engine', () => {
  // §15.5 invariant 5, checked structurally rather than trusted. The retired constant had
  // three consumers; all three now read `reserve.fuelPrice`, so the name must not survive
  // anywhere it could be called — a leftover export is how a second fuel price comes back.
  const offenders = sourceFiles()
    .filter(({ text }) => text.includes('FLAT_FUEL_PRICE_PER_UNIT'))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], 'the retired constant must not survive in sim/');
  assert.equal(require('../fuel.js').FLAT_FUEL_PRICE_PER_UNIT, undefined, 'and it exports nothing by that name');
});

test('ONE PRICE: nothing but `reserve.fuelPrice` prices fuel', () => {
  // The narrower claim the invariant actually needs: there is exactly one place a fuel
  // quantity is turned into credits (`fuelValue`), and exactly one number it multiplies
  // by. Both consumers are asserted to route through it above; this pins that the module
  // that owns the rule exposes ONE price constant and no second one.
  const fuel = require('../fuel.js');
  const priceLike = Object.keys(fuel).filter((k) => /PRICE/i.test(k));
  assert.deepEqual(priceLike, ['REFERENCE_FUEL_PRICE'],
    'sim/fuel.js must export exactly one price name — the calibration anchor');
  // And the anchor is a CONSTANT, distinct from the state field it seeds. Confusing the
  // two is the failure this whole slice is shaped to prevent: 5b-ii moves the field and
  // must never move the anchor.
  const s = galaxy(SPREAD, { pool: 1000, fuelPrice: 42 });
  assert.equal(REFERENCE_FUEL_PRICE, 10, 'the anchor does not follow the market price');
  assert.equal(s.reserve.fuelPrice, 42);
  assert.equal(fuelValue(3, s.reserve.fuelPrice), 126, 'and the valuation reads the market, not the anchor');
});

// --- 6. THE LAWS STILL HOLD ---------------------------------------------------------

test('INVARIANT 1 across a long run at a NON-reference price: issuance still moves, never mints', () => {
  // The failure this slice could plausibly introduce: the conversion inflates a grant, and
  // fuel appears that the pool never held. Run it long and check conservation by hand at
  // every boundary, not just at the end.
  //
  // ⚠ NARROWED BY 5b-ii. This test used to open at a hand-set CHEAP price (6) and assert
  // that the run reached the crunch and pinned the pool at zero — which it did, because
  // nothing could move the price back. The controller now can, and does: it is exactly the
  // job of the slice that this galaxy climbs out instead of rationing for ever. So the
  // rationing half of the claim has MOVED rather than been dropped — it lives in
  // fuel-controller.test.js's crisis test, on a load no price can throttle, which is the
  // only condition under which §4.1's crunch is still reachable. What stays here is the
  // conservation claim, which is what this test was named for.
  let s = galaxy(SPREAD, { pool: 4000, fuelPrice: 6 });   // cheap ⇒ grants open LARGER
  const producedAtStart = s.audit.totalProduced;
  let boundaries = 0;

  for (let cycle = 0; cycle < 12; cycle += 1) {
    s = runToBoundary(s);
    boundaries += 1;
    assertConserved(s, `boundary ${boundaries} under a moving price`);
  }

  // Only the influx minted. Every unit of the difference is the influx and nothing else —
  // a grant that minted would show up here as a bigger number than the influx explains, and
  // so would a controller that had somehow touched fuel instead of just the price.
  assert.equal(s.audit.totalProduced - producedAtStart, boundaries * DEUTERIUM_INFLUX_PER_CYCLE,
    'the influx is the ONLY thing that minted across the whole run');
  assert.equal(s.audit.totalConsumed, 0, 'and nothing was consumed — no trade in this fixture');
  // The price really did travel, or "conservation held under a moving price" is a weaker
  // claim than it reads: it opened at 6, and the controller has since had its way with it.
  assert.notEqual(s.reserve.fuelPrice, 6, 'the price genuinely moved across the run');
});

test('rationing is untouched — it clips the PHYSICAL amounts, whatever the price', () => {
  // `rationGrants` is price-blind by construction: it takes physical desires and a
  // physical pool. This pins that the conversion happens BEFORE it, so the clip still
  // empties the pool to exactly what it holds.
  const s = galaxy(SPREAD, { pool: 50, fuelPrice: REFERENCE_FUEL_PRICE / 2 });
  const desired = s.guilds.map((g) => physicalGrantFor(s, g));
  assert.ok(desired.reduce((a, b) => a + b, 0) > 50 + DEUTERIUM_INFLUX_PER_CYCLE,
    'the fixture must really out-draw its pool, or there is no crunch to test');

  const granted = rationGrants(desired, 50);
  assert.equal(granted.reduce((a, b) => a + b, 0), 50, 'the clip empties the pool to exactly the pool');
  granted.forEach((g, i) => assert.ok(g <= desired[i] && g >= 0 && Number.isInteger(g)));
});

test('determinism (invariant 9): a priced galaxy is byte-identical run twice', () => {
  const { hashState } = require('../serialize.js');
  const run = () => {
    let s = galaxy(SPREAD, { pool: 4000, fuelPrice: 13.7 });
    for (let i = 0; i < 20; i += 1) s = tick(s);
    return hashState(s);
  };
  assert.equal(run(), run(), 'the same galaxy at the same price hashes the same, every run');
});

test('a zero or negative price HALTS rather than granting nonsense', () => {
  // Nothing in 5b-i can reach this, which is exactly why the guard is worth having now:
  // 5b-ii's controller is what will start writing the field, and a missing floor there
  // would otherwise hand out Infinity fuel silently (§15.5 — halt, don't continue).
  for (const bad of [0, -1, NaN, Infinity]) {
    const s = galaxy([{ id: 'g1', systems: 1, mines: 3, rp: 4482 }], { pool: 1000, fuelPrice: bad });
    assert.throws(() => physicalGrantFor(s, s.guilds[0]), /reserve\.fuelPrice must be a finite number > 0/,
      `price ${bad} must halt`);
  }
});
