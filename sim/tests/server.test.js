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
const found = (over = {}) => req('POST', '/action', { type: 'foundGuild', guildId: 'player-guild', credits: 120, influence: 100, homeSystemId: 'sys_0002', ...over });
const mine = (over = {}) => req('POST', '/action', { type: 'establishVenture', guildId: 'player-guild', ventureId: 'm1', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5, ...over });

// --- read endpoints --------------------------------------------------------

test('GET / serves the testbed UI (HTML)', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /SYNDICATE \/\/ TESTBED/); // the page, not the JSON probe
  assert.match(html, /id="btn-found"/);         // the driver controls are present
  assert.match(html, /id="btn-tick"/);
  // The home-system picker replaced the free-text id, and the invented-influence
  // field is gone (see the /starters slice, 04-08-26).
  assert.match(html, /<select id="f-home">/);
  assert.doesNotMatch(html, /id="f-influence"/);
  // Guild Management overlay scaffolding is present (slice 2, 04-08-26): the
  // per-card MANAGE affordance, the full-screen overlay, and its guild selector.
  assert.match(html, /class="manage"/);
  assert.match(html, /id="guild-overlay"/);
  assert.match(html, /id="go-guild"/);
  // The standalone establish form was retired (slice 3, 04-08-26): establishing
  // now lives in the planet manifest inside the overlay.
  assert.doesNotMatch(html, /id="btn-venture"/);
  // The Production view is served: its renderer and the MANIFEST/PRODUCTION toggle.
  assert.match(html, /renderProductionView/);
  assert.match(html, /data-sysmode="production"/);
  // Slice 2b-ii — the INTERACTIVE controls are present: the Gate-1 fork rank
  // up/down buttons, the downstream-cap input, the Gate-3 per-line throttle input,
  // and the disabled Syndicate-fork marker (inert until real licences).
  assert.match(html, /class="fork-move"/);
  assert.match(html, /class="dscap"/);
  assert.match(html, /class="throttle"/);
  assert.match(html, /no licences yet/);
  // The naive browser-side recompute + its caption are gone — the view now shows
  // the engine's resolved allocation, so nothing is captioned "naive".
  assert.doesNotMatch(html, /class="pc-grid"/);
  assert.doesNotMatch(html, /do <b>not<\/b> account for throttling/);
  // Slice 2c-ii — the review flag display: the per-issue list in the Production
  // view and the issue-count badge on the system header (both render the engine's
  // `review` array; no client-side issue logic).
  assert.match(html, /class="review-issue"/);
  assert.match(html, /class="review-badge"/);
});

test('GET /starters lists the seed\'s startable home systems', async () => {
  const { status, body } = await req('GET', '/starters');
  assert.equal(status, 200);
  // 368 starter-eligible systems in seed 7331. Pinned on purpose: if this ever
  // changes, the seed changed under us and we want to be told loudly.
  assert.equal(body.count, 368);
  assert.equal(body.starters.length, 368);
  // Shape: each carries what the picker shows plus the homeworld a guild seats on.
  const s0 = body.starters[0];
  assert.deepEqual(Object.keys(s0).sort(), ['id', 'name', 'ring', 'terranHomeworldId']);
  // Starter-eligible ⟺ it has a Terran homeworld, so none may be null.
  assert.ok(body.starters.every((s) => typeof s.terranHomeworldId === 'string' && s.terranHomeworldId.length > 0));
  // Deterministic, id-sorted; sys_0002 is the known first starter (the old form default).
  assert.equal(s0.id, 'sys_0002');
  for (let i = 1; i < body.starters.length; i++) {
    assert.ok(body.starters[i - 1].id < body.starters[i].id, 'starters must be id-sorted');
  }
});

test('GET /system/:id returns a system\'s static layout (planets, nodes, slots)', async () => {
  const { status, body } = await req('GET', '/system/sys_0002');
  assert.equal(status, 200);
  assert.equal(body.id, 'sys_0002');
  assert.equal(body.terranHomeworldId, 'pl_00004');
  assert.equal(body.planets.length, 1);
  const hw = body.planets[0];
  assert.equal(hw.archetype, 'terran');
  assert.equal(hw.resourceNodes.length, 15);
  assert.equal(hw.settlementSlots.length, 15); // the Terran slot anchor
  assert.equal(hw.resourceNodes[0].resourceType, 'titanium');
});

test('GET /system/:id handles a multi-planet system and 404s an unknown id', async () => {
  const multi = await req('GET', '/system/sys_0009');
  assert.equal(multi.status, 200);
  assert.equal(multi.body.planets.length, 4);
  const miss = await req('GET', '/system/sys_9999');
  assert.equal(miss.status, 404);
  assert.match(miss.body.error, /no such system/);
});

test('GET /recipes returns the refining catalog', async () => {
  const { status, body } = await req('GET', '/recipes');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.recipes));
  const alloy = body.recipes.find((r) => r.id === 'titanium_alloy');
  assert.ok(alloy, 'titanium_alloy present');
  assert.deepEqual(alloy.inputs, [
    { good: 'titanium', qty: 3 },
    { good: 'carbon_products', qty: 1 },
  ]);
  assert.deepEqual(alloy.output, { good: 'titanium_alloy', qty: 1 });
});

test('GET /goods returns the vocabulary by tier', async () => {
  const { status, body } = await req('GET', '/goods');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.raw) && Array.isArray(body.processed));
  // raw + processed together are exactly the stockpile goods (resources.js).
  assert.ok(body.raw.includes('titanium'), 'a known raw good is present');
  assert.ok(body.processed.includes('titanium_alloy'), 'a known processed good is present');
  assert.ok(!body.raw.includes('titanium_alloy'), 'processed goods are not in the raw list');
});

test('GET /health reports liveness (JSON)', async () => {
  await reset();
  const { status, body } = await req('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'starfare-testbed');
});

test('GET /snapshot returns the zero-state snapshot (schema 6)', async () => {
  await reset();
  const { status, body } = await req('GET', '/snapshot');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, 6); // bumped 5->6 for the §5 rate-based engine rewrite
  assert.equal(body.tick, 0);
  assert.equal(body.guilds.length, 0);
  assert.equal(body.claims.length, 10); // Citadel + 9 outposts
});

test('a founded guild\'s snapshot carries per-system stockpiles and each venture the reserved commitment', async () => {
  await reset();
  await found();
  await mine();
  const { body } = await req('POST', '/tick'); // one tick so the mine mints
  const g = body.guilds[0];
  // Per-system breakdown (ruling B1): titanium pooled in the home system.
  assert.deepEqual(g.stockpilesBySystem, { sys_0002: { titanium: 5 } });
  // Flat total still present and equal to the sum across systems.
  assert.equal(g.stockpiles.titanium, 5);
  // The venture carries its systemId and the reserved commitment placeholder (0).
  const v = body.ventures[0];
  assert.equal(v.systemId, 'sys_0002');
  assert.equal(v.syndicateCommitment, 0);
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
