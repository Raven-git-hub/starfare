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
const { guildTotals, cloneStockpiles } = require('./stock.js');
const { cloneProfile } = require('./profile.js');
const { previewProduction } = require('./production.js');

// Bump when the shape below changes so the inspector can refuse a stale file
// loudly instead of rendering half of it. The inspector checks this.
// v2 (03-08-26): added top-level `claims` (the SHARED territory layer), so the
// debug lens can finally see Syndicate waystations + guild homes, not just
// guilds/ventures.
// v3 (05-08-26): the read-only Production view's data support — a guild's
// per-system stockpile breakdown (`stockpilesBySystem`, ruling B1), and each
// venture's `systemId` + reserved `syndicateCommitment` placeholder. All
// ADDITIVE: existing fields (flat `stockpiles`, etc.) are untouched, so older
// readers keep working; the bump is honest bookkeeping that the shape grew.
// v4 (07-08-26): the interactive Production view's data support (slice 2b-i) —
// each guild row now carries its stored `productionProfile` (sparse, deep-cloned,
// exactly as stored so the controls can tell explicitly-set from defaulted), and
// a top-level `production` block = `previewProduction(state)` (per guild → per
// system → the resolved per-good fork split and per-line allocation, computed by
// the SAME resolver the tick uses). Still ADDITIVE: every v3 field is untouched,
// so older readers keep working; this only grows the shape. Neither field is in
// serialized state — the profile is engine-owned owned state read here, and the
// preview is derived telemetry (not part of the determinism hash).
// v5 (07-08-26): the §5 review flag (slice 2c-i) — each system's entry in the
// `production` block now carries a `review` array of issue objects (stale
// throttles, stale good-policies, unmanaged raw surplus), computed on the read
// path in `previewProduction`. Still ADDITIVE (every v4 field untouched) and still
// derived telemetry, so the move path and the determinism hash are unchanged.
// v6 (10-08-26): the §5 rate-based engine rewrite, with the "Correction — the
// recipe ratio" folded in (schema 6 was never released, so this is its shape, no
// 6->7). The `production` block's shape grew with the new resolver: each good now
// also carries `drawable`/`pool` (the stockpile drawdown folded into Gate 3), each
// consuming line carries the whole units `drawn` beside `alloc`, and each refinery
// carries `{ rate, bottleneckGood, minted, batchCarry }` in place of the old
// `batches`. Each `reserveFloor` the player has set surfaces in the carried
// `productionProfile` (it rides along in the sparse per-good policy). Serialized
// venture state gains `batchCarry` (the per-good sub-unit carries, §15.4), echoed
// on each venture row here. `rate` and the carry fractions are floats (telemetry /
// timing state); the snapshot is not part of the determinism hash, so this is honest
// bookkeeping that the shape grew — no move-path change beyond the rewrite it reflects.
// v6 (Slice A, 10-08-26): the §5 one-pot distribution reshapes the `production`
// block's per-good entry (schema 6 still unreleased, so it is redefined in place, no
// 6->7): `drawable`/`pool` are replaced by `reserve0` (start-of-step reserve), `pot`
// (reserve0 + fresh), and `reserveDelta` (this tick's net reserve change — the
// console's trend arrow); `fork.{stockpile,downstream,syndicate}` now report the
// reserve HELD / consumer DRAW / syndicate DRAW; `supplied` is the consumer draw cap.
// In the carried `productionProfile`, the per-good `stockpile {mode,value}` fork
// amount and `reserveFloor` are replaced by the single `reserveLevel`.
// v7 (Slice B-i): the §5 Syndicate WINDOWED ACCRUAL. Each committed good's entry in the
// `production` block gains a `window` sub-object = { Q, windowStart, delivered,
// sendCarry, ticksRemaining, requiredRate, sendThisTick, pctAchieved, status } — the
// per-good %-achieved / delivered / required-rate / ticks-remaining / resolved
// send-this-tick / met|breach status telemetry the client renders and computes nothing
// from (§5 display rule). Additive and present only for a good with a non-zero
// commitment (0/unlicensed today ⇒ absent), so existing readers are untouched. In the
// carried `productionProfile`, a good's policy may now carry the Syndicate send control
// `syndicate {mode,value}`. windowStart/delivered/sendCarry ARE serialized engine state
// (guild.syndicateWindows, in the determinism hash); the window telemetry here is
// DERIVED (previewProduction) and is not.
const SNAPSHOT_SCHEMA = 7;

// buildSnapshot(state) -> a plain, JSON-serialisable object:
//   {
//     schemaVersion, tick,
//     galacticSupply: {
//       resources: { <every raw good>: int },          // all 17 keys, zero-filled
//       fuel: { reserve, guildHeld, total },            // total = reserve+guildHeld
//     },
//     syndicate: { ledger },
//     guilds: [ { id, name, isBot, credits, fuelHoard, influence,
//                 stockpiles: { good: int },                    // flat guild total
//                 stockpilesBySystem: { systemId: { good: int } }, // per-system
//                 productionProfile: { ... } } ],               // §5 profile, sparse as stored
//     production: [ { guildId,                                  // previewProduction(state)
//       systems: [ { systemId, mines, goods, lines, refineries,     // resolved per-system
//                    review: [ { kind, ventureId?|good? } ] } ] } ], // §5 review flag (2c-i)
//     ventures: [ { id, ownerGuildId, type, siteId, systemId, resourceType,
//                   recipeId, productionRate, syndicateCommitment,
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
    // Guild-level holdings = the per-system pools flattened into one { good: int }
    // (ruling B1, §15.2): the guild's TOTAL across its systems, kept for existing
    // readers (guild cards, the overlay holdings line) that want one figure.
    stockpiles: guildTotals(g),
    // Per-system breakdown (ruling B1): the SAME pools, unflattened —
    // systemId -> good -> int. Added now that the Production view needs a
    // system's own holdings (the "add the field when a consumer needs it" case
    // the roadmap anticipated). A deep-enough copy so the snapshot can never
    // alias back into live state, exactly like the flat total above is a fresh
    // object. The engine owns the split; the browser only reads a system's row.
    stockpilesBySystem: cloneStockpiles(g.stockpiles || {}),
    // The guild's stored System Production Profile (§5/§15.4), deep-cloned so a
    // consumer mutating the snapshot can never alias into engine state (same
    // discipline as stockpiles). Emitted SPARSE — exactly as stored, defaults NOT
    // filled in — so the interactive controls (slice 2b-ii) can tell an
    // explicitly-set entry from a defaulted one (mirroring hasThrottle). Absent
    // keys mean their defaults; an all-default guild carries `{}`.
    productionProfile: cloneProfile(g.productionProfile || {}),
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
        // systemId: the venture's own denormalised system key (ruling B1) — the
        // pool its production moves goods in. Exposed top-level so the Production
        // view can group ventures by system without reaching into `site`. Falls
        // back to the resolved site's system if a synthetic venture lacks it.
        systemId: v.systemId || (site ? site.systemId : null),
        resourceType: v.resourceType || null,
        recipeId: v.recipeId || null,
        productionRate: v.productionRate,
        // syndicateCommitment: the reserved placeholder (§15.4, §5), 0/unlicensed
        // for every venture today. Surfaced so the view reads a real engine field
        // beside each producer/consumer and in totals, never inventing its own.
        syndicateCommitment: v.syndicateCommitment || 0,
        // batchCarry: the per-good sub-unit carries (§5 rate-based rewrite corrected
        // 10-08-26, §15.4) — { [good]: fraction in [0,1) } over every input + output.
        // Surfaced so the lens can show why a small line's whole units appear only
        // every few ticks. Copied so the snapshot can't alias into engine state;
        // defaults {} for a fresh venture.
        batchCarry: { ...(v.batchCarry || {}) },
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
    // The resolved production preview (§5, ruled 07-08-26; rate-based 10-08-26): per
    // guild → per system → this tick's fresh, the Gate-1 fork split, the drawdown
    // pool, each line's balancer split, and each refinery's rate/minted — all from
    // the SAME resolveProduction the tick applies, so figures are engine truth.
    // Derived telemetry: computed on demand, never part of serialized state.
    production: previewProduction(state),
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
    guildId: 'player-guild',
    name: 'Player Guild',
    credits: 120,
    influence: 100,
    homeSystemId: 'sys_0002',
    ventures: [
      { id: 'mine_1', ownerGuildId: 'player-guild', type: 'mining', siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5 },
    ],
  });
  state = advance(state, [found]).state; // founding also runs one tick
  // A second mine, this time via the establishVenture action (the testbed's
  // "add a venture" path), on the homeworld's other titanium node.
  const secondMine = createEstablishVentureAction({
    guildId: 'player-guild', ventureId: 'mine_2', siteId: 'pl_00004_n02', resourceType: 'titanium', productionRate: 5, // titanium's ruled rate, matching mine_1 [phase-1-tuning.md]
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
