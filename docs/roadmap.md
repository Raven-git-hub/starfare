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
| 1 | The guild↔Syndicate economy | ✅ Done (deep, 1,310 tests, deterministic) |
| 2 | **The walking skeleton — a contested galaxy vs bots** | 🔶 **In progress** — the single-guild expansion spine is landing (transport visibility, the asset economy: dockyard + Syndicate buy; the trade layer rebuilt onto cargo-space haulers + held orders); the guild↔guild contest (a rival, territory, the market) is not built yet |
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
  `sim/tests/vehicles.test.js`; full suite **1,367 green**, an unbought galaxy byte-identical. *Deferred to
  the CLIENT slice: the In-Progress panel marking the head "building" vs the rest "queued" off the new flag.*

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
  - **slice 4 — the Tier-4 build/deploy path.** The buildable/deployable kit, placement range, anchor-ownership.
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
- **2.2 — Transport: route actions, saved lanes & repeating runs (the automation layer).** The continuation of the guild-transport UI: per-waypoint load/unload ACTIONS that run automatically on arrival, SAVED reusable lanes, and REPEATING runs (continuous or N laps) — the self-repeating trade lane. Design contract: **transport-model.md §11** (RULED 22-09-26; the entity, the chained-legs execution, up-front per-run/per-lap fuel, the reposition rule, and the partial-proceeds / anchor-gone failure split). Built as a ladder: **1a** engine (one-shot route-with-actions execution — chained legs, per-waypoint action, up-front per-run fuel; operator-CLI driven, no client) → **1b** client (the two authoring entry points — the map chip at placement + the dispatch Finalise list to manage — plus the outpost-name label fix) → **2** saved routes (per-guild store + Save / Load Route UI + re-validate at load) → **3** repetition (continuous / N-run with the reposition rule, per-lap fuel + re-validation + pause/resume/cancel). *Pulls the transport-model.md §9/§10 "Phase 4" route-planner automation forward into Phase 2.*
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
- **2.2 — Territory: claims as a live lever.** A claim action + contest resolution (first-valid-wins
  is already stubbed in the engine); expansion beyond the home system; the claim raises the GP/RP bar
  (already modelled). *Precondition for tolls, exploration, espionage.*
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
