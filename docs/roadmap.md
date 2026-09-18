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
  to the home system), an In Progress list + Current Build donut off `syndicateBuilds` (parallel
  builds, soonest first; no parts, no pending state), and the two art heroes. The client PRICES
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
  pattern) at the destination on arrival, dropping the shipment if the owner is gone. **Snapshot** —
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
  all require an ownable, movable guild craft, so it is built FIRST. Sequence — (a) **entity + ownership:** the
  `Vehicle` gains a `systemId` location + inert `maintenanceCondition`, and BOTH the dockyard build and the
  Syndicate purchase mint a transport **idle** into `guild.vehicles` (numbers: `phase-1-tuning.md` "Guild
  transports"; entity: design.md §15.4; the buy/build machinery is kind-general); (b) **dispatch + arrival:** a
  single-leg move, fuel debited up front, position **derived** from a stored schedule (§6, the Syndicate-shipment
  pattern), the only tick step being arrival; then multi-leg routes (the leg is the atomic unit from the start),
  cargo, and scheduled runs. UI: the OPERATIONS hero splits into idle-transports (dispatch) over leased. *From
  here the thread fans out — Syndicate transport contracts, maintenance, exploration (a plain craft scans,
  slower and fuelled), and deep-space asset deployment (outpost → toll). A full Phase-2 renumber to reflect this
  reordering is the roadmap-expert thread's job at hand-back, not done here.*
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
