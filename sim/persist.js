'use strict';

// persist.js — file-backed durability for the testbed dev rig (B+ prototype).
//
// WHAT THIS IS: the thin durability LAYER from docs/persistence-model.md, built
// against files instead of Postgres. It follows the doc's "B+" shape —
//   - a STATE SNAPSHOT (the full in-memory state, written atomically), plus
//   - an ACTION JOURNAL (every accepted action appended before it is applied) —
// so a testbed galaxy survives a restart. It is OPT-IN and dev-rig only: not the
// Phase-2 production server, no Postgres, no multi-galaxy, no auth (all Phase 2).
//
// WHAT THIS IS NOT: engine logic. There is ZERO game logic here. Recovery replays
// the SAME validate→apply path the live server uses (actions.js), so there is no
// second engine and determinism (invariant 9) is what makes replay exact. The
// pure sim/ loop is run unmodified; this WRAPS it.
//
// The "snapshot" is the full live STATE object (serialize.canonicalStringify),
// NOT buildSnapshot's derived view — restore needs the authoritative state, not
// the debug lens.
//
// THE ORDERING HAZARD this slice exists to get right (the write-ahead-log
// double-apply trap): if you snapshot, then truncate the journal, and crash in
// between, the new snapshot already contains those actions AND the journal still
// lists them → replay double-applies. We avoid it WITHOUT relying on truncation:
// every journal entry carries the tick it was applied at, and on replay we apply
// only entries with `tick >= loadedState.tick`. A snapshot at tick N already
// contains every action applied while state.tick < N, so skipping those entries
// is idempotent-safe whether or not the journal was ever truncated (the doc notes
// a permanent, non-truncated journal is a valid option). Journal truncation is
// therefore a size optimisation we MAY add later, not a correctness requirement —
// deferred (see docs/persistence-model.md "Deferred").

const fs = require('node:fs');
const { join } = require('node:path');

const { canonicalStringify } = require('./serialize.js');
const { validateAction, applyAction } = require('./actions.js');

// File names inside the persist dir. The DIRECTORY is operator config (an env
// var), not a game number; these two names are the fixed layout of that dir.
const STATE_FILE = 'state.json';
const JOURNAL_FILE = 'journal.jsonl';
// The SEED joins the save (galaxy-lifecycle.md): the active galaxy is the trio
// { seed.json, state.json, journal.jsonl } in the volume, so a galaxy generated at
// runtime survives a restart and "start a new game" is a button, not a redeploy.
// data/seed.json stays in the repo as the generator's reference fixture and the
// default for a run with no volume — it is not the active galaxy.
const SEED_FILE = 'seed.json';

function statePath(dir) { return join(dir, STATE_FILE); }
function journalPath(dir) { return join(dir, JOURNAL_FILE); }
function seedPath(dir) { return join(dir, SEED_FILE); }

// saveSeed(seedObj, dir) — write the generated galaxy geometry to the volume, with
// the same temp-file + rename atomicity saveState uses: a crash mid-write leaves
// the previous seed whole rather than a half-file that would fail to parse on boot.
function saveSeed(seedObj, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${SEED_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(seedObj));
  fs.renameSync(tmp, seedPath(dir)); // atomic replace
  console.log(`[persist] saved seed ${seedObj && seedObj.seed} (${(seedObj.systems || []).length} systems)`);
}

// loadSeed(dir) -> the active galaxy's seed object, or null when the volume holds
// none. Null is the NO-GALAXY signal the server boots into: an empty volume means
// no galaxy, NOT the baked default (galaxy-lifecycle.md, Decision 1).
function loadSeed(dir) {
  const sp = seedPath(dir);
  if (!fs.existsSync(sp)) return null;
  return JSON.parse(fs.readFileSync(sp, 'utf8'));
}

// deleteGalaxy(dir) — remove the whole active galaxy: geometry, state and history.
// Delete is deliberate and total; what is left is an empty volume, i.e. NO-GALAXY.
function deleteGalaxy(dir) {
  fs.rmSync(seedPath(dir), { force: true });
  fs.rmSync(statePath(dir), { force: true });
  fs.rmSync(journalPath(dir), { force: true });
  console.log('[persist] deleted galaxy (seed + state + journal)');
}

// saveState(state, dir) — atomically write the CANONICAL serialization of the
// full STATE object to <dir>/state.json (invariant 4 / atomicity: a crash
// mid-write must leave the previous file intact). We write to a temp file in the
// SAME directory, then rename over the target — rename is atomic within one
// filesystem, so a reader/restart sees either the whole old file or the whole new
// one, never a half-written file. This is the "snapshot" of persistence-model.md.
function saveState(state, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${STATE_FILE}.tmp`);
  fs.writeFileSync(tmp, canonicalStringify(state));
  fs.renameSync(tmp, statePath(dir)); // atomic replace
  console.log(`[persist] saved state @tick ${state.tick}`);
}

// appendJournal(tick, action, dir) — append one JSON line {tick, action} to
// <dir>/journal.jsonl. `tick` is state.tick at apply time. The server appends
// BEFORE it applies (write-ahead order), so the journal only ever holds accepted
// actions, each recorded before it took effect — the classic WAL discipline that
// makes crash-window replay exact.
function appendJournal(tick, action, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(journalPath(dir), `${JSON.stringify({ tick, action })}\n`);
  console.log(`[persist] journalled ${action && action.type} @tick ${tick}`);
}

// clearJournal(dir) — remove the journal file if present. Used by /reset, which
// returns the galaxy to the zero-state: the old actions no longer describe the
// live world, so they must not replay on the next boot. Not a truncation-for-size
// optimisation (that stays deferred) — a reset is a deliberate discard of history.
function clearJournal(dir) {
  fs.rmSync(journalPath(dir), { force: true });
}

// loadOrInit(dir, initFn) — restore, or start fresh.
//   - No state.json → return initFn() (today's pure zero-state boot).
//   - state.json present → parse it, then REPLAY the journalled actions whose
//     tick >= the loaded snapshot's tick, through the normal validate→apply path.
//     Entries with tick < the loaded tick are already baked into the snapshot;
//     skipping them is the double-apply guard (see the header). A replayed action
//     that FAILS validation is a determinism break — we HALT LOUDLY rather than
//     skip it, because silently dropping a journalled action would recover a
//     DIFFERENT world than the one that was running.
// Returns the in-memory state and logs what it did.
function loadOrInit(dir, initFn) {
  const sp = statePath(dir);
  if (!fs.existsSync(sp)) {
    console.log('[persist] no state file — initialising fresh zero-state');
    return initFn();
  }

  let state = JSON.parse(fs.readFileSync(sp, 'utf8'));
  console.log(`[persist] loaded state @tick ${state.tick}`);

  // The loaded snapshot's tick is fixed for the whole replay: applyAction never
  // advances the tick, so this stays the correct cut-off throughout the loop.
  const loadedTick = state.tick;

  const jp = journalPath(dir);
  let replayed = 0;
  if (fs.existsSync(jp)) {
    const lines = fs.readFileSync(jp, 'utf8').split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Double-apply guard: everything already in the snapshot is skipped.
      if (entry.tick < loadedTick) continue;
      const { valid, reason } = validateAction(state, entry.action);
      if (!valid) {
        // A determinism break (invariant 9) — never something to skip. Halt with
        // the tick and reason so the operator sees exactly what diverged.
        throw new Error(
          `[persist] REPLAY HALT: journalled action (${entry.action && entry.action.type}) `
          + `failed validation @tick ${entry.tick}: ${reason} — determinism break, refusing to continue`,
        );
      }
      state = applyAction(state, entry.action);
      replayed++;
    }
  }
  console.log(`[persist] replayed ${replayed} journalled actions`);
  return state;
}

module.exports = {
  saveSeed, loadSeed, deleteGalaxy,
  saveState,
  appendJournal,
  clearJournal,
  loadOrInit,
  // Path helpers exported for tests/tools that need to locate the files.
  statePath,
  journalPath,
};
