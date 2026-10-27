'use strict';

// eviction.js — LOSING GROUND, the DESTROYED fate (design.md §2 "Losing it evicts the system"; §19 #67 and #69,
// both RULED 17-10-26; docs/territory-model.md §4 "AS-BUILT — losing ground, engine PR 1"). A guild's Prefecture is
// destroyed, the system it claimed goes FALLOW (unclaimed, re-claimable), and the guild's position there is gone:
// its ventures are torn down, its machines are left behind as STRANDED idle assets awaiting salvage, and its goods in
// that system are forfeit. Only its intel survives — what it learned of the system stays in its exploration record.
//
// ONE consequence, more than one cause. §19 #69 rules that the CAUSE picks the fate, and two causes destroy: the
// owner's voluntary abandonment, and the storyteller (§9, not built). So the consequence lives HERE, in one helper,
// and each cause calls it — today only the `abandonPrefecture` action (sim/actions.js), later the storyteller — so
// the two can never evict differently. (The other fate, CAPTURE by a hostile takeover, changes hands instead of
// going fallow; it is design-ahead with the investment arc and is not this file.)
//
// STRANDED is the one new piece of state. An asset's only location is its `systemId` (design.md §2, corrected
// 17-10-26 — there is no orbital-limbo state), so a stranded machine needs no new coordinate: it keeps its
// `systemId`, now a system its owner does NOT hold, and carries `stranded = { tick }` — the tick it was left behind,
// in the `{ ..., tick }` shape the engine's other flags use (a craft's `deployFailed` / `laneEnded`). OMITTED on
// every asset that is not stranded, so a galaxy that has evicted nothing is byte-identical to one built before this.
// The rule it keeps (`checkStrandedAssets`, sim/invariants.js): a stranded asset is idle, and sits only in a system
// NOBODY holds — the salvage window is open only while the system is uncontrolled (§19 #67).

const { applyVentureClosure } = require('./licence.js');
const { recordEvent, SYSTEM_LOST } = require('./events.js');
const { forfeitSystemPool } = require('./stock.js');
const { getSystem } = require('./seed.js');
const { carriedAssetIds } = require('./assets.js');

// The causes that DESTROY a Prefecture (§19 #69). Only the owner's abandonment is built; the storyteller's cause
// joins this list when §9 is built. An unknown cause is a caller bug, so evictSystem HALTS on one rather than write
// a notice nobody can read.
const SYSTEM_LOST_CAUSES = Object.freeze(['abandoned']);

// The cause the uprooted ventures' own `venture_closed` notices carry (docs/event-log.md §2): they were closed by
// the eviction, not torn down by hand (`teardown`), forced by the Syndicate (`forced`) or removed by an operator.
const EVICTED = 'evicted';

// isStranded(asset) -> true iff the asset was left behind by an eviction and has not been recovered since.
function isStranded(asset) {
  return !!(asset && asset.stranded);
}

// strandedAssetsIn(state, systemId) -> [ { guildId, assetId } ] — every stranded asset, of any guild, sitting in
// `systemId`, in guild then asset order (invariant 9). Read by the plant's TEMPORARY re-claim guard (sim/actions.js).
function strandedAssetsIn(state, systemId) {
  const out = [];
  for (const g of state.guilds || []) {
    for (const a of g.assets || []) {
      if (a.systemId === systemId && isStranded(a)) out.push({ guildId: g.id, assetId: a.id });
    }
  }
  return out;
}

// recoverStrandedAssets(guild, systemId) -> the ids of the guild's own stranded assets in `systemId`, having
// MUTATED each to drop its flag. Called when the guild plants a Prefecture there again (sim/actions.js plantKit):
// the system is held once more, so its machines in it are ordinary idle assets again — and a stranded asset in a
// held system is exactly what the invariant forbids. Another guild's stranded assets never reach a plant (the
// TEMPORARY guard refuses it), so this only ever clears the planter's own.
function recoverStrandedAssets(guild, systemId) {
  const recovered = [];
  for (const a of guild.assets || []) {
    if (a.systemId === systemId && isStranded(a)) {
      delete a.stranded;
      recovered.push(a.id);
    }
  }
  return recovered;
}

// byId — byte order over ASCII ids, so every list in the notice is stable (invariant 9).
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// evictSystem(state, guild, prefecture, cause, tick) -> the notice payload, having MUTATED `state` and `guild`.
// THE ONE eviction. The caller has proved the Prefecture is the guild's; `tick` is the tick the eviction happens on
// (an action apply passes `next.tick`). In the ruled order, failing loud:
//   0. THE HOME EXEMPTION (design.md §2): a guild is never evicted from the world it was founded on. Founding claims
//      without a Prefecture, so a home has none to destroy — but that is asserted here, not assumed: a Prefecture
//      in its owner's home is a corrupt state, and this HALTS on it rather than unclaim a homeworld.
//   1. UNCLAIM. The Prefecture row goes (and `state.prefectures` with it, when it was the last — omit-when-empty),
//      and so does its claim row. The claim row is what every "does G hold S?" question reads (sim/claims.js), so
//      the system is unheld from here on: `guildHolds` is false, the control map drops its footprint, and the
//      slot it stood on is free (occupancy is derived from the row). The guild's `prefectureSerial` is untouched —
//      ids are never reused (design.md §15.4).
//   2. UPROOT. Every venture the guild has in the system is closed through THE shared closure
//      (`applyVentureClosure`, sim/licence.js — the one forced closure and a player teardown use), cause `evicted`:
//      it forfeits the venture's RP, writes its node lockout when its licence has term left, and records its
//      `venture_closed` notice; its machine drops to idle. No settlement fee is charged: the fee is the closure's
//      CALLER's to charge, and forced closure charges none either. Then every asset the guild has in the system —
//      the machines just freed and any already idle there, kits included ("everything the guild holds in that
//      system", design.md §2) — is flagged `stranded = { tick }`. Each keeps its `systemId` and its condition. A
//      machine aboard a heavy (in transit, the asset ferry) is not in the system and is not stranded.
//   3. FORFEIT THE GOODS (§19 #67, candidate (a)). The guild's pool in that system is dropped whole — the system's
//      key leaves `guild.stockpiles` (sim/stock.js `forfeitSystemPool`). Goods carry no conservation ledger, so this
//      is a plain delete; Galactic Supply falls by exactly those goods once the caller refreshes its cache — the
//      market-visible drop the ruling chose. Goods aboard the guild's craft are not the pool, and are untouched.
//   4. KEEP THE INTEL. Nothing here touches `guild.exploration`: the record is independent of the claim.
//   5. ONE NOTICE. A single `system_lost` event on the guild's log (docs/event-log.md §14), its payload
//      self-contained — the Prefecture and the system are gone by the time the player reads it.
function evictSystem(state, guild, prefecture, cause, tick) {
  if (!SYSTEM_LOST_CAUSES.includes(cause)) {
    throw new Error(`evictSystem, tick ${tick}: unknown cause ${JSON.stringify(cause)} (known: ${SYSTEM_LOST_CAUSES.join(', ')})`);
  }
  const systemId = prefecture.systemId;
  if (prefecture.ownerGuildId !== guild.id) {
    throw new Error(`evictSystem, tick ${tick}: Prefecture ${JSON.stringify(prefecture.id)} belongs to guild ${JSON.stringify(prefecture.ownerGuildId)}, not ${JSON.stringify(guild.id)}`);
  }
  // 0. The home exemption.
  if (systemId === guild.homeSystemId) {
    throw new Error(`evictSystem, tick ${tick}: Prefecture ${JSON.stringify(prefecture.id)} stands in guild ${JSON.stringify(guild.id)}'s home system ${JSON.stringify(systemId)} — a home is never evicted (design.md §2), and founding claims it without a Prefecture`);
  }

  // 1. Unclaim.
  state.prefectures = state.prefectures.filter((p) => p.id !== prefecture.id);
  if (state.prefectures.length === 0) delete state.prefectures;
  state.claims = state.claims.filter((c) => c.claimId !== prefecture.claimId);

  // 2. Uproot. The ventures are picked out first, because the closure splices each from the array it would be
  //    iterating; they close in stored order, so the notices and lockouts are written deterministically.
  const ventures = (guild.ventures || []).filter((v) => v.systemId === systemId);
  for (const v of ventures) applyVentureClosure(state, guild, v, EVICTED, tick);
  //    A machine ABOARD one of the guild's heavies (the asset ferry, sim/ferry.js) keeps the systemId it was loaded
  //    from, which may be this one — but it is in the hold, not in the system, so it is not left behind.
  const aboard = carriedAssetIds(guild);
  const strandedAssetIds = [];
  for (const a of guild.assets || []) {
    if (a.systemId !== systemId || aboard.has(a.id)) continue;
    a.stranded = { tick };
    strandedAssetIds.push(a.id);
  }

  // 3. Forfeit the goods.
  const goodsForfeit = forfeitSystemPool(guild, systemId);

  // 5. One notice. (4 — the intel — is kept by touching nothing.)
  const system = getSystem(systemId);
  const payload = {
    cause,
    prefectureId: prefecture.id,
    claimId: prefecture.claimId,
    systemId,
    systemName: (system && system.name) || systemId,
    planetId: prefecture.planetId,
    slotId: prefecture.slotId,
    ventureIds: ventures.map((v) => v.id).sort(byId),
    strandedAssetIds: strandedAssetIds.sort(byId),
    goodsForfeit,
  };
  recordEvent(guild, tick, SYSTEM_LOST, payload);
  return payload;
}

module.exports = {
  SYSTEM_LOST_CAUSES, EVICTED, isStranded, strandedAssetsIn, recoverStrandedAssets, evictSystem,
};
