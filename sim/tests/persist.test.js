'use strict';

// persist.test.js — the mechanical tripwires for file-backed durability
// (sim/persist.js, the dev-rig B+ prototype). These tests are the POINT of the
// slice: determinism (invariant 9) is load-bearing for journal replay, and the
// write-ahead-log double-apply trap is the specific hazard this design avoids.
// Each test fails LOUD if durability silently changes the recovered world.
//
// The four tripwires (mirroring the build prompt):
//   1. round-trip determinism — save+journal, load, hash matches the original.
//   2. crash-window / zero loss — actions after the last save survive via replay.
//   3. double-apply guard — a snapshot-baked action still in the journal is NOT
//      re-applied on replay (the WAL trap).
//   4. no-op proof — the pure (flag-unset) engine path is byte-identical to
//      before this change; persistence is strictly opt-in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { createZeroState } = require('../scenarios/zero-state.js');
const { advance } = require('../run.js');
const {
  validateAction, applyAction,
  createFoundGuildAction, createEstablishVentureAction, createSetProductionProfileAction,
} = require('../actions.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, clearJournal, loadOrInit, journalPath } = require('../persist.js');
const { guildTotals } = require('../stock.js');
const { STARTER_MINERS, STARTER_FACTORIES } = require('../assets.js');
const { GUILD_STARTING_FUEL, REFERENCE_FUEL_PRICE } = require('../fuel.js');
const { POOL_SEED, DEUTERIUM_INFLUX_PER_CYCLE } = require('../issuance.js');

// A throwaway persist dir per test, cleaned up after. Real filesystem (not a
// mock) so the atomic temp-file+rename write path is actually exercised.
function withTmpDir(t) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Apply one action, asserting it validates (test scenarios only script legal
// moves; a reject here is a bug in the test, not a durability outcome).
function applyValid(state, action) {
  const { valid, reason } = validateAction(state, action);
  assert.ok(valid, `action ${action.type} unexpectedly rejected: ${reason}`);
  return applyAction(state, action);
}

// Drive the SERVER's exact write-ahead protocol against a persist dir, so the
// on-disk files are built the way the live server builds them:
//   - an action step:  validate → appendJournal(state.tick) → applyAction   (no tick)
//   - a tick step:      advance one tick → saveState                        (per-tick cadence)
// Returns the final in-memory state (the "original"/"control" to compare against
// what loadOrInit recovers). `steps` is a list of { action } or { tick: true }.
function runScripted(dir, steps) {
  let state = createZeroState();
  for (const step of steps) {
    if (step.tick) {
      state = advance(state, []).state;
      saveState(state, dir);
    } else {
      const { valid, reason } = validateAction(state, step.action);
      assert.ok(valid, `scripted action ${step.action.type} rejected: ${reason}`);
      appendJournal(state.tick, step.action, dir); // write-ahead: journal BEFORE apply
      state = applyAction(state, step.action);
    }
  }
  return state;
}

// Reusable legal moves against the real seed (same ids the establish-venture
// tests use): sys_0002 is a starter home; pl_00004_n01/n02 are titanium nodes on
// its Terran homeworld.
const FOUND = createFoundGuildAction({ guildId: 'player-guild', name: 'Player', credits: 120, influence: 100, homeSystemId: 'sys_0002' });
// GOLDEN-PRESERVING assetIds (31-08-26): the deploy now NAMES its machine, and these
// two name exactly the ones the previous auto-pick (lowest idle id) would have taken —
// so every venture below lands with the same `assetId` it had before, and the four
// hashes pinned further down do not move. That is the point: this slice changed WHO
// chooses the machine, not which one these runs end up running.
const MINE_1 = createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n01', assetId: 'asset_player-guild_miner_01', resourceType: 'titanium', productionRate: 5 });
const MINE_2 = createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_2', siteId: 'pl_00004_n02', assetId: 'asset_player-guild_miner_02', resourceType: 'titanium', productionRate: 3 });
const PROFILE = createSetProductionProfileAction({ guildId: 'player-guild', systemId: 'sys_0002', goods: { titanium: { order: ['syndicate', 'downstream', 'stockpile'] } } });

// --- 1. round-trip determinism (the headline) ------------------------------

test('round-trip: save + journal, then loadOrInit recovers a hash-identical state', (t) => {
  const dir = withTmpDir(t);
  // found a guild, establish a titanium mine, set a production profile, tick a few.
  const original = runScripted(dir, [
    { action: FOUND },
    { action: MINE_1 },
    { action: PROFILE },
    { tick: true }, { tick: true }, { tick: true },
  ]);

  const recovered = loadOrInit(dir, createZeroState);

  assert.equal(hashState(recovered), hashState(original));
  // sanity: the recovered world actually holds the guild + mine (not an empty init).
  assert.equal(recovered.guilds.length, 1);
  assert.equal(recovered.guilds[0].ventures.length, 1);
});

// --- 2. crash-window / zero loss -------------------------------------------

test('crash window: actions after the last save survive via journal replay', (t) => {
  const dir = withTmpDir(t);
  // Phase A: found + establish + two ticks, all persisted → last snapshot @tick 2.
  let state = runScripted(dir, [
    { action: FOUND },
    { action: MINE_1 },
    { tick: true }, { tick: true },
  ]);
  assert.equal(state.tick, 2);

  // Phase B: MORE accepted actions after that snapshot — journalled + applied in
  // memory, but NO further tick/save. This is the crash window: a hard crash here
  // runs no shutdown hook, so only the journal carries these two actions.
  const crashActions = [MINE_2, PROFILE];
  for (const a of crashActions) {
    appendJournal(state.tick, a, dir); // tick === 2
    state = applyValid(state, a);
  }
  const control = state; // what memory held at crash time; never saved to disk

  // Discard the in-memory state; recover from disk (snapshot @2 + replay @2 actions).
  const recovered = loadOrInit(dir, createZeroState);

  assert.equal(hashState(recovered), hashState(control)); // zero action loss
  assert.equal(recovered.guilds[0].ventures.length, 2);   // the crash-window mine is back
});

// --- 3. double-apply guard (the WAL trap this design exists to avoid) -------

test('double-apply guard: a snapshot-baked action still in the journal is not re-applied', (t) => {
  const dir = withTmpDir(t);
  // found + establish (journalled @tick 0), then a tick → snapshot @tick 1 that
  // ALREADY contains both. We deliberately DO NOT truncate the journal, so on
  // disk state.json @tick 1 and journal.jsonl still listing the @0 actions
  // coexist — exactly the "snapshot saved but journal still present" window.
  const control = runScripted(dir, [
    { action: FOUND },
    { action: MINE_1 },
    { tick: true },
  ]);
  assert.equal(control.tick, 1);

  // Prove the trap is actually set: the journal still holds the two @0 entries
  // that the snapshot already baked in.
  const lines = fs.readFileSync(journalPath(dir), 'utf8').split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => JSON.parse(l).tick === 0));

  // Replay must SKIP them (tick 0 < loaded tick 1). If the guard were broken it
  // would re-apply foundGuild onto a state that already has that guild — which
  // validateAction rejects, so loadOrInit would throw REPLAY HALT. Either way a
  // broken guard fails this test; a correct guard recovers the single-apply state.
  const recovered = loadOrInit(dir, createZeroState);

  assert.equal(hashState(recovered), hashState(control));
  assert.equal(recovered.guilds.length, 1);              // not duplicated
  assert.equal(recovered.guilds[0].ventures.length, 1);  // not double-established
});

// --- 4. no-op proof: the pure (flag-unset) path is byte-identical ----------

// GOLDEN: hashState of the canonical dev sequence run through the PURE engine
// (no persistence), captured from the engine as it stands. Persistence is
// strictly opt-in, so with STARFARE_PERSIST_DIR unset the server runs this exact
// pure path — this hash is the "before this change" value. If a future edit ever
// alters the engine's result for this sequence, this tripwire fires.
//
// PRICE-ENGINE SLICE (26-08-26): state now carries a `prices` block (sim/prices.js) —
// real serialized state, so the FULL hash legitimately moved. The golden below is
// UNCHANGED and is now asserted against the state with the price block stripped, which
// makes it a stronger statement than before: the price engine added prices and changed
// nothing else about this sequence, byte for byte. The full-state hash is pinned beside
// it so a drift in the price numbers themselves is caught too.
//
// PRODUCTION-HISTORY SLICE (28-08-26): the console's trend sparklines moved out of the
// browser into stored state (`guild.productionHistory`, sim/history.js) — real serialized
// bytes, so the FULL hash legitimately moved again. Both goldens below are UNCHANGED and
// are now asserted with the history stripped as well: this slice added a history buffer
// and changed nothing else about this sequence, byte for byte. The full hash is pinned
// beside them so a drift in the recorded samples themselves is caught too.
// PRICE-HISTORY SLICE (29-08-26): all three goldens below are UNCHANGED and needed NO
// regen — deliberately, and it is worth saying why rather than leaving it to look like an
// oversight. `state.priceHistory` (sim/price-history.js) mints nothing until the first
// fine bucket closes at tick 15, and this sequence ends at tick 2. So a run this short
// carries no price-history key at all and is byte-identical with nothing stripped, which
// is the omit-when-empty no-op working exactly as designed. (The 40-tick runs in
// commitment-scaffold.test.js DO cross the bucket, and were re-pinned there with the
// strip-and-prove method.)
//
// ASSET-OCCUPANCY SLICE (30-08-26): founding now GRANTS a starter asset inventory
// (15 Miners + 10 Factories, docs/phase-1-tuning.md) and `establishVenture` occupies
// one, so this sequence — which founds a guild and establishes a mine — legitimately
// gained real serialized bytes and its FULL hash moved. Same strip-and-prove method,
// and it is the whole delta proof: the three goldens below are ALL UNCHANGED and are
// now asserted with the assets stripped too, so this slice added an inventory and one
// `assetId` and altered NOTHING else about this sequence, byte for byte — no credit,
// no stockpile, no production number moved. The new full hash is pinned beside them.
// (A guild built WITHOUT founding carries no `assets` key and no `assetId` at all and
// is byte-identical with nothing stripped — the omit-when-empty no-op, which is why
// commitment-scaffold.test.js's five goldens did not move and needed no regen.)
//
// FUEL SLICE 1 (31-08-26) — ALL FOUR GOLDENS RE-PINNED, and this is the first slice
// that could not preserve one. THE DELTA IS THE FOUNDING FUEL GRANT: `foundGuild` now
// seeds the new guild's hoard with `GUILD_STARTING_FUEL` (500, sim/fuel.js — the
// starter floor ruled in docs/fuel-economy.md §7), and the canonical sequence below
// founds a guild, so it lands in this state. Every previous slice added a NEW key and
// could be stripped back to its predecessor; this one changes the VALUE of three
// numbers that already existed, and there is nothing to strip:
//   guilds[0].fuelHoard             0  ->   500
//   audit.totalProduced            30  ->   530   (the genesis entry invariant 1 needs)
//   galacticSupply.fuel.guildHeld   0  ->   500   (the refreshed cache)
// So the strip-and-prove method is inverted instead of abandoned: the test right below
// the four hashes SUBTRACTS the grant from exactly those three fields and asserts the
// result is the OLD `GOLDEN_HASH_WITH_ASSETS`, byte for byte. That is the same
// statement the strips used to make — this slice seeded a hoard and changed NOTHING
// else about this sequence — and it fails loudly if a future edit smuggles a second
// change in behind a re-pin.
// THE REPUTATION RESCALE (01-09-26, slice 1 of 2 — docs/points-and-reputation.md §2.6).
// GP and RP moved onto one small integer scale: `MEANLINE_K` 150 → 1, `W_SYS` 12 → 200,
// tier weights 6/8 → 100/150. This canonical sequence FOUNDS A GUILD, and the founding
// endowment is `MEANLINE_K × W_SYS` — so its ONE serialized number, `foundingEndowment`
// (mirrored in `guildReputation`), moved 1800 → 200 and ALL SIX hashes below are re-pinned.
//
// NOTHING ELSE MOVED, and again the re-pinning is not the proof: the un-endow test below
// strips exactly those two fields and asserts `GOLDEN_HASH_BEFORE_ENDOWMENT` comes back
// byte for byte — and it does, unchanged, which is the statement that this rescale's whole
// footprint on this sequence is the endowment's value. The run is 2 ticks on the 1,440-tick
// default window, so it crosses NO cycle boundary: no issuance, so the rescaled GP weights
// and the re-based `BASE_GRANT_PER_GP` (5 → 0.3) reach no fuel number here. The runs that
// DO cross a boundary are in commitment-scaffold.test.js.
const GOLDEN_HASH = '252305d0d8ed39a1b5f59fa8f32600697b42cc66c0d27affb9581736cb099c47';
const GOLDEN_HASH_WITH_PRICES = 'bcdda635599da199a2de10e4283c2d11c404378f1cd5514b30d63555f08e12a4';
const GOLDEN_HASH_WITH_HISTORY = 'dc14c1af5d1ebdb559b72d4c0f1796c58ad115b0ab4140ea37913aef75f0fe92';
const GOLDEN_HASH_WITH_ASSETS = 'd3f6036d885bcdc02891e983ec1e59ab3d0a81ec5b2ba08c3c22d48019c86c68';

// FUEL SLICE 5a (31-08-26) — the pool got a real seed. The Syndicate reserve
// (`state.reserve.reserveLevel`) opened on a `[SHEET]` placeholder 30 from the walking
// skeleton until this slice gave the pool a rule (the influx fills it, issuance draws it
// down), at which point its opening balance became `POOL_SEED`. That moves three numbers
// in this canonical sequence — the pool, the audit's `totalProduced` (which seeds from
// it) and the `galacticSupply.fuel.reserve` cache — so all four goldens above are
// re-pinned. NOTHING ELSE MOVED, and the proof is below rather than in the re-pinning:
// this run is 2 ticks on the 1,440-tick default window, so it crosses NO boundary — no
// influx, no issuance, no grant record. The value the full hash held before this slice,
// kept so the un-seed proof has something to prove against:
const GOLDEN_HASH_BEFORE_POOL_SEED = '9f8a9a45861f268980d30274eadc0eac07a1d45ae5d7a48085ba0a6bf2f6469b';
// What that line seeded before POOL_SEED replaced it.
const RETIRED_POOL_PLACEHOLDER = 30;

// THE FOUNDING ENDOWMENT (31-08-26, A′ — docs/points-and-reputation.md §2.5). Founding now
// grants a one-time guild-level reputation of `MEANLINE_K × W_SYS` so a newborn opens ON
// ITS LINE instead of pinned at the issuance floor. This canonical sequence FOUNDS A GUILD,
// so it is one of the runs that legitimately changes: its guild gains a `foundingEndowment`
// key and its `guildReputation` moves 0 → 1800. All four goldens above are re-pinned, and —
// as ever — the re-pinning is not the proof: the un-endow test below undoes exactly those
// two fields and asserts the PRE-SLICE hash comes back byte for byte.
//
// NOTHING ELSE MOVED, and the run's shape is why: it is 2 ticks on the 1,440-tick default
// window, so it crosses NO cycle boundary — no issuance, so the newborn's modifier rising
// from ×0.30 to ×1.00 changes no fuel in THIS run. (A run that did cross a boundary would
// also see the grant rise, which is the point of the slice.)
const GOLDEN_HASH_BEFORE_ENDOWMENT = 'd744ab2a9f3e4c0ededaee0d70007d39e48f2677604941535d6ba85b0301ebed';

// The pre-fuel-slice full hash, kept so the un-granting proof below has something to
// prove against. It is the value `GOLDEN_HASH_WITH_ASSETS` held before 31-08-26.
const GOLDEN_HASH_BEFORE_FUEL_GRANT = 'c42d88d7b70b6046ca710deda21717daccf58a969125ea9802a01fb82d386ffd';

// FUEL PRICE MEDIATION (01-09-26, slice 5b-i — docs/fuel-supply-and-allocation.md §4.2).
// The reserve gains `fuelPrice`, the galaxy's ONE market price of `deuterium_fuel`. It is
// REAL serialized state (5b-ii's controller has to move it cycle to cycle), so the FULL
// hash legitimately moved — and this time the ordinary strip works, because the slice ADDS
// a key rather than changing a value: all four goldens above are UNCHANGED and are now
// asserted with the price stripped, which is the whole proof. This slice added one field
// and altered NOTHING else about this sequence, byte for byte — no grant, no hoard, no
// pool, no valuation. The new full hash is pinned beside them so a drift in the price
// itself is caught too.
const GOLDEN_HASH_WITH_FUEL_PRICE = 'e84443c76147c10566578348cc05b95e36caa6b21886c85a0faabdd88ea86e16';

// THE FUEL PRICE CONTROLLER (01-09-26, slice 5b-ii — §4.2). The reserve gains `avgDraw`,
// the trailing average of galaxy demand the controller steers against. Real serialized
// state (an EMA is memory), so the FULL hash moved again — and again the ORDINARY strip
// works, because this slice adds a key rather than changing a value ON THIS RUN.
//
// ⚠ AND THAT LAST QUALIFIER IS THE WHOLE POINT OF PINNING IT HERE. 5b-ii is emphatically
// NOT a no-op: it moves the price every cycle and changes every grant that follows. This
// sequence is spared only because it is 2 TICKS ON THE 1,440-TICK DEFAULT WINDOW and
// crosses NO cycle boundary — so the controller never runs, `avgDraw` is still its seed,
// `fuelPrice` is still the reference, and the added key is the entire delta. The runs that
// DO cross a boundary are in commitment-scaffold.test.js, and their hashes moved for real.
const GOLDEN_HASH_WITH_AVG_DRAW = '2a7ab973d8c92199204890c2e11a868d2df647bf64ae386ebcb397e988261e7a';

// The state minus the reserve's fuel price — everything the four goldens above covered.
// Stripped inside `reserve`, leaving `reserveLevel` and every other top-level key in
// place, so a change anywhere else still fails the assertion.
const withoutFuelPrice = (state) => {
  const { fuelPrice, ...reserve } = state.reserve;
  return { ...state, reserve };
};
// …and the same, one slice later, for the controller's demand average.
const withoutAvgDraw = (state) => {
  const { avgDraw, ...reserve } = state.reserve;
  return { ...state, reserve };
};

// The state minus its price block — exactly what the golden above covered.
const withoutPrices = (state) => { const { prices, ...rest } = state; return rest; };
// The state minus every guild's production-history buffer — what the two hashes above
// covered before this slice. Stripped per guild, leaving the rest of the row untouched.
const withoutHistory = (state) => ({
  ...state,
  guilds: (state.guilds || []).map((g) => { const { productionHistory, ...rest } = g; return rest; }),
});
// The state minus everything the asset slice added — the guild's inventory AND every
// venture's `assetId` reference. Stripped in both places, because the slice writes in
// both, and leaving every other byte of the guild and the venture in place is what
// makes the three unchanged hashes below a proof that ONLY the assets moved.
const withoutAssets = (state) => ({
  ...state,
  guilds: (state.guilds || []).map((g) => {
    const { assets, ...rest } = g;
    return {
      ...rest,
      ventures: (g.ventures || []).map((v) => { const { assetId, ...vRest } = v; return vRest; }),
    };
  }),
});

test('no-op proof: pure engine path (persistence OFF) matches the golden hash', () => {
  // The SAME scripted moves as above, but driven straight through the engine with
  // ZERO persist calls — modelling a boot + action/tick sequence with the flag unset.
  let s = createZeroState();
  s = applyValid(s, FOUND);
  s = applyValid(s, MINE_1);
  s = applyValid(s, PROFILE);
  s = advance(s, []).state;
  s = advance(s, []).state;

  assert.equal(s.tick, 2);
  const bare = (x) => withoutAvgDraw(withoutFuelPrice(x));
  assert.equal(hashState(bare(withoutAssets(withoutHistory(withoutPrices(s))))), GOLDEN_HASH, 'everything but the price block, the history buffer, the assets and the two reserve fields is byte-identical to pre-price-engine HEAD');
  assert.equal(hashState(bare(withoutAssets(withoutHistory(s)))), GOLDEN_HASH_WITH_PRICES, 'and with prices back in, the ONLY delta from the pre-history engine is productionHistory');
  assert.equal(hashState(bare(withoutAssets(s))), GOLDEN_HASH_WITH_HISTORY, 'and with the history back in, the ONLY delta from the pre-asset engine is the assets');
  assert.equal(hashState(bare(s)), GOLDEN_HASH_WITH_ASSETS, 'and with the assets back in, the ONLY delta from the pre-5b-i engine is the two reserve fields');
  assert.equal(hashState(withoutAvgDraw(s)), GOLDEN_HASH_WITH_FUEL_PRICE, 'with the price back in, the ONLY delta from the pre-5b-ii engine is reserve.avgDraw');
  assert.equal(hashState(s), GOLDEN_HASH_WITH_AVG_DRAW, 'and the demand average itself is pinned');
  assert.equal(s.reserve.fuelPrice, REFERENCE_FUEL_PRICE,
    'the strips above are only a proof if there was really something to strip — the price opens at the reference…');
  assert.equal(s.reserve.avgDraw, DEUTERIUM_INFLUX_PER_CYCLE,
    '…and the demand average at the balanced-galaxy assumption, both untouched because this run crosses no boundary');
  assert.equal(s.priceHistory, undefined,
    'a 2-tick run takes no price sample at all (the first fine bucket closes at tick 15), which is why the three goldens above did not move');
  assert.deepEqual(s.guilds[0].productionHistory, { sys_0002: { titanium: { prod: [5, 5], cons: [0, 0] } } },
    'the stripped-equals-old proof above is only a proof if there was really history to strip');
  // ...and likewise for the assets: the three unchanged hashes only mean something if
  // this run really did grant an inventory and occupy one machine out of it.
  assert.equal(s.guilds[0].assets.length, STARTER_MINERS + STARTER_FACTORIES, 'the run really did receive the starter gift');
  assert.equal(s.guilds[0].ventures[0].assetId, 'asset_player-guild_miner_01', 'and the mine really is running one of them');
  // The delta is the assets ALONE — no game number moved with them. Credits are the
  // founding's 120 (nothing was charged for the gift or the deploy), and the mine's
  // output is the same 5/tick × 2 ticks it produced before this slice existed.
  assert.equal(s.guilds[0].credits, 120, 'the gift and the deploy cost nothing');
  assert.equal(guildTotals(s.guilds[0]).titanium, 10, 'and production is byte-for-byte what it was: occupying an asset changes no game number');
});

// The fuel slice's own delta proof — the strip-and-prove idiom inverted, because a
// changed VALUE cannot be stripped the way an added key can. Un-grant the founding
// fuel from the three fields it touches and the whole state must hash to what it
// hashed before the slice. If a future edit re-pins the four goldens above while
// also moving some other number, this is what catches it.
test('no-op proof: subtract the founding fuel grant and the pre-slice golden comes back', () => {
  let s = createZeroState();
  s = applyValid(s, FOUND);
  s = applyValid(s, MINE_1);
  s = applyValid(s, PROFILE);
  s = advance(s, []).state;
  s = advance(s, []).state;

  // The grant really landed — otherwise "subtract it and nothing changed" is vacuous.
  assert.equal(s.guilds[0].fuelHoard, GUILD_STARTING_FUEL, 'the founding really did seed a hoard');
  assert.equal(s.audit.totalProduced, s.reserve.reserveLevel + GUILD_STARTING_FUEL, 'and recorded it as produced');
  assert.equal(s.galacticSupply.fuel.guildHeld, GUILD_STARTING_FUEL, 'and refreshed the supply cache');

  const ungranted = structuredClone(s);
  // …and un-endow the founding (A′, 31-08-26), so what comes back is the state as it stood
  // before ANY of the three slices that have touched founding since.
  ungranted.guilds[0].guildReputation -= ungranted.guilds[0].foundingEndowment;
  delete ungranted.guilds[0].foundingEndowment;
  ungranted.guilds[0].fuelHoard -= GUILD_STARTING_FUEL;
  ungranted.audit.totalProduced -= GUILD_STARTING_FUEL;
  ungranted.galacticSupply.fuel.guildHeld -= GUILD_STARTING_FUEL;

  // …and un-seed the POOL too (slice 5a), so what comes back is the state as it stood
  // before EITHER fuel slice touched it. Two slices' worth of fuel undone, one hash.
  ungranted.reserve.reserveLevel -= POOL_SEED - RETIRED_POOL_PLACEHOLDER;
  ungranted.audit.totalProduced -= POOL_SEED - RETIRED_POOL_PLACEHOLDER;
  ungranted.galacticSupply.fuel.reserve -= POOL_SEED - RETIRED_POOL_PLACEHOLDER;

  assert.equal(hashState(withoutAvgDraw(withoutFuelPrice(ungranted))), GOLDEN_HASH_BEFORE_FUEL_GRANT,
    'the fuel grant and the pool seed are the ONLY deltas the two fuel slices made to the canonical sequence, byte for byte');
});

// Slice 5a's own delta proof, the same inverted idiom: a changed VALUE cannot be stripped
// the way an added key can, so subtract the pool seed from the three fields it reaches and
// the pre-slice hash must come back. This is what makes the four re-pinned goldens above
// mean something — a re-pinned number on its own proves only that somebody ran the code.
test('no-op proof: un-seed the pool and the pre-slice-5a golden comes back', () => {
  let s = createZeroState();
  s = applyValid(s, FOUND);
  s = applyValid(s, MINE_1);
  s = applyValid(s, PROFILE);
  s = advance(s, []).state;
  s = advance(s, []).state;

  // The seed really landed — otherwise "subtract it and nothing changed" is vacuous.
  assert.equal(s.reserve.reserveLevel, POOL_SEED, 'the galaxy really did open on a seeded pool');
  assert.equal(s.audit.totalProduced, POOL_SEED + GUILD_STARTING_FUEL, 'and the audit counts it as produced');
  assert.equal(s.galacticSupply.fuel.reserve, POOL_SEED, 'with the supply cache agreeing');

  // NOTHING FLOWED. Two ticks on the 1,440-tick default window cross no boundary, so the
  // influx never fired and no grant was made — which is itself the "nothing happens off a
  // boundary" proof, and is why the pool is still exactly its seed.
  assert.equal(s.guilds[0].lastFuelGrant, undefined, 'no boundary was crossed, so no grant was recorded');
  assert.equal(s.guilds[0].fuelHoard, GUILD_STARTING_FUEL, 'the hoard is the founding grant alone');

  // INVARIANT 1 by hand: everything minted is accounted for in the pool and the hoards.
  assert.equal(s.audit.totalProduced - s.audit.totalConsumed,
    s.reserve.reserveLevel + s.guilds[0].fuelHoard,
    'conservation: produced − consumed == pool + Σ hoards');

  const unseeded = structuredClone(s);
  // The endowment landed after this golden was pinned, so it is undone here too — this
  // test is about the POOL seed being the only delta SLICE 5a made.
  unseeded.guilds[0].guildReputation -= unseeded.guilds[0].foundingEndowment;
  delete unseeded.guilds[0].foundingEndowment;
  unseeded.reserve.reserveLevel -= POOL_SEED - RETIRED_POOL_PLACEHOLDER;
  unseeded.audit.totalProduced -= POOL_SEED - RETIRED_POOL_PLACEHOLDER;
  unseeded.galacticSupply.fuel.reserve -= POOL_SEED - RETIRED_POOL_PLACEHOLDER;

  assert.equal(hashState(withoutAvgDraw(withoutFuelPrice(unseeded))), GOLDEN_HASH_BEFORE_POOL_SEED,
    'the pool seed is the ONLY delta slice 5a made to this run, byte for byte');
});

// The founding endowment's own delta proof — the inverted strip-and-prove this repo uses
// whenever a changed VALUE cannot be stripped the way an added key can. Undo the two fields
// the endowment touches and the pre-slice hash must come back, byte for byte. Without this,
// four re-pinned numbers would prove only that somebody ran the code.
test('no-op proof: un-endow the founding and the pre-endowment golden comes back', () => {
  let s = createZeroState();
  s = applyValid(s, FOUND);
  s = applyValid(s, MINE_1);
  s = applyValid(s, PROFILE);
  s = advance(s, []).state;
  s = advance(s, []).state;

  const g = s.guilds[0];
  const { MEANLINE_K } = require('../meanline.js');
  const { W_SYS } = require('../points.js');

  // The endowment really landed, and is DERIVED — not a number typed into the engine.
  assert.equal(g.foundingEndowment, MEANLINE_K * W_SYS, 'sized from the two ruled constants');
  // ⤳ RESCALED 01-09-26 (1800 → 200), points-and-reputation.md §2.6, with NO edit to
  // `foundingEndowmentFor` — it is the product of two ruled constants and tracked them.
  assert.equal(g.foundingEndowment, 200);
  assert.equal(g.guildReputation, 200, 'and the guild total carries it');
  // It endowed the HOME SYSTEM only: the mine this run established is not endowed, so the
  // guild's Points (300) are above what its reputation covers (200, one system's worth).
  assert.equal(g.ventures.length, 1, 'the run really did establish a venture');
  assert.equal(g.ventures[0].reputation, undefined, 'which carries no reputation of its own');

  // NO FUEL MOVED ON ITS ACCOUNT in this run: 2 ticks on the 1,440-tick default window
  // crosses no boundary, so the newborn's modifier rising to 1.0 granted it nothing here.
  assert.equal(g.lastFuelGrant, undefined);

  const unendowed = structuredClone(s);
  unendowed.guilds[0].guildReputation -= unendowed.guilds[0].foundingEndowment;
  delete unendowed.guilds[0].foundingEndowment;

  assert.equal(hashState(withoutAvgDraw(withoutFuelPrice(unendowed))), GOLDEN_HASH_BEFORE_ENDOWMENT,
    'the endowment is the ONLY delta this slice made to the canonical sequence, byte for byte');
});

// --- 5. graceful shutdown: the MID-INTERVAL save (no intervening tick) ------
//
// The double-apply guard above only exercises a snapshot taken at a tick BOUNDARY
// (a `tick: true` step sits between the actions and the save, so snapshot @1 >
// actions @0). The graceful-shutdown hook saves MID-INTERVAL — capturing actions
// tagged with the CURRENT tick, with the journal still listing them. That is a
// different, un-covered configuration, and it is the common deploy/reboot path.
// These two tests pin it: the shutdown FLOW (save + clearJournal) recovers
// cleanly, and a save WITHOUT the clear fails LOUD (never a silent double-apply).

// Apply actions with NO intervening tick: journalled + applied @tick 0, and
// state.tick stays 0 — exactly the state the shutdown hook saves.
function foundMineNoTick(dir) {
  let state = createZeroState();
  for (const a of [FOUND, MINE_1]) {
    appendJournal(state.tick, a, dir); // tick === 0, same tick the snapshot will carry
    state = applyValid(state, a);
  }
  return state; // tick 0, one guild + mine_1
}

test('graceful shutdown: a mid-interval save + clearJournal recovers without throwing', (t) => {
  const dir = withTmpDir(t);
  const control = foundMineNoTick(dir);
  assert.equal(control.tick, 0);

  // The server's SIGINT/SIGTERM hook: save the authoritative live state, THEN
  // clear the journal so nothing replays on top of a snapshot that already holds it.
  saveState(control, dir);
  clearJournal(dir);

  const recovered = loadOrInit(dir, createZeroState);
  assert.equal(hashState(recovered), hashState(control)); // single-apply, no double-apply
  assert.equal(recovered.guilds.length, 1);
  assert.equal(recovered.guilds[0].ventures.length, 1);
});

test('mid-interval save with the journal left intact HALTS loudly (why the clear is load-bearing)', (t) => {
  const dir = withTmpDir(t);
  const state = foundMineNoTick(dir);

  // Save the mid-interval snapshot @tick 0 (it already contains the @0 actions)
  // but DO NOT clear the journal. The @0 entries satisfy `tick >= loadedTick`
  // (0 >= 0), so replay re-applies foundGuild onto a state that already has that
  // guild. The design refuses to continue — LOUD REPLAY HALT, not a silent
  // double-apply. This is exactly the corruption the shutdown-hook clear prevents.
  saveState(state, dir);
  assert.throws(() => loadOrInit(dir, createZeroState), /REPLAY HALT/);
});

// --- bonus: no state file → clean init; reset clears the journal -----------

test('loadOrInit with no state file returns a fresh init (opt-in from empty)', (t) => {
  const dir = withTmpDir(t);
  const s = loadOrInit(dir, createZeroState);
  assert.equal(hashState(s), hashState(createZeroState()));
});

test('clearJournal removes the journal so reset does not replay a stale world', (t) => {
  const dir = withTmpDir(t);
  runScripted(dir, [{ action: FOUND }, { tick: true }]);
  assert.ok(fs.existsSync(journalPath(dir)));
  clearJournal(dir);
  assert.ok(!fs.existsSync(journalPath(dir)));
});
