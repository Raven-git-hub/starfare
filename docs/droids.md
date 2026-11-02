# Droids — the licence payoff (roadmap 2.6)

**Design model. RULED 02-11-26** (design pass against tip `5e0bed2`, suite green), the
computational contract for the droid slice. `design.md` §4 "Droids" holds the narrative and the
headline rulings and points here; this file is the model the build reads. Numbers are
`[FIRST-CUT]` and live in `docs/phase-1-tuning.md` §Droids — this file names them for orientation
but that file is their source of truth. Nothing here is built yet.

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
- `assignedToVentureId` — nullable; the venture it staffs, or null when idle.
- `condition` — a stored fraction in `(0, 1]`, decaying while deployed (§5). **Every mutation
  records its tick** (§15.2).
- `deployedAtTick` — set on assignment; the anchor decay reads from.

**State is derived** (invariant 5): *deployed* iff a venture references it, *idle* otherwise.
Ownership is containment (the guild whose array holds the row). **Assignment** is an action: an
idle droid → a venture, **same-system** and **instant** (the asset Gate-2 shape); unassign returns
it to idle. A venture holds at most **CAP** droids (`[FIRST-CUT]` 20); a 21st is refused. Idle
droids **do not decay** (§4) and carry no storage cost this slice (deferred, §8).

## 2. The buff — one knob, two emission paths

Working droids (`condition > 0`) multiply a venture's production **speed** by `1 + boost(n)`, `n` =
the venture's working droids:

    boost(n) = BOOST_MAX × (n / CAP) ^ p

Mild-convex (`p` slightly above 1), concentration rewarded. `[FIRST-CUT]` `BOOST_MAX = 1.0` (a full
complement **doubles** production speed, ×2), `p = 1.5`, `CAP = 20`. **Source-blind**: a working
guild droid boosts exactly as much as a working Syndicate droid — source changes only durability,
cost and maintenance, never the boost.

Applied in the production model's native form (`productionRate` is inert for a timed factory):

- **Continuous** (Tier 1/2): effective `rate = baseline × (1 + boost)`, emitted through a
  per-venture **fractional accumulator** so goods stay integer (§15.2) and deterministic. Baseline
  is the droidless baseline (`baselineRateFor`), never a throttled `productionRate`.
- **Timed** (Tier 3/4): each tick advances the unit's progress by `(1 + boost)` instead of 1, on
  the `unitTicksRemaining` accumulator. `TICKS_PER_UNIT` is **untouched**, so units stay whole and
  `assertWholeWeeklyOutput` stays green.

Applied in the tick (`stepProduction`); the client renders the rate and computes no game number.

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
  market-independent tariff** (`[FIRST-CUT]` ~12–15k cr — a special institutional product, not a
  market good, so NOT an `INSTALLATION_KIT_BUY_BASELINE` floor). Durability **2 weeks** raw →
  **4 weeks** maintained. **Higher maintenance demand** (the "red tape": `[FIRST-CUT]` twice the
  `droid_components`/week of a guild droid). May be assigned **only to a licensed venture** (§4).

Both sources mint one idle droid row, `source`-stamped, through one helper.

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
move — the `rebanded-goods-delta.test.js` template).

**Out (§7):** all failure/illegality mechanics, the security role, idle-storage cost, in-place
repair, miner/factory condition, the throttle-below rate cap, anything rival-dependent.

## 9. Invariants & proof obligations

- **GP/RP-neutrality:** buying, building, assigning, unassigning or replacing a droid moves no GP,
  no mean-line modifier, no fuel entitlement, no licence fee/commitment.
- **Boost correctness:** effective output = droidless baseline × `(1 + boost(n))` for working
  droids, to the ruled curve; zero droids ⇒ exactly baseline.
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
1 `droid_components` = 1 droid-week · **Syndicate** droid life 2 wk / 4 wk, flat tariff ~12–15k cr,
upkeep 2 `droid_components` = 1 droid-week · `droidComponentReserve` default 0 · `drive_module` →
sub-tier **3-2**, `droid_components` → sub-tier **3-2** (each sets the module's price band **and**
its production timer — 30 ticks/unit, y = 336/week).

## 12. Build order (vertical slices)

1. **Engine** — the entity + both acquire paths (guild dockyard build, Syndicate flat-tariff buy) +
   assignment (licence-gated for Syndicate) + the boost in `stepProduction` (both forms) + monotonic
   decay + destroy/replace at end-of-life + the `droid_components` maintenance pool; plus the
   sub-tier classification of `drive_module` / `droid_components` and the lean droid bill lifted into
   the FINAL table + `sim/asset-recipes.js` (one commit), with the golden re-pin + fresh galaxy
   proven. All §9 tripwires. **No failure mechanism** (§7).
2. **Client** — buy / build / assign / unassign + the boosted-rate and coverage display; renders the
   snapshot, computes no game number.

Each slice: suite green + count, the §9 tripwires, "do NOT push — open a PR."
