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
// field defaulted (§15.4): `order` = ["syndicate","downstream","stockpile"],
// `downstreamPct` = 100 (feed downstream fully), `stockpile` = { percent, 0 }
// (keep nothing beyond overflow). A good/system with no stored entry returns the
// all-defaults policy; a partially-set entry fills only the fields it set and
// defaults the rest. The returned object is fresh (arrays/objects copied), so a
// caller mutating it can never alias into engine state.
function getGoodPolicy(guild, systemId, good) {
  const stored = (((guild.productionProfile || {})[systemId] || {}).goods || {})[good] || {};
  const stockpile = stored.stockpile || {};
  return {
    order: Array.isArray(stored.order) ? [...stored.order] : [...DEFAULT_ORDER],
    downstreamPct: stored.downstreamPct === undefined ? 100 : stored.downstreamPct,
    stockpile: {
      mode: stockpile.mode === undefined ? 'percent' : stockpile.mode,
      value: stockpile.value === undefined ? 0 : stockpile.value,
    },
  };
}

// getThrottlePct(guild, systemId, ventureId) -> the venture's Gate-3 throttle
// (% of its own full-tilt max), defaulting to 100 when absent — a venture the
// profile does not name runs at the FCFS default (§15.4).
function getThrottlePct(guild, systemId, ventureId) {
  const throttles = ((guild.productionProfile || {})[systemId] || {}).throttles || {};
  return throttles[ventureId] === undefined ? 100 : throttles[ventureId];
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
      if (policy.stockpile !== undefined) merged.stockpile = { ...policy.stockpile };
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
// the per-system entry, its goods map and each good's order array + stockpile
// object, and its throttles map.
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
          ...(policy.stockpile !== undefined ? { stockpile: { ...policy.stockpile } } : {}),
        };
      }
    }
    if (entry.throttles) copy.throttles = { ...entry.throttles };
    out[systemId] = copy;
  }
  return out;
}

module.exports = { getGoodPolicy, getThrottlePct, setEntry, cloneProfile };
