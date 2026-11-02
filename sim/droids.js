'use strict';

// droids.js — the droid vocabulary, its id scheme, and THE ONE droid mint (roadmap 2.6, droid engine
// slice 2; docs/droids.md §1).
//
// A droid is a production buff that will attach to a VENTURE (docs/droids.md §0). It is not a ground
// asset (miner / factory), not a vehicle and not an installation kit, so it lives in its own collection,
// `guild.droids`, beside `assets` / `ventures` / `vehicles`. One row per droid, because condition will be
// per-unit once decay lands.
//
// What this slice builds is ONLY the entity and the guild dockyard build: a finished `droid` build mints
// one idle, guild-source droid at the dockyard's system (sim/tick.js mintFinishedKind). Nothing reads a
// droid yet — no assignment, no boost, no decay, no maintenance, no Syndicate buy. Those are later slices.
//
// Like sim/assets.js, this file holds RULES and the mint. The row itself is built by `createDroid` in
// sim/state.js, beside the other entity constructors.

const { createDroid } = require('./state.js');
const { assetId } = require('./assets.js');

// The bill kind a dockyard queue entry carries for a droid build. Spelled ONCE, here.
const DROID = 'droid';

// The two sources (docs/droids.md §3). Source is NOT a quality tier: it will govern durability, cost,
// upkeep and where a droid may be used, never the boost. Only 'guild' is minted in this slice; 'syndicate'
// is listed so the invariant accepts the full vocabulary the design rules, and the Syndicate-buy slice
// adds nothing here.
const DROID_SOURCE_GUILD = 'guild';
const DROID_SOURCE_SYNDICATE = 'syndicate';
const DROID_SOURCES = Object.freeze([DROID_SOURCE_GUILD, DROID_SOURCE_SYNDICATE]);

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
  droidId,
  nextDroidSerial,
  mintDroid,
};
