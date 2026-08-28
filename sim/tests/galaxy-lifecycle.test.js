'use strict';

// Tests the runtime GALAXY LIFECYCLE (docs/galaxy-lifecycle.md, Slice A): a server
// with a persist volume is either NO-GALAXY or ACTIVE, two admin endpoints move
// between those states, and the seed itself lives in the volume so a galaxy created
// at runtime survives a restart.
//
// These boot the real server as a child process, because the lifecycle IS boot
// behaviour: what the volume holds decides which state the server comes up in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { dayOf, minuteOf } = require('../calendar.js');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-lifecycle-')); }

// Boot a server over a given volume. tickMs undefined ⇒ no boot clock.
function bootServer({ dir, port, tickMs }) {
  const env = { ...process.env, PORT: String(port), STARFARE_PERSIST_DIR: dir };
  delete env.STARFARE_TICK_MS;
  if (tickMs !== undefined) env.STARFARE_TICK_MS = String(tickMs);
  const child = spawn(process.execPath, [SERVER_JS], { env });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  return { child, out };
}

async function waitForHealth(port, timeoutMs = 8000) {
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
const get = async (port, p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
};
const post = async (port, p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

// --- 1. Create -------------------------------------------------------------

test('POST /admin/galaxy/new creates a galaxy: active, on the new seed, at tick 0, turning', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child, out } = bootServer({ dir, port, tickMs: 50 });
  try {
    const before = await waitForHealth(port);
    assert.equal(before.galaxy, 'no-galaxy', 'an empty volume boots to NO GALAXY');
    assert.equal(before.autotick.running, false, 'nothing to tick, so no clock');

    const created = await post(port, '/admin/galaxy/new', { seed: 12345 });
    assert.equal(created.status, 200);
    assert.deepEqual({ ok: created.body.ok, seed: created.body.seed, tick: created.body.tick },
      { ok: true, seed: 12345, tick: 0 });

    const health = await get(port, '/health');
    assert.equal(health.body.galaxy, 'active');
    assert.equal(health.body.seed, 12345);
    assert.equal(health.body.autotick.running, true, 'the galaxy turns from creation, with no guilds');

    // /galaxy now serves THIS seed's geometry.
    const galaxy = await get(port, '/galaxy');
    assert.equal(galaxy.status, 200);
    assert.equal(galaxy.body.seed, 12345);
    assert.ok(galaxy.body.systems.length > 0);

    // The zero-state was rebuilt on the NEW seed: the Syndicate's claims are this
    // galaxy's Citadel + one per outpost, not the previous galaxy's.
    const snap = await get(port, '/snapshot');
    assert.equal(snap.body.tick >= 0, true);
    assert.equal(snap.body.guilds.length, 0);
    assert.equal(snap.body.claims.length, 1 + galaxy.body.outposts.length,
      'Syndicate claims = the Citadel + one waystation per outpost of THIS seed');
    assert.ok(snap.body.claims.every((c) => c.ownerGuildId === 'syndicate'));

    // The volume holds the whole galaxy.
    for (const f of ['seed.json', 'state.json']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} written to the volume`);
    }
    assert.match(out.stdout, /\[galaxy\] CREATED — seed 12345/);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. Reproducibility ----------------------------------------------------

test('the same seed number makes the same galaxy (twice, in-process and over two servers)', async () => {
  const { generateGalaxySeed } = require('../../tools/generate_seed.js');
  const a = generateGalaxySeed(777);
  const b = generateGalaxySeed(777);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'the generator is a pure function of its number');

  const runs = [];
  for (let i = 0; i < 2; i++) {
    const dir = tmpDir();
    const port = await freePort();
    const { child } = bootServer({ dir, port });
    try {
      await waitForHealth(port);
      await post(port, '/admin/galaxy/new', { seed: 777 });
      runs.push(JSON.stringify((await get(port, '/galaxy')).body));
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.equal(runs[0], runs[1], 'two servers, same number, byte-identical geometry');
  assert.equal(runs[0], JSON.stringify(a), 'and it is what the generator produces');
});

// --- 3. A randomised seed --------------------------------------------------

test('Create with no seed randomises one, and reports it', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child } = bootServer({ dir, port });
  try {
    await waitForHealth(port);
    const created = await post(port, '/admin/galaxy/new', {});
    assert.equal(created.status, 200);
    assert.ok(Number.isInteger(created.body.seed), 'a number was chosen');
    assert.ok(created.body.seed > 0);
    const health = await get(port, '/health');
    assert.equal(health.body.seed, created.body.seed, 'and /health names the same galaxy');
    assert.equal((await get(port, '/galaxy')).body.seed, created.body.seed);
    // A bad seed is refused rather than silently randomised over.
    const bad = await post(port, '/admin/galaxy/new', { seed: 'nine' });
    assert.equal(bad.status, 400);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. Delete -------------------------------------------------------------

test('POST /admin/galaxy/delete returns the server to NO GALAXY, and nothing crashes there', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child, out } = bootServer({ dir, port, tickMs: 50 });
  try {
    await waitForHealth(port);
    await post(port, '/admin/galaxy/new', { seed: 4242 });
    assert.equal((await get(port, '/health')).body.galaxy, 'active');

    const del = await post(port, '/admin/galaxy/delete');
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true, state: 'no-galaxy' });

    const health = await get(port, '/health');
    assert.equal(health.body.galaxy, 'no-galaxy');
    assert.equal(health.body.seed, null);
    assert.equal(health.body.tick, null);
    assert.equal(health.body.autotick.running, false, 'the clock stops with the galaxy');

    // Every route answers the no-galaxy state; none throws a 500.
    const galaxy = await get(port, '/galaxy');
    assert.equal(galaxy.status, 404);
    assert.equal(galaxy.body.state, 'no-galaxy');
    const snap = await get(port, '/snapshot');
    assert.equal(snap.status, 200);
    assert.equal(snap.body.state, 'no-galaxy');
    for (const p of ['/starters', '/system/sys_0002']) {
      const r = await get(port, p);
      assert.equal(r.body.state, 'no-galaxy', `${p} answers the state`);
    }
    for (const p of ['/tick', '/reset', '/autotick/stop']) {
      const r = await post(port, p);
      assert.ok(r.status < 500, `${p} refuses gracefully, got ${r.status}`);
      assert.equal(r.body.state, 'no-galaxy');
    }
    const act = await post(port, '/action', { type: 'foundGuild', guildId: 'g', credits: 0, homeSystemId: 'sys_0002' });
    assert.ok(act.status < 500);
    assert.equal(act.body.state, 'no-galaxy');

    // The volume is empty again.
    for (const f of ['seed.json', 'state.json', 'journal.jsonl']) {
      assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} removed from the volume`);
    }
    assert.match(out.stdout, /\[galaxy\] DELETED/);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. Boot restore -------------------------------------------------------

test('a galaxy created at runtime survives a restart, byte-identical', async () => {
  const { hashState } = require('../serialize.js');
  const dir = tmpDir();
  try {
    const p1 = await freePort();
    const first = bootServer({ dir, port: p1 });
    let stateBefore;
    try {
      await waitForHealth(p1);
      await post(p1, '/admin/galaxy/new', { seed: 909 });
      // Do something real, so the restore has more than a zero-state to prove.
      const starters = (await get(p1, '/starters')).body.starters;
      await post(p1, '/action', { type: 'foundGuild', guildId: 'g1', name: 'G One', credits: 500, homeSystemId: starters[0].id });
      await post(p1, '/tick');
      await post(p1, '/tick');
      stateBefore = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    } finally { first.child.kill('SIGKILL'); }

    const p2 = await freePort();
    const second = bootServer({ dir, port: p2 });
    try {
      const health = await waitForHealth(p2);
      assert.equal(health.galaxy, 'active');
      assert.equal(health.seed, 909, 'the volume seed, not the baked one');
      assert.equal(health.tick, stateBefore.tick);
      assert.match(second.out.stdout, /\[galaxy\] ACTIVE — seed 909/);
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(hashState(after), hashState(stateBefore), 'restored byte-identical (invariant 9)');
      const snap = await get(p2, '/snapshot');
      assert.equal(snap.body.guilds.length, 1);
      assert.equal(snap.body.guilds[0].id, 'g1');
    } finally { second.child.kill('SIGKILL'); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6. Boot into NO GALAXY ------------------------------------------------

test('an empty volume boots to NO GALAXY and every endpoint stays up', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child, out } = bootServer({ dir, port, tickMs: 50 });
  try {
    const health = await waitForHealth(port);
    assert.equal(health.galaxy, 'no-galaxy');
    assert.equal(health.seed, null);
    assert.equal(health.autotick.running, false);
    assert.ok(health.uptimeSeconds >= 0);
    assert.ok(typeof health.serverTime === 'string');
    assert.match(out.stdout, /\[galaxy\] NO GALAXY/);
    assert.match(out.stdout, /\[clock\] ARMED/, 'the clock waits for a galaxy rather than starting');
    // The pages still serve — the operator needs the admin panel to create one.
    for (const p of ['/', '/inspect', '/console']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 200, `${p} still serves in NO GALAXY`);
    }
    assert.equal((await get(port, '/galaxy')).status, 404);
    assert.equal((await get(port, '/snapshot')).body.state, 'no-galaxy');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 7. The consistency guard ----------------------------------------------

test('a seed paired with another galaxy\'s state is never loaded — the create is finished instead', async () => {
  const dir = tmpDir();
  try {
    // Make a real galaxy on seed 111 with a guild in it…
    const p1 = await freePort();
    const first = bootServer({ dir, port: p1 });
    try {
      await waitForHealth(p1);
      await post(p1, '/admin/galaxy/new', { seed: 111 });
      const starters = (await get(p1, '/starters')).body.starters;
      await post(p1, '/action', { type: 'foundGuild', guildId: 'ghost', name: 'Ghost', credits: 500, homeSystemId: starters[0].id });
      await post(p1, '/tick');
    } finally { first.child.kill('SIGKILL'); }

    // …then simulate a Create interrupted between saveSeed and saveState: a NEW
    // seed on disk, still beside the OLD galaxy's state.
    const { generateGalaxySeed } = require('../../tools/generate_seed.js');
    fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(generateGalaxySeed(222)));

    const p2 = await freePort();
    const second = bootServer({ dir, port: p2 });
    try {
      const health = await waitForHealth(p2);
      assert.equal(health.galaxy, 'active');
      assert.equal(health.seed, 222, 'the active seed is the one on disk');
      assert.equal(health.tick, 0, 'and the state is a fresh zero-state on it');
      assert.match(second.out.stderr, /INCONSISTENT SAVE/, 'and it said so loudly');
      const snap = await get(p2, '/snapshot');
      assert.equal(snap.body.guilds.length, 0, 'the previous galaxy\'s guild is NOT carried over');
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(onDisk.world.seed, 222, 'the repaired state was persisted');
    } finally { second.child.kill('SIGKILL'); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 8. Back-compat: no volume ⇒ no lifecycle, byte-for-byte -----------------

test('with no persist volume the engine path is unchanged (hash-identical)', () => {
  // The lifecycle only exists over a volume. Without one the server still boots the
  // committed seed into a zero-state, so a scripted run must hash exactly as it did
  // before this change — the same value the pre-existing determinism tests assert.
  const { createZeroState } = require('../scenarios/zero-state.js');
  const { advance } = require('../run.js');
  const { hashState } = require('../serialize.js');
  const { createFoundGuildAction } = require('../actions.js');
  const { getSeedNumber } = require('../seed.js');

  assert.equal(getSeedNumber(), 7331, 'the default index is still the committed seed');
  let a = createZeroState();
  a = advance(a, [createFoundGuildAction({ guildId: 'p', name: 'P', credits: 120, influence: 100, homeSystemId: 'sys_0002' })]).state;
  a = advance(a, []).state;

  let b = createZeroState();
  b = advance(b, [createFoundGuildAction({ guildId: 'p', name: 'P', credits: 120, influence: 100, homeSystemId: 'sys_0002' })]).state;
  b = advance(b, []).state;

  assert.equal(hashState(a), hashState(b));
  assert.equal(a.world.seed, 7331);
});

// The admin endpoints need a volume to own a galaxy; without one they refuse.
test('the admin endpoints refuse when there is no persist volume', async () => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.STARFARE_PERSIST_DIR;
  delete env.STARFARE_TICK_MS;
  const child = spawn(process.execPath, [SERVER_JS], { env });
  try {
    await waitForHealth(port);
    for (const p of ['/admin/galaxy/new', '/admin/galaxy/delete']) {
      const r = await post(port, p, {});
      assert.equal(r.status, 409);
      assert.match(r.body.error, /persist volume/);
    }
    // …and the dev path still serves the committed galaxy, untouched.
    const g = await get(port, '/galaxy');
    assert.equal(g.status, 200);
    assert.equal(g.body.seed, 7331);
  } finally {
    child.kill('SIGKILL');
  }
});

// --- The midnight anchor at the create seam (docs/cycle-and-calendar.md §2) --------
//
// The anchor's whole point is that a LIVE galaxy rolls its cycle at server midnight
// rather than at whatever time of day it was created. The arithmetic is proven in
// calendar.test.js and day-anchor.test.js; these two prove the WIRING — that creation
// actually sets it, that it is persisted and reloaded rather than recomputed, and that
// the two paths which must NOT anchor (reset, restore) still don't.

test('creating a galaxy sets a frozen dayAnchorTick, and the snapshot carries the clock', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child } = bootServer({ dir, port });
  try {
    await waitForHealth(port);
    await post(port, '/admin/galaxy/new', { seed: 31337 });

    const snap = await get(port, '/snapshot');
    const cal = snap.body.calendar;
    assert.ok(cal, 'the snapshot carries the cycle clock');
    assert.equal(cal.windowN, 1440, 'a live galaxy runs the ruled cycle length');

    // The anchor is derived from the server's own clock, so the test cannot predict it
    // — but it CAN pin the property that makes it an anchor: the first producing tick
    // must read the wall clock's minute-of-day, i.e. anchor ≡ -minuteOfDay (mod N),
    // which puts it in (-1440, 0].
    const a = cal.dayAnchorTick;
    assert.ok(Number.isInteger(a), `dayAnchorTick is an integer, got ${a}`);
    assert.ok(a <= 0 && a > -1440, `the anchor is the negative representative, got ${a}`);

    // The property that makes it an ANCHOR rather than an arbitrary offset: the galaxy's
    // first producing tick lands on DAY 0 at the minute-of-day it was created, and its
    // first boundary is exactly that many minutes short of a full cycle — i.e. the next
    // midnight. (Whether that minute matches this machine's clock is minuteOfDayFromDate's
    // unit test; here the server's clock is the input, so re-reading it would only
    // re-derive the same number and prove nothing.)
    const impliedMinute = ((-a % 1440) + 1440) % 1440;
    assert.equal(dayOf(1, 1440, a), 0, 'the creation tick is on day 0');
    assert.equal(minuteOf(1, 1440, a), impliedMinute, 'reading the minute it was created at');
    const firstBoundary = 1440 + a; // minutes REMAINING until midnight, not elapsed
    assert.equal(((firstBoundary - a) % 1440 + 1440) % 1440, 0, 'the first boundary is a real boundary');
    assert.equal(minuteOf(firstBoundary, 1440, a), 1439, 'and it is the last minute of day 0 — midnight');

    // Frozen: it must survive a restart unchanged (§3, no catch-up).
    child.kill('SIGKILL');
    const port2 = await freePort();
    const second = bootServer({ dir, port: port2 });
    try {
      await waitForHealth(port2);
      const snap2 = await get(port2, '/snapshot');
      assert.equal(snap2.body.calendar.dayAnchorTick, a,
        'the reloaded galaxy kept its anchor — nothing re-derived it');
    } finally { second.child.kill('SIGKILL'); }
  } finally { child.kill('SIGKILL'); }
});

// --- The per-galaxy UTC offset at the create seam (§2) -----------------------------
//
// WHICH midnight the anchor above lines up with. The arithmetic is proven at a known
// instant in utc-offset.test.js (a live server's clock is not settable); these prove the
// WIRING — that Create takes the operator's choice, freezes it, serves it on both the
// snapshot and /health, refuses a bad one, and that neither reset nor restore invents one.

test('a galaxy created with a UTC offset freezes it, serves it, and survives a restart with it', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child } = bootServer({ dir, port });
  try {
    await waitForHealth(port);
    // Bracket the create with our own UTC readings: the server's clock is the input, so
    // the expected minute is whichever of the two the create fell on. (A minute can roll
    // mid-test; pinning a single reading would make this flake once an hour.)
    const utcMinuteNow = () => { const d = new Date(); return (d.getUTCHours() * 60) + d.getUTCMinutes(); };
    const before = utcMinuteNow();
    const created = await post(port, '/admin/galaxy/new', { seed: 8888, utcOffsetMinutes: 480 });
    const after = utcMinuteNow();
    assert.equal(created.body.utcOffsetMinutes, 480, 'Create reports back the offset it took');

    const snap = await get(port, '/snapshot');
    const cal = snap.body.calendar;
    assert.equal(cal.utcOffsetMinutes, 480, 'the snapshot calendar carries it');

    // The anchor is the LOCAL minute-of-day, negated — so the minute this galaxy's
    // tick 1 reads is the UTC+8 minute-of-day, 480 minutes ahead of the UTC one
    // (mod a day). That is the whole behavioural claim: the offset really did move the
    // day, and the container's own timezone had no say in it.
    const local = minuteOf(1, 1440, cal.dayAnchorTick);
    const shifted = (m) => ((m + 480) % 1440 + 1440) % 1440;
    assert.ok(local === shifted(before) || local === shifted(after),
      `tick 1 reads the UTC+8 minute-of-day, not the UTC one (got ${local})`);

    const health = await get(port, '/health');
    assert.equal(health.body.utcOffsetMinutes, 480, '/health carries it beside serverTime');
    assert.match(health.body.serverTime, /Z$/, 'and serverTime stays a UTC instant');

    // FROZEN: a restart reloads it rather than re-deriving anything.
    child.kill('SIGKILL');
    const port2 = await freePort();
    const second = bootServer({ dir, port: port2 });
    try {
      await waitForHealth(port2);
      const snap2 = await get(port2, '/snapshot');
      assert.equal(snap2.body.calendar.utcOffsetMinutes, 480, 'the reloaded galaxy kept its offset');
      assert.equal(snap2.body.calendar.dayAnchorTick, cal.dayAnchorTick, 'and its anchor');
    } finally { second.child.kill('SIGKILL'); }
  } finally { child.kill('SIGKILL'); }
});

test('an out-of-range or fractional UTC offset is REFUSED, not clamped', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child } = bootServer({ dir, port });
  try {
    await waitForHealth(port);
    for (const bad of [841, -721, 90.5, '480']) {
      const res = await post(port, '/admin/galaxy/new', { seed: 7, utcOffsetMinutes: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} is refused`);
      assert.match(res.body.error, /utcOffsetMinutes/);
    }
    // …and nothing was created by the refusals.
    const health = await get(port, '/health');
    assert.equal(health.body.galaxy, 'no-galaxy', 'a refused create creates nothing');
    assert.equal(health.body.utcOffsetMinutes, null, 'and with no galaxy there is no offset');
  } finally { child.kill('SIGKILL'); }
});

test('omitting the offset is UTC — byte-identical to a pre-offset galaxy', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child } = bootServer({ dir, port });
  try {
    await waitForHealth(port);
    await post(port, '/admin/galaxy/new', { seed: 999 });
    const snap = await get(port, '/snapshot');
    assert.equal(snap.body.calendar.utcOffsetMinutes, 0, 'no offset asked for reads as UTC');
    // The state on disk carries NO offset key at all — that omission is what keeps an
    // unconfigured galaxy's bytes exactly what they were before this slice.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal('utcOffsetMinutes' in onDisk, false, 'and writes no field to the volume');
  } finally { child.kill('SIGKILL'); }
});

test('POST /reset does NOT re-anchor — a reset galaxy runs the unanchored cadence', async () => {
  const dir = tmpDir();
  const port = await freePort();
  const { child } = bootServer({ dir, port });
  try {
    await waitForHealth(port);
    await post(port, '/admin/galaxy/new', { seed: 424242 });
    const created = await get(port, '/snapshot');
    assert.ok(created.body.calendar.dayAnchorTick <= 0);

    await post(port, '/reset');
    const afterReset = await get(port, '/snapshot');
    assert.equal(afterReset.body.calendar.dayAnchorTick, 0,
      'reset rebuilds a plain zero-state — anchoring is Create’s job alone');
    assert.equal(afterReset.body.calendar.utcOffsetMinutes, 0,
      'and the offset goes with the anchor — choosing one is Create’s job too');
  } finally { child.kill('SIGKILL'); }
});
