'use strict';

// droids.js — the droid vocabulary, its id scheme, and THE ONE droid mint (roadmap 2.6, droid engine
// slice 2; docs/droids.md §1).
//
// A droid is a production buff that will attach to a VENTURE (docs/droids.md §0). It is not a ground
// asset (miner / factory), not a vehicle and not an installation kit, so it lives in its own collection,
// `guild.droids`, beside `assets` / `ventures` / `vehicles`. One row per droid, because condition will be
// per-unit once decay lands.
//
// Slice 2 built the entity and the guild dockyard build: a finished `droid` build mints one idle,
// guild-source droid at the dockyard's system (sim/tick.js mintFinishedKind). Slice 3 adds the SYNDICATE
// buy (a flat tariff, sim/actions.js buyAssetFromSyndicate) and ASSIGNMENT (assignDroid / unassignDroid,
// licence-gated for a Syndicate droid, capped per venture). An assigned droid still does NOTHING to
// production — the boost, decay and maintenance are later slices.
//
// Like sim/assets.js, this file holds RULES and the mint. The row itself is built by `createDroid` in
// sim/state.js, beside the other entity constructors.

const { createDroid } = require('./state.js');
const { assetId } = require('./assets.js');

// The bill kind a dockyard queue entry carries for a droid build. Spelled ONCE, here.
const DROID = 'droid';

// The two sources (docs/droids.md §3). Source is NOT a quality tier: it will govern durability, cost,
// upkeep and where a droid may be used, never the boost. A dockyard build mints 'guild'; a Syndicate buy
// (slice 3) mints 'syndicate'.
const DROID_SOURCE_GUILD = 'guild';
const DROID_SOURCE_SYNDICATE = 'syndicate';
const DROID_SOURCES = Object.freeze([DROID_SOURCE_GUILD, DROID_SOURCE_SYNDICATE]);

// SYNDICATE_DROID_TARIFF — the FLAT credit price of one Syndicate droid (docs/phase-1-tuning.md §Droids,
// pinned at 10,000 cr for droid engine slice 3, `[FIRST-CUT]`). Market-independent ON PURPOSE: the
// Syndicate droid is "a special institutional product", not a market good (docs/droids.md §3), so it is
// NOT the parts-priced, floor-baselined path every other Syndicate buy takes (sim/asset-recipes.js
// priceAssetForPurchase reads THIS for a droid instead). An integer, like every credit amount (§15.2).
const SYNDICATE_DROID_TARIFF = 10_000;

// DROID_CAP — the most droids ONE VENTURE may hold assigned (docs/phase-1-tuning.md §Droids, `[FIRST-CUT]`
// 20; docs/droids.md §1). A 21st assign is refused. SOURCE-BLIND: guild and Syndicate droids count alike.
// The boost curve (a later slice) will read the same constant as its `CAP`, so it is spelled once, here.
const DROID_CAP = 20;

// isDroidIdle(droid) -> true when no venture holds it. Idle/deployed is DERIVED from the one stored pointer
// (invariant 5): `assignedToVentureId` is present exactly while the droid is assigned, and absent otherwise.
function isDroidIdle(droid) {
  return droid.assignedToVentureId === undefined;
}

// assignedDroidCount(guild, ventureId) -> how many of the guild's droids are assigned to that venture —
// what the cap gate and the cap invariant both count. Counts every source (the cap is source-blind).
function assignedDroidCount(guild, ventureId) {
  return (guild.droids || []).filter((d) => d.assignedToVentureId === ventureId).length;
}

// unassign(droid) -> MUTATES the droid back to idle, in the system it already sits in (a droid never moves
// on assignment — assignment is same-system). Both assignment fields go together, so a droid is never left
// half-assigned. The one place a droid is released: the unassignDroid apply and a venture's closure.
function unassign(droid) {
  delete droid.assignedToVentureId;
  delete droid.deployedAtTick;
}

// releaseDroidsFrom(guild, ventureId) -> MUTATES every droid of the guild assigned to `ventureId` back to
// idle. Called by the ONE venture-removal path (sim/licence.js applyVentureClosure — teardown, forced
// closure, eviction, the operator lever), BEFORE the venture is spliced out. Without it a closed venture
// would leave droids pointing at nothing and `checkDroids` would halt the next tick. The design derives
// "deployed" from a venture referencing the droid (docs/droids.md §1), so a gone venture makes its droids
// idle by definition — this only keeps the stored pointer in step with that, exactly as a closed venture's
// asset "returns to idle" (sim/licence.js). Returns the number released (for a test or a notice).
function releaseDroidsFrom(guild, ventureId) {
  let released = 0;
  for (const d of guild.droids || []) {
    if (d.assignedToVentureId === ventureId) {
      unassign(d);
      released += 1;
    }
  }
  return released;
}

// droidId(guildId, n) -> `asset_<guildId>_droid_NN`. The same shape as every other asset id
// (sim/assets.js assetId), so the id names its owner and its number the same way.
function droidId(guildId, n) {
  return assetId(guildId, DROID, n);
}

// nextDroidSerial(guild) -> one above the guild's stored `droidSerial` (absent/0 -> 1). The kitAssetSerial
// pattern (sim/assets.js nextKitAssetSerial): droids WILL leave the collection (spent at end of life, a
// later slice), so "the highest live number + 1" could hand out a spent droid's id again. A stored counter
// that only climbs cannot (design.md §15.4 "Ids never repeat"). A pure read — the caller bumps it.
function nextDroidSerial(guild) {
  return (guild.droidSerial || 0) + 1;
}

// mintDroid(guild, source, systemId) -> the new idle droid, having MUTATED `guild`. THE ONE droid mint
// (docs/droids.md §3: "Both sources mint one idle droid row, source-stamped, through one helper"). Bumps
// the serial FIRST, so two mints in one tick get two different numbers. Throws on a duplicate id: the
// serial only climbs, so a hit means the counter itself has been corrupted — halt rather than share an id.
function mintDroid(guild, source, systemId) {
  const serial = nextDroidSerial(guild);
  guild.droidSerial = serial;
  const id = droidId(guild.id, serial);
  if (!Array.isArray(guild.droids)) guild.droids = [];
  if (guild.droids.some((d) => d.id === id)) {
    throw new Error(`mintDroid: guild ${guild.id} minted duplicate droid id ${id} — droidSerial corrupted`);
  }
  const droid = createDroid({ id, systemId, source });
  guild.droids.push(droid);
  return droid;
}

module.exports = {
  DROID,
  DROID_SOURCE_GUILD,
  DROID_SOURCE_SYNDICATE,
  DROID_SOURCES,
  SYNDICATE_DROID_TARIFF,
  DROID_CAP,
  isDroidIdle,
  assignedDroidCount,
  unassign,
  releaseDroidsFrom,
  droidId,
  nextDroidSerial,
  mintDroid,
};
