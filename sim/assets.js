'use strict';

const { DEPLOYABLE_KITS, kitGoodFor } = require('./resources.js');

// assets.js — the ground-asset vocabulary and the derived "who is idle?" lookup
// (design.md §4, "Asset occupancy — deploy, idle, and the build contract",
// 30-08-26). A venture is the licenced operating company; an ASSET is the
// machine it runs. There are exactly two ground-deployable kinds: a MINER on a
// resource node, a FACTORY on a settlement slot.
//
// WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY DOES NOT HOLD: an asset is in
// exactly one of three states — DEPLOYED (a live venture's `assetId` points at it),
// IN TRANSIT (a vehicle's `carryingAssetId` names it — the cross-system ferry,
// sim/ferry.js, built by losing ground engine PR 2) or IDLE (in the guild's
// inventory, referenced by nothing) — and each is DERIVED, never stored. There is no `isIdle` flag anywhere, exactly as
// occupancy.js keeps "what venture is on this site?" a lookup over ventures
// rather than a field on the site (invariant 5: the same fact must not live in
// two places, or it can drift). So this file answers the question by scanning
// the guild's own ventures, every time it is asked.
//
// It holds RULES (kinds, the starter count, the id scheme) and SELECTORS over a
// guild — plus the one DELETION, `deleteAsset`, which sits beside nextAssetNumber
// because it writes the record that function reads. It constructs nothing —
// `createAsset` lives with the other entity constructors in state.js — which is
// what keeps this file free of a require cycle with state.js.
//
// TWO SETS OF KINDS, KEPT APART ON PURPOSE (design.md §4, "The undeployed Outpost kit
// is a system-scoped idle asset", RULED 02-10-26). A guild's inventory also holds
// undeployed KITS — an idle 'outpost' is a kit waiting to be loaded onto a heavy and
// deployed in space. A kit is never run by a venture, so it is NOT in `ASSET_KINDS`
// (the venture-deployable set, what `establishVenture` and the Syndicate purchase
// accept); it has its own set, `KIT_ASSET_KINDS`, below. Keeping two lists is what
// stops a venture ever naming a kit.

// The two kinds. Lowercase, one word, matching how venture `type` is already
// spelled ('mining' / 'refining') — pinned here once so no other file spells it.
const MINER = 'miner';
const FACTORY = 'factory';
const ASSET_KINDS = [FACTORY, MINER];

// The KIT asset kinds — an undeployed kit sitting idle in a system's inventory. Read off
// the deployable-kit table (sim/resources.js `DEPLOYABLE_KITS`), so a kind is a kit asset
// exactly when it has a kit good, and adding a kind later (toll gate) is one row THERE.
// Today: ['deepScan', 'outpost'] (the Deep Scan Array kit joined 2.5 (b1) by exactly that one
// row). Sorted for a stable order (invariant 9).
const KIT_ASSET_KINDS = Object.freeze(Object.keys(DEPLOYABLE_KITS).sort());

// maintenanceCondition — DESIGN-AHEAD, INERT IN THIS SLICE (design.md §4,
// "Condition & maintenance — design-ahead, NOT built here"). Every asset carries
// it from creation; NOTHING in this slice reads it and nothing changes it — no
// decay tick, no repair, no maintenance spend, and (load-bearing) condition never
// touches production, so occupying an asset changes no game number. It is carried
// now only so the shape is stable when the maintenance slice lands, with no
// migration.
//
// REPRESENTATION (a slice-local ruling, not a tuning number): a plain FRACTION
// where 1 = new/full and 0 = a stopped-but-not-destroyed machine. "New = full" is
// an identity, not a balance number — the decay rate, the ~4x expected-life anchor
// and the repair economics are the maintenance slice's to rule, and are NOT
// invented here.
const ASSET_CONDITION_NEW = 1;
const ASSET_CONDITION_MIN = 0;

// The starter gift — `[FIRST-CUT]`, docs/phase-1-tuning.md "Starter asset gift"
// (30-08-26), design.md §4. A founding guild receives 15 Miners + 10 Factories,
// idle, in inventory: deliberately BELOW a home system's capacity so asset
// scarcity bites from turn one. Source #1 of §4's five asset sources; the other
// four (Syndicate commission, open market, self-built Tier-4, Ancients) are later
// slices. The numbers live HERE, once, and are never inlined at a call site.
const STARTER_MINERS = 15;
const STARTER_FACTORIES = 10;

// Is `kind` a VENTURE-deployable kind (miner / factory)? A kit kind is not — see above.
function isAssetKind(kind) {
  return ASSET_KINDS.includes(kind);
}

// Is `kind` a KIT asset kind (an undeployed kit, e.g. 'outpost')? Asks the same table
// `kitGoodFor` reads, so "is a kit asset" and "has a kit good" are one fact.
function isKitAssetKind(kind) {
  return kitGoodFor(kind) !== null;
}

// Which machine a venture type needs (design.md §4): a mining venture IS a miner
// on a resource node; a refining venture IS a factory on a settlement slot. Any
// other type has no asset kind yet — manufacture/construct are higher-tier
// FACTORY modes not built in the engine, so they are not guessed at here.
function assetKindForVentureType(type) {
  if (type === 'mining') return MINER;
  if (type === 'refining') return FACTORY;
  return null;
}

// The starter grant as plain SPECS ({ id, kind, systemId }), ready for createAsset.
// Kept as data rather than built entities so this file never has to require state.js.
//
// Every starter asset sits at the guild's HOME SYSTEM (design.md §4, 12-09-26): the
// founding-granted inventory is idle AT `homeSystemId`, so the caller passes it in and
// it stamps onto each spec. `systemId` is required for the same reason createAsset
// requires it — a machine with no location is the model this slice retires.
//
// The id scheme is `asset_<guildId>_<kind>_<NN>`, 1-based and zero-padded to two
// digits. STABLE and DETERMINISTIC (§15.2, invariant 9): two runs of the same
// scenario mint byte-identical ids. The padding is not decoration — it makes
// lexicographic order agree with numeric order, so "the guild's assets in id order"
// is the same list however it is sorted (a founding consumes this pool in mint
// order; a deploy now NAMES the asset it wants, sim/actions.js).
function starterAssetSpecs(guildId, systemId) {
  const specs = [];
  for (let n = 1; n <= STARTER_MINERS; n += 1) specs.push({ id: assetId(guildId, MINER, n), kind: MINER, systemId });
  for (let n = 1; n <= STARTER_FACTORIES; n += 1) specs.push({ id: assetId(guildId, FACTORY, n), kind: FACTORY, systemId });
  return specs;
}

function assetId(guildId, kind, n) {
  return `asset_${guildId}_${kind}_${String(n).padStart(2, '0')}`;
}

// assetNumberOf(id) -> the trailing numeric suffix of an id minted by `assetId` above
// (`asset_<guild>_<kind>_NN` -> the integer NN), or null when the id carries none. Reads only
// the last `_NN` group, so a guildId containing an underscore does not confuse it.
function assetNumberOf(id) {
  const m = /_(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

// nextAssetNumber(guild, kind) -> the next free per-(guild, kind) asset NUMBER: one above the
// higher of (a) the highest suffix among this guild's assets of that kind and (b) the guild's
// removed high-water for that kind (both 0 when absent, so 0 -> 1 for a guild with neither). The
// Dockyard, the Syndicate delivery and grantAsset mint from this (docs/build-yard.md §4), CONTINUING
// the per-(guild, kind) sequence above the founding grant's `01..STARTER_*` range.
//
// WHY (b): design.md §15.4 "Ids never repeat". Teardown frees an asset to idle, it does not remove it
// (sim/licence.js). But the operator levers removeAsset and removeVenture { asset: 'remove' } DO delete
// one — and so, in play, does the SWEEP (losing ground engine PR 4, sim/eviction.js), which retires a
// stranded machine from its former owner when a rival's claim takes it. Deleting the top-numbered miner
// would let the live max hand its number out again. So every deletion records the number it deletes in
// `guild.removedAssetHighWater` (deleteAsset, below), and this reads it: a number at or below it is
// never minted again. Omitted until an asset is deleted, so a guild that never lost one numbers exactly
// as before.
//
// DETERMINISTIC (invariant 9): two emissions in one tick get distinct ids because the build step
// pushes each emitted asset into `guild.assets` BEFORE minting the next, so the second read sees the
// first and returns a higher number. A KIT asset is different — loading it onto a heavy removes it —
// so kits do NOT number from this; they use `nextKitAssetSerial` below.
function nextAssetNumber(guild, kind) {
  const removed = guild.removedAssetHighWater;
  let max = (removed && removed[kind]) || 0;
  for (const a of (guild.assets || [])) {
    if (a.kind !== kind) continue;
    const n = assetNumberOf(a.id);
    if (n != null && n > max) max = n;
  }
  return max + 1;
}

// deleteAsset(guild, assetId) — THE ONE way an asset leaves a guild's inventory for good, shared by the
// operator levers (removeAsset, removeVenture { asset: 'remove' }, removeVehicle of a laden heavy —
// sim/actions.js) and the sweep (sim/eviction.js), so none of them can forget the record below.
//
// Before the row goes, a miner's or factory's NUMBER (the `NN` of `asset_<guild>_<kind>_NN`) is recorded
// in the guild's per-kind REMOVED HIGH-WATER, `guild.removedAssetHighWater = { [kind]: NN }`.
// nextAssetNumber (above) reads it, so a deleted number is never minted again — without it, deleting
// the top-numbered miner would let the next grant or build reissue that id. The mark only climbs:
// deleting a number at or below the one already recorded changes nothing, and the map is created only
// when it is first written (omit-when-absent, sim/state.js).
//
// A KIT is not recorded: kits number from `kitAssetSerial`, a stored counter that already never goes back.
// Nothing is conserved for an asset, so there is no counter-move; and like grantAsset, the tick is
// recorded in the journal (an asset carries no tick of its own). It MUTATES `guild`. (It lived in
// sim/actions.js until the sweep needed it from sim/eviction.js, which sim/actions.js requires.)
function deleteAsset(guild, assetId) {
  const asset = (guild.assets || []).find((a) => a.id === assetId);
  const n = asset ? assetNumberOf(asset.id) : null;
  const marks = guild.removedAssetHighWater || {};
  if (asset && isAssetKind(asset.kind) && n != null && n > (marks[asset.kind] || 0)) {
    guild.removedAssetHighWater = { ...marks, [asset.kind]: n };
  }
  guild.assets = (guild.assets || []).filter((a) => a.id !== assetId);
}

// nextKitAssetSerial(guild) -> the next per-guild KIT asset number: one above the guild's stored
// `kitAssetSerial` counter (absent/0 -> 1). A kit asset LEAVES the inventory when it is loaded onto a
// heavy, so "the highest live number + 1" (nextAssetNumber above) could hand a loaded kit's id to the
// next kit — and design.md §15.4 "Ids never repeat" rules that out. So kits number from a STORED
// counter that only ever climbs, the `vehicleSerial` / `outpostSerial` pattern. One counter for all of
// a guild's kit kinds, as `vehicleSerial` is one counter for all its craft classes. The CALLER bumps
// `guild.kitAssetSerial` to this value when it mints (this stays a pure read).
function nextKitAssetSerial(guild) {
  return (guild.kitAssetSerial || 0) + 1;
}

// deployedAssetIds(guild) -> Map<assetId, ventureId>. The DERIVATION everything
// else here rests on: an asset is deployed iff some venture of this guild names
// it. If two ventures somehow name the same asset, last-writer-wins in this map —
// but that is a corruption `checkAssetOccupancy` (invariants.js) catches and halts
// on; this selector reports, it does not police (the computeOccupancy discipline).
function deployedAssetIds(guild) {
  const byAsset = new Map();
  for (const v of guild.ventures || []) {
    if (v.assetId != null) byAsset.set(v.assetId, v.id);
  }
  return byAsset;
}

// carriedAssetIds(guild) -> Map<assetId, vehicleId>. The THIRD state's derivation (design.md §4,
// "State is DERIVED from what references the asset, now three states"; built by losing ground, engine
// PR 2 — the cross-system asset ferry, sim/ferry.js): an asset is IN TRANSIT iff one of the guild's
// vehicles names it in `carryingAssetId`. Like deployedAssetIds it reports and does not police — an
// asset named by two vehicles is a corruption `checkCarriedAssets` (invariants.js) catches and halts on.
function carriedAssetIds(guild) {
  const byAsset = new Map();
  for (const v of guild.vehicles || []) {
    if (v.carryingAssetId !== undefined) byAsset.set(v.carryingAssetId, v.id);
  }
  return byAsset;
}

// Every idle asset the guild owns, in stored order. Idle = owned and referenced by
// nothing: none of its owner's ventures runs it, and none of its vehicles carries it.
function idleAssets(guild, kind) {
  const deployed = deployedAssetIds(guild);
  const carried = carriedAssetIds(guild);
  return (guild.assets || []).filter((a) => !deployed.has(a.id) && !carried.has(a.id) && (kind === undefined || a.kind === kind));
}

module.exports = {
  MINER,
  FACTORY,
  ASSET_KINDS,
  KIT_ASSET_KINDS,
  ASSET_CONDITION_NEW,
  ASSET_CONDITION_MIN,
  STARTER_MINERS,
  STARTER_FACTORIES,
  isAssetKind,
  isKitAssetKind,
  assetKindForVentureType,
  starterAssetSpecs,
  assetId,
  assetNumberOf,
  nextAssetNumber,
  deleteAsset,
  nextKitAssetSerial,
  deployedAssetIds,
  carriedAssetIds,
  idleAssets,
};
