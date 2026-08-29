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
const { PRICED_GOODS, postedPrice, basePriceFor } = require('./prices.js');
const { clonePriceHistory } = require('./price-history.js');
const { DEFAULT_WINDOW_N } = require('./windows.js');
const { dayOf, minuteOf, displayLabel } = require('./calendar.js');

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
// v7 (price engine, 26-08-26): ADDITIVE — a top-level `prices` block, the per-good
// POSTED Syndicate value (sim/prices.js), one float per non-fuel good. No schema bump:
// nothing existing changed shape, so every current reader keeps working and an older
// reader simply ignores the new key. Deliberately POSTED ONLY — the EMA memory and the
// publish pipeline (the not-yet-published values) stay off the lens, because handing
// out the future price would kill the front-running read the 2-tick lag exists to
// create. `deuterium_fuel` has no row — fuel is never listed (§8).
//   PRICE HISTORY (29-08-26) — this note used to end "no price HISTORY is emitted
//   either", on the reasoning that a ring buffer in serialized state was too much to
//   pay for a chart the client could buffer itself. That reasoning is retired: a
//   browser-side buffer starts empty on every reload and no two viewers see the same
//   curve (the same fault the production sparklines were moved into the engine to fix),
//   and a 3-month chart is not something a page visit can accumulate. So a top-level
//   `priceHistory` block IS emitted now — three coarsening rings per good
//   (sim/price-history.js), ~546 samples, which is what makes it affordable.
//   Beside it, `priceBase`: the per-good base value, for the chart's reference line.
//   Both ADDITIVE, and NO schema bump — same call as the price block above and for the
//   same reason: nothing existing changed shape, so every current reader keeps working
//   and an older reader ignores the new keys. (The v3/v4 bumps were for growth inside
//   existing rows; a new top-level key on its own is not that.) Still POSTED ONLY: the
//   rings record published values, never the pipeline's unpublished ones, so the
//   front-running read the 2-tick lag exists to create survives.
// v7 (licence Slice 3a, 26-08-26): ADDITIVE — each guild row gains `syndicateSale`, the
// record of what the Syndicate last bought from that guild (`{ tick, credited, goods:
// {good: {units, price, credited}} }`, from `guild.lastSyndicateSale`), plus
// `thisTick: bool` so a reader can tell "you earned N credits this tick" from a stale
// record without doing the comparison itself. Each venture row gains `equityPct` (the
// offered equity share `o`) beside the existing `syndicateCommitment`. No schema bump:
// nothing existing changed shape. `syndicateSale` is null for a guild that has never
// sold — the overwhelming majority today, since a commitment only exists where the dev
// scaffold set one.
// v7 (the midnight anchor + calendar, 27-08-26): ADDITIVE — a top-level `calendar`
// block beside `tick`: `{ day, minute, label, windowN, dayAnchorTick }`, the cycle clock
// derived from the plain tick (docs/cycle-and-calendar.md §5). No schema bump: nothing
// existing changed shape, and this is DERIVED telemetry — it adds nothing to serialized
// state and enters no determinism hash. `label` is "DDDD:TTTT" DISPLAY notation and is
// never parsed back by the engine. Emitted now so the console has a seam to read; the
// rendering is a later client slice, and per §5's display rule the browser computes no
// part of it.
// v7 (the per-galaxy UTC offset, 28-08-26): ADDITIVE — the `calendar` block gains
// `utcOffsetMinutes`, WHICH midnight this galaxy's cycle is anchored to (0 = UTC,
// docs/cycle-and-calendar.md §2). No schema bump: nothing existing changed shape, and
// it is the same derived-telemetry kind as the rest of the block. It is what lets a
// wall-clock display (the HUD, /inspect) show the galaxy's own local time rather than
// the viewer's or the container's.
// v7 (licence Slice 3b-ii, 27-08-26): ADDITIVE — each venture row gains
// `committedFromTick`, the first producing tick under its licence (or null), which is
// what pro-rates its first window's obligation. No schema bump; nothing changed shape.
// v7 (licence Slice 3b-i, 27-08-26): ADDITIVE — each venture row gains `licence`, the
// stored licence object (`committedOutputPct`, `windowDays`, `signedTick`, `lockedPrice`,
// `basicFee`, `discountedFee`) or null when unlicensed. No schema bump: nothing existing
// changed shape. The two fees are what was LOCKED at signing, not a live recomputation —
// they do not move when the market does, which is the point of locking them.
// v7 (licence distribution, 27-08-26): ADDITIVE — a committed good's `window` block in
// the `production` block gains `perVenture` = { [ventureId]: { commitment, delivered,
// status } }, the PER-LICENCE met/breach §5 rules is the real verdict (the good-level
// `status` beside it is now a rollup of these). Keyed by ventureId so the console's
// Syndicate roster reads one row per venture with no reshaping — `commitment` is that
// venture's target this window (`round(syndicateCommitment × windowFraction)`),
// `delivered` its share of the pile under the good's `pursue` order, `status` its
// binary verdict. In the carried `productionProfile`, a good's policy may now also
// carry the `pursue` ranking (an array of ventureIds). No schema bump: nothing existing
// changed shape and an older reader simply ignores the new keys. DERIVED telemetry —
// recomputed every read by the same resolver the tick applies, in no serialized state
// and in no determinism hash.
// v7 (console legibility pass, 28-08-26): ADDITIVE — each seated venture's `site` block
// gains `name`, the friendly place name derived in sim/seed.js ("FEN-6425 I · Node 1"),
// so the console can say WHERE a venture sits without printing `pl_00004_n01` at the
// player. Pure derived telemetry over the immutable seed, and nothing existing changed
// shape, so NO schema bump — the same call the additive `perVenture` above made. The
// `calendar.label` guard in the same pass adds no field either: it only changes the
// string the pre-game tick 0 renders as ('—' rather than the honest but meaningless
// `00-1:1439`), leaving `calendar.day`/`minute` the exact arithmetic they were.
// v7 (persistent production history, 28-08-26): ADDITIVE — each system's entry in the
// `production` block gains `history` = { [good]: { prod: [...], cons: [...] } }, the last
// HISTORY_N (60) ticks of that good's fresh output and downstream draw, echoed VERBATIM
// from the stored buffer `guild.productionHistory` (sim/history.js). This is the first
// piece of the `production` block that is NOT recomputed on read: it is serialized engine
// state surfaced as-is, which is exactly why it survives a reload and reads the same for
// every viewer — the console's two trend sparklines used to be a browser-side buffer that
// started empty on every page load. It sits beside `review` at SYSTEM level rather than
// inside `goods` because `goods` holds only the goods routed this tick, and a mined good
// with no in-system consumer has no `goods` entry yet still has a trend to draw. No schema
// bump: nothing existing changed shape and an older reader ignores the new key — the same
// call the additive `perVenture` and `site.name` made.
// v7 (licence Slice 3b-iii, 28-08-26): ADDITIVE — each guild row gains `licenceFee`, the
// record of the fee the Syndicate charged that guild at the last window boundary
// (`{ tick, thisTick, charged, ventures: { ventureId: { status, owed, basicFee,
// discountedFee } } }`, from `guild.lastLicenceFee`). No schema bump: nothing existing
// changed shape, the same additive call `syndicateSale` and `perVenture` made. Unlike the
// `production` block's live `perVenture` telemetry — recomputed on every read and gone
// the instant the window rolls — this is STORED state echoed as-is, which is exactly why
// it can still be read on the ticks AFTER the boundary that produced it. null for a guild
// that has never been charged.
const SNAPSHOT_SCHEMA = 7;

// buildSnapshot(state) -> a plain, JSON-serialisable object:
//   {
//     schemaVersion, tick,
//     galacticSupply: {
//       resources: { <every raw good>: int },          // all 17 keys, zero-filled
//       fuel: { reserve, guildHeld, total },            // total = reserve+guildHeld
//     },
//     syndicate: { ledger },
//     prices: { <every non-fuel stockpile good>: <posted value> },  // sim/prices.js
//     guilds: [ { id, name, isBot, credits, fuelHoard, influence,
//                 syndicateSale: { tick, thisTick, credited, goods } | null, // Slice 3a
//                 licenceFee: { tick, thisTick, charged, ventures } | null,   // Slice 3b-iii
//                 stockpiles: { good: int },                    // flat guild total
//                 stockpilesBySystem: { systemId: { good: int } }, // per-system
//                 productionProfile: { ... } } ],               // §5 profile, sparse as stored
//     production: [ { guildId,                                  // previewProduction(state)
//       systems: [ { systemId, mines, goods, lines, refineries,     // resolved per-system
//                    review: [ { kind, ventureId?|good? } ],         // §5 review flag (2c-i)
//                    history: { good: { prod: [int], cons: [int] } } } ] } ], // stored, sim/history.js
//       // a committed good also carries goods[good].window = { Q, windowStart, delivered,
//       // sendCarry, ticksRemaining, requiredRate, sendThisTick, pctAchieved, status,
//       // perVenture: { ventureId: { commitment, delivered, status } } }  // §5 per-licence
//     ventures: [ { id, ownerGuildId, type, siteId, systemId, resourceType,
//                   licence: { committedOutputPct, windowDays, signedTick,       // 3b-i
//                              lockedPrice, basicFee, discountedFee } | null,
//                   committedFromTick: int | null,                            // 3b-ii
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
    // What the Syndicate last BOUGHT from this guild under its commitment (Slice 3a) —
    // the credits it paid, the units it took and the posted price it paid them at, per
    // good. `thisTick` is the engine answering "is this the current tick's sale?" so the
    // console can print "you earned N credits from your commitment this tick" without
    // computing anything (§5's display rule). Deep-copied, like every other block here,
    // so a consumer mutating the snapshot can't reach back into live state. null for a
    // guild that has never sold — which is every unlicensed guild.
    syndicateSale: g.lastSyndicateSale
      ? {
          tick: g.lastSyndicateSale.tick,
          thisTick: g.lastSyndicateSale.tick === state.tick,
          credited: g.lastSyndicateSale.credited,
          goods: Object.fromEntries(
            Object.keys(g.lastSyndicateSale.goods || {}).sort()
              .map((good) => [good, { ...g.lastSyndicateSale.goods[good] }]),
          ),
        }
      : null,
    // What the Syndicate CHARGED this guild at the last window boundary (Slice 3b-iii) —
    // the guild-wide lump and, per licensed venture, its boundary verdict and what that
    // verdict cost it. `thisTick` is the engine answering "did this fire on the current
    // tick?", the same courtesy `syndicateSale` above does, so the console can say "you
    // were charged N credits this cycle" without comparing anything itself (§5's display
    // rule). This is the ONLY place the verdict survives the window roll: the moment the
    // boundary tick ends, the delivered pile resets and the met/breach that priced the fee
    // is gone. Deep-copied like every other block here; null for a guild that has never
    // been charged — which is every unlicensed guild, and every guild before its first
    // boundary under a licence.
    licenceFee: g.lastLicenceFee
      ? {
          tick: g.lastLicenceFee.tick,
          thisTick: g.lastLicenceFee.tick === state.tick,
          charged: g.lastLicenceFee.charged,
          ventures: Object.fromEntries(
            Object.keys(g.lastLicenceFee.ventures || {}).sort()
              .map((id) => [id, { ...g.lastLicenceFee.ventures[id] }]),
          ),
        }
      : null,
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
        // equityPct: the venture's offered equity share `o` (§5's equity lever, Slice
        // 3a) — the cut of its commitment-sale income it forfeits. Absent on a venture
        // that offered none, reported here as the 0 it means.
        equityPct: v.equityPct || 0,
        // licence: the venture's Syndicate Venture Licence (Slice 3b-i) — its agreed
        // terms and the two fee figures LOCKED at signing, so the console can show
        // "your fee: N (discounted from M), locked at price P" without computing a
        // thing (§5's display rule). Copied so the snapshot can't alias into engine
        // state. null for an unlicensed venture, which is most of them.
        licence: v.licence ? { ...v.licence } : null,
        // committedFromTick: the venture's FIRST PRODUCING tick under its licence
        // (Slice 3b-ii) — the term that pro-rates its first window's obligation (§5's
        // join ruling). null for an unlicensed venture, and for one committed through
        // the dev scaffold, both of which owe a full window. Surfaced so the console
        // can explain a first window that asks for less than the full commitment,
        // instead of the number appearing to be wrong.
        committedFromTick: v.committedFromTick == null ? null : v.committedFromTick,
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
              // The friendly name of the place ("FEN-6425 I · Node 1"), derived in
              // sim/seed.js from seed data alone (28-08-26). It exists so the console
              // can SAY where a venture sits instead of printing `pl_00004_n01` at the
              // player — and so the browser still derives nothing itself (§5's display
              // rule). Pure DERIVED telemetry over the immutable seed: it enters no
              // determinism hash and adds nothing to serialized state.
              name: site.name || null,
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

  // The cycle length and anchor in force, defaulted the same way every engine reader
  // defaults them, so the emitted clock matches the boundary the engine actually judges
  // on rather than a second opinion about it.
  const calN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
  const calAnchor = state.dayAnchorTick == null ? 0 : state.dayAnchorTick;
  const calOffset = state.utcOffsetMinutes == null ? 0 : state.utcOffsetMinutes;

  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    tick: state.tick,
    // The cycle clock (docs/cycle-and-calendar.md §5) — PURE DERIVED TELEMETRY, computed
    // from the plain integer tick beside it. It adds nothing to serialized state and
    // enters no determinism hash; the tick remains the only stored time value, and
    // `label`'s "DDDD:TTTT" is display notation the engine never parses back.
    //
    // Emitted so the console can stop guessing where a cycle begins and ends. Rendering
    // it is a later client slice; this is the seam it will read, and per §5's display
    // rule the browser computes no part of it. `dayAnchorTick` rides along so the client
    // can convert a tick to a real arrival time without a second source of truth.
    calendar: {
      day: dayOf(state.tick, calN, calAnchor),
      minute: minuteOf(state.tick, calN, calAnchor),
      // The DISPLAY label, blank ('—') at the pre-game tick 0 rather than the honest but
      // meaningless `00-1:0023` (28-08-26). `day`/`minute` beside it stay the exact,
      // un-clamped arithmetic — a reader doing sums gets the truth, a reader printing a
      // clock gets nothing until there is a clock to print.
      label: displayLabel(state.tick, calN, calAnchor),
      windowN: calN,
      dayAnchorTick: calAnchor,
      // WHICH midnight the anchor is lined up with (§2). 0 = UTC. A display reading a
      // wall clock (the HUD, /inspect) shifts by this so the clock a player reads and
      // the boundary the engine judges on are the same time of day; `day`/`minute`
      // above already carry it implicitly, through the anchor.
      utcOffsetMinutes: calOffset,
    },
    galacticSupply: {
      resources: { ...supply.resources },
      // reserve and guildHeld are kept separate on purpose — which one the fuel
      // PRICE reads is an open pricing-time ruling (fuel-allocation-model.md vs
      // the 02-08-26 working rule). `total` is a convenience for the inspector's
      // "how much fuel exists at all" line; it commits to nothing.
      fuel: { reserve, guildHeld, total: reserve + guildHeld },
    },
    syndicate: { ledger: state.syndicate ? state.syndicate.ledger : 0 },
    // The posted Syndicate value per non-fuel good — the number the whole economy
    // will be denominated in (docs/licence-and-price-system.md Part 1). Read through
    // the one accessor so the publish pipeline's shape stays inside sim/prices.js,
    // and walked in the module's sorted good order so the emitted bytes are stable.
    // A state built before this slice (or by hand in a test) simply has no price
    // rows; postedPrice returns null and the good is reported as such rather than
    // being given an invented number.
    prices: Object.fromEntries(PRICED_GOODS.map((good) => [good, postedPrice(state, good)])),
    // The posted-price HISTORY, verbatim from state (sim/price-history.js): per good,
    // three rings — `fine` / `medium` / `coarse` — of past posted values, oldest →
    // newest. The chart reads a good's ring for the selected scale with NO reshaping;
    // which scale button reads which ring (three rings, four buttons — `coarse` serves
    // both 1M and 3M at different windows) is recorded in docs/phase-1-tuning.md.
    //
    // ALWAYS EMITTED, even when empty — unlike the STATE field, which is omitted until
    // the first sample so a young galaxy hashes byte-identically to pre-slice. The two
    // differ on purpose: the state field answers to the determinism hash, the snapshot
    // field answers to a reader, and a stable shape is kinder to a reader than a key
    // that appears at tick 15. A good with no samples yet simply has no row, and the
    // chart shows its "gathering history…" state.
    priceHistory: clonePriceHistory(state.priceHistory),
    // The per-good BASE value — the anchor the price curve multiplies — so the chart
    // can draw its reference line without the browser typing a game number of its own
    // (design.md §5: the client computes no authoritative number). Read through
    // prices.js's one accessor: it is uniform across goods TODAY because per-good
    // bases are unruled, and this shape is what that later ruling fills in.
    priceBase: Object.fromEntries(PRICED_GOODS.map((good) => [good, basePriceFor(good)])),
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
