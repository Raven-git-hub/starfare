'use strict';

// Slice 2c-i: the §5 review flag, computed engine-side on the READ path
// (`reviewSystem` in sim/production.js, surfaced via `previewProduction` and the
// snapshot). It is read-only telemetry — it moves no goods and is not consulted by
// the tick — so production is a provable no-op. These tests pin each of the three
// triggers, the deliberate (c)-scoping and (d)-exclusion, the no-op + determinism,
// purity, and the snapshot emission (schema 5).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { hashState } = require('../serialize.js');
const { getStock } = require('../stock.js');
const { computeGalacticSupply } = require('../supply.js');
const { reviewSystem, previewProduction } = require('../production.js');
const { buildSnapshot, SNAPSHOT_SCHEMA } = require('../snapshot.js');

const SYS = 'sysA';
const mine = (id, good, rate) => ({ id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate });
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const held = (s, good) => getStock(s.guilds[0], SYS, good);

function sysState({ ventures, profile = {}, stockpiles = {} }) {
  return createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      stockpiles: Object.keys(stockpiles).length ? { [SYS]: stockpiles } : {},
      productionProfile: Object.keys(profile).length ? { [SYS]: profile } : {},
      ventures,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
}
const review = (s) => reviewSystem(s.guilds[0], SYS);

// --- (a) stale throttle --------------------------------------------------------

test('(a) a throttle naming a removed venture flags stale_throttle', () => {
  // r_a exists; the profile also throttles r_b, which is not in the system.
  const s = sysState({
    ventures: [refinery('r_a', 'conductive_material', 10)],
    profile: { throttles: { r_a: 100, r_b: 50 } },
  });
  assert.deepEqual(review(s), [{ kind: 'stale_throttle', ventureId: 'r_b' }]);
});

// --- (b) stale good policy -----------------------------------------------------

test('(b) a goods policy for a good with no producer flags stale_good_policy', () => {
  // The system produces titanium/carbon/titanium_alloy; a stored policy for gold
  // (no producer) is stale. Titanium & carbon are both consumed, so no (c) noise.
  const s = sysState({
    ventures: [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
    profile: { goods: { gold: { downstreamPct: 50 } } },
  });
  assert.deepEqual(review(s), [{ kind: 'stale_good_policy', good: 'gold' }]);
});

// --- (c) unmanaged raw surplus -------------------------------------------------

test('(c) a lone mine — raw good, no consumer, no policy — flags unmanaged_surplus', () => {
  const s = sysState({ ventures: [mine('t', 'titanium', 5)] });
  assert.deepEqual(review(s), [{ kind: 'unmanaged_surplus', good: 'titanium' }]);
});

test('(c) is silenced by setting ANY policy for that good', () => {
  // Same lone mine, but the player has set a policy for titanium — the nudge is gone.
  const s = sysState({
    ventures: [mine('t', 'titanium', 5)],
    profile: { goods: { titanium: { downstreamPct: 50 } } },
  });
  assert.deepEqual(review(s), []);
});

test('(c) does NOT fire when a refinery consumes the raw good', () => {
  // titanium & carbon are both recipe inputs of titanium_alloy → consumed, not surplus.
  const s = sysState({
    ventures: [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
  });
  assert.deepEqual(review(s), []);
});

test('(c) is raw-only: a processed refinery output nothing consumes does NOT flag', () => {
  // titanium_alloy is produced and consumed by nothing, but it is PROCESSED, so it
  // is never an unmanaged_surplus (piling processed output is normal). The raw
  // inputs are consumed, so the whole review is clean.
  const s = sysState({
    ventures: [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
  });
  const r = review(s);
  assert.deepEqual(r, []);
  assert.equal(r.some((i) => i.good === 'titanium_alloy'), false, 'the processed output is never flagged');
});

// --- (d) chosen scarcity is NOT flagged (the key negative test) ----------------

test('(d) a consumer starved by a chosen downstream cap is NOT an issue', () => {
  // A 10% downstream cap starves the refinery and titanium piles up — but that is
  // the player's deliberate choice, so (d) computes nothing: titanium is consumed
  // (no (c)) and its policy is for a produced good (no (b)). The review stays empty
  // even as the pile grows over ticks.
  let s = sysState({
    ventures: [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
    profile: { goods: { titanium: { downstreamPct: 10 } } },
  });
  assert.deepEqual(review(s), [], 'no issue at tick 0');
  for (let i = 0; i < 5; i += 1) s = tick(s);
  assert.ok(held(s, 'titanium') > 0, 'titanium is genuinely piling from the chosen cap');
  assert.deepEqual(review(s), [], 'chosen scarcity is still not flagged after the pile forms');
});

// --- determinism of the sorted list --------------------------------------------

test('the review list is deterministically sorted by (kind, ventureId|good)', () => {
  // One of each kind plus two stale throttles, deliberately fed in a jumbled order.
  const s = sysState({
    ventures: [mine('t', 'titanium', 5)], // titanium: no consumer, no policy → (c)
    profile: {
      goods: { gold: { downstreamPct: 50 }, silver: { downstreamPct: 50 } }, // both stale → (b)
      throttles: { z_line: 50, a_line: 50 }, // both stale → (a)
    },
  });
  assert.deepEqual(review(s), [
    { kind: 'stale_good_policy', good: 'gold' },
    { kind: 'stale_good_policy', good: 'silver' },
    { kind: 'stale_throttle', ventureId: 'a_line' },
    { kind: 'stale_throttle', ventureId: 'z_line' },
    { kind: 'unmanaged_surplus', good: 'titanium' },
  ]);
});

// --- no-op on production + determinism ------------------------------------------

test('no-op: the review moves no goods — a review-triggering profile leaves supply untouched', () => {
  // Two identical mine→refinery chains; one also carries a stale throttle + stale
  // policy + an unmanaged second mine. The review differs; the produced supply does not.
  const ventures = () => [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2), mine('g', 'gold', 4)];
  let clean = sysState({ ventures: ventures() });
  let noisy = sysState({ ventures: ventures(), profile: { throttles: { ghost: 50 }, goods: { lead: { downstreamPct: 20 } } } });
  for (let i = 0; i < 50; i += 1) { clean = tick(clean); noisy = tick(noisy); }
  assert.deepEqual(computeGalacticSupply(noisy).resources, computeGalacticSupply(clean).resources, 'review issues do not move goods');
  assert.ok(review(noisy).length > 0, 'the noisy state really does raise review issues');
  // gold is an unmanaged surplus in BOTH (raw, no consumer, no policy) — sanity.
  assert.equal(review(clean).some((i) => i.kind === 'unmanaged_surplus' && i.good === 'gold'), true);
});

test('determinism: same start, run twice to tick 50, identical hash (review present)', () => {
  const build = () => {
    let s = sysState({
      ventures: [mine('t', 'titanium', 5), mine('c', 'carbon_products', 5), refinery('r', 'titanium_alloy', 2)],
      profile: { throttles: { ghost: 50 }, goods: { gold: { downstreamPct: 20 } } },
    });
    for (let i = 0; i < 50; i += 1) s = tick(s);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
});

// --- purity --------------------------------------------------------------------

test('purity: previewProduction does not mutate state, even when it raises issues', () => {
  const s = sysState({
    ventures: [mine('t', 'titanium', 5)],
    profile: { throttles: { ghost: 50 } },
  });
  const before = hashState(s);
  const preview = previewProduction(s);
  assert.equal(hashState(s), before, 'state is byte-identical after computing the review');
  assert.ok(preview[0].systems[0].review.length > 0, 'the preview really did compute issues');
});

// --- snapshot emission ---------------------------------------------------------

test('snapshot: schema is 5 and the production block carries the review array', () => {
  assert.equal(SNAPSHOT_SCHEMA, 5);
  const s = sysState({
    ventures: [mine('t', 'titanium', 5)],
    profile: { throttles: { ghost: 50 } },
  });
  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, 5);
  const sysReport = snap.production.find((p) => p.guildId === 'g1').systems.find((r) => r.systemId === SYS);
  assert.deepEqual(sysReport.review, [
    { kind: 'stale_throttle', ventureId: 'ghost' },
    { kind: 'unmanaged_surplus', good: 'titanium' },
  ]);
});
