'use strict';

// Tests the testbed dev-harness server (slice 2, 03-08-26). It boots the real
// server on an ephemeral port and drives it over HTTP, so this is the tripwire
// that the thin HTTP layer faithfully exposes the SAME engine — and, crucially,
// that submitting an action does NOT tick (manual tick), while POST /tick does.
//
// The server holds ONE module-level state, so tests that need a clean galaxy
// POST /reset first.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { makeServer } = require('../server.js');

let server;
let base;

before(async () => {
  server = makeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  // Close the listener and any lingering keep-alive sockets so the test process
  // can exit cleanly (fetch/undici holds connections open otherwise).
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
});

// Small helpers.
async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const reset = () => req('POST', '/reset');
const found = (over = {}) => req('POST', '/action', { type: 'foundGuild', guildId: 'player', credits: 120, influence: 100, homeSystemId: 'sys_0002', ...over });
const mine = (over = {}) => req('POST', '/action', { type: 'establishVenture', guildId: 'player', ventureId: 'm1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5, ...over });

// --- read endpoints --------------------------------------------------------

test('GET / reports liveness', async () => {
  await reset();
  const { status, body } = await req('GET', '/');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'starfare-testbed');
});

test('GET /snapshot returns the zero-state snapshot (schema 2)', async () => {
  await reset();
  const { status, body } = await req('GET', '/snapshot');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.tick, 0);
  assert.equal(body.guilds.length, 0);
  assert.equal(body.claims.length, 10); // Citadel + 9 outposts
});

// --- the manual-tick contract: actions do NOT tick -------------------------

test('POST /action applies the action but does NOT advance the tick', async () => {
  await reset();
  const { status, body } = await found();
  assert.equal(status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.snapshot.guilds.length, 1);
  assert.equal(body.snapshot.tick, 0, 'founding must not tick — manual tick only');
});

test('a venture established via /action does not produce until a /tick', async () => {
  await reset();
  await found();
  const est = await mine();
  assert.equal(est.body.accepted, true);
  assert.equal(est.body.snapshot.ventures.length, 1);
  assert.equal((est.body.snapshot.guilds[0].stockpiles.titanium) || 0, 0, 'no production before a tick');
});

test('POST /tick advances one tick and production mints', async () => {
  await reset();
  await found();
  await mine();
  let t = await req('POST', '/tick');
  assert.equal(t.body.tick, 1);
  assert.equal(t.body.guilds[0].stockpiles.titanium, 5);
  t = await req('POST', '/tick');
  assert.equal(t.body.tick, 2);
  assert.equal(t.body.guilds[0].stockpiles.titanium, 10);
});

// --- rejections are 200 with a reason, not errors --------------------------

test('an occupied node is rejected (200, accepted:false, reason)', async () => {
  await reset();
  await found();
  await mine();
  const { status, body } = await mine({ ventureId: 'm2' });
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.match(body.reason, /already occupied/);
});

test('an unknown action type is rejected with a reason', async () => {
  await reset();
  const { status, body } = await req('POST', '/action', { type: 'nonsense' });
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.match(body.reason, /unknown action type/);
});

// --- malformed input + routing --------------------------------------------

test('a non-JSON body is a 400', async () => {
  const res = await fetch(base + '/action', { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('a non-object JSON body is a 400', async () => {
  const { status } = await req('POST', '/action', [1, 2, 3]);
  assert.equal(status, 400);
});

test('an unknown route is a 404', async () => {
  const res = await fetch(base + '/nope');
  assert.equal(res.status, 404);
});

// --- reset -----------------------------------------------------------------

test('POST /reset returns to the zero-state', async () => {
  await reset();
  await found();
  await req('POST', '/tick');
  const { body } = await reset();
  assert.equal(body.tick, 0);
  assert.equal(body.guilds.length, 0);
  assert.equal(body.claims.length, 10);
});
