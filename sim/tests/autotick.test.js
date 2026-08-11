'use strict';

// Tests the auto-tick heartbeat (Phase 1 Stage 2, 11-08-26) at the MODULE level,
// driving server.js's exported tick path and timer controls directly (the HTTP
// endpoints are tripwired separately in server.test.js). node:test runs each file
// in its own process, so this file's module-level live state + timers are isolated.
//
// The whole point of the heartbeat is that it adds NO game logic: it only calls
// the same shared tickOnce() that POST /tick calls. These tests prove that two
// ways — a timing-free equivalence, and a real-timer wiring run — plus the two
// server-state rules the heartbeat introduces: halt-on-trip and a clean stop.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getState, setState,
  tickOnce, startAutotick, stopAutotick, getAutotickStatus, _getAutotickTimer,
} = require('../server.js');
const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { hashState } = require('../serialize.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small but comfortably-above-floor interval for the timing tests.
const AUTOTICK_TEST_INTERVAL = 10;

// --- (a) DETERMINISM / NO-OP: the fire path is a pure re-tick ---------------
// tickOnce() N times from a seed must be byte-identical to N advance()s from the
// same seed. This proves the heartbeat's fire path adds no logic — it IS advance.

test('N tickOnce() calls equal N manual advance()s from the same seed (byte-identical)', () => {
  const N = 12;

  // The heartbeat path: seed the live state, then fire tickOnce N times.
  setState(createZeroState());
  for (let i = 0; i < N; i += 1) tickOnce();
  const viaHeartbeat = hashState(getState());

  // The manual path: N plain advance()s from an independent seed.
  let s = createZeroState();
  for (let i = 0; i < N; i += 1) s = advance(s).state;
  const viaManual = hashState(s);

  assert.equal(viaHeartbeat, viaManual);
  assert.equal(getState().tick, N);
});

// --- (b) REAL-TIMER WIRING: whatever T fires, T manual ticks match ----------
// Start a fast heartbeat, let some fires happen, stop it, read the tick T it
// actually reached, and assert T manual advance()s are byte-identical. The exact
// fire count is timing-dependent, so we assert equivalence for the ACTUAL T, not
// a fixed number. The timer must end stopped, and must have been unref'd.

test('the running heartbeat advances real ticks equivalent to T manual advances; ends stopped + unref\'d', async () => {
  setState(createZeroState());

  startAutotick(AUTOTICK_TEST_INTERVAL);
  // While running, the timer must be unref'd so it can never wedge the process.
  const handle = _getAutotickTimer();
  assert.ok(handle, 'a timer handle exists while running');
  assert.equal(handle.hasRef(), false, 'the heartbeat timer must be unref\'d');
  assert.equal(getAutotickStatus().running, true);

  await sleep(120);           // let several fires happen (count is timing-dependent)
  stopAutotick();

  const T = getState().tick;
  assert.ok(T >= 1, `expected at least one fire, got tick ${T}`);

  // The timer ends stopped.
  assert.equal(_getAutotickTimer(), null, 'timer handle is null after stop');
  assert.equal(getAutotickStatus().running, false);

  // Whatever T occurred, T manual advances from the same seed match byte-for-byte.
  let s = createZeroState();
  for (let i = 0; i < T; i += 1) s = advance(s).state;
  assert.equal(hashState(getState()), hashState(s), 'heartbeat-run state == T manual advances');
});

// --- HALT-ON-TRIP: a throw inside the loop stops the timer and records it ----
// Fault-injected: seed a state that passes intake (no actions) but breaks an
// invariant on the tick — advance() throws, so tickOnce() throws. The heartbeat
// must STOP and record lastError { message, tick } instead of re-firing forever,
// leaving the last good state live (advance threw before setState).

test('halt-on-trip: a tick that throws stops the timer and records lastError, last good state stays live', async () => {
  // A hand-built broken state (mirrors run.test.js): guild credits negative, but
  // the credit TOTAL is still 0, so ONLY the non-negativity invariant trips — a
  // clean, deterministic throw on the tick.
  const broken = {
    tick: 7,
    guilds: [{ id: 'g1', credits: -1, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 1 },
    world: { nodes: [] },
    claims: [],
    shipments: [],
    audit: { totalProduced: 0, totalConsumed: 0, expectedCreditTotal: 0 },
  };
  setState(broken);

  startAutotick(AUTOTICK_TEST_INTERVAL);
  await sleep(60);            // give the timer several chances to (wrongly) re-fire

  const status = getAutotickStatus();
  assert.equal(status.running, false, 'the heartbeat must halt, not keep firing');
  assert.equal(_getAutotickTimer(), null, 'the timer is cleared on trip');
  assert.ok(status.lastError, 'a lastError is recorded');
  assert.match(status.lastError.message, /Invariant violation/);
  assert.equal(status.lastError.tick, 7, 'records the last-good tick it is stuck on');

  // The live state is untouched — advance() threw before setState, so the last
  // good state (the broken seed at tick 7) is exactly what stayed live.
  assert.equal(getState().tick, 7);

  // A fresh start clears the prior halt's error.
  setState(createZeroState());
  startAutotick(AUTOTICK_TEST_INTERVAL);
  assert.equal(getAutotickStatus().lastError, null, 'a fresh start clears lastError');
  stopAutotick();
});

// --- start-while-running REPLACES the timer (change speed live) --------------

test('starting while running replaces the interval (one timer, new speed)', () => {
  setState(createZeroState());
  startAutotick(20);
  const first = _getAutotickTimer();
  assert.equal(getAutotickStatus().intervalMs, 20);

  startAutotick(50);
  const second = _getAutotickTimer();
  assert.notEqual(first, second, 'the old timer was replaced, not left running alongside');
  assert.equal(getAutotickStatus().intervalMs, 50);
  assert.equal(getAutotickStatus().running, true);

  stopAutotick();
  assert.equal(getAutotickStatus().running, false);
});

// --- stop is idempotent ------------------------------------------------------

test('stopAutotick is idempotent (stop-when-stopped is a no-op)', () => {
  stopAutotick(); // already stopped
  assert.equal(getAutotickStatus().running, false);
  assert.equal(_getAutotickTimer(), null);
});
