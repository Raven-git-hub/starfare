'use strict';

// claims.js — the accessor layer over the SHARED territory rows (`state.claims`,
// design.md §15.1 / §15.4). One row is
//     { claimId, ownerGuildId, landmarkId, landmarkKind, claimedAtTick, contested }
// and it is the SOURCE OF TRUTH for who holds what (foundGuild pushes one; the
// guild-home invariant checks the denormalised `homeSystemId` against it, never
// the other way round).
//
// It exists so ONE predicate answers "does this guild hold this system?" for
// every caller. The BUY side needs that question twice — once when the purchase
// is validated (you may only buy into a system you hold) and once at the arrival
// tick (if it now answers false, the cargo is lost, §6) — and those two must be
// the SAME question, or a delivery could be legal to schedule and impossible to
// land, or vice versa.
//
// The same discipline runs one layer down, in hexes: `controlNear` is the one
// answer to "whose footprints cover this hex?", and the seniority control map at
// the end of this file (`controlledBy` / `resolveControl`, docs/territory-model.md
// §2) awards a contested hex to ONE claim, built on it.

// Seed geometry for `controlNear` and the control map below (the footprints' centres and radii). Both
// modules are seed-only and never require this one, so there is no require cycle.
const { getSystem, getClaimRadius } = require('./seed.js');
const { hexDistance, hexesWithin } = require('./transport.js');

// The ONE match expression the two questions below share, so they are literally the
// same question rather than two spellings of it that could drift apart.
// `landmarkKind` is part of the match for the same reason getLandmark demands it:
// an outpost id must never resolve as a system by luck.
const isSystemClaim = (c) => c.landmarkKind === 'system';
const isSystemClaimFor = (c, guildId) => c.ownerGuildId === guildId && isSystemClaim(c);

// guildHolds(state, guildId, systemId) -> boolean. A claim on that exact system,
// of kind 'system', owned by that guild.
function guildHolds(state, guildId, systemId) {
  return (state.claims || []).some((c) => isSystemClaimFor(c, guildId) && c.landmarkId === systemId);
}

// heldSystemIds(state, guildId) -> the systems that guild holds, sorted, no repeats.
//
// The PLURAL of `guildHolds`, and deliberately built on the same predicate: a
// caller that wants "which systems?" must not answer it by a second, differently
// spelled reading of `state.claims`, or the list and the check could disagree —
// exactly the drift this module's header exists to prevent. `heldSystemIds(...)
// .includes(x)` and `guildHolds(..., x)` are true together, always.
//
// SORTED and DEDUPED at the source. Sorted because a consumer emitting these into
// the snapshot needs stable bytes (invariant 9) and should not have to remember to
// sort; deduped because nothing structurally forbids two claim rows on one system,
// and a repeat would silently double a keyed map's work. Claim ids are ASCII, so
// `localeCompare` and byte order agree.
function heldSystemIds(state, guildId) {
  const ids = new Set();
  for (const c of state.claims || []) {
    if (isSystemClaimFor(c, guildId)) ids.add(c.landmarkId);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// systemControllers(state) -> Map systemId -> the guild id holding it. The L0 "controlling
// guild" fact (docs/exploration-model.md §1 — never fogged, every system) for the whole galaxy at
// once, so the per-guild view does not ask `guildHolds` 1,500 × guilds times. Built on the SAME
// `isSystemClaim` test as the two questions above, so `systemControllers(s).get(x) === g` and
// `guildHolds(s, g, x)` agree. A system with no system claim is simply absent (unclaimed).
// If two claim rows ever named one system, the FIRST in `state.claims` order would answer —
// deterministic (invariant 9); nothing builds that today (founding refuses an already-claimed home).
function systemControllers(state) {
  const out = new Map();
  for (const c of state.claims || []) {
    if (isSystemClaim(c) && !out.has(c.landmarkId)) out.set(c.landmarkId, c.ownerGuildId);
  }
  return out;
}

// systemHolder(state, systemId) -> the id of the guild holding `systemId`, or null when no guild does
// (the system is unclaimed). The single-system form of `systemControllers` above, built on the same
// `isSystemClaim` test and answering the same way when two rows ever named one system (the FIRST in
// `state.claims` order), so `systemHolder(s, x) === g` exactly when `guildHolds(s, g, x)` for the guild
// the map would name. The Prefecture / claims slice asks it twice, each time to tell THREE cases apart —
// unclaimed, held by this guild, held by a rival: the ferry's unheld-system unload exception (a Prefecture
// kit may unload into an unclaimed system or its own, never a rival's) and the plant's one-per-system gate.
function systemHolder(state, systemId) {
  const row = (state.claims || []).find((c) => isSystemClaim(c) && c.landmarkId === systemId);
  return row ? row.ownerGuildId : null;
}

// controlNear(state, coords, within) -> every guild CONTROL FOOTPRINT that reaches to within `within` hexes of
// hex `coords`. THE ONE answer to "whose footprints cover this hex?" (`within` 0) and to "whose control is this
// hex in or beside?" (`within` 1), so the two questions cannot drift apart (roadmap 2.5 slice 15; the Deep Scan
// Array's placement rule, docs/exploration-model.md §5 REVISED 15-10-26, is its first caller). It lists them ALL
// and decides nothing; which ONE guild a contested hex belongs to is `controlledBy` below, built on this.
//
// Today's footprints (docs/territory-model.md §2):
//   - a held SYSTEM controls every hex within its seed `claimRadius` of its centre, the centre included;
//   - a guild OUTPOST controls only its own hex: radius 0, because it has no aura yet. When the aura radii are
//     ruled, "controlled" grows with them — here, and nowhere else.
// So a hex is within `within` of a footprint exactly when it is within (radius + `within`) of its centre.
//
// Each footprint is { guildId, kind: 'system' | 'outpost', id, anchorSystemId }: a system is its own anchor, an
// Outpost hangs off its stored `anchorSystemId`. A held system's footprint also names the claim row it comes from
// — `claimId` and `claimedAtTick`, the two facts §2's seniority reads (an Outpost writes no claim row, so its
// footprint has neither). Held systems come first, then Outposts, each in id order, so the first one a caller
// picks is stable (invariant 9). Holding is read through `isSystemClaim`, the same match the questions above use
// — never a second notion of holding. If two rows ever named one guild's hold on one system, the FIRST in
// `state.claims` order is its footprint, as it is `systemHolder`'s answer (play never writes two).
//
// MORE THAN ONE GUILD can come back for a single hex: two held disks may overlap (§2 keeps overlap "as a
// feature"). This hands back every footprint; `controlledBy` applies §2's seniority rule to award the hex.
function controlNear(state, coords, within) {
  const systems = new Map();   // "guild|system" -> footprint: a Map, so a repeated claim row counts once
  for (const c of state.claims || []) {
    if (!isSystemClaim(c)) continue;
    const claimRadius = claimRadiusOf(c);
    const key = `${c.ownerGuildId}|${c.landmarkId}`;
    if (!systems.has(key) && hexDistance(coords, getSystem(c.landmarkId).coords) <= claimRadius + within) {
      systems.set(key, {
        guildId: c.ownerGuildId, kind: 'system', id: c.landmarkId, anchorSystemId: c.landmarkId,
        claimId: c.claimId, claimedAtTick: c.claimedAtTick,
      });
    }
  }
  const outposts = (state.outposts || [])
    .filter((o) => hexDistance(coords, o.coords) <= within)
    .map((o) => ({ guildId: o.ownerGuildId, kind: 'outpost', id: o.id, anchorSystemId: o.anchorSystemId }));
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...[...systems.values()].sort(byId), ...outposts.sort(byId)];
}

// claimRadiusOf(claim) -> the seed `claimRadius` of a held system's footprint. A held system with no footprint
// radius is a broken seed, not a hex that "happens to be outside" it — so this HALTS rather than quietly answer
// (design.md §15.5: a silent violation is worse than a crash). Shared by `controlNear` and the control map's net,
// so both halt on the same words.
function claimRadiusOf(c) {
  const claimRadius = getClaimRadius(c.landmarkId);
  if (claimRadius === null) {
    throw new Error(`hex control: guild ${JSON.stringify(c.ownerGuildId)} holds system ${JSON.stringify(c.landmarkId)}, whose seed row carries no whole-number claimRadius`);
  }
  return claimRadius;
}

// ---------------------------------------------------------------------------------------------------------------
// THE SENIORITY CONTROL MAP (docs/territory-model.md §2, "The control footprint & the first-settled rule"; roadmap
// 2.5, the Prefecture / claims slice, engine PR 2). Two held systems' footprints may overlap, and §2 awards each
// contested hex to ONE claim:
//   1. a hex within a held system's claimRadius of its centre is a CANDIDATE of that system's claim (controlNear's
//      system footprints — the coverage question is asked there and nowhere else);
//   2. among the candidates, the OLDEST `claimedAtTick` wins;
//   3. OWN-CENTRE OVERRIDE: a held system's own centre hex is that system's, whatever the seniority — a senior
//      neighbour never takes another system's centre;
//   4. TIE-BREAK: equal `claimedAtTick` -> the LOWER `claimId` (byte order; claim ids are ASCII), the
//      stable-ordering convention (invariant 9).
// DERIVED, NEVER STORED (§1): a pure read of `state.claims` and the seed, recomputed on every call — so a claim
// added or removed changes the answer with nothing to reconcile. It writes nothing.
//
// SCOPE — the SYSTEM layer only. §2's seniority rule is ruled for claimed systems; an Outpost writes no claim row
// (it has no `claimedAtTick` to rank), so its one-hex footprint is not in this map. controlNear still lists it, and
// how the two compose (an Outpost hex inside a rival's disk) is on the decision checklist, not decided here.

// seniorFirst(a, b) — rules 2 and 4 as one sort order over system footprints: the older claim first, and at equal
// ticks the lower claimId.
function seniorFirst(a, b) {
  if (a.claimedAtTick !== b.claimedAtTick) return a.claimedAtTick - b.claimedAtTick;
  return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
}

// controllingFootprint(state, coords) -> the ONE held-system footprint (controlNear's shape) that controls hex
// `coords` under §2, or null when no held system's footprint covers it. The rule lives here, once; `controlledBy`
// and `resolveControl` are both read off it.
function controllingFootprint(state, coords) {
  const candidates = controlNear(state, coords, 0).filter((f) => f.kind === 'system');
  if (candidates.length === 0) return null;
  for (const f of candidates) {
    // Seniority cannot rank a claim with no whole tick (design.md §15.2 — every mutation records its tick). HALT,
    // naming it, rather than let a comparison with a missing number quietly pick a winner.
    if (!Number.isInteger(f.claimedAtTick) || f.claimedAtTick < 0) {
      throw new Error(`hex control: claim ${JSON.stringify(f.claimId)} (guild ${JSON.stringify(f.guildId)}, system ${JSON.stringify(f.id)}) carries no whole claimedAtTick (${JSON.stringify(f.claimedAtTick)}) — seniority cannot rank it`);
    }
  }
  // Rule 3 — the own-centre override. The hex is a held system's centre when that system's footprint is a
  // candidate at distance 0. Its holder is asked of `systemHolder`, so the map and the accessor cannot disagree.
  const centre = candidates.find((f) => hexDistance(coords, getSystem(f.id).coords) === 0);
  if (centre) {
    const holder = systemHolder(state, centre.id);
    return candidates.find((f) => f.id === centre.id && f.guildId === holder);
  }
  // Rules 2 and 4 — the senior claim among the candidates.
  return [...candidates].sort(seniorFirst)[0];
}

// controlledBy(state, coords) -> the id of the guild that controls hex `coords` under §2's seniority rule, or null
// when no held system's footprint covers it. For a held system's own centre this is exactly `systemHolder` (rule
// 3); on a hex only one footprint covers, it is that claim's owner.
function controlledBy(state, coords) {
  const f = controllingFootprint(state, coords);
  return f ? f.guildId : null;
}

// resolveControl(state) -> [ { q, r, guildId, claimId } ] — THE WHOLE MAP: every hex some held system's footprint
// covers, with the guild that controls it and the claim that won it, sorted by q then r (invariant 9). Empty when
// no system is held.
//
// THE RULE IS NOT COPIED HERE. Each hex is put to `controllingFootprint` — the very rule `controlledBy` answers
// with — so a row of the map and `controlledBy` for that hex are one answer. What this adds is only WHERE TO ASK:
// a net of every hex within claimRadius of each held system's centre (`hexesWithin`, a Map so an overlapped hex is
// asked once). Every hex the rule could award is in some held disk, so the net misses none; a test compares the
// map with the rule written out independently over a wider area. A net hex the rule awards to nobody would mean
// the net and controlNear disagree about a disk, so that HALTS.
//
// Hexes are listed as the footprint covers them, the galaxy's rim included: no bounds filter, exactly as the
// client's territory paint draws a disk today (on the committed seed, 11 systems' disks reach past the rim).
//
// A system claim naming a system the seed does not have is a DANGLING reference: the claim invariant halts the
// tick on it, and the god's-eye lens shows its row with `landmark: null` rather than throwing (the debug lens
// surfaces the breakage — tests/snapshot.test.js). It has no centre to cast a net from, so the net passes over it.
// It cannot quietly shrink the map: asking about any held hex goes through controlNear, which halts on it.
function resolveControl(state) {
  const net = new Map();   // "q,r" -> { q, r }
  for (const c of state.claims || []) {
    if (!isSystemClaim(c) || !getSystem(c.landmarkId)) continue;
    for (const hex of hexesWithin(getSystem(c.landmarkId).coords, claimRadiusOf(c))) net.set(`${hex.q},${hex.r}`, hex);
  }
  const rows = [];
  for (const hex of net.values()) {
    const f = controllingFootprint(state, hex);
    if (!f) throw new Error(`control map: hex ${hex.q},${hex.r} lies in a held disk, yet no held system's footprint covers it`);
    rows.push({ q: hex.q, r: hex.r, guildId: f.guildId, claimId: f.claimId });
  }
  return rows.sort((a, b) => a.q - b.q || a.r - b.r);
}

module.exports = {
  guildHolds, heldSystemIds, systemControllers, systemHolder, controlNear, controlledBy, resolveControl,
};
