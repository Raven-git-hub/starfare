#!/usr/bin/env node
/**
 * Galaxy Seed Generator
 * ---------------------
 * Generates the static Galaxy Seed (see design.md §15, §16):
 * a deterministic map shape — solar systems (ring-classified), planets with
 * archetypes and resource nodes, Syndicate outposts, and the Citadel. No
 * claims, no ventures, no live state of any kind. Given the same seed number,
 * always produces the identical galaxy.
 *
 * Deliberately does NOT enumerate all ~101,000 hexes into the output —
 * the hex lattice is pure geometry, reproducible from galaxyParams alone.
 * Only entities that deviate from "blank hex" are stored.
 *
 * Usage: node generate_seed.js [seed] [outputPath]
 *   e.g. node generate_seed.js 7331 ./seed.json
 */

const fs = require('fs');

// ---------- seeded RNG (identical to galaxy-map-hex.html, so results
//            are comparable/portable between generator and prototype) ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- tunable generation parameters ----------
const PARAMS = {
  radius: 2750,          // GALAXY_R — galaxy extent in world units
  hexSize: 9.5,           // HEX_SIZE — flat-top axial hex size
  citadelRadius: 4,       // hex-radius of the Citadel core (fixed Syndicate territory)
  arms: 4,                 // spiral arms
  spiralTwist: 2.6,
  targetSystems: 1500,
  numOutposts: 9,
  outpostMinSeparation: 210,  // world units, mirrors the prototype
  planetCountMin: 1,
  planetCountMax: 6,          // design intent (prototype currently caps at 5 — deliberately corrected here)
  systemClaimRadius: 1,        // ring of 6 neighbor hexes claimed alongside the system, per the state model
  rareTierMinPerStarter: 2,    // §2 guarantee: >=2 rare-tier planets within 1/3 radius of every starter system
};

// ---------- hex geometry (flat-top axial — must match galaxy-map-hex.html) ----------
function hexToPixel(q, r, hexSize) {
  return {
    x: hexSize * 1.5 * q,
    y: hexSize * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r),
  };
}

function hexDist(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

// ---------- ring classification (pipeline step 4; design.md §2) ----------
// The galaxy is split into three concentric rings by *world-space* distance
// from the Citadel (at q=0,r=0), as a fraction of the galaxy radius:
//   0 - 1/3   -> inner
//   1/3 - 2/3 -> middle
//   2/3 - 1   -> outer
// This is pure geometry — no RNG — so it never perturbs the base skeleton's
// draw order. Boundaries are lower-closed / upper-open; boundary-exact systems
// (measure-zero) fall into the outer of the pair.
const RING_INNER_FRAC = 1 / 3;
const RING_MIDDLE_FRAC = 2 / 3;

function classifyRing(coords, hexSize, radius) {
  const p = hexToPixel(coords.q, coords.r, hexSize);
  const frac = Math.hypot(p.x, p.y) / radius;
  if (frac < RING_INNER_FRAC) return 'inner';
  if (frac < RING_MIDDLE_FRAC) return 'middle';
  return 'outer';
}

// ---------- naming ----------
// Astronomical-catalog style: a sector-themed prefix (derived from which
// spiral arm / angular sector the system sits in) plus a numeric designator
// derived from its hex coordinates — evocative of real catalogs like
// "NGC 224" while staying deterministic and coordinate-traceable.
const SECTOR_PREFIXES = [
  'KES', 'VAN', 'ORU', 'DRA', 'MOL', 'ILY', 'THE', 'ZOV', 'COR', 'BAR',
  'RYN', 'FEN', 'AXE', 'PEL', 'HAL', 'QIR',
];

function systemName(q, r, arms) {
  const angle = Math.atan2(r, q);
  const sectorCount = SECTOR_PREFIXES.length;
  const sectorIdx = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * sectorCount) % sectorCount;
  // catalog number: deterministic encoding of coordinates, not their literal value —
  // keeps names traceable back to position without just printing "q12r-3"
  const raw = Math.abs(q * 733 + r * 911);
  const catalog = 1000 + (raw % 9000);
  return `${SECTOR_PREFIXES[sectorIdx]}-${catalog}`;
}

function outpostName(rand) {
  const prefixes = ['Free', 'Rim', 'Drift', 'Halo', 'Nomad', 'Waystation', 'Ledger', 'Anchor', 'Common'];
  const suffixes = ["'s Reach", ' Exchange', ' Landing', ' Market', ' Depot', ' Post'];
  return prefixes[Math.floor(rand() * prefixes.length)] + suffixes[Math.floor(rand() * suffixes.length)];
}

// ---------- planet archetypes & resource pools (design.md §2) ----------
// Weights sum to 100 (relative frequency, not a literal percentage). Terran is
// the homeworld archetype: 12 GUARANTEED nodes (incl. gold/silver/tungsten, per
// §2) + 3 random from the same pool = 15, and the sole exception to the 10-node
// cap. Oceanic guarantees >=2 Deuterium (the galaxy's only fuel source).
const ARCHETYPES = {
  rocky:       { weight: 28, nodeRange: [3, 6], pool: ['titanium', 'copper', 'lead', 'silica'] },
  oceanic:     { weight: 14, nodeRange: [3, 5], pool: ['deuterium', 'carbon_products', 'polymers'], guaranteed: { deuterium: 2 } },
  ice:         { weight: 14, nodeRange: [3, 5], pool: ['ammonia', 'nitrogen', 'helium'] },
  desert:      { weight: 14, nodeRange: [2, 3], pool: ['titanium', 'silica'] },
  terran:      { weight: 8,
                 guaranteedList: ['titanium', 'titanium', 'copper', 'lead', 'silica', 'lithium', 'polymers', 'carbon_products', 'nitrogen', 'gold', 'silver', 'tungsten'],
                 randomFill: 3,
                 pool: ['titanium', 'copper', 'lead', 'silica', 'lithium', 'polymers', 'carbon_products', 'nitrogen', 'gold', 'silver', 'tungsten'] },
  gasGiant:    { weight: 8,  nodeRange: [2, 4], pool: ['xenon', 'helium', 'nitrogen'] },
  molten:      { weight: 8,  nodeRange: [2, 4], pool: ['gold', 'silver', 'tungsten'] },
  irradiated:  { weight: 4,  nodeRange: [1, 3], pool: ['neodymium', 'palladium'] },
  crystalline: { weight: 2,  nodeRange: [1, 3], pool: ['silica', 'neodymium'] },
};
const GLOBAL_MAX_NODES_PER_PLANET = 10; // §2 hard cap on randomly-drawn planets

// The three rare-tier archetypes (design.md §2). Only these receive the ring
// multiplier; fuel and the common tier are exempt.
const RARE_TIER = new Set(['molten', 'irradiated', 'crystalline']);

// Per-ring weight multiplier on the rare-tier archetypes (design.md §2). Equal
// RADIAL thirds are not equal AREA thirds (area ~ r^2, so rings run ~1:3:5 by
// area), so the multiplier has to be aggressive to survive the outer ring's
// sheer size. Verification targets on seed 7331: ~41% rare-tier inner vs ~3.6%
// outer (~11x spread).
const RING_RARE_MULTIPLIER = { inner: 4, middle: 1, outer: 0.25 };

// Startup assertion (§2: "enforced as a startup assertion ... rather than a
// comment"): no RANDOM archetype may exceed the cap. Terran has no nodeRange
// (fixed 15) and is the named exception.
for (const [name, def] of Object.entries(ARCHETYPES)) {
  if (def.nodeRange && def.nodeRange[1] > GLOBAL_MAX_NODES_PER_PLANET) {
    throw new Error(`archetype ${name} nodeRange max ${def.nodeRange[1]} exceeds the ${GLOBAL_MAX_NODES_PER_PLANET}-node cap`);
  }
}

// Effective weight of an archetype in a given ring: base weight for common tiers
// and fuel; base * ring multiplier for the three rare tiers.
function archetypeWeight(key, def, ring) {
  return RARE_TIER.has(key) ? def.weight * RING_RARE_MULTIPLIER[ring] : def.weight;
}

// Ring-weighted archetype draw (design.md §2). The gradient lives entirely in
// the per-ring re-weighting of the rare tiers; everything else is unchanged.
// One rand() call per planet regardless of ring, so the draw *count* is stable —
// only the resulting archetype distribution shifts.
function pickArchetype(rand, ring) {
  let totalWeight = 0;
  for (const [key, def] of Object.entries(ARCHETYPES)) totalWeight += archetypeWeight(key, def, ring);
  let roll = rand() * totalWeight;
  for (const [key, def] of Object.entries(ARCHETYPES)) {
    roll -= archetypeWeight(key, def, ring);
    if (roll <= 0) return key;
  }
  return Object.keys(ARCHETYPES)[0]; // floating-point fallback, should never trigger
}

// Which rare tier a *repaired* planet becomes (see repairRareTierGuarantee).
// PROVISIONAL DECISION — flagged for a ruling (roadmap Track G decision list;
// working practice #5): weighted draw among the three rare tiers by their base
// weight (molten 8 : irradiated 4 : crystalline 2), so a repaired planet looks
// like an organically-generated inner-ring rare world. This is UNOBSERVABLE on
// seed 7331 because the repair pass fires zero times there — it only affects
// unlucky seeds. If a ruling prefers e.g. "always molten", change here only.
const RARE_TIER_KEYS = ['molten', 'irradiated', 'crystalline'];
function pickRareTier(rand) {
  let total = 0;
  for (const k of RARE_TIER_KEYS) total += ARCHETYPES[k].weight;
  let roll = rand() * total;
  for (const k of RARE_TIER_KEYS) {
    roll -= ARCHETYPES[k].weight;
    if (roll <= 0) return k;
  }
  return RARE_TIER_KEYS[0];
}

// Resource nodes for one planet. NODE RICHNESS/YIELD is deliberately NOT set:
// it is an undecided number (roadmap follow-on), so the canonical seed carries
// no placeholder for it -- it is added when richness is designed.
function generateResourceNodes(archetype, rand, planetId) {
  const def = ARCHETYPES[archetype];
  let idx = 0;
  const makeNode = (resourceType) => {
    idx++;
    return { id: `${planetId}_n${String(idx).padStart(2, '0')}`, resourceType };
  };

  // Terran: fixed 12 guaranteed + `randomFill` random draws from the pool = 15.
  if (def.guaranteedList) {
    const nodes = def.guaranteedList.map(makeNode);
    for (let i = 0; i < (def.randomFill || 0); i++) {
      nodes.push(makeNode(def.pool[Math.floor(rand() * def.pool.length)]));
    }
    return nodes;
  }

  const [min, max] = def.nodeRange;
  const totalCount = Math.min(GLOBAL_MAX_NODES_PER_PLANET, min + Math.floor(rand() * (max - min + 1)));
  const nodes = [];
  let remaining = totalCount;
  // guaranteed minimums first (e.g. Oceanic's >=2 Deuterium)
  for (const [resourceType, minCount] of Object.entries(def.guaranteed || {})) {
    for (let i = 0; i < minCount && remaining > 0; i++) { nodes.push(makeNode(resourceType)); remaining--; }
  }
  // fill the rest randomly from the archetype's pool
  for (let i = 0; i < remaining; i++) {
    nodes.push(makeNode(def.pool[Math.floor(rand() * def.pool.length)]));
  }
  return nodes;
}

// A system is starter-eligible if it holds >=1 Terran planet (design.md §13):
// Terran's guaranteed spread makes it starter-viable by construction.
function isStarterEligible(system) {
  return system.planets.some(p => p.archetype === 'terran');
}

// ---------- rare-tier guarantee (shared by the repair pass and validation) ----------
// Count rare-tier planets within `search` world-units of the system at index i.
// Distance is measured system-to-system (all of a system's planets share its
// position), so a nearby system contributes ALL of its rare-tier planets.
// A system's own rare-tier planets count (distance 0).
function countRareTierWithin(systems, sysPix, i, search) {
  const origin = sysPix[i];
  let count = 0;
  for (let j = 0; j < systems.length; j++) {
    const dx = sysPix[j].x - origin.x, dy = sysPix[j].y - origin.y;
    if (dx * dx + dy * dy > search * search) continue;
    for (const pl of systems[j].planets) if (RARE_TIER.has(pl.archetype)) count++;
  }
  return count;
}

// Rare-tier repair pass (pipeline step 9; design.md §2, §16). Guarantees every
// starter system has >= min rare-tier planets within 1/3 of the galaxy radius,
// by converting the NEAREST eligible (non-Terran, non-rare-tier) planets in
// range until the floor is met. Deterministic: systems and candidates are
// processed in a fixed order (array order; ties broken by planet id). On seed
// 7331 with min=2 it fires ZERO times — the gradient alone clears the bar — so
// it is a safety net for unlucky seeds, not the primary mechanism.
function repairRareTierGuarantee(systems, rand, hexSize, radius, min) {
  const search = radius / 3;
  const sysPix = systems.map(s => hexToPixel(s.coords.q, s.coords.r, hexSize));
  let repairs = 0;

  for (let i = 0; i < systems.length; i++) {
    if (!systems[i].starterEligible) continue;
    let rareCount = countRareTierWithin(systems, sysPix, i, search);
    if (rareCount >= min) continue;

    // Gather eligible conversion candidates in range, nearest-first.
    const origin = sysPix[i];
    const candidates = [];
    for (let j = 0; j < systems.length; j++) {
      const dx = sysPix[j].x - origin.x, dy = sysPix[j].y - origin.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > search * search) continue;
      for (const pl of systems[j].planets) {
        if (pl.archetype === 'terran' || RARE_TIER.has(pl.archetype)) continue;
        candidates.push({ planet: pl, d2 });
      }
    }
    candidates.sort((a, b) => a.d2 - b.d2 || a.planet.id.localeCompare(b.planet.id));

    for (const cand of candidates) {
      if (rareCount >= min) break;
      const newArch = pickRareTier(rand);
      cand.planet.archetype = newArch;
      cand.planet.resourceNodes = generateResourceNodes(newArch, rand, cand.planet.id);
      rareCount++;
      repairs++;
    }
  }
  return repairs;
}

// Validation (pipeline step 10): every resourceType appears somewhere; the
// starter pool is non-empty and spread across every sector (not just healthy in
// aggregate); and — post-repair — every starter system still meets the >=min
// rare-tier-within-1/3-radius guarantee.
function validateGalaxy(systems, hexSize, radius, min) {
  const issues = [];
  const resourceTypeCounts = {};
  const archetypeCounts = {};
  systems.forEach(sys => {
    sys.planets.forEach(p => {
      archetypeCounts[p.archetype] = (archetypeCounts[p.archetype] || 0) + 1;
      p.resourceNodes.forEach(n => { resourceTypeCounts[n.resourceType] = (resourceTypeCounts[n.resourceType] || 0) + 1; });
    });
  });
  const allResourceTypes = new Set();
  Object.values(ARCHETYPES).forEach(def => { (def.pool || []).forEach(rt => allResourceTypes.add(rt)); });
  allResourceTypes.forEach(rt => {
    if (!resourceTypeCounts[rt]) issues.push(`resourceType '${rt}' does not appear anywhere in the generated galaxy`);
  });
  const starterSystems = systems.filter(s => s.starterEligible);
  if (starterSystems.length === 0) issues.push('no starter-eligible (Terran-bearing) systems were generated at all');
  const sectorsCovered = new Set(starterSystems.map(s => s.name.split('-')[0]));
  const missingSectors = SECTOR_PREFIXES.filter(pfx => !sectorsCovered.has(pfx));
  if (missingSectors.length > 0) issues.push(`starter-eligible systems missing from sectors: ${missingSectors.join(', ')}`);

  // rare-tier guarantee, post-repair
  const search = radius / 3;
  const sysPix = systems.map(s => hexToPixel(s.coords.q, s.coords.r, hexSize));
  let shortfalls = 0;
  for (let i = 0; i < systems.length; i++) {
    if (!systems[i].starterEligible) continue;
    if (countRareTierWithin(systems, sysPix, i, search) < min) shortfalls++;
  }
  if (shortfalls > 0) issues.push(`${shortfalls} starter system(s) below the >=${min} rare-tier-within-1/3-radius guarantee after repair`);

  return { issues, archetypeCounts, starterSystemCount: starterSystems.length };
}

// ---------- main generation ----------
function generateGalaxySeed(seed, opts = {}) {
  const rand = mulberry32(seed);
  const { radius, hexSize, citadelRadius, arms, spiralTwist, targetSystems, numOutposts, outpostMinSeparation, planetCountMin, planetCountMax, systemClaimRadius } = PARAMS;
  const rareTierMin = opts.rareTierMinPerStarter != null ? opts.rareTierMinPerStarter : PARAMS.rareTierMinPerStarter;

  // --- spiral-arm eligibility: systems only sit where the arms are ---
  function armDistance(x, y) {
    const r = Math.hypot(x, y);
    const theta = Math.atan2(y, x);
    let minD = Infinity;
    for (let a = 0; a < arms; a++) {
      const armTheta = (Math.PI * 2 / arms) * a + (r / radius) * spiralTwist * Math.PI;
      let d = theta - armTheta;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      minD = Math.min(minD, Math.abs(d));
    }
    return { minD, r };
  }

  // enumerate candidate hexes along the arms (NOT stored in output — used only
  // to pick system locations; the lattice itself is regenerated by consumers)
  const range = Math.ceil(radius / (hexSize * 1.3));
  const armEligible = [];
  for (let q = -range; q <= range; q++) {
    for (let r = -range; r <= range; r++) {
      const p = hexToPixel(q, r, hexSize);
      const d = Math.hypot(p.x, p.y);
      if (d > radius) continue;
      if (hexDist({ q, r }, { q: 0, r: 0 }) <= citadelRadius) continue; // Citadel excludes systems
      const { minD, r: rr } = armDistance(p.x, p.y);
      if (minD < (0.85 - 0.30 * (rr / radius)) * 0.6) armEligible.push({ q, r });
    }
  }

  // deterministic shuffle, then take the first N — same technique as the prototype
  for (let i = armEligible.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [armEligible[i], armEligible[j]] = [armEligible[j], armEligible[i]];
  }
  const chosen = armEligible.slice(0, Math.min(targetSystems, armEligible.length));

  // --- build system entries (pipeline steps 2, 3, 4) ---
  // `ring` (step 4) is pure geometry, set here at build time; it consumes no
  // RNG and so leaves the base skeleton's draw order byte-identical.
  let planetCounter = 0;
  const systems = chosen.map((hex, i) => {
    const id = `sys_${String(i + 1).padStart(4, '0')}`;
    const planetCount = planetCountMin + Math.floor(rand() * (planetCountMax - planetCountMin + 1));
    const planets = [];
    for (let p = 0; p < planetCount; p++) {
      planetCounter++;
      planets.push({ id: `pl_${String(planetCounter).padStart(5, '0')}` }); // stats/resourceNodes added later
    }
    return {
      id,
      coords: { q: hex.q, r: hex.r },
      name: systemName(hex.q, hex.r, arms),
      claimRadius: PARAMS.systemClaimRadius,
      ring: classifyRing({ q: hex.q, r: hex.r }, hexSize, radius),
      planets,
    };
  });

  // --- outposts: isolated, in genuinely blank space, away from systems & each other ---
  const systemHexSet = new Set(systems.map(s => `${s.coords.q},${s.coords.r}`));
  const outposts = [];
  let tries = 0;
  const maxTries = 4000;
  while (outposts.length < numOutposts && tries < maxTries) {
    tries++;
    const q = Math.floor((rand() - 0.5) * 2 * range);
    const r = Math.floor((rand() - 0.5) * 2 * range);
    const p = hexToPixel(q, r, hexSize);
    const d = Math.hypot(p.x, p.y);
    if (d > radius * 0.92) continue;
    if (hexDist({ q, r }, { q: 0, r: 0 }) <= citadelRadius) continue;
    if (systemHexSet.has(`${q},${r}`)) continue;
    const tooClose = outposts.some(o => Math.hypot(o._x - p.x, o._y - p.y) < outpostMinSeparation);
    if (tooClose) continue;
    outposts.push({
      id: `out_${String(outposts.length + 1).padStart(2, '0')}`,
      coords: { q, r },
      name: outpostName(rand),
      _x: p.x, _y: p.y, // internal only, stripped before write
    });
  }
  outposts.forEach(o => { delete o._x; delete o._y; });

  // --- pipeline steps 5, 6, 8: archetypes (ring-weighted), resource nodes, starter tags ---
  // Runs AFTER every base draw above, so the system/planet/outpost skeleton and
  // all coordinates stay byte-identical to the bare seed; these passes only
  // DECORATE the planets already built. The archetype draw is now ring-weighted
  // (step 5 folded into step 4's classification via sys.ring).
  let totalResourceNodes = 0;
  for (const sys of systems) {
    for (const planet of sys.planets) {
      planet.archetype = pickArchetype(rand, sys.ring);
      planet.resourceNodes = generateResourceNodes(planet.archetype, rand, planet.id);
      totalResourceNodes += planet.resourceNodes.length;
    }
    sys.starterEligible = isStarterEligible(sys);
  }

  // --- pipeline step 9: rare-tier repair pass (after starter tagging) ---
  const repairs = repairRareTierGuarantee(systems, rand, hexSize, radius, rareTierMin);
  // node total may have shifted if any planet was converted
  totalResourceNodes = 0;
  for (const sys of systems) for (const planet of sys.planets) totalResourceNodes += planet.resourceNodes.length;

  const validation = validateGalaxy(systems, hexSize, radius, rareTierMin); // pipeline step 10

  return {
    seed,
    // No generatedAt/wall-clock field on purpose (ruling 20-07-26, roadmap
    // Phase 2): the seed's identity is its seed number, and "when it was
    // generated" is git's job, not the content's. Baking a timestamp in here
    // made the file non-byte-deterministic across runs. Do not re-add it.
    galaxyParams: {
      radius, hexSize, citadelRadius, arms, spiralTwist,
    },
    citadel: { coords: { q: 0, r: 0 }, radius: citadelRadius },
    systems,
    outposts,
    validation: { passed: validation.issues.length === 0, issues: validation.issues },
    stats: {
      totalHexesInGalaxy: null, // filled in below
      totalSystems: systems.length,
      totalPlanets: planetCounter,
      totalResourceNodes,
      totalOutposts: outposts.length,
      starterSystems: validation.starterSystemCount,
      rareTierRepairs: repairs,
      armEligibleHexesConsidered: armEligible.length,
    },
  };
}

// ---------- entrypoint ----------
function countTotalHexes(radius, hexSize) {
  const range = Math.ceil(radius / (hexSize * 1.3));
  let count = 0;
  for (let q = -range; q <= range; q++) {
    for (let r = -range; r <= range; r++) {
      const p = hexToPixel(q, r, hexSize);
      if (Math.hypot(p.x, p.y) <= radius) count++;
    }
  }
  return count;
}

// Exported so the verification test (tools/generate_seed.test.js) can drive the
// generator in-memory without writing a file. Running the file directly still
// writes the seed (guarded below).
module.exports = {
  PARAMS, ARCHETYPES, RARE_TIER, RING_RARE_MULTIPLIER,
  mulberry32, hexToPixel, hexDist, classifyRing,
  pickArchetype, pickRareTier, generateResourceNodes,
  countRareTierWithin, repairRareTierGuarantee, validateGalaxy,
  generateGalaxySeed, countTotalHexes,
};

if (require.main === module) {
  const seedArg = parseInt(process.argv[2], 10);
  const seed = Number.isFinite(seedArg) ? seedArg : 7331;
  const outPath = process.argv[3] || './seed.json';

  const galaxy = generateGalaxySeed(seed);
  galaxy.stats.totalHexesInGalaxy = countTotalHexes(PARAMS.radius, PARAMS.hexSize);

  fs.writeFileSync(outPath, JSON.stringify(galaxy, null, 2));

  console.log(`Galaxy seed generated: ${outPath}`);
  console.log(`  seed:            ${seed}`);
  console.log(`  total hexes:     ${galaxy.stats.totalHexesInGalaxy.toLocaleString()} (not stored — regenerable from galaxyParams)`);
  console.log(`  systems:         ${galaxy.stats.totalSystems}`);
  console.log(`  planets:         ${galaxy.stats.totalPlanets}`);
  console.log(`  resource nodes:  ${galaxy.stats.totalResourceNodes.toLocaleString()}`);
  console.log(`  starter systems: ${galaxy.stats.starterSystems}`);
  console.log(`  rare-tier repairs: ${galaxy.stats.rareTierRepairs}`);
  console.log(`  validation:      ${galaxy.validation.passed ? 'PASSED' : 'FAILED -- ' + galaxy.validation.issues.join('; ')}`);
  console.log(`  outposts:        ${galaxy.stats.totalOutposts}`);
}
