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
//
// THE EVICTION'S REACH (engine PR 3; §19 #67, SETTLED 19-10-26). A lost system reaches past the guild's own
// position there: EVERY guild's lane with a stop at it ENDS (a fallow system resets all logistics there), and the
// evicting guild's Deep Scan Arrays that hung off it go DARK (their running scans voided). Outposts are not
// touched: they stand on their own hexes, independent of the system claim, and stay reclaimable.
//
// THE SWEEP (engine PR 4; §19 #67, SETTLED 28-10-26). The salvage window closes when someone claims the fallow
// system. If the claimant is the old owner, its plant simply RECOVERS its own machines (recoverStrandedAssets). If it
// is a rival, the machines still lying there CHANGE HANDS to it (sweepStrandedAssets): re-minted under the new owner,
// with both guilds told. Either way, nothing is left stranded in a held system.
//
// THE SALVAGE WINDOW (design.md §2 / §19 #67, SETTLED 19-10-26; its rate RULED 31-10-26, phase-1-tuning.md). The
// salvage cannot wait for ever: an eviction opens ONE window per lost system, pooled over everything it stranded there,
// and FIXED at the eviction tick. It lives in `state.salvageWindows`, keyed by system, as
// `{ ownerGuildId, evictedAtTick, deadlineTick }` — omitted until the first eviction that strands something, and
// deleted again when the last window closes, so a galaxy that has evicted nothing is byte-identical to one built before
// this. A window closes one of two ways: a claim of the system (the plant calls closeSalvageWindow, right after the
// recover and the sweep), or its deadline (lapseSalvageWindows, tick step 4), which DESTROYS whatever is still stranded.

const { applyVentureClosure } = require('./licence.js');
const {
  recordEvent, SYSTEM_LOST, ASSETS_INHERITED, ASSETS_SWEPT, SALVAGE_WINDOW_LAPSED,
} = require('./events.js');
const { forfeitSystemPool } = require('./stock.js');
const { getSystem } = require('./seed.js');
const { createAsset } = require('./state.js');
const {
  carriedAssetIds, assetId, nextAssetNumber, nextKitAssetSerial, isKitAssetKind, deleteAsset,
} = require('./assets.js');
const { endLane } = require('./routes.js');
const { voidDetachedScans } = require('./deep-scan-arrays.js');

// The causes that DESTROY a Prefecture (§19 #69). Only the owner's abandonment is built; the storyteller's cause
// joins this list when §9 is built. An unknown cause is a caller bug, so evictSystem HALTS on one rather than write
// a notice nobody can read.
const SYSTEM_LOST_CAUSES = Object.freeze(['abandoned']);

// The cause the uprooted ventures' own `venture_closed` notices carry (docs/event-log.md §2): they were closed by
// the eviction, not torn down by hand (`teardown`), forced by the Syndicate (`forced`) or removed by an operator.
const EVICTED = 'evicted';

// The salvage window's RATE and CAP — `[FIRST-CUT]`, RULED 31-10-26 (phase-1-tuning.md, the salvage-window bullet).
// Not invented here: 3 days per stranded asset and an 18-day cap, at the ruled 1,440 ticks a day
// (cycle-and-calendar.md). Their one home; salvageWindowTicks below is the only reader.
const SALVAGE_WINDOW_TICKS_PER_ASSET = 4320; // 3 days × 1,440 ticks
const SALVAGE_WINDOW_CAP_TICKS = 25920;      // 18 days × 1,440 ticks — reached at 6 assets, so it bites from the 7th

// salvageWindowTicks(strandCount) -> how long a lost system's window stays open: 3 days for each asset stranded
// there, capped at 18 days. Pooled — one length for the whole system, however the assets are later salvaged.
function salvageWindowTicks(strandCount) {
  return Math.min(strandCount * SALVAGE_WINDOW_TICKS_PER_ASSET, SALVAGE_WINDOW_CAP_TICKS);
}

// closeSalvageWindow(state, systemId) — MUTATES `state`: the system's window record goes, and the map with it once it
// is empty (omit-when-empty, as `syndicateBuilds` and `prefectures` are). Called by the plant, whose claim ends the
// window early, and by the lapse below. Closing a system with no window does nothing.
function closeSalvageWindow(state, systemId) {
  if (!state.salvageWindows) return;
  delete state.salvageWindows[systemId];
  if (Object.keys(state.salvageWindows).length === 0) delete state.salvageWindows;
}

// isStranded(asset) -> true iff the asset was left behind by an eviction and has not been recovered since.
function isStranded(asset) {
  return !!(asset && asset.stranded);
}

// strandedAssetsIn(state, systemId) -> [ { guildId, assetId } ] — every stranded asset, of any guild, sitting in
// `systemId`, in guild then asset order (invariant 9). Read by the sweep below, which takes them in this order.
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
// held system is exactly what the invariant forbids. They are still the guild's own, so they keep their ids and
// nobody is told. ANOTHER guild's stranded assets there are not this function's: the sweep below takes them.
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

// --- THE SWEEP (losing ground, engine PR 4; design.md §19 #67, SETTLED 28-10-26) -------------------------------------
//
// A rival's claim of a fallow system closes the salvage window: whatever the old owner has not hauled out by then
// changes hands. The planter's own plant (sim/actions.js plantKit) calls this right after recoverStrandedAssets.

// sweptNumber(guild, kind) -> the number the planter's re-minted asset takes, from the sequence its kind already
// numbers from — so the sweep invents no third way to number an asset. A miner or factory continues the guild's
// per-kind sequence (`nextAssetNumber`, which also stays above every number the guild ever deleted); a KIT bumps the
// guild's stored kit serial, which never goes back (the `mintKitAsset` way, sim/actions.js). MUTATES `guild` for a kit.
function sweptNumber(guild, kind) {
  if (!isKitAssetKind(kind)) return nextAssetNumber(guild, kind);
  guild.kitAssetSerial = nextKitAssetSerial(guild);
  return guild.kitAssetSerial;
}

// sweepStrandedAssets(state, guild, prefecture, tick) -> the planter's new asset ids, having MUTATED `state`.
// `guild` has just planted `prefecture` in a fallow system, at `tick`, and now holds it. Every stranded asset of
// ANOTHER guild still lying in that system changes hands to the planter (§19 #67). It cannot simply be moved from one
// guild's list to the other's: its id names its owner (`asset_<guild>_<kind>_NN`), so a moved row would carry a
// rival's name and break the per-guild numbering. So each one is RE-MINTED, in guild-then-asset order (invariant 9):
//   1. read the old row's `kind` and `maintenanceCondition` — before the row goes;
//   2. retire it from its former owner through THE ONE deletion, `deleteAsset` (sim/assets.js), which also records the
//      former owner's removed high-water, so the old number is never reissued to it (design.md §15.4 — the sweep is
//      the game's first owner change, so this is the first time play needs that record). Its `assets` list goes too
//      if that was its last asset (omit-when-empty, as a load or a plant leaves it);
//   3. mint a fresh asset under the planter: a new id from the planter's own sequence (sweptNumber), the same kind,
//      in the same system (now the planter's), the SAME maintenanceCondition — the field is inert (design.md §4), so
//      "at their current condition" means the stored value rides along, nothing more — stamped `updatedAtTick` with
//      this tick (§15.2), and with NO `stranded` flag: an owned machine in a held system is an ordinary idle asset.
//      It is pushed before the next is minted, so nextAssetNumber sees it and two never collide.
// Then BOTH SIDES ARE TOLD (ruled 28-10-26): one `assets_swept` notice per former owner, in guild order, listing the
// ids it lost and naming the new holder (who holds a system is public, L0 — the scan_voided precedent); and one
// `assets_inherited` to the planter, listing its new ids — and NOT naming the former owner, since whether stranded
// machines are public is still an open question (decision checklist). A sweep that finds nothing writes nothing.
//
// What it cannot reach, by construction: a machine aboard a heavy (loadAsset cleared its flag — it is in the hold,
// not the system) or already unloaded elsewhere (not in this system). Goods were destroyed at the eviction. And the
// node lockouts the eviction wrote are galaxy-scoped and untouched, so the planter inherits spoiled ground too.
function sweepStrandedAssets(state, guild, prefecture, tick) {
  const systemId = prefecture.systemId;
  const lostBy = new Map(); // former owner's id -> the old ids it lost (insertion order = guild order)
  const inherited = [];
  for (const { guildId, assetId: oldId } of strandedAssetsIn(state, systemId)) {
    if (guildId === guild.id) continue; // the planter's own — recoverStrandedAssets has already handed them back
    const formerOwner = state.guilds.find((g) => g.id === guildId);
    const { kind, maintenanceCondition } = formerOwner.assets.find((a) => a.id === oldId);
    deleteAsset(formerOwner, oldId);
    if (formerOwner.assets.length === 0) delete formerOwner.assets;
    if (!Array.isArray(guild.assets)) guild.assets = [];
    const newId = assetId(guild.id, kind, sweptNumber(guild, kind));
    guild.assets.push(createAsset({ id: newId, kind, systemId, maintenanceCondition, updatedAtTick: tick }));
    inherited.push(newId);
    if (!lostBy.has(guildId)) lostBy.set(guildId, []);
    lostBy.get(guildId).push(oldId);
  }
  if (inherited.length === 0) return inherited;

  const system = getSystem(systemId);
  const systemName = (system && system.name) || systemId;
  for (const [guildId, oldIds] of lostBy) {
    const formerOwner = state.guilds.find((g) => g.id === guildId);
    recordEvent(formerOwner, tick, ASSETS_SWEPT, {
      systemId, systemName, sweptAssetIds: [...oldIds].sort(byId), byGuildId: guild.id, byGuildName: guild.name || guild.id,
    });
  }
  recordEvent(guild, tick, ASSETS_INHERITED, {
    systemId, systemName, prefectureId: prefecture.id, inheritedAssetIds: [...inherited].sort(byId),
  });
  return inherited;
}

// The reason a lane ended by an eviction carries (sim/routes.js LANE_END_REASONS): the system went fallow. It is not
// 'target-gone' — the system still exists — so the player is told the ground was lost.
const SYSTEM_LOST_LANE_END = 'system-lost';

// stopsAt(route, systemId) -> true iff one of the route's waypoints is anchored AT that system (a system landmark
// `{ landmarkKind: 'system', landmarkId }`), whether or not it carries an action: a waypoint is a place the craft
// goes. A leg that merely passes through the system's footprint stops nowhere in it, and a bare hex is not the
// system even where it lies inside the disk, so neither counts.
function stopsAt(route, systemId) {
  return route.waypoints.some((wp) => wp.anchor.landmarkKind === 'system' && wp.anchor.landmarkId === systemId);
}

// endLanesStoppingAt(state, systemId, tick) — MUTATES every craft whose lane it ends. EVERY guild's craft is asked,
// not only the evicted guild's (§19 #67: a fallow system resets all logistics there). Each craft with a route that
// stops at the system has its lane ended
// through THE ONE `endLane` (transport-model.md §11.6 "anchor gone — the lane ENDS"): the route is dropped, the
// craft flagged `laneEnded = { reason: 'system-lost', tick }` and stamped `updatedAtTick` (§15.2). Nothing else
// about it changes, so it is left where it stopped: an idle craft stays at its berth (a lane waiting at its last
// stop included); a craft in flight finishes the leg it is on and lands idle at its end; a craft in an Outpost's
// dock finishes its turnaround there and stays parked. Whatever it carries — goods, a kit, a machine — stays aboard:
// ending a lane drops the route, never the hold. A craft with no route (a plain dispatch) has no lane to end.
function endLanesStoppingAt(state, systemId, tick) {
  for (const g of state.guilds || []) {
    for (const craft of g.vehicles || []) {
      if (!craft.route || !stopsAt(craft.route, systemId)) continue;
      endLane(craft, SYSTEM_LOST_LANE_END, tick);
      craft.updatedAtTick = tick;
    }
  }
}

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
//      If anything was stranded, the system's SALVAGE WINDOW opens (the header above): its deadline is this tick plus
//      salvageWindowTicks(how many were stranded), counted now, machines and kits alike, and never moved after. A
//      machine aboard a heavy is not counted, since it was not stranded. Nothing stranded, no window.
//   3. FORFEIT THE GOODS (§19 #67, candidate (a)). The guild's pool in that system is dropped whole — the system's
//      key leaves `guild.stockpiles` (sim/stock.js `forfeitSystemPool`). Goods carry no conservation ledger, so this
//      is a plain delete; Galactic Supply falls by exactly those goods once the caller refreshes its cache — the
//      market-visible drop the ruling chose. Goods aboard the guild's craft are not the pool, and are untouched.
//   4. END THE LANES (engine PR 3). Every guild's lane with a stop at the system ends `system-lost`
//      (`endLanesStoppingAt` above) — the evicted guild's and its rivals' alike.
//   5. DARKEN THE ARRAYS (engine PR 3). Each of the guild's Deep Scan Arrays that is running a scan and no longer
//      touches the guild's own control — the lost system was what it hung off — has its scan voided, with a
//      `scan_voided` notice, reason 'anchor-lost' (sim/deep-scan-arrays.js `voidDetachedScans`). The array itself
//      stands. One still touching other ground the guild holds keeps its scan; an idle one has nothing to void, and
//      the queueScan gate keeps it idle while it is dark. A rival's arrays touch the rival's control, which this does
//      not change. Outposts are not touched at all: they survive the eviction, and stay reclaimable.
//   6. KEEP THE INTEL. Nothing here touches `guild.exploration`: the record is independent of the claim.
//   7. ONE NOTICE. A single `system_lost` event on the guild's log (docs/event-log.md §14), its payload
//      self-contained — the Prefecture and the system are gone by the time the player reads it. It is written last,
//      after the ventures' and the arrays' own notices, so the newest-first log shows the loss above them.
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
  if (strandedAssetIds.length > 0) {
    if (!state.salvageWindows) state.salvageWindows = {};
    state.salvageWindows[systemId] = {
      ownerGuildId: guild.id,
      evictedAtTick: tick,
      deadlineTick: tick + salvageWindowTicks(strandedAssetIds.length),
    };
  }

  // 3. Forfeit the goods.
  const goodsForfeit = forfeitSystemPool(guild, systemId);

  // 4. End the lanes — every guild's.
  endLanesStoppingAt(state, systemId, tick);

  // 5. Darken the arrays — the guild's own. Step 1 has already taken the system's control away, so attachment is
  //    asked of the ground as it now stands.
  voidDetachedScans(state, guild, tick);

  // 7. One notice. (6 — the intel — is kept by touching nothing.)
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

// --- THE LAPSE (design.md §2: "the clock lapsing → the un-salvaged machines are destroyed") ------------------------
//
// lapseSalvageWindows(state, tick) — MUTATES `state`. Tick step 4 (scheduled events, design.md §15.6) calls it with
// the tick being built. Every window whose deadline has come (`deadlineTick <= tick`) lapses, in systemId order, so
// two systems lapsing on one tick always resolve the same way (invariant 9; a plain object's key order is not used):
//   1. every asset still stranded in the system is DESTROYED, in guild-then-asset order (strandedAssetsIn), through
//      THE ONE deletion, `deleteAsset` (sim/assets.js), so a machine's number is recorded in its guild's
//      `removedAssetHighWater` and never reissued (design.md §15.4); a guild's `assets` key goes if that was its last.
//      What was salvaged before the deadline is safe: a machine loaded aboard a heavy is no longer stranded, and one
//      already unloaded is in another system. A window that is open means the system is fallow (checkSalvageWindows,
//      sim/invariants.js), so nothing here can touch a held system's assets.
//   2. each guild that lost something is told, with ONE `salvage_window_lapsed` notice (docs/event-log.md §16) naming
//      the system and the destroyed ids. In play that is only the window's owner — every claim sweeps or recovers what
//      lies in a system, so only the last guild evicted from it can have assets stranded there — but the notice goes
//      to whoever lost them, as the sweep's `assets_swept` does. If everything was salvaged, nobody is told.
//   3. the window closes.
function lapseSalvageWindows(state, tick) {
  const windows = state.salvageWindows;
  if (!windows) return;
  for (const systemId of Object.keys(windows).sort(byId)) {
    if (windows[systemId].deadlineTick > tick) continue;
    const lostBy = new Map(); // guildId -> the ids it lost (insertion order = guild order)
    for (const { guildId, assetId: id } of strandedAssetsIn(state, systemId)) {
      const owner = state.guilds.find((g) => g.id === guildId);
      deleteAsset(owner, id);
      if (owner.assets.length === 0) delete owner.assets;
      if (!lostBy.has(guildId)) lostBy.set(guildId, []);
      lostBy.get(guildId).push(id);
    }
    const system = getSystem(systemId);
    for (const [guildId, ids] of lostBy) {
      recordEvent(state.guilds.find((g) => g.id === guildId), tick, SALVAGE_WINDOW_LAPSED, {
        systemId, systemName: (system && system.name) || systemId, destroyedAssetIds: ids.sort(byId),
      });
    }
    closeSalvageWindow(state, systemId);
  }
}

module.exports = {
  SYSTEM_LOST_CAUSES, EVICTED, SYSTEM_LOST_LANE_END, SALVAGE_WINDOW_TICKS_PER_ASSET, SALVAGE_WINDOW_CAP_TICKS,
  isStranded, strandedAssetsIn, recoverStrandedAssets, sweepStrandedAssets, evictSystem,
  salvageWindowTicks, closeSalvageWindow, lapseSalvageWindows,
};
