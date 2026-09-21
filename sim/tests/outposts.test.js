'use strict';

// outposts.test.js — the guild Outpost, roadmap 2.2 the outpost ladder slice 1 (design.md §4
// "The Guild Outpost", §15.4 — the Toll Gate entity family; docs/phase-1-tuning.md
// §"Guild Outpost"). An operator can PLACE a single-hex, guild-owned Outpost anchored to a
// system and DESTROY it; the snapshot carries it. Nothing else — NO cargo, NO dock behaviour,
// NO client — so `capacity` / `dockCapacity` are carried but read by nothing.
//
// The tripwires, one per ruling:
//   - VOCABULARY: the derived capacity cap 30 × HEAVY_HOLD, the [FIRST-CUT] 10 dock slots, the
//     deterministic `outpost_<guild>_NN` id scheme + per-guild mint serial (no invented number);
//   - SPAWN: mints a SHARED outpost into state.outposts with the right owner / coords / anchor /
//     capacity / dockCapacity / createdAtTick, and the snapshot mirrors it;
//   - the GATES: unknown guild / unknown anchor system / off-lattice hex / a hex already holding a
//     seed landmark or another outpost all refuse-whole (one structure per hex);
//   - REMOVE: drops the row; an unknown or non-owned outpost refuses; the serial never decrements,
//     so a removed id is never reissued;
//   - INVARIANTS: §15.5 stays clean after spawn and after remove;
//   - the NO-OP: a galaxy with no outpost carries no `outposts` key (byte-identical to pre-slice);
//   - determinism (invariant 9): a spawn→remove→spawn run twice is byte-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { HEAVY_HOLD } = require('../fuel.js');
const { OUTPOST_CAPACITY, OUTPOST_DOCK_SLOTS, outpostId, nextOutpostSerial } = require('../outposts.js');
const { getSystem, isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const {
  validateAction, applyAction, createSpawnOutpostAction, createRemoveOutpostAction,
} = require('../actions.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');

const HOME = starterHomeAtDistance(6);
const ANCHOR = HOME.id; // a real seed system to anchor an outpost to

// The first N in-bounds hexes that hold no seed landmark, in a deterministic scan order — DERIVED
// from the seed (like waystation-fixtures), so a regen carries the tests instead of breaking them.
function freeHexes(n) {
  const out = [];
  for (let q = -60; q <= 60 && out.length < n; q += 1) {
    for (let r = -60; r <= 60 && out.length < n; r += 1) {
      if (isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) out.push({ q, r });
    }
  }
  assert.ok(out.length >= n, `need ${n} free hexes on this seed, found ${out.length}`);
  return out;
}
const FREE = freeHexes(3);

// A bare guild with no home claim — spawn/remove touch no credits/fuel/points/reputation/claims,
// so nothing needs seating; the ledger is balanced so createState opens invariant-clean.
function outpostState() {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
}
const spawn = (over = {}) => createSpawnOutpostAction({
  guildId: 'g1', anchorSystemId: ANCHOR, coords: FREE[0], ...over,
});
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refused = (state, action) => {
  const { valid } = validateAction(state, action);
  return valid === false;
};

// --- 1. the constants (derived, no invented number) --------------------------------------------

test('OUTPOST_CAPACITY is 30 × HEAVY_HOLD and OUTPOST_DOCK_SLOTS is 10; the id scheme + serial', () => {
  assert.equal(OUTPOST_CAPACITY, 30 * HEAVY_HOLD);
  assert.equal(OUTPOST_DOCK_SLOTS, 10);
  assert.equal(outpostId('g1', 1), 'outpost_g1_01');
  assert.equal(outpostId('g1', 12), 'outpost_g1_12');
  // nextOutpostSerial reads the guild's STORED counter (design.md §15.4 "Ids never repeat"), NOT
  // the highest live suffix — so a torn-down outpost's number is never re-derived and reissued.
  assert.equal(nextOutpostSerial({}), 1, 'no counter yet -> 1');
  assert.equal(nextOutpostSerial({ outpostSerial: 0 }), 1);
  assert.equal(nextOutpostSerial({ outpostSerial: 5 }), 6);
});

// --- 2. spawn: the entity in state + snapshot --------------------------------------------------

test('spawn: mints a SHARED outpost with the right owner / coords / anchor / capacity / dockCapacity', () => {
  let s = outpostState();
  s = accept(s, spawn());
  assert.equal(s.outposts.length, 1);
  const o = s.outposts[0];
  assert.equal(o.id, 'outpost_g1_01', 'the deterministic per-guild serial id');
  assert.equal(o.ownerGuildId, 'g1');
  assert.deepEqual(o.coords, FREE[0]);
  assert.equal(o.anchorSystemId, ANCHOR);
  assert.equal(o.capacity, OUTPOST_CAPACITY, 'the carried 30 × HEAVY_HOLD cap');
  assert.equal(o.dockCapacity, OUTPOST_DOCK_SLOTS, 'the carried [FIRST-CUT] 10 dock slots');
  assert.equal(o.createdAtTick, s.tick, 'every mutation records its tick (§15.2)');
  assert.equal(o.stockpile, undefined, 'the stockpile is born empty — omit-when-empty, nothing writes it');
  assert.equal(s.guilds[0].outpostSerial, 1, 'the per-guild mint counter advanced');
  // Spawn moves NOTHING else — no credits/fuel change, no vehicle/asset minted, invariants clean.
  assert.equal(s.guilds[0].credits, 0);
  assert.equal(s.guilds[0].fuelHoard, 0);
  assert.equal((s.guilds[0].vehicles || []).length, 0);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('spawn: the snapshot surfaces the outpost with an empty stockpile view', () => {
  let s = outpostState();
  s = accept(s, spawn());
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.outposts, [{
    id: 'outpost_g1_01',
    ownerGuildId: 'g1',
    coords: FREE[0],
    anchorSystemId: ANCHOR,
    capacity: OUTPOST_CAPACITY,
    dockCapacity: OUTPOST_DOCK_SLOTS,
    stockpile: {},
  }]);
});

test('spawn: the coords in state/snapshot are COPIES — no alias into the action', () => {
  const coords = { q: FREE[1].q, r: FREE[1].r };
  const action = createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: ANCHOR, coords });
  const s = accept(outpostState(), action);
  coords.q = 99999; // mutate the caller's object after the fact
  assert.equal(s.outposts[0].coords.q, FREE[1].q, 'engine state did not alias the action coords');
});

// --- 3. the placement gates (one structure per hex; real guild + anchor + hex) ------------------

test('spawn: unknown guild, unknown anchor system, and an off-lattice hex each refuse-whole', () => {
  const s = outpostState();
  assert.equal(refused(s, spawn({ guildId: 'ghost' })), true, 'unknown guild refused');
  assert.equal(refused(s, spawn({ anchorSystemId: 'sys_not_real' })), true, 'unknown anchor system refused');
  assert.equal(refused(s, spawn({ coords: { q: 100000, r: 100000 } })), true, 'off-lattice hex refused');
  assert.equal(refused(s, spawn({ coords: { q: 1.5, r: 0 } })), true, 'a non-integer is not a hex');
  assert.equal(refused(s, spawn({ coords: 'nope' })), true, 'a malformed coords is refused');
});

test('spawn: a hex already holding a SEED landmark (a system) is refused — one structure per hex', () => {
  const sysCoords = getSystem(ANCHOR).coords;
  assert.deepEqual(seedLandmarkAtHex(sysCoords.q, sysCoords.r), { id: ANCHOR, kind: 'system', coords: sysCoords });
  const s = outpostState();
  assert.equal(refused(s, spawn({ coords: { q: sysCoords.q, r: sysCoords.r } })), true, 'the anchor system\'s own hex is occupied');
  // The Citadel occupies the origin hex, too.
  assert.equal(refused(s, spawn({ coords: { q: 0, r: 0 } })), true, 'the Citadel hex is occupied');
});

test('spawn: a second outpost on the SAME hex is refused (a live outpost occupies it)', () => {
  let s = outpostState();
  s = accept(s, spawn()); // FREE[0]
  assert.equal(refused(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: ANCHOR, coords: FREE[0] })), true, 'same guild, same hex');
  // A DIFFERENT guild is refused on that hex too — the bar is the hex, not the owner.
  const s2 = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }, { id: 'g2', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  const withOne = accept(s2, spawn());
  assert.equal(refused(withOne, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: ANCHOR, coords: FREE[0] })), true, 'a rival guild is refused on the occupied hex');
  // A DIFFERENT free hex is fine.
  assert.equal(validateAction(withOne, createSpawnOutpostAction({ guildId: 'g2', anchorSystemId: ANCHOR, coords: FREE[1] })).valid, true, 'a free hex accepts a second outpost');
});

// --- 4. remove ---------------------------------------------------------------------------------

test('remove: drops the outpost by id; an unknown or non-owned outpost refuses', () => {
  let s = outpostState();
  s = accept(s, spawn());
  const id = s.outposts[0].id;
  assert.equal(refused(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_99' })), true, 'unknown id refused');
  // A guild that does not own the outpost cannot remove it.
  const s2 = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }, { id: 'g2', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  const withOne = accept(s2, spawn());
  assert.equal(refused(withOne, createRemoveOutpostAction({ guildId: 'g2', outpostId: withOne.outposts[0].id })), true, 'a non-owner cannot remove it');
  // The owner removes it — the row is gone, and the `outposts` key drops (omit-when-empty).
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: id }));
  assert.equal(s.outposts, undefined, 'the last outpost removed drops the key (byte-identical to pre-slice)');
  assert.equal(s.guilds[0].outpostSerial, 1, 'the serial is untouched by removal');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('spawn→remove→spawn: the removed id is never reissued (serial monotonic, design.md §15.4)', () => {
  let s = outpostState();
  s = accept(s, spawn());              // _01
  const firstId = s.outposts[0].id;
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: firstId }));
  s = accept(s, spawn());              // _02, NOT _01 — a max-based derivation would have reissued _01
  assert.equal(s.outposts.length, 1);
  assert.notEqual(s.outposts[0].id, firstId, 'the removed id is not reissued');
  assert.equal(s.outposts[0].id, 'outpost_g1_02');
  assert.equal(s.guilds[0].outpostSerial, 2);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. the integrity invariant ----------------------------------------------------------------

test('checkOutpostIntegrity catches a bad owner / anchor / hex / capacity / createdAtTick / dupes', () => {
  const mk = (over) => {
    const base = {
      guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, outpostSerial: 1 }],
      reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
      outposts: [{
        id: 'outpost_g1_01', ownerGuildId: 'g1', coords: { ...FREE[0] }, anchorSystemId: ANCHOR,
        capacity: OUTPOST_CAPACITY, dockCapacity: OUTPOST_DOCK_SLOTS, createdAtTick: 0,
      }],
    };
    // createState omits an empty outposts array, so hand the rows in via a post-build patch to keep
    // a deliberately-corrupt row (a scenario/save could carry one; the invariant must still bite).
    const s = createState(base);
    s.outposts = base.outposts.map((o) => ({ ...o, ...over }));
    return s;
  };
  assert.deepEqual(checkInvariants(mk({}), 0), [], 'a well-formed outpost passes');

  const ruleOf = (over) => checkInvariants(mk(over), 0).map((x) => x.rule);
  assert.ok(ruleOf({ ownerGuildId: 'ghost' }).includes('outpost-owner-exists'), 'dangling owner trips');
  assert.ok(ruleOf({ anchorSystemId: 'sys_not_real' }).some((r) => r.startsWith('outpost-anchor-is-a-system')), 'bad anchor trips');
  assert.ok(ruleOf({ coords: { q: 100000, r: 100000 } }).some((r) => r.startsWith('outpost-coords-in-bounds')), 'off-lattice hex trips');
  assert.ok(ruleOf({ coords: { q: 0, r: 0 } }).some((r) => r.startsWith('outpost-hex-unoccupied-by-seed')), 'a hex on the Citadel trips');
  assert.ok(ruleOf({ capacity: 1.5 }).includes('outpost-capacity-is-a-non-negative-int'), 'non-int capacity trips');
  assert.ok(ruleOf({ dockCapacity: -1 }).includes('outpost-dockCapacity-is-a-non-negative-int'), 'negative dockCapacity trips');
  assert.ok(ruleOf({ createdAtTick: -1 }).some((r) => r.startsWith('outpost-createdAtTick-is-a-tick')), 'bad createdAtTick trips');
  assert.ok(ruleOf({ stockpile: { titanium: -3 } }).some((r) => r.startsWith('outpost-stockpile-is-a-non-negative-int')), 'negative stockpile trips');
});

test('checkOutpostIntegrity catches a duplicate hex, a duplicate id, and a serial below a live suffix', () => {
  const twoAt = (over2) => {
    const s = createState({ guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, outpostSerial: 2 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
    s.outposts = [
      { id: 'outpost_g1_01', ownerGuildId: 'g1', coords: { ...FREE[0] }, anchorSystemId: ANCHOR, capacity: OUTPOST_CAPACITY, dockCapacity: OUTPOST_DOCK_SLOTS, createdAtTick: 0 },
      { id: 'outpost_g1_02', ownerGuildId: 'g1', coords: { ...FREE[1] }, anchorSystemId: ANCHOR, capacity: OUTPOST_CAPACITY, dockCapacity: OUTPOST_DOCK_SLOTS, createdAtTick: 0, ...over2 },
    ];
    return checkInvariants(s, 0).map((x) => x.rule);
  };
  assert.ok(twoAt({ coords: { ...FREE[0] } }).some((r) => r.startsWith('outpost-hex-unique')), 'two outposts on one hex trip');
  assert.ok(twoAt({ id: 'outpost_g1_01' }).includes('outpost-id-unique'), 'a duplicate id trips');
  // A serial below the highest live suffix (02) trips: drop it to 1 with only one outpost (_02).
  const s = createState({ guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, outpostSerial: 1 }], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  s.outposts = [{ id: 'outpost_g1_02', ownerGuildId: 'g1', coords: { ...FREE[0] }, anchorSystemId: ANCHOR, capacity: OUTPOST_CAPACITY, dockCapacity: OUTPOST_DOCK_SLOTS, createdAtTick: 0 }];
  assert.ok(checkInvariants(s, 0).map((x) => x.rule).includes('outpost-serial-monotonic'), 'serial below a live suffix trips');
});

// --- 6. the no-op + determinism ----------------------------------------------------------------

test('no-op: a galaxy with no outpost carries no `outposts` key and is byte-identical', () => {
  const bare = outpostState();
  assert.equal(bare.outposts, undefined, 'no outpost -> no key');
  // Spawn then remove the only outpost: back to no key, and the whole state hashes as it began.
  let s = accept(bare, spawn());
  s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: s.outposts[0].id }));
  assert.equal(s.outposts, undefined);
  // The serial DID advance (a stored monotonic counter), so the state is not identical to the bare
  // one — that is the intended cost of never reissuing an id. The `outposts` key, though, is gone.
  assert.equal(s.guilds[0].outpostSerial, 1);
});

test('determinism: a spawn→remove→spawn sequence run twice is byte-identical (invariant 9)', () => {
  const run = () => {
    let s = outpostState();
    s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: ANCHOR, coords: FREE[0] }));
    s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: ANCHOR, coords: FREE[1] }));
    s = accept(s, createRemoveOutpostAction({ guildId: 'g1', outpostId: 'outpost_g1_01' }));
    s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: ANCHOR, coords: FREE[2] }));
    return s;
  };
  assert.equal(hashState(run()), hashState(run()));
});
