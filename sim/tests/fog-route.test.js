'use strict';

// fog-route.test.js — the HEADLESS seam for the per-guild view (roadmap 2.5 (a) engine slice 1):
// `GET /snapshot?guild=<id>` serves `buildSnapshot(state, id)`; plain `GET /snapshot` is the god's-eye
// lens exactly as before; an unknown guild is a 404, never a silent god's-eye fallback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { makeServer } = require('../server.js');
const { getStarterSystems } = require('../seed.js');

let server;
let base;

before(async () => {
  server = makeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
});

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const [HOME_A, HOME_B] = getStarterSystems().map((s) => s.id);

test('GET /snapshot?guild= serves that guild\'s fogged view; plain /snapshot stays god\'s-eye; unknown guild 404s', async () => {
  await req('POST', '/reset');
  for (const [guildId, homeSystemId] of [['player-guild', HOME_A], ['bot-guild', HOME_B]]) {
    const { body } = await req('POST', '/action', { type: 'foundGuild', guildId, credits: 2000, influence: 100, homeSystemId });
    assert.equal(body.accepted, true, body.reason);
  }

  const gods = await req('GET', '/snapshot');
  assert.equal(gods.status, 200);
  assert.equal('viewerGuildId' in gods.body, false, 'no query = the god\'s-eye lens, unchanged');
  assert.ok('stockpilesBySystem' in gods.body.guilds.find((g) => g.id === 'bot-guild'), 'which shows every guild in full');

  const mine = await req('GET', '/snapshot?guild=player-guild');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.viewerGuildId, 'player-guild');
  assert.ok(Array.isArray(mine.body.geography.systems) && mine.body.geography.known[HOME_A], 'with its geography');
  assert.deepEqual(Object.keys(mine.body.guilds.find((g) => g.id === 'bot-guild')), ['id', 'name', 'isBot', 'homeSystemId'],
    'the rival cut to its public facts');
  assert.ok('stockpilesBySystem' in mine.body.guilds.find((g) => g.id === 'player-guild'), 'its own row in full');

  const nobody = await req('GET', '/snapshot?guild=nobody');
  assert.equal(nobody.status, 404);
  assert.match(nobody.body.error, /no guild with id "nobody"/);
});
