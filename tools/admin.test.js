'use strict';
// Tripwire tests for the operator CLI (tools/admin.js).
// Run: node --test tools/admin.test.js
//
// These guard the CLI's PURE logic only — argument parsing, the snapshot path
// extractor, the resource-node finder, and above all `judgeVerify`, whose `pass`
// IS `verify-cycle`'s exit code. The HTTP orchestration around them is a thin
// shell over routes sim/server.js already serves and needs a live server, so it
// is deliberately not unit-tested here (it is exercised by running the command).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('./admin.js');

// --- parseArgs --------------------------------------------------------------

test('parseArgs: the command list, table-driven', () => {
  const cases = [
    { argv: ['health'], command: 'health', flags: { _: [] } },
    { argv: ['snapshot', '--json'], command: 'snapshot', flags: { _: [], json: true } },
    { argv: ['snapshot', '--pick', 'calendar'], command: 'snapshot', flags: { _: [], pick: 'calendar' } },
    { argv: ['snapshot', '--pick=calendar.windowN'], command: 'snapshot', flags: { _: [], pick: 'calendar.windowN' } },
    { argv: ['new-galaxy', '--seed', '4242'], command: 'new-galaxy', flags: { _: [], seed: 4242 } },
    { argv: ['seat-demo', '--window', '24'], command: 'seat-demo', flags: { _: [], window: 24 } },
    { argv: ['tick', '5'], command: 'tick', flags: { _: ['5'] } },
    // --base works before the command as well as after it.
    { argv: ['--base', 'http://box:7331', 'health'], command: 'health', flags: { _: [], base: 'http://box:7331' } },
    { argv: ['health', '--base', 'http://box:7331'], command: 'health', flags: { _: [], base: 'http://box:7331' } },
    { argv: [], command: null, flags: { _: [] } },
    { argv: ['-h'], command: null, flags: { _: [], help: true } },
  ];
  for (const c of cases) {
    const got = A.parseArgs(c.argv);
    assert.equal(got.command, c.command, `command for ${JSON.stringify(c.argv)}`);
    assert.deepEqual(got.flags, c.flags, `flags for ${JSON.stringify(c.argv)}`);
  }
});

test('parseArgs: an unknown flag throws rather than running a different command', () => {
  assert.throws(() => A.parseArgs(['health', '--verbose']), /unknown flag --verbose/);
  assert.throws(() => A.parseArgs(['snapshot', '--Pick', 'calendar']), /unknown flag --Pick/);
});

test('parseArgs: a value flag with no value, and a bool flag given one, both throw', () => {
  assert.throws(() => A.parseArgs(['new-galaxy', '--seed']), /--seed needs a value/);
  assert.throws(() => A.parseArgs(['snapshot', '--json=1']), /--json takes no value/);
});

test('parseArgs: an integer flag refuses a non-integer', () => {
  assert.throws(() => A.parseArgs(['new-galaxy', '--seed', 'abc']), /--seed must be an integer/);
  assert.throws(() => A.parseArgs(['new-galaxy', '--seed', '4.2']), /--seed must be an integer/);
  assert.equal(A.parseArgs(['new-galaxy', '--seed', '-7']).flags.seed, -7, 'a negative integer is still an integer');
});

// --- the UTC offset flag (docs/cycle-and-calendar.md §2) ---------------------

test('parseArgs: --utc-offset carries HOURS and may be fractional', () => {
  // The one flag that is not an int: half- and quarter-hour zones are real.
  assert.equal(A.parseArgs(['new-galaxy', '--utc-offset', '8']).flags['utc-offset'], 8);
  assert.equal(A.parseArgs(['new-galaxy', '--utc-offset=5.5']).flags['utc-offset'], 5.5);
  assert.equal(A.parseArgs(['new-galaxy', '--utc-offset', '-3.5']).flags['utc-offset'], -3.5);
  assert.throws(() => A.parseArgs(['new-galaxy', '--utc-offset', 'east']), /--utc-offset must be a number/);
  assert.throws(() => A.parseArgs(['new-galaxy', '--utc-offset']), /--utc-offset needs a value/);
});

test('utcOffsetMinutesFromHours: hours in, whole minutes out — and a typo is refused', () => {
  assert.equal(A.utcOffsetMinutesFromHours(0), 0, 'the default is UTC');
  assert.equal(A.utcOffsetMinutesFromHours(8), 480);
  assert.equal(A.utcOffsetMinutesFromHours(5.5), 330, 'half-hour zones are real');
  assert.equal(A.utcOffsetMinutesFromHours(5.75), 345, 'and so are quarter-hour ones');
  assert.equal(A.utcOffsetMinutesFromHours(-3.5), -210);
  assert.equal(A.utcOffsetMinutesFromHours(-12), -720, 'the far west edge');
  assert.equal(A.utcOffsetMinutesFromHours(14), 840, 'the far east edge');
  // A galaxy is anchored ONCE, so these are refused rather than rounded into place.
  assert.throws(() => A.utcOffsetMinutesFromHours(0.001), /not a whole number of minutes/);
  assert.throws(() => A.utcOffsetMinutesFromHours(15), /outside UTC-12:00 \.\. UTC\+14:00/);
  assert.throws(() => A.utcOffsetMinutesFromHours(-13), /outside UTC-12:00 \.\. UTC\+14:00/);
  assert.throws(() => A.utcOffsetMinutesFromHours('8'), /must be a number of hours/);
  assert.throws(() => A.utcOffsetMinutesFromHours(NaN), /must be a number of hours/);
});

// --- pick -------------------------------------------------------------------

test('pick: extracts a dotted path, and returns undefined for a missing one', () => {
  const snap = { tick: 12, calendar: { windowN: 1440, dayAnchorTick: -865 }, guilds: [] };
  assert.equal(A.pick(snap, 'tick'), 12);
  assert.deepEqual(A.pick(snap, 'calendar'), { windowN: 1440, dayAnchorTick: -865 });
  assert.equal(A.pick(snap, 'calendar.windowN'), 1440);
  assert.equal(A.pick(snap, 'calendar.nope'), undefined);
  assert.equal(A.pick(snap, 'nope.windowN'), undefined, 'does not throw part-way down a missing path');
  assert.equal(A.pick(snap, 'tick.windowN'), undefined, 'stepping into a non-object yields undefined');
  assert.equal(A.pick(snap, ''), undefined);
});

// --- pickResourceNode -------------------------------------------------------

// A GET /system/:id layout, shaped exactly as sim/seed.js getSystemLayout returns.
const LAYOUT_WITH_TITANIUM = {
  id: 'sys_0002',
  name: 'Testfield',
  planets: [
    { id: 'pl_00001', resourceNodes: [{ id: 'pl_00001_n01', resourceType: 'lead' }], settlementSlots: [] },
    {
      id: 'pl_00002',
      resourceNodes: [
        { id: 'pl_00002_n01', resourceType: 'copper' },
        { id: 'pl_00002_n02', resourceType: 'titanium' },
        { id: 'pl_00002_n03', resourceType: 'titanium' },
      ],
      settlementSlots: [{ id: 'pl_00002_s01' }],
    },
  ],
};

const LAYOUT_WITHOUT_TITANIUM = {
  id: 'sys_0003',
  name: 'Barrens',
  planets: [
    { id: 'pl_00009', resourceNodes: [{ id: 'pl_00009_n01', resourceType: 'silica' }], settlementSlots: [] },
    { id: 'pl_00010', resourceNodes: [], settlementSlots: [{ id: 'pl_00010_s01' }] },
  ],
};

test('pickResourceNode: finds the first matching node, in the seed\'s own order', () => {
  assert.deepEqual(
    A.pickResourceNode([LAYOUT_WITH_TITANIUM], 'titanium'),
    { systemId: 'sys_0002', nodeId: 'pl_00002_n02' },
  );
  assert.deepEqual(
    A.pickResourceNode([LAYOUT_WITH_TITANIUM], 'lead'),
    { systemId: 'sys_0002', nodeId: 'pl_00001_n01' },
  );
});

test('pickResourceNode: returns null when no layout holds the good', () => {
  assert.equal(A.pickResourceNode([LAYOUT_WITHOUT_TITANIUM], 'titanium'), null);
  assert.equal(A.pickResourceNode([], 'titanium'), null);
  assert.equal(A.pickResourceNode(undefined, 'titanium'), null);
});

test('pickResourceNode: skips a barren layout and finds the good in a later one', () => {
  assert.deepEqual(
    A.pickResourceNode([LAYOUT_WITHOUT_TITANIUM, LAYOUT_WITH_TITANIUM], 'titanium'),
    { systemId: 'sys_0002', nodeId: 'pl_00002_n02' },
  );
});

test('findResourceNodes: collects up to the limit — how seat-demo gets its TWO mines', () => {
  assert.deepEqual(A.findResourceNodes([LAYOUT_WITH_TITANIUM], 'titanium', 2), [
    { systemId: 'sys_0002', nodeId: 'pl_00002_n02' },
    { systemId: 'sys_0002', nodeId: 'pl_00002_n03' },
  ]);
  // The barren layout cannot supply two, so seat-demo would move on to the next starter.
  assert.equal(A.findResourceNodes([LAYOUT_WITHOUT_TITANIUM], 'titanium', 2).length, 0);
});

// --- judgeVerify — the tripwire verify-cycle's exit code reads ---------------

// A live, correctly-ruled galaxy: a 100% titanium licence over a 1,440-tick day,
// created at 14:25 server time (so the anchor is -865).
const GOOD = {
  venture: { id: 'verify_cycle_pl_00002_n02', syndicateCommitment: 7200 },
  calendar: { day: 0, minute: 3, label: '0000:0003', windowN: 1440, dayAnchorTick: -865 },
};

test('judgeVerify: the ruled galaxy passes all three checks', () => {
  const v = A.judgeVerify(GOOD);
  assert.equal(v.pass, true, JSON.stringify(v.checks));
  assert.equal(v.checks.length, 3);
  assert.ok(v.checks.every((c) => c.ok));
});

test('judgeVerify: the RETIRED 120-unit commitment fails, and says what it read', () => {
  // 120 = the placeholder N=24 window's commitment — exactly the regression this
  // check exists to catch on a container running older code.
  const v = A.judgeVerify({ ...GOOD, venture: { ...GOOD.venture, syndicateCommitment: 120 } });
  assert.equal(v.pass, false);
  assert.equal(v.checks[0].ok, false);
  assert.match(v.checks[0].detail, /120/);
  assert.ok(v.checks[1].ok && v.checks[2].ok, 'only the commitment check fails');
});

test('judgeVerify: the retired 24-tick window fails', () => {
  const v = A.judgeVerify({ ...GOOD, calendar: { ...GOOD.calendar, windowN: 24 } });
  assert.equal(v.pass, false);
  assert.equal(v.checks[1].ok, false);
  assert.match(v.checks[1].detail, /24/);
});

test('judgeVerify: a null anchor fails — the calendar layer is not live', () => {
  const v = A.judgeVerify({ ...GOOD, calendar: { ...GOOD.calendar, dayAnchorTick: null } });
  assert.equal(v.pass, false);
  assert.equal(v.checks[2].ok, false);
  assert.match(v.checks[2].detail, /not midnight-anchored/);
});

test('judgeVerify: anchor 0 PASSES — a galaxy created exactly at midnight is anchored', () => {
  // The check is "present and an integer", not "negative": 0 is the legitimate
  // anchor for a midnight creation, and inventing a stricter rule here would be
  // this tool authoring a game rule.
  const v = A.judgeVerify({ ...GOOD, calendar: { ...GOOD.calendar, dayAnchorTick: 0 } });
  assert.equal(v.pass, true, JSON.stringify(v.checks));
});

test('judgeVerify: nothing read back at all fails loudly rather than throwing', () => {
  const v = A.judgeVerify({ venture: null, calendar: null });
  assert.equal(v.pass, false);
  assert.equal(v.checks.filter((c) => c.ok).length, 0);
  assert.match(v.checks[0].detail, /no venture read back/);
  assert.match(v.checks[1].detail, /no calendar block/);
  assert.equal(A.judgeVerify().pass, false, 'called with nothing at all');
});

test('the expected figures are the ruled ones, quoted not authored', () => {
  // If either ruling moves, docs/cycle-and-calendar.md and sim/ move FIRST; this
  // line is where the CLI's copy of them must be re-quoted, never patched blind.
  assert.equal(A.EXPECTED_COMMITMENT, 7200);
  assert.equal(A.EXPECTED_WINDOW_N, 1440);
});

// --- pickIdleAssetId --------------------------------------------------------

// A /snapshot guild block, shaped exactly as sim/snapshot.js emits it: every asset
// carries the engine's own deployed-vs-idle answer, so the CLI derives nothing.
const SNAP = {
  guilds: [{
    id: 'seat_demo',
    assets: [
      { id: 'asset_seat_demo_miner_01', kind: 'miner', deployedToVentureId: 'v1' },
      { id: 'asset_seat_demo_miner_03', kind: 'miner', deployedToVentureId: null },
      { id: 'asset_seat_demo_miner_02', kind: 'miner', deployedToVentureId: null },
      { id: 'asset_seat_demo_factory_01', kind: 'factory', deployedToVentureId: null },
    ],
  }],
};

test('pickIdleAssetId: the lowest IDLE id of the asked-for kind', () => {
  // miner_01 is deployed, so the lowest idle is 02 — and stored order does not decide it.
  assert.equal(A.pickIdleAssetId(SNAP, 'seat_demo', 'miner'), 'asset_seat_demo_miner_02');
  assert.equal(A.pickIdleAssetId(SNAP, 'seat_demo', 'factory'), 'asset_seat_demo_factory_01');
});

test('pickIdleAssetId: no idle machine of that kind throws rather than deploying a wrong one', () => {
  const allDeployed = { guilds: [{ id: 'g', assets: [{ id: 'a', kind: 'miner', deployedToVentureId: 'v' }] }] };
  assert.throws(() => A.pickIdleAssetId(allDeployed, 'g', 'miner'), /holds no idle miner/);
  assert.throws(() => A.pickIdleAssetId(SNAP, 'nobody', 'miner'), /holds no idle miner/);
});
