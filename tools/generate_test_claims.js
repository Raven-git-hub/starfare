#!/usr/bin/env node
/**
 * Test Claims Generator
 * ----------------------
 * NOT part of the real architecture — ownership is live state, never seed data
 * (galaxy-state-model.md §1a). This script exists purely to produce test/demo
 * claims so the seed viewer's territory + label rendering can be exercised
 * against something more interesting than an empty galaxy.
 *
 * Reads a seed.json, assigns systems and nearby outposts to N test guilds,
 * writes a separate claims JSON. Deterministic given the same claims seed.
 *
 * Usage: node generate_test_claims.js <seedFile> [claimsSeed] [outputPath]
 *   e.g. node generate_test_claims.js ./seed.json 4242 ./test_claims.json
 */

const fs = require('fs');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexDist(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}
function hexToPixel(q, r, hexSize) {
  return { x: hexSize * 1.5 * q, y: hexSize * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r) };
}

const CONFIG = {
  guildCount: 20,
  systemsMin: 2,
  systemsMax: 10,
  outpostsMin: 0,
  outpostsMax: 5,
  outpostMaxHexDist: 10,      // guild outposts stay within this hex distance of one of the guild's own systems
  outpostPlacementTries: 60,
  gatesMin: 0,
  gatesMax: 4,
  gateMaxAnchorDist: 10,      // a gate anchors within this hex distance of one of the guild's own systems OR outposts
  gatePlacementTries: 60,
};

function genGuildNames(rand, n) {
  const prefixes = ['Kesh', 'Vantar', 'Orun', 'Dracis', 'Molvex', 'Ilyra', 'Thessic', 'Zovane', 'Correlan', 'Baryx',
    'Rynthe', 'Fenor', 'Axelis', 'Pelgrave', 'Halcion', 'Qirenne', 'Novask', 'Ombrix', 'Selvane', 'Tharok'];
  const suffixes = [' Combine', ' Concern', ' Compact', ' Cartel', ' Trust', ' Consortium', ' Holdings', ' Syndicate', ' Group'];
  const used = new Set(); const out = [];
  while (out.length < n) {
    const nm = prefixes[Math.floor(rand()*prefixes.length)] + suffixes[Math.floor(rand()*suffixes.length)];
    if (!used.has(nm)) { used.add(nm); out.push(nm); }
  }
  return out;
}

// evenly spaced hues around the color wheel for visually distinct guild colors
function guildColor(i, n) {
  const hue = (i * (360 / n)) % 360;
  const s = 0.62, l = 0.56;
  const c = (1 - Math.abs(2*l-1)) * s;
  const x = c * (1 - Math.abs((hue/60) % 2 - 1));
  const m = l - c/2;
  let r,g,b;
  if (hue < 60) [r,g,b] = [c,x,0];
  else if (hue < 120) [r,g,b] = [x,c,0];
  else if (hue < 180) [r,g,b] = [0,c,x];
  else if (hue < 240) [r,g,b] = [0,x,c];
  else if (hue < 300) [r,g,b] = [x,0,c];
  else [r,g,b] = [c,0,x];
  return { r: Math.round((r+m)*255), g: Math.round((g+m)*255), b: Math.round((b+m)*255) };
}

function generateTestClaims(seedFile, claimsSeed) {
  const galaxy = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const rand = mulberry32(claimsSeed);
  const hexSize = galaxy.galaxyParams.hexSize;

  const guildNames = genGuildNames(rand, CONFIG.guildCount);
  const guilds = guildNames.map((name, i) => ({
    id: `guild_${String(i+1).padStart(2,'0')}`,
    name,
    color: guildColor(i, CONFIG.guildCount),
  }));

  const availableSystems = galaxy.systems.slice(); // pool shrinks as guilds claim — no overlap between guilds
  const systemClaims = {}; // systemId -> guildId
  const guildOutposts = [];
  const tollGates = [];
  const tollPaths = [];
  const usedOutpostHexes = new Set(
    galaxy.outposts.map(o => `${o.coords.q},${o.coords.r}`)
      .concat(galaxy.systems.map(s => `${s.coords.q},${s.coords.r}`))
  );

  guilds.forEach(g => {
    const target = CONFIG.systemsMin + Math.floor(rand() * (CONFIG.systemsMax - CONFIG.systemsMin + 1));
    if (!availableSystems.length) { g._systems = []; return; }

    // seed the cluster with a random unclaimed system, then grow via nearest-neighbor —
    // keeps a guild's territory "roughly close together" rather than scattered galaxy-wide
    const seedIdx = Math.floor(rand() * availableSystems.length);
    const claimed = [availableSystems.splice(seedIdx, 1)[0]];
    while (claimed.length < target && availableSystems.length) {
      let bestIdx = -1, bestD = Infinity;
      availableSystems.forEach((s, i) => {
        let d = Infinity;
        for (const c of claimed) d = Math.min(d, hexDist(s.coords, c.coords));
        if (d < bestD) { bestD = d; bestIdx = i; }
      });
      claimed.push(availableSystems.splice(bestIdx, 1)[0]);
    }
    claimed.forEach(s => { systemClaims[s.id] = g.id; });
    g._systems = claimed;

    // outposts: within outpostMaxHexDist of one of this guild's own systems, on a genuinely free hex
    const outpostCount = CONFIG.outpostsMin + Math.floor(rand() * (CONFIG.outpostsMax - CONFIG.outpostsMin + 1));
    const myOutposts = [];
    for (let n = 0; n < outpostCount; n++) {
      let placed = false;
      for (let attempt = 0; attempt < CONFIG.outpostPlacementTries && !placed; attempt++) {
        const refSys = claimed[Math.floor(rand() * claimed.length)];
        const dist = 1 + Math.floor(rand() * CONFIG.outpostMaxHexDist);
        const ang = rand() * Math.PI * 2;
        const dq = Math.round(Math.cos(ang) * dist);
        const dr = Math.round(Math.sin(ang) * dist);
        const q = refSys.coords.q + dq, r = refSys.coords.r + dr;
        const key = `${q},${r}`;
        if (usedOutpostHexes.has(key)) continue;
        if (hexDist({q,r}, refSys.coords) > CONFIG.outpostMaxHexDist) continue;
        const p = hexToPixel(q, r, hexSize);
        if (Math.hypot(p.x, p.y) > galaxy.galaxyParams.radius) continue;
        if (hexDist({q,r}, {q:0,r:0}) <= galaxy.citadel.radius) continue;
        usedOutpostHexes.add(key);
        const outpost = {
          id: `gop_${guildOutposts.length+1}`,
          guildId: g.id,
          coords: { q, r },
          name: `${g.name.split(' ')[0]} Waypoint ${n+1}`,
        };
        guildOutposts.push(outpost);
        myOutposts.push(outpost);
        placed = true;
      }
    }

    // toll gates: anchor within gateMaxAnchorDist of EITHER one of the guild's own systems
    // OR one of its own outposts (outposts themselves only ever anchor to a system — this is
    // the one extra hop that lets a chain reach system -> gate -> outpost -> gate, up to 20 hexes)
    const anchorPool = claimed.map(s => s.coords).concat(myOutposts.map(o => o.coords));
    const myGates = [];
    const gateCount = CONFIG.gatesMin + Math.floor(rand() * (CONFIG.gatesMax - CONFIG.gatesMin + 1));
    for (let n = 0; n < gateCount; n++) {
      let placed = false;
      for (let attempt = 0; attempt < CONFIG.gatePlacementTries && !placed; attempt++) {
        const anchor = anchorPool[Math.floor(rand() * anchorPool.length)];
        const dist = 1 + Math.floor(rand() * CONFIG.gateMaxAnchorDist);
        const ang = rand() * Math.PI * 2;
        const dq = Math.round(Math.cos(ang) * dist);
        const dr = Math.round(Math.sin(ang) * dist);
        const q = anchor.q + dq, r = anchor.r + dr;
        const key = `${q},${r}`;
        if (usedOutpostHexes.has(key)) continue;
        if (hexDist({q,r}, anchor) > CONFIG.gateMaxAnchorDist) continue;
        const p = hexToPixel(q, r, hexSize);
        if (Math.hypot(p.x, p.y) > galaxy.galaxyParams.radius) continue;
        if (hexDist({q,r}, {q:0,r:0}) <= galaxy.citadel.radius) continue;
        usedOutpostHexes.add(key);
        const gate = {
          id: `gate_${tollGates.length+1}`,
          guildId: g.id,
          coords: { q, r },
          name: `${g.name.split(' ')[0]} Gate ${n+1}`,
        };
        tollGates.push(gate);
        myGates.push(gate);
        placed = true;
      }
    }

    // toll paths: connect this guild's own gates into a nearest-neighbor chain — always gate-to-gate,
    // never terminating at an outpost (an outpost only ever gets a path routed near it, per the spec)
    if (myGates.length >= 2) {
      const remaining = myGates.slice(1);
      const chain = [myGates[0]];
      while (remaining.length) {
        let bestIdx = 0, bestD = Infinity;
        remaining.forEach((gt, i) => {
          const d = hexDist(gt.coords, chain[chain.length-1].coords);
          if (d < bestD) { bestD = d; bestIdx = i; }
        });
        chain.push(remaining.splice(bestIdx, 1)[0]);
      }
      for (let i = 0; i < chain.length - 1; i++) {
        tollPaths.push({ id: `path_${tollPaths.length+1}`, guildId: g.id, gateAId: chain[i].id, gateBId: chain[i+1].id });
      }
    }

    delete g._systems;
  });

  return {
    claimsSeed,
    // No generatedAt/wall-clock field on purpose (ruling 20-07-26, roadmap
    // Phase 2) — see generate_seed.js. NOTE: `seedFile` below is still an
    // environment-dependent input path and is a separate open determinism
    // question (flagged for a ruling), not settled by this one.
    seedFile,
    guilds,
    systemClaims,
    guildOutposts,
    tollGates,
    tollPaths,
    stats: {
      totalGuilds: guilds.length,
      totalClaimedSystems: Object.keys(systemClaims).length,
      totalGuildOutposts: guildOutposts.length,
      totalTollGates: tollGates.length,
      totalTollPaths: tollPaths.length,
    },
  };
}

const seedFile = process.argv[2] || './seed.json';
const claimsSeedArg = parseInt(process.argv[3], 10);
const claimsSeed = Number.isFinite(claimsSeedArg) ? claimsSeedArg : 4242;
const outPath = process.argv[4] || './test_claims.json';

const claims = generateTestClaims(seedFile, claimsSeed);
fs.writeFileSync(outPath, JSON.stringify(claims, null, 2));

console.log(`Test claims generated: ${outPath}`);
console.log(`  claims seed:        ${claimsSeed}`);
console.log(`  guilds:              ${claims.stats.totalGuilds}`);
console.log(`  claimed systems:     ${claims.stats.totalClaimedSystems}`);
console.log(`  guild outposts:      ${claims.stats.totalGuildOutposts}`);
console.log(`  toll gates:          ${claims.stats.totalTollGates}`);
console.log(`  toll paths:          ${claims.stats.totalTollPaths}`);
