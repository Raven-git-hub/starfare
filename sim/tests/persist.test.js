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
const MINE_1 = createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 });
const MINE_2 = createEstablishVentureAction({ guildId: 'player-guild', ventureId: 'mine_2', siteId: 'pl_00004_n02', resourceType: 'titanium', productionRate: 3 });
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
const GOLDEN_HASH = '56401013588519715d15f415334fb2660b1bd9f73881352dc9f48b787a7b564c';

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
  assert.equal(hashState(s), GOLDEN_HASH);
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
