'use strict';

// deep-scan-arrays.js — the Deep Scan Array vocabulary: the deterministic id scheme and the per-guild
// mint counter (docs/exploration-model.md §5; roadmap 2.5 (b1)), and — 2.5 (b2) — the DISCOVERY SCAN: the
// two durations, the shape of a scan job, and the end-of-tick step that completes one. The outpost mirror
// is sim/outposts.js.
//
// A Deep Scan Array is a SHARED, single-hex, guild-owned structure. It lives in its own top-level
// list, `state.deepScanArrays`, beside `state.outposts` (NOT folded into it: an array has no stockpile,
// no capacity and no dock, and keeping the lists apart leaves every Outpost row byte-identical). It is
// placed only by a guild's DEPLOY — a heavy carrying a `deep_scan_array_kit` to a bare hex in or beside
// its own territory, or (slice 16) berthed at one of its own held systems, onto that system's centre (the
// rule is `deployCheck`, sim/actions.js) — and nothing else mints one.
//
// SCOPE: placed (b1), and it scans (b2) — ONE job at a time, queued by the `queueScan` action
// (sim/actions.js), completed here. Monitoring (the watch fan) is deferred, and the entity carries no fan
// fields until a slice reads them (exploration-model.md §5: "dead fields only muddy the determinism hash").
//
// Like outposts.js, this file constructs no entity — `createDeepScanArray` lives with the other entity
// constructors in state.js — so it stays free of a require cycle with state.js. Its one MUTATION is the
// tick step `stepScanCompletions`, which edits the tick's own clone in place, as every tick step does.
// (That step also writes the job's completion NOTICE — `scan_complete` / `scan_voided`, docs/event-log.md
// §13 — through the shared `recordEvent`.)
//
// ATTACHMENT (losing ground, engine PR 3; design.md §19 #67, SETTLED 19-10-26). An array is placed touching its
// guild's own control (§5 "Deploy placement"), and that touch is now LIVE, not only checked at the deploy: an
// array whose hex no longer sits in or beside its guild's own control is DARK — it runs no scan and takes none.
// Nothing stores "dark": it is read off the live control every time (`isArrayAttached`), so an array wakes by
// itself when friendly control abuts it again. When control goes, `voidDetachedScans` voids the running job of
// every array that went dark, with a `scan_voided` notice whose `reason` is 'anchor-lost'.

const { getPlanet, getSystem, getSystemLayout, roman } = require('./seed.js');
const { systemControllers, controlNear } = require('./claims.js');
const { revealSystemArchetypes, revealPlanetSurface } = require('./exploration.js');
const { recordEvent, SCAN_COMPLETE, SCAN_VOIDED } = require('./events.js');

// CENTRE_KIND — the ONE kit kind that may deploy on the CENTRE hex of a system its guild holds: the Deep Scan
// Array's own kit kind ('deepScan', its DEPLOYABLE_KITS key, sim/resources.js). docs/exploration-model.md §5,
// AMENDED 15-10-26 (roadmap 2.5 slice 16): "the ONE exception to 'a deploy lands on a bare hex', and it is for
// arrays only". Spelled here once, so the deploy rule (sim/actions.js `deployCheck`) and the route invariant
// (sim/invariants.js) read the same name rather than two copies of the string.
const CENTRE_KIND = 'deepScan';

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

// --- the attachment (exploration-model.md §5; losing ground, engine PR 3) ---------------------------------

// attachmentFootprints(state, guildId, coords) -> the guild's OWN control footprints that hex `coords` is IN OR
// BESIDE: a held system's disk the hex is in or one hex outside, or one of its Outposts on or next to the hex
// (`controlNear` at `within` 1, kept to this guild — controlNear's order, held systems first, each by id).
// THE §5 ATTACHMENT, spelled once: the deploy rule (sim/actions.js `attachedPlacement`) places an array only where
// this is non-empty and anchors it to the first footprint, and `isArrayAttached` below asks the same question of an
// array already standing. Whether a RIVAL controls the hex is the deploy rule's separate question (placement only —
// an array whose hex later falls in a rival's control stands, still attached to its own guild's ground).
function attachmentFootprints(state, guildId, coords) {
  return controlNear(state, coords, 1).filter((f) => f.guildId === guildId);
}

// isArrayAttached(state, array) -> true while the array's hex is in or beside its owner's own control (above).
// An array for which this is false is DARK (design.md §19 #67): it may carry no scan job (the invariant,
// sim/invariants.js) and takes no new one (the queueScan gate, sim/actions.js).
function isArrayAttached(state, array) {
  return attachmentFootprints(state, array.ownerGuildId, array.coords).length > 0;
}

// The `reason` a `scan_voided` notice carries when its array went DARK under the job (docs/event-log.md §13). The
// rival void — the target claimed before the scan finished — carries no `reason` (it was the only void before
// engine PR 3, and its payload is unchanged), so a reader tells the two apart by this key.
const SCAN_VOID_ANCHOR_LOST = 'anchor-lost';

// voidDetachedScans(state, guild, tick) — MUTATES `state` and `guild`. Called right after something takes control
// away from the guild — today the eviction (sim/eviction.js) and the two ways an Outpost leaves the map
// (sim/actions.js `reclaimOutpost` / `removeOutpost`). Each of the guild's arrays that is running a job and is no
// longer attached goes dark: its job is cleared (the key deleted — omit-when-idle, as a finished job), nothing is
// revealed, and the guild gets ONE `scan_voided` notice per array, `reason: 'anchor-lost'`, with the same
// self-contained description of the job the completion notices carry. The array row itself stays — dark, not destroyed — stamped `updatedAtTick` (§15.2:
// the void is a mutation of the row; absent until an array's first void). An idle dark array is left untouched:
// there is nothing to void, and the queueScan gate keeps it idle.
// Only `guild`'s arrays are asked: control is the guild's own, so another guild's arrays cannot lose theirs by it.
// Arrays in id order, so the notices are written in a fixed order (invariant 9).
function voidDetachedScans(state, guild, tick) {
  const dark = (state.deepScanArrays || [])
    .filter((a) => a.ownerGuildId === guild.id && a.scan && !isArrayAttached(state, a))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const array of dark) {
    recordEvent(guild, tick, SCAN_VOIDED, { ...scanNoticeTarget(array), reason: SCAN_VOID_ANCHOR_LOST });
    delete array.scan;
    array.updatedAtTick = tick;
  }
}

// --- the discovery scan (2.5 (b2); docs/exploration-model.md §5 "Discovery — the scan") ---------------

// The two scan durations, in ticks (1 tick = 1 minute). `[FIRST-CUT]`, ruled by the human 05-10-26 and
// recorded in docs/phase-1-tuning.md "Exploration & scanning": an L1 SYSTEM scan (every planet's archetype)
// takes 720 ticks (12 h); an L2 PLANET scan (one planet's whole surface — its resource nodes and, since the
// settlement-surface slice, its settlement slots) takes 480 ticks (8 h). They live here ONCE; the queue apply
// reads them through SCAN_TICKS and the invariant checks a job against them.
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

// scanTargetName(job) -> the target's display name, for the completion notice: an L1's SYSTEM seed name
// ("Nyx"), an L2's planet DESIGNATION ("Nyx IV" — its system's name and its Roman ordinal, the 1-based
// place in the seed's planet order that the board's `order` and the site names already number it by).
// Carried in the payload because the notice must read the same after the world moves on (the
// `ventureName` reason, docs/event-log.md §2). Falls back to the raw id, as `ventureName` does.
function scanTargetName(job) {
  if (job.level === 'L1') {
    const system = getSystem(job.targetSystemId);
    return (system && system.name) || job.targetSystemId;
  }
  const planet = getPlanet(job.targetPlanetId);
  const layout = planet ? getSystemLayout(planet.systemId) : null;
  const ordinal = layout ? layout.planets.findIndex((p) => p.id === job.targetPlanetId) + 1 : 0;
  return ordinal > 0 ? `${layout.name} ${roman(ordinal)}` : job.targetPlanetId;
}

// scanNoticeTarget(array) -> what every scan notice says about the job the array is running: which array, which
// level, which target (the key the job itself carries) and the target's name. Shared by the completion step and
// the dark-array void (`voidDetachedScans`), so the notices describe a job the same way whichever way it ended.
function scanNoticeTarget(array) {
  const job = array.scan;
  return {
    arrayId: array.id,
    level: job.level,
    ...(job.level === 'L1' ? { targetSystemId: job.targetSystemId } : { targetPlanetId: job.targetPlanetId }),
    targetName: scanTargetName(job),
  };
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
// every planet's ARCHETYPE in the target system and NO surface; an L2 learns the target planet's whole
// SURFACE — every resource node and every settlement slot on it (§4 ruling 10). Learn-once makes an
// already-known fact a no-op, so the record never shrinks and keeps each fact's first tick.
//
// The job is CLEARED either way — the key deleted (omit-when-idle) — and the array is free for its next job.
// A removed array took its job with it (the job lives on the row), so it never reaches this step; nor does a DARK
// one — its job was voided the moment it lost its attachment (`voidDetachedScans`), so every job due here runs on an
// attached array (the invariant holds it).
//
// THE NOTICE (docs/event-log.md §13, ruled 14-10-26). Either way the owning guild gets ONE notice, written
// here through the shared `recordEvent`, stamped `tick`:
//   - on the REVEAL path, `scan_complete`, ALWAYS — even when the reveal learned nothing new (an
//     already-charted target): the job still finished and the array is free, and the notice says so;
//   - on the VOID path, `scan_voided`, naming the rival that controls the target's system. That is public
//     (L0: who holds a system is never fogged), so naming it leaks nothing.
// The payload is self-contained — it carries the names it needs, since the array may be gone and the
// system may change hands again by the time the player reads it.
//
// DETERMINISM (invariant 9): arrays in id order. Each reveal and each notice writes only its own guild's
// record and log, stamped `tick`; a guild with two arrays finishing on one tick gets its notices in array-id
// order, so the event ids are fixed too.
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
    // What both notices say about the job (scanNoticeTarget).
    const target = scanNoticeTarget(array);
    const controller = controllers.get(scanTargetSystemId(job));
    if (controller === undefined || controller === owner.id) {
      // Learn-once: `newFacts` is how many facts were NEW (0 = it was all known already).
      const newFacts = job.level === 'L1'
        ? revealSystemArchetypes(owner, job.targetSystemId, tick)
        : revealPlanetSurface(owner, job.targetPlanetId, tick);
      recordEvent(owner, tick, SCAN_COMPLETE, { ...target, newFacts });
    } else {
      // A claim may name a guild with no row (none does today); the id then stands in for the name.
      const rival = (state.guilds || []).find((g) => g.id === controller);
      recordEvent(owner, tick, SCAN_VOIDED, { ...target, byGuildId: controller, byGuildName: (rival && rival.name) || controller });
    }
    delete array.scan;
  }
  return state;
}

module.exports = {
  CENTRE_KIND,
  deepScanArrayId,
  deepScanArrayNumberOf,
  nextDeepScanArraySerial,
  SCAN_L1_TICKS,
  SCAN_L2_TICKS,
  SCAN_TICKS,
  SCAN_LEVELS,
  copyScanJob,
  scanTargetSystemId,
  scanTargetName,
  stepScanCompletions,
  attachmentFootprints,
  isArrayAttached,
  SCAN_VOID_ANCHOR_LOST,
  voidDetachedScans,
};
