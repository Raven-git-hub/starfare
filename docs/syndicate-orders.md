# Syndicate orders — the buy/sell order model (design-ahead, RULED 16-09-26)

*A Syndicate trade is now placed as an **order** the guild assembles line by line, then finalises — not a
one-shot. This doc is the source of truth for the order model; it sits on top of the transaction rules in
`transport-model.md` §8 and the cargo-space hauler in §5.1, and it supersedes the single-good BUY and the
one-good/many-systems SELL those sections describe as built. The repo wins over this doc.*

## 1. What it is

The guild builds up a **buy order** (goods to acquire, delivered to one destination) and a **sell order**
(goods to offload, shipped from one origin) by hitting **Add to Buy/Sell Order** on the trade floor as it
browses goods, then **finalises** each in the transaction popup. Buy and sell are the two mirror halves of
one model: many goods, one leg, one hauler sized by the order's total **cargo space** (§5.1).

## 2. The order is engine state (§18), not a browser draft

An order-in-progress is **game state**, and this engine's contract is that the engine owns state and the
client only renders it (`design.md` §18). Every other meaningful thing — the fuel hoard, ventures,
in-flight shipments, the dockyard queue — is engine state; a half-built order is the same kind of thing.
A browser-only draft would be the one piece of state living outside the engine — the seam that rots — and
it would force the client to compute the order's cargo space and hauler tier itself, which §18 forbids.
So the order lives in the engine, and the engine publishes its computed space/tier/fuel for the client to
**render**.

Each guild carries, **omit-when-empty** (an untouched guild serializes byte-identical, the same discipline
as `assets`):

    guild.buyOrder  = { lines: [ { good, qty }, ... ] }
    guild.sellOrder = { lines: [ { good, qty }, ... ] }

- **One line per good.** Adding a good already in the order **tops up** its qty (§5.1 "each good once");
  the `cargo` map a finalise builds is then unambiguous.
- **Integer qty > 0** (§15.2). Lines are kept in a **stable, deterministic order** (sorted by good id,
  invariant 9) so the serialized order and every derived sum are reproducible.
- **No target is stored.** The **destination** (buy) / **origin** (sell) is a *finalise-time* choice made
  in the popup — it is not built up across the trade floor, so it is not part of the draft. The **lines**
  are the thing worth persisting; the target is re-picked each time the popup opens.

## 3. The actions (build the order)

> **AS-BUILT (engine slice, Phase 2).** The state (§2) and these three actions are BUILT in
> `sim/state.js` (`createGuild` threads `buyOrder`/`sellOrder` omit-when-empty via `cloneOrder`,
> the `assets` discipline) and `sim/actions.js` (`addOrderLine` / `removeOrderLine` / `clearOrder`
> with their creators, validate and apply). `addOrderLine` tops up a repeated good and keeps lines
> sorted by good id; `removeOrderLine` omits the order when it empties and fails loud on a missing
> line; `clearOrder` is idempotent. `checkOrders` (`sim/invariants.js`) is the tripwire — lines
> sorted, unique, priced-and-not-fuel, positive-int. NO tick is stored on the order: §2/§4 pin its
> shape as `{ lines: [{ good, qty }] }` (with `space` added only in the snapshot), which has no
> field for one — see the decision note in the build report; the CLIENT is a later slice (§8).

- **`addOrderLine({ guildId, side, good, qty })`** — `side` ∈ `buy | sell`. Appends the good or tops up its
  existing line. Validates: `good` is a priced good (not fuel, `prices.js` `PRICED_GOODS`); `qty` a positive
  integer. It does **not** gate on capacity or on stock — a draft may be built past a hauler's hold and
  trimmed later, and a sell line's origin (hence its stock) is not known until finalise. Records its tick.
- **`removeOrderLine({ guildId, side, good })`** — drops a line.
- **`clearOrder({ guildId, side })`** — empties the order (also what a successful finalise does).

An order may therefore exceed the heavy hold while being built; that is a **shown state**, not an error
(see §4/§5). A guild deleted (torn down) takes its orders with it — no orphan.

## 4. What the snapshot publishes (engine computes; client renders)

> **AS-BUILT (engine slice, Phase 2).** BUILT in `sim/snapshot.js` (`orderSnapshot`): each guild
> row gains `buyOrder`/`sellOrder` = `{ lines:[{good,qty,space}], totalUnits, totalSpace, haulerTier,
> overCap }`, present only when the guild has that order (omit-when-empty). `space` = `qty ×
> volumeOf(good)`; `haulerTier` = `haulerTierForSpace(totalSpace)` (null when over cap); `overCap`
> = `totalSpace > HEAVY_HOLD`. Pure derived telemetry — no serialized byte, no determinism hash, no
> schema-version bump (additive, like `goodVolumes`/`haulerTiers`).

Each guild row publishes its two orders, **echoed with the engine-computed derived fields** so the client
performs no space/tier arithmetic (§18):

    buyOrder / sellOrder: {
      lines: [ { good, qty, space } ],   // space = qty × volumeOf(good) — engine-computed per line
      totalUnits, totalSpace,            // Σ
      haulerTier,                        // 'light' | 'medium' | 'heavy'  (the smallest hold that fits)
      overCap                            // true when totalSpace > the heavy hold (6,000,000)
    }

Derived-on-read from `guild.buyOrder`/`sellOrder` + `fuel.js` (`volumeOf`, `haulerTierForSpace`, the tier
table) — **no stored byte, no determinism hash** (like the existing `fuelCost` block, PR #89). The route
**fuel** for a chosen target reads the per-system `fuelCost[sys].fuelBurnByTier[haulerTier]` the snapshot
already carries. The trade-floor gauge and the finalise popup render these; they compute nothing.

## 5. Finalise (commit the order)

> **AS-BUILT (engine slice, Phase 2; legacy paths RETIRED in the cleanup slice).** BUILT in
> `sim/actions.js`, now SINGLE-PATH — the held-order finalise. `buyFromSyndicate({ guildId,
> destinationSystemId, issueTick })` reads `guild.buyOrder.lines`, delivers to `destinationSystemId`
> on one space-tiered leg, and clears `buyOrder` on success. `sellToSyndicate({ guildId,
> originSystemId, issueTick })` reads `guild.sellOrder.lines`, sells them from that one origin on ONE
> space-tiered leg (origin → nearest waystation), credits Σ `round(qty × quotedPrice)` per line,
> removes the stock, and clears `sellOrder` — immediate settlement, no shipment. Both reject-whole on
> the aggregate: capacity (total space > `HEAVY_HOLD`), credits (BUY), fuel hoard (both), destination
> held (BUY), origin holds each line's stock (SELL, naming short lines), and the §8.1 quote-lock. An
> empty held order is refused; a reject-whole leaves the draft untouched (never reaches apply).
> **RETIRED (cleanup slice):** the transitional dual-mode intake — the inline `cart`/`good` BUY and
> the `allocations` multi-system SELL, kept for backward-compat through the client slice — is GONE,
> along with its `createBuyFromSyndicateAction`/`createSellToSyndicateAction` legacy parameters and
> the `buyIsHeldOrder`/inline-`cart` helpers. The held-order behaviour above is byte-for-byte
> unchanged; only the dead intake was removed (§8).
> *(⤳ §9, 03/04-10-26: the target is now a NODE. `sellToSyndicate` also takes `originOutpostId` (slice 1a,
> §9.2 AS-BUILT) and `buyFromSyndicate` also takes `destinationOutpostId` (slice 1b, §9.1 / §9.4 AS-BUILT),
> each as an exactly-one-of alternative to the system field. The system paths above are unchanged.)*
> *(⤳ §9.2, 04-10-26: `sellToSyndicate` takes an inline `cart` again. It is a NEW path for the Outpost Manager's
> sale, not the retired intake revived: it sells the cart and never touches `sellOrder`. BUY's inline cart and the
> `allocations` SELL stay retired.)*

The transaction popup's confirm **finalises the held order** — this is the permanent shape of
`buyFromSyndicate` / `sellToSyndicate`, replacing PR #89's inline-cart BUY and the multi-system SELL:

- **`buyFromSyndicate({ guildId, destinationSystemId, issueTick })`** — reads `guild.buyOrder.lines`,
  delivers the whole multi-good cart to `destinationSystemId` on one space-tiered leg (§5.1/§8.0), debits
  Σ `round(qty × quotedPrice(good, issueTick))`, schedules ONE shipment, and **clears `buyOrder`**.
- **`sellToSyndicate({ guildId, originSystemId, issueTick })`** — reads `guild.sellOrder.lines`, sells them
  from `originSystemId` on one space-tiered leg to its nearest waystation, credits Σ proceeds, removes the
  stock, and **clears `sellOrder`**. Immediate settlement — no shipment ("sold goods leave the moment you
  place them").
- Both **reject-whole on the aggregate** (`transport-model.md` §8.0), now including the **capacity gate**:
  an order whose total space exceeds the heavy hold is refused with a split-the-order message. Plus the
  existing gates — credits (BUY), fuel hoard (both), destination held (BUY), **origin holds the stock**
  (SELL, per line), and the **§8.1 quote-lock** (prices freeze when the popup opens; the confirm carries
  the `issueTick`; TTL + cycle-boundary expiry → re-quote). An **empty** order cannot be finalised. On
  reject-whole the draft is **untouched**, so the player trims and retries.

## 6. The trade UI (client slice)

> **AS-BUILT (client slice, Phase 2 — DONE).** BUILT in `client/game.html` (the `trade-tab-wire`
> block), client-only — no `sim/` change, so every determinism/persisted golden is byte-identical
> and the full suite is unchanged (1298 tests green). What landed:
> - **Syndicate Trade card:** both panes collapse to one shape — a quantity for the selected good +
>   an **Add to Sell/Buy Order** button that posts `addOrderLine({ side, good, qty })`. The retired
>   per-system SELL basket (`tw-sysalloc`, the `Max`/allocation UI) is gone from the card; the card
>   keeps no local basket and no cost/fuel preview — the order is engine state, rendered from the poll.
> - **The two hero buttons** on the "Syndicate Exchange" hero (`tw-thero`), **Buy Order** / **Sell
>   Order**, each badged with the snapshot order's line-count + `totalSpace` (absent ⇒ "empty",
>   disabled; `overCap` flagged). Clicking opens the finalise popup for that side.
> - **The finalise popup** (`#tw-tx-overlay`): the two-column **Qty | Resource** fixed-height scroll
>   manifest read from `order.lines` (per-line `space`, a per-row remove ✕ → `removeOrderLine`); the
>   finalise-time **target** (BUY *Deliver to* destination / SELL *Ship from* origin) over the held
>   systems; the hero art + **`TIER · used / hold`** tag driven by `order.haulerTier`; the ledger
>   (cost/proceeds, treasury, route fuel `fuelCost[target].{fuelBurnByTier,creditCostByTier}[tier]`,
>   the fuel-hoard bar, and — BUY only — arrival `fuelCost[target].travelTicks`); the **over-capacity**
>   split-the-order state (confirm disabled); and the §8.1 quote-lock (freeze at open, `issueTick` on
>   confirm). Confirm posts the held-order finalise — BUY `buyFromSyndicate({ destinationSystemId,
>   issueTick })`, SELL `sellToSyndicate({ originSystemId, issueTick })` — no `cart`/`good`/`allocations`.
> - Verified by the served-bytes tripwire (`sim/tests/server.test.js`) and a headless-Chromium
>   end-to-end (build a two-good buy order → manifest + tier + route fuel + arrival → confirm →
>   order empties; a one-origin sell; an over-cap build with confirm disabled).
>
> STILL REMAINING (unchanged from §8): (1) **retiring the legacy engine paths** — DONE (cleanup
> slice): the inline `cart`/`good` BUY and the `allocations` SELL have been removed; the finalise is
> single-path (the held order) and the client already sent only that. (2) The **SELL origin-picker
> helper** (§7) — this slice offers every held system and lets the engine's stock gate reject-whole
> with the named shortfall; offering only systems that hold every line (or per-line availability) is
> a later refinement.
> The client computes no game number (§18): space, tier, fuel, cost and arrival are all read from the snapshot.

- **Syndicate Trade card:** the Sell/Buy toggle's action button becomes **Add to Sell Order** /
  **Add to Buy Order** (calls `addOrderLine` for the selected good + qty). The card's mechanics — pick a
  good in the rail, its price chart, set a qty — are unchanged.
- **Right "Syndicate Exchange" hero (`tw-thero`):** two buttons at the top, **Buy Order** and
  **Sell Order**, each badged with its line-count / total space; clicking opens the finalise popup for that
  order.
- **The finalise popup** (`#tw-tx-overlay`, both sides): the manifest as a two-column **Qty | Resource**
  fixed-height **scroll box** (a long order never resizes the popup); the right hero shows the transport
  art + a tag by the order's cargo-space tier; the ledger carries cost/proceeds, treasury, route fuel, the
  fuel-hoard bar, and — **BUY only** — **arrival time** (SELL settles immediately, so no arrival row). An
  **over-capacity** order shows the split-the-order state with confirm disabled.

## 7. Failure modes (hunted on paper — working practice #7)

- **Over the hold** — allowed while building; the order shows `overCap`; finalise reject-wholes with the
  split-the-order message. (A sanity bound on a single absurd `qty` can be added if play shows the need —
  deferred, not invented.)
- **Price moves between add and finalise** — the §8.1 quote-lock freezes at popup-open and re-derives at
  the issue tick; past the window the popup shows expired and re-quotes. The order itself holds only
  goods + qtys, never a price.
- **SELL from an origin that lacks the stock** — a real friction of one-origin/multi-good: the goods in a
  sell order may not all sit in one system. Finalise **reject-wholes** naming the short lines; the draft is
  untouched. The client's origin picker should help — offer systems that hold the order's goods, or show
  per-line availability (a client-slice refinement, flagged here).
- **Destination lost / not held at finalise (BUY)** — the territory gate reject-wholes.
- **Reload / device switch mid-build** — the order persists, like all state (the whole point of §2).
- **Empty order finalise** — refused. **Buy and sell orders coexist** independently per guild.

## 8. Build sequence

Engine slice first — the `buyOrder`/`sellOrder` state + the three build actions + finalise reading the held
order + the snapshot publish + the SELL re-axe (single origin). The deployed single-good BUY / multi-system
SELL kept working through the engine slice (backward-compat) and were retired once the client switched. Then
the **client slice** — the Add-to-Order wiring, the two hero buttons, and the adjusted popups. Both spelled
out in their build prompts; the mockups land in `docs/mockups/` with the client slice as its visual contract.
Finally the **cleanup slice** — the transitional legacy paths removed (DONE, see below).

> **AS-BUILT (engine slice, Phase 2 — DONE; client + cleanup slices — DONE).** The engine slice is
> built and green (state, the three build actions, the finalise incl. the single-origin SELL re-axe,
> the snapshot publish, the `checkOrders` tripwire). The **client slice** landed (§6). The **cleanup
> slice** is now DONE: the transitional legacy finalise paths — the inline `cart`/`good` BUY and the
> multi-system `allocations` SELL — have been **RETIRED** from `sim/actions.js` (the dual-mode
> branches, the legacy creator parameters, and the `buyIsHeldOrder`/inline-`cart` helpers are gone),
> the finalise is single-path (the held order), and the tests that drove behaviour through the
> retired shapes were migrated onto the held-order path (`sim/tests/`: `sell.test.js`,
> `cargo-space.test.js`, `buy.test.js`, `fuel-burn.test.js`, `sell-fuel-burn.test.js`,
> `quote-lock.test.js`, `fuel-cost.test.js`, `transport-visibility.test.js`,
> `deuterium-refinery.test.js`; the two legacy-parity tests in `syndicate-orders.test.js` removed).
> The held-order behaviour is byte-for-byte unchanged; the full suite is green and every
> determinism/persist golden is byte-identical. NOTHING REMAINING for the order model except the
> optional origin-picker refinement flagged in §6/§7.

## 9. Trading from outposts — the node-target model (RULED 03-10-26)

Outposts are deployable (roadmap 2.2, the deploy pipeline) and carry a real, capacity-bounded stockpile
(`stockpile`; cap `OUTPOST_CAPACITY = 30 × HEAVY_HOLD`; `used = usedSpace(stockpile)`). This section extends
the buy/sell order model (§1–§7) so the Syndicate trades **to and from an outpost**, not only a held system.
The order itself (§2–§4) is unchanged — goods + qtys, engine state; what changes is the finalise TARGET and
the fuel leg.

**A node is a system OR an outpost.** Both BUY and SELL finalise against a **node the guild holds** — a held
system (the claim) or one of the guild's own outposts (a single controlled hex). Everywhere §5 says
"destination system" / "origin system", read **destination node / origin node**. The gate that the target is
the guild's is the node check: a system by its claim, an outpost by `ownerGuildId`.

**The fuel leg generalises from a system to a node's hex.** Today `vehicleDeliveryFuelBurn` and the snapshot
`fuelCost` block key off a *system* and its `nearestWaystation(systemId)`. The leg is really
*node-hex → nearest waystation* (SELL) / *waystation → node-hex* (BUY). Compute it from the node's **coords**
(a system's centre hex, an outpost's hex), so an outpost far from any waystation costs more fuel to trade
through than one beside it — the emergent cost of where it was planted. The per-node fuel/delivery telemetry
(`fuelBurnByTier` / `creditCostByTier` / `travelTicks`) is published for outposts too, the same additive,
hash-free way it already is for systems (§4) — no determinism byte, no schema bump.

> **AS-BUILT (engine slice 1a, 03-10-26) — the fuel leg from a node's hex, and its telemetry.**
> - **The leg.** The waystation search now takes a hex: `nearestWaystationToHex(hex)` (`sim/transport.js`), with
>   `routeFuelCostFromHex(hex, space)` and `routeFuelBurnByTierFromHex(hex)` (`sim/fuel.js`) beside it. The system
>   forms (`nearestWaystation(systemId)`, `routeFuelCost`, `routeFuelBurnByTier`) look up the system's centre hex
>   (`systemHex`) and hand it to the hex form, so a system's leg is unchanged. A test checks this against the old
>   search for every seed system at every tier boundary, and the BUY and asset paths still call the system forms.
>   `vehicleDeliveryFuelBurn` (a bought craft flying itself in, BUY-side) is not touched. *(⤳ slice 1b: the goods BUY
>   now calls the hex forms too, through `buyDestination` (§9.1 AS-BUILT). A system's hex is its centre hex, so its
>   leg, burn and arrival tick are the same numbers as before. The asset buy still calls the system forms.)*
> - **The telemetry.** Each guild row gains **`outpostFuelCost`**: one entry per Outpost the guild owns, keyed by
>   outpost id and sorted. The entry has the same shape as a system's (`fuelBurn`, `creditCost`, `travelTicks`,
>   `vehicleTravelTicks`, `fuelBurnByTier`, `creditCostByTier`) and is measured from the Outpost's own hex. One
>   helper, `routeQuoteFor(hex, fuelPrice)` (`sim/snapshot.js`), builds both maps, so the shapes cannot drift. It
>   is derived telemetry: no stored byte, no determinism hash, no schema bump, and the key is omitted for a guild
>   with no Outpost.
> - **Why a sibling key, not more `fuelCost` keys.** The live client reads `fuelCost`'s keys as the list of
>   systems the guild holds (`txHeldSystems`, which fills the BUY "Deliver to" and SELL "Ship from" dropdowns). An
>   Outpost id there would show up as a target the engine then refuses. So `fuelCost` stays exactly the held
>   systems, and a test pins that. Whether to merge the two maps (one map keyed by node id, the "one ordering" of
>   §9.1) once the client stops reading `fuelCost`'s keys that way is on the roadmap decision checklist.

### 9.1 BUY — the Syndicate delivers to the nearest node by default, overridable

> **AS-BUILT (engine slice 1b, 04-10-26) — the engine BUY half.** `buyFromSyndicate` (`sim/actions.js`) now
> delivers to a held system or to one of the guild's own Outposts. The client is a later slice, so the
> default-nearest target and the override picker below are not built yet; the engine takes whichever node it is given.
> - **The destination shape.** The action takes **exactly one** of `destinationSystemId` (unchanged, and still what
>   the live client sends) or **`destinationOutpostId`** (new), the mirror of 1a's `originSystemId` /
>   `originOutpostId`. Both, or an empty id, is refused. Neither gets the old `destinationSystemId must be a
>   non-empty string`. `createBuyFromSyndicateAction` puts only the field given into the action, so a system buy's
>   action is exactly what it was.
> - **One destination reader.** `buyDestination(state, guild, action)`, beside 1a's `sellOrigin`, is the one place a
>   system and an Outpost differ: the node's id, its hex, the destination field the shipment carries
>   (`{ destinationSystemId }` or `{ destinationOutpostId }`), and its free space right now (`Infinity` for a system,
>   which is uncapped; the Outpost's `capacity − usedSpace(stockpile)` otherwise). Validate and apply both read it, so
>   the hex the fuel gate prices is the hex apply burns for and times the flight from, and the node on the shipment
>   is the node validate gated.
> - **The gates, for an Outpost destination.** *Node held:* the Outpost exists and its `ownerGuildId` is this guild,
>   else `guild "…" owns no outpost "…" to deliver to`. This also covers an Outpost torn down between the popup
>   opening and the confirm (§9.4). *No capacity gate:* a buy to a full, or too-full, Outpost is accepted and departs
>   (the ruling above). *Fuel:* the leg runs from the nearest waystation to the Outpost's hex. The hauler-hold cap, the
>   credits gate and the §8.1 quote-lock work on the whole order, whatever the destination, and are unchanged. The
>   gates run in the same order as before, so a system buy is refused for the same reason it always was.
> - **Apply.** Credits move to the ledger and one leg is burned, as for a system. ONE shipment is scheduled:
>   `{ ownerGuildId, cargo, destinationOutpostId, arrivalTick }`. The Outpost field takes the system field's place in
>   the record, and `arrivalTick` comes from the Outpost's own leg. A system shipment is the same record it always was.
> - **The departure space-warning.** When the order's space is more than the Outpost's free space at that moment,
>   apply writes a **`delivery_space_warning`** notice on the departure tick (`docs/event-log.md` §11). A system is
>   never warned. The warning reads the stockpile as it stands and does **not** count other deliveries already flying
>   to the Outpost, so a buy that fits now can still be turned back, unwarned, if the guild fills the Outpost while it
>   is in transit (§9.4).
> - **No reservation, no hold, no fine** — those were ruled out. The cash and fuel are spent at departure either way.
> - Tests: `sim/tests/buy-to-outpost.test.js` (20). Operator path: the existing `POST /action` with
>   `{ type: 'buyFromSyndicate', guildId, destinationOutpostId }`; no new endpoint or CLI verb.

The Syndicate's default drop is the guild's **node nearest a waystation** (the cheapest delivery leg), and
the player **may override** to any held node, paying that node's larger leg. Narratively the Syndicate offers
its own time-efficient drop; carrying goods deeper is the guild's choice, paid in fuel. Pressure, not
prohibition: the default and the fuel price steer toward good trade-route management without forbidding
anything.

- **Default target** = the held node with the shortest *node → nearest-waystation* leg, read from the
  engine-published per-node legs (the client selects the minimum; it computes no game number, §18 — if strict
  §18 wants it, the snapshot may flag the default node rather than let the client pick). **Tie-break:** the
  lower node id, the stable-ordering convention (invariant 9), systems and outposts in one ordering.
- **Override** = any node the guild holds; the ledger's route fuel re-reads that node's leg.
- **Outpost capacity is NOT a placement gate — warn, don't block (REVISED 04-10-26).** A system stockpile is
  uncapped; an **outpost** is bounded by `OUTPOST_CAPACITY`, but a BUY to a full (or too-full) outpost is
  **still allowed to depart**: the Syndicate takes the payment and ships regardless — the player owns the
  space. When the order's space exceeds the outpost's **current free space**, the engine writes a
  **space-warning notice** (an inbox message in the Trader's voice, `docs/event-log.md`) the moment the buy
  departs, so the player can clear room before the delivery lands. Capacity is then judged only **on arrival**
  (9.4, all-or-nothing). An order can never exceed `OUTPOST_CAPACITY` whatever the outpost holds (it is capped
  at one hauler hold, 1/30th of an outpost), so a placement gate would catch nothing arrival does not. (This
  REPLACES the reject-whole placement gate first drafted here on 03-10-26 — the warning model gives the player
  full agency and the jeopardy that goes with it.)
- The existing BUY gates are unchanged: hauler-hold capacity, credits, fuel hoard, destination held, the
  §8.1 quote-lock.

### 9.2 SELL — from a held system (trade tab) or an outpost (its manager)

> **AS-BUILT (engine slice 1a, 03-10-26) — the engine SELL half.** `sellToSyndicate` (`sim/actions.js`) now
> finalises from a held system or from one of the guild's own Outposts. The client is a later slice, so the
> Outpost Manager's SELL and the removal of the origin dropdown are not built yet. *(⤳ 04-10-26: the Outpost
> Manager's SELL is BUILT, sending the inline cart — the client AS-BUILT below. The origin dropdown stays: its
> removal was withdrawn, see SUPERSEDED below.)*
> - **The origin shape.** The action takes **exactly one** of `originSystemId` (unchanged, and still what the live
>   client sends) or **`originOutpostId`** (new). Both, or an empty id, is refused. Neither gets the old
>   `originSystemId must be a non-empty string`. `createSellToSyndicateAction` puts only the field given into the
>   action, so a system sale's action is exactly what it was. A separate field was chosen over a unified
>   `origin: { kind, id }` ref so the system path did not change at all: the same action shape, the same refusal
>   wording, and nothing to migrate.
> - **One origin reader.** `sellOrigin(state, guild, action)` is the one place a system and an Outpost differ: the
>   origin's id, its label in a refusal, its hex, how much of a good it holds, and how sold goods leave it.
>   Validate and apply both read it, so the pile the stock gate checks is the pile apply drains.
> - **The gates, for an Outpost origin.** *Node held:* the Outpost exists and its `ownerGuildId` is this guild,
>   else `guild "…" owns no outpost "…" to sell from`. This also covers an Outpost torn down between the popup
>   opening and the confirm (§9.4). *Stock:* each line is checked against **that Outpost's own `stockpile`**,
>   never the system pool, and the refusal names every short line (§7's shape, reading `in outpost "…"`).
>   *Fuel:* the leg runs from the Outpost's hex to its nearest waystation (§9 AS-BUILT above). The hauler-hold
>   capacity gate and the §8.1 quote-lock work on the whole order, whatever the origin, and are unchanged.
> - **Apply.** Each sold good leaves `outpost.stockpile`: a good sold to 0 loses its key, and a stockpile sold
>   empty loses the `stockpile` key, as the dock step does. Σ `round(qty × quotedPrice)` per line is credited
>   from the ledger. One leg is burned. The order clears. Settlement is immediate, with no shipment. Galactic
>   supply already counts Outpost stockpiles (`sim/supply.js`), and the sale re-derives the cache, so the goods
>   are counted once and sunk once.
> - **No tick stamp on the Outpost.** An Outpost carries no `updatedAtTick` (only `createdAtTick`), and neither
>   the dock step nor the system sale stamps the pile it changes. The sale follows its siblings (§15.2) rather than
>   adding a field. This is flagged on the decision checklist.
> - Tests: `sim/tests/sell-from-outpost.test.js` (13). Operator path: the existing `POST /action` with
>   `{ type: 'sellToSyndicate', guildId, originOutpostId }`; no new endpoint or CLI verb.

SELL finalises from a **node the guild holds**, by one of **two paths** — and the trade-tab SELL built in §6
is **unchanged**: the outpost is an *additional* origin, never a replacement.

- **From the trade tab — a held system (unchanged).** The player builds the held sell order (§3), opens the
  SELL finalise (§6), and chooses a held **system** as the origin from the Ship-from dropdown. Held order,
  immediate settlement, system-hex → nearest waystation. Nothing on this path changes.
- **From an outpost — its manager (new).** The Outpost Manager — read-only today — gains a **Sell to
  Syndicate** affordance, its one write. The origin **is** that outpost (no picker — the player is already
  looking at the pile), drawing only from its `stockpile`. The consignment is built in the manager by picking
  quantities from the outpost's own resource tables (a **MAX** prefill = the held amount of that good); the
  summary occupies the manager's right hero while an order is live — the transport hero by hauler tier, a
  static **"Syndicate Waystation"** label for the drop, the consignment, the proceeds, the fuel cost, and the
  fuel credits remaining, then the **Sell to Syndicate** button — and confirm ships that outpost's goods → its
  nearest waystation, immediate settlement. An **empty outpost offers no SELL** (the affordance is absent/disabled).

Both paths run the identical gates and settlement (§5, and the slice-1a AS-BUILT above): each line stock-gated
against that node's own pile (reject-whole naming any short line, §7), the one-hauler-hold capacity cap, the
§8.1 quote-lock, and the node-hex → nearest-waystation fuel leg; immediate settlement, no shipment. The
player's act is the same in both places — pick quantities, read proceeds and fuel, confirm — differing only in
where it starts.

**The outpost sell is carried to the engine as an inline cart, not the held order — the one engine change the
client half needs.** `sellToSyndicate` gains an inline **`cart`** path (the mirror of `buyFromSyndicate`'s
existing inline cart) carried alongside `originOutpostId`: it reads the cart's lines, runs the same gates and
settlement, and **does not read, write or clear `guild.sellOrder`**. There is only one `guild.sellOrder`, so
this keeps an outpost sale independent of any order the player is mid-way through in the trade tab, and keeps
the outpost draft **ephemeral** — it lives in the manager popup, not in persisted guild state (the right
lifetime for a look-at-the-pile-and-sell-it-now act). The trade-tab system SELL keeps reading the held order
(§5) exactly as before. §18 holds: the summary's proceeds, fuel, consignment space and hauler tier are display
echoes of the engine's own formulas over the published volume/hold tables, and the engine is the authoritative
gate — an order over one hauler hold is reject-wholed at confirm.

> **AS-BUILT (engine: the inline-cart SELL, 04-10-26).** `sellToSyndicate` (`sim/actions.js`) now takes an optional
> **`cart: [{ good, qty }, …]`** beside its origin. The client is a later slice, so the Outpost Manager's SELL is not
> built yet. *(⤳ 04-10-26: BUILT — the client AS-BUILT next.)*
> - **Which path.** The cart's *presence* picks it. An action with a `cart` sells the cart; one without finalises the
>   held order exactly as before. An empty cart, or one that is not an array, is refused (`a SELL cart must carry at
>   least one { good, qty } line`), never read as "no cart", so a bad cart cannot fall through and sell the trade-tab
>   draft. Two small helpers, `sellIsHeldOrder` and `sellFinalizeLines`, give validate and apply the same answer and
>   the same lines.
> - **A correction to the wording above.** `buyFromSyndicate` has no inline cart today: it was retired in the cleanup
>   slice (§5). The SELL cart mirrors how that retired cart worked (its presence rule, its line checks, one reader for
>   validate and apply). BUY is not given a cart back.
> - **The checks.** A cart was never built through `addOrderLine`, so validate first checks what building would have
>   refused: a line that is not an object, fuel, a good twice (`sellCartProblem`, in the words `addOrderLine` and the
>   BUY use). Then the cart goes through the SAME per-line loop and gates as a held order: each good priced, each qty
>   a positive integer, the stock in the origin's own pile (naming every short line, §7), the hauler-hold cap, the fuel
>   leg from the origin's hex, and the §8.1 quote-lock. A malformed cart is refused whole, never deduplicated or
>   coerced. Either origin works, read through `sellOrigin`, unchanged.
> - **Apply.** Settlement is the held order's, line for line: the goods leave the origin (omit-when-empty), Σ
>   `round(qty × quotedPrice)` is credited from the ledger, one leg is burned, galactic supply is re-derived, and no
>   shipment is made. The one difference: **`guild.sellOrder` is not read, written or cleared.** The cart lives only on
>   the action (and so in the journal), never on the guild, so `checkOrders` never sees it. The engine sorts a copy of
>   the cart and leaves the action as it was sent.
> - **Unchanged:** the held-order path (system and Outpost origins), `sellOrigin`, the gates, the leg, the pricing,
>   and `buyFromSyndicate`. There is no `allocations` path to keep: it was retired with the BUY cart (§5).
> - Tests: `sim/tests/sell-cart.test.js` (16). Operator path: the existing `POST /action` with
>   `{ type: 'sellToSyndicate', guildId, originOutpostId, cart: [{ good, qty }, …] }` (or `originSystemId`); no new
>   endpoint or CLI verb.

> **AS-BUILT (client: the Outpost Manager's SELL panel, 04-10-26).** `client/game.html` only; no `sim/` change. The
> Outpost Manager (`#outpost-overlay`) gains its one write, in its own block ("SELL TO SYNDICATE from this Outpost").
> - **The builder.** A resource cell for a good this Outpost holds, and the Syndicate prices, is clickable. It opens
>   into a full-width row: a quantity box (digits only), **MAX** (fills the held amount) and **Add to order**. Add sets
>   that good's line to the box's quantity, clamped to 1..held. It replaces the line rather than topping it up, so
>   re-opening a good edits its line. A good in the draft shows "In order" after its quantity. A 0-held cell is inert,
>   as before. An Outpost with nothing it can sell offers no builder and no summary, and a draft left over when its
>   pile runs out is dropped.
> - **The draft is local.** It lives in the manager's own state for this open only: reset on open and on close,
>   including the self-close when the Outpost is torn down. Nothing is posted until confirm, and `guild.sellOrder` is
>   never read or written, so a trade-tab draft stays as it is. The 1-second poll rewrites a region only when its
>   HTML changed, so it never resets the draft, the frozen quote, or the caret in the quantity box.
> - **The summary** takes the right hero while the draft has a line; an empty draft reverts to the selected berth's
>   read-out. Top to bottom: the transport art by tier (`TX_ART`, under the trade popup's scrim) and its
>   `TIER · space / hold` tag; **Shipping to: Syndicate Waystation**, a static label (the snapshot names no
>   waystation); the consignment (Qty | Resource, a ✕ per row); the ledger — **Proceeds** Σ `round(qty × frozen
>   price)`, **Fuel cost** (`outpostFuelCost[id].creditCostByTier[tier]`, frozen), **Fuel credits remaining** (the
>   combined hoard's credit value less that cost) — and the trade popup's fuel bar; then **Sell to Syndicate**.
> - **Display echoes (§18).** Space = Σ `qty × goodVolumes[good]`; the tier is the smallest `haulerTiers` hold it fits,
>   the engine's own rule; the fuel gate reads `fuelBurnByTier[tier]` against the combined hoard, as the trade popup
>   does. Over the heavy hold the tag reads **Over capacity**, the hint "Over one hold — trim the order." shows, and
>   Sell is disabled. The engine stays the gate.
> - **Quote-lock (§8.1).** The quote freezes when the summary first appears (the first Add) and on Refresh: the issue
>   tick, every good's posted price (lines are added after the freeze, and the engine prices each at the issue tick),
>   and this Outpost's per-tier fuel credits. Expiry runs the trade popup's one rule against the draft's issue tick;
>   expired shows the trade popup's banner and Refresh, and disables Sell.
> - **Confirm** sends ONE action: `sellToSyndicate { guildId, originOutpostId, cart: [{ good, qty }, …], issueTick }`,
>   the cart in good-id order. Accepted: the draft clears and the snapshot is re-read. Refused: the draft is kept so
>   the player can trim and retry. A stale quote flips to the expired state; any other reason (short stock, fuel, over
>   the hold) shows the engine's own words in the summary.
> - **Reused, not copied.** The trade popup hands its finalise parts to the manager as `window.__txParts`: `TX_ART`,
>   `txHoldFor`, `priceOf`, the combined fuel readings, `txQuoteExpiredSince` (the expiry rule, split out of
>   `txExpired`, which now calls it with its own issue tick), `txIsQuoteRejection` and `txFuelBar`. The look is the
>   trade popup's CSS (51 rules) and the Dock editor's quantity box + MAX (5 rules), each rule gaining `#outpost-overlay`
>   as a second selector; the trade SELL popup renders pixel-identical. `txFreezeQuote` is mirrored rather than
>   called, because it writes the trade popup's own state and freezes only the held order's goods.
> - **Unchanged:** the TRADE tab — the SELL card, the Sell Order button, the held-order finalise, the Ship-from
>   dropdown. The System Manifest has no sell.
> - Tests: the served-page tripwire (`sim/tests/server.test.js`). Its bare `cart:` pin is narrowed to BUY, since the
>   page's one `cart:` is now this sale; the two quote-lock pins follow the shared rule; +1 test pins this panel.

> **SUPERSEDED (reversed after playtest, 04-10-26) — the node-relocation of SELL.** The 03–04/10 version of
> this section made SELL *only* contextual: the trade-tab SELL card retired, the origin dropdown removed, all
> selling moved onto the node. In play that gutted the trade tab — it left a half BUY-only flow — and changed
> working UI that was never meant to change. **Withdrawn.** The trade-tab SELL (held order, system origin via
> the dropdown) stands as §6 built it; the outpost is an *additional* origin via the inline-cart sell above;
> and the §6/§7 origin-picker is **not** retired. The engine SELL half from slice 1a (the AS-BUILT block above
> — `originOutpostId`, `sellOrigin`, the gates) is sound and stays; only the client's node-relocation was
> wrong, and its three client slices (2/3a/3b) were reverted from `main` on 04-10-26.

### 9.3 Why BUY keeps a target and SELL does not

Both are nodes the guild holds, but they are reached differently. **BUY** is always initiated from the
Syndicate market (the TRADE tab), which has no node context, so it must answer "deliver where?" — the
default-nearest destination with override (§9.1). **SELL** never has a destination to answer: it always ships
to the origin's nearest waystation, so there is no target pick either way. Its *origin* is a pick only when
there is no node context to supply it — from the TRADE tab the player names a held **system** in the Ship-from
dropdown (§6); from an outpost's manager the origin simply **is** that outpost, no pick. The combined model:
**the Syndicate meets the guild at its frontier** — dropping buys at the nearest node, accepting sells shipped
from wherever — and the guild's **own routes** (the transport layer) move goods between its nodes. The
Syndicate runs the waystation leg; the guild runs the inside.

### 9.4 Failure modes (hunted on paper — working practice #7)

> **AS-BUILT (engine slice 1b, 04-10-26) — the arrival.** `stepArrivals` (`sim/tick.js`) lands a shipment that names
> a `destinationOutpostId` through `landOutpostDelivery`, beside the asset branch. The system delivery's path is
> untouched. All or nothing, never a partial deposit:
> - **Outpost gone.** If the Outpost no longer exists, or is no longer this guild's, the consignment is lost and a
>   **`delivery_turned_back`** notice is written with cause **`outpost-gone`**. It is the Outpost version of the system
>   delivery's `guildHolds` vanish, and the same question the node-held gate asked at departure.
> - **No room.** The WHOLE consignment's space is checked against the Outpost's free space at that moment
>   (`outpostFreeSpace`, the same helper the departure warning read). It fits (exactly full counts) → every good is
>   deposited into `outpost.stockpile`, created if the Outpost had none. It does not fit, even by one unit of space →
>   the whole consignment is lost and a `delivery_turned_back` notice is written with cause **`full`**.
> - **Lost is lost.** No refund, no divert to another node. The shipment leaves the list either way.
> - **The cap.** Room is judged against the Outpost's own `capacity`, which is minted as `OUTPOST_CAPACITY` and is the
>   field the dock step's unload clamp and the `outpost-stockpile-within-capacity` invariant read. One cap, three readers.
> - **Same-tick deliveries to one Outpost** land in the order they were bought (the step's sort is stable, and the
>   Outpost id is now one of its keys), so the earlier buy takes the room first.
> - **Supply and conservation.** The step does not refresh galactic supply; tick's end-of-steps derive does, as for a
>   system delivery. Outpost stockpiles are already counted in supply, so a landed delivery raises it by exactly the
>   goods, and a lost one leaves it unchanged: the cargo was never in a stockpile, and the cash reached the ledger at
>   purchase. Invariants 1 and 2 hold either way.
> - **A broken state halts.** An Outpost that still names a guild that does not exist throws with the tick, as the
>   system delivery does for a claim with no guild. (No action deletes a guild today.)
> - **Not touched:** the dock step (`stepOutpostDocks`) and its free-space clamp, and SELL (1a).

- **Destination outpost full when the delivery ARRIVES (BUY) — all-or-nothing loss (REVISED 04-10-26).**
  Placement does not gate on capacity (9.1), so a buy can be sent to an outpost with no room now, the Trader's
  space-warning notice telling the player to clear space before it lands. On arrival the engine checks the
  WHOLE consignment against the outpost's free space: it fits → it deposits; it does not → the **entire**
  consignment is lost, **no refund** (never a partial deposit), and a **turn-back notice** records that the
  Syndicate was turned away for want of room. A buy that fit when placed can still be lost this way if the
  guild over-committed the outpost while the delivery was in transit (a second buy, a dock unload) — the
  jeopardy of sending goods somewhere you did not keep room. An outpost torn down while a delivery is in
  transit is the same arrival-loss (nowhere to land, the same notice). Never a silent spill to another node —
  the drop is the chosen (or default-nearest) node, or nothing.
- **The default-nearest node is a frontier outpost the player didn't want goods at.** Intended: the default is
  the cheapest leg; delivering deeper is the override. The inward move is the transport layer's job, not the
  Syndicate's.
- **Outpost torn down / lost between popup-open and finalise.** The node-held gate reject-wholes, exactly as a
  lost system destination does (§7).
- **SELL from an outpost with a long leg to any waystation.** Allowed; the fuel simply costs more — the
  planted-too-deep consequence, shown in the ledger before confirm.
- **Outpost with an empty stockpile.** No SELL affordance; it can still be a BUY *destination* (delivering
  stock to it is how it fills).
- **Nearest-node tie.** Lower node id, deterministic (9.1).
