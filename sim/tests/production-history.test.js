'use strict';

// The persistent per-(system, good) production/consumption HISTORY buffer
// (guild.productionHistory, sim/history.js) — the console's two trend sparklines,
// moved out of the browser and into engine state so they survive a reload and read the
// same for every viewer. These are the tripwires the slice must ship (§18 #4 —
// mechanical tripwires over review), in the window-accrual.test.js style: controlled
// single-system scenarios, exact numbers. They pin:
//   (a) a producing good accrues one sample per tick, in order
//   (b) the ring caps at HISTORY_N and drops the OLDEST sample
//   (c) an idle galaxy mints no key at all (sparse — the byte-identical no-op)
//   (d) a series stays CONTIGUOUS through a lull (a 0 is pushed, not a gap)
//   (e) consumption records the real downstream draw, and refined output counts as
//       production even when something downstream eats it
//   (f) the snapshot carries the series verbatim, per system, keyed by good
//   (g) determinism: the buffer is stored state and reproduces byte for byte
//   (h) the invariant sweep catches a rotted series

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { HISTORY_N, getHistory, pushHistory } = require('../history.js');

const SYS = 'sysA';
const mine = (id, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate,
});
const refinery = (id, recipeId, rate) => ({
  id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate,
});
const hist = (s, good) => getHistory(s.guilds[0], SYS, good);

function sysState(ventures, stockpiles = {}) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: Object.keys(stockpiles).length ? { [SYS]: stockpiles } : {},
      ventures,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}

// --- (a) one sample per tick, oldest -> newest ----------------------------------

test('(a) a producing good accrues one sample per tick, in tick order', () => {
  let s = sysState([mine('t', 'titanium', 7)]);
  assert.equal(hist(s, 'titanium'), null, 'nothing recorded before the first tick');

  for (let i = 0; i < 5; i += 1) s = tick(s);

  const h = hist(s, 'titanium');
  assert.deepEqual(h.prod, [7, 7, 7, 7, 7], 'five ticks, five samples of the mine rate');
  assert.deepEqual(h.cons, [0, 0, 0, 0, 0], 'nothing consumes titanium here');
  assert.equal(h.prod.length, s.tick, 'exactly one sample per producing tick');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- (b) the ring caps at HISTORY_N, dropping the OLDEST ------------------------

test('(b) the series ring-caps at HISTORY_N and drops the oldest sample', () => {
  // Through the tick, every sample of a steady mine is the same number, so this test
  // pins the LENGTH cap only — that the ring really is a ring and does not grow without
  // bound. WHICH sample gets dropped is pinned separately, in (b2), against distinct
  // values the accessor is fed directly.
  let s = sysState([mine('t', 'titanium', 3)]);
  for (let i = 0; i < HISTORY_N + 25; i += 1) s = tick(s);

  const h = hist(s, 'titanium');
  assert.equal(h.prod.length, HISTORY_N, 'the prod ring never grows past the cap');
  assert.equal(h.cons.length, HISTORY_N, 'nor the cons ring');
  assert.ok(s.tick > HISTORY_N, 'the run really did outlast the ring (otherwise this proves nothing)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('(b2) the dropped sample is the OLDEST — the series is the RECENT tail', () => {
  // Asserted against the accessor directly, with DISTINCT values. Through the tick the
  // samples in a controlled scenario are all equal, so "the oldest fell off" would be
  // vacuously true there; here each sample is its own tick number, so the tail is
  // unambiguous.
  const guild = { id: 'g1' };
  for (let i = 1; i <= HISTORY_N + 4; i += 1) pushHistory(guild, SYS, 'titanium', i, i * 2);

  const h = getHistory(guild, SYS, 'titanium');
  assert.equal(h.prod.length, HISTORY_N, 'capped');
  assert.equal(h.prod[0], 5, 'the first four samples fell off the front');
  assert.equal(h.prod[HISTORY_N - 1], HISTORY_N + 4, 'and the newest sample is last');
  assert.deepEqual(h.cons, h.prod.map((v) => v * 2), 'both series slid in lockstep');
});

// --- (c) sparse: an idle galaxy mints no key -----------------------------------

test('(c) an idle galaxy mints NO productionHistory key (sparse, byte-identical)', () => {
  // A guild with no ventures at all: nothing is mined, nothing is refined, so there is
  // no good to record. This is the discipline that makes the golden-hash regen provable
  // — the same rule guild.syndicateWindows follows for an unlicensed guild.
  let s = sysState([]);
  const before = hashState(s);
  for (let i = 0; i < 10; i += 1) s = tick(s);

  assert.equal(s.guilds[0].productionHistory, undefined, 'no key is minted at all');
  assert.ok(!JSON.stringify(s).includes('productionHistory'), 'and none appears anywhere in serialized state');
  assert.deepEqual(checkInvariants(s, s.tick), []);
  // The state DID move on (the tick counter), so this is not a vacuous assertion.
  assert.notEqual(hashState(s), before);
});

test('(c2) a good that never moves gets no key even while its neighbour records', () => {
  // Two mines, one good each. `carbon_products` is mined; `silica` is not mined here and
  // nothing consumes it — it must never appear, or the buffer would bloat with every
  // good in the catalog.
  let s = sysState([mine('c', 'carbon_products', 4)]);
  for (let i = 0; i < 3; i += 1) s = tick(s);

  const perGood = s.guilds[0].productionHistory[SYS];
  assert.deepEqual(Object.keys(perGood), ['carbon_products'], 'only the good that actually moved');
  assert.equal(hist(s, 'silica'), null);
});

// --- (d) contiguity through a lull ---------------------------------------------

test('(d) an active series stays CONTIGUOUS through a lull — a 0, never a gap', () => {
  // A refinery with a starving input: `titanium_alloy` needs 3 titanium + 1 carbon per
  // batch, and only carbon is mined here. So the alloy line is routed every tick (carbon
  // has a consumer) but runs at rate 0 and draws nothing. What is pinned is that carbon's
  // series still has one sample per tick with no hole in it, because a hole would draw a
  // slope between two ticks that are not adjacent.
  let s = sysState([mine('c', 'carbon_products', 2), refinery('r', 'titanium_alloy', 1)]);
  for (let i = 0; i < 6; i += 1) s = tick(s);

  const h = hist(s, 'carbon_products');
  assert.equal(h.prod.length, 6, 'a sample every tick');
  assert.equal(h.cons.length, 6);
  assert.deepEqual(h.prod, [2, 2, 2, 2, 2, 2], 'the mine ran every tick');
  // The starved line draws nothing at all (its rate is 0 — its titanium input is
  // absent), so carbon's consumption is a genuine run of zeroes, recorded not skipped.
  assert.deepEqual(h.cons, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- (e) what the two numbers actually are --------------------------------------

test('(e) cons is the real downstream draw, and MINTED output counts as production', () => {
  // 3 titanium + 1 carbon -> 1 titanium_alloy, at rate 1. Both inputs are mined at
  // exactly the batch rate, so the line runs at full rate every tick from tick 1.
  let s = sysState([mine('t', 'titanium', 3), mine('c', 'carbon_products', 1), refinery('r', 'titanium_alloy', 1)]);
  for (let i = 0; i < 4; i += 1) s = tick(s);

  assert.deepEqual(hist(s, 'titanium').prod, [3, 3, 3, 3], 'mined fresh');
  assert.deepEqual(hist(s, 'titanium').cons, [3, 3, 3, 3], 'and drawn by the line, in full');
  assert.deepEqual(hist(s, 'carbon_products').cons, [1, 1, 1, 1]);

  // The output good: nothing downstream eats the alloy here, so its consumption is 0 —
  // but it IS being produced, one unit a tick, and that is what the console's producer
  // stack shows under "Production". `goods[good].fresh` counts MINE output only and
  // would have recorded 0, which is the case the old client-side buffer got wrong.
  assert.deepEqual(hist(s, 'titanium_alloy').prod, [1, 1, 1, 1], 'refinery output is production');
  assert.deepEqual(hist(s, 'titanium_alloy').cons, [0, 0, 0, 0]);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- (f) the snapshot carries it verbatim ---------------------------------------

test('(f) the snapshot carries the series per system, keyed by good, byte-for-byte', () => {
  let s = sysState([mine('t', 'titanium', 6)]);
  for (let i = 0; i < 3; i += 1) s = tick(s);

  const snap = buildSnapshot(s);
  const sys = snap.production.find((p) => p.guildId === 'g1').systems.find((x) => x.systemId === SYS);
  assert.deepEqual(sys.history.titanium, { prod: [6, 6, 6], cons: [0, 0, 0] },
    'the console reads the stored series with no reshaping');
  assert.deepEqual(sys.history.titanium, hist(s, 'titanium'), 'and it is the stored buffer, verbatim');

  // COPIED, not aliased: the snapshot goes out over HTTP, and a consumer mutating it
  // must not be able to reach into engine state (the discipline cloneProfile follows).
  sys.history.titanium.prod.push(999);
  assert.deepEqual(hist(s, 'titanium').prod, [6, 6, 6], 'engine state is untouched by a snapshot edit');
});

test('(f2) a system with no history yet reports an empty map, not a missing key', () => {
  const s = sysState([mine('t', 'titanium', 6)]); // tick 0 — nothing recorded yet
  const snap = buildSnapshot(s);
  const sys = snap.production.find((p) => p.guildId === 'g1').systems.find((x) => x.systemId === SYS);
  assert.deepEqual(sys.history, {}, 'the client can read `.history[good]` without a guard on the map itself');
});

// --- (g) determinism (invariant 9) ----------------------------------------------

test('(g) determinism: the buffer is stored state and reproduces byte for byte', () => {
  const build = () => {
    let s = sysState([mine('t', 'titanium', 3), mine('c', 'carbon_products', 1), refinery('r', 'titanium_alloy', 1)]);
    for (let i = 0; i < 70; i += 1) s = tick(s);
    return s;
  };
  const a = build();
  const b = build();
  assert.equal(hashState(a), hashState(b), 'two runs of the same start agree to the byte');
  // The buffer really is IN the hash — that is the point, and it is what the golden
  // regen had to account for. If it were somehow excluded, this would pass vacuously.
  assert.ok(JSON.stringify(a).includes('productionHistory'), 'the buffer is genuinely in serialized state');
});

// --- (h) the tripwire itself -----------------------------------------------------

test('(h) the invariant sweep catches a rotted series', () => {
  let s = sysState([mine('t', 'titanium', 3)]);
  for (let i = 0; i < 4; i += 1) s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'a healthy buffer trips nothing');

  // A fractional sample: goods are integers (§15.2), so this is a real corruption.
  const rotted = structuredClone(s);
  rotted.guilds[0].productionHistory[SYS].titanium.prod[1] = 2.5;
  assert.ok(checkInvariants(rotted, rotted.tick).some((v) => v.where.includes('productionHistory')),
    'a non-integer sample is caught');

  // Two series of different lengths no longer share an x-axis — the two lines would be
  // drawn against different ticks.
  const skewed = structuredClone(s);
  skewed.guilds[0].productionHistory[SYS].titanium.cons.pop();
  assert.ok(skewed && checkInvariants(skewed, skewed.tick)
    .some((v) => v.rule.includes('share-an-x-axis')), 'a length mismatch is caught');

  // A ring that stopped ringing would grow without bound and bloat every save.
  const overlong = structuredClone(s);
  const series = overlong.guilds[0].productionHistory[SYS].titanium;
  while (series.prod.length <= HISTORY_N) { series.prod.push(1); series.cons.push(0); }
  assert.ok(checkInvariants(overlong, overlong.tick)
    .some((v) => v.rule.includes('ring-capped')), 'an over-long series is caught');
});
