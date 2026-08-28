'use strict';

// seed.js — the engine's read-only window onto the static galaxy seed
// (data/seed.json). This is where the live overlay names a place by id and the
// seed resolves that id to what it says is there (design.md §15.3's separate
// store). It NEVER mutates the seed — the seed is a pure function of one integer
// and stays that way.
//
// It builds two indexes over the seed, once, lazily, cached for the process:
//   - SITES: every planet's resource nodes AND settlement slots — where a
//     venture can sit (used by occupancy + the site-occupancy invariant).
//   - LANDMARKS: the galaxy's claimable/referenceable features — the Citadel,
//     the Syndicate outposts (waystations), and the solar systems — where the
//     live TERRITORY layer (claims, guild homes) points. Added 03-08-26 so the
//     live world stops being a placeholder graph and starts referencing the
//     real seed (design.md §15.4).
// `require('../data/seed.json')` is itself cached by Node, so "load once" is
// free; these indexes are id -> place maps on top of it. Kept out of the tick
// hot path on purpose: only seating/claim validation and the invariants read
// the seed, so tick() stays seed-free and pure.

const path = require('node:path');

// A "site" is anywhere a venture can sit: a resource node (mining) or a
// settlement slot (refinery/factory/construction). Both share this shape:
//   { id, kind: 'resource' | 'settlement', planetId, systemId, resourceType?, name }
// where `name` is the friendly display name derived below ("FEN-6425 I · Node 1").
// A "landmark" is a claimable/referenceable seed feature:
//   citadel : { id: 'citadel', kind: 'citadel', coords, radius }
//   outpost : { id, kind: 'outpost', name, coords }
//   system  : { id, kind: 'system', name, ring, coords, starterEligible,
//               terranHomeworldId }   // homeworld = its lowest-id Terran planet
let _index = null;

// The ACTIVE seed object this module indexes. Null means "nobody has set one",
// in which case we fall back to the committed data/seed.json — the generator's
// reference fixture and the default for every non-persistent run, so the tests
// and the plain `node sim/server.js` path are unchanged by the galaxy lifecycle.
//
// A server WITH a persist volume owns the real choice (galaxy-lifecycle.md): it
// loads the volume's seed and calls setSeed() before anything reads the index.
// This file does no file IO of its own beyond that default require — it is a pure
// index over whatever seed it is handed.
let _seed = null;

// --- The friendly site name (DERIVED display telemetry, added 28-08-26) -------
// The seed names systems (`FEN-6425`) but not planets or sites, so every screen that
// wanted to say WHERE a venture sits printed a raw id (`pl_00004_n01`). These two pure
// helpers derive the name the console shows — from seed data alone, so the browser
// still computes nothing (design.md §5's display rule).
//
// Format: "<system name> <planet's Roman ordinal in its system> · <Node|Slot> <number>",
// e.g. `pl_00004_n01` in FEN-6425 -> "FEN-6425 I · Node 1". The ordinal is the planet's
// 1-based index in its system's `planets` array (the seed's own deterministic order),
// which is the only planet identity the seed carries beyond the id.

// Roman numerals, the ordinary subtractive notation. Not a game number — a way of
// writing one. Only ever called with a small positive planet ordinal; anything else
// (0, negative, non-integer) is handed back as its plain digits rather than faked.
const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function roman(n) {
  if (!Number.isInteger(n) || n < 1) return String(n);
  let left = n;
  let out = '';
  for (const [value, sym] of ROMAN) {
    while (left >= value) { out += sym; left -= value; }
  }
  return out;
}

// siteName(siteId, systemName, planetOrdinal) -> the display name, or the site id itself
// if the id does not carry the seed's `_nNN` / `_sNN` suffix. A weird-looking id beats a
// plausible-looking invention: an unparseable site says so on screen.
function siteName(siteId, systemName, planetOrdinal) {
  const m = /_([ns])(\d+)$/.exec(siteId);
  if (!m) return siteId;
  const kind = m[1] === 'n' ? 'Node' : 'Slot';
  return `${systemName} ${roman(planetOrdinal)} · ${kind} ${parseInt(m[2], 10)}`;
}

// setSeed(seedObject) — make this the active galaxy and drop the cached index, so
// the next read rebuilds over it. Called by the server on boot (volume seed) and
// on Create Galaxy, BEFORE the new zero-state is built (the ordering the atomic
// create depends on: the zero-state plants the Syndicate on THIS seed's landmarks).
function setSeed(seedObject) {
  _seed = seedObject || null;
  _index = null;
}

function buildIndex() {
  // Resolve relative to this file so it works regardless of cwd.
  const seed = _seed || require(path.join(__dirname, '..', 'data', 'seed.json'));

  const bySite = new Map();
  const bySystem = new Map();
  const bySystemRaw = new Map();
  const byOutpost = new Map();

  for (const sys of seed.systems || []) {
    // The lowest-id Terran planet is the homeworld a guild starts on (§13);
    // null if the system has none (i.e. it is not starter-eligible).
    let terranHomeworldId = null;
    // The planet's 1-based index in its system's own order — the ordinal `siteName`
    // turns into a Roman numeral. Counted here, where the seed's order is being
    // walked anyway, so nothing later has to re-find a planet in its system.
    let ordinal = 0;
    for (const planet of sys.planets || []) {
      ordinal += 1;
      if (planet.archetype === 'terran') {
        if (terranHomeworldId === null || planet.id < terranHomeworldId) terranHomeworldId = planet.id;
      }
      for (const node of planet.resourceNodes || []) {
        bySite.set(node.id, {
          id: node.id, kind: 'resource', resourceType: node.resourceType,
          planetId: planet.id, systemId: sys.id,
          name: siteName(node.id, sys.name, ordinal),
        });
      }
      for (const slot of planet.settlementSlots || []) {
        bySite.set(slot.id, {
          id: slot.id, kind: 'settlement',
          planetId: planet.id, systemId: sys.id,
          name: siteName(slot.id, sys.name, ordinal),
        });
      }
    }
    bySystem.set(sys.id, {
      id: sys.id, kind: 'system', name: sys.name, ring: sys.ring,
      coords: sys.coords, starterEligible: !!sys.starterEligible, terranHomeworldId,
    });
    // Keep the raw seed system too, so getSystemLayout can hand back its planets
    // (with nodes + slots) on demand without a second pass over the seed. It's a
    // reference into the already-cached seed object, not a copy.
    bySystemRaw.set(sys.id, sys);
  }

  for (const out of seed.outposts || []) {
    byOutpost.set(out.id, { id: out.id, kind: 'outpost', name: out.name, coords: out.coords });
  }

  // The Citadel is a single galactic-origin landmark with no seed id of its own
  // (just coords + radius). We give it the stable singleton key 'citadel' so the
  // live layer can reference it like any other landmark.
  const citadel = seed.citadel
    ? { id: 'citadel', kind: 'citadel', coords: seed.citadel.coords, radius: seed.citadel.radius }
    : null;

  return { bySite, bySystem, bySystemRaw, byOutpost, citadel, seedNumber: seed.seed };
}

function index() {
  if (_index === null) _index = buildIndex();
  return _index;
}

// --- Sites (where ventures sit) --------------------------------------------

// getSite(id) -> the site entry, or null if no such node/slot exists in the
// seed. This is the referential-integrity check a dangling siteId fails.
function getSite(id) {
  return index().bySite.get(id) || null;
}

function isResourceNode(id) {
  const s = getSite(id);
  return !!s && s.kind === 'resource';
}

function isSettlementSlot(id) {
  const s = getSite(id);
  return !!s && s.kind === 'settlement';
}

// findNodesByResource(type) -> every resource-node site of that good. For
// scenarios/tests that need a real node id to seat a venture on. Sorted by id
// for a stable, deterministic order.
function findNodesByResource(resourceType) {
  const out = [];
  for (const site of index().bySite.values()) {
    if (site.kind === 'resource' && site.resourceType === resourceType) out.push(site);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// --- Landmarks (where claims/homes point) ----------------------------------

function getCitadel() {
  return index().citadel;
}

function getSystem(id) {
  return index().bySystem.get(id) || null;
}

function getOutpost(id) {
  return index().byOutpost.get(id) || null;
}

// getOutposts() -> every Syndicate outpost (waystation), sorted by id for a
// stable, deterministic order. The zero-state claims all of these for the
// Syndicate at genesis.
function getOutposts() {
  return [...index().byOutpost.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// getLandmark(id, kind) -> the landmark entry for a given (id, kind) pair, or
// null. `kind` is required so a claim that points at the WRONG kind of thing
// (e.g. an outpost id tagged as a system) fails rather than resolving by luck —
// the same strictness the site-occupancy invariant applies to ventures.
function getLandmark(id, kind) {
  if (kind === 'citadel') {
    const c = getCitadel();
    return c && id === c.id ? c : null;
  }
  if (kind === 'outpost') return getOutpost(id);
  if (kind === 'system') return getSystem(id);
  return null;
}

// isStarterSystem(id) -> is this a real, starter-eligible system (design.md
// §13: it holds >=1 Terran planet)? The eligibility answer a guild home needs.
function isStarterSystem(id) {
  const s = getSystem(id);
  return !!s && s.starterEligible;
}

// getTerranHomeworld(systemId) -> the id of the system's homeworld (its
// lowest-id Terran planet), or null if the system has none / does not exist.
function getTerranHomeworld(systemId) {
  const s = getSystem(systemId);
  return s ? s.terranHomeworldId : null;
}

// getStarterSystems() -> every starter-eligible system (design.md §13: it holds
// >=1 Terran planet), each carried with its display name, ring, and the id of
// the Terran homeworld a guild would seat on. Sorted by id for a stable,
// deterministic order (mirrors getOutposts). This is the enumerator that the
// single-system isStarterSystem/getTerranHomeworld pair was missing: the
// testbed's home-system picker is built from it, so the picker offers exactly
// the seed's real, startable homes — nothing free-typed, nothing invented.
function getStarterSystems() {
  const out = [];
  for (const sys of index().bySystem.values()) {
    if (sys.starterEligible) {
      out.push({ id: sys.id, name: sys.name, ring: sys.ring, terranHomeworldId: sys.terranHomeworldId });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// getSystemLayout(id) -> a system's full STATIC territory, the way the UI drills
// into it: the system's identity plus every planet with its resource nodes and
// settlement slots. Empty slots are included on purpose — the UI needs to see
// where a venture COULD be established, not only where one already sits. This is
// pure seed data (the immutable substrate); the live overlay of who occupies
// which site comes from the snapshot's occupancy and is composed in the browser.
// Returns null if no such system exists (the endpoint turns that into a 404).
// Planet / node / slot order is the seed's own deterministic order.
function getSystemLayout(id) {
  const sys = index().bySystemRaw.get(id);
  if (!sys) return null;
  return {
    id: sys.id,
    name: sys.name,
    ring: sys.ring || null,
    starterEligible: !!sys.starterEligible,
    terranHomeworldId: getTerranHomeworld(sys.id),
    planets: (sys.planets || []).map((p) => ({
      id: p.id,
      archetype: p.archetype,
      resourceNodes: (p.resourceNodes || []).map((n) => ({ id: n.id, resourceType: n.resourceType })),
      settlementSlots: (p.settlementSlots || []).map((s) => ({ id: s.id })),
    })),
  };
}

// getSeedNumber() -> the integer the seed was generated from. The live world
// records this so a galaxy knows which seed it is built over.
function getSeedNumber() {
  return index().seedNumber;
}

module.exports = {
  setSeed,
  getSite, isResourceNode, isSettlementSlot, findNodesByResource, siteName, roman,
  getCitadel, getSystem, getOutpost, getOutposts, getLandmark,
  isStarterSystem, getTerranHomeworld, getStarterSystems, getSystemLayout, getSeedNumber,
};
