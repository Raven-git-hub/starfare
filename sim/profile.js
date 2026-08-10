'use strict';

// profile.js — the production-profile accessor layer (design.md §5, §15.4).
//
// The System Production Profile is a guild's per-SYSTEM standing policy for how
// `stepProduction` routes each good through §5's three gates. Like stockpiles
// (ruling B1, §15.2) it is SYSTEM-SCOPED, so `guild.productionProfile` is a
// NESTED map
//     systemId -> { goods: good -> <gate-1 policy>, throttles: ventureId -> int }
// not one flat guild policy. Everything that reads or writes the profile goes
// through the accessors below, so the nested shape lives in exactly ONE file —
// change the shape here and nowhere else needs to know. This is the exact
// division of labour sim/stock.js owns for the stockpile shape.
//
// The profile is SPARSE and ADVISORY (§15.4): an absent key means its default,
// and a good — or a whole system — with no entry behaves exactly as today. The
// read accessors below fill the defaults in so callers never branch on "is this
// key present." This module holds NO game-balance numbers and NO tick logic: the
// only constants here are the STRUCTURAL defaults §15.4 fixes (the fork order,
// 100, 0) — every real amount is player-supplied. It is storage plumbing only.

// The Gate-1 fork ordering default (§15.4): pay the licence, feed the factories,
// pile the rest. A permutation of exactly these three fork names. Returned as a
// FRESH array by getGoodPolicy so a caller can never mutate the shared default.
const DEFAULT_ORDER = Object.freeze(['syndicate', 'downstream', 'stockpile']);

// getGoodPolicy(guild, systemId, good) -> the good's Gate-1 policy with every
// field defaulted (§15.4): `order` = ["syndicate","downstream","stockpile"] (the
// three claimants' priority), `downstreamPct` = 100 (feed the consumers fully),
// `reserveLevel` = 0 (§5 one-pot distribution, Slice A: the quantity the Reserve
// claimant holds back at its priority slot — 0 = hold nothing). A good/system with
// no stored entry returns the all-defaults policy; a partially-set entry fills only
// the fields it set and defaults the rest. The returned object is fresh (the order
// array copied), so a caller mutating it can never alias into engine state.
//
// NOTE (Slice A, 10-08-26): this REPLACES the old `stockpile {mode,value}` fork
// amount AND the separate `reserveFloor` with the single `reserveLevel` — one
// reserve concept, a level held by its priority. A stored profile carrying the old
// keys is harmless: they are simply ignored here (absent `reserveLevel` → 0).
function getGoodPolicy(guild, systemId, good) {
  const stored = (((guild.productionProfile || {})[systemId] || {}).goods || {})[good] || {};
  return {
    order: Array.isArray(stored.order) ? [...stored.order] : [...DEFAULT_ORDER],
    downstreamPct: stored.downstreamPct === undefined ? 100 : stored.downstreamPct,
    reserveLevel: stored.reserveLevel === undefined ? 0 : stored.reserveLevel,
  };
}

// getThrottlePct(guild, systemId, ventureId) -> the venture's Gate-3 throttle
// (% of its own full-tilt max), defaulting to 100 when absent — a venture the
// profile does not name runs at the FCFS default (§15.4).
function getThrottlePct(guild, systemId, ventureId) {
  const throttles = ((guild.productionProfile || {})[systemId] || {}).throttles || {};
  return throttles[ventureId] === undefined ? 100 : throttles[ventureId];
}

// hasThrottle(guild, systemId, ventureId) -> is a throttle EXPLICITLY stored for
// that venture (as opposed to defaulting to 100)? Gate 3 needs this to pick its
// regime: if ANY consumer of a good has a throttle set, the split is proportional;
// if NONE do, it is the FCFS establishment-order default (§5). A throttle set to
// 100 is "set" and must count — which getThrottlePct alone can't tell from the
// default — so the regime choice reads presence here, not the value. Kept in this
// file so tick.js never reaches into the raw profile shape.
function hasThrottle(guild, systemId, ventureId) {
  const throttles = ((guild.productionProfile || {})[systemId] || {}).throttles || {};
  return Object.prototype.hasOwnProperty.call(throttles, ventureId);
}

// storedThrottleIds(guild, systemId) -> sorted array of ventureIds that have an
// EXPLICITLY-stored Gate-3 throttle for that system ([] when the system/profile is
// absent). The plural of hasThrottle: it enumerates the stored keys rather than
// testing one, so the review pass (§5, sim/production.js) can find throttles that
// name a since-removed venture. Sorted for determinism (invariant 9).
function storedThrottleIds(guild, systemId) {
  const throttles = ((guild.productionProfile || {})[systemId] || {}).throttles || {};
  return Object.keys(throttles).sort();
}

// storedPolicyGoods(guild, systemId) -> sorted array of goods that have an
// EXPLICITLY-stored Gate-1 `goods` policy entry for that system ([] when absent).
// The review pass uses it two ways: to flag a policy for a good no longer produced
// (stale), and to silence the unmanaged-surplus flag for a good the player HAS set
// a policy on. Reads the sparse shape here so callers never touch the raw profile.
function storedPolicyGoods(guild, systemId) {
  const goods = ((guild.productionProfile || {})[systemId] || {}).goods || {};
  return Object.keys(goods).sort();
}

// setEntry(guild, systemId, { goods?, throttles? }) -> MERGE a patch into the
// guild's profile for one system, creating the nesting as needed. Merges at the
// KEY level: each good in `goods` merges its supplied fields over that good's
// stored entry (so setting `downstreamPct` alone leaves a previously-set `order`
// intact), and each ventureId in `throttles` sets that line's throttle. This is
// the setter the setProductionProfile action applies through; well-formedness of
// the patch (§15.4's field rules) is the action's job, not this file's — same
// division of labour as sim/stock.js's addStock (this assembles, invariants judge).
function setEntry(guild, systemId, patch) {
  if (!guild.productionProfile) guild.productionProfile = {};
  if (!guild.productionProfile[systemId]) guild.productionProfile[systemId] = {};
  const entry = guild.productionProfile[systemId];

  if (patch && patch.goods) {
    if (!entry.goods) entry.goods = {};
    for (const [good, policy] of Object.entries(patch.goods)) {
      const current = entry.goods[good] || {};
      const merged = { ...current };
      if (policy.order !== undefined) merged.order = [...policy.order];
      if (policy.downstreamPct !== undefined) merged.downstreamPct = policy.downstreamPct;
      if (policy.reserveLevel !== undefined) merged.reserveLevel = policy.reserveLevel;
      entry.goods[good] = merged;
    }
  }

  if (patch && patch.throttles) {
    if (!entry.throttles) entry.throttles = {};
    for (const [ventureId, pct] of Object.entries(patch.throttles)) {
      entry.throttles[ventureId] = pct;
    }
  }

  return entry;
}

// cloneProfile(profile) -> a deep-enough copy of the nested map so a caller's
// object can never alias into engine state (state.js uses this in createGuild,
// parallel to cloneStockpiles). Copies every level the shape actually nests:
// the per-system entry, its goods map and each good's order array (reserveLevel /
// downstreamPct are scalars, copied by the spread), and its throttles map.
function cloneProfile(profile) {
  const out = {};
  for (const [systemId, entry] of Object.entries(profile || {})) {
    const copy = {};
    if (entry.goods) {
      copy.goods = {};
      for (const [good, policy] of Object.entries(entry.goods)) {
        copy.goods[good] = {
          ...policy,
          ...(policy.order !== undefined ? { order: [...policy.order] } : {}),
        };
      }
    }
    if (entry.throttles) copy.throttles = { ...entry.throttles };
    out[systemId] = copy;
  }
  return out;
}

module.exports = { getGoodPolicy, getThrottlePct, hasThrottle, storedThrottleIds, storedPolicyGoods, setEntry, cloneProfile };
