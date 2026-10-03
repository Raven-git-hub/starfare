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
>   `vehicleDeliveryFuelBurn` (a bought craft flying itself in, BUY-side) is not touched.
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
- **Capacity gate (NEW, outpost-only).** A system stockpile is uncapped; an **outpost** is bounded by
  `OUTPOST_CAPACITY`. A BUY whose order exceeds the destination outpost's **free space**
  (`OUTPOST_CAPACITY − used`) **reject-wholes**, naming the shortfall — the same reject-whole shape as the
  hauler-hold cap (§5) and the SELL stock gate (§7): the draft is untouched, so the player trims, re-targets a
  roomier node, or clears the outpost first. (A fresh outpost has 30× the heavy hold free, so this binds only
  on an already-stocked outpost — real, but rare.)
- The existing BUY gates are unchanged: hauler-hold capacity, credits, fuel hoard, destination held, the
  §8.1 quote-lock.

### 9.2 SELL — initiated from the node, no origin picker

> **AS-BUILT (engine slice 1a, 03-10-26) — the engine SELL half.** `sellToSyndicate` (`sim/actions.js`) now
> finalises from a held system or from one of the guild's own Outposts. The client is a later slice, so the
> Outpost Manager's SELL and the removal of the origin dropdown are not built yet.
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

SELL is **initiated contextually from the node** whose goods are being sold — a held system's manifest or an
outpost's manager — and the origin **is** that node. The origin dropdown (§5/§6) is **removed**: there is no
pick, because the player is already looking at the pile. The order ships that node's stockpile → its nearest
waystation, immediate settlement (§5), fuel = that leg.

- **The Outpost Manager gains a SELL action** — it is read-only today; this is its one write affordance: sell
  from the outpost's stockpile, exactly as a system manifest sells from a system's.
- **An empty node offers no SELL** (nothing to ship — the affordance is absent/disabled).
- The SELL stock gate (§7) still applies, now almost always satisfied by construction (you sell from a pile
  you can see); it remains as the engine's backstop, reject-whole naming any short line.
- This **retires** the §6/§7 "SELL origin-picker helper" as moot — there is no origin picker left to refine.

### 9.3 Why BUY keeps a target and SELL does not

They start from different places. SELL begins at a node the player is managing, so the origin is context. BUY
begins at the Syndicate market (the TRADE tab), where there is no node context, so it must answer "deliver
where?" — hence the default-nearest target with override. The combined model: **the Syndicate meets the guild
at its frontier** — dropping buys at the nearest node, accepting sells shipped from wherever — and the guild's
**own routes** (the transport layer) move goods between its nodes. The Syndicate runs the waystation leg; the
guild runs the inside.

### 9.4 Failure modes (hunted on paper — working practice #7)

- **Destination outpost full / nearly full (BUY).** Reject-whole with the free-space shortfall (9.1). Never a
  silent spill to another node — the drop is always the chosen (or default-nearest) node, legibly.
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
