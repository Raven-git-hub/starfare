'use strict';

// fog.test.js — the PER-GUILD snapshot (docs/exploration-model.md §2/§3/§7, roadmap 2.5 (a) engine
// slice 1; sim/fog.js, sim/snapshot.js `buildSnapshot(state, guildId)`). The tripwires:
//
//   1. THE GOD'S-EYE LENS IS UNTOUCHED: `buildSnapshot(state)` hashes to the bytes recorded on main
//      BEFORE this slice (8c248d6) for five scripted states; a null/undefined guild is the same lens.
//   2. EVERY top-level snapshot key is classified (public / filtered) — a new key fails here until
//      somebody decides whether a player may see it.
//   3. A GUILD THAT SEES EVERYTHING sees the god's-eye bytes: in a one-guild galaxy the per-guild view,
//      minus the two keys it adds (`viewerGuildId`, `geography`), is byte-identical to the god's-eye —
//      except the two galaxy-wide aggregate blocks, which are coarsened for EVERY viewer (ruling 1).
//   4. THE FOG, ENUMERATED: in a two-guild galaxy the per-guild view differs from the god's-eye by
//      exactly the hidden rival facts — every public key identical, the own rows identical.
//   5. The brief's behaviours: rival stockpiles hidden / own full; an un-licensed rival node fogged; a
//      rival's lapsed venture loses the live fact but the geography stays; transports, deliveries,
//      builds, production and notices of a rival hidden; L0 for every system; the record resolved.
//   7. The three RULINGS of 06-10-26 (the design room, on PR #167):
//      (1) the galaxy-wide aggregates are coarsened to posted values, so a rival's stockpile, fuel hoard
//          and credits are NOT derivable from the view (perturb them: the view does not move a byte);
//      (2) a rival LICENSED venture shows its reputation, and still not its terms or recipe;
//      (3) a node lockout shows only on a node the viewer knows or on ground it controls.
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
  GALAXY_FUEL_FIELDS,
} = require('../fog.js');
const { computeGalacticSupply } = require('../supply.js');
const { addStock } = require('../stock.js');
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

test('one-guild galaxy: the per-guild view minus its two added keys is the god\'s-eye, aggregates coarsened', () => {
  let s = ok(createZeroState(), [A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME })]);
  s = ok(s, [
    A_.createEstablishVentureAction({ guildId: A, ventureId: 'a_mine', siteId: `${getTerranHomeworld(A_HOME)}_n01`, assetId: `asset_${A}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: A, ventureId: 'a_mine', committedOutputPct: 1, windowDays: 7 }),
  ]);
  s = tick(tick(s));
  const { viewerGuildId, geography, ...rest } = buildSnapshot(s, A);
  assert.equal(viewerGuildId, A);
  assert.ok(geography.systems.length > 0);
  // No rival, nothing to fog — EXCEPT the galaxy-wide aggregates, which are coarsened for every viewer
  // (ruling 1, 06-10-26): the view's shape never depends on how many rivals there are. Put the two
  // coarsened blocks into the god's-eye object and every other byte must be the same.
  const full = buildSnapshot(s);
  const expected = {
    ...full,
    galacticSupply: { fuel: Object.fromEntries(GALAXY_FUEL_FIELDS.map((f) => [f, full.galacticSupply.fuel[f]])) },
    syndicate: {},
  };
  assert.equal(bytes(rest), bytes(expected), 'every byte the same, bar the two coarsened aggregate blocks');
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

  // galacticSupply / syndicate: coarsened to the posted values (ruling 1) — no Σ-of-every-guild total.
  assert.deepEqual(view.galacticSupply, { fuel: pick(full.galacticSupply.fuel, GALAXY_FUEL_FIELDS) });
  assert.deepEqual(Object.keys(view.galacticSupply.fuel), ['reserve', 'fuelPrice', 'avgDraw', 'targetReserve']);
  assert.deepEqual(view.syndicate, {}, 'the ledger encodes Σ guild credits; the row has no other field');

  // nodeLockouts: a subset of the god's-eye rows, each unchanged (ruling 3 — see its own test).
  for (const l of view.nodeLockouts) assert.ok(full.nodeLockouts.some((fl) => bytes(fl) === bytes(l)));

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
  // (Its `reputation` IS public — ruling 2, 06-10-26 — and has its own test below.)
  const bm = view.ventures.find((v) => v.id === 'b_mine');
  for (const key of ['productionRate', 'licence', 'batchCarry', 'teardownSettlement']) {
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

// --- 7. the three rulings of 06-10-26 ------------------------------------------------------------------

// Three honest perturbations of the RIVAL's private numbers, each keeping the invariants exact: goods
// added to its stockpile (the supply cache refreshed), fuel minted into its hoard (recorded as
// produced, invariant 1), credits moved ledger → rival (invariant 2). Each returns a fresh state.
const PERTURB_RIVAL = {
  stockpile: (s) => {
    const p = structuredClone(s);
    addStock(guildOf(p, B), B_HOME, 'titanium', 1000);
    p.galacticSupply = computeGalacticSupply(p);
    return p;
  },
  fuelHoard: (s) => {
    const p = structuredClone(s);
    guildOf(p, B).fuelHoard += 500;
    p.audit.totalProduced += 500;
    p.galacticSupply = computeGalacticSupply(p);
    return p;
  },
  credits: (s) => {
    const p = structuredClone(s);
    guildOf(p, B).credits += 1_000_000;
    p.syndicate.ledger -= 1_000_000;
    return p;
  },
};

test('RULING 1: a rival\'s stockpile, fuel hoard and credits are NOT derivable from the viewer\'s view', () => {
  const s = rivalGalaxy();
  const view = bytes(buildSnapshot(s, A));
  for (const [what, perturb] of Object.entries(PERTURB_RIVAL)) {
    const p = perturb(s);
    assert.deepEqual(checkInvariants(p, p.tick), [], `the ${what} perturbation is an honest state`);
    // The operator lens DOES see the change — so this test can fail…
    assert.notEqual(bytes(buildSnapshot(p)), bytes(buildSnapshot(s)), `the god's-eye lens shows B's ${what} moving`);
    // …and the viewer's lens does not move a single byte: nothing in it is a function of B's ${what}.
    assert.equal(bytes(buildSnapshot(p, A)), view, `A's view changed when only B's ${what} did — it leaks`);
  }
});

test('RULING 1: the aggregates are coarsened, not removed — the posted price and the pool stay public', () => {
  const s = rivalGalaxy();
  const full = buildSnapshot(s);
  const { galacticSupply, syndicate } = buildSnapshot(s, A);
  assert.equal('resources' in galacticSupply, false, 'Σ every guild\'s stockpiles');
  assert.equal('guildHeld' in galacticSupply.fuel, false, 'Σ every guild\'s hoard');
  assert.equal('total' in galacticSupply.fuel, false, 'pool + Σ hoards');
  assert.equal('ledger' in syndicate, false, 'the balancing account, opposite Σ guild credits');
  for (const f of ['reserve', 'fuelPrice', 'avgDraw', 'targetReserve']) {
    assert.equal(galacticSupply.fuel[f], full.galacticSupply.fuel[f], `${f} is the same number the operator sees`);
  }
});

// A rival licensed REFINERY beside the licensed mine, so the recipe has something to hide.
function rivalGalaxyWithRefinery() {
  let s = ok(rivalGalaxy(), [
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_refinery', siteId: `${B_PLANET}_s01`, type: 'refining', recipeId: 'titanium_alloy', assetId: `asset_${B}_factory_01` }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_refinery', committedOutputPct: 1, windowDays: 7 }),
  ]);
  return tick(s);
}

test('RULING 2: a rival LICENSED venture shows its reputation; its terms and recipe stay hidden', () => {
  const s = rivalGalaxyWithRefinery();
  const full = buildSnapshot(s);
  const view = buildSnapshot(s, A);
  for (const id of ['b_mine', 'b_refinery']) {
    const fullRow = full.ventures.find((v) => v.id === id);
    const row = view.ventures.find((v) => v.id === id);
    assert.ok(fullRow.licence, `${id} really is licensed`);
    assert.ok(fullRow.reputation > 0, `${id} carries a real reputation (the signing bump), so the check is not vacuous`);
    assert.equal(row.reputation, fullRow.reputation, `${id}'s reputation is fully visible (design.md §5)`);
    for (const key of ['licence', 'deuteriumLicence', 'committedFromTick', 'contractWindow', 'equityPct',
      'syndicateCommitment', 'equityPerCycle', 'standing', 'renegotiationOffer', 'teardownSettlement',
      'productionRate', 'recipeId', 'resourceType', 'batchCarry', 'buildQueue']) {
      assert.equal(key in row, false, `${id}: ${key} is terms or operations, not the register`);
    }
  }
  const refinery = view.ventures.find((v) => v.id === 'b_refinery');
  assert.equal(full.ventures.find((v) => v.id === 'b_refinery').recipeId, 'titanium_alloy');
  assert.equal(bytes(refinery).includes('titanium_alloy'), false, 'the recipe / produced good appears nowhere on the row');
  assert.equal(refinery.type, 'refining', 'the TYPE is public — a rival infers the inputs (§405)');
  assert.equal(refinery.site.kind, 'settlement');
  assert.equal(refinery.planetArchetype, getPlanet(B_PLANET).archetype);
});

// Three lockouts: B's OBSERVED licensed mine (A knows the node), B's licensed mine torn down between
// two ticks (never observed — A does not know it), and A's own torn-down mine (A controls the ground).
function lockoutGalaxy() {
  const aMine = `${getTerranHomeworld(A_HOME)}_n01`;
  let s = ok(createZeroState(), [
    A_.createFoundGuildAction({ guildId: A, name: 'Player', credits: 2000, influence: 100, homeSystemId: A_HOME }),
    A_.createFoundGuildAction({ guildId: B, name: 'Rival', isBot: true, credits: 200000, influence: 100, homeSystemId: B_HOME }),
  ]);
  s = ok(s, [
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_seen', siteId: B_MINE, assetId: `asset_${B}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_seen', committedOutputPct: 1, windowDays: 7 }),
  ]);
  s = tick(s); // A observes B_MINE on the register
  s = ok(s, [
    A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_seen' }),
    // Licensed and torn down with no tick between: never on the register at a tick.
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_unseen', siteId: B_MINE_2, assetId: `asset_${B}_miner_02`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_unseen', committedOutputPct: 1, windowDays: 7 }),
    A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_unseen' }),
    // A's own, the same way — so B never learns A's node either.
    A_.createEstablishVentureAction({ guildId: A, ventureId: 'a_mine', siteId: aMine, assetId: `asset_${A}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: A, ventureId: 'a_mine', committedOutputPct: 1, windowDays: 7 }),
    A_.createDecommissionVentureAction({ guildId: A, ventureId: 'a_mine' }),
  ]);
  return { s, aMine };
}

test('RULING 3: a lockout on an UN-KNOWN rival node is not in the view; known or own-ground lockouts are', () => {
  const { s, aMine } = lockoutGalaxy();
  const lockedSites = (snap) => snap.nodeLockouts.map((l) => l.siteId).sort();
  assert.deepEqual(lockedSites(buildSnapshot(s)), [aMine, B_MINE, B_MINE_2].sort(), 'the operator sees all three');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  const aView = buildSnapshot(s, A);
  assert.deepEqual(lockedSites(aView), [aMine, B_MINE].sort(), 'A: its own ground + the rival node it learned');
  assert.equal(bytes(aView).includes(B_MINE_2), false, 'the never-observed rival node appears NOWHERE in A\'s view');

  const bView = buildSnapshot(s, B);
  assert.deepEqual(lockedSites(bView), [B_MINE, B_MINE_2].sort(), 'B: both on its own ground, and not A\'s unseen node');
  assert.equal(bytes(bView).includes(aMine), false);
  // Each visible row is the god's-eye row, unchanged.
  for (const l of aView.nodeLockouts) assert.ok(buildSnapshot(s).nodeLockouts.some((fl) => bytes(fl) === bytes(l)));
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
