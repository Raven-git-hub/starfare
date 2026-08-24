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
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

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

test('GET / serves the PLAYER CLIENT (HTML), not the deleted testbed', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  // The player client (client-wiring.md Slice 1: `/` is the game, `/inspect` the watcher).
  assert.match(html, /<title>STARFARE<\/title>/);
  assert.match(html, /id="connectBtn"/);          // the real found/adopt flow
  assert.match(html, /shellConnectInit/);
  assert.match(html, /id="hud-guild"/);           // identity from the snapshot, not a literal
  assert.match(html, /__setLiveTerritory/);       // territory from claims[]
  assert.match(html, /\/galaxy/);                  // the seed comes from the endpoint

  // The testbed is GONE — its file and its driver controls with it.
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'client', 'testbed.html')), false);
  for (const marker of ['SYNDICATE // TESTBED', 'id="btn-found"', 'id="btn-tick"', 'id="btn-autotick"']) {
    assert.ok(!html.includes(marker), `the player client must not carry the testbed's ${marker}`);
  }
  // And the demo galaxy + its baked identity are deleted, not bypassed (§6).
  assert.ok(!html.includes('buildDemoGalaxy'), 'the demo galaxy generator must be gone');
  assert.ok(!html.includes('Vanguard'), 'the demo guild literal must be gone');
});

test('GET /assets/<path> serves the client\'s art, and refuses a path that escapes', async () => {
  // A real file the client references (client/assets/planets/rocky.jpg).
  const ok = await fetch(base + '/assets/planets/rocky.jpg');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') || '', /image\/jpeg/);
  const bytes = Buffer.from(await ok.arrayBuffer());
  assert.ok(bytes.length > 0, 'the asset has content');
  assert.equal(bytes[0], 0xff, 'JPEG magic byte 1');   // it is the file, not an error page
  assert.equal(bytes[1], 0xd8, 'JPEG magic byte 2');

  // Traversal, in the forms a caller can actually send: a literal `..`, an
  // encoded one, and an absolute path. None may return a file.
  for (const bad of ['/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/../../sim/server.js', '/assets//etc/passwd']) {
    const res = await fetch(base + bad);
    assert.ok(res.status === 403 || res.status === 404, `${bad} must be refused, got ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('makeServer'), `${bad} must not return sim/server.js`);
  }

  // An unknown asset is a 404, not a 500.
  const miss = await fetch(base + '/assets/planets/nope.jpg');
  assert.equal(miss.status, 404);
});

test('GET /console serves the player-facing Production Console (HTML)', async () => {
  const res = await fetch(base + '/console');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  // The Archive-styled console page (not the testbed, not the JSON probe).
  assert.match(html, /System Production Console/);
  // Its driver controls + the live-wired scaffolding are present (a client-render
  // tripwire mirroring the GET / pin): tick, the resource bar, the Gate-1 arms, the
  // reserve level control, the syndicate send control, and the commitment readout —
  // all reading the schema-7 snapshot, computing no game number.
  assert.match(html, /id="btnTick"/);
  assert.match(html, /id="resbar"/);
  assert.match(html, /class="prank"/);        // Gate-1 priority selects
  assert.match(html, /class="rlevel"/);        // reserveLevel control
  assert.match(html, /class="syn-mode"/);      // Syndicate send-mode selector (Slice B-ii)
  assert.match(html, /commitmentReadout/);     // the windowed-accrual readout, from `window`
  assert.match(html, /systemReport/);          // reads the snapshot production block
  // Auto-tick watch UI (Phase 1 Stage 2): the console's LIVE / PAUSE-VIEW toggle —
  // a client-side refresh freeze only (no /autotick control: a player cannot pause
  // a persistent real-time world).
  assert.match(html, /id="btnLive"/);
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

test('GET /snapshot returns the zero-state snapshot (schema 7)', async () => {
  await reset();
  const { status, body } = await req('GET', '/snapshot');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, 7); // bumped 6->7 for the §5 Syndicate windowed-accrual telemetry
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

// --- auto-tick heartbeat (Phase 1 Stage 2) ---------------------------------
// The heartbeat is a real timer, so these tests let a little wall-clock pass.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Always stop the heartbeat after a heartbeat test so it can't leak into the
// next one (the server holds one module-level timer). reset() also stops it.
async function stopAuto() { await req('POST', '/autotick/stop'); }

test('GET /health carries the auto-tick status', async () => {
  await reset();
  const { body } = await req('GET', '/health');
  assert.ok(body.autotick, 'health carries an autotick block');
  assert.equal(body.autotick.running, false);
  assert.equal(body.autotick.lastError, null);
  // It is SERVER state, not game state — it must NOT leak into the snapshot.
  const snap = await req('GET', '/snapshot');
  assert.equal(snap.body.autotick, undefined, 'snapshot stays pure game state');
});

test('POST /autotick/start advances the tick with NO manual /tick', async () => {
  await reset();
  await found();
  await mine();
  const before = (await req('GET', '/snapshot')).body.tick;
  assert.equal(before, 0);

  const started = await req('POST', '/autotick/start', { intervalMs: 10 });
  assert.equal(started.status, 200);
  assert.equal(started.body.autotick.running, true);
  assert.equal(started.body.autotick.intervalMs, 10);

  await sleep(80);
  await stopAuto();

  // The galaxy moved on its own — no POST /tick was sent — and production minted.
  const snap = (await req('GET', '/snapshot')).body;
  assert.ok(snap.tick >= 1, `expected the heartbeat to advance the tick, got ${snap.tick}`);
  assert.equal(snap.guilds[0].stockpiles.titanium, snap.tick * 5, 'titanium tracks the auto-advanced tick');
});

test('POST /autotick/stop halts the heartbeat (the tick stops moving)', async () => {
  await reset();
  await req('POST', '/autotick/start', { intervalMs: 10 });
  await sleep(50);
  const stopped = await req('POST', '/autotick/stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.autotick.running, false);

  const t1 = (await req('GET', '/snapshot')).body.tick;
  await sleep(50);
  const t2 = (await req('GET', '/snapshot')).body.tick;
  assert.equal(t1, t2, 'the tick must not advance after stop');
});

test('POST /autotick/stop is idempotent (stop-when-stopped is a 200 no-op)', async () => {
  await reset();
  const r = await req('POST', '/autotick/stop');
  assert.equal(r.status, 200);
  assert.equal(r.body.autotick.running, false);
});

test('start-while-running replaces the interval (change speed live)', async () => {
  await reset();
  await req('POST', '/autotick/start', { intervalMs: 10 });
  const replaced = await req('POST', '/autotick/start', { intervalMs: 40 });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.autotick.running, true);
  assert.equal(replaced.body.autotick.intervalMs, 40, 'the new interval replaced the old one');
  const health = await req('GET', '/health');
  assert.equal(health.body.autotick.intervalMs, 40);
  await stopAuto();
});

test('an invalid intervalMs is rejected (400) and does not start a heartbeat', async () => {
  await reset();
  for (const bad of [0, -5, 5 /* below the 10ms floor */, 3.5, 'fast', null]) {
    const r = await req('POST', '/autotick/start', { intervalMs: bad });
    assert.equal(r.status, 400, `intervalMs ${JSON.stringify(bad)} must be rejected`);
  }
  // A missing body field is a 400 too.
  const none = await req('POST', '/autotick/start', {});
  assert.equal(none.status, 400);
  // None of the rejects started anything.
  const health = await req('GET', '/health');
  assert.equal(health.body.autotick.running, false);
});

test('POST /reset stops a running heartbeat', async () => {
  await reset();
  await req('POST', '/autotick/start', { intervalMs: 10 });
  assert.equal((await req('GET', '/health')).body.autotick.running, true);
  await reset();
  const health = await req('GET', '/health');
  assert.equal(health.body.autotick.running, false, 'reset must stop the clock before zeroing');
  // Belt-and-braces: the tick genuinely stops moving after the reset.
  const t1 = (await req('GET', '/snapshot')).body.tick;
  await sleep(40);
  const t2 = (await req('GET', '/snapshot')).body.tick;
  assert.equal(t1, t2);
});

// --- client-wiring Slice 0: the seed endpoint, the watcher, the boot clock ---

test('GET /galaxy serves the committed seed geometry verbatim (JSON)', async () => {
  const res = await fetch(base + '/galaxy');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();

  // The shape the map (Slice 1) and the detail screens read: systems with
  // coordinates + ring + planets, the outposts, and the Citadel.
  assert.ok(Array.isArray(body.systems) && body.systems.length > 0, 'systems present');
  const s0 = body.systems[0];
  assert.equal(typeof s0.coords.q, 'number');
  assert.equal(typeof s0.coords.r, 'number');
  assert.equal(typeof s0.ring, 'string');
  assert.ok(Array.isArray(s0.planets), 'a system carries its planets');
  assert.ok(Array.isArray(body.outposts), 'outposts present');
  assert.ok(body.citadel, 'the Citadel is present');

  // And it is the COMMITTED seed, not a reshape: byte-for-byte the same file
  // sim/seed.js reads, so map and detail can never disagree on geometry.
  assert.deepEqual(body, require('../../data/seed.json'));
});

test('GET /inspect serves the operator watcher — and it has NO action controls', async () => {
  const res = await fetch(base + '/inspect');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  // The page itself (not the testbed, not the console, not the JSON probe).
  assert.match(html, /SYNDICATE \/\/ OPERATOR WATCH/);
  assert.match(html, /id="productionpanel"/);   // it renders the full god's-eye state
  assert.match(html, /id="occupancypanel"/);
  assert.match(html, /id="claimpanel"/);
  assert.match(html, /\/snapshot/);             // it reads the snapshot, live

  // THE WATCH-ONLY GUARANTEE (client-wiring.md §2): the served bytes name no
  // mutating route at all. If a control ever creeps in, this fails loudly.
  for (const route of ['/action', '/tick', '/reset', '/autotick']) {
    assert.ok(!html.includes(route), `/inspect must not reference ${route} — it only watches`);
  }
});

// The boot clock lives in the CLI block, so these tests boot sim/server.js as a
// REAL child process. They are the only tests here that do; everything else drives
// the in-process server above.
const SERVER_JS = path.join(__dirname, '..', 'server.js');

// Ask the OS for a free port and hand it back. The CLI reads PORT from the env and
// treats 0 as unset (Number('0') is falsy), so a boot test cannot use the
// ephemeral-port trick the in-process tests use. The tiny bind race is acceptable.
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

// Boot the server as its own process with STARFARE_TICK_MS explicitly controlled
// (deleted, not just unset, so the ambient env can never leak into the OFF case).
// Returns the child plus accumulating stdout/stderr for the boot log assertions.
function bootServer(tickMs, port) {
  const env = { ...process.env, PORT: String(port) };
  delete env.STARFARE_TICK_MS;
  delete env.STARFARE_PERSIST_DIR; // the boot clock is what's under test, not durability
  if (tickMs !== undefined) env.STARFARE_TICK_MS = String(tickMs);
  const child = spawn(process.execPath, [SERVER_JS], { env });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  return { child, out };
}

// Poll the liveness probe until the child is answering (or give up loudly).
async function waitForHealth(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('the booted server never answered /health');
    await sleep(25);
  }
}

test('STARFARE_TICK_MS set: the clock starts on boot (no manual advance)', async () => {
  const port = await freePort();
  const { child, out } = bootServer(50, port);
  try {
    const health = await waitForHealth(port);
    assert.equal(health.autotick.running, true, 'the heartbeat runs from boot');
    assert.equal(health.autotick.intervalMs, 50);
    assert.match(out.stdout, /\[clock\] ON — auto-tick every 50 ms/);
    // And it genuinely turns: the tick climbs with nothing driving it.
    const t1 = (await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json()).tick;
    await sleep(250);
    const t2 = (await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json()).tick;
    assert.ok(t2 > t1, `expected the galaxy to advance on its own (${t1} -> ${t2})`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('STARFARE_TICK_MS unset: no heartbeat (today\'s behaviour, unchanged)', async () => {
  const port = await freePort();
  const { child, out } = bootServer(undefined, port);
  try {
    const health = await waitForHealth(port);
    assert.equal(health.autotick.running, false, 'unset must mean no clock');
    assert.equal(health.autotick.intervalMs, null);
    assert.match(out.stdout, /\[clock\] OFF — no heartbeat/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('POST /reset comes back RUNNING when the boot clock is configured', async () => {
  // Ruling 24-08-26 (client-wiring.md §5): a deployed galaxy must always turn, so a
  // reset returns a fresh RUNNING galaxy — it re-arms the boot clock rather than
  // leaving the world frozen until someone restarts the server.
  const port = await freePort();
  const { child } = bootServer(50, port);
  try {
    await waitForHealth(port);
    const reset = await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).tick, 0, 'reset still zeroes the galaxy');
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.autotick.running, true, 'the clock is re-armed after a reset');
    assert.equal(health.autotick.intervalMs, 50, 'at the interval the operator booted with');
    // And it genuinely turns again, from zero.
    await sleep(250);
    const tick = (await (await fetch(`http://127.0.0.1:${port}/snapshot`)).json()).tick;
    assert.ok(tick >= 1, `expected the reset galaxy to advance on its own, got ${tick}`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('POST /reset leaves the clock OFF when no boot clock was configured', async () => {
  // The manual dev-rig flow is unchanged: with STARFARE_TICK_MS unset there is no
  // clock to put back, so reset must not invent one.
  const port = await freePort();
  const { child } = bootServer(undefined, port);
  try {
    await waitForHealth(port);
    await fetch(`http://127.0.0.1:${port}/autotick/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMs: 10 }),
    });
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).autotick.running, true);
    await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' });
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.autotick.running, false, 'reset stops a hand-started clock and does not re-arm');
    assert.equal(health.autotick.intervalMs, null);
  } finally {
    child.kill('SIGKILL');
  }
});

test('an invalid STARFARE_TICK_MS fails the boot loudly (non-zero exit)', async () => {
  for (const bad of ['fast', '0', '-5', '5' /* below the floor */, '3.5']) {
    const port = await freePort();
    const { child, out } = bootServer(bad, port);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.notEqual(code, 0, `STARFARE_TICK_MS=${bad} must fail the boot`);
    assert.match(out.stderr, /\[clock\] STARFARE_TICK_MS must be an integer/);
  }
});
