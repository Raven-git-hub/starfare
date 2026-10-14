'use strict';

// scan-notice-script.js — scripted scans run to completion, for the scan-notice slice's byte proof (roadmap
// 2.5, ruling 12 slice-3b checklist items 9(a) and 8; docs/event-log.md §13), read by
// tests/scan-notice.test.js.
//
// The slice adds ONE thing to a finishing scan: a notice appended to the owner's event log. The reveal and
// the job-clear must be untouched. So the proof needs main's bytes from BEFORE the slice, and this script uses
// ONLY what main had at 8b24026 — the idle-array galaxy, queueScan, founding, `reveal` and plain ticks — so it
// runs unchanged on that commit. The hashes it gave there are pinned in the test.
//
// From the idle-array galaxy (two founded guilds; A's one idle array touching its home):
//   l1Done     — A runs an L1 of an unclaimed starter system to completion (720 ticks): the reveal path,
//                every planet's archetype new.
//   l2Done     — then an L2 of one of its planets (480 ticks): the reveal path, that planet's whole surface new.
//   repeatDone — then the L1 of the same system again (720 ticks): the reveal path, NOTHING new.
//   voided     — from the start, an L1 of another unclaimed starter system; 300 ticks in a third guild founds
//                on it; at completion the job is voided.

const { advance } = require('../run.js');
const { getStarterSystems, getSystemLayout } = require('../seed.js');
const { createQueueScanAction, createFoundGuildAction } = require('../actions.js');
const { idleArrayScript } = require('./idle-array-script.js');

const C = 'third-guild';

function scanNoticeScript() {
  const { steps: { deployed }, A, B, aHome, bHome, ok } = idleArrayScript();
  const ARRAY = `deepScanArray_${A}_01`;
  const tickN = (s, n) => { for (let i = 0; i < n; i += 1) s = advance(s, []).state; return s; };
  const L1 = (systemId) => createQueueScanAction({ guildId: A, arrayId: ARRAY, level: 'L1', targetSystemId: systemId });
  const L2 = (planetId) => createQueueScanAction({ guildId: A, arrayId: ARRAY, level: 'L2', targetPlanetId: planetId });

  // Targets derived from the seed, as deep-scan-job.test.js derives them: unclaimed STARTER systems with at
  // least three planets (a starter, so a third guild can really found on one mid-scan).
  const planetsOf = (systemId) => getSystemLayout(systemId).planets;
  const unclaimed = getStarterSystems().map((s) => s.id)
    .filter((id) => id !== aHome && id !== bHome && planetsOf(id).length >= 3);
  const TARGET = unclaimed[0];
  const CONTESTED = unclaimed[1];
  // A planet with both kinds of surface, so the L2 learns nodes AND slots.
  const SURFACED = planetsOf(TARGET).find((p) => p.resourceNodes.length > 0 && p.settlementSlots.length > 0).id;

  const l1Done = tickN(ok(deployed, [L1(TARGET)]), 720);
  const l2Done = tickN(ok(l1Done, [L2(SURFACED)]), 480);
  const repeatDone = tickN(ok(l2Done, [L1(TARGET)]), 720);
  const contested = ok(tickN(ok(deployed, [L1(CONTESTED)]), 300), [
    createFoundGuildAction({ guildId: C, name: 'Third', credits: 2000, influence: 100, homeSystemId: CONTESTED }),
  ]);
  const voided = tickN(contested, 420);

  return {
    steps: { l1Done, l2Done, repeatDone, voided },
    A, B, C, ARRAY, TARGET, CONTESTED, SURFACED, deployed, ok, tickN, L1, L2,
  };
}

module.exports = { scanNoticeScript };
