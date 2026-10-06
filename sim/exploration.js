'use strict';

// exploration.js — the per-guild EXPLORATION RECORD (docs/exploration-model.md §3, §6, §7).
//
// What a guild has LEARNED about the galaxy's static geography, kept forever once learned
// ("learn-once / known-forever", §3). It is OWNED guild state, nested on the Guild exactly as
// `assets` and `ventures` are: holding the row IS knowing the fact. It is serialized, so it is
// covered by the determinism hash (invariant 9), and it only ever grows, like `lifetimeProduced`.
//
// THE SHAPE (chosen at build, 05-10-26 — the smallest that answers the per-planet claim gate, §8):
//
//     guild.exploration = {
//       [planetId]: { tick, nodes: { [nodeId]: tick } }
//     }
//
//   - A planet KEY present  = the guild knows that planet's ARCHETYPE (L1). `tick` = when it learned it.
//   - A node key under it   = the guild knows that resource node and its TYPE (L2). Value = when learned.
//   - `nodes` is `{}` for a planet known at L1 only.
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
// THE ONE WRITE PATH is `reveal` below. Every source funnels through it — founding (§6) and a
// rival's licensed venture (§3) in this slice; the Deep Scan Array, a craft visit and the
// Prefecture later. It is source-agnostic on purpose: it records WHAT was learned and WHEN, never
// HOW, so a new source adds a caller, not a second writer.

const { getSite, getPlanet, getSystemLayout } = require('./seed.js');

// reveal(guild, fact, tick) -> the number of NEW facts learned (0 = it already knew; a no-op).
//
// `fact` is one of:
//   { planetId }  — L1: the guild learns that planet's archetype.
//   { nodeId }    — L2: the guild learns that resource node's type. A node cannot be known without
//                   its planet (you learn where it is), so this ALSO reveals the node's planet.
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
  if (fact && fact.nodeId != null) {
    const site = getSite(fact.nodeId);
    if (!site || site.kind !== 'resource') {
      throw new Error(`exploration.reveal: ${JSON.stringify(fact.nodeId)} is not a resource node in the seed`);
    }
    nodeId = site.id;
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
    entry = { tick, nodes: {} };
    guild.exploration[planetId] = entry;
    learned += 1;
  }
  if (nodeId !== null && entry.nodes[nodeId] === undefined) {
    entry.nodes[nodeId] = tick;
    learned += 1;
  }
  return learned;
}

// revealSystem(guild, systemId, tick) -> new facts learned. EVERY planet of the system (L1) and EVERY
// resource node on each (L2), through `reveal`. Founding uses it for the home system (§6: "it has
// lived there"). The seed's own layout is the source of which planets and nodes exist — nothing listed
// here by hand. Walked in the seed's order; the order changes no value (each fact carries its own tick).
function revealSystem(guild, systemId, tick) {
  const layout = getSystemLayout(systemId);
  if (!layout) throw new Error(`exploration.revealSystem: ${JSON.stringify(systemId)} is not a system in the seed`);
  let learned = 0;
  for (const planet of layout.planets) {
    learned += reveal(guild, { planetId: planet.id }, tick);
    for (const node of planet.resourceNodes) learned += reveal(guild, { nodeId: node.id }, tick);
  }
  return learned;
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
// can keep the key omit-when-empty). Two levels deep — each planet entry and its `nodes` map are
// fresh objects — so a copy can never alias into engine state.
function cloneExploration(record) {
  if (!record || Object.keys(record).length === 0) return null;
  const out = {};
  for (const planetId of Object.keys(record)) {
    out[planetId] = { tick: record[planetId].tick, nodes: { ...record[planetId].nodes } };
  }
  return out;
}

// isOnPublicRegister(venture) -> is this venture LICENSED, i.e. declared to the Syndicate?
// (§0: "licensed = declared to the Syndicate = public".) Two licence shapes exist: the ordinary
// windowed `licence` (Tier-1/2, and the Tier-3 contract) and the windowless `deuteriumLicence` on a
// licensed deuterium mine. Either one puts the venture on the public register; an unlicensed venture
// (including an illegal refinery) is private operations and teaches a rival nothing.
function isOnPublicRegister(venture) {
  return !!(venture && (venture.licence || venture.deuteriumLicence));
}

// publicRegisterFacts(state) -> [{ ownerGuildId, fact }] — what every licensed, seated venture in the
// galaxy teaches a rival about geography, in guild-then-venture array order (invariant 9):
//   - on a resource NODE: { nodeId } — the node's type, and with it its planet's archetype;
//   - on a settlement SLOT: { planetId } — a slot is not a resource node, so there is no node fact,
//     only the planet's archetype (§2: "that node, its planet's archetype, and the venture type").
// A venture whose site does not resolve is skipped here; the site-occupancy invariant halts on it.
function publicRegisterFacts(state) {
  const out = [];
  for (const owner of state.guilds || []) {
    for (const v of owner.ventures || []) {
      if (!isOnPublicRegister(v) || !v.siteId) continue;
      const site = getSite(v.siteId);
      if (!site) continue;
      const fact = site.kind === 'resource' ? { nodeId: site.id } : { planetId: site.planetId };
      out.push({ ownerGuildId: owner.id, fact });
    }
  }
  return out;
}

// observePublicRegister(state, tick) — the observe-and-record step (§3's "a rival's licensed venture
// teaches you one node", made permanent). Every guild reads every RIVAL's licensed ventures off the
// public register and writes what they teach into its own record, through `reveal`. Its own ventures
// are skipped: what a guild learns from the register is what OTHER guilds declared.
//
// Learn-once does the rest: a venture that stays licensed for a thousand ticks writes its facts once,
// and when it later closes, the venture TYPE drops out of the live view but nothing here is undone —
// the node stays known (§3). Runs at the END of every tick (sim/tick.js); mutates `state` in place, as
// every tick step does on the tick's own clone. Deterministic: guilds in array order, the register
// in its own fixed order, and each fact carries its own tick, so no value depends on visiting order.
function observePublicRegister(state, tick) {
  const register = publicRegisterFacts(state);
  if (register.length === 0) return state;
  for (const observer of state.guilds || []) {
    for (const { ownerGuildId, fact } of register) {
      if (ownerGuildId === observer.id) continue;
      reveal(observer, fact, tick);
    }
  }
  return state;
}

module.exports = {
  reveal, revealSystem, knowsPlanet, knowsNode, cloneExploration,
  isOnPublicRegister, publicRegisterFacts, observePublicRegister,
};
