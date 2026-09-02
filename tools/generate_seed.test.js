'use strict';
// Tripwire tests for the galaxy seed generator (tools/generate_seed.js).
// Run: node --test tools/generate_seed.test.js
//
// These guard the load-bearing generation invariants — most centrally
// determinism (design.md §15.5 invariant #9) and the rare-tier gradient +
// starter guarantee (design.md §2). They drive the generator IN MEMORY via its
// exports; they never write a file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('./generate_seed.js');

const SEED = 7331; // the canonical reference seed
const RARE = G.RARE_TIER;

function build(opts) { return G.generateGalaxySeed(SEED, opts); }

// Per-ring rare-tier planet fractions for a generated galaxy.
function ringFractions(g) {
  const t = { inner: { rare: 0, tot: 0 }, middle: { rare: 0, tot: 0 }, outer: { rare: 0, tot: 0 } };
  for (const s of g.systems) {
    for (const p of s.planets) {
      t[s.ring].tot++;
      if (RARE.has(p.archetype)) t[s.ring].rare++;
    }
  }
  return {
    inner: t.inner.rare / t.inner.tot,
    middle: t.middle.rare / t.middle.tot,
    outer: t.outer.rare / t.outer.tot,
  };
}

test('determinism: same seed -> byte-identical galaxy (invariant #9)', () => {
  const a = JSON.stringify(build());
  const b = JSON.stringify(build());
  assert.equal(a, b);
});

test('different seeds -> different galaxies', () => {
  const a = JSON.stringify(build().systems);
  const b = JSON.stringify(G.generateGalaxySeed(9999).systems);
  assert.notEqual(a, b);
});

test('every system is classified into exactly one valid ring', () => {
  const g = build();
  for (const s of g.systems) {
    assert.ok(['inner', 'middle', 'outer'].includes(s.ring), `bad ring ${s.ring} on ${s.id}`);
  }
});

test('rare-tier gradient is steep and monotonic inner>middle>outer (design.md §2)', () => {
  const f = ringFractions(build());
  // Bands sit around the theoretical fractions of the sourced ×4/×1/×0.25
  // multipliers (inner 56/142≈39%, middle 14/100=14%, outer 3.5/89.5≈4%),
  // wide enough not to be brittle, tight enough to catch a broken gradient.
  assert.ok(f.inner > 0.34 && f.inner < 0.46, `inner ${f.inner.toFixed(3)} out of band`);
  assert.ok(f.middle > 0.11 && f.middle < 0.18, `middle ${f.middle.toFixed(3)} out of band`);
  assert.ok(f.outer > 0.02 && f.outer < 0.06, `outer ${f.outer.toFixed(3)} out of band`);
  assert.ok(f.inner > f.middle && f.middle > f.outer, 'gradient not monotonic');
  assert.ok(f.inner / f.outer >= 7, `inner/outer spread ${(f.inner / f.outer).toFixed(1)}x too shallow`);
});

test('every starter system meets the >=2 rare-tier-within-⅓-radius guarantee (design.md §2)', () => {
  const g = build();
  const { hexSize, radius } = g.galaxyParams;
  const sysPix = g.systems.map(s => G.hexToPixel(s.coords.q, s.coords.r, hexSize));
  const search = radius / 3;
  for (let i = 0; i < g.systems.length; i++) {
    if (!g.systems[i].starterEligible) continue;
    const n = G.countRareTierWithin(g.systems, sysPix, i, search);
    assert.ok(n >= 2, `starter ${g.systems[i].id} has only ${n} rare-tier within ⅓ radius`);
  }
});

test('repair pass fires zero times on seed 7331 at the default floor (design.md §16)', () => {
  assert.equal(build().stats.rareTierRepairs, 0);
});

test('validation passes on seed 7331', () => {
  const g = build();
  assert.equal(g.validation.passed, true, g.validation.issues.join('; '));
});

test('repair pass engages under stress (floor raised to 50) and still validates', () => {
  const g = build({ rareTierMinPerStarter: 50 });
  assert.ok(g.stats.rareTierRepairs > 0, 'expected repairs at floor=50');
  assert.equal(g.validation.passed, true, g.validation.issues.join('; '));
});

test('settlement slots: count matches the archetype spec, ids are distinct and sequential', () => {
  const g = build();
  for (const s of g.systems) {
    for (const p of s.planets) {
      const spec = G.SETTLEMENT_SLOTS[p.archetype];
      assert.ok(spec, `no settlement spec for archetype ${p.archetype}`);
      const n = p.settlementSlots.length;
      if (spec.fixed !== undefined) {
        assert.equal(n, spec.fixed, `${p.id} (${p.archetype}) should have exactly ${spec.fixed} slots`);
      } else {
        const [min, max] = spec.range;
        assert.ok(n >= min && n <= max, `${p.id} (${p.archetype}) slot count ${n} outside [${min},${max}]`);
      }
      // ids: `${planetId}_sNN`, 1-based, sequential, and disjoint from _nNN nodes
      p.settlementSlots.forEach((slot, i) => {
        assert.equal(slot.id, `${p.id}_s${String(i + 1).padStart(2, '0')}`);
      });
    }
  }
});

test('settlement slots: gaseous/hostile archetypes have none; terran has 15', () => {
  const g = build();
  for (const s of g.systems) {
    for (const p of s.planets) {
      if (p.archetype === 'gasGiant' || p.archetype === 'molten' || p.archetype === 'irradiated') {
        assert.equal(p.settlementSlots.length, 0, `${p.archetype} must have 0 slots`);
      }
      if (p.archetype === 'terran') {
        assert.equal(p.settlementSlots.length, 15, 'terran must have exactly 15 slots');
      }
    }
  }
});

test('settlement slots: stats.totalSettlementSlots equals the live sum', () => {
  const g = build();
  let sum = 0;
  for (const s of g.systems) for (const p of s.planets) sum += p.settlementSlots.length;
  assert.equal(g.stats.totalSettlementSlots, sum);
});

// --- node-count rebalance (design.md §2, 30-08-26) ---------------------------

test('node cap is 15: every archetype range is capped at 15 and no drawn planet exceeds it', () => {
  // The cap is 15 (Terran's fixed count and the System View pip grid's capacity).
  // Contract side: no archetype's range max may exceed the cap (Terran carries no
  // range and is the exempt exception). Realized side: no planet on a live galaxy
  // exceeds 15 nodes, and the ceiling is actually reached (it is a real cap, not
  // a number the ranges never approach).
  for (const [name, def] of Object.entries(G.ARCHETYPES)) {
    if (def.nodeRange) assert.ok(def.nodeRange[1] <= 15, `${name} range max ${def.nodeRange[1]} exceeds 15`);
  }
  const g = build();
  let maxNodes = 0;
  for (const s of g.systems) {
    for (const p of s.planets) {
      assert.ok(p.resourceNodes.length <= 15, `${p.id} (${p.archetype}) has ${p.resourceNodes.length} nodes > 15`);
      if (p.resourceNodes.length > maxNodes) maxNodes = p.resourceNodes.length;
    }
  }
  assert.equal(maxNodes, 15, 'the 15-node ceiling is actually reached somewhere');
});

test('rocky planets carry the guaranteed floor: >=2 each of titanium, copper, lead (design.md §2)', () => {
  const g = build();
  let rockyCount = 0;
  for (const s of g.systems) {
    for (const p of s.planets) {
      if (p.archetype !== 'rocky') continue;
      rockyCount++;
      const counts = {};
      for (const n of p.resourceNodes) counts[n.resourceType] = (counts[n.resourceType] || 0) + 1;
      assert.ok((counts.titanium || 0) >= 2, `${p.id} has ${counts.titanium || 0} titanium, want >=2`);
      assert.ok((counts.copper || 0) >= 2, `${p.id} has ${counts.copper || 0} copper, want >=2`);
      assert.ok((counts.lead || 0) >= 2, `${p.id} has ${counts.lead || 0} lead, want >=2`);
    }
  }
  assert.ok(rockyCount > 0, 'the seed actually contains rocky planets to check');
});

// --- waystation placement — the segmented 6×16 = 96 scheme (design.md §16 step 7) ---

// The 60° segment [0,6) a waystation's world position falls in — mirrors the
// generator's own segmentOf so the test checks the same partition it placed against.
function segmentOf(coords, hexSize) {
  const p = G.hexToPixel(coords.q, coords.r, hexSize);
  return Math.floor(((Math.atan2(p.y, p.x) + Math.PI) / (Math.PI * 2)) * 6) % 6;
}

test('waystations: 96 total, 16 per segment, ring floors >=2/>=4/>=6 met in every segment', () => {
  const g = build();
  const { hexSize, radius } = g.galaxyParams;
  assert.equal(g.outposts.length, 96, 'the segmented scheme places 6 × 16 = 96');
  assert.equal(g.stats.totalOutposts, 96, 'and the stat agrees');
  const cells = Array.from({ length: 6 }, () => ({ inner: 0, middle: 0, outer: 0 }));
  for (const o of g.outposts) {
    cells[segmentOf(o.coords, hexSize)][G.classifyRing(o.coords, hexSize, radius)]++;
  }
  for (let seg = 0; seg < 6; seg++) {
    const c = cells[seg];
    assert.ok(c.inner >= 2, `segment ${seg} inner ${c.inner} < 2`);
    assert.ok(c.middle >= 4, `segment ${seg} middle ${c.middle} < 4`);
    assert.ok(c.outer >= 6, `segment ${seg} outer ${c.outer} < 6`);
    assert.equal(c.inner + c.middle + c.outer, 16, `segment ${seg} holds exactly 16`);
  }
});

test('waystations: every pair is at least outpostMinSeparation apart', () => {
  const g = build();
  const { hexSize } = g.galaxyParams;
  const pts = g.outposts.map((o) => G.hexToPixel(o.coords.q, o.coords.r, hexSize));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      assert.ok(d >= G.PARAMS.outpostMinSeparation, `outposts ${i}/${j} only ${d.toFixed(1)} apart`);
    }
  }
});

test('waystations: an unfillable cell throws rather than placing fewer (§16 step 7)', () => {
  // A min-separation larger than the whole galaxy makes the second waystation in the
  // first cell impossible to place, so the per-cell budget is spent and the generator
  // throws — the silent-shortfall guard firing on demand.
  assert.throws(() => G.generateGalaxySeed(SEED, { outpostMinSeparation: 1e9 }), /could not fill/);
});

// Drift tripwire: the COMMITTED data/seed.json is exactly what the CLI writes.
// data/seed.json is the shared fixture the sim, the viewer, and the tests all read
// (design.md §16), so it must never silently diverge from the generator. This
// reproduces the CLI write path verbatim (the `require.main` block of
// generate_seed.js): generate 7331, post-fill the `totalHexesInGalaxy: null` the
// pure function deliberately leaves for the entrypoint, then stringify with a
// 2-space indent and NO trailing newline — what fs.writeFileSync receives. If this
// fails, data/seed.json is stale: regenerate it from tools/generate_seed.js (do not
// hand-edit). NB: the null/post-fill split is mirrored on purpose, not "fixed" here.
test('committed data/seed.json is byte-identical to the CLI output (drift tripwire)', () => {
  const g = G.generateGalaxySeed(SEED);
  g.stats.totalHexesInGalaxy = G.countTotalHexes(g.galaxyParams.radius, g.galaxyParams.hexSize);
  const cli = JSON.stringify(g, null, 2); // no trailing newline — matches the CLI writeFileSync
  const committed = fs.readFileSync(path.join(__dirname, '..', 'data', 'seed.json'), 'utf8');
  assert.equal(cli, committed, 'data/seed.json is stale — regenerate it from tools/generate_seed.js');
});
