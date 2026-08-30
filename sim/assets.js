'use strict';

// assets.js — the ground-asset vocabulary and the derived "who is idle?" lookup
// (design.md §4, "Asset occupancy — deploy, idle, and the build contract",
// 30-08-26). A venture is the licenced operating company; an ASSET is the
// machine it runs. There are exactly two ground-deployable kinds: a MINER on a
// resource node, a FACTORY on a settlement slot.
//
// WHY THIS FILE EXISTS, AND WHAT IT DELIBERATELY DOES NOT HOLD: an asset is in
// exactly one of two states — DEPLOYED (a live venture's `assetId` points at it)
// or IDLE (in the guild's inventory, referenced by nothing) — and "idle" is
// DERIVED, never stored. There is no `isIdle` flag anywhere, exactly as
// occupancy.js keeps "what venture is on this site?" a lookup over ventures
// rather than a field on the site (invariant 5: the same fact must not live in
// two places, or it can drift). So this file answers the question by scanning
// the guild's own ventures, every time it is asked.
//
// It holds RULES (kinds, the starter count, the id scheme) and SELECTORS over a
// guild. It constructs nothing — `createAsset` lives with the other entity
// constructors in state.js — which is what keeps this file free of a require
// cycle with state.js.

// The two kinds. Lowercase, one word, matching how venture `type` is already
// spelled ('mining' / 'refining') — pinned here once so no other file spells it.
const MINER = 'miner';
const FACTORY = 'factory';
const ASSET_KINDS = [FACTORY, MINER];

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

function isAssetKind(kind) {
  return ASSET_KINDS.includes(kind);
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

// The starter grant as plain SPECS ({ id, kind }), ready for createAsset. Kept as
// data rather than built entities so this file never has to require state.js.
//
// The id scheme is `asset_<guildId>_<kind>_<NN>`, 1-based and zero-padded to two
// digits. STABLE and DETERMINISTIC (§15.2, invariant 9): two runs of the same
// scenario mint byte-identical ids. The padding is not decoration — it makes
// lexicographic order agree with numeric order, which is what lets `pickIdleAsset`
// below use a plain string comparison as its deterministic tie-break.
function starterAssetSpecs(guildId) {
  const specs = [];
  for (let n = 1; n <= STARTER_MINERS; n += 1) specs.push({ id: assetId(guildId, MINER, n), kind: MINER });
  for (let n = 1; n <= STARTER_FACTORIES; n += 1) specs.push({ id: assetId(guildId, FACTORY, n), kind: FACTORY });
  return specs;
}

function assetId(guildId, kind, n) {
  return `asset_${guildId}_${kind}_${String(n).padStart(2, '0')}`;
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

// Every idle asset the guild owns, in stored order. Idle = owned and referenced by
// none of its owner's ventures.
function idleAssets(guild, kind) {
  const deployed = deployedAssetIds(guild);
  return (guild.assets || []).filter((a) => !deployed.has(a.id) && (kind === undefined || a.kind === kind));
}

// The one asset a deploy takes: the idle asset of `kind` with the LOWEST id.
//
// The rule is arbitrary but it must be PINNED, because "whichever one" would make
// the same scenario deploy different machines on different runs and invariant 9
// would catch it as non-determinism. Lowest-id is chosen over stored-array-order
// because it survives any future reordering of the inventory. Returns undefined
// when none is free — which is deploy gate 2 failing.
function pickIdleAsset(guild, kind) {
  let best;
  for (const a of idleAssets(guild, kind)) {
    if (best === undefined || a.id < best.id) best = a;
  }
  return best;
}

module.exports = {
  MINER,
  FACTORY,
  ASSET_KINDS,
  ASSET_CONDITION_NEW,
  ASSET_CONDITION_MIN,
  STARTER_MINERS,
  STARTER_FACTORIES,
  isAssetKind,
  assetKindForVentureType,
  starterAssetSpecs,
  deployedAssetIds,
  idleAssets,
  pickIdleAsset,
};
