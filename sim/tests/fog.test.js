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
//   5. The brief's behaviours: rival stockpiles hidden / own full; an un-licensed rival venture fogged;
//      transports, deliveries, builds, production and notices of a rival hidden; L0 for every system.
//      ⤳ RE-WRITTEN 08-10-26 to §4 ruling 11 (control ⇒ full L2, live): a CONTROLLED system — own or rival —
//      shows every planet's archetype and every node, computed live from the seed + the claims, never from
//      the record; it stays while the system is held and drops out when control lapses, leaving only what
//      the viewer surveyed itself; an UNCONTROLLED frontier system shows only that; and the record is never
//      written from a rival. (The byte proof of the removed leak: tests/rival-leak-removed.test.js.)
//   7. The three RULINGS of 06-10-26 (the design room, on PR #167):
//      (1) the galaxy-wide aggregates are coarsened to posted values, so a rival's stockpile, fuel hoard
//          and credits are NOT derivable from the view (perturb them: the view does not move a byte);
//      (2) a rival LICENSED venture shows its reputation, and still not its terms or recipe;
//      (3) a node lockout shows only on a node the viewer knows (its RECORD) or on ground it controls.
//   6. PURE and DETERMINISTIC: the view writes nothing, and the same (state, guildId) gives the same
//      bytes across two runs and across save/restore (invariant 9).
//   8. DEEP-SCAN ARRAYS (2.5 (b1)): a rival's arrays are in the view NOWHERE — not even the key — while
//      the viewer's own are in full and the god's-eye lens shows every one; a rival's array deploy moves
//      not one byte of the viewer's view.
//   9. SCAN JOBS (2.5 (b2)): the job rides the owner's array row — the owner and the god's-eye see it, a
//      rival sees neither array nor job; a rival's scan, queued or completed, moves not one byte of the view.
//  10. SETTLEMENT SLOTS (the settlement-surface slice, 09-10-26; §4 ruling 10): every `known` entry carries a
//      `slots` map beside `nodes` — every slot of a CONTROLLED system (own or rival), exactly the surveyed
//      slots of a frontier planet, `{}` where none is known — and the god's-eye lens still carries none.

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
  TOP_LEVEL, OMIT_WHEN_EMPTY_TOP_LEVEL, RIVAL_GUILD_FIELDS, RIVAL_VENTURE_FIELDS, RIVAL_OUTPOST_FIELDS,
  RIVAL_SYSTEM_LANDMARK_FIELDS, GALAXY_FUEL_FIELDS,
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
  getL0Systems, isHexInBounds, seedLandmarkAtHex, getClaimRadius,
} = require('../seed.js');
const { kitAboard, placeCraft } = require('./kit-fixtures.js');
const { reveal, revealPlanetSurface } = require('../exploration.js');

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

// fullSurface(systemId) -> what §4 ruling 11 says a CONTROLLED system shows in `geography.known`: every planet's
// archetype, every resource node's type and every settlement slot (present = `true`; a slot has no type),
// straight from the seed's own layout.
function fullSurface(systemId) {
  const out = {};
  for (const p of getSystemLayout(systemId).planets) {
    out[p.id] = {
      archetype: p.archetype,
      nodes: Object.fromEntries(p.resourceNodes.map((n) => [n.id, n.resourceType])),
      slots: Object.fromEntries(p.settlementSlots.map((x) => [x.id, true])),
    };
  }
  return out;
}

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
  // A key the god's-eye lens OMITS WHEN EMPTY (`deepScanArrays`, 2.5 (b1)) may be absent from these states
  // — none has an array — but it must be classified all the same, so it is filtered the moment it appears
  // (tests/deep-scan-array.test.js checks a state where it is present). Every other classified key must be
  // present, and every present key classified, exactly as before.
  assert.deepEqual(OMIT_WHEN_EMPTY_TOP_LEVEL.filter((k) => !classified.includes(k)), [], 'an omit-when-empty key is classified too');
  for (const s of Object.values(godsEyeScript())) {
    const keys = Object.keys(buildSnapshot(s));
    const absentOptional = OMIT_WHEN_EMPTY_TOP_LEVEL.filter((k) => !keys.includes(k));
    assert.deepEqual([...keys, ...absentOptional].sort(), classified,
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

test('an UN-LICENSED rival VENTURE stays fogged: the ground under it is shown, the venture on it is not', () => {
  const s = rivalGalaxy();
  const view = buildSnapshot(s, A);
  assert.equal(view.ventures.some((v) => v.id === 'b_mine_2'), false, 'not in ventures');
  assert.equal(B_MINE_2 in view.occupancy, false, 'not in occupancy — nothing says the node is worked');
  assert.equal(bytes(view).includes('b_mine_2'), false, 'the venture appears nowhere in A\'s view (L3, deferred)');
  // Ruling 11: B controls the system, so the NODE is public ground — its type, like every node there.
  assert.equal(view.geography.known[B_HOME][B_PLANET].nodes[B_MINE_2], 'titanium');
  assert.equal(B_PLANET in guildOf(s, A).exploration, false, 'and A\'s record learned nothing of B\'s planet');
});

test('THE MARQUEE (ruling 11): a rival-controlled system shows its WHOLE surface, live; a lapsed venture loses only the venture', () => {
  let s = rivalGalaxy();
  // Licensed: A's view shows the venture TYPE on the register, and B's whole home system as ground.
  let view = buildSnapshot(s, A);
  const live = view.ventures.find((v) => v.id === 'b_mine');
  assert.equal(live.type, 'mining', 'the venture type is on the public register');
  assert.equal(live.planetArchetype, getPlanet(B_PLANET).archetype, 'with its planet\'s archetype');
  assert.equal(live.site.resourceType, 'titanium', 'and its node\'s type');
  assert.equal(view.occupancy[B_MINE], 'b_mine');
  // (a) EVERY planet's archetype and ALL nodes — not just the licensed one — because B controls the system.
  assert.deepEqual(view.geography.known[B_HOME], fullSurface(B_HOME));
  assert.ok(Object.keys(view.geography.known[B_HOME][B_PLANET].nodes).length > 2,
    'every node of the planet — not just the licensed one, and the unlicensed one too — so "whole" is tested');
  // (c) And none of it is from A's record: the record holds only A's own home, never a rival's node.
  for (const planetId of Object.keys(guildOf(s, A).exploration)) assert.equal(getPlanet(planetId).systemId, A_HOME);

  // B closes it. Two ticks later the venture is gone; the surface is not — B still controls the system.
  s = ok(s, [A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_mine' })]);
  s = tick(tick(s));
  view = buildSnapshot(s, A);
  assert.equal(view.ventures.some((v) => v.id === 'b_mine'), false, 'the venture is gone from the view');
  assert.equal(B_MINE in view.occupancy, false, 'and from occupancy');
  assert.deepEqual(view.geography.known[B_HOME], fullSurface(B_HOME), 'the ground stays while B holds it');
  assert.equal(B_PLANET in guildOf(s, A).exploration, false, 'and still nothing was banked');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// The claims slice (Prefecture plant-and-claim) is not built, so a guild cannot yet come to hold — or lose — a
// system other than its home. A claim row is pushed and removed by hand here, the same stand-in
// tests/deep-scan-job.test.js uses, so the LIVE rule can be shown both ways.
// FRONTIER: an unclaimed starter with at least three planets (A and B hold starters [0] and [1]), derived from
// the seed so a regen carries the tests — several planets, so "only the one you surveyed" has others to leave out.
const FRONTIER = getStarterSystems().map((x) => x.id)
  .find((id) => id !== A_HOME && id !== B_HOME && getSystemLayout(id).planets.length >= 3);
const FRONTIER_PLANET = getSystemLayout(FRONTIER).planets[0].id;
const claimFor = (guildId, systemId, at) => ({ claimId: `claim_${guildId}_${systemId}`, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system', claimedAtTick: at, contested: false });

test('ruling 11: the surface is LIVE — shown while ANY guild controls the system, gone when control lapses, leaving only what you surveyed', () => {
  // A has surveyed ONE frontier planet to L1 (its archetype — no node), at the current tick.
  const s = rivalGalaxy();
  reveal(guildOf(s, A), { planetId: FRONTIER_PLANET }, s.tick);
  const recordBefore = canonicalStringify(guildOf(s, A).exploration);
  const surveyed = { [FRONTIER_PLANET]: { archetype: getPlanet(FRONTIER_PLANET).archetype, nodes: {}, slots: {} } };

  // (b) Uncontrolled: only what A surveyed — one planet, archetype only.
  assert.deepEqual(buildSnapshot(s, A).geography.known[FRONTIER], surveyed);
  assert.equal(FRONTIER in buildSnapshot(s, B).geography.known, false, 'B surveyed nothing there, so B sees nothing past L0');

  // (a) A RIVAL takes it: A sees the whole surface; so does B, its holder.
  const rivalHeld = structuredClone(s);
  rivalHeld.claims.push(claimFor(B, FRONTIER, s.tick));
  assert.deepEqual(checkInvariants(rivalHeld, rivalHeld.tick), [], 'an honest state');
  assert.deepEqual(buildSnapshot(rivalHeld, A).geography.known[FRONTIER], fullSurface(FRONTIER));
  assert.deepEqual(buildSnapshot(rivalHeld, B).geography.known[FRONTIER], fullSurface(FRONTIER));
  // (c) Seeing it wrote nothing: A's record is exactly what A surveyed.
  assert.equal(canonicalStringify(guildOf(rivalHeld, A).exploration), recordBefore);

  // The VIEWER takes it instead: its own system, at full L2, from the moment it holds it (§2).
  const ownHeld = structuredClone(s);
  ownHeld.claims.push(claimFor(A, FRONTIER, s.tick));
  assert.deepEqual(buildSnapshot(ownHeld, A).geography.known[FRONTIER], fullSurface(FRONTIER));

  // Control LAPSES (the claim row goes): back to exactly what A surveyed. Nothing was banked.
  const lapsed = structuredClone(rivalHeld);
  lapsed.claims = lapsed.claims.filter((c) => c.landmarkId !== FRONTIER);
  assert.deepEqual(buildSnapshot(lapsed, A).geography.known[FRONTIER], surveyed);
  assert.equal(FRONTIER in buildSnapshot(lapsed, B).geography.known, false, 'B, which held it, keeps nothing either');
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

// --- deep-scan arrays (2.5 (b1)): never visible to a rival ------------------------------------------

// deployArray(s, guildId, home) -> `s` with one Deep Scan Array of `guildId`'s on a bare hex touching its
// home's footprint (claimRadius + 1 out): an array kit granted at home and loaded onto the guild's starter
// heavy (kit-fixtures.js), the heavy PLACED on the hex (the stand-in for a flight), then the real deploy.
function deployArray(s, guildId, home) {
  const heavy = `vehicle_${guildId}_heavyTransport_01`;
  const centre = getSystem(home).coords;
  const ring = getClaimRadius(home) + 1;
  const hex = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }]
    .map((d) => ({ q: centre.q + ring * d.q, r: centre.r + ring * d.r }))
    .find((h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r));
  const laden = placeCraft(kitAboard(s, guildId, heavy, 'deepScan'), guildId, heavy, hex);
  return ok(laden, [A_.createDeployAssetAction({ guildId, vehicleId: heavy })]);
}

test('rival DEEP-SCAN ARRAYS are in the view NOWHERE; the viewer\'s own are in full; the god\'s-eye shows both', () => {
  const s = deployArray(deployArray(rivalGalaxy(), A, A_HOME), B, B_HOME);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const full = buildSnapshot(s);
  const A_ARRAY = `deepScanArray_${A}_01`;
  const B_ARRAY = `deepScanArray_${B}_01`;
  assert.deepEqual(full.deepScanArrays.map((a) => a.id), [B_ARRAY, A_ARRAY], 'the operator lens: every array, id order');
  assert.ok(TOP_LEVEL.filtered.includes('deepScanArrays'), 'classified, so it is filtered the moment it appears');
  for (const [viewer, own, rival] of [[A, A_ARRAY, B_ARRAY], [B, B_ARRAY, A_ARRAY]]) {
    const view = buildSnapshot(s, viewer);
    assert.deepEqual(Object.keys(view), [...Object.keys(full), 'viewerGuildId', 'geography'], `${viewer}: the key stays in place`);
    assert.equal(bytes(view.deepScanArrays), bytes(full.deepScanArrays.filter((a) => a.id === own)), `${viewer}: its own array, in full`);
    assert.equal(bytes(view).includes(rival), false, `${viewer}: the rival's array id appears nowhere in the view`);
  }
});

test('a rival\'s array deploy moves NOT ONE BYTE of the viewer\'s view — the key does not even appear', () => {
  const before = rivalGalaxy();
  const after = deployArray(before, B, B_HOME);
  assert.equal(after.deepScanArrays.length, 1);
  assert.notEqual(bytes(buildSnapshot(after)), bytes(buildSnapshot(before)), 'the operator lens sees it');
  // B's laden heavy was PLACED before the deploy, so compare A's view of B mid-way (placed, kit aboard)
  // with A's view after: the only thing between them is B's deploy.
  const heavy = `vehicle_${B}_heavyTransport_01`;
  const placed = placeCraft(kitAboard(before, B, heavy, 'deepScan'), B, heavy, after.deepScanArrays[0].coords);
  const viewAfter = buildSnapshot(after, A);
  assert.equal('deepScanArrays' in viewAfter, false, 'A owns no array, so A\'s view carries no deepScanArrays key at all');
  assert.equal(bytes(viewAfter), bytes(buildSnapshot(placed, A)));
  assert.equal(bytes(viewAfter), bytes(buildSnapshot(before, A)), 'nor did B\'s grant, load or placing');
});

// --- the scan job (2.5 (b2)): it rides the owner's array row, so it is never visible to a rival ----------

const SCAN_TARGET = FRONTIER; // the unclaimed frontier system (defined with the ruling-11 tests above)
const queueL1 = (s) => ok(s, [A_.createQueueScanAction({ guildId: A, arrayId: `deepScanArray_${A}_01`, level: 'L1', targetSystemId: SCAN_TARGET })]);

test('a SCAN JOB rides the owner\'s array row: the owner and the god\'s-eye see it; a rival sees neither the array nor the job', () => {
  const s = deployArray(rivalGalaxy(), A, A_HOME);
  const queued = queueL1(s);
  const full = buildSnapshot(queued);
  assert.deepEqual(full.deepScanArrays[0].scan, queued.deepScanArrays[0].scan, 'the operator lens carries the job');
  assert.equal(bytes(buildSnapshot(queued, A).deepScanArrays), bytes(full.deepScanArrays), 'the owner: its array and its job, in full');
  const rival = buildSnapshot(queued, B);
  assert.equal('deepScanArrays' in rival, false);
  assert.equal(bytes(rival).includes(`deepScanArray_${A}_01`), false);
  assert.equal(bytes(rival), bytes(buildSnapshot(s, B)), 'A queuing a scan moves not one byte of B\'s view');
});

test('a rival\'s scan COMPLETING moves not one byte of the viewer\'s view — the reveal lands in the scanner\'s record only', () => {
  // Two timelines from one start, ticked alike: in one A runs an L1 scan to completion, in the other it does not.
  const start = deployArray(rivalGalaxy(), A, A_HOME);
  let scanned = queueL1(start);
  let idle = start;
  for (let i = 0; i < 720; i += 1) { scanned = tick(scanned); idle = tick(idle); }
  assert.equal('scan' in scanned.deepScanArrays[0], false, 'the job completed');
  assert.ok(buildSnapshot(scanned, A).geography.known[SCAN_TARGET], 'A\'s view now knows the target system');
  assert.equal(SCAN_TARGET in buildSnapshot(idle, A).geography.known, false);
  assert.equal(bytes(buildSnapshot(scanned, B)), bytes(buildSnapshot(idle, B)), 'B\'s view is identical either way');
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

test('an UNCONTROLLED frontier system\'s planet ids appear NOWHERE in the view until the guild surveys them', () => {
  const { founded: s } = godsEyeScript();
  const text = bytes(buildSnapshot(s, A));
  for (const planet of getSystemLayout(FRONTIER).planets) {
    assert.equal(text.includes(`"${planet.id}`), false, `frontier planet ${planet.id} leaks into A's view (an id is L1 here)`);
  }
  // Survey one, and that one — only that one — appears; so this test can fail.
  const surveyed = structuredClone(s);
  reveal(guildOf(surveyed, A), { planetId: FRONTIER_PLANET }, surveyed.tick);
  const after = bytes(buildSnapshot(surveyed, A));
  assert.ok(after.includes(`"${FRONTIER_PLANET}"`));
  for (const planet of getSystemLayout(FRONTIER).planets.slice(1)) assert.equal(after.includes(`"${planet.id}`), false);
  // A RIVAL-controlled system is the other way round (ruling 11): its planets are public ground.
  assert.ok(text.includes(`"${B_PLANET}"`), 'B\'s home planets are in A\'s view the moment B holds the system');
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

test('geography: `known` is exactly the record ∪ every controlled system, resolved through the seed — nothing more', () => {
  // A has also surveyed one frontier planet in full (its archetype, every node and every slot), so all three
  // kinds of entry are present: own home (record AND control — one entry, merged), rival home (control only),
  // and a frontier planet (record only).
  const s = rivalGalaxy();
  revealPlanetSurface(guildOf(s, A), FRONTIER_PLANET, s.tick);
  const { known } = buildSnapshot(s, A).geography;

  // Every entry is a seed fact, filed under its own system — every node a resource node of that planet with
  // its seed type, every slot a settlement slot of that planet.
  for (const [systemId, planets] of Object.entries(known)) {
    for (const [planetId, entry] of Object.entries(planets)) {
      assert.equal(getPlanet(planetId).systemId, systemId);
      assert.deepEqual(Object.keys(entry), ['archetype', 'nodes', 'slots'], 'one uniform entry shape');
      assert.equal(entry.archetype, getPlanet(planetId).archetype);
      for (const [nodeId, type] of Object.entries(entry.nodes)) assert.equal(type, getSite(nodeId).resourceType);
      for (const [slotId, present] of Object.entries(entry.slots)) {
        assert.equal(present, true);
        assert.equal(getSite(slotId).kind, 'settlement');
        assert.equal(getSite(slotId).planetId, planetId);
      }
    }
  }
  // Exactly the union, and nothing more.
  assert.deepEqual(Object.keys(known), [A_HOME, B_HOME, FRONTIER].sort(), 'the two controlled systems + the one surveyed');
  assert.deepEqual(known[A_HOME], fullSurface(A_HOME), 'own home: record and control agree, merged into one');
  assert.deepEqual(known[B_HOME], fullSurface(B_HOME), 'rival home: control only, the whole surface');
  assert.deepEqual(known[FRONTIER], { [FRONTIER_PLANET]: fullSurface(FRONTIER)[FRONTIER_PLANET] }, 'frontier: only the surveyed planet');

  // Sorted at every level, whatever order the two sources met the keys in (invariant 9).
  const sorted = (keys) => [...keys].sort();
  assert.deepEqual(Object.keys(known), sorted(Object.keys(known)));
  for (const planets of Object.values(known)) {
    assert.deepEqual(Object.keys(planets), sorted(Object.keys(planets)));
    for (const entry of Object.values(planets)) {
      assert.deepEqual(Object.keys(entry.nodes), sorted(Object.keys(entry.nodes)));
      assert.deepEqual(Object.keys(entry.slots), sorted(Object.keys(entry.slots)));
    }
  }
});

// --- 10. settlement slots (the settlement-surface slice, 09-10-26) ------------------------------------------

// slotIdsOf(planetId) -> that planet's settlement-slot ids, from the seed's own layout, sorted.
const slotIdsOf = (planetId) => getSystemLayout(getPlanet(planetId).systemId).planets
  .find((p) => p.id === planetId).settlementSlots.map((x) => x.id).sort();

test('SLOTS: a CONTROLLED system shows EVERY planet\'s settlement slots — own and rival alike — and they are real', () => {
  const s = rivalGalaxy();
  for (const viewer of [A, B]) {
    const { known } = buildSnapshot(s, viewer).geography;
    for (const home of [A_HOME, B_HOME]) {
      let total = 0;
      for (const planet of getSystemLayout(home).planets) {
        assert.deepEqual(Object.keys(known[home][planet.id].slots), slotIdsOf(planet.id), `${viewer} sees every slot of ${planet.id}`);
        total += planet.settlementSlots.length;
      }
      assert.ok(total > 0, `${home} has settlement slots, so "every slot" is tested`);
    }
  }
  // The rival's home is shown LIVE, not from A's record: A's record holds slots only on its own home planets.
  for (const [planetId, entry] of Object.entries(guildOf(s, A).exploration)) {
    assert.equal(getPlanet(planetId).systemId, A_HOME);
    assert.deepEqual(Object.keys(entry.slots).sort(), slotIdsOf(planetId), 'founding recorded every home slot');
  }
});

test('SLOTS: a self-surveyed FRONTIER planet shows exactly its surveyed slots; an L1-only planet shows none', () => {
  // Pick the frontier's first planet that HAS slots (a gas giant, molten or irradiated world carries none).
  const planets = getSystemLayout(FRONTIER).planets;
  const surfaced = planets.find((p) => p.settlementSlots.length > 0).id;
  const archetypeOnly = planets.find((p) => p.id !== surfaced).id;
  const s = rivalGalaxy();
  revealPlanetSurface(guildOf(s, A), surfaced, s.tick);       // an L2 survey of one planet
  reveal(guildOf(s, A), { planetId: archetypeOnly }, s.tick);  // an L1 fact about another
  const { known } = buildSnapshot(s, A).geography;
  assert.deepEqual(Object.keys(known[FRONTIER]).sort(), [surfaced, archetypeOnly].sort(), 'only the two planets A learned');
  assert.deepEqual(known[FRONTIER][surfaced], fullSurface(FRONTIER)[surfaced], 'the surveyed planet: every node AND every slot');
  assert.deepEqual(known[FRONTIER][archetypeOnly], { archetype: getPlanet(archetypeOnly).archetype, nodes: {}, slots: {} },
    'the L1 planet: archetype only — the slots map is present and empty, the same shape');
  assert.equal(FRONTIER in buildSnapshot(s, B).geography.known, false, 'B surveyed nothing there');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('SLOTS: the god\'s-eye lens carries no slot track — it builds no geography and no guild row shows the record', () => {
  const s = rivalGalaxy();
  const full = buildSnapshot(s);
  assert.equal('geography' in full, false);
  for (const g of full.guilds) assert.equal('exploration' in g, false, `${g.id}: the record is never on the operator row`);
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

// Three lockouts: two on B's ground — B_MINE (licensed, ticked, then torn down) and B_MINE_2 (licensed and torn
// down with no tick between) — and A's own torn-down mine on A's ground.
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
  s = tick(s); // on the register at a tick's end (before ruling 11, this is when A banked the node)
  s = ok(s, [
    A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_seen' }),
    A_.createEstablishVentureAction({ guildId: B, ventureId: 'b_unseen', siteId: B_MINE_2, assetId: `asset_${B}_miner_02`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: B, ventureId: 'b_unseen', committedOutputPct: 1, windowDays: 7 }),
    A_.createDecommissionVentureAction({ guildId: B, ventureId: 'b_unseen' }),
    A_.createEstablishVentureAction({ guildId: A, ventureId: 'a_mine', siteId: aMine, assetId: `asset_${A}_miner_01`, resourceType: 'titanium', productionRate: 5 }),
    A_.createApplyForLicenceAction({ guildId: A, ventureId: 'a_mine', committedOutputPct: 1, windowDays: 7 }),
    A_.createDecommissionVentureAction({ guildId: A, ventureId: 'a_mine' }),
  ]);
  return { s, aMine };
}

test('RULING 3: a lockout shows on a node the viewer\'s RECORD knows or on ground it controls — nowhere else', () => {
  const { s, aMine } = lockoutGalaxy();
  const lockedSites = (snap) => snap.nodeLockouts.map((l) => l.siteId).sort();
  assert.deepEqual(lockedSites(buildSnapshot(s)), [aMine, B_MINE, B_MINE_2].sort(), 'the operator sees all three');
  assert.deepEqual(checkInvariants(s, s.tick), []);

  // A: only its own ground. B's two lockouts are hidden although `geography.known` shows both NODES (ruling 11)
  // — "knows" in ruling 3 is the record, and since ruling 11 the record never learns a rival's node. Whether
  // it should follow the live projection instead is OPEN on the roadmap's decision checklist; hidden until ruled.
  const aView = buildSnapshot(s, A);
  assert.deepEqual(lockedSites(aView), [aMine]);
  assert.ok(B_MINE in aView.geography.known[B_HOME][B_PLANET].nodes, 'the node itself IS shown as ground');

  const bView = buildSnapshot(s, B);
  assert.deepEqual(lockedSites(bView), [B_MINE, B_MINE_2].sort(), 'B: both, on its own ground — and not A\'s');

  // The RECORD half of the rule still works: a node A's own record knows shows its lockout. (A stand-in for a
  // survey A made before B held the ground — B_MINE written straight into A's record through `reveal`.)
  const surveyed = structuredClone(s);
  reveal(guildOf(surveyed, A), { nodeId: B_MINE }, 0);
  assert.deepEqual(lockedSites(buildSnapshot(surveyed, A)), [aMine, B_MINE].sort());

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
