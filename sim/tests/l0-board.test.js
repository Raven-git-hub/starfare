'use strict';

// l0-board.test.js — roadmap 2.5, the L0-board engine slice (docs/exploration-model.md §4 ruling 12, slice 2).
// Two halves, built so nothing live breaks:
//   - THE BOARD: the static half of L0 — every system's position and orbital layout — served once at
//     GET /board (sim/seed.js `getBoard`, sim/server.js). GET /galaxy is UNCHANGED this slice: the client
//     still reads it until the client flip (slice 3), which is also when the /galaxy leak closes.
//   - THE SLIM: the per-guild view drops `geography.systems`; `geography` is `{ known }`.
// The tripwires:
//
//   1. SHAPE: one row per seed system, sorted by id, exactly { id, name, coords, ring, planets: [{ id, order }] };
//      a planet's order is its seed index + 1 — the order getSystemLayout and the site names use.
//   2. LEAK-FREE: the serialized board holds no archetype, resource type, node or slot (asserted on the JSON
//      text), and no site id at all.
//   3. DETERMINISTIC (invariant 9): the same seed gives the same board bytes; a different seed, different bytes.
//   4. THE JOIN (ruling 12's failure mode (a)): every planet `known` names is on the board, in its own system.
//   5. THE SLIM: every scripted view's `geography` is `{ known }`; `known` is byte-identical to slice 1's; the
//      controller of every held system is still in the view's `claims`. (The byte proof that the slim is a
//      removal and nothing more — put the block back, get slice 1's bytes — is in rival-leak-removed.test.js
//      and deep-scan-job.test.js, beside the pins it re-pins. The god's-eye pins in those files and the five
//      in fog.test.js are unchanged: the lens builds no geography.)
//   6. THE ROUTE: GET /board serves the board with an ETag and answers a matching If-None-Match with 304;
//      404 with no galaxy; a new galaxy refreshes the board and changes the ETag (ruling 12's failure mode (b)).
//
// ⤳ 13-10-26 — the board-widening engine slice (§4 ruling 12's 13-10-26 note): the board is no longer a
// systems-only array but the whole static public galaxy, an OBJECT —
//   { seed, galaxyParams, citadel, outposts, stats, systems: [ { id, name, coords, ring, claimRadius, planets } ] }
// — the seed with its fogged planet detail and its Terran pointer taken out. So: SHAPE also checks the five
// top-level blocks equal the seed's and every row's `claimRadius` equals its seed system's; LEAK-FREE also
// forbids `terranHomeworldId`, `starterEligible` and `validation`, and proves the check bites; COPY, NEVER
// ALIAS checks the board shares no object with the seed; PINNED pins the committed seed's board bytes and the
// ETag that names them. The per-guild view is untouched (it never reads the board's top level).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const {
  getBoard, getSystem, getSystemLayout, getSite, getSeedNumber, setSeed, roman, getClaimRadius, getStarterSystems,
} = require('../seed.js');
const { buildSnapshot } = require('../snapshot.js');
const { systemControllers } = require('../claims.js');
const { revealPlanetSurface } = require('../exploration.js');
const { makeServer } = require('../server.js');
const { generateGalaxySeed } = require('../../tools/generate_seed.js');
const { rivalLeakScript, soloScript, A, B, A_HOME, B_HOME } = require('./rival-leak-script.js');
const { idleArrayScript } = require('./idle-array-script.js');
const { controllersFromClaims } = require('./systems-block.js');

const SEED_PATH = path.join(__dirname, '..', '..', 'data', 'seed.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const bytes = (x) => JSON.stringify(x);

// The four words that name L1/L2 geography in the seed. None may appear in the board.
const FOGGED_FIELDS = ['archetype', 'resourceType', 'resourceNodes', 'settlementSlots'];
// ⤳ 13-10-26: the rest of ruling 12's "out" list. None is fogged geometry, but none belongs on the board:
// `terranHomeworldId` names which planet is Terran (an L1 fact — a leak), `starterEligible` is the home
// picker's (GET /starters), and `validation` is the seed's gen-time self-check, unread.
const OUT_FIELDS = ['terranHomeworldId', 'starterEligible', 'validation'];
const FORBIDDEN = [...FOGGED_FIELDS, ...OUT_FIELDS];

// leakedFields(text) -> every forbidden word found anywhere in a serialized board; [] means leak-free. A plain
// text search, not a walk of the keys, so the word is caught wherever it sits — as a key or inside a value.
function leakedFields(text) {
  return FORBIDDEN.filter((field) => text.includes(field));
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// boardFromSeed(seed) -> the board, spelled a SECOND way: straight off a raw seed object, without the engine's
// index. If the engine's board and this one ever differ by a byte, one of them is wrong. (It shares objects with
// the seed, which is fine for a spelling that is only ever stringified; the engine's must not — see COPY below.)
function boardFromSeed(seed) {
  return {
    seed: seed.seed,
    galaxyParams: seed.galaxyParams,
    citadel: seed.citadel,
    outposts: [...seed.outposts].sort(byId),
    stats: seed.stats,
    systems: seed.systems
      .map((sys) => ({
        id: sys.id,
        name: sys.name,
        coords: { q: sys.coords.q, r: sys.coords.r },
        ring: sys.ring || null,
        claimRadius: sys.claimRadius,
        planets: sys.planets.map((p, i) => ({ id: p.id, order: i + 1 })),
      }))
      .sort(byId),
  };
}

// objectsIn(value) -> the Set of every object and array reachable from `value`, itself included.
function objectsIn(value, out = new Set()) {
  if (value === null || typeof value !== 'object' || out.has(value)) return out;
  out.add(value);
  for (const child of Object.values(value)) objectsIn(child, out);
  return out;
}

// The committed seed's board, pinned: its size and the sha256 of its bytes — the hash GET /board's ETag carries.
// Recorded 13-10-26 by the board-widening slice. (Before it, the systems-only board was 283,008 bytes, sha256
// f901b66938dd67bd3b558913882f854ed0b901f46497b170e767c2da0c8216fe.) A deliberate change to the board re-pins
// these; an accidental one fails here first.
const BOARD_PIN = {
  bytes: 313702,
  sha256: 'f5c5e90930de20fa79400990bb50cd2e9808de6979569348b39eb7528ea31f20',
};

// --- 1. shape ---------------------------------------------------------------------------------------------

test('SHAPE: the board is the seed\'s public face — { seed, galaxyParams, citadel, outposts, stats, systems }, each block the seed\'s', () => {
  const board = getBoard();
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  assert.deepEqual(Object.keys(board), ['seed', 'galaxyParams', 'citadel', 'outposts', 'stats', 'systems']);
  assert.equal(bytes(board), bytes(boardFromSeed(seed)), 'the same bytes as the board spelled straight off the seed');
  // The galaxy's public config is the seed's own, value for value.
  assert.equal(board.seed, seed.seed);
  assert.equal(board.seed, getSeedNumber());
  assert.deepEqual(board.galaxyParams, seed.galaxyParams);
  assert.deepEqual(board.citadel, seed.citadel, 'the seed\'s Citadel — not the landmark: no id, no kind');
  assert.deepEqual(board.stats, seed.stats);
  // The waystations: every one the seed has, exactly { id, coords: { q, r }, name }, in id order.
  assert.equal(board.outposts.length, seed.outposts.length);
  assert.ok(board.outposts.length > 0, 'the committed seed has waystations, so this check can fail');
  assert.deepEqual(board.outposts, [...seed.outposts].sort(byId));
  assert.deepEqual(board.outposts.map((o) => o.id), board.outposts.map((o) => o.id).sort(), 'id order');
  for (const out of board.outposts) {
    assert.deepEqual(Object.keys(out), ['id', 'coords', 'name']);
    assert.deepEqual(Object.keys(out.coords), ['q', 'r']);
  }
});

test('SHAPE: one system row per seed system, sorted by id, exactly { id, name, coords, ring, claimRadius, planets: [{ id, order }] }', () => {
  const { systems } = getBoard();
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const seedSystem = new Map(seed.systems.map((sys) => [sys.id, sys]));
  assert.equal(systems.length, seed.systems.length, 'every system on the seed');
  assert.deepEqual(systems.map((s) => s.id), systems.map((s) => s.id).sort(), 'id order');
  for (const row of systems) {
    assert.deepEqual(Object.keys(row), ['id', 'name', 'coords', 'ring', 'claimRadius', 'planets']);
    assert.deepEqual(Object.keys(row.coords), ['q', 'r']);
    assert.deepEqual(row.coords, getSystem(row.id).coords);
    // The claim radius is the seed system's own — the same number the engine's own reader answers.
    assert.equal(row.claimRadius, seedSystem.get(row.id).claimRadius);
    assert.equal(row.claimRadius, getClaimRadius(row.id));
    const layout = getSystemLayout(row.id);
    assert.equal(row.name, layout.name);
    assert.equal(row.ring, layout.ring);
    // The orbital layout IS getSystemLayout's planet list, cut to id + order (order = seed index + 1).
    assert.deepEqual(row.planets, layout.planets.map((p, i) => ({ id: p.id, order: i + 1 })));
    for (const planet of row.planets) assert.deepEqual(Object.keys(planet), ['id', 'order']);
  }
});

test('NO NEW NUMBERING: a planet\'s board order is the Roman numeral its sites are already named by', () => {
  // siteName (sim/seed.js) names a site "<system> <planet's Roman ordinal> · Node n". The board's order must be
  // that same ordinal, or a client would label one planet two ways.
  let checked = 0;
  for (const row of getBoard().systems) {
    for (const [i, planet] of getSystemLayout(row.id).planets.entries()) {
      const node = planet.resourceNodes[0];
      if (!node) continue;
      assert.equal(row.planets[i].id, planet.id);
      assert.ok(getSite(node.id).name.startsWith(`${row.name} ${roman(row.planets[i].order)} · `), getSite(node.id).name);
      checked += 1;
    }
  }
  assert.ok(checked > 1000, `checked ${checked} planets`);
});

// --- 2. leak-free -----------------------------------------------------------------------------------------

test('LEAK-FREE: the serialized board holds no archetype, resource type, node or slot, no Terran pointer, no starter flag, no validation block — and no site id', () => {
  const text = bytes(getBoard());
  const seedText = fs.readFileSync(SEED_PATH, 'utf8');
  // Every forbidden word is really there to leak, so a misspelt one cannot pass for free. The seed file carries
  // six of them; the Terran pointer it does not — the index derives it, and its own starter rows carry it.
  const sourceText = seedText + bytes(getStarterSystems());
  for (const field of FORBIDDEN) assert.ok(sourceText.includes(field), `the source does carry "${field}", so this check can fail`);
  assert.deepEqual(leakedFields(text), [], 'the board leaks');
  // A node id is `<planet>_nNN`, a slot id `<planet>_sNN`: none may appear, not even as a bare id.
  assert.match(seedText, /_[ns]\d+"/, 'the seed does carry site ids');
  assert.doesNotMatch(text, /_[ns]\d+"/, 'the board names a node or slot');
});

test('LEAK-FREE BITES: a board carrying any forbidden field — on a system row or at the top — fails the check', () => {
  for (const field of FORBIDDEN) {
    const onRow = structuredClone(getBoard());
    onRow.systems[0][field] = 'x';
    assert.deepEqual(leakedFields(bytes(onRow)), [field], `"${field}" on a system row`);
    const onTop = structuredClone(getBoard());
    onTop[field] = 'x';
    assert.deepEqual(leakedFields(bytes(onTop)), [field], `"${field}" at the top level`);
  }
  // The realistic slip: a starter system's row gains the Terran pointer exactly as the index holds it.
  const starter = getStarterSystems()[0];
  const leaky = structuredClone(getBoard());
  leaky.systems.find((row) => row.id === starter.id).terranHomeworldId = starter.terranHomeworldId;
  assert.deepEqual(leakedFields(bytes(leaky)), ['terranHomeworldId']);
});

test('COPY, NEVER ALIAS: the board shares no object with the seed it was cut from', () => {
  // Index a seed object we hold, so we can ask of every object in the board: is this one of the seed's?
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  try {
    setSeed(seed);
    const seedObjects = objectsIn(seed);
    const boardObjects = [...objectsIn(getBoard())];
    // The walk really reached the rows: at least a row, its coords and its planets array per system, and one
    // object per planet.
    const floor = 3 * seed.systems.length + seed.stats.totalPlanets;
    assert.ok(boardObjects.length >= floor, `walked ${boardObjects.length} board objects, expected at least ${floor}`);
    const shared = boardObjects.filter((o) => seedObjects.has(o));
    assert.deepEqual(shared, [], 'the board hands out an object of the seed');
  } finally {
    setSeed(null); // back to the committed seed for every other test in this file
  }
});

// --- 3. deterministic -------------------------------------------------------------------------------------

test('DETERMINISTIC: the same seed gives the same board bytes; a different seed gives different bytes', () => {
  const committed = bytes(getBoard());
  try {
    // A fresh parse of the same file, indexed from scratch: the same bytes.
    setSeed(JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')));
    assert.equal(bytes(getBoard()), committed);
    // Two galaxies generated from one number: one board. Another number: another board.
    setSeed(generateGalaxySeed(4242));
    const first = bytes(getBoard());
    setSeed(generateGalaxySeed(4242));
    assert.equal(bytes(getBoard()), first, 'same seed number, same board');
    setSeed(generateGalaxySeed(4343));
    assert.notEqual(bytes(getBoard()), first, 'a different galaxy, a different board');
  } finally {
    setSeed(null); // back to the committed seed for every other test in this file
  }
  assert.equal(bytes(getBoard()), committed);
});

test('PINNED: the committed seed\'s board is exactly the pinned bytes', () => {
  const text = bytes(getBoard());
  assert.equal(Buffer.byteLength(text), BOARD_PIN.bytes, 'the board\'s size moved');
  assert.equal(sha(text), BOARD_PIN.sha256, 'the board\'s bytes moved');
});

// --- 4. the join ------------------------------------------------------------------------------------------

test('THE JOIN: every planet `known` names is on the board in its own system; a controlled system\'s are all of them', () => {
  const s = rivalLeakScript().licensed;
  // A frontier planet A surveyed itself, so `known` holds all three kinds of entry (own, rival, surveyed).
  const frontier = getBoard().systems.find((row) => row.id !== A_HOME && row.id !== B_HOME && row.planets.length > 1);
  const surveyed = structuredClone(s);
  revealPlanetSurface(surveyed.guilds.find((g) => g.id === A), frontier.planets[0].id, surveyed.tick);
  const rowById = new Map(getBoard().systems.map((row) => [row.id, row]));
  for (const guildId of [A, B]) {
    const { known } = buildSnapshot(surveyed, guildId).geography;
    for (const [systemId, planets] of Object.entries(known)) {
      const boardIds = rowById.get(systemId).planets.map((p) => p.id);
      for (const planetId of Object.keys(planets)) assert.ok(boardIds.includes(planetId), `${planetId} is not on the board under ${systemId}`);
      // A controlled system is shown at full L2 (ruling 11): every planet the board lists, no more, no fewer.
      if (systemControllers(surveyed).has(systemId)) assert.deepEqual(Object.keys(planets), [...boardIds].sort());
    }
  }
  assert.deepEqual(Object.keys(buildSnapshot(surveyed, A).geography.known[frontier.id]), [frontier.planets[0].id]);
});

// --- 5. the slim ------------------------------------------------------------------------------------------

// `geography.known` of each scripted view, recorded on main at 348e0fc (BEFORE this slice) by hashing
// JSON.stringify(view.geography.known). Every two-guild view in these scripts knows the same ground — both
// homes, the first two starter systems — so they share one hash; the solo view knows only its home.
const KNOWN_ON_SLICE_1 = {
  twoGuild: '48a856530ec9e435098633870285ec8d02cc46db866b90e48c00cf02f0724231',
  solo: '3344932ba2d65eecec1872e9bb2250988f095511c4abe34be15300633db6eacb',
};

// scriptedViews() -> every per-guild view the re-pinned goldens cover: the ruling-11 script's three steps for
// both guilds, its solo run, and the idle-array script's two steps for both guilds.
function scriptedViews() {
  const out = [];
  const leak = rivalLeakScript();
  for (const step of ['founded', 'licensed', 'closed']) {
    for (const guildId of [A, B]) out.push({ label: `rival-leak ${step} ${guildId}`, state: leak[step], guildId, known: KNOWN_ON_SLICE_1.twoGuild });
  }
  out.push({ label: 'solo', state: soloScript().solo, guildId: A, known: KNOWN_ON_SLICE_1.solo });
  const idle = idleArrayScript();
  for (const step of ['deployed', 'ticked']) {
    for (const guildId of [idle.A, idle.B]) out.push({ label: `idle-array ${step} ${guildId}`, state: idle.steps[step], guildId, known: KNOWN_ON_SLICE_1.twoGuild });
  }
  return out;
}

test('THE SLIM: `geography` is `{ known }`, `known` is byte-identical to slice 1, and every controller is in `claims`', () => {
  const views = scriptedViews();
  assert.equal(views.length, 11);
  for (const { label, state, guildId, known } of views) {
    const view = buildSnapshot(state, guildId);
    assert.deepEqual(Object.keys(view.geography), ['known'], `${label}: geography.systems is gone`);
    assert.equal(sha(bytes(view.geography.known)), known, `${label}: known moved`);
    assert.deepEqual([...controllersFromClaims(view)], [...systemControllers(state)], `${label}: a controller is missing from claims`);
    assert.equal('geography' in buildSnapshot(state), false, `${label}: the god's-eye lens builds no geography`);
  }
});

// --- 6. the route -----------------------------------------------------------------------------------------

async function withServer(fn) {
  const server = makeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
}

test('GET /board serves the board, with an ETag and the /galaxy CORS headers; /galaxy is untouched', async (t) => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/board`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('cache-control'), 'no-cache', 'revalidate every time, so a new galaxy is never served stale');
    // The tag names the pinned bytes: the committed seed's number and the sha256 of its board.
    assert.equal(res.headers.get('etag'), `"board-${getSeedNumber()}-${BOARD_PIN.sha256}"`);
    const text = await res.text();
    assert.equal(text, bytes(getBoard()), 'the board, byte for byte');
    // The leak-free tripwire, on the bytes a browser actually receives.
    assert.deepEqual(leakedFields(text), [], 'the served board leaks');

    // /galaxy still serves the committed seed verbatim (its cutover is the client flip, slice 3).
    const galaxy = await fetch(`${base}/galaxy`);
    const galaxyBytes = Buffer.from(await galaxy.arrayBuffer());
    assert.equal(galaxy.status, 200);
    assert.ok(galaxyBytes.equals(fs.readFileSync(SEED_PATH)), '/galaxy is the committed seed, unchanged');
    const boardSize = Buffer.byteLength(text);
    assert.ok(boardSize < galaxyBytes.length);
    t.diagnostic(`/board ${boardSize} bytes vs /galaxy ${galaxyBytes.length} bytes (${((100 * boardSize) / galaxyBytes.length).toFixed(1)}%)`);
  });
});

test('GET /board answers a matching If-None-Match with 304 and no body; a different tag gets the board', async () => {
  await withServer(async (base) => {
    const etag = (await fetch(`${base}/board`)).headers.get('etag');
    for (const header of [etag, `W/${etag}`, `"something-else", ${etag}`, '*']) {
      const res = await fetch(`${base}/board`, { headers: { 'If-None-Match': header } });
      assert.equal(res.status, 304, `If-None-Match: ${header}`);
      assert.equal(res.headers.get('etag'), etag);
      assert.equal(await res.text(), '');
    }
    const stale = await fetch(`${base}/board`, { headers: { 'If-None-Match': '"board-1-0000"' } });
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), bytes(getBoard()));
  });
});

// The lifecycle half boots the real server over a persist volume, as tests/galaxy-lifecycle.test.js does: what
// the volume holds decides whether there is a galaxy, and only a volume can create a new one.
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

async function waitForHealth(base) {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('the booted server never answered /health');
    await sleep(25);
  }
}

test('LIFECYCLE: 404 with no galaxy; a new galaxy refreshes the board and its ETag; /reset keeps both; delete is 404 again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-board-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), STARFARE_PERSIST_DIR: dir };
  delete env.STARFARE_TICK_MS;
  const child = spawn(process.execPath, [SERVER_JS], { env });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  // createAndRead(seedNumber) -> create that galaxy, then { etag, text } of its board, checked against its own
  // /galaxy (the board spelled straight off the seed the server is serving).
  async function createAndRead(seedNumber) {
    assert.equal((await post('/admin/galaxy/new', { seed: seedNumber })).status, 200);
    const res = await fetch(`${base}/board`);
    assert.equal(res.status, 200);
    const etag = res.headers.get('etag');
    assert.match(etag, new RegExp(`^"board-${seedNumber}-[0-9a-f]{64}"$`));
    const text = await res.text();
    const seed = await (await fetch(`${base}/galaxy`)).json();
    assert.equal(seed.seed, seedNumber);
    assert.equal(text, bytes(boardFromSeed(seed)), `the board of galaxy ${seedNumber}, from that galaxy's own seed`);
    assert.equal(JSON.parse(text).seed, seedNumber, 'the board names its own galaxy');
    assert.deepEqual(leakedFields(text), [], `the board of galaxy ${seedNumber} leaks`);
    return { etag, text };
  }
  try {
    await waitForHealth(base);
    const none = await fetch(`${base}/board`);
    assert.equal(none.status, 404);
    assert.equal((await none.json()).state, 'no-galaxy', 'the same no-galaxy answer /galaxy gives');

    const first = await createAndRead(4242);
    assert.equal((await fetch(`${base}/board`, { headers: { 'If-None-Match': first.etag } })).status, 304);
    // /reset rebuilds the state on the SAME seed: same galaxy, same board, the tag still good.
    assert.equal((await post('/reset')).status, 200);
    assert.equal((await fetch(`${base}/board`, { headers: { 'If-None-Match': first.etag } })).status, 304);

    // A new galaxy: the buffer refreshed, a new tag, so the old one no longer earns a 304.
    const second = await createAndRead(4343);
    assert.notEqual(second.etag, first.etag);
    assert.notEqual(second.text, first.text);
    const stale = await fetch(`${base}/board`, { headers: { 'If-None-Match': first.etag } });
    assert.equal(stale.status, 200, 'a client holding the old galaxy\'s board gets the new one');
    assert.equal(await stale.text(), second.text);

    assert.equal((await post('/admin/galaxy/delete')).status, 200);
    assert.equal((await fetch(`${base}/board`)).status, 404);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
