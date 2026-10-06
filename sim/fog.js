'use strict';

// fog.js — the PER-GUILD view: from the god's-eye snapshot, exactly what ONE guild may see
// (docs/exploration-model.md §2, §3, §7; roadmap 2.5 (a), engine slice 1).
//
// `buildSnapshot(state)` is the god's-eye debug lens and stays exactly what it was. The player path
// asks `buildSnapshot(state, guildId)`, which builds that same god's-eye object and hands it here.
// This file only SUBTRACTS rival facts and ADDS the guild's geography; it computes no game number
// (the tick stays central). It reads the record, the claims and the seed — never writes anything.
//
// The view = L0 (always) ∪ the guild's record (permanent) ∪ the live rules (recomputed) — §3:
//   - THE VIEWING GUILD sees its own data in full, row for row as the god's-eye lens shows it.
//   - EVERY RIVAL is cut to the public facts (§0: "licensed is public, ownership is public, geography
//     is learnable, operations are private"):
//       · its guild row     → who it is and where its home is (id, name, isBot, homeSystemId);
//       · its ventures      → ONLY the licensed ones (the public register), and of each only the node,
//                             its planet's archetype, the venture type and its reputation (design.md
//                             §5: "fully visible") — never a stockpile, terms or recipe (§405);
//                             an UNLICENSED rival venture is not in the view at all (fogged until L3);
//       · its outposts      → where they are and whose (a structure is public; its stockpile and dock
//                             are not — the dock names the rival's transports, which are never shown);
//       · its deep-scan arrays → NOT IN THE VIEW AT ALL (§2: "transports and deep-scan arrays are never"
//                             visible, unlike outposts and toll gates — until L3, deferred);
//       · its claims        → kept (ownership is public), the claimed system's seed detail cut to L0;
//       · its deliveries, pending builds, production preview and notices → not in the view.
//   - GALAXY-WIDE AGGREGATES are coarsened to posted values (design.md §5: "the real supply figure is
//     hidden; players see only the value and its history"): no Σ-of-every-guild total survives that a
//     guild could subtract its own share from to read a rival's holdings.
//   - NODE LOCKOUTS are shown only on a node the viewer knows or on ground it controls.
//   - `geography` is added: L0 for every system, plus the viewing guild's record, resolved.
//
// ALLOW-LISTS, NOT DENY-LISTS, for every rival row: a field added to a guild / venture / outpost row
// later is HIDDEN from rivals until someone decides it is public. And every top-level key of the
// god's-eye snapshot must be classified in TOP_LEVEL below — tests/fog.test.js fails loudly on a new,
// unclassified key, so no future field reaches the player view by default.

const { getSite, getPlanet, getL0Systems } = require('./seed.js');
const { systemControllers, guildHolds } = require('./claims.js');
const { isOnPublicRegister, knowsNode } = require('./exploration.js');

// What a rival's guild row keeps. `homeSystemId` is the controller fact (L0, public via the claim);
// `homePlanetId` is NOT kept — it names a planet inside a rival system, which is L1 the guild has not
// learned. Credits, fuel, stockpiles, reputation, points, assets, vehicles, orders, events… all go.
const RIVAL_GUILD_FIELDS = ['id', 'name', 'isBot', 'homeSystemId'];

// What a rival LICENSED venture's row keeps (§2: "that node, its planet's archetype, and the venture
// type — never the stockpile"). `site` is the node itself: kind, planet, system, the node's resource
// type and its display name (all facts about the node the register reveals). The archetype is added
// as `planetArchetype`, from the seed. `reputation` is kept — RULED 06-10-26: design.md §5, "ventures
// carry a FULLY VISIBLE reputation score" (the investment-risk signal and the takeover trigger), so a
// rival can watch pressure build. Everything operational — rate, licence terms and fees, a
// refinery's recipe / produced good (§405: types are visible so a rival INFERS the inputs, it is not
// told them), carries, settlement preview — is dropped.
const RIVAL_VENTURE_FIELDS = ['id', 'ownerGuildId', 'type', 'siteId', 'systemId', 'ventureName', 'reputation', 'site'];

// What a rival outpost's row keeps: where the structure is, whose it is, what it anchors to (§2:
// "outposts and toll gates are always visible"). Its stockpile, used space, capacities and dock
// queue/slots (which name the rival's craft) are operations, and go.
const RIVAL_OUTPOST_FIELDS = ['id', 'ownerGuildId', 'coords', 'anchorSystemId'];

// What a RIVAL's system claim keeps of its resolved seed landmark: L0 — identity and position. The
// god's-eye claim row resolves the whole system landmark, which also carries `terranHomeworldId`
// (which of the rival's planets is its Terran homeworld — L1 of a planet the viewer has not learned),
// `starterEligible` (≥ 1 Terran planet — L1) and `ring` (position-derived, dropped with them to keep
// the row to L0). The claim ROW itself — who holds which landmark, since when — stays whole: ownership
// is public (§1). Waystation and Citadel claims, and the viewer's own claims, pass through untouched.
const RIVAL_SYSTEM_LANDMARK_FIELDS = ['id', 'kind', 'name', 'coords'];

// THE GALAXY-WIDE AGGREGATES — RULED 06-10-26 (design.md §5: "the real supply figure is hidden;
// players see only the value and its history"). The god's-eye `galacticSupply` and `syndicate` blocks
// are sums over EVERY guild: `resources` (Σ stockpiles), `fuel.guildHeld` / `fuel.total` (Σ hoards),
// and `syndicate.ledger` (the balancing account — by invariant 2 it moves opposite Σ guild credits).
// A guild that subtracts its own share from any of them reads its rivals' holdings — exactly, with one
// rival. So the per-guild view keeps only the POSTED values and the shared pool's scarcity signal:
//   fuel — `reserve` (the Syndicate pool every guild draws from — not anyone's holding), `fuelPrice`
//          (the posted price), `avgDraw` / `targetReserve` (the controller's demand signal and target).
//   syndicate — no field of today's row is public; the allow-list is empty, so the block is `{}` until
//          a genuinely public Syndicate fact is added to it deliberately.
// (A posted price moves with total supply over ticks — that is the value §5 lets players see.)
const GALAXY_FUEL_FIELDS = ['reserve', 'fuelPrice', 'avgDraw', 'targetReserve'];
const SYNDICATE_PUBLIC_FIELDS = [];

// EVERY top-level key of the god's-eye snapshot, classified. `public` passes through untouched;
// `filtered` is rewritten below. A key in neither list fails tests/fog.test.js.
const TOP_LEVEL = {
  public: [
    'schemaVersion', 'tick', 'calendar', 'prices', 'priceHistory',
    'fuelPriceHistory', 'priceBase', 'goodVolumes', 'haulerTiers', 'feeQuote', 'tier3Contract',
    'assetPurchaseQuote',
  ],
  filtered: [
    'galacticSupply', 'syndicate', 'guilds', 'production', 'ventures', 'occupancy', 'claims', 'outposts',
    'deepScanArrays', 'shipments', 'nodeLockouts', 'syndicateBuilds', 'attention',
  ],
};

// The classified keys the god's-eye snapshot OMITS WHEN EMPTY, so a snapshot may lack them. Every other
// classified key is always present. `deepScanArrays` (2.5 (b1)) is omitted until an array exists, so a
// galaxy without one serves exactly the god's-eye bytes it did before arrays existed.
const OMIT_WHEN_EMPTY_TOP_LEVEL = ['deepScanArrays'];

function pick(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

// registeredVentureIds(state) -> the ids of every venture on the public register, asked of the STORED
// ventures through the SAME `isOnPublicRegister` the end-of-tick record observation uses — so "a
// rival venture this view shows" and "a rival venture the record learns from" are one question.
function registeredVentureIds(state) {
  const ids = new Set();
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) if (isOnPublicRegister(v)) ids.add(v.id);
  }
  return ids;
}

// claimRow(row, guildId) — every claim stays (ownership is public); a RIVAL's SYSTEM claim has its
// resolved landmark cut to L0 (RIVAL_SYSTEM_LANDMARK_FIELDS above).
function claimRow(row, guildId) {
  if (row.ownerGuildId === guildId || row.landmarkKind !== 'system' || !row.landmark) return row;
  return { ...row, landmark: pick(row.landmark, RIVAL_SYSTEM_LANDMARK_FIELDS) };
}

// isLockoutVisible(state, guild, lockout) — RULED 06-10-26. A node lockout names a site and the tick
// it frees. The viewer sees it only if it KNOWS the node (its record, `knowsNode`) or CONTROLS the
// node's system (its own ground — where the lockout gates its own establish). Anything else would name
// a node inside a rival system the viewer never learned: e.g. one licensed and torn down between two
// ticks, so never on the register at a tick. A settlement slot is not a node and is never "known" in
// the record, so a slot's lockout shows only on ground the viewer controls.
function isLockoutVisible(state, guild, lockout) {
  if (knowsNode(guild, lockout.siteId)) return true;
  const site = getSite(lockout.siteId);
  return !!site && guildHolds(state, guild.id, site.systemId);
}

function rivalVentureRow(row) {
  const out = pick(row, RIVAL_VENTURE_FIELDS);
  const planet = row.site ? getPlanet(row.site.planetId) : null;
  out.planetArchetype = planet ? planet.archetype : null;
  return out;
}

// geographyFor(state, guild) -> { systems, known } — what the guild may draw as MAP:
//   systems — L0, every system, id order: { id, name, coords, planetCount, controllerGuildId }.
//             Never fogged (§1), so computed here for all, never stored per guild.
//   known   — the guild's exploration RECORD, resolved through the seed and grouped by system:
//             { [systemId]: { [planetId]: { archetype, nodes: { [nodeId]: resourceType } } } }.
//             Only what the record holds; keys in sorted order so the bytes are stable (invariant 9).
// The live half of the map — a rival's licensed node and its planet's archetype — rides on that
// rival's venture row instead (`ventures`), so the two sources stay distinct (§3).
function geographyFor(state, guild) {
  const controllers = systemControllers(state);
  const systems = getL0Systems().map((s) => ({
    id: s.id,
    name: s.name,
    coords: { q: s.coords.q, r: s.coords.r },
    planetCount: s.planetCount,
    controllerGuildId: controllers.get(s.id) || null,
  }));

  const known = {};
  const record = guild.exploration || {};
  for (const planetId of Object.keys(record).sort()) {
    const planet = getPlanet(planetId);
    if (!planet) continue; // a dangling id is the record invariant's to halt on, not the view's to draw
    const nodes = {};
    for (const nodeId of Object.keys(record[planetId].nodes).sort()) {
      const site = getSite(nodeId);
      if (site) nodes[nodeId] = site.resourceType;
    }
    if (!known[planet.systemId]) known[planet.systemId] = {};
    known[planet.systemId][planetId] = { archetype: planet.archetype, nodes };
  }
  // Systems in sorted order too (planets were visited in planet order, which need not be system order).
  const knownSorted = {};
  for (const systemId of Object.keys(known).sort()) knownSorted[systemId] = known[systemId];
  return { systems, known: knownSorted };
}

// fogForGuild(full, state, guildId) -> the per-guild view. `full` is a FRESH god's-eye snapshot of
// `state` (buildSnapshot built it for this call), so its objects may be passed through without a
// copy: nothing else holds them. Throws on a guild that does not exist — asking for a view through
// nobody's eyes is a caller bug, and quietly returning the god's-eye view would leak everything.
function fogForGuild(full, state, guildId) {
  const guild = (state.guilds || []).find((g) => g.id === guildId);
  if (!guild) throw new Error(`fogForGuild: no guild with id ${JSON.stringify(guildId)}`);

  // The viewer's own ventures in full; a rival's only if it is on the public register.
  const registered = registeredVentureIds(state);
  const ventures = full.ventures
    .filter((v) => v.ownerGuildId === guildId || registered.has(v.id))
    .map((v) => (v.ownerGuildId === guildId ? v : rivalVentureRow(v)));
  const visibleVentureIds = new Set(ventures.map((v) => v.id));

  const out = {};
  for (const key of Object.keys(full)) {
    if (TOP_LEVEL.public.includes(key)) out[key] = full[key];
    else if (key === 'galacticSupply') out.galacticSupply = { fuel: pick(full.galacticSupply.fuel, GALAXY_FUEL_FIELDS) };
    else if (key === 'syndicate') out.syndicate = pick(full.syndicate, SYNDICATE_PUBLIC_FIELDS);
    else if (key === 'nodeLockouts') out.nodeLockouts = full.nodeLockouts.filter((l) => isLockoutVisible(state, guild, l));
    else if (key === 'guilds') out.guilds = full.guilds.map((g) => (g.id === guildId ? g : pick(g, RIVAL_GUILD_FIELDS)));
    else if (key === 'production') out.production = full.production.filter((p) => p.guildId === guildId);
    else if (key === 'ventures') out.ventures = ventures;
    else if (key === 'occupancy') {
      out.occupancy = {};
      for (const siteId of Object.keys(full.occupancy)) {
        if (visibleVentureIds.has(full.occupancy[siteId])) out.occupancy[siteId] = full.occupancy[siteId];
      }
    } else if (key === 'claims') out.claims = full.claims.map((c) => claimRow(c, guildId));
    else if (key === 'outposts') out.outposts = full.outposts.map((o) => (o.ownerGuildId === guildId ? o : pick(o, RIVAL_OUTPOST_FIELDS)));
    else if (key === 'deepScanArrays') {
      // ONLY THE VIEWER'S OWN arrays, each in full (exploration-model.md §2: a rival's deep-scan arrays are
      // never visible). And the key itself follows the VIEWER: omitted unless the viewer owns one. Were it
      // kept as `[]` whenever the god's-eye lens had a row, its mere presence would tell the viewer that
      // SOME rival owns an array — the view's shape must never depend on a rival's hidden state.
      const own = full.deepScanArrays.filter((a) => a.ownerGuildId === guildId);
      if (own.length) out.deepScanArrays = own;
    }
    else if (key === 'shipments') out.shipments = full.shipments.filter((s) => s.ownerGuildId === guildId);
    else if (key === 'syndicateBuilds') out.syndicateBuilds = full.syndicateBuilds.filter((b) => b.ownerGuildId === guildId);
    else if (key === 'attention') {
      out.attention = {
        renegotiations: full.attention.renegotiations.filter((r) => r.guildId === guildId),
        notices: full.attention.notices.filter((n) => n.guildId === guildId),
      };
    } else {
      // An unclassified key: fail LOUDLY rather than guess whether it is public (§18 — a silent leak
      // is worse than a crash). tests/fog.test.js catches this before it can ship.
      throw new Error(`fogForGuild: snapshot key ${JSON.stringify(key)} is not classified in TOP_LEVEL (sim/fog.js)`);
    }
  }
  // Which guild this view is through, and the map it may draw. Added AFTER the god's-eye keys, so a
  // reader comparing the two lenses sees every shared key in the same place.
  out.viewerGuildId = guildId;
  out.geography = geographyFor(state, guild);
  return out;
}

module.exports = {
  fogForGuild, geographyFor, TOP_LEVEL, OMIT_WHEN_EMPTY_TOP_LEVEL,
  RIVAL_GUILD_FIELDS, RIVAL_VENTURE_FIELDS, RIVAL_OUTPOST_FIELDS, RIVAL_SYSTEM_LANDMARK_FIELDS,
  GALAXY_FUEL_FIELDS, SYNDICATE_PUBLIC_FIELDS,
};
