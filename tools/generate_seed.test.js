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
