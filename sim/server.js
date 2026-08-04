'use strict';

// server.js — the thin dev-harness HTTP server for the testbed (slice 2,
// 03-08-26). It holds THE one live state in memory and exposes the engine over
// HTTP so a browser (or curl) can drive it: submit actions, tick manually, watch
// production and galacticSupply move, reset.
//
// WHAT THIS IS NOT: the Phase-2 game server. This is a DEV RIG —
//   - in-memory + ephemeral: a restart returns to the zero-state (there is a
//     Reset endpoint so you don't have to restart to start over);
//   - single shared state, single user, no auth, no persistence;
//   - Postgres is deferred to Phase 2 (design.md §14 keeps Phase 1 in-memory).
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
// Manual tick by design: the galaxy advances ONLY when POST /tick is called.
// Submitting an action (POST /action) applies it to state-as-it-stands but does
// NOT tick — mirroring §15.7's real server, where actions drain continuously and
// the tick advances separately. So you can add a guild, add its ventures, then
// tick once and watch that batch produce.
//
// Endpoints (all JSON; permissive CORS for a local dev rig):
//   GET  /            -> the testbed UI page (client/testbed.html)
//   GET  /health      -> liveness JSON + a one-line summary
//   GET  /snapshot    -> buildSnapshot(state) (the debug lens' data; schema 2)
//   GET  /starters    -> the seed's starter-eligible systems (the home-system
//                        picker's source; static, derived from the seed only)
//   GET  /system/:id  -> one system's static layout: planets, each with its
//                        resource nodes + settlement slots (seed-only; the UI
//                        composes live occupancy from the snapshot on top)
//   POST /tick        -> advance one tick (no actions); returns the new snapshot
//   POST /action      -> intake ONE action object (no tick); returns
//                        { accepted, reason, snapshot }
//   POST /reset       -> back to the zero-state; returns the snapshot
//
// Run:  node sim/server.js   (listens on $PORT, default 7331 — the galaxy seed)

const http = require('node:http');
const fs = require('node:fs');
const { join } = require('node:path');

const { createZeroState } = require('./scenarios/zero-state.js');
const { advance } = require('./run.js');
const { intake } = require('./actions.js');
const { assertInvariants } = require('./invariants.js');
const { buildSnapshot } = require('./snapshot.js');
const { getStarterSystems, getSystemLayout } = require('./seed.js');

const DEFAULT_PORT = 7331; // the galaxy seed number, and clear of the host's other services

// The testbed UI page, served at GET /. Read from disk per request so an HTML
// edit shows up on the next browser refresh (the repo is volume-mounted into the
// container) without a server restart.
const TESTBED_HTML = join(__dirname, '..', 'client', 'testbed.html');

// --- the single live-state holder -----------------------------------------
// One `let`, reached only through get/set. This is the seam Phase 2 replaces:
// swap these two functions for Postgres reads/writes and nothing else in the
// file — or the engine — changes. Keeping it to one holder now is the whole
// discipline; no speculative StateStore abstraction is built.
let liveState = createZeroState();
function getState() { return liveState; }
function setState(s) { liveState = s; }

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

  // GET / -> the testbed UI (HTML). GET /health -> the JSON liveness probe
  // (unchanged, so anything scripted against it keeps working).
  if (method === 'GET' && path === '/') {
    try {
      const html = fs.readFileSync(TESTBED_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: 'could not read client/testbed.html', detail: String(err && err.message || err) });
    }
    return;
  }

  if (method === 'GET' && path === '/health') {
    const s = getState();
    sendJson(res, 200, {
      ok: true,
      service: 'starfare-testbed',
      note: 'dev rig — in-memory, ephemeral, manual tick. NOT the Phase-2 server.',
      tick: s.tick,
      guilds: s.guilds.length,
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

  if (method === 'POST' && path === '/tick') {
    try {
      // advance with no actions = a pure tick (intake nothing, run the economy
      // step, assert). On an invariant violation `advance` throws before
      // returning, so setState is never reached and the live state is untouched.
      const { state: next } = advance(getState(), []);
      setState(next);
      sendJson(res, 200, buildSnapshot(next));
    } catch (err) {
      sendJson(res, 500, { error: 'error on tick (invariant violation or engine throw)', detail: String(err && err.message || err) });
    }
    return;
  }

  if (method === 'POST' && path === '/reset') {
    setState(createZeroState());
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
      // intake applies the action against state-as-it-stands WITHOUT ticking. A
      // rejected action leaves the state unchanged (accepted:false + reason) —
      // that is a normal 200 outcome, not an error. We still assert: for every
      // action defined so far the post-intake state is fully valid, so a
      // violation here would be a real bug, surfaced as a 500 with the live
      // state left on its last good value.
      const { state: next, results } = intake(getState(), [action]);
      assertInvariants(next, next.tick);
      setState(next);
      const r = results[0];
      sendJson(res, 200, { accepted: r.accepted, reason: r.reason || null, snapshot: buildSnapshot(next) });
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

module.exports = { makeServer, getState, setState };

// --- CLI --------------------------------------------------------------------
if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = makeServer();
  server.listen(port, () => {
    console.log(`starfare testbed listening on http://0.0.0.0:${port}`);
    console.log(`  open the UI at http://<host>:${port}/  (GET /health for JSON liveness)`);
    console.log('  API: GET /snapshot   POST /tick   POST /action   POST /reset');
    console.log('  dev rig: in-memory, ephemeral, manual tick — NOT the Phase-2 server');
  });
}
