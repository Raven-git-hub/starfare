'use strict';

// control-map.test.js — THE SENIORITY CONTROL MAP (roadmap 2.5, the Prefecture / claims slice, engine PR 2;
// docs/territory-model.md §2 "The control footprint & the first-settled rule"). Two held systems' footprints may
// overlap; §2 awards each contested hex to ONE claim, and sim/claims.js builds that as `controlledBy` (one hex) and
// `resolveControl` (the whole map), both on `controlNear`. The snapshot carries the map as `controlMap`.
//
// The tripwires:
//   1. SENIORITY, on a real plant: g2 plants a Prefecture 2 hexes from g1's home (the merged PR 1 fixture); the
//      OLDER claim takes every contested hex, and each side keeps the rest of its own disk.
//   2. THE OWN-CENTRE OVERRIDE: two ADJACENT held systems — the junior keeps its own centre even though the
//      senior's disk covers it; the senior takes the majority of the contested hexes.
//   3. THE TIE-BREAK: equal claimedAtTick -> the lower claimId, whoever owns it and wherever it sits in
//      `state.claims`; and the tick outranks the id (an older claim with a higher id still wins).
//   4. AGREEMENT with the accessors: a held centre is `systemHolder`'s; an uncontested hex is its one claim's owner;
//      a hex no footprint covers is null; every map row is `controlledBy` for its hex.
//   5. RECOMPUTE ON CHANGE: remove the senior claim and the junior expands to its full footprint, the senior's other
//      hexes fall to the next claim or to nobody — nothing stored to reconcile.
//   6. THE ORACLE: §2 written out again here, sharing nothing with sim/claims.js but the seed, asked of every hex
//      around a dense cluster of claims (ties included) — the map and the rule must equal it.
//   7. SCOPE: the system layer only — an Outpost's own hex is not in the map.
//   8. DETERMINISM (invariant 9): sorted by q then r, no repeats, the same for any order of `state.claims`, and a
//      replayed run gives the same bytes. DERIVED: asking writes nothing.
//   9. THE SNAPSHOT: `controlMap` is `resolveControl`, right after `claims`, `[]` when no system is held, PUBLIC —
//      the same whole map in every guild's view; and the strip refuses to be vacuous.
//  10. FAIL LOUD: a covering claim with no whole tick halts the map, naming it; the claim invariant flags a missing
//      or future claimedAtTick and a repeated claimId — the facts seniority needs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { TOP_LEVEL } = require('../fog.js');
const { controlNear, controlledBy, resolveControl, systemHolder } = require('../claims.js');
const { getSystem, getClaimRadius, seedLandmarkAtHex, isHexInBounds } = require('../seed.js');
const { createSpawnOutpostAction } = require('../actions.js');
const { withoutControlMap } = require('./control-map-strip.js');
const P = require('./prefecture-fixtures.js');
const seed = require('../../data/seed.json');

const { accept, HOME, HOME_HEX, TARGET, PLANET_A, SLOT_A1 } = P;
const keyOf = (h) => `${h.q},${h.r}`;
const centreOf = (systemId) => getSystem(systemId).coords;

// --- the oracle's own geometry: written out here, NOT imported, so the oracle shares no code with the engine ------
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
// The six neighbours plus the hex itself — a 1-hex disk, by hand.
const STEPS = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const diskOf = (systemId) => {
  const c = centreOf(systemId);
  return seed.systems.find((x) => x.id === systemId).claimRadius === 1
    ? STEPS.map((d) => ({ q: c.q + d.q, r: c.r + d.r }))
    : null;   // every seed system has claimRadius 1 today; a test below asserts it, so this branch never runs
};

// mapOf(rows) -> Map "q,r" -> row, for looking hexes up.
const mapOf = (rows) => new Map(rows.map((row) => [keyOf(row), row]));

// claim(guildId, systemId, tick, claimId?) -> a hand-written system claim row, `foundGuild`'s shape.
const claim = (guildId, systemId, tick, claimId = `claim_${guildId}_${systemId}`) => ({
  claimId, ownerGuildId: guildId, landmarkId: systemId, landmarkKind: 'system', claimedAtTick: tick, contested: false,
});

// galaxyOf(claims, tick) -> a minimal, LEGAL galaxy holding exactly these claims: one homeless guild per owner (a
// homeless guild is legal — checkGuildHome skips it), at `tick` (a claim's tick may not be in the future). Asserted
// clean by every invariant, so a test here never runs on a state the engine would halt on.
function galaxyOf(claims, tick = 10) {
  const owners = [...new Set(claims.map((c) => c.ownerGuildId))].sort();
  const s = createState({
    guilds: owners.map((id) => ({ id, credits: 0, fuelHoard: 0 })),
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims,
  });
  s.tick = tick;
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the hand-built galaxy is legal');
  return s;
}

// ADJ_A, ADJ_B — the first two seed systems (in id order) that sit side by side: each centre is inside the other's
// disk. Derived from the seed, so a regen carries the tests.
const [ADJ_A, ADJ_B] = (() => {
  const ids = seed.systems.map((x) => x.id).sort();
  for (const a of ids) {
    const b = ids.find((id) => id > a && dist(centreOf(a), centreOf(id)) === 1);
    if (b) return [a, b];
  }
  throw new Error('control-map test: no two adjacent systems on this seed');
})();

// The hexes BOTH adjacent disks cover: the two centres and the two ring hexes beside both.
const SHARED_AB = diskOf(ADJ_A).filter((h) => dist(h, centreOf(ADJ_B)) <= 1);

// planted({ wait }) -> the merged PR 1 fixture after g2 — a RIVAL — plants a Prefecture on TARGET, 2 hexes from g1's
// home, so the two footprints overlap. `wait` ticks pass first, so g2's claim is strictly younger than g1's home
// claim (claimed at tick 0); with `wait` 0 the two claims share tick 0 and the tie-break decides.
function planted({ wait = 5 } = {}) {
  let s = P.ticks(P.kitGalaxy({ fuelHoard: 5_000 }), wait);
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g2', TARGET));
  s = P.survey(s, 'g2', PLANET_A);
  return accept(s, P.plant('g2', kitId, SLOT_A1));
}
const HOME_CLAIM = `claim_g1_${HOME.id}`;
const G2_CLAIM = 'claim_prefecture_g2_01';

// --- 0. the ground the tests stand on ------------------------------------------------------------------------------

test('the fixtures: every seed system has claimRadius 1 (the 7-hex footprint), the target is 2 hexes from home, and ADJ_A/ADJ_B touch', () => {
  assert.equal(seed.systems.every((x) => x.claimRadius === 1), true, '§2: own hex plus the ring of 6');
  assert.equal(P.TARGET_DISTANCE, 2, 'decision-checklist item 8 of PR 1: the fixture target sits 2 hexes from home');
  assert.equal(dist(centreOf(ADJ_A), centreOf(ADJ_B)), 1);
  assert.equal(SHARED_AB.length, 4, 'two touching disks share both centres and the two ring hexes beside both');
});

// --- 1. seniority, on a real plant ---------------------------------------------------------------------------------

test('SENIORITY: g2 plants beside g1\'s home — the older claim (g1\'s, tick 0) takes every contested hex; each keeps the rest of its disk', () => {
  const s = planted();
  const g2Row = s.claims.find((c) => c.claimId === G2_CLAIM);
  assert.ok(g2Row.claimedAtTick > 0, 'g2 claimed after g1 (claimed at tick 0)');
  const map = mapOf(resolveControl(s));
  const homeDisk = diskOf(HOME.id);
  const targetDisk = diskOf(TARGET);
  const contested = homeDisk.filter((h) => targetDisk.some((t) => keyOf(t) === keyOf(h)));
  assert.ok(contested.length >= 1, 'the two footprints really overlap, so this test can fail');
  for (const h of contested) {
    assert.deepEqual(map.get(keyOf(h)), { q: h.q, r: h.r, guildId: 'g1', claimId: HOME_CLAIM }, `contested ${keyOf(h)} is the senior's`);
    assert.equal(controlledBy(s, h), 'g1');
  }
  for (const h of targetDisk.filter((t) => !contested.some((c) => keyOf(c) === keyOf(t)))) {
    assert.equal(map.get(keyOf(h)).guildId, 'g2', `${keyOf(h)} — only g2's disk covers it`);
  }
  for (const h of homeDisk) assert.equal(map.get(keyOf(h)).guildId, 'g1', `${keyOf(h)} — g1's whole disk is g1's`);
  assert.equal(controlledBy(s, centreOf(TARGET)), 'g2', 'the junior holds its own centre');
  assert.equal(map.size, homeDisk.length + targetDisk.length - contested.length + 7, 'plus g2\'s far home disk, 7 hexes');
});

test('SENIORITY, same guild: g1 plants its own Prefecture beside home — the home claim wins the shared hexes; the owner is g1 throughout', () => {
  let s = P.ticks(P.kitGalaxy({ fuelHoard: 5_000 }), 5);
  let kitId;
  ({ s, kitId } = P.grantPrefectureKit(s, 'g1', TARGET));
  s = P.survey(s, 'g1', PLANET_A);
  s = accept(s, P.plant('g1', kitId, SLOT_A1));
  const map = mapOf(resolveControl(s));
  const contested = diskOf(HOME.id).filter((h) => dist(h, centreOf(TARGET)) <= 1);
  for (const h of contested) assert.equal(map.get(keyOf(h)).claimId, HOME_CLAIM, 'the older of g1\'s two claims won it');
  assert.equal(map.get(keyOf(centreOf(TARGET))).claimId, 'claim_prefecture_g1_01');
  assert.equal([...map.values()].filter((row) => row.guildId === 'g1').length, 14 - contested.length);
});

// --- 2. the own-centre override ------------------------------------------------------------------------------------

test('OWN-CENTRE OVERRIDE: two adjacent systems — the junior keeps its centre inside the senior\'s disk; the senior takes the majority', () => {
  const s = galaxyOf([claim('g1', ADJ_A, 0), claim('g2', ADJ_B, 5)]);
  const map = mapOf(resolveControl(s));
  assert.equal(dist(centreOf(ADJ_B), centreOf(ADJ_A)) <= getClaimRadius(ADJ_A), true, 'the senior\'s disk covers the junior\'s centre');
  assert.equal(controlledBy(s, centreOf(ADJ_B)), 'g2', 'the junior holds its own centre regardless of seniority');
  assert.equal(map.get(keyOf(centreOf(ADJ_B))).claimId, `claim_g2_${ADJ_B}`);
  assert.equal(controlledBy(s, centreOf(ADJ_A)), 'g1', 'and the senior its own');
  const won = SHARED_AB.filter((h) => map.get(keyOf(h)).guildId === 'g1');
  assert.equal(won.length, 3, 'the senior takes 3 of the 4 contested hexes: its centre and the two ring hexes');
  assert.deepEqual(SHARED_AB.filter((h) => map.get(keyOf(h)).guildId === 'g2').map(keyOf), [keyOf(centreOf(ADJ_B))], 'the junior only its centre');
  // The override is the centre's ALONE: swap the ages and it is the other centre that is defended.
  const swapped = mapOf(resolveControl(galaxyOf([claim('g1', ADJ_A, 5), claim('g2', ADJ_B, 0)])));
  assert.equal(swapped.get(keyOf(centreOf(ADJ_A))).guildId, 'g1');
  assert.equal(SHARED_AB.filter((h) => swapped.get(keyOf(h)).guildId === 'g2').length, 3);
});

// --- 3. the tie-break ----------------------------------------------------------------------------------------------

test('TIE-BREAK: equal claimedAtTick -> the LOWER claimId takes the contested ring hexes; each still keeps its centre', () => {
  const ring = SHARED_AB.filter((h) => keyOf(h) !== keyOf(centreOf(ADJ_A)) && keyOf(h) !== keyOf(centreOf(ADJ_B)));
  assert.equal(ring.length, 2);
  // g2 owns the lower id here — so it is the id that decides, not the guild, not the system.
  const s = galaxyOf([claim('g1', ADJ_A, 3, 'claim_b'), claim('g2', ADJ_B, 3, 'claim_a')]);
  for (const h of ring) assert.equal(controlledBy(s, h), 'g2', `${keyOf(h)} — the lower claimId`);
  assert.equal(controlledBy(s, centreOf(ADJ_A)), 'g1', 'the tie never takes a centre');
  // Swap the ids and the ring goes the other way.
  const t = galaxyOf([claim('g1', ADJ_A, 3, 'claim_a'), claim('g2', ADJ_B, 3, 'claim_b')]);
  for (const h of ring) assert.equal(controlledBy(t, h), 'g1');
  // The order of `state.claims` decides nothing.
  const reversed = galaxyOf([claim('g2', ADJ_B, 3, 'claim_a'), claim('g1', ADJ_A, 3, 'claim_b')]);
  assert.deepEqual(resolveControl(reversed), resolveControl(s));
});

test('TIE-BREAK on a real plant: a Prefecture planted at tick 0, the home\'s own tick — "claim_g1_…" sorts below "claim_prefecture_…"', () => {
  const s = planted({ wait: 0 });
  assert.equal(s.claims.find((c) => c.claimId === G2_CLAIM).claimedAtTick, 0, 'the two claims tie');
  for (const h of diskOf(HOME.id).filter((x) => dist(x, centreOf(TARGET)) <= 1)) {
    assert.equal(resolveControl(s).find((row) => keyOf(row) === keyOf(h)).claimId, HOME_CLAIM, 'the lower claimId wins the tie');
  }
});

test('THE TICK OUTRANKS THE ID: an older claim with a HIGHER claimId still wins the contested hexes', () => {
  const s = galaxyOf([claim('g1', ADJ_A, 1, 'claim_z'), claim('g2', ADJ_B, 2, 'claim_a')]);
  const ring = SHARED_AB.filter((h) => keyOf(h) !== keyOf(centreOf(ADJ_A)) && keyOf(h) !== keyOf(centreOf(ADJ_B)));
  for (const h of ring) assert.equal(controlledBy(s, h), 'g1');
});

// --- 4. agreement with the accessors -------------------------------------------------------------------------------

test('AGREEMENT: a held centre is systemHolder\'s; an uncontested hex is its one claim\'s owner; an uncovered hex is null; every row is controlledBy', () => {
  for (const s of [planted(), galaxyOf([claim('g1', ADJ_A, 0), claim('g2', ADJ_B, 5)])]) {
    for (const c of s.claims.filter((x) => x.landmarkKind === 'system')) {
      assert.equal(controlledBy(s, centreOf(c.landmarkId)), systemHolder(s, c.landmarkId), `${c.landmarkId}'s centre`);
    }
    for (const row of resolveControl(s)) {
      assert.equal(controlledBy(s, row), row.guildId, `${keyOf(row)}: the map row and controlledBy are one answer`);
      const covering = controlNear(s, row, 0).filter((f) => f.kind === 'system');
      assert.ok(covering.some((f) => f.claimId === row.claimId && f.guildId === row.guildId), `${keyOf(row)}: the winner is one of the claims covering it`);
      if (covering.length === 1) assert.equal(row.guildId, covering[0].guildId, `${keyOf(row)}: uncontested — its one claim's owner`);
    }
  }
  const s = planted();
  const outside = { q: HOME_HEX.q + 5, r: HOME_HEX.r - 5 };
  assert.deepEqual(controlNear(s, outside, 0), [], 'no footprint covers it');
  assert.equal(controlledBy(s, outside), null);
  assert.equal(resolveControl(s).some((row) => keyOf(row) === keyOf(outside)), false);
});

// --- 5. recompute on change ----------------------------------------------------------------------------------------

test('RECOMPUTE ON CHANGE: remove the senior claim and the junior expands to its whole disk; the senior\'s other hexes are nobody\'s', () => {
  const both = galaxyOf([claim('g1', ADJ_A, 0), claim('g2', ADJ_B, 5)]);
  assert.equal(resolveControl(both).filter((row) => row.guildId === 'g2').length, 7 - 3, 'before: the junior lost three hexes');
  // No production path removes a claim yet (§19 #67, #69); the test edits the claim board directly.
  const juniorAlone = structuredClone(both);
  juniorAlone.claims = juniorAlone.claims.filter((c) => c.ownerGuildId !== 'g1');
  const rows = resolveControl(juniorAlone);
  assert.deepEqual(rows.map(keyOf).sort(), diskOf(ADJ_B).map(keyOf).sort(), 'the junior now holds its full footprint');
  assert.equal(rows.every((row) => row.guildId === 'g2'), true);
  for (const h of diskOf(ADJ_A).filter((x) => dist(x, centreOf(ADJ_B)) > 1)) {
    assert.equal(controlledBy(juniorAlone, h), null, `${keyOf(h)} reverts to uncontrolled`);
  }
});

test('RECOMPUTE ON CHANGE, three claims: remove the senior and its contested hexes pass to the NEXT oldest claim, not the youngest', () => {
  // Three systems whose disks all cover one hex that is none of their centres — found in the seed (the first such
  // trio in id order), so a regen carries it.
  const ids = seed.systems.map((x) => x.id).sort();
  const sharedBy = (trio) => diskOf(trio[0]).find((h) => trio.every((id) => dist(h, centreOf(id)) <= 1)
    && !trio.some((id) => keyOf(centreOf(id)) === keyOf(h)));
  let trio = null;
  for (const a of ids) {
    const near = ids.filter((b) => b > a && dist(centreOf(a), centreOf(b)) <= 2);
    for (const b of near) {
      const c = near.find((x) => x > b && sharedBy([a, b, x]));
      if (c) { trio = [a, b, c]; break; }
    }
    if (trio) break;
  }
  assert.ok(trio, 'the seed has three systems whose disks share a hex that is nobody\'s centre');
  const [a, b, c] = trio;
  const shared = sharedBy(trio);
  const all = galaxyOf([claim('g1', a, 1), claim('g2', b, 2), claim('g3', c, 3)]);
  assert.equal(controlledBy(all, shared), 'g1', 'the oldest of three');
  const without = structuredClone(all);
  without.claims = without.claims.filter((x) => x.ownerGuildId !== 'g1');
  assert.equal(controlledBy(without, shared), 'g2', 'the next oldest, now senior');
});

// --- 6. the oracle -------------------------------------------------------------------------------------------------

// oracleOwner(claims, hex) -> §2 written out again, sharing nothing with sim/claims.js but the seed: the FIRST
// system claim naming a system whose centre this is (rule 3, and `systemHolder`'s "first row"); else, among the
// system claims whose disk covers the hex, the oldest claimedAtTick, ties to the lower claimId; else nobody.
function oracleOwner(claims, hex) {
  const systemClaims = claims.filter((c) => c.landmarkKind === 'system');
  const atCentre = systemClaims.find((c) => dist(centreOf(c.landmarkId), hex) === 0);
  if (atCentre) return atCentre;
  const covering = systemClaims.filter((c) => diskOf(c.landmarkId).some((h) => keyOf(h) === keyOf(hex)));
  if (covering.length === 0) return null;
  return covering.slice().sort((x, y) => (x.claimedAtTick - y.claimedAtTick) || (x.claimId < y.claimId ? -1 : 1))[0];
}

test('THE ORACLE: around a dense cluster of claims (ties included), the map and controlledBy equal §2 written out independently, hex for hex', () => {
  // The seed system with the most others within 3 hexes, and those others — every disk in reach of another's.
  const ids = seed.systems.map((x) => x.id).sort();
  const hub = ids.map((id) => ({ id, n: ids.filter((o) => o !== id && dist(centreOf(id), centreOf(o)) <= 3).length }))
    .sort((x, y) => y.n - x.n || (x.id < y.id ? -1 : 1))[0].id;
  const cluster = [hub, ...ids.filter((o) => o !== hub && dist(centreOf(hub), centreOf(o)) <= 3)];
  assert.ok(cluster.length >= 3, `a cluster worth testing (${cluster.length} systems)`);
  // Owners and ticks cycle so neighbours differ, and every third claim shares tick 4 — ties are in play.
  const claims = cluster.map((id, i) => claim(`g${(i % 3) + 1}`, id, i % 3 === 0 ? 4 : i + 1, `claim_${String(cluster.length - i).padStart(2, '0')}`));
  const s = galaxyOf(claims, 50);
  const rows = resolveControl(s);
  const map = mapOf(rows);
  let asked = 0;
  let contested = 0;
  const c = centreOf(hub);
  for (let q = c.q - 6; q <= c.q + 6; q += 1) {
    for (let r = c.r - 6; r <= c.r + 6; r += 1) {
      const hex = { q, r };
      const want = oracleOwner(claims, hex);
      const row = map.get(keyOf(hex));
      asked += 1;
      if (claims.filter((x) => diskOf(x.landmarkId).some((h) => keyOf(h) === keyOf(hex))).length > 1) contested += 1;
      assert.equal(controlledBy(s, hex), want ? want.ownerGuildId : null, `controlledBy ${keyOf(hex)}`);
      assert.deepEqual(row || null, want ? { q, r, guildId: want.ownerGuildId, claimId: want.claimId } : null, `map row ${keyOf(hex)}`);
    }
  }
  assert.ok(contested >= 2, `the cluster really contests hexes (${contested}), so the oracle compares something`);
  // Every map row lies inside the box asked about, so the map holds nothing the oracle did not rule on.
  assert.equal(rows.every((row) => Math.abs(row.q - c.q) <= 6 && Math.abs(row.r - c.r) <= 6), true, `all ${rows.length} rows were asked (${asked} hexes)`);
});

// --- 7. scope: the system layer only -------------------------------------------------------------------------------

test('SCOPE: an Outpost\'s own hex is NOT in the map (no claim row, no seniority) — controlNear still lists it', () => {
  let s = planted();
  const free = [3, 4, 5].map((k) => ({ q: HOME_HEX.q + k, r: HOME_HEX.r }))
    .find((h) => isHexInBounds(h.q, h.r) && !seedLandmarkAtHex(h.q, h.r) && controlledBy(s, h) === null);
  assert.ok(free, 'a bare hex outside every disk');
  s = accept(s, createSpawnOutpostAction({ guildId: 'g1', anchorSystemId: HOME.id, coords: free }));
  assert.deepEqual(controlNear(s, free, 0).map((f) => f.kind), ['outpost'], 'controlNear lists the Outpost\'s footprint');
  assert.equal(controlledBy(s, free), null, 'the seniority map is the system layer only');
  assert.equal(resolveControl(s).some((row) => keyOf(row) === keyOf(free)), false);
});

// --- 8. determinism, and derived-never-stored ----------------------------------------------------------------------

test('DETERMINISM: sorted by q then r with no repeats; any order of state.claims gives the same map; a replayed plant gives the same bytes', () => {
  const s = galaxyOf([claim('g1', ADJ_A, 0), claim('g2', ADJ_B, 5)]);
  const rows = resolveControl(s);
  const sorted = rows.slice().sort((a, b) => a.q - b.q || a.r - b.r);
  assert.deepEqual(rows, sorted, 'sorted by q then r');
  assert.equal(new Set(rows.map(keyOf)).size, rows.length, 'one row per hex');
  const reversed = structuredClone(s);
  reversed.claims.reverse();
  assert.deepEqual(resolveControl(reversed), rows, 'the order of the claim board decides nothing');
  assert.equal(JSON.stringify(resolveControl(planted())), JSON.stringify(resolveControl(planted())), 'replay-identical');
  assert.equal(JSON.stringify(buildSnapshot(planted()).controlMap), JSON.stringify(buildSnapshot(planted()).controlMap));
});

test('DERIVED, NEVER STORED: asking for the map — or a snapshot — writes nothing, and the state hash does not move', () => {
  const s = planted();
  const before = structuredClone(s);
  const hash = hashState(s);
  resolveControl(s);
  controlledBy(s, centreOf(TARGET));
  buildSnapshot(s);
  buildSnapshot(s, 'g2');
  assert.deepEqual(s, before);
  assert.equal(hashState(s), hash);
  assert.equal('controlMap' in s, false, 'no state key');
});

// --- 9. the snapshot -----------------------------------------------------------------------------------------------

test('THE SNAPSHOT: `controlMap` is resolveControl, emitted right after `claims` — and [] when no system is held', () => {
  const s = planted();
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.controlMap, resolveControl(s));
  const keys = Object.keys(snap);
  assert.equal(keys[keys.indexOf('claims') + 1], 'controlMap', 'beside the claims it is derived from');
  const zero = buildSnapshot(createZeroState());
  assert.ok(zero.claims.length > 0, 'the zero state carries the Syndicate\'s claims…');
  assert.deepEqual(zero.controlMap, [], '…none a system, so the map is empty — but present');
});

test('THE SNAPSHOT IS PUBLIC: every guild\'s view carries the god\'s-eye map whole — the rival\'s contested hexes included', () => {
  const s = planted();
  const full = buildSnapshot(s).controlMap;
  assert.equal(TOP_LEVEL.public.includes('controlMap'), true);
  assert.equal(TOP_LEVEL.filtered.includes('controlMap'), false);
  for (const guildId of ['g1', 'g2']) {
    assert.deepEqual(buildSnapshot(s, guildId).controlMap, full, `${guildId}'s view`);
  }
  assert.ok(full.some((row) => row.guildId === 'g1') && full.some((row) => row.guildId === 'g2'), 'both guilds\' control is in it');
});

test('THE STRIP: it removes exactly `controlMap`, and refuses to be vacuous — no key, or a held system with an empty map', () => {
  const snap = buildSnapshot(planted());
  const stripped = withoutControlMap(snap);
  const { controlMap, ...rest } = snap;
  assert.ok(controlMap.length > 0);
  assert.equal(JSON.stringify(stripped), JSON.stringify(rest), 'nothing else touched, key order kept');
  assert.throws(() => withoutControlMap(rest), /carries no controlMap/);
  assert.throws(() => withoutControlMap({ ...snap, controlMap: [] }), /a system is held, yet the controlMap is empty/);
  assert.deepEqual(Object.keys(withoutControlMap(buildSnapshot(createZeroState()))).includes('controlMap'), false, 'an empty map with no held system is fine');
});

// --- 10. fail loud -------------------------------------------------------------------------------------------------

test('FAIL LOUD: a covering claim with no whole claimedAtTick halts the map, naming the claim — seniority cannot rank it', () => {
  const s = galaxyOf([claim('g1', ADJ_A, 0), claim('g2', ADJ_B, 5)]);
  const broken = structuredClone(s);
  delete broken.claims[1].claimedAtTick;
  assert.throws(() => controlledBy(broken, centreOf(ADJ_A)), new RegExp(`claim "claim_g2_${ADJ_B}" \\(guild "g2", system "${ADJ_B}"\\) carries no whole claimedAtTick`));
  assert.throws(() => resolveControl(broken), /seniority cannot rank it/);
  assert.throws(() => buildSnapshot(broken), /seniority cannot rank it/);
});

test('THE INVARIANT: a missing or future claimedAtTick, and a repeated claimId, are flagged — the facts seniority needs', () => {
  const s = galaxyOf([claim('g1', ADJ_A, 0), claim('g2', ADJ_B, 5)]);
  const rules = (x) => checkInvariants(x, x.tick).map((v) => v.rule);

  const missing = structuredClone(s);
  delete missing.claims[0].claimedAtTick;
  assert.deepEqual(rules(missing), ['claim-claimedAtTick-is-a-past-tick (§15.2)']);

  const future = structuredClone(s);
  future.claims[1].claimedAtTick = s.tick + 1;
  assert.deepEqual(rules(future), ['claim-claimedAtTick-is-a-past-tick (§15.2)']);

  const fractional = structuredClone(s);
  fractional.claims[1].claimedAtTick = 2.5;
  assert.deepEqual(rules(fractional), ['claim-claimedAtTick-is-a-past-tick (§15.2)']);

  const repeated = structuredClone(s);
  repeated.claims[1].claimId = repeated.claims[0].claimId;
  const v = checkInvariants(repeated, repeated.tick);
  assert.deepEqual(v.map((x) => x.rule), ['claim-id-unique (design.md §15.4)']);
  assert.deepEqual(v[0].detail, { claimId: `claim_g1_${ADJ_A}` });
});
