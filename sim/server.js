'use strict';

// server.js — the thin dev-harness HTTP server for the testbed (slice 2,
// 03-08-26). It holds THE one live state in memory and exposes the engine over
// HTTP so a browser (or curl) can drive it: submit actions, tick manually, watch
// production and galacticSupply move, reset.
//
// WHAT THIS IS NOT: the Phase-2 game server. This is a DEV RIG —
//   - single shared state, single user, no auth;
//   - in-memory by default + ephemeral: a restart returns to the zero-state
//     (there is a Reset endpoint so you don't have to restart to start over);
//   - OPT-IN file-backed durability (set STARFARE_PERSIST_DIR): a state snapshot
//     + action journal so a testbed galaxy survives a restart — the file-backed
//     B+ prototype from docs/persistence-model.md. This is STILL the dev rig, not
//     the Phase-2 server: Postgres, multi-galaxy and auth all stay Phase 2. The
//     durability layer lives in sim/persist.js; this file only WRAPS the loop
//     with it (the pure engine is unmodified — persistence-model.md's premise).
//
// THE RULE THAT KEEPS IT HONEST: this file contains ZERO game logic. Every
// mutation goes through the SAME sim/ the tests and invariants guard —
// `intake` for an action, `advance` for a tick — so there is no second engine
// and no unowned seam. The server is plumbing: read a request, call the engine,
// return a snapshot. If a tick or action ever breaks an invariant, the engine
// throws; the server catches it, leaves the live state on the last good value,
// and returns the violation as a 500 so the tripwire is visible rather than
// crashing the process.
//
// Tick timing by design: submitting an action (POST /action) applies it to
// state-as-it-stands but does NOT tick — mirroring §15.7's real server, where
// actions drain continuously and the tick advances separately. So you can add a
// guild, add its ventures, then advance and watch that batch produce. A tick
// happens two ways, and BOTH go through the one shared `tickOnce()` so there is
// structurally one tick path and "no new game logic" holds by construction:
//   - MANUAL: POST /tick advances exactly one tick (the default drive).
//   - AUTO (optional): a server-side heartbeat (POST /autotick/start) advances a
//     tick every intervalMs, so a running galaxy is watchable without clicking. The
//     SAME heartbeat can be started at BOOT by the operator env var
//     STARFARE_TICK_MS (see the CLI block) so a deployed galaxy turns on its own
//     and the watcher at /inspect stays honestly read-only (client-wiring.md §5).
//     The interval is a PLAYBACK-SPEED knob, not a game/tuning number, and is
//     unrelated to the (deferred) per-hour tick-duration mapping. The heartbeat
//     has no HTTP caller to hand a 500, so if a tick throws it HALTS the timer
//     and records the error rather than firing into a broken state forever
//     (halt-on-trip); POST /reset stops it, zeroes the galaxy, and — when the
//     BOOT clock is configured — starts it again (see bootTickMs below).
//
// Endpoints (all JSON; permissive CORS for a local dev rig):
//   GET  /               -> the PLAYER CLIENT (client/game.html) — the game itself
//   GET  /assets/<path>  -> static art/audio under client/assets/ (read-only)
//   GET  /console        -> the player-facing Production Console (client/console.html)
//   GET  /inspect        -> the OPERATOR watch-only panel (client/inspect.html): a
//                           live poll of the god's-eye snapshot, zero controls
//   GET  /galaxy         -> the committed seed geometry (data/seed.json, served
//                           verbatim) — the one full-galaxy read the client needs
//   GET  /health         -> liveness JSON + a one-line summary + autotick status
//   GET  /snapshot       -> buildSnapshot(state) (the debug lens' data)
//   GET  /starters       -> the seed's starter-eligible systems (the home-system
//                           picker's source; static, derived from the seed only)
//   GET  /system/:id     -> one system's static layout: planets, each with its
//                           resource nodes + settlement slots (seed-only; the UI
//                           composes live occupancy from the snapshot on top)
//   GET  /recipes        -> the refining recipe catalog (rules, not state; feeds
//                           the establish-refinery picker)
//   GET  /goods          -> the good vocabulary by tier (raw, processed); static
//                           rules, buckets the galactic-supply display
//   POST /tick           -> advance one tick (no actions); returns the new snapshot
//   POST /autotick/start -> { intervalMs }: start/replace the heartbeat; returns status
//   POST /autotick/stop  -> stop the heartbeat (idempotent); returns status
//   POST /action         -> intake ONE action object (no tick); returns
//                           { accepted, reason, snapshot }
//   POST /reset          -> back to the zero-state; re-arms the boot clock if one
//                           was configured, so a deployed galaxy keeps turning
//
// Run:  node sim/server.js   (listens on $PORT, default 7331 — the galaxy seed)

const http = require('node:http');
const fs = require('node:fs');
const { join, resolve, sep, extname } = require('node:path');

const { createZeroState } = require('./scenarios/zero-state.js');
const { advance } = require('./run.js');
const { validateAction, applyAction } = require('./actions.js');
const { assertInvariants } = require('./invariants.js');
const { saveState, appendJournal, clearJournal, loadOrInit } = require('./persist.js');
const { buildSnapshot } = require('./snapshot.js');
const { getStarterSystems, getSystemLayout } = require('./seed.js');
const { listRecipes } = require('./recipes.js');
const { RAW_RESOURCES, PROCESSED_GOODS } = require('./resources.js');

const DEFAULT_PORT = 7331; // the galaxy seed number, and clear of the host's other services

// The PLAYER CLIENT, served at GET / (client-wiring.md Slice 1 — this replaced
// the deleted dev testbed as the front door; two doors only, §4: `/` is the game,
// `/inspect` is the operator watcher). Read from disk per request so an HTML edit
// shows up on the next browser refresh (the repo is volume-mounted into the
// container) without a server restart.
const GAME_HTML = join(__dirname, '..', 'client', 'game.html');

// The client's art and audio live under client/assets/ and are referenced by
// relative `assets/...` URLs, so they need a static route. Read-only, and every
// request is resolved and then checked to still sit INSIDE this directory — the
// one place this server touches a caller-supplied path.
const ASSETS_DIR = join(__dirname, '..', 'client', 'assets');

// Content types for what client/assets/ actually holds (jpg, mp3) plus the two
// formats the art pipeline may add next. Anything else is served as an opaque
// download rather than guessed at.
const ASSET_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
};

// The player-facing System Production Console, served at GET /console. Same read-from-
// disk-per-request pattern as the testbed, and — like it — ZERO game logic: it drives
// the SAME live state over the SAME endpoints, only in the player-facing Archive view.
const CONSOLE_HTML = join(__dirname, '..', 'client', 'console.html');

// The OPERATOR watch-only panel, served at GET /inspect. Same read-from-disk-per-
// request pattern as the two pages above. It is god's-eye (it renders every
// guild's real stockpiles and the true galactic supply), so it is deliberately
// UNLINKED from any player surface; for now the whole site sits behind Cloudflare
// Access and real per-viewer filtering is deferred (client-wiring.md §7).
const INSPECT_HTML = join(__dirname, '..', 'client', 'inspect.html');

// The committed seed, served verbatim at GET /galaxy. Read ONCE at module load
// into a buffer and handed out per request: it is ~5.8 MB, completely static, and
// re-reading it per hit would be pure waste. These are the SAME bytes sim/seed.js
// parses, so the map and the per-system detail screens can never disagree on
// geometry (client-wiring.md §6). This is public identity data — the galaxy every
// player sees — NOT god's-eye, so serving it openly is fine.
const SEED_JSON = fs.readFileSync(join(__dirname, '..', 'data', 'seed.json'));

// --- opt-in file-backed durability (dev-rig prototype) ----------------------
// STARFARE_PERSIST_DIR set  → durability ON: boot restores from disk, ticks
//                             snapshot, accepted actions are journalled, reset
//                             and a shutdown hook keep the files honest.
// STARFARE_PERSIST_DIR unset → today's pure in-memory behaviour, byte-for-byte
//                             (existing tests and the default run are unchanged).
// The directory is operator CONFIG (an env var), never a game number. This is
// the file-backed B+ prototype from docs/persistence-model.md — a DEV RIG, not
// the Phase-2 server (Postgres/multi-galaxy/auth all stay Phase 2). Read once at
// module load so the CLI boot and every handler see the same decision.
const persistDir = process.env.STARFARE_PERSIST_DIR || null;

// --- the single live-state holder -----------------------------------------
// One `let`, reached only through get/set. This is the seam Phase 2 replaces:
// swap these two functions for Postgres reads/writes and nothing else in the
// file — or the engine — changes. Keeping it to one holder now is the whole
// discipline; no speculative StateStore abstraction is built.
//
// When persisting, boot RESTORES from disk (loadOrInit = last snapshot + replay
// the journalled actions since it) instead of starting at the zero-state; with
// the flag unset it is exactly the old `createZeroState()` boot.
let liveState = persistDir ? loadOrInit(persistDir, createZeroState) : createZeroState();
function getState() { return liveState; }
function setState(s) { liveState = s; }

// tickOnce() — THE one tick path. Both POST /tick and the heartbeat call this,
// so the server has structurally a single "advance the galaxy one turn" step and
// carries no game logic of its own: it is exactly `advance(getState(), [])`
// (no actions = a pure economy tick) piped back through setState. On an invariant
// violation `advance` throws BEFORE returning, so setState is never reached and
// the live state is left on its last good value. It does NOT catch — each caller
// owns its failure mode (POST /tick → a 500; the heartbeat → halt-on-trip).
function tickOnce() {
  const { state: next } = advance(getState(), []);
  setState(next);
  // Per-tick snapshot cadence (docs/persistence-model.md: default every tick).
  // Both tick paths (POST /tick and the heartbeat) flow through here, so one
  // snapshot point covers both. Only `advance` returning cleanly gets us here —
  // on an invariant violation it throws first and no stale state is saved.
  if (persistDir) saveState(getState(), persistDir);
}

// --- the optional auto-tick heartbeat (server state, NOT game state) --------
// A dev-rig playback clock: when running, it fires tickOnce() every intervalMs so
// a galaxy advances on its own and is watchable. This is SERVER state — it stays
// OUT of the snapshot (which is pure game state, schema unchanged) and is exposed
// only via GET /health. The three fields below are the whole of it.

// DEV-RIG PLUMBING GUARD, not a game/tuning number: a floor on the heartbeat
// interval so a fat-fingered tiny value can't spin the process into a busy loop.
// It bounds playback speed only; it is unrelated to any tick-duration constant
// and does NOT belong in docs/phase-1-tuning.md.
const AUTOTICK_MIN_INTERVAL_MS = 10;

// The interval the OPERATOR configured at boot (STARFARE_TICK_MS), or null when
// none was. Set once by the CLI block below and read by POST /reset, which uses it
// to put the clock back after zeroing — RULING 24-08-26 (client-wiring.md §5): on a
// persistent deployment the galaxy must always turn, so a reset returns a fresh
// RUNNING galaxy, not a frozen one. This revises the earlier "reset stops the
// heartbeat" rule: reset still stops-then-zeroes (nothing fires mid-wipe), and only
// then re-arms. With no boot clock configured, reset leaves it off exactly as before,
// so the manual dev-rig flow (reset → deploy at tick 0 → start by hand) is unchanged.
let bootTickMs = null;

let autotickTimer = null;        // the setInterval handle, or null when stopped
let autotickIntervalMs = null;   // the interval it is (was) running at, or null
let autotickLastError = null;    // { message, tick } of the last halt-on-trip, or null

// The status surfaced on GET /health and returned by the autotick endpoints.
function getAutotickStatus() {
  return {
    running: autotickTimer !== null,
    intervalMs: autotickIntervalMs,
    lastError: autotickLastError,
  };
}

// Stop the heartbeat. Idempotent (stop-when-stopped is a no-op) and used by the
// stop endpoint, by reset, and by halt-on-trip. Leaves lastError untouched so a
// halt's cause survives for the operator to read; a fresh start clears it.
function stopAutotick() {
  if (autotickTimer !== null) {
    clearInterval(autotickTimer);
    autotickTimer = null;
  }
  autotickIntervalMs = null;
}

// One heartbeat fire: tick, and HALT-ON-TRIP if it throws. There is no HTTP
// caller here to return a 500 to, so we must not keep firing into a broken state
// every interval. `advance` threw before setState (tickOnce contract), so the
// last good state is still live — exactly the POST /tick contract. We stop the
// timer, record the error and the (last-good) tick it is now stuck on, and log it.
function autotickFire() {
  try {
    tickOnce();
  } catch (err) {
    const tickStuckOn = getState().tick;
    stopAutotick();
    autotickLastError = { message: String((err && err.message) || err), tick: tickStuckOn };
    console.error(`autotick HALTED on trip (stuck at tick ${tickStuckOn}): ${autotickLastError.message}`);
  }
}

// Start (or replace) the heartbeat at intervalMs. Replacing lets you change speed
// live: an already-running timer is cleared first, so there is never more than one.
// The timer is unref()'d so it can never by itself wedge the process from exiting.
// Assumes intervalMs was validated by the caller (a positive int >= the floor).
function startAutotick(intervalMs) {
  stopAutotick();                 // replace any running timer (change speed live)
  autotickLastError = null;       // a fresh start is a clean slate
  autotickIntervalMs = intervalMs;
  autotickTimer = setInterval(autotickFire, intervalMs);
  autotickTimer.unref();          // never keep the process alive on the heartbeat alone
}

// Test-only introspection: the raw timer handle (or null), so a test can assert
// the timer ends stopped and is unref'd (Timeout#hasRef()). Not used at runtime.
function _getAutotickTimer() { return autotickTimer; }

// --- tiny HTTP helpers ------------------------------------------------------

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Dev-rig CORS: this is an ephemeral local testbed on a trusted host, so a
    // page served from anywhere (incl. file://) may drive it. Not a production
    // stance — the real server will scope origins.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { // 1 MB guard against a runaway body
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// --- request handling -------------------------------------------------------

async function handleRequest(req, res) {
  const method = req.method;
  const path = (req.url || '/').split('?')[0];

  // CORS preflight.
  if (method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  // GET / -> the PLAYER CLIENT (HTML). GET /health -> the JSON liveness probe
  // (unchanged, so anything scripted against it keeps working).
  if (method === 'GET' && path === '/') {
    try {
      const html = fs.readFileSync(GAME_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: 'could not read client/game.html', detail: String(err && err.message || err) });
    }
    return;
  }

  // GET /assets/<path> -> a file under client/assets/, read-only. The path comes
  // from the caller, so it is decoded, resolved, and then checked to still start
  // with ASSETS_DIR + separator: a `..` segment or an absolute path fails that
  // check and gets a 403 rather than a file. The same check runs again on the
  // REAL path (symlinks followed), so a link inside the tree cannot point out of
  // it either. (`path` here is already the URL minus its query string.)
  if (method === 'GET' && path.startsWith('/assets/')) {
    let rel;
    try {
      rel = decodeURIComponent(path.slice('/assets/'.length));
    } catch {
      sendJson(res, 400, { error: 'malformed asset path' });
      return;
    }
    const full = resolve(ASSETS_DIR, rel);
    if (full !== ASSETS_DIR && !full.startsWith(ASSETS_DIR + sep)) {
      sendJson(res, 403, { error: 'asset path escapes client/assets/' });
      return;
    }
    let real;
    let body;
    try {
      real = fs.realpathSync(full);          // resolve symlinks before trusting the prefix
      if (!real.startsWith(ASSETS_DIR + sep)) throw new Error('escapes client/assets/');
      body = fs.readFileSync(real);
    } catch {
      sendJson(res, 404, { error: `no such asset: ${rel}` });
      return;
    }
    const type = ASSET_TYPES[extname(real).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
    return;
  }

  // GET /console -> the player-facing System Production Console (HTML), served exactly
  // like GET / above. Harness route only — no game logic; it reads the same snapshot.
  if (method === 'GET' && path === '/console') {
    try {
      const html = fs.readFileSync(CONSOLE_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: 'could not read client/console.html', detail: String(err && err.message || err) });
    }
    return;
  }

  // GET /inspect -> the operator watch-only panel (HTML), served exactly like
  // GET /console above. Watch-only is a property of the PAGE (it has no controls
  // that POST anything); the server does not enforce it, and a tripwire in
  // sim/tests/server.test.js asserts the served bytes carry no action route.
  if (method === 'GET' && path === '/inspect') {
    try {
      const html = fs.readFileSync(INSPECT_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: 'could not read client/inspect.html', detail: String(err && err.message || err) });
    }
    return;
  }

  // The committed seed geometry, verbatim. SEED data, not live state — it never
  // moves on a tick — so it is served from the buffer read at boot, unreshaped and
  // unfiltered. The client composes live occupancy from the snapshot on top of it,
  // exactly as it already does for /system/:id.
  if (method === 'GET' && path === '/galaxy') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(SEED_JSON);
    return;
  }

  if (method === 'GET' && path === '/health') {
    const s = getState();
    sendJson(res, 200, {
      ok: true,
      service: 'starfare-testbed',
      note: 'dev rig — in-memory, ephemeral, optional auto-tick. NOT the Phase-2 server.',
      tick: s.tick,
      guilds: s.guilds.length,
      // SERVER state, not game state — deliberately here and NOT in the snapshot.
      autotick: getAutotickStatus(),
    });
    return;
  }

  if (method === 'GET' && path === '/snapshot') {
    sendJson(res, 200, buildSnapshot(getState()));
    return;
  }

  // The seed's starter-eligible systems, for the UI's home-system picker. This
  // is a property of the SEED, not of live state — it never changes with the
  // galaxy's tick — so it reads straight from the seed selector and is safe to
  // fetch once on page load. It stays here (not in buildSnapshot) precisely
  // because it is state-independent: the snapshot is the moving galaxy; this is
  // the fixed menu of places a guild may start.
  if (method === 'GET' && path === '/starters') {
    const starters = getStarterSystems();
    sendJson(res, 200, { starters, count: starters.length });
    return;
  }

  // One system's static territory layout (planets -> resource nodes + settlement
  // slots), for the UI to drill into. Like /starters this is SEED data, not live
  // state, so it never moves on a tick and the browser can cache it per system;
  // the live overlay (who occupies which site) is composed from the snapshot's
  // occupancy client-side. An unknown id is a 404 (the selector returns null).
  if (method === 'GET' && path.startsWith('/system/')) {
    const id = decodeURIComponent(path.slice('/system/'.length));
    if (!id) {
      sendJson(res, 400, { error: 'GET /system/:id requires a system id, e.g. /system/sys_0002' });
      return;
    }
    const layout = getSystemLayout(id);
    if (!layout) {
      sendJson(res, 404, { error: `no such system: ${id}` });
      return;
    }
    sendJson(res, 200, layout);
    return;
  }

  // The refining recipe catalog — RULES, not live state (sim/recipes.js is the
  // one source of truth for "what conversions exist"). Read-only and static, so
  // the UI fetches it once to populate the establish-refinery picker; changing a
  // recipe means editing recipes.js + restarting, never a live mutation here.
  if (method === 'GET' && path === '/recipes') {
    sendJson(res, 200, { recipes: listRecipes() });
    return;
  }

  // The good vocabulary, categorized (RULES, not state; from resources.js).
  // Static and read-only, so the UI fetches it once to bucket the flat
  // galactic-supply totals into manufacturing-tree tiers. Manufactured Parts and
  // Constructed Assets are future tiers with no goods yet, so they aren't here —
  // the UI renders them as empty placeholders.
  if (method === 'GET' && path === '/goods') {
    sendJson(res, 200, { raw: RAW_RESOURCES, processed: PROCESSED_GOODS });
    return;
  }

  if (method === 'POST' && path === '/tick') {
    try {
      // The SAME shared tick path the heartbeat uses (tickOnce = advance-no-actions
      // → setState). On an invariant violation `advance` throws before setState, so
      // the live state is untouched and we surface the violation as a 500.
      tickOnce();
      sendJson(res, 200, buildSnapshot(getState()));
    } catch (err) {
      sendJson(res, 500, { error: 'error on tick (invariant violation or engine throw)', detail: String(err && err.message || err) });
    }
    return;
  }

  // Start (or replace) the auto-tick heartbeat. Body: { intervalMs }. intervalMs
  // must be a positive integer at or above the dev-rig busy-loop floor; anything
  // else is a 400 (a plumbing guard, not a game rule). Start-while-running clears
  // and replaces the timer, so you can change playback speed live.
  if (method === 'POST' && path === '/autotick/start') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { error: 'request body must be valid JSON, e.g. {"intervalMs":1000}' });
      return;
    }
    const intervalMs = body && body.intervalMs;
    if (!Number.isInteger(intervalMs) || intervalMs < AUTOTICK_MIN_INTERVAL_MS) {
      sendJson(res, 400, { error: `intervalMs must be an integer >= ${AUTOTICK_MIN_INTERVAL_MS} (ms)` });
      return;
    }
    startAutotick(intervalMs);
    sendJson(res, 200, { autotick: getAutotickStatus() });
    return;
  }

  // Stop the heartbeat. Idempotent — stop-when-stopped is a 200 no-op.
  if (method === 'POST' && path === '/autotick/stop') {
    stopAutotick();
    sendJson(res, 200, { autotick: getAutotickStatus() });
    return;
  }

  if (method === 'POST' && path === '/reset') {
    // Stop the clock BEFORE zeroing the galaxy, so the heartbeat isn't firing
    // while the operator re-deploys (reset → deploy → set windowN + commitments
    // at tick 0 → then start). A fresh galaxy also clears a prior halt's error.
    stopAutotick();
    autotickLastError = null;
    setState(createZeroState());
    // Reset the durable files alongside the in-memory galaxy: the old journal
    // describes a world that no longer exists, so it must not replay on the next
    // boot. Clear it, then write a fresh zero-state snapshot so disk and memory
    // agree from tick 0.
    if (persistDir) {
      clearJournal(persistDir);
      saveState(getState(), persistDir);
    }
    // Put the clock back, if the operator configured one at boot: a deployed galaxy
    // is never left frozen by a reset (the ruling above). Same startAutotick() the
    // endpoint and the boot block call — one tick path, no new game logic.
    if (bootTickMs !== null) startAutotick(bootTickMs);
    sendJson(res, 200, buildSnapshot(getState()));
    return;
  }

  if (method === 'POST' && path === '/action') {
    let action;
    try {
      const raw = await readBody(req);
      action = JSON.parse(raw || 'null');
    } catch {
      sendJson(res, 400, { error: 'request body must be a valid JSON action object' });
      return;
    }
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      sendJson(res, 400, { error: 'request body must be a single JSON action object (e.g. {"type":"foundGuild", ...})' });
      return;
    }
    try {
      // Apply ONE action against state-as-it-stands WITHOUT ticking, in the
      // write-ahead order the durability model needs: validate FIRST, then (when
      // persisting) journal the accepted action BEFORE applying it, so the journal
      // only ever holds actions that took effect and always records them before
      // the effect — a crash between the append and the apply loses nothing (the
      // entry replays on restart). A rejected action leaves the state unchanged
      // (accepted:false + reason) and is NOT journalled — that is a normal 200
      // outcome, not an error. This is exactly intake's single-action semantics,
      // spelled out here so the append lands between validate and apply.
      const before = getState();
      const { valid, reason } = validateAction(before, action);
      let next = before;
      if (valid) {
        // `tick` = state.tick at apply time (applyAction never advances it).
        if (persistDir) appendJournal(before.tick, action, persistDir);
        next = applyAction(before, action);
      }
      // We still assert: for every action defined so far the post-apply state is
      // fully valid, so a violation here would be a real bug, surfaced as a 500
      // with the live state left on its last good value. (For a rejected action
      // next === before, already-valid live state.)
      assertInvariants(next, next.tick);
      setState(next);
      sendJson(res, 200, { accepted: valid, reason: valid ? null : reason, snapshot: buildSnapshot(next) });
    } catch (err) {
      sendJson(res, 500, { error: 'error applying action (invariant violation or engine throw)', detail: String(err && err.message || err) });
    }
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

// makeServer() -> an http.Server not yet listening. Exported so a test can bind
// it to an ephemeral port; the CLI below binds it to $PORT.
function makeServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { error: 'unhandled server error', detail: String(err && err.message || err) });
    });
  });
}

module.exports = {
  makeServer, getState, setState,
  tickOnce, startAutotick, stopAutotick, getAutotickStatus, _getAutotickTimer,
};

// --- CLI --------------------------------------------------------------------
if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = makeServer();

  // Graceful-shutdown hook (only when persisting): on a deploy/reboot signal,
  // save the live state then exit, so a clean stop never depends on the last
  // per-tick snapshot. A HARD crash (kill -9, power loss) runs no hook — that is
  // exactly what the journal-replay path recovers on the next boot. Registered
  // only under the flag so the pure in-memory run adds no process listeners.
  if (persistDir) {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return; // a second signal shouldn't double-save/exit
      shuttingDown = true;
      console.log(`[persist] ${signal} — saving state before exit`);
      try {
        // Save the authoritative live state, THEN clear the journal — order and
        // both steps matter. Unlike the per-tick snapshot (always taken right
        // after `advance`, at a tick BOUNDARY, before any same-tick action is
        // applied), this shutdown snapshot is taken MID-INTERVAL: it already
        // contains this tick's actions, which are still tagged with the current
        // tick in the journal. loadOrInit's replay filter (tick >= loadedTick)
        // would re-apply exactly those and HALT on boot, so the journal must not
        // survive a clean save. Clearing it makes the snapshot solely
        // authoritative — the same reason /reset clears it.
        //
        // deferred: harden — a crash BETWEEN the save and the clear leaves the
        // fresh snapshot next to a stale same-tick journal, which boots to a loud
        // REPLAY HALT (never a silent double-apply). Rare and loud-not-silent; a
        // fully atomic save+clear is a later hardening, unneeded for the dev rig.
        saveState(getState(), persistDir);
        clearJournal(persistDir);
      } catch (err) {
        console.error(`[persist] shutdown save FAILED: ${String((err && err.message) || err)}`);
      }
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // --- the clock starts itself (client-wiring.md §5) ------------------------
  // STARFARE_TICK_MS set   -> the EXISTING heartbeat starts on boot at that
  //                           interval, so a deployed galaxy turns on its own and
  //                           nobody has to press anything to make time pass.
  // STARFARE_TICK_MS unset -> today's behaviour byte-for-byte: no heartbeat (the
  //                           opt-in shape STARFARE_PERSIST_DIR already uses).
  // This is OPERATOR CONFIG — playback speed — not a game/tuning number, so there
  // is deliberately NO default: unset means off, and an unusable value is a loud
  // boot failure rather than a guess. The validation is exactly the endpoint's
  // (an integer at or above the busy-loop floor); a bad value exits non-zero here,
  // before the port is bound, so a broken clock can never be left running.
  const rawTickMs = process.env.STARFARE_TICK_MS;
  if (rawTickMs !== undefined && rawTickMs !== '') {
    const parsed = Number(rawTickMs);
    if (!Number.isInteger(parsed) || parsed < AUTOTICK_MIN_INTERVAL_MS) {
      console.error(`[clock] STARFARE_TICK_MS must be an integer >= ${AUTOTICK_MIN_INTERVAL_MS} (ms); got ${JSON.stringify(rawTickMs)}`);
      process.exit(1);
    }
    bootTickMs = parsed;   // module-scoped: POST /reset re-arms from it
  }

  server.listen(port, () => {
    console.log(`starfare testbed listening on http://0.0.0.0:${port}`);
    console.log(`  the game is at http://<host>:${port}/  (operator watcher: /inspect; GET /health for JSON liveness)`);
    console.log('  API: GET /snapshot   POST /tick   POST /action   POST /reset');
    console.log('  auto-tick: POST /autotick/start {intervalMs}   POST /autotick/stop   (status on GET /health)');
    if (persistDir) {
      console.log(`  durability: ON — file-backed state+journal in ${persistDir} (dev-rig B+ prototype)`);
    } else {
      console.log('  durability: OFF — in-memory, ephemeral (set STARFARE_PERSIST_DIR to enable)');
    }
    // Start the clock only once the server is actually listening, so the galaxy
    // never advances before anything can read it. Same startAutotick() the endpoint
    // calls — one tick path, no new game logic.
    if (bootTickMs !== null) {
      startAutotick(bootTickMs);
      console.log(`[clock] ON — auto-tick every ${bootTickMs} ms (STARFARE_TICK_MS); the galaxy turns on its own`);
    } else {
      console.log('[clock] OFF — no heartbeat (set STARFARE_TICK_MS to an interval in ms to start one on boot)');
    }
    console.log('  dev rig: optional auto-tick, opt-in durability — NOT the Phase-2 server');
  });
}
