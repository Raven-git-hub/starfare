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

Buildable vs sellable — two catalogs. The dockyard can BUILD every kind that has a recipe
(`sim/asset-recipes.js` `BUILDABLE_KINDS`): miner, factory, and the four guild transports
(light / medium / heavy / spycraft). The Syndicate SELLS a narrower set — see §"What the
Syndicate sells" below. The outpost / scanner / toll-gate / droid kinds follow when their
entities and recipes exist.

## What the Syndicate sells — sellable ⊂ buildable (RULED 22-09-26)

The Syndicate sells every BUILDABLE kind **except `spycraft`**. Spycraft is a
**guild-build-only** asset: a guild constructs it at its own dockyard (parts + time), and it is
**never** sold by the Syndicate and **not tradeable** on the open market. The two acquisition
catalogs deliberately DIVERGE at spycraft:

- **Build catalog** — the dockyard (`GET /asset-recipes` → the System Production Console): the
  full `BUILDABLE_KINDS` — miner, factory, light / medium / heavy transport, **and spycraft**.
- **Sell catalog** — the Syndicate buy (the `assetPurchaseQuote` snapshot block + the
  `buyAssetFromSyndicate` gate): a new **`SYNDICATE_SELLABLE_KINDS`** = `BUILDABLE_KINDS` **minus
  `spycraft`** — miner, factory, light / medium / heavy transport (five kinds).

`SYNDICATE_SELLABLE_KINDS` is the one authoritative set for "what the Syndicate sells": the buy
gate **refuses** any kind outside it (a spycraft buy is refused loudly, not merely hidden from
the UI), and the TRADE tab's Constructed view renders exactly it (it iterates the quote). The
build gate and `/asset-recipes` keep the full `BUILDABLE_KINDS`, so a guild can still build
spycraft itself. `spycraft`'s `VEHICLE_BUY_BASELINE` entry goes **dormant** — no buy path prices
it any more — retained, not read by the sell path. Narrative: stealth craft are something a
guild makes in the dark, not something it orders from the institution.

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

## Cancelling a queued commission — refund the baseline, forfeit the fuel (RULED 26-09-26)

A guild may CANCEL a Syndicate commission that has **not started building** — every queued entry,
and a head that has not yet begun its countdown (`remainingTicks == null`). A commission that is
**underway** (its `remainingTicks` is counting down) cannot be cancelled: the Syndicate is already
building it. The action is `cancelSyndicateCommission`, addressing one entry by a **stable
`commissionId`** stamped on it at buy time (a per-guild counter, never an array index — the
dockyard's `cancelCommission` precedent, `build-yard.md` §3).

On cancel:

- **Credits — refund the kind's BASELINE, not the price paid.** The guild is returned
  `VEHICLE_BUY_BASELINE[kind]` for a transport, else `ASSET_PURCHASE_FLOOR` (12M) for miner/factory
  — the same `baseline` term the purchase price is `max(baseline, …)` of. When the pricing formula
  ever lifts the paid price above the baseline (the `partsCost × 0.8` branch), the Syndicate KEEPS
  that premium; at today's parts scale the baseline binds, so the refund equals what was paid. The
  refund REVERSES the buy's ledger move (`guild.credits += baseline; syndicate.ledger -= baseline`),
  so credit conservation (invariant 2) holds by construction.
- **Fuel — FORFEIT.** The delivery flight's fuel was burned out of the galaxy up front; a cancel
  does NOT return it (the fuel stays consumed, invariant 1 untouched). Cancelling therefore costs
  the whole prepaid flight — a real, deliberate cost that discourages queue-stuffing.

The entry leaves `state.syndicateBuilds`; the queue stays omit-when-empty (the key is deleted when
the last entry goes). Only the OWNING guild may cancel its own commission.

## The queue cap — at most 10 pending per guild (RULED 26-09-26)

A guild's Syndicate commission queue is capped at **`SYNDICATE_QUEUE_MAX` (10, `phase-1-tuning.md`)**
— the WHOLE per-guild queue counts, the one building plus those waiting (mirroring how the dockyard's
`MAX_QUEUE` counts `buildQueue.length`). An 11th `buyAssetFromSyndicate` is refused loudly at intake,
exactly as a dockyard refuses a 6th commission. (The dockyard's own cap stays 5; the Syndicate's is a
separate, per-guild number.)

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
- **Two-phase build→deliver** — `stepSyndicateBuilds` (`sim/tick.js` step 4, scheduled events) advances
  each guild's PER-GUILD SINGLE-SLOT queue: only the HEAD builds, counting down its `BUILD_TICKS`, and on
  completion it promotes to a standard §6 delivery shipment carrying an `assetKind` marker and leaves the
  queue so the next entry starts on the following tick. `stepArrivals` mints one idle asset (the dockyard's
  exact `assetId`/`nextAssetNumber`/`createAsset` pattern) at the destination on arrival, guarding a
  vanished owner by dropping the shipment. *(Superseded the original PARALLEL "promote at an absolute
  `buildDoneTick`" model in the 2.1d ENGINE sequential slice — see §"Build concurrency".)*
- **Snapshot** — additive, derived-on-read: `snapshot.syndicateBuilds` (the on-order indicator, now the
  per-guild queue with a `building` flag on each guild's head, the stored `remainingTicks`, and a
  queue-aware `ticksRemaining`) + an `assetKind` field on an asset shipment's transit row. No serialized
  byte, no golden move.

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
  the confirm popup) · In Progress (this guild's `syndicateBuilds`, sorted by `ticksRemaining`, a %
  complete each) · Current Build donut (the soonest build's BUILD countdown + %, no parts, IDLE when
  nothing builds) · Building art (follows the soonest build) · SYNDICATE BUILDYARD hero. Every
  price/day-count/%/arrival is a display derivation of `assetPurchaseQuote` / `syndicateBuilds` /
  the route quote.
  *(Superseded framing: this view was built against the PARALLEL engine, where every build counted
  down at once and the panel showed them soonest-arrival first with no head/queued distinction. The
  2.1d ENGINE sequential slice made the queue per-guild single-slot — only the head builds — and the
  snapshot now carries a `building` flag on each guild's head plus a queue-aware `ticksRemaining`, so
  sorting by `ticksRemaining` still renders a correct staggered list with the donut on the head. The
  client's own visual rework — marking the head "building" vs the rest "queued" off that flag — is the
  NEXT slice; this view keeps working off `ticksRemaining` until then. See §"Build concurrency".)*
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

## As built — the SELL/BUILD catalog divergence (2.1d/2.2, 22-09-26)

✅ **BUILT — the ruling above, in the engine + server (no client change).** `sim/asset-recipes.js`
now defines and exports **`SYNDICATE_SELLABLE_KINDS`** — an explicit frozen list (the two ground
assets + the three cargo transports), `BUILDABLE_KINDS` minus `spycraft` — and also exports the
merged **`ALL_BILLS`** catalog. The two catalogs now diverge exactly where the ruling says:

- **Sell path** reads `SYNDICATE_SELLABLE_KINDS`, not `BUILDABLE_KINDS`. `buyAssetFromSyndicate`'s
  gate (`sim/actions.js`) refuses any kind outside it — a spycraft buy is refused **loudly**,
  naming it guild-build-only. The snapshot's `assetPurchaseQuote` (`sim/snapshot.js`) maps over the
  sellable set, so it carries exactly the five kinds (spycraft absent) and the TRADE tab's
  Constructed view — which iterates the quote — shows exactly those five with **no client change**.
- **Build path** keeps the full `BUILDABLE_KINDS`. `commissionBuild`'s gate is untouched (a guild
  builds all six), and `GET /asset-recipes` (`sim/server.js`) now serves `{ bills: ALL_BILLS,
  buildable: BUILDABLE_KINDS, … }` — all six kinds with every bill — so the System Production
  Console builds any recipe, spycraft included. The dockyard mint path was already kind-general
  (`mintFinishedKind` branches a vehicle into `guild.vehicles`); this slice added no mint logic,
  only a tripwire proving a dockyard builds a transport AND spycraft end-to-end into `guild.vehicles`.

No serialized state moved (gate/derive/endpoint changes only) — a galaxy that neither buys nor
builds serializes byte-identically (goldens unchanged). `spycraft`'s `VEHICLE_BUY_BASELINE` entry is
now **dormant** on the sell path, retained but no longer read to price a sale.

## As built — the queue cap + cancelling a commission (2.1d, ENGINE slice, 26-09-26)

✅ **BUILT — §"The queue cap" and §"Cancelling a queued commission", engine + snapshot only (no
client).** Every number is sourced: `SYNDICATE_QUEUE_MAX` (10) from `phase-1-tuning.md`, the refund
from the existing baselines. None was invented.

- **The constant + one baseline** (`sim/asset-recipes.js`): `SYNDICATE_QUEUE_MAX = 10`, and
  `assetPurchaseBaseline(kind)` = `VEHICLE_BUY_BASELINE[kind] ?? ASSET_PURCHASE_FLOOR`. This helper
  is the only definition of "baseline". `priceAssetForPurchase` now calls it for its
  `max(baseline, …)`, and the cancel refund calls it too, so the price floor and the refund cannot
  drift apart.
- **A stable id on every commission.** The `buyAssetFromSyndicate` apply stamps a `commissionId` on
  each `syndicateBuilds` entry. It comes from a per-guild counter, `guild.syndicateCommissionSerial`,
  read through `nextSyndicateCommissionId` and following the `vehicleSerial` / `nextVehicleSerial`
  pattern: ids start at 1 and only ever count up, so a cancel or ship-out never shifts or reissues
  one. The counter is written only when a guild first commissions (`createGuild` omits it at 0), so
  a guild that never commissions carries no new byte. `boughtTick` is unchanged. `stepSyndicateBuilds`
  is unchanged too: it carries the new field along without reading it.
- **The cap** (`buyAssetFromSyndicate` validate): the gate counts the guild's own entries (filtered by
  `ownerGuildId`, so the building head counts) and refuses at `>= SYNDICATE_QUEUE_MAX`, naming
  the count (`… queue is full (10/10)`). It runs after the kind and destination gates and before
  the credits and fuel gates, so a full queue is blamed on the cap, not on affordability. The
  dockyard's `MAX_QUEUE` (5) is unchanged.
- **The cancel** — `cancelSyndicateCommission { guildId, commissionId }`, built by
  `createCancelSyndicateCommissionAction`.
  - *Validate* refuses, each with its own reason, when: the guild does not exist; the id is not a
    positive integer; no entry with that id is owned by this guild (only the owner may cancel); or
    the entry has `remainingTicks != null`, meaning it is underway ("a commission already under
    construction cannot be cancelled"). A head that has counted down to 0 but not yet shipped
    counts as underway.
  - *Apply* removes the entry and refunds `assetPurchaseBaseline(kind)`: guild credits go up and
    the ledger goes down by the same integer, reversing the buy's ledger move, and the Syndicate
    keeps any premium above the baseline. Fuel and `audit.totalConsumed` are not touched, so the
    delivery fuel is forfeit. The apply deletes `syndicateBuilds` when it empties and refreshes
    `galacticSupply`, the same refresh the buy makes, so `POST /action`'s invariant check passes
    with no tick between.
- **Snapshot** (derived on read, no serialized byte): each `syndicateBuilds` row gains `commissionId`
  and `cancellable`. `cancellable` is true only when the entry has an id and `remainingTicks == null`,
  the same two conditions validate checks, so the client never offers a cancel the engine would refuse.
- **An entry bought before this slice** has no `commissionId`. The snapshot shows it with
  `commissionId: null` and `cancellable: false`. The validate's integer check runs before the lookup,
  so no cancel can match such an entry. It still builds, ships and mints normally.
- **Observation, not a new decision:** under the per-tier price bands (RULED 26-09-26), every sellable
  kind's parts cost at the Tier-3 **ceiling**, times 0.8, stays far below its baseline (a miner's comes
  to about 0.8M against the 12M floor). So the `partsCost × 0.8` branch cannot bind today, and a cancel
  refund always equals the price paid. The premium rule is live in code and pinned by a test that
  hand-sets out-of-band prices.

Tripwires: `sim/tests/syndicate-queue-cancel.test.js` (23 tests: the cap, stable ids, cancel and
refund, fuel forfeit, FIFO order kept, the empty key deleted, underway and non-owner refusals,
conservation, the premium kept, snapshot fields, an entry bought before this slice, no-op and
determinism), plus the re-pinned entry shape in `sim/tests/asset-purchase.test.js`. **Deferred to
the CLIENT slice:** the cancel controls in the TRADE tab's Constructed view (`client/game.html`) and
`client/console.html`, which read `cancellable`.

<!-- asset-purchase-doc-sentinel v1 -->
