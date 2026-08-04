'use strict';

// stock.js — the guild-stockpile accessor layer (design.md ruling B1, §15.2).
//
// Resources are SYSTEM-SCOPED: a guild's holdings are a separate pool per system
// it operates in, so `guild.stockpiles` is a NESTED map
//     systemId -> good -> int
// not one flat guild pile. Everything that reads or writes a stockpile goes
// through the accessors below, so the nested shape lives in exactly ONE file —
// change the shape here and nowhere else needs to know.
//
// Within a system, goods are pooled and instantly usable by any of that guild's
// ventures there; ACROSS systems they do NOT commingle (moving goods is a
// shipment — not modelled yet, one guild controls one system today, so this is
// currently a no-op re-key). The guild-wide total across all its systems is a
// PRICING AGGREGATE ONLY (`guildTotals`) — it feeds galactic supply (§15.4) and
// the snapshot's guild-level holdings view, and is never a pool anything draws
// from directly.

// getStock(guild, systemId, good) -> int held of `good` in that guild's
// `systemId` pool (0 if the pool or the good is absent).
function getStock(guild, systemId, good) {
  const pool = (guild.stockpiles || {})[systemId];
  return (pool && pool[good]) || 0;
}

// addStock(guild, systemId, good, delta) -> add `delta` (may be negative) to the
// (systemId, good) cell, creating the nesting as needed. Returns the new value.
// Legality of the result (integer, non-negative, known good) is enforced by
// invariants.js every tick, not here — same division of labour as credits.
function addStock(guild, systemId, good, delta) {
  if (!guild.stockpiles) guild.stockpiles = {};
  if (!guild.stockpiles[systemId]) guild.stockpiles[systemId] = {};
  const pool = guild.stockpiles[systemId];
  pool[good] = (pool[good] || 0) + delta;
  return pool[good];
}

// guildTotals(guild) -> flat { good: int } summed across ALL of the guild's
// system pools: the guild-wide PRICING AGGREGATE (ruling B1). This is what
// galactic supply sums and what the snapshot reports as a guild's holdings —
// never a pool. Goods present with a 0 total still appear (harmless).
function guildTotals(guild) {
  const totals = {};
  for (const pool of Object.values(guild.stockpiles || {})) {
    for (const [good, qty] of Object.entries(pool || {})) {
      totals[good] = (totals[good] || 0) + qty;
    }
  }
  return totals;
}

// cloneStockpiles(bySystem) -> a deep-enough copy of the nested map so a caller's
// object can never alias into engine state (state.js uses this in createGuild).
function cloneStockpiles(bySystem) {
  const out = {};
  for (const [systemId, pool] of Object.entries(bySystem || {})) {
    out[systemId] = { ...pool };
  }
  return out;
}

module.exports = { getStock, addStock, guildTotals, cloneStockpiles };
