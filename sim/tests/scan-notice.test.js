'use strict';

// scan-notice.test.js — the scan's two loose ends (roadmap 2.5, ruling 12 slice-3b checklist items 9(a) and 8;
// ruled 14-10-26 by the design room; docs/event-log.md §13, docs/exploration-model.md §5):
//
//   1. THE NOTICE: a Deep Scan Array finishing its job writes ONE notice to its guild's event log —
//      `scan_complete` on the reveal path, ALWAYS (even when nothing new was learned), or `scan_voided`
//      naming the rival when a rival came to hold the target first. Self-contained payloads, stamped `tick`.
//   2. THE GOLDENS DELTA: the notice is the ONLY thing the slice adds to a finishing scan. Strip it and the
//      state, the god's-eye lens and the owner's view are main's bytes from before the slice (8b24026); a
//      rival's view never moved at all.
//   3. THE DUPLICATE-TARGET GUARD: `queueScan` refuses a scan whose exact (level, target) another of the
//      guild's own arrays is already running. Another planet of the same system, or an L1 against an L2 of
//      one of its planets, is not a duplicate. A RIVAL's array is never counted: its jobs are private.
//
// The scan mechanic itself (the reveal, the void condition, the durations) is deep-scan-job.test.js's.

// ⤳ 16-10-26 (roadmap 2.5, the Prefecture / claims slice): digests pinned below were RE-PINNED. The slice
// re-banded two Tier-3 modules the Prefecture bill uses (claim_beacon → 3-2, habitation_module → 3-3;
// docs/phase-1-tuning.md), which moves their seeded price rows (prices, price history, the quote ring, and the
// snapshot's price fields) in every state and view. With those two goods' keys deleted, every digest this file
// computes is the one 79807db computed, line for line (checked over all of them at the re-pin); scripted runs
// keep that proof standing in tests/rebanded-goods-delta.test.js. Where a test below says "byte-identical to
// main" or "the pre-slice engine", read: apart from those two goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { withoutInstallationQuotes } = require('./installation-quote-strip.js');
const { withoutDeepScanLanes } = require('./deep-scan-lane-strip.js');
const { withoutControlMap } = require('./control-map-strip.js');
const { checkInvariants } = require('../invariants.js');
const { reveal, revealPlanetSurface } = require('../exploration.js');
const { SCAN_COMPLETE, SCAN_VOIDED } = require('../events.js');
const { stepScanCompletions, scanTargetName } = require('../deep-scan-arrays.js');
const {
  getSystem, getSystemLayout, getBoard, getClaimRadius, isHexInBounds, seedLandmarkAtHex, roman,
} = require('../seed.js');
const {
  validateAction, applyAction, createQueueScanAction, createFoundGuildAction, createDeployAssetAction,
} = require('../actions.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const { scanNoticeScript } = require('./scan-notice-script.js');

const script = scanNoticeScript();
const { steps, A, B, C, ARRAY, TARGET, CONTESTED, SURFACED, deployed: BASE, ok, tickN } = script;
const ARRAY_2 = `deepScanArray_${A}_02`;

const sha = (text) => createHash('sha256').update(text).digest('hex');
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const arrayOf = (s, id = ARRAY) => (s.deepScanArrays || []).find((a) => a.id === id);
const eventsOf = (s, id = A) => guildOf(s, id).events || [];
const planetsOf = (systemId) => getSystemLayout(systemId).planets;
const scan = (level, target, arrayId = ARRAY, guildId = A) => createQueueScanAction({
  guildId, arrayId, level, ...(level === 'L1' ? { targetSystemId: target } : { targetPlanetId: target }),
});
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
// The guild learns `planetId`'s archetype directly (the stand-in for an L1), on a fresh clone.
function knowing(s, ...planetIds) {
  const next = structuredClone(s);
  for (const planetId of planetIds) reveal(guildOf(next, A), { planetId }, next.tick);
  return next;
}
// A planet's designation the way the CLIENT builds it (game.html `__planetDesignation`): the board's system
// name and the board's `order`, as a Roman numeral. The engine's targetName must agree with it.
function boardDesignation(planetId) {
  for (const sys of getBoard().systems) {
    const p = sys.planets.find((x) => x.id === planetId);
    if (p) return `${sys.name} ${roman(p.order)}`;
  }
  return null;
}

// --- 1. the notice -----------------------------------------------------------------------------------------

test('L1 COMPLETE: one scan_complete, at the completion tick, born unread — the system\'s name and every archetype counted new', () => {
  const s = steps.l1Done;
  assert.equal(s.tick, 720);
  assert.equal('scan' in arrayOf(s), false, 'the job cleared');
  assert.deepEqual(eventsOf(s), [{
    id: 0, tick: 720, type: SCAN_COMPLETE,
    payload: { arrayId: ARRAY, level: 'L1', targetSystemId: TARGET, targetName: getSystem(TARGET).name, newFacts: planetsOf(TARGET).length },
  }]);
  // newFacts is the reveal's own count: exactly the planets the record gained.
  assert.equal(Object.keys(guildOf(s, A).exploration).filter((p) => planetsOf(TARGET).some((x) => x.id === p)).length, planetsOf(TARGET).length);
  assert.equal(eventsOf(s, B).length, 0, 'the rival is told nothing');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'checkEventLog accepts the new type');
});

test('L2 COMPLETE: the planet\'s designation (as the client names it) and its whole surface counted new', () => {
  const s = steps.l2Done;
  const row = planetsOf(TARGET).find((p) => p.id === SURFACED);
  const last = eventsOf(s)[eventsOf(s).length - 1];
  assert.deepEqual(last, {
    id: 1, tick: 1200, type: SCAN_COMPLETE,
    payload: {
      arrayId: ARRAY, level: 'L2', targetPlanetId: SURFACED, targetName: boardDesignation(SURFACED),
      newFacts: row.resourceNodes.length + row.settlementSlots.length,
    },
  });
  assert.match(last.payload.targetName, new RegExp(`^${getSystem(TARGET).name} [IVX]+$`));
  assert.ok(last.payload.newFacts > 0);
});

test('NOTHING NEW: a scan of an already-charted target still emits scan_complete, newFacts 0, and learns nothing', () => {
  // The script's third run: the same L1 again, every archetype already known.
  const s = steps.repeatDone;
  assert.deepEqual(eventsOf(s).map((e) => e.payload.newFacts), [planetsOf(TARGET).length, eventsOf(steps.l2Done)[1].payload.newFacts, 0]);
  assert.deepEqual(eventsOf(s)[2], {
    id: 2, tick: 1920, type: SCAN_COMPLETE,
    payload: { arrayId: ARRAY, level: 'L1', targetSystemId: TARGET, targetName: getSystem(TARGET).name, newFacts: 0 },
  });
  assert.deepEqual(guildOf(s, A).exploration, guildOf(steps.l2Done, A).exploration, 'learn-once: the record did not move');
  // And an L2 of a planet whose surface is already known: newFacts 0 there too.
  const charted = structuredClone(steps.l1Done);
  revealPlanetSurface(guildOf(charted, A), SURFACED, charted.tick);
  const done = tickN(accept(charted, scan('L2', SURFACED)), 480);
  assert.deepEqual(eventsOf(done).slice(-1)[0].payload, {
    arrayId: ARRAY, level: 'L2', targetPlanetId: SURFACED, targetName: boardDesignation(SURFACED), newFacts: 0,
  });
  assert.deepEqual(guildOf(done, A).exploration, guildOf(charted, A).exploration);
});

test('OWN GROUND: if the scanning guild comes to hold the target mid-scan, it still reveals — and still says scan_complete', () => {
  const mid = tickN(accept(BASE, scan('L1', TARGET)), 300);
  const claimed = structuredClone(mid);
  claimed.claims.push({ claimId: `claim_${A}_${TARGET}`, ownerGuildId: A, landmarkId: TARGET, landmarkKind: 'system', claimedAtTick: mid.tick, contested: false });
  const done = tickN(claimed, 420);
  assert.deepEqual(eventsOf(done), [{
    id: 0, tick: 720, type: SCAN_COMPLETE,
    payload: { arrayId: ARRAY, level: 'L1', targetSystemId: TARGET, targetName: getSystem(TARGET).name, newFacts: planetsOf(TARGET).length },
  }]);
});

test('VOIDED, L1: a rival founding on the target mid-scan → one scan_voided naming it; nothing revealed; the job cleared', () => {
  const s = steps.voided;
  assert.equal(s.tick, 720);
  assert.equal('scan' in arrayOf(s), false);
  assert.deepEqual(eventsOf(s), [{
    id: 0, tick: 720, type: SCAN_VOIDED,
    payload: { arrayId: ARRAY, level: 'L1', targetSystemId: CONTESTED, targetName: getSystem(CONTESTED).name, byGuildId: C, byGuildName: 'Third' },
  }]);
  for (const planet of planetsOf(CONTESTED)) assert.equal(planet.id in guildOf(s, A).exploration, false, 'no partial reveal');
  assert.equal(eventsOf(s, C).length, 0, 'the claimer is not told: the job was private');
  assert.equal(eventsOf(s, B).length, 0);
});

test('VOIDED, L2: the target planet\'s system is the one re-checked, and the notice names the planet', () => {
  const p = planetsOf(CONTESTED)[1].id;
  const queued = accept(knowing(BASE, p), scan('L2', p));
  const mid = ok(tickN(queued, 10), [createFoundGuildAction({ guildId: C, name: 'Third', credits: 2000, influence: 100, homeSystemId: CONTESTED })]);
  const done = tickN(mid, 470);
  assert.deepEqual(eventsOf(done), [{
    id: 0, tick: 480, type: SCAN_VOIDED,
    payload: { arrayId: ARRAY, level: 'L2', targetPlanetId: p, targetName: boardDesignation(p), byGuildId: C, byGuildName: 'Third' },
  }]);
  assert.deepEqual(guildOf(done, A).exploration[p], { tick: BASE.tick, nodes: {}, slots: {} }, 'only the archetype it already knew');
});

test('VOIDED by a claim with no guild row: the controller\'s id stands in for its name', () => {
  // Unreachable today (every claim names a real guild), so it is staged on the step directly.
  const s = structuredClone(accept(BASE, scan('L1', CONTESTED)));
  s.claims.push({ claimId: 'claim_ghost', ownerGuildId: 'ghost', landmarkId: CONTESTED, landmarkKind: 'system', claimedAtTick: 0, contested: false });
  stepScanCompletions(s, 720);
  assert.deepEqual(eventsOf(s)[0].payload, {
    arrayId: ARRAY, level: 'L1', targetSystemId: CONTESTED, targetName: getSystem(CONTESTED).name, byGuildId: 'ghost', byGuildName: 'ghost',
  });
});

test('the notice is SURFACED like any notice: the owner\'s events row (with whenDay) and its unread attention — never a rival\'s view', () => {
  const s = steps.l1Done;
  const view = buildSnapshot(s, A);
  const row = guildOf(view, A).events[0];
  assert.equal(row.type, SCAN_COMPLETE);
  assert.equal(typeof row.whenDay, 'number', 'the engine derives the day the client shows');
  assert.equal('unlockDay' in row, false, 'no node is held');
  assert.deepEqual(view.attention.notices.map((n) => [n.guildId, n.type]), [[A, SCAN_COMPLETE]]);
  const rival = JSON.stringify(buildSnapshot(s, B));
  assert.equal(rival.includes('scan_complete'), false);
  assert.equal(rival.includes(ARRAY), false);
});

test('scanTargetName: a system\'s name, a planet\'s designation, the raw id when the seed has neither', () => {
  assert.equal(scanTargetName({ level: 'L1', targetSystemId: TARGET }), getSystem(TARGET).name);
  for (const planet of planetsOf(TARGET)) assert.equal(scanTargetName({ level: 'L2', targetPlanetId: planet.id }), boardDesignation(planet.id));
  assert.equal(scanTargetName({ level: 'L1', targetSystemId: 'sys_nope' }), 'sys_nope');
  assert.equal(scanTargetName({ level: 'L2', targetPlanetId: 'pl_nope' }), 'pl_nope');
});

// --- 2. the goldens delta: the notice is the only change ---------------------------------------------------

// Recorded on main at 8b24026 — BEFORE this slice — by copying tests/scan-notice-script.js into a checkout of
// that commit and hashing each step's state (hashState), the god's-eye lens and both guilds' views
// (JSON.stringify(buildSnapshot(state[, guildId]))). On main no scan writes a notice, so A's log was empty at
// every step. If a pin moves, the slice changed more than the notice: find out why before re-pinning.
const SCAN_STEPS_ON_MAIN = {
  l1Done: {
    state: '6f055b579a6855c48f359931d6a88a45c4a6dfac32ca8b9dcfa15835345fb1b7',
    godsEye: 'd3d3886f2cafc9be20c8ab15b33c9296054727eaaf513a7b2759922534a78cf2',
    [A]: 'fb7360434a651e89252d59d96992db9cbd8f2b2fdcea38d4f366796cd242b5fc',
    [B]: '2da411930a7657871dc44b956c81a612479c4402147f5c0703aa13e6335194c5',
  },
  l2Done: {
    state: 'd5f3aa7eeb2ec158a9b6c6c811841b101babb569d9a48474b805dd8242f77e1d',
    godsEye: 'ac683a7ab4336c2da6d1358697ece73624fa8934cba9a78f57fc2f4afbd1c9c6',
    [A]: '16b43126e9d24b8fd939ab50290a9b1f3b53c33a701e63b5095cb14c5607befe',
    [B]: 'ada4f48fba1480601906ce0a95d6efd14dec2ec582ded5a9446c9de158f6bd76',
  },
  repeatDone: {
    state: '002c3e6c06090acb498aa8b6fefb20944b2c108c5e79e9e992599d10eccbb543',
    godsEye: '884ab136fa0600ae8034ee5acb11fe88fb924e9c3a05fa94e0c572c8d3d7ba26',
    [A]: 'd21854d34e43030e65875fb1001c1df327686abc87d79ff62ae459ecf3947e62',
    [B]: 'c4c07315d497d9efc02027ec214a347ea52510303a6d13aa5df697535708f26b',
  },
  voided: {
    state: 'cef98d02bd04e340d775f7eff8cb2f2a371f84ef29a5ae90086b14fd607a4b6f',
    godsEye: '381c50437923dbb5bf76b044f95446e17c2f91cf1febbc2089b2bf51a6673f9b',
    [A]: 'bd7c50d7d0f07175d63e48720a1781a570506e03875cf1e3be12e2319bc09a2a',
    [B]: 'e23592c86d7016fd24649c82b078d91a542f51dfb54db55c67a8be2b461a3476',
  },
};
// How many scan notices each step should have written to A's log, in order.
const EXPECTED_NOTICES = {
  l1Done: [SCAN_COMPLETE], l2Done: [SCAN_COMPLETE, SCAN_COMPLETE],
  repeatDone: [SCAN_COMPLETE, SCAN_COMPLETE, SCAN_COMPLETE], voided: [SCAN_VOIDED],
};

const isScanNotice = (e) => e.type === SCAN_COMPLETE || e.type === SCAN_VOIDED;

// withoutScanNotices(state) -> { state, dropped }: a copy with every scan notice taken out of every guild's log
// and the guild's id counter wound back past them. Winding back is honest only if the scan notices are the
// guild's NEWEST rows, so that is checked; a guild left with no rows loses both lazy keys, as it never had them.
function withoutScanNotices(state) {
  const s = structuredClone(state);
  const dropped = [];
  for (const g of s.guilds) {
    if (!Array.isArray(g.events)) continue;
    const gone = g.events.filter(isScanNotice);
    if (!gone.length) continue;
    const kept = g.events.filter((e) => !isScanNotice(e));
    assert.ok(kept.every((k) => gone.every((e) => k.id < e.id)), 'the scan notices are the newest rows');
    dropped.push(...gone.map((e) => ({ guildId: g.id, ...e })));
    g.eventSeq -= gone.length;
    if (kept.length) g.events = kept;
    else delete g.events;
    if (g.eventSeq === 0) delete g.eventSeq;
  }
  return { state: s, dropped };
}
// The same for a lens: the scan rows out of each guild row's `events` and out of `attention.notices`.
function lensWithoutScanNotices(snapshot) {
  const out = structuredClone(snapshot);
  for (const g of out.guilds || []) if (Array.isArray(g.events)) g.events = g.events.filter((e) => !isScanNotice(e));
  if (out.attention) out.attention.notices = out.attention.notices.filter((n) => !isScanNotice(n));
  return out;
}

test('GOLDENS DELTA: strip the scan notices and every finished scan is main\'s bytes — state, god\'s-eye, the owner\'s view; the rival\'s view never moved', () => {
  for (const [name, pins] of Object.entries(SCAN_STEPS_ON_MAIN)) {
    const s = steps[name];
    // The full bytes DID move — by the notice — so this test can fail.
    assert.notEqual(hashState(s), pins.state, `${name}: the notice is really in the state`);
    const { state: stripped, dropped } = withoutScanNotices(s);
    assert.deepEqual(dropped.map((e) => [e.guildId, e.type]), EXPECTED_NOTICES[name].map((t) => [A, t]), `${name}: exactly the expected notices, all A's`);
    assert.equal(hashState(stripped), pins.state, `${name}: the state moved OUTSIDE the notice (the reveal or the job-clear changed)`);
    // ⤳ 15-10-26: every lens/view hash here goes through the installation-quote strip (tests/installation-quote-strip.js) —
    // the installation kit acquire slice added two public assetPurchaseQuote rows and nothing else, so the pins stay as they were.
    // ⤳ 15-10-26 (slice 14b): and through the deepScan-lane strip (tests/deep-scan-lane-strip.js) — every guild row
    // holding a system gained `deployRange.deepScan` and nothing else moved, so the pins still stand.
    // ⤳ 16-10-26 (the Prefecture / claims slice, engine PR 2): and through the control-map strip (tests/control-map-strip.js)
    // — every snapshot and view gained the public `controlMap` and nothing else moved, so the pins still stand.
    assert.equal(sha(JSON.stringify(lensWithoutScanNotices(withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(buildSnapshot(s))))))), pins.godsEye, `${name}: the god's-eye lens moved outside the notice`);
    assert.equal(sha(JSON.stringify(lensWithoutScanNotices(withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(buildSnapshot(s, A))))))), pins[A], `${name}: A's view moved outside the notice`);
    assert.equal(sha(JSON.stringify(withoutDeepScanLanes(withoutInstallationQuotes(withoutControlMap(buildSnapshot(s, B)))))), pins[B], `${name}: B's view moved at all`);
  }
});

// --- 3. the duplicate-target guard -------------------------------------------------------------------------

// withSecondArray(s) -> `s` with a second array of A's (deepScanArray_<A>_02) on another bare hex touching
// A's home: the starter heavy brought home (placed), an array kit granted and loaded, the heavy placed on the
// hex, then the real manual deploy — the idle-array script's recipe, skipping the hex array 01 stands on.
const DIRECTIONS = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }];
function withSecondArray(s) {
  const home = guildOf(s, A).homeSystemId;
  const heavy = `vehicle_${A}_heavyTransport_01`;
  const centre = getSystem(home).coords;
  const ring = getClaimRadius(home) + 1;
  const taken = new Set((s.deepScanArrays || []).map((a) => `${a.coords.q},${a.coords.r}`));
  const hex = DIRECTIONS.map((d) => ({ q: centre.q + ring * d.q, r: centre.r + ring * d.r }))
    .find((h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r) && !taken.has(`${h.q},${h.r}`));
  let next = placeCraft(structuredClone(s), A, heavy, { landmarkKind: 'system', landmarkId: home });
  next = placeCraft(kitAboard(next, A, heavy, 'deepScan'), A, heavy, hex);
  next = ok(next, [createDeployAssetAction({ guildId: A, vehicleId: heavy })]);
  assert.deepEqual(next.deepScanArrays.filter((a) => a.ownerGuildId === A).map((a) => a.id), [ARRAY, ARRAY_2]);
  return next;
}
const TWO = withSecondArray(BASE);
const [P1, P2] = planetsOf(TARGET).map((p) => p.id);

test('DUPLICATE, L1: a second array on the system another of the guild\'s arrays is surveying is refused, naming that array and its completeTick', () => {
  const busy = accept(TWO, scan('L1', TARGET));
  const reason = refuse(busy, scan('L1', TARGET, ARRAY_2));
  assert.equal(reason, `Deep Scan Array "${ARRAY}" is already running an L1 scan of system ${TARGET} (it completes at tick ${TWO.tick + 720}) — one array per target; a second would only repeat it`);
  // Still refused mid-way, still naming the same completeTick.
  assert.match(refuse(tickN(busy, 100), scan('L1', TARGET, ARRAY_2)), new RegExp(`completes at tick ${TWO.tick + 720}\\)`));
  assert.equal('scan' in arrayOf(busy, ARRAY_2), false, 'the second array stays idle');
});

test('DUPLICATE, L2: a second array on the same PLANET is refused', () => {
  const busy = accept(knowing(TWO, P1), scan('L2', P1));
  assert.equal(refuse(busy, scan('L2', P1, ARRAY_2)),
    `Deep Scan Array "${ARRAY}" is already running an L2 scan of planet ${P1} (it completes at tick ${TWO.tick + 480}) — one array per target; a second would only repeat it`);
});

test('NOT DUPLICATES: another planet of the same system, and an L1 against an L2 of the same system, are still accepted', () => {
  const both = knowing(TWO, P1, P2);
  // Two planets of one system: two targets.
  const twoPlanets = accept(accept(both, scan('L2', P1)), scan('L2', P2, ARRAY_2));
  assert.deepEqual([arrayOf(twoPlanets).scan.targetPlanetId, arrayOf(twoPlanets, ARRAY_2).scan.targetPlanetId], [P1, P2]);
  // The system's L1 while one of its planets is under an L2 — and the other way round.
  accept(accept(both, scan('L2', P1)), scan('L1', TARGET, ARRAY_2));
  accept(accept(both, scan('L1', TARGET)), scan('L2', P1, ARRAY_2));
});

test('A RIVAL\'s array on the same target is no bar — its job is private, and a refusal must not reveal it', () => {
  // B gets an array of its own (deployed at its home, as A's was) and starts on TARGET first.
  const { deployArrayAtHome } = require('./idle-array-script.js').idleArrayScript();
  const withB = deployArrayAtHome(structuredClone(BASE), B, guildOf(BASE, B).homeSystemId);
  const bArray = `deepScanArray_${B}_01`;
  const bBusy = accept(withB, scan('L1', TARGET, bArray, B));
  accept(bBusy, scan('L1', TARGET)); // A is not told, and not stopped
});

test('the busy-array refusal still comes first, and a finished job frees the target', () => {
  const busy = accept(TWO, scan('L1', TARGET));
  assert.match(refuse(busy, scan('L1', TARGET)), /one job per array, and no queue behind it/, 'the same array again: the busy refusal, not the duplicate one');
  // Once array 01's job completes, nothing holds TARGET: array 02 may take it (a repeat, which learns nothing).
  const done = tickN(busy, 720);
  assert.equal('scan' in arrayOf(done), false);
  accept(done, scan('L1', TARGET, ARRAY_2));
});

test('TWO ARRAYS, ONE TICK: both notices are written, in array-id order — one complete, one voided', () => {
  // Array 01 surveys TARGET; array 02 surveys CONTESTED, which a third guild founds on mid-way.
  const queued = accept(accept(TWO, scan('L1', TARGET)), scan('L1', CONTESTED, ARRAY_2));
  const mid = ok(tickN(queued, 300), [createFoundGuildAction({ guildId: C, name: 'Third', credits: 2000, influence: 100, homeSystemId: CONTESTED })]);
  const done = tickN(mid, 420);
  assert.deepEqual(eventsOf(done).map((e) => [e.id, e.tick, e.type, e.payload.arrayId]), [
    [0, queued.tick + 720, SCAN_COMPLETE, ARRAY],
    [1, queued.tick + 720, SCAN_VOIDED, ARRAY_2],
  ]);
});
