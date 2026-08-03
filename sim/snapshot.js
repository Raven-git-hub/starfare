'use strict';

// snapshot.js — a static JSON view of LIVE ENGINE STATE, for the developer's
// state inspector (client/state_inspector.html).
//
// THIS IS A DEBUG LENS, NOT PLAYER UI. design.md §7 (line ~222) hides the real
// galactic supply from players: they only ever see the Syndicate's single
// computed *value* and its history, never the true totals. Everything this file
// emits — every guild's exact stockpiles, the real fuel figures, who sits on
// which node — is god's-eye data a player must never be shown. It exists so the
// human (a visual learner) can WATCH the economy the tick loop is producing.
//
// WHY a file rather than a live query: the inspector is a client-side HTML page
// opened from file:// — it cannot call these Node selectors. So the engine emits
// a snapshot the page loads by file-picker, exactly as seed_viewer.html loads
// data/seed.json. Nothing is computed in the browser; the browser only renders.
//
// buildSnapshot(state) is PURE. It derives everything from the state's OWN
// selectors (computeGalacticSupply, computeOccupancy) plus the read-only seed
// index (getSite) — it invents no number the engine does not already hold. The
// tripwire tests/snapshot.test.js asserts the snapshot's totals equal those
// selectors, so this view can never silently drift from the engine it mirrors.
//
// This derived file is NOT part of tick determinism (invariant 9 is about tick
// STATE, not telemetry), so it is written pretty-printed for the human to read;
// the object is assembled in a fixed field order, so its bytes are stable.

const { computeGalacticSupply } = require('./supply.js');
const { computeOccupancy } = require('./occupancy.js');
const { getSite, getLandmark } = require('./seed.js');

// Bump when the shape below changes so the inspector can refuse a stale file
// loudly instead of rendering half of it. The inspector checks this.
// v2 (03-08-26): added top-level `claims` (the SHARED territory layer), so the
// debug lens can finally see Syndicate waystations + guild homes, not just
// guilds/ventures.
const SNAPSHOT_SCHEMA = 2;

// buildSnapshot(state) -> a plain, JSON-serialisable object:
//   {
//     schemaVersion, tick,
//     galacticSupply: {
//       resources: { <every raw good>: int },          // all 17 keys, zero-filled
//       fuel: { reserve, guildHeld, total },            // total = reserve+guildHeld
//     },
//     syndicate: { ledger },
//     guilds: [ { id, name, isBot, credits, fuelHoard, influence,
//                 stockpiles: { good: int } } ],
//     ventures: [ { id, ownerGuildId, type, siteId, resourceType, productionRate,
//                   site: { kind, planetId, systemId, resourceType } | null } ],
//     occupancy: { <siteId>: <ventureId> },
//     claims: [ { claimId, ownerGuildId, landmarkId, landmarkKind, claimedAtTick,
//                 contested,
//                 landmark: { kind, name?, coords?, ... } | null } ],
//   }
function buildSnapshot(state) {
  const supply = computeGalacticSupply(state);
  const occupancy = computeOccupancy(state);

  // Guild breakdown: copy the fields the inspector shows. stockpiles is spread
  // into a fresh object so a consumer mutating the snapshot can never reach back
  // into live state.
  const guilds = (state.guilds || []).map((g) => ({
    id: g.id,
    name: g.name,
    isBot: !!g.isBot,
    credits: g.credits,
    fuelHoard: g.fuelHoard,
    influence: g.influence,
    homeSystemId: g.homeSystemId || null,
    homePlanetId: g.homePlanetId || null,
    stockpiles: { ...(g.stockpiles || {}) },
  }));

  // Every venture, flattened out of its owner guild, with its seed site
  // resolved. A null `site` means unseated (no siteId) or — if a siteId is set
  // but resolves to null — a dangling reference the occupancy invariant would
  // already be halting on; the inspector renders it as UNKNOWN so the human can
  // see the breakage rather than have it hidden.
  const ventures = [];
  for (const g of state.guilds || []) {
    for (const v of g.ventures || []) {
      const site = v.siteId ? getSite(v.siteId) : null;
      ventures.push({
        id: v.id,
        ownerGuildId: v.ownerGuildId,
        type: v.type,
        siteId: v.siteId || null,
        resourceType: v.resourceType || null,
        recipeId: v.recipeId || null,
        productionRate: v.productionRate,
        site: site
          ? {
              kind: site.kind,
              planetId: site.planetId,
              systemId: site.systemId,
              resourceType: site.resourceType || null,
            }
          : null,
      });
    }
  }

  // Every territory claim, with its seed landmark resolved (as ventures resolve
  // their site). A null `landmark` means a dangling reference the claim-integrity
  // invariant would already be halting on; the lens surfaces the breakage rather
  // than hiding it. The resolved landmark carries coords, so a map view can place
  // the claim without re-loading the seed for geometry.
  const claims = (state.claims || []).map((c) => ({
    claimId: c.claimId,
    ownerGuildId: c.ownerGuildId,
    landmarkId: c.landmarkId,
    landmarkKind: c.landmarkKind,
    claimedAtTick: c.claimedAtTick,
    contested: !!c.contested,
    landmark: getLandmark(c.landmarkId, c.landmarkKind) || null,
  }));

  const reserve = supply.fuel.reserve;
  const guildHeld = supply.fuel.guildHeld;

  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    tick: state.tick,
    galacticSupply: {
      resources: { ...supply.resources },
      // reserve and guildHeld are kept separate on purpose — which one the fuel
      // PRICE reads is an open pricing-time ruling (fuel-allocation-model.md vs
      // the 02-08-26 working rule). `total` is a convenience for the inspector's
      // "how much fuel exists at all" line; it commits to nothing.
      fuel: { reserve, guildHeld, total: reserve + guildHeld },
    },
    syndicate: { ledger: state.syndicate ? state.syndicate.ledger : 0 },
    guilds,
    ventures,
    occupancy,
    claims,
  };
}

module.exports = { buildSnapshot, SNAPSHOT_SCHEMA };

// --- CLI --------------------------------------------------------------------
// `node sim/snapshot.js [outPath]` boots the same walking-skeleton scenario the
// demo narrates (zero-state -> found the player guild -> a couple of quiet
// ticks), then writes the snapshot for the inspector to load. Default output is
// the gitignored dev/state_snapshot.json (a throwaway dev artifact, never
// committed). Kept here, guarded by require.main, so importing buildSnapshot for
// tests runs none of this.
if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createZeroState } = require('./scenarios/zero-state.js');
  const { advance } = require('./run.js');
  const { createFoundGuildAction, createEstablishVentureAction } = require('./actions.js');

  // Mirrors sim/demo.js's scenario (numbers sourced from phase-1-tuning.md):
  // one Titanium mine seated on a real seed node, $120 / influence 100.
  let state = createZeroState();
  const found = createFoundGuildAction({
    guildId: 'player',
    name: 'Player Guild',
    credits: 120,
    influence: 100,
    homeSystemId: 'sys_0002',
    ventures: [
      { id: 'mine_1', ownerGuildId: 'player', type: 'mining', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 },
    ],
  });
  state = advance(state, [found]).state; // founding also runs one tick
  // A second mine, this time via the establishVenture action (the testbed's
  // "add a venture" path), on the homeworld's other titanium node.
  const secondMine = createEstablishVentureAction({
    guildId: 'player', ventureId: 'mine_2', siteId: 'pl_00004_n02', resourceType: 'titanium', productionRate: 3,
  });
  state = advance(state, [secondMine]).state;
  for (let i = 0; i < 2; i += 1) state = advance(state, []).state; // two quiet ticks

  const outArg = process.argv[2];
  const outPath = outArg
    ? path.resolve(outArg)
    : path.join(__dirname, '..', 'dev', 'state_snapshot.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(buildSnapshot(state), null, 2) + '\n');
  console.log(`snapshot written: ${outPath}`);
  console.log('open client/state_inspector.html and load that file (debug lens — not player UI)');
}
