# Droids — the licence payoff (roadmap 2.6)

**Design model. RULED 02-11-26** (design pass against tip `5e0bed2`, suite green), the
computational contract for the droid slice. `design.md` §4 "Droids" holds the narrative and the
headline rulings and points here; this file is the model the build reads. Numbers are
`[FIRST-CUT]` and live in `docs/phase-1-tuning.md` §Droids — this file names them for orientation
but that file is their source of truth. Nothing here is built yet. *(⤳ 02-11-26: except the §11 sub-tier reband —
`drive_module` / `droid_components` → 3-2 — BUILT as **droid engine slice 1** (§12); and the §1 entity + the guild
dockyard build (§3's guild half), BUILT as **droid engine slice 2** (§12); and the Syndicate flat-tariff buy (§3's
Syndicate half) + assignment with the licence gate and the cap (§1/§4), BUILT as **droid engine slice 3** (§12); and
the boost (§2), BUILT as **droid engine slice 4** (§12); and decay, the maintenance pool and destroy-at-zero (§5), BUILT as
**droid engine slice 5** (§12) — **the droid engine is complete**; the client is next. *(⤳ 07-11-26: the Syndicate
buy is now BATCHED and SHIPPED — §3's RE-RULED note and its AS-BUILT note; slice 3's instant buy is retired.)*)*

**Scope discipline:** 2.6 builds **droids functioning, with these numbers** — the entity, the two
sources, the boost, decay and the maintenance pool. The **failure mechanism is NOT built here**
(§7): catastrophic failure and the illegality of self-build belong to the **storyteller era**
(2.7+). We only need to be *aware* of them now, because that awareness is what **justifies the
numbers** (§3). The build builds droids with the numbers; it does not build failure.

Droids are **roadmap 2.6 — the last genuinely solo facet of play**: they boost *your own*
production, no rival required. So this slice reaches into nothing rival-dependent.

## 0. What a droid is

A droid is a **production buff attached to a venture** — a workforce that raises the venture's
output above its droidless baseline. It is **not** one of the two ground-deployable assets (miner,
factory — `design.md` §4); it attaches to the *venture*, not the machine, and stays with the
venture across an asset swap. A single droid type, **no quality tiers** (v1) — the only per-droid
distinction is its `source`. Factory (production) role only this slice; the security role is a
later, rival-gated slice (§7).

## 1. Entity & state

A droid is an **individual row** in a guild-owned collection (`guild.droids`, a sibling of
`ventures` / `assets` / `vehicles`). Individual rows, not a pool, because condition is per-unit
(droids deployed at different ticks age differently, and the maintenance triage below is
per-droid). Each row:

- `id` — stable, unique, **never reissued** (a per-guild serial, the `kitAssetSerial` pattern,
  `design.md` §15.4). Omitted-when-none keeps a droidless galaxy byte-identical.
- `systemId` — the system it sits in (an idle droid has a location, like an asset).
- `source` — `'syndicate'` or `'guild'`. Governs durability, cost, maintenance demand and where it
  may be used (§3). **Not** a quality tier — the boost is identical regardless of source (§2).
- `assignedToVentureId` — nullable; the venture it staffs, or null when idle. *(⤳ AS-BUILT slice 3: **omitted**
  when idle rather than null, so an idle row is exactly slice 2's `id`, `systemId`, `source`, `condition`.)*
- `condition` — a stored fraction in `(0, 1]`, decaying while deployed (§5). **Every mutation
  records its tick** (§15.2).
- `deployedAtTick` — set on assignment; the anchor decay reads from. *(⤳ AS-BUILT slice 3: stamped with the assign
  tick, omitted when idle; it travels with `assignedToVentureId` — both or neither.)*

*(**⤳ AS-BUILT 02-11-26 — droid engine slice 2.** `createDroid` (`sim/state.js`) assembles
`{ id, systemId, source, condition }`; `condition` is minted at `ASSET_CONDITION_NEW` (1) and is inert. The rows live
in `guild.droids` and the counter in `guild.droidSerial`, both **omitted when empty / 0**, so a droidless galaxy
serializes byte-identically (pinned against fb550f7). Ids are `asset_<guild>_droid_NN` from the serial
(`sim/droids.js`, `nextDroidSerial` / `mintDroid` — the one droid mint). `checkDroids` (`sim/invariants.js`) halts
on an unknown source, a missing `systemId`, a condition outside [0, 1], an id that does not rebuild from its guild
and number, a duplicate id, or a live droid above the serial. The snapshot publishes each guild's own droids
(`{ id, systemId, source, condition }`, omit-when-empty); a rival never sees them. Every droid is idle — nothing
assigns one yet.)*

**State is derived** (invariant 5): *deployed* iff a venture references it, *idle* otherwise.
Ownership is containment (the guild whose array holds the row). **Assignment** is an action: an
idle droid → a venture, **same-system** and **instant** (the asset Gate-2 shape); unassign returns
it to idle. A venture holds at most **CAP** droids (`[FIRST-CUT]` 20); a 21st is refused. Idle
droids **do not decay** (§4) and carry no storage cost this slice (deferred, §8).

*(**⤳ AS-BUILT 02-11-26 — droid engine slice 3, assignment.** The stored fact is the **droid's** pointer,
`assignedToVentureId` (with `deployedAtTick`), not a list on the venture — the superseded `droidComplement` venture
skeleton stays unresurrected. So *deployed* iff that pointer is present, *idle* iff absent (`isDroidIdle`,
`sim/droids.js`) — the same derivation, read from the other end. **`assignDroid { guildId, droidId, ventureId }`**
refuses, in order, each with its own reason: the guild owns no such droid / no such venture; the droid is already
assigned (naming the venture); the droid's system is not the venture's (same-system only, the establish Gate-2
rule); the droid is **Syndicate**-source and the venture is **unlicensed** (neither licence — §4's gate, naming
the venture); the venture already holds **CAP** (20, `DROID_CAP`) assigned droids, counted source-blind. On success
it records the venture and the tick, and moves nothing else. **`unassignDroid { guildId, droidId }`** refuses a droid
that is not the guild's or is already idle, and returns it to idle in place. A **guild** droid may staff any of the
guild's ventures, licensed or not. **A closed venture releases its droids:** the one closure path
(`applyVentureClosure`, `sim/licence.js` — teardown, forced closure, eviction, the operator lever) returns every droid
it held to idle where it stands, as a closed venture's asset returns to idle. `checkDroids` (`sim/invariants.js`) now
also halts on a half-assigned droid, a deploy tick in the future, a droid on a venture that is not its own guild's
(or no longer exists), a droid in a different system from its venture, and a venture over the cap. Assigned droids
still do **nothing** to production — the boost is a later slice.)*

*(**⤳ AS-BUILT 03-11-26 — droid engine slice 4: the tick stamp, and assignable = boostable.** Every droid row the
engine mints or moves now carries **`updatedAtTick`** — the tick of its last mutation, the field `Asset.updatedAtTick`
already carries for machines (§15.2, every mutation records its tick). `mintDroid` takes the tick and stamps it (the
dockyard mint stamps the dockyard step's tick, the one its yard venture is stamped with; the Syndicate buy, the
action's tick) and refuses to mint without one; `assignDroid` and `unassignDroid` stamp it, and so does the closure
release (`releaseDroidsFrom`, the closure's tick). Omitted when absent (as on `Asset`), so a droidless galaxy is
byte-identical; `checkDroids` halts on a stamp that is not a whole tick or lies in the future. A droid that merely
*works* is not re-stamped — nothing about the row changed. **And `assignDroid` refuses a venture that makes nothing**
(`producedGoodFor(venture) == null` — a dockyard, an illegal deuterium refinery, a bare shell), naming it, checked
right after ownership: the boost can never reach such a venture, so a droid may now be assigned exactly where it
boosts.)*

## 2. The buff — one knob, two emission paths

Working droids (`condition > 0`) multiply a venture's production **speed** by `1 + boost(n)`, `n` =
the venture's working droids:

    boost(n) = BOOST_MAX × (n / CAP) ^ p

Mild-convex (`p` slightly above 1), concentration rewarded. `[FIRST-CUT]` `BOOST_MAX = 1.0` (a full
complement **doubles** production speed, ×2), `p = 1.5`, `CAP = 20`. **Source-blind**: a working
guild droid boosts exactly as much as a working Syndicate droid — source changes only durability,
cost and maintenance, never the boost.

Applied in the production model's native form (`productionRate` is inert for a timed factory):

- **Continuous** (Tier 1/2): effective `rate = productionRate × (1 + boost)`, emitted through a
  per-venture **fractional accumulator** so goods stay integer (§15.2) and deterministic. *(⤳ RULED
  03-11-26 — the boost's input is the venture's **`productionRate`**, the stored rate the tick runs at,
  throttled for a continuous line as `(pct/100) × productionRate × (1 + boost)`. For a normally-established,
  unthrottled venture `productionRate` **is** the droidless baseline, so this reads `baseline × (1 + boost)` in
  the common case. The two differ only under a throttle — the boost raises the throttled rate: throttle-below and
  droids-above are the two directions of one dial — or under an operator-set rate; in both, `productionRate` is
  the correct input. The rule "read the droidless baseline (`baselineRateFor`), never a throttled
  `productionRate`" is the **fee / commitment basis** (§4), not the boost's input; the two do not conflict — the
  boost moves output, the basis prices the licence, and neither reads the other.)*
- **Timed** (Tier 3/4): each tick advances the unit's progress by `(1 + boost)` instead of 1, on
  the `unitTicksRemaining` accumulator. `TICKS_PER_UNIT` is **untouched**, so units stay whole and
  `assertWholeWeeklyOutput` stays green.

Applied in the tick (`stepProduction`); the client renders the rate and computes no game number.

*(**⤳ AS-BUILT 03-11-26 — droid engine slice 4, the boost.** `productionBoost(n)` (`sim/droids.js`) is the curve
above, read from a 21-entry table built once at load (n is a whole 0–20, so no `Math.pow` in the tick; boost(0) is
an exact 0 and boost(20) an exact 1.0). n counts a venture's **working** droids — `assignedToVentureId` is the
venture AND `condition > 0` (`isDroidWorking`, `workingDroidCounts`); nothing lowers condition yet, so every assigned
droid works, and decay will slot in without touching the boost. **Applied transiently inside `resolveProduction`**
(`sim/production.js`) — the pure resolver both the tick and `previewProduction` run, so the preview shows the
boosted numbers the tick then applies — and **never written onto the venture**. **The multiplied rate is the stored
`productionRate`** (RULED 03-11-26 — see the Continuous bullet above): the droidless baseline in the common case,
the throttled or operator-set rate otherwise. The droidless baseline remains the fee / commitment basis (§4), which
the boost never touches. Per form:

- **Mine:** extracts `productionRate × (1 + boost)` a tick. Goods stay whole by floor-and-carry on a new per-mine
  **`extractionCarry`** (in [0, 1), omitted when 0): this tick's extraction is added to it, the whole part is
  deposited, the rest carried. The deposit takes whichever path the mine's output already takes (stockpile, a
  licensed deuterium mine's auto-sale + pool mint, an unlicensed one's raw store).
- **Continuous line:** its throttle cap is `(pct/100) × productionRate × (1 + boost)`, and its Gate-2/3 **input ask
  scales the same way** (`batchesAsked`) — rounded **up** to whole units (`unitsAsked`), because Gates 2 and 3 deal in
  integers and a floored ask would hand a line at 1.35 batches/tick only enough for 1, so the boost could never run.
  The existing `batchCarry` then lands the higher rate on whole units and draws `rate × qty` of every input — a
  boosted line draws proportionally more (conservation), and a starved one is still held by its scarcest input.
  An unboosted ask is already whole, so the rounding changes nothing for it.
- **Timed factory:** each tick a unit is on the line gets `1 + boost` ticks of work instead of 1. The countdown
  `unitTicksRemaining` stays whole: the work is floor-and-carried through a new **`unitWorkCarry`**. **The overshoot
  (ruled in this slice):** a unit's last tick can do more work than it still needed; the leftover is **carried into
  the next unit**, not dropped, so a steadily-fed factory averages exactly `TICKS_PER_UNIT ÷ (1 + boost)` ticks a unit
  (at ×2 a 15-tick unit lands on ticks 8, 15, 23, 30 …). Work is banked only across a mint into an immediately
  started next unit: an **empty line that starts no unit** (no input set, or throttled to 0) does no work and **its
  carry is cleared**. `unitWorkCarry` is in [0, 1) while a unit is on the line and in [0, 2) on the tick right after a
  mint (at most one whole tick of overshoot plus a part); `checkTimedProduction` fences both. A unit is minted only
  when its countdown reaches 0, takes its whole input set at start, and is never partial; `TICKS_PER_UNIT` and
  `assertWholeWeeklyOutput` (the BASELINE y) are untouched — a boosted factory simply makes more than y a week.

**Neutral, by construction and test-pinned (§4, §6):** the commitment target `Q` is still built from
`syndicateCommitment`, so a committed boosted venture delivers exactly its baseline commitment and keeps the surplus
(the windowed send self-terminates at `Q`; a timed good's Syndicate-first take stops at `x`); the fee is locked at
signing off the baseline; a timed factory's **progress payment** still pays the committed share of *baseline*
progress (`output qty ÷ TICKS_PER_UNIT`) on each tick a unit is on the line, so a steadily-fed boosted factory is paid
exactly what an unboosted one is — the extra work is the guild's, not the Syndicate's to pay for; GP, the issuance
modifier and the expected RP read ventures and systems, never output. **No-op:** with no working droid every
`× (1 + 0)` is an exact `× 1` and both carries stay absent — a galaxy with idle droids and every production path hashes
exactly as at a8ff924 (pinned).)*

## 3. Sources, cost & durability — and WHY the numbers are what they are

Two sources, deliberately asymmetric. The asymmetry is set **now, aware of a future tradeoff that
2.6 does not build** (§7): guild droids will carry catastrophic-failure risk and are an illicit
"off-spec" product; Syndicate droids are safe and legal. So the numbers price **value against
(future) risk**:

- **Guild droid** — **cheaper and longer-lasting.** Dockyard-built from a **lean** bill at live
  market price (`[FIRST-CUT]` `3 droid_components · 1 drive_module · 2 power_cells`, ~4–5k at rest;
  assembly `BUILD_TICKS` 360). Durability **4 weeks** raw → **8 weeks** maintained. Lower
  maintenance demand. Usable **anywhere**. The off-spec `droid_components`-dominant build stands in
  for a full machine (it is *why* the bill is lean, not §4's full chassis/control/sensor list — a
  deliberate departure recorded in `asset-recipes.md`). The counterweight to all this value is the
  future risk; **in 2.6 that risk is absent, so guild droids are the better buy** (the accepted
  latency — the payoff completes with the storyteller, roadmap 2.6).
- **Syndicate droid** — **dearer and shorter-lived, but safe and legal.** Bought at a **flat,
  market-independent tariff** (`[FIRST-CUT]` ~12–15k cr, *⤳ pinned at **10,000 cr** for slice 3* — a special institutional product, not a
  market good, so NOT an `INSTALLATION_KIT_BUY_BASELINE` floor). Durability **2 weeks** raw →
  **4 weeks** maintained. **Higher maintenance demand** (the "red tape": `[FIRST-CUT]` twice the
  `droid_components`/week of a guild droid). May be assigned **only to a licensed venture** (§4). *(⤳ 09-11-26: the red-tape upkeep premium is **dropped** — both sources draw 1 `droid_components` per droid-week — and the guild droid's maintained life becomes **16 weeks** (maintenance ×4; the Syndicate's stays ×2). The guild payoff is now carried by life, not upkeep; `docs/maintenance.md` §1.)*

Both sources mint one idle droid row, `source`-stamped, through one helper. *(⤳ AS-BUILT 02-11-26, droid engine
slice 2: the helper is `mintDroid` (`sim/droids.js`), and the **guild** path is built — a dockyard build of kind
`droid` from the lean bill above, `BUILD_TICKS` 360, minting through `mintFinishedKind` (`sim/tick.js`), never
through the kit mint. *(⤳ AS-BUILT 02-11-26, droid engine slice 3:)* the **Syndicate** path is built too — a
`buyAssetFromSyndicate` of kind `droid` (the droid now in `SYNDICATE_SELLABLE_KINDS`) charges the flat
**`SYNDICATE_DROID_TARIFF` 10,000 cr** (`priceAssetForPurchase` branches to it — no parts price, no quote ring, no
floor), ledgers it to the Syndicate (invariant 2), and mints **one idle Syndicate-source droid** at the destination
through the same `mintDroid`, at once: no commission queue, no build wait, no delivery fuel. The destination must be a
system the guild **holds** (where its ventures are — assignment is same-system); a short guild is refused, naming
the shortfall. The commissioned-asset quote in the snapshot (`assetPurchaseQuote`) does not list the droid — it has
no build time or delivery leg to quote; surfacing the tariff is the client slice's.)*

*(**⤳ RE-RULED 07-11-26 — the Syndicate buy becomes BATCHED and SHIPPED** — supersedes the instant hand-over
above ("at once … no delivery fuel", "no … delivery leg to quote"). Syndicate droids sell in **three batches —
5, 10, 50 — at the flat 10,000 cr/droid tariff** (**50,000 / 100,000 / 500,000**; these three sizes are the only
purchase quantities, the per-droid price unchanged, so `SYNDICATE_DROID_TARIFF` stays 10,000). The buy's **build
time is 0** (the Syndicate holds them ready), but it is now a **standard Syndicate delivery** (`docs/asset-purchase.md`,
the design.md §6 shipments rail), not an instant mint: one **medium** hauler from the destination's nearest
waystation, at the flat Syndicate `CRAFT_SPEED`, its delivery fuel the **medium hold's** route fuel — a droid
purchase fills a medium hold, parallel to an asset filling a heavy hold (`ASSET_CARGO_VOLUME = HEAVY_HOLD`), so it is
**one medium flight per purchase, the same fuel whether you buy 5 or 50**, and it reuses the existing medium tier —
**no new number**. Credits + delivery fuel are charged **up front** at buy (like a bought miner); the batch lands as
**N idle Syndicate-source droids** at the held destination when the shipment arrives. It is **sold from the Syndicate
buy surface** alongside the commissioned assets. Built in the Syndicate droid-batch-buy slice, which supersedes the
instant `buyAssetFromSyndicate` droid path.)*

*(**⤳ AS-BUILT 07-11-26 — the Syndicate droid batch-buy (engine + snapshot + client).** The RE-RULED note above, built.
**No new number:** the sizes and tariff are the ruling's; the delivery reuses the medium hold, `CRAFT_SPEED` and the
waystations. **The action** is a dedicated `buyDroidBatch { guildId, batch, destinationSystemId }` (`sim/actions.js`),
not a branch of `buyAssetFromSyndicate`, because a droid batch is a *count* of a flat-priced product, builds in 0 and
rides a different hauler. `batch` must be one of **`SYNDICATE_DROID_BATCHES` = [5, 10, 50]** (`sim/droids.js`, frozen).
Validate refuses, each with its own reason and in this order: an unknown guild; any other size (naming the three); an
empty, off-seed or unroutable destination; one the guild does **not hold**; credits short of `batch × 10,000` (naming
the shortfall); fuel (legal + contraband) short of the flight (naming the shortfall). **Apply** moves exactly
`batch × SYNDICATE_DROID_TARIFF` guild → Syndicate ledger (invariant 2) and burns **one medium flight** up front —
`routeFuelCost(dest, DROID_BATCH_CARGO_VOLUME)`, where `DROID_BATCH_CARGO_VOLUME` (`sim/fuel.js`) is the medium row's own
`hold` (50,000), the same for 5 or 50 — through the legal-first `burnFuel`, with `audit.totalConsumed` rising to match
(invariant 1). **Build 0, so it ships the tick it is bought:** apply pushes a standard delivery shipment
`{ ownerGuildId, assetKind: 'droid', droidCount, destinationSystemId, arrivalTick }` with `arrivalTick =
arrivalTickFor(buyTick, distance to the nearest waystation)` — the goods buy's schedule, and the clock a finished
commission ships on. It **never enters `syndicateBuilds`**: it does not wait behind a building head, takes no place
under `SYNDICATE_QUEUE_MAX`, and has no `commissionId` (so it cannot be cancelled — it is in flight at once, like a goods
buy; decision checklist). **The arrival** (`stepArrivals`, `sim/tick.js`) branches on `assetKind === 'droid'` ahead of
the one-asset mint and calls `mintDroidBatch`: it halts if `droidCount` is not a ruled size, else mints exactly
`droidCount` idle **Syndicate**-source droids at the destination through `mintDroid`, stamped with the arrival tick,
on consecutive `droidSerial` numbers. It moves no credit or fuel (pinned: the landing tick differs from a twin with the
shipment removed only by the droids and the serial). A vanished owner's batch is dropped, as any asset delivery; the
destination is not re-checked at arrival (what a lost system does to droids is still the open §1 seam *(⤳ 07-11-26: ruled and built — §14: it IS re-checked now, and a batch bound for a lost system is forfeit)*). **The
instant path is gone:** a droid `buyAssetFromSyndicate` is now refused, naming `buyDroidBatch`; the droid stays in
`SYNDICATE_SELLABLE_KINDS` and `priceAssetForPurchase` still returns the per-droid tariff. A new invariant,
`checkDroidShipments`, halts on a droid delivery whose count is not a ruled size, a `droidCount` on any other shipment,
or a droid delivery carrying cargo. **Snapshot:** a public top-level **`droidBatchQuote`** = `{ perDroid: 10000,
haulerTier: 'medium', batches: [{ size, price }] }` (`sim/fog.js` passes it to every view), and a droid delivery's
transit row adds `droidCount`. The arrival estimate is not duplicated there: build is 0, so arrival is the delivery
leg, read from the existing `fuelCost[dest].travelTicks` (and the fuel from `fuelCost[dest].fuelBurnByTier[haulerTier]`).
**Client** (`client/game.html`, TRADE → 4 · Constructed): the Commission Assets list ends with a **Droids** card —
three batch chips (5 / 10 / 50), the lit chip's price and `¢10,000/droid`, a "Ready — ships by medium · ~Xh" line
(X = the home system's `travelTicks`) where the other cards show a build time, and **+ Add commission**, which (after
the same credits pre-check and adviser confirm as the other cards) posts `buyDroidBatch` to the home system and lets
the poll re-render. The Operations transit manifest names a batch "droids · N". **No-op:** a galaxy that never buys
a batch serializes byte-identically to c613414; its snapshot and views differ only by `droidBatchQuote`, and every
snapshot golden pinned before the slice is still asserted through `sim/tests/droid-batch-quote-strip.js`.
Tripwires: `sim/tests/droid-batch-buy.test.js`, `sim/tests/droid-batch-card.test.js`.)*

**Why this gap (the rationale to lock):** guild droids out-perform on cost, life and upkeep because
they will eventually be the *risky, illicit* option; the Syndicate premium (dearer, shorter, more
upkeep) is the price of *future* safety and legality. The **size** of the gap is coupled to how
punishing the storyteller's catch turns out to be — a 2.7 decision — so the figures above are
**provisional first-cuts, moderate on purpose**; they are not validated until the risk side exists.

## 4. The licence coupling — latent in 2.6

A **0%-commitment, 0-equity licence pays the full fee** (`licence-fee.md`, corner (0,0) = 100%) off
the **droidless baseline**; **droids cannot inflate the fee** (test-pinned). What the licence buys
for droids is the right to staff **Syndicate** droids (safe, legal) — a *licensed* venture may; an
*unlicensed* one gets guild droids only. **This payoff is latent in 2.6:** until the storyteller
fires guild-droid failures, guild droids are simply better, so the licence exerts no droid-pull
yet. 2.6 lays the machinery; the pull arrives with the storyteller (roadmap 2.6, reframed). The
boost never touches licence terms and licence terms never touch the boost (`design.md` §4, one-way).

On a licence lapse, Syndicate droids already assigned keep running (no retroactive change in 2.6);
you simply can't assign more. The illegality of that arrangement is future enforcement (§7).

*(**⤳ AS-BUILT 02-11-26 — droid engine slice 3.** The gate is built **assign-time only**: `assignDroid` refuses a
Syndicate droid on an **unlicensed** venture, naming the venture, and a guild droid is never licence-checked.
**"Licensed" means either licence a venture can hold:** the windowed `licence` (Tier-1/2/3) **or** a deuterium mine's
windowless `deuteriumLicence` (`isLicensedDeuteriumMine`, `sim/baseline.js`) — so a licensed deuterium mine takes
Syndicate droids like any licensed venture (test-pinned; an unlicensed deuterium mine is still refused). There
is deliberately **no** invariant that a Syndicate droid's venture be licensed — a lapse after assignment leaves the
droid assigned and running (a legal state; an invariant demanding the licence would wrongly halt on it). Test-pinned:
a Syndicate droid on a venture whose licence then lapses (`applyLapse`) stays assigned, un-restamped, through every
invariant on every tick; a second Syndicate droid is then refused there; the first can be taken off but not put
back. The licence's fee and terms still read only the droidless baseline — nothing in this slice touches them.)*

*(**⤳ AS-BUILT 03-11-26 — droid engine slice 4.** **Assignable = boostable:** `assignDroid` now also refuses a venture
that produces no good (`producedGoodFor` null — a dockyard, an illegal deuterium refinery), naming it, so the licence
gate above only ever decides *which producing* ventures a Syndicate droid may staff. **Droids cannot inflate the fee
or the commitment — now with a boost to test it against:** the boost multiplies only this tick's minted output, never
the stored `productionRate`, the signed licence or `syndicateCommitment`; a committed boosted venture delivers exactly
its baseline commitment and keeps the rest as uncommitted upside, and the boundary fee is identical with or without a
full complement (test-pinned, `sim/tests/droid-boost.test.js`).)*

*(**⤳ RULED 03-11-26 — the slice-4 neutrality rules, settled.** **The timed progress payment pays baseline
progress only:** a committed boosted timed factory is paid, on each tick a unit is on the line, the committed share
of *baseline* progress (`output qty ÷ TICKS_PER_UNIT`), exactly as an unboosted one — paying for the boosted progress
would have the Syndicate pay for units it never receives (it takes its `x` and no more; the extra units are the
guild's). This is the settled neutrality rule, not an open question. **Droids may boost a licensed deuterium mine**,
like any producing venture — no special case. Its windowless `deuteriumLicence` sets no commitment, and its output
already goes, per tick, to the Syndicate auto-sale and the fuel-pool mint; so a boosted licensed deuterium mine adds
to the guild's deuterium sales **and** to the galaxy's fuel pool (an unlicensed one's raw store simply grows faster).
Allowed now; whether that unbalances the fuel pool is flagged on the roadmap's decision checklist for the
fuel-economy / multiplayer balancing pass.)*

## 5. Decay & maintenance

Condition **decays only while deployed**, **linearly** (a flat fraction of full per tick), and
**monotonically** — maintenance *slows* the slide, never reverses it (no in-place repair). Two
rates per droid, by whether it is **covered** this tick; the rates fall out of the §3 week-lives
(uncovered = `1 / raw-life-ticks`, covered = half that; a week = 10,080 ticks), so they are not
separate numbers. Decay is applied per tick to each deployed droid, tick-stamped; the ~20/venture
cap bounds the work.

**At zero condition (normal end-of-life), uniform for both sources:** the droid is **spent →
destroyed → replaced** (rebuy/rebuild), freeing its cap slot (no repair, so a zero droid cannot
linger). Guild droids reach this far less often (longer life). This is ordinary wear, **not** the
catastrophic failure of §7.

**Maintenance is a `droid_components` supply line** (not a credit sink, not the full bill). Coverage
is **funded at the window boundary**: each window, maintenance draws `droid_components` from stock
to cover as many deployed droids as stock allows, at `[FIRST-CUT]` **1 component = 1 droid-week**
for a guild droid and **2 components = 1 droid-week** for a Syndicate droid (the red-tape premium).
Covered droids decay slow that window, uncovered fast. **When short, lowest-condition-first** (id
tie-break — deterministic, invariant 9). A per-guild `droidComponentReserve` floor (`[FIRST-CUT]`
default 0) protects build-stock: maintenance never draws below it. The client **displays** stock,
consumption rate (components/week at the current complement), runway, and coverage status — and
computes no game number.

*(**⤳ AS-BUILT 03-11-26 — droid engine slice 5: decay, the maintenance pool, destroy at zero.** **No new number** —
the lives, the upkeep and the reserve default are `phase-1-tuning.md` §Droids', now read by code (`sim/droids.js`:
`DROID_LIFE_TICKS` guild **4 wk / 8 wk**, Syndicate **2 wk / 4 wk**; `DROID_UPKEEP_PER_WEEK` guild **1**, Syndicate
**2**; `DROID_COMPONENT_RESERVE_DEFAULT` **0**; the week is the Tier-3 week, 10,080 ticks). Two reconciliations, ruled
by the human in the slice prompt:

- **The maintenance cadence is the WEEK, not the window.** "1 component = 1 droid-week", so coverage is funded at each
  **week boundary** — `isWindowBoundary(tick, 10,080, dayAnchorTick)`, the same anchored week a Tier-3 contract
  settles on — not at the daily window boundary the paragraph above says.
- **The pool is PER SYSTEM, not per guild.** Goods are system-local (ruling B1, `design.md` §15.2), so a droid is
  maintained from **its own system's** `droid_components` stock only — never another system's. The reserve floor is
  per system too: `guild.droidComponentReserve: { [systemId]: whole units }`, omitted when empty, absent ⇒ 0
  (`droidComponentReserveFor`). *Nothing sets it yet* — there is no player action for it in this slice (decision
  checklist); a scenario or a restored save may hand one in, and the upkeep honours it.

**Decay** (`decayDroidsIn`, run per tick per system from `stepProduction`'s per-system loop, right **after** that
system's production — so a droid boosts at its start-of-tick condition, including on the tick it wears out). Each
**deployed** droid in the system loses one tick of wear; an **idle droid is untouched**. The arithmetic is done in whole
**wear units** so a droid lands on exactly 0 on exactly its ruled tick: a new droid holds `DROID_WEAR_SCALE` units — the
least common multiple of the four lives (80,640 today, *derived*, not a tuning number) — and a tick takes
`SCALE ÷ life` of them (guild 2 uncovered / 1 covered, Syndicate 4 / 2); the stored `condition` stays the fraction
`units ÷ SCALE`. A load-time tripwire halts if any rate is not a whole number. Decay is **monotonic** by construction
(at least one unit a tick, rounding moves less than ½) and a per-droid tripwire halts if a condition ever fails to
fall. Wear is the tick's ambient process, so it does **not** re-stamp `updatedAtTick`, which keeps marking discrete
events only.

**Destroy at zero.** A droid reaching 0 is **removed from `guild.droids`** the same tick (the key omitted when the last
one goes); its venture simply has one droid fewer from the next tick — the boost drops, the cap slot frees, and
nothing replaces it automatically (rebuy / rebuild is the player's). The loss is **recorded** as one `droids_spent`
notice per system per tick, stamped with the producing tick (`docs/event-log.md` §17). **Ids are never reissued:**
`droidSerial` only climbs and never reads the live rows, so destroying even the top-numbered droid leaves the next
mint one above it (test-pinned). `checkDroids` now halts on a **deployed droid at condition 0** (`droid-deployed-alive`
— the "undead" state §10 forbids); an idle droid at 0 stays legal (hand-built only — idle droids never wear).

**Upkeep** (`fundDroidUpkeep`, on a week boundary only, per system, **after** that tick's wear — so the boundary tick
itself wears at last week's rate and a droid that wore out on it is not paid for). It pays for the week that starts
the next tick. Spendable stock = the system's `droid_components` above its reserve floor. The deployed droids are
ordered **lowest condition first, id tie-break** (a total order — invariant 9), and each is covered if the remaining
spendable stock pays its cost (1 guild, 2 Syndicate); **a droid the remainder cannot pay for is skipped and a cheaper
one after it may still be covered** (built so no component sits idle while a droid it could pay for wears fast —
decision checklist). Each deployed droid's coverage is SET — `maintained: true` (slow wear) or the key removed (fast
wear) — and stamped `updatedAtTick`. The whole draw leaves the stock in one `addStock`; tripwires halt if the stock
fell by anything but exactly the covered droids' cost, or below the floor. The consumed components are a goods sink
like a dockyard's bill consumption (non-fuel goods are not conserved — the galactic-supply cache follows the stock,
`sim/supply.js`). **A droid deployed mid-week** carries no `maintained` key, so it wears fast until the next boundary
covers it. **Unassign clears coverage** (`unassign`, which the closure release also runs): the week's component is
not refunded, and a redeployed droid is unmaintained until the next boundary (decision checklist). `checkDroids`
halts on a `maintained` that is not exactly `true` or sits on an idle droid, and on a reserve that is not a whole
number ≥ 0.

**Neutral** (§6, test-pinned): the step moves nothing but droid rows, `droid_components` and the notice — no credit,
no fuel, no GP, no mean-line modifier, no RP, no licence or fee. **No-op byte-identical:** a galaxy with no deployed
droid (idle droids of both sources beside a pile of `droid_components`, across a week boundary) hashes exactly as at
8ffbd21 (recorded there, `sim/tests/droid-decay-noop-script.js`). **Snapshot** (state only — no client in this slice):
each droid row carries `maintained: true` while covered (omitted otherwise) beside its `condition`; the owner's guild
row carries `droidUpkeep: { [systemId]: { stock, reserve, weeklyUpkeep, maintained, unmaintained, runwayWeeks,
nextUpkeepTick } }` for each system with a deployed droid — all derived on read, all whole numbers, omitted when no
droid is deployed, fogged from rivals.)*

*(**⤳ RULED 09-11-26 — the maintenance design pass retunes this section** (`docs/maintenance.md` §1; numbers in `phase-1-tuning.md` §"Maintenance"). Three changes, everything else above stands. **(a) One upkeep rate:** both sources draw **1** `droid_components` per droid-week — the Syndicate premium of 2 is dropped (it taxed the guild without a components chain, the wrong target). **(b) Maintenance multiplies life by source:** guild **×4** (4 wk → **16 wk**, 161,280 ticks), Syndicate **×2** (2 wk → 4 wk, unchanged); `DROID_WEAR_SCALE` re-derives to **161,280** (guild 4 / 1 units a tick, Syndicate 8 / 4); a deployed droid keeps its condition fraction, its units rescale exactly. **(c) The reserve gets a setter and stays its own setting:** `droidComponentReserve` means "keep this many for building" — upkeep never draws below it; it does not guard the dockyard build; it is **not** the console's `reserveLevel` (superseding §13.3's lean); a new player action sets it per system, from the Maintenance tab. Not built yet — maintenance build slice 1.)*

*(**⤳ AS-BUILT 09-11-26 — maintenance slice 1 builds the retune above** (`docs/maintenance.md` §1's AS-BUILT note has
the detail). In `sim/droids.js`: `DROID_LIFE_TICKS` guild **40,320 / 161,280**, Syndicate 20,160 / 40,320;
`DROID_UPKEEP_PER_WEEK` is now **one constant, 1** (no longer a by-source table — the AS-BUILT note above, which reads
"guild 1, Syndicate 2", is superseded); `DROID_WEAR_SCALE` derives to **161,280**, wear guild 4 / 1, Syndicate 8 / 4
units a tick. Everything else in this section stands as built: decay, destroy at zero, the per-system weekly upkeep
and its triage (with one rate, a skipped droid is never followed by a covered one — the loop is kept, still
correct), neutrality. The reserve now has its setter, **`setDroidComponentReserve { guildId, systemId, reserve }`**
— "nothing sets it yet" above is superseded. A droid deployed before the retune keeps its condition fraction; no
save migration. The droid-decay no-op golden (8ffbd21) is still byte-identical; the auto-replace no-op golden
(ef14e01) is re-pinned on purpose, its diff written at the golden.)*

## 6. GP / RP — neutral (reaffirmed)

GP/RP-neutral (RULED 10-09-26, `points-and-reputation.md` §1): droids touch output at the
production step only — never GP, never the mean-line bar; the fee / commitment / RP keep reading the
fixed droidless baseline. A droid's cost sits on the **credit axis** (buy / build) and the **goods
axis** (`droid_components` for maintenance). This slice adds no droid GP or RP source. (An RP carrot
to encourage adoption was considered and declined for 2.6 — GP would be counterproductive, raising
the expected-RP bar; revisit only if play shows weak adoption.)

## 7. NOT built in 2.6 — the future that justifies the numbers

These are **design-ahead only**. 2.6 is aware of them (they are why §3's numbers are set as they
are) but **builds none of them**:

- **Catastrophic failure of guild droids.** The off-spec "may or may not fail — maybe that red tape
  was for a reason" catch. It is a **storyteller event** (its natural home, like the deuterium-pump
  detection, `design.md` §(2) "Mechanic TBD in Phase 6"): the storyteller targets a guild grown
  comfortable on cheap illicit droids. Its trigger, probability and effect (destroy the droid ±
  collateral) are **all out of scope here** — designed with the storyteller. 2.6 builds **no**
  failure action, no dormant hook, no RNG; the tick stays pure (invariant 9).
- **The illegality of self-build.** The Syndicate sells `droid_components` for *maintenance*;
  building your own droids is unsanctioned "uncontrolled AI" — illicit (pressure, not prohibition).
  Enforcement (suspicion → fine) is the same Phase-6 storyteller layer. 2.6 builds no enforcement;
  guild droids simply work.
- **The security role.** The second droid role staffs route/territory defense, scaling **linearly**
  (deliberately weaker than the factory curve); the exponential-vs-linear asymmetry makes near-max
  factories high-value, under-defended targets. Contributing factors to keep in view: combat losses
  and reassign-with-delay. Rival-gated — a later slice.
- **Idle-droid storage cost; in-place repair; miner/factory condition** — all deferred.

Recording these is the seam: when the storyteller slice arrives, it reads this and the numbers make
sense; nothing load-bearing lives only in chat.

## 8. Scope

**In (2.6):** the droid entity + two sources (guild dockyard-build at market, Syndicate flat
tariff) + licence-gated assignment of Syndicate droids + the boost in `stepProduction` (both forms)
+ monotonic decay + destroy/replace at end-of-life + the `droid_components` maintenance pool
(window funding, lowest-condition triage, reserve floor) + the client affordances and displays. Plus
the sub-tier classification of `drive_module` / `droid_components` (→ 3-2) and the lean guild bill
lifted into `sim/asset-recipes.js` — the table row + `BUILD_TICKS` + code in ONE commit (the
Prefecture pattern), with the **golden re-pin + fresh galaxy** proven (only those two goods' rows
move — the `rebanded-goods-delta.test.js` template). *(⤳ 02-11-26, the human: these two now ship
**apart**. The reband, with its golden re-pin + fresh galaxy, shipped alone as droid engine slice 1
(§12). The bill lift — table row + `BUILD_TICKS` + code, still ONE commit — waits for the acquire
slice; until then the bill stays a note in `docs/asset-recipes.md`.)* *(⤳ 02-11-26: the bill lift shipped, in one
commit, with droid engine slice 2 — the entity + the guild dockyard build (§12).)*

*(⤳ 03-11-26: the boost in `stepProduction` (both forms) shipped with droid engine slice 4 — §2 AS-BUILT.)*
*(⤳ 03-11-26: monotonic decay, destroy at end-of-life and the `droid_components` maintenance pool (weekly funding,
lowest-condition triage, the reserve floor) shipped with droid engine slice 5 — §5 AS-BUILT. Replacement is the
player's ordinary rebuy / rebuild; the engine's in-scope list is done, and only the client affordances remain.)*

**Out (§7):** all failure/illegality mechanics, the security role, idle-storage cost, in-place
repair, miner/factory condition, the throttle-below rate cap, anything rival-dependent.

## 9. Invariants & proof obligations

- **GP/RP-neutrality:** buying, building, assigning, unassigning or replacing a droid moves no GP,
  no mean-line modifier, no fuel entitlement, no licence fee/commitment.
- **Boost correctness:** effective output = `productionRate × (1 + boost(n))` for working droids
  (for a continuous line, its throttled rate `(pct/100) × productionRate × (1 + boost(n))`; for a
  timed factory, `1 + boost(n)` ticks of work a tick), to the ruled curve; zero droids ⇒ exactly the
  droidless output. For a normally-established, unthrottled venture `productionRate` is the droidless
  baseline, so this is baseline × `(1 + boost(n))` (§2's ruling, 03-11-26). The droidless baseline is
  the fee / commitment basis (§4), never moved by the boost.
- **Licence gate:** a Syndicate droid cannot be *assigned* to an unlicensed venture (refused,
  naming it).
- **No-op byte-identical:** a galaxy that mints no droid serializes byte-identical to pre-slice
  state (every droid field omit-when-empty), pinned against `main`.
- **Determinism (invariant 9):** no randomness anywhere — decay and the maintenance triage are pure;
  same seed twice byte-identical.
- **Conservation (invariant 2):** credits for a Syndicate buy, parts for a guild build, and
  `droid_components` for maintenance are ledgered; a replaced droid is an accounted sink.
- **Integer goods (§15.2):** the continuous rate accumulator and the timed progress accumulator
  never emit a fractional unit.
- **Ids never repeat (§15.4):** a replaced droid's number is never reissued.

## 10. Failure modes hunted on paper (survival rule 7)

- **`droid_components` runs dry.** Coverage lapses; droids fall to the fast rate and wear out sooner.
  Intended. The reserve floor and runway display are the player's guards.
- **Self-build eats maintenance supply.** Building a guild droid consumes `droid_components` the
  guild also needs for upkeep — a deliberate competing draw; make it visible.
- **Cap vs alive.** The cap counts assigned droids; a droid destroyed at end-of-life frees its slot,
  and there is no zero-but-undead state (zero → destroyed), so "assigned" and "alive" coincide. Pin
  it with a test.
- **Timed whole-unit safety under boost.** The progress accumulator must never emit a partial unit
  or break `assertWholeWeeklyOutput`.
- **Triage determinism.** Lowest-condition-first needs a total order (id tie-break) or a replay
  diverges.
- **Licence lapse with Syndicate droids assigned.** They keep running; no retroactive reprofiling in
  2.6 (the illegality is future enforcement). Spell out in the build.

## 11. The numbers (→ `docs/phase-1-tuning.md` §Droids, all `[FIRST-CUT]`, provisional pending 2.7)

Cap 20 · `BOOST_MAX` 1.0 (×2 at full) · `p` 1.5 · **guild** droid life 4 wk / 8 wk (0 / full
maintenance), bill `3 droid_components · 1 drive_module · 2 power_cells`, `BUILD_TICKS` 360, upkeep
1 `droid_components` = 1 droid-week · **Syndicate** droid life 2 wk / 4 wk, flat tariff ~12–15k cr (*pinned 10,000, slice 3*),
upkeep 2 `droid_components` = 1 droid-week · `droidComponentReserve` default 0 · `drive_module` →
sub-tier **3-2**, `droid_components` → sub-tier **3-2** (each sets the module's price band **and**
its production timer — 30 ticks/unit, y = 336/week).

*(⤳ AS-BUILT 03-11-26, droid engine slice 5: every number above is now read by code. The lives as `DROID_LIFE_TICKS`
(guild 40,320 / 80,640 ticks, Syndicate 20,160 / 40,320), the upkeep as `DROID_UPKEEP_PER_WEEK` (1 / 2), the reserve
default as `DROID_COMPONENT_RESERVE_DEFAULT` (0), all in `sim/droids.js`. The only derived figure is the wear scale
80,640 (the lives' least common multiple), an exact-arithmetic device, not a tuning number.)*

*(⤳ RULED 09-11-26, `docs/maintenance.md` §1: guild droid life **4 wk / 16 wk**; upkeep **1** `droid_components` = 1 droid-week for **both** sources; wear scale **161,280**. The rest of this section is unchanged.)*

*(⤳ AS-BUILT 09-11-26, maintenance slice 1: the ruling above is in code — `DROID_LIFE_TICKS` guild 40,320 / **161,280**,
Syndicate 20,160 / 40,320; `DROID_UPKEEP_PER_WEEK` **1** (one constant, both sources); wear scale **161,280** (derived).
The 8 wk / Syndicate-2 / 80,640 figures above are superseded in code. `droidComponentReserve` default 0, now set by
the `setDroidComponentReserve` action.)*

## 12. Build order (vertical slices)

1. **Engine** — the entity + both acquire paths (guild dockyard build, Syndicate flat-tariff buy) +
   assignment (licence-gated for Syndicate) + the boost in `stepProduction` (both forms) + monotonic
   decay + destroy/replace at end-of-life + the `droid_components` maintenance pool; plus the
   sub-tier classification of `drive_module` / `droid_components` and the lean droid bill lifted into
   the FINAL table + `sim/asset-recipes.js` (one commit), with the golden re-pin + fresh galaxy
   proven. All §9 tripwires. **No failure mechanism** (§7).
   *(⤳ 02-11-26, the human: the engine is built in **several slices**, not one. **Slice 1 — the
   Tier-3 reband — BUILT 02-11-26:** `drive_module` / `droid_components` → 3-2 (price band and
   30-tick timer), the golden re-pin and the fresh-galaxy requirement, nothing else
   (`docs/phase-1-tuning.md` §Droids, "AS-BUILT 02-11-26"). Still to come in later engine slices: the
   entity, the two acquire paths (the guild one lifting the bill), assignment, the boost, decay and
   the maintenance pool. How those are split and ordered is not ruled here.)*
   *(⤳ **Slice 2 — the droid entity + the guild dockyard build — BUILT 02-11-26.** `guild.droids` rows
   `{ id, systemId, source, condition }` and the `droidSerial` counter (both omit-when-empty), the lean bill lifted
   into the FINAL table + `sim/asset-recipes.js` (`DROID_BILL`, `BUILD_TICKS` 360) in one commit, and a finished
   dockyard build minting one idle guild-source droid at the dockyard's system; the `checkDroids` invariant; the
   snapshot rows. **Still pending:** the Syndicate flat-tariff buy (a droid buy is refused until then), assignment
   + the licence gate + the cap, the boost, decay and the maintenance pool.)*
   *(⤳ **Slice 3 — the Syndicate flat-tariff buy + assignment (the licence gate + the cap) — BUILT 02-11-26.** A
   Syndicate droid bought for a flat 10,000 cr, minted at once at a held system (§3 — *⤳ superseded 07-11-26 by the
   batched, shipped buy, §3's AS-BUILT note*); `assignDroid` / `unassignDroid`
   with the five ordered refusals, the assign-time-only licence gate (licensed = the windowed `licence` or a deuterium
   mine's `deuteriumLicence`) and the source-blind cap of 20 (§1, §4); a
   closed venture releasing its droids; `checkDroids`' assignment rules; the snapshot's droid `assignedToVentureId`
   and the owner-only `droidComplement` (omit-when-empty). Assigned droids still do nothing to production. **Still
   pending:** the boost, decay and the maintenance pool.)*
   *(⤳ **Slice 4 — the production boost (both emission forms) — BUILT 03-11-26.** `productionBoost` for a venture's
   working droids, applied transiently in `resolveProduction`: a mine through a new `extractionCarry`, a continuous
   line through its scaled throttle cap and input ask (the existing `batchCarry`), a timed factory through a new
   `unitWorkCarry` with the overshoot carried into the next unit (§2 AS-BUILT). Neutral to the stored rate, the
   commitment, the fee, the progress payment, GP and the mean line. Folded in: `updatedAtTick` on every droid
   mutation, and `assignDroid` refusing a non-producing venture (§1 AS-BUILT). **Still pending:** decay and the
   maintenance pool, then the client.)*
   *(⤳ **Slice 5 — decay + the `droid_components` maintenance pool + destroy at zero — BUILT 03-11-26.** Per-tick
   linear wear of deployed droids in exact whole units, the weekly per-system upkeep (lowest-condition-first, the
   per-system reserve floor), removal at 0 with a `droids_spent` notice and no id reissued, the snapshot's
   `maintained` flag and per-system `droidUpkeep` row (§5 AS-BUILT). **The droid engine is complete.** Next: the
   client (step 2 below).)*
2. **Client** — the droid affordances and displays, detailed in §13 below (deployment in the Venture
   Management popup, the per-venture auto-replace, and the maintenance tab); renders the snapshot,
   computes no game number.

Each slice: suite green + count, the §9 tripwires, "do NOT push — open a PR."

## 13. Client design (the UI pass) — RULED 05-11-26

The engine is complete (§8); this section is the client. Everything is **per-system**, because droids are
system-specific: a droid carries a `systemId`, is assigned only within its own system (§1), is maintained from
that system's local `droid_components` pool (§5), and **cannot move between systems** (relocation stays deferred).
There is **no guild-wide droid pool** — each system holds, assigns and maintains its own droids, so every droid
surface is per-system.

### 13.1 Deployment — the Venture Management popup

Droid **deployment and the complement** live in the existing **Venture Management popup** (the "Open Venture
Management" per-venture popup) — the one surface already scoped to *this* venture, committed or 0%-commitment alike,
which is exactly the per-venture home droids need (the per-system Production Console is good-centric and lists only
*committed* ventures, so it is the wrong host). The popup gains a droid section:

- **Available** — a count of idle droids standing in **this venture's system** that could be assigned here: idle
  (`assignedToVentureId` absent) · same system · and, for a Syndicate droid, this venture licensed. A
  **client-derived** count over the snapshot's own-guild droids — no engine number.
- **Slots** — a descending list, one slot per droid currently assigned to this venture (`assignedToVentureId` ===
  the venture), each showing the droid's **id** and its **condition** as a depleting thermometer (the snapshot's
  `condition`, 0→1). Up to **CAP (20)** slots.
- **Fill / clear** — filling an empty slot assigns an available idle droid (`assignDroid`); clearing a slot returns
  that droid to idle in its system (`unassignDroid`). Both are the **existing** actions; the client offers only
  assignable droids, so the engine never refuses a presented option.

This section is **client-only**: it reads existing snapshot state and calls existing actions — no new engine or
snapshot for the display.

*(**⤳ AS-RULED 06-11-26 — the deployment layout; mock `docs/mockups/droid-deployment.html`.** All **CAP (20)** slots
show as a **4×5 grid** (empties dashed — superseding the "descending list" above); **Available** is a **thermometer**
(fill = available ÷ CAP), not a bare number; each slot's **condition** is a thermometer **colour-coded
green/yellow/red** by a presentation threshold (green > 60% · yellow 30–60% · red < 30% — the RP z-band pattern);
**Deploy** fills **reading order** (left→right, then down) with the first empty marked *next*, and assigns the
**lowest-id assignable idle droid**; **no legend / no source-colour key**. The **CAP** is mirrored client-side and
**pinned by a served-page tripwire** (as RP_FLOOR / RP_SOFT_CAP are), not published. The **auto-replace toggle** the
mock draws is **§13.2 (slice 2)**, not this slice.)*

*(**⤳ AS-BUILT 06-11-26 — client slice 1, deployment.** Client-only: no `sim/` engine or snapshot source changed. In
`client/game.html`, the `#vm-overlay` card gains a full-width `#vmWorkforce` band under its two columns (CSS
`.vm-wf` / `.vm-slots` / `.vm-slot` / `.vm-therm`, in the popup's own palette — condition green / yellow / red are
the popup's `--green` / `--amber` / `--red`); the overlay already scrolls, so a tall popup stays reachable. In the
venture-management-wire IIFE, `renderVM()` now calls **`renderWorkforce(s, v)`**, so the section fills on open and
re-renders on every poll. It reads the player's own guild row (`window.__player().guildId`) — `droids` and
`droidComplement`, both tolerated absent — and the venture. **Producing gate:** `producedGood(v) == null` shows the
calm "produces no good — nothing for a droid to boost" line and no slots. **Available** is
**`droidsAvailableFor(me, v)`**, a pure function mirroring the `assignDroid` gate (idle · same system · a Syndicate
droid only where `licence` or `deuteriumLicence`); its thermometer is `available ÷ DROID_CAP`, clamped full.
**Slots:** all `DROID_CAP` cells, the complement in reading order, the first empty marked *next*; each filled cell
shows `droid_NN` (the full id on hover), a condition thermometer coloured by **`conditionBand(condition)`** and a %,
and a ✕. **Deploy** sends `assignDroid` for `droidsAvailableFor(...)[0]` — the first in the snapshot's id order —
and is disabled when none is available or the venture is full; **✕** sends `unassignDroid`. Neither changes what
is drawn: the snapshot is re-read (`__refreshNow`) and the next render shows the result; a refusal shows in the
section's note (`#vmWfNote`), and the controls hold while an action is in flight. **The cap:** `var DROID_CAP = 20`,
one named constant, pinned by `sim/tests/server.test.js` against `sim/droids.js`'s own `DROID_CAP` (the test
fails if either moves alone); the same test runs the page's own `droidsAvailableFor` against the engine's
`validateAction` for every droid × venture pair of a fixture covering each branch of the gate. **Not built:** the
auto-replace toggle (§13.2), the maintenance tab (§13.3), a guild-vs-Syndicate source chooser on Deploy, the §13.4
carry-overs, a boost indicator.)*

*(**⤳ AS-BUILT 06-11-26 — client slice 1b, the deploy source chooser.** Client-only: no `sim/` engine or snapshot
source changed. **Supersedes** slice 1's "Deploy … assigns the lowest-id assignable idle droid" (of any source): a
single Deploy could spend a flexible guild droid on a licensed venture while Syndicate droids sat idle — and only a
guild droid can staff an unlicensed venture (§3/§4). The one button is now **two source buttons, ＋ Guild · n and
＋ Syndicate · n**, each labelled with that source's assignable count here. The choice is **source-level**, not per
droid: within a source, Deploy sends the **lowest-id** assignable idle droid of **that** source (the snapshot's id
order — string order, as before; slice-1 call (2) still stands). The counts are **`splitBySource(droidsAvailableFor(me,
v))`** — the one gate partitioned by `source`, not a second gate — so on an unlicensed venture the Syndicate
partition is empty by the gate itself. Each button is disabled when its partition is empty, the venture is at
`DROID_CAP`, or an action is in flight; both send the same `assignDroid` through the same `WF.busy` flow. On an
unlicensed venture a presentation-only hint ("Syndicate needs licence") sits beside the buttons; it reads
**`ventureLicensed(v)`**, the licence test the filter itself now calls, so the hint and the gate cannot disagree.
The available thermometer and total count are unchanged (total = the two partitions summed). The served-page test
now also checks each source's partition against the engine's `validateAction` for every fixture venture, and that
each button sends its own partition's `[0]`. Mock updated to match. **Not built:** a per-droid picker; the
auto-replace toggle (§13.2) — still absent, the test still asserts it.)*

### 13.2 Auto-replace — a new per-venture mechanic (engine + a popup toggle)

A per-venture **`autoReplace`** flag (a venture field, default **off**, omitted when off so a galaxy with it off
stays byte-identical). When a deployed droid is **destroyed at zero condition** (§5's decay step) on a venture whose `autoReplace`
is on — **and only then**; a player's unassign or a closure's release never triggers a refill — the **same tick** the
vacated slot is refilled by **assigning an idle droid from that system** that passes the normal assign gate (idle ·
same-system · licence-ok for a Syndicate droid). The refill **honours the source of the droid that died**:

- a **Syndicate** vacancy is filled only by the **lowest-id idle Syndicate droid** the gate allows; if none, the slot
  stays empty — **never a guild droid**;
- a **guild** vacancy is filled by the **lowest-id idle guild droid**; if none, it **falls back** to the lowest-id
  idle Syndicate droid the gate allows; if neither, empty.

So auto-replace may **downgrade** a guild slot to Syndicate to keep a venture running, but **never upgrades** a
Syndicate slot to guild — that switch is the player's alone (only the player spends a guild droid onto a new slot).
When several vacancies in a system compete for the same idle buffer the same tick, the fill is **two passes, both in
venture-establishment order (lowest-id within a source)**: first every vacancy is served **from its own source**,
then the remaining **guild** vacancies take their **Syndicate fallback** — so a fallback can never consume a
Syndicate droid a genuine Syndicate vacancy needed. Deterministic throughout (invariant 9).

**"Lowest id" — RULED 06-11-26.** Every droid-id tie-break and "lowest id" pick is the **lexicographic order of the
id string** — the order the snapshot sorts droids in (which the client's Deploy reads) and the §5 maintenance
triage's tie-break. One comparator, `byDroidId` (`sim/droids.js`), serves the triage and this refill alike, so they
cannot drift apart. Deterministic (invariant 9): ids are unique, so it is a total order. Lexicographic and numeric
order agree through serial 99 and part at 100 (`…droid_100` sorts before `…droid_99`); **lexicographic is the
convention** — the numeric alternative was considered and declined 06-11-26.

It is **free**: it reassigns a spare the guild already owns — **no credits, parts, or build delay** (this is why
"stock" means idle droids, not components or credits). If no assignable idle droid is available the slot stays empty
(the complement drops) until the player replenishes the buffer. A refilled droid is an ordinary assignment
(`updatedAtTick` stamped, cap respected) that **keeps the spare's own condition** — NEW only if the spare was freshly
minted; a worn spare deploys worn, since resetting it would be the free repair §5 forbids. *(⤳ corrected 06-11-26 at
the build, client slice 2: this read "condition NEW", which would have repaired a worn spare for free.)* **GP/RP- and conservation-neutral** — nothing is minted or
spent. **No new numbers.** The toggle is set from the popup through a small new action.

*(**Licence lapse** — a Syndicate vacancy on a venture whose licence has since lapsed finds no gate-allowed Syndicate
droid, so it stays empty: the venture's Syndicate complement **erodes** as those droids wear out (its already-assigned
droids stay — the §13.1 gate is assign-time only — and its guild deaths still refill with guild). **Deferred
alternative, parked 06-11-26 — evict-on-lapse:** a lapse could instead unassign the venture's Syndicate droids back
to idle at once ("their software refuses unlicensed work"), a crisper fiction that returns them as redeployable
spares — but it reverses the assign-time-only gate and is its own slice.)*

*(**⤳ AS-BUILT 06-11-26 — client slice 2, auto-replace (engine + snapshot + client).** **No new number.**
**The flag:** `venture.autoReplace` — `true` or omitted (`createVenture` carries it, the `deuteriumRefinery`
convention); `checkDroids` halts on any other stored value (`venture-auto-replace-valid`). **The action:**
`setAutoReplace { guildId, ventureId, on }` (`sim/actions.js`) — refused for an unknown guild, a venture the guild
does not own, or an `on` that is not a boolean; on writes `autoReplace: true`, off **deletes the key**, and the venture
is stamped `updatedAtTick`. Any owned venture may carry it (a non-producing one simply never has a death). **The one
gate, the one mutation:** the `assignDroid` checks after ownership (producing · idle · same system · Syndicate →
licensed · CAP) moved verbatim into `assignDroidRefusal(guild, droid, venture)` and the apply's three-field write into
`assignDroidTo(droid, ventureId, tick)` (`sim/droids.js`); `assignDroid` and the refill both call them, so the refill
can place nothing the player's Deploy would be refused and never touches `condition`. **The hook — two phases in
`stepDroidUpkeep`** (`sim/tick.js`, per system, inside `stepProduction`'s loop): **A** — `decayDroidsIn` destroys this
tick's zero-condition droids and the `droids_spent` notice records them, both unchanged; **B** — right after,
`refillAutoReplaceVacancies(guild, systemId, spent, producingTick)` makes one vacancy per spent droid that staffed an
`autoReplace` venture in the system (with that droid's source), in `guild.ventures` array order, and fills them in
the two passes above, each pick the **lowest-id** (`byDroidId`, lexicographic) idle droid of the source in the system that
`assignDroidRefusal` passes (re-run per pick, so the cap and licence hold refill by refill). It runs **before** the
week-boundary upkeep, so on a boundary a refilled droid is paid for like any deployed droid; a refill is otherwise
unmaintained (no `maintained` key) until the next boundary. Stamped `deployedAtTick` / `updatedAtTick` with the
producing tick (as a closure's release is). **Death-only by construction:** it reads only `spent`, so an unassign or
a closure release never reaches it. **Silent:** no notice (deferred — decision checklist). Tripwires halt if refills
outnumber vacancies or a venture passes CAP. **"Lowest id" is lexicographic** (the ruling above): the refill and the §5 triage share
`byDroidId`, and a test pins that both pick the same droid among serials 99 / 100 / 101 and that the snapshot lists
them in that order. *(Built first as numeric order; amended in the same PR, 06-11-26.)* **Snapshot:** the
venture row carries `autoReplace: true` while on, **omitted** when off (unlike its always-present boolean
neighbours, so a galaxy that never switches it on publishes byte-identically); a rival's venture row is cut to
`RIVAL_VENTURE_FIELDS`, so it never sees it. **Client:** `renderWorkforce` draws the mock's **Auto-replace** switch
beside the WORKFORCE heading (`#vmWfAuto`, none on a non-producing venture), reading `autoReplaceOn(v)` off the
snapshot; a click sends `setAutoReplace` with the opposite state through `sendDroidAction` — no optimistic change,
the poll re-renders. **Proof** (`sim/tests/droid-autoreplace.test.js`): a galaxy with it off everywhere — both
sources deployed, three wearing out, idle spares of both sources, a licensed venture, a week boundary crossed —
hashes exactly as at ef14e01 (`droid-autoreplace-noop-script.js`); the source rule both ways; the thin-buffer
two-pass case; the lapsed-licence erosion; same-system only; CAP (one death, one refill); a worn spare keeps its
condition; an unassign is never refilled; a refill moves no credit, good, fuel, GP or RP; two runs and a save/restore
byte-identical; the snapshot flag and its fog; the invariant. **Not built:** a "droid auto-replaced" notice; the
maintenance tab (§13.3); evict-on-lapse (parked above).)*

### 13.3 Maintenance — its own tab, next to Operations (design pending)

`droid_components` **upkeep** gets **its own top-level tab, beside Operations** — a **separate design pass**, not
ruled here. The engine is already built (§5): per-system weekly coverage, lowest-condition triage, a per-system
reserve floor. The tab will surface, per system, the stock, the weekly upkeep need and coverage, the runway, and a
control for the **reserve floor** — which **reuses the existing per-good `reserveLevel`**
(`production-console-model.md`), not a bespoke setter. Layout and wiring are the maintenance-tab pass.

*(⤳ RULED 09-11-26 — the maintenance design pass, `docs/maintenance.md` §7: the tab is ruled, and spans droids **and spacecraft** (a Fleet half for the guild credit pool and every craft, a Droids half per system). The reserve control does **not** reuse `reserveLevel` — it is its own per-system `droidComponentReserve` setter ("keep this many for building"), §1c there.)*

### 13.4 Carry-overs folded in

The commission list's incidental "droid" entry (engine slice 2) gets a coherent affordance or is hidden until
deployment exists; the `droids_spent` notice's player-facing wording (engine slice 5) is settled at the client slice.

### 13.5 Client slices (build order)

1. **Deployment** — the droid section in the Venture Management popup (client-only: available, slots,
   assign / unassign).
2. **Auto-replace** — the `autoReplace` venture flag + the fill-on-death-from-idle engine mechanic + the popup
   toggle. *(⤳ BUILT 06-11-26 — §13.2's AS-BUILT note.)*
3. **The maintenance tab** — after its own design pass.

The client renders the snapshot and computes no game number; the counts and conditions it shows are read, not
computed.

## 14. Losing a system — droids are destroyed with it — RULED 07-11-26

Droids are **system-local** (§1): a droid carries a `systemId`, is assigned only within its own system, and
**cannot move between systems**. So when a guild **loses a system** — by **abandoning** its Prefecture or by
**eviction** (`sim/eviction.js`) — its droids there have nowhere to go, and they are **destroyed with it**, like the
Prefecture and the torn-down ventures. They are **not** left stranded-and-salvageable the way a system's **machines**
are (the losing-ground salvage window), and a rival who later claims the fallow system does **not** inherit them —
the droids are gone at the moment of loss, so there is nothing to strand or sweep.

- **Deployed and idle alike.** Every droid of the losing guild standing in the system is destroyed — the deployed
  ones on the ventures being torn down, and the idle ones in the system's pool. Same row-removal as a droid wearing
  out (§5): droid rows leave `guild.droids`, nothing is minted; **GP/RP- and conservation-neutral** (a droid is not a
  conserved good), **deterministic** (invariant 9).
- **An in-flight batch is forfeit.** A Syndicate droid batch (§3) whose delivery is bound for a system the guild **no
  longer holds when it would arrive** is **lost** — the droids never materialise, and the credits **and** delivery
  fuel paid up front are **forfeit** (no refund), consistent with the fuel-always-forfeit rule and with the player
  having lost the system. The delivery's fuel was already burned out of the galaxy at buy, so nothing is reversed and
  invariant 1 is untouched.
- **The `droid_components` stock is forfeit as goods.** A lost system's `droid_components` (the §5 maintenance pool)
  go the way of **all** the guild's goods there — forfeit under the existing losing-ground goods rule, no special
  handling.
- **No new notice.** The existing `system_lost` message (`docs/event-log.md` §14) is **widened** to say the guild's
  droids in the system were lost/abandoned too; droids get no event type of their own.

*(**⤳ AS-BUILT 07-11-26 — droids and losing a system (engine + the notice's words).** The ruling above, built. **No new
number.**
- **The hook is `evictSystem`** (`sim/eviction.js`), the one eviction both causes route through (today
  `abandonPrefecture`; the storyteller's later). A new step **2b**, right after the venture closures — which have
  already released every deployed droid back to idle (`releaseDroidsFrom`) — calls **`destroyDroidsIn(guild,
  systemId)`**: every droid of the losing guild whose `systemId` is the lost system leaves `guild.droids`, the key
  omitted when the last one goes, `droidSerial` untouched (ids never reissued). The same row-removal as a §5 death;
  nothing minted, nothing refunded. **Not stranded:** no droid is ever flagged, so the salvage window does not count
  one and neither `recoverStrandedAssets` nor `sweepStrandedAssets` can see one — a rival (or the old owner) claiming
  the fallow system inherits no droid. Only the **losing guild's** droids are touched; another guild's droids cannot
  stand in a system it does not hold.
- **The arrival forfeit** is in `mintDroidBatch` (`sim/tick.js`, `stepArrivals`' droid branch): after the ruled-size
  tripwire, `guildHolds(state, buyer, destinationSystemId)` is asked, and a batch whose destination is no longer held
  **mints nothing** and resolves (it leaves `shipments` like any landed delivery). Nothing is reversed — the credits
  are the Syndicate's and the medium flight's fuel was burned at the buy. Pinned: the arrival tick hashes identically
  to a twin whose shipment was simply deleted. A batch whose system is lost and **re-claimed** before it lands still
  lands — the check is "held at arrival", as the ruling words it.
- **The notice:** `system_lost`'s payload gains `destroyedDroidIds` (sorted, **omitted when none**, so a droidless
  eviction's payload is byte-identical to before); the client's card gains a sentence and a `Droids lost` fact
  (`docs/event-log.md` §14, AS-BUILT — the droid loss). No new event type.
- **Tripwires** (`checkDroids`, `sim/invariants.js`): `droid-never-stranded` (a droid row carrying `stranded`),
  `droid-not-in-a-lost-system` (a droid standing in a system with an open salvage window — an eviction that forgot
  its droids) and `droid-not-in-a-rival-system` (a droid standing in a system another guild holds). The stronger rule —
  "a droid stands only where its guild holds" — is **not** asserted: many hand-built test fixtures place droids in
  systems with no claim row, so it waits on a fixture pass (`docs/roadmap.md` checklist). The one gap that leaves — an
  eviction that strands nothing (so opens no window) and forgets its droids — is pinned by the eviction tests instead.
- **Conservation / neutrality** (invariants 1–2): the eviction with droids hashes identically to the same eviction with
  those droid rows deleted beforehand, bar the notice field — no credit, fuel, GP or RP moves because of a droid. The
  system's `droid_components` go with the pool under the existing goods forfeit, no special handling.
- **No-op:** a batch landing in a held system, and a loss with no droid in it, hash exactly as at 1cfea14 (state and
  every view; `sim/tests/droid-loss-noop-script.js`). **Determinism:** both the droid-destroying abandon and the
  forfeited batch re-run and save/restore byte-identically. Tests: `sim/tests/droid-system-loss.test.js`.)*
