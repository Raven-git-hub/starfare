# Starfare — Roadmap

## How to read this

Starfare's core is the **contest between guilds** under one opaque Syndicate — territory,
tolls, investment, a shared fuel squeeze, mutual dependency without trust. This roadmap is
**mechanics-first**: build the whole single-galaxy game loop against lightweight bots and prove it
is *fun* before investing in human-multiplayer and persistence infrastructure. What we have today
is a deep, well-tested **guild↔Syndicate economy** (one axis); what's next is the **guild↔guild
contest** that makes it a game.

Detailed build history lives in git; each ✅ line here is the terse record, grouped by system.

---

## Status dashboard

| Phase | Name | Status |
|---|---|---|
| 0 | Prove it's fun, learn to code | ✅ Done |
| 1 | The guild↔Syndicate economy | ✅ Done (deep, 1,855 tests, deterministic) |
| 2 | **The walking skeleton — a contested galaxy vs bots** | 🔶 **In progress** — the single-guild expansion spine is landing (transport visibility, the asset economy: dockyard + Syndicate buy; the trade layer rebuilt onto cargo-space haulers + held orders; the deploy pipeline's first three rungs — a hauled Outpost kit deployed by hand or on arrival, with the retreat rule, and the legal deploy range published for the client — and its first client rung, the deploy map, which quotes the leg's time / fuel before DEPLOY; a failed deploy's retreat now records a `deploy_failed` notice, which the MESSAGES inbox shows in the pilot's voice with Show on map; re-ruled asset-initiated, the kit is now an idle asset in a system's inventory, loaded onto and unloaded from a heavy, and deployed from its own idle row: a carrier picked in the Deploy Outpost popup, a route of one stop or many planned on the deploy map, and the kit loaded at the popup's Deploy); the guild↔guild contest (a rival, territory, the market) is not built yet |
| 3 | Persist & harden for the long game | ⬜ Not started (dev rig already ticks + persists) |
| 4 | Human multiplayer | ⬜ Not started |
| 5 | The political layer (council, legality) | ⬜ Not started |
| 6 | Full bots, storyteller & the narrative layer | ⬜ Not started |
| 7 | Self-hosting, config, onboarding, polish | ⬜ Not started |
| G | Galaxy generation (parallel track) | 🔶 Generator + viewer done; a few open decisions |

---

## Phase 0 — Prove it's fun, learn to code ✅

Hand-played the fuel-market simulator, walked a shipment through its lifecycle on paper, ran the
deliberate squeeze (confirmed real tension + open balance question #31), extracted the simulator's
formulas into design.md §8 as the port contract.

---

## Phase 1 — The guild↔Syndicate economy ✅

One axis, built deep and tested. **Every player transaction is with the Syndicate**; the guild↔guild
contest is Phase 2. Grouped record:

- **Harness & determinism** — pure `tick(state, actions)`, the eight §15.6 steps as named functions,
  invariant checks (conservation of fuel/credits, non-negativity, determinism), canonical
  serialization + state hashing, validate-as-it-arrives action intake, the driver.
- **Resources & the production tree** — resource vocabulary, the multi-input recipe engine,
  rate-based resolution with stockpile drawdown + per-good batch carry, production profiles as owned
  state, the production resolver + preview, engine-computed review flags. The recipe catalog is 37:
  12 Tier-2 refines (raw→processed, incl. `luminite_glass`) + the 25 Tier-3 **module** manufactures
  (processed→module, 2.1a — `docs/asset-recipes.md`), all run by the one tier-blind engine. The
  Establish-Venture overlay's picker now opens Tier 3 too (2.1a client): the tier list filters the
  one real catalog by each recipe's OUTPUT tier, so Tier 2 lists only the 12 refines and Tier 3 lists
  the 25 module manufactures, and a Tier-3 factory deploys as the same `refining` venture the engine
  already accepts. Tier-4 construct + the build yard are 2.1b (not built; the picker still greys
  Tier-4 out).
- **Commitment & the Syndicate fork** — commitment-as-sale (committed goods earn credits),
  one-pot priority-ordered distribution, windowed accrual, per-venture met/breach via the
  pursue-order fill, factory output commits producer-general.
- **The licence system** — the licence entity + fee math locked at issuance, the mid-window join
  pro-rate, the fee charged at the window boundary (discounted if met / full if breached),
  per-venture distribution, layer hardening.
- **The price engine** — `stepPriceRecompute` + per-good Syndicate value, the demand-relative fuel
  price controller (pool as its own integrator), price-history coarsening rings, quote-lock (the
  §8.1 agreed-price quote, engine + client).
- **The calendar** — `N` = 1,440 (a 24-hour commitment cycle), the midnight anchor + `sim/calendar.js`,
  per-galaxy UTC offset.
- **Fuel** — fuel real + seeded, the route fuel-cost quote (distance via `nearestWaystation`), fuel
  *bites* (buy/sell burn the route), the travel-time field.
- **Reputation & the mean line** — live RP with band arithmetic (clamped [−500, 1500], taper on
  gains), the GP calculator (`W_SYS` × systems + Σ tier weights, derived), the mean line
  (`expected = GP`, issuance modifier clamped 0.3–1.5), the fuel pool + per-GP grant, the founding
  endowment, the RP rescale onto one integer scale, the venture signing bump, tier-blind earn.
- **The asset economy (seed only)** — assets as per-guild inventory entities, a 15/10 starter gift
  at founding, `establishVenture`'s three-gate occupy (names its machine, gated to held systems).
  *Assets can only be granted, not built — the build yard is Phase 2.*
- **Deuterium (the fuel lever)** — the licensed windowless mine + per-tick auto-sale, its T4 RP; the
  illegal path (unlicensed mine → raw store, illegal refinery + contraband + legal-first burn);
  the DEUTERIUM dashboard tab.
- **The Guild Hall & clients** — the Standing panel + engine fields, the fuel-change gauge; the
  Production Console, TRADE tab + charts, Planet Manifest + establish-in-UI, the state inspector,
  the operator CLI (`tools/admin.js`), the dev container (ticks + persists, `Cache-Control: no-cache`).
- **The licence lifecycle** — renegotiation (standing bands, terms, re-lock; the delivery UI + lapse;
  the grace/acceptance/auto-lapse timers), forced closure at −500, voluntary teardown, and the
  **event log & MESSAGES notices** — now redesigned as an email-style inbox with per-type popups.

### The gap this leaves

The economy has only ever run **one guild vs the Syndicate**. None of the inter-guild contest
exists: no way to build assets, no territory claim action (a guild is boxed into its home system),
no tolls, no inter-guild market or trade, no investment, no bots, no exploration. The shared fuel
pool + mean line is the one mutual-dependency mechanic built — and it has never been exercised as a
contest. **Phase 2 closes that.**

---

## Phase 2 — The walking skeleton: a contested galaxy vs bots 🔶 NEXT

**Goal (the old Phase-1 goal, finally reachable):** sit down as one guild against several bot guilds
on the dev rig and feel a real fuel squeeze you can cause or resist — with territory, tolls, and
investment as levers. Prove the game is a game before persistence/multiplayer.

Built in dependency order. Two keystones: the **asset economy** (upstream of everything buildable)
and **territory** (upstream of tolls, exploration, espionage). All of it sits behind the world
boundary so the later hex-map swap doesn't touch it.

**Built so far:**

- **The Constructed view follows the BUILDING head, not the soonest arrival (2.1d, CLIENT slice —
  `docs/asset-purchase.md` §"As built — the building head vs the queued rows").** `renderConstructed`
  (`client/game.html`) now reads the snapshot's `building` flag. The Current Build donut (header tag
  `· building`), the "Building" art and the In Progress highlight follow that row instead of the
  soonest-arriving one. The list keeps the snapshot's FIFO order (no sort), a queued row reads "queued"
  instead of 0%, and the header counts `N in queue`. The fixed bug: a light transport queued behind a
  miner (fast build, flies itself in) can arrive first, and it took the donut, the art and the
  highlight while still waiting. Client only; no `sim/` source change, so goldens are byte-identical.
  Proven by `sim/tests/trade-constructed.test.js` (+3 source) and the new
  `sim/tests/constructed-building-head.test.js` (+4: that exact miner-then-light-transport case built in
  the engine, with the page's own render run against its snapshot), plus a headless-Chromium smoke of
  the same case; full suite **1,639 green**.

- **Cancel a Syndicate commission from the TRADE tab + a commission-id guard (2.1d, CLIENT slice —
  `docs/asset-purchase.md` §"Cancelling a queued commission").** The Constructed view's In Progress
  rows now carry a ✕ on every commission the snapshot marks `cancellable` (`client/game.html`). It
  confirms in words, with no refund figure (the snapshot publishes none), and posts
  `cancelSyndicateCommission`. New invariant `checkSyndicateBuildsIntegrity`: per guild, every present
  `commissionId` is a unique positive integer and `syndicateCommissionSerial` is ≥ the highest live id.
  Entries with no id (bought before ids existed) are skipped. The check is read-only, so goldens are
  byte-identical. Proven by `sim/tests/syndicate-commission-integrity.test.js` (+7) and
  `sim/tests/trade-constructed.test.js` (+4); full suite **1,632 green**. *Marking the building head vs
  the queued rows was deferred from here; it landed in the next slice (above).*

- **Syndicate queue cap + cancel a not-started commission (2.1d, ENGINE slice — `docs/asset-purchase.md`
  §"The queue cap" + §"Cancelling a queued commission", RULED 26-09-26).** Engine + snapshot + tests only
  (NO client — the cancel controls are the next slice). **Cap:** `buyAssetFromSyndicate` refuses a guild's
  11th pending commission (`SYNDICATE_QUEUE_MAX` = 10, `phase-1-tuning.md`; the whole per-guild queue,
  building head included), before the credits and fuel gates. The dockyard's `MAX_QUEUE` (5) is
  unchanged. **Stable id:** each `syndicateBuilds` entry now carries a `commissionId` from a per-guild
  counter (`guild.syndicateCommissionSerial`, following `vehicleSerial`: starts at 1, counts up only,
  omitted until the guild's first commission). **Cancel:** the new
  **`cancelSyndicateCommission { guildId, commissionId }`** removes a not-started entry
  (`remainingTicks == null`; an underway commission, or another guild's, is refused) and refunds
  `assetPurchaseBaseline(kind)` (guild credits up, ledger down). `priceAssetForPurchase`'s floor now
  reads the same helper, so price and refund can't diverge. The delivery fuel is forfeit (fuel and
  `totalConsumed` untouched), and the key is deleted when the queue empties. **Snapshot:** each
  `syndicateBuilds` row gains `commissionId` + `cancellable`. An entry from before this slice has no id,
  so it shows as not cancellable, can't be matched by a cancel, and still ships. A galaxy that never
  commissions is byte-identical (hash-compared against pre-slice `main`), and `stepSyndicateBuilds` is
  untouched. Proven by `sim/tests/syndicate-queue-cancel.test.js` (+23); full suite **1,621 green**.

- **Syndicate build → per-guild single-slot sequential (2.1d, ENGINE slice — `docs/asset-purchase.md`
  §"Build concurrency").** Engine + snapshot + tests only (NO client — the In-Progress visual rework is
  the next slice), rebuilding the Syndicate construction queue from the retired PARALLEL model to the
  per-guild single-slot FIFO the ruling (19-09-26) sets — mirroring the dockyard (`buildDockyards`) per
  GUILD instead of per yard. The bug it fixes: the old `stepSyndicateBuilds` stored an absolute
  `buildDoneTick` per commission and promoted EVERY build whose done-tick had passed, so a batch
  commissioned together completed together. Now **`buyAssetFromSyndicate`** records the dockyard's
  RELATIVE shape — `{ ownerGuildId, assetKind, destinationSystemId, remainingTicks: null, boughtTick }`
  (`remainingTicks: null` = queued, not started; array order IS the guild's FIFO; omit-when-empty
  unchanged) — and **`stepSyndicateBuilds`** (`sim/tick.js`) walks `state.syndicateBuilds` in array order
  tracking advanced guilds in a Set: each guild's HEAD only either STARTS (`null` → `BUILD_TICKS[kind]`,
  no decrement that tick) or counts down and, at 0, promotes to the same §6 delivery shipment as before
  (kind-aware `arrivalTick`, `assetKind` marker) and leaves the queue so the next entry starts the
  following tick. Credits + fuel stay charged up front; the completion→shipment/arrival/mint code is
  unchanged. **Snapshot** — `syndicateBuilds` is now the derived-on-read per-guild queue: a `building`
  flag on each guild's head, the stored `remainingTicks`, and a queue-aware `ticksRemaining` (a per-guild
  running sum of `remainingTicks ?? BUILD_TICKS[kind]`), dropping the retired `buildDoneTick`; the current
  client keeps rendering off `ticksRemaining` until its slice. Determinism holds (array order only, integer
  ticks — invariant 9). Proven by `sim/tests/asset-purchase.test.js` (re-baselined off the sequential model
  + new single-slot / handoff / two-guild-independence / worked-example / determinism tripwires) and
  `sim/tests/vehicles.test.js`; full suite **1,367 green**, an unbought galaxy byte-identical. *The CLIENT
  slice (the In-Progress panel marking the head "building" vs the rest "queued" off the new flag) has
  since landed (above).*

- **The operator adjust levers (dev/steward tool, ENGINE + CLI — `docs/operator-adjust.md`).** Six
  operator/dev actions (`sim/actions.js`) that grant or remove a guild's producible state and remove a
  venture — `adjustCredits` / `adjustFuel` (signed-delta scalars, each doing the conserving
  counter-move: credits against the Syndicate ledger, fuel against the audit counters), `adjustGoods`
  (a `(guild, system)` stockpile cell + the `galacticSupply` cache refresh), `grantAsset` (mint one
  idle `asset_<guild>_<kind>_NN`), `removeAsset` (`detach` nulls the venture's `assetId` / `close`
  tears it down via the shared `applyVentureClosure`, cause `operator`), and `removeVenture`
  (`keep` / `remove` the freed asset). Ordinary actions on `POST /action`, journaled + invariant-checked
  for free — the same species as `setSyndicateCommitment` / `setWindowN`; the operator surface is six
  `tools/admin.js` subcommands, NOT a client panel or a new endpoint. Additive only: no existing action
  path changed, so every determinism / persist golden is byte-identical (suite 1,298 → **1,315 green**,
  plus `tools/` 38 → 42). Proven by `sim/tests/operator-adjust.test.js` (the §15.5 tripwires clean after
  each lever) + `tools/admin.test.js` (the pure arg→action mapping). *No tick path was touched — the
  detach-production proof found production already null-safe (the engine never dereferences a venture's
  `assetId`), so a detached venture survives a tick invariant-clean. Deferred, not invented: making a
  detached venture actually PRODUCE NOTHING — the engine's production is asset-blind by design (design.md
  §4, "occupying an asset changes no game number"), so coupling asset-presence to output is a broad new
  rule on the decision checklist below, not this steward slice's to bolt on.*

- **Retiring the transitional Syndicate-trade paths (Phase 2, ENGINE cleanup — `docs/syndicate-orders.md`
  §5/§8).** Engine + tests only (`sim/`), NO client change and NO new behaviour — a deletion of dead
  intake. The client slice landed and the deployed client sends only the held-order finalise, so the
  transitional dual-mode branches are dead code and are now removed. `sim/actions.js`: `buyFromSyndicate`
  drops the inline `cart` / legacy `good`/`qty` acceptance (it always reads `guild.buyOrder.lines`),
  `sellToSyndicate` drops the `good` + `allocations` multi-system path (it always reads
  `guild.sellOrder.lines` from one `originSystemId`), the two creators lose their legacy parameters, and
  the `buyIsHeldOrder` / inline-`cart` helpers are deleted — each finalise is now SINGLE-PATH, the
  held-order finalise, byte-for-byte unchanged in behaviour. Tests that drove behaviour through the
  retired shapes were **migrated onto the held-order path** (build the order with `addOrderLine`, then
  finalise), preserving their coverage: `sell.test.js`, `cargo-space.test.js`, `buy.test.js`,
  `fuel-burn.test.js`, `sell-fuel-burn.test.js`, `quote-lock.test.js`, `fuel-cost.test.js`,
  `transport-visibility.test.js`, `deuterium-refinery.test.js`; the two legacy-parity tests in
  `syndicate-orders.test.js` were removed (their assertion — the retired shapes still work — is now false
  by design), and `server.test.js` keeps its no-`allocations`/no-`cart` negative plus the held-order
  BUY/SELL pins. Only retired-mechanic assertions were dropped (per-system rounding across allocations,
  cross-system split-invariance, the multi-system burn SUM, malformed/duplicate-allocation rejection);
  the single-origin behaviour is proved intact. Full suite **1,310 green** (was 1,315 — the net −5 is
  retired tests), every determinism/persist golden **byte-identical** (the held-order path was
  untouched), and `grep` finds no acceptance of `cart`/`allocations`/`buyIsHeldOrder` outside
  comments/history. *Nothing remaining for the order model except the optional SELL origin-picker
  refinement (§6/§7).*

- **The Syndicate order trade UI (Phase 2, CLIENT — `docs/syndicate-orders.md` §6).** Client-only
  (`client/game.html`, the `trade-tab-wire` block) — NO `sim/` change, so every determinism/persisted
  golden is byte-identical and the suite is unchanged (**1,298 green**). The trade floor now BUILDS
  the engine-held order and finalises it. The Syndicate Trade card's two panes collapse to one shape —
  a quantity + an **Add to Sell/Buy Order** button posting `addOrderLine` — retiring the per-system
  SELL basket from the card. The "Syndicate Exchange" hero grows two buttons, **Buy Order** / **Sell
  Order**, badged from the snapshot's `buyOrder`/`sellOrder` (line-count + `totalSpace`, "empty" when
  absent), each opening the adjusted finalise popup (`#tw-tx-overlay`): a two-column **Qty | Resource**
  fixed-height scroll manifest from `order.lines` (per-line `space`, per-row remove ✕), a finalise-time
  target (BUY *Deliver to* / SELL *Ship from* over the held systems), the hero art + **`TIER · used /
  hold`** tag by `order.haulerTier`, the ledger (cost/proceeds, treasury, route fuel from
  `fuelCost[target].{fuelBurnByTier,creditCostByTier}[tier]`, the fuel-hoard bar, BUY-only arrival from
  `.travelTicks`), the **over-capacity** split-the-order state (confirm disabled), and the §8.1
  quote-lock (freeze at open, `issueTick` on confirm). Confirm posts the held-order finalise —
  `buyFromSyndicate({ destinationSystemId, issueTick })` / `sellToSyndicate({ originSystemId,
  issueTick })`, no `cart`/`good`/`allocations`. The client computes no game number — space, tier,
  fuel, cost and arrival are all read from the snapshot (§18). Verified by the served-bytes tripwire
  (`sim/tests/server.test.js`) and a headless-Chromium end-to-end (two-good buy order → manifest, tier,
  route fuel, arrival → confirm → order empties; a one-origin sell; an over-cap build, confirm disabled).
  *RETIRING the legacy engine paths (inline `cart`/`good` BUY, `allocations` SELL) is now DONE — see the
  cleanup slice entry above. Still deferred, not invented: the SELL origin-picker helper (§7 — this slice
  offers every held system and lets the engine's stock gate reject-whole with the named shortfall;
  only-systems-that-hold-every-line is a later refinement).*

- **The Syndicate order model (Phase 2, ENGINE — `docs/syndicate-orders.md`).** Engine + snapshot
  only (NO client — the next slice), all backward-compatible so the deployed single-good BUY / multi-
  system SELL keep working untouched. Each guild now carries a held **`buyOrder`** and **`sellOrder`**
  (`{ lines: [{good, qty}] }`, `sim/state.js`, omit-when-empty like `assets` — an order-less guild is
  byte-identical to pre-slice). Three build actions (`sim/actions.js`): **`addOrderLine`** (append or
  top-up a repeated good, one line per good, kept sorted by good id; creates the order on first add;
  no capacity/stock gate — a draft may exceed a hold, §3), **`removeOrderLine`** (drops a line, omits
  the order when it empties, fails loud on a missing line), **`clearOrder`** (idempotent). Both
  finalises go **dual-mode**: `buyFromSyndicate` with no inline `cart`/`good` reads `guild.buyOrder`,
  delivers the whole multi-good cart to one destination on one space-tiered leg and clears it;
  `sellToSyndicate` with an `originSystemId` (no `allocations`) reads `guild.sellOrder`, sells it from
  that ONE origin on one space-tiered leg (the §5.1 single-origin SELL re-axe), credits Σ proceeds,
  removes the stock and clears it — immediate settlement, no shipment. Both new paths reject-whole on
  the aggregate — capacity (> `HEAVY_HOLD`), credits (BUY), fuel hoard (both), destination held (BUY),
  origin holds each line's stock (SELL, naming short lines), and the §8.1 quote-lock — and leave the
  draft untouched on refusal; an empty order is refused. **Snapshot** — additive derived-on-read:
  each guild row gains `buyOrder`/`sellOrder` = `{ lines:[{good,qty,space}], totalUnits, totalSpace,
  haulerTier, overCap }` (engine-computed, so the client renders no space/tier — §18), present only
  when the order exists. **Invariant** — `checkOrders` (`sim/invariants.js`): lines sorted, unique,
  priced-and-not-fuel, positive-int. No serialized byte from the snapshot, no schema bump, goldens
  byte-identical; `sim/tests/syndicate-orders.test.js` (27 tests), full suite **1,298 green**.
  *The CLIENT half is now BUILT (the row above), and RETIRING the legacy inline BUY / multi-system SELL
  is now DONE (the cleanup slice entry above) — the finalise is single-path. Still deferred:
  the SELL origin-picker help. One decision deferred, not invented: the held order stores NO tick —
  §2/§4 pin its shape with no field for one — flagged rather than adding a field that would move the
  snapshot/persist shape.*

- **The cargo-space Syndicate hauler + multi-good BUY (Phase 2, ENGINE — shipment rebuild slice 1,
  `docs/transport-model.md` §5.1/§8.0).** Engine + snapshot only (NO client — later slices), all
  backward-compatible so the deployed single-good client keeps working. A shipment's size is now
  **cargo SPACE** (`Σ qty × volumeOf(good)`, volume by manufacturing tier: T1 1 / T2 100 / T3 60,000 /
  T4 asset 6,000,000), and a leg flies on the **smallest hauler tier whose hold fits** it — light
  10,000 @ 0.5/hex, medium 50,000 @ 0.6, heavy 6,000,000 @ 0.7 — the tier moving fuel, never time.
  **`sim/fuel.js`** gains the tier table, `volumeOf`, `haulerTierForSpace`, `routeFuelBurnByTier`, and
  a space-required `routeFuelCost(systemId, space)` (a missing load throws — no silent under-charge).
  **BUY** (`sim/actions.js`) gains an optional multi-good `cart:[{good,qty}]` to ONE destination
  (legacy `{good,qty}` normalizes to a one-line cart, byte-identical): one shipment carrying the whole
  cart, cost = Σ per-good, burn = the total-space tier, a NEW capacity gate reject-wholing a cart over
  the heavy hold. **SELL** keeps its shape (one good, many systems) but space-tiers each row's burn and
  caps each row at the heavy hold. **Asset delivery** (`buyAssetFromSyndicate`) now burns the **heavy**
  rate — a T4 asset fills a heavy hold (§5.1, RULED 14-09-26) — superseding the light-rate placeholder.
  **Snapshot** — additive derived-on-read: `fuelCost[sys]` gains `fuelBurnByTier`/`creditCostByTier`
  (its `fuelBurn`/`creditCost` stay the light-tier values), plus published `goodVolumes` and a
  `haulerTiers` hold ladder — unit counts + integers only, no rate/geometry/speed. No serialized byte,
  no schema bump, no golden moved (every golden's trades stay within the light hold in space). Full
  suite 1,271 green. *Deferred to later slices: the SELL axis-flip (one origin, many goods — a breaking
  action-shape change), and the whole CLIENT (the BUY/SELL manifest UI, the tier/fuel/cap display, the
  art re-key). Until they land, SELL stays one-good/many-systems (now space-tiered) and the BUY popup
  stays single-good — the multi-good cart is engine-ready but not reachable from the deployed client.*

- **Buy a Tier-4 asset from the Syndicate (2.1d, CLIENT slice A — `docs/asset-purchase.md`).** The
  TRADE tab's "4 · Constructed" tier tab is now LIVE and renders the Syndicate asset-commission BUY
  view (`client/game.html`, built to `docs/mockups/trade-4constructed.html`): a Commission-Assets
  menu (per kind — price + Build/Delivery/arrival — Add → `__adviserConfirm` → `buyAssetFromSyndicate`
  to the home system), an In Progress list + Current Build donut off `syndicateBuilds` (sorted by
  `ticksRemaining`; no parts), and the two art heroes. The client PRICES
  NOTHING (§5): a new additive, derived-on-read snapshot block **`assetPurchaseQuote`** = `{ <kind>:
  { price, buildTicks } }` (off `priceAssetForPurchase` + `BUILD_TICKS`) supplies the price and build
  time; the delivery leg of the arrival is read from the goods buy's own `fuelCost[dest].travelTicks`.
  No serialized byte, no schema bump, goldens byte-identical. *Deferred to CLIENT slice B: the
  Operations "on order" indicator and the in-flight manifest's Miner/Factory label.*

- **Buy a Tier-4 asset from the Syndicate (2.1d, CLIENT slice B — `docs/asset-purchase.md`).** The
  Operations "In Transit" manifest now NAMES an asset delivery (`client/game.html`, `rowHtml`):
  when `sh.assetKind` is set it renders one `<kind> asset` `.ops-manrow` ("Miner Asset" / "Factory
  Asset" via the existing `.ops-manrow .g` capitalize rule) instead of the goods-cargo loop's "No
  cargo listed." empty case; a goods delivery is byte-for-byte unchanged (row head, carrier line,
  map leg, cargo). The "Nothing in transit" empty-state copy now names asset commissions too.
  Pure presentation of the already-published `assetKind` marker (§5) — no engine/snapshot change,
  goldens byte-identical. *Still deferred: the Operations "on order" indicator (a build surfaced
  BEFORE it ships stays in the TRADE tab's In Progress, not Operations).*

- **Buy a Tier-4 asset from the Syndicate (2.1d, ENGINE slice 1 — `docs/asset-purchase.md`).** The
  BUY side of the asset economy, engine + snapshot only (NO client — the next slice). A guild pays
  **credits + fuel up front** and the Syndicate builds the asset centrally, then ships it and mints an
  idle asset at the destination. **Price** — `max(ASSET_PURCHASE_FLOOR 12M, round(partsCost × 0.8))` off
  the same quote-lock ring the goods BUY uses (`priceAssetForPurchase`, `sim/asset-recipes.js`); the
  floor binds at today's parts scale, so a miner/factory costs a flat 12M. **Action** —
  `buyAssetFromSyndicate` (`sim/actions.js`), the asset analogue of `buyFromSyndicate`: same gates +
  §8.1 quote-lock, minus the `guildHolds` gate (an idle asset lands anywhere — presence not required).
  Apply debits credits → `syndicate.ledger` (invariant 2) and burns the light-hauler route fuel
  (invariant 1), and records a build order on the new top-level **`state.syndicateBuilds`**
  (omit-when-empty, so an unbought galaxy is byte-identical). **Two phases** — `stepSyndicateBuilds`
  (tick **step 4**, scheduled events — the eight-step order is unchanged, step 4 simply gained its first
  occupant) promotes a build at its absolute `buildDoneTick` to a standard §6 delivery shipment carrying
  an `assetKind` marker; `stepArrivals` mints one idle asset (the dockyard's exact id/`createAsset`
  pattern) at the destination on arrival, dropping the shipment if the owner is gone. *(This absolute-
  `buildDoneTick` PARALLEL promotion was superseded by the per-guild single-slot sequential rebuild — the
  top-of-list ENGINE slice — see §"Build concurrency".)* **Snapshot** —
  additive derived-on-read: `syndicateBuilds` (the on-order indicator) + an `assetKind` field on an
  asset transit row; no serialized byte, no golden move. Proven by `sim/tests/asset-purchase.test.js`
  (16 tests incl. a headless found→buy→build→deliver→mint; full suite 1,239 green, goldens
  byte-identical). *Deferred to the client slice: the TRADE-tab section, confirm popup, Operations
  "on order" render, and the map label. Sell-to-Syndicate / lease and the other asset kinds stay ahead.*

- **Transport visibility (engine half)** — the snapshot now surfaces, on every in-flight Syndicate
  shipment, the leg the client draws: `originOutpostId` / `originCoords` (the nearest waystation, the
  leg's start endpoint) and `departureTick` (the second of transport-model.md §2.3's two ticks;
  `arrivalTick` was already surfaced). All three are DERIVED on read from `destinationSystemId` +
  `arrivalTick` + seed geometry — no stored field — so the client can re-derive `legProgress` and
  tween the craft along its leg (§2.3/§6); the engine publishes endpoints + the two ticks, never a
  progress fraction. *The galaxy-map / Transport-tab CLIENT half that reads these and interpolates is
  the following slice.*

- **Transport visibility (client half)** — the galaxy-map overlay in `client/game.html`. Each poll
  pushes the player's OWN in-flight Syndicate deliveries (filtered `ownerGuildId === myGuildId`;
  rivals' deliveries are not drawn — a slice-local ruling, espionage is later) through a new
  `__setLiveShipments`, and `render()` draws each as a dashed brass leg (nearest waystation →
  destination), a gold craft chevron tweened along it at `legProgress` (transport-model.md §2.3) off
  the engine's two ticks, tagged with the carrier (`'Syndicate'`) + `fmtETA(ticksRemaining)` above 1×
  zoom. One timing source — the clock ring's fractional tick (`__fractionalTick`); no heartbeat ⇒ the
  craft parks at its integer tick. CLIENT only — no engine/snapshot/sim change, so determinism holds;
  proven end-to-end in headless Chromium (leg + craft + tag draw, ETA decrements and the craft advances
  toward the destination as ticks step, a rival's shipment does not draw). *The Transport-tab board
  stays Phase 4.*

- **The OPERATIONS tab (client)** — the list-and-hub companion to the galaxy-map overlay
  (`docs/operations-hub.md`). The Transport tab is renamed **OPERATIONS** and becomes a top-level
  rendered panel (`#tp-ops`, a peer of TRADE / Guild Hall / Deuterium) in the Guild-Hall visual
  language: a three-column frame (LEASED hero | IN TRANSIT + DEPLOYED + IDLE | pilot hero), every panel
  fixed-height with internal scroll. **IN TRANSIT is live** — the player's own in-flight Syndicate
  deliveries off the snapshot (`ownerGuildId === myGuildId`, soonest-arrival first), each row an origin
  waystation · progress bar (`legProgress`) · reserved alert slot · ETA (`fmtETA` of the engine's
  `ticksRemaining`, never recomputed from the bar) · destination system, expandable to a
  `Carrier: Syndicate` line + the cargo manifest. **LEASED / DEPLOYED / IDLE ship as empty scaffolds**
  (their entities don't exist yet). CLIENT only — no engine/snapshot/sim change, determinism holds;
  proven end-to-end in headless Chromium (two BUYs at different distances list soonest-first with
  origin/progress/ETA/destination, the top row's manifest expands, the scaffolds show their empty
  states, a rival's shipment does not appear). *The guild-craft / leasing board (LEASED, craft ids in
  IN TRANSIT) stays Phase 4.*

- **Asset inventory is per-system (2.1b groundwork, engine + snapshot).** Every `Asset` now carries a
  `systemId` — its physical location — required at construction, stamped at founding to the guild's
  `homeSystemId`, and immutable this slice. `establishVenture` / `establishDeuteriumRefinery` Gate 2
  gains a same-system clause (deploy from that system's inventory only), the occupancy invariant
  gains `asset-system-present` + `deployed-asset-system-matches-venture`, and the snapshot's asset
  rows surface `systemId` so the client can group inventory by system. A **no-op** on today's
  one-system galaxies; cross-system redeploy + the `inTransit` state stay deferred to 2.2 (design.md
  §4). *Upstream of the build yard (each built asset lands at the building system) and of territory.*
- **The OPERATIONS hub's IDLE section is live (2.1b client).** The IDLE `ops-card` (`#ops-idle-list`)
  now lists the guild's uncommitted ground assets off the snapshot — the founding **15 miners + 10
  factories**, idle from turn one, finally on screen. Membership is the engine's one rule read verbatim
  (`deployedToVentureId == null`, guild-wide), **grouped by system** (`Asset.systemId`, resolved to its
  name) then **by kind** under collapsible Miners / Factories headers; each machine row is its ID + kind
  descriptor. Filled by the same operations-tab-wire as IN TRANSIT — on open and every poll — so it
  stays live as machines deploy (leave) and ventures tear down (return); a signature guard preserves the
  reader's collapse state across polls; an all-deployed guild keeps a calm empty state. Read-only this
  slice — no Manage popup / deploy-from-hub (`operations-hub.md` §8), no same-system picker filter (2.2).
  CLIENT only — no engine/snapshot/sim change, determinism holds; the one served-page tripwire in
  `sim/tests/server.test.js` was updated in place to pin the live IDLE contract. Proven end-to-end in
  headless Chromium (fresh founding → one system group, 15/10 subgroups; deploy one miner → it drops out
  of IDLE next poll; tear the venture down → it returns). *DEPLOYED / LEASED stay empty scaffolds (their
  entities don't exist yet).*
- **The build yard's Tier-4 build core is live (2.1b slice 1, engine + snapshot).** A **dockyard** —
  a factory venture in construct mode (`isDockyard`, the analogue of the deuterium-refinery marker;
  established via `establishDockyard`, which mirrors the refinery's occupancy gates minus recipe/rate) —
  carries a **single-slot, strict-FIFO commission queue** (`commissionBuild` / `cancelCommission`, capped
  at `MAX_QUEUE` = 5) that turns modules **drawn from its own system's stockpile** into finished
  **miner / factory** assets. The **reserve-and-wait build step** (`buildDockyards`, a per-guild sub-step
  beside `refineDeuterium`) waits with no reservation until a head's whole bill is present, consumes it
  atomically, counts down `BUILD_TICKS` (miner 720 / factory 960), then **emits one asset idle at the
  dockyard's system**, its id continuing the per-(guild,kind) sequence above the founding grant. The
  Tier-4 bills live in `sim/asset-recipes.js` (lifted from `docs/asset-recipes.md`, with a load-time
  tripwire that every module is a real Tier-3 good); teardown reuses `decommissionVenture` (queue gone,
  factory freed to idle, consumed modules not refunded). **GP/RP-neutral this slice** — a dockyard scores
  0 GP by the recipe-less default and no RP (the §5 special-COUNT / held Tier-4 RP bump are slice 2). The
  snapshot surfaces `dockyard` + `buildQueue`. Determinism holds; a non-dockyard venture is byte-identical
  to before (the new fields are omitted unless `dockyard`). Proven by `sim/tests/dockyard.test.js`
  (31 tests; full suite 1,193 green). *The Syndicate-commission-for-credits (2.1d), the open market
  (2.1e) and the ship/outpost/scanner/toll-gate/droid outputs stay ahead.*
- **The dockyard is a full Tier-4 venture in the mean-line economy (2.1b slice 2, engine only).** The
  build core's GP/RP-neutral placeholder is retired: `guildPoints` now **special-COUNTs a dockyard at
  Tier 4** (`isDockyard` → `TIER_WEIGHT[4]` = **500**, the mirror of the deuterium special-skip and its
  first GP reader — a dockyard produces no good, so the count is explicit), and establishing one mints a
  **held Tier-4 RP signing bump of 900** (`DOCKYARD_SIGNING_BUMP`, a flat magnitude via `signingBump`
  special-cased on `isDockyard`, applied in the `establishDockyard` apply onto `venture.reputation` with
  `guild.guildReputation` tracking it). With `MEANLINE_K` = 1 the +500 GP raises the bar 500, so the net
  standing benefit is **+400**, tuned so the net-benefit ordering is **deuterium mine (+1000) > dockyard
  (+400) > a Tier-1/2/3 venture (tier-3 at 100 % commit, +300)** — the tuning invariant recorded in
  `docs/phase-1-tuning.md`. **Held while it stands, forfeited on teardown → not farmable**; no per-cycle
  accrual; `checkGuildReputationSum` stays exact. GP is derived so no serialized byte and no determinism
  golden moves. Proven by `sim/tests/dockyard-points.test.js` (9 tests; full suite 1,216 green). *The
  queue UI's read-only render is the 2.1b client tab (B1, built — see `build-yard.md §7`); the
  commission menu + cancel (B2) and the ladder outputs stay ahead.*
- **2.0 — Two guilds, the fuel contest proven.** Seat a second guild (inert or lightly scripted);
  run the existing mean-line / issuance as an actual multi-guild contest; confirm density-beats-sprawl
  tension is real between two actors. *No new mechanic — the oldest walking-skeleton line, closed.*
- **2.1 — The asset economy / build yard (keystone).** 🔶 *Largely built* (see "Built so far").
  The **dockyard** (build from your own parts, 2.1b) and the **Syndicate purchase** (buy for credits,
  2.1d) are in end-to-end for the two kinds that have entities — **miner** and **factory**: a
  commission menu, a single-slot build queue, central build + delivery, a fresh idle asset minted at
  the destination. The Syndicate purchase-price question is settled (`docs/asset-purchase.md`).
  **Remaining:** **2.1e — list assets on the open market to other guilds**, the first guild↔guild
  trade (*precondition: 2.0, a second guild*; open: sell-to-Syndicate outright vs lease-only; do
  founding grants survive the market era); and the **other Tier-4 output kinds** — ship / outpost /
  toll gate / scan array / droid (no entities yet; the buy+dockyard machinery is kind-general, so
  each is mostly its entity + recipe, and each unblocks a downstream slice: toll gates → 2.3, scan
  arrays/spycraft → 2.5, droids → 2.6, outposts → 2.2).
- **2.2 (foundation) — The guild transport tier: own & move a craft (the substrate under the differentiation stack).**
  Guilds build/buy, own, and fly their own transports — the first guild-tier Tier-4 output to enter the build.
  **Pulled forward from Phase 4** (design.md §6): territory (below), tolls (2.3), and exploration/espionage (2.5)
  all require an ownable, movable guild craft, so it is built FIRST. Sequence — (a) **entity + ownership — ✅ BUILT
  (18-09-26, engine + snapshot only; `sim/vehicles.js`, `createVehicle`, `sim/asset-recipes.js` ship bills +
  BUILD_TICKS + baselines, buy/build in `sim/actions.js`, the shared `mintFinishedKind` seam in `sim/tick.js`,
  the snapshot `vehicles` rows + purchase quote, `checkVehicleIntegrity`; `sim/tests/vehicles.test.js`):** the
  `Vehicle` gained a `systemId` location + inert `maintenanceCondition`, and BOTH the dockyard build and the
  Syndicate purchase mint a transport **idle** into `guild.vehicles` — the buy flies the craft itself (its own
  `fuelCostToRun × hexDistance` up front, arrival `<head completion tick> + ceil(hexDistance × speed[class])` —
  the head completing its single-slot countdown, §"Build concurrency"), and the
  slice authored no number (all from `phase-1-tuning.md` "Guild transports"; entity: design.md §15.4; the
  buy/build machinery is kind-general). *A NO-OP on galaxies that mint no craft — the goldens do not move.*
  **(a-client) surface the transports in the CLIENT — ✅ BUILT (18-09-26, `client/game.html`, client-only bar
  one additive snapshot field):** the four classes now COMMISSION on the TRADE "4 · Constructed" floor (they
  already rode the generic `assetPurchaseQuote` path; `pretty()` now splits camelCase so a class reads
  "Light Transport" / "Medium Transport" / "Heavy Transport" / "Spycraft", and the menu got a fixed-panel
  internal scroll as the catalog grew to six), and the OPERATIONS left column SPLIT into a herostack of two
  equal panels — **Idle Transports** (the guild's idle `vehicles`, grouped by system, each craft a collapsible
  tab: short type + system → maintenance % + an inert, disabled Dispatch) over **Leased**. The one engine touch
  is an **additive, derived-on-read** snapshot field, `fuelCost[sys].vehicleTravelTicks[class]` — the craft's
  OWN self-delivery leg `ceil(hexDistance × speed[class])` (a bought craft flies itself, so the hauler
  `travelTicks` was wrong for it; §18 — the client computes no game number), so the commission popup and the
  In-Progress rows quote a craft's real arrival. *Byte-identical goldens (derived-on-read, no serialized byte);
  the suite holds at 1,325.* **Dispatch/movement stays slice (b).** *(No `docs/mockups/guild-transport-client.html`
  existed in the repo at build time — see the decision checklist; built to the build-prompt's textual contract.)*
  (b) **dispatch + arrival — the polyline / waypoint model (RULED 18-09-26, transport-model.md §4).**
  A route is an ordered list of **legs**, each leg any two location **anchors** (system / outpost / bare hex),
  direction changing at every waypoint (deep space included); the leg is the atomic unit **from the start**, so
  multi-leg is not a later add-on. Fuel is burned in **units from the hoard, whole route up front** (refused whole
  if short — no stranding), presented to the player as a live-priced credit cost; the whole schedule is **frozen at
  dispatch** and the **only tick step is the final arrival**, which flips the craft idle at its last anchor.
  **Slices: (b1) engine + operator CLI — ✅ BUILT (19-09-26; `sim/transport.js` leg math, `sim/actions.js`
  `dispatchVehicle`, `sim/tick.js` `stepVehicleArrivals`, `sim/invariants.js` `checkVehicleIntegrity` status
  branch, `sim/snapshot.js` in-flight route, `sim/server.js` `/admin/vehicle/dispatch`, `tools/admin.js
  dispatch-vehicle`; `sim/tests/dispatch.test.js`):** `legTicks`/`legFuelBurn` put the §2.2 formula (with the
  `TOLL_BUFF` path) in one place; `dispatchVehicle` builds the polyline from the craft's location through the
  waypoints, burns `Σ legFuelBurn` from the hoard up front (refused whole if short), and freezes a contiguous
  schedule; `stepVehicleArrivals` is the ONE tick step — it lands a craft idle at its final anchor at
  `trip.arrivalTick`; the snapshot surfaces the in-flight legs (resolved coords + ticks) and the live-priced
  credit cost; `admin.js dispatch-vehicle --waypoints "…"` dispatches a multi-leg route headless. *A NO-OP on a
  galaxy that dispatches nothing (the goldens do not move); determinism + a mid-route restart proven; the suite
  holds at 1,353 (+16) + tools.* **This slice sets `isToll: false` on every leg (no toll infrastructure yet) —
  the buff path is present and unit-tested. Cargo, the client, and everything else stay slice (b2)+.**
  **(b2) client** — the Dispatch popup's waypoint builder (a live estimate, engine authoritative at apply) and the
  in-flight polyline / craft render. Cargo, waypoint actions, saved routes, and scheduled/repeating runs are their
  own later passes; the anchor-list shape leaves the seams. UI: the OPERATIONS hero splits into idle-transports
  (dispatch) over leased.
  **Slices: (b2a) in-flight render — ✅ BUILT (19-09-26, `client/game.html`, CLIENT ONLY).** The visibility half
  of the dispatch client, built before the planner (b2b) so a dispatched craft is visible the moment it flies. It
  consumes the b1 snapshot's `vehicles[].trip` as-is (NO engine/snapshot change) and mirrors the Syndicate-delivery
  machinery. **Map overlay:** a sibling feed `window.__setLiveInTransitCraft` (beside `__setLiveDeepSpaceCraft`),
  filled each poll from the player's OWN guild row filtered `status === 'inTransit' && v.trip` (own only,
  client-wiring §7); a draw pass beside the delivery pass draws the WHOLE multi-leg polyline (every leg the same
  dashed brass line, off-screen culled per leg), slides the craft along its ACTIVE leg (`departureTick ≤ Tf <
  arrivalTick`, clamped at both ends) as the same rotated gold chevron, and — above 1× — tags it
  `[prettyClass(class), fmtETA(trip.arrivalTick − nowTick)]` in the `'player'` accent. **OPERATIONS IN TRANSIT:**
  each own in-transit craft becomes a row in `#ops-transit-list` alongside the Syndicate deliveries (interleaved by
  soonest arrival) — craft name · overall progress bar (`clamp01((Tf − trip.dispatchTick)/(trip.arrivalTick −
  trip.dispatchTick))`) · ETA (`trip.arrivalTick − nowTick`) · destination name (the final leg's `to` coords
  reverse-mapped to a system/outpost via the new `window.__landmarkNameAt`, else `Deep Space (q, r)`); its manifest
  carrier line is the craft's own name and cargo reads "No cargo" (the goods loop shape left ready). Both fold into
  the existing `transitSig` structure-guard + in-place bar/ETA update (stable key `id + trip.arrivalTick`), so
  scroll/expand state survives a poll. The client computes no game number (§18): position/ETA/progress are derives
  off the engine's ticks, the reverse-map is presentation. *Client-only — the sim suite holds at 1,353, 0 fail;
  proven end-to-end in headless Chromium: a `dispatch-vehicle` multi-leg route flies as a polyline + chevron + tag
  and shows a live IN TRANSIT row, then on arrival leaves both layers and reappears idle at its final anchor.*
  **(b2b) the route-planner** — the Dispatch popup's waypoint builder, quote, and Finalise. Split into a small
  engine prerequisite (b2b-1, the quote endpoint) and the client (b2b-2, the popup).
  **Slices: (b2b-1) the dispatch quote — ✅ BUILT (19-09-26, engine + endpoint only; `sim/actions.js`
  `quoteDispatch`, `sim/server.js` `POST /vehicle/quote`; `sim/tests/quote.test.js` + a `server.test.js`
  tripwire).** The read-only projection of a dispatch, so the planner (b2b-2) can preview a candidate route's
  authoritative time/fuel/cost and gate its Dispatch button off the truth WITHOUT computing any game number (§18).
  `quoteDispatch(state, { guildId, vehicleId, waypoints })` mirrors `dispatchVehicle`'s validate gates (guild
  exists, owns the craft, craft idle) and calls the SAME `dispatchRoute` the real dispatch uses (now shared, via
  the new read-only `quoteDispatch` wrapper) — so a quote and the dispatch it previews can never disagree — then
  builds the breakdown from `dispatchRoute`'s own leg lengths: per-leg `{ length, ticks, fuel }` (§2.2 `legTicks`
  / `legFuelBurn`, `isToll` false), `totalTicks`/`totalUnits`, `credits = fuelValue(totalUnits, reserve.fuelPrice)`
  (the live-priced display cost), `affordable = (fuelHoard + deuteriumFuel) >= totalUnits` (reported, not enforced
  — an unaffordable route is still a valid `ok` quote), and `arrivalTick = state.tick + totalTicks`. A ruled
  failure (empty / unresolvable waypoint / zero-length leg / non-idle craft / unknown guild-or-vehicle) returns
  `{ ok: false, reason }` with the SAME message the dispatch validate gives. The endpoint `POST /vehicle/quote`
  is the read-only twin of `POST /admin/vehicle/dispatch`: player-facing (NOT under `/admin/`, as open as
  `/snapshot`), it reads the live state and returns `quoteDispatch`'s result as JSON — NO action, NO
  `applyOneAction`, NO journal, NO tick, NO snapshot — so calling it any number of times leaves the galaxy
  byte-identical; a `{ ok: false }` quote is a 200 (a valid answer), 409/400 reserved for no-galaxy / a malformed
  body. **NO state change, NO client** (the popup is b2b-2). *No serialized byte added, so the persist/determinism
  goldens do not move; the suite is 1,353 → **1,361 green** (0 fail).*
  **Slices: (b2b-2) the route-planner client — ✅ BUILT (19-09-26, CLIENT ONLY; `client/game.html`).** The final
  dispatch slice: the player builds a multi-leg route on the galaxy map and dispatches a craft from the client,
  gated by the engine quote. NO engine/snapshot/`sim` change — dispatch goes through the existing `POST /action`
  (`dispatchVehicle`), the cost preview through the b2b-1 `POST /vehicle/quote`. The whole in-progress route lives
  in one client object `PLAN = { vehicle, origin, waypoints:[anchor,…], candidate }` (each anchor the engine's own
  `{ landmarkKind, landmarkId }`-or-`{ q, r }` location shape, so the list the client sends is exactly what
  `quoteDispatch`/`dispatchVehicle` accept). **The Dispatch popup, restructured:** the left column's `.dp-soon`
  placeholder becomes an Onboard Manifest placeholder ("Hold empty") + Maintenance (disabled) / **Plan Route**
  (pre-plan), and — post-Finalise — a two-box **Planned Route** (a scrollable Origin+waypoints list beside Time
  over Cost, the fuel cost shown in credits, §8.0) + Edit Route / **Dispatch**. **The map planning mode:** Plan
  Route flies to the craft and enters a planning mode with a banner, a left waypoint list (▲▼ reorder, ✕ remove —
  arrows, not drag), and top-right Finalise/Cancel; a map click resolves a hex to a candidate anchor (system →
  `system`, Syndicate outpost → `outpost`, else a bare hex) shown as an **ADD → Confirm/Cancel** chip glued to the
  hex, so a pan/mis-click adds nothing until Confirm. A **dead-leg guard** refuses a candidate (or flags a list
  row) whose resolved `{q,r}` equals the previous anchor's — the UI never builds the zero-length leg the engine
  would reject (§4). A **planning draw pass** (the sibling of the b2a in-transit pass) paints the confirmed
  polyline + a dashed proposed leg + origin/turning-point markers each frame from `PLAN`. **Finalise → quote →
  Dispatch:** Finalise (≥ 1 waypoint, no dead leg) POSTs the route to `/vehicle/quote`, shows Time
  (`fmtETA(totalTicks)`) over Cost (`credits ¢`), and gates Dispatch on `affordable` / a `{ ok:false }` reason;
  Dispatch sends `dispatchVehicle` through `/action`, and on accept the craft flies via the b2a overlay (map +
  OPERATIONS). **§18 is the load-bearing rule:** the client computes NO game number — every time/fuel/credit
  figure is the engine's quote, and the client only resolves anchors to coords to draw the polyline and to compare
  hexes for the dead-leg check (geometry, not an economy number). Capacity is not published to the client (no
  engine change this slice), so the manifest shows its shape with a placeholder rather than a client-invented
  number — surfacing guild-vehicle capacity is a decision-checklist item (below). Proven CLIENT-ONLY (the engine
  suite is untouched: `sim && node --test` still **1,361 green**, 0 fail) and end-to-end in headless Chromium
  against a booted server: the restructured pre-plan popup; Plan Route → planning mode; click → ADD → Confirm
  appends a turning point and the polyline draws; a second click builds a multi-leg route; reorder/remove
  re-costs and re-draws; a zero-length candidate is refused; Finalise shows the two-box Planned Route (Time over
  Cost in credits); Dispatch → `/action` accepted → the craft flies (b2a overlay); a landmark final anchor lands
  the craft idle at that landmark and a bare-hex final anchor lands it in DEEP SPACE.
  *From
  here the thread fans out — Syndicate transport contracts, maintenance, exploration (a plain craft scans,
  slower and fuelled), and deep-space asset deployment (outpost → toll). A full Phase-2 renumber to reflect this
  reordering is the roadmap-expert thread's job at hand-back, not done here.*
- **2.2 (spawn) — Vehicle spawn / remove primitive (operator CLI + Storyteller substrate).**
  🔶 *Engine + snapshot + operator CLI BUILT (18-09-26); the OPERATIONS **DEEP SPACE** client group is
  the remaining slice.* A journalled `spawnVehicle` / `removeVehicle` engine action pair. **Spawn** any
  class into any guild (bots included) at any location — a system, an outpost, or a bare hex — minted
  **idle at the current tick**, condition settable (default `1`); **remove** by id, which **destroys** the
  craft (and, forward, its cargo — a recorded goods sink). Generalises the shipped `systemId` into a
  **landmark-or-hex location** (system and outpost are equivalent anchors; a craft anchored to nothing is
  **DEEP SPACE**), adds a **stored per-guild monotonic mint counter** so a removed id is never reissued,
  and states the movement **performance contract** (position derived on read, never simulated per tick).
  Exposed as `tools/admin.js spawn-vehicle` / `remove-vehicle` over an Access-gated `/admin` endpoint; the
  SAME primitive is how the Storyteller materialises craft later. Ruling: design.md §15.4 ("Vehicle
  location, spawn / remove, and the movement performance contract").
  **BUILT — engine + snapshot + operator CLI (18-09-26):** the `location` model (a landmark-or-hex idle
  position, generalised from `systemId`) with `resolveVehicleLocation`/`vehicleCoords` as the one
  judge/selector and an in-bounds hex test derived from the seed's `galaxyParams` (`isHexInBounds`, no
  invented number); the stored per-guild `vehicleSerial` counter (omit-when-0), replacing the max+1
  derivation removal broke; `spawnVehicle`/`removeVehicle` through the shared validate/apply/journal path;
  `checkVehicleIntegrity` upgraded to the landmark-or-hex + serial-monotonic + unique-id sweep; the
  snapshot's `location` row; and `POST /admin/vehicle/spawn|remove` + the two `tools/admin.js` commands.
  A NO-OP on a craft-less galaxy (persist goldens byte-identical); sim suite 1,325 → **1,337 green**, and
  `tools/admin.test.js` 24 → 30.
  **BUILT — the OPERATIONS DEEP SPACE client group (18-09-26, `client/game.html`, CLIENT ONLY).** The
  IDLE-transports panel now reads each craft's snapshot `location` instead of the retired `v.systemId`,
  fixing the regression where every idle craft mis-grouped under a blank header. A pure group resolver
  `tpGroupOf(v)` maps a craft's `location` to a group `{ key, name }` — a system landmark → its system
  name, an outpost landmark → its outpost name, a bare hex → the one shared **DEEP SPACE** bucket, and a
  malformed row → a defensive "Unknown"; a per-craft `tpCraftWhere(v)` labels a landmark craft by name and
  a deep-space craft by its `(q, r)` coordinates. `tpSystemHtml` is generalised to `tpGroupHtml(key, name,
  craft)` (one `ops-tp-sys` group per landmark or DEEP SPACE, collapse-keyed on the group key), and
  `renderIdleTransports` groups by group key, sorts named landmarks alphabetically with DEEP SPACE last,
  and signs on the full resolved location so any re-anchor re-renders. No engine/snapshot change — the
  snapshot already emits `location` — so the sim suite still passes **1,337 green**. **Deferred:**
  everything movement (dispatch/arrival/cargo) which is slice (b).
  **BUILT — deep-space craft on the map + the Dispatch popup scaffold (client polish, `client/game.html`,
  CLIENT ONLY).** The player's OWN idle bare-hex transports now draw on the galaxy map: the poll feeds
  them to a new map-IIFE setter `__setLiveDeepSpaceCraft([{ id, class, q, r }])` (own craft only,
  client-wiring §7 — a craft berthed at a system/outpost is already marked by that landmark's tag, so
  only bare-hex craft are fed), which keeps the list for drawing and a `craftByKey` "q,r" hit-test map.
  The render pass draws each as a small player-accent diamond plus a clickable diagonal name-tag
  (`drawLabelBox` with `[<TYPE>, 'IDLE']`; the second line is optional so a future guild-outpost
  deployable inherits a type-only label). `handleClick` gains a top-of-chain branch: a click on a
  craft's hex opens the **Dispatch popup** instead of the system panel. The popup is a new
  `#dispatch-overlay` mirroring `#vm-overlay`'s `.est` shell — head (eyebrow "Dispatch" + the craft's
  name, e.g. `Heavy Transport · #03`), a main column summarising Class / Location (landmark name or
  `(q, r)`) / Maintenance %, and a side hero showing the per-class art (`assets/units/<class>.jpg`).
  Its ONE action this slice is **"Show on map"**: it closes the popup and `__flyTo(coords.q, coords.r, 9)`
  (zoom matching My System), resolving a bare-hex craft to its own hex and a landmark craft to the seed's
  `GAME.galaxy.systems`/`.outposts` coords. `openDispatch(vehicle)` is the one entry point, opened from
  the map click AND from the OPERATIONS Dispatch button (now enabled, its `disabled`/title removed). No
  engine/snapshot change — the client reads the already-published `vehicles[].location`, resolves
  names/coords off the seed, and draws (§5/§18) — so the sim suite still passes **1,337 green**.
  **Deferred:** everything movement (destination/route/fuel/the real dispatch, and rivals' craft on the
  map) which is slice (b). *Polished (client-only): the popup now shows the FULL-PORTRAIT art
  (`aspect-ratio:848/1264` + `cover`, the whole ship uncropped, "Show on map" on a footer beneath it),
  and the LABEL opens the popup while a hex click is normal (the `craftByKey` hex branch retired for a
  per-frame `craftLabelHits` label hit-test off `drawLabelBox`'s returned box).*
- **2.2 — The guild Outpost: the outpost ladder (design.md §4 "The Guild Outpost").** The logistics
  staging structure the cargo loop hangs off — a single-hex, guild-owned infrastructure claim in the
  Toll Gate family (§15.4) that anchors to a system and holds a finite, cargo-space stockpile. Built
  as a rung-by-rung ladder, mirroring how the guild transport was bootstrapped (spawn/remove first,
  the economy wired later):
  - **slice 1 — the entity + operator CLI (engine only).** 🟢 *BUILT.* The Outpost entity
    (`state.outposts`, SHARED), `spawnOutpost`/`removeOutpost` journalled actions, `POST /admin/outpost/spawn|remove`,
    and `tools/admin.js spawn-outpost`/`remove-outpost` — an operator can place and destroy one and see it
    in the snapshot, exactly as a vehicle. Two numbers, neither invented: `OUTPOST_CAPACITY = 30 × HEAVY_HOLD`
    (derived) and `OUTPOST_DOCK_SLOTS = 10` (`[FIRST-CUT]`) → `phase-1-tuning.md`; a stored per-guild mint
    serial (`outpost_<guild>_NN`, never reissued); `checkOutpostIntegrity` (owner/anchor/hex/one-structure-per-hex/
    unique-id/serial-monotonic). `capacity`/`dockCapacity`/`stockpile` CARRIED but read/written by nothing.
    A NO-OP on a galaxy with no outpost (goldens byte-identical). Sim suite 1,367 → **1,383 green**,
    `tools/admin.test.js` 32 → 35. **Deferred:** placement RANGE / anchor-ownership gating (the operator
    places freely, like `spawn-vehicle`); the client (slice 2); cargo / load / unload / the dock model's
    behaviour, and the destruction consequences §4 names — stored goods destroyed, docked craft evicted to
    idle-in-space (slice 3); storing idle assets at an Outpost (idle assets have no location yet, §4); selling
    to the Syndicate from an Outpost, the toll-hub, maintenance (later).
  - **slice 2 — the client.** 🟢 *BUILT.* Draw the outpost on the map, read it in the panel — CLIENT
    ONLY (`client/game.html`), consuming the `snapshot.outposts` rows slice 1 emits; no engine,
    snapshot or `sim` change. The already-scaffolded render passes (the guild-coloured territory-fill
    hex, the diamond marker, the `guildOutpostByKey` click map, the "Guild Outpost" info-panel branch)
    were fed EMPTY; they are now filled from the snapshot. `loadClaims` maps each row to the shape the
    passes read (`guildId`/`coords`) plus the panel's fields, `__setLiveTerritory` threads
    `snapshot.outposts` through beside `guilds`/`systemClaims`, and every guild's outpost renders in
    the owner's colour (client-wiring §7 — a structure's location is public; its economics are not,
    and this slice holds none). The panel names the owner, the anchor system, and the engine's
    `capacity` / `dockCapacity` figures (displayed, never computed — §18; thousands-formatting and the
    derived name are presentation), with a "Hold empty" line mirroring the vehicle popup. A name-tag
    (own outposts only, matching own-systems labelling) and a legend "Guild Outpost" diamond entry
    round it out. Sim suite still **1,383 green** (untouched); rendered end-to-end in headless
    Chromium (operator-spawned outpost → tinted hex + marker + name tag; click → the enriched panel;
    a no-outpost galaxy renders byte-for-byte as before). **Deferred (surfaced, not invented):** the
    derived display-name choice (anchor name + " Outpost", `#NN` fallback — presentation, ruled here);
    rival-outpost economic detail (only location + static class figures shown); cargo/stockpile
    contents, docking, and outposts as route/planner targets (all slice 3+).
  - **slice 3 — cargo + the dock model.** 🟢 *ENGINE BUILT (21-09-26 — same work as the 2.2 cargo
    ladder's engine slice 2 below).* Load/unload AT an Outpost through the deadlock-free
    park/queue/slot/turnaround, the finite stockpile enforced (an unload clamps to the room remaining),
    the destruction consequences (teardown destroys the stored goods and evicts docked craft) — all in the
    engine + operator CLI + snapshot. **Still deferred:** the load/unload CLIENT (the manual popup, the
    OPERATIONS dock display) and selling to the Syndicate from the Outpost.
  - **slice 3-client — the read-only Outpost Manager.** 🟢 *BUILT (21-09-26 — CLIENT + three derived
    snapshot fields; `client/game.html` `#outpost-overlay`, `sim/snapshot.js`).* Clicking a guild Outpost's
    **OPEN DETAILS** button (the `#sp-details` placeholder, now enabled + wired) opens a three-column popup
    (the Dispatch popup reshaped) that renders `snapshot.outposts[i]` LIVE: the ten dock berths counting
    down (a progress fill = `1 − eta/totalTicks`), the queue with wait times, the storage donut (`used /
    capacity`) + per-tier resource tables (bucketed by the same `tierGoods` the Trade tab uses), and the
    selected berth's craft (`hold used / capacity`). It is the WINDOW, not the control panel — **nothing
    here starts a transfer**. The client computes NO game number (§18): the ENGINE gained **three additive,
    derived-on-read snapshot fields** so the view invents none — `slots[i].totalTicks`
    (`outpostDockTurnaround(class)`), the outpost row's `used` (`usedSpace(stockpile)`), and each vehicle
    row's `capacity` + `used` (`usedSpace(cargo)`). Derived-only, so `persist`/determinism goldens are
    **byte-identical** (an empty-dock galaxy is unchanged); the ASSETS tier tab + the Maintenance Hangar are
    parked placeholders (no engine data). Sim suite 1,412 → **1,415 green** (three new tripwires on the
    fields); rendered end-to-end in headless Chromium (click → OPEN DETAILS → the manager; DOCKED countdown
    + fill; QUEUED wait times; the donut + RAW/PROCESSED tables; the parked ASSETS/hangar; an empty outpost
    opens cleanly). **Display calls (surfaced, not invented):** the berth ordinals (`DOCK 01…`) are client
    numbering — the engine's `slots[]` is an unordered list of active transfers with no berth identity, so a
    vacant row is inert; the derived outpost name (anchor name + " Outpost", `#NN` fallback); the parked
    ASSETS tab + Maintenance Hangar. **Still deferred:** the manual load/unload popup (the shared manifest
    editor, cargo engine slice B) and the OPERATIONS dock display.
  - **slice 3-client, playtest fixes.** 🟢 *BUILT — CLIENT ONLY (`client/game.html`, no engine/snapshot/`sim`
    change; the parked lifecycle, `dockStatus`, and the space figures are all already published — design.md §4/§18).*
    Two fixes found playing the read-only manager: (1) **a craft parked on an Outpost's hex no longer steals the
    Outpost's map click** — the map label pass skips a deep-space craft whose hex is in `guildOutpostByKey`, so it
    draws no name-tag to intercept and `handleClick` falls through to the hex chain (which already resolves the hex
    as `guildOutpost` → OPEN DETAILS → the manager); a bare-hex idle craft's label is unchanged. (2) The parked
    craft is **shown in the manager's DOCKED tab** under a new **"Parked · awaiting orders"** group — the player's
    own vehicle rows whose `dockStatus` is `{ state:'parked', outpostId }` (a filter, not new data), selectable
    (a `'parked'` selection kind, guarded like slot/queue) and read into the right hero; it holds no berth (§4), so
    it sits above the ten unchanged docks (no parked craft ⇒ no group). (3) The **popup height is now stable across
    all four tier tabs** — `#outpost-overlay .est-body` takes a fixed height (reusing the existing 620 figure) and
    the resource grid scrolls inside a flex-capped `.om-tierbody` (Tier 3's 25 modules scroll; RAW/PROCESSED don't),
    so the donut, Maintenance Hangar, and tier tabs stay fixed. Sim suite **1,415 green** (untouched — client-only);
    rendered end-to-end in headless Chromium (parked craft opens the manager not Dispatch and lists under Parked;
    a far bare-hex craft still opens Dispatch from its label; the popup height is identical tabbing 1→2→3→4).
    **View + select only** — giving a parked craft an order / dispatch-from-the-manager is slice B (the shared
    manifest editor), still out of scope.
  - **slice 3-client, Parked/Queued merge + readability.** 🟢 *BUILT — CLIENT ONLY (`client/game.html`, no
    engine/snapshot/`sim` change; the park/queue/slot model, `dockStatus`, and the space figures are all already
    published — design.md §4/§18 UNCHANGED, this only re-presents them).* A playtest UX simplification: the manager
    surfaced three waiting-states (Docked / Parked / Queued) where a player needs two. (1) **DOCKED → the ten berths
    only** — the "Parked · awaiting orders" group is removed from the `OM.tab==='DOCKED'` branch of `renderLeft`;
    DOCKED now renders exactly the slot-held craft (`Dock NN`, counting down) plus vacant fillers to `dockCapacity`.
    (2) **QUEUED → PARKED, the unified waiting line** — the tab is renamed (label + `OM.tab` value `'QUEUED'`→
    `'PARKED'` + the `omTabQueued`→`omTabParked` id, kept internally consistent) and its list is the UNION of the two
    engine waiting-states shown together: engine-`queue` craft (a manifest, waiting for a berth — `class · #NN` over
    the existing wait subline) then parked craft (`parkedCraft()`, no manifest — `class · #NN` over an "awaiting
    orders" subline). Both keep their existing `'queue'` / `'parked'` selection kinds; empty union ⇒ a single
    "No craft parked" placeholder. Display order is queued-then-parked, a **stable presentation order only** — the
    unified-queue promotion/priority ruling (a parked craft keeps its arrival spot; a manifest-carrying craft behind
    it jumps it) is a slice-B design ruling, NOT encoded here. (3) **Row/label text enlarged for legibility** — the
    `#outpost-overlay .om-row` text is pushed toward ~double (`.cl` 12→18px, `.berth` 9→13px, `.sub` 10→14px, tabs
    10→13px), the resource-grid cells match it (`.om-cell .nm`/`.q` 11→15px), and `.om-row`/`.om-cell` min-heights
    grow so nothing clips; the list + tier grid still scroll inside the fixed 620px body, so the popup height is
    unchanged (playtest-fix 3 holds). Sim suite **1,415 green** (untouched — client-only; the served-page tripwire
    stays green); rendered end-to-end in headless Chromium (a parked craft + a queued craft both list under PARKED,
    DOCKED shows only berths; one tick promotes the queued craft into a DOCK berth and it leaves PARKED; the enlarged
    text is not clipped and the body height is identical across the four tier tabs; an empty Outpost shows "No craft
    parked" + ten vacant berths, no console errors). **Display calls (surfaced, not invented):** the unified list's
    queued-then-parked display order, and the enlarged font/row-height figures (display sizes, tunable). **Deferred,
    not invented:** the unified-queue promotion/priority ruling → slice B; giving a parked craft an order / manual
    dispatch → slice B.
  - **slice 4 — the Tier-4 build/deploy path.** The buildable/deployable kit, placement range, anchor-ownership. *→ Now the **deploy pipeline** item (below, `territory-model.md` §5): its slice 1 builds the deployable `outpost_kit`, the placement range and anchor-ownership (a guild deploys within 10 hexes of a system it holds). The BUILDABLE half — a dockyard producing the kit — is a later rung there.*
- **2.2 — cargo: the load / haul / unload engine (design.md §4 "The dock model").** The craft's hold
  and the manifest that fills/empties it — the substrate that turns dispatch (above) into a real
  load → haul → unload loop. Built as a ladder around the design's split (a transfer is INSTANT at a
  system, but goes through the deadlock-free park/queue/slot/turnaround dock model at an Outpost):
  - **slice 1 — the craft hold + load/unload at a system (engine + operator CLI).** 🟢 *BUILT (21-09-26).*
    `Vehicle.cargo` (a `good → int` hold, capped by `capacity` in `Σ qty × volumeOf` space, omit-when-empty,
    deep-copied — `sim/state.js`); the journalled **`transferCargo`** action (`sim/actions.js`, `{ guildId,
    vehicleId, manifest }`) that refuses whole unless the guild owns an idle craft **at a system** with a
    well-formed manifest, then resolves it INSTANTLY (no slot, no timer) in the design's fixed order —
    **all unloads first, then all loads**, each line `min(qty, source holds, destination space)` against
    the live totals, partial-safe, the unloads-before-loads cascade freeing the space the loads then use;
    goods move between the hold and the guild's `(guild, system)` pool via `sim/stock.js` (ruling B1), no
    fuel/credits, every mutation tick-stamped. **Galactic Supply now counts the hold** (`sim/supply.js`
    folds each craft's `cargo` in beside the pools; `checkGalacticSupplyConsistency` agrees), so a load is
    conserved and `removeVehicle` refreshes the cache — destroying a laden craft is the accounted goods
    sink §15.4's forward contract named. `checkVehicleIntegrity` guards a corrupt hold (known good,
    positive-int qty, `Σ qty×volumeOf ≤ capacity`); the snapshot row surfaces the hold as a stable `cargo`
    map (the client reads it later). Exposed as `POST /admin/vehicle/transfer` + `tools/admin.js
    transfer-cargo --load good:qty,… --unload good:qty,…` (prints the resulting hold + the system-pool
    deltas). **No new number** — capacity and `volumeOf` are reused. **A NO-OP on a galaxy where no craft
    loads** (persist/determinism/galactic-supply goldens byte-identical — an empty hold omits its key).
    Sim suite 1,383 → **1,398 green**, `tools/admin.test.js` 35 → 37. **Deferred:** the Outpost dock model
    (park / queue / the ten slots / the per-class `OUTPOST_DOCK_TURNAROUND` timer / transfers at an Outpost
    — cargo engine slice 2, aka the outpost ladder's slice 3); route-embedded auto-manifests and the manual
    load/unload popup (client slices); selling from an Outpost (later). No client touched.
  - **slice 2 — the Outpost dock model (engine + operator CLI).** 🟢 *BUILT (21-09-26).* The
    park/queue/slot/turnaround at an Outpost (the timed half of §4): `transferCargo` at one of the guild's
    OWN Outposts (reached by hex-coincidence — a guild Outpost is not a location landmark, so the craft's
    bare-hex berth sits on the Outpost's `{q,r}`) is QUEUED, not instant. The manifest records on the
    Outpost's `queue` (`readyTick` = the confirm tick); the craft stays plain `idle` (parked). A new tick
    step **`stepOutpostDocks`** (after `stepVehicleArrivals` — arrive-then-dock in one tick) promotes
    queued craft into free slots (≤ `OUTPOST_DOCK_SLOTS`, earliest `readyTick`, tie-break stable id,
    `completionTick = thisTick + OUTPOST_DOCK_TURNAROUND[class]` = 5/30/120) — the craft carries the new
    `loading` status while slotted (so `dispatchVehicle` refuses it) — then resolves every slot completing
    this tick via the ONE shared resolver (`sim/manifest.js`, extracted from slice 1) against the hold and
    the Outpost's **hard-capped** stockpile (an unload clamps to the room remaining — the partial case);
    goods move at COMPLETION, the craft returns to parked, the slot frees. **Galactic Supply now counts
    Outpost stockpiles** (`sim/supply.js` folds each `outpost.stockpile` in; the consistency invariant
    agrees), so a completion is conserved. **`removeOutpost`** cashes the teardown deferral — evicts docked
    (`loading`→`idle`) + queued craft to idle-in-space at the hex with their pre-transfer holds (a
    mid-turnaround loader leaves un-happened) and DESTROYS the stored goods (supply drops by exactly that);
    **`dispatchVehicle`** cancels a re-dispatched queued craft, refuses a loading one. `checkOutpostIntegrity`
    guards the dock state (slots ≤ `dockCapacity`, live owner-held craft, one dock per craft, status/kind
    match, tick fields, well-formed manifests) and the stockpile hard cap. The snapshot surfaces the
    `queue`/`slots` (per-slot ETA) and each craft's `dockStatus` (parked/queued/loading+eta). One manifest
    per craft (a second is refused); `spycraft` (capacity 0, no ruled turnaround) is refused. **No new
    number** — `OUTPOST_DOCK_SLOTS` / `OUTPOST_DOCK_TURNAROUND` are `phase-1-tuning.md`'s. **A NO-OP on a
    galaxy with no Outpost transfer** (the step early-returns; `queue`/`slots`/`stockpile` omit-when-empty;
    goldens byte-identical). Sim suite 1,398 → **1,412 green** (`sim/tests/outpost-dock.test.js`, +14).
    **Deferred:** the manual load/unload popup + the OPERATIONS dock display (client), route-embedded
    auto-manifests, selling from an Outpost. No client touched.
  - **slice 2.2 — the manifest MAX mode (engine + operator CLI).** 🟢 *BUILT (21-09-26).* A tiny
    extension to the manifest model for the DOCK popup (client slice B) to drive: a line may now be
    `{ dir, good, max: true }` (no `qty`) for **max** — "as much as possible" — alongside the existing
    `{ dir, good, qty }` fixed amount (§4). The **ONE shared resolver** (`sim/manifest.js`) drops the
    `qty` term for a max line — the clamp becomes `min(source holds, destination's remaining space)`,
    expressed as an `Infinity` cap so it falls out of the same `min` against the LIVE running totals
    (no special branch): a max load fills the hold or drains the store's stock; a max unload empties
    the hold or stops at an Outpost's hard cap (partial). A max line consumes whatever room/stock its
    phase has left, in listed order — deterministic (§15.5 inv 9). **`transferCargo` validate** accepts
    the two shapes and rejects both-`qty`-and-`max` / neither / a non-`true` `max` (the shared
    `manifestAmountError`, reused by `checkOutpostIntegrity` so gate and invariant can't drift). The
    outpost-queue copy + the snapshot `queue`/`slots` carry a max line as `{ dir, good, max: true }`
    (never `qty: undefined`) via the shared `copyManifestLine`, so the later client tells the two
    apart. The `transfer-cargo` CLI takes a `good:max` token (`--load titanium:400,ammonia:max`).
    **No new number** (max removes a cap, adds none). **A NO-OP on a galaxy whose every manifest is an
    amount line** (the max branch is never taken; goldens byte-identical). Sim suite → **1,433 green**
    (+18: `sim/tests/manifest.test.js` new, plus max tripwires in `cargo-transfer`/`outpost-dock`);
    `tools/admin.test.js` 37 → **39**. **Deferred:** the DOCK popup + capacity bar that drive max
    (client slice B). No client touched (`client/game.html` untouched).
  - **slice B — the DOCK popup + Parked-row actions (client).** 🟢 *BUILT (CLIENT ONLY —
    `client/game.html`; no engine/snapshot/`sim`/`tools` change. `transferCargo`, the MAX manifest and
    the dock lifecycle are all merged (slices 1/2/2.2); this only builds the UI that drives them, off
    already-published figures — design.md §4 the settled+built manifest amount/max model, §18 the client
    computes no game number).* The manual load/unload UI the read-only Outpost Manager left deferred. Two
    pieces: (1) **the PARKED-tab action bar** — in `renderLeft`'s PARKED branch an awaiting-orders craft
    (`parkedCraft()`, no manifest) now renders as an ACTION CARD with a two-button row: **DOCK** (opens
    the manifest editor for that craft + this outpost, `window.__openDock(craftId, OM.id)`) and
    **DISPATCH** (opens the existing Dispatch popup, `window.__openDispatch(<craft row>)`); the buttons
    `stopPropagation` so the card stays selectable for the right-hero read-out. A QUEUED craft (`row.queue`
    — already holds an engine-queued manifest) renders as before with NO buttons, so it reads at a glance
    which craft need an action. (2) **the `#dock-overlay` manifest editor** — a new overlay + CSS block +
    IIFE mirroring `#dispatch-overlay` (same est card / palette / backdrop / Esc-to-close, z-index 580 so
    it sits over the manager). A line builder: each line is a good `<select>` grouped by tier
    (`<optgroup>` off the same `tierGoods`/`window.__goodsCatalog` the resource tables use), a load/unload
    `<select>`, and a quantity — a number input beside a **MAX** toggle (MAX greys/clears the input and
    makes the line a max line). **+ Add line** appends a fresh line; a per-line **×** removes it (never
    below one line). A **hold-capacity bar** shows `used / capacity` against the craft's `capacity`: the
    solid fill is `Σ (load line's fixed amount × goodVolumes[good])`, and a hatched remainder appears when
    any load line is MAX (a max load fills whatever's left). **Confirm** builds the manifest in listed
    order — each line → `{ dir, good, qty }` (positive int) or `{ dir, good, max:true }` — and fires
    `window.__sendAction({ type:'transferCargo', … })`; accepted → close (the craft leaves Parked for the
    queue on the next poll), refused → the engine `reason` shows inline and the popup stays open. Confirm
    is disabled while the manifest is empty or any line is incomplete (no good, or an amount line with a
    non-positive/blank qty). **Display calls (surfaced, not invented):** the capacity bar is an
    **EMPTY-HOLD estimate** — it deliberately ignores cargo already aboard and other legs, summing only
    the entered load amounts × published `goodVolumes` (a §18 display projection; the ENGINE resolves the
    transfer authoritatively on confirm); the MAX line's listed order decides which same-phase line gets
    the remaining room (§4), reflected in the manifest's build order. The only new constants are display
    sizes (the CSS). Sim suite **1,433 green** (untouched — client-only; the served-page tripwire
    `sim/tests/server.test.js` stays green). **Deferred, not invented:** the SYSTEM-transfer entry point
    (instant load/unload at a system — the same editor, opened from a system later); editing/cancelling a
    QUEUED craft's manifest (that stays re-dispatch via Operations); a stock hint / stock-filter in the
    good dropdown (the player reads availability from the manager's resource tables).
  - **slice B, playtest fixes.** 🟢 *BUILT — CLIENT ONLY (`client/game.html`; no engine/snapshot/`sim`
    change — `cargo`/`used`/`capacity` are already published on every vehicle row (cargo slices 1/2),
    design.md §18: the client displays them, computes no game number).* Two fixes found playing the DOCK
    loop: (1) **opening DISPATCH from the Outpost Manager closes the manager first** — the PARKED-tab
    DISPATCH handler calls `closeManager()` before `window.__openDispatch(v)`, so the Dispatch popup opens
    unobstructed (both overlays are `z-index: 570`, which had left Dispatch behind the manager). DOCK is
    unchanged — its editor is `z-index: 580` and is meant to sit over the still-open manager. (2) **the
    Dispatch popup's Onboard Manifest now renders the craft's real hold** instead of the hard-coded "Hold
    empty · 0 / — capacity": `renderPrePlan` reads `DP.vehicle.cargo`/`used`/`capacity` (re-read from the
    live row each open) — an empty hold shows `Hold empty` + `0 / <capacity> cargo space` (the real cap,
    not `—`), a laden hold lists each good (`<pretty name>` · `<qty>`, `fmtNum`-formatted) plus the
    published `<used> / <capacity> cargo space` summary. Sim suite **1,433 green** (untouched — client-only;
    the served-page tripwire stays green); verified end-to-end in headless Chromium (a laden craft lists its
    goods + used/capacity; an empty craft shows the real capacity; Outpost Manager → PARKED → DISPATCH
    closes the manager and the Dispatch popup is fully visible, DOCK still opens its editor over the
    manager; no application console errors). **Display calls (surfaced, not invented):** the goods rows are
    sorted by good id (stable display order) and the row/summary font sizes are display constants (CSS).
  - **Operations tab, craft hold wired.** 🟢 *BUILT — CLIENT ONLY (`client/game.html`; no engine/snapshot/`sim`
    change — `cargo`/`used`/`capacity` are already published on every vehicle row, idle AND in-transit,
    design.md §18: the client displays them, computes no game number).* A playtest follow-up on the merged
    cargo UI: the Operations tab ignored a craft's hold in two places, both predating the cargo engine.
    (1) **The in-transit craft manifest** (`craftRowHtml`) hard-coded "No cargo."; it now itemises the
    craft's published `v.cargo` (one `ops-manrow` per good — pretty name + `fmt` quantity, sorted by good
    id) plus a `used / capacity` Hold summary row, an empty hold keeping the single `No cargo.` row —
    mirroring the sibling Syndicate shipment manifest (stockpile goods, so a plain quantity, no "Nu").
    (2) **The Idle Transports craft card** (`tpCraftHtml`) showed only Maintenance + Dispatch; its expanded
    body now carries a Hold stat line (`used / capacity`, mirroring the Maintenance line) with the goods it
    carries listed beneath, an empty hold reading `Hold empty` under a `0 / <capacity>` summary. Added one
    tiny local `prettyGood` (snake_case → Title Case) — the other panels' copies live in their own IIFEs,
    out of scope here. Sim suite **1,433 green** (untouched — client-only; the served-page tripwire stays
    green). **Display calls (surfaced, not invented):** goods rows sorted by good id (stable order); the
    in-transit manifest carries the same used/capacity summary row as the idle card, for parity.
  - **DOCK editor made hold-aware.** 🟢 *BUILT — CLIENT ONLY (`client/game.html`; no engine/snapshot/`sim`/`tools`
    change — the vehicle row already publishes `cargo`/`capacity`/`used` and the snapshot already publishes
    top-level `goodVolumes`, design.md §4/§18: the client displays them, computes no game number).* A playtest
    fix on the DOCK / Manifest editor (cargo slice B): a laden craft opening the editor gave no sign of what it
    already carried, and the capacity bar was an EMPTY-HOLD estimate that pretended the hold started empty — so
    a craft carrying 3,000 ammonia "looked empty" in the one screen where the player decides what to load/unload.
    Two pieces: (1) a **"Currently aboard" read-out** (`renderAboard` → `#dkAboard`) above the Manifest sechead —
    one row per good in `v.cargo` (pretty name + `fmtNum` quantity, sorted by good id) plus a `Hold used <used> /
    <capacity> cargo space` summary (both published, `used` not recomputed), an empty hold showing a muted `Hold
    empty` row; re-read off the live row each render. (2) the **capacity bar is now a projection over the REAL
    current hold** (`refreshDerived` reworked), mirroring the engine's §4 resolution order — ALL UNLOADS first
    (each removing `min(amount, units aboard)`, MAX emptying the good), then ALL LOADS (fixed loads clamped by the
    room left, a MAX load filling to capacity): `base = v.used` (the faded `#dkBarBase` segment, the hold that
    survives), the solid `#dkBarSolid` stacked ON TOP for this order's load, the hatch to capacity for a MAX load;
    head relabelled "Hold after this order", figure `projUsed / cap`, with a faded/solid legend (`Already aboard` /
    `This order`). Sim suite **1,433 green** (untouched — client-only; the served-page tripwire stays green);
    verified end-to-end in headless Chromium (a 3,000-ammonia craft parked at an outpost: "Currently aboard" reads
    the real 3,000 / 10,000, a +4,000 load stacks to 7,000 / 10,000, an amount/MAX unload drops the base, a MAX
    load hatches to capacity from the top of the real hold, an empty craft reads `Hold empty` / 0 / capacity — no
    console errors). **Display calls (surfaced, not invented):** the projection follows §4's unload-then-load order
    so the estimate matches what the engine will do; a net-unload simply reads the bar shorter and the figure lower
    (the per-good picture lives in the "Currently aboard" read-out, so the bar stays a pure space projection);
    the new constants are display sizes/colours (the faded base segment reuses the overlay's amber palette).
  - **Operations tab, idle transports parked at an outpost group under that outpost.** 🟢 *BUILT — CLIENT ONLY
    (`client/game.html`; no engine/snapshot/`sim`/`tools` change — `location` and `dockStatus` are both already
    on every idle vehicle row, design.md §15.4/§18: the client buckets published values, computes no game number).*
    A playtest fix on the OPERATIONS Idle-Transports grouper: a craft parked / queued / loading at a guild outpost
    berths by hex-coincidence, so its published `location` is the outpost's bare hex (anchored to nothing) and the
    grouper dropped it into the shared **DEEP SPACE** bucket — even though a craft whose `location` is that outpost
    landmark already groups under the outpost. Two tiny read-time branches, each off `dockStatus.outpostId`: (1)
    `tpGroupOf` now returns `{ key: 'outpost:'+id, name: outpostName(id) }` — the SAME key/name the landmark-outpost
    branch produces, so a parked craft merges into the one outpost group — placed after the landmark checks and
    before the bare-hex DEEP SPACE branch, so it wins for a parked craft's bare-hex location; (2) `tpCraftWhere`
    mirrors the precedence, labelling a docked craft with its outpost name (before the `(q, r)` branch). A craft
    with no dock relation still falls to DEEP SPACE with its `(q, r)`; a craft idle at a system is unaffected. This
    covers `queued`/`loading` craft too (they carry `dockStatus.outpostId`) — correct, they're at the outpost.
    Sim suite unchanged (client-only; the served-page tripwire stays green). **Display calls (surfaced, not
    invented):** none — the outpost `{q,r}`↔landmark relation is the engine's model (§15.4), read here off the
    already-published `dockStatus`, keyed identically to the landmark path so the two paths merge into one group.
  - **One canonical guild-outpost display-name resolver.** 🟢 *BUILT — CLIENT ONLY (`client/game.html`; no
    engine/snapshot/`sim`/`tools` change — `anchorSystemId` is already on the outpost row, design.md §15.4/§18;
    no design.md change, the anchor-derived naming convention is pre-existing).* Naming follow-up to the grouping
    above: those new group headers read `window.__outpostName(id)`, but that resolver knew only the seed Syndicate
    waystations (static `/galaxy` geometry) — a guild outpost id isn't there, so a header fell back to the raw
    `outpost_<guild>_NN` id and disagreed with the Outpost Manager's friendly title. Fix: `window.__outpostName`
    is now the ONE resolver — seed waystation by stored name (unchanged first branch, a no-op for every existing
    waystation caller), ELSE a guild outpost looked up on the live snapshot and named `<anchor system> Outpost`
    (fallback `Outpost #NN`) the way the manager already derives it, ELSE the raw id (guarded, non-throwing before
    the first snapshot). The Outpost Manager's private `outpostName(row)` now delegates to it (`window.__outpostName(row.id)`),
    so the derivation lives in one spot and the manager title and the Operations grouping header can't drift. The
    grouping code (`tpGroupOf`/`tpCraftWhere`) is untouched — it just starts reading the friendly name. Sim suite
    unchanged (client-only; served-page tripwire green). **Display calls (surfaced, not invented):** none — the
    same anchor-derived convention, now centralised.
  - **The SYSTEM-transfer DOCK entry point + the spycraft DOCK-button gate.** 🟢 *BUILT — CLIENT ONLY
    (`client/game.html`; no engine/snapshot/`sim`/`tools` change — `transferCargo` at a system already resolves
    instantly against the guild's soft-capped system pool (cargo engine slice 1), design.md §4 the SYSTEM half;
    no design.md change, "a spycraft cannot dock" is the engine's existing refusal now surfaced in the UI).* The
    slice-B deferral — "the SYSTEM-transfer entry point (instant load/unload at a system — the same editor, opened
    from a system later)" — landed. In OPERATIONS → Idle Transports, a craft **idle at a system and not a
    spycraft** (`v.location.landmarkKind === 'system'` && `v.class !== 'spycraft'`) now renders a **Dock** button
    (`.ops-tp-dock`, styled like Dispatch, in a flex pair before it) beside Dispatch; its delegated handler calls
    `window.__openDock(id, null)` — the SAME manifest editor a parked-at-outpost craft uses, with a **null**
    outpost, so the engine branches on where the craft sits and resolves the transfer **instantly** (no queue, no
    turnaround) against the system pool. The editor is reused UNCHANGED (no system mode, no header/capacity-bar
    change): a system transfer is instant and hold-bounded, which the existing popup already models. A craft
    parked at an outpost (its DOCK is the Outpost Manager) or adrift in deep space gets no system Dock; a spycraft
    at a system gets Dispatch only. **The spycraft gate's second site:** the Outpost Manager PARKED action bar now
    renders its **Dock** button only for a non-spycraft parked craft (`v.class !== 'spycraft'`) — a spycraft has
    no hold and the engine refuses its transfer, so the button (which was shown to it before, and refused on
    confirm) is gone; Dispatch is unchanged for a parked spycraft. Sim suite **1,439 green** (untouched —
    client-only; the served-page tripwire stays green); verified end-to-end in headless Chromium (a transport idle
    at a system shows Dock + Dispatch, Dock opens the editor, a `titanium` load + Confirm resolves instantly — the
    hold grows and the system pool shrinks with no tick; a spycraft at a system shows Dispatch only; a parked
    spycraft shows no Dock in the manager while a parked transport still does; a transport parked at an outpost
    shows no system Dock in Operations; no application console errors). **Display calls (surfaced, not invented):**
    the Dock button reuses the Dispatch button styling; the flex button-row split is a display size (CSS).
  - **Idle-Transports hold-staleness fix: cargo folded into the rebuild signature.** 🟢 *BUILT — CLIENT
    ONLY (`client/game.html`; no engine/snapshot/`sim`/`tools` change — `cargo`/`used` are already
    published and already read by `tpCraftHtml`).* A playtest follow-up on the craft-hold wiring + the
    SYSTEM-transfer entry point above: loading cargo onto a craft at a system (an instant transfer) with
    the OPERATIONS → Idle Transports panel open left the craft's expanded card reading "Hold empty" /
    `0 / cap` until an unrelated change forced a rebuild. Root cause: `renderIdleTransports`'s rebuild
    signature (a render-guard that preserves the reader's collapse/expand state across polls, §18)
    carried id/group/location/status/maintenance but **not** the hold — so an in-place cargo change,
    which the instant system transfer makes trivial to trigger with nothing else moving, didn't shift
    the signature and the card early-returned frozen. Fix: one appended term folding a canonical (sorted)
    per-good cargo fingerprint into each craft's signature — mirroring what the card renders (the Hold
    stat + the goods list, not just a total, so a load, an unload, or an equal-volume swap all rebuild);
    the guard and rebuild body are otherwise unchanged, so the reader's open/closed state still survives.
    Sim suite **1,439 green** (untouched — client-only; the served-page tripwire stays green). *Deferred,
    not folded in: the IN-TRANSIT list has its own separate signature and a laden in-transit craft's
    manifest is a separate surface — not touched this slice.*
- **2.2 — Transport: route actions, saved lanes & repeating runs (the automation layer).** The continuation of the guild-transport UI: per-waypoint load/unload ACTIONS that run automatically on arrival, SAVED reusable lanes, and REPEATING runs (continuous or N laps) — the self-repeating trade lane. Design contract: **transport-model.md §11** (RULED 22-09-26; the entity, the chained-legs execution, up-front per-run/per-lap fuel, the reposition rule, and the partial-proceeds / anchor-gone failure split). Built as a ladder: **1a** engine (one-shot route-with-actions execution — chained legs, per-waypoint action, up-front per-run fuel; operator-CLI driven, no client) → **1b** client (the two authoring entry points — the map chip at placement + the dispatch Finalise list to manage — plus the outpost-name label fix) → **2** saved routes (per-guild store + Save / Load Route UI + re-validate at load) → **3** repetition (continuous / N-run with the reposition rule, per-lap fuel + re-validation + pause/resume/cancel). *Pulls the transport-model.md §9/§10 "Phase 4" route-planner automation forward into Phase 2.* ✅ **Ladder DONE (24-09-26)** — 1a → 1b → 2a / 2a.1 → 2b → 3a / 3a.1 → 3b → 3c-engine → 3c (client) all BUILT: a guild can author an actioned route, save / load it, launch it once / continuous / N-run at an immediate or per-cycle cadence with the per-lap cost shown, watch its laps and waits, and Cancel or Stop it after this run.
  - **slice 1a — engine (one-shot route-with-actions execution).** 🟢 *BUILT (22-09-26 — `sim/actions.js`,
    `sim/tick.js`, `sim/invariants.js`, `sim/snapshot.js`, `sim/server.js`, `tools/admin.js`; tripwires
    `sim/tests/route-actions.test.js` (new), `tools/admin.test.js`; contract transport-model.md §11 —
    engine + operator CLI, NO client).* The chained-legs execution seam. A new journalled action
    **`dispatchRouteWithActions`** (`sim/actions.js`, `{ guildId, vehicleId, waypoints }`, each waypoint
    `{ anchor, action? }` with `action = { type:'dock', manifest }`) validates WHOLE / refuses WHOLE — idle
    owned craft, every leg (craft → W1 → … → WN) resolves and is non-zero-length (reuses `dispatchRoute`),
    every action's manifest well-formed (the shared `manifestError`, extracted from `transferCargo`), a
    spycraft (capacity 0) with any action refused, and the WHOLE run's fuel (`Σ legFuelBurn`) covered.
    Apply burns that fuel UP FRONT (§11.3), journals `vehicle.route = { waypoints, cursor }` (omit-when-absent),
    and dispatches the FIRST leg (`buildSingleLegTrip`, the one-home single-leg trip). The chained execution
    is one funnel **`advanceRoute`** called by the two tick hooks: **`stepVehicleArrivals`** — on arrival a
    routed craft resolves the waypoint's action (INSTANT at a system via `resolveManifest`; QUEUE at an owned
    Outpost, exactly as `transferCargo` does; a no-action waypoint chains straight through) then advances;
    **`stepOutpostDocks`** — advances after the slot resolves at turnaround (the turnaround IS the pause).
    The run ends idle at the last waypoint, `route` cleared, no `trip`. Partial-safe (§11.6 — a partial load/
    unload never stalls the lane); anchor-gone (an outpost torn down mid-run) HALTS SAFELY (idle at the current
    berth, route cleared, no throw). `checkVehicleIntegrity` asserts the route (`routeViolation`: ≥1 waypoint,
    cursor in range, anchors resolve, actions well-formed); the snapshot surfaces a routed craft's `route`
    (fresh-copied). Exposed as `POST /admin/vehicle/dispatch-route` + `tools/admin.js dispatch-route --route
    "sys:A@load:titanium:400; q,r@unload:titanium:400"`. **No new number** — reuses the §4 manifest resolver,
    the §4 dock turnaround, the §2.2 leg time/fuel. **A NO-OP on a galaxy that dispatches no actioned route**
    (`route` omit-when-absent; persist/determinism/galactic-supply goldens byte-identical). Sim suite 1,439 →
    **1,453 green** (`route-actions.test.js` +14); `tools/admin.test.js` 39 → **42**. Driven end-to-end via the
    CLI against a booted server (load @ system, deliver @ outpost, craft idle at the last waypoint). **Deferred,
    not invented:** the client + the two authoring entry points (1b), saved routes (2), repetition + the
    reposition rule + the anchor-gone flag surfacing (3). The §11.4 zero-length-reposition SKIP is the
    reposition rule (slice 3), so 1a refuses a route whose first waypoint IS the craft's berth (a zero-length
    first leg) — a run positions to a distinct first waypoint. *(Superseded by slice 2a — that reposition is now
    SKIPPED, §11.9.)*
  - **slice 1b — client (the two authoring entry points + the outpost-name label fix).** 🟢 *BUILT (23-09-26 —
    CLIENT ONLY, `client/game.html`; no engine/snapshot/`sim`/`tools` change — it drives the 1a
    `dispatchRouteWithActions` through the existing `POST /action`; contract transport-model.md §11.1 / §11.7 /
    §18).* Six isolated pieces. **(1) The waypoint shape:** the map planner's `PLAN.waypoints` and the Dispatch
    popup's `DP.waypoints` are now `[{ anchor, action? }]` (§11.1) — every geometry read (draw chain, dead-leg
    check, labels) goes through `wp.anchor`; the quote and the plain dispatch still receive a bare anchor list.
    **(2) The dock editor as a manifest COLLECTOR** (reused, not forked): `window.__openDock(craftId, outpostId,
    onSave?, existing?)` — with `onSave` the primary button reads "Save action" and Save hands the identical
    manifest to `onSave(manifest)` instead of posting `transferCargo`; `existing` opens it pre-filled with a
    **Clear action** (`onSave(null)`). Without `onSave` it behaves exactly as before (the Outpost Manager and the
    Operations system Dock are untouched). **(3) Entry point A — the map chip:** on an ACTIONABLE candidate the
    chip gains **[Action]** beside Add/Confirm; Save stashes the manifest on the candidate and Confirm bakes
    `{ anchor, action }` into the waypoint; the left list shows a set action as a sub-line ("dock · load
    titanium 400"). **(4) Entry point B — the Finalise list:** each row's reserved slot is its action control
    ("+ Action" unset / filled "● Action" set, summary sub-line) — add / edit (pre-filled) / clear on the
    laid-out route, no re-quote (an action never changes a leg). **(5) Dispatch:** any action set → POST
    `dispatchRouteWithActions` with `{ anchor, action? }` per waypoint; none → the plain `dispatchVehicle`
    exactly as before (the frozen multi-leg flight + animation); a refusal surfaces the engine's reason.
    **(6) Labels:** the shared `__landmarkNameAt` now also resolves a GUILD outpost's hex (off the live
    snapshot) through the canonical `__outpostName`, so a guild-outpost waypoint reads "<system> Outpost" in
    the map list, the Dispatch list and the Dispatch Location (a craft parked there), not "(q, r)"; a plain hex
    still reads "(q, r)". **The gate** (both entry points, one shared `routeActionAllowed`): the §11.7 first cut
    — a system the guild holds or the guild's OWN outpost (matched by hex, since a planner click on a guild
    outpost records a bare `{ q, r }`); a Syndicate waystation, an unheld system or open space is a pure turning
    point, and a spycraft (no hold — the engine refuses its actions) gets no Action, mirroring the existing
    DOCK-button class gate. Sim suite **1,453 green** (untouched — client-only; the served-page tripwire stays
    green). Verified end-to-end in headless Chromium: the chip shows Action on a held system / own outpost and
    not on an unheld system, a bare hex, or for a spycraft; the editor opens in collect mode ("Save action"),
    re-opens pre-filled with Clear; the Finalise list adds / edits / clears and the Time/Cost hold; a no-action
    route posts `dispatchVehicle` unchanged, an actioned one posts the exact `dispatchRouteWithActions`
    payload, a fuel refusal shows the engine reason; a bare hex → home (load titanium 400) → own outpost
    (unload titanium 400) run ticks through with the 400 moving from the home pool into the outpost stockpile
    and the craft idle at the outpost; labels read the outpost's name; no application console errors.
    **Display calls (surfaced, not invented):** the chip's "Action" / "Action ✓" and the list's "+ Action" /
    "● Action" labels + styles; the summary wording; the sub-lines wrap rather than truncate; the editor's
    eyebrow reads "Route Action · Manifest" in collect mode. **Slice-local call:** the editor's "Currently
    aboard" + hold bar show the craft's hold NOW — exact for its first actioned stop, advisory for later ones
    (the engine resolves each stop against the real hold on arrival, partial-safe §11.6). **Side effect, by
    design:** `__landmarkNameAt`'s fourth caller, the OPERATIONS IN TRANSIT destination, now also names a
    guild outpost instead of "Deep Space (q, r)". **Deferred, not invented:** saved routes / Load Route (2);
    repetition + the reposition rule + pause/resume (3); the anchor-gone pause/flag UI (3); a route-mode hold
    view in the editor (projecting the hold at a mid-route stop — revisit if playtest shows it confuses);
    actions at the origin (not a waypoint, §11.1).
  - **slice 2a — engine (the saved-route store + the zero-length reposition skip).** 🟢 *BUILT (23-09-26 —
    `sim/routes.js` (new), `sim/state.js`, `sim/actions.js`, `sim/tick.js`, `sim/invariants.js`, `sim/snapshot.js`,
    `sim/server.js`, `tools/admin.js`; tripwires `sim/tests/saved-routes.test.js` (new), `route-actions.test.js`,
    `server.test.js`, `tools/admin.test.js`; contract transport-model.md §11.9 / §11.4 / §11.2 — engine + operator
    CLI, NO client).*
    **(1) The store** (`sim/routes.js` (new), `sim/state.js`, `sim/actions.js`, `sim/invariants.js`,
    `sim/snapshot.js`; tripwires `sim/tests/saved-routes.test.js` (new)). A guild owns **`savedRoutes`** — rows
    `{ id, name, waypoints: [{ anchor, action? }], updatedAtTick }` built by `createSavedRoute` (waypoints
    DEEP-copied), **omit-when-empty** — and **`savedRouteSerial`** (**omit-when-0**), the exact sibling of
    `vehicleSerial` / `outpostSerial`: ids are `route_<guild>_NN` (`sim/routes.js`, the `outpost_<guild>_NN`
    mirror), bumped at every create, never decremented. Two journalled actions, the spawn/remove validate→apply
    shape: **`saveRoute { guildId, name, waypoints }`** is a NAME-BASED UPSERT — a new name mints a fresh id; a
    name the guild already uses updates that row's waypoints IN PLACE (same id, same list position, serial
    unchanged); it moves no goods/fuel/credits and stamps `updatedAtTick`. Validate: guild exists; `name` a
    non-empty string after trim; `waypoints` non-empty, each checked by **`routeWaypointError`** — the ONE
    per-waypoint gate now shared with `dispatchRouteWithActions`'s validate (anchor resolves; action, if any, a
    `{ type:'dock', manifest }` with a §4 manifest via `manifestError`). A saved route is ORIGIN-FREE, so there
    is no leg-length or fuel check at save time (those are the dispatch's). **`deleteRoute { guildId, routeId }`**
    removes a row the guild owns; an emptied store drops the key. `checkSavedRouteIntegrity` asserts every tick:
    a present store is a non-empty array; each id is `route_<guild>_NN` for its guild and unique; each name a
    non-empty trimmed string, unique within the guild (the upsert key); each waypoint list non-empty and
    well-formed (`waypointListViolation`, extracted from `routeViolation` so a craft's route and a saved route are
    judged by one check); `updatedAtTick` a whole tick; `savedRouteSerial ≥` the highest live suffix. The
    snapshot surfaces each guild's `savedRoutes` as fresh `{ id, name, waypoints }` copies in stored order,
    omit-when-empty. `copyRouteWaypoint` moved from `sim/actions.js` to the new `sim/routes.js` so `state.js` can
    share it without a require cycle. **Slice-local shape calls:** the name is stored TRIMMED and matched
    exactly otherwise (case and inner spaces count — "Ore run" ≠ "ore run"); the row stamps `updatedAtTick` (the
    tick of the LAST save, since an upsert rewrites it — the §11.9 "stamps its tick"); snapshot order is stored
    (first-saved) order. **A NO-OP on a galaxy with no saved route** (both keys omitted; persist/determinism/
    galactic-supply goldens byte-identical). Sim suite 1,453 → **1,472 green** (`saved-routes.test.js` +19).
    **(2) The operator CLI** (`sim/server.js`, `tools/admin.js`; tripwires `sim/tests/server.test.js`,
    `tools/admin.test.js`). Access-gated `POST /admin/route/save { guildId, name, waypoints }` and
    `POST /admin/route/delete { guildId, routeId }`, through the SAME validate → journal → apply path as the
    vehicle endpoints; no list endpoint — `GET /snapshot` carries the routes. `tools/admin.js save-route "NAME"
    --guild ID --route "…"` (the name is the one positional argument — an unquoted multi-word name is refused,
    not guessed at; `--route` is the dispatch-route grammar, now shared with a `command` name for its errors)
    and `delete-route --guild ID --id ROUTE_ID`; both print the guild's saved routes as they now stand. Sim suite
    → **1,474 green** (`server.test.js` +2); `tools/admin.test.js` 42 → **45**.
    **(3) A 1a fix found on the way (`sim/actions.js`; tripwire `route-actions.test.js`).** `dispatchRouteWithActions`
    did not cancel a craft's queued manual Outpost manifest the way `dispatchVehicle` does (design.md §4 "a queued
    craft is cancelled by being re-dispatched away"): the stale entry named a craft now in flight, tripping
    `outpost-dock-status-matches-kind` at once (a 500 over the server), and a tick later the dock step promoted the
    flying craft to `loading`. Both applies now call one `cancelQueuedManifest` (extracted from `dispatchVehicle`,
    unchanged behaviour there). The skip below depends on it — a craft dispatched from its own Outpost would
    otherwise queue a SECOND manifest there. Sim suite → **1,475 green** (+1).
    **(4) The zero-length reposition SKIP (§11.4, pulled forward by §11.9)** (`sim/actions.js`, `sim/tick.js`;
    tripwires `route-actions.test.js`). A `dispatchRouteWithActions` whose craft already sits on W1 used to be
    refused (a zero-length leg 0); now that reposition is SKIPPED. `dispatchRoute` gains one opt-in
    (`skipZeroLengthFirstLeg`, used ONLY by the actioned-route validate + apply): a zero-length leg 0 is left out
    and reported (`skippedFirstLeg`); any later zero-length leg (two chosen waypoints on one hex) is still refused,
    and a one-waypoint route whose waypoint is the craft's berth is refused as "no legs" (§4) *(superseded by
    slice 2a.1 — WITH an action it now acts in place, §11.9)*. The plain dispatch,
    the quote and the chained next-leg builder keep the refusal unchanged. On a skip the apply seats the craft on
    W1's anchor (the same hex — what landing there sets) and runs the SAME `resolveRouteArrival` the arrival step
    uses: a system action resolves at dispatch and the W1→W2 leg goes; an own-Outpost action queues (readyTick =
    now) and W2 goes at turnaround; a no-action W1 flies straight on; no store at W1 halts safely, as an arrival
    would (§11.6). Up-front fuel is Σ over the REAL legs only. No same-tick loop: W1→W2 is a real ≥ 1-tick leg,
    so the craft next lands in a later tick's arrival step (tripwired: the cursor never advances twice in one tick;
    replay byte-identical). To let the apply call the resolver without a require cycle, the executor trio
    (`advanceRoute` / `resolveSystemAction` / `resolveRouteArrival`) moved verbatim from `sim/tick.js` to
    `sim/actions.js` (its own move-only commit); the tick hooks import it. Sim suite → **1,481 green**
    (`route-actions.test.js` +6 skip tripwires; the old "zero-length first leg refused" assertion became "an
    internal dead leg / a no-leg route refused"). **No-op proof:** the persist/determinism/galactic-supply goldens
    are untouched and green, and five runs — zero-state, economy_meanline (+ crisis), supply_relief (400 ticks
    each) and a routed NON-skip lane (1,500 ticks) — hash byte-identical (state + snapshot) on `main` and on this
    branch. **Driven end-to-end via the CLI** against a booted, persisted server (seed 7): `save-route "Ore run"
    --route "sys:sys_0001@load:titanium:400; 78,-7@unload:titanium:400"` → `route_g1_01`, read back from
    `/snapshot`; `dispatch-route` of a craft PARKED at sys_0001 along the same waypoints → the 400 loaded IN PLACE
    at tick 0 (pool 400 → 0), the craft already on the one real leg (fuel 500 → 499), arrived tick 105, unloaded
    at turnaround (outpost stockpile 400), idle at the outpost; restarts after every step reload canonically
    identical; `delete-route` ×2 dropped the key, and a re-save minted `route_g1_03` (never a reissue). (The
    Outpost is addressed as `q,r` — a guild Outpost is not a location landmark; `out:<id>` names a seed waystation.)
    **Deferred, not invented:** the client — Save Route / Load Route / delete (2b); repetition, the lap-start
    anchor-gone check and pause/flag surfacing (3); soft re-validation at load (2b, client); rename (delete +
    re-save, §11.9). **Carried to 2b:** `quoteDispatch` (the Finalise quote) still refuses a zero-length first leg
    — a route loaded onto a craft already at W1 will need the quote to learn the same skip. *(Landed in engine
    slice 2a.1 instead — the quote is engine code (§18), so 2b stays client-only.)* **Two rulings flagged on
    the decision checklist** (both built conservatively, and SINCE RULED 23-09-26 — see the checklist): a one-waypoint route at the craft's own berth, and a
    skipped W1 whose action has no store.
  - **slice 2a.1 — engine (a one-stop route acts in place + the quote learns the skip).** 🟢 *BUILT (23-09-26 —
    `sim/actions.js`; tripwires `sim/tests/route-actions.test.js`, `quote.test.js`, `server.test.js`; contract
    transport-model.md §11.9 "A one-stop route dispatched from its own stop" / §11.4 / §11.3, design.md §18 —
    ENGINE ONLY, no client, no `tools` change).* Two halves of the same skip.
    **(A) A one-stop route acts in place.** The limit case of the 2a skip, now RULED:
    a `dispatchRouteWithActions` whose ONLY waypoint is the craft's own berth, carrying an action, resolves that
    action IN PLACE and the craft ends idle there — no leg, no fuel. **(1) `dispatchRoute`:** when the skip leaves
    no leg it now returns ok with `legs: []`, `totalUnits: 0` and a new `actInPlace: true` marker (every ok result
    carries `actInPlace`), instead of the "no legs" refusal. That refusal stays, as a defensive branch, for a
    legless result that did NOT come from the skip (unreachable today: without the skip, leg 0 is always built or
    refused). An internal zero-length leg is still refused, and the skip never cascades (`[W1(action), W1]` from
    W1 → "leg 1 is zero-length"). **(2) The validate** gates the no-action case: `dispatchRoute` only sees bare
    anchors, so the rule "an act-in-place route must carry an action" lives where the `{ anchor, action? }`
    waypoints are visible. A one-stop route at the berth with NO action is refused ("nothing to fly and nothing
    to do", §11.9 / §4). The per-waypoint gate, the spycraft (capacity 0) refusal and the fuel gate are unchanged.
    The fuel gate over zero legs is trivially met. **(3) The apply is unchanged:** the 2a skip branch already
    covers it. It seats the craft on W1's anchor and runs `resolveRouteArrival`, and because W1 is also the last
    waypoint, `advanceRoute` ends the run instead of dispatching a leg. A system action resolves at dispatch and
    the craft is idle at W1 with no `route` / `trip`. An own-Outpost action queues (readyTick = now), and the dock
    step completes it and ends the run at turnaround, idle at the Outpost (one manifest per craft holds: a queued
    manual manifest is cancelled, and a second transfer on top of the route's is refused). `burnFuel(guild, 0)`
    is a no-op, so nothing burns and there is nothing to refund (§11.3). Comments only. **Follows from two
    rulings (not a new call):** an action at a berth with NO store (a bare hex, e.g. 2b's orphaned action) is
    accepted and halts safely in place, exactly as an arrival there would (§11.6, the RULED "skipped W1 whose
    action has no store"). Here that costs nothing, since there is no leg. **The plain `dispatchVehicle` is
    untouched** and still refuses a standing-still route. Sim suite 1,481 → **1,487 green**
    (`route-actions.test.js` +6: act in place at a system (load, then unload), at its own Outpost (queued →
    turnaround, one manifest per craft), no-action refused with no state change (system / Outpost / bare hex; and
    a spycraft's action still refused), the same one-stop route from elsewhere still flies there first,
    the no-store halt, determinism + a mid-turnaround restart. The old "a one-stop route at the berth is refused
    as no legs" assertion became "no-action one-stop refused" + "the skip never cascades"). The new tests are
    real tripwires: run against the pre-slice `actions.js`, six fail.
    **(B) The quote takes the same skip** (discharges 2a's "Carried to 2b" line). `quoteDispatch` now passes
    `skipZeroLengthFirstLeg` to `dispatchRoute`, so the Finalise quote previews exactly what
    `dispatchRouteWithActions` will fly. A craft already on W1 quotes only the REAL onward legs; the quote for
    `[W1, W2, …]` from W1 is identical to the quote for `[W2, …]`. A one-stop route at the berth quotes as acting
    in place: `legs: []`, `totalTicks: 0`, `totalUnits: 0`, `credits: 0`, `affordable: true`, `arrivalTick` = now.
    The builder already handled an empty `legs` (no NaN), so the change is the one option plus comments. After a
    skip there is one leg fewer than waypoints (leg k ends at waypoint k+1). The quote stays action-blind (geometry
    only, as in 1b), so the "act in place needs an action" rule stays the dispatch validate's. An internal dead
    leg is still refused, and so is a dead leg right after a skipped W1. **Scope call:** §11.9 names only the
    one-stop ruling for 2a.1. The quote half was done here rather than in 2b because the quote is engine code
    (design.md §18 — the client computes no game number), which keeps 2b purely client-side. **Known edge (not
    fixed here):** plain `dispatchVehicle` does NOT skip, so a NO-action route whose first waypoint is the craft's
    own hex now quotes ok while a plain dispatch of it is still refused. Today's client never asks for that
    quote: its planner flags the craft → W1 row as a dead leg and keeps Finalise disabled. 2b decides how the
    client treats it. *(Decided in slice 2b: such a route is sent as `dispatchRouteWithActions`, the path that
    skips.)* Sim suite → **1,493 green** (`quote.test.js` +5: skip ≡ quoting from W1 onward; the quote
    matches the real actioned run's fuel, first leg and final arrival tick; act-in-place quotes 0/0/0 arriving
    now (at tick 0 and ticked forward) and the dispatch burns that 0; the skip never cascades; deterministic.
    `server.test.js` +1: `POST /vehicle/quote` act-in-place + skip, still read-only. The old "first waypoint on
    the craft's hex is a zero-length failure" quote assertion became an internal dead leg.) Against slice (A)'s
    `actions.js`, five of the six fail. The sixth, determinism, is a property that holds either way.
    **No-op proof:** the only behaviour changes are previously REFUSED inputs now accepted (an actioned one-stop
    dispatch at the berth; a quote whose first waypoint is the craft's hex). The persist / determinism /
    galactic-supply goldens are untouched and green. Five runs hash byte-identical (state + snapshot, every
    100 ticks) on `main` and on this branch: zero-state, economy_meanline (+ crisis) and supply_relief (400
    ticks each), plus a routed NON-act-in-place lane (1,500 ticks: an actioned run from off-W1, a 2a multi-stop
    skip run, a plain dispatch) together with the non-skip quotes asked along the way.
    **Driven end-to-end via the CLI** against a booted, persisted server (seed 7; guild `g1` founded at sys_0001,
    400 titanium in its pool, a light craft parked there): `save-route "Top up" --route
    "sys:sys_0001@load:titanium:400"` → `route_g1_01`. `POST /vehicle/quote` on that one waypoint →
    `{ legs: [], totalTicks: 0, totalUnits: 0, credits: 0, arrivalTick: 0 }`. `dispatch-route --route
    "sys:sys_0001"` (no action) → refused, exit 1. `dispatch-route` along the saved waypoint → the 400 loaded IN
    PLACE at tick 0 (pool 400 → 0, hold 400), fuel 500 → 500, the craft idle at sys_0001 with no route/trip. An
    in-place unload at tick 3 put it back, and a second in-place load at tick 5 was followed by a SIGKILL. The
    restart REPLAYED that journalled action ("replayed 1 journalled actions") and reloaded canonically identical to
    the pre-kill state (a graceful restart also reloads identically). One more tick changed nothing about the
    craft, and `delete-route` dropped the `savedRoutes` key.
    **Deferred, not invented:** the client Save / Load Route UI and any client handling of the plain-route-at-
    berth edge (2b); repetition, the lap-start anchor-gone re-check and pause/flag surfacing (3).
  - **slice 2b — client (Save / Load Route, the skip-aware planner, the broken-stop gate).** 🟢 *BUILT (23-09-26 —
    CLIENT ONLY, `client/game.html`; no engine/snapshot/`sim`/`tools` change — it drives the 2a `saveRoute` /
    `deleteRoute` and the 2a/2a.1 skip through the existing `POST /action` and `POST /vehicle/quote`; contract
    transport-model.md §11.9 / §11.1 / §11.7 / §11.4, design.md §18).* Four isolated pieces, one commit each.
    **(1) The skip-aware planner.** The planner's route checks now take a `route` (`{ vehicle, origin,
    waypoints }`) instead of reading `PLAN`, so the map planner and the Finalise list judge a route by ONE rule
    set (shared as `window.__routeChecks`). `deadLegAt`: waypoint 0 is never a dead leg — on the craft's own hex
    it is the §11.4 skip (`skipsFirstLeg`); an internal zero-length leg (two stops on one hex) is still dead,
    unchanged. The chip and Confirm share one `candidateIsDeadLeg`, so the craft's own hex can be clicked as
    stop 1, Action and all. `idleAtBerth`: the one-stop route at the berth with NO action (the engine refuses
    it) carries a cue ("this stop is where the craft already sits — add an action or remove it") and cannot
    Dispatch; Finalise stays reachable, so the popup's "+ Action" can fix it. **The "acts in place" cue:**
    stop 1 on the craft's hex reads "you are here — acts in place" (or "you are here — starts from this stop"
    with no action) in both lists, so the 0-leg / 0-fuel first stop reads as intentional. `startPlanning` now
    runs `refreshPlanState`, so a seeded list (Edit / Load Route) sets the Finalise gate too.
    **(2) The broken-stop flag + hard Dispatch gate.** `brokenAt(route, i) = wp.action &&
    !routeActionAllowed(craft, wp.anchor)` — the 1b Action gate, reused, not forked. It is judged at render time,
    so a loaded route needs no separate re-validation pass: its dead stops simply render broken (§11.9 soft
    re-validation). Map: a broken stop's hex is outlined and its ring/index drawn in the flag red (#C2603A, the
    popup's `--red` and the dead-leg row's palette). Lists: the broken row is red-tinted with a one-line reason
    in both the planner list and the Finalise list ("store gone — this stop can't load/unload"); the Finalise
    row keeps its Action control (Edit / Clear) and gains a Remove, which re-quotes (`fetchQuote`, factored out
    of Finalise). Dispatch: `canSend = okQ && q.affordable !== false && !dispatchBlock(route)`, where
    `dispatchBlock` is the dead-leg / broken-stop / idle-at-berth gate, its reason shown the way an
    `{ ok:false }` quote's is, and re-checked at the moment of sending. Hard block, no warn-but-allow (ruled).
    **(3) Save Route (the Finalise view).** A name field + Save posts `saveRoute { guildId, name, waypoints }`
    with the laid-out route, actions and all. The engine's name upsert decides; the button reads "Update Route"
    when the trimmed name matches one of the guild's saved routes, else "Save Route". Always available — a
    stop broken for this craft is still a legal plan to save; only Dispatch is gated. The engine's accept /
    refuse shows under the row, and an accept re-reads the snapshot at once.
    **(4) Load Route (the planner).** A "Load Route ▾" button beside Finalise / Cancel, HIDDEN when the guild
    has no saved route (omit-when-empty), opens a menu of the guild's saved routes (name + stop count) off the
    snapshot's `guild.savedRoutes` (a new `__setLiveSavedRoutes` door fed by `applySnapshot`, rebuilt only when
    the rows change). Picking one runs the planner's own init (`startPlanning` → `copyWaypoint`: fresh
    non-aliasing copies, the craft's current location as the origin, so the positioning leg falls out, §11.4);
    the next Finalise quotes the new geometry. A small ✕ arms to "Delete?", and a second click posts
    `deleteRoute { guildId, routeId }`; the list refreshes from the re-read snapshot.
    Sim suite **1,493 green** (untouched — client-only; the served-page tripwire stays green). **Verified
    end-to-end in headless Chromium** against a booted server (seed 7; guild `g1`, two light transports at home,
    one in deep space, a guild outpost 2 hexes off home). (a) The human's case: Plan Route → click the craft's
    own hex, attach load titanium 400, add the outpost (unload 400) and a bare hex → Finalises (it did not
    before) and posts `dispatchRouteWithActions`; the 400 loads IN PLACE at dispatch, the craft flies on, the
    outpost ends holding 400 and the craft idles at W3. Two clicked stops on one hex are still refused (chip +
    list + Finalise). (b) Save "Ore run" → it appears in Load Route → loaded onto the deep-space craft (origin =
    its own hex, fresh quote) → an edited unload re-saved under the same name updates `route_g1_01` in place →
    ✕ / Delete? removes it and the button disappears. (c) A route through the outpost saved, the outpost torn
    down, Load → red on the map and in both lists, Dispatch disabled with the reason; still saves; Clear (or
    Remove) → Dispatch re-enables and it flies. (d) A one-stop "load 400" route loaded onto a craft at that
    stop shows the cue and a 0m / 0 ¢ quote, and Dispatch acts in place (400 aboard, no fuel burned). No
    application console errors (the only console lines are Google Fonts stylesheets failing TLS through the
    sandbox proxy).
    **Slice-local calls (surfaced, not invented):** a route whose stop 1 is the craft's hex is sent as
    `dispatchRouteWithActions` even with NO action — it is the one engine path that takes the skip, and the one
    the quote previews (plain `dispatchVehicle` still refuses a zero first leg; discharges 2a.1's "known edge");
    the idle one-stop route blocks Dispatch, not Finalise; the Save field starts on a loaded route's name (so
    "edit a lane, then commit it back" is one click); delete is two-step; a spycraft's broken reason reads "no
    hold — this craft can't load/unload"; the gate is re-checked at click time rather than the open popup
    re-rendering on each poll (the map outline is live; the lists refresh on the next edit). **Display calls:**
    the Load control's placement (top-right, beside Finalise) and its menu; the broken palette (the existing
    flag red); the cue wording; the Save row under the Planned Route. **Deferred, not invented:** repetition, the
    lap-start anchor-gone re-check and pause/flag surfacing (3); rename (delete + re-save, §11.9); the route-mode
    hold view in the dock editor (since 1b).
  - **slice 3a — engine (repetition: the repeat loop).** 🟢 *BUILT (23-09-26 — `sim/routes.js`, `sim/actions.js`,
    `sim/tick.js`, `sim/state.js`, `sim/invariants.js`, `sim/snapshot.js`, `sim/server.js`, `tools/admin.js`;
    tripwires `sim/tests/route-repeat.test.js` (new), `server.test.js`, `tools/admin.test.js`; contract
    transport-model.md §11.10 / §11.4 / §11.6 / §11.3 / §11.2 — engine + operator CLI, NO client).*
    A route can now REPEAT. Landed as tight commits, one piece each.
    **(1) The launch modes + the entity.** `dispatchRouteWithActions` takes an optional **`repeat`** —
    `{ mode: 'once' | 'continuous' | 'nRun', n? }`, default `{ mode: 'once' }` — a LAUNCH parameter (§11.5),
    never stored on a saved route. The constructor carries it only when given, so a one-shot dispatch journals
    exactly as before. Validate (`repeatError`): `mode` one of the three (`REPEAT_MODES`, the shared vocabulary
    in `sim/routes.js`); `n` a whole number ≥ 1 on `nRun` and ABSENT on the other two. Apply journals the repeat
    state onto `craft.route` (`repeatStateFor`): `continuous` → `mode`; `nRun` → `mode` + `lapsRemaining = n`;
    `once` → NOTHING (omit-when-default), so a one-shot route is the built `{ waypoints, cursor }`, byte for
    byte. The launch fuels **lap 1 only** (the positioning to W1 + the first cycle — the same bill a one-shot
    pays) and an unaffordable lap 1 is REFUSED at launch, never left waiting (§11.3 / §11.6).
    `routeViolation` now checks the repeat state: a present `mode` is `continuous` or `nRun` (a stored `once`
    is non-canonical); `lapsRemaining` only on `nRun`, a whole number ≥ 1 on a live route (the lap that reaches
    0 ends the lane on the spot); a repeating route has ≥ 2 waypoints. The snapshot's vehicle row surfaces
    `route.mode` / `route.lapsRemaining` (`snapshotRoute`, fresh copies), both absent on a one-shot row.
    **Slice-local call (flagged on the decision checklist):** a ONE-stop lane cannot repeat — refused at
    launch. Its cycle has no leg (WN is W1), so every lap after the first would skip its zero-length
    reposition (§11.4) and resolve W1 in place again at once: it would lap without end inside a single tick,
    breaking §11.2 / §15.4 (every lap step hangs off a real arrival or turnaround). With ≥ 2 stops the W1 → W2
    leg is real, so every lap takes time. Sim suite 1,493 → **1,500 green** (`route-repeat.test.js` +7). (With
    no loop yet, a repeating lane still ends idle at WN after one cycle — piece (2) makes it lap.)
    **(2) The lap loop** (`sim/actions.js`, `sim/tick.js`). `advanceRoute(state, guild, craft, thisTick)` — the
    one funnel — now reaches a LAP BOUNDARY when the craft has resolved WN, instead of always ending. The
    boundary runs §11.10's fixed order: **`finishLap`** — step 1, is the run over? A one-shot (no `mode`) ends
    idle at WN exactly as before; an N-run counts `lapsRemaining` down and ends at 0 — then **`startLap`**:
    step 2, the lap-START target re-check — every actioned waypoint must still have its store, through
    **`routeStoreAt`**, the ONE predicate the arrival resolver now also uses (a system landmark, else the
    guild's own Outpost on that hex, else none), so the re-check can never pass a stop the arrival would then
    refuse; any gone → the lane ENDS at WN (route dropped). It runs BEFORE the fuel, so a doomed lap is never
    charged (§11.3). Step 3, price the lap through the SAME `dispatchRoute` the launch uses, from the craft's
    berth at WN: the reposition WN → W1 (skipped when zero-length) plus the cycle; hoard + contraband short →
    the lane WAITS at WN (`route.waiting`, nothing burned — the resume is piece (4)). Step 4, burn the whole lap
    up front (`burnFuel` + `totalConsumed`, the launch's own burn), reset the cursor to W1 and reposition
    through **`flyToFirstStop`** — the launch's first-leg code, now one helper shared by the dispatch apply and
    every later lap: fly WN → W1, or, when WN is W1, skip that zero-length leg and resolve W1 in place through
    `resolveRouteArrival` (the 2a/2a.1 skip), then chain on — never a dead leg. Every step still hangs off an
    arrival or a turnaround completion (the two tick hooks call the same funnel) — no per-tick per-craft loop.
    Sim suite → **1,506 green** (`route-repeat.test.js` +6): an n=3 lane runs EXACTLY three cycles (`lapsRemaining`
    3→2→1→0, the 4th lap's goods left at A however long it runs on); a continuous lane unloads 400 once per lap
    on an exact, derived lap period (loop-back + cycle + the ruled turnaround), never twice in a tick; WN ≠ W1
    flies the loop-back leg each lap and pays for it; WN == W1 never builds a zero-length leg and pays only the
    cycle; each lap's whole bill leaves the hoard on the tick the craft leaves WN, `totalConsumed` rising to
    match; replay and a mid-lap JSON restart are byte-identical. Every lap test ticks through `advance`, which
    asserts every invariant on every tick.
    **(3) Target-gone ENDS + the flag** (`sim/routes.js`, `sim/actions.js`, `sim/invariants.js`,
    `sim/snapshot.js`, `sim/state.js`). Every place a lane stops because a stop's store is gone now goes
    through ONE helper, **`endLane`**: drop the route (an ordinary idle craft, no resume-in-place, §11.6) and
    flag the craft **`laneEnded = { reason: 'target-gone', tick }`** (`LANE_END_REASONS`, `sim/routes.js`) so
    the player can see WHY it stopped. The sites: the lap-start re-check (idle at WN — nothing burned, the
    check precedes the fuel); the arrival resolver's no-store halt (idle at the now-bare hex, still laden); a
    next leg that can no longer be built; and — **a 1a gap found on the way** — an Outpost torn down under a
    craft DOCKED there for its lane (queued or loading). `removeOutpost` evicts such a craft idle, as §4 says,
    but it used to keep its route: the dock completion it waited for died with the Outpost, so nothing could
    ever advance it (reproduced on `main`: idle 2,000 ticks later, cursor stuck). Now its lane ends and is
    flagged at the teardown tick. The flag is cleared by the craft's next dispatch, plain or routed (a manual
    transfer leaves it). One-shot routes get the flag too — the 1a "safe halt" is now the ruled END. The
    snapshot row surfaces `laneEnded` (a fresh copy, omit-when-absent); `checkVehicleIntegrity` asserts a
    known reason, a whole tick no later than now, and no route alongside it. Sim suite → **1,512 green**
    (`route-repeat.test.js` +6: the lap-start END at WN with no fuel spent; the mid-flight END at the bare
    hex, no refund; the docked-eviction END; a one-shot flagged too; the flag cleared by both dispatches but
    not a transfer; the integrity checks).
    **(4) Fuel-short WAITS + the cycle-boundary re-attempt** (`sim/routes.js`, `sim/actions.js`, `sim/tick.js`,
    `sim/invariants.js`, `sim/snapshot.js`, `sim/state.js`). A lane that cannot pay for its next lap (piece
    (2)'s step 3) keeps its craft idle at WN with its route intact and `route.waiting = { reason: 'fuel',
    sinceTick }` (`WAIT_REASONS`), burning nothing. **`resumeWaitingLanes`** re-runs the SAME `startLap` for
    every waiting lane — guilds in array order, each guild's craft in fixed id order, one try each — and is
    called from `stepBaselineAllocation` at each fuel-cycle boundary as a new last block **(e)**, after
    issuance has grown the hoards (and after the fuel-burn-history pass, so a lap burned there counts toward
    the cycle just opening); the ruled (a)–(d) order is untouched, and nothing the price controller reads is
    moved by a lap burn. So a waiting lane re-checks its targets first (a stop gone meanwhile → END + flag,
    nothing burned), then its fuel: affordable → burn, reposition, run; still short → keep waiting,
    `sinceTick` unchanged. The anchored cycle boundary, never a wall clock (invariant 9); no lane waiting →
    no work. An unaffordable lap 1 is still REFUSED at launch (piece (1)). Integrity: `routeViolation` checks
    a `waiting` has a known reason and a whole `sinceTick`, rides only a repeating lane and only at WN;
    `checkVehicleIntegrity` checks the waiting craft is idle with no trip and `sinceTick` ≤ now. The snapshot
    route surfaces `waiting` (a fresh copy). **Two guards on a waiting craft** (it is idle, so it would
    otherwise pass the idle gates): a manual `transferCargo` on a craft running a lane is REFUSED — at an
    Outpost the dock completion would advance the lane as if it were the lane's own stop, and the re-attempt
    could launch a craft sitting in a dock slot; and a plain `dispatchVehicle` now DROPS any lane the craft
    carries (re-dispatching cancels what it was waiting on, §4) — before, a plain trip could land still
    carrying a stale route (reachable on `main` with a routed craft queued at a full Outpost) and the arrival
    step would resolve that route's stop. Sim suite → **1,517 green** (`route-repeat.test.js` +5: waits at WN
    with nothing burned, stays waiting through a boundary while short, resumes on exactly the first boundary
    after fuel arrives and cycles on; lower id first when a boundary can pay for one of two; a stop gone while
    waiting ends it at the boundary; the two guards; the integrity checks).
    **(5) "Stop after this run" + the operator CLI** (`sim/actions.js`, `sim/invariants.js`, `sim/snapshot.js`,
    `sim/state.js`, `sim/server.js`, `tools/admin.js`; tripwires `route-repeat.test.js`, `server.test.js`,
    `tools/admin.test.js`). A new journalled action **`stopRouteAfterRun { guildId, vehicleId }`** — the engine
    half of §11.10's in-transit control. Validate: the guild's craft is running a REPEATING lane (a craft with
    no route, or a one-shot — which already ends after this run — is refused) that is not already stopping (a
    second stop is a refused no-op). Apply sets `route.stopAfterRun = true` and stamps `updatedAtTick`;
    `finishLap` then ends the lane at the next WN boundary whatever its mode — the lap it is on finishes, the
    craft lands idle at WN, nothing snaps, nothing is flagged (a player stop is not a failure). **Slice-local
    call:** a lane WAITING for fuel is already at that boundary with its run finished, so a stop ends it on
    the spot (idle at WN, no route). `routeViolation` checks `stopAfterRun` is `true`, on a running repeating
    lane, never beside a wait; the snapshot route surfaces it. Exposed as `POST /admin/vehicle/stop-route-after-run`
    (the SAME validate → journal → apply path) and `tools/admin.js stop-route-after-run --guild ID --id
    VEHICLE_ID`; `POST /admin/vehicle/dispatch-route` passes a body `repeat` through, and `dispatch-route`
    gains **`--repeat once | continuous | nRun:N`** (`parseRepeatFlag`; the engine's own mode names, the lap
    count after a colon; anything else fails the command). Both commands print the lane's state (mode, laps
    left, a wait, a pending stop). The player client sends the same two actions through `POST /action`
    (slice 3c). Sim suite → **1,524 green** (`route-repeat.test.js` +5, plus one more lap-loop tripwire found
    in review — WN == W1 at an OUTPOST, where the lap boundary fires inside the dock step and re-queues the craft
    on the Outpost being iterated; `server.test.js` +1); `tools/admin.test.js` 45 → **48**. Slice 3a total:
    1,493 → **1,524**, zero failures.
    **No-op proof.** The persist / determinism / galactic-supply goldens are untouched and green. Five runs hash
    byte-identical (state + snapshot, every 100 ticks) on `main` and on this branch: zero-state,
    economy_meanline (+ crisis) and supply_relief (400 ticks each), and a routed ONE-SHOT lane (1,500 ticks, a
    100-tick fuel cycle so the new boundary re-attempt runs fifteen times: an actioned run from off-W1, a 2a skip
    run and a plain dispatch, plus a quote). A one-shot route stores no repeat field, never takes the loop
    branch, and nothing waits. (A one-shot that loses its stop now also carries the `laneEnded` flag — piece (3),
    the one deliberate one-shot change.)
    **Driven end-to-end via the CLI** against a booted, persisted server (seed 7; guild `g1` founded at sys_0001
    with 4,000 titanium, its Outpost two hexes off at `75,-7`, a light craft at home). (a) `dispatch-route
    --route "sys:sys_0001@load:titanium:400; 75,-7@unload:titanium:400" --repeat nRun:3` → W1 loaded in place,
    laps left 3 → 2 → 1, 400 delivered per lap, each lap's 2 fuel units leaving the hoard on the tick it left
    WN, idle at the Outpost at t1065 (the derived lap period) with 1,200 delivered and the fourth lap's goods
    still at home; a SIGKILL restart mid-lap-3 reloaded canonically identical and the run finished the same.
    (b) `--repeat continuous` then `stop-route-after-run` mid-lap → the lap finished and the craft landed idle at
    WN, no flag; a second stop exited 1. (c) `remove-outpost` while the craft flew toward it → the lane ENDED
    at the bare hex on arrival, still laden, `laneEnded {target-gone, 3520}` in the snapshot, no fuel back; the
    next `dispatch-route` cleared it. (d) `adjust-fuel` drained the hoard → the lane finished its lap and
    WAITED at WN (nothing burned), then resumed on exactly the next fuel-cycle boundary when the cycle grant
    landed; drained again, SIGKILLed while waiting, restarted canonically identical, and resumed on the
    following boundary. No invariant errors in the server log.
    **Deferred, not invented:** **3b** — Cancel: the immediate in-transit stop that snaps the craft to the hex
    it occupies (§2.3 position, hex-rounded) with the toll-aware `isToll` branch as a stub. **3c** — the client:
    the launch-mode picker, the Operations → In Transit Cancel / Stop-after-run controls, and rendering a
    flagged idle craft and a fuel wait (this slice only SURFACES the state in the snapshot). The lane's
    original `n` is not stored (only `lapsRemaining`, as specified) — if 3c wants "lap k of N" it will need it
    added. `quoteDispatch` quotes lap 1 (what the launch burns); a per-lap (loop-back + cycle) quote, if 3c wants
    one, is engine work (§18). "A system lost" (§11.6) cannot happen yet — no path removes a claim; when
    territory lands, `routeStoreAt` is the one place it goes.
  - **slice 3a.1 — engine (repetition extensions: cadence, `N` + `lapsDone`, the wait-reason split).** 🟢 *BUILT
    (24-09-26 — `sim/routes.js`, `sim/actions.js`, `sim/invariants.js`, `sim/snapshot.js`, `sim/state.js`,
    `sim/tick.js` (comment), `sim/server.js` (comment), `tools/admin.js`; tripwires
    `sim/tests/route-repeat-extensions.test.js` (new), `server.test.js`, `tools/admin.test.js`; contract
    transport-model.md §11.10 as amended 24-09-26 — engine + operator CLI, NO client).* Rounds out 3a's repeat
    model with the three extensions ruled into §11.10 on 24-09-26, before 3b (cancel) and 3c (client).
    **(1) The cadence launch option.** `dispatchRouteWithActions`'s `repeat` takes an optional **`cadence`** —
    `'immediate'` (the default) or `'perCycle'` (`CADENCES`, `sim/routes.js`, beside `REPEAT_MODES`). Validate
    (`repeatError`): one of the two, and only on a REPEATING mode — a cadence on `once` is REFUSED (even
    `immediate`: a one-shot has no next lap to pace; the same call 3a made for a stray `n`). Apply journals it
    onto `craft.route` **omit-when-immediate** (`repeatStateFor`), so a lane launched without a cadence — or
    with an explicit `immediate` — is byte-identical to a 3a lane. `routeViolation`: a PRESENT cadence must be
    `perCycle` (a stored `immediate` is non-canonical, exactly as a stored `once` mode is) and rides a repeating
    lane only. The snapshot route surfaces it (absent = immediate). The option is journalled here; piece (3)
    makes a `perCycle` lane hold. Sim suite 1,524 → **1,528 green** (`route-repeat-extensions.test.js` +4).
    **(2) The lap counters — `lapsDone` + `N`** (`sim/actions.js`, `sim/invariants.js`, `sim/snapshot.js`,
    `sim/state.js`). At launch every repeating lane journals **`lapsDone: 0`** (always present on a repeating
    route, not omit-when-0 — the client reads one shape), and an nRun also journals **`N`**, its launched lap
    target (never changed afterwards — the "of N" denominator), beside the existing `lapsRemaining`. A `once`
    route carries neither (unchanged). `finishLap` counts each completed lap: `lapsDone` up by one (so after
    lap 1 it reads 1 — the client's "lap k" is `lapsDone + 1`), an nRun's `lapsRemaining` down by one, then the
    unchanged end-checks (stop-after-run, or the N-th lap → idle at WN). The positioning prefix is not a
    lap (§11.10), so lap 1 counts once, when its cycle completes. No new tick stamp: the count happens on the
    tick the lap ended, which the next event already records (the next departure, a wait's `sinceTick`, an
    end flag, or the route going) — the arrival step's "no second home" discipline. `routeViolation`:
    `lapsDone` a whole number ≥ 0 on every repeating route and on no one-shot; `N` a whole number ≥ 1 present
    iff `mode === 'nRun'`; and on an nRun `lapsDone + lapsRemaining === N`, so a lap counted one way and not
    the other fails loudly. The snapshot route surfaces both (fresh copies). *(Closes 3a's deferred "the
    original `n` is not stored" note.)* Sim suite → **1,532 green** (`route-repeat-extensions.test.js` +4:
    journalled at launch; an n=3 lane reads 0/3 → 1/2 → 2/1 in state and snapshot, each count moving on the
    tick that lap's unload lands, then ends idle at WN after three laps; a continuous lane's count climbs one
    per lap with no `N`; the integrity checks).
    **(3) The per-cycle hold + the wait-reason split** (`sim/routes.js`, `sim/actions.js`, `sim/invariants.js`,
    `sim/snapshot.js`, `sim/state.js`, `sim/tick.js` comment only). `finishLap`, after counting the lap and
    running the unchanged end-checks, HOLDS a `perCycle` lane instead of calling `startLap`: it sets
    **`route.waiting = { reason: 'cadence', sinceTick }`** and returns, the craft idle at WN, nothing burned.
    `WAIT_REASONS` is now `['fuel', 'cadence']`. The EXISTING cycle-boundary re-attempt (`resumeWaitingLanes`,
    step 6 (e)) already runs every waiting lane through `startLap` in fixed id order — confirmed, no change —
    so a held lane starts its next lap there: target re-check, then fuel, then burn + reposition, the SAME
    path a fuel-short lane resumes on. No new timer, no new number: the anchored cycle boundary (invariant 9).
    An `immediate` lane calls `startLap` at once, exactly as in 3a; lap 1 of either cadence launches from the
    dispatch apply, so a per-cycle lane still flies its FIRST lap immediately — the hold is only between laps.
    **The reason split:** `startLap`'s fuel-short branch now re-dates the wait when the reason changes — a
    lane already waiting for FUEL keeps its first `sinceTick` (3a, unchanged), while a cadence hold that
    cannot pay at its boundary becomes `{ reason: 'fuel', sinceTick: <that boundary> }` (the reason change is
    a mutation, and `sinceTick` records its tick). A lap that runs clears either reason (`delete
    route.waiting`), and after it completes a per-cycle lane holds for its cadence again — the two reasons
    never wedge. "Stop after this run" on a lane holding for its cadence ends it on the spot, exactly as on a
    fuel wait (it is already at WN with its run finished). **The boundary-tick edge (built, flagged in the
    code):** a per-cycle lap that ENDS on a boundary tick holds in the arrival / dock step (step 5) and is
    re-attempted by step 6 (e) of the same tick, so it goes straight on — that boundary is the one it held
    for; still one lap start per boundary, since every lap takes at least a tick. A fuel-short lane already
    behaved this way in 3a. `routeViolation`: a `cadence` wait rides a `perCycle` lane only, and ANY wait
    needs `lapsDone ≥ 1` (a lane only waits at a lap boundary; lap 1 launches or is refused, never waits).
    The snapshot surfaces the reason as stored. Sim suite → **1,543 green** (`route-repeat-extensions.test.js`
    +11: lap 1 flies at once and the hold appears only after it, burning nothing, until exactly the next
    boundary; one lap per cycle, each later lap starting ON a boundary one cycle after the last, while the
    immediate lane runs back to back (the 3a loop); a lap longer than the cycle still starts only on the first
    boundary after it ended; the boundary-tick edge; an n=2 per-cycle run ends idle at WN on its last lap's
    tick, with no trailing hold; stop-after-run on a hold; WN == W1 at an Outpost re-queued from the boundary
    step, invariants every tick; replay and a mid-hold restart byte-identical; a cadence hold short at its
    boundary flips to a fuel wait dated from that boundary, stays `fuel` through the next, runs on the first
    boundary after fuel arrives and holds for cadence again; a stop torn down during a hold ends the lane at
    the boundary, flagged, nothing burned; the integrity checks). Mutation-checked: with the hold disabled 10
    of these fail; with the reason flip reverted the flip test fails.
    **(4) The operator CLI** (`tools/admin.js`, `sim/server.js` comment; tripwires `tools/admin.test.js`,
    `server.test.js`). No new endpoint — `POST /admin/vehicle/dispatch-route` already passes the body's whole
    `repeat` to the engine, cadence included. `dispatch-route --repeat` takes the cadence as a trailing
    colon field, in the engine's own words: **`--repeat continuous:perCycle`**, **`--repeat nRun:3:perCycle`**
    (or `:immediate`, the default) — so the flag reads as the one `repeat` object it sends, and the mode and
    cadence stay one flag rather than two that could disagree. `parseRepeatFlag` refuses only what does not
    parse (an unknown cadence word, a stray colon); legality stays the engine's — `once:perCycle` parses and
    the engine refuses it with the ruled reason. `printLaneState` adds the cadence (repeating lanes; none
    stored = immediate) and `lapsDone` ("2 of 3" on an nRun) beside the existing laps-left / wait / stop rows,
    and the wait row now names either reason. Usage text documents the grammar. `tools/admin.test.js` 48 →
    **49** (the cadence grammar, the arg → body mapping); `server.test.js`'s repeat test now launches
    `perCycle` and refuses a cadence on `once` (no count change). Sim suite still **1,543**.
    **(5) Loop geometry — a guard, no new rule** (`route-repeat-extensions.test.js` only). §11.10's loop-geometry
    ruling documents what 3a's executor already does (it walks the waypoints by cursor and refuses only two
    CONSECUTIVE stops on one hex), so no engine logic changed. Two tripwires hold it to the ruling's own
    example, the milk-run **B → C → D → C → B** (C = system A; B, D = two of the guild's Outposts) run as an
    n=3 lane: each stop's pool moves in cursor order every lap — A `+60` then `+25−10`, B `−100` (as W1) then
    `+10` (as W5), D once — the closing B → B flyback is skipped (WN == W1) so laps 2–3 fly only the four
    cycle legs, no zero-length leg is ever built, and the hold ends each lap empty; replay and a mid-lap
    restart (between A's two visits) are byte-identical. Sim suite → **1,545 green**. Slice 3a.1 total: sim
    1,524 → **1,545**, `tools/admin.test.js` 48 → **49** (tools suite 66 → 67), zero failures.
    **No-op proof.** The persist / determinism / galactic-supply goldens are untouched and green (they carry
    no repeating route). Hashed on `main` (pre-slice) and on this branch with the same script: (a)
    zero-state, supply_relief, economy_meanline and its crisis variant, 400 ticks each, state + snapshot
    every 100 ticks — **byte-identical**; (b) a routed ONE-SHOT galaxy (an actioned run from off-W1, a 2a
    skip run, a plain dispatch, a quote; 1,500 ticks on a 100-tick fuel cycle) — **byte-identical** (a
    `once` route carries no repeat field at all); (c) three IMMEDIATE repeating lanes (continuous, nRun:3,
    and a WN == W1 ring at the Outpost) on a starved hoard with a fuel grant every 700 ticks, so they wait and
    resume (3,256 lane-ticks waiting, 18 lap burns), 4,000 ticks, state + snapshot hashed EVERY tick with only
    the new bookkeeping fields (`lapsDone`, `N`, `cadence`) stripped — **identical every tick**: the same
    laps, fuel, arrival ticks, cargo and waits as 3a. Controls: unstripped, the digest differs (the new
    fields are really there); with one lane switched to `perCycle`, it differs (the projection sees a real
    behaviour change).
    **Driven end-to-end via the CLI** against a booted, persisted server (seed 7, `/reset` + a 900-tick fuel
    cycle; guild `g1` at sys_0001 with 8,000 titanium, its Outpost two hexes off at `75,-7`, three light craft
    at home). `dispatch-route … --repeat continuous:perCycle` (craft 01) printed `cadence perCycle, lapsDone
    0`; `--repeat nRun:3` (craft 02) printed `cadence immediate, lapsDone 0 of 3, lapsLeft 3`; `--repeat
    once:perCycle` exited 1 with the engine's reason; `--repeat continuous:daily` failed the parse. Ticking
    and reading `/snapshot`: craft 02 ran back to back, laps ending t215 / t640 / t1065, `lapsDone` 0/3 → 1/3
    → 2/3, idle at the Outpost at t1065 (3a's own figure); craft 01 flew lap 1 at once, held (`waiting
    cadence since 215`), started lap 2 ON the t900 boundary, held from t1325, started lap 3 ON t1800, held
    from t2225 — one lap per cycle. A SIGKILL at t1400 (mid-hold) restarted to a canonically identical
    snapshot, still holding since t1325, and resumed at t1800 as the unbroken run would. `stop-route-after-run`
    on the held lane at t2300 ended it on the spot, idle at the Outpost; the t2700 boundary started nothing.
    2,400 titanium delivered (6 laps × 400). No invariant errors in either server log. (The reason flip
    could not be shown live: this guild's per-cycle fuel grant dwarfs a 2-unit lap. The tripwire covers it.)
    **Deploy note.** A galaxy persisted with a slice-3a repeating lane RUNNING (a route with a `mode` but no
    `lapsDone`) fails the new `lapsDone` check on its first tick after this deploy and halts loudly, by
    design, not silently. No migration was written. Before deploying, check `snapshot` for any craft whose
    route has a `mode`, and let it finish or re-dispatch it. Lanes only exist if an operator launched one
    through the 3a CLI.
    **Deferred, not invented:** **3b**: Cancel, the immediate in-transit stop that snaps the craft to the hex
    it occupies, with the toll-aware `isToll` branch as a stub. **3c**: the client launch picker (mode + N +
    cadence), the "lap k / lap k of N" and waiting read-out (fuel vs cadence), the Operations → In Transit
    Cancel / Stop-after-run controls, and the closed-loop legibility UX (§11.10 loop geometry). This slice
    only SURFACES the state. The per-lap (loop-back + cycle) quote noted under 3a is still open for 3c. Edge
    calls built one way are on the decision checklist ("Repeating lanes — 3a.1 edge calls").
  - **slice 3b — engine (Cancel: the in-transit stop + the snap-to-hex).** 🟢 *BUILT (24-09-26 —
    `sim/transport.js`, `sim/actions.js`, `sim/server.js`, `tools/admin.js`; tripwires
    `sim/tests/route-cancel.test.js` (new), `server.test.js`, `tools/admin.test.js`; contract
    transport-model.md §11.10 "Cancel" / §2.3 / §2.4 / §11.6 — engine + operator CLI, NO client).* The engine
    half of §11.10's Cancel control: a craft's lane ends AT ONCE, a craft in flight snapping to the hex it is
    over. Landed as tight commits, one piece each.
    **(1) The snap-to-hex helper** (`sim/transport.js`; tripwires `sim/tests/route-cancel.test.js` (new)).
    Beside `hexDistance`: **`legHexAtTick(from, to, departureTick, arrivalTick, tick)`** — the hex a craft
    flying the straight leg `from` → `to` is over at `tick`. It is §2.3's `legProgress = clamp01((T −
    departureTick) / (arrivalTick − departureTick))`, the position interpolated along the leg, then §2.4's
    **`cubeRound`**: round q, r and s = −q − r, and rebuild the one that moved furthest from the other two so
    they still sum to 0 (rounding q and r alone can pick the wrong hex near a corner). **Whole-number maths
    throughout:** the position is carried as integers over the leg's tick span, never as a decimal, so every
    rounding comparison is exact. That matters on an exact edge: the textbook decimal version of the same
    algorithm disagrees with itself on such points (794 of 2,000,000 random points, every one an exact tie,
    tipped by float noise), while this one settles a tie by the fixed order of its checks, every run
    (§15.5 invariant 9). A negative zero is normalised to 0. It throws on a fractional tick or coord or a leg
    of no duration rather than place a craft from a bad schedule. No number: interpolation and rounding are
    geometry. Nothing calls it yet (piece (2) does), so nothing existing changes. Tripwires (6): the cube
    correction ((0.45, 0.35) is hex (1, 0), not the naive (0, 0)); half-way along (0,0) → (9,7) is the edge
    between (5,3) and (4,4) and the tie rule picks (5,3) (naive rounding would give (5,4)); the same point
    flown either way is the same hex; the endpoints and the clamp; tick by tick the craft only ever steps
    to a neighbouring hex; an exact tie and the negative zero; the bad-schedule refusals. Mutation-checked:
    with the correction removed 4 of these fail; with the tie order flipped the tie test fails.
    **(2) The `cancelRoute` action** (`sim/actions.js`; tripwires `route-cancel.test.js`). A new journalled
    action **`cancelRoute { guildId, vehicleId }`**, the validate → apply shape of `stopRouteAfterRun`.
    Validate: the guild owns the craft and the craft is ON A LANE, meaning it is flying (a `trip`: a routed leg
    or a plain multi-leg dispatch) or holds a `route` while parked. An ordinary idle craft (neither) is
    REFUSED, "nothing to cancel". Apply, by state:
    **In flight** → **`cancelLanding`**, the one home of the landing, shared by validate and apply (the
    `dispatchRoute` discipline): find the ACTIVE leg (the first not yet arrived; the legs are contiguous, so
    at a leg boundary it is the next leg at progress 0, i.e. the waypoint between them), snap through
    `legHexAtTick`, and set `location = { q, r }` (a bare hex), `status = 'idle'`, with the trip and route
    dropped. **Parked** (a lane waiting for fuel or holding for its cadence at WN, or queued / loading at an
    Outpost stop) → nothing snaps; the route drops where the craft sits and the shared
    `cancelQueuedManifest` sweeps any queue entry. Either way no `laneEnded` flag (a player's cancel is not a
    failure), `updatedAtTick` stamped, and nothing moves: the hold stays aboard, and the unflown legs' fuel
    is not refunded (§11.3). **The toll branch is a STUB:** `cancelLanding` checks the active leg's
    `isToll`; a toll leg (roadmap 2.3: complete to the toll's exit) is REFUSED today, and the apply throws
    if called without validate, so it can never fall through to a snap inside a toll. `isToll` is always
    false until 2.3, so the branch is unreachable. **Two conservative calls (on the decision checklist,
    "Cancel — 3b edge calls"):** (a) a craft LOADING in a dock slot drops its lane but keeps its slot. A
    craft in a slot runs to completion (§4), so that one transfer finishes and the craft stays idle at the
    Outpost. (b) **A snap that would land OFF the lattice is refused for that tick.** The lattice is a disc of
    hexes, so a leg between two in-bounds hexes near the rim can pass over a hex outside it (on this seed
    ~3% of sampled rim-leg positions do). The craft flies on, and a later cancel lands. Which in-bounds hex
    it "should" snap to is not ruled, so it is not guessed. Integrity: the existing checks already cover a
    snapped craft (idle ⇒ a location that resolves in-bounds, no trip; a present route/flag checked as
    before). No gap was found, so no check was added. Snapshot: no change (a cancelled craft is an ordinary
    idle row). Sim suite 1,545 → **1,563 green** (`route-cancel.test.js` 6 → 18): a routed lane cancelled
    half-way along the worked (9,7) leg lands on (5,3) from its start and 1/20 in on (1,0), with no trip,
    route or flag, fuel untouched, and it stays there and can be re-dispatched; a plain two-leg dispatch
    snaps on the ACTIVE leg (mid leg 2 → leg 2's own (5,3); exactly at the boundary → the waypoint; mid leg 1
    → its hex); cancelled on the dispatch tick it is on its start hex, a bare hex even when it left a system;
    a fuel wait and a cadence hold drop in place with nothing burned and nothing resumed at the next boundary;
    a lane queued at its Outpost stop loses its queue entry and nothing loads later; a LOADING lane keeps its
    slot, the load completes and nothing sends the craft on; refusals (no lane, unknown craft/guild, a second
    cancel) leave the galaxy byte-identical; the toll stub refuses (and ignores a toll flag on a later leg);
    a rim chord over an off-lattice hex is refused, then lands a few ticks on; replay and a mid-flight JSON
    restart are byte-identical; the integrity checks trip on a corrupted snapped craft. Mutation-checked,
    each caught by its own test: the first leg instead of the active one; no queue sweep; no bounds check;
    no toll guard; a `laneEnded` flag on cancel (9 tests fail).
    **No-op proof.** `cancelRoute` is a new action and `legHexAtTick` is called only by it, so nothing that
    exists changes. The persist / determinism / galactic-supply goldens are untouched and green. Hashed on
    `main` (pre-slice) and on this branch with one script, all **byte-identical**: zero-state,
    supply_relief, economy_meanline and its crisis variant (400 ticks each, state + snapshot every 100
    ticks), and a routed galaxy hashed EVERY tick for 3,000 ticks on a 100-tick fuel cycle (a plain
    multi-leg dispatch, an actioned one-shot, a 2a skip run, a continuous lane starved into fuel waits, an
    nRun:3 lane, a perCycle lane, and a quote: 850 waiting lane-ticks, 2,800 titanium delivered). Control:
    adding one cancel to the routed galaxy changes its digest.
    **(3) The operator CLI** (`sim/server.js`, `tools/admin.js`; tripwires `server.test.js`,
    `tools/admin.test.js`). **`POST /admin/vehicle/cancel-route { guildId, vehicleId }`**, Access-gated under
    /admin/ and routed exactly like `/stop-route-after-run` (the SAME validate → journal → apply path, so a
    cancel survives restart and replays). **`tools/admin.js cancel-route --guild ID --id VEHICLE_ID`**:
    `--id` names the vehicle as on every other vehicle command (the build prompt said `--vehicle`; the
    sibling commands' flag was kept). It prints the tick, the craft's status and location, and for a craft
    that was LOADING the dock row ("this transfer finishes in N ticks, then idle there"). A refused cancel
    exits 1 with the engine's reason. The player client sends the same action through `POST /action`
    (slice 3c). `server.test.js` +1: an idle craft is refused, a craft past half-way on a 2-hex leg lands on
    the engine's own `legHexAtTick` hex (not either end), the call does not tick, a second cancel is refused,
    and a body without a vehicle id is a 400. `tools/admin.test.js` 49 → **50** (the arg → body mapping; the
    command list). Sim suite → **1,564 green**; tools suite 67 → **68**. Slice 3b total: sim 1,545 →
    **1,564**, zero failures.
    **Driven end-to-end via the CLI** against a booted, persisted server (seed 7; guild `g1` founded at
    sys_0001 (77,-7), its Outpost at `75,-7`, three light craft at home). At tick 0: craft 01 `dispatch-vehicle
    --waypoints "80,-7; 89,0"` (3 hexes, then the worked (9,7) leg); craft 03 loaded 300 titanium and
    `dispatch-route "75,-7@unload:titanium:max; sys:sys_0001"`; craft 02 a `--repeat continuous` lane
    home→Outpost; then `adjust-fuel` drained the hoard. At t210 craft 03 was LOADING at the Outpost: `cancel-route`
    printed `status loading … this transfer finishes in 5 ticks`. By t220 its 300 were unloaded and it sat
    idle at the Outpost, no route, not flown on home. Craft 02 finished lap 1 and WAITED for fuel (since t215):
    `cancel-route` dropped it idle at the Outpost, and a second cancel exited 1 ("not on a lane"). An unknown
    craft exited 1 too. A SIGKILL at t800 (craft 01 mid leg 2) restarted canonically identical (the journalled
    cancels replayed). At t1155, half-way along leg 2, `cancel-route` put craft 01 idle at **`85,-4`** =
    (80,-7) + (5,3), the hand-computed hex. At t2055 (past its old arrival, t1995, and past the t1127 fuel
    boundary that refilled the hoard) all three were still ordinary idle craft, no trip / route / flag, and
    craft 02 never resumed. A second SIGKILL restart was canonically identical. No invariant errors in any
    server log.
    **Snapshot marker: none.** A cancelled craft is an ordinary idle row (status + location), exactly what
    the snapshot already surfaces. Nothing records that it was cancelled, which matches the ruling ("an
    ordinary idle craft again").
    **Deferred, not invented:** **3c** — the client: the Operations → In Transit Cancel / Stop-after-run
    buttons, the launch picker, and rendering flagged / waiting lanes (this slice is the engine action only).
    **Roadmap 2.3** — the toll-exit completion behind the `isToll` stub. The four edge calls are on the
    decision checklist ("Cancel — 3b edge calls").
  - **slice 3c-engine — engine (the per-lap cost quote).** 🟢 *BUILT (24-09-26 — `sim/actions.js`,
    `sim/snapshot.js`, `sim/server.js` (comments); tripwires `sim/tests/route-lap-cost.test.js` (new),
    `quote.test.js`, `server.test.js`; contract transport-model.md §11.4 / §11.10 / §2.2, design.md §18 —
    engine only, NO client).* The client half of 3c must show what ONE LAP of a repeating lane costs, and the
    client computes no game number (§18), so the engine now publishes it on the two surfaces the client reads.
    *(Closes the per-lap quote left open under 3a and 3a.1.)* No new number, no stored field.
    **The lap.** A lap is the recurring cycle (§11.4): from WN, fly back WN → W1, then run W1 → … → WN. Its
    fuel is the flyback plus the cycle's legs; when WN == W1 the flyback is zero-length and skipped, so the lap
    is just the cycle. It leaves out lap 1's one-time positioning leg (launch location → W1), which the run
    quote's `totalUnits` already carries. **`perLapCost(craft, waypoints, fuelPrice)`** (`sim/actions.js`,
    beside `dispatchRoute`) is the one home: it prices the lap EXACTLY as `startLap` charges one —
    `dispatchRoute` from the craft parked at WN, with the zero-length first leg skipped — so the number shown
    is the number each later lap takes from the hoard. It returns `{ perLapUnits, perLapCredits }`:
    `perLapCredits = fuelValue(perLapUnits, fuelPrice)`, the same live-priced display rule as the run quote's
    `credits`. It depends only on the waypoints and the craft's per-hex burn, never on where the craft is or the
    launch mode.
    **(1) The quote.** Every ok `quoteDispatch` now also returns `perLapUnits` + `perLapCredits` (at
    `reserve.fuelPrice`), so its ok shape is `{ ok, legs, totalTicks, totalUnits, credits, perLapUnits,
    perLapCredits, affordable, arrivalTick }`. They gate nothing, and every existing figure is unchanged. It
    is still a pure read.
    **(2) The snapshot.** A REPEATING lane's `route` row (`snapshotRoute`, which now takes the craft and the
    fuel price) carries `perLapUnits` + `perLapCredits`, derived on read. A `once` route carries neither and
    is byte-identical to before. So is a craft with no route. Nothing is added to the craft's route in engine
    state.
    **Shape calls.** The field names are the build prompt's. A ONE-stop route (`[W1]`) is a degenerate lap
    (WN is W1, nothing to fly): it prices as **0**, not an error. `perLapCost` returns **null** for both fields
    only on a list `dispatchRoute` would refuse (empty, an anchor that does not resolve, two stops in a row on
    one hex). That cannot happen from an accepted route: the quote prices the lap only after the run built, and
    a running lane's anchors are invariant-checked and never change. So null is a visible "no lap", never a
    quiet 0. **Worth knowing for the client:** run − lap = positioning − flyback, and that can go EITHER way.
    Launched far from W1, a lap is cheaper than the first run. Launched on W1 (the positioning is skipped), a
    lap costs MORE, because only the lap flies the flyback. For the same reason, naming the craft's berth as
    W1 leaves the RUN quote unchanged but changes the LAP (the berth is now a stop on the loop). So three
    existing tests changed by design (four assertions, no count change). In `quote.test.js`, the berth-as-W1
    test now compares the run and pins both laps, and the act-in-place shape gains `perLapUnits: 0,
    perLapCredits: 0`. `server.test.js` makes the same two changes over HTTP, in one test.
    **Tripwires** (`route-lap-cost.test.js`, 12): an open loop's lap = flyback + cycle, from pinned leg lengths
    (5 fuel against a 7-fuel run), and run − lap = positioning − flyback both ways (a 1-hex launch gives a lap
    dearer than the run); the lap is the same from any launch point, including on W1; a closed loop's lap is
    just the cycle, and equals the open loop's (the closing leg IS the flyback); **driven** nRun lanes
    (closed n=3, open n=4) burn `totalUnits` at launch and exactly `perLapUnits` at every later lap start,
    read off the hoard on the tick it moves, and the snapshot showed that same figure; `perLapCredits` =
    `fuelValue` at the asked price, and re-reads at a new price on the quote and on a running lane's row;
    continuous / nRun / perCycle rows carry the quote's figures, a `once` row's keys are exactly `cursor` +
    `waypoints`, and nothing is stored on the route; the row's figure is unchanged on every tick of two laps; a
    one-waypoint route quotes 0 (no throw), and an unbuildable list prices null (never 0); quoting is a pure,
    deterministic read. Mutation-checked, each caught: pricing from W1 (no flyback) (5 fail), from the craft's
    real location (12), with no zero-length skip (5), at a fixed price (1), 0 instead of null (1), per-lap on a
    `once` row (1). Sim suite 1,564 → **1,576 green**, tools suite **68** (unchanged), zero failures.
    **No-op proof.** The persist / determinism / galactic-supply goldens are untouched and green. Hashed on
    `main` and on this branch with one script, all **identical**: zero-state, supply_relief, economy_meanline
    and its crisis variant (400 ticks, state + snapshot every 100); and a routed galaxy on a 100-tick fuel cycle
    hashed EVERY tick for 3,000 ticks (a plain multi-leg dispatch, a one-shot route, a continuous open lane, an
    nRun:3 closed lane and a perCycle lane on a starved hoard, 98 waiting lane-ticks), covering its state, its
    snapshot with the two per-lap keys stripped, its one-shot / route-less rows UNSTRIPPED, and three quotes a
    tick with the per-lap keys stripped. Control: 9,000 lane-row ticks carried the per-lap figures on the
    branch, 0 on `main`.
    **Driven end-to-end** against a booted, persisted server (seed 7; guild `g1` at sys_0001 (77,-7) with
    4,000 titanium, its Outpost at `75,-7`). `POST /vehicle/quote` before launch: craft 01 (at home) on
    `home → Outpost` quoted a 1-fuel run and a **2-fuel lap** (20 credits); craft 02 (at `80,-7`) on the closed
    `home → Outpost → 75,-4 → home` quoted a 7-fuel run and a **5-fuel lap**; a one-stop route quoted a 0 lap.
    Both launched with `dispatch-route --repeat nRun:3`, and the hoard fell 8 (the two runs). Ticking and reading
    each snapshot, every lap start matched the row's figure: craft 01 −2 at t215 and t640 (idle at the Outpost
    at t1065, 3a's own figures); craft 02 −5 at t1160 and t2005 (idle at home at t2850). The t858 boundary
    moved the fuel price to 2.56, and craft 02's row re-read to **13 credits** a lap (`fuelValue(5, 2.56)`). A
    SIGKILL at t1500 restarted canonically identical, still showing 5 / 13. 1,800 titanium delivered, the hoard
    reconciled (500 − 8 − 14 + two grants = 772), and no invariant errors in either server log.
    **Not changed:** transport-model.md's §4 "AS-BUILT 19-09-26" paragraph still lists the b2b-1 quote shape
    (dated, and the new fields only extend it). It was left alone per the build prompt; this note records the
    addition. **Deferred, not invented:** **3c (client)** — the launch picker showing this cost beside the
    mode / N / cadence, the "X fuel / lap" read-out on the Operations active-lanes row, the In Transit Cancel /
    Stop-after-run controls, rendering flagged / waiting lanes, and the closed-loop legibility UX (§11.10).
    Nothing went to the decision checklist: no number or rule was chosen.
  - **slice 3c — client (the automation layer's player surface).** 🟢 *BUILT (24-09-26 —
    `client/game.html` only; contract transport-model.md §11.10 / §11.4 / §11.6, design.md §18 — CLIENT
    ONLY: no engine, snapshot, `sim` or `tools` change).* The last rung of the ladder. The player launches,
    watches and stops a lane by rendering fields the engine already publishes and POSTing actions that
    already exist. Landed as four commits, one piece each.
    **(1) The launch picker + the per-lap cost** (the Dispatch popup's Finalise view). Under the Save row,
    just above Dispatch: a **Launch** row (Once, the default / Continuous / N-run, with a lap-count field
    beside N-run) and, for a repeating mode, a **Cadence** row (Immediate, the default / Per-cycle) and a
    **Per lap** line, e.g. "2 fuel · 20 ¢", read straight off the quote's `perLapUnits` / `perLapCredits`
    (§18). A note says the Time / Cost above are the FIRST lap, which includes reaching stop 1. **The gate
    mirrors the engine:** only `dispatchRouteWithActions` takes a `repeat`, and it refuses a repeating lane
    with fewer than two stops. So the repeating toggles are enabled only for a route with two or more stops
    and at least one action; a route with no action still goes out as the plain `dispatchVehicle`, once, as
    before. Otherwise they are disabled, with a one-line why. Dispatch adds `repeat: { mode, n?, cadence? }`
    to the actioned dispatch, sending only what differs from the engine defaults (`n` for N-run only,
    `cadence` only for per-cycle). A Once launch sends NO `repeat` key, so it is exactly the 1b / 2b
    dispatch. Dispatch is held, with a line saying why, until an N-run's lap count is a whole number ≥ 1 (the
    engine's own rule, previewed). The field starts EMPTY rather than on a guessed default. The choice lives in
    the popup (a launch parameter, §11.5, never stored on a saved route): it resets when the popup opens a
    craft or closes, and survives an Edit Route round trip.
    **(2) The active-lanes rows + Cancel / Stop after this run** (Operations → IN TRANSIT). The craft
    selector widens from "flying" to the engine's own on-a-lane test (the `cancelRoute` gate): a craft
    FLYING (`inTransit` with a `trip`) or holding a `route` while parked (a lane waiting at its last stop, or
    at an Outpost stop in the dock). So a waiting lane stays visible; the full idle-craft board is Phase 4.
    A flying row is unchanged (the leg's bar, ETA and destination). A PARKED row shows its state where the
    bar would be: **"Holding for fuel"** (amber) for `waiting.reason === 'fuel'`, **"Next lap at cycle"**
    for `'cadence'`, "Loading" (with the engine's `dockStatus.eta` in the ETA cell) or "Queued to dock" at
    an Outpost stop. The destination cell names where it sits, with no arrow. A REPEATING lane adds a read-out
    line under the head, e.g. "Lap 2 of 3 · 5 fuel / lap · per-cycle": the lap is `lapsDone + 1` (the lap it
    is on, or waiting to start, presentation of a published count), "of N" for an N-run, and the snapshot's
    `perLapUnits`. A pending stop adds "stopping after this lap". Parked rows sort after the flying ones.
    The expanded region adds the controls: **Cancel** on every craft row (§11.10: any lane, a plain dispatch
    included) asks first ("Stop this run? The craft halts where it is." — Yes, cancel / Keep going), then
    POSTs `cancelRoute`. **Stop after this run**, on a repeating lane only, POSTs `stopRouteAfterRun` with
    no confirm, then reads "Stopping after this lap", disabled. Both go through `window.__sendAction`. On
    accept the snapshot is re-read, so a cancelled craft leaves the list at once. On refuse the engine's
    reason shows on the row, and the craft flies on (the rim refusal: a craft over a hex outside the
    lattice). That refusal answers the tick it was asked on, so it clears when the clock moves on. **Display
    calls:** the identity cell now reads the short class + the craft's number ("Light #02", the Dispatch
    popup's "#NN"), so two craft of one class can be told apart; a row's expand state is keyed on the craft
    id alone (it was id + arrival tick), so an open row — and its controls — survives the lane moving to its
    next leg. The row still rebuilds on a new leg or a lane-state change (`craftSig`). The per-row alert slot
    stays unwired (operations-hub.md §4 reserves it for "destination lost in flight"). The IDLE TRANSPORTS
    panel now leaves out a craft carrying a `route`: a lane waiting at its last stop has status `idle`, so it
    was listed there too, with a Dock the engine refuses for a lane craft and a Dispatch that drops the
    lane. One craft, one home: IN TRANSIT, with its lane controls.
    **(3) The ended-lane notice** (§11.6). A craft carrying `laneEnded` has had its lane dropped and is an
    ordinary idle craft, and the idle-craft board that would show it is Phase 4. So the lanes' home says it:
    a strip at the top of the IN TRANSIT card with one notice per flagged craft, e.g. "Light #01's lane
    stopped at (75, -7) — a stop's store is gone." (`target-gone` → "a stop's store is gone"; an unknown
    reason would show as the engine wrote it). Each notice has a ✕. A dismissal is keyed on the craft id +
    the flag's tick, so a later ending on the same craft shows again. It is remembered for this page visit
    only; a reload shows a still-flagged craft again. The engine clears the flag on the craft's next
    dispatch, so the notice also goes by itself once the craft is re-tasked. A player's Cancel / Stop sets
    no flag, so it never shows one. **Display call:** the notice lives only in Operations (no tab pip or
    map toast).
    **(4) Closed-loop legibility** (§11.10 loop geometry). With a repeating mode picked, the route reads as a
    loop. An OPEN loop (`B → C → D`) gets a **"↺ Return to B"** row after its last stop in the Finalise
    list ("each lap flies back to stop 1"). It is not a stop: dashed ring, dimmer name, no controls. So the
    player sees the loop close itself and need not re-add stop 1. A hand-CLOSED loop (`B → C → D → B`, the
    last stop on stop 1's hex) keeps BOTH B stops, each able to act (the two-way haul the engine takes
    literally), with a note on the last one ("back on stop 1's hex — the loop is closed, no return leg"),
    and draws no return row. Nothing is merged or de-duplicated. The mode is chosen in the popup AFTER
    planning, so the planner learns it only on **Edit Route**: with a repeating mode on, it re-opens with
    the same return row in its waypoint list and a finer, dimmer dashed return line WN → W1 on the map
    (none for a closed loop). A fresh Plan Route starts with it off, and Load Route keeps it. The repeat
    gate (two or more stops, some action) and the closed-loop test (last stop's hex == stop 1's) move into
    the planner's shared `window.__routeChecks` (`canRepeat`, `loopClosed`), so the popup and the planner
    judge a route by one rule. The hex comparison is the same geometry the dead-leg check already does, not
    a game number.
    **Verified** — sim suite **1,576 green**, unchanged (client-only; the served-page tripwire
    `sim/tests/server.test.js` green). Driven in headless Chromium against a booted, persisted server (seed 7;
    guild `g1` at sys_0001, its Outpost at `75,-7`, 4,000 titanium, three light craft at home, four saved
    routes). Each run started from a fresh galaxy, went through the real UI (open the craft → Plan Route →
    Load Route → Finalise → the picker → Dispatch; Operations for the lanes), and logged **no console
    errors**; the server log had no invariant errors. (1) An N-run 3 / per-cycle launch posted `repeat:
    { mode:'nRun', n:3, cadence:'perCycle' }`, and the engine's route carried `N 3`, `cadence perCycle`,
    `lapsDone 0`. The picker's "2 fuel · 20 ¢" equalled the quote's `perLapUnits` / `perLapCredits` (run:
    1 fuel · 10 ¢, the 3c-engine figures). An empty N held Dispatch with its line. A plain route had the
    repeat toggles disabled and still posted `dispatchVehicle`, and a Once actioned route posted no `repeat`
    key. (2) The lanes appeared as "Lap 1 of 3 · 2 fuel / lap" and "Lap 1 · 5 fuel / lap · per-cycle"; the
    N-run read "Lap 2 of 3" at t215. The per-cycle lane read "Next lap at cycle" at its last stop from t530,
    listed under IN TRANSIT only (IDLE TRANSPORTS kept just the two idle craft at home).
    With the hoard drained, the N-run finished lap 2 and read "Holding for fuel" (amber) at t640. (3) Cancel
    asked first, "Keep going" left the craft flying, and "Yes, cancel" posted `cancelRoute`: the one-shot
    snapped idle at `76,-7` and left the list. A craft on a rim chord (`-192,80` → `-191,72`, 56 ticks in,
    over `-192,79`) was refused with the engine's reason and flew on; the reason cleared on the next tick.
    Stop after this run posted `stopRouteAfterRun`, the row read "stopping after this lap" and the button
    "Stopping after this lap" (disabled). The lane ended after its current lap, idle at its last stop
    `75,-4`, with no flag. (4) Two continuous lanes flying to the Outpost; `remove-outpost` mid-flight ended both at
    the bare hex (`laneEnded {target-gone, 210}`), and two notices appeared. ✕ removed one; re-dispatching
    the other craft cleared the flag and its notice. (5) `B → C → D` Continuous showed "↺ Return to
    ZOV-6064" in Finalise and, after Edit Route, in the planner list with the dashed return line on the
    map. The mode survived Edit Route → Finalise. Once showed no return row. `B → C → D → B` showed two
    ZOV-6064 stops (#1 and #4), the closed note on #4 and no return row. Its per-lap "5 fuel · 50 ¢" matched
    the quote, the same lap as the open form's (the closing leg IS the flyback).
    **Not changed:** operations-hub.md §4 / §7 still describe IN TRANSIT as Syndicate deliveries only. It
    has not described guild craft rows since 2.2 b2a (recorded here, as 3c is). Left alone: a design-ahead doc
    this slice was not asked to touch. **Deferred, not invented:** the full idle / DEPLOYED / LEASED craft board
    (Phase 4, where a waiting lane and an ended-lane craft would also live); the toll-exit completion behind
    Cancel's `isToll` stub (roadmap 2.3); drawing a RUNNING lane's whole loop on the map (the in-transit
    layer still draws only the leg being flown); an Operations tab pip for an ended lane; anything a
    playtest surfaces. Nothing went to the decision checklist: no number or rule was chosen. The new
    constants are display sizes and colours from the existing palettes; the empty N field avoids a default
    lap count.
- **Tuning — resource yield tiers & the homeworld production floor — ✅ BUILT 24-09-26 (two commits).**
  Per-resource mine yields by rarity tier (design.md §2 "Resource Yield Tiers & the Homeworld Production
  Floor"; numbers in `docs/phase-1-tuning.md` "Resource yield tiers"). The build: the yield table in
  `sim/baseline.js`; the engine stamps a new venture's `productionRate` from its baseline when the establish
  call names none, and the client stops sending its flat `ESTABLISH_RATE`; baselines served to the client;
  a homeworld-floor tripwire test. Needs a **fresh galaxy** on deploy (no migration of stored rates).
  **Commit 1 of 2 BUILT 24-09-26 — the engine-owned establish rate (a no-op on every existing caller).**
  `establishVenture`'s `productionRate` is optional; omitted, the engine stamps the venture's baseline
  (`baselineRateFor`, `sim/baseline.js`) and refuses if there is none. `GET /goods` serves
  `mineBaseline` / `refineryBaseline`; the client's mine, factory and deuterium-mine establishes send no
  rate and the ledger's Rate row reads the served baseline (`ESTABLISH_RATE` survives only on the
  deuterium refinery). A tripwire pins every baseline value as a positive integer. The table itself is
  still the uniform 5, so every determinism golden is byte-identical. Suite **1,587 green**.
  **Commit 2 of 2 BUILT 24-09-26 — the yield table + the homeworld-floor tripwire.** `MINE_BASELINE` is
  the phase-1-tuning.md table exactly (deuterium stays 5; `REFINERY_BASELINE`, recipes, `FEE_RATE`, price
  and reputation constants untouched). `sim/tests/homeworld-floor.test.js` derives the 12-node Terran
  spread from the seed and the six homeworld-complete recipes from the catalog, then checks design.md §2's
  inequality for every input good: RED on the uniform-5 table (all seven inputs short), GREEN on the tiers.
  The new yields broke 47 tests. Each fix derives its expectation from the table, and a mine fixture keeps
  its old ratio to the baseline: a rate of 5 becomes the baseline, 10 becomes twice it. Every re-pinned
  determinism golden (23 in commitment-scaffold, 14 in persist) was first shown to reproduce byte for byte
  with only the table set back to all-5. With the table set back, the whole suite passes except the floor
  tripwire, which fails by design. The establish panel's single mirrored `BASELINE_RATE` is retired (its
  own tripwire demanded it the day baselines differentiated). The commitment preview now reads each good's
  baseline from `GET /goods` (`baselineUnits`). Non-test callers audited: `tools/admin.js` (seat-demo,
  verify-cycle) and the `sim/snapshot.js` CLI demo now take the engine default, and verify-cycle expects
  230,400. The supply-relief and meanline scenarios keep their explicit fixture rates, and `sim/demo.js`'s
  foundGuild inline mine is out of scope. Sim suite **1,590 green**; tools **68 green**. **Deferred, not
  invented:** capping a named `productionRate` at its baseline (throttle-below / droids-above); foundGuild
  inline rates; the deuterium refinery's throughput (`ESTABLISH_RATE` 5 still stands in). **Needs a fresh
  galaxy on deploy.**

- **Tuning — per-tier price bands — ✅ BUILT 26-09-26 (two commits).** design.md §5 "PER-TIER PRICE BANDS
  + THE REFINING PUMP AS A FEATURE" (ruled 26-09-26); numbers in `docs/phase-1-tuning.md` "Resource prices";
  as-built in `docs/price-engine.md`. `PRICE_BANDS` (`sim/prices.js`, keyed by `tierOf`) replaces the flat
  `BASE_PRICE` / `PRICE_FLOOR` / `PRICE_CEILING`: T1 1 / 0.2 / 1,000, T2 10 / 2 / 10,000, T3 100 / 20 /
  100,000. The seed, the target, the zero-capacity rest, the clamp and the `sim/invariants.js` price
  tripwire all read the good's own band, and `bandFor` throws (naming the good) on a priced good with no
  tier. Nothing else moved: no other price constant, no Syndicate mechanic (still spreadless and two-sided,
  so the refining pump stays live as ruled), no `feeRate`, no client, no snapshot schema. The two
  price-STRIPPED goldens (`GOLDEN_HASH`, `GOLDEN_UNLICENSED`) are byte-identical; 37 price-inclusive hashes
  were re-pinned; with the bands set back to a uniform 10 / 2 / 200, the new code reproduces every previous
  asserted hash. Tests that assumed a flat 10 now read the good's own band (none deleted); one fixture
  (multi-venture F-A) opens titanium's price at 10 so its two splits stay whole credits apart. Sim suite
  1,590 → **1,598 green**; tools **68 green**. **Needs a fresh galaxy on deploy.**
  **Commit 2 of 2 — raw deuterium excepted (RULED 26-09-26).** Commit 1 had put raw `deuterium` (priced;
  only `deuterium_fuel` is not) on the T1 band at base 1. Deuterium is out of the tier system (design.md
  §8), so `bandFor` now hands it `DEUTERIUM_BAND` — its status-quo **10 / 2 / 200** — and it stays in
  `PRICED_GOODS` for the licensed-mine auto-sale. Its price row and auto-sale income are byte-identical to
  the pre-slice engine (proven by replaying the golden runs plus a deuterium-heavy run on both engines);
  the 53 manufacturing goods stay per tier. The price-stripped goldens are still unchanged; the 37
  price-inclusive hashes were re-pinned again, and the only delta from commit 1 is deuterium's price rows
  (plus, where deuterium auto-sells, the credits and ledger it pays). The "deuterium on T1" tripwire is
  replaced by "deuterium on its own 10 / 2 / 200 band, not T1's". Sim suite **1,598 green**; tools **68
  green**.

- **Tier-3 timed-production economy + Syndicate Top-Up — ✅ COMPLETE (28-09-26).** The
  specialist-manufacturing tier is whole end-to-end — sub-tier price bands, timed per-unit
  production, weekly whole-unit settlement (progress-based payment, Syndicate-first delivery, a 7-day
  rolling term + renegotiation), the settlement-time stockpile rescue, and the opt-in, capped Syndicate
  Top-Up — engine + console client, verified live on the seed-42 galaxy (sim **1,776** / tools
  **68**). The per-slice rows below (Slice 1 → the Syndicate Top-Up client) are the build record.
  **Next is playtest, not more build:** the only open items are the `[FIRST-CUT]` numbers in
  `phase-1-tuning.md` — the `TICKS_PER_UNIT` ladder, the sub-tier / specialist price bands,
  `FEE_RATE`, the capacity reference period, and the four unclassified modules. *(⤳ 28-09-26: the
  ladder's first retune is in: every weekly output is now whole. See "Tier-3 whole-week retime" at
  the end of these rows.)*

- **Tuning — Tier-3 sub-tier + specialist price bands, and the final Tier-4 bills — ✅ BUILT 27-09-26
  (Slice 1 of the Tier-3 economy build; data/pricing only).** design.md §5 "TIER-3 SUB-TIERS, SPECIALIST
  PARTS & FINAL TIER-4 BILLS" (ruled 27-09-26); numbers in `docs/phase-1-tuning.md`, bills in
  `docs/asset-recipes.md`, as-built in `docs/price-engine.md`. `sim/prices.js`: the uniform T3 row of
  `PRICE_BANDS` is retired. A new classifier, `TIER3_PRICE_CLASS`, puts each of the 25 modules in a
  sub-tier (3-1 100 / 3-2 1,000 / 3-3 10,000) or makes it a specialist with its own band (1M–20M). Every
  Tier-3 band is floor 0.2× base, ceiling 100× base. `bandFor` routes Tier 3 through the classifier and
  fails loud, naming the good, if one has no band; it also runs as a load-time check. The four modules no
  bill uses yet keep the old uniform 100 / 20 / 100,000 band as their status quo (see the decision
  checklist). `sim/asset-recipes.js`: all nine FINAL bills. The outpost, deep scan array and toll gate
  bills are **data only** (`INSTALLATION_BILLS`, no build or buy path). `BUILD_TICKS` gains outpost
  12,960, deep_scan_array 10,080 and toll_gate 8,640, inert until those kinds are buildable. **Untouched:**
  capacity, level, production rates, `TICKS_PER_UNIT`, the build/assembly flow, income/settlement. The
  price invariant already reads `bandFor`, so it checks the new bands with no logic change. Goldens:
  every Tier-3-stripped golden held, including both price-stripped ones (`GOLDEN_HASH`,
  `GOLDEN_UNLICENSED`). Four full-state hashes were re-pinned. With the Tier-3 bands set back to the old
  uniform band, all 42 pinned hashes reproduced HEAD's values byte for byte. New tripwires: the ruled
  Tier-3 numbers and classifier, every module resolving to a band, each class seeding at its own base
  and clamping in its own band, the per-band invariant, the fail-loud guard, and all nine bills plus
  their assembly times checked against `docs/asset-recipes.md` itself. Sim suite 1,639 → **1,655 green**;
  tools **68 green**. **Not safe to run live until Slice 2 (timed production) ships**, as ruled; needs a
  **fresh galaxy** on deploy.

- **Tier-3 timed production + the per-period capacity — ✅ BUILT 27-09-26 (Slice 2 of the Tier-3 economy
  build).** `docs/tier3-timed-production.md` ("The model", "The timer ladder", the input-gating half of
  "Build time", "The price fix"; as-built at its end); numbers in `docs/phase-1-tuning.md`; design.md §5
  AS-BUILT note. **Every classified Tier-3 good is produced on a timer.**
  - `TICKS_PER_UNIT` (`sim/baseline.js`) is the ruled ladder: 3-1 15 · 3-2 30 · 3-3 60 · specialists
    360–4,320 *(⤳ 360–5,040 since the 28-09-26 whole-week retime)*. `ticksPerUnitFor(good)` is the one
    "timed or continuous?" answer.
  - A timed factory takes its **whole input set when a unit starts**, counts down the new
    `venture.unitTicksRemaining` (omitted when the line is empty), and mints **one whole unit** at 0.
    With steady inputs that is one unit every `TICKS_PER_UNIT` ticks and 0 in between.
  - It is an ordinary Gate-2/3 consumer that asks for a whole set when idle and nothing mid-unit. Handed
    less than a whole set, it does not start and draws nothing (a deterministic stall).
  - Tier-1 mines and Tier-2 refineries are untouched.
  - **Capacity fix, on the capacity path only.** `capacityOutputFor` (`sim/prices.js`) counts a timed
    good per **day** (`CAPACITY_PERIOD_TICKS` 1,440 ÷ `TICKS_PER_UNIT` × output) and a continuous good
    per tick as before. One finished heavy engine now nudges its price to ~22M (1.1× base); against a
    per-tick capacity it would peg the 2B ceiling (both pinned).
  - **Seams held.** `baselineOutputFor` is unchanged, so the licence fee and the fee quote read what they
    did. The commitment / sale / fee logic is untouched: a committed timed factory now delivers lumpily
    (0 most ticks, 1 on completion), as expected until Slice 3 smooths it.
  - **Invariants** (`sim/invariants.js`): a timed good is never produced continuously (fails naming the
    good); the countdown sits only on a timed factory and only in `[1, TICKS_PER_UNIT)`; no fractional
    stockpile unit (the existing §15.2 sweep).
  - **One structural move:** `TIER3_PRICE_CLASS` moved verbatim from `sim/prices.js` to
    `sim/resources.js`, because `sim/baseline.js` now reads it and cannot import `sim/prices.js`.
    `sim/prices.js` re-exports it; no band or `bandFor` logic changed.
  - **Goldens: none moved.** No pinned run makes a Tier-3 good, and a Tier-1/2 run is byte-identical to
    the pre-slice engine (scratch-checkout diff). In a run that does make a module, only that factory,
    the module and its inputs' stocks, prices and histories differ from HEAD.
  - One existing test updated deliberately: `tier3-catalog.test.js` ran 15 ticks, and a 15-tick unit
    started on tick 2 lands on tick 16, so it now runs 30 and pins the first mint at tick 16.
  - Sim suite 1,655 → **1,675 green** (`sim/tests/tier3-timed-production.test.js`, +20); tools **68
    green**.
  - **Still not safe to run live:** a Tier-3 licence's commitment and fee are still sized off the
    continuous 5 batches/tick baseline, so a licensed Tier-3 factory breaches its daily window until
    Slice 3 (weekly whole-unit settlement, progress-based payment). Needs a **fresh galaxy** on deploy
    (new venture field).

- **Tier-3 weekly settlement window + the fee re-based on timed output — ✅ BUILT 27-09-26 (Slice 3a of
  the Tier-3 economy build).** `docs/tier3-timed-production.md` ("Contract & settlement"; the sizing half
  of "Income & commitment"; as-built "Slice 3a" at its end); design.md §5 AS-BUILT note.
  - **A Tier-3 commitment settles weekly.** `TIER3_WINDOW_N` = 10,080 (`sim/windows.js`; 7 ruled days).
    `windowNForGood` gives a timed good the week and every other good `state.windowN`. It is
    **derived from the good, not stored**: no schema change.
  - **Threaded through** the target `Q` and pace, the met/breach verdict, the sale's equity split, the fee
    charge + RP (each licence charged only on its own boundary, inside the unchanged day gate), the
    `syndicateWindows` roll, and the window-fraction invariant. A mid-week signer owes the week pro-rated.
  - **The windows nest** (every week end is a day end). A galaxy whose day does not divide 10,080 refuses a
    Tier-3 licence, the tick halts, and a new invariant (`tier3-week-nests-in-the-day`) names it. An
    unlicensed Tier-3 factory reads no window.
  - **The fee:** `licenceBasisFor` (`sim/licence.js`) sizes a Tier-3 licence on `y = 10,080 ÷
    TICKS_PER_UNIT`, so `basicFee = 0.10 × y × price-at-signing`: a 3-1 part at base 6,720 a week
    (was 72,000 a day). The committed quantity is `round(pct × y)`, capped at `floor(y)`. The quote,
    the signing, the re-lock and its preview share the one basis. Tier-1/2 fees are unchanged.
    `FEE_RATE` stays 0.10, and no number was invented.
  - **Goldens: none moved** (no pinned run licenses Tier 3). Tier-1/2 runs, with and without an
    unlicensed Tier-3 factory and anchored, are byte-identical to HEAD at every tick (scratch-checkout
    diff). A standing test pins two hashes computed on the pre-slice engine.
  - Tests updated deliberately: `tier3-timed-production.test.js`'s "SEAM 2" title and comment (the fee
    no longer reads `baselineOutputFor` for a timed good; its assertions are unchanged).
  - Sim suite 1,675 → **1,694 green** (`sim/tests/tier3-settlement.test.js`, +19, one shared
    10,080-tick run). Tools **68 green**.
  - **Still not safe to run live:** on the default paced send, a committed Tier-3 factory under-delivers
    and breaches (see the decision checklist). That is Slice 3b's Syndicate-first delivery. Not built
    here: whole-unit `x`-of-`y` (3b), fixed re-offer and one-week term (3b), per-tick progress
    payment (3c). *(⤳ Re-cut for the 3b build: those are now 3c, 3c and 3d. The delivery gap is
    closed by Slice 3b, below.)*

- **Tier-3 Syndicate-first delivery — ✅ BUILT 27-09-26 (Slice 3b of the Tier-3 economy build).**
  `docs/tier3-timed-production.md` ("Delivery — Syndicate first (fixed)"; as-built "Slice 3b" at its
  end); design.md §5 AS-BUILT note and §15.4. **Sub-slices re-cut by the human for this build:** 3b =
  Syndicate-first delivery; 3c = whole-unit `x`-of-`y`, the one-week rolling term and the fixed
  re-offer; 3d = the per-tick progress payment.
  - **The rule.** For a committed **timed** good, each tick the Syndicate takes `min(units minted this
    tick, Q − delivered so far this week)`. Every minted unit goes to the Syndicate until the week's `Q`
    is met, then to the guild's stockpile. Whole units only: no pace, no carry.
  - **Two small changes in `sim/production.js`** ("SYNDICATE FIRST"): the intent is `Q − delivered`
    (the paced / absolute / percent send is skipped for a timed good, and `sendCarry` stays 0), and
    the Syndicate claimant is lifted to the front of the good's claimant order. The existing fresh-only
    cap turns that into `min(minted, Q − delivered)`. `sim/tick.js` is untouched.
  - **Unchanged:** `Q`, `delivered`, the verdict, the fee, reputation and the sale (still on delivered
    units, so still lumpy: 3d). No new state, no schema change. Tier-1/2 send untouched.
  - **The gap is closed.** A fed 3-1 factory on the DEFAULT send now meets every level from 10% to
    100% (3a: 27/67 … 211/672, all breach; 3b: 67/67 … 672/672, all met) and keeps `672 − Q`.
  - **"Fixed" = not a lever:** a reserve ranked ahead of the Syndicate, or the send control set to
    "absolute 0", cannot hold a committed unit back (both still met). The profile action still
    accepts them; they are inert for a timed good (decision checklist). *(⤳ 28-09-26, Slice A: intake
    now refuses a send or an order for a committed timed good.)*
  - **Goldens: none moved** (no pinned run commits a timed good). A new standing test pins a Tier-1/2
    galaxy under every send control and order to hashes computed on HEAD 8af8b11, every tick. Six
    3,000-tick Tier-1/2 runs were diffed against HEAD: identical state, preview and snapshots at every
    tick. Beside a *licensed* Tier-3 factory, the Tier-1/2 slice is identical too.
  - Tests updated deliberately: `tier3-settlement.test.js`'s "THE GAP" is **repointed** to "THE GAP,
    CLOSED" (the default send now meets, 336 of 336, and settles exactly like the absolute one); its
    header, one run comment and one test title follow.
  - Sim suite 1,694 → **1,708 green** (`sim/tests/tier3-delivery.test.js`, +14; also run against HEAD,
    where 11 of the 14 fail, and against four deliberate breakages, each caught). Tools **68 green**.
  - **Still not safe to run live:** delivery is fixed, but two 3a defects remain for 3c (decision
    checklist): teardown settlement counted in days, and the Tier-1/2 `windowDays` term and ratchet
    still applying to Tier 3. *(⤳ Both closed by Slice 3c, below.)*

- **Tier-3 contract: whole-unit `x`, the one-week rolling term, the fixed re-offer — ✅ BUILT 28-09-26
  (Slice 3c of the Tier-3 economy build).** `docs/tier3-timed-production.md` ("Income & commitment",
  "Contract & settlement", "Renegotiation — fixed re-offer"; as-built "Slice 3c" at its end);
  design.md §5 AS-BUILT note. Closes the two 3a defects the checklist carried for 3c. For a licence on
  a **timed** good only (decided by the good; the four unclassified modules keep the Tier-1/2 licence).
  - **Whole units.** `applyForLicence` takes `{ committedUnits }` for a Tier-3 venture: an integer `x`
    in `[0, floor(y)]`, `y = 10,080 ÷ TICKS_PER_UNIT`. It stores `committedOutputPct = x / y`
    exactly and `syndicateCommitment = x`, so the fee, RP, delivery and settlement read one
    commitment.
    - Refused, naming the bound: an out-of-range, fractional or wrong-typed `x`; a percentage or a
      `windowDays` on a Tier-3 licence; `committedUnits` on a Tier-1/2 licence.
    - The Tier-1/2 shape `{ committedOutputPct, windowDays }` is unchanged.
  - **The one-week term.** A Tier-3 licence stores `windowDays: 1` (`TIER3_TERM_WINDOWS`), counted in
    its own window. `licenceWindowN` derives that window from the good: the week for Tier 3, the day
    for Tier 1/2. No new field. It is threaded through:
    - teardown: a Tier-3 teardown owes **one** weekly fee on any day of its week (was 7 on day 1) and
      locks the node until signing + 10,080;
    - the renegotiate/lapse gate;
    - the renegotiation schedule (`renegotiationScheduleFor`, read by the snapshot and the auto-lapse
      step). It is a 7-day contract's timeline: 1 day of grace, a 5-day offer, then auto-lapse.
  - **The fixed re-offer.** `renegotiationTerms` returns a Tier-3 licence's own terms, whatever its
    standing: the same exact `x / y`, the same term, and no Strong discount. `renegotiationFee`
    re-prices them at today's price; the re-lock re-derives the same `x` (pinned for all 5,139
    `(good, x)` pairs). *(⤳ RULED 28-09-26: a Strong venture keeps the Strong discount; only the
    ratchet is dropped. Built by the cleanup entry below.)*
  - **Invariant:** a timed-good licence has `windowDays` 1 (`tier3-term-is-one-week`), and its `x` is
    whole, within `[0, floor(y)]` and equal to `committedOutputPct × y` exactly
    (`tier3-commitment-is-x-of-y`). Tier-1/2 keeps the 7–42 bound.
  - **Unchanged:** the sale on delivered units (still lumpy, 3d), Syndicate-first delivery (3b), the
    week and fee sizing (3a), and the Tier-1/2 licence lifecycle. No schema change. A save holding a
    pre-slice Tier-3 licence fails the new invariant (Tier 3 was never declared safe to run live).
  - **Goldens: none moved** (no pinned run licenses Tier 3).
    - A new standing test pins a Tier-1/2 lifecycle to hashes computed on HEAD 5867c18: state every
      tick, snapshot every 10 ticks, every intake result.
    - Three Tier-1/2 lifecycle runs were diffed against HEAD: identical state, snapshots (5,160),
      intake results and refusal reasons.
    - Beside a *licensed* Tier-3 guild, the Tier-1/2 licences, rows, fees and verdicts are identical.
      Their fuel grants can move with the Tier-3 guild's RP through the shared pool (decision
      checklist).
  - Tests updated deliberately (`tier3-settlement.test.js`, `tier3-delivery.test.js`):
    - their Tier-3 licences commit whole units (the same `Q` as before);
    - 3a's re-lock test now expects the fixed re-offer instead of Steady's +0.10.
  - Sim suite 1,708 → **1,721 green** (`sim/tests/tier3-contract.test.js`, +13). It was also run
    against HEAD, where 12 of 13 fail; the isolation pin passes. Six deliberate breakages are each
    caught. Tools **68 green**.
  - **Still not safe to run live:**
    - the per-tick progress payment is 3d; *(⤳ built by Slice 3d, below)*
    - the client still sends the Tier-1/2 shape for a Tier-3 factory, which the engine now refuses;
      *(⤳ the Establish popup: built 28-09-26, "Tier-3 fork of the Establish popup" below)*
    - the Slice-3c checklist items below.

- **Tier-3 per-tick progress payment — ✅ BUILT 28-09-26 (Slice 3d of the Tier-3 economy build; the
  last engine slice).** `docs/tier3-timed-production.md` ("Income & commitment"; as-built "Slice 3d" at
  its end); design.md §5 AS-BUILT note; `docs/commitment-sale.md`. For a committed **timed** good only
  (decided by the good); Tier-1/2 keep the delivery-basis sale byte for byte.
  - **The payment.** Each tick a committed timed factory's line moves, it is paid `ownerFraction ×
    (x / y) × (output qty ÷ TICKS_PER_UNIT) × the posted price`: the committed share of that tick's
    work, at that tick's price, with the sale's owner split. 0 on a tick with no unit on the line.
    Smooth while running, nothing while stalled, nothing ever clawed back. A week of running is `x`
    units' worth.
  - **No double-count.** The delivery still moves the unit Syndicate-first and records it, but credits
    nothing for a timed good. The payment runs just before it, so the unit arrives already paid.
  - **Built as:** `paidOnProgress`, `committedShareOf` and `progressPayment` in `sim/licence.js` (pure
    arithmetic), applied in `applyProduction` (`sim/tick.js`, "THE PROGRESS PAYMENT"). The resolver,
    the preview and the snapshot are unchanged.
    - `committedShareOf` halts on an `x` outside `[0, floor(y)]` (dev scaffold only), naming the tick,
      `x` and `y`.
    - A missing posted price halts, as it does for the sale.
  - **Floor-and-carry** (build call, checklist). A tick of work can be worth under a credit (a 3-1 part
    at `x = 50` earns ~0.5 a tick), so rounding each tick would pay it nothing. The payment pays whole
    credits and carries the rest on the venture as **`paymentCarry`** in `[0, 1)`: the ruled
    discipline of `sendCarry` / `batchCarry`. It is never ahead of the work and never more than a
    credit behind.
  - **New state, omitted when 0:** `venture.paymentCarry`. A galaxy without a committed timed factory
    serializes as before; no fresh galaxy needed. New tripwire: it sits only on a timed factory, in
    `[0, 1)`.
  - **Measured, one week, one fed factory** (HEAD 4a0a651 → this slice):
    - 3-1, `x = 672` (flat price 100): 672 × 100 = 67,200 → 6–7 on all 10,080 ticks = 67,200.
    - Heavy engine, `x = 3` (flat 20M): 3 × 20M → 5,952–5,953 on all 10,080 ticks = 60M (short by
      under a credit, which is carried).
    - 3-1, `x = 336`: 33,600 on 336 ticks → 3–4 on all 10,080 ticks = 35,062. The week is paid at its
      average price (100 → 117 as the guild's own half piles up); the old sale sampled only the
      first-half price, because Syndicate-first delivery front-loads.
  - **Goldens: none moved** (no pinned run commits a timed good). Every 3a/3b/3c isolation pin passes
    unchanged. A new standing test pins Tier-1/2 committed goods to hashes computed on HEAD 4a0a651
    over 1,200 ticks: alone (state every tick, snapshot every 10), and beside guilds paid on timed
    progress (the Tier-1/2 guild's whole state, and the Tier-1/2 slice of a guild committing both
    tiers). The same two galaxies were also diffed against HEAD for 3,000 ticks at a 1,440-tick day,
    an anchored day and a 60-tick day: identical at every tick.
  - Test updated deliberately: `tier3-timed-production.test.js` "SEAM 1" pinned the lumpy sale. It now
    pins lumpy delivery with a smooth payment, and its scaffold `x` of 10,000 is now 672 (the payment
    refuses `x > floor(y)`).
  - Sim suite 1,721 → **1,733 green** (`sim/tests/tier3-payment.test.js`, +12; one shared 10,080-tick
    week, six guilds, every tick checked). Run against HEAD: 10 of 12 fail (the two engine-independent
    ones pass). Eight deliberate breakages are each caught: the delivery crediting too (double
    count), rounding per tick, flooring with no carry, paying on idle ticks, paying the whole progress
    instead of the committed share, ignoring the owner split, paying every good on progress (caught by
    the isolation pin), and no halt on an impossible `x`. Tools **68 green**.
  - **Still not safe to run live:** the client (3c's item) and the checklist items for 3c and 3d.
    *(⤳ The Establish popup: built 28-09-26, below. The Venture Management / renegotiation popups and
    the console are still open.)*

- **Tier-3 re-offer keeps the Strong discount; two lifecycle rulings recorded — ✅ BUILT 28-09-26
  (Tier-3 economy — cleanup).** `docs/tier3-timed-production.md` ("Renegotiation — fixed re-offer";
  as-built "the Strong discount on the re-offer, and two rulings recorded" at its end); design.md §5
  RULED note. Resolves three items the 3c/3d checklists carried.
  - **The fix (one return field).** `renegotiationTerms`' Tier-3 branch returned `feeDiscount: 0` at
    every band. It now returns `STRONG_FEE_DISCOUNT` (the existing −10%) for a Strong venture and 0
    otherwise, exactly as the Tier-1/2 branch does. The commitment `x / y` (exact) and the one-week
    term are unchanged, and there is still no ratchet: standing is read for the discount only.
  - **Recorded as RULED (docs only, no code):** the breached-week delivery/payment divergence is an
    intended breach penalty; auto-lapse (no auto-renew) is intended.
  - **Goldens: none moved.** No pinned run renegotiates a Strong Tier-3 venture (the one other Tier-3
    re-lock in the suite is at Steady). The Tier-1/2 branch is untouched, and the 3c Tier-1/2
    isolation pin passes unchanged.
  - Test updated deliberately: `tier3-contract.test.js`'s (c) headline expected no discount at Strong.
    It now expects 9,072 / 8,397 at Strong and 10,080 / 9,330 elsewhere (typed by hand), and checks a
    second renewal is not discounted twice. The 5,139-pair round trip also checks the discount by band.
  - Sim suite 1,733 → **1,734 green** (a new tripwire probes both sides of every band edge for a 3-1
    part and a heavy engine: the commitment never moves, and the discount is there only at Strong).
    Against HEAD's `sim/licence.js`, 3 of the file's 14 fail. Two deliberate breakages (the ratchet put
    back; the discount at every band) are each caught. Tools **68 green**.

- **Tier-3 fork of the Establish popup — ✅ BUILT 28-09-26 (Tier-3 economy — client).**
  `docs/tier3-timed-production.md` ("As built — the client" at its end); design.md §5 AS-BUILT note.
  Closes 3c's first client item. The popup sent the Tier-1/2 licence shape for every factory, which 3c
  refuses for a timed good, so every licensed Tier-3 deploy landed unlicensed.
  - **The fork** (`client/game.html`, `applyTier3Fork`). It is triggered the way Fuel and Tier 4 fold
    the popup, by the engine's classification read off the snapshot, so there is no good list in the
    client. For a timed good:
    - the commitment is a whole-unit slider, `0..floor(y)` with step 1, reading `x / y /week` and
      re-scaled live by the recipe;
    - equity is unchanged;
    - the fee %, the ¢/week and the graph marker read `x / y` through the existing mirror of the grid;
    - the 7–42-day slider becomes a read-only `7 days · fixed`;
    - the Licence Summary reads weekly;
    - the deploy sends `applyForLicence { committedUnits: x }` alone.
    Every non-timed recipe (Tier 1/2, the four unclassified modules), Fuel, Tier 4 and Deuterium are
    unchanged.
  - **One additive, derived snapshot field (flagged).** Nothing the client read carried `y`,
    `floor(y)` or which goods are timed, so `tier3Contract` publishes them per timed good:
    `{ weeklyOutput, committedUnitsCeiling, termDays }`, from `weeklyOutputOf`,
    `committedUnitsCeiling` and the schedule's term, listed only where `isTimedVenture` says so. It
    has no stored byte, no hash and no schema bump. No engine behaviour changed.
  - **Goldens: none moved; nothing re-pinned.** The two isolation pins that hash whole snapshots
    (`tier3-contract` `ISO_SNAPSHOTS_AND_RESULTS`, `tier3-payment` `ISO_ONE_SNAPSHOTS`) now hash them
    without the new key and still match the pre-slice engine's hashes. `server.test.js`'s meter pin
    now matches `repGain(cr,S.o01)` (`cr` is `S.c` for Tier 1/2).
  - **Proven by exercise** (Chromium, a live dev server, the real connect → homeworld → Settlements
    path):
    - the fork switches by recipe;
    - the slider snaps (336.7 → 337; a click → 2 of 3) and re-scales 0–672 / 0–3 of 3.5 / 0–2 of 2.33;
    - at every point of an `x` × equity sweep, the ¢/week equals the engine's `licenceFee`
      arithmetic;
    - the deploy's `{ committedUnits: 2 }` was accepted, with the locked fee equal to the panel's;
    - the pre-slice client's `{ committedOutputPct: 0.5, windowDays: 14 }` was refused;
    - the Tier-2 popup is pixel-identical to the pre-slice client's.
  - Sim suite 1,734 → **1,741 green**: `sim/tests/tier3-establish-client.test.js` (+6, including an
    HTTP end-to-end of the popup's two actions) and a served-page pin in `server.test.js` (+1). Six
    deliberate breakages are each caught. Tools **68 green**.
  - **Still not safe to run live:** the Venture Management and renegotiation popups (3c's other client
    items), the console, and the checklist items below. *(⤳ The console: built 28-09-26, "Tier-3
    fork of the System Production Console" below.)*

- **Tier-3 Establish popup — weekly language + the capacity Rate row — ✅ BUILT 28-09-26 (Tier-3
  economy — client copy).** `docs/tier3-timed-production.md` ("As built — the client's weekly copy" at
  its end); design.md §2 and §5 notes. It closes two items from "Tier-3 Establish client" on the
  checklist below (the Rate row and the copy). It is client-only: `client/game.html`.
  - **The Rate row shows capacity.** For a timed good it reads **Produces `y /week`**, from
    `tier3Contract[good].weeklyOutput`. It reads no commitment and no licence choice, so it is the
    same in every state. Every other venture keeps its per-tick **Rate** row.
  - **The copy is weekly.** On the Tier-3 path:
    - the hidden `/cycle` readout is no longer filled;
    - the confirm and both receipts say `x` units a week to the Syndicate, on a fixed one-week term;
    - "First output next tick", "tick by tick", "share" and the batches/tick "Recorded" rate are gone;
    - the two Tier-3 reels speak in whole units and weeks.
  - **No ETA:** the page holds no timer, and working one out would be the browser computing a game
    number (checklist).
  - **Standing convention:** every Tier-3 client surface speaks in whole units and weeks. It says
    no "share", no "per cycle" and no "per tick".
  - **Goldens: none moved** (no engine change). Tier-1, Tier-2, the unclassified module, Fuel and
    Tier-4 are identical to HEAD 3ef93a2's client. The panels, confirms, receipts and reels match,
    and each popup screenshot is a byte-identical PNG to a HEAD run (Chromium, live servers, one
    script; HEAD-vs-HEAD shows the same ≤12-pixel renderer noise).
  - Sim suite 1,741 → **1,742 green**: one served-page pin in `server.test.js` (+1). Six deliberate
    breakages are each caught. Tools **68 green**.

- **Tier-3 fork of the System Production Console — ✅ BUILT 28-09-26 (Tier-3 economy — client).**
  `docs/tier3-timed-production.md` ("As built — the client: the System Production Console" at its
  end); `docs/production-console-model.md` ("The Tier-3 fork"); design.md §5 AS-BUILT note. It is
  client-only: `client/console.html`, with no engine change and no snapshot change.
  - **The trigger** is `tier3Contract`, the same list the Establish popup forks on, so the page holds
    no good list, timer or week. Every other good, and Tier 4, is unchanged.
  - **For a timed good:**
    - the stockpile strip loses its top-up squares and per-tick chevrons, and shows "per factory · 1
      unit / 15m · up to 672 /week"; *(⤳ 28-09-26: that note is cut as clutter, "Tier-3 console — the
      stockpile strip's note cut" below)*
    - the Production column shows the cadence and each factory's unit on the line, not a per-tick
      trend;
    - Distribution has two arms, **Syndicate 1 · fixed, then Stockpile 2 · fixed**, with no
      Production arm, no rank selector and no send control;
    - the right column is always the Syndicate, weekly: the thermometer shows delivered against the
      week's `Q`, the countdown runs to the week's end ("6d 20h left in the week"), a breach shows at
      the week's end, the fee is "charged once a week", and the term is the fixed `termDays` days.
      There is no Consumption tab;
    - the standalone hero's "Output u/tick" row becomes "Makes 1 unit / 15m".
  - **No new snapshot field.** The timer and the unit on the line were already published on each
    timed factory's production row (`ticksPerUnit`, `unitTicksRemaining`).
  - **Two display rulings, made by the human during the build (checklist below):**
    - the order is drawn fixed and never written;
    - the reserve floor keeps the strip's typed field but drops the per-tick % slider, and no copy
      claims the reserve holds units back (it moves no unit of a timed good today). *(⤳ 28-09-26, Slice
      A: it now does, at the week's end, and the console says so.)*
  - **Goldens: none moved** (no engine change). By exercise in Chromium on a live server, 14 Tier-1/2
    cases (standalone and embedded, both tabs, an idle good, an unclassified module, Tier 4) rendered
    identical DOM and byte-identical screenshots against HEAD's page (apart from a one-pixel renderer
    blip that HEAD shows against itself too). A fuel tank (3-1) and a heavy
    reactor engine (specialist) read correctly from tick 200 through the week's breach and roll-over.
  - Sim suite 1,742 → **1,747 green**: `sim/tests/tier3-console-client.test.js` (+4, the engine facts
    the fork's display stands on) and a served-page pin in `server.test.js` (+1). Nine deliberate
    breakages, two of them in the engine, are each caught. Tools **68 green**.
  - **Still not safe to run live:** the Venture Management and renegotiation popups (3c's other client
    items), and the checklist items below.

- **Slice A (licence system) — the settlement-time stockpile rescue + refusing controls on a timed good —
  ✅ BUILT 28-09-26.** design.md §5 (the two RULED 28-09-26 notes and the AS-BUILT note after them);
  `docs/tier3-timed-production.md` "As built — Slice A". Closes two checklist items: 3b's "should intake
  refuse a send/order for a timed good" and the console's "should the reserve get a job for a timed good".
  - **The rescue (every tier).** At each committed good's own boundary (the day for Tier 1/2, the week for
    a timed Tier-3 good), just before the verdict, a short licence is topped up from the guild's stock of
    that good in that system: `topUp = min(shortfall, stock above reserveLevel not yet used)`.
    - Stock at or below the floor is never taken. A partial top-up leaves the guild exactly at its floor,
      and the licence still breaches on the rest.
    - The shortfall is the one the verdict's pursue fill leaves. Several short licences share the pile
      in the same pursue order, and the resolver halts if re-running the fill on the topped-up pile
      credits any venture differently.
    - Paid as a delivery: the posted price, `commitmentSale`, `recordSale`, owner `1 − o`. For a timed
      good this is the stockpiled units' one payment, beside unchanged progress payments.
    - Halts, naming the tick: no posted price; a rescue that would leave less than the floor on hand.
    - The fee, reputation and closure code is unchanged and reads the topped-up verdict.
  - **Built as:** `settlementRescue` + the boundary block in `resolveProduction` (`sim/production.js`,
    the plan, shared with the preview) and one loop in `applyProduction` (`sim/tick.js`, the move and the
    payment). The good's `window` gains `rescued`, present only when units move. No stored field, no
    schema bump.
  - **The refusal.** `setProductionProfile` refuses `syndicate` or `order` for a good a venture in that
    system makes as a timed good and commits, naming the field and the venture. `null`, `reserveLevel`,
    `pursue`, an uncommitted timed good and every Tier-1/2 good are still accepted.
  - **The console (client only).** The timed path's typed reserve field was already live (checked in
    Chromium: it POSTs only `reserveLevel`, which is stored and re-rendered). The strip and the Stockpile
    arm now say what the floor does at the week's end. The Tier-1, Tier-2 and uncommitted timed-good
    pages checked (four) render DOM identical to HEAD's.
  - **Isolation (the shared settlement path).**
    - The whole final suite (1,760 sim + 68 tools, all green) was run with the engine compared to HEAD
      d12ba58 from the same input on every tick: 178,600 ticks identical, the 50 ticks with a rescue
      all different, 0 unexplained; 8,292 previews identical, 14 previewing a rescue, 0 unexplained.
    - A new standing pin (hashes computed on HEAD d12ba58) holds a no-shortfall run and a
      shortfall-with-no-spare run, both spanning a Tier-3 week boundary, to HEAD's bytes at every tick.
    - **Four pins re-pinned, each only because its run now contains rescues** (the rescue ticks are
      named beside each): `tier3-contract` (both hashes), `tier3-delivery` (both), `tier3-payment`
      (three of four; the mixed guild's slice did not move), `tier3-settlement` (all four).
  - **Tests updated deliberately** (the rescue now reaches them; all were first proven to pass with only
    the rescue switched off):
    - breach-subject fixtures that forced a breach with a short send while the unsent output piled up
      now also hold that pile behind a reserve floor, so their verdicts, fees and RP are exactly as
      before: `licence-distribution` and `licence-fee-charge` (`setSend`), `reputation` (`send`),
      `forced-closure` (`starve`), `founding-endowment`, `mid-window-prorate` (the counterfactual),
      `factory-commitment` (the under-send breach), `window-accrual` (e);
    - repointed, because they pinned the pile as untouchable at a boundary: `window-accrual` (d) (the
      fork still sends 0; the pile now moves only on a boundary, by the rescue) and `reserve-priority`
      ("fresh only": the fork still takes 3; the rescue takes 2 and the window meets; the old breach is
      now what a floor of 10 gives, pinned beside it); `factory-commitment` "DEFERRED, PINNED" (the
      percent gap still sends 0 on every tick; at the boundary the rescue now delivers from stock);
    - comments only: `tier3-console-client` (fact 3), `tools/licence_bot.js`.
  - Sim suite 1,747 → **1,760 green** (`sim/tests/settlement-rescue.test.js` +12; a served-page pin in
    `server.test.js` +1). Against HEAD's engine 11 of the 12 new tests fail (the isolation pin passes).
    Eight deliberate breakages each turn a named test red: skip the floor, rescue below the floor, pay
    twice, a partial rescue softening the breach, a free hand-over, rescue on every tick, ignore the
    pursue order, drop the refusal. Tools **68 green**. **No number was invented.**

- **Slice A-fix (licence system) — the settlement rescue skips a licence-less commitment and pays each
  top-up on its own licence's equity — ✅ BUILT 28-09-26.** design.md §5 ("SETTLEMENT RESCUE — three
  follow-up rulings", (2) and (3), and the AS-BUILT Slice A-fix note after Slice A's). Closes Slice A's
  two checklist items on the equity split and the dev scaffold. Ruling (1) (input-raiding is intended)
  was already as-built and is untouched, as is everything else Slice A built: the floor, the boundary
  timing, partial rescue, the posted price, both halts, the fee, reputation and forced closure.
  - **(2) No licence, no rescue.** `settlementRescue` (`sim/production.js`) skips a venture with no
    stored `licence`, the fee charge's own test (`Boolean(v.licence)`, carried on the venture's target
    row). The skipped venture keeps what the pursue fill gave it and is judged on that; the spare
    passes on to the next licence. The verdict after a rescue is now each venture's fill plus its own
    top-up (`creditTopUps`). Slice A's halt (that credit must equal the fill re-run on the topped-up
    pile) still runs wherever every commitment on the good has a licence, which is all of real play.
  - **(3) Each top-up on its own equity.** The resolver's report carries `rescueTopUps` (`{ [good]: {
    [ventureId]: units } }`, only when a rescue moved units). `applyProduction` (`sim/tick.js`) pays the
    rescue through a new `rescueSale` (`sim/licence.js`): each top-up split on `ownerFraction` over its
    one venture, summed and rounded once, one integer on both legs. The posted price, the no-price
    halt, the below-floor halt, `addStock(-rescued)` and `recordSale` (units and credits summed for the
    good) are unchanged. New halts: the top-ups must add up to `rescued`, and `rescueSale` refuses a
    top-up for a venture it cannot find. `commitmentSale`, the per-tick delivery and the progress
    payment keep the blend.
  - **Nothing new shows.** `previewProduction` leaves `rescueTopUps` out, so the snapshot's shape is
    unchanged. No stored field, no schema bump.
  - **Isolation (both changes have a tight blast radius).**
    - The whole final suite (1,768 sim, all green; the 68 tools tests never tick the engine) was run
      with the engine compared to HEAD d7ef657 from the same input on every tick: of 180,501 ticks,
      180,490 are identical, 11 differ, 0 unexplained. 7 are ruling (2), a scaffold commitment HEAD
      rescued: `reserve-priority` (1), `window-accrual` (2), `factory-commitment` (1) and the new (g)
      tests (3). 4 are ruling (3), a good with licences at equity 0.1 and 0.4: the new (h) and (j)
      tests. Previews: identical on every tick but the 7 of ruling (2).
    - **No existing pin moved**, the four Slice A re-pins (`tier3-contract`, `-delivery`, `-payment`,
      `-settlement`) included: their rescues are real licences, one per good.
    - A new standing pin (hashes computed on HEAD d7ef657) holds two runs of REAL play with the rescue
      firing on every boundary to HEAD's bytes, every tick, every preview and every day's snapshot:
      one licence per good (Tier 1, 2 and 3, at equities 0.3, 0.15 and 0.2; 23 rescues), and two
      licences on one good at equal equity 0.3, both topped up every boundary (11 rescues, 22 top-ups).
  - **Tests updated deliberately** (each fixture commits straight on the venture, with no stored
    licence, so the rescue now skips it and the test returns to its pre-Slice-A outcome):
    `reserve-priority` "fresh only" (the pile untouched, the window breaches; the floor-10 twin gives
    the same), `window-accrual` (d) (the pile never moves, on a boundary or off it), and
    `factory-commitment` "DEFERRED, PINNED" (the percent gap now shows unrescued: 0 delivered).
  - Sim suite 1,760 → **1,768 green** (`sim/tests/settlement-rescue-fix.test.js`, +8). Named tripwires:
    (g) no licence, no rescue (in both rankings, and a scaffold alone); (h) own equity, not the blend
    (saving one licence, and topping up both); (i) equal equity is the blend; (j) the delivery still
    blends beside the rescue; (k) one venture is bit-for-bit the old sale. Conservation (every
    invariant, credits only between guild and ledger) is checked across each boundary. Against HEAD's
    engine 6 of the 8 fail; the 2 that pass do so by design ((i), and the isolation pin). Five
    deliberate breakages each turn a named test red: rescue a no-licence commitment ((g) ×2 and the
    three updated tests); pay the rescue on the blend ((h) ×2, (j)); never let Slice A's check stand
    aside ((g) halts with Slice A's attribution message); round each licence's share separately ((h)
    both, the isolation pin); let the snapshot carry `rescueTopUps` (the isolation pin). Tools **68
    green**. **No number was invented.**

- **Slice A2-engine (licence system) — Syndicate Top-Up: the settlement rescue is opt-in and capped —
  ✅ BUILT 28-09-26.** design.md §5 ("SYNDICATE TOP-UP — opt-in + capped", RULED 28-09-26, and the
  AS-BUILT Slice A2-engine note). The engine half; the console's de-mock is **Slice A2-client (✅ built,
  below)**. Every tier, none special-cased.
  - **Two profile fields,** validated and stored by `setProductionProfile` beside `reserveLevel`:
    `syndicateTopUp` (true/false; absent = false, OFF) and `syndicateTopUpLimit` (an integer ≥ 0,
    validated like `reserveLevel`; absent or sent `null` = no limit). `getGoodPolicy` fills the
    defaults. `null` clears either field (the profile's tri-state rule). Neither is refused on a
    committed timed good.
  - **The gate and the cap:** `settlementRescue` (`sim/production.js`) gains the switch (off ⇒ no
    top-ups) and the limit (the pool starts at the lower of the stock above the floor and the limit).
    Each venture's top-up is still `min(shortfall, pool left)` in the pursue order, so the good's rescue
    is the lowest of the shortfalls, the stock above the floor and the limit. The fields reach it on
    the good's plan, as `reserveLevel` and `pursue` do.
  - **Untouched:** the payment (`rescueSale`, per-licence equity), no licence no rescue, the floor,
    partial rescue, the verdict, fee, reputation and forced closure, and the per-tick Consumption
    Top-Up. `sim/tick.js` gained a comment, no code.
  - **Isolation.** The whole final suite was run with every `tick` and `previewProduction` call also
    run on HEAD cad2877's engine (always-on) from the same input:
    - **forced on, no limit, for every good:** 182,124 ticks and 12,394 previews, all byte-identical
      (9 ticks halt identically in both);
    - **as shipped:** 183,482 of 183,582 ticks identical (9 identical halts); the 91 that differ are
      all explained good by good (switched off ⇒ 0 rescued; capped ⇒ exactly `min(HEAD's, limit)`),
      0 unexplained. They are: the new tests (25); the four Tier-3 goldens (50); and three
      `mid-window-prorate` tests (16) whose rescue fired incidentally and was never asserted. Previews:
      27 of 12,408 differ, all explained.
    - **Four pins RESTORED, not re-pinned** — `tier3-contract` (both), `tier3-delivery` (both),
      `tier3-payment` (three of four), `tier3-settlement` (all four). Slice A re-pinned them only
      because rescues appeared. Their guilds never turn the switch on, so they now reproduce their
      original pre-Slice-A hashes (HEAD d12ba58's) exactly: the default-off proof.
    - **Slice A-fix's pin flipped to on, not re-pinned:** it must keep rescuing, so its fixtures turn
      the switch on. It hashes state and snapshots with that one key removed, and its HEAD d7ef657
      hashes still hold unchanged: the on-with-no-limit proof.
    - **A new standing pin (b)** holds one run of real play (a partial rescue, a scaffold ranked first,
      two licences at equity 0.1 and 0.4, a Tier-3 week) to HEAD cad2877's bytes switched on, and to
      HEAD d12ba58's (no rescue at all) left off.
  - **Tests updated deliberately:** `settlement-rescue` and `settlement-rescue-fix` turn the switch on
    in every fixture (they test a rescue that fires; nothing else changed in them). Seven
    `profile`/`actions` tests gain the two defaults in the policy shape they pin. Comments only:
    `tier3-console-client`, `tools/licence_bot.js`.
  - Sim suite 1,768 → **1,776 green** (`sim/tests/syndicate-top-up.test.js`, +8). Named tripwires:
    (a) off ⇒ no rescue, the breach stands (absent, false, false-with-a-limit; before/after beside it);
    (b) on + no limit ⇒ the old engine; (c) the limit (a table of nine, per settlement, Tier 2,
    Tier 3); (d) the floor still holds; (e) a shared limit pays each licence on its own equity;
    (f) the two fields' validation. Against HEAD's engine all 8 fail. Six deliberate breakages each
    turn named tests red:
    - rescue while off: (a), (b), the Tier-2 and Tier-3 rows, and the four restored goldens (8 tests);
    - ignore the limit: (c) ×4 and (e) (5 tests);
    - a per-licence limit instead of one per good: (e);
    - default on: 16 tests in the rescue, profile and Tier-3 files, among them (a), (b), (f), the four
      goldens and the profile shapes;
    - the limit replacing the floor: (c)/(d), stopped by the tick's floor halt;
    - drop the validation: (f).
    Tools **68 green**. **No number was invented.**

- **Slice A2-client (licence system — client) — Syndicate Top-Up: the console's control is live — ✅ BUILT
  28-09-26.** design.md §5 ("SYNDICATE TOP-UP", and the AS-BUILT Slice A2-client note). `client/console.html`
  only, plus the served-page pins it changed. **No engine change, no snapshot change.**
  - **De-mocked:** the Syndicate top-up square (in a Tier-1/2 good's stockpile row, where it always sat)
    reads the good's `syndicateTopUp` / `syndicateTopUpLimit` off the snapshot through `goodPolicy`,
    beside `reserveLevel` (absent ⇒ OFF / no limit). A click on the switch POSTs `{ syndicateTopUp: <bool> }`
    via `sendProfile`, flipped from the snapshot's value (`postTopUpSwitch`, which holds the LIVE poll
    like the pursue movers). A limit edit POSTs `{ syndicateTopUpLimit: <int> }`, and a blank field POSTs
    `null` (no limit, shown as "no limit"). The engine does the validation. The browser-only `SYN`
    object, its "ADVISORY … POST nothing" note, the mock tag and the orphaned `.mocktag`/`.mocknote` CSS
    are gone.
  - **Stale text fixed (prose only):** the legend and file header (the licence layer "not built", the
    top-up "MOCK"); an uncommitted good's "the send is advisory until a licence is issued" (×2, one in
    unreachable code) → "the send takes effect once a licence commits this good"; the timed Stockpile
    arm → "If Syndicate Top-Up is on, stock above the reserve is delivered at settlement to cover a
    short week, up to any limit you set." The hero's Facility block keeps its MOCK tag.
  - **Proof.** Sim suite **1,776 green** (unchanged count, no golden moved). Tools **68 green**. Two
    served-page pins updated with their intent kept (`server.test.js`: the design-ahead panel now
    numbers one and the top-up is not tagged mock; the timed Stockpile arm's new copy, and the old line
    gone). **Exercise:** Chromium on a live dev server, with the galaxy built over HTTP (two titanium
    mines, one licensed; a titanium-alloy refinery; a licensed fuel-tank factory). 38 checks, all
    green:
    - every POST body matched exactly: on, off, a limit of 25, cleared to `null`, the stepper's 1, a
      refused −3, a second good's own switch, and embedded mode;
    - every value re-read from `/snapshot`, and after a full reload;
    - the old strings gone from the served page, and the Facility tag still there.
    **Parity** against HEAD's page on the same frozen galaxy: 12 cases (Tier 1–4, committed,
    uncommitted, idle, timed, standalone and embedded). The DOM is identical outside the three changed
    elements. With those held to HEAD's size, every stage screenshot is byte-identical (HEAD is stable
    against itself). The one visible side-effect: without the MOCK tag the square's header fits on one
    line, so a Tier-1/2 stockpile row is 13px shorter. **No number was invented.** Open items: the
    decision checklist, "Slice A2-client".

- **Slice A2-client-fix (licence system — client) — the Tier-3 fork gets its Syndicate Top-Up control —
  ✅ BUILT 28-09-26.** design.md §5 (the AS-BUILT Slice A2-client-fix note). Closes Slice A2-client's
  first checklist item: the timed fork drew no top-up control, so a Tier-3 guild could not turn on
  the rescue the opt-in was ruled for. `client/console.html` plus the one served-page assertion.
  **No engine change, no snapshot change.**
  - **Built as ruled:** `timedReservePanel` draws `syndTopupSquare(good, true)` in the Consumption
    square's place on the strip. It is the Tier-1/2 control itself: the same `goodPolicy` read, the
    one `.su-en` handler (`postTopUpSwitch`), and the one `.su-limit` handler. Only the words are the
    week's (the label "limit /week", the tooltips). On the timed path the square never shows "active",
    because the fork draws no per-tick projection. The reserve field is unchanged.
  - **Test flipped:** `server.test.js`'s Tier-3 fork test no longer lists `syndTopupSquare` as
    something the fork must not draw. It now pins that the strip draws it, with `.su-en` and
    `.su-limit`, through exactly one handler of each. It still pins that the fork draws no
    `consTopupSquare`. It fails by name against the pre-fix page.
  - **Proof.** Sim **1,776 green**, tools **68 green** (no golden moved). Chromium on a live dev
    server, 38 checks. The galaxy had fuel tank and hull plating licensed, a deep scan mast
    uncommitted, and chassis idle. Every POST body was exactly one field: on, off, a limit of 3,
    cleared to `null`, the stepper's 1, a refused −2, and the second timed good's own switch and
    limit. Every value survived a reload, and it worked embedded too. **Parity** against the pre-fix
    page:
    - Tier 1/2, the unclassified module and Tier 4: raw-DOM identical and pixel-identical.
    - Every timed case: exactly one element added; with it removed, the DOM and the whole stage's
      pixels are identical.
    The timed strip grows from 104–106px to 142px. **No number was invented.**

- **Tier-3 console — the stockpile strip's note cut; the idle-good line terse — ✅ BUILT 28-09-26
  (client copy, asked for by the human).** `docs/tier3-timed-production.md` ("As built — the
  console's stockpile strip carries no note" at its end); design.md §5 notes. `client/console.html`
  only. **No engine change, no snapshot change, no figure changed.**
  - **The strip.** `timedReservePanel` draws no note. The three lines under the timed strip's title
    are gone:
    - "per factory · 1 unit / 15m";
    - "up to `y` /week";
    - "the reserve is never taken at the week's settlement".
    The strip shows its title, the reserve field and bar, and on-hand, and still no chevrons.
    `stockpileStrip`'s fifth argument is now a `timed` flag, not a note, because an empty note would
    have drawn the per-tick chevrons back. Tier 1/2 pass nothing and are unchanged. The unused
    `.rs-cad` style and `timedReservePanel`'s unused `t3`/`report` arguments are gone.
  - **Still on the page:** the cadence and `y` in the Production column, and the floor's job in the
    Stockpile arm. An idle timed good draws no Production column, so it no longer shows `y`.
  - **The idle-good line, every tier:** "Lead — idle · on hand 7". It was "Lead is idle in sys_0006 —
    nothing mined, refined, or consumed here. On hand: 7."
  - **Tests:** `server.test.js` has two pins repointed to the new call shapes, and the Slice A pin no
    longer asks for the strip's reserve line. The arm half is kept. A new pin (+1) checks four things:
    - no `rs-cad` anywhere;
    - no note words in `timedReservePanel`;
    - the timed head is the title alone, and Tier 1/2's call is unchanged;
    - the terse idle line, with the old sentence gone.
    All three Tier-3 console pins fail against HEAD's page. Four deliberate breakages each turn a
    named pin red: an empty note (chevrons back), the old idle sentence, a note line back in the
    panel, and chevrons in the timed head. `tier3-console-client.test.js` changed in comments only.
  - **Proof.** Sim 1,776 → **1,777 green**, tools **68 green**; no golden moved. Chromium ran on two
    live dev servers, this page and HEAD c99005b's, on one galaxy built by the same actions (seed 7331,
    tick 20). It had Tier-1 mines, Tier-2 refines, a committed fuel tank, an uncommitted power-cells
    factory, an unclassified drive module, and idle lead, silicon wafer and hull plating. 18 cases in
    all, standalone and embedded, both right tabs, and Tier 4:
    - **Unchanged (11):** Tier 1/2, the unclassified module, Tier 4 and embedded are DOM-identical.
      10 are pixel-identical. One differs by 100 pixels at ≤1/255, in the flow body, not the strip.
      That is renderer noise: HEAD shows it against itself on another case.
    - **Changed as intended (7):** each timed strip lost exactly its note, with no chevrons. Each idle
      case shows the terse line.
    - The stock row stays 142px.
    - The DOM compare normalises the sparkline's gradient ids (`sg<n>`). They come from a per-render
      counter, so they vary between two renders of the same page on HEAD too.
    **No number was invented.**
- **Tier-3 whole-week retime — every weekly output is a whole number — ✅ BUILT 28-09-26 (Tier-3
  tuning).** `docs/phase-1-tuning.md` ("Tier-3 timers REVISED" and its AS-BUILT note);
  `docs/tier3-timed-production.md` ("As built — the whole-week retime"); design.md §5 (the ladder note).
  **No new number:** the three timers are the human's ruling, and the week is `TIER3_WINDOW_N`.
  - **The retime.** `TICKS_PER_UNIT` (`sim/baseline.js`): heavy_reactor_engine 2,880 → **2,520** (42 h,
    y = 4), stealth_module 2,880 → **3,360** (56 h, y = 3), deep_scan_mast 4,320 → **5,040** (84 h,
    y = 2). The other seven rows are unchanged.
  - **The tripwire.** `assertWholeWeeklyOutput` (`sim/windows.js`, beside the week) runs at load and
    throws, naming the good, its timer and the fractional `y`, if `10,080 % TICKS_PER_UNIT` is not 0 for
    any Tier-3 good with a timer. The unclassified four have none, so they are skipped. Shown live: the
    heavy engine set back to 2,880 stops the engine loading ("y = 10080 ÷ 2880 = 3.5 is not a whole
    number").
  - **A float seam, closed.** `(1 ÷ 3,360) × 10,080` is 3.0000000000000004, so `weeklyOutputOf`
    (`sim/licence.js`) rounds the engine's `y` back to its whole number. That is a no-op for every
    other good. Without it a stealth module committed in full would store `x / y` = 0.9999999999999999.
    The existing float-safety test caught the same seam; it now pins exact `y` plus the same whole
    units from `floor` and `round`.
  - **What moved (derived).** Heavy engine `floor(y)` 3 → **4**, fee at base 7M → **8M**/week, and its
    most (x = 4) is now a full commitment (discounted 6M). Stealth 2.8M → 2.4M/week; deep scan mast
    4,666,667 → 4,000,000/week. A tick of committed work is `x ÷ 10,080` of a unit whatever the timer,
    so the progress pay for a given `x` is unchanged.
  - **Isolation.** Goods not retimed are byte-identical to HEAD c99005b. A week plus a day with all 18
    non-retimed timed goods committed, plus Tier-1/2 licences, gives the same state every tick, and
    every snapshot matches once the three retimed goods' quote rows are removed. Every other pinned
    hash held.
  - **Re-pinned (each noted in its file):**
    - Eight **snapshot** hashes in five tests, whose runs build none of the three. The snapshot
      publishes every timed good's `feeQuote` / `tier3Contract` row, and those rows moved. Checked
      snapshot by snapshot: identical to HEAD with those rows removed, and the state hashes did not
      move. They are `settlement-rescue-fix` (both runs), `settlement-rescue` (both),
      `syndicate-top-up` (on and off), `tier3-contract`'s Tier-1/2 isolation, and `tier3-payment`'s
      ISO_ONE_SNAPSHOTS.
    - `tier3-payment`'s **ISO_TWO_T12_GUILD**. Its galaxy commits a heavy engine at x = 3, now 3 of 4,
      not 6/7. So that guild's signing RP fell (514 → 450), then its issuance modifier, then the fuel
      price. The Tier-1/2 guild's physical fuel grant rose (31 → 33 on tick 180). Only its fuel fields
      differ from HEAD.
  - **Tests.** The "at its most" heavy-engine cases move to x = 4. The 4th unit lands on tick 10,080,
    the week's last, and it counts: met. The payment test keeps x = 3 (now 3 of 4). Its "never more
    than owed" check allows 1e-3, the float allowance its sibling line uses: the engine now pays exactly
    60,000,000, and the test's own float sum reads 59,999,999.99999674. New: "WHOLE WEEKS", every `y`
    whole and the engine's `y` exact, and the tripwire firing on each old timer. Sim 1,776 →
    **1,778 green**; tools **68 green**.
  - **Left for the client slice (out of scope here):** `client/console.html`'s `fmtY` comment still
    cites "a deep scan mast's 2.333… reads 2.33". The console shows whatever the snapshot publishes,
    so it now reads 4 / 3 / 2.

- **2.2 — The deploy pipeline: the cross-system asset ferry (`docs/territory-model.md` §5).** Haul a
  Tier-4 kit on a transport to a target and place it on arrival — the ferry that unblocks the Prefecture
  (the item below). Built as a ladder: **slice 1** the deployable good + a manual outpost deploy (engine +
  operator CLI) → **slice 2** auto-insert the deploy on arrival (a dispatch's on-arrival action, via the
  actioned-route machinery) → **slice 3** the deploy range in the snapshot (the data the range paint
  reads) → the client (Manage popup, deploy-map picker, range paint — *⤳ re-ruled 01-10-26 as the
  craft-initiated deploy map, `territory-model.md` §5; client slice 2 below*) → the kit SOURCES (the dockyard
  building a kit, the founding-grant kit, loading a kit from a store) → the other kinds (toll gate,
  deep-scan array, the Prefecture). *⤳ Re-ruled 02-10-26 as ASSET-INITIATED (`territory-model.md` §5 REVISED,
  `design.md` §4): the kit is a system-scoped idle asset, loaded onto a same-system heavy at commit. Its
  prerequisite rung — the kit as an idle asset + load / unload + the repointed `grantKit` — is BUILT, "asset-initiated
  slice 1" below; the client (idle-outpost Deploy, carrier picker, planner reuse, message rewire) is next. ⤳ Its first rung — the
  idle-outpost Deploy, the carrier picker and the `loadKit`-then-dispatch commit on the single-leg map — is BUILT, "asset-initiated
  client slice 2a" below; next the multi-leg planner with the commit in the popup (2b), then the message's Redeploy / Return (3).
  ⤳ Its second rung — the multi-leg planner and the commit in the popup — is BUILT, "asset-initiated client slice 2b" below;
  next the message's Redeploy / Return (3).*
  - **slice 1 — the deployable good + outpost deploy (engine + operator CLI, NO client).** 🟢 *BUILT (29-09-26).*
    **Built so far — the deployable good:** `DEPLOYABLE_GOODS` = [`outpost_kit`] + `isDeployableGood` /
    `kitGoodFor` (`sim/resources.js`), a sibling category to the stockpile goods and deliberately NOT in
    `STOCKPILE_GOODS` — so it has no price row, no Galactic Supply row, and is illegal in a system pool or an
    Outpost stockpile; `volumeOf('outpost_kit')` = `ASSET_CARGO_VOLUME` (= `HEAVY_HOLD`, `sim/fuel.js` — no
    new number), so only a heavy carries one, one at a time; `checkVehicleIntegrity`'s cargo known-good check
    widened to accept a deployable good IN A HOLD ONLY. The manual `transferCargo` gate and the route-action
    manifest gate stay stockpile-only (a kit is never manifested, never automated).
    **Built so far — the mint lever:** the journalled `grantKit { guildId, vehicleId, kind }` (`sim/actions.js`)
    mints one kit (`kind: 'outpost'` → `outpost_kit`) straight into an idle craft's hold — the operator test
    seam until the real kit sources land. Refused whole unless the guild owns the craft, the kind has a kit,
    the craft is idle and not on a lane, and its hold has room for the kit — which, at `HEAVY_HOLD`, means an
    EMPTY heavy (a light / medium / spycraft is refused as over capacity; no separate class rule). Tick-stamped
    (`updatedAtTick`); moves no credits / fuel / supply. And a kit never rides a lane: `grantKit` refuses a
    craft on one, and `dispatchRouteWithActions` refuses to launch a REPEATING lane on a kit-laden craft (a
    one-shot route still carries it — that is how it reaches its target).
    **Built so far — the deploy:** the journalled `deployAsset { guildId, vehicleId }` (`sim/actions.js`; the kind
    is read from the kit aboard). Refused whole unless the guild owns the craft; it is idle, not on a lane, and on
    a BARE HEX (not berthed at a system / waystation landmark — an Outpost goes on open ground); it carries
    exactly one `outpost_kit` and nothing else; the hex is unoccupied (the shared `hexOccupant` — no seed
    landmark, no guild Outpost — now also what `spawnOutpost` asks); and the hex is within
    `OUTPOST_DEPLOY_RANGE` (the ruled `[FIRST-CUT]` 10, `sim/outposts.js`, recorded in `phase-1-tuning.md`
    "Territory & deployment") of a system the guild holds. The apply mints the Outpost through the ONE mint
    path `spawnOutpost` now shares (`mintOutpost` — the same `outpost_<guild>_NN` serial, the same shared row),
    anchored to the NEAREST held system (a tie → the lower system id), and consumes the kit (the hold key goes).
    Instant (no build time, §5); moves no credits / fuel / supply / price, writes no claim row. The craft stays
    idle on the hex, so it now reads as parked at its new Outpost.
    **The operator surface:** `POST /admin/vehicle/grant-kit` + `POST /admin/vehicle/deploy-asset` (Access-gated,
    through the same validate → journal → apply path as every `/admin/vehicle/*` endpoint) and `tools/admin.js
    grant-kit --guild ID --id VEHICLE_ID --kind outpost` / `deploy-asset --guild ID --id VEHICLE_ID` (each prints
    the resulting hold; a deploy also prints the new Outpost's id, hex and anchor). `docs/cli-runbook.md` has the
    sequence. No snapshot change: a kit shows as an ordinary `cargo` key (its `used` a whole heavy hold).
    **A NO-OP on a galaxy with no kit and no deploy** — no existing test or golden changed (persist / determinism /
    galactic-supply goldens byte-identical). Sim 1,779 → **1,818 green** (`deployable-goods.test.js` +15,
    `deploy-asset.test.js` +22, `server.test.js` +2); `tools/admin.test.js` 68 → **71**. Driven end to end
    against a live persisted server (seed 42): grant → dispatch 3 hexes → tick → deploy; exactly-10 deploys,
    11 is refused; a `kill -9` (journal replay) and a SIGTERM restart both come back canonically byte-identical.
    **Deferred (not invented):** the client (the Manage popup, the deploy-map picker, the range painted on the
    map — `client/game.html` untouched; today a kit just lists as an "Outpost Kit" cargo row); auto-deploy on
    arrival (a dispatch's on-arrival action) and with it the arrival re-validation rule (open on the checklist)
    *(⤳ BUILT in slice 2, below)*;
    the kit SOURCES (the dockyard building one, the founding-grant kit, loading one from a pool / Outpost —
    `transferCargo` and the route-action gates stay stockpile-only); storing a kit AT an Outpost (§4); the other
    kinds (toll gate, deep-scan array, the Prefecture) and their ranges; the spatial control layer
    (`territory-model.md` §1–§3 — a deployed Outpost writes no claim row); the Outpost's GP weight and deploy RP
    offset (`phase-1-tuning.md`, still `[DEFERRED]` — a deploy moves no points, exactly as `spawnOutpost` never has).
  - **slice 2 — auto-deploy on arrival + the retreat rule (engine + operator CLI, NO client).** 🟢 *BUILT (30-09-26).*
    **The deploy waypoint action:** a `dispatchRouteWithActions` waypoint may carry `{ type: 'deploy', kind }`
    beside `dock` ("send this heavy + kit to hex X; it plants the Outpost the moment it lands"). Refused whole at
    dispatch unless the kind has a kit (`kitGoodFor`), it is on the FINAL waypoint, that anchor is a BARE HEX, and
    the deploy would pass NOW — exactly one matching kit and nothing else aboard, the hex free, within
    `OUTPOST_DEPLOY_RANGE` of a held system — so a doomed trip is never flown or fuelled. It is exempt from
    `routeStoreAt` (open ground has no store); slice 1's repeating-lane gate is unchanged, so it rides a one-shot
    route only; `saveRoute` keeps its dock-only gate (a deploy is a one-off trip, never a saved lane).
    **The on-arrival deploy:** `resolveRouteArrival` gains a `deploy` branch that re-validates and applies through
    slice 1's core, now shared — `deployCheck` (bare hex, one kit, `hexOccupant`, `nearestHeldSystem` range) and
    `deployKit` (`mintOutpost` + consume the kit) — so the manual `deployAsset` and the arrival are one deploy
    implementation with two triggers (`deployAsset` itself is unchanged). `mintOutpost` now takes its tick, since an
    arrival mints on `state.tick + 1`.
    **The retreat (the arrival-revalidation rule, RULED 30-09-26 — `territory-model.md` §5):** on a failed
    arrival the craft does NOT idle on the hex (it may be a rival's space). It snaps `DEPLOY_RETREAT_HEXES`
    (`[FIRST-CUT]` 3, `sim/outposts.js`, recorded in `phase-1-tuning.md` "Territory & deployment") hexes toward the
    nearest held system — `hexStepToward` (`sim/transport.js`, a whole-number cube-round of the interpolated point)
    — clamped to land AT the system (a landmark location) when it is that close or closer. Kit aboard, idle; no
    fuel, time, toll/fine or supply move. Flagged `deployFailed = { reason: 'occupied' | 'out-of-range', tick }`,
    the `laneEnded` pattern: cleared by the next dispatch (either kind), surfaced on the snapshot's vehicle row,
    shape-checked by `sim/invariants.js` (a known reason, a whole tick ≤ now, no route alongside); the route
    invariant also pins a craft's deploy action to the last waypoint, a bare hex and a one-shot route. A failure the
    dispatch rules out (a kit lost in flight, a guild holding no system) HALTS the tick with the values instead of
    guessing. **One provisional edge (decision checklist):** a 3-hex step that falls just off the lattice near the
    rim (9 system / in-range-hex pairs on the live seed) steps on along the same line to the first on-lattice hex.
    **The operator surface:** no new endpoint — `tools/admin.js dispatch-route` takes a last stop
    `q,r@deploy:KIND` (e.g. `--route "101,55@deploy:outpost"`; one action per waypoint, so never beside `@load` /
    `@unload`) and prints it as `deploy KIND`; `docs/cli-runbook.md` has the sequence, retreat included.
    `tools/admin.test.js` 71 → **73**. Driven end to end against a live persisted server (seed 42): a heavy
    dispatched `101,55@deploy:outpost` planted `outpost_seat_demo_01` on its arrival tick with credits, fuel,
    Galactic Supply, stockpiles, prices and claims byte-equal to a twin server flying the same route with no
    action; a deploy onto that now-occupied hex was refused up front; one sent to `104,48` and occupied
    mid-flight retreated to `104,51` (3 back toward home at `104,55`), kit aboard, `deployFailed: occupied`; the
    flag cleared on re-dispatch; a `kill -9` mid-flight, a SIGTERM restart and a `kill -9` replaying a journalled
    dispatch all came back canonically byte-identical.
    **A NO-OP on a galaxy that dispatches no deploy** — the branch is never taken and `deployFailed` never set; no
    existing test or golden changed (persist / determinism / galactic-supply goldens byte-identical). Sim 1,818 →
    **1,845 green** (`deploy-on-arrival.test.js` +27: the retreat geometry, happy path, retreat on occupied /
    out-of-range, the clamp, the flag's clear, every dispatch gate, determinism across save/restore, two craft on
    one hex, the off-lattice walk, the loud halt, the invariant shapes).
    **Deferred (not invented):** the client (the Manage popup, the deploy-map picker, the painted range, and the
    `deployFailed` message — "deploy failed — hex taken / out of range; craft pulled back"); refining the retreat
    LANDING to avoid rival / contested space (needs the §1–§3 spatial control layer); the other kinds; the kit
    sources; auto-deploy for the ground-asset lane (that is the establish flow, not this).
  - **slice 3 — the deploy range in the snapshot (engine + snapshot, NO client).** 🟢 *BUILT (29-09-26).*
    Built to `territory-model.md` §5 "Painting the range (the snapshot contract)", no design change. Each guild
    row in `buildSnapshot` (`sim/snapshot.js`) gains a lane-keyed `deployRange = { outpost: { radius, anchors } }`
    (`deployRangeFor`): `radius` is the engine's `OUTPOST_DEPLOY_RANGE` (imported — no literal in the snapshot, §18)
    and `anchors` is `heldSystemIds(state, guildId)` verbatim — sorted and deduped at the source (invariant 9), the
    same set `nearestHeldSystem` measures the range to. **Omit-when-empty:** a guild holding no system carries no
    `deployRange` key (it can deploy nowhere), the `savedRoutes` discipline. Lane-keyed so `tollGate` / `deepScan`
    join as sibling keys with no reshape; only `outpost` is filled. The thin shape by ruling — no enumerated hex set,
    no occupancy or bounds filtering: the client draws `hexDistance ≤ radius` disks and `deployCheck` stays the sole
    authority on legality. ADDITIVE, no schema bump (`SNAPSHOT_SCHEMA` stays 7); the guild-row shape comment
    documents `deployRange?`. Pure derived telemetry, like `fuelCost`: reads state, mutates nothing, no serialized
    byte, no determinism hash. No behaviour change — `deployCheck` / `deployAsset` / `deployKit`, the deploy
    waypoint action and the retreat are untouched; no endpoint, CLI or operator change (`GET /snapshot` already
    serves the row verbatim).
    **The tripwire:** `deploy-range.test.js`'s `assertDeployRange` checks every guild row against the state it was
    built from — absent when nothing is held; otherwise exactly the `outpost` lane, exactly `{ radius, anchors }`,
    `radius === OUTPOST_DEPLOY_RANGE`, every anchor held (`guildHolds`) and the list equal to `heldSystemIds` in
    order — and throws with the tick and the offending values. It is a snapshot-shape assertion in the test file,
    not a `sim/invariants.js` check, because those read STATE every tick and `deployRange` exists only in the
    snapshot.
    **A NO-OP on every golden** — no existing test or golden changed: the persist / determinism / galactic-supply
    state goldens (`persist.test.js`, `commitment-scaffold.test.js`, …) cannot move, since nothing is serialized;
    the snapshot-hash goldens (`tier3-contract`, `settlement-rescue`, `syndicate-top-up`) hold no system, so the key
    is omitted and their bytes are unchanged. Proven directly too: a founded two-guild galaxy run 60 ticks before and
    after the change gives the same state hash at every tick and the same snapshot bytes once `deployRange` is
    stripped. Sim 1,845 → **1,855 green** (`deploy-range.test.js` +10: the N-systems shape, omit-when-empty, own
    systems only (not a rival's, a non-system claim or an Outpost), derived-not-stale through a hand-edited claim
    list and the real `foundGuild`, determinism + sorted-not-insertion order, purity + no aliasing, the painted edge
    agreeing with `deployAsset` (exactly `radius` passes, one further is refused), the tripwire firing on each kind
    of drift, and holding every tick of a founded galaxy); tools **73** unchanged.
    **Deferred (not invented):** the client — painting the range on the deploy-map picker (the next slice;
    `client/game.html` untouched), with the Manage popup and the `deployFailed` message; the `tollGate` /
    `deepScan` lanes and their anchors (outposts join them) with their ranges, still `[FIRST-CUT]` on the checklist.
  - **client slice 2 — the deploy map + on-tile DEPLOY (CLIENT ONLY, `client/game.html`).** 🟢 *BUILT (01-10-26).*
    Built to `territory-model.md` §5 "The deploy map (client, as designed — RULED 01-10-26)", no design change: the
    transport route builder re-skinned, with no new visual language. **Entry:** the Dispatch popup's pre-plan row gains
    **Deploy** beside Plan Route, shown ONLY when the craft's hold carries an `outpost_kit` (`deployKindOf`) *(⤳ REMOVED
    02-10-26 — the map now opens from the idle outpost; "asset-initiated client slice 2a" below)*. It opens
    the map in the **deploy variant of planning mode** (`startPlanning(…, deployKind)`) at **4×** (`DEPLOY_MAP_ZOOM`,
    the ruling's zoom), centred on the craft. **The ring:** `drawDeployRing` paints the player guild row's
    `deployRange.outpost`: the union of `hexesInRadius(anchor, radius)` over every anchor, its boundary edges only
    (an edge whose neighbour is outside the union), in the player teal with the toll path's dashed stroke. The radius
    is the engine's, never a literal (§18). **Select + the chip:** a click proposes `PLAN.candidate` as before; on the
    deploy map `#plan-chip` is ONE stage, **[Deploy] [Cancel]**. A non-bare hex (a system, a waystation, the Citadel's
    hex, any guild's Outpost), an off-disc hex or one outside the ring is refused the route builder's way: the chip
    stays, Deploy disabled, the reason as its hint (`deployRefusal`, which asks deployCheck's questions in its order;
    guidance, never the verdict). A refused candidate is replaced by the next click. A SELECTED target locks the map,
    so a click elsewhere does nothing until Cancel. **DEPLOY** builds the one waypoint `{ anchor, action: { type:
    'deploy', kind: 'outpost' } }` and sends it down the Dispatch popup's own path (`__dispatchDeploy` →
    `dispatchActionFor` → `dispatchRouteWithActions` via `wireWaypoints`). The chip is the finalise: no Finalise
    view, no launch picker, always a one-shot. The map stays in deploy mode until the engine answers. An accept
    closes it and re-reads the snapshot, so the craft draws in transit. A refusal puts the engine's reason on the
    target row and keeps the selection. DEPLOY also re-checks the hex first, so one an Outpost took since it was
    picked is caught with nothing sent. **Arrow-key panning** goes into the SHARED planning mode, so the route
    builder gains it too: each press moves `focusTarget` `PAN_STEP_PX` (120) screen px, screen-relative at any orbit
    angle, and the frame loop's ease animates it. Drag-orbit is untouched, and a key typed into a field is ignored.
    **Chrome reused:** the banner reads "Deploying Outpost · Heavy Transport"; the left panel, "Deploy Target", shows
    the origin + the one target, its action read through the shared `actionSummary` (which now reads a deploy
    action); `#app.deploying` hides Load Route / Finalise; the map key and zoom readout are unchanged.
    **A NO-OP for `sim/`:** no engine, snapshot, test or golden touched (`git diff` is `client/game.html` + docs).
    Sim **1,855 green** and tools **73 green**, both unchanged. Driven headless on a seated seed-42 server (a heavy
    given a kit by `grant-kit`): Deploy shows on the kit-carrying heavy and not on a light. The map opens at 4× with
    the ring. The home system and a hex 11 out are refused. A bare hex 6 out selected → DEPLOY → in transit with
    exactly one waypoint carrying the deploy action, one-shot, and on arrival the engine planted the Outpost there.
    A second click while selected did nothing, and the arrow keys panned both modes (measured to the pixel). A hex
    taken after it was picked was caught at DEPLOY. An engine refusal (no fuel) showed on the target, and a retry
    after refuelling went out.
    **Deferred (not invented):** client slice 1, the `deployFailed` notice on the Operations · In-Transit strip
    (its own slice, not built here); showing the engine's time / fuel quote before DEPLOY, and the pan step
    (both on the decision checklist; *⤳ the quote is ruled yes and BUILT 01-10-26, "the pre-deploy quote" below*); re-judging a picked hex on every poll (DEPLOY re-checks at the click, the
    engine at dispatch and arrival); the other lanes (toll gate, deep scan, ground assets) and the kit sources.
  - **the `deploy_failed` notice — ENGINE (the type + the write, NO client).** 🟢 *BUILT (01-10-26).*
    Built to `docs/event-log.md` §10, no design change. **The type:** `DEPLOY_FAILED = 'deploy_failed'` is the third
    entry in `EVENT_TYPES` (`sim/events.js`), so `checkEventLog` accepts it. The log, `recordEvent`, retention and
    acknowledge are unchanged, and the new type rides all of them. **The write:** `resolveDeployArrival`'s retreat
    branch (`sim/actions.js`), where it already sets `craft.deployFailed`, also records one row through `recordEvent`
    on the same guild at the same tick. One writer, so the flag and the message cannot disagree. The flag, the deploy
    and the retreat logic are untouched. **The payload** (self-contained, built at the retreat): `cause` (the flag's
    reason, `'occupied'` / `'out-of-range'`), `kind` (the deploy waypoint's `action.kind`, `'outpost'`), `targetHex`
    (a fresh `{ q, r }` of the hex it could not deploy on, read before the snap), `craftId` + `craftClass`, and
    `retreatSystemId` + `retreatSystemName`. The system is `nearestHeldSystem` asked with the same arguments
    `retreatLanding` uses, so it names the system the craft is pulled toward. The name is its seed name, falling back
    to the id (the `ventureName` pattern). **No snapshot field:** `guilds[].events` already surfaces the row with
    `whenDay` (no `unlockDay`), and `attention.notices` counts it while unread. **One copy fix, flagged in the PR:**
    `targetHex` is the first NESTED payload value, and the one-level `{ ...e.payload }` copies in `createState` and
    the snapshot (`guilds[].events`, `attention.notices`) would have shared it with engine state. All three now go
    through one `cloneEventPayload` (`sim/events.js`, a `structuredClone`). The output is byte-identical, with no new
    field and no schema bump.
    **The tripwires** (`deploy-failed-event.test.js` +10, `events.test.js` +3): a retreat writes exactly one row, on
    the retreating guild only, with the full payload, for both causes, and the row and the flag agree on reason and
    tick. With a nearer second system held, the craft and the notice both go there; in the clamp case the craft
    parks AT the named system. Two heavies landing on one hex write one row, naming the one that retreated. A
    successful deploy, or a craft with no deploy action, writes nothing and leaves no `events` key. The row is
    identical across a mid-flight save/restore and a post-retreat round trip. It surfaces with `whenDay`, counts
    unread, is acknowledged idempotently, and ages out on both clocks like the other two types. `checkEventLog`
    accepts three types in one log and still trips on a shared id, a bad tick, `readTick < tick` and a near-miss
    type. The payload copy is deep. Each tripwire was shown to fire: a shallow copy fails 2 tests, dropping the
    write fails 7, and dropping the type from the vocabulary fails 11 (the existing retreat tests included).
    **A NO-OP on every galaxy that never retreats.** No existing test or golden changed; the one edited assertion
    is the vocabulary test, from "exactly two" to "exactly three" types. Proven directly too, running the same
    script against a clean worktree of the parent commit and against this change: a founded two-guild galaxy over
    301 ticks and a successful deploy over 401 ticks give the same state hash and the same snapshot hash at every
    tick, and neither carries an `events` key. A retreating deploy's state hash first differs on its arrival tick.
    With `events` / `eventSeq` stripped it is identical at every tick, so the event log is the only thing that
    moved. Sim 1,855 → **1,868 green**; tools **73** unchanged.
    **Deferred (not invented):** the CLIENT slice. That is the inbox row "Deployment failed — {Kind}", the pilot
    popup (eyebrow, voice, facts block) and Show on map. **Known gap until it lands:** the current client's notice
    renderer (`noticeTitle` / `noticeBody`, `client/game.html`) treats any type other than `venture_closed` as a
    licence lapse. So a `deploy_failed` row would show in the inbox as "Licence lapsed — Venture" with the lapse
    body. Ship this slice with the client slice, or accept that mislabel in between. *⤳ Closed: the client slice is
    BUILT 01-10-26, "the `deploy_failed` message — CLIENT" below.*
  - **client — the pre-deploy quote on the deploy map (CLIENT ONLY, `client/game.html`).** 🟢 *BUILT (01-10-26).*
    Closes the decision-checklist call "(1) No quote before DEPLOY" (ruled yes) and builds it to `territory-model.md`
    §5 "The deploy map", now revised to say so. Once a VALID target is selected, the Deploy Target row shows the
    engine's time and fuel cost for the leg, the same figures the route builder's Finalise view shows before Dispatch.
    **Reused, not rebuilt:** the route builder's `fetchQuote` (`POST /vehicle/quote`, the read-only `quoteDispatch`)
    is asked for the SAME single deploy waypoint DEPLOY sends. It reaches the map through a new bridge,
    `window.__fetchQuote`. `fetchQuote` sends anchors only (`anchorsOf`), and the engine's quote never reads an
    action, so the deploy leg is quoted as its bare flight: the same `dispatchRoute` leg the deploy dispatch burns
    for. The figures are formatted by `quoteFigures`, the Finalise view's Time / Cost cells pulled into one helper
    with unchanged output. It is shared as `window.__quoteFigures`, so both views read a quote one way (§18: the
    client formats, the engine computes). **The flow:** `refreshPlanState` (the hook every candidate change already
    runs) calls `requestDeployQuote`. That asks once per selection and records the ask on `PLAN.deployQuote = { target,
    quote }`, keyed to the candidate the way `openCandidateAction` keys its save. So an answer for a target since
    cancelled or changed is dropped, never shown on the wrong hex. `deployQuoteLines` lays it on the target row:
    "Quoting…" while the fetch is out, then "Time … · Cost … ¢". For a leg the engine cannot quote (`{ ok:false }`)
    it shows the engine's reason as the flagged line instead, as Finalise does. A refused hex asks nothing. Cancel
    and a fresh click drop the old quote beside the old `deployRefused`. **DEPLOY is not gated on it:** the quote is
    informational, and the engine re-checks and re-costs at dispatch.
    **A NO-OP for `sim/`:** no engine, snapshot, test or golden touched (`git diff` is `client/game.html` + docs).
    Sim **1,868 green** and tools **73 green**, both unchanged. Driven headless on a seated seed-42 server (heavies
    given kits by `grant-kit`), every check scripted to fail loudly:
    - a bare hex 5 out read "Quoting…" with DEPLOY enabled, then the engine's own "Time 18h 45m · Cost 5000 ¢";
    - exactly one request went out for it, the one leg, anchors only;
    - Cancel cleared the target and its quote, and a new target 6 out re-read "Quoting…" before its own quote;
    - a slow answer for a target cancelled in flight landed after the next target was quoted, and was dropped;
    - the home system was refused with no request sent;
    - DEPLOY went out with the one `deploy:outpost` waypoint, and the engine burned exactly the quoted 600 fuel units;
    - a craft no longer idle showed the engine's own `{ ok:false }` reason in place of figures;
    - DEPLOY clicked mid-quote still went out, and the late answer landed harmlessly;
    - the route builder's Finalise Time / Cost still read the engine's figures exactly;
    - no page errors.
    **Deferred (not invented):** re-quoting on a poll (asked once per selection, as Finalise asks once per route);
    an affordability cue (Finalise has none either, only its disabled Dispatch, and DEPLOY is not gated).
  - **the `deploy_failed` message — CLIENT (the inbox row, the pilot popup, Show on map; `client/game.html` only).**
    🟢 *BUILT (01-10-26).* Built to `docs/event-log.md` §10, no design change; AS-BUILT in §10. A small addition to
    the MESSAGES notice code that already exists. **Reused:** the inbox render (newest-first, unread dot, read
    dimming), `noticeTitle` / `noticeRowTitle`, `openNotice` / `__openNotice` and its read-on-open
    `acknowledgeEvent`, the `#notice-overlay` card and its styles, the facts renderer, `prettyGood`, `__flyTo`,
    and the Dispatch popup's `coordsOf` (shared through one new bridge, `window.__craftCoords`). **Added:** a
    `deploy_failed` branch in the two title builders ("Deployment failed — Outpost"), a 🚀 `NOTICE_ICON`,
    `deployKindLabel`, `DEPLOY_FAILED_BODY` (§10's two beats verbatim), `DEPLOY_FAILED_REASON`, a local
    `prettyClass` (the codebase's per-IIFE copy pattern), `deployFailedFacts`, and `showNoticeOnMap`. `openNotice`
    now sets the eyebrow, hero art, body paragraphs and SHOW ON MAP on every open: the pilot ("Fleet — Dispatch",
    `pilot.jpg`) for a `deploy_failed`, the uniform adviser for everything else. **Show on map** flies (zoom 9) to
    the live craft's hex, falling back to `payload.targetHex` when the craft is gone or flying. **One layout fix:**
    the pilot card's content overflows the fixed 600px card by about 60px, which had clipped the footer buttons off
    the card. `#notice-overlay .reel-text` gains `min-height:0`, so the body scrolls and the buttons stay. The
    venture / licence notices are untouched: their card is the same PNG bytes before and after.
    **A NO-OP for `sim/`:** no engine, snapshot, test or golden touched (`git diff` is `client/game.html` + docs).
    Sim **1,868 green** and tools **73 green**, both unchanged. Driven headless on a seated seed-42 server, with
    the notice produced by the engine itself: a heavy granted a kit was sent to `104,48@deploy:outpost`, the hex was
    occupied mid-flight, and on arrival it retreated to `104,51`, writing the `deploy_failed` row. A venture
    teardown wrote a `venture_closed` row beside it. Every check scripted to fail loudly:
    - the inbox showed "Deployment failed — Outpost" (🚀, unread) above "Venture closed — Titanium Mine";
    - the popup read "Fleet — Dispatch" over the pilot, with the title, the two beats as two paragraphs (verbatim),
      and the facts Heavy Transport · #01 / hex 104, 48 / Hex taken / BAR-1337 / Day 1;
    - SHOW ON MAP and DISMISS were both inside the card's visible bounds;
    - opening it stamped `readTick`, dropped it from `attention.notices`, and the row re-rendered read;
    - a venture notice opened next was back to "Syndicate Notice" + the adviser, with no SHOW ON MAP, and its card
      was byte-identical to the pre-change client's;
    - SHOW ON MAP closed the popup and the Guild Hall and flew to `(104, 51)` at zoom 9, the craft's current hex,
      not the target;
    - `__craftCoords` resolved a craft parked AT the home system to that system's hex;
    - with the craft removed, SHOW ON MAP fell back to the target `(104, 48)`;
    - no page errors.
    **Flagged, not ruled (decision checklist):** the `#` in the Craft fact, the card fit, and Show on map for a
    craft already flying again.
  - **asset-initiated slice 1 — the kit as a system-scoped idle asset (ENGINE + operator CLI, NO client).** 🟢 *BUILT
    (02-10-26).* Built to `territory-model.md` §5 "The deploy flow, REVISED — asset-initiated (RULED 02-10-26)" and
    `design.md` §4 "The undeployed Outpost kit is a system-scoped idle asset", no design change and no new number;
    AS-BUILT notes in both. **The model:** a kit is in exactly one of two representations — an idle ASSET of kind
    `'outpost'` in a system's inventory (`guild.assets`, made by `createAsset`, a `systemId`, never a venture), or the
    `outpost_kit` GOOD in a heavy's hold (what `deployCheck` / `deployKit` read — the deploy, the retreat and the
    `deploy_failed` notice are UNTOUCHED). **The vocabulary:** `'outpost'` is a KIT kind (`KIT_ASSET_KINDS` /
    `isKitAssetKind`, `sim/assets.js`, read off `DEPLOYABLE_KITS`), kept apart from the venture kinds — `ASSET_KINDS`
    stays `[factory, miner]` and `isAssetKind('outpost')` is false, so `establishVenture`, the Syndicate purchase and
    `grantAsset` all refuse a kit. `kindForKit` (`sim/resources.js`) is `kitGoodFor`'s inverse, off the same table.
    **The actions** (`sim/actions.js`, all journalled): **`grantKit { guildId, systemId, kind }`** — REPOINTED, it now
    mints one idle kit asset at any real system (the operator places freely, as `grantAsset` does), refusing an
    unknown guild, a system not on the seed, or a kind with no kit; **`loadKit { guildId, vehicleId, assetId }`** —
    names the kit, refused unless it is an idle kit in this guild's inventory and the carrier is this guild's heavy,
    idle, off any lane, with an empty hold, berthed at the kit's own system; the asset leaves the inventory and exactly
    one `outpost_kit` lands in the hold (tick-stamped on the craft); **`unloadKit { guildId, vehicleId }`** — refused
    unless the craft is idle, off any lane, carries exactly one kit and nothing else, and is berthed at a system its
    guild holds; the good leaves the hold and a fresh idle kit asset is minted there. The unload's rule and apply
    (`unloadKitCheck` / `kitIntoInventory`) take location and tick as arguments — the `deployCheck` / `deployKit`
    shape — so the Return fork's on-arrival unload can reuse them as a second trigger. **Ids never repeat:** a loaded
    kit LEAVES the inventory, so the live-max `nextAssetNumber` could reissue its id; kits number from a stored
    per-guild `kitAssetSerial` (`asset_<guild>_outpost_NN`, the `vehicleSerial` pattern, `design.md` §15.4),
    omitted when 0. **Invariants** (`checkAssetOccupancy`): `asset-kind-known` accepts a venture kind OR a kit kind;
    new `kit-asset-never-deployed` and `kit-asset-serial-monotonic`. **Snapshot:** unchanged — a kit is already an
    `assets` row `{ kind: 'outpost', deployedToVentureId: null }`, which is all `__myIdleAssets('outpost')` reads (the
    shape comment now says so). **The operator surface:** `POST /admin/guild/grant-kit` (renamed from
    `/admin/vehicle/grant-kit`, which now 404s — it no longer touches a vehicle), `POST /admin/vehicle/load-kit` and
    `POST /admin/vehicle/unload-kit`, mirroring the sibling endpoints; `tools/admin.js grant-kit --guild ID --system ID
    --kind outpost`, `load-kit --guild ID --id VEHICLE_ID --asset ASSET_ID`, `unload-kit --guild ID --id VEHICLE_ID`
    (each prints the guild's idle kits and the hold); `docs/cli-runbook.md` updated.
    **The tests moved to the new flow:** every test that granted a kit into a hold now grants into a system and loads
    it (`sim/tests/kit-fixtures.js` `kitAboard`); a test needing a laden heavy out on a hex places it there after the
    load (`placeCraft` — the stand-in for a 225-ticks-a-hex flight; the happy paths still fly for real).
    `deploy-asset.test.js`'s seven grant-into-a-hold tests retired — each ruling they pinned (heavy-only,
    one-at-a-time, idle only, never on a lane, the unknown guild / kind) is now a `grantKit` / `loadKit` gate in the new
    `kit-asset.test.js`. **Tripwires** (`kit-asset.test.js` +23): the vocabulary; the grant and its gates; the snapshot
    row and the client's filter; establish / buy / grantAsset refusing a kit; load and unload, every refusal; the round
    trip and no id reused; KIT CONSERVATION (idle kits + kits aboard unchanged by load / unload, −1 only on deploy —
    `assertKitsMoved`, which throws with the tick and both counts); determinism live and across a journalled
    save/restore; a founded guild's machines and venture running 30 ticks clean with kits beside them; and the new
    invariant rules firing. Shown to fire: numbering kits from the live max fails 7, a load that forgets to remove the
    asset fails 10, dropping the same-system gate / the held-system check / the never-deployed rule fails 1 each, and
    an invariant that rejects kit kinds fails 7. Plus `deploy-on-arrival.test.js` +1: a clamped retreat parks the heavy
    AT home, and `unloadKit` drops its kit back into home's inventory.
    **A NO-OP on a galaxy that mints no kit:** no existing golden changed (none of the 25 golden-bearing test files is
    touched; persist / determinism / galactic-supply all green). Proven directly too: one kit-free script (two founded
    guilds, a venture, an Outpost, a heavy's dispatch and a light's docked route) run against a clean worktree of the
    parent commit and against this change gives the same state hash AND snapshot hash at every one of 400 ticks.
    Sim 1,868 → **1,886 green** (+23 kit-asset, −7 retired, +1 deploy-on-arrival, +1 server); tools **73** green,
    the same count (three tests rewritten for the repointed `grant-kit` and the new bodies). Driven headless on a
    seated seed-42 server through `tools/admin.js`: grant → `asset_seat_demo_outpost_01` idle in `sys_0006` (assets
    25 → 26); load onto an empty heavy there → inventory 26 → 25, hold 6,000,000 / 6,000,000; dispatch
    `101,55@deploy:outpost` + 675 ticks → `outpost_seat_demo_01` on `101,55`, the heavy parked on it, hold empty; a
    second heavy granted `_02`, loaded, unloaded → a fresh idle `_03` in `sys_0006`, hold empty; a load onto the heavy
    parked at the Outpost and an unload of an empty heavy were both refused with the engine's reason; a `kill -9`
    restart replayed the journal to a leaf-identical snapshot.
    **Deferred (not invented):** the client (the idle-outpost Deploy button, the outpost-subject popup and carrier
    dropdown, the planner reuse, the message's Redeploy / Return forks) *(⤳ the Deploy button and the popup with its carrier
    dropdown are BUILT 02-10-26, "asset-initiated client slice 2a" below; the planner reuse is slice 2b, BUILT 02-10-26 below)*; the route-arrival unload (the Return fork's
    auto-appended unload action); the real kit sources; storing a kit AT an Outpost; the other kinds. **Two calls on the
    decision checklist** ("Asset-initiated slice 1 — two calls"): a standalone unload leaves a retreated craft's
    `deployFailed` set (only a dispatch clears it, as ruled); and an idle kit asset carries no tick of its own.
    *(⤳ The first is RULED 02-10-26 — the unload clears it — and BUILT, "engine-integrity tidy" below.)*
  - **engine-integrity tidy — two independent fixes (ENGINE + tests, NO client).** 🟢 *BUILT (02-10-26).* No new
    number, no client, and the deploy / retreat / `loadKit` / founding / the asset id scheme are untouched.
    **Fix A — `unloadKit` clears `deployFailed`** (closes the decision-checklist call "a standalone unload leaves
    `deployFailed` set", RULED: the unload clears it). One line in `kitIntoInventory`, the ONE unload apply (so the
    Return fork's on-arrival unload inherits it): once a retreated kit is back in an inventory the failed deploy is
    over, so the flag would only be stale on an empty, idle craft. The flag is omit-when-absent, so a craft that never
    failed is unchanged. The retreat still sets it and the next dispatch still clears it; this adds "…or unloading the
    kit". `territory-model.md` §5 and `design.md` §4 annotated. **Fix B — miner / factory ids never repeat across the
    operator remove levers** (`design.md` §15.4 "Ids never repeat"; AS-BUILT in `design.md` §4 beside the kit-serial
    block). `nextAssetNumber` is "highest LIVE number + 1", safe in play (nothing deletes a machine) but not under the
    operator levers `removeAsset` / `removeVenture { asset: 'remove' }`, which do: deleting the top miner let the next
    grant or build reissue its id. Both levers now delete through ONE helper, `deleteAsset` (`sim/actions.js`), which
    first records the deleted number in a per-kind **removed high-water**, `guild.removedAssetHighWater = { [kind]: NN }`
    (omit-when-empty, `createGuild`); `nextAssetNumber` (`sim/assets.js`) returns `max(highest live, high-water) + 1`.
    The mark only climbs; a kit is not recorded (kits number from `kitAssetSerial`). Founding is untouched; `grantAsset`,
    the Dockyard and the Syndicate delivery all mint through `nextAssetNumber`. **Invariants** (`checkAssetOccupancy`):
    `removed-asset-high-water-valid` (each key a venture kind, each value a whole number ≥ 1) and
    `removed-asset-number-not-reissued` (no live asset carries its kind's recorded number). The suggested mirror of the
    kit rule, "the mark ≥ every live number", was NOT used: it is false in a legal state (delete miner 03 while 04..15
    live → mark 3). **Tripwires:** `asset-id-high-water.test.js` (new, +14) — each remover (idle, occupied detach /
    close, and the venture-side remove) then a grant → `_16`, never the deleted `_15`; a Dockyard build after a delete;
    a non-top delete does not inflate the next number; the mark never drops, even with no miner left alive; kinds kept
    apart; a kit not recorded; determinism run twice, by journalled replay, and from a state saved WITH a mark; both
    invariant rules firing; the no-op shape. `deploy-on-arrival.test.js`'s retreat-then-unload test now asserts the flag
    is gone (it pinned the old behaviour); `kit-asset.test.js` +1 (a craft that never failed is unchanged by an unload).
    Shown to fire: without Fix A's line the deploy test fails; without the high-water read 9 of the 14 new tests fail
    (the ticking-invariants one through `removed-asset-number-not-reissued`).
    **A NO-OP on every existing golden:** no golden scenario uses either remove lever, the high-water is omitted until
    one deletes something, and `deployFailed` is omit-when-absent, so none of the 32 golden-bearing test files is
    touched and all pass. And directly: one delete-free script exercising every changed path (two grants, a venture
    removed with `keep`, a Dockyard miner build, a kit granted / loaded / unloaded) gives the same state hash as a clean
    worktree of the parent commit at all 819 steps (11 actions + 800 ticks). Sim 1,886 → **1,901 green** (+14
    asset-id-high-water, +1 kit-asset); tools **73** green (unchanged).
  - **asset-initiated client slice 2a — the entry + carrier picker + the `loadKit`-then-dispatch commit (CLIENT ONLY,
    `client/game.html`).** 🟢 *BUILT (02-10-26).* Built to `territory-model.md` §5 "The deploy flow, REVISED", no
    design change and no new number; AS-BUILT in §5. A deployment now starts from the outpost: OPERATIONS → IDLE → an
    idle outpost's **Deploy** → the **Deploy Outpost** popup → pick a carrier → **Plan Route** → the deploy map for that
    carrier → the on-tile **DEPLOY**, which sends `loadKit` and then, only if the load is accepted, the dispatch.
    **Reused as is:** the IDLE panel render and its delegated click handler; the Dispatch / Dock button style; the
    Dispatch popup's chrome (`.est` / `.est-head` / `.eyebrow` / `.dp-sum` rows / `.dp-actions` / `.dp-btn`, the
    side-hero art and caption) and the establish popup's `select.est-select`, shared by naming `#deploy-overlay` beside
    `#dispatch-overlay` / `#est-overlay` on each rule they use, not copied; the whole single-leg deploy map
    (`startPlanning`'s deploy variant, `deployTarget` / `deployAction` / `deployRefusal`, the ring, the quote, the
    chip, arrow-key pan); `__sendAction`, `__dispatchDeploy`, `__player`, `__snapshot`, `__systemName`.
    **Added:** the Deploy button on an `'outpost'` row (`machineHtml`, one sizing rule); the `#deploy-overlay` markup
    (`kd*` ids); the `deploy-kit-wire` IIFE (`openKitDeploy` / `__openKitDeploy`, `carriersFor`, `renderCarriers`,
    `onPlanRoute`, `closeKitDeploy`); a sixth `startPlanning` argument, carried as `PLAN.deployKitAssetId`, with
    `__planDeploy(vehicle, kind, kitAssetId)`; and in `confirmDeploy` the load step plus `loadDeployKit`. **Removed:**
    `deployKindOf`, the Dispatch popup's Deploy button (`dpDeployBtn`) and `onDeploy` (the heavy-first entry). The
    carrier dropdown filters exactly as `loadKit` gates: a heavy transport, idle, off any lane, with an empty hold
    (published as `{}`), berthed at the kit's system. That is guidance; `loadKit` is the authority. **Known gap until
    slice 3:** a heavy holding a kit with no deploy under way has no client deploy path. That is a heavy left by a
    retreat, by a dispatch refused after its load, or by an operator `load-kit`. It is operator-recoverable
    (`unload-kit`, then Deploy from the idle row).
    **A NO-OP for `sim/`:** no engine, snapshot, test or golden touched (`git diff` is `client/game.html` + docs). Sim
    **1,901 green** and tools **73 green**, both unchanged (the `game.html` served-page tripwires included). Driven
    headless on a seated seed-42 server: a kit granted at home (`sys_0006`), and three craft that must not be offered:
    a heavy at home with titanium aboard, a medium at home, and an empty heavy at another system. Every check was
    scripted to fail loudly, and every `POST /action` body was recorded:
    - only the outpost row carried Deploy (none of the 23 idle miner / factory rows);
    - the popup read "Deploy Outpost" / "Outpost Kit · #01" / Outpost · BAR-1337 · Yes, with the dropdown "No
      Available Transport" (disabled) and Plan Route disabled;
    - an empty heavy spawned at home was the only option ("Heavy Transport · #04"), and picking it enabled Plan Route;
      ✕ and Escape each closed the popup;
    - Plan Route opened the deploy map ("Deploying Outpost · Heavy Transport") with nothing sent, the kit still in
      inventory and the hold empty;
    - a bare hex `(107, 52)` read "deploy · outpost" and the engine's "Time 11h 15m · Cost 3000 ¢";
    - Cancel then left the kit in inventory, with no `loadKit` sent;
    - DEPLOY after the carrier took on cargo sent ONLY `loadKit` (guild / carrier / kit), showed the engine's "has
      cargo aboard" reason, and left the kit in inventory;
    - DEPLOY with the guild's fuel at 0 sent `loadKit` THEN `dispatchRouteWithActions`: the load landed (kit aboard,
      inventory empty), the dispatch was refused for fuel, and nothing flew;
    - DEPLOY again with fuel restored sent ONLY the dispatch (no second load), one `{ type: 'deploy', kind: 'outpost' }`
      waypoint on `(107, 52)`;
    - by tick 700 `outpost_seat_demo_01` stood on `(107, 52)`, the heavy's hold was empty and its `dockStatus` was
      `parked` on it, and IDLE no longer listed the kit;
    - a heavy loaded by the operator lever showed only Maintenance / Plan Route in its Dispatch popup, with "Outpost Kit"
      in its manifest;
    - the Dock editor still titled and closed its own craft (the first run caught the new popup reusing the Dock
      editor's `dk*` ids, renamed `kd*` before landing);
    - no page errors.
    **Deferred (not invented):** the multi-leg planner and the commit in the popup (slice 2b) *(⤳ BUILT 02-10-26, next)*;
    the message's Redeploy / Return (slice 3). **Two calls on the decision checklist** ("Asset-initiated client slice 2a —
    two calls"): what the Ready row reads, and whether DEPLOY should hold the load when the leg is not affordable. *(⤳ The
    first is RULED 02-10-26 — drop the row — and BUILT in slice 2b; the second is half-ruled, see the checklist.)*
  - **asset-initiated client slice 2b — the multi-leg planner + the commit in the popup (CLIENT ONLY,
    `client/game.html`).** 🟢 *BUILT (02-10-26).* Built to `territory-model.md` §5 "The deploy flow, REVISED" ("Plan" and
    "Commit", Fork 2), no design change and no new number; AS-BUILT in §5. A deployment now runs: OPERATIONS → IDLE → an
    idle outpost's **Deploy** → the **Deploy Outpost** popup → pick a carrier → **Plan Route** → the deploy map, now the
    full route planner (one stop or many) → **Finalise** → back in the popup: the Planned Route and its Time / Cost →
    **Deploy**, which sends `loadKit` and then, only if the load is accepted, the dispatch.
    **Reused as is:** the planner — `startPlanning`, the Add → Confirm chip (`renderPlanChip` / `confirmCandidate`), the
    waypoint list with reorder / remove (`renderPlanList`), `#planFinalise` / `finalisePlanning`, `anyDeadLeg`,
    `refreshPlanState`; the deploy map's range ring (`deployReach` / `drawDeployRing`), `deployRefusal`, `deployAction`,
    `DEPLOY_MAP_ZOOM` centring and arrow-key pan; the quote (`fetchQuote` / `quoteFigures`); the Dispatch popup's
    post-finalise markup (`.dp-route` / `.wp-list` / `.wp-row` / `.tc-box` / `.dp-refuse` / `.dp-actions`), shared by
    naming `#deploy-overlay` beside `#dispatch-overlay` on each rule it uses, not copied; the send path `__dispatchDeploy`
    (`dispatchActionFor` → `dispatchRouteWithActions`, `wireWaypoints`); `__routeActionSummary`,
    `__routeChecks.hereNote`, `__sendAction`, `__player`; slice 2a's `openKitDeploy` / `carriersFor` / `renderCarriers`.
    **Changed:** `deployTarget()` is now the route's LAST stop when the kit may deploy there (it was the selected
    candidate). One Finalise gate, `canFinalise()`, is shared by the button and `finalisePlanning`: the old rule, plus a
    legal last stop on the deploy map. On the deploy map `finalisePlanning` hands the route to the popup. The chip
    offers no Action in deploy mode. The map's quote is keyed to the route (`routeKey`), not a candidate. A map click and
    the chip's Cancel are back to the route builder's own (the chip only). `__planDeploy(vehicle, kind, waypoints)`
    takes a route (it took the kit id), so Edit Route can hand one back. The popup's Plan Route only hides it, as the
    Dispatch popup's does, so it keeps the kit for Finalise. Escape closes the popup only while it is shown.
    **Added:** `deployWaypoints` (the one place the deploy action is added: on the last stop), `deployRow` (the last
    row's lines), `routeKey`, `canFinalise`; in the popup, `renderPrePlan` / `renderPostFinalise` (the Dispatch popup's
    two states), `kitDeployFinalise` (`__kitDeployFinalise`), `onEditRoute`, `onDeploy` with its `loadKit`, the `aboard`
    flag, and a Carrier row in the summary (post-finalise); `__anchorLabel` (the planner's `anchorLabel`, so the popup
    names stops the way the map does).
    **Removed:** `fillDeployChip`, `confirmDeploy`, `loadDeployKit`, the click lock on a selected target, `PLAN`'s
    `deployKitAssetId` / `deploySending` / `deployRefused`, the CSS rule hiding Finalise in deploy mode (Load Route stays
    hidden), the "Deploy Target" list retitle, and the popup's Ready row (slice 2a's checklist call (1), ruled).
    **A NO-OP for `sim/`:** no engine, snapshot, test or golden touched (`git diff` is `client/game.html` + docs, and
    `git diff -- sim tools` is empty). Sim **1,901 green** and tools **73 green**, both unchanged (the `game.html`
    served-page tripwires included). Driven headless on a seated seed-42 server (home `sys_0006` at `104,55`): a kit
    granted at home and an empty heavy spawned there. 59 scripted checks, each failing loudly, with every `POST /action`
    body recorded:
    - the popup's summary read Kind / Stored at, with no Ready row;
    - Plan Route opened the deploy map with Finalise shown (disabled, no stop yet), Load Route hidden, and nothing sent;
    - the chip on the held home system offered Add, then Confirm / Cancel, with no Action;
    - one stop `(109, 54)` carried "deploy · outpost" and enabled Finalise; a second stop `(106, 49)` took the deploy
      action from it, and the route's quote showed under it ("Time 2d 00h · Cost 13000 ¢");
    - a third stop `(115, 55)`, 11 hexes out, flagged "can't deploy here — outside the deploy range" and disabled Finalise,
      as did the home system as the last stop ("not a bare hex"); removing the stop re-enabled it;
    - Escape on the map left planning running;
    - Finalise re-opened the popup with Origin / `(109, 54)` / `(106, 49)` + "deploy · outpost", the engine's Time / Cost,
      a Carrier row and Edit Route / Deploy, with nothing sent and the kit in inventory;
    - Edit Route re-opened the map with the route kept, and closing the popup left no plan behind; neither sent anything,
      and the kit stayed in inventory;
    - Deploy with 10 titanium in the carrier sent ONLY `loadKit` (guild / carrier / kit), showed the engine's "has cargo
      aboard" reason without claiming the kit aboard, and left the kit in inventory;
    - Deploy with the guild's fuel at 0 sent `loadKit` THEN `dispatchRouteWithActions`: the load landed (kit aboard,
      inventory empty, craft idle), and the refusal ended "— the kit is now aboard Heavy Transport · #01.";
    - Deploy again with fuel restored sent ONLY the dispatch: two waypoints, `{ type: 'deploy', kind: 'outpost' }` on the
      last only. The popup closed and the heavy flew; in flight its route cursor went stop 1 → stop 2;
    - on landing `outpost_seat_demo_01` stood on `(106, 49)`, the heavy was idle there with an empty hold and
      `dockStatus` parked on that Outpost, and no idle kit was left;
    - a single-stop route (a second kit and heavy, stop `(101, 55)`) sent `loadKit` then one deploy waypoint, and placed
      a second Outpost there;
    - the ordinary planner was unchanged: its chip on the home system offered Add + Action, and its Finalise opened the
      Dispatch popup (Save Route and the launch picker intact), sending nothing;
    - no page errors.
    **Deferred (not invented):** the message's Redeploy / Return (slice 3). **Calls on the decision checklist:** slice 2a's
    call (2) is half-ruled and still open for the popup's Deploy (should it hold the load on an unaffordable or
    unquotable route?); and "Asset-initiated client slice 2b — two calls": the deploy map's Cancel leaving to the plain
    map, and no Load Route on the deploy map.
- **2.2 — Territory: claims as a live lever.** A claim action + contest resolution (first-valid-wins
  is already stubbed in the engine); expansion beyond the home system; the claim raises the GP/RP bar
  (already modelled). *Precondition for tolls, exploration, espionage.* **The claim action's SHAPE is
  now RULED - design.md §2 "The Prefecture - the territorial claim anchor" (29-09-26): one
  Prefecture, on one settlement slot, claims the whole system and every node in it; exclusive against
  other guilds' claims and their unleased deployment, with leasing the one contractual exception; the
  home system exempt, so a guild can never be evicted from its homeworld; losing a Prefecture evicts
  the guild's machines in that system into orbital limbo.** NOT BUILT, and **sequenced behind the
  cross-system asset ferry** (design.md §4, deferred): a Prefecture kit is transported and deployed
  like any other asset, so there is no claim action until an asset can move between systems. Three
  questions are open and block the build - design.md §19 **#67** (what happens to an evicted system's
  GOODS), **#68** (the Tier-4 bill, and the two orphan Tier-3 modules it would claim), **#69** (how a
  Prefecture is removed by anyone but its owner - the design has no hostile-destruction mechanic). **The spatial control layer + the deploy pipeline are now designed — `docs/territory-model.md` (29-09-26):** the 7-hex footprint with first-settled seniority over overlaps, semi-controlled detection corridors, the two-lane cross-system deploy pipeline (the ferry that unblocks the Prefecture), and the starter ≥ 3 spacing rule; the open `[FIRST-CUT]` numbers are on the checklist below.
- **2.3 — Transport (guild tier) + tolls.** Routes (construction, rules, location/route bonuses),
  payload, travel time; toll gates (built at 2.1, placed on territory from 2.2), toll rules; the
  Syndicate transport contract (the Syndicate leases guild transports back — recall-time model:
  recall any time at no fee, but it takes time to become available again); maintenance wear on
  contract → returned at 5% → guild repairs. *Open: recall-time vs renegotiation window (leaning
  recall); the 5% return threshold; the route-bonus mechanic.*
- **2.4 — Investment & the financial layer.** Invest in other guilds' ventures (Guild Hall →
  Finance); a per-tick share of the venture's commitment sale; an engine-derived share price
  (contract length × resource price × expected output ÷ 100, re-derived each tick as the price
  moves); an RP boost modifier (total-capital : invested-capital ratio); **forced lease at −300 RP**
  offered to the largest shareholder (may decline, no penalty). *Open: shares non-tradable (leaning
  yes); the share-price formula specifics; the RP-band reconciliation — forced-lease −300 vs
  forced-closure −500 vs the renegotiation `atRisk` band, and whether forced-lease triggers on a
  continuous RP threshold or at window-end; "forced lease" is a NEW lifecycle ending (venture
  transferred, not closed) that must slot into the built accept/reject/timeout/teardown/closure set.*
- **2.5 — Exploration & espionage.** Layered fog-of-war: Layer 1 — everyone sees system position +
  controlling guild (1A controlled: planet count + archetypes, not nodes; 1B uncontrolled: planet
  count only); Layer 2 — a Deep Scan Array (built at 2.1) reveals archetypes then nodes of
  non-controlled systems over time within range; Layer 3 — spycraft (built at 2.1) inspects a
  specific enemy-controlled planet. *Open: scan durations + array range; espionage cost/risk.*
- **2.6 — Droids.** The licence payoff (the reason a 0%-commitment venture still wants a licence) —
  a production boost, built at 2.1. *Open: the boost mechanic + numbers.*
- **2.7 — Lightweight bots + a first storyteller nudge.** Rule-based economic opponents that use the
  levers above (claim, build, toll, invest) enough to create tension, plus enough of a storyteller to
  lean on whoever's grown comfortable. *Full bot tiers, disposition, pirates and the narrative layer
  stay in Phase 6.*
- **Threaded cosmetic:** the Syndicate Waystation panel is currently a stock production console —
  it needs its own actions.

**Exit:** a solo session against bots produces a squeeze the player can cause or resist, and an
honest written answer to "does this shape of game feel right to play." (This is Phase 0's open
question #31, finally answerable with territory levers in.)

---

## Phase 3 — Persist & harden for the long game ⬜

The dev rig already ticks and persists (per-tick snapshot + action journal + state volume,
`docs/persistence-model.md`). This phase makes it durable: crash-safe ticking (restart knows its
tick, never double-applies/skips), PostgreSQL for the §15.4 entities (transactions as invariant 4),
the in-memory → persisted migration, server-side invariant checks halting on violation. **Goal:**
close the tab, come back later, something happened.

---

## Phase 4 — Human multiplayer ⬜

Accounts / login / sessions; concurrent intake through the same validate-as-it-arrives discipline
under real concurrency; the Syndicate Exchange **player order book** (asks/bids, divergence from the
Syndicate value line); partial-transparency enforced server-side; the ~200-actor adversarial squeeze
test (design.md §15.7). Also the world-adapter swap (graph → hex galaxy), proven not to touch
economic logic by the Phase-2 boundary test. **Goal:** multiple humans share one galaxy and betrayal
becomes possible.

---

## Phase 5 — The political layer ⬜

Council votes (influence-weighted, real time windows); legality disputes over recorded defiance;
fines (conservation-safe, paid to victims); forced-compliance rulings with decaying precedent;
vote-weight integrity (invariant 6). **Goal:** a real dispute resolved by a real vote someone
lobbied for.

---

## Phase 6 — Full bots, storyteller & the narrative layer ⬜

Bot tiers 1–3 + finalised disposition feeding vote behaviour; pirate bots (escalation, black
market); the storyteller (concentration / Gini / stagnation signals, surface-area targeting,
~70/30 telegraphed/sudden); events that redistribute opportunity not just delete value; and the
narrative layer — Rebellion, cover missions, intel/evidence, the Ancients (#16–21). **Goal:** a
server left alone for a week produces a story worth retelling.

---

## Phase 7 — Self-hosting, config, onboarding, polish ⬜

Server config surface (severities, windows, tick rate, bot density, storyteller presets); live
onboarding (reserved starters, the Titanium starter quest); the many-clocks legibility pass;
self-host deployment + seed shareability. **Goal:** someone who isn't the developer runs a galaxy,
and someone who's never read the design doc learns by playing.

---

## Track G — Galaxy generation (parallel) 🔶

Generator complete: rings (inner/middle/outer, ×4/×1/×0.25 rare-tier gradient), nine archetypes,
resource nodes, settlement slots, starter tagging, rare-tier repair, validation, determinism;
`seed_viewer.html` renders it. **Required before the Phase-4 hex-map swap.** Open: which rare tier a
repaired planet becomes; node richness/yield; `Planet.stats` fate (#33).

---

## Decision checklist (open)

**Phase 2 — new, from the design notes (need rulings before their slice becomes a build prompt):**
- **Territory & deployment `[FIRST-CUT]` numbers (29-09-26, `docs/territory-model.md`)** — need rulings before the deploy/claim build: the space-asset **deploy ranges** (outpost 10 / toll gate 10 / deep scan 5 hexes), the **semi-control aura radii** (system 5 / outpost 3 / gate·scan 2), the **starter minimum separation** (3 hexes = 2×claimRadius + 1), and the **arrival-revalidation** failure rule (a kit arriving to an illegal target stays aboard and the craft idles — confirm). Squatting enforcement (detection / penalty / report-bounty) is a ruled *direction* deferred to 2.5 / Phase-6, not a number. **⤳ 29-09-26 — the OUTPOST deploy range (10) is RULED as the `[FIRST-CUT]`** and recorded in `phase-1-tuning.md` "Territory & deployment" (`OUTPOST_DEPLOY_RANGE`, built with the 2.2 deploy pipeline slice 1). **⤳ 30-09-26 — the arrival-revalidation rule is RULED and CLOSED:** a failed on-arrival deploy RETREATS the craft `DEPLOY_RETREAT_HEXES` (`[FIRST-CUT]` 3, recorded in `phase-1-tuning.md`) toward the nearest held system, clamped at that system, kit aboard, flagged `deployFailed` (`territory-model.md` §5; built with the deploy pipeline slice 2). **Still open:** the toll-gate / deep-scan ranges, the aura radii, the starter separation; **the off-lattice retreat landing** — near the rim the 3-hex step can land just outside the galaxy (9 system / in-range-hex pairs on the live seed); slice 2 builds it PROVISIONALLY as "step on along the same line to the first on-lattice hex (at worst the system)" — confirm or rule otherwise; and refining the retreat landing to avoid rival / contested space (with the spatial control layer).
- **The deploy map: two client calls (01-10-26, 2.2 deploy pipeline client slice 2, `territory-model.md` §5)**, built
  one way and flagged rather than ruled. **(1) No quote before DEPLOY.** ~~The ruling makes the chip's DEPLOY the
  finalise, so the deploy map sends the leg without ever showing the engine's time / fuel / credit quote. The route
  builder shows that quote (`POST /vehicle/quote`) in the Dispatch popup's Finalise view before Dispatch. Today the
  player first sees a deploy's fuel figure only if the engine refuses for fuel ("route burns 400 fuel units up
  front but the guild holds 0"). Should the quote show once a hex is picked (e.g. on the Deploy Target row), before
  DEPLOY?~~ **⤳ 01-10-26 — RULED yes, BUILT and CLOSED:** once a valid hex is picked, the Deploy Target row shows the
  engine's time / fuel quote for the leg (the route builder's `fetchQuote` + the Finalise view's formatting),
  informational only, so DEPLOY does not wait on it (2.2 deploy pipeline, "the pre-deploy quote"; `territory-model.md`
  §5). **(2) The arrow-key pan step** — still open — is built at **120 screen px per press** (`PAN_STEP_PX`, both planning
  modes). It is a presentation default, not a game number; confirm or retune.
- **The `deploy_failed` message: three client calls (01-10-26, 2.2 deploy pipeline, `event-log.md` §10 client
  AS-BUILT)**, built one way and flagged rather than ruled. **(1) The Craft fact** reads "Heavy Transport · #01",
  the name the Dispatch popup and Outpost Manager already give a craft; §10 writes `craftClass · NN`, with no `#`.
  Confirm, or drop the `#` here only. **(2) The card fit.** The pilot's two beats + five facts are about 60px taller
  than the notice card's fixed `min(80vh, 600px)`, so the body scrolls and the last fact (`Failed`) sits just below
  the fold. Accept, or rule a taller card for this notice. **(3) Show on map for a craft flying again.** §10 rules
  the craft's current hex, falling back to `targetHex` "if the craft is gone". A craft the player has already
  re-dispatched has no hex, so it is built to fall back to `targetHex` too. Confirm, or rule another target (e.g.
  its destination).
- **Asset-initiated slice 1 — two calls (02-10-26, 2.2 deploy pipeline, the kit as an idle asset; `design.md` §4
  AS-BUILT)**, built the conservative way and flagged rather than ruled. **(1) A standalone unload leaves
  `deployFailed` set.** ~~The flag is ruled "cleared by the next dispatch", and an unload is not a dispatch, so a heavy
  that retreated AT a held system and then unloads its kit by hand keeps `deployFailed` until it next flies. The Return
  fork (a dispatch with an unload appended) clears it anyway. Confirm, or rule that `unloadKit` clears it too (it is
  one line in `kitIntoInventory`).~~ **⤳ 02-10-26 — RULED: `unloadKit` clears it too. BUILT and CLOSED** (the one line
  in `kitIntoInventory`; 2.2 deploy pipeline, "engine-integrity tidy"). **(2) An idle kit asset carries no tick of its own.** `createAsset` deliberately
  has no `updatedAtTick` / `createdAtTick` (its comment defers a stamp to the maintenance slice, the first thing that
  mutates an asset), so `grantKit` — like `grantAsset`, the Dockyard and the Syndicate delivery — records its tick only
  in the journal; `loadKit` / `unloadKit` stamp the craft. Confirm, or rule a `createdAtTick` on kit assets (or on all
  assets).
- **Asset-initiated client slice 2a — two calls (02-10-26, 2.2 deploy pipeline, `territory-model.md` §5 AS-BUILT)**, built
  one way and flagged rather than ruled. **(1) The Ready row.** ~~The Deploy Outpost popup's summary is Kind / Stored at /
  Ready. An idle kit carries no tick or status of its own (call (2) of slice 1, above), and the popup opens only for a
  kit the engine reports idle, so Ready reads a constant "Yes". Confirm, or rule what Ready should say (or drop it).~~
  **⤳ 02-10-26 — RULED: drop it. BUILT and CLOSED** (2.2 deploy pipeline, "asset-initiated client slice 2b").
  **(2) A dispatch refused after the load.** The ruled order loads first. A dispatch the engine then refuses leaves the
  heavy holding the kit. On the live seed that means a guild that cannot cover the leg's fuel. The map stays open, and
  a retry there is the plain dispatch. But leaving the map strands the kit aboard with no client path until slice 3
  (operator `unload-kit` recovers it). The pre-deploy quote already says when the guild cannot afford the leg. Should
  DEPLOY hold the load when the quote says so? DEPLOY is ruled not to wait on the quote today. And should the refusal
  also say the kit is now aboard? Built as neither: the engine's reason only. **⤳ 02-10-26 — half RULED:** the refusal
  now says the kit is aboard ("… — the kit is now aboard Heavy Transport · #01."), BUILT in slice 2b. **Still open:**
  the commit is now the Deploy Outpost popup's **Deploy** (slice 2b), which shows the route's Time / Cost above it.
  Should Deploy hold the load when that quote says the guild can't afford the route (`affordable: false`), or when the
  engine can't quote it (`ok: false`)? The Dispatch popup disables its Dispatch in both cases. Deploy is built not to
  wait on the quote, as ruled for the map's DEPLOY; an `ok: false` quote's reason does show under the route.
- **Asset-initiated client slice 2b — two calls (02-10-26, 2.2 deploy pipeline, `territory-model.md` §5 AS-BUILT)**, built
  one way and flagged rather than ruled. **(1) The deploy map's Cancel** leaves to the plain map, as the route builder's
  Cancel does. The kit stays in inventory, and the player re-opens the Deploy Outpost popup from IDLE (it starts
  pre-plan). Confirm, or rule that Cancel returns to the popup (pre-plan, or post-finalise when the map was opened by
  Edit Route). **(2) No Load Route on the deploy map.** It stays hidden. A saved lane's stops carry dock actions, which a
  deploy route cannot, and loading one re-plans as an ordinary route. Confirm, or rule that a saved route may seed a
  deploy route (its actions dropped, the deploy added to its last stop).
- **Split the oversized engine files — WHEN? (02-10-26, flagged by the 2.2 deploy pipeline engine-integrity tidy.)**
  `sim/actions.js` (5,258 lines) and `sim/server.js` (1,530) are far past a readable size for a codebase the human
  reads line by line; `sim/invariants.js` (2,386), `sim/snapshot.js` (2,120) and `sim/tick.js` (1,771) are also large.
  A future refactor should split them by concern — e.g. `actions.js` by action family (operator levers, ventures /
  licences, transport and routes, the deploy pipeline), each family keeping its validate and apply side by side, and
  `server.js` by route group. It is a pure move (no behaviour change, every golden byte-identical, the whole suite
  green before and after), so its risk is in the seams, not the logic. **Not done** — logged for a ruling on
  **when** (e.g. between slices, or at the Phase 3 hardening). *(⤳ 02-10-26, flagged by asset-initiated client slice
  2a: `client/game.html` belongs in the same question. It is 13,243 lines with 16 inline scripts, and the slice added
  about 180. The same pure move would split it, e.g. one file per IIFE. Several sim tests read `game.html` as a
  served-page tripwire, so they would follow the moved code.)* *(⤳ 02-10-26, asset-initiated client slice 2b: 13,343
  lines now, +100 net — it retired the single-leg commit as it added the popup's post-finalise view.)*

- **Asset-presence vs. production** — *surfaced 16-09-26 by the operator adjust levers
  (`docs/operator-adjust.md` §3.5 AS-BUILT).* Production is currently **asset-blind** — a venture
  produces from its own `productionRate`, and "occupying an asset changes no game number" (design.md
  §4). So `removeAsset 'detach'`, which the ruling calls "dormant/unpowered," leaves a venture that
  keeps producing at its rate. Should a venture with no asset (`assetId == null`) produce **nothing**
  (detach = unpowered), and if so does the maintenance slice's condition→output curve subsume it? This
  is a real coupling that would move the whole body of asset-less-producing-venture tests; flagged, not
  guessed. Invariant-safety is unaffected either way (a detached venture is invariant-legal and the
  tick is null-safe).

- **Owned transports + missions** — *surfaced 16-09-26 by the transport-ops thread; confirmed
  design intent, not yet designed.* Guilds building/buying their own transports (the entity
  `guild.vehicles` exists, empty) and flying them on missions — the guild transport tier of 2.3.
  Open design: its **seam with the cargo-space Syndicate hauler** (one shared cargo/volume/burn model
  vs a distinct guild-craft model), and where owning-and-flying sits against 2.3's routes / tolls /
  lease-back.

- **Guild-vehicle capacity is not published to the client** — *surfaced 19-09-26 by the b2b-2 route-planner
  slice.* The engine holds each craft's `capacity` (`VEHICLE_SPECS`, `sim/vehicles.js`), but neither the snapshot
  vehicle row nor any catalog block surfaces it, and the b2b-2 slice was CLIENT-ONLY (no `sim` change). So the
  Dispatch popup's Onboard Manifest placeholder shows its shape ("Hold empty · 0 / — capacity") rather than a
  real capacity — the client refuses to type a game number the engine hasn't published (§18). The cargo slice
  needs this number, so it (or a small snapshot addition beside `goodVolumes`/`haulerTiers`) should surface
  per-class capacity when it lands; until then the placeholder is honest, not a guessed constant.

- **Guild-transport client mockup is missing** — *surfaced 18-09-26 by the 2.2-foundation client slice.*
  The build prompt named `docs/mockups/guild-transport-client.html` as the visual contract, but no such
  file exists in the repo (nor in git history). The slice was built to the prompt's textual spec (the
  commission floor + the two-panel OPERATIONS herostack); a later mockup should be reconciled against
  what shipped, or the "point the roadmap note at the mockup" instruction dropped. No number was invented
  by its absence — every figure still reads from the snapshot.

- **Actioned route — a one-waypoint route at the craft's own berth** — *surfaced 23-09-26 by 2.2 automation
  slice 2a.* §11.4 / §11.9 say a craft already at W1 "resolves W1's action IN PLACE and continues to W2". With no
  W2 the skip leaves NO leg, and §4 refuses a route with no legs — so 2a REFUSES `[W1]` dispatched from W1, with
  or without an action (the conservative reading; `transferCargo` already does the in-place half). Should a
  one-stop route at the craft's berth instead run its action in place, so a one-stop SAVED route works from its
  own stop? Needs a ruling before 2b's Load Route makes it easy to reach.

    **RULED 23-09-26 — RUN IT IN PLACE.** A one-stop route dispatched from that very stop resolves its
    action in place and ends idle there (no leg, no fuel), not refused (transport-model.md §11.9). Small
    engine follow-up (slice 2a.1), before 2b's Load Route. *BUILT 23-09-26 (slice 2a.1).*

- **Actioned route — a skipped W1 whose action has no store** — *surfaced 23-09-26 by 2.2 automation slice 2a.*
  When the craft already sits on W1 and W1 carries an action, the skip resolves it through the SAME arrival
  resolver; if W1 is not a store (a bare hex with no own Outpost — e.g. a saved route's Outpost since torn down,
  2b's "orphaned action"), the run HALTS at dispatch exactly as an arrival there would (§11.6) — but the run's
  up-front fuel for the real legs has already burned. Should the dispatch instead be REFUSED at validate (the §4
  transfer gate: "a transfer is issued at a store"), so no fuel is spent? §11.6's lap-start anchor-gone check
  (slice 3) is the ruled home for catching this before fuelling; 2a mirrors arrival and does not guess.

    **RULED 23-09-26 — NO REFUND.** Fuel burned up front is committed and never refunded, even when the
    route then proves impossible; the craft halts and eats the loss (transport-model.md §11.3). 2a's
    behaviour STANDS (no code change). The §11.6 lap-start re-check (slice 3) declines to FUEL a
    visibly-doomed lap — a refusal to charge, not a refund.

- **Repeating lanes — edge calls built conservatively** — *surfaced 23-09-26 by 2.2 automation slice 3a.*
  §11.10 does not cover these; each is built the cautious way and wants a ruling (or a confirm):
  - **A one-stop lane cannot repeat** (refused at launch). Its cycle has no leg, so it would lap in place
    without end inside one tick. Alternative: let it repeat but only at a turnaround (an Outpost stop), or
    make a legless lap wait for the next tick — which would be a new timing rule.
  - **A craft running a lane refuses a manual transfer.** Only reachable while a lane WAITS for fuel (the
    craft is idle at WN). At an Outpost a manual transfer would be mistaken for the lane's own stop when it
    completes. Alternative: allow it at a system (instant, harmless) and refuse only at an Outpost.
  - **Re-dispatching a craft drops its lane** (a waiting lane, or one queued at an Outpost stop). Follows §4
    ("a queued craft is cancelled by being re-dispatched"); the alternative is to refuse the dispatch until
    the lane is stopped.
  - **"Stop after this run" on a lane waiting for fuel ends it at once** (it is already idle at WN with its
    run finished). The alternative is to refuse the stop and leave Cancel (slice 3b) as the only way out of
    a wait.

- **Repeating lanes — 3a.1 edge calls** — *surfaced 24-09-26 by 2.2 automation slice 3a.1.* §11.10's
  amendment covers the model. These readings were built one way and want a ruling or a confirm:
  - **A per-cycle lap that ends ON a boundary tick starts its next lap at that same boundary.** The hold is set
    in the arrival / dock step and the boundary re-attempt runs later in the same tick, so the boundary
    firing now is "the next" one. It is still one lap start per boundary, and a fuel-short lane already
    behaved this way in 3a. The alternative is to hold a full extra cycle, which means an extra "held since"
    tick rule.
  - **A cadence on a `once` run is REFUSED, not ignored** (even `cadence: 'immediate'`). This follows 3a's
    call on a stray `n` on a continuous lane. The alternative is to accept and drop it silently.
  - **A cadence hold that cannot pay at its boundary is a fuel wait dated FROM THAT BOUNDARY.** `sinceTick`
    reads as "waiting for this reason since". The alternative is to carry the hold's original `sinceTick`
    across, which would read as "stopped since".
  - **"Stop after this run" on a lane holding for its cadence ends it at once.** This extends 3a's fuel-wait
    call: the lane is already idle at WN with its run finished.
  - **A stored `cadence: 'immediate'` fails integrity.** It is non-canonical, the same way a stored `once`
    mode is. The build prompt read "`immediate` | `perCycle` when present". The stricter check protects the
    rule that an immediate lane is byte-identical to a 3a one.

- **Cancel — 3b edge calls** — *surfaced 24-09-26 by 2.2 automation slice 3b.* §11.10 rules Cancel for an
  IN-TRANSIT craft. These readings were built one way and want a ruling or a confirm:
  - **Cancel also frees a PARKED lane.** A lane waiting for fuel or holding for its cadence at WN, or queued /
    loading at an Outpost stop, has no leg to snap on, so Cancel just drops its route where the craft sits
    (the queue entry swept). Without this, the only way out of a wait would be "stop after this run" (which
    already ends a waiting lane at once, 3a) or a re-dispatch. The alternative is to refuse Cancel on a
    craft that is not flying.
  - **A craft LOADING in a dock slot keeps its slot.** Its lane ends at once, but the one transfer in
    progress finishes (design.md §4: "a craft in a slot runs to completion", the same reason a dispatch
    refuses it), then the craft is idle at the Outpost. The alternative is to pull it out of the slot
    unloaded, which would break that §4 rule.
  - **A snap that would land OFF the lattice is refused for that tick.** The lattice is a disc of hexes, so
    a straight leg between two in-bounds hexes near the rim can pass over a hex outside it, and a craft
    cannot be left there (not a valid location). The craft flies on, and a cancel a few ticks later lands.
    The alternative is a rule for which in-bounds hex to use instead (e.g. the last in-bounds hex it
    passed, or the leg's nearer end), and that rule is not in the doc.
  - **The snap is always a BARE hex, even on a landmark's hex.** A craft cancelled over (or still on) a
    system's hex idles as `{ q, r }`, not as that system. The transfer gate then reads it as deep space, and
    a plain dispatch to that same system is refused as a zero-length leg (an actioned route re-anchors it
    through the §11.4 skip). The alternative: when the snap hex holds a system or outpost landmark, idle AT
    that landmark (the shape the arrival step leaves).

- **Raw deuterium's price under the per-tier bands** — *surfaced 26-09-26 by the per-tier price-bands
  slice.* The ruling (design.md §5) says "`deuterium` is tier 1 but never priced, so its band is moot". In
  the engine only `deuterium_fuel` is unpriced. Raw `deuterium` has a posted price
  (`docs/fuel-supply-and-allocation.md` "Priced, but not hidden"), and the licensed deuterium mine's per-tick
  auto-sale pays it. Built as ruled, it takes the T1 band and rests at **1** (was 10), so a licensed
  deuterium mine's sale income falls about 10× (a 5/tick mine: ~50 → ~5 credits a tick) — the mine that
  feeds "the one raw the Syndicate genuinely needs fed to it". Options: (a) keep it, deuterium is a T1 raw
  like any other; (b) give deuterium its own base and band, a per-good exception and a new number to rule;
  (c) pay the auto-sale off a dedicated fuel-facing quote instead of the commodity price, which
  fuel-supply-and-allocation.md already leaves open as a build choice. Not guessed.

    **RULED 26-09-26 — DEUTERIUM UNTOUCHED; separate pricing mechanism deferred to the fuel-economy
    work.** Deuterium is out of the tier system (design.md §8) and is not re-tiered: it keeps its
    pre-slice band (10 / 2 / 200) on the shared price engine. A dedicated fuel-facing price (option c) is
    a future fuel-economy decision. *BUILT 26-09-26 (commit 2 of the per-tier price-bands slice).*

- **The four unclassified Tier-3 modules' sub-tier** — *surfaced 27-09-26 by the Tier-3 price-bands
  slice.* `docs/phase-1-tuning.md` says drive_module, droid_components, claim_beacon and
  habitation_module "default to a sub-tier when first placed in a bill" but not WHICH one, and no bill
  uses them yet. They are priced goods, so they must have a band (a fresh galaxy seeds them). Built as:
  they keep the old uniform Tier-3 band, **100 / 20 / 100,000** (`UNCLASSIFIED_TIER3_BAND`,
  `sim/prices.js`), their status quo. Note 3-1 has the same base (100) and floor but a 10,000
  ceiling. Needs: a sub-tier (or specialist band) for each, ruled when the droid / claim / habitation
  bills are designed. Not guessed.
  **⤳ 27-09-26 (Tier-3 timed production):** their sub-tier now also decides their production
  **timer**. With no sub-tier they have no `TICKS_PER_UNIT`, so they stay **continuous** at 5
  batches/tick (their status quo). The ruling says ALL Tier-3 goods are timed, so this is a known gap.
  Ruling their sub-tier makes them timed with no code change (`ticksPerUnitFor` reads the class).

- **Tier-3 slice 2 (timed production) — items for a ruling or a confirm** — *surfaced 27-09-26.*
  - **What a partial throttle means for a timed factory.** Built as **on/off**: a throttle of 0 stops
    a new unit starting (a unit already on the line finishes, since its inputs are spent), and
    anything above 0 runs the timer at full pace. Should 50% slow the timer (e.g. a unit every 2 ×
    `TICKS_PER_UNIT`)? That needs a rule, so it was not guessed.
  - **`productionRate` on a timed factory is inert.** Establish still stamps `REFINERY_BASELINE` (5
    batches/tick); the timed path only needs it above 0. The console still shows it, and the
    snapshot's `equityPerCycle` projection multiplies it. Retire it for timed factories, or show the
    timer instead? (A client / Slice-3 question.) The snapshot's venture row does not yet echo
    `unitTicksRemaining`; the production preview row does. *(⤳ 28-09-26, Tier-3 Establish client: the
    popup's Rate row still shows the stamped 5 batches/tick for a Tier-3 recipe; left as is, pending
    this question.)* *(⤳ 28-09-26, weekly copy: the popup's Rate row now shows the weekly capacity
    `y /week` from `tier3Contract`, not `productionRate`. The engine question itself stays open.)*
    *(⤳ 28-09-26, the console's Tier-3 fork: on a timed good's own page the console shows the timer
    off the production row ("1 unit / 15m"), never a rate. It never read `productionRate`. On an
    INPUT good's page, e.g. titanium alloy, a timed factory is still listed as a consumer with the
    row's per-tick `rate` (`1 ÷ TICKS_PER_UNIT`, "0.07/t"). That is the Tier-1/2 page, left
    byte-identical by that slice; see its checklist block below.)*
  - **Before Tier 3 runs live (Slice 3's job, recorded so it is not missed):** a Tier-3 licence's
    committed quantity (`commitmentUnitsFor`) and fee (`licenceFee`) still read the continuous
    `baselineOutputFor` (5 units/tick). A timed factory makes at most 1,440 ÷ `TICKS_PER_UNIT` a day,
    so a licensed Tier-3 factory breaches every daily window at any commitment above about 1.3% (3-1)
    — much lower for specialists. Seam 2 kept the fee's reading unchanged on purpose.
    **⤳ 27-09-26 (Slice 3a): the SIZING half is built.** The commitment and fee now read the timed
    weekly output `y` over a 10,080-tick week, not the continuous baseline over a day. What still breaches
    is the default paced DELIVERY; see "Tier-3 slice 3a" below. **⤳ 27-09-26 (Slice 3b): the
    delivery half is built too** (Syndicate-first); see "Tier-3 slice 3b" below.
  - **Doc drift, not a code question.** design.md §5's "Load-bearing price fix" paragraph and
    `docs/phase-1-tuning.md`'s base-price ↔ timer paragraph still say capacity is "per cycle (whole
    units per week ≈ one per factory)". The later RULED notes say per **day** (1,440 ticks), and that
    is what was built. The same §5 ruling says the timer reuses "the remainder mechanism"; it was built
    as a countdown instead, because a carry accrues inputs continuously, which the build rule forbids.

- **Tier-3 slice 3a (weekly settlement + fee re-base) — items for a ruling or a confirm** — *surfaced
  27-09-26.*
  - **The paced-send gap: Slice 3b must close this before Tier 3 runs live.** On the DEFAULT paced
    Syndicate send, a committed Tier-3 factory delivers about 20–40% of its weekly target and breaches at
    every commitment. For a 3-1 part over one week: 10% → 27/67, 50% → 100/336, 100% → 211/672. The
    pace's whole-unit intent mostly falls on ticks the timer mints nothing, and the fork is fresh-only.
    Through the existing `absolute` send (1/tick) the same factory meets every level up to 100%. So the
    week and the sizing are right, and the gap is DELIVERY ORDER. The ruled cure is "Delivery —
    Syndicate first" (`docs/tier3-timed-production.md`), which is 3b's and was not touched. The gap is
    pinned by a test ("THE GAP", `tier3-settlement.test.js`) that is expected to go red when 3b lands.
    **⤳ CLOSED 27-09-26 (Slice 3b).** Syndicate-first delivery is built; the same factory now meets
    every level on the default send (10% → 67/67 … 100% → 672/672). "THE GAP" went red as expected and
    is repointed to "THE GAP, CLOSED".
  - **Teardown settlement is still counted in DAYS.** `teardownSettlement` charges `remaining days ×
    discountedFee`, and for a Tier-3 licence that fee is now a WEEKLY one. A 7-day Tier-3 licence torn
    down on day 1 is charged 7 weekly fees. The ruling says "Teardown owes at most this one week's
    settlement fee". That is still ~10× less than before this slice (the old daily fee was ~10× larger),
    but it is wrong by construction. The fix belongs with the one-week term (3b) and was not changed here.
    *(⤳ Re-cut: the one-week term is now 3c. Still open after 3b.)* **⤳ CLOSED 28-09-26 (Slice 3c).**
    The teardown now counts in the licence's own window, which is the week for Tier 3. A Tier-3
    licence owes one weekly fee on any day of its week and is locked out until the week ends.
  - **A Tier-3 licence still carries `windowDays` (7–42) and the day-based renegotiation schedule.**
    The ruled Tier-3 contract term is one week with a fixed re-offer (no ratchet). 3a shares only the
    fee basis with renegotiation, so a re-lock re-prices on `y`. The Steady/Sub-par/At-risk commitment
    ratchet still applies to Tier-3 until 3b. *(⤳ Re-cut: now 3c. Still open after 3b.)* **⤳ CLOSED
    28-09-26 (Slice 3c).** A Tier-3 licence's term is fixed at one week (`windowDays: 1` in its weekly
    window), and it gets the fixed re-offer, not the ratchet.
  - **The `floor(y)` ceiling on the percentage commitment** (e.g. a heavy engine at 100% commits 3, not
    `round(3.5) = 4`). This applies the ruled `x ≤ floor(y)` to today's percentage expression; the
    whole-unit `x` is 3b's. Confirm. *(⤳ Re-cut: whole-unit `x` is now 3c.)* **⤳ 28-09-26 (Slice
    3c):** a Tier-3 licence no longer signs a percentage. It commits `x ∈ [0, floor(y)]` directly, so
    this cap now matters only to the re-lock's re-derivation, which hands back the same `x`.
  - **A day that does not divide the week** (`state.windowN`, a setup knob; e.g. the 50 one test uses) is
    built REFUSE + HALT + INVARIANT for Tier 3 only. Tier-1/2 in such a galaxy is untouched, and its
    Tier-3 fee quotes are omitted. Confirm (the alternative would be refusing such a `setWindowN`
    outright).
  - **Display, not engine.** `lastLicenceFee` is replaced at every charge, so in a guild with both tiers
    a Tier-3 weekly verdict is overwritten by the next day's Tier-1/2 charge. The client also still labels
    fee quotes and commitments "per cycle", but a Tier-3 figure is per WEEK. Both are client / read-model
    follow-ups. *(⤳ 28-09-26: the label is fixed in the Establish popup, where a Tier-3 recipe reads its
    commitment, fee and breach fee per week. Venture Management and the console still say "per cycle";
    `lastLicenceFee` is unchanged.)* *(⤳ 28-09-26: the console's Tier-3 fork now reads a timed good
    weekly: week target, the week's countdown, and the fee "once a week, when the week settles".
    Venture Management still says "per cycle". The console's last-charge line is still the
    guild-wide `licenceFee` record, which a Tier-1/2 day overwrites.)*

- **Tier-3 slice 3b (Syndicate-first delivery) — items for a ruling or a confirm** — *surfaced
  27-09-26.*
  - **"Fixed" was built as: the Syndicate always claims first for a timed good.** The ruling says
    "Delivery — Syndicate first (fixed)" and "No staggering". The build reads "fixed" as not a lever.
    For a committed timed good the Syndicate claimant is lifted to the front of the stored claimant
    order, so a reserve ranked ahead of it cannot catch a committed unit. The player's other two
    claimants keep their relative order. Without the lift, a reserve level would hold every minted
    unit (on 3a's engine such a guild delivered nothing). Confirm.
  - **The send control and the Syndicate's place in `order` are inert for a timed good, but still
    accepted.** `setProductionProfile` still takes `syndicate: { mode, value }` and any `order` for a
    Tier-3 good; the engine does not read either for delivery. Should intake refuse them for a timed
    good, or keep accepting them as harmless? The console still shows a timed good's "pace" and
    "resolved send", and offers the send control. `requiredRate` is still reported (it is true
    telemetry: the pace that would still meet `Q`), but the control does nothing. A client / read-model
    follow-up either way. *(⤳ 28-09-26, the console's Tier-3 fork, RULED by the human during that
    build: for a timed good the console draws the order as fixed (Syndicate 1, Stockpile 2), with no
    selector, no send control and no pace, and POSTs neither. Whether INTAKE should refuse them is
    still open.)* **⤳ CLOSED 28-09-26 (Slice A, RULED design.md §5): intake refuses a send or an order
    for a committed timed good, naming the field and the venture.** (What stays open is in the Slice A
    items below: an uncommitted timed good, and a value stored before the commitment.)
  - **One pot per good: an unlicensed sibling's units fill `Q` too.** `Q` is the good's target in a
    system, and the fork has always drawn on the good's whole fresh output there, so an unlicensed
    factory beside a licensed one of the same good feeds the Syndicate first as well. This is unchanged
    from the paced send (it is the existing per-good pot), but Syndicate-first makes it visible. Confirm,
    or rule it per-licence when whole-unit `x` lands (3c). A test pins today's behaviour.
  - **Payment is still lumpy** (not a question; recorded so it is not missed). The sale still fires on
    delivery: nothing on most ticks, one whole unit's worth when a unit lands. The per-tick progress
    payment is 3d's. Until then, a met week is paid for exactly its `Q` delivered units, in lumps.
    **⤳ CLOSED 28-09-26 (Slice 3d).** A committed timed good is paid every tick on its progress; its
    delivery credits nothing.
  - **Still open before Tier 3 runs live:** the two 3a items above that are now 3c's (teardown
    settlement counted in days; the `windowDays` term and ratchet still applying to Tier 3).
    **⤳ Both CLOSED 28-09-26 (Slice 3c).**

- **Tier-3 slice 3c (whole units, the one-week term, the fixed re-offer) — items for a ruling or a
  confirm** — *surfaced 28-09-26.*
  - **Auto-renew or auto-lapse?** The ruling says a Tier-3 contract "effectively auto-renews unless
    the guild opts out", and also "Accept (renew) or reject (lapse)".
    - Built as: the existing Tier-1/2 timers. The week ends, then a day of grace (a 7-day contract's
      grace), then the offer stands for 5 days, then the licence **auto-lapses** if nobody accepts it.
    - Alternative: an auto-renew step that re-locks the identical terms at the deadline instead of
      lapsing them. That is a new tick behaviour, so it was not guessed.
    - **⤳ RULED 28-09-26: auto-lapse is intended.** The guild renews by accepting the re-offer; an
      offer nobody accepts auto-lapses. No auto-renew step. No code change.
  - **The term is not aligned to the settlement week.** The ruling says "the contract term and the
    settlement window are the same week". Built with the existing re-lock rule:
    - A term runs signing + 10,080. A licence signed mid-week spans two settlement weeks.
    - Accepting the re-offer, at any point in its 5-day window, resets `signedTick` and
      `committedFromTick`.
    - So the week it is accepted in has its target **and fee** pro-rated from the acceptance tick. The
      part of the week before acceptance goes uncharged, though the factory kept delivering. For Tier
      1/2 that is at most part of a day. For Tier 3 it can be most of a week's fee: accepted on day
      10, week 2 is charged 57% of its fee (measured); on the last offer day, 29%.
    - Aligning term, offer and renewal to the week boundary is a design question.
  - **No Strong discount on a Tier-3 re-offer.** Built as: the re-offer is identical at every standing,
    Strong included, so there is no −10% fee. The ruling's "identical terms … no standing ratchet …
    Drops T1/2's `renegotiationTerms` recompute" was read as dropping the whole standing-keyed terms
    function, discount and all. Confirm. **⤳ RULED 28-09-26: the Tier-3 re-offer KEEPS the Strong
    discount and drops only the commitment ratchet. Built 28-09-26 (Tier-3 cleanup, above).**
  - **Grace is keyed on the contract's length in days.** A Tier-3 week is 7 days at the ruled day, so
    its grace is 1 day. On a test galaxy with a shorter day the same week is more "days" (168 at a
    60-tick day), so the grace is 5 days. This matters only off the ruled day. Confirm.
  - **Fuel-pool coupling (a consequence, not a question).** A Tier-3 licence's ratio `x / y` sets that
    venture's RP (the signing bump and the met gain). The shared fuel pool splits by RP across every
    guild.
    - So, next to HEAD, a Tier-3 guild beside Tier-1/2 guilds can move **their fuel grants**. Example:
      a heavy engine at its most is now 6/7, where HEAD's 100% gave a bigger bump.
    - Their licences, fees and verdicts are identical to HEAD. This is the existing coupling that any
      RP change carries.
  - **One pot per good is unchanged.** 3b asked whether an unlicensed sibling's units should stop
    filling `Q` "when whole-unit `x` lands". 3c did not change it: `x` sums into the good's `Q` as the
    percentage did. The question stays open.
  - **Client / read-model follow-ups** (not engine questions):
    - The Establish panel still sends `committedOutputPct` + `windowDays` for a Tier-3 factory. The
      engine now refuses that, with the right bound in the reason. The client must send
      `committedUnits`. **⤳ CLOSED 28-09-26 (Tier-3 Establish client).** It sends `committedUnits`
      alone for a timed good.
    - To offer an `x`, the client needs `y` / `floor(y)`. The server's commitment preview
      (`BASELINE_UNITS_BY_GOOD`) is still the stale 5/tick figure for a Tier-3 good. **⤳ CLOSED
      28-09-26:** the snapshot's new `tier3Contract` publishes `y`, `floor(y)` and the term, and the
      popup reads those. GET /goods's `baselineUnits` is unchanged (still 5/tick for a Tier-3 good);
      the popup no longer reads it for one.
    - Venture Management reads `lic.windowDays` as days. A Tier-3 licence would show "renegotiable in
      1 days", and its window bar divides 7 remaining days by 1.
    - The renegotiation popup shows a commitment as a whole-number percentage. A Tier-3 ratio like
      6/7 would show as 86%.
  - **The `setSyndicateCommitment` dev scaffold** can now trip `tier3-commitment-is-x-of-y` if it
    rewrites a licensed Tier-3 venture's commitment without its ratio. That is intended: the fee and
    delivery would otherwise read two different promises.

- **Tier-3 slice 3d (the per-tick progress payment) — items for a ruling or a confirm** — *surfaced
  28-09-26.*
  - **Delivery and payment disagree within a week (a ruling).** Delivery is Syndicate-first: whole
    units, the first `Q` made (3b). Payment is `x / y` of every tick's work (3d). Over a met week they
    agree: `x` delivered, `x` units' worth paid. Within a week they do not:
    - A **short week** delivers more than it is paid for. A factory at `x = 336` of 672 that makes only
      160 units delivers all 160 but is paid for 80. It then breaches and pays the full fee, as
      before. Under the old sale it was paid for all 160.
    - A **met week at `x < y`** delivers early and is paid evenly: at 50%, 336 delivered by tick 5,040,
      168 paid by then.
    - Both rulings were built as written. Is this the intended "risk premium … breach bites harder"?
      If not, the options are (each a ruling, and each would touch delivery, so none was built):
      - pay a delivered unit's uncommitted share on delivery;
      - or deliver only as much as the committed progress has paid for.
    - **⤳ RULED 28-09-26: intended, not a defect.** On a breached Tier-3 week the Syndicate keeps
      every delivered unit, while the guild is paid only its committed share `x / y`. That is a
      deliberate breach penalty ("commit conservatively"). Neither alternative is taken; delivery and
      payment are unchanged.
  - **Whole credits: floor-and-carry (confirm).** One tick of committed work is often worth under a
    credit. A 3-1 part at base 100 committed at `x = 50` earns ~0.5 a tick, and at `x = 1` about
    0.01.
    - Built with the ruled floor-and-carry discipline of `sendCarry` / `batchCarry`: pay the whole
      credits, and keep the part of a credit on the venture as `paymentCarry` in `[0, 1)`.
    - Rounding each tick instead would pay `x ≤ 50` nothing all week and `x = 67` about 1.5×.
    - New serialized state, omitted when 0. No fresh galaxy is needed.
  - **The owner split is the good-level `ownerFraction`, as the build prompt specified (confirm).**
    With one committed factory per good it is exactly `1 − o`. With two committed factories of one
    good that offered different equity, each factory's progress is paid at their contribution-weighted
    mean, not at its own `1 − o`. So if one stalls, the other is paid at the blend. Per-venture
    `1 − o` would be exact, because progress, unlike a pooled delivery, is attributable.
  - **A moving price re-weights the week** (a consequence, not a question). At a steady price the
    week's total equals the old sale's exactly (hull plating 67,200; heavy engine 60M). When the price
    moves, the week is paid at its average price instead of at the delivery ticks' prices. At
    `x = 336` of 672 that is 35,062 against the old 33,600: Syndicate-first delivers every unit in the
    first half at the base price, and the guild's own half then lifts the price to 117. This is "valued
    at that tick's price", as ruled.
  - **The dev scaffold now halts on `x > floor(y)` for a timed factory** (confirm). Its first tick of
    work stops the galaxy, naming the tick, `x` and `y`; before this slice it was paid per delivered
    unit. The scaffold intake (`setSyndicateCommitment`) still accepts such an `x`. Should it refuse
    it instead, as `applyForLicence` does?
  - **The carry after a lapse** (confirm). A teardown forfeits the carry (under a credit) with the
    venture's partial progress. A lapse leaves it on the venture, and it is added to the next payment
    if the venture is committed again.
  - **Read model, not engine.** For a timed good, `lastSyndicateSale.goods[good]` now holds two
    events: `credited` is that tick's progress payment, and `units` is the whole units delivered that
    tick (usually 0). The client does not read `syndicateSale` yet.

- **Tier-3 Establish client (the popup's Tier-3 fork) — items for a ruling or a confirm** — *surfaced
  28-09-26.*
  - **The new snapshot field (confirm).** `tier3Contract: { <timed good>: { weeklyOutput,
    committedUnitsCeiling, termDays } }`. It was added because the popup could not render without it,
    as the build prompt allowed. Confirm the name and shape before a second reader (Venture Management,
    the console) depends on it.
  - **`termDays` copies one expression.** It is `TIER3_TERM_WINDOWS × (week ÷ day)`, the expression
    `renegotiationSchedule` uses inline; `sim/licence.js` exports no "term in days" helper, and the
    engine was out of scope. A test pins the two agree at a 1,440- and a 60-tick day. Factor a shared
    helper the next time `sim/licence.js` is open?
  - **`x` across a recipe change.** Built as: `x` carries over and is held to the new `floor(y)` (400
    fuel tanks become 3 heavy engines *(⤳ 4 since the 28-09-26 whole-week retime)*), as the Tier-1/2
    share carries over. The alternative is to reset
    `x` to 0 on every recipe change. A UI call; confirm.
  - **`y` is shown to 2 dp** (`2 / 2.33` for a deep scan mast), following the engine's own "to 2 dp
    only for reading" convention in its refusal. The ratio uses the exact `y`. Confirm, or show a
    fraction (2⅓). *(⤳ 28-09-26: moot for today's timers. The whole-week ruling makes every `y` whole
    (a deep scan mast is 2), and a load-time tripwire keeps it so, so the 2 dp formatting never shows
    a fraction. It is kept.)*
  - **A timed good this galaxy cannot license** (a day that does not divide the week; a dev setup
    only). The snapshot lists no contract for it, so the popup shows the Tier-1/2 panel, and the engine
    refuses the licence with its own reason. Confirm, or show a "cannot be licensed here" state (the
    field would then need to list the good with a flag).
  - **The Rate row** still shows the stamped 5 batches/tick for a timed recipe. That is the Slice-2
    `productionRate` question above, not answered here. **⤳ CLOSED 28-09-26 (weekly copy).** It
    reads "Produces `y /week`", the weekly capacity from `tier3Contract.weeklyOutput`. The engine's
    `productionRate` question above is still open.
  - **Copy for the copy pass.** Two short help reels (`commitUnits`, `term3`) and the Tier-3 confirm
    and receipt lines are new, and written from `docs/tier3-timed-production.md`. The unlicensed and
    refused-licence receipts, which were not touched, still say "First output next tick" for a Tier-3
    venture. **⤳ 28-09-26 (weekly copy):** the Tier-3 confirm, both receipts and the two reels now
    read weekly, with no "next tick", "tick by tick", "share" or batches/tick.
    The refused-licence receipt never said "next tick"; only its "Recorded" rate did, and that is gone
    too. The wording is still open to the human's copy pass.
  - **Notch density (layout, not a game number).** The whole-unit slider draws a notch per unit only
    when notches are at least 6 px apart on screen. A heavy engine shows 0·1·2·3; a 3-1 part's 672
    shows only its end values.

- **Tier-3 Establish popup weekly copy — items for a ruling or a confirm** — *surfaced 28-09-26.*
  - **A first-unit ETA (not built).** The build prompt allowed "first unit in ~N hours" only if it
    could be sourced from the good's timer. The page holds no timer, and `10,080 ÷ y` would be the
    browser computing a game number (§5). So the copy says only what starts the first unit. To show
    an ETA, the engine would publish it: for example, `ticksPerUnit` beside `weeklyOutput` in
    `tier3Contract`. Wanted?
  - **The row's label.** Built as **Produces** (the prompt's example). **Capacity** is the other
    obvious word. Confirm.
  - **"Renegotiate in 7 days" on the Tier-3 path.** The Licence Summary key is the Tier-1/2 one. A
    Tier-3 term is fixed and re-offered, not renegotiated. It was left as the prior slice built it,
    because the days are the snapshot's own `termDays`. A copy-pass item.
  - **Stale shared reels (noticed, not touched: they are Tier-1/2 copy too).** The `licence` reel's
    last page says fee "*charging* it is the one part still to be built", but charging is built
    (Slice 3b-iii). The `asset` reel says "there is no teardown", but voluntary teardown is built.
    Fixing them changes Tier-1/2 copy, so it is a separate, human-approved edit.

- **Tier-3 console fork (the System Production Console's Tier-3 fork) — items for a ruling or a
  confirm** — *surfaced 28-09-26.*
  - **The Distribution order is drawn fixed.** RULED 28-09-26 (the human, during the build). The
    build prompt asked for rank selectors over the two arms, but the engine never reads the order for
    a timed good:
    - committed: the Syndicate is lifted first (3b);
    - uncommitted: it sends nothing.

    So the console draws "1 · fixed" and "2 · fixed" and writes no `order`. Intake still accepts an
    `order` or a send control for a timed good (3b's item above, still open).
  - **The reserve floor moves no unit of a timed good.** RULED 28-09-26 (the human, during the
    build): keep the strip's typed reserve field as shipped, and drop the Tier-1/2 Distribution slider
    on the timed path. That slider is a % of this tick's output (0 or 1 for a timed good), so a drag
    would write the level to 0 or 1.
    - The finding behind the ruling: `reserveLevel` is read only in Gate 1. A timed good has no
      consumer, and its Syndicate is lifted first and takes only the units made that tick. So the
      level changes only the REPORTED hold (`fork.stockpile`). A test pins this
      (`tier3-console-client.test.js`).
    - Tier-4 assembly and a Syndicate sale do not read it either.
    - **Open:** should the reserve get a job for a timed good (e.g. hold stock back from a Tier-4
      build start or a sale)? Or should the field be hidden on the timed path until it has one?
      Nothing on the timed path claims it holds units back.
      **⤳ ANSWERED 28-09-26 (Slice A, RULED design.md §5):** its job is the floor of the settlement
      rescue: a short week is topped up from stock above it, never at or below it. The strip and the
      Stockpile arm now say so. It still holds nothing back from a Tier-4 build start or a sale.
  - **A timed good this galaxy cannot license** (a day that does not divide the week; a dev setup
    only). `tier3Contract` is empty there, so the console shows such a good in the Tier-1/2 layout,
    though its production is timed. This matches the Establish popup's item above. Confirm, or fork on
    the production row's `timed` flag as well.
  - **The unit countdown is the preview's.** "12m left on this unit" is the row's
    `unitTicksRemaining`, the work left AFTER the coming tick. Every console figure is the next
    tick's preview, so it reads one minute under a wall-clock "lands in". It is shown verbatim, with
    no `+1`. Confirm.
  - **An input good's page still speaks per tick about timed factories.** On, e.g., titanium alloy's
    (Tier-2) page, a fuel-tank factory is listed as a consumer with the row's `rate` ("0.07/t"). The
    hero shows "Eff. rate … u/t" and "Makes 0 u/t" for it. That page is the Tier-1/2 console, left
    byte-identical by this slice's scope. It is a later read-model / copy item.
  - **Copy for the copy pass:**
    - the cadence reads "1 unit / 48h 0m", the shared `fmtTicksAsDuration` format; changing the helper
      would change every Tier-1/2 countdown;
    - "left on this unit", "unit made", "waiting on …" and "idle";
    - the Syndicate arm's rule sentence;
    - the Stockpile arm's "On hand" duplicates the strip's figure (a layout choice);
    - the footer's week sentence.

- **Slice A (the settlement rescue + the timed-good refusal) — items for a ruling or a confirm** —
  *surfaced 28-09-26. Each was built one way, stated here, not chosen silently.* *(⤳ Slice A2-engine:
  every item below where the rescue "covers", "takes" or "moves" something now holds only for a good
  whose Syndicate Top-Up is turned on.)*
  - **The rescue's equity split is the SALE's, not the fill's (confirm).** The build prompt said "pay it
    as the boundary delivery does", so the rescued units go through `commitmentSale`: the owner's share
    is the good's contribution-weighted `1 − o` across its committed ventures, not the `1 − o` of the
    licence the pursue fill credited them to. With one committed venture per good, or equal equity, the
    two are the same. With two ventures of different equity, the rescued units are paid at the blend
    (the same question 3d's progress payment raised). **⤳ CLOSED 28-09-26 — RULED (design.md §5, the
    follow-up rulings, (3)) and BUILT (Slice A-fix): each top-up is paid on its own licence's equity
    (`rescueSale`). The per-tick delivery and the progress payment keep the blend.**
  - **A dev-scaffold commitment is rescued too (confirm).** The rescue runs over the verdict's own set,
    every venture with `syndicateCommitment > 0`, including a `setSyndicateCommitment` one with no
    licence (no fee to save, but a verdict and a paid delivery). Leaving them out would split the one
    pursue attribution in two. **⤳ CLOSED 28-09-26 — RULED (design.md §5, the follow-up rulings, (2))
    and BUILT (Slice A-fix): no licence, no rescue, matching the fee charge. The split attribution this
    item foresaw is recorded under Slice A-fix, below.**
  - **The rescue takes any stock above the floor, whatever it was held for (a consequence, confirm).**
    Stock kept as another line's input is rescued unless it is floored: e.g. titanium alloy held as a
    fuel-tank factory's input sets (each of the four re-pinned runs rescues alloy that a fuel-tank
    factory beside it also draws on), or Tier-3 parts
    held for a Tier-4 build. The rescue runs in step 1, before the dockyard sub-step, so a boundary can
    take parts a build would have started on that tick. The reserve floor is the only protection, as
    ruled. **⤳ RULED 28-09-26 (design.md §5, the follow-up rulings, (1)): intended, as built.**
  - **Only the venture's own system (confirm).** Stock of the good in the guild's OTHER systems is not
    used (stockpiles are per system, ruling B1). This reads "its own stockpile" as the guild's pile where
    the venture is.
  - **An uncommitted timed good still accepts a send or an order (a ruling).** The ruling says
    "committed", so that is what is refused. For an uncommitted timed good both are just as inert (no
    recipe consumes a timed good, and it has no commitment to send). Also, a value stored BEFORE the good
    was committed stays stored, inert, after it (a `null` clears it). Should intake refuse both for every
    timed good, whether committed or not?
  - **The percent-of-fresh gap on a refined good is now covered at the boundary (a consequence).**
    design.md §5 (the factory-commitment note) records that a `percent` send on a refined good sends 0.
    That is unchanged on every tick. But the factory's output piles up, and at the boundary the rescue
    now delivers the target from that stock (above the floor). So the window meets, with every unit
    handed over at the window's end. `factory-commitment.test.js` "DEFERRED, PINNED" now pins both
    halves. (The gap itself is not on this checklist today; design.md says it should be.) *(⤳ Slice
    A-fix: that test's fixture commits with no stored licence, so it now pins the gap unrescued. A
    real licence is still covered at the boundary, as described.)*
  - **The Tier-1/2 console says nothing about the rescue (client follow-up).** The rescue is live for
    Tier 1/2 too, but this slice changed only the timed path's copy. The Tier-1/2 strip and reserve
    controls still describe the per-tick flow. Nothing shows `window.rescued` yet, on either path.
  - **Reputation moves with the rescue, so fuel grants can too (a consequence).** A rescued licence is
    `met`, not `breach`, so its RP moves the other way. Through the shared pool, that can move other
    guilds' fuel grants, as 3c recorded for Tier-3 standing.

- **Slice A-fix (no licence, no rescue; each top-up on its own equity) — items for a ruling or a
  confirm** — *surfaced 28-09-26. Each was built one way, stated here, not chosen silently.*
  - **With a scaffold on the good, the verdict is no longer one fill of the window's pile (a
    consequence, confirm).** Ruling (2) skips a licence-less commitment, so the verdict after a rescue
    is each venture's fill plus its OWN top-up, not the pursue fill re-run on the topped-up pile. The
    two agree whenever every commitment on the good has a licence (all of real play), and Slice A's
    halt still checks that. They differ only when a short scaffold is ranked ahead of a rescued
    licence: the scaffold keeps what the fill gave it and breaches, and the licence behind it is met.
    The re-run fill would have handed the scaffold the rescued units instead. Only the dev scaffold can
    reach this.
  - **The per-licence top-ups are not shown (a display question).** The tick gets them from the
    resolver (`rescueTopUps`), but the snapshot leaves them out so its shape, and every pinned hash,
    stays as it was. A client can read the window's `rescued` (the good's total) and each licence's
    verdict row. Showing "licence X was rescued by N units" would need a snapshot field.
  - **One rounding per good per boundary (built as the existing rule, confirm).** The owner's shares
    of a good's top-ups are added up unrounded and rounded once, the same "round once, one integer on
    both legs" rule `commitmentSale` follows (#43). The build prompt's "summing the owner credits"
    could also be read as rounding each licence's share and adding the integers, but then two licences
    at equal equity could be paid a credit more or less than the blend, which the prompt ruled out.
    With no investors yet, the `o` share still stays in the ledger, so today ruling (3) moves only the
    line between the owner's keep and the ledger.

- **Slice A2-engine (Syndicate Top-Up, opt-in + capped) — items for a ruling or a confirm** —
  *surfaced 28-09-26. Each was built one way, stated here, not chosen silently.*
  - **The limit caps ONE settlement, and renews each boundary (confirm).** Built as the build prompt
    specified ("the good's cumulative rescue = min(Σ shortfalls, stock above the floor, limit)", at a
    boundary). So a guild short every day can be topped up by the limit every day. The limit is not a
    running budget that runs down.
  - **The limit belongs to the good, not to each licence (confirm).** It is shared by the good's
    licences in the pursue order: two short licences under one limit get at most the limit between
    them, not the limit each. A skipped scaffold uses none of it.
  - **`null` for the switch clears it to OFF (confirm).** The prompt said "if present, must be a
    boolean". Every other profile field takes `null` as "clear to the default" (§15.4's tri-state),
    and so does the switch: `syndicateTopUp: null` deletes the key and reads `false`. Any other
    non-boolean is refused.
  - **A limit of 0 with the switch on rescues nothing (a consequence).** Legal, since the limit is an
    integer ≥ 0, and in effect the same as off.
  - **A stored switch or limit on a good nothing commits is accepted and inert (confirm).** Like
    `reserveLevel` and `pursue`, it is standing intent that takes effect once the good is committed.
    It is not refused the way a timed good's send control is.
  - **Live galaxies lose their rescues at the next boundary (a consequence).** No migration turns
    the switch on for existing profiles. So a persisted galaxy that relied on the always-on rescue
    now breaches where it was rescued. Its fees and RP move accordingly, and its fuel grants can too,
    through the shared pool. This is the ruled default ("DEFAULT: DISABLED").
  - **The tick does not re-check the switch or the limit (confirm).** The resolver is the one place
    that decides. The tick still re-checks the floor against the real pile (Slice A's halt), and a
    breakage that took the limit in place of the floor was caught by that halt. A matching halt for
    the switch and the limit would be defence in depth, but the build prompt kept the tick unchanged.
  - **Nothing shows that a rescue was capped (a display question, for Slice A2-client).** The window's
    `rescued` and the carried profile (switch and limit) are what a client can read. "Capped at your
    limit" would need a derived field. *(⤳ Still open after Slice A2-client: its build prompt kept the
    engine and the snapshot unchanged, so no such field exists and the console does not show one.)*
  - **The console's text is now wrong in one place (Slice A2-client).** The Tier-3 Stockpile arm says
    "If the week ends short, stock above the reserve is delivered to cover it." That is now true only
    with the switch on, and `server.test.js` pins the string. The panel's top-up control
    (`SYN = { topupEnabled, limit }`) is still a mock. **⤳ CLOSED 28-09-26 (Slice A2-client): the arm
    now says the top-up is opt-in (the pin moved with it), and the control is live.**
  - **Slice A's fixture floors are now redundant (housekeeping).** Eight breach-subject tests got a
    reserve floor in Slice A only to hold their pile away from the rescue. With the switch off by
    default the floor no longer matters there. They were left as they are: they still pass, and still
    pin the same verdicts.

- **Slice A2-client (the console's Syndicate Top-Up control) — items for a ruling or a confirm** —
  *surfaced 28-09-26. Each was built one way, stated here, not chosen silently.*
  - **A timed Tier-3 good has no Syndicate Top-Up control (needs a ruling).** The engine's switch
    covers every tier, a Tier-3 week included. But the timed fork draws no top-up square: it was
    dropped with the Consumption square in the Tier-3 console slice, and `server.test.js` pins that the
    fork draws neither. So a Tier-3 guild cannot turn the rescue on from the console, and its week is
    never rescued unless the switch is set some other way (the raw action). The Stockpile arm's new
    copy ("If Syndicate Top-Up is on, …") is true, but the page offers no switch. Not built here: the
    build prompt kept placement as-is and said nothing about the timed path. Where it goes (the strip,
    the Syndicate column) is a design call. **⤳ RULED + BUILT 28-09-26 (Slice A2-client-fix): in the
    Consumption square's place on the timed strip, the same control in the week's words.**
  - **Placement (confirm).** The build prompt said the control "belongs on the Syndicate tab". In the
    page, and in the authoritative mockup (`docs/mockups/console_restructure.html`), it sits in the
    stockpile row beside the Consumption top-up, visible whichever right-hand tab is open. The prompt
    also said "keep its placement/visual as-is", so it was not moved.
  - **Switching off POSTs `false`, not `null` (confirm).** The prompt said to POST a boolean. The engine
    stores `syndicateTopUp: false`, which reads exactly as absent. The alternative, `null`, is the
    profile's clear-path (§15.4's "absent = default is the single canonical encoding") and would keep
    the profile sparse. Behaviour is identical either way. Only the stored bytes differ.
  - **What "active" means on the square (confirm, or rule a field).** As in the mock, the triangles
    turn amber and animate when the switch is on and the thermometer projects a short window. That
    projection is the thermometer's existing one (this tick's send over the ticks left). It is not an
    engine field. The top-up itself runs only at settlement and only from stock above the reserve,
    which the square does not check. So "active" means "on, and heading short", not "delivering now".
    It was kept as-is per the prompt. An engine-resolved "will top up N" field would pair with the
    open "nothing shows a rescue was capped" item above.
  - **The square is 13px shorter (a consequence).** Without the MOCK tag its header fits on one line,
    so every Tier-1/2 stockpile row is 13px shorter and the panels below move up by that much. Nothing
    else moved (the parity check above).
  - **The timed square never shows "active" (a consequence of Slice A2-client-fix; confirm).** On
    Tier 1/2 the animation comes from the thermometer's per-tick projection. The timed fork draws no
    projection (a timed good sends 0 on most ticks), so on a timed good the ✔ shows the switch and the
    triangles stay idle. Any "this week will be topped up" look would need an engine field (see
    "what 'active' means" above).
  - **Dead code noticed, not removed (housekeeping).** `armBody`'s Syndicate branch and
    `commitmentReadout` (`client/console.html`) are unreachable: `gate1Col` sends every `syndicate` arm
    to `synPanel`. Its stale "advisory" line was corrected anyway. Deleting them is a separate cleanup.

- **Tier-3 whole-week retime — items for a confirm** — *surfaced 28-09-26. Each was built one way,
  stated here, not chosen silently. No number was chosen.*
  - **The float seam is closed by rounding `y` in `weeklyOutputOf` (confirm).** The engine's `y` is the
    per-tick pace times the week, and for the 3,360 timer that product is 3.0000000000000004. Rounding
    it back is exact given the ruling, a one-line change, and a no-op for every other good. The
    alternative is to carry an exact `y` (`qty × week ÷ timer`, divided last) on the licence basis. That
    changes the basis's shape and its readers. `floor(y)` and the fee were already right.
  - **The tripwire lives in `sim/windows.js`, not `sim/baseline.js` (a consequence).** It needs the week,
    and `windows.js` already requires `baseline.js`. A comment by `TICKS_PER_UNIT` points to it.
  - **Eight snapshot re-pins (five tests) in runs that build none of the three goods (confirm).** The build prompt
    said a run touching none of the three must not move, and none of their states did. But every
    snapshot publishes each timed good's fee quote and `y`, so their snapshot hashes had to move. Each
    was checked against HEAD with only those three goods' rows removed. The alternative is to strip
    those rows before hashing, as `tier3Contract` already is in two of them. That would need new pins
    anyway, since the old pins included the old rows.
  - **"At its most" is now a full commitment (a consequence).** With `y` whole, `x = floor(y)` means
    `x / y` = 1 for every timed good. The heavy engine tests that meant "at its most" moved to x = 4.
    Those that used x = 3 as "a partial commitment" stay at 3 (now 3 of 4).
  - **Dead-ish paths (housekeeping, not removed).** `floor(y)` (`committedUnitsCeiling`) and the
    2 dp display of `y` (engine refusal and client `fmtY`) now never cut anything for today's timers.
    They are kept as the ruled bound and harmless formatting. Simplifying them is a separate cleanup.

- **Tier-3 slice 1 — small items for a ruling or a confirm** — *surfaced 27-09-26 by the Tier-3
  price-bands slice.*
  - **Installation kind spellings.** The three data-only installation kinds are spelled `outpost`,
    `deep_scan_array` and `toll_gate` (as the build prompt named them) in `sim/asset-recipes.js`. The
    vehicle classes are camelCase (`lightTransport`). Confirm or re-spell before an entity uses them;
    after that, a rename is a migration.
  - **Doc drift, not a code question.** design.md §5 (27-09-26) and `docs/phase-1-tuning.md` still say
    each final bill is sized to "≈50% of its base at rest", but `docs/asset-recipes.md` says that target
    is retired. If "base" means the Syndicate buy baseline, only the heavy transport's parts at rest are
    near 50% of it (miner / factory ≈ 9%, spycraft ≈ 8%, medium ≈ 27%, light < 1%). Separately,
    `docs/tier3-timed-production.md` calls the bills "8–35 parts", but the heavy transport's is 55.
    The bills were built exactly as tabled; which text is current is for the human.

- **Deferred, flagged in docs (revisit with their slice, don't lose):** the SELL origin-picker helper
  (offer only systems that hold every line — `syndicate-orders.md` §7, a client refinement); a
  contraband-fuel operator lever (`operator-adjust.md`); and Phase-3 per-role auth to fence the
  operator actions off from players.

- **Build yard:** *Purchase price* — **RULED 14-09-26** (`docs/asset-purchase.md` + `phase-1-tuning.md`):
  `price = max(12,000,000 floor, round(partsCost × 0.8))` `[FIRST-CUT]`; a buy pays credits + fuel up
  front, the Syndicate builds centrally (`BUILD_TICKS`) then ships a standard delivery manifest, and an
  idle asset is minted at the destination. **Still open:** sell assets to the Syndicate outright vs
  lease-only; do founding asset grants survive, or must everything be built?
- **Transport:** recall-time vs renegotiation-window for Syndicate contracts (leaning recall); the
  maintenance return threshold (5%); the location/route bonus mechanic; **the craft-speed shape** — 150 ticks/hex `[FIRST-CUT]` (halved 14-09-26) is still ~0.6–16 real-days on the seed, so the durable fix is a much smaller ticks-per-hex or a non-raw-hex distance (log / per-ring band).
- **Investment:** are shares tradable (leaning no)? The share-price formula specifics and the RP-boost
  ratio. **The RP-band reconciliation** (forced-lease −300 vs forced-closure −500 vs renegotiation
  bands; continuous-threshold vs window-end trigger; forced-lease as a new venture-transfer ending).
- **Exploration/espionage:** scan durations + array range; espionage cost/risk model.
- **Droids:** the production-boost mechanic + numbers.

**Carried from Phase 1 / earlier:**

- The 0%-commitment venture that can never earn its way back — intended, or does it need an out?
- #31 — does counter-play to a squeeze exist? (answerable in Phase 2 play)
- Track G: repaired-planet rare tier; node richness; `Planet.stats`.

---

## Standing rules (all phases)

1. The repo is the only memory — the doc updates in the same commit as the code it describes.
2. Sequential vertical slices, never parallel modules — the seams are the hard part.
3. Tests are the tripwires; when unsure what to test, reach for one of the nine invariants (§15.5).
4. Never invent a number silently — unsourced constants go to the decision checklist.
5. Tag phase gates in git so any past playable state is one checkout away.
6. Design here; build in Claude Code. The seam rule: Code reads only the repo + the prompt.
