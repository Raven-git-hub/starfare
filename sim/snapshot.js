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
const { REFERENCE_FUEL_PRICE, routeFuelCost, fuelValue } = require('./fuel.js');
const { nearestWaystation, arrivalTickFor } = require('./transport.js');
const { grantFor, targetReserve, DEUTERIUM_INFLUX_PER_CYCLE } = require('./issuance.js');
const { heldSystemIds } = require('./claims.js');
const { guildPoints } = require('./points.js');
const { expectedReputation, issuanceModifier } = require('./meanline.js');
const { computeOccupancy } = require('./occupancy.js');
const { deployedAssetIds } = require('./assets.js');
const { getSite, getLandmark, getStarterSystems, getTerranHomeworld } = require('./seed.js');
const { guildTotals, cloneStockpiles } = require('./stock.js');
const { cloneProfile } = require('./profile.js');
const { previewProduction } = require('./production.js');
const { PRICED_GOODS, postedPrice, basePriceFor } = require('./prices.js');
const { baselineUnitsForGood, baselineOutputFor, isLicensedDeuteriumMine, isIllegalDeuteriumRefinery, producedGoodFor } = require('./baseline.js');
const { licenceFee, teardownSettlement, licenceEndTick, ventureStanding, renegotiationFee } = require('./licence.js');
const { clonePriceHistory } = require('./price-history.js');
const { getFuelPriceRing } = require('./fuel-price-history.js');
const { cloneModifierHistory } = require('./modifier-history.js');
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
// (29-08-26, the Syndicate BUY engine): top-level `shipments` — the IN-FLIGHT
// layer (design.md §6 / §15.1), one row per pending Syndicate delivery
// (`{ ownerGuildId, cargo, destinationSystemId, arrivalTick }`) plus a derived
// `ticksRemaining` so a later BUY/transport panel can say "arriving in N ticks"
// without doing arithmetic in the browser (§5's display rule). No schema bump:
// nothing existing changed shape — the same additive call `syndicateSale`,
// `perVenture` and `licenceFee` each made. The rows are STORED state echoed
// as-is; `ticksRemaining` is the one derived field and reaches no stored byte.
// (31-08-26, the licence-fee quote): top-level `feeQuote` — per priced good, the BASIC
// licence fee in integer credits a venture producing that good would be charged if it
// signed NOW, at the current posted price and the window in force. ADDITIVE, and NO
// schema bump: nothing existing changed shape, so every current reader keeps working and
// an older reader ignores the new key — the same call `prices`, `priceHistory`,
// `priceBase` and `calendar` each made (the v3/v4 bumps were for growth INSIDE existing
// rows, which this is not). It exists because the fee in CREDITS is not derivable in the
// browser: it is `FEE_RATE × the good's droidless baseline × windowN × the posted price`,
// and the client holds none of those pieces — which is why the Establish-Venture panel
// can only speak in "% of basic" today. Computed by calling the engine's own
// `licenceFee` (sim/licence.js) over `baselineUnitsForGood` (sim/baseline.js), NOT by
// re-deriving the formula here: the quote and what `applyForLicence` locks come out of
// one function, so they cannot drift. BASIC ONLY — the commitment/equity discount
// depends on the player's live slider values, which a snapshot cannot know, so publishing
// a discounted figure would be guessing the player's terms. Pure derived telemetry: it
// reads state as it stands, mutates nothing, enters no serialized byte and no
// determinism hash.
// (31-08-26, fuel Slice 1): each guild row gains `fuelHoardValue` — the guild's
// `fuelHoard` marked to market in integer credits at the `[FIRST-CUT]` flat rate
// `FLAT_FUEL_PRICE_PER_UNIT` (sim/fuel.js). ADDITIVE, and NO schema bump: nothing
// existing changed shape — `fuelHoard` itself is untouched and merely stops being
// zero now that founding seeds a starter hoard — so every current reader keeps
// working and an older reader ignores the new key. The same additive call
// `syndicateSale`, `perVenture`, `licenceFee`, `shipments` and `feeQuote` each
// made; the v3/v4 bumps were for growth INSIDE existing rows, which this is not.
// It exists because fuel has NO posted price (design.md §8) — there is no
// `prices.deuterium_fuel` row for a client to look the rate up in — so a browser
// that wanted the hoard in credits could only invent the rate. The engine owns it.
// (31-08-26, fuel Slice 2): each guild row gains `fuelCost` — per system the guild
// HOLDS, the fuel a Syndicate trade to that system burns and what that fuel is worth
// (`{ fuelBurn, creditCost }`), from `routeFuelCost` (sim/fuel.js) at the `[FIRST-CUT]`
// `SYNDICATE_HAULER_BURN_RATE`. ADDITIVE, and NO schema bump: nothing existing changed
// shape, so every current reader keeps working and an older reader ignores the new key —
// the same additive call `fuelHoardValue`, `feeQuote`, `shipments`, `licenceFee`,
// `syndicateSale` and `perVenture` each made. It exists because the burn is
// `distance x rate` over seed geometry the browser does not hold, and the client must be
// able to say what a trade costs BEFORE the player commits to it (§5's display rule).
// Held systems only, because a delivery goes only to a system you hold (§6); keys arrive
// sorted from `heldSystemIds` (invariant 9). Pure derived telemetry: no serialized byte,
// no determinism hash, and nothing is deducted — that is Slice 3.
// (03-09-26, fuel route travel time): each `fuelCost` entry gains `travelTicks` — the
// route's travel DURATION in ticks, `arrivalTickFor(0, distance)` = `ceil(distance ×
// CRAFT_SPEED)` over the SAME `systemId → nearest waystation` route `fuelBurn` uses
// (transport-model.md §8.0). ADDITIVE, and NO schema bump: nothing existing changed shape,
// so every current reader keeps working and an older one ignores the new key — the same
// additive-growth-INSIDE-a-row this file makes without a bump. It exists because the BUY
// transaction popup (a later client slice) must quote an ARRIVAL time before the player
// commits, and travel time is `distance × CRAFT_SPEED` over seed geometry the browser does
// not hold — the same reason `fuelBurn` and `creditCost` are published beside it. Computed
// through the engine's own `nearestWaystation`/`arrivalTickFor` (sim/transport.js), never
// re-derived here, so the quote flies on the geometry the delivery is timed on (§8's one
// geometry). Published as the DURATION, never an absolute arrival tick — the client adds it
// to the current tick — and `0` for a system with no reachable waystation, matching the 0
// `fuelBurn` reports there. Pure derived telemetry, exactly as the `fuelBurn`/`creditCost`
// beside it: no serialized byte, no determinism hash, nothing charged.
// (31-08-26, RP slice 1): each guild row gains `guildReputation` and each venture row
// gains `reputation` — the guild's Reputation Points and the per-venture running total
// they are the sum of (docs/points-and-reputation.md §2 / §6 step 1). ADDITIVE, and NO
// schema bump: nothing existing changed shape, so every current reader keeps working and
// an older reader ignores the new keys — the same additive call `fuelCost`,
// `fuelHoardValue`, `feeQuote`, `shipments`, `licenceFee`, `syndicateSale` and
// `perVenture` each made; the v3/v4 bumps were for growth INSIDE existing rows, which
// this is not. Both are STORED state ECHOED, not derived: the tick moves them at the
// window boundary from the licence's own met/breach verdict, and this file re-sums
// nothing (§5's display rule, and §15.2's one-source-of-truth). They are reported as
// their 0 when absent, like `equityPct` and `syndicateCommitment`. The band, the taper
// and the fuel mean line that will READ these are all later slices; nothing here clamps.
// (31-08-26, GP slice 3): each guild row gains `guildPoints` — the guild's Guild Points,
// `W_SYS × held systems + Σ ventures W_TIER(tier)` (docs/points-and-reputation.md §1.0),
// from the engine's own `guildPoints` (sim/points.js). ADDITIVE, and NO schema bump:
// nothing existing changed shape, so every current reader keeps working and an older one
// ignores the new key — the same additive call `guildReputation`, `fuelCost`,
// `fuelHoardValue`, `feeQuote`, `shipments`, `licenceFee` and `syndicateSale` each made.
// Unlike `guildReputation` it is DERIVED, not echoed: there is no stored counterpart and
// deliberately none (§1.0 rules GP a helper recomputed on read, like `heldSystemIds`), so
// it enters no serialized byte and no determinism hash and the state goldens cannot move
// on its account. Published with no consumer yet — the mean line is the next slice.
// (31-08-26, mean-line slice 4): each guild row gains `expectedReputation` and
// `issuanceModifier` — the RP expected for the guild's Points, and its actual RP judged
// against that (docs/points-and-reputation.md §3), from the engine's own helpers
// (sim/meanline.js). ADDITIVE, and NO schema bump: nothing existing changed shape — the
// same additive call `guildPoints`, `guildReputation`, `fuelCost`, `fuelHoardValue`,
// `feeQuote`, `shipments`, `licenceFee` and `syndicateSale` each made. DERIVED like
// `guildPoints`: no stored counterpart, no serialized byte, no determinism hash. The
// modifier is the one FLOAT in this block and is unrounded on purpose. Published with no
// consumer: no fuel is granted anywhere in the engine, because `baseGrant` is the pool
// slice (§8) and is not built.
// (31-08-26, fuel slice 5a): each guild row gains `fuelGrant` — what the Syndicate granted
// it at the last cycle boundary, and what it was due (docs/fuel-supply-and-allocation.md
// §2.1). ADDITIVE, and NO schema bump: nothing existing changed shape — the same additive
// call `issuanceModifier`, `guildPoints`, `guildReputation`, `fuelCost`, `fuelHoardValue`,
// `feeQuote`, `shipments`, `licenceFee` and `syndicateSale` each made. It is a RECORD OF
// AN EVENT echoed as stored, like `licenceFee`, because a grant is true of one boundary
// only. THE POOL GAINED NO FIELD, deliberately: it is already published as
// `galacticSupply.fuel.reserve` and has been since the walking skeleton — what changed in
// this slice is that the number finally MOVES.
// (31-08-26, the founding endowment A′): each guild row gains `foundingEndowment` — how
// much of `guildReputation` was granted at founding rather than earned
// (docs/points-and-reputation.md §2.5). ADDITIVE, and NO schema bump: nothing existing
// changed shape, so every current reader keeps working — the same additive call
// `fuelGrant`, `issuanceModifier`, `guildPoints` and the rest each made. Echoed as stored;
// the mean line and the modifier are untouched, because they already read the TOTAL, which
// now simply carries the endowment inside it.
// (01-09-26, fuel price mediation — slice 5b-i): `galacticSupply.fuel` gains `fuelPrice`,
// the galaxy's ONE market price of `deuterium_fuel` (docs/fuel-supply-and-allocation.md
// §4.2), echoed off `state.reserve.fuelPrice`. ADDITIVE, and NO schema bump: nothing
// existing changed shape — the same additive call `foundingEndowment`, `fuelGrant`,
// `issuanceModifier` and the rest each made. TWO EXISTING FIELDS CHANGED WHAT THEY READ
// WITHOUT CHANGING SHAPE OR VALUE: `guilds[].fuelHoardValue` and each `fuelCost` row's
// `creditCost` now mark against that price instead of the retired flat constant — the
// same numbers today, because the price is seeded AT the constant's value, and moving
// together the moment 5b-ii moves the price.
// (01-09-26, the fuel price CONTROLLER — slice 5b-ii): `galacticSupply.fuel` gains
// `avgDraw` and `targetReserve` — the trailing demand average the controller steers against
// and the demand-relative level it is steering the pool TO (§4.2). ADDITIVE, and NO schema
// bump; the same additive call `fuelPrice`, `foundingEndowment` and the rest each made.
// `avgDraw` is ECHOED off state; `targetReserve` is DERIVED on read through the engine's own
// `targetReserve` (sim/issuance.js), so a reader never multiplies by `TARGET_CYCLES` itself
// and there is one definition of the target (invariant 5). Together with `fuelPrice` and
// `reserve` these are the four numbers that explain any grant in the galaxy — which is what
// lets the economy recorder show the controller working while importing nothing but the
// snapshot.
// (02-09-26, the Guild Hall engine fields — docs/guild-hall.md §4, slices A/B/C): the
// three additive fields the Standing panel wires up. ADDITIVE, and NO schema bump: nothing
// existing changed shape, so every current reader keeps working and an older one ignores
// the new keys — the same additive call `fuelGrant`, `foundingEndowment` and the rest each
// made.
//   - each guild row gains `fuelHoardAtCycleStart` (Slice A) — the hoard at the last cycle
//     boundary, post-grant, before this cycle's usage — and its marked value
//     `fuelHoardAtCycleStartValue = fuelValue(…, reserve.fuelPrice)`, exactly parallel to
//     `fuelHoardValue`. ECHOED off stored state; the pair is the stockpile bar's max and
//     the datum its used-this-cycle gap is measured from. null (both) for a guild that has
//     never been due a grant — every holdings-less guild, and every guild before its first
//     boundary — because the field is stamped only there (§4 A's sparsity).
//   - each guild's `fuelGrant` gains `modifier` (Slice B) — the issuance modifier that DROVE
//     that boundary's grant, ECHOED off `lastFuelGrant.modifier`. It is the panel's CURRENT
//     gauge; the live `issuanceModifier` already in the row is its PREDICTED. A FLOAT and
//     unrounded, like `issuanceModifier` beside it.
//   - each guild row gains `modifierHistory` (Slice C) — the rolling per-guild series of the
//     modifier, one sample per cycle (sim/modifier-history.js), for the Performance line.
//     ECHOED VERBATIM from the stored ring. ALWAYS EMITTED, even empty (a stable [] for a
//     guild with none), the same courtesy `priceHistory` extends a reader — unlike the STATE
//     field, which is omitted until the first sample so a young galaxy hashes byte-identically
//     to pre-slice.
// (06-09-26, the expected-fuel-change gauge — docs/guild-hall.md §2.1): the Standing panel's
// THIRD gauge (a fuel-credit change ratio beside Current/Predicted). ADDITIVE, and NO schema
// bump: nothing existing changed shape, so every current reader keeps working and an older one
// ignores the new keys — the same additive call the Guild Hall A/B/C fields above each made.
//   - each guild row gains `predictedGrant` — the guild's LIVE fuel-credit entitlement
//     (`grantFor` = `round(BASE_GRANT_PER_GP × GP × modifier)` where it stands now, in credits
//     at the reference price). DERIVED like `guildPoints`/`issuanceModifier`: no stored
//     counterpart, no serialized byte, no determinism hash. It is the NUMERATOR of the gauge's
//     ratio.
//   - each guild's `fuelGrant` gains `entitlement` — THIS cycle's stamped entitlement, ECHOED
//     off `lastFuelGrant.entitlement`. It is the DENOMINATOR. The client divides the two
//     (`predictedGrant ÷ fuelGrant.entitlement`) for the change ratio — the sanctioned
//     two-field derive, like the RP donut's subtraction. Unlike `predictedGrant` this rides a
//     serialized record, so it appears only after a guild's first boundary (null before).
// (06-09-26, the Fuel Δ founding baseline — docs/guild-hall.md §2): each guild row gains
// `foundingEntitlement` — the guild's fuel-credit entitlement at founding (`grantFor` captured
// in the `foundGuild` apply), ECHOED off stored state like `foundingEndowment`. It is the Fuel Δ
// gauge's DENOMINATOR before the first boundary stamps `fuelGrant.entitlement`, so the gauge
// reads live (opening ×1.00) from tick 0 instead of `—`. ADDITIVE, NO schema bump. null for a
// guild not founded through `foundGuild` and for a zero-GP founding — the client falls through
// to today's behaviour on a null.
// (07-09-26, the DEUTERIUM tab's engine data — docs/guild-hall.md §4.2): the two remaining feeds
// the tab needs. ADDITIVE, and NO schema bump: nothing existing changed shape, so every current
// reader keeps working and an older one ignores the new keys.
//   - a top-level `fuelPriceHistory` — the galaxy-wide fuel-price trend, the ring of the last ≤12
//     COMPLETED 6-hour averages, oldest → newest (12 = 3 days), for the tab's price graph
//     (sim/fuel-price-history.js). A plain array, ALWAYS EMITTED (a stable [] before the first
//     bucket closes), the same courtesy `priceHistory` extends. The partial current-bucket
//     accumulator is NOT published — the live tip is `galacticSupply.fuel.fuelPrice`.
//   - each guild row gains `deuteriumProduction: { legalPerCycle, contrabandPerCycle }` — the
//     tab's Production readout, the guild's deuterium output per cycle in fuel-quantity units
//     (Σ licensed-mine / illegal-refinery `productionRate` × the cycle length). DERIVED, a
//     projection (rate × cycle, deliberately raw-unlimited), no stored byte, no determinism hash.
// (07-09-26, venture teardown — docs/venture-teardown.md §7): two additive fields for the
// coming decommission client. ADDITIVE, and NO schema bump: nothing existing changed shape, so
// every current reader keeps working and an older one ignores the new keys — the same additive
// call the DEUTERIUM tab feeds and all the rows above each made.
//   - a top-level `nodeLockouts` — the sites barred from re-establishment after a licensed
//     teardown, `[ { siteId, releaseTick, lockedAtTick, ticksRemaining } ]`, ECHOED off
//     `state.nodeLockouts` with the one derived `ticksRemaining` (like a shipment's). ALWAYS
//     EMITTED as an array (a stable [] when none), the same courtesy `shipments` extends —
//     unlike the STATE field, which is omitted-when-empty for the determinism hash.
//   - each venture row gains `teardownSettlement: { settlementFee, lockoutUntilTick, rpForfeit }`
//     — what closing it would cost right now, from the engine's own `teardownSettlement`
//     (sim/licence.js), the SAME helper the decommission apply charges, so the previewed cost
//     and the charged cost are one number by construction (§7). DERIVED on read: no stored byte,
//     no determinism hash.
// (08-09-26, the Venture Management popup — docs/venture-management.md §7): two additive per-venture
// fields the popup reads. ADDITIVE, and NO schema bump: nothing existing changed shape, so every
// current reader keeps working and an older one ignores the new keys — the same additive call the
// teardown fields above and all the rows before them each made. Both DERIVED on read: no serialized
// byte, no determinism hash, so no state golden moves on their account.
//   - each venture row gains `contractWindow: { endTick, endCycle, cyclesRemaining, expired }` — the
//     licence's committed window expressed in CYCLES, or null for an unlicensed venture and the
//     windowless deuterium-licensed mine. `endTick` is the SAME value teardownSettlement's
//     `lockoutUntilTick` uses (both through `licenceEndTick`, sim/licence.js), and `cyclesRemaining`
//     the SAME remaining-cycles the §3.2 settlement fee is priced on, so the panel's window and the
//     charged settlement cannot disagree.
//   - each venture row gains `equityPerCycle` — the investor (equity) payout PROJECTION for one
//     cycle in integer credits, `round(committedOutputPct × productionRate × windowN × equityPct ×
//     postedPrice(good))`, the `o`-share of the commitment sale at the current price. A projection
//     (rate × cycle, raw-unlimited) like `deuteriumProduction`; 0 when unlicensed, no equity, or
//     deuterium (no posted price). The engine decides it so the browser renders it (§5).
// (08-09-26, licence renegotiation #64 Slice 1 — docs/renegotiation.md, design.md §5): two additive
// per-venture fields, present ONLY on a licensed non-deuterium venture (SPREAD in, so an unlicensed
// venture and a deuterium mine carry NEITHER key). ADDITIVE, NO schema bump — nothing existing
// changed shape. Both DERIVED on read: no serialized byte, no determinism hash, so no state golden
// moves, and they invent no number (the four `[FIRST-CUT]` renegotiation constants live in
// sim/licence.js, sourced from phase-1-tuning.md). See renegotiationFieldsFor.
//   - each licensed non-deuterium venture row gains `standing` — its `ventureStanding` band
//     ('atRisk' | 'subPar' | 'steady' | 'strong'), a read of `venture.reputation`, present always.
//   - and `renegotiationOffer` — the terms the player would accept, present (non-null) only once the
//     committed window has elapsed (reusing `contractWindow.expired`): the new `committedOutputPct`,
//     the re-locked `basicFee`/`discountedFee` at the CURRENT posted price (Strong-band discount
//     applied if strong), and a `feeDiscountApplied` flag — from the SAME `renegotiationFee` the
//     `renegotiateLicence` apply locks (sim/licence.js), so the offer shown and the terms taken
//     cannot disagree. null before the window elapses.
const SNAPSHOT_SCHEMA = 7;

// contractWindowForVenture(state, venture) -> the venture's licence window in CYCLES, or null.
// The Venture Management popup's contract-window ledger (docs/venture-management.md). A cycle is
// a day is `windowN` ticks (sim/windows.js), so this speaks in cycles where teardownSettlement
// speaks in ticks — the two share ONLY the end-of-term tick, through `licenceEndTick`, so they
// cannot disagree about when the window ends.
//
//   null  for an unlicensed venture and for a deuterium-LICENSED mine (windowless, §1.4) — both
//         carry no ordinary `licence`, so there is no window to price.
//   else  { endTick, endCycle, cyclesRemaining, expired } where:
//     endTick         = licenceEndTick(licence, windowN)  — the SAME tick teardownSettlement's
//                       `lockoutUntilTick` uses when the term still has cycles left.
//     endCycle        = floor(endTick / windowN)          — the calendar cycle the term ends on.
//     cyclesRemaining = max(0, windowDays − floor((tick − signedTick)/windowN)) — the same
//                       remaining-cycles arithmetic the §3.2 settlement fee is priced on, so the
//                       count the panel shows and the cycles the fee charges for are one number.
//     expired         = cyclesRemaining === 0             — past the term, the licence rolls (§5).
//
// Pure derived telemetry: reads state as it stands, mutates nothing, enters no serialized byte
// and no determinism hash. Invents NO number — every term (`windowDays`, `signedTick`, `windowN`)
// is already ruled and stored.
function contractWindowForVenture(state, venture) {
  const lic = venture && venture.licence;
  if (!lic) return null;
  const windowN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
  const endTick = licenceEndTick(lic, windowN);
  const elapsedCycles = Math.floor((state.tick - lic.signedTick) / windowN);
  const cyclesRemaining = Math.max(0, lic.windowDays - elapsedCycles);
  return {
    endTick,
    endCycle: Math.floor(endTick / windowN),
    cyclesRemaining,
    expired: cyclesRemaining === 0,
  };
}

// equityPerCycleForVenture(state, venture) -> the investor (equity) payout PROJECTION for one
// cycle, in INTEGER credits (§15.2) — the `o`-share of the commitment sale at the CURRENT posted
// price (docs/venture-management.md). It is the ENGINE deciding the number so the client renders
// it (§5), rather than the browser multiplying five fields:
//
//   round( committedOutputPct × productionRate × windowN × equityPct × postedPrice(good) )
//
// Deliberately a PROJECTION (rate × cycle, raw-unlimited, like `deuteriumProduction` beside it) —
// what the equity share would be worth over a cycle at the current price, NOT a realised payout
// (there is no investor market yet; the `o` share still routes to the Syndicate ledger). 0 when
// unlicensed (no `licence`, hence no committedOutputPct), no equity offered, or the good has no
// posted price (deuterium/fuel, §8). Pure derived telemetry: no serialized byte, no hash.
function equityPerCycleForVenture(state, venture) {
  const lic = venture && venture.licence;
  const equityPct = (venture && venture.equityPct) || 0;
  if (!lic || equityPct <= 0) return 0;
  const price = postedPrice(state, producedGoodFor(venture));
  if (!price) return 0;
  const windowN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
  return Math.round(lic.committedOutputPct * venture.productionRate * windowN * equityPct * price);
}

// renegotiationFieldsFor(state, venture) -> the licence-renegotiation read model for one
// venture (design.md §5 "Licence renegotiation — the terms function & venture standing";
// #64 Slice 1). Returns an object to SPREAD into the venture row, so a venture that owns
// neither field gets NEITHER key:
//
//   {}                                — unlicensed, and the windowless deuterium-licensed
//                                       mine: both carry no ordinary `licence`, so there is
//                                       no standing or offer (a deuterium mine carries
//                                       neither field, as §1.4 requires).
//   { standing, renegotiationOffer }  — a licensed, non-deuterium venture:
//       standing            — its `ventureStanding` band, ALWAYS (just a read of RP).
//       renegotiationOffer  — the terms the player would accept, ONLY once the committed
//                             window has elapsed (reusing `contractWindow.expired`): the
//                             new `committedOutputPct`, the re-locked `basicFee`/
//                             `discountedFee` at the CURRENT posted price (Strong-band
//                             discount applied if strong), and a `feeDiscountApplied` flag.
//                             null before the window elapses.
//
// This is the seam the client RENEGOTIATE button reads (client half, next slice). It is
// the SAME `renegotiationFee` the `renegotiateLicence` apply locks, so the offer shown and
// the terms taken cannot disagree. Pure DERIVED telemetry: reads state as it stands,
// mutates nothing, enters no serialized byte and no determinism hash; invents no number.
function renegotiationFieldsFor(state, venture) {
  const lic = venture && venture.licence;
  if (!lic) return {};   // unlicensed, or the windowless deuterium mine — neither field
  const standing = ventureStanding(venture);
  const cw = contractWindowForVenture(state, venture);
  let renegotiationOffer = null;
  if (cw && cw.expired) {
    const baseline = baselineOutputFor(venture);
    const lockedPrice = baseline && postedPrice(state, baseline.good);
    // A licensed non-deuterium venture always has both (its good was priced at signing);
    // guard anyway so a preview is never computed against a missing baseline or price.
    if (baseline && baseline.units > 0 && lockedPrice != null) {
      const windowN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;
      renegotiationOffer = renegotiationFee({
        venture,
        baselineUnitsPerTick: baseline.units,
        windowN,
        lockedPrice,
      });
    }
  }
  return { standing, renegotiationOffer };
}

// buildSnapshot(state) -> a plain, JSON-serialisable object:
//   {
//     schemaVersion, tick,
//     galacticSupply: {
//       resources: { <every raw good>: int },          // all 17 keys, zero-filled
//       fuel: { reserve, guildHeld, total,             // total = reserve+guildHeld
//               fuelPrice,                             // the ONE market price
//               avgDraw, targetReserve },              // the controller's demand signal
//                                                      //   and the level it steers to
//     },
//     syndicate: { ledger },
//     prices: { <every non-fuel stockpile good>: <posted value> },  // sim/prices.js
//     fuelPriceHistory: [ <6h avg>, ... ],   // galaxy-wide fuel-price trend, ≤12, []-safe
//     feeQuote: { <priced good with a baseline>: <basic licence fee, int credits> },
//       // what a licence signed NOW would cost, per good — sim/licence.js's own licenceFee
//     guilds: [ { id, name, isBot, credits, fuelHoard, fuelHoardValue,
//                 fuelHoardAtCycleStart, fuelHoardAtCycleStartValue,  // Guild Hall A | null
//                 deuterium, deuteriumFuel, deuteriumFuelValue,       // §1.4 stores (1a/1b)
//                 deuteriumProduction: { legalPerCycle, contrabandPerCycle }, // §4.2, units/cycle
//                 modifierHistory: [ <modifier>, ... ],               // Guild Hall C, []-safe
//                 influence,
//                 guildReputation,                    // RP, Σ ventures' + endowment
//                 foundingEndowment,                  // of which granted at founding
//                 foundingEntitlement,     // fuel-credit entitlement at founding | null
//                 guildPoints,                                  // GP, DERIVED per read
//                 expectedReputation, issuanceModifier,        // the mean line, DERIVED
//                 predictedGrant,                    // live fuel-credit entitlement, DERIVED
//                 fuelGrant: { tick, thisTick, granted, desired, rationed, modifier,
//                              entitlement } | null,           // entitlement: this cycle's, echoed
//                 fuelCost: { systemId: { fuelBurn, creditCost, travelTicks } }, // held systems, sorted
//                 syndicateSale: { tick, thisTick, credited, goods } | null, // Slice 3a
//                 licenceFee: { tick, thisTick, charged, ventures } | null,   // Slice 3b-iii
//                 stockpiles: { good: int },                    // flat guild total
//                 stockpilesBySystem: { systemId: { good: int } }, // per-system
//                 assets: [ { id, kind, maintenanceCondition,      // §4 inventory
//                             deployedToVentureId: id | null } ],  //   null = IDLE
//                 productionProfile: { ... } } ],               // §5 profile, sparse as stored
//     production: [ { guildId,                                  // previewProduction(state)
//       systems: [ { systemId, mines, goods, lines, refineries,     // resolved per-system
//                    review: [ { kind, ventureId?|good? } ],         // §5 review flag (2c-i)
//                    history: { good: { prod: [int], cons: [int] } } } ] } ], // stored, sim/history.js
//       // a committed good also carries goods[good].window = { Q, windowStart, delivered,
//       // sendCarry, ticksRemaining, requiredRate, sendThisTick, pctAchieved, status,
//       // perVenture: { ventureId: { commitment, delivered, status } } }  // §5 per-licence
//     ventures: [ { id, ownerGuildId, type, siteId, systemId, assetId, resourceType,
//                   reputation,                              // RP running total, signed
//                   licence: { committedOutputPct, windowDays, signedTick,       // 3b-i
//                              lockedPrice, basicFee, discountedFee } | null,
//                   committedFromTick: int | null,                            // 3b-ii
//                   deuteriumLicence: { signedTick } | null,   // §1.4 licensed mine marker
//                   deuteriumRefinery: bool,                   // §1.4 illegal refinery marker
//                   recipeId, productionRate, syndicateCommitment,
//                   teardownSettlement: { settlementFee, lockoutUntilTick, rpForfeit }, // §7
//                   contractWindow: { endTick, endCycle, cyclesRemaining, expired } | null, // VM popup
//                   equityPerCycle: int,                       // equity payout projection, VM popup
//                   site: { kind, planetId, systemId, resourceType } | null } ],
//     occupancy: { <siteId>: <ventureId> },
//     claims: [ { claimId, ownerGuildId, landmarkId, landmarkKind, claimedAtTick,
//                 contested,
//                 landmark: { kind, name?, coords?, ... } | null } ],
//     shipments: [ { ownerGuildId, cargo: { good: int }, destinationSystemId,
//                    arrivalTick, ticksRemaining } ],   // IN-FLIGHT, design.md §6
//     nodeLockouts: [ { siteId, releaseTick, lockedAtTick, ticksRemaining } ], // teardown §3.3
//   }
function buildSnapshot(state) {
  const supply = computeGalacticSupply(state);
  const occupancy = computeOccupancy(state);

  // THE ONE FUEL PRICE (§15.5 invariant 5), read ONCE for the whole snapshot — the
  // hoard's mark-to-market, every route's credit quote, and the headline figure in
  // `galacticSupply.fuel` are all this same number, so no two rows of one snapshot can
  // ever be priced differently. Echoed off state, never recomputed here: the engine owns
  // the price and 5b-ii will own moving it.
  //
  // The reserve-less fallback mirrors `computeGalacticSupply`'s (which reads a missing
  // reserve as a pool of 0) and `createReserve`'s own structural default, so a hand-built
  // partial state gets the reference rather than a NaN quietly multiplied through every
  // credit figure on the page. No number is invented here: it is the same named constant
  // a real galaxy opens at. `createState` always builds a reserve, so this is reachable
  // only from a fixture.
  const fuelPrice = state.reserve && state.reserve.fuelPrice !== undefined
    ? state.reserve.fuelPrice
    : REFERENCE_FUEL_PRICE;
  // The controller's demand signal (slice 5b-ii), read the same defensive way and for the
  // same reason: a hand-built partial state gets `createReserve`'s own opening assumption
  // rather than a NaN target propagated through the fuel block.
  const avgDraw = state.reserve && state.reserve.avgDraw !== undefined
    ? state.reserve.avgDraw
    : DEUTERIUM_INFLUX_PER_CYCLE;

  // The cycle length in ticks, defaulted the way every engine reader defaults it — the
  // multiplier that turns a per-tick production RATE into a per-cycle projection for the
  // deuterium Production readout below (and the cycle clock further down reuses it as `calN`).
  const cycleN = state.windowN == null ? DEFAULT_WINDOW_N : state.windowN;

  // Guild breakdown: copy the fields the inspector shows. stockpiles is spread
  // into a fresh object so a consumer mutating the snapshot can never reach back
  // into live state.
  const guilds = (state.guilds || []).map((g) => {
    // The derivation the asset block below reads: assetId -> the venture running
    // it. Computed ONCE per guild (sim/assets.js), not per asset row.
    const deployedTo = deployedAssetIds(g);
    return {
      id: g.id,
      name: g.name,
      isBot: !!g.isBot,
      credits: g.credits,
      fuelHoard: g.fuelHoard,
      // The hoard marked to market in credits, so the client never multiplies a
      // game number itself (§5's display rule: the browser renders, the engine
      // decides). Fuel is the one good the price ENGINE never prices (design.md
      // §8) — it has its own price, `state.reserve.fuelPrice`, and since slice
      // 5b-i (§4.2) that is what this marks against, through the engine's own
      // `fuelValue`. It used to ride a flat constant, which is now retired: there
      // is ONE fuel price (§15.5 invariant 5) and this is a reading of it. Pure
      // derived telemetry: no stored byte, no determinism hash, nothing charged.
      fuelHoardValue: fuelValue(g.fuelHoard, fuelPrice),
      // The hoard at the START of this cycle (Guild Hall Slice A, docs/guild-hall.md §4/§2.3)
      // — stamped by tick.js's step 6 POST-grant, before this cycle's usage. It is the
      // stockpile bar's MAX and the datum the used-this-cycle gap ((start − current) × price)
      // is measured from. ECHOED off stored state, and marked to market through the SAME
      // `fuelValue`/`fuelPrice` the hoard above uses (invariant 5: one fuel price). SPARSE:
      // stamped only for a guild that was DUE a grant, so `null` for a holdings-less guild and
      // for one before its first boundary — a null, not a 0, because a real 0 (a hoard that
      // opened the cycle empty) is a different, meaningful fact the bar must be able to show.
      fuelHoardAtCycleStart: g.fuelHoardAtCycleStart == null ? null : g.fuelHoardAtCycleStart,
      fuelHoardAtCycleStartValue: g.fuelHoardAtCycleStart == null
        ? null
        : fuelValue(g.fuelHoardAtCycleStart, fuelPrice),
      // The two guild-wide DEUTERIUM stores (§1.4 "The illegal path, made concrete", slices
      // 1a/1b) — the B1 exemption, held guild-wide rather than per-system:
      //   - `deuterium`: RAW contraband, mined by an unlicensed deuterium mine, awaiting a
      //     refinery. A goods quantity, not fuel — its posted-price valuation is the DEUTERIUM
      //     tab's job (slice 2b), so only the raw count is published here.
      //   - `deuteriumFuel`: CONTRABAND FUEL, refined 1:1 from the raw. Held FUEL, so it is
      //     marked to `reserve.fuelPrice` through the SAME `fuelValue` as `fuelHoard` — this is
      //     the RED segment of the Guild-Hall fuel bar (blue = `fuelHoard`, the legal half).
      // Both ECHOED off stored state (the engine decides, the browser renders), reported as the
      // 0 they mean when absent so the client reads a number, never an `undefined`. Additive and
      // DERIVED — no stored counterpart beyond the two scalars, no determinism byte.
      deuterium: g.deuterium || 0,
      deuteriumFuel: g.deuteriumFuel || 0,
      deuteriumFuelValue: fuelValue(g.deuteriumFuel || 0, fuelPrice),
      // The three FUEL-BURN-HISTORY fields the DEUTERIUM tab (slice 2b) reads — the donut's
      // RED baseline, the live burn counter, and the burn-habits series (docs/guild-hall.md,
      // the fuel-burn-history subsection; fuel-supply-and-allocation.md §1.4). All ECHOED off
      // stored state — the engine decides, the browser renders — additive and DERIVED, no
      // determinism byte of their own.
      //   - `deuteriumFuelAtCycleStart` + its marked `…Value`: the contraband held at the START
      //     of this cycle, and that marked to `reserve.fuelPrice` through the SAME `fuelValue`
      //     the blue baseline uses (invariant 5: one fuel price) — so the donut has a RED max in
      //     credits exactly parallel to `fuelHoardAtCycleStartValue`. SPARSE like the blue datum:
      //     `null` for a guild with no contraband, so the donut reads "no red", not a real 0.
      //   - `fuelBurnedThisCycle`: the live total burned this cycle (the counter, `|| 0`).
      //   - `fuelBurnHistory`: the rolling last-10-cycle `{ burn, granted, contrabandBurned }`
      //     series, in integer fuel QUANTITIES (deliberately not credits, so the burn/allotment
      //     series stays comparable across price moves), the array as stored (`|| []`).
      deuteriumFuelAtCycleStart: g.deuteriumFuelAtCycleStart == null ? null : g.deuteriumFuelAtCycleStart,
      deuteriumFuelAtCycleStartValue: g.deuteriumFuelAtCycleStart == null
        ? null
        : fuelValue(g.deuteriumFuelAtCycleStart, fuelPrice),
      fuelBurnedThisCycle: g.fuelBurnedThisCycle || 0,
      fuelBurnHistory: g.fuelBurnHistory || [],
      // The DEUTERIUM tab's Production readout — the guild's deuterium output PER CYCLE, in
      // fuel-quantity UNITS (not credits), split legal / contraband. A pure DERIVED read: it is
      // the engine deciding the number so the client renders rather than computes it (§5), with
      // no stored counterpart and no determinism byte.
      //   - `legalPerCycle`      = Σ (`productionRate` of the guild's LICENSED deuterium mines —
      //     `isLicensedDeuteriumMine`, i.e. `resourceType === 'deuterium'` + a `deuteriumLicence`)
      //     × the cycle length `cycleN`.
      //   - `contrabandPerCycle` = Σ (`productionRate` of the guild's ILLEGAL refineries —
      //     `isIllegalDeuteriumRefinery`, i.e. the `deuteriumRefinery` marker) × `cycleN`.
      // Deliberately a PROJECTION, not an exact figure: rate × cycle length. A refinery is
      // raw-limited in reality (it converts only as much as `guild.deuterium` holds); this ignores
      // that, as designed — the readout shows the guild's committed CAPACITY per cycle, not its
      // realised throughput. `cycleN` (= `windowN`, the galaxy's real cycle) is used, never a
      // hardcoded 1,440, so the projection tracks a non-standard cycle.
      deuteriumProduction: {
        legalPerCycle: (g.ventures || []).reduce(
          (sum, v) => sum + (isLicensedDeuteriumMine(v) ? v.productionRate * cycleN : 0), 0),
        contrabandPerCycle: (g.ventures || []).reduce(
          (sum, v) => sum + (isIllegalDeuteriumRefinery(v) ? v.productionRate * cycleN : 0), 0),
      },
      // What a Syndicate trade COSTS IN FUEL, per system this guild holds (fuel
      // Slice 2). Keyed by systemId, each `{ fuelBurn, creditCost, travelTicks }`.
      // The BURN is the engine's own `routeFuelCost` (sim/fuel.js) — CALLED, never
      // re-derived, so the quote the client shows and the burn the purchase deducts
      // come out of one function and cannot drift.
      //
      // THE `creditCost` IS A VALUATION, NOT A CHARGE, and since slice 5b-i (§4.2)
      // it is marked to `reserve.fuelPrice` here rather than to a flat constant
      // inside `routeFuelCost`. The engine charges the PHYSICAL `fuelBurn`, which is
      // geometry and unchanged; what that burn is worth in credits is today's price,
      // so it is computed at the display site through the SAME `fuelValue` the hoard
      // uses. One price, one valuation function, both readings move together.
      //
      // THE `travelTicks` IS THE ROUTE'S TRAVEL DURATION — how many ticks a delivery
      // to this system spends in flight (transport-model.md §8.0). It is
      // `arrivalTickFor(0, distance)` = `ceil(distance × CRAFT_SPEED)` over the SAME
      // `systemId → nearest waystation` route the burn uses, so the BUY confirm popup
      // (a later client slice) can quote an arrival time before the player commits.
      // Published as the DURATION, never an absolute arrival tick: the browser adds it
      // to the current tick, so there is nothing to recompute when the tick advances.
      // Read from `nearestWaystation` and `arrivalTickFor` (sim/transport.js) — CALLED,
      // never re-derived, exactly as `creditCost` reuses `fuelValue`: the geometry the
      // quote flies on is the one the delivery is timed on (§8's "one geometry"). A
      // system with no reachable waystation gets `0`, the same honest no-route value
      // `fuelBurn` reports there, not a real duration.
      //
      // HELD SYSTEMS ONLY, because a Syndicate delivery goes only to a system you
      // hold (§6, enforced by `buyFromSyndicate`'s own `guildHolds` gate) — a quote
      // for anywhere else would be a price for a trade the engine would refuse.
      // The list comes from `heldSystemIds`, which reads the same claim rows that
      // gate through the same predicate, and arrives sorted (invariant 9).
      //
      // Pure derived telemetry: reads state as it stands, mutates nothing, enters
      // no serialized byte and no determinism hash. Nothing is charged — the
      // deduction is Slice 3.
      fuelCost: Object.fromEntries(
        heldSystemIds(state, g.id).map((systemId) => {
          const { fuelBurn } = routeFuelCost(systemId);
          // Same route the burn uses; a system with no reachable waystation → 0
          // travel ticks, matching the 0 `fuelBurn` reports for that no-route case.
          const near = nearestWaystation(systemId);
          const travelTicks = near ? arrivalTickFor(0, near.distance) : 0;
          return [
            systemId,
            { fuelBurn, creditCost: fuelValue(fuelBurn, fuelPrice), travelTicks },
          ];
        }),
      ),
      influence: g.influence,
      // guildReputation: the guild's Reputation Points — Σ its ventures' `reputation`
      // (docs/points-and-reputation.md §2), ECHOED as stored, never re-summed here. The
      // engine owns the sum and an invariant guards it (`checkGuildReputationSum`); a
      // snapshot that added the ventures up a second time would be a second derivation
      // of one fact, and the lens and the state could disagree about a number the fuel
      // layer's mean line will later read (§3). 0 for every guild that has never been
      // judged at a boundary, which is every unlicensed one.
      guildReputation: g.guildReputation || 0,
      // foundingEndowment: how much of the total above was GRANTED AT FOUNDING rather than
      // earned (docs/points-and-reputation.md §2.5) — `MEANLINE_K × W_SYS × the systems held
      // at founding`, which neutralises the home system's bar exactly once. Echoed as
      // stored, like `guildReputation` itself. It is what lets a reader see WHY a
      // ventureless newborn sits on its line rather than at the floor: without it the total
      // is a number with no visible provenance. 0 for every guild not founded through
      // `foundGuild`, which is every scenario- and test-built one.
      foundingEndowment: g.foundingEndowment || 0,
      // foundingEntitlement: the guild's fuel-credit ENTITLEMENT at founding (the
      // expected-fuel-change gauge's baseline, docs/guild-hall.md §2) — `grantFor` captured at
      // founding, ECHOED as stored like `foundingEndowment` beside it. It is the Fuel Δ gauge's
      // DENOMINATOR before the first cycle boundary stamps a real `fuelGrant.entitlement`, so
      // the gauge reads live (opening at ×1.00) from tick 0 instead of `—` until the first
      // boundary. null for a guild not founded through `foundGuild` (every scenario/test one)
      // and for a zero-GP founding — a null the client falls through to today's behaviour on.
      foundingEntitlement: g.foundingEntitlement == null ? null : g.foundingEntitlement,
      // guildPoints: the guild's Guild Points — how BIG it is
      // (docs/points-and-reputation.md §1/§1.0): `W_SYS × held systems + Σ ventures
      // W_TIER(tier)`, computed by the engine's own `guildPoints` (sim/points.js) rather
      // than re-derived here, so the lens and any future consumer read one function.
      //
      // DERIVED, and the ONLY guild figure in this block that is: unlike
      // `guildReputation` beside it there is nothing stored to echo, because GP is a pure
      // function of holdings that already exist in state (the claim rows and the venture
      // array). It reaches no serialized byte and no determinism hash — the same standing
      // as `fuelCost` and `fuelHoardValue` above.
      //
      // It is published and NOTHING READS IT YET. The mean line that judges RP against it
      // (`expectedRP = MEANLINE_K × GP`, §3) is the next slice and is not built; §4 rules
      // that the FUEL layer will own it and merely read this.
      guildPoints: guildPoints(state, g),
      // THE MEAN LINE (docs/points-and-reputation.md §3), the pair above joined:
      // `expectedReputation` is the RP a guild this big is expected to have earned
      // (`MEANLINE_K × guildPoints`), and `issuanceModifier` is `guildReputation` judged
      // against it — the multiplier a future fuel grant would be scaled by. Both from the
      // engine's own helpers (sim/meanline.js), never re-derived here.
      //
      // DERIVED like `guildPoints` beside them: no stored counterpart, no serialized
      // byte, no determinism hash. The modifier is a FLOAT and deliberately UNROUNDED —
      // no precision is ruled, so picking one would be inventing a number; a display
      // formats it.
      //
      // THEY GRANT NOTHING. `fuelGranted = baseGrant × modifier` needs `baseGrant`, the
      // pool/price slice (§8), which is not built — so this is published and read by
      // nothing, exactly as `guildPoints` was one slice ago. A modifier of 1.0 on a guild
      // holding nothing is the ruled empty-guild guard (§3), not a missing value.
      expectedReputation: expectedReputation(state, g),
      issuanceModifier: issuanceModifier(state, g),
      // predictedGrant: this guild's LIVE fuel-credit entitlement — `grantFor` =
      // `round(BASE_GRANT_PER_GP × GP × modifier)` at where the guild stands RIGHT NOW, i.e.
      // what the next boundary would grant it (in credits, at the reference price) if the
      // cycle ended this instant. The expected-fuel-change gauge (docs/guild-hall.md §2.1)
      // divides this by `fuelGrant.entitlement` (this cycle's stamped entitlement) to draw a
      // change ratio centred on ×1.00 — the one presentation derive that slice adds.
      //
      // DERIVED like `guildPoints`/`issuanceModifier` beside it: a pure function of holdings
      // and reputation already in state, no stored counterpart, no serialized byte, no
      // determinism hash. NOT `physicalGrantFor` — the gauge is a ratio of ENTITLEMENTS
      // (price-independent), so the shared price cancels and the ratio measures the guild's
      // GROWTH this cycle, not the market's price move. An integer credit — `grantFor` rounds
      // (§15.2). A holdings-less guild reads 0 (GP 0), the ruled empty-guild answer.
      predictedGrant: grantFor(state, g),
      // What the Syndicate GRANTED this guild at the last cycle boundary (fuel slice 5a,
      // docs/fuel-supply-and-allocation.md §2.1) — what it was DUE (`desired`, its size ×
      // its modifier) and what it actually RECEIVED after rationing. `thisTick` is the
      // engine answering "did this fire on the current tick?", the courtesy
      // `syndicateSale` and `licenceFee` already do.
      //
      // A RECORD OF AN EVENT, echoed as stored, not a derivable fact (invariant 5): both
      // figures are true of ONE boundary — `desired` moves with the guild's Points and
      // reputation, and `granted` also depended on how full the pool was and on what every
      // other guild drew that cycle. Neither could be recovered a tick later.
      //
      // WHEN THE TWO DIFFER, THE GALAXY RATIONED. That is the crunch edge (§4.1) made
      // visible, and it is the whole reason `desired` is carried beside `granted` rather
      // than left to be inferred. null for a guild that has never been due anything —
      // every holdings-less guild, and every guild before its first boundary.
      //
      // THE POOL ITSELF NEEDS NO NEW FIELD: it is already published as
      // `galacticSupply.fuel.reserve`, beside `guildHeld` and their `total`. Adding a
      // second reading of one number to this lens would be exactly the drift
      // `checkGalacticSupplyConsistency` exists to prevent.
      fuelGrant: g.lastFuelGrant
        ? {
            tick: g.lastFuelGrant.tick,
            thisTick: g.lastFuelGrant.tick === state.tick,
            granted: g.lastFuelGrant.granted,
            desired: g.lastFuelGrant.desired,
            rationed: g.lastFuelGrant.granted < g.lastFuelGrant.desired,
            // The modifier that DROVE this cycle's grant (Guild Hall Slice B) — the panel's
            // CURRENT gauge. ECHOED off the stored record, never recomputed here: the live
            // `issuanceModifier` beside this in the row reads the guild's standing RIGHT NOW
            // (the panel's PREDICTED), and the whole point is that the two can differ once
            // this cycle's actions have moved reputation. A FLOAT and unrounded, like the
            // live one. Reported as its 0-safe value when a pre-slice record carries no
            // modifier (`?? null`); a real record always has one.
            modifier: g.lastFuelGrant.modifier == null ? null : g.lastFuelGrant.modifier,
            // This cycle's fuel-credit ENTITLEMENT (the expected-fuel-change gauge,
            // docs/guild-hall.md §2.1) — `grantFor` at THIS boundary, the price-independent
            // number `desired` was scaled from. ECHOED off the stored record, never
            // recomputed here: the live `predictedGrant` beside this in the row is NEXT
            // cycle's entitlement, and the panel divides the two (nxt ÷ cur) for the change
            // ratio, the same sanctioned two-field derive the RP donut's subtraction is. The
            // client renders `—` before the first grant (no `cur` to divide from), exactly as
            // the Current gauge already does. Reported as its 0-safe value when a pre-slice
            // record carries no entitlement (`?? null`); a real record always has one.
            entitlement: g.lastFuelGrant.entitlement == null ? null : g.lastFuelGrant.entitlement,
          }
        : null,
      // The rolling per-guild ISSUANCE-MODIFIER history (Guild Hall Slice C,
      // sim/modifier-history.js) — one sample per cycle at the boundary, oldest → newest,
      // for the Standing panel's Performance line (the panel draws the last 10). ECHOED
      // VERBATIM from the stored ring, copied so the snapshot can never alias into engine
      // state. ALWAYS EMITTED, even empty: a guild with no history yet gets a stable `[]`
      // (the panel's "gathering history…" state), the same courtesy `priceHistory` extends —
      // unlike the STORED field, which is omitted until the first sample so a young galaxy
      // hashes byte-identically to pre-slice.
      modifierHistory: cloneModifierHistory(g.modifierHistory),
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
      // assets: the guild's ground-asset inventory (design.md §4, 30-08-26), one row
      // per owned machine. `deployedToVentureId` is the ENGINE answering "is this one
      // idle?" — the venture whose `assetId` names it, or null — so the client reads
      // idle-vs-deployed instead of recomputing the derivation itself (§5's display
      // rule: the browser renders, the engine decides). `maintenanceCondition` rides
      // along inert, so the surface is already the right shape when the maintenance
      // slice gives it a meaning. Sorted by id — the deployment pick is id-ordered, so
      // the panel reads in the order the engine will take them. Fresh objects, so a
      // consumer mutating the snapshot can never alias into engine state.
      assets: (g.assets || []).map((a) => ({
        id: a.id,
        kind: a.kind,
        maintenanceCondition: a.maintenanceCondition,
        deployedToVentureId: deployedTo.get(a.id) || null,
      })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
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
    };
  });

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
        // assetId: the machine this venture runs (§4) — the other half of the
        // guild's `assets` block above, read from the venture's end. null for an
        // asset-less venture, which is legal but unreachable through establish or
        // founding (both always occupy).
        assetId: v.assetId == null ? null : v.assetId,
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
        // reputation: the venture's RP running total (docs/points-and-reputation.md §2;
        // design.md §5 "ventures carry a fully visible reputation score" — this is what
        // makes it visible). SIGNED: a breaching venture reports a negative number, and
        // that is the state the band's closure floor eventually acts on, not an error.
        // Absent on a venture that has never been judged, reported here as the 0 it
        // means — exactly the courtesy `equityPct` and `syndicateCommitment` above do,
        // so a client reads a number and never an `undefined`. Echoed as STORED; the
        // engine decides, the browser renders (§5's display rule).
        reputation: v.reputation || 0,
        // licence: the venture's Syndicate Venture Licence (Slice 3b-i) — its agreed
        // terms and the two fee figures LOCKED at signing, so the console can show
        // "your fee: N (discounted from M), locked at price P" without computing a
        // thing (§5's display rule). Copied so the snapshot can't alias into engine
        // state. null for an unlicensed venture, which is most of them.
        licence: v.licence ? { ...v.licence } : null,
        // The two DEUTERIUM markers (§1.4), surfaced so the client can tell a licensed
        // deuterium mine, an unlicensed one, and an illegal refinery apart — each presents and
        // deploys differently:
        //   - `deuteriumLicence`: the windowless deuterium licence ({ signedTick }) — a licensed
        //     mine that auto-sells to the Syndicate. null on an unlicensed mine.
        //   - `deuteriumRefinery`: true on an illegal refinery (a factory venture converting raw
        //     deuterium → contraband fuel). false otherwise.
        // Both ECHOED off stored state; copied so the snapshot can't alias into engine state.
        // A plain deuterium MINE carries a `resourceType` of 'deuterium'; the two markers say
        // what has been done with it.
        deuteriumLicence: v.deuteriumLicence ? { ...v.deuteriumLicence } : null,
        deuteriumRefinery: !!v.deuteriumRefinery,
        // committedFromTick: the venture's FIRST PRODUCING tick under its licence
        // (Slice 3b-ii) — the term that pro-rates its first window's obligation (§5's
        // join ruling). null for an unlicensed venture, and for one committed through
        // the dev scaffold, both of which owe a full window. Surfaced so the console
        // can explain a first window that asks for less than the full commitment,
        // instead of the number appearing to be wrong.
        committedFromTick: v.committedFromTick == null ? null : v.committedFromTick,
        // teardownSettlement: what decommissioning this venture would cost RIGHT NOW
        // (docs/venture-teardown.md §7) — `{ settlementFee, lockoutUntilTick, rpForfeit }`,
        // computed by the SAME pure helper the decommission apply charges, so the confirm the
        // client shows and the cost the engine takes cannot disagree (§7). A later client slice
        // reads this; the field is additive telemetry, computed on read, no serialized byte.
        // For a licensed deuterium mine (whose teardown is deferred, §6) it previews the
        // unlicensed shape (fee 0, no lockout, its RP forfeited) — an honest preview even
        // though the action refuses it this slice.
        teardownSettlement: teardownSettlement(state, g, v),
        // contractWindow: the licence's committed window in CYCLES (docs/venture-management.md §7)
        // — { endTick, endCycle, cyclesRemaining, expired } or null for an unlicensed venture and a
        // windowless deuterium-licensed mine. The Venture Management popup's hero speaks the window
        // in cycles, never ticks; `endTick` is the SAME value teardownSettlement's `lockoutUntilTick`
        // carries (through `licenceEndTick`), so the panel and the settlement cannot disagree about
        // the term's end. DERIVED on read: no serialized byte, no determinism hash.
        contractWindow: contractWindowForVenture(state, v),
        // equityPerCycle: the investor (equity) payout PROJECTION for one cycle, integer credits —
        // `round(committedOutputPct × productionRate × windowN × equityPct × postedPrice(good))`
        // (docs/venture-management.md §7). The `o`-share of the commitment sale at the current price,
        // deliberately raw-unlimited (rate × cycle) like `deuteriumProduction`. 0 when unlicensed, no
        // equity, or deuterium (no posted price). The engine decides the figure so the browser renders
        // it (§5); DERIVED on read, no serialized byte, no determinism hash.
        equityPerCycle: equityPerCycleForVenture(state, v),
        // standing + renegotiationOffer: the licence-renegotiation read model (#64 Slice
        // 1, design.md §5). SPREAD so an unlicensed venture and a deuterium mine carry
        // NEITHER key: `standing` (the ventureStanding band) is present for every licensed
        // non-deuterium venture; `renegotiationOffer` (the new terms + re-locked fee the
        // player would accept, from the SAME renegotiationFee the apply locks) only once
        // the committed window has elapsed, null before. DERIVED on read: no serialized
        // byte, no determinism hash, invents no number. See renegotiationFieldsFor.
        ...renegotiationFieldsFor(state, v),
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

  // The IN-FLIGHT layer (§15.1): every pending Syndicate delivery, echoed as
  // stored. `ticksRemaining` is the ONE derived field — `arrivalTick - tick`,
  // floored at 0 so a delivery due this very tick reads 0 rather than a negative
  // — computed here because §5's rule is that the browser renders and never
  // calculates. `cargo` is spread into a fresh object so a consumer mutating the
  // snapshot can never reach back into live state.
  const shipments = (state.shipments || []).map((ship) => ({
    ownerGuildId: ship.ownerGuildId,
    cargo: { ...(ship.cargo || {}) },
    destinationSystemId: ship.destinationSystemId,
    arrivalTick: ship.arrivalTick,
    ticksRemaining: Math.max(0, ship.arrivalTick - state.tick),
  }));

  const reserve = supply.fuel.reserve;
  const guildHeld = supply.fuel.guildHeld;

  // The cycle length and anchor in force, defaulted the same way every engine reader
  // defaults them, so the emitted clock matches the boundary the engine actually judges
  // on rather than a second opinion about it.
  const calN = cycleN;
  const calAnchor = state.dayAnchorTick == null ? 0 : state.dayAnchorTick;
  const calOffset = state.utcOffsetMinutes == null ? 0 : state.utcOffsetMinutes;

  // The per-good BASIC licence fee, in credits, at the price and window standing right
  // now — the quote a player reads before signing. Every term is the licence path's own:
  // the good's droidless baseline (`baselineUnitsForGood`), the window `calN` above (read
  // exactly as `applyForLicence` reads it), the POSTED price (the same lagged value a
  // signature locks), and the arithmetic itself, which is `licenceFee` called rather than
  // copied. Commitment and equity are passed at 0 — `basicFee` does not depend on them
  // (it is the un-discounted figure by definition), and the DISCOUNTED fee is deliberately
  // not published: it moves with sliders the player has not yet let go of.
  //
  // Walked in PRICED_GOODS' sorted order so the emitted bytes are stable (invariant 9). A
  // good is OMITTED rather than given an invented number when either half is missing:
  // nothing can produce it (no baseline), or the state carries no price row for it (a
  // hand-built test state) — a zero fee there would read as "this licence is free".
  const feeQuote = {};
  for (const good of PRICED_GOODS) {
    const baselineUnitsPerTick = baselineUnitsForGood(good);
    const lockedPrice = postedPrice(state, good);
    if (baselineUnitsPerTick == null || lockedPrice == null) continue;
    feeQuote[good] = licenceFee({
      baselineUnitsPerTick,
      windowN: calN,
      lockedPrice,
      committedOutputPct: 0,
      equityPct: 0,
    }).basicFee;
  }

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
      //
      // `fuelPrice` — the galaxy's ONE market price of `deuterium_fuel`, echoed off
      // `state.reserve.fuelPrice` (slice 5b-i, §4.2). Every credit figure in this snapshot
      // that touches fuel is this price times a quantity. Since slice 5b-ii the controller
      // MOVES it each cycle, which is what the two figures beside it explain.
      //
      // `avgDraw` / `targetReserve` — the controller's own two numbers (slice 5b-ii): the
      // trailing average of what the galaxy DESIRES each cycle, and `TARGET_CYCLES ×` it,
      // the level the price is steering the pool to. Read them against `reserve` and the
      // price stops being a mystery: pool below target ⇒ the price is rising, above ⇒
      // falling, at it ⇒ the price is exactly `REFERENCE_FUEL_PRICE`. `avgDraw` is echoed
      // off state; `targetReserve` is DERIVED here through the engine's own function, so
      // the lens never carries a second copy of the rule (invariant 5).
      fuel: {
        reserve,
        guildHeld,
        total: reserve + guildHeld,
        fuelPrice,
        avgDraw,
        targetReserve: targetReserve(avgDraw),
      },
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
    // The galaxy-wide FUEL-PRICE history (sim/fuel-price-history.js) — the ring of the last ≤12
    // COMPLETED 6-hour averages, oldest → newest (12 points = a 3-day trend), a plain array the
    // DEUTERIUM tab's price graph draws with no reshaping. Copied so the snapshot can't alias
    // into engine state; a galaxy that has closed no bucket yet emits `[]` (the graph shows its
    // "gathering history…" state), always a stable shape for the reader — the same courtesy
    // `priceHistory` extends. The partial current-bucket accumulator is deliberately NOT
    // published: the live "now" tip is already `galacticSupply.fuel.fuelPrice` above, so the
    // client tips the line with the live price and the ring carries only closed averages.
    fuelPriceHistory: [...(getFuelPriceRing(state) || [])],
    // The per-good BASE value — the anchor the price curve multiplies — so the chart
    // can draw its reference line without the browser typing a game number of its own
    // (design.md §5: the client computes no authoritative number). Read through
    // prices.js's one accessor: it is uniform across goods TODAY because per-good
    // bases are unruled, and this shape is what that later ruling fills in.
    priceBase: Object.fromEntries(PRICED_GOODS.map((good) => [good, basePriceFor(good)])),
    // The BASIC licence fee per good, in credits, at the posted price and window in force
    // (built above). What a licence signed this tick would lock — so the Establish-Venture
    // panel can show the real number instead of a percentage, and still compute nothing
    // itself (§5's display rule). Un-discounted: the commitment/equity relief is the
    // player's own live terms, and the client already draws that curve.
    feeQuote,
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
    shipments,
    // The node lockouts (docs/venture-teardown.md §3.3) — sites barred from re-establishment
    // until `releaseTick` after an ordinary-licensed teardown. Echoed as stored, with the one
    // derived `ticksRemaining` (`releaseTick - tick`, floored at 0) computed here so the
    // browser renders and never calculates — exactly the courtesy `shipments` above extends.
    // ALWAYS EMITTED as an array (a stable [] when a galaxy holds none), unlike the STATE field
    // which is omitted-when-empty for the determinism hash: the snapshot answers to a reader, a
    // stable shape is kinder than a key that appears only after the first teardown.
    nodeLockouts: (state.nodeLockouts || []).map((l) => ({
      siteId: l.siteId,
      releaseTick: l.releaseTick,
      lockedAtTick: l.lockedAtTick,
      ticksRemaining: Math.max(0, l.releaseTick - state.tick),
    })),
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
  // one Titanium mine seated on a real seed node, $120 / influence 100. The home
  // is DERIVED from the seed (first starter + its Terran homeworld), not hardcoded.
  let state = createZeroState();
  const homeSystemId = getStarterSystems()[0].id;
  const homePlanetId = getTerranHomeworld(homeSystemId);
  const found = createFoundGuildAction({
    guildId: 'player-guild',
    name: 'Player Guild',
    credits: 120,
    influence: 100,
    homeSystemId,
    ventures: [
      { id: 'mine_1', ownerGuildId: 'player-guild', type: 'mining', siteId: `${homePlanetId}_n01`, resourceType: 'titanium', productionRate: 5 },
    ],
  });
  state = advance(state, [found]).state; // founding also runs one tick
  // A second mine, this time via the establishVenture action (the testbed's
  // "add a venture" path), on the homeworld's other titanium node.
  const secondMine = createEstablishVentureAction({
    guildId: 'player-guild', ventureId: 'mine_2', siteId: `${homePlanetId}_n02`,
    // The deploy NAMES its machine (§4, 31-08-26). miner_01 went to the founding's
    // inline mine_1, so this one takes the next idle Miner out of the starter gift.
    assetId: 'asset_player-guild_miner_02',
    resourceType: 'titanium', productionRate: 5, // titanium's ruled rate, matching mine_1 [phase-1-tuning.md]
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
