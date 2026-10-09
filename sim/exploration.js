'use strict';

// exploration.js — the per-guild EXPLORATION RECORD (docs/exploration-model.md §3, §6, §7).
//
// What a guild has LEARNED about the galaxy's static geography, kept forever once learned
// ("learn-once / known-forever", §3). It is OWNED guild state, nested on the Guild exactly as
// `assets` and `ventures` are: holding the row IS knowing the fact. It is serialized, so it is
// covered by the determinism hash (invariant 9), and it only ever grows, like `lifetimeProduced`.
//
// THE SHAPE (chosen at build, 05-10-26 — the smallest that answers the per-planet claim gate, §8;
// the `slots` track added by the settlement-surface slice, 09-10-26 — §4 ruling 10):
//
//     guild.exploration = {
//       [planetId]: { tick, nodes: { [nodeId]: tick }, slots: { [slotId]: tick } }
//     }
//
//   - A planet KEY present  = the guild knows that planet's ARCHETYPE (L1). `tick` = when it learned it.
//   - A node key under it   = the guild knows that resource node and its TYPE (L2). Value = when learned.
//   - A slot key under it   = the guild knows that SETTLEMENT SLOT is there (L2). Value = when learned.
//     A slot has no type to know — the key IS the fact. It is what the claim gate will read (§8).
//   - `nodes` and `slots` are BOTH always present, `{}` for a planet known at L1 only.
//
// A planet's SURFACE is its nodes AND its slots, and one L2 survey learns them together (§4 ruling 10):
// `revealSurface` below is the one place that says so.
//
// IDS ONLY — the archetype and the node's resource type are NOT copied in. The seed is the one map
// (design.md §15.3 "they link by reference only", invariant 5), so the record says WHICH facts the
// guild holds and the view reads WHAT they are from the seed (`getPlanet`, `getSite`). A copied
// archetype would be a second home for a seed fact, needing its own drift tripwire for no gain.
//
// L0 IS NOT HERE. Position, planet count and controller are never fogged (§1), so the view computes
// them for every system; storing them per guild would record what nobody can fail to know.
//
// OMIT-WHEN-EMPTY: a guild that knows nothing carries no `exploration` key at all, so a guild-less
// state, and every guild built by a scenario rather than founded, serializes exactly as before.
//
// THE ONE WRITE PATH is `reveal` below. Every source funnels through it — founding (§6) since 2.5 (a);
// the Deep Scan Array's scan (§5) since 2.5 (b2), through the two loops `revealSystemArchetypes` (L1)
// and `revealPlanetSurface` (L2); a craft visit later. It is source-agnostic on purpose: it records WHAT
// was learned and WHEN, never HOW, so a new source adds a caller, not a second writer.
//
// ONLY YOUR OWN SURVEYS (§4 ruling 11, 08-10-26). The record is written by founding and by the guild's
// own scans — never from a RIVAL. A rival's licensed venture used to be banked here (the removed
// `observePublicRegister`); it is not any more, because a controlled system's whole surface is now shown
// LIVE in the view (sim/fog.js `geographyFor`), so there is nothing to remember. That also keeps every
// planet in the record at L1 or at full L2 — the rival leak was the only thing that ever wrote one node
// of a planet and not its siblings.

const { getSite, getPlanet, getSystemLayout } = require('./seed.js');

// reveal(guild, fact, tick) -> the number of NEW facts learned (0 = it already knew; a no-op).
//
// `fact` is one of:
//   { planetId }  — L1: the guild learns that planet's archetype.
//   { nodeId }    — L2: the guild learns that resource node's type. A node cannot be known without
//                   its planet (you learn where it is), so this ALSO reveals the node's planet.
//   { slotId }    — L2: the guild learns that settlement slot is there. Like a node, it ALSO reveals
//                   the slot's planet.
//
// LEARN-ONCE: a fact already in the record keeps its ORIGINAL tick — knowing something again is not
// learning it, so nothing is rewritten and the record never shrinks. Mutates `guild` (the caller owns
// a cloned state, as every apply and tick step does). Throws on an id the seed does not hold: a
// caller revealing a place that does not exist is a bug, and a silent skip would hide it.
function reveal(guild, fact, tick) {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error(`exploration.reveal: tick must be a whole tick >= 0, got ${JSON.stringify(tick)}`);
  }
  let planetId;
  let nodeId = null;
  let slotId = null;
  if (fact && fact.nodeId != null) {
    const site = getSite(fact.nodeId);
    if (!site || site.kind !== 'resource') {
      throw new Error(`exploration.reveal: ${JSON.stringify(fact.nodeId)} is not a resource node in the seed`);
    }
    nodeId = site.id;
    planetId = site.planetId;
  } else if (fact && fact.slotId != null) {
    const site = getSite(fact.slotId);
    if (!site || site.kind !== 'settlement') {
      throw new Error(`exploration.reveal: ${JSON.stringify(fact.slotId)} is not a settlement slot in the seed`);
    }
    slotId = site.id;
    planetId = site.planetId;
  } else {
    planetId = fact && fact.planetId;
    if (!getPlanet(planetId)) {
      throw new Error(`exploration.reveal: ${JSON.stringify(planetId)} is not a planet in the seed`);
    }
  }

  let learned = 0;
  if (!guild.exploration) guild.exploration = {};
  let entry = guild.exploration[planetId];
  if (!entry) {
    // Both tracks from birth, so every entry has one shape whatever first named its planet.
    entry = { tick, nodes: {}, slots: {} };
    guild.exploration[planetId] = entry;
    learned += 1;
  }
  if (nodeId !== null && entry.nodes[nodeId] === undefined) {
    entry.nodes[nodeId] = tick;
    learned += 1;
  }
  if (slotId !== null && entry.slots[slotId] === undefined) {
    entry.slots[slotId] = tick;
    learned += 1;
  }
  return learned;
}

// revealSurface(guild, planetRow, tick) -> new facts learned. The WHOLE SURFACE of one planet: every
// resource node AND every settlement slot on it, through `reveal` (§4 ruling 10: one survey walks the
// ground for both). `planetRow` is that planet's row in the seed's own layout (`getSystemLayout(...)
// .planets[i]`), so which nodes and slots exist is the seed's fact — nothing listed here by hand. The one
// place "surface" is spelled out, shared by founding and the L2 scan so the two can never disagree.
function revealSurface(guild, planetRow, tick) {
  let learned = 0;
  for (const node of planetRow.resourceNodes) learned += reveal(guild, { nodeId: node.id }, tick);
  for (const slot of planetRow.settlementSlots) learned += reveal(guild, { slotId: slot.id }, tick);
  return learned;
}

// revealSystem(guild, systemId, tick) -> new facts learned. EVERY planet of the system (L1) and its
// whole surface — every resource node and every settlement slot (L2) — through `reveal`. Founding uses it
// for the home system (§6: "it has lived there"). Walked in the seed's order; the order changes no value
// (each fact carries its own tick).
function revealSystem(guild, systemId, tick) {
  const layout = getSystemLayout(systemId);
  if (!layout) throw new Error(`exploration.revealSystem: ${JSON.stringify(systemId)} is not a system in the seed`);
  let learned = 0;
  for (const planet of layout.planets) {
    learned += reveal(guild, { planetId: planet.id }, tick);
    learned += revealSurface(guild, planet, tick);
  }
  return learned;
}

// revealSystemArchetypes(guild, systemId, tick) -> new facts learned. L1 of ONE system: every planet's
// ARCHETYPE, through `reveal` — and NO surface: no node, no slot. That is the whole difference from
// `revealSystem` above, which is founding's "it has lived there" and reveals every surface too. An L1 scan
// sees what the planets ARE, not what lies on them (§1). Its caller: a Deep Scan Array's L1 scan completing
// (sim/deep-scan-arrays.js `stepScanCompletions`).
function revealSystemArchetypes(guild, systemId, tick) {
  const layout = getSystemLayout(systemId);
  if (!layout) throw new Error(`exploration.revealSystemArchetypes: ${JSON.stringify(systemId)} is not a system in the seed`);
  let learned = 0;
  for (const planet of layout.planets) learned += reveal(guild, { planetId: planet.id }, tick);
  return learned;
}

// revealPlanetSurface(guild, planetId, tick) -> new facts learned. L2 of ONE planet: its whole surface —
// every resource node and every settlement slot — through `revealSurface`. (A node or slot fact also
// reveals its planet, but the scan's L1→L2 chain means the planet is already known by the time this runs.)
// Its caller: a Deep Scan Array's L2 scan completing. Named `revealPlanetNodes` until the settlement-surface
// slice (09-10-26), when it began revealing slots too and the old name stopped being true.
function revealPlanetSurface(guild, planetId, tick) {
  const planet = getPlanet(planetId);
  if (!planet) throw new Error(`exploration.revealPlanetSurface: ${JSON.stringify(planetId)} is not a planet in the seed`);
  const row = getSystemLayout(planet.systemId).planets.find((p) => p.id === planetId);
  return revealSurface(guild, row, tick);
}

// knowsPlanet(guild, planetId) / knowsNode(guild, nodeId) — the two read questions. A pure read.
// `knowsNode` is what the per-planet claim gate (§8) will ask, planet by planet; nothing enforces
// that gate yet — the Prefecture slice does.
function knowsPlanet(guild, planetId) {
  return !!(guild && guild.exploration && guild.exploration[planetId]);
}
function knowsNode(guild, nodeId) {
  const site = getSite(nodeId);
  if (!site || !knowsPlanet(guild, site.planetId)) return false;
  return guild.exploration[site.planetId].nodes[nodeId] !== undefined;
}

// cloneExploration(record) -> a deep-enough copy, or null for a missing/empty record (so the caller
// can keep the key omit-when-empty). Two levels deep — each planet entry and its `nodes` and `slots`
// maps are fresh objects — so a copy can never alias into engine state.
function cloneExploration(record) {
  if (!record || Object.keys(record).length === 0) return null;
  const out = {};
  for (const planetId of Object.keys(record)) {
    out[planetId] = {
      tick: record[planetId].tick,
      nodes: { ...record[planetId].nodes },
      slots: { ...record[planetId].slots },
    };
  }
  return out;
}

// isOnPublicRegister(venture) -> is this venture LICENSED, i.e. declared to the Syndicate?
// (§0: "licensed = declared to the Syndicate = public".) Two licence shapes exist: the ordinary
// windowed `licence` (Tier-1/2, and the Tier-3 contract) and the windowless `deuteriumLicence` on a
// licensed deuterium mine. Either one puts the venture on the public register; an unlicensed venture
// (including an illegal refinery) is private operations. Its one reader is the per-guild view
// (sim/fog.js), which shows a rival's venture only if this answers true. It never writes the record.
function isOnPublicRegister(venture) {
  return !!(venture && (venture.licence || venture.deuteriumLicence));
}

module.exports = {
  reveal, revealSystem, revealSystemArchetypes, revealPlanetSurface, knowsPlanet, knowsNode, cloneExploration,
  isOnPublicRegister,
};
