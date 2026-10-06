'use strict';

// deep-scan-arrays.js — the Deep Scan Array vocabulary: the deterministic id scheme and the per-guild
// mint counter (docs/exploration-model.md §5; roadmap 2.5 (b1)), and — 2.5 (b2) — the DISCOVERY SCAN: the
// two durations, the shape of a scan job, and the end-of-tick step that completes one. The outpost mirror
// is sim/outposts.js.
//
// A Deep Scan Array is a SHARED, single-hex, guild-owned structure. It lives in its own top-level
// list, `state.deepScanArrays`, beside `state.outposts` (NOT folded into it: an array has no stockpile,
// no capacity and no dock, and keeping the lists apart leaves every Outpost row byte-identical). It is
// placed only by a guild's DEPLOY — a heavy carrying a `deep_scan_array_kit` to a bare hex "attached" to
// its own territory (the rule is `deployCheck`, sim/actions.js) — and nothing else mints one.
//
// SCOPE: placed (b1), and it scans (b2) — ONE job at a time, queued by the `queueScan` action
// (sim/actions.js), completed here. Monitoring (the watch fan) is deferred, and the entity carries no fan
// fields until a slice reads them (exploration-model.md §5: "dead fields only muddy the determinism hash").
//
// Like outposts.js, this file constructs no entity — `createDeepScanArray` lives with the other entity
// constructors in state.js — so it stays free of a require cycle with state.js. Its one MUTATION is the
// tick step `stepScanCompletions`, which edits the tick's own clone in place, as every tick step does.

const { getPlanet } = require('./seed.js');
const { systemControllers } = require('./claims.js');
const { revealSystemArchetypes, revealPlanetNodes } = require('./exploration.js');

// The id scheme is `deepScanArray_<guildId>_NN`, 1-based and zero-padded to two digits — the exact mirror
// of outposts.js's `outpost_<guildId>_NN`. STABLE and DETERMINISTIC (§15.2, invariant 9): two runs of the
// same scenario mint byte-identical ids. The padding makes lexicographic order agree with numeric order.
function deepScanArrayId(guildId, n) {
  return `deepScanArray_${guildId}_${String(n).padStart(2, '0')}`;
}

// deepScanArrayNumberOf(id) -> the trailing NN minted by `deepScanArrayId`, or null when the id carries
// none. Reads only the last `_NN` group, so a guildId containing an underscore does not confuse it — the
// same parse outpostNumberOf uses.
function deepScanArrayNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextDeepScanArraySerial(guild) -> the next per-GUILD mint serial: one above the guild's stored
// `deepScanArraySerial` (absent/0 -> 1). The array mirror of `nextOutpostSerial`, and STORED for the same
// reason (design.md §15.4 "Ids never repeat"): once an array is removed (the operator's
// `removeDeepScanArray`, 2.5 (b2)), a `max(live) + 1` derivation would re-hand its number. The CALLER bumps
// `guild.deepScanArraySerial` at mint (this stays a pure read); it never decrements.
function nextDeepScanArraySerial(guild) {
  return (guild.deepScanArraySerial || 0) + 1;
}

// --- the discovery scan (2.5 (b2); docs/exploration-model.md §5 "Discovery — the scan") ---------------

// The two scan durations, in ticks (1 tick = 1 minute). `[FIRST-CUT]`, ruled by the human 05-10-26 and
// recorded in docs/phase-1-tuning.md "Exploration & scanning": an L1 SYSTEM scan (every planet's archetype)
// takes 720 ticks (12 h); an L2 PLANET scan (one planet's resource nodes) takes 480 ticks (8 h). They live
// here ONCE; the queue apply reads them through SCAN_TICKS and the invariant checks a job against them.
const SCAN_L1_TICKS = 720;
const SCAN_L2_TICKS = 480;
const SCAN_TICKS = Object.freeze({ L1: SCAN_L1_TICKS, L2: SCAN_L2_TICKS });
const SCAN_LEVELS = Object.freeze(Object.keys(SCAN_TICKS));

// THE SCAN JOB — one optional field on the array row, `array.scan`, present only while a job runs:
//
//     { level: 'L1', targetSystemId, startedTick, completeTick }
//     { level: 'L2', targetPlanetId, startedTick, completeTick }
//
// One target key per level: an L1 scans a whole SYSTEM, an L2 one PLANET. `startedTick` is the tick the job
// was queued (§15.2); `completeTick` = startedTick + SCAN_TICKS[level], the tick at whose END it reveals.
// OMIT-WHEN-IDLE: an idle array carries no `scan` key at all, so it serialises exactly as a b1 array did,
// and finishing a job deletes the key rather than nulling it.

// copyScanJob(job) -> a FRESH copy of a scan job, so a caller's object (a scenario, a save handed to
// createState, the snapshot row) can never alias into engine state. It copies the target key the job
// carries and invents none — a malformed job stays malformed, for the invariant to see.
function copyScanJob(job) {
  return {
    level: job.level,
    ...(job.targetSystemId !== undefined ? { targetSystemId: job.targetSystemId } : {}),
    ...(job.targetPlanetId !== undefined ? { targetPlanetId: job.targetPlanetId } : {}),
    startedTick: job.startedTick,
    completeTick: job.completeTick,
  };
}

// scanTargetSystemId(job) -> the SYSTEM a job's target sits in: an L1's own `targetSystemId`, or the system
// of an L2's planet (from the seed). Null when an L2's planet does not resolve. This is the system whose
// controller decides whether the target is scannable — at queue time and again at completion — so both
// ask about the same system.
function scanTargetSystemId(job) {
  if (job.level === 'L1') return job.targetSystemId;
  const planet = getPlanet(job.targetPlanetId);
  return planet ? planet.systemId : null;
}

// stepScanCompletions(state, tick) — every array whose job is DUE (`completeTick <= tick`) finishes it now.
// Runs at the END of every tick (sim/tick.js), `tick` being the tick just built, and mutates `state` in
// place. `<=` and not `===`, the arrivals idiom: a due job can never be stepped over.
//
// RE-VALIDATED AT COMPLETION — "legal to schedule, re-checked on arrival", the shape sim/claims.js gives buy
// deliveries. The target was unclaimed when queued, but the world has had 720 or 480 ticks to move. If a
// RIVAL now controls the target's system, the job completes to NOTHING — no reveal, not even a partial one
// (scanning a rival is L3 espionage, deferred). Unclaimed, or now held by the array's OWN guild, both
// reveal: finishing a survey of your own ground is harmless.
//
// The reveal goes through the ONE write path (sim/exploration.js `reveal`, via its two loops): an L1 learns
// every planet's ARCHETYPE in the target system and NO node; an L2 learns every resource node on the target
// planet. Learn-once makes an already-known fact a no-op, so the record never shrinks and keeps each fact's
// first tick.
//
// The job is CLEARED either way — the key deleted (omit-when-idle) — and the array is free for its next job.
// A removed array took its job with it (the job lives on the row), so it never reaches this step.
//
// DETERMINISM (invariant 9): arrays in id order. Each reveal writes only its own guild's record, stamped
// `tick`, so no value depends on the visiting order anyway.
function stepScanCompletions(state, tick) {
  const due = (state.deepScanArrays || []).filter((a) => a.scan && a.scan.completeTick <= tick);
  if (due.length === 0) return state;
  due.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const controllers = systemControllers(state); // absent = unclaimed
  for (const array of due) {
    const job = array.scan;
    const owner = (state.guilds || []).find((g) => g.id === array.ownerGuildId);
    if (!owner) {
      throw new Error(`stepScanCompletions: at tick ${tick} array ${JSON.stringify(array.id)} finished a scan for guild ${JSON.stringify(array.ownerGuildId)}, which does not exist`);
    }
    if (!SCAN_LEVELS.includes(job.level)) {
      throw new Error(`stepScanCompletions: at tick ${tick} array ${JSON.stringify(array.id)} holds a scan of unknown level ${JSON.stringify(job.level)}`);
    }
    const controller = controllers.get(scanTargetSystemId(job));
    if (controller === undefined || controller === owner.id) {
      if (job.level === 'L1') revealSystemArchetypes(owner, job.targetSystemId, tick);
      else revealPlanetNodes(owner, job.targetPlanetId, tick);
    }
    delete array.scan;
  }
  return state;
}

module.exports = {
  deepScanArrayId,
  deepScanArrayNumberOf,
  nextDeepScanArraySerial,
  SCAN_L1_TICKS,
  SCAN_L2_TICKS,
  SCAN_TICKS,
  SCAN_LEVELS,
  copyScanJob,
  scanTargetSystemId,
  stepScanCompletions,
};
