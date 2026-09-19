# Buying a Tier-4 asset from the Syndicate — roadmap 2.1d

*Ruled 14-09-26 in the design room. The BUY side of the asset economy: a guild pays the
Syndicate credits (and fuel) to build and deliver a finished Tier-4 asset — the alternative to
building it itself in a dockyard (`docs/build-yard.md`). Every number is `[FIRST-CUT]` and lives
in `docs/phase-1-tuning.md`; this doc is the mechanic. It reuses the §6 Syndicate-delivery rails
(`docs/design.md` §6, the IN-FLIGHT `shipments` layer) — nothing new is invented where a rail
already exists.*

## What it is

The dockyard (`build-yard.md`) turns a guild's OWN stockpiled modules into an asset over a build
time, spending no credits. The Syndicate purchase is the mirror acquisition path: spend CREDITS
(and fuel) instead of parts, and the Syndicate builds and ships the asset to you. The two are a
deliberate trade-off — parts + time + no credits (dockyard) vs credits + time + no parts
(Syndicate) — so neither dominates.

Buildable kinds this slice: **miner, factory** — the only asset kinds with entities
(`sim/assets.js`; `sim/asset-recipes.js` `BUILDABLE_ASSET_KINDS`). The ship / outpost / scanner /
toll-gate / droid kinds follow when their entities exist.

## The two phases

A purchase is TWO phases in sequence, one order:

1. **Construction (Syndicate-side).** On buy, the guild pays the full price in credits AND the
   delivery fuel UP FRONT, and a build order is recorded. The asset is built centrally over the
   kind's build time — the SAME `BUILD_TICKS` the dockyard uses (`asset-recipes.js`: miner 720
   / factory 960 ticks). During construction the order is "on order": it is NOT a shipment and
   does NOT appear on the map — only a calm "on order — arriving day X" indicator in the
   Operations panel tells the player it is coming.
2. **Delivery.** When construction completes, the order becomes a **standard Syndicate delivery
   shipment** (§6 / the `shipments` layer) from the destination's nearest waystation, travelling
   the straight-line hex distance at the ruled Syndicate craft speed (`phase-1-tuning.md`). From
   this moment it is an ordinary transport manifest: it appears in the Operations panel's transit
   list and is tweened along its leg on the map, **identical to a goods BUY**. On the arrival tick
   the shipment lands and a **fresh idle asset** of that kind is minted at the destination system,
   guild-owned, ready to deploy — exactly like a dockyard's output.

Player timeline: pay → (build time) → a manifest appears and travels → asset arrives. In ticks:

    arrivalTick = buyTick + BUILD_TICKS[kind] + ceil(hexDistance × <Syndicate craft speed>)

(This holds only for a commission that starts building immediately — first in an empty queue. One
placed behind others starts its BUILD_TICKS only when it reaches the head; see §Build concurrency.)

## Build concurrency — one slot per guild, single-slot sequential (RULED 19-09-26)

The Syndicate runs **one build slot per guild**. A guild's Syndicate commissions — Tier-4 assets
AND guild transports alike, the unified `state.syndicateBuilds` list — form a **per-guild FIFO
queue**: **only the HEAD builds**, counting down its `BUILD_TICKS`, and when the head completes and
is sent for delivery the **next head starts** its countdown. The build clock starts when a
commission reaches the front, **not when it is ordered**.

This mirrors the dockyard's single-slot / strict-FIFO `remainingTicks` model exactly
(`buildDockyards`, `docs/build-yard.md` §3) — the Syndicate is simply a per-guild queue where the
dockyard is a per-yard one. Each guild's queue is **independent**: the Syndicate services every
guild as though it were the only one, so a rival's queue never delays yours. Credits and the
delivery fuel are still charged **up front at buy** (unchanged) — so a head dispatches the instant
it completes; there is no fuel-gated wait.

**Differentiation from dockyards (deliberate):** a guild may own several dockyards and so build
several assets at once — **one per yard** — but the Syndicate is one slot per guild, so a guild's
Syndicate orders **never build in parallel**.

**Supersedes the PARALLEL model.** The as-built notes below describe the earlier behaviour — each
order counting down from its own buy tick, all at once — which let a batch of commissions collapse
to near-simultaneous completion (the bug that motivated this ruling). The engine (`syndicateBuilds`
→ head-only `remainingTicks`, one active build per guild) and the client In Progress panel (head
building on the donut, the rest queued/waiting) are rebuilt to this model in the slices that follow;
treat those "As built" descriptions as superseded until then.

## Price

Assets have no posted market price, so the Syndicate prices a purchase as:

    price = max( ASSET_PURCHASE_FLOOR , round( partsCost × ASSET_PURCHASE_REDUCTION ) )

where `partsCost = Σ over the kind's bill of ( module qty × that module's posted price )` — the
same bill (`asset-recipes.js` `ASSET_BILLS`) and the same posted prices the rest of the economy
uses (`sim/prices.js`), priced at the quote's issue tick (quote-lock, §8.1: the price cannot
shift between opening the confirm popup and confirming). Rounded once on the whole order (#43).

`ASSET_PURCHASE_FLOOR` and `ASSET_PURCHASE_REDUCTION` are `[FIRST-CUT]` (`phase-1-tuning.md`). At
today's economy scale a miner/factory's parts are worth only ~100–2,800 credits, far below the
floor, so the **floor binds** and a purchase is effectively a flat `ASSET_PURCHASE_FLOOR`. The
`partsCost × REDUCTION` branch is kept LIVE in the formula (not dead code): as recipes and prices
are tuned, parts can rise toward and past the floor, at which point the discounted per-part price
governs. This is deliberate — assets are meant to be a major purchase now, and the model is tuned
by editing the two constants, never the code.

## Cost timing and fuel

BOTH costs are charged at buy, up front:

- **Credits** — the price above, debited from the guild and credited to the Syndicate ledger
  (invariant 2, as the goods BUY does).
- **Fuel** — the delivery flight burns route fuel like any Syndicate delivery. An asset is a
  single indivisible payload that fills a **heavy** hold, so it burns at the **heavy hauler rate
  (0.7/hex)** over the hex distance (`transport-model.md` §5.1, RULED 14-09-26). **✅ BUILT** (shipment
  rebuild slice 1): the light→heavy change rode the tiered-hauler build and the engine now charges the
  heavy rate — `routeFuelCost(destinationSystemId, ASSET_CARGO_VOLUME)`, where `ASSET_CARGO_VOLUME` is the
  heavy hold (`sim/fuel.js`). *(History: this began as a `[FIRST-CUT]` light-rate placeholder that
  deferred the asset→tier mapping to §5.1's ruling; that ruling set it to heavy and the build applied it.)*

Charging the fuel up front (rather than when the flight departs) is deliberate: it removes the
failure mode where construction finishes but the guild can no longer afford the flight, leaving a
delivery stuck with nowhere to go. Affordability of both credits and fuel is checked once, at buy;
a guild that cannot pay either is refused up front (the goods-BUY mirror).

## Destination

One destination system per order (a purchase does not split — the §6 asymmetry). The asset lands
idle, guild-owned, AT that system. Presence in the destination is NOT required (the goods BUY
delivers to any system; an idle asset is guild inventory located at a system, like a dockyard's
output). In the current single-system galaxy this is the home system; the parameter is ruled now
so multi-system (2.2) needs no reopening.

## Failure modes (hunted on paper — working practice #7)

- **Can't afford credits or fuel** → refused up front at validate, nothing scheduled (goods-BUY
  mirror).
- **Price moved between quote and confirm** → quote-lock (§8.1, `issueTick`): the confirm
  re-prices the parts from the engine's own ring at the issue tick, or is refused if the quote
  expired. Nothing the client sends can pin the price.
- **Guild gone before arrival** (torn down mid-flight) → the arrival mints nothing and drops the
  shipment (the arrival step already tolerates a missing owner for goods; the asset mint takes the
  same guard).
- **Stable id** — the minted asset gets a freshly minted stable id (§15.2), recorded with its mint
  tick (every mutation records its tick).
- **A long, expensive commitment** — a 12M floor + a 3–5 day build + an up-to-days delivery is
  intended (assets are hard to get); a test galaxy fast-forwards ticks (`tools/admin.js`) to
  exercise it.

## Reuse vs new

Reused unchanged: the §6 Syndicate delivery + `shipments` subsystem (waystation geometry, craft
speed, hauler fuel burn, the transport manifest and its Operations + map visibility); the build
time (`asset-recipes.js` `BUILD_TICKS`); the bills + posted prices (`ASSET_BILLS`, `sim/prices.js`);
the idle-asset mint shape (`foundGuild` / the dockyard already create one).

New: the `buyAssetFromSyndicate` action + the price function; a build-order record and the tick
step that promotes it to a delivery shipment on completion; the asset-carrying shipment variant +
its mint-on-arrival; the TRADE-tab client section + confirm popup; the "on order" construction
indicator. Sliced engine-first, then client.

## The two `[FIRST-CUT]` constants

Recorded in `docs/phase-1-tuning.md` (the authority on the values), living once in
`sim/asset-recipes.js`:

- **`ASSET_PURCHASE_FLOOR`** = 12,000,000 credits — the minimum a Syndicate asset costs.
- **`ASSET_PURCHASE_REDUCTION`** = 0.8 — the multiplier on live parts cost (a 20% discount) that
  governs the price once `partsCost × 0.8` exceeds the floor.

Both tunable in that one file; both currently place the price at the flat floor.

## As built — ENGINE slice 1 (2.1d, engine-first)

✅ **BUILT — the engine half of this ruling.** Sliced engine-first (see "Reuse vs new"): the data
now exists, the client renders it next slice.
- **Price + constants** — `ASSET_PURCHASE_FLOOR` / `ASSET_PURCHASE_REDUCTION` / `priceAssetForPurchase`
  in `sim/asset-recipes.js` (beside the dockyard build-core constants), off the same quote-lock ring
  (`quotedPrice`) the goods BUY uses. The floor binds at today's parts scale.
- **The action** — `buyAssetFromSyndicate` (`sim/actions.js`), the asset analogue of `buyFromSyndicate`:
  same gate structure and quote-lock, minus the `guildHolds` gate (presence not required). Apply debits
  credits → `syndicate.ledger` (invariant 2) and burns the **heavy**-hauler route fuel up front (invariant 1)
  — a T4 asset fills a heavy hold (§5.1, RULED 14-09-26), `routeFuelCost(dest, ASSET_CARGO_VOLUME)`; ✅ BUILT
  in the shipment-rebuild slice, superseding the original light-rate placeholder —,
  then records a build order on the new top-level `state.syndicateBuilds` (omit-when-empty, so an unbought
  galaxy stays byte-identical).
- **Two-phase build→deliver** — `stepSyndicateBuilds` (`sim/tick.js` step 4, scheduled events) promotes a
  build at its absolute `buildDoneTick` to a standard §6 delivery shipment carrying an `assetKind` marker;
  `stepArrivals` mints one idle asset (the dockyard's exact `assetId`/`nextAssetNumber`/`createAsset`
  pattern) at the destination on arrival, guarding a vanished owner by dropping the shipment.
- **Snapshot** — additive, derived-on-read: `snapshot.syndicateBuilds` (the on-order indicator) + an
  `assetKind` field on an asset shipment's transit row. No serialized byte, no golden move.

**Deferred to the client slice (unbuilt):** the TRADE-tab section, the confirm popup, the Operations
"on order" rendering, and the map label — this slice only makes the data exist.

## As built — CLIENT slice A (2.1d, the TRADE-tab buy view)

✅ **BUILT — the buy view half of the client.** The TRADE tab's "4 · Constructed" tier tab is now
live and renders the Syndicate asset-commission view (`client/game.html`, built to
`docs/mockups/trade-4constructed.html`).
- **Snapshot quote** — additive, derived-on-read: `snapshot.assetPurchaseQuote` = `{ <kind>:
  { price, buildTicks } }` for each `BUILDABLE_ASSET_KINDS`, off the engine's own
  `priceAssetForPurchase(state, kind, state.tick)` + `BUILD_TICKS[kind]`. No serialized byte, no
  schema bump, no golden move — an unbought galaxy still serializes byte-identically. The client
  renders the price and build time; it prices nothing (§5). The delivery leg of the arrival estimate
  is NOT added here — the client reads it from the same per-system route quote the goods buy uses
  (`guilds[].fuelCost[dest].travelTicks`).
- **The view** — tier 4 is always live (an asset is bought, not held, so it needs no goods or
  dockyard); `T.tier === 4` renders the five panels in place of the goods floor and hides the
  resource-chip row. Commission-Assets menu (per kind: price + Build/Delivery/arrival stat, Add →
  the confirm popup) · In Progress (this guild's `syndicateBuilds`, parallel, soonest-arrival first,
  a % complete each) · Current Build donut (the soonest build's BUILD countdown + %, no parts and no
  pending state, IDLE when nothing builds) · Building art (follows the soonest build) · SYNDICATE
  BUILDYARD hero. Every price/day-count/%/arrival is a display derivation of `assetPurchaseQuote` /
  `syndicateBuilds` / the route quote.
- **Add → confirm → buy** — the menu's Add opens `window.__adviserConfirm` (the `#est-reel` adviser
  card) restating the ¢ cost + build/delivery/arrival; onConfirm fires `buyAssetFromSyndicate`
  (`{ guildId, assetKind, destinationSystemId: <home>, issueTick }`) via the SAME action-post path
  the goods buy uses. Destination is the single home system (no picker this slice — multi-system is
  2.2). The engine's refusal surfaces as an amber note; it is never pre-guessed.

**Client slice B (built):** the Operations "In Transit" manifest now NAMES an asset delivery —
`rowHtml` branches on `sh.assetKind` and renders one `<kind> asset` row ("Miner Asset" / "Factory
Asset" via the existing `.ops-manrow .g` capitalize rule) instead of the goods-cargo loop's "No
cargo listed." empty case; a goods delivery's manifest is unchanged. This slice's In Progress
(slice A) shows only the BUILD phase (`syndicateBuilds`); once a build completes it leaves that
list and appears here as a normal delivery. *Still deferred (unbuilt): the Operations "on order"
indicator surfacing a build BEFORE it ships — a still-building asset stays in the TRADE tab's In
Progress and is deliberately not surfaced in Operations until it is actually in transit.*

<!-- asset-purchase-doc-sentinel v1 -->
