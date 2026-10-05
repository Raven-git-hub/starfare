'use strict';

// fog.test.js — the PER-GUILD snapshot (docs/exploration-model.md §2/§3/§7, roadmap 2.5 (a) engine
// slice 1; sim/fog.js, sim/snapshot.js `buildSnapshot(state, guildId)`). The tripwires:
//
//   1. THE GOD'S-EYE LENS IS UNTOUCHED: `buildSnapshot(state)` hashes to the bytes recorded on main
//      BEFORE this slice (8c248d6) for five scripted states; a null/undefined guild is the same lens.
//   2. EVERY top-level snapshot key is classified (public / filtered) — a new key fails here until
//      somebody decides whether a player may see it.
//   3. A GUILD THAT SEES EVERYTHING sees the god's-eye bytes: in a one-guild galaxy the per-guild view,
//      minus the two keys it adds (`viewerGuildId`, `geography`), is byte-identical to the god's-eye.
//   4. THE FOG, ENUMERATED: in a two-guild galaxy the per-guild view differs from the god's-eye by
//      exactly the hidden rival facts — every public key identical, the own rows identical.
//   5. The brief's behaviours: rival stockpiles hidden / own full; an un-licensed rival node fogged; a
//      rival's lapsed venture loses the live fact but the geography stays; transports, deliveries,
//      builds, production and notices of a rival hidden; L0 for every system; the record resolved.
//   6. PURE and DETERMINISTIC: the view writes nothing, and the same (state, guildId) gives the same
//      bytes across two runs and across save/restore (invariant 9).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const A_ = require('../actions.js');
const { buildSnapshot } = require('../snapshot.js');
const {
  TOP_LEVEL, RIVAL_GUILD_FIELDS, RIVAL_VENTURE_FIELDS, RIVAL_OUTPOST_FIELDS, RIVAL_SYSTEM_LANDMARK_FIELDS,
} = require('../fog.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { checkInvariants } = require('../invariants.js');
const { guildHolds } = require('../claims.js');
const { hexDistance } = require('../transport.js');
const {
  getStarterSystems, getTerranHomeworld, getSystem, getPlanet, getSite, getSystemLayout,
  getL0Systems, isHexInBounds, seedLandmarkAtHex,
} = require('../seed.js');

const A = 'player-guild';
const B = 'bot-guild';
const A_HOME = getStarterSystems()[0].id;
const B_HOME = getStarterSystems()[1].id;
const B_PLANET = getTerranHomeworld(B_HOME);
const B_MINE = `${B_PLANET}_n01`;   // titanium (a Terran homeworld opens titanium, titanium — §2)
const B_MINE_2 = `${B_PLANET}_n02`;

const sha = (text) => createHash('sha256').update(text).digest('hex');
const bytes = (snap) => JSON.stringify(snap);
const guildOf = (s, id) => s.guilds.find((g) => g.id === id);
const rowOf = (snap, id) => snap.guilds.find((g) => g.id === id);
const tick = (s) => advance(s, []).state;

function ok(state, actions) {
  const { state: next, results } = A_.intake(state, actions);
  for (const r of results) assert.equal(r.accepted, true, `refused: ${r.reason}`);
  return next;
}

// --- 1. the god's-eye lens is byte-identical to pre-slice main ------------------------------------

// Recorded on main at 8c248d6 — BEFORE this slice's code existed — by running exactly the script in
// `godsEyeScript` below against that tree and hashing `JSON.stringify(buildSnapshot(state))` (the
// bytes GET /snapshot serves). If one of these moves, the operator lens changed: that is never a
// side effect of fog, so find out why before re-pinning.
const GODS_EYE_ON_MAIN = {
  zero: '11cef44ade7dfc79bb49e9134e985ad562e110e7d89481eec3d871fe559ed9c6',
  founded: 'f0cd62a9a0d395e5861b64d952bdb3ac39577002b9977d1d0109c699ce498ce8',
  rivalVentures: 'f5a32f09801bb1dea2b87fafc34994d1000f8a5a991ab802408379c5f3022287',
  withShipments: 'dcc22f6c2daac617a4827a654206b00fa2fdbf7985302437a251a6113273153c',
  afterClosure: 'ec36a24b48fdb0d903fcc49a69496990ae7a32a22d2b4722f0ddeb92d1dccb9a',
};

// The script those hashes came from: a bot rival with a licensed and an unlicensed mine, two buys,
// then the licensed mine closed. Returns the five named states.
function godsEyeScript() {
  const out = {};
  let s = createZeroState();
  out.zero = s;
  s = ok(s, [
    A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
    A_.createFoundGuildAction({ guildId: B, name: 'Bot', isBot: true, credits: 200000, influence: 100, homeSystemId: B_HOME }),
  ]);
  out.founded = s;
  s = ok(s, [
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_mine', siteId: B_MINE, assetId: `asset_${B}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_mine', committedOutputPct: 1, windowDays: 7 }),
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_mine_2', siteId: B_MINE_2, assetId: `asset_${B}_miner_02`, resourceType: 'titanium', productionRate: 5 }),
  ]);
  s = tick(tick(tick(s)));
  out.rivalVentures = s;
  s = ok(s, [
    A_.createAddOrderLineAction({ guildId: A, side: 'buy', good: 'titanium', qty: 5 }),
    A_.createBuyFromSyndicateAction({ guildId: A, destinationSystemId: A_HOME, issueTick: s.tick }),
    A_.createAddOrderLineAction({ guildId: B, side: 'buy', good: 'lead', qty: 5 }),
    A_.createBuyFromSyndicateAction({ guildId: B, destinationSystemId: B_HOME, issueTick: s.tick }),
  ]);
  s = tick(s);
  out.withShipments = s;
  s = ok(s, [A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]);
  out.afterClosure = tick(tick(s));
  return out;
}

test('god\'s-eye: buildSnapshot(state) is byte-identical to pre-slice main, for every scripted state', () => {
  const states = godsEyeScript();
  for (const [name, golden] of Object.entries(GODS_EYE_ON_MAIN)) {
    assert.equal(sha(bytes(buildSnapshot(states[name]))), golden, `the god's-eye bytes moved at "${name}"`);
  }
});

test('god\'s-eye: a null or undefined guild IS the god\'s-eye lens (same bytes), and carries no fog keys', () => {
  const { withShipments: s } = godsEyeScript();
  const full = bytes(buildSnapshot(s));
  assert.equal(bytes(buildSnapshot(s, null)), full);
  assert.equal(bytes(buildSnapshot(s, undefined)), full);
  const snap = buildSnapshot(s);
  assert.equal('viewerGuildId' in snap, false);
  assert.equal('geography' in snap, false);
});

test('per-guild: asking for a guild that does not exist throws — never a silent god\'s-eye fallback', () => {
  const { founded: s } = godsEyeScript();
  assert.throws(() => buildSnapshot(s, 'nobody'), /no guild with id "nobody"/);
});

// --- 2. every top-level key is classified -----------------------------------------------------------

test('classification: every god\'s-eye top-level key is public XOR filtered — a new key fails here', () => {
  const overlap = TOP_LEVEL.public.filter((k) => TOP_LEVEL.filtered.includes(k));
  assert.deepEqual(overlap, [], 'a key cannot be both');
  const classified = [...TOP_LEVEL.public, ...TOP_LEVEL.filtered].sort();
  for (const s of Object.values(godsEyeScript())) {
    assert.deepEqual(Object.keys(buildSnapshot(s)).sort(), classified,
      'the god\'s-eye snapshot gained or lost a top-level key: classify it in sim/fog.js TOP_LEVEL (public or filtered) before it reaches a player');
  }
});

// --- 3. a guild that sees everything sees the god's-eye bytes ---------------------------------------

test('one-guild galaxy: the per-guild view minus its two added keys is byte-identical to the god\'s-eye', () => {
  let s = ok(createZeroState(), [A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME })]);
  s = ok(s, [
    A_.createEstablishVentureAction({ guildId: A, ventureId: 'a_mine', siteId: `${getTerranHomeworld(A_HOME)}_n01`, assetId: `asset_${A}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: A, ventureId: 'a_mine', committedOutputPct: 1, windowDays: 7 }),
  ]);
  s = tick(tick(s));
  const { viewerGuildId, geography, ...rest } = buildSnapshot(s, A);
  assert.equal(viewerGuildId, A);
  assert.ok(geography.systems.length > 0);
  assert.equal(bytes(rest), bytes(buildSnapshot(s)), 'no rival, nothing to fog: every byte the same');
});

// --- the two-guild galaxy the fog tests read --------------------------------------------------------

// A free hex `d` from B's home (in the lattice, no seed landmark on it) for B's Outpost.
function freeHexNear(systemId, d) {
  const from = getSystem(systemId).coords;
  for (let q = from.q - d; q <= from.q + d; q += 1) {
    for (let r = from.r - d; r <= from.r + d; r += 1) {
      const hex = { q, r };
      if (hexDistance(hex, from) === d && isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) return hex;
    }
  }
  throw new Error(`no free hex at distance ${d} from ${systemId}`);
}

// Two HUMAN guilds (so both hold the starter fleet + kit). B — the rival — has: a LICENSED mine, an
// UNLICENSED mine, an Outpost, a Syndicate goods delivery in flight and an asset on order. A has a
// delivery of its own. Then three ticks, so the end-of-tick observation has run.
function rivalGalaxy() {
  let s = ok(createZeroState(), [
    A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
    A_.createFoundGuildAction({ guildId: B, name: 'Rival', credits: 2000, influence: 100, homeSystemId: B_HOME }),
  ]);
  s = ok(s, [
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_mine', siteId: B_MINE, assetId: `asset_${B}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_mine', committedOutputPct: 1, windowDays: 7 }),
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_mine_2', siteId: B_MINE_2, assetId: `asset_${B}_miner_02`, resourceType: 'titanium', productionRate: 5 }),
    A_.createSpawnOutpostAction({ guildId: B, anchorSystemId: B_HOME, coords: freeHexNear(B_HOME, 2) }),
    A_.createAddOrderLineAction({ guildId: A, side: 'buy', good: 'titanium', qty: 5 }),
    A_.createBuyFromSyndicateAction({ guildId: A, destinationSystemId: A_HOME, issueTick: 0 }),
    A_.createAddOrderLineAction({ guildId: B, side: 'buy', good: 'lead', qty: 5 }),
    A_.createBuyFromSyndicateAction({ guildId: B, destinationSystemId: B_HOME, issueTick: 0 }),
    A_.createAdjustCreditsAction({ guildId: B, delta: 10_000_000 }), // operator lever: a miner costs more than the starter credits
    A_.createBuyAssetFromSyndicateAction({ guildId: B, assetKind: 'miner', destinationSystemId: B_HOME, issueTick: 0 }),
  ]);
  return tick(tick(tick(s)));
}

test('the rival galaxy fixture really holds every kind of rival fact the fog must hide', () => {
  const s = rivalGalaxy();
  const full = buildSnapshot(s);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  assert.ok(Object.keys(rowOf(full, B).stockpilesBySystem).length > 0, 'B holds stockpiles');
  assert.ok(rowOf(full, B).vehicles.length > 0, 'B owns transports');
  assert.ok(full.ventures.some((v) => v.id === 'b_mine' && v.licence), 'B has a licensed venture');
  assert.ok(full.ventures.some((v) => v.id === 'b_mine_2' && !v.licence), 'B has an unlicensed venture');
  assert.ok(full.outposts.some((o) => o.ownerGuildId === B), 'B has an Outpost');
  assert.ok(full.shipments.some((x) => x.ownerGuildId === B), 'B has a delivery in flight');
  assert.ok(full.shipments.some((x) => x.ownerGuildId === A), 'A has a delivery in flight');
  assert.ok(full.syndicateBuilds.some((b) => b.ownerGuildId === B), 'B has an asset on order');
  assert.ok(full.production.some((p) => p.guildId === B), 'B has a production preview');
});

// --- 4. the fog, enumerated -------------------------------------------------------------------------

test('THE FOG, ENUMERATED: the per-guild view differs from the god\'s-eye by exactly the hidden rival facts', () => {
  const s = rivalGalaxy();
  const full = buildSnapshot(s);
  const view = buildSnapshot(s, A);
  const pick = (row, fields) => Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]]));

  // The view's keys: every god's-eye key, in the same order, then the two it adds.
  assert.deepEqual(Object.keys(view), [...Object.keys(full), 'viewerGuildId', 'geography']);

  // PUBLIC keys: byte-identical.
  for (const key of TOP_LEVEL.public) assert.equal(bytes(view[key]), bytes(full[key]), `public key ${key} moved`);

  // guilds: A's own row identical; B's row cut to exactly the allow-list, values unchanged.
  assert.equal(bytes(rowOf(view, A)), bytes(rowOf(full, A)), 'A sees its own row in full');
  assert.deepEqual(rowOf(view, B), pick(rowOf(full, B), RIVAL_GUILD_FIELDS));
  assert.deepEqual(Object.keys(rowOf(view, B)), ['id', 'name', 'isBot', 'homeSystemId']);

  // ventures: A's own rows identical; of B's, ONLY the licensed one, cut to its public facts.
  const own = full.ventures.filter((v) => v.ownerGuildId === A);
  assert.equal(bytes(view.ventures.filter((v) => v.ownerGuildId === A)), bytes(own));
  const rival = view.ventures.filter((v) => v.ownerGuildId === B);
  assert.deepEqual(rival.map((v) => v.id), ['b_mine'], 'only the licensed rival venture is visible');
  assert.deepEqual(rival[0], {
    ...pick(full.ventures.find((v) => v.id === 'b_mine'), RIVAL_VENTURE_FIELDS),
    planetArchetype: getPlanet(B_PLANET).archetype,
  });

  // occupancy: exactly the visible ventures' sites.
  const visibleIds = new Set(view.ventures.map((v) => v.id));
  assert.deepEqual(view.occupancy, Object.fromEntries(Object.entries(full.occupancy).filter(([, vid]) => visibleIds.has(vid))));
  assert.equal(B_MINE_2 in view.occupancy, false);

  // outposts: B's cut to where-and-whose; A's (none here) would be in full.
  for (const o of view.outposts) {
    const fo = full.outposts.find((x) => x.id === o.id);
    assert.deepEqual(o, o.ownerGuildId === A ? fo : pick(fo, RIVAL_OUTPOST_FIELDS));
  }
  assert.equal(view.outposts.length, full.outposts.length, 'every structure is still on the map');

  // claims: every row kept, in order; a RIVAL system claim's resolved landmark cut to L0, all else identical.
  assert.equal(view.claims.length, full.claims.length, 'ownership is public: every claim is still there');
  view.claims.forEach((c, i) => {
    const fc = full.claims[i];
    if (fc.ownerGuildId !== A && fc.landmarkKind === 'system') {
      assert.deepEqual(c, { ...fc, landmark: pick(fc.landmark, RIVAL_SYSTEM_LANDMARK_FIELDS) });
    } else {
      assert.equal(bytes(c), bytes(fc), `claim ${fc.claimId} is passed through untouched`);
    }
  });

  // shipments / builds / production / attention: A's own only, rows identical.
  assert.equal(bytes(view.shipments), bytes(full.shipments.filter((x) => x.ownerGuildId === A)));
  assert.equal(bytes(view.syndicateBuilds), bytes(full.syndicateBuilds.filter((b) => b.ownerGuildId === A)));
  assert.equal(bytes(view.production), bytes(full.production.filter((p) => p.guildId === A)));
  assert.equal(bytes(view.attention), bytes({
    renegotiations: full.attention.renegotiations.filter((r) => r.guildId === A),
    notices: full.attention.notices.filter((n) => n.guildId === A),
  }));
});

// --- 5. the brief's behaviours ------------------------------------------------------------------------

test('rival STOCKPILES are hidden; the viewing guild\'s own stockpiles are in full', () => {
  const s = rivalGalaxy();
  const full = buildSnapshot(s);
  const view = buildSnapshot(s, A);
  for (const key of ['stockpiles', 'stockpilesBySystem', 'credits', 'fuelHoard', 'assets', 'productionProfile']) {
    assert.equal(key in rowOf(view, B), false, `rival ${key} must not be in A's view`);
  }
  assert.deepEqual(rowOf(view, A).stockpiles, rowOf(full, A).stockpiles);
  assert.deepEqual(rowOf(view, A).stockpilesBySystem, rowOf(full, A).stockpilesBySystem);
  // Not even the rival's licensed venture leaks its holdings: no production rate, no licence terms.
  const bm = view.ventures.find((v) => v.id === 'b_mine');
  for (const key of ['productionRate', 'licence', 'batchCarry', 'reputation', 'teardownSettlement']) {
    assert.equal(key in bm, false, `a rival venture's ${key} is operations, not the public register`);
  }
  // And B's view is the mirror image: its own stockpiles, none of A's.
  const bView = buildSnapshot(s, B);
  assert.deepEqual(rowOf(bView, B).stockpilesBySystem, rowOf(full, B).stockpilesBySystem);
  assert.equal('stockpilesBySystem' in rowOf(bView, A), false);
});

test('rival TRANSPORTS are never shown: no vehicles on the rival row, no rival craft in any dock', () => {
  const s = rivalGalaxy();
  const view = buildSnapshot(s, A);
  assert.equal('vehicles' in rowOf(view, B), false);
  const bVehicleIds = guildOf(s, B).vehicles.map((v) => v.id);
  assert.ok(bVehicleIds.length > 0);
  const text = bytes(view);
  for (const id of bVehicleIds) assert.equal(text.includes(id), false, `rival craft ${id} appears somewhere in A's view`);
  for (const o of view.outposts.filter((x) => x.ownerGuildId === B)) {
    assert.equal('queue' in o || 'slots' in o || 'stockpile' in o, false, 'a rival dock is operations');
  }
});

test('an UN-LICENSED rival node stays fogged: in no rival-visible list, and written to no record', () => {
  const s = rivalGalaxy();
  const view = buildSnapshot(s, A);
  assert.equal(view.ventures.some((v) => v.id === 'b_mine_2'), false, 'not in ventures');
  assert.equal(B_MINE_2 in view.occupancy, false, 'not in occupancy');
  assert.equal(bytes(view).includes(B_MINE_2), false, 'its node id appears nowhere in A\'s view');
  assert.equal(guildOf(s, A).exploration[B_PLANET].nodes[B_MINE_2], undefined, 'and A\'s record never learned it');
});

test('THE MARQUEE: a rival\'s lapsed venture loses the live fact but the geography stays', () => {
  let s = rivalGalaxy();
  // Licensed and observed: A's view shows the venture TYPE live, and the node's geography from the record.
  let view = buildSnapshot(s, A);
  const live = view.ventures.find((v) => v.id === 'b_mine');
  assert.equal(live.type, 'mining', 'the venture type is on the public register');
  assert.equal(live.planetArchetype, getPlanet(B_PLANET).archetype, 'with its planet\'s archetype');
  assert.equal(live.site.resourceType, 'titanium', 'and its node\'s type');
  assert.equal(view.occupancy[B_MINE], 'b_mine');
  assert.deepEqual(view.geography.known[B_HOME][B_PLANET].nodes, { [B_MINE]: 'titanium' });
  assert.equal(guildOf(s, A).exploration[B_PLANET].nodes[B_MINE], 1, 'learned at the end of the first tick');

  // B closes it. Two ticks later the live fact is gone; the geographic fact is not.
  s = ok(s, [A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]);
  s = tick(tick(s));
  view = buildSnapshot(s, A);
  assert.equal(view.ventures.some((v) => v.id === 'b_mine'), false, 'the venture is gone from the view');
  assert.equal(B_MINE in view.occupancy, false, 'and from occupancy');
  assert.deepEqual(view.geography.known[B_HOME][B_PLANET], { archetype: getPlanet(B_PLANET).archetype, nodes: { [B_MINE]: 'titanium' } },
    'but A still knows node and planet');
  assert.equal(guildOf(s, A).exploration[B_PLANET].nodes[B_MINE], 1, 'and the record still holds it, first tick and all');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a rival\'s deliveries, builds, production and notices are not in the view; your own are', () => {
  let s = rivalGalaxy();
  s = ok(s, [A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]); // B gets a notice
  const full = buildSnapshot(s);
  const view = buildSnapshot(s, A);
  assert.ok(full.attention.notices.some((n) => n.guildId === B), 'B really has a notice');
  assert.equal(view.attention.notices.some((n) => n.guildId === B), false);
  assert.ok(view.shipments.length > 0 && view.shipments.every((x) => x.ownerGuildId === A), 'A\'s own delivery is shown');
  assert.equal(view.syndicateBuilds.some((b) => b.ownerGuildId === B), false);
  assert.deepEqual(view.production.map((p) => p.guildId), [A]);
});

test('rival OUTPOSTS stay on the map — where and whose — and every CLAIM (the controllers) stays public', () => {
  const s = rivalGalaxy();
  const full = buildSnapshot(s);
  const view = buildSnapshot(s, A);
  const bo = view.outposts.find((o) => o.ownerGuildId === B);
  assert.deepEqual(Object.keys(bo), ['id', 'ownerGuildId', 'coords', 'anchorSystemId']);
  // Who holds what is public: the same claim ids, owners and landmarks, waystations and Citadel included.
  const ownership = (snap) => snap.claims.map((c) => [c.claimId, c.ownerGuildId, c.landmarkKind, c.landmarkId]);
  assert.deepEqual(ownership(view), ownership(full));
  // But B's home claim no longer resolves B's homeworld: its landmark is L0 only.
  const bHome = view.claims.find((c) => c.ownerGuildId === B && c.landmarkKind === 'system');
  assert.deepEqual(Object.keys(bHome.landmark), ['id', 'kind', 'name', 'coords']);
  // While A's own home claim keeps the full landmark (its home is known in full anyway).
  const aHome = view.claims.find((c) => c.ownerGuildId === A && c.landmarkKind === 'system');
  assert.equal(aHome.landmark.terranHomeworldId, getTerranHomeworld(A_HOME));
});

test('a rival system\'s interior planet ids appear NOWHERE in the view until the guild learns them', () => {
  // Founded, no rival venture yet: A has learned nothing about B's home beyond L0.
  const { founded: s } = godsEyeScript();
  const text = bytes(buildSnapshot(s, A));
  for (const planet of getSystemLayout(B_HOME).planets) {
    assert.equal(text.includes(`"${planet.id}`), false, `B's planet ${planet.id} leaks into A's view (an id is L1 here)`);
  }
  assert.ok(bytes(buildSnapshot(s)).includes(`"${B_PLANET}"`), 'the god\'s-eye lens does carry it — so this test can fail');
});

test('geography: L0 for EVERY system (position, planet count, controller) — never fogged', () => {
  const s = rivalGalaxy();
  const { systems } = buildSnapshot(s, A).geography;
  assert.equal(systems.length, getL0Systems().length);
  assert.deepEqual(systems.map((x) => x.id), [...systems.map((x) => x.id)].sort(), 'id order (stable bytes)');
  for (const row of systems) {
    assert.deepEqual(Object.keys(row), ['id', 'name', 'coords', 'planetCount', 'controllerGuildId']);
    assert.equal(row.planetCount, getSystemLayout(row.id).planets.length);
    assert.deepEqual(row.coords, getSystem(row.id).coords);
  }
  const byId = Object.fromEntries(systems.map((x) => [x.id, x]));
  assert.equal(byId[A_HOME].controllerGuildId, A);
  assert.equal(byId[B_HOME].controllerGuildId, B, 'the rival\'s ownership is public');
  for (const row of systems) {
    if (row.controllerGuildId) assert.ok(guildHolds(s, row.controllerGuildId, row.id), 'controller agrees with guildHolds');
  }
  // L0 rows carry no geography: no archetype, no ring, no starter flag (each would leak L1).
  assert.equal(bytes(systems).includes('archetype'), false);
});

test('geography: `known` is exactly the record, resolved through the seed — and nothing more', () => {
  const s = rivalGalaxy();
  const { known } = buildSnapshot(s, A).geography;
  const rec = guildOf(s, A).exploration;
  const flat = {};
  for (const [systemId, planets] of Object.entries(known)) {
    for (const [planetId, entry] of Object.entries(planets)) {
      assert.equal(getPlanet(planetId).systemId, systemId);
      assert.equal(entry.archetype, getPlanet(planetId).archetype);
      for (const [nodeId, type] of Object.entries(entry.nodes)) assert.equal(type, getSite(nodeId).resourceType);
      flat[planetId] = Object.keys(entry.nodes).sort();
    }
  }
  assert.deepEqual(Object.keys(flat).sort(), Object.keys(rec).sort(), 'the same planets as the record');
  for (const planetId of Object.keys(rec)) assert.deepEqual(flat[planetId], Object.keys(rec[planetId].nodes).sort());
  // A knows its home fully, one rival planet partially (one node), and no other rival planet.
  assert.deepEqual(Object.keys(known).sort(), [A_HOME, B_HOME].sort());
  assert.deepEqual(Object.keys(known[B_HOME]), [B_PLANET]);
});

// --- 6. pure and deterministic ----------------------------------------------------------------------

test('the per-guild view is PURE: building it writes nothing (in particular, not the record)', () => {
  const s = rivalGalaxy();
  const before = hashState(s);
  buildSnapshot(s, A);
  buildSnapshot(s, B);
  assert.equal(hashState(s), before);
});

test('determinism: the same (state, guildId) gives the same bytes across two runs and across save/restore', (t) => {
  const a = rivalGalaxy();
  const b = rivalGalaxy();
  assert.equal(bytes(buildSnapshot(a, A)), bytes(buildSnapshot(b, A)));
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'fog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveState(a, dir);
  const restored = loadOrInit(dir, () => { throw new Error('a saved state must load'); });
  assert.equal(hashState(restored), hashState(a), 'the state (record included) restores byte-identically');
  // Compared CANONICALLY (sorted keys) across the restore: the save writes canonical JSON, so a stored
  // object the god's-eye lens echoes as-is (a craft's `location`) comes back with its keys in sorted
  // order. That is a pre-existing property of the god's-eye rows, not of fog — same content, and
  // `buildSnapshot(restored)` with no guild shows it too.
  for (const g of [A, B]) {
    assert.equal(canonicalStringify(buildSnapshot(restored, g)), canonicalStringify(buildSnapshot(a, g)), `${g}'s view survives restore`);
  }
});
