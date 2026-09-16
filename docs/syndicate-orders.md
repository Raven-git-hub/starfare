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

> **AS-BUILT (engine slice, Phase 2).** BUILT in `sim/actions.js`, DUAL-MODE for backward-compat.
> `buyFromSyndicate`: an action carrying an inline `cart`/`good` takes the legacy path unchanged
> (the deployed client); one carrying NEITHER reads `guild.buyOrder.lines`, delivers to
> `destinationSystemId` on one space-tiered leg, and clears `buyOrder` on success. `sellToSyndicate`:
> an action carrying `allocations` takes the legacy multi-system path unchanged; one carrying
> `originSystemId` reads `guild.sellOrder.lines`, sells them from that one origin on ONE space-tiered
> leg (origin → nearest waystation), credits Σ `round(qty × quotedPrice)` per line, removes the
> stock, and clears `sellOrder` — immediate settlement, no shipment. Both new paths reject-whole on
> the aggregate: capacity (total space > `HEAVY_HOLD`), credits (BUY), fuel hoard (both), destination
> held (BUY), origin holds each line's stock (SELL, naming short lines), and the §8.1 quote-lock. An
> empty held order is refused; a reject-whole leaves the draft untouched (never reaches apply). The
> legacy branches are marked TRANSITIONAL — retired with the client slice (§8).

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
> STILL REMAINING (unchanged from §8): (1) **retiring the legacy engine paths** — the inline
> `cart`/`good` BUY and the `allocations` SELL stay for backward-compat; the client no longer sends
> them, so a later cleanup slice removes them. (2) The **SELL origin-picker helper** (§7) — this
> slice offers every held system and lets the engine's stock gate reject-whole with the named
> shortfall; offering only systems that hold every line (or per-line availability) is a later refinement.
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
SELL keep working through the engine slice (backward-compat) and are retired when the client switches. Then
the **client slice** — the Add-to-Order wiring, the two hero buttons, and the adjusted popups. Both spelled
out in their build prompts; the mockups land in `docs/mockups/` with the client slice as its visual contract.

> **AS-BUILT (engine slice, Phase 2 — DONE).** The engine slice above is built and green (state,
> the three build actions, both dual-mode finalises incl. the single-origin SELL re-axe, the
> snapshot publish, the `checkOrders` tripwire; `sim/tests/syndicate-orders.test.js`, 27 tests;
> full suite green, goldens byte-identical). STILL REMAINING: (1) the **client slice** — the
> Add-to-Order wiring, the two "Syndicate Exchange" hero buttons, the adjusted finalise popups, and
> the origin-picker help (§6/§7), with the mockups; (2) **retiring the legacy paths** — the inline
> `cart`/`good` BUY and the `allocations` SELL stay for backward-compat and are removed once the
> client no longer sends them.
