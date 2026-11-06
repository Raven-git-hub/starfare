'use strict';

// grant-droid.test.js — the operator's droid test lever (roadmap 2.6, droid test-enablement).
//
// `grantDroid { systemId, source, count }` mints `count` idle droids of one source into a system, for the
// guild that HOLDS it, through THE ONE droid mint (sim/droids.js mintDroid). What is pinned here:
//   1. it mints exactly `count` droids, of the named source, idle, at the system, at condition NEW, each
//      stamped with the tick it was granted (§15.2), with fresh ids off the holder's droidSerial;
//   2. the droids go to the HOLDER — a rival's system grants to the rival, never to anyone else;
//   3. it is refused, whole, for an unknown source, a count that is not a whole number >= 1, a system off
//      the seed, and a system no guild holds — and a refused grant mints nothing;
//   4. a granted droid is a real droid: the existing assignDroid accepts it (licence gate included);
//   5. the endpoint and the CLI, against a real server process: exit 0 and the right report, exit 1 on a
//      refusal with the engine's reason.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const { checkInvariants } = require('../invariants.js');
const { DROID_SOURCES } = require('../droids.js');
const { createGrantDroidAction, createAssignDroidAction } = require('../actions.js');
const { HOME, RIVAL, kitGalaxy, accept, refuse, ticks, g1Of } = require('./installation-kit-fixtures.js');

const g2Of = (s) => s.guilds.find((g) => g.id === 'g2');
const grant = (over = {}) => createGrantDroidAction({ systemId: HOME.id, source: 'guild', count: 1, ...over });

// A galaxy a few ticks in, so a stamp of the CURRENT tick is told apart from a stamp of 0.
function galaxy() {
  const s = ticks(kitGalaxy(), 3);
  assert.equal(s.tick, 3, 'the fixture is three ticks in');
  return s;
}

// --- 1. the mint -------------------------------------------------------------------------------------------

test('grantDroid mints exactly `count` idle droids of the source into the system, each stamped with the tick', () => {
  const before = galaxy();
  const s = accept(before, grant({ source: 'syndicate', count: 3 }));
  assert.deepEqual(g1Of(s).droids, [
    { id: 'asset_g1_droid_01', systemId: HOME.id, source: 'syndicate', condition: 1, updatedAtTick: 3 },
    { id: 'asset_g1_droid_02', systemId: HOME.id, source: 'syndicate', condition: 1, updatedAtTick: 3 },
    { id: 'asset_g1_droid_03', systemId: HOME.id, source: 'syndicate', condition: 1, updatedAtTick: 3 },
  ]);
  assert.equal(g1Of(s).droidSerial, 3);
  // A droid is not a good and costs nothing here: no credit, fuel, ledger or supply moved.
  assert.equal(g1Of(s).credits, g1Of(before).credits);
  assert.equal(g1Of(s).fuelHoard, g1Of(before).fuelHoard);
  assert.equal(s.syndicate.ledger, before.syndicate.ledger);
  assert.deepEqual(s.galacticSupply, before.galacticSupply);
  // A second grant continues the serial, of the other source, at its own tick.
  const later = ticks(s, 2);
  const two = accept(later, grant({ source: 'guild', count: 2 }));
  assert.deepEqual(g1Of(two).droids.slice(3).map((d) => [d.id, d.source, d.updatedAtTick]), [
    ['asset_g1_droid_04', 'guild', 5],
    ['asset_g1_droid_05', 'guild', 5],
  ]);
  // And the galaxy keeps running clean with them in it (advance checks every invariant every tick).
  ticks(two, 5);
});

test('grantDroid goes to the guild that holds the system — a rival\'s system grants to the rival', () => {
  const s = accept(galaxy(), grant({ systemId: RIVAL, count: 2 }));
  assert.equal(g1Of(s).droids, undefined, 'g1 got nothing');
  assert.deepEqual(g2Of(s).droids.map((d) => [d.id, d.systemId, d.source]), [
    ['asset_g2_droid_01', RIVAL, 'guild'],
    ['asset_g2_droid_02', RIVAL, 'guild'],
  ]);
});

// --- 2. the refusals ---------------------------------------------------------------------------------------

test('grantDroid refuses an unknown source, a non-positive or non-integer count, an unreal or unheld system', () => {
  const s = galaxy();
  assert.deepEqual([...DROID_SOURCES].sort(), ['guild', 'syndicate'], 'the two sources the refusal names');
  assert.match(refuse(s, grant({ source: 'pirate' })), /"pirate" is not a droid source \(known: guild, syndicate\)/);
  assert.match(refuse(s, grant({ source: 'Guild' })), /is not a droid source/, 'spelled exactly');
  for (const count of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(refuse(s, grant({ count })), /count must be a whole number of droids, at least 1/, `count ${count}`);
  }
  assert.match(refuse(s, grant({ systemId: 'sys_nope' })), /system "sys_nope" is not a system on the seed/);
  // A real system nobody holds: neither g1's HOME nor g2's RIVAL.
  const unheld = require('../../data/seed.json').systems.map((x) => x.id).find((id) => id !== HOME.id && id !== RIVAL);
  assert.match(refuse(s, grant({ systemId: unheld })), new RegExp(`system "${unheld}" is held by no guild`));
  // The constructor insists on every field (the CLI defaults count; the engine never guesses one).
  assert.throws(() => createGrantDroidAction({ source: 'guild', count: 1 }), /systemId is required/);
  assert.throws(() => createGrantDroidAction({ systemId: HOME.id, count: 1 }), /source is required/);
  assert.throws(() => createGrantDroidAction({ systemId: HOME.id, source: 'guild' }), /count is required/);
  assert.deepEqual(grant(), { type: 'grantDroid', systemId: HOME.id, source: 'guild', count: 1 });
  // Nothing was minted by any of it.
  assert.equal(g1Of(s).droids, undefined);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. a granted droid is a real droid --------------------------------------------------------------------

test('a granted droid is assignable through the existing assignDroid, licence gate and all', () => {
  let s = galaxy();
  // A bare producing venture at HOME, unlicensed (the droid-assignment fixture's shape).
  g1Of(s).ventures.push({ id: 'v_bare', ownerGuildId: 'g1', type: 'refining', systemId: HOME.id, recipeId: 'titanium_alloy' });
  s = accept(s, grant({ source: 'guild' }));
  s = accept(s, grant({ source: 'syndicate' }));
  const assign = (droidId) => createAssignDroidAction({ guildId: 'g1', droidId, ventureId: 'v_bare' });
  const assigned = accept(s, assign('asset_g1_droid_01'));
  assert.equal(g1Of(assigned).droids[0].assignedToVentureId, 'v_bare');
  assert.match(refuse(s, assign('asset_g1_droid_02')), /licen/i, 'a granted Syndicate droid still obeys the licence gate');
});

// --- 4. the endpoint and the CLI, against a real server process --------------------------------------------

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const ADMIN_JS = path.join(__dirname, '..', '..', 'tools', 'admin.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('THE OPERATOR CLI: grant-droid exits 0 and reports the mint; a bad source / count / missing flag exits 1', async () => {
  const { HOME_SYSTEM } = require('./home-anchor.js');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.STARFARE_TICK_MS;
  delete env.STARFARE_PERSIST_DIR;
  const server = spawn(process.execPath, [SERVER_JS], { env });
  const base = `http://127.0.0.1:${port}`;
  const post = async (route, body) => (await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const cli = (...args) => spawnSync(process.execPath, [ADMIN_JS, ...args, '--base', base], { encoding: 'utf8' });
  const G = 'player-guild';
  try {
    for (let i = 0; ; i += 1) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not listening yet */ }
      if (i > 200) throw new Error('the server never answered /health');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal((await post('/action', { type: 'foundGuild', guildId: G, credits: 120, influence: 100, homeSystemId: HOME_SYSTEM, isBot: true })).accepted, true);
    await post('/tick', {});

    // The default count is one droid.
    const one = cli('grant-droid', '--system', HOME_SYSTEM, '--source', 'guild');
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /action\s+grantDroid/);
    assert.match(one.stdout, new RegExp(`guild\\s+${G}`));
    assert.match(one.stdout, /minted\s+1\b/);
    // --count N mints N more, of the named source.
    const three = cli('grant-droid', '--system', HOME_SYSTEM, '--source', 'syndicate', '--count', '3');
    assert.equal(three.status, 0, three.stderr);
    assert.match(three.stdout, new RegExp(`idle here\\s+4 \\(of 4 in ${HOME_SYSTEM}\\)`));

    // The server state the CLI reported: four idle droids, the sources as asked, each stamped with the tick.
    const snap = await (await fetch(`${base}/snapshot`)).json();
    const droids = snap.guilds.find((g) => g.id === G).droids;
    assert.deepEqual(droids.map((d) => [d.source, d.systemId, d.condition, d.assignedToVentureId]), [
      ['guild', HOME_SYSTEM, 1, undefined],
      ['syndicate', HOME_SYSTEM, 1, undefined],
      ['syndicate', HOME_SYSTEM, 1, undefined],
      ['syndicate', HOME_SYSTEM, 1, undefined],
    ]);

    // Refusals exit 1 with the engine's reason, and mint nothing.
    const badSource = cli('grant-droid', '--system', HOME_SYSTEM, '--source', 'pirate');
    assert.equal(badSource.status, 1);
    assert.match(badSource.stderr, /grant-droid refused: "pirate" is not a droid source/);
    const zero = cli('grant-droid', '--system', HOME_SYSTEM, '--source', 'guild', '--count', '0');
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /grant-droid refused: count must be a whole number of droids, at least 1/);
    const negative = cli('grant-droid', '--system', HOME_SYSTEM, '--source', 'guild', '--count', '-2');
    assert.equal(negative.status, 1);
    assert.match(negative.stderr, /grant-droid refused: count must be a whole number/);
    const missing = cli('grant-droid', '--system', HOME_SYSTEM);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /grant-droid: --source is required/);
    const after = await (await fetch(`${base}/snapshot`)).json();
    assert.equal(after.guilds.find((g) => g.id === G).droids.length, 4, 'no refusal minted a droid');

    // The endpoint refuses a malformed body as a 400.
    const malformed = await fetch(`${base}/admin/guild/grant-droid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemId: HOME_SYSTEM, source: 'guild' }) });
    assert.equal(malformed.status, 400);
  } finally {
    server.kill();
  }
});
