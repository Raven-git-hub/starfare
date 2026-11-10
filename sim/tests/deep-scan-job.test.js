'use strict';

// deep-scan-job.test.js — roadmap 2.5 (b2): the Deep Scan Array's DISCOVERY SCAN (docs/exploration-model.md
// §5 "Discovery — the scan"). An array runs one job at a time — an L1 system scan (720 ticks: every planet's
// archetype) or an L2 planet scan (480 ticks: one planet's resource nodes) — and on completion writes its
// guild's exploration record through the ONE `reveal`. The tripwires:
//
//   1. THE NUMBERS: the two durations are the ruled [FIRST-CUT] ones, live once, and match the tuning doc.
//   2. L1 reveals every archetype of the target system and NO surface, exactly 720 ticks after it was queued;
//      L2 reveals the one target planet's whole surface — every node AND every settlement slot (⤳ the
//      settlement-surface slice, 09-10-26) — exactly 480 ticks after. The job then clears.
//   3. THE CHAIN, per planet: an L2 needs ITS planet's archetype known — not any other planet's.
//   4. ONE ACTIVE JOB per array, no backlog.
//   5. TARGETS: unclaimed only — a rival's system is refused (L3), your own is refused; no reach limit.
//   6. COMPLETION RE-VALIDATED: a rival claiming the target mid-scan voids the job (nothing revealed, job
//      cleared); the scanning guild coming to hold it does not.
//   7. ARRAY LOST MID-JOB: the operator remove takes the job with it; nothing fires; banked facts stay.
//   8. DETERMINISM (invariant 9): a mid-flight job survives save → restore and a journal replay, and completes
//      identically; createState copies a handed-in job.
//   9. OMIT-WHEN-IDLE: a galaxy whose arrays are idle is byte-identical to main before the scan (hashes
//      recorded on 52e5e3f), and an array whose job finished is the idle row again. (⤳ 08-10-26, ruling 11:
//      the two per-guild VIEWS re-pinned — each now shows the rival's home at full L2 — with a strip-and-prove
//      back to the 52e5e3f bytes; the state and the god's-eye lens did not move.) (⤳ 09-10-26, the
//      settlement-surface slice: the state and both views re-pinned again — founding now records the home's
//      settlement slots and every `known` entry carries `slots` — each with a strip-and-prove back to the
//      previous bytes (tests/slot-strip.js); the god's-eye lens did not move.) (⤳ 09-10-26, the L0-board
//      slice: both views re-pinned once more — `geography.systems` is gone — each with a put-back-and-prove
//      to the settlement-surface bytes (tests/systems-block.js); the state and the god's-eye lens did not move.)
//  10. INVARIANTS: a malformed job fails loudly; the completion step halts, naming the tick.
// The per-guild view (a rival never sees the job) is tested with the rest of the fog, in fog.test.js.

// ⤳ 16-10-26 (roadmap 2.5, the Prefecture / claims slice): digests pinned below were RE-PINNED. The slice
// re-banded two Tier-3 modules the Prefecture bill uses (claim_beacon → 3-2, habitation_module → 3-3;
// docs/phase-1-tuning.md), which moves their seeded price rows (prices, price history, the quote ring, and the
// snapshot's price fields) in every state and view. With those two goods' keys deleted, every digest this file
// computes is the one 79807db computed, line for line (checked over all of them at the re-pin); scripted runs
// keep that proof standing in tests/rebanded-goods-delta.test.js. Where a test below says "byte-identical to
// main" or "the pre-slice engine", read: apart from those two goods' price rows.
//
// ⤳ 02-11-26 (roadmap 2.6, droid engine slice 1 — the Tier-3 reband): digests pinned below were RE-PINNED again. The
// slice gave the droid's two parts their ruled sub-tier (drive_module → 3-2, droid_components → 3-2;
// docs/phase-1-tuning.md §Droids), which moves their seeded price rows (prices, price history, the quote ring, the
// snapshot's price fields and tier3Contract) in every state and view. With those two goods' keys deleted, every digest
// this file computes is the one 4bf6cbb computed, line for line (checked over all of them at the re-pin); scripted
// runs keep that proof standing in tests/rebanded-goods-delta.test.js. Read "byte-identical to main" or "the pre-slice
// engine" below as: apart from the re-banded goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { advance } = require('../run.js');
const { createState } = require('../state.js');
const { hashState } = require('../serialize.js');
const { saveState, appendJournal, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
// ⤳ 07-11-26: the droid batch-buy slice's one snapshot delta, stripped so the goldens below keep their old pins.
const { withoutDroidBatchQuote } = require('./droid-batch-quote-strip.js');
const { withoutInstallationQuotes } = require('./installation-quote-strip.js');
const { withoutDeepScanLanes } = require('./deep-scan-lane-strip.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { checkInvariants } = require('../invariants.js');
const { reveal } = require('../exploration.js');
const { hexDistance } = require('../transport.js');
const {
  SCAN_TICKS, SCAN_L1_TICKS, SCAN_L2_TICKS, SCAN_LEVELS, stepScanCompletions,
} = require('../deep-scan-arrays.js');
const { getStarterSystems, getSystem, getSystemLayout, getBoard } = require('../seed.js');
const { placeCraft } = require('./kit-fixtures.js');
const { idleArrayScript } = require('./idle-array-script.js');
const { withoutRivalGround } = require('./rival-leak-script.js');
const { withoutRecordSlots, withoutKnownSlots, stripKnownSlots } = require('./slot-strip.js');
const { withSystemsBlock } = require('./systems-block.js');
const {
  validateAction, applyAction, createQueueScanAction, createRemoveDeepScanArrayAction, createFoundGuildAction,
} = require('../actions.js');

// The base galaxy (idle-array-script.js): two founded guilds, and A's one idle array touching its home.
const { steps: { deployed: BASE }, A, B, aHome, bHome, deployArrayAtHome, ok } = idleArrayScript();
const ARRAY = `deepScanArray_${A}_01`;

// Targets, derived from the seed so a regen carries the tests. Each is an UNCLAIMED STARTER system with at
// least three planets: a starter, because founding is the only way the engine claims a system today, so a
// third guild can really found on one mid-scan.
const planetsOf = (systemId) => getSystemLayout(systemId).planets;
const unclaimedStarters = getStarterSystems().map((s) => s.id)
  .filter((id) => id !== aHome && id !== bHome && planetsOf(id).length >= 3);
const TARGET = unclaimedStarters[0];        // what A scans in the happy path
const CONTESTED = unclaimedStarters[1];     // what a third guild founds on mid-scan
const [P1, P2] = planetsOf(TARGET).map((p) => p.id);

const sha = (text) => createHash('sha256').update(text).digest('hex');
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const arrayOf = (s, id = ARRAY) => (s.deepScanArrays || []).find((a) => a.id === id);
const recordOf = (s, id = A) => guildOf(s, id).exploration;
const L1 = (systemId, guildId = A) => createQueueScanAction({ guildId, arrayId: ARRAY, level: 'L1', targetSystemId: systemId });
const L2 = (planetId, guildId = A) => createQueueScanAction({ guildId, arrayId: ARRAY, level: 'L2', targetPlanetId: planetId });
const accept = (s, action) => {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(s, action);
};
const refuse = (s, action) => {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, false, `expected ${action.type} refused`);
  return reason;
};
// Every tick goes through advance(), so the invariants are asserted on each one.
function tickN(s, n) {
  for (let i = 0; i < n; i += 1) s = advance(s, []).state;
  return s;
}
// The guild learns `planetId`'s archetype directly — the stand-in for whatever taught it (an L1 scan, a craft
// visit, a rival's licensed venture). A fresh clone, so the shared fixtures stay untouched.
function knowing(s, planetId) {
  const next = structuredClone(s);
  reveal(guildOf(next, A), { planetId }, next.tick);
  return next;
}

// The L1 of TARGET, run to completion once and shared (advance() is pure, so no test can disturb it).
let afterL1Memo = null;
function afterL1() {
  if (!afterL1Memo) afterL1Memo = tickN(accept(BASE, L1(TARGET)), SCAN_L1_TICKS);
  return afterL1Memo;
}

// --- 1. the numbers -------------------------------------------------------------------------------------

test('the durations are the ruled [FIRST-CUT] values — L1 720, L2 480 — live once, and match phase-1-tuning.md', () => {
  assert.deepEqual({ ...SCAN_TICKS }, { L1: 720, L2: 480 });
  assert.equal(SCAN_L1_TICKS, 720);
  assert.equal(SCAN_L2_TICKS, 480);
  assert.deepEqual([...SCAN_LEVELS], ['L1', 'L2']);
  assert.ok(Object.isFrozen(SCAN_TICKS));
  // The doc the numbers came from still says them — a retune that moves one and not the other fails here.
  const tuning = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'phase-1-tuning.md'), 'utf8');
  assert.match(tuning, /L1\s+system scan\*\*[^=]*= \*\*720 ticks \(12 h\)\*\*/);
  assert.match(tuning, /L2\s+per-planet scan\*\*[^=]*= \*\*480 ticks \(8 h\)\*\*/);
});

// --- 2. L1 and L2 -----------------------------------------------------------------------------------------

test('queueScan stamps ONE job on the idle array — level, target, startedTick now, completeTick now + 720 — and moves nothing else', () => {
  assert.equal('scan' in arrayOf(BASE), false, 'a deployed array starts idle');
  const s = accept(BASE, L1(TARGET));
  assert.deepEqual(arrayOf(s).scan, { level: 'L1', targetSystemId: TARGET, startedTick: BASE.tick, completeTick: BASE.tick + 720 });
  // Nothing else in the galaxy moved: no fuel, no credits, no record — a scan's only price is time.
  const without = structuredClone(s);
  delete arrayOf(without).scan;
  assert.equal(hashState(without), hashState(BASE));
});

test('L1 SCAN: at the end of tick start + 720 the guild knows every planet\'s ARCHETYPE in the target system, and NO surface', () => {
  const queued = accept(BASE, L1(TARGET));
  const before = recordOf(queued);
  const almost = tickN(queued, SCAN_L1_TICKS - 1);
  assert.equal(arrayOf(almost).scan.completeTick, almost.tick + 1, 'one tick to go: still running');
  assert.deepEqual(recordOf(almost), before, 'nothing is revealed early');

  const done = tickN(almost, 1);
  assert.equal(done.tick, BASE.tick + 720);
  const record = recordOf(done);
  for (const planet of planetsOf(TARGET)) {
    assert.deepEqual(record[planet.id], { tick: done.tick, nodes: {}, slots: {} }, `${planet.id}: archetype known, no node, no slot`);
  }
  // Exactly those planets were added; everything the guild knew before is untouched.
  const added = Object.keys(record).filter((p) => !(p in before)).sort();
  assert.deepEqual(added, planetsOf(TARGET).map((p) => p.id).sort());
  for (const p of Object.keys(before)) assert.deepEqual(record[p], before[p]);
  assert.equal('scan' in arrayOf(done), false, 'the job cleared — the array is idle again');
  assert.deepEqual(done, afterL1(), 'the shared fixture is this same run');
});

// SURFACED: a TARGET planet with both kinds of surface — resource nodes AND settlement slots — derived from the
// seed, so the L2 test below proves "the whole surface" rather than passing on a zero-slot archetype (a gas
// giant, molten or irradiated world carries none, design.md §2).
const SURFACED = planetsOf(TARGET).find((p) => p.resourceNodes.length > 0 && p.settlementSlots.length > 0).id;

test('L2 SCAN, after the L1: at start + 480 the guild knows THAT planet\'s whole surface — every node and every slot — and no other\'s', () => {
  const l1 = afterL1();
  const queued = accept(l1, L2(SURFACED));
  assert.deepEqual(arrayOf(queued).scan, { level: 'L2', targetPlanetId: SURFACED, startedTick: l1.tick, completeTick: l1.tick + 480 });
  const almost = tickN(queued, SCAN_L2_TICKS - 1);
  assert.deepEqual(recordOf(almost), recordOf(l1), 'nothing is revealed early');

  const done = tickN(almost, 1);
  assert.equal(done.tick, l1.tick + 480);
  const record = recordOf(done);
  const row = planetsOf(TARGET).find((p) => p.id === SURFACED);
  const nodes = row.resourceNodes.map((n) => n.id);
  const slots = row.settlementSlots.map((x) => x.id);
  assert.deepEqual(record[SURFACED], {
    tick: l1.tick,
    nodes: Object.fromEntries(nodes.map((n) => [n, done.tick])),
    slots: Object.fromEntries(slots.map((x) => [x, done.tick])),
  }, 'every node AND every settlement slot of the planet, stamped now; the planet keeps the tick it was learned at L1 (learn-once)');
  for (const planet of planetsOf(TARGET)) {
    if (planet.id !== SURFACED) assert.deepEqual(record[planet.id], recordOf(l1)[planet.id], `${planet.id} untouched`);
  }
  assert.equal('scan' in arrayOf(done), false);
  assert.deepEqual(checkInvariants(done, done.tick), [], 'the slot guard passes on a real survey');
});

// --- 3. the chain --------------------------------------------------------------------------------------

test('THE CHAIN is per PLANET: no L2 on a planet whose archetype is unknown; knowing P1 opens an L2 on P1 only', () => {
  assert.match(refuse(BASE, L2(P1)), /archetype is not known yet — an L2 scan needs the planet known at L1 first/);
  const knowsP1 = knowing(BASE, P1);
  accept(knowsP1, L2(P1));
  assert.match(refuse(knowsP1, L2(P2)), /planet .* archetype is not known yet/, 'P2 shares P1\'s system, but its own archetype is the gate');
  // After the L1 of the whole system, every planet in it is open to an L2.
  for (const planet of planetsOf(TARGET)) accept(afterL1(), L2(planet.id));
});

// --- 4. one active job ---------------------------------------------------------------------------------

test('ONE ACTIVE JOB: a busy array refuses a second scan of any kind; once its job completes it takes the next', () => {
  const busy = tickN(accept(BASE, L1(TARGET)), 100);
  for (const action of [L1(CONTESTED), L1(TARGET), L2(P1)]) {
    assert.match(refuse(knowing(busy, P1), action), /is already running an L1 scan of system .* \(it completes at tick 720\) — one job per array, and no queue behind it/);
  }
  accept(afterL1(), L1(CONTESTED));
});

// --- 5. targets ----------------------------------------------------------------------------------------

test('TARGETS: a rival-held system is refused (L3), your own is refused, an unclaimed one is accepted — at either level', () => {
  const bPlanet = planetsOf(bHome)[0].id;
  const aPlanet = planetsOf(aHome)[0].id;
  assert.match(refuse(BASE, L1(bHome)), new RegExp(`system ${bHome} is held by guild "${B}" — scanning a rival's territory is espionage \\(L3\\)`));
  assert.match(refuse(knowing(BASE, bPlanet), L2(bPlanet)), /is held by guild .* espionage \(L3\)/);
  assert.match(refuse(BASE, L1(aHome)), new RegExp(`system ${aHome} is yours — your own ground you already know`));
  assert.ok(guildOf(BASE, A).exploration[aPlanet], 'A knows its home planet, so only the own-ground rule refuses this L2');
  assert.match(refuse(BASE, L2(aPlanet)), /is yours/);
  accept(BASE, L1(TARGET));
  accept(knowing(BASE, P1), L2(P1));
});

test('NO REACH LIMIT: the system farthest from the array, anywhere in the galaxy, is a legal target', () => {
  const at = arrayOf(BASE).coords;
  const far = getBoard().systems.reduce((best, sys) => (hexDistance(sys.coords, at) > hexDistance(best.coords, at) ? sys : best));
  assert.ok(hexDistance(far.coords, at) > 20);
  assert.deepEqual(arrayOf(accept(BASE, L1(far.id))).scan.targetSystemId, far.id);
});

test('REFUSED WHOLE: an unknown guild, an array not its own, a bad level, a target not on the seed, the wrong target key', () => {
  assert.match(refuse(BASE, L1(TARGET, 'nobody')), /no guild with id "nobody"/);
  assert.match(refuse(BASE, L1(TARGET, B)), new RegExp(`guild "${B}" owns no Deep Scan Array "${ARRAY}"`));
  assert.match(refuse(BASE, createQueueScanAction({ guildId: A, arrayId: 'deepScanArray_x_01', level: 'L1', targetSystemId: TARGET })), /owns no Deep Scan Array/);
  assert.match(refuse(BASE, createQueueScanAction({ guildId: A, arrayId: ARRAY, level: 'L3', targetSystemId: TARGET })), /level must be one of L1, L2, got "L3"/);
  assert.match(refuse(BASE, L1('sys_nope')), /targetSystemId "sys_nope" is not a system on the seed/);
  assert.match(refuse(BASE, L2('pl_nope')), /targetPlanetId "pl_nope" is not a planet on the seed/);
  assert.match(refuse(BASE, createQueueScanAction({ guildId: A, arrayId: ARRAY, level: 'L1', targetPlanetId: P1 })), /an L1 scan surveys a whole system — name targetSystemId, not targetPlanetId/);
  assert.match(refuse(BASE, createQueueScanAction({ guildId: A, arrayId: ARRAY, level: 'L2', targetSystemId: TARGET })), /an L2 scan surveys one planet — name targetPlanetId, not targetSystemId/);
  assert.throws(() => createQueueScanAction({ guildId: A, arrayId: ARRAY }), /level is required/);
  assert.throws(() => createRemoveDeepScanArrayAction({ guildId: A }), /arrayId is required/);
});

// --- 6. completion, re-validated -----------------------------------------------------------------------

const C = 'third-guild';
const foundOn = (systemId) => createFoundGuildAction({ guildId: C, name: 'Third', credits: 2000, influence: 100, homeSystemId: systemId });

test('RE-VALIDATED, L1: a rival founding on the target mid-scan voids the job — the record is unchanged and the job clears', () => {
  const queued = accept(BASE, L1(CONTESTED));
  const mid = ok(tickN(queued, 300), [foundOn(CONTESTED)]); // C now holds it, 420 ticks before completion
  assert.ok(arrayOf(mid).scan, 'the job keeps running — it is judged at completion, not cancelled');
  const done = tickN(mid, SCAN_L1_TICKS - 300);
  assert.equal(done.tick, queued.tick + 720);
  assert.deepEqual(recordOf(done), recordOf(queued), 'nothing revealed — not even a partial reveal');
  assert.equal('scan' in arrayOf(done), false, 'the voided job is cleared all the same');
  for (const planet of planetsOf(CONTESTED)) assert.equal(planet.id in recordOf(done), false);
});

test('RE-VALIDATED, L2: the target PLANET\'s system is the one re-checked', () => {
  const p = planetsOf(CONTESTED)[1].id;
  const queued = accept(knowing(BASE, p), L2(p));
  const mid = ok(tickN(queued, 10), [foundOn(CONTESTED)]);
  const done = tickN(mid, SCAN_L2_TICKS - 10);
  assert.deepEqual(recordOf(done)[p], { tick: BASE.tick, nodes: {}, slots: {} }, 'the archetype it already knew, and no node or slot');
  assert.equal('scan' in arrayOf(done), false);
});

test('RE-VALIDATED, own ground: if the SCANNING guild comes to hold the target mid-scan, the reveal still lands', () => {
  const mid = tickN(accept(BASE, L1(TARGET)), 300);
  // No Prefecture yet, so A's claim is written in directly — the stand-in for the claim slice to come.
  const claimed = structuredClone(mid);
  claimed.claims.push({ claimId: `claim_${A}_${TARGET}`, ownerGuildId: A, landmarkId: TARGET, landmarkKind: 'system', claimedAtTick: mid.tick, contested: false });
  const done = tickN(claimed, SCAN_L1_TICKS - 300);
  for (const planet of planetsOf(TARGET)) assert.deepEqual(recordOf(done)[planet.id], { tick: done.tick, nodes: {}, slots: {} });
});

// --- 7. array lost mid-job ------------------------------------------------------------------------------

test('ARRAY LOST MID-JOB: removeDeepScanArray takes the job with it — nothing fires at the old completeTick; banked facts stay', () => {
  const l1 = afterL1();
  const mid = tickN(accept(l1, L2(P1)), 200);
  const removed = accept(mid, createRemoveDeepScanArrayAction({ guildId: A, arrayId: ARRAY }));
  assert.equal('deepScanArrays' in removed, false, 'the last array gone → the key goes too (omit-when-empty)');
  assert.equal(guildOf(removed, A).deepScanArraySerial, 1, 'the serial is untouched');
  const past = tickN(removed, SCAN_L2_TICKS);
  assert.ok(past.tick > l1.tick + 480, 'past the old completeTick');
  assert.deepEqual(recordOf(past), recordOf(l1), 'no L2 node arrived; every L1 archetype stayed');
  // The removed id is never reissued: the next array is _02.
  const home = { landmarkKind: 'system', landmarkId: aHome };
  const again = deployArrayAtHome(placeCraft(structuredClone(past), A, `vehicle_${A}_heavyTransport_01`, home), A, aHome);
  assert.deepEqual(again.deepScanArrays.map((a) => a.id), [`deepScanArray_${A}_02`]);
});

test('removeDeepScanArray is owner-checked: an unknown array, or another guild\'s, is refused', () => {
  assert.match(refuse(BASE, createRemoveDeepScanArrayAction({ guildId: B, arrayId: ARRAY })), new RegExp(`guild "${B}" owns no Deep Scan Array "${ARRAY}"`));
  assert.match(refuse(BASE, createRemoveDeepScanArrayAction({ guildId: A, arrayId: 'deepScanArray_x_01' })), /owns no Deep Scan Array/);
  assert.match(refuse(BASE, createRemoveDeepScanArrayAction({ guildId: 'nobody', arrayId: ARRAY })), /no guild with id/);
});

// --- 8. determinism ---------------------------------------------------------------------------------------

test('DETERMINISM: a mid-flight job survives save → restore byte-identically, and completes identically', (t) => {
  const mid = tickN(accept(BASE, L1(TARGET)), 250);
  assert.equal(hashState(tickN(accept(BASE, L1(TARGET)), 250)), hashState(mid), 'two runs agree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(mid, dir);
  const restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
  assert.equal(hashState(restored), hashState(mid));
  assert.deepEqual(arrayOf(restored).scan, arrayOf(mid).scan);
  const a = tickN(mid, SCAN_L1_TICKS - 250);
  const b = tickN(restored, SCAN_L1_TICKS - 250);
  assert.equal(hashState(b), hashState(a), 'the restored job completes to the same bytes');
  assert.deepEqual(recordOf(b), recordOf(afterL1()));
});

test('DETERMINISM: a journalled queueScan and removeDeepScanArray replay to the same bytes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(BASE, dir);
  let s = BASE;
  for (const action of [L1(TARGET)]) { s = accept(s, action); appendJournal(s.tick, action, dir); }
  assert.equal(hashState(loadOrInit(dir, () => { throw new Error('should restore'); })), hashState(s));
  const removal = createRemoveDeepScanArrayAction({ guildId: A, arrayId: ARRAY });
  s = accept(s, removal);
  appendJournal(s.tick, removal, dir);
  assert.equal(hashState(loadOrInit(dir, () => { throw new Error('should restore'); })), hashState(s));
});

test('createState carries a handed-in job, as a copy — never an alias', () => {
  const mid = accept(BASE, L1(TARGET));
  const handed = mid.deepScanArrays;
  const rebuilt = createState({ guilds: [{ id: A, credits: 0, fuelHoard: 0, deepScanArraySerial: 1 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, deepScanArrays: handed });
  assert.deepEqual(rebuilt.deepScanArrays, handed);
  assert.notEqual(rebuilt.deepScanArrays[0].scan, handed[0].scan, 'a fresh job object');
  const idle = createState({ guilds: [{ id: A, credits: 0, fuelHoard: 0, deepScanArraySerial: 1 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, deepScanArrays: BASE.deepScanArrays });
  assert.equal('scan' in idle.deepScanArrays[0], false, 'an idle array stays keyless');
});

// --- 9. omit-when-idle: byte-identical to main --------------------------------------------------------------

// Recorded on main at 52e5e3f — BEFORE the scan existed — by copying tests/idle-array-script.js into a checkout
// of that commit and hashing each step's state (hashState), the god's-eye lens and both guilds' views
// (JSON.stringify(buildSnapshot(state[, guildId]))). If one moves, an idle array (or the end-of-tick block
// over one) changed: find out why before re-pinning.
// ⤳ 08-10-26 (ruling 11, docs/exploration-model.md §4): the two VIEW pins below are no longer the full view —
// each view now also shows the RIVAL's home system at full L2 (control ⇒ L2, live), so the full view moved. They
// are kept as the STRIP-AND-PROVE: the view with the rival-held ground taken out (`withoutRivalGround`) still
// hashes to these 52e5e3f bytes, so that is the ONLY place it moved. The full views are re-pinned in
// IDLE_ARRAY_VIEWS_RULING_11. The state and god's-eye pins did not move (no rival licensed venture here, so the
// removed register step never wrote anything; and the god's-eye lens carries no record).
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const IDLE_ARRAY_ON_MAIN = {
  deployed: {
    state: '4e2d006b07d9aecde8617a1e23325d0cc6a8deae823932eb494e59bbe4265b7d',
    godsEye: 'ebeb77354279bbbce41cf9806387e8f670a7016d33146310cad45d8e979a9715',
    [A]: '0cb9db3950c9e22f001ba8be8929ff6bc00571ced8069f4dac70270963b5fab8',
    [B]: '095d0fdf24c02d554cacd98b20cbe332e9321cd86aca718bbc83a22c20a550ce',
  },
  ticked: {
    state: 'be08506563553dd7ea22aafecd2b552e2299ac483244eebd975c516885af2fef',
    godsEye: '93f502851572f53004301351dfb8b54301ae32a85b4af937452c0ed3889efff6',
    [A]: 'f171e6513fd836e2ac60d374f5e95d95ce17a5cc59745f0aa46dc3bc843aa376',
    [B]: 'c8813916ce29ae1f5292daaff60674ec8dd0bd3cbd5aa423268057aa07c1b46a',
  },
};

// The full per-guild views of the same two steps, recorded 08-10-26 after ruling 11's cleanup.
// ⤳ 09-10-26 (the settlement-surface slice): no longer the full views either — each `known` entry now
// carries `slots` — but kept as the strip-and-prove: strip the slots and the view still hashes to these.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const IDLE_ARRAY_VIEWS_RULING_11 = {
  deployed: {
    [A]: '385f297ecf4e468e3c2164ec957aabad9e8141125f21195877f8fd7090581704',
    [B]: '3c4e1c20ddebef9393a37297dc1d071c27998f1033f495a314917bb87fa7147a',
  },
  ticked: {
    [A]: '280e1eb15751c816313dcd958b6e24f425ecd93531b1d8959a242710acbba8b6',
    [B]: 'f198c81b051c6620e71e6c971092eef4794aeae2327c4dee9c75b97fd928feba',
  },
};

// The full state and per-guild views of the same two steps, recorded 09-10-26 after the settlement-surface
// slice: founding records the home system's settlement slots, and every `known` entry carries `slots`.
// ⤳ 09-10-26 (the L0-board slice): the two VIEW pins are no longer the full views — `geography.systems` is
// gone — but kept as the put-back-and-prove: put the block back (from the board + the view's own claims) and
// the view still hashes to these. The state pins are still the full state (the slice moved no state).
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const IDLE_ARRAY_WITH_SLOTS = {
  deployed: {
    state: 'aa6fe11d5605368ce2014b54db5806a6227e45822c2b2d94b82f19a362e78462',
    [A]: '8e4a504678ed716d2ca1deac4ae19e61dedd28697db3981e4b124d17a7370e64',
    [B]: 'ee3c8f461d0d8c8a9e732764175a1396b646ad575064275558214374baeef62e',
  },
  ticked: {
    state: '2221f17fbe16c2adfa119a64ca86921382fa6afb1ececa43ab39a556d3c817a0',
    [A]: 'e9489dca802ffeb4c8aad541f7a59b9e6c27022f602e86168bad3f109ab30d44',
    [B]: 'd8915a4357f2352dd53aad422de7559acf5a7067603aa4e2af245f0b5c1920fd',
  },
};

// The full per-guild views after the L0-board slice (ruling 12 slice 2). Recorded on main at 348e0fc — BEFORE
// the slice — by deleting `geography.systems` from each IDLE_ARRAY_WITH_SLOTS view and hashing the rest.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
// RE-PINNED 10-11-26 (maintenance slice 3): this script flies a craft, which now wears in flight. main's (bb1a9c5) bytes and these, each with every vehicle maintenanceCondition and the slice's added craftMaintenance / maintenanceCovered keys removed, hash identically — wear is the only change.
const IDLE_ARRAY_SLIM = {
  deployed: {
    [A]: '75a6caea3ccf4eeb5ce88406ad3e6759efee14ea60f3d0d1adb0e9f1fcad1bf0',
    [B]: '4d76b84402789f9df26e942fb7a3e2c7038561f80126f2df39e5734c4da9f293',
  },
  ticked: {
    [A]: '80ff8795d0c16cfccd9792091a5ee9916c22729880c75f252390ee9918df1f61',
    [B]: '933f3eec5a4d4bb9ecaae23f8ada599faaf42e5b354a68a2365afa7b33b21177',
  },
};

test('OMIT-WHEN-IDLE: a galaxy whose array is idle is byte-identical to main before the scan — state, god\'s-eye, both views', () => {
  const { steps } = idleArrayScript();
  for (const [name, pins] of Object.entries(IDLE_ARRAY_ON_MAIN)) {
    const s = steps[name];
    assert.equal(hashState(s), IDLE_ARRAY_WITH_SLOTS[name].state, `the state moved at "${name}"`);
    // Strip the record's slots (the settlement-surface slice) and it is the 52e5e3f state, byte for byte.
    const { state: noSlots, count } = withoutRecordSlots(s);
    assert.ok(count > 0, 'the foundings really recorded settlement slots');
    assert.equal(hashState(noSlots), pins.state, `the state moved OUTSIDE the record's slots at "${name}"`);
    // ⤳ 15-10-26: every lens/view hash here goes through the installation-quote strip (tests/installation-quote-strip.js) —
    // the installation kit acquire slice added two public assetPurchaseQuote rows and nothing else, so the pins stay as they were.
    // ⤳ 15-10-26 (slice 14b): and through the deepScan-lane strip (tests/deep-scan-lane-strip.js) — every guild row
    // holding a system gained `deployRange.deepScan` and nothing else moved, so the pins still stand.
    // ⤳ 16-10-26 (the Prefecture / claims slice, engine PR 2): and through the control-map strip (tests/control-map-strip.js)
    // — every snapshot and view gained the public `controlMap` and nothing else moved, so the pins still stand.
    assert.equal(sha(JSON.stringify(withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(withoutDroidBatchQuote(buildSnapshot(s))))))), pins.godsEye, `the god's-eye lens moved at "${name}"`);
    for (const guildId of [A, B]) {
      const view = withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(withoutDroidBatchQuote(buildSnapshot(s, guildId)))));
      assert.equal(sha(JSON.stringify(view)), IDLE_ARRAY_SLIM[name][guildId], `${guildId}'s view moved at "${name}"`);
      // Put `geography.systems` back and it is the 09-10-26 (settlement-surface) view…
      const legacy = withSystemsBlock(view);
      assert.equal(sha(JSON.stringify(legacy)), IDLE_ARRAY_WITH_SLOTS[name][guildId], `${guildId}'s view moved OUTSIDE geography.systems at "${name}"`);
      // …strip the slots from `known` and it is the 08-10-26 (ruling 11) view…
      const { view: noKnownSlots, count: shown } = withoutKnownSlots(legacy);
      assert.ok(shown > 0, `${guildId}'s view really shows settlement slots`);
      assert.equal(sha(JSON.stringify(noKnownSlots)), IDLE_ARRAY_VIEWS_RULING_11[name][guildId], `${guildId}'s view moved OUTSIDE the slots at "${name}"`);
      // …and strip the rival's ground too (ruling 11's projection) and it is the 52e5e3f view, byte for byte.
      assert.equal(sha(JSON.stringify(withoutRivalGround(stripKnownSlots(legacy)))), pins[guildId], `${guildId}'s view moved OUTSIDE the rival's ground at "${name}"`);
    }
  }
});

test('OMIT-WHEN-IDLE: once its job is done the array is the idle row again, byte for byte — in state and in the lens', () => {
  const rowBefore = JSON.stringify(arrayOf(BASE));
  const lensBefore = JSON.stringify(buildSnapshot(BASE).deepScanArrays);
  const running = accept(BASE, L1(TARGET));
  assert.deepEqual(buildSnapshot(running).deepScanArrays[0].scan, arrayOf(running).scan, 'while it runs, the lens carries the job');
  const done = afterL1();
  assert.equal(JSON.stringify(arrayOf(done)), rowBefore);
  assert.equal(JSON.stringify(buildSnapshot(done).deepScanArrays), lensBefore);
});

// --- 10. invariants -------------------------------------------------------------------------------------

test('INVARIANTS: a malformed scan job fails loudly, each its own rule', () => {
  const running = accept(knowing(BASE, P1), L2(P1)); // an L2 job, startedTick 0, completeTick 480
  assert.deepEqual(checkInvariants(running, running.tick), []);
  const broken = (edit) => {
    const s = structuredClone(running);
    edit(s, arrayOf(s));
    return checkInvariants(s, s.tick).map((v) => v.rule);
  };
  const has = (rules, rule) => assert.ok(rules.includes(rule), `expected ${rule}, got ${JSON.stringify(rules)}`);
  has(broken((s, a) => { a.scan = null; }), 'deepScanArray-scan-is-a-job-object (omit-when-idle)');
  has(broken((s, a) => { a.scan.level = 'L3'; }), 'deepScanArray-scan-level-is-ruled (deep-scan-arrays.js)');
  has(broken((s, a) => { a.scan.targetSystemId = TARGET; }), 'deepScanArray-scan-L2-targets-one-real-planet');
  has(broken((s, a) => { a.scan.targetPlanetId = 'pl_nope'; }), 'deepScanArray-scan-L2-targets-one-real-planet');
  has(broken((s, a) => { a.scan = { level: 'L1', targetSystemId: 'sys_nope', startedTick: 0, completeTick: 720 }; }), 'deepScanArray-scan-L1-targets-one-real-system');
  has(broken((s, a) => { a.scan = { level: 'L1', targetSystemId: TARGET, targetPlanetId: P1, startedTick: 0, completeTick: 720 }; }), 'deepScanArray-scan-L1-targets-one-real-system');
  has(broken((s, a) => { a.scan.startedTick = -1; a.scan.completeTick = 479; }), 'deepScanArray-scan-startedTick-in-the-array-lifetime (§15.2)');
  has(broken((s, a) => { a.scan.startedTick = 5; a.scan.completeTick = 485; }), 'deepScanArray-scan-startedTick-in-the-array-lifetime (§15.2)');
  has(broken((s, a) => { a.scan.completeTick = 481; }), 'deepScanArray-scan-duration-is-the-ruled-one (phase-1-tuning.md)');
  has(broken((s) => { s.tick = 480; }), 'deepScanArray-scan-never-overdue (stepScanCompletions)');
  has(broken((s) => { delete guildOf(s, A).exploration[P1]; }), 'deepScanArray-scan-L2-chain-holds (§5)');
});

test('HALT: the completion step throws, naming the tick, on a job of unknown level or an array with no owner', () => {
  const odd = structuredClone(accept(BASE, L1(TARGET)));
  arrayOf(odd).scan.level = 'L9';
  assert.throws(() => stepScanCompletions(odd, 720), /at tick 720 .* unknown level "L9"/);
  const orphan = structuredClone(accept(BASE, L1(TARGET)));
  arrayOf(orphan).ownerGuildId = 'ghost';
  assert.throws(() => stepScanCompletions(orphan, 720), /at tick 720 .* for guild "ghost", which does not exist/);
  // And a job not yet due is left alone.
  const early = structuredClone(accept(BASE, L1(TARGET)));
  stepScanCompletions(early, 719);
  assert.ok(arrayOf(early).scan);
});
