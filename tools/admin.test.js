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

// --- the operator adjust levers (docs/operator-adjust.md §5) -----------------
// The CLI surface for the six levers: parseArgs must carry their flags, and
// adjustActionFor must build the exact action object POST /action validates —
// authoring no game number, just wiring flags to fields.

test('parseArgs: the adjust levers carry their flags', () => {
  assert.deepEqual(
    A.parseArgs(['adjust-credits', '--guild', 'g1', '--delta', '15000000']),
    { command: 'adjust-credits', flags: { _: [], guild: 'g1', delta: 15000000 } },
  );
  // A negative delta is a remove — still an integer.
  assert.equal(A.parseArgs(['adjust-fuel', '--guild', 'g1', '--delta', '-4000']).flags.delta, -4000);
  assert.deepEqual(
    A.parseArgs(['adjust-goods', '--guild', 'g1', '--system', 'sys_1', '--good', 'titanium', '--delta', '900']),
    { command: 'adjust-goods', flags: { _: [], guild: 'g1', system: 'sys_1', good: 'titanium', delta: 900 } },
  );
  assert.deepEqual(
    A.parseArgs(['remove-asset', '--guild', 'g1', '--asset', 'asset_g1_miner_01', '--close']),
    { command: 'remove-asset', flags: { _: [], guild: 'g1', asset: 'asset_g1_miner_01', close: true } },
  );
  assert.deepEqual(
    A.parseArgs(['remove-venture', '--guild', 'g1', '--venture', 'v1', '--remove-asset']),
    { command: 'remove-venture', flags: { _: [], guild: 'g1', venture: 'v1', 'remove-asset': true } },
  );
  // --delta refuses a non-integer, like every int flag.
  assert.throws(() => A.parseArgs(['adjust-credits', '--guild', 'g1', '--delta', '1.5']), /--delta must be an integer/);
});

test('adjustActionFor: each subcommand builds the exact engine action', () => {
  assert.deepEqual(
    A.adjustActionFor('adjust-credits', { guild: 'g1', delta: 15000000 }),
    { type: 'adjustCredits', guildId: 'g1', delta: 15000000 },
  );
  assert.deepEqual(
    A.adjustActionFor('adjust-fuel', { guild: 'g1', delta: -4000 }),
    { type: 'adjustFuel', guildId: 'g1', delta: -4000 },
  );
  assert.deepEqual(
    A.adjustActionFor('adjust-goods', { guild: 'g1', system: 'sys_1', good: 'titanium', delta: 900 }),
    { type: 'adjustGoods', guildId: 'g1', systemId: 'sys_1', good: 'titanium', delta: 900 },
  );
  assert.deepEqual(
    A.adjustActionFor('grant-asset', { guild: 'g1', kind: 'factory', system: 'sys_1' }),
    { type: 'grantAsset', guildId: 'g1', kind: 'factory', systemId: 'sys_1' },
  );
  // remove-asset: --close picks 'close', its absence defaults to 'detach'.
  assert.deepEqual(
    A.adjustActionFor('remove-asset', { guild: 'g1', asset: 'asset_g1_miner_01', close: true }),
    { type: 'removeAsset', guildId: 'g1', assetId: 'asset_g1_miner_01', occupied: 'close' },
  );
  assert.deepEqual(
    A.adjustActionFor('remove-asset', { guild: 'g1', asset: 'asset_g1_miner_01' }),
    { type: 'removeAsset', guildId: 'g1', assetId: 'asset_g1_miner_01', occupied: 'detach' },
  );
  // remove-venture: --remove-asset picks 'remove', its absence defaults to 'keep'.
  assert.deepEqual(
    A.adjustActionFor('remove-venture', { guild: 'g1', venture: 'v1', 'remove-asset': true }),
    { type: 'removeVenture', guildId: 'g1', ventureId: 'v1', asset: 'remove' },
  );
  assert.deepEqual(
    A.adjustActionFor('remove-venture', { guild: 'g1', venture: 'v1' }),
    { type: 'removeVenture', guildId: 'g1', ventureId: 'v1', asset: 'keep' },
  );
});

test('adjustActionFor: a missing required flag throws rather than posting a half action', () => {
  assert.throws(() => A.adjustActionFor('adjust-credits', { guild: 'g1' }), /--delta is required/);
  assert.throws(() => A.adjustActionFor('adjust-credits', { delta: 1 }), /--guild is required/);
  assert.throws(() => A.adjustActionFor('adjust-goods', { guild: 'g1', system: 's', delta: 1 }), /--good is required/);
  assert.throws(() => A.adjustActionFor('grant-asset', { guild: 'g1', kind: 'miner' }), /--system is required/);
  assert.throws(() => A.adjustActionFor('remove-asset', { guild: 'g1' }), /--asset is required/);
  assert.throws(() => A.adjustActionFor('remove-venture', { guild: 'g1' }), /--venture is required/);
  assert.throws(() => A.adjustActionFor('not-a-lever', { guild: 'g1' }), /is not an adjust subcommand/);
});

test('ADJUST_COMMANDS lists exactly the six levers', () => {
  assert.deepEqual(
    [...A.ADJUST_COMMANDS].sort(),
    ['adjust-credits', 'adjust-fuel', 'adjust-goods', 'grant-asset', 'remove-asset', 'remove-venture'].sort(),
  );
});

// --- the vehicle spawn/remove primitive (design.md §15.4, roadmap 2.2 spawn) --------------------
// The CLI surface: parseArgs must carry the new flags, and the PURE body builders must map the
// flags to the exact request body the /admin/vehicle/* endpoints construct their action from.

test('parseArgs: the vehicle flags parse (class/outpost/hex strings, condition a number)', () => {
  assert.deepEqual(
    A.parseArgs(['spawn-vehicle', '--guild', 'g1', '--class', 'lightTransport', '--system', 'sys_0006']),
    { command: 'spawn-vehicle', flags: { _: [], guild: 'g1', class: 'lightTransport', system: 'sys_0006' } },
  );
  assert.deepEqual(
    A.parseArgs(['spawn-vehicle', '--guild', 'g1', '--class', 'spycraft', '--hex', '3,-4', '--condition', '0.5']),
    { command: 'spawn-vehicle', flags: { _: [], guild: 'g1', class: 'spycraft', hex: '3,-4', condition: 0.5 } },
  );
  assert.deepEqual(
    A.parseArgs(['remove-vehicle', '--guild', 'g1', '--id', 'vehicle_g1_lightTransport_01']),
    { command: 'remove-vehicle', flags: { _: [], guild: 'g1', id: 'vehicle_g1_lightTransport_01' } },
  );
});

test('parseHexFlag: "q,r" of two integers, else it refuses rather than coercing', () => {
  assert.deepEqual(A.parseHexFlag('3,-4'), { q: 3, r: -4 });
  assert.deepEqual(A.parseHexFlag('0,0'), { q: 0, r: 0 });
  assert.throws(() => A.parseHexFlag('3'), /must be "q,r"/);
  assert.throws(() => A.parseHexFlag('3,4,5'), /must be "q,r"/);
  assert.throws(() => A.parseHexFlag('3.5,4'), /must both be integers/);
  assert.throws(() => A.parseHexFlag('a,b'), /must both be integers/);
});

test('vehicleLocationFromFlags: exactly one of --system / --outpost / --hex becomes the location', () => {
  assert.deepEqual(A.vehicleLocationFromFlags({ system: 'sys_0006' }), { landmarkKind: 'system', landmarkId: 'sys_0006' });
  assert.deepEqual(A.vehicleLocationFromFlags({ outpost: 'out_01' }), { landmarkKind: 'outpost', landmarkId: 'out_01' });
  assert.deepEqual(A.vehicleLocationFromFlags({ hex: '3,-4' }), { q: 3, r: -4 });
  // Zero forms and more-than-one form are both refused (a craft sits at exactly one location).
  assert.throws(() => A.vehicleLocationFromFlags({}), /a location is required/);
  assert.throws(() => A.vehicleLocationFromFlags({ system: 'sys_0006', hex: '0,0' }), /exactly one/);
  assert.throws(() => A.vehicleLocationFromFlags({ system: 'sys_0006', outpost: 'out_01' }), /exactly one/);
});

test('spawnVehicleBody / removeVehicleBody: build the exact request body, condition omitted by default', () => {
  assert.deepEqual(
    A.spawnVehicleBody({ guild: 'g1', class: 'lightTransport', system: 'sys_0006' }),
    { guildId: 'g1', class: 'lightTransport', location: { landmarkKind: 'system', landmarkId: 'sys_0006' } },
  );
  assert.deepEqual(
    A.spawnVehicleBody({ guild: 'g1', class: 'spycraft', hex: '3,-4', condition: 0.5 }),
    { guildId: 'g1', class: 'spycraft', location: { q: 3, r: -4 }, condition: 0.5 },
  );
  assert.deepEqual(
    A.removeVehicleBody({ guild: 'g1', id: 'vehicle_g1_lightTransport_01' }),
    { guildId: 'g1', vehicleId: 'vehicle_g1_lightTransport_01' },
  );
});

test('spawnVehicleBody / removeVehicleBody: a missing required flag throws rather than posting a half body', () => {
  assert.throws(() => A.spawnVehicleBody({ class: 'lightTransport', system: 'sys_0006' }), /--guild is required/);
  assert.throws(() => A.spawnVehicleBody({ guild: 'g1', system: 'sys_0006' }), /--class is required/);
  assert.throws(() => A.spawnVehicleBody({ guild: 'g1', class: 'lightTransport' }), /a location is required/);
  assert.throws(() => A.removeVehicleBody({ guild: 'g1' }), /--id is required/);
  assert.throws(() => A.removeVehicleBody({ id: 'v' }), /--guild is required/);
});

test('VEHICLE_COMMANDS lists the vehicle subcommands (spawn / remove / dispatch / transfer)', () => {
  assert.deepEqual([...A.VEHICLE_COMMANDS].sort(), ['dispatch-vehicle', 'remove-vehicle', 'spawn-vehicle', 'transfer-cargo'].sort());
});

test('parseWaypointsFlag / parseWaypointToken: sys/out/hex tokens, semicolon-separated, non-empty', () => {
  // The three anchor forms, in one route, order preserved.
  assert.deepEqual(
    A.parseWaypointsFlag('1,-2;sys:sys_0006;out:out_01'),
    [{ q: 1, r: -2 }, { landmarkKind: 'system', landmarkId: 'sys_0006' }, { landmarkKind: 'outpost', landmarkId: 'out_01' }],
  );
  // A single hex token, and blanks/trailing separators are ignored.
  assert.deepEqual(A.parseWaypointsFlag(' 3,4 ; '), [{ q: 3, r: 4 }]);
  assert.deepEqual(A.parseWaypointToken('sys:sys_0001'), { landmarkKind: 'system', landmarkId: 'sys_0001' });
  assert.deepEqual(A.parseWaypointToken('out:out_02'), { landmarkKind: 'outpost', landmarkId: 'out_02' });
  assert.deepEqual(A.parseWaypointToken('5,-1'), { q: 5, r: -1 });
  // Empty / all-blank is refused (a dispatch needs a route); a bad hex token throws through parseHexFlag.
  assert.throws(() => A.parseWaypointsFlag(''), /at least one anchor/);
  assert.throws(() => A.parseWaypointsFlag(' ; ; '), /at least one anchor/);
  assert.throws(() => A.parseWaypointsFlag('sys_0006'), /must be "q,r"/); // no sys:/out: prefix -> parsed as a hex
});

// --- spawn-outpost / remove-outpost (design.md §4 / §15.4, roadmap 2.2 slice 1) ---------------

test('spawnOutpostBody / removeOutpostBody: build the exact request body from the flags', () => {
  assert.deepEqual(
    A.spawnOutpostBody({ guild: 'g1', system: 'sys_0006', hex: '3,-4' }),
    { guildId: 'g1', anchorSystemId: 'sys_0006', coords: { q: 3, r: -4 } },
  );
  assert.deepEqual(
    A.removeOutpostBody({ guild: 'g1', id: 'outpost_g1_01' }),
    { guildId: 'g1', outpostId: 'outpost_g1_01' },
  );
});

test('spawnOutpostBody / removeOutpostBody: a missing required flag throws rather than posting a half body', () => {
  assert.throws(() => A.spawnOutpostBody({ system: 'sys_0006', hex: '0,0' }), /--guild is required/);
  assert.throws(() => A.spawnOutpostBody({ guild: 'g1', hex: '0,0' }), /--system is required/);
  assert.throws(() => A.spawnOutpostBody({ guild: 'g1', system: 'sys_0006' }), /--hex is required/);
  // A malformed --hex is refused (not two integers) rather than coerced.
  assert.throws(() => A.spawnOutpostBody({ guild: 'g1', system: 'sys_0006', hex: '3' }), /must be "q,r"/);
  assert.throws(() => A.removeOutpostBody({ guild: 'g1' }), /--id is required/);
  assert.throws(() => A.removeOutpostBody({ id: 'o' }), /--guild is required/);
});

test('OUTPOST_COMMANDS lists the outpost subcommands (spawn / remove)', () => {
  assert.deepEqual([...A.OUTPOST_COMMANDS].sort(), ['remove-outpost', 'spawn-outpost'].sort());
});

test('dispatchVehicleBody: builds the exact request body; a missing required flag throws', () => {
  assert.deepEqual(
    A.dispatchVehicleBody({ guild: 'g1', id: 'vehicle_g1_lightTransport_01', waypoints: 'sys:sys_0006;3,4' }),
    {
      guildId: 'g1',
      vehicleId: 'vehicle_g1_lightTransport_01',
      waypoints: [{ landmarkKind: 'system', landmarkId: 'sys_0006' }, { q: 3, r: 4 }],
    },
  );
  assert.throws(() => A.dispatchVehicleBody({ id: 'v', waypoints: 'sys:s' }), /--guild is required/);
  assert.throws(() => A.dispatchVehicleBody({ guild: 'g1', waypoints: 'sys:s' }), /--id is required/);
  assert.throws(() => A.dispatchVehicleBody({ guild: 'g1', id: 'v' }), /--waypoints is required/);
});

// --- transfer-cargo (design.md §4 "The dock model", the system half; roadmap 2.2 cargo slice 1) ---

test('parseCargoFlag: "good:qty,good:qty" -> dir-tagged lines, order preserved; bad tokens throw', () => {
  assert.deepEqual(
    A.parseCargoFlag('titanium_alloy:400,ore:1200', 'load'),
    [{ dir: 'load', good: 'titanium_alloy', qty: 400 }, { dir: 'load', good: 'ore', qty: 1200 }],
  );
  // Blanks and trailing separators are ignored; the good id passes through verbatim (the engine
  // decides which goods are real, not the CLI).
  assert.deepEqual(A.parseCargoFlag(' coolant:50 , ', 'unload'), [{ dir: 'unload', good: 'coolant', qty: 50 }]);
  assert.throws(() => A.parseCargoFlag('', 'load'), /at least one "good:qty" pair/);
  assert.throws(() => A.parseCargoFlag('titanium_alloy', 'load'), /must be "good:qty"/); // no colon
  assert.throws(() => A.parseCargoFlag('titanium_alloy:0', 'load'), /positive integer/); // qty must be > 0
  assert.throws(() => A.parseCargoFlag('titanium_alloy:2.5', 'load'), /positive integer/);
  assert.throws(() => A.parseCargoFlag('titanium_alloy:-3', 'load'), /positive integer/);
});

test('parseCargoFlag: "good:max" -> a MAX line (no qty); amount lines and max mix in one flag', () => {
  // A bare `good:max` token builds a { dir, good, max: true } line — no `qty` key at all (§4).
  assert.deepEqual(A.parseCargoFlag('ammonia:max', 'load'), [{ dir: 'load', good: 'ammonia', max: true }]);
  // Amount and max tokens mix in one flag, order preserved — each carries its own shape.
  assert.deepEqual(
    A.parseCargoFlag('titanium:400,ammonia:max', 'load'),
    [{ dir: 'load', good: 'titanium', qty: 400 }, { dir: 'load', good: 'ammonia', max: true }],
  );
  // `max` works the same for an unload, and is whitespace-tolerant like the qty tokens.
  assert.deepEqual(A.parseCargoFlag(' coolant:max ', 'unload'), [{ dir: 'unload', good: 'coolant', max: true }]);
  // Only the exact word `max` is the sentinel — anything else is still parsed as a qty and rejected.
  assert.throws(() => A.parseCargoFlag('titanium:maximum', 'load'), /positive integer or "max"/);
});

test('transferCargoBody: a good:max token rides through to a { dir, good, max: true } manifest line', () => {
  assert.deepEqual(
    A.transferCargoBody({ guild: 'g1', id: 'v', load: 'titanium:400,ammonia:max' }),
    {
      guildId: 'g1',
      vehicleId: 'v',
      manifest: [{ dir: 'load', good: 'titanium', qty: 400 }, { dir: 'load', good: 'ammonia', max: true }],
    },
  );
});

test('transferCargoBody: builds the exact body — UNLOADS FIRST then LOADS; a missing flag throws', () => {
  // Both directions given: the manifest resolves unloads-before-loads (§4), so the body lists it that way.
  assert.deepEqual(
    A.transferCargoBody({ guild: 'g1', id: 'vehicle_g1_heavyTransport_01', unload: 'coolant:50', load: 'titanium_alloy:400,ore:1200' }),
    {
      guildId: 'g1',
      vehicleId: 'vehicle_g1_heavyTransport_01',
      manifest: [
        { dir: 'unload', good: 'coolant', qty: 50 },
        { dir: 'load', good: 'titanium_alloy', qty: 400 },
        { dir: 'load', good: 'ore', qty: 1200 },
      ],
    },
  );
  // Only one direction is enough.
  assert.deepEqual(
    A.transferCargoBody({ guild: 'g1', id: 'v', load: 'silica:10' }),
    { guildId: 'g1', vehicleId: 'v', manifest: [{ dir: 'load', good: 'silica', qty: 10 }] },
  );
  // Neither --load nor --unload is a refused no-op (nothing to move).
  assert.throws(() => A.transferCargoBody({ guild: 'g1', id: 'v' }), /at least one of --load .* or --unload/);
  assert.throws(() => A.transferCargoBody({ id: 'v', load: 'silica:1' }), /--guild is required/);
  assert.throws(() => A.transferCargoBody({ guild: 'g1', load: 'silica:1' }), /--id is required/);
});
