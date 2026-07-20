#!/usr/bin/env node
/**
 * Galaxy Seed Generator
 * ---------------------
 * Generates the static Galaxy Seed (see galaxy-state-model.md §1a):
 * a deterministic map shape — solar systems, blank placeholder planets,
 * Syndicate outposts, and the Citadel. No claims, no ventures, no live
 * state of any kind. Given the same seed number, always produces the
 * identical galaxy.
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
};

// ---------- planet archetypes & resource pools (galaxy-state-model.md, Part 1) ----------
// Weights sum to 100 (relative frequency, not a literal percentage).
// `fixedSpread` archetypes (Terran) skip random node generation entirely.
// `guaranteed` archetypes (Oceanic) force a minimum count of one resourceType,
// then fill the rest of the node budget randomly from `pool`.
const ARCHETYPES = {
  rocky:       { weight: 28, nodeRange: [3, 6], pool: ['titanium', 'copper', 'lead', 'silica'] },
  terran:      { weight: 8,  fixedSpread: ['titanium', 'titanium', 'copper', 'lead', 'silica', 'lithium', 'polymers', 'carbon_products', 'nitrogen'] },
  oceanic:     { weight: 14, nodeRange: [3, 5], pool: ['deuterium', 'carbon_products', 'polymers'], guaranteed: { deuterium: 2 } },
  ice:         { weight: 14, nodeRange: [3, 5], pool: ['ammonia', 'nitrogen', 'helium'] },
  gasGiant:    { weight: 8,  nodeRange: [2, 4], pool: ['xenon', 'helium', 'nitrogen'] },
  molten:      { weight: 8,  nodeRange: [2, 4], pool: ['gold', 'silver', 'tungsten'] },
  desert:      { weight: 14, nodeRange: [2, 3], pool: ['titanium', 'silica'] },
  irradiated:  { weight: 4,  nodeRange: [1, 3], pool: ['neodymium', 'palladium'] },
  crystalline: { weight: 2,  nodeRange: [1, 3], pool: ['silica', 'neodymium'] },
};
const GLOBAL_MAX_NODES_PER_PLANET = 10; // hard cap, see Planet Archetypes & Resources

function pickArchetype(rand) {
  const totalWeight = Object.values(ARCHETYPES).reduce((sum, a) => sum + a.weight, 0);
  let roll = rand() * totalWeight;
  for (const [key, def] of Object.entries(ARCHETYPES)) {
    roll -= def.weight;
    if (roll <= 0) return key;
  }
  return Object.keys(ARCHETYPES)[0]; // floating-point fallback, should never trigger
}

// richness generation is a placeholder pending a dedicated design pass — flat
// 3-8 spread for random draws, flat 5 for Terran's fixed spread (fairness).
function generateResourceNodes(archetype, rand, idPrefix) {
  const def = ARCHETYPES[archetype];
  let nodeIdx = 0;
  const makeNode = (resourceType, richness) => {
    nodeIdx++;
    return {
      id: `${idPrefix}_${String(nodeIdx).padStart(2, '0')}`,
      resourceType,
      richness,
    };
  };

  if (def.fixedSpread) {
    return def.fixedSpread.map(rt => makeNode(rt, 5));
  }

  const [min, max] = def.nodeRange;
  const totalCount = Math.min(GLOBAL_MAX_NODES_PER_PLANET, min + Math.floor(rand() * (max - min + 1)));
  const nodes = [];

  // guaranteed minimums first (e.g. Oceanic's Deuterium)
  let remaining = totalCount;
  for (const [resourceType, minCount] of Object.entries(def.guaranteed || {})) {
    for (let i = 0; i < minCount && remaining > 0; i++) {
      nodes.push(makeNode(resourceType, 3 + Math.floor(rand() * 6)));
      remaining--;
    }
  }
  // fill the rest randomly from the archetype's pool
  for (let i = 0; i < remaining; i++) {
    const resourceType = def.pool[Math.floor(rand() * def.pool.length)];
    nodes.push(makeNode(resourceType, 3 + Math.floor(rand() * 6)));
  }
  return nodes;
}

// starter-eligible tagging (§ Onboarding): a system qualifies if it contains
// >=1 Terran planet — Terran's fixed spread guarantees starter-viability by
// construction, so no separate node-count threshold is needed.
function isStarterEligible(system) {
  return system.planets.some(p => p.archetype === 'terran');
}

// validation pass: every resourceType reachable somewhere, starter pool
// non-empty and spread across every sector (not just the galaxy in aggregate).
function validateGalaxy(systems, arms) {
  const issues = [];
  const resourceTypeCounts = {};
  const archetypeCounts = {};

  systems.forEach(sys => {
    sys.planets.forEach(p => {
      archetypeCounts[p.archetype] = (archetypeCounts[p.archetype] || 0) + 1;
      p.resourceNodes.forEach(n => {
        resourceTypeCounts[n.resourceType] = (resourceTypeCounts[n.resourceType] || 0) + 1;
      });
    });
  });

  const allResourceTypes = new Set();
  Object.values(ARCHETYPES).forEach(def => {
    (def.pool || def.fixedSpread || []).forEach(rt => allResourceTypes.add(rt));
  });
  allResourceTypes.forEach(rt => {
    if (!resourceTypeCounts[rt]) issues.push(`resourceType '${rt}' does not appear anywhere in the generated galaxy`);
  });

  const starterSystems = systems.filter(s => s.starterEligible);
  if (starterSystems.length === 0) {
    issues.push('no starter-eligible (Terran-bearing) systems were generated at all');
  }
  const sectorsCovered = new Set(starterSystems.map(s => s.name.split('-')[0]));
  const missingSectors = SECTOR_PREFIXES.filter(pfx => !sectorsCovered.has(pfx));
  if (missingSectors.length > 0) {
    issues.push(`starter-eligible systems missing from sectors: ${missingSectors.join(', ')}`);
  }

  return { issues, resourceTypeCounts, archetypeCounts, starterSystemCount: starterSystems.length };
}


function hexToPixel(q, r, hexSize) {
  return {
    x: hexSize * 1.5 * q,
    y: hexSize * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r),
  };
}

function hexDist(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
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

// ---------- main generation ----------
function generateGalaxySeed(seed) {
  const rand = mulberry32(seed);
  const { radius, hexSize, citadelRadius, arms, spiralTwist, targetSystems, numOutposts, outpostMinSeparation, planetCountMin, planetCountMax, systemClaimRadius } = PARAMS;

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

  // --- build system entries ---
  let planetCounter = 0;
  const systems = chosen.map((hex, i) => {
    const id = `sys_${String(i + 1).padStart(4, '0')}`;
    const planetCount = planetCountMin + Math.floor(rand() * (planetCountMax - planetCountMin + 1));
    const planets = [];
    for (let p = 0; p < planetCount; p++) {
      planetCounter++;
      const planetId = `pl_${String(planetCounter).padStart(5, '0')}`;
      const archetype = pickArchetype(rand);
      const resourceNodes = generateResourceNodes(archetype, rand, `rn_${String(planetCounter).padStart(5, '0')}`);
      planets.push({ id: planetId, archetype, stats: {}, resourceNodes });
    }
    const system = {
      id,
      coords: { q: hex.q, r: hex.r },
      name: systemName(hex.q, hex.r, arms),
      claimRadius: PARAMS.systemClaimRadius,
      planets,
    };
    system.starterEligible = isStarterEligible(system);
    return system;
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

  const validation = validateGalaxy(systems, arms);

  return {
    seed,
    // No generatedAt field on purpose — see generate_seed.js (ruling 20-07-26).
    galaxyParams: {
      radius, hexSize, citadelRadius, arms, spiralTwist,
    },
    citadel: { coords: { q: 0, r: 0 }, radius: citadelRadius },
    systems,
    outposts,
    stats: {
      totalHexesInGalaxy: null, // filled in below
      totalSystems: systems.length,
      totalPlanets: planetCounter,
      totalOutposts: outposts.length,
      armEligibleHexesConsidered: armEligible.length,
      starterEligibleSystems: validation.starterSystemCount,
      archetypeCounts: validation.archetypeCounts,
      resourceTypeCounts: validation.resourceTypeCounts,
    },
    validation: {
      passed: validation.issues.length === 0,
      issues: validation.issues,
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
console.log(`  outposts:        ${galaxy.stats.totalOutposts}`);
console.log(`  starter systems: ${galaxy.stats.starterEligibleSystems} (>=1 Terran planet)`);
console.log(`  archetypes:      ${Object.entries(galaxy.stats.archetypeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`  resourceTypes:   ${Object.entries(galaxy.stats.resourceTypeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
if (galaxy.validation.passed) {
  console.log(`  validation:      PASSED`);
} else {
  console.log(`  validation:      FAILED`);
  galaxy.validation.issues.forEach(issue => console.log(`    - ${issue}`));
}
