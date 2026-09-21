'use strict';

// tools/admin.js — the OPERATOR CLI. A thin HTTP client over the running
// server's existing endpoints, so the recurring ops/verification chores are
// plain, labelled shell commands in the repo instead of a console blob pasted
// into a chat message.
//
// WHAT IT IS NOT: it is not the engine and it holds no game logic. Every number
// it prints is read back from the server; the two figures `verify-cycle`
// asserts on (7,200 units and a 1,440-tick window) are quoted engine truth
// (docs/cycle-and-calendar.md §1, sim/tests/cycle-length.test.js), NOT values
// this file authors. It calls only routes sim/server.js already serves and adds
// none.
//
// Dependency-free on purpose (plain Node + global `fetch`), so it runs in the
// stock node:22-alpine image with nothing installed:
//
//   docker exec starfare node tools/admin.js verify-cycle
//   node tools/admin.js snapshot --pick calendar --base http://localhost:7331
//
// Exit 0 on success, 1 on failure — including a refused action ({accepted:false})
// — so it is scriptable and CI-able.
//
// The pure logic lives at the top and is exported for tools/admin.test.js; the
// HTTP orchestration below it is a deliberately thin, unit-untested shell.

// ---------------------------------------------------------------------------
// Pure logic (exported; unit-tested in tools/admin.test.js)
// ---------------------------------------------------------------------------

// Every flag the CLI accepts, and what kind of value it carries. One global
// table rather than per-command tables: the surface is small, and an unknown
// flag should fail the same way whichever command it followed.
const FLAG_SPEC = Object.freeze({
  base: 'string',   // which server to talk to
  seed: 'int',      // new-galaxy / verify-cycle: name the galaxy
  pick: 'string',   // snapshot: extract one dotted path
  window: 'int',    // seat-demo: short-cycle test galaxy via setWindowN
  'utc-offset': 'number', // new-galaxy: which midnight the cycle rolls on, in HOURS
  json: 'bool',     // snapshot: dump the whole thing
  // The operator adjust levers (docs/operator-adjust.md §5).
  guild: 'string',    // which guild the adjust acts on
  delta: 'int',       // signed integer: a grant (+) or remove (−) for the scalar levers
  system: 'string',   // adjust-goods / grant-asset: which system's cell / where to mint
  good: 'string',     // adjust-goods: which stockpile good
  kind: 'string',     // grant-asset: miner | factory
  asset: 'string',    // remove-asset: which asset id
  venture: 'string',  // remove-venture: which venture id
  close: 'bool',      // remove-asset: tear the venture down (else detach)
  'remove-asset': 'bool', // remove-venture: delete the freed asset too (else keep it idle)
  // The vehicle spawn/remove primitive (design.md §15.4, roadmap 2.2 spawn).
  class: 'string',    // spawn-vehicle: lightTransport | mediumTransport | heavyTransport | spycraft
  outpost: 'string',  // spawn-vehicle: berth at an outpost landmark
  hex: 'string',      // spawn-vehicle: berth at a bare hex, "q,r"
  condition: 'number', // spawn-vehicle: starting maintenanceCondition fraction (default 1)
  id: 'string',       // remove-vehicle / dispatch-vehicle / transfer-cargo: which vehicle id
  waypoints: 'string', // dispatch-vehicle: "w;w;…", each sys:<id> | out:<id> | q,r
  load: 'string',     // transfer-cargo: "good:qty|max,…" to load pool -> hold
  unload: 'string',   // transfer-cargo: "good:qty|max,…" to unload hold -> pool
  help: 'bool',
});

// parseArgs(argv) -> { command, flags }, where argv is process.argv.slice(2).
// Positional leftovers land in `flags._` (only `tick [n]` uses one). Flags may
// appear before or after the command, and as `--flag value` or `--flag=value`.
// An unknown flag, a missing value, or a non-integer where an integer is
// required THROWS — a typo'd operator command must not run a different one.
function parseArgs(argv) {
  const flags = { _: [] };
  let command = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h') { flags.help = true; continue; }
    if (typeof token === 'string' && token.startsWith('--')) {
      let name = token.slice(2);
      let inline = null;
      const eq = name.indexOf('=');
      if (eq !== -1) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
      const kind = FLAG_SPEC[name];
      if (!kind) {
        const known = Object.keys(FLAG_SPEC).map((f) => `--${f}`).join(', ');
        throw new Error(`unknown flag --${name} (known flags: ${known})`);
      }
      if (kind === 'bool') {
        if (inline !== null) throw new Error(`--${name} takes no value`);
        flags[name] = true;
        continue;
      }
      const raw = inline !== null ? inline : argv[i + 1];
      if (inline === null) i += 1;
      if (raw === undefined) throw new Error(`--${name} needs a value`);
      if (kind === 'int') {
        const n = Number(raw);
        if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer, got ${JSON.stringify(raw)}`);
        flags[name] = n;
      } else if (kind === 'number') {
        // A fractional value is legitimate here and only here: half-hour and
        // quarter-hour timezones are real (+5.5, +5.75), so `--utc-offset` cannot be
        // an int. Still refuses anything that is not a finite number.
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
        flags[name] = n;
      } else {
        flags[name] = raw;
      }
      continue;
    }
    if (command === null) command = token; else flags._.push(token);
  }
  return { command, flags };
}

// utcOffsetMinutesFromHours(hours) -> the galaxy's `utcOffsetMinutes`, or THROWS.
// The operator says '+8' or '+5.5'; the wire and the engine speak whole minutes
// (docs/cycle-and-calendar.md §2). Fractions that are not a whole number of minutes,
// and anything outside UTC-12:00 .. UTC+14:00, are refused rather than rounded: a
// galaxy is anchored ONCE, so a typo here is not correctable afterwards.
function utcOffsetMinutesFromHours(hours) {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    throw new Error(`--utc-offset must be a number of hours, got ${JSON.stringify(hours)}`);
  }
  const exact = hours * 60;
  const minutes = Math.round(exact);
  // Floating point: 5.5 * 60 is exactly 330, but 0.1 * 60 is 6.000000000000001, so the
  // comparison is against a tolerance rather than ===.
  if (Math.abs(exact - minutes) > 1e-6) {
    throw new Error(`--utc-offset ${hours} is not a whole number of minutes`);
  }
  if (minutes < -720 || minutes > 840) {
    throw new Error(`--utc-offset ${hours} is outside UTC-12:00 .. UTC+14:00`);
  }
  return minutes;
}

// pick(obj, 'a.b.c') -> the value at that dotted path, or undefined if any step
// is missing. Used by `snapshot --pick` so an operator can pull one block out of
// a 3 MB snapshot without piping it through another tool.
function pick(obj, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// findResourceNodes(layouts, resourceType, limit) -> every { systemId, nodeId }
// in the given GET /system/:id layouts whose node carries that good, in the
// seed's own deterministic order (so the same galaxy always seats the same way).
// `layouts` is an array of getSystemLayout objects: { id, planets: [{ resourceNodes:
// [{ id, resourceType }] }] }.
function findResourceNodes(layouts, resourceType, limit = Infinity) {
  const out = [];
  for (const layout of layouts || []) {
    if (!layout || !Array.isArray(layout.planets)) continue;
    for (const planet of layout.planets) {
      const nodes = (planet && planet.resourceNodes) || [];
      for (const node of nodes) {
        if (node && node.resourceType === resourceType) {
          out.push({ systemId: layout.id, nodeId: node.id });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

// pickResourceNode(layouts, resourceType) -> the FIRST matching
// { systemId, nodeId }, or null when the layouts hold none of that good.
function pickResourceNode(layouts, resourceType) {
  const found = findResourceNodes(layouts, resourceType, 1);
  return found.length > 0 ? found[0] : null;
}

// The two figures verify-cycle asserts on. NEITHER is authored here: 7,200 is
// the engine's own 100%-titanium commitment over one 1,440-tick day (5/tick ×
// 1,440 — sim/tests/cycle-length.test.js), and 1,440 is the ruled cycle length
// (docs/cycle-and-calendar.md §1). They are written down as EXPECTATIONS so a
// container running older code fails loudly instead of quietly.
const EXPECTED_COMMITMENT = 7200;
const EXPECTED_WINDOW_N = 1440;

// judgeVerify({ venture, calendar }) -> { pass, checks: [{ name, ok, detail }] }.
// The load-bearing tripwire: `verify-cycle`'s exit code is `pass`. It is pure —
// it reads back what the server said and judges it, computing nothing.
//
// On the anchor: the snapshot always emits an INTEGER `dayAnchorTick` (a galaxy
// with none defaults to 0, which is the legitimate value for one created exactly
// at midnight), so the check is "present and an integer", not "negative". A null
// or missing anchor means the calendar layer is not live on that server.
function judgeVerify({ venture, calendar } = {}) {
  const v = venture || null;
  const c = calendar || null;
  const commitment = v ? v.syndicateCommitment : undefined;
  const windowN = c ? c.windowN : undefined;
  const anchor = c ? c.dayAnchorTick : undefined;
  const checks = [
    {
      name: `venture.syndicateCommitment === ${EXPECTED_COMMITMENT}`,
      ok: commitment === EXPECTED_COMMITMENT,
      detail: v ? `read back ${JSON.stringify(commitment)}` : 'no venture read back from the snapshot',
    },
    {
      name: `calendar.windowN === ${EXPECTED_WINDOW_N}`,
      ok: windowN === EXPECTED_WINDOW_N,
      detail: c ? `read back ${JSON.stringify(windowN)}` : 'no calendar block in the snapshot',
    },
    {
      name: 'calendar.dayAnchorTick present',
      ok: Number.isInteger(anchor),
      detail: Number.isInteger(anchor)
        ? `read back ${anchor}`
        : `read back ${JSON.stringify(anchor)} — this galaxy is not midnight-anchored`,
    },
  ];
  return { pass: checks.every((k) => k.ok), checks };
}

// The lowest idle asset of `kind` in a guild's inventory, read straight off the
// snapshot the server just handed back. Deploying now NAMES its machine (design.md
// §4, 31-08-26), so this CLI has to CHOOSE one — and it chooses from the engine's own
// deployed-vs-idle answer (`deployedToVentureId`), deriving nothing itself. Lowest id
// keeps a scripted seat-demo run reproducible.
function pickIdleAssetId(snap, guildId, kind) {
  const guild = (snap.guilds || []).find((g) => g.id === guildId);
  const idle = ((guild && guild.assets) || [])
    .filter((a) => a.kind === kind && a.deployedToVentureId == null)
    .map((a) => a.id)
    .sort();
  if (!idle.length) throw new Error(`guild ${guildId} holds no idle ${kind} to deploy — every one it owns is already on a site`);
  return idle[0];
}

// The six operator adjust subcommands (docs/operator-adjust.md §5) and the engine
// action each posts. One command per action, so the CLI surface mirrors the six levers
// exactly. The scalar levers take a SIGNED `--delta` (positive grants, negative removes),
// so `adjust-credits`/`adjust-fuel`/`adjust-goods` each cover both directions.
const ADJUST_COMMANDS = Object.freeze([
  'adjust-credits', 'adjust-fuel', 'adjust-goods', 'grant-asset', 'remove-asset', 'remove-venture',
]);

// requireFlag(flags, name, command) -> the flag's value, or THROWS. A missing required
// flag must fail the command, never post a half-formed action (the parseArgs discipline).
function requireFlag(flags, name, command) {
  const v = flags[name];
  if (v === undefined) throw new Error(`${command}: --${name} is required`);
  return v;
}

// adjustActionFor(command, flags) -> the exact { type, ... } action object POST /action
// validates for that subcommand. PURE and exported so tools/admin.test.js can assert each
// command builds the right action without a server — this file authors no game number (a
// delta is the operator's; the conserving counter-move is the engine's, docs/operator-
// adjust.md §2). Boolean flags pick the two-valued modes: --close -> occupied 'close'
// (else 'detach'); --remove-asset -> asset 'remove' (else 'keep').
function adjustActionFor(command, flags) {
  switch (command) {
    case 'adjust-credits':
      return { type: 'adjustCredits', guildId: requireFlag(flags, 'guild', command), delta: requireFlag(flags, 'delta', command) };
    case 'adjust-fuel':
      return { type: 'adjustFuel', guildId: requireFlag(flags, 'guild', command), delta: requireFlag(flags, 'delta', command) };
    case 'adjust-goods':
      return {
        type: 'adjustGoods',
        guildId: requireFlag(flags, 'guild', command),
        systemId: requireFlag(flags, 'system', command),
        good: requireFlag(flags, 'good', command),
        delta: requireFlag(flags, 'delta', command),
      };
    case 'grant-asset':
      return {
        type: 'grantAsset',
        guildId: requireFlag(flags, 'guild', command),
        kind: requireFlag(flags, 'kind', command),
        systemId: requireFlag(flags, 'system', command),
      };
    case 'remove-asset':
      return {
        type: 'removeAsset',
        guildId: requireFlag(flags, 'guild', command),
        assetId: requireFlag(flags, 'asset', command),
        occupied: flags.close ? 'close' : 'detach',
      };
    case 'remove-venture':
      return {
        type: 'removeVenture',
        guildId: requireFlag(flags, 'guild', command),
        ventureId: requireFlag(flags, 'venture', command),
        asset: flags['remove-asset'] ? 'remove' : 'keep',
      };
    default:
      throw new Error(`adjustActionFor: ${JSON.stringify(command)} is not an adjust subcommand`);
  }
}

// The two vehicle spawn/remove subcommands (design.md §15.4, roadmap 2.2 spawn) — thin HTTP
// clients over POST /admin/vehicle/spawn|remove, the operator/Storyteller primitive.
const VEHICLE_COMMANDS = Object.freeze(['spawn-vehicle', 'remove-vehicle', 'dispatch-vehicle', 'transfer-cargo']);

// parseHexFlag(raw) -> { q, r } | THROWS. The operator writes `--hex 3,-4`; the engine speaks a
// bare-hex location { q, r } of INTEGERS (design.md §15.4). Anything not exactly two integers is
// refused rather than coerced — a mistyped coordinate must fail the command, not spawn a craft
// somewhere nobody named.
function parseHexFlag(raw) {
  if (typeof raw !== 'string') throw new Error(`--hex must be "q,r", got ${JSON.stringify(raw)}`);
  const parts = raw.split(',');
  if (parts.length !== 2) throw new Error(`--hex must be "q,r" (two integers), got ${JSON.stringify(raw)}`);
  const q = Number(parts[0]);
  const r = Number(parts[1]);
  if (!Number.isInteger(q) || !Number.isInteger(r)) throw new Error(`--hex q and r must both be integers, got ${JSON.stringify(raw)}`);
  return { q, r };
}

// vehicleLocationFromFlags(flags) -> the engine `location` object, or THROWS. EXACTLY ONE of
// --system / --outpost / --hex must be given (design.md §15.4 "exactly one" location form); zero
// or more than one is refused. A --system/--outpost becomes a landmark ref { landmarkKind,
// landmarkId }; a --hex becomes a bare { q, r }. PURE and exported so admin.test.js can assert
// the mapping without a server (this file authors no game number — the seed decides what resolves).
function vehicleLocationFromFlags(flags) {
  const forms = [];
  if (flags.system !== undefined) forms.push({ landmarkKind: 'system', landmarkId: flags.system });
  if (flags.outpost !== undefined) forms.push({ landmarkKind: 'outpost', landmarkId: flags.outpost });
  if (flags.hex !== undefined) forms.push(parseHexFlag(flags.hex));
  if (forms.length === 0) throw new Error('spawn-vehicle: a location is required — give exactly one of --system <id>, --outpost <id>, or --hex q,r');
  if (forms.length > 1) throw new Error('spawn-vehicle: give exactly one of --system, --outpost, or --hex (a craft sits at exactly one location)');
  return forms[0];
}

// spawnVehicleBody(flags) -> the POST /admin/vehicle/spawn request body. --condition is included
// only when given (the engine defaults it to new / 1). PURE and exported (admin.test.js).
function spawnVehicleBody(flags) {
  const body = {
    guildId: requireFlag(flags, 'guild', 'spawn-vehicle'),
    class: requireFlag(flags, 'class', 'spawn-vehicle'),
    location: vehicleLocationFromFlags(flags),
  };
  if (flags.condition !== undefined) body.condition = flags.condition;
  return body;
}

// removeVehicleBody(flags) -> the POST /admin/vehicle/remove request body. PURE and exported.
function removeVehicleBody(flags) {
  return {
    guildId: requireFlag(flags, 'guild', 'remove-vehicle'),
    vehicleId: requireFlag(flags, 'id', 'remove-vehicle'),
  };
}

// parseWaypointToken(tok) -> a single location anchor { landmarkKind, landmarkId } | { q, r }, or
// THROWS. `sys:<id>` -> a system landmark; `out:<id>` -> an outpost landmark; anything else is a bare
// hex `q,r` (parseHexFlag). Mirrors vehicleLocationFromFlags' mapping so a waypoint speaks the same
// anchor shape a spawn location does (design.md §15.4). PURE — the seed decides what resolves, not this.
function parseWaypointToken(tok) {
  const t = String(tok).trim();
  if (t.startsWith('sys:')) return { landmarkKind: 'system', landmarkId: t.slice(4) };
  if (t.startsWith('out:')) return { landmarkKind: 'outpost', landmarkId: t.slice(4) };
  return parseHexFlag(t); // "q,r" or throw
}

// parseWaypointsFlag(raw) -> a non-empty ordered array of anchors, or THROWS. Semicolon-separated,
// each token sys:<id> | out:<id> | q,r (transport-model.md §4 — a route is an ordered anchor list).
// An empty (or all-blank) list is refused: a dispatch needs at least one waypoint. PURE and exported.
function parseWaypointsFlag(raw) {
  if (typeof raw !== 'string') throw new Error(`--waypoints must be a "w;w;…" string, got ${JSON.stringify(raw)}`);
  const tokens = raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new Error('dispatch-vehicle: --waypoints needs at least one anchor (sys:<id> | out:<id> | q,r), separated by ;');
  }
  return tokens.map(parseWaypointToken);
}

// dispatchVehicleBody(flags) -> the POST /admin/vehicle/dispatch request body. PURE and exported.
function dispatchVehicleBody(flags) {
  return {
    guildId: requireFlag(flags, 'guild', 'dispatch-vehicle'),
    vehicleId: requireFlag(flags, 'id', 'dispatch-vehicle'),
    waypoints: parseWaypointsFlag(requireFlag(flags, 'waypoints', 'dispatch-vehicle')),
  };
}

// parseCargoFlag(raw, dir) -> the manifest lines for one direction, or THROWS. The operator writes
// `--load good:qty,good:qty`; each comma-separated token is `good:qty` (qty a positive integer) OR
// `good:max` — "as much as possible" (design.md §4), which builds a { dir, good, max: true } line with
// no qty. A malformed token fails the command rather than posting a half-formed manifest (the
// parseHexFlag / parseWaypointsFlag discipline). `good` is passed through verbatim — WHICH goods are
// real stockpile keys is the engine's validate gate, not this file's (it authors no vocabulary). PURE.
function parseCargoFlag(raw, dir) {
  if (typeof raw !== 'string') throw new Error(`--${dir} must be "good:qty,good:qty", got ${JSON.stringify(raw)}`);
  const tokens = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) throw new Error(`--${dir} needs at least one "good:qty" pair`);
  return tokens.map((tok) => {
    const colon = tok.lastIndexOf(':'); // lastIndexOf so a good id with a ':' (none today) wouldn't split wrong
    if (colon <= 0 || colon === tok.length - 1) throw new Error(`--${dir} token must be "good:qty", got ${JSON.stringify(tok)}`);
    const good = tok.slice(0, colon);
    const amount = tok.slice(colon + 1);
    // `good:max` -> a MAX line (no qty). Anything else must be a positive integer qty.
    if (amount === 'max') return { dir, good, max: true };
    const qty = Number(amount);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`--${dir} qty must be a positive integer or "max", got ${JSON.stringify(tok)}`);
    return { dir, good, qty };
  });
}

// transferCargoBody(flags) -> the POST /admin/vehicle/transfer request body. The manifest is built
// UNLOADS FIRST, then LOADS — matching the engine's fixed resolution order (design.md §4), so the
// printed manifest reads the way it resolves — from `--unload` and/or `--load` ("good:qty,…" each);
// at least one is required. PURE and exported so admin.test.js can assert the arg→body mapping.
function transferCargoBody(flags) {
  const manifest = [];
  if (flags.unload !== undefined) manifest.push(...parseCargoFlag(flags.unload, 'unload'));
  if (flags.load !== undefined) manifest.push(...parseCargoFlag(flags.load, 'load'));
  if (manifest.length === 0) throw new Error('transfer-cargo: give at least one of --load good:qty,… or --unload good:qty,…');
  return {
    guildId: requireFlag(flags, 'guild', 'transfer-cargo'),
    vehicleId: requireFlag(flags, 'id', 'transfer-cargo'),
    manifest,
  };
}

// The two guild-Outpost spawn/remove subcommands (design.md §4 / §15.4, roadmap 2.2 slice 1) — thin
// HTTP clients over POST /admin/outpost/spawn|remove, the operator primitive for placing/destroying a
// guild Outpost, exactly as spawn-vehicle / remove-vehicle place/destroy a craft.
const OUTPOST_COMMANDS = Object.freeze(['spawn-outpost', 'remove-outpost']);

// spawnOutpostBody(flags) -> the POST /admin/outpost/spawn request body. The anchor is --system (the
// system the outpost anchors to) and the hex is --hex "q,r" (parseHexFlag). PURE and exported so
// admin.test.js can assert the mapping without a server (this file authors no game number — the seed
// decides what resolves and the engine mints the id).
function spawnOutpostBody(flags) {
  return {
    guildId: requireFlag(flags, 'guild', 'spawn-outpost'),
    anchorSystemId: requireFlag(flags, 'system', 'spawn-outpost'),
    coords: parseHexFlag(requireFlag(flags, 'hex', 'spawn-outpost')),
  };
}

// removeOutpostBody(flags) -> the POST /admin/outpost/remove request body. PURE and exported.
function removeOutpostBody(flags) {
  return {
    guildId: requireFlag(flags, 'guild', 'remove-outpost'),
    outpostId: requireFlag(flags, 'id', 'remove-outpost'),
  };
}

module.exports = {
  parseArgs, pick, findResourceNodes, pickResourceNode, pickIdleAssetId, judgeVerify, utcOffsetMinutesFromHours,
  adjustActionFor, ADJUST_COMMANDS,
  parseHexFlag, vehicleLocationFromFlags, spawnVehicleBody, removeVehicleBody, VEHICLE_COMMANDS,
  parseWaypointToken, parseWaypointsFlag, dispatchVehicleBody,
  parseCargoFlag, transferCargoBody,
  spawnOutpostBody, removeOutpostBody, OUTPOST_COMMANDS,
  EXPECTED_COMMITMENT, EXPECTED_WINDOW_N,
};

// ---------------------------------------------------------------------------
// The HTTP shell — thin, and deliberately not unit-tested (it needs a server)
// ---------------------------------------------------------------------------

const DEFAULT_BASE = process.env.STARFARE_BASE || 'http://localhost:7331';

// Operator-supplied setup values, every one QUOTED from somewhere that already
// ruled it — this file chooses no game number.
const STARTING_CREDITS = 2000;   // client/game.html's STARTING_CREDITS [FIRST-CUT]
const ESTABLISH_RATE = 5;        // titanium's ruled 5/tick (phase-1-tuning.md); the client's establish rate
const FULL_COMMITMENT = 1;       // committedOutputPct as a fraction — 1 = 100%
const WINDOW_DAYS = 7;           // sim/licence.js WINDOW_DAYS_MIN, the shortest legal term
const DEMO_GOOD = 'titanium';
const STARTER_SCAN_LIMIT = 40;   // how many starters the node-finder will fetch layouts for

function log(...parts) { console.log(...parts); }
function row(label, value) { console.log(`${String(label).padEnd(12)}${value}`); }

async function request(base, method, path, body) {
  const url = base.replace(/\/+$/, '') + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`cannot reach ${url} — ${(err && err.message) || err}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — kept in `text` for the error */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function callJson(base, method, path, body) {
  const r = await request(base, method, path, body);
  if (!r.ok || r.json === null) {
    const detail = r.json ? JSON.stringify(r.json) : r.text.slice(0, 300);
    throw new Error(`${method} ${path} -> HTTP ${r.status}: ${detail}`);
  }
  return r.json;
}

const getJson = (base, path) => callJson(base, 'GET', path);
const postJson = (base, path, body) => callJson(base, 'POST', path, body);

// POST one action. A REFUSED action is a normal 200 with accepted:false — the
// CLI turns it into a failure, because an operator scripting this needs a
// non-zero exit when the Syndicate said no.
async function act(base, action) {
  const out = await postJson(base, '/action', action);
  if (!out.accepted) throw new Error(`action ${action.type} refused: ${out.reason}`);
  return out.snapshot;
}

// A snapshot, insisting there is a galaxy behind it.
async function liveSnapshot(base) {
  const snap = await getJson(base, '/snapshot');
  if (snap && snap.state === 'no-galaxy') {
    throw new Error(`NO GALAXY on ${base} — ${snap.reason}. Create one: node tools/admin.js new-galaxy`);
  }
  return snap;
}

// The galaxy's offset as an operator reads it: 'UTC', 'UTC+8', 'UTC+5:30'.
function offsetLabel(minutes) {
  const m = Number(minutes) || 0;
  if (m === 0) return 'UTC';
  const abs = Math.abs(m);
  const rem = abs % 60;
  return `UTC${m < 0 ? '-' : '+'}${Math.floor(abs / 60)}${rem ? `:${String(rem).padStart(2, '0')}` : ''}`;
}

function calendarLine(cal) {
  if (!cal) return '(no calendar block — the server is behind this build)';
  return `day ${cal.day} · minute ${cal.minute} · ${cal.label} · windowN ${cal.windowN} · dayAnchorTick ${cal.dayAnchorTick} · utcOffsetMinutes ${cal.utcOffsetMinutes == null ? '(absent)' : cal.utcOffsetMinutes}`;
}

// --- commands ---------------------------------------------------------------

async function cmdHealth(base) {
  const h = await getJson(base, '/health');
  row('base', base);
  row('ok', h.ok);
  row('service', h.service);
  row('galaxy', `${h.galaxy}${h.seed === null ? '' : ` — seed ${h.seed}`}`);
  row('tick', h.tick);
  row('guilds', h.guilds);
  row('autotick', JSON.stringify(h.autotick));
  row('uptime', `${h.uptimeSeconds}s`);
  row('serverTime', h.serverTime);
}

async function cmdSnapshot(base, flags) {
  const snap = await liveSnapshot(base);
  if (flags.json) { log(JSON.stringify(snap, null, 2)); return; }
  if (flags.pick !== undefined) {
    const value = pick(snap, flags.pick);
    if (value === undefined) throw new Error(`no such path in the snapshot: ${flags.pick}`);
    log(typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value));
    return;
  }
  row('tick', snap.tick);
  row('calendar', calendarLine(snap.calendar));
  row('guilds', (snap.guilds || []).length);
  row('ventures', (snap.ventures || []).length);
}

async function cmdStarters(base) {
  const out = await getJson(base, '/starters');
  row('starters', out.count);
  for (const s of out.starters || []) {
    log(`  ${s.id}  ${String(s.ring || '?').padEnd(6)} ${s.name}  (homeworld ${s.terranHomeworldId})`);
  }
}

async function cmdNewGalaxy(base, flags) {
  log('!! this REPLACES the active galaxy — its world, ventures and history are dropped.');
  const body = flags.seed === undefined ? {} : { seed: flags.seed };
  // WHICH midnight the new galaxy rolls its day on. Omitted is 0 = UTC, and the flag
  // is in HOURS because that is how an operator names a timezone. Frozen at creation.
  if (flags['utc-offset'] !== undefined) {
    body.utcOffsetMinutes = utcOffsetMinutesFromHours(flags['utc-offset']);
  }
  const out = await postJson(base, '/admin/galaxy/new', body);
  const snap = await liveSnapshot(base);
  const cal = snap.calendar || null;
  row('galaxy', `${out.state} — seed ${out.seed}, tick ${out.tick}`);
  row('calendar', calendarLine(cal));
  const anchored = cal && Number.isInteger(cal.dayAnchorTick);
  row('anchor', anchored
    ? `dayAnchorTick ${cal.dayAnchorTick} — anchored to midnight at ${offsetLabel(cal.utcOffsetMinutes)}`
    : 'MISSING — this server is not running the calendar build');
  if (!anchored) throw new Error('the new galaxy came back without a dayAnchorTick');
  return out;
}

async function cmdTick(base, flags) {
  const n = flags._.length > 0 ? Number(flags._[0]) : 1;
  if (!Number.isInteger(n) || n < 1) throw new Error(`tick [n]: n must be an integer >= 1, got ${JSON.stringify(flags._[0])}`);
  const before = await liveSnapshot(base);
  let snap = before;
  for (let i = 0; i < n; i += 1) snap = await postJson(base, '/tick');
  row('ticked', `${n}`);
  row('tick', `${before.tick} -> ${snap.tick}`);
  row('calendar', calendarLine(snap.calendar));
}

// Scan starter systems (skipping any already claimed) for one holding at least
// `want` nodes of `good`, fetching each layout from GET /system/:id. Bounded, and
// the bound is REPORTED on failure rather than passing silently as "none exist".
async function scanStarters(base, snap, good, want) {
  const claimed = new Set((snap.claims || []).map((c) => c.landmarkId));
  const all = (await getJson(base, '/starters')).starters || [];
  const open = all.filter((s) => !claimed.has(s.id));
  const scanned = open.slice(0, STARTER_SCAN_LIMIT);
  for (const starter of scanned) {
    const layout = await getJson(base, `/system/${encodeURIComponent(starter.id)}`);
    const nodes = findResourceNodes([layout], good, want);
    if (nodes.length >= want) return { starter, layout, nodes };
  }
  throw new Error(
    `no unclaimed starter with ${want} ${good} node(s) in the first ${scanned.length} of `
    + `${open.length} unclaimed starters (scan bounded at ${STARTER_SCAN_LIMIT})`,
  );
}

async function cmdSeatDemo(base, flags) {
  const short = flags.window !== undefined;
  // The two paths are mutually exclusive: --window keeps the galaxy that is there
  // (it only /resets it), so it has no seed to name. Say so rather than ignoring --seed.
  if (short && flags.seed !== undefined) {
    throw new Error('seat-demo: --window and --seed are mutually exclusive — --window /resets the galaxy in place, it does not create one');
  }
  if (short) {
    // A tick-0 TEST galaxy: /reset zeroes the world (no midnight anchor), which is
    // the only state in which setWindowN is legal — it is a setup-only knob.
    await postJson(base, '/reset');
    await act(base, { type: 'setWindowN', windowN: flags.window });
    log(`window      ${flags.window} ticks (short-cycle test galaxy via /reset + setWindowN — NOT anchored)`);
  } else {
    await cmdNewGalaxy(base, flags);
  }

  const snap = await liveSnapshot(base);
  const { starter, nodes } = await scanStarters(base, snap, DEMO_GOOD, 2);

  const guildId = 'seat_demo';
  // Each action returns the snapshot it produced, so the inventory this reads is
  // always post-founding and post-previous-deploy — the second mine cannot name the
  // machine the first one just took.
  let live = await act(base, {
    type: 'foundGuild', guildId, name: 'Seat Demo', credits: STARTING_CREDITS, homeSystemId: starter.id,
  });

  const seated = [];
  for (const node of nodes) {
    const ventureId = `${guildId}_${node.nodeId}`;
    live = await act(base, {
      type: 'establishVenture',
      guildId,
      ventureId,
      ventureType: 'mining',
      siteId: node.nodeId,
      assetId: pickIdleAssetId(live, guildId, 'miner'),
      resourceType: DEMO_GOOD,
      productionRate: ESTABLISH_RATE,
    });
    await act(base, {
      type: 'applyForLicence', guildId, ventureId, committedOutputPct: FULL_COMMITMENT, windowDays: WINDOW_DAYS,
    });
    seated.push(ventureId);
  }

  const after = await liveSnapshot(base);
  const mine = (id) => (after.ventures || []).find((v) => v.id === id) || null;

  row('seated', `${starter.id} "${starter.name}" — 2 ${DEMO_GOOD} mines, both licensed at 100%`);
  for (const id of seated) {
    const v = mine(id);
    log(`  ${id}  site ${v ? v.siteId : '?'}  commitment ${v ? v.syndicateCommitment : '?'} / window`);
  }
  row('calendar', calendarLine(after.calendar));
  row('console', `${base.replace(/\/+$/, '')}/console?guild=${guildId}&system=${starter.id}`);
  log('');
  log('Both licences claim 100% of their mine\'s baseline, so the system\'s whole fresh');
  log(`${DEMO_GOOD} pile is spoken for — open the console above and watch the Syndicate roster`);
  log('fill in pursue order as the window runs.');
}

async function cmdVerifyCycle(base, flags) {
  // The post-redeploy self-check: build a galaxy from scratch, license one mine
  // at 100%, read the result back, and judge it.
  await cmdNewGalaxy(base, flags);
  const snap = await liveSnapshot(base);
  const { starter, nodes } = await scanStarters(base, snap, DEMO_GOOD, 1);
  const node = nodes[0];

  const guildId = 'verify_cycle';
  const ventureId = `${guildId}_${node.nodeId}`;
  const founded = await act(base, {
    type: 'foundGuild', guildId, name: 'Verify Cycle', credits: STARTING_CREDITS, homeSystemId: starter.id,
  });
  await act(base, {
    type: 'establishVenture',
    guildId,
    ventureId,
    ventureType: 'mining',
    siteId: node.nodeId,
    assetId: pickIdleAssetId(founded, guildId, 'miner'),
    resourceType: DEMO_GOOD,
    productionRate: ESTABLISH_RATE,
  });
  await act(base, {
    type: 'applyForLicence', guildId, ventureId, committedOutputPct: FULL_COMMITMENT, windowDays: WINDOW_DAYS,
  });

  const after = await liveSnapshot(base);
  const venture = (after.ventures || []).find((v) => v.id === ventureId) || null;
  const verdict = judgeVerify({ venture, calendar: after.calendar });

  log('');
  row('licensed', `${ventureId} on ${node.nodeId} (${starter.id})`);
  log('');
  for (const check of verdict.checks) {
    log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(42)} ${check.detail}`);
  }
  log('');
  log(verdict.pass
    ? 'ALL PASS — the 24-hour, midnight-anchored commitment cycle is live on this server.'
    : 'FAILED — this server is not running the ruled cycle.');
  if (!verdict.pass) throw new Error('verify-cycle failed');
}

// The operator adjust levers (docs/operator-adjust.md §5): build the action from the
// subcommand's flags (the PURE `adjustActionFor`) and POST it over the shared `act`
// helper — so a refused adjust throws and exits 1, exactly as the other action commands
// rely on. Prints the accepted action and the guild's resulting producible state so an
// operator sees what moved.
async function cmdAdjust(base, command, flags) {
  const action = adjustActionFor(command, flags);
  const snap = await act(base, action); // refused action => throw => exit 1
  const guild = (snap.guilds || []).find((g) => g.id === action.guildId) || null;
  row('action', action.type);
  row('guild', action.guildId);
  if (guild) {
    if (guild.credits !== undefined) row('credits', guild.credits);
    if (guild.fuelHoard !== undefined) row('fuelHoard', guild.fuelHoard);
    if (Array.isArray(guild.assets)) row('assets', `${guild.assets.length}`);
  }
}

// The vehicle spawn/remove primitive (design.md §15.4, roadmap 2.2 spawn): build the request
// body from the flags (the PURE spawnVehicleBody / removeVehicleBody) and POST it to the gated
// /admin/vehicle/* endpoint. A REFUSED action comes back as a 200 with accepted:false — turn it
// into a throw so a scripted operator gets exit 1, exactly as `act` does for /action. Prints the
// craft that moved so the operator sees the result.
async function cmdSpawnVehicle(base, flags) {
  const body = spawnVehicleBody(flags);
  const out = await postJson(base, '/admin/vehicle/spawn', body);
  if (!out.accepted) throw new Error(`spawn-vehicle refused: ${out.reason}`);
  const guild = (out.snapshot.guilds || []).find((g) => g.id === body.guildId) || null;
  const vehicles = (guild && guild.vehicles) || [];
  const minted = vehicles[vehicles.length - 1] || null; // the just-minted craft is the newest row
  row('action', 'spawnVehicle');
  row('guild', body.guildId);
  row('class', body.class);
  row('location', JSON.stringify(body.location));
  if (minted) row('minted', `${minted.id} (${minted.status}, condition ${minted.maintenanceCondition})`);
  row('vehicles', `${vehicles.length}`);
}

async function cmdRemoveVehicle(base, flags) {
  const body = removeVehicleBody(flags);
  const out = await postJson(base, '/admin/vehicle/remove', body);
  if (!out.accepted) throw new Error(`remove-vehicle refused: ${out.reason}`);
  const guild = (out.snapshot.guilds || []).find((g) => g.id === body.guildId) || null;
  row('action', 'removeVehicle');
  row('guild', body.guildId);
  row('removed', body.vehicleId);
  row('vehicles', `${((guild && guild.vehicles) || []).length}`);
}

// dispatch-vehicle (transport-model.md §4): send an idle craft along a multi-leg route. Prints the
// craft flying — its status, leg count, final arrivalTick, and the credit-equivalent route fuel cost
// the snapshot surfaces — so the operator sees the trip took (and can advance the server to watch it
// land idle at its final anchor). A refused action comes back accepted:false -> throw -> exit 1.
async function cmdDispatchVehicle(base, flags) {
  const body = dispatchVehicleBody(flags);
  const out = await postJson(base, '/admin/vehicle/dispatch', body);
  if (!out.accepted) throw new Error(`dispatch-vehicle refused: ${out.reason}`);
  const guild = (out.snapshot.guilds || []).find((g) => g.id === body.guildId) || null;
  const craft = ((guild && guild.vehicles) || []).find((v) => v.id === body.vehicleId) || null;
  row('action', 'dispatchVehicle');
  row('guild', body.guildId);
  row('vehicle', body.vehicleId);
  row('waypoints', JSON.stringify(body.waypoints));
  if (craft) {
    row('status', craft.status);
    if (craft.trip) {
      row('legs', `${craft.trip.legs.length}`);
      row('arrivalTick', `${craft.trip.arrivalTick}`);
      row('fuelCost', `${craft.trip.fuelCost} credits`);
    }
  }
}

// transfer-cargo (design.md §4 "The dock model", the system half; roadmap 2.2 cargo engine slice 1):
// load/unload an idle craft against the system it sits at, resolved instantly. Captures the pre-state
// snapshot first so it can print the SYSTEM POOL DELTAS the transfer produced (the transfer is
// partial-safe — a line clamps to what fits — so the delta is the honest record, read from before/
// after, not the ask). Then POSTs, and prints the resulting hold. A refused action -> throw -> exit 1.
async function cmdTransferCargo(base, flags) {
  const body = transferCargoBody(flags);
  const before = await liveSnapshot(base);
  const craftBefore = (((before.guilds || []).find((g) => g.id === body.guildId) || {}).vehicles || [])
    .find((v) => v.id === body.vehicleId) || null;
  // The system the craft sits at — the pool the deltas are read against. Absent (craft gone / not at a
  // system) is left for the engine to refuse; fall back to a null key so the diff below reads 0s.
  const systemId = (craftBefore && craftBefore.location && craftBefore.location.landmarkKind === 'system')
    ? craftBefore.location.landmarkId : null;
  const poolOf = (snap) => {
    const g = (snap.guilds || []).find((gg) => gg.id === body.guildId) || {};
    return ((g.stockpilesBySystem || {})[systemId]) || {};
  };
  const poolBefore = poolOf(before);

  const out = await postJson(base, '/admin/vehicle/transfer', body);
  if (!out.accepted) throw new Error(`transfer-cargo refused: ${out.reason}`);
  const guild = (out.snapshot.guilds || []).find((g) => g.id === body.guildId) || null;
  const craft = ((guild && guild.vehicles) || []).find((v) => v.id === body.vehicleId) || null;
  const poolAfter = poolOf(out.snapshot);

  row('action', 'transferCargo');
  row('guild', body.guildId);
  row('vehicle', body.vehicleId);
  row('system', systemId === null ? '(not at a system)' : systemId);
  // The hold as it stands after the transfer (empty prints "empty" — omit-when-empty on the engine).
  const hold = (craft && craft.cargo) || {};
  const holdKeys = Object.keys(hold).sort();
  row('hold', holdKeys.length ? holdKeys.map((good) => `${good}:${hold[good]}`).join(', ') : 'empty');
  // The pool delta for every good the manifest touched — how many units actually moved (signed:
  // +into the pool on an unload, −out on a load), so a clamped partial reads truthfully.
  const touched = [...new Set(body.manifest.map((l) => l.good))].sort();
  for (const good of touched) {
    const delta = ((poolAfter[good] || 0) - (poolBefore[good] || 0));
    row(`pool ${good}`, `${delta >= 0 ? '+' : ''}${delta} (now ${poolAfter[good] || 0})`);
  }
}

// The guild-Outpost spawn/remove primitive (design.md §4 / §15.4, roadmap 2.2 slice 1): build the
// request body from the flags (the PURE spawnOutpostBody / removeOutpostBody) and POST it to the gated
// /admin/outpost/* endpoint. A REFUSED action comes back as a 200 with accepted:false — turn it into a
// throw so a scripted operator gets exit 1, exactly as cmdSpawnVehicle does. Prints the outpost that moved.
async function cmdSpawnOutpost(base, flags) {
  const body = spawnOutpostBody(flags);
  const out = await postJson(base, '/admin/outpost/spawn', body);
  if (!out.accepted) throw new Error(`spawn-outpost refused: ${out.reason}`);
  const outposts = (out.snapshot.outposts || []).filter((o) => o.ownerGuildId === body.guildId);
  const minted = outposts[outposts.length - 1] || null; // the just-minted outpost is the newest row
  row('action', 'spawnOutpost');
  row('guild', body.guildId);
  row('anchor', body.anchorSystemId);
  row('hex', JSON.stringify(body.coords));
  if (minted) row('minted', `${minted.id} (capacity ${minted.capacity}, dockCapacity ${minted.dockCapacity})`);
  row('outposts', `${(out.snapshot.outposts || []).length}`);
}

async function cmdRemoveOutpost(base, flags) {
  const body = removeOutpostBody(flags);
  const out = await postJson(base, '/admin/outpost/remove', body);
  if (!out.accepted) throw new Error(`remove-outpost refused: ${out.reason}`);
  row('action', 'removeOutpost');
  row('guild', body.guildId);
  row('removed', body.outpostId);
  row('outposts', `${(out.snapshot.outposts || []).length}`);
}

const USAGE = `starfare operator CLI — a thin client over the running server's API.

  node tools/admin.js <command> [flags]
  docker exec starfare node tools/admin.js <command> [flags]

Commands
  health                      GET  /health
  snapshot [--json] [--pick a.b.c]
                              GET  /snapshot (default: a compact summary)
  starters                    GET  /starters
  new-galaxy [--seed N] [--utc-offset H]
                              POST /admin/galaxy/new  — REPLACES the active galaxy
  seat-demo [--window N]      the two-mine 100%-licence demo (see the runbook)
  verify-cycle [--seed N]     the post-redeploy self-check; exit 0 only if every check passes
  tick [n]                    POST /tick, n times (default 1)

Operator adjust levers (docs/operator-adjust.md — dev/steward, exit 1 on a refused action)
  adjust-credits  --guild ID --delta N     grant (+) / remove (−) credits (ledger counter-move)
  adjust-fuel     --guild ID --delta N     grant (+) / remove (−) legal fuel hoard
  adjust-goods    --guild ID --system ID --good G --delta N   a (guild, system) stockpile cell
  grant-asset     --guild ID --kind miner|factory --system ID   mint one idle asset
  remove-asset    --guild ID --asset ID [--close]   remove an asset (occupied: detach, or --close)
  remove-venture  --guild ID --venture ID [--remove-asset]   tear a venture down (keep / remove asset)

Vehicle spawn/remove primitive (design.md §15.4 — operator/Storyteller, exit 1 on a refused action)
  spawn-vehicle   --guild ID --class C (one of --system ID / --outpost ID / --hex q,r) [--condition F]
                  mint one idle craft (default condition 1) at a system, an outpost, or a bare hex
  remove-vehicle  --guild ID --id VEHICLE_ID   destroy the named craft (id never reissued)
  dispatch-vehicle --guild ID --id VEHICLE_ID --waypoints "w;w;…"
                  send an idle craft along a multi-leg route; each w is sys:<id> | out:<id> | q,r
                  (whole-route fuel burned up front from the hoard; refused whole if short)
  transfer-cargo  --guild ID --id VEHICLE_ID [--unload good:qty|max,…] [--load good:qty|max,…]
                  load/unload an idle craft against the SYSTEM it sits at, resolved instantly
                  (a token is good:qty for a fixed amount, or good:max for "as much as possible", §4;
                  unloads-then-loads, partial-safe; at an outpost / in deep space → refused)

Guild-Outpost spawn/remove primitive (design.md §4 — operator, exit 1 on a refused action)
  spawn-outpost   --guild ID --system ANCHOR_ID --hex q,r
                  place one guild Outpost anchored to a system, on a single in-bounds hex
                  (one structure per hex; placed freely — range/anchor-ownership deferred)
  remove-outpost  --guild ID --id OUTPOST_ID   tear the named outpost down (id never reissued)

Flags
  --base <url>   which server (default $STARFARE_BASE or ${DEFAULT_BASE})
  --seed N       name the galaxy new-galaxy/verify-cycle creates
  --pick a.b.c   snapshot: print one dotted path
  --json         snapshot: dump the whole thing
  --window N     seat-demo: a tick-0 short-cycle test galaxy (/reset + setWindowN)
  --utc-offset H new-galaxy: which midnight the galaxy's day rolls on, in HOURS
                 (default 0 = UTC; -12 .. +14; halves allowed, e.g. +5.5). FROZEN
                 at creation — only a new galaxy can carry a different one.
  --guild ID     adjust levers: which guild the adjust acts on
  --delta N      adjust-credits/fuel/goods: a SIGNED integer (grant +, remove −)
  --system ID    adjust-goods / grant-asset: which system's cell / where to mint;
                 spawn-outpost: the system the outpost anchors to
  --good G       adjust-goods: which stockpile good
  --kind K       grant-asset: miner | factory
  --asset ID     remove-asset: which asset id
  --venture ID   remove-venture: which venture id
  --close        remove-asset: tear the occupying venture down (default: detach it)
  --remove-asset remove-venture: delete the freed asset too (default: keep it idle)
  --class C      spawn-vehicle: lightTransport | mediumTransport | heavyTransport | spycraft
  --outpost ID   spawn-vehicle: berth the craft at an outpost landmark
  --hex q,r      spawn-vehicle: berth the craft at a bare in-bounds hex;
                 spawn-outpost: the single hex the outpost occupies
  --condition F  spawn-vehicle: starting maintenanceCondition fraction in [0, 1] (default 1)
  --id ID        remove-vehicle / dispatch-vehicle: which vehicle id;
                 remove-outpost: which outpost id
  --waypoints W  dispatch-vehicle: "w;w;…" route, each w = sys:<id> | out:<id> | q,r
  --load G:N,…   transfer-cargo: goods to load pool -> hold ("good:qty" or "good:max", comma-sep)
  --unload G:N,… transfer-cargo: goods to unload hold -> pool ("good:qty" or "good:max", comma-sep)
  --help, -h     this text
`;

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (flags.help || !command || command === 'help') { process.stdout.write(USAGE); return; }
  const base = flags.base || DEFAULT_BASE;
  switch (command) {
    case 'health': await cmdHealth(base); return;
    case 'snapshot': await cmdSnapshot(base, flags); return;
    case 'starters': await cmdStarters(base); return;
    case 'new-galaxy': await cmdNewGalaxy(base, flags); return;
    case 'seat-demo': await cmdSeatDemo(base, flags); return;
    case 'verify-cycle': await cmdVerifyCycle(base, flags); return;
    case 'tick': await cmdTick(base, flags); return;
    case 'spawn-vehicle': await cmdSpawnVehicle(base, flags); return;
    case 'remove-vehicle': await cmdRemoveVehicle(base, flags); return;
    case 'dispatch-vehicle': await cmdDispatchVehicle(base, flags); return;
    case 'transfer-cargo': await cmdTransferCargo(base, flags); return;
    case 'spawn-outpost': await cmdSpawnOutpost(base, flags); return;
    case 'remove-outpost': await cmdRemoveOutpost(base, flags); return;
    default:
      // The six operator adjust levers share one thin command (docs/operator-adjust.md §5).
      if (ADJUST_COMMANDS.includes(command)) { await cmdAdjust(base, command, flags); return; }
      throw new Error(`unknown command ${JSON.stringify(command)} — run \`node tools/admin.js --help\``);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(`admin: ${(err && err.message) || err}`);
      process.exit(1);
    },
  );
}
