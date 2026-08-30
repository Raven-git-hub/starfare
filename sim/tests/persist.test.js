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
const GOLDEN_HASH = '56401013588519715d15f415334fb2660b1bd9f73881352dc9f48b787a7b564c';
const GOLDEN_HASH_WITH_PRICES = '53c4f4818b198cbf5000dc7d1ed4e7d8ce0f1e96902291f26575ff6b44b1b212';
const GOLDEN_HASH_WITH_HISTORY = '170bedd2c54dbb44b0583f93f1b8acfc8052c8c71d0e2b6e0146d8676f9d4a27';
const GOLDEN_HASH_WITH_ASSETS = 'c42d88d7b70b6046ca710deda21717daccf58a969125ea9802a01fb82d386ffd';

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
  assert.equal(hashState(withoutAssets(withoutHistory(withoutPrices(s)))), GOLDEN_HASH, 'everything but the price block, the history buffer and the assets is byte-identical to pre-price-engine HEAD');
  assert.equal(hashState(withoutAssets(withoutHistory(s))), GOLDEN_HASH_WITH_PRICES, 'and with prices back in, the ONLY delta from the pre-history engine is productionHistory');
  assert.equal(hashState(withoutAssets(s)), GOLDEN_HASH_WITH_HISTORY, 'and with the history back in, the ONLY delta from the pre-asset engine is the assets');
  assert.equal(hashState(s), GOLDEN_HASH_WITH_ASSETS, 'and the asset inventory itself is pinned');
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
