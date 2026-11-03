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
// licence-gated for a Syndicate droid, capped per venture). Slice 4 adds THE BOOST (`productionBoost`,
// below): a venture's WORKING droids raise its production, applied transiently by sim/production.js
// resolveProduction. Decay and maintenance are later slices.
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
// The boost curve below reads the same constant as its `CAP`, so it is spelled once, here.
const DROID_CAP = 20;

// THE BOOST CURVE (docs/droids.md §2; the numbers are docs/phase-1-tuning.md §Droids, `[FIRST-CUT]`):
//     boost(n) = BOOST_MAX × (n / CAP) ^ p
// A full complement (n = CAP) gives boost 1.0, i.e. production ×2. p slightly above 1 makes the curve
// mildly convex — the twentieth droid adds more than the first, so concentrating droids is rewarded.
const DROID_BOOST_MAX = 1.0;
const DROID_BOOST_P = 1.5;

// n can only be a whole number from 0 to CAP, so the 21 possible boosts are worked out ONCE, here, and
// production just looks one up. That keeps Math.pow out of the tick loop entirely: the same n always
// reads the same stored number, so the boost is deterministic by construction (invariant 9). n = 0 is
// written as an exact 0 — a droidless venture multiplies by exactly 1 and its bytes cannot move — and
// n = CAP is exactly BOOST_MAX (1 ^ p = 1).
const BOOST_TABLE = Object.freeze(Array.from({ length: DROID_CAP + 1 }, (_, n) => (
  n === 0 ? 0 : DROID_BOOST_MAX * Math.pow(n / DROID_CAP, DROID_BOOST_P)
)));

// productionBoost(n) -> the boost fraction for n WORKING droids on one venture (0 for none, 1.0 for a full
// complement). Production multiplies by (1 + boost). Anything but a whole number in [0, CAP] is a bug
// upstream — the cap gate and checkDroids keep a venture at or under CAP — so it throws rather than guess.
// SOURCE-BLIND: the caller counts guild and Syndicate droids alike.
function productionBoost(n) {
  if (!Number.isInteger(n) || n < 0 || n > DROID_CAP) {
    throw new Error(`productionBoost: working-droid count ${n} is not a whole number in [0, ${DROID_CAP}]`);
  }
  return BOOST_TABLE[n];
}

// isDroidWorking(droid) -> true when the droid is assigned to a venture AND still has condition left.
// Only a working droid boosts (docs/droids.md §2: "Working droids (condition > 0)"). Nothing lowers
// condition yet (decay is the next slice), so today every assigned droid is working — but reading
// `condition > 0` now means decay slots in later with no change here.
function isDroidWorking(droid) {
  return droid.assignedToVentureId !== undefined && droid.condition > 0;
}

// workingDroidCounts(guild) -> a Map of ventureId -> how many WORKING droids staff it. Ventures with
// none are simply absent. Built in one pass so production can look up every venture's count cheaply.
function workingDroidCounts(guild) {
  const counts = new Map();
  for (const d of guild.droids || []) {
    if (isDroidWorking(d)) counts.set(d.assignedToVentureId, (counts.get(d.assignedToVentureId) || 0) + 1);
  }
  return counts;
}

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

// unassign(droid, tick) -> MUTATES the droid back to idle, in the system it already sits in (a droid never
// moves on assignment — assignment is same-system). Both assignment fields go together, so a droid is never
// left half-assigned. The one place a droid is released: the unassignDroid apply and a venture's closure.
// Stamps `updatedAtTick` (§15.2: every mutation records its tick).
function unassign(droid, tick) {
  delete droid.assignedToVentureId;
  delete droid.deployedAtTick;
  droid.updatedAtTick = tick;
}

// releaseDroidsFrom(guild, ventureId) -> MUTATES every droid of the guild assigned to `ventureId` back to
// idle. Called by the ONE venture-removal path (sim/licence.js applyVentureClosure — teardown, forced
// closure, eviction, the operator lever), BEFORE the venture is spliced out. Without it a closed venture
// would leave droids pointing at nothing and `checkDroids` would halt the next tick. The design derives
// "deployed" from a venture referencing the droid (docs/droids.md §1), so a gone venture makes its droids
// idle by definition — this only keeps the stored pointer in step with that, exactly as a closed venture's
// asset "returns to idle" (sim/licence.js). Returns the number released (for a test or a notice).
function releaseDroidsFrom(guild, ventureId, tick) {
  let released = 0;
  for (const d of guild.droids || []) {
    if (d.assignedToVentureId === ventureId) {
      unassign(d, tick);
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

// mintDroid(guild, source, systemId, tick) -> the new idle droid, having MUTATED `guild`. THE ONE droid mint
// (docs/droids.md §3: "Both sources mint one idle droid row, source-stamped, through one helper"). Bumps
// the serial FIRST, so two mints in one tick get two different numbers. Throws on a duplicate id: the
// serial only climbs, so a hit means the counter itself has been corrupted — halt rather than share an id.
// The row is stamped `updatedAtTick: tick` (§15.2); a missing tick is a caller bug, so it throws.
function mintDroid(guild, source, systemId, tick) {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new Error(`mintDroid: guild ${guild.id} minted a droid without a valid tick (got ${tick}) — every mutation records its tick (§15.2)`);
  }
  const serial = nextDroidSerial(guild);
  guild.droidSerial = serial;
  const id = droidId(guild.id, serial);
  if (!Array.isArray(guild.droids)) guild.droids = [];
  if (guild.droids.some((d) => d.id === id)) {
    throw new Error(`mintDroid: guild ${guild.id} minted duplicate droid id ${id} — droidSerial corrupted`);
  }
  const droid = createDroid({ id, systemId, source, updatedAtTick: tick });
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
  DROID_BOOST_MAX,
  DROID_BOOST_P,
  productionBoost,
  isDroidWorking,
  workingDroidCounts,
  isDroidIdle,
  assignedDroidCount,
  unassign,
  releaseDroidsFrom,
  droidId,
  nextDroidSerial,
  mintDroid,
};
