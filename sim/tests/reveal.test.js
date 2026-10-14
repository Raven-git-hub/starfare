'use strict';

// reveal.test.js — the operator `reveal` lever (docs/operator-adjust.md §3.7; roadmap 2.5, the CLI fog
// tooling). The first KNOWLEDGE lever: it writes a guild's exploration record and nothing else. The
// tripwires:
//
//   1. THE THREE FORMS: a system reveal is every planet at full L2 (archetype + every node + every slot,
//      as founding does); `l1: true` is every planet's archetype and NO surface (as an L1 scan does); a
//      planet reveal is that one planet at L2 and no sibling (as an L2 scan does).
//   2. LEARN-ONCE / IDEMPOTENT: a repeat reveal is ACCEPTED and changes not one byte; widening L1 to L2
//      adds the surface and leaves the planets on their L1 tick.
//   3. FAIL-LOUD: an unknown guild, system or planet, both targets, no target, a bad `l1`, and `l1` on a
//      planet are each a REFUSED action with its own reason — never a silent no-op — and state is untouched.
//   4. THE TICK: every fact the reveal adds is stamped with the tick it was applied on (§15.2).
//   5. INVARIANT-NEUTRAL: the reveal moves nothing — the whole state, less the guild's own record, is
//      byte-identical (galacticSupply, the ledger and the audit among it); the god's-eye lens is
//      byte-identical; the nine invariants stay clean.
//   6. THE FOG STILL FOGS (headless, over the real server): POST /action a reveal, then GET
//      /snapshot?guild=<id> shows it in that guild's `known`, while a second guild's view shows none of it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { intake, createFoundGuildAction, createRevealAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { makeServer } = require('../server.js');
const { getStarterSystems, getSystemLayout } = require('../seed.js');

// Two guilds on the seed's first two starter systems. Every id below is DERIVED from the seed.
const A = 'player-guild';
const B = 'bot-guild';
const A_HOME = getStarterSystems()[0].id;
const B_HOME = getStarterSystems()[1].id;

// The frontier: the first OTHER starter system with at least three planets, so a planet reveal has
// siblings to leave unknown. Nobody claims it, so no view shows it live (sim/fog.js shows a CONTROLLED
// system to everyone) — whatever a guild knows of it came from its own record.
const FRONTIER = getStarterSystems().slice(2).map((s) => s.id).find((id) => getSystemLayout(id).planets.length >= 3);
const FRONTIER_PLANETS = getSystemLayout(FRONTIER).planets;
// A planet with both kinds of surface, so a planet reveal proves nodes AND slots.
const FRONTIER_PLANET = FRONTIER_PLANETS.find((p) => p.resourceNodes.length > 0 && p.settlementSlots.length > 0);

const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
// One tick with no actions (advance asserts every invariant on the way).
const tickOnce = (s) => advance(s).state;

// Found A and B through `intake` (the POST /action drain) at tick 0.
function twoGuilds() {
  const { state, results } = intake(createZeroState(), [
    createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
    createFoundGuildAction({ guildId: B, name: 'Bot', isBot: true, credits: 200000, influence: 100, homeSystemId: B_HOME }),
  ]);
  for (const r of results) assert.equal(r.accepted, true, `founding refused: ${r.reason}`);
  return state;
}

// Apply one action through intake (no tick), exactly as POST /action applies it.
function apply(state, action) {
  const { state: next, results } = intake(state, [action]);
  return { next, result: results[0] };
}

// The record entry a planet SHOULD have at full L2, straight from the seed's layout.
function fullEntry(planet, tick) {
  const nodes = {};
  for (const n of planet.resourceNodes) nodes[n.id] = tick;
  const slots = {};
  for (const s of planet.settlementSlots) slots[s.id] = tick;
  return { tick, nodes, slots };
}

// The whole state with the named guild's exploration record taken out — what must NOT move.
function withoutRecord(state, guildId) {
  const copy = structuredClone(state);
  delete guildOf(copy, guildId).exploration;
  return canonicalStringify(copy);
}

// --- the constructor -----------------------------------------------------------

test('createRevealAction requires guildId and passes on only the fields it was given', () => {
  assert.throws(() => createRevealAction({ systemId: FRONTIER }), /guildId is required/);
  assert.deepEqual(createRevealAction({ guildId: A, systemId: FRONTIER }), { type: 'reveal', guildId: A, systemId: FRONTIER });
  assert.deepEqual(
    createRevealAction({ guildId: A, systemId: FRONTIER, l1: true }),
    { type: 'reveal', guildId: A, systemId: FRONTIER, l1: true },
  );
  assert.deepEqual(
    createRevealAction({ guildId: A, planetId: FRONTIER_PLANET.id }),
    { type: 'reveal', guildId: A, planetId: FRONTIER_PLANET.id },
  );
});

// --- the three forms ---------------------------------------------------------------

test('a SYSTEM reveal knows every planet of the system at full L2 — archetype, every node, every slot', () => {
  const s = twoGuilds();
  const { next, result } = apply(s, createRevealAction({ guildId: A, systemId: FRONTIER }));
  assert.equal(result.accepted, true, result.reason);
  const record = guildOf(next, A).exploration;
  for (const planet of FRONTIER_PLANETS) {
    assert.deepEqual(record[planet.id], fullEntry(planet, next.tick), `planet ${planet.id} at full L2`);
  }
  // Nothing else was learned: the record is the founding record plus exactly this system's planets.
  const before = Object.keys(guildOf(s, A).exploration);
  assert.deepEqual(
    Object.keys(record).sort(),
    [...before, ...FRONTIER_PLANETS.map((p) => p.id)].sort(),
  );
});

test('an L1 reveal knows every planet\'s ARCHETYPE and no surface — no node, no slot', () => {
  const s = twoGuilds();
  const { next, result } = apply(s, createRevealAction({ guildId: A, systemId: FRONTIER, l1: true }));
  assert.equal(result.accepted, true, result.reason);
  const record = guildOf(next, A).exploration;
  for (const planet of FRONTIER_PLANETS) {
    assert.deepEqual(record[planet.id], { tick: next.tick, nodes: {}, slots: {} }, `planet ${planet.id} at L1 only`);
  }
  // And the view draws them that way: archetypes, empty surfaces.
  const known = buildSnapshot(next, A).geography.known[FRONTIER];
  for (const planet of FRONTIER_PLANETS) {
    assert.deepEqual(known[planet.id], { archetype: planet.archetype, nodes: {}, slots: {} });
  }
});

test('a PLANET reveal knows that one planet at L2 — and none of its siblings', () => {
  const s = twoGuilds();
  const { next, result } = apply(s, createRevealAction({ guildId: A, planetId: FRONTIER_PLANET.id }));
  assert.equal(result.accepted, true, result.reason);
  const record = guildOf(next, A).exploration;
  assert.deepEqual(record[FRONTIER_PLANET.id], fullEntry(FRONTIER_PLANET, next.tick));
  for (const planet of FRONTIER_PLANETS) {
    if (planet.id !== FRONTIER_PLANET.id) assert.equal(record[planet.id], undefined, `sibling ${planet.id} stays unknown`);
  }
  assert.deepEqual(Object.keys(buildSnapshot(next, A).geography.known[FRONTIER]), [FRONTIER_PLANET.id]);
});

// --- learn-once / idempotent ---------------------------------------------------------

test('IDEMPOTENT: a repeat reveal is accepted and changes not one byte — even a tick later', () => {
  const s = twoGuilds();
  const once = apply(s, createRevealAction({ guildId: A, systemId: FRONTIER })).next;
  const later = tickOnce(once); // a tick on, so a re-stamp would show
  for (const action of [
    createRevealAction({ guildId: A, systemId: FRONTIER }),
    createRevealAction({ guildId: A, systemId: FRONTIER, l1: true }),
    createRevealAction({ guildId: A, planetId: FRONTIER_PLANET.id }),
  ]) {
    const { next, result } = apply(later, action);
    assert.equal(result.accepted, true, `a repeat ${JSON.stringify(action)} is still accepted`);
    assert.equal(canonicalStringify(next), canonicalStringify(later), `and adds nothing: ${JSON.stringify(action)}`);
  }
});

test('LEARN-ONCE: widening L1 to a full reveal adds the surface, and the planets keep their L1 tick', () => {
  const s = twoGuilds();
  const l1 = apply(s, createRevealAction({ guildId: A, systemId: FRONTIER, l1: true })).next;
  const l1Tick = l1.tick;
  const later = tickOnce(tickOnce(l1));
  const { next, result } = apply(later, createRevealAction({ guildId: A, systemId: FRONTIER }));
  assert.equal(result.accepted, true, result.reason);
  const record = guildOf(next, A).exploration;
  for (const planet of FRONTIER_PLANETS) {
    const entry = fullEntry(planet, next.tick);
    entry.tick = l1Tick; // the archetype was learned at L1, and knowing it again is not learning it
    assert.deepEqual(record[planet.id], entry, `planet ${planet.id}`);
  }
});

// --- fail-loud: every bad reveal is REFUSED, and state is untouched -----------------------------

test('a bad reveal is REFUSED with its own reason, and state is untouched', () => {
  const s = twoGuilds();
  const cases = [
    [{ type: 'reveal', guildId: 'nobody', systemId: FRONTIER }, /no guild with id "nobody"/],
    [{ type: 'reveal', guildId: A, systemId: 'sys_9999999' }, /system "sys_9999999" is not a system on the seed/],
    [{ type: 'reveal', guildId: A, planetId: 'pl_9999999' }, /planet "pl_9999999" is not a planet on the seed/],
    [{ type: 'reveal', guildId: A, systemId: 42 }, /system 42 is not a system on the seed/],
    [{ type: 'reveal', guildId: A, systemId: FRONTIER, planetId: FRONTIER_PLANET.id }, /exactly one target .* not both/],
    [{ type: 'reveal', guildId: A }, /exactly one target/],
    [{ type: 'reveal', guildId: A, systemId: null, planetId: null }, /exactly one target/],
    [{ type: 'reveal', guildId: A, systemId: FRONTIER, l1: 'yes' }, /l1 must be true or false/],
    [{ type: 'reveal', guildId: A, planetId: FRONTIER_PLANET.id, l1: true }, /l1 is for a system reveal only/],
  ];
  const bytes = canonicalStringify(s);
  for (const [action, reason] of cases) {
    const { next, result } = apply(s, action);
    assert.equal(result.accepted, false, `${JSON.stringify(action)} must be refused`);
    assert.match(result.reason, reason, JSON.stringify(action));
    assert.equal(canonicalStringify(next), bytes, `a refused ${JSON.stringify(action)} leaves state untouched`);
  }
});

// --- the tick -------------------------------------------------------------------------------

test('THE TICK: every fact a reveal adds is stamped with the tick it was applied on', () => {
  let s = twoGuilds();
  for (let i = 0; i < 3; i += 1) s = tickOnce(s);
  assert.equal(s.tick, 3, 'a few ticks in, so the stamp cannot be a coincidental 0');
  const { next } = apply(s, createRevealAction({ guildId: A, systemId: FRONTIER }));
  const record = guildOf(next, A).exploration;
  for (const planet of FRONTIER_PLANETS) {
    const entry = record[planet.id];
    assert.equal(entry.tick, 3, `planet ${planet.id}`);
    for (const t of [...Object.values(entry.nodes), ...Object.values(entry.slots)]) assert.equal(t, 3);
  }
  // The founding facts keep the founding tick.
  assert.equal(record[getSystemLayout(A_HOME).planets[0].id].tick, 0);
});

// --- invariant-neutral ------------------------------------------------------------------------

test('INVARIANT-NEUTRAL: a reveal moves nothing — state less the record, the god\'s-eye lens, and the invariants', () => {
  let s = twoGuilds();
  s = tickOnce(s); // a ticked galaxy, so supply and prices carry real values
  for (const action of [
    createRevealAction({ guildId: A, systemId: FRONTIER }),
    createRevealAction({ guildId: A, systemId: FRONTIER, l1: true }),
    createRevealAction({ guildId: A, planetId: FRONTIER_PLANET.id }),
  ]) {
    const { next, result } = apply(s, action);
    assert.equal(result.accepted, true, result.reason);
    // The record DID change…
    assert.notEqual(canonicalStringify(guildOf(next, A).exploration), canonicalStringify(guildOf(s, A).exploration));
    // …and nothing else did: not one byte of the state outside A's record.
    assert.equal(withoutRecord(next, A), withoutRecord(s, A), `only the record moved: ${JSON.stringify(action)}`);
    // Named explicitly, the quantities the invariants conserve.
    assert.equal(canonicalStringify(next.galacticSupply), canonicalStringify(s.galacticSupply), 'galacticSupply');
    assert.equal(next.syndicate.ledger, s.syndicate.ledger, 'the ledger');
    assert.equal(canonicalStringify(next.audit), canonicalStringify(s.audit), 'the audit');
    // The god's-eye lens carries no record, so it does not move a byte either.
    assert.equal(JSON.stringify(buildSnapshot(next)), JSON.stringify(buildSnapshot(s)), 'the god\'s-eye snapshot');
    assert.deepEqual(checkInvariants(next), [], 'the nine invariants stay clean');
  }
});

// --- the headless round-trip: the fog still fogs -----------------------------------------------------
// The fog-route harness (tests/fog-route.test.js): the real server, POST /action, GET /snapshot?guild=.

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

test('HEADLESS: POST /action reveal → that guild\'s GET /snapshot?guild= knows it; a second guild\'s view does not', async () => {
  await req('POST', '/reset');
  for (const [guildId, homeSystemId] of [[A, A_HOME], [B, B_HOME]]) {
    const { body } = await req('POST', '/action', { type: 'foundGuild', guildId, credits: 2000, influence: 100, homeSystemId });
    assert.equal(body.accepted, true, body.reason);
  }
  // Before: neither guild knows the frontier.
  assert.equal((await req('GET', `/snapshot?guild=${A}`)).body.geography.known[FRONTIER], undefined);

  const revealed = await req('POST', '/action', { type: 'reveal', guildId: A, systemId: FRONTIER });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.accepted, true, revealed.body.reason);

  // A's view: every planet of the frontier, its archetype and its whole surface.
  const mine = (await req('GET', `/snapshot?guild=${A}`)).body.geography.known[FRONTIER];
  assert.deepEqual(Object.keys(mine), FRONTIER_PLANETS.map((p) => p.id).sort());
  for (const planet of FRONTIER_PLANETS) {
    assert.equal(mine[planet.id].archetype, planet.archetype);
    assert.deepEqual(Object.keys(mine[planet.id].nodes), planet.resourceNodes.map((n) => n.id).sort());
    assert.deepEqual(Object.keys(mine[planet.id].slots), planet.settlementSlots.map((x) => x.id).sort());
  }

  // B's view: none of it — B's `known` is only the ground it would know anyway (both homes, held).
  const theirs = (await req('GET', `/snapshot?guild=${B}`)).body.geography.known;
  assert.equal(theirs[FRONTIER], undefined, 'the second guild still knows nothing of the frontier');
  assert.deepEqual(Object.keys(theirs).sort(), [A_HOME, B_HOME].sort());

  // A bad reveal over the wire is a refusal (200, accepted:false), not a 500.
  const bad = await req('POST', '/action', { type: 'reveal', guildId: A, planetId: 'pl_9999999' });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.accepted, false);
  assert.match(bad.body.reason, /not a planet on the seed/);
});

test('the fixtures are what they claim: a frontier of 3+ planets nobody founded on, and a planet with nodes and slots', () => {
  assert.ok(FRONTIER && FRONTIER !== A_HOME && FRONTIER !== B_HOME);
  assert.ok(FRONTIER_PLANETS.length >= 3);
  assert.ok(FRONTIER_PLANET.resourceNodes.length > 0 && FRONTIER_PLANET.settlementSlots.length > 0);
});
