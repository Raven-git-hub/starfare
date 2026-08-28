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

module.exports = {
  parseArgs, pick, findResourceNodes, pickResourceNode, judgeVerify, utcOffsetMinutesFromHours,
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
  await act(base, {
    type: 'foundGuild', guildId, name: 'Seat Demo', credits: STARTING_CREDITS, homeSystemId: starter.id,
  });

  const seated = [];
  for (const node of nodes) {
    const ventureId = `${guildId}_${node.nodeId}`;
    await act(base, {
      type: 'establishVenture',
      guildId,
      ventureId,
      ventureType: 'mining',
      siteId: node.nodeId,
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
  await act(base, {
    type: 'foundGuild', guildId, name: 'Verify Cycle', credits: STARTING_CREDITS, homeSystemId: starter.id,
  });
  await act(base, {
    type: 'establishVenture',
    guildId,
    ventureId,
    ventureType: 'mining',
    siteId: node.nodeId,
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

Flags
  --base <url>   which server (default $STARFARE_BASE or ${DEFAULT_BASE})
  --seed N       name the galaxy new-galaxy/verify-cycle creates
  --pick a.b.c   snapshot: print one dotted path
  --json         snapshot: dump the whole thing
  --window N     seat-demo: a tick-0 short-cycle test galaxy (/reset + setWindowN)
  --utc-offset H new-galaxy: which midnight the galaxy's day rolls on, in HOURS
                 (default 0 = UTC; -12 .. +14; halves allowed, e.g. +5.5). FROZEN
                 at creation — only a new galaxy can carry a different one.
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
    default:
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
