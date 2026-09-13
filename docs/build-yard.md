# The Build Yard (Dockyard) — the Tier-4 construct engine (roadmap 2.1b)

**Design-ahead, 13-09-26 (the reserved 2.1 asset-economy / build-yard thread).** The repo
wins over this file. Nothing here is built yet — this is the settled spec the 2.1b build-yard
engine slice reads. Recipe bills: `asset-recipes.md`. Asset model + occupancy: `design.md §4`.
The mechanical precedent throughout is the **deuterium refinery** (`design.md §1.4`,
`sim/actions.js` `establishDeuteriumRefinery`) — a recipe-less factory venture with a dedicated
tick step. Every number here is `[FIRST-CUT]` → `docs/phase-1-tuning.md`.

## 0. What it is, in one line
A **Dockyard** is a factory asset in a **construct (Tier-4) mode**, carrying a **commission
queue** that turns modules (drawn from its own system's stockpile) into finished **assets** that
land idle in the guild's inventory. It closes the loop: raw -> refined -> modules -> **(dockyard)**
-> a miner/factory idle at that system (shown in the OPERATIONS hub's IDLE section).

## 1. The Tier-4 recipe catalog
Tier-3 module recipes already live in `recipes.js` and output a *good*. A Tier-4 recipe is
different: its output is an **asset**, not a stockpile good, so it is NOT a `recipes.js` row. The
build encodes the `asset-recipes.md` bills as a machine-readable catalog — **`sim/asset-recipes.js`**,
`assetKind -> { module: qty }` — lifting quantities straight from the doc (all `[FIRST-CUT]`).
**Buildable this slice: miner + factory** (their entities exist). Ships/droids/installations have
bills in the doc but no buildable entity yet — deferred to their own slices.
- Miner = 2 chassis, reactor_housing, photovoltaic_array, power_cells, control_module,
  extraction_head, cargo_module, cargo_handling_system, defence_system.
- Factory = 3 chassis, reactor_housing, 2 photovoltaic_array, 2 power_cells, control_module,
  2 fabrication_line, sensor_suite, cargo_handling_system, defence_system.

## 2. The Dockyard entity + establish
A Dockyard is a **factory asset on a settlement slot** in construct mode, established the way the
deuterium refinery is — a dedicated establish path, chosen by picking **"Tier 4"** at deploy (no
per-recipe pick; the yard builds any buildable kind via its queue). It reuses the **three occupancy
gates** (vacant slot; a named idle **factory** asset **in this system**, per `design.md §4`; the
guild holds the system). It takes **no `recipeId`** and carries a **queue** instead.
- **Identity:** a new predicate `isDockyard(v)` (its venture type / a construct-mode marker), the
  analogue of `isDeuteriumMine`. The rate resolver skips it (no `recipeId`+`productionRate`); a
  dedicated **build step** advances its queue.
- **No licence, no equity, no commitment** (roadmap 2.1). Its standing effect is §5, not a licence.

## 3. The commission-and-queue + build lifecycle
- **Commission** (`commissionBuild`): append an `assetKind` to the dockyard's queue. Validates the
  venture is a dockyard the guild owns and the kind is buildable. **No cost at commission.**
- **Queue:** single active build, **strict FIFO, no skip-ahead**, capped at **`MAX_QUEUE` (~5,
  `[FIRST-CUT]`)** — a 6th commission is refused loudly.
- **Reserve-and-wait build step (new tick step):**
  1. The **head** commission *waits* until every module in its bill is present in the **dockyard's
     own system stockpile** (production is local, so consumption is local).
  2. When all present, **consume the whole bill atomically** and start the build — count down
     **`BUILD_TICKS[assetKind]`** (fixed per kind, `[FIRST-CUT]`; ladder: light transport shortest
     -> outpost / deep-scanner longest). **No reservation while waiting** — the modules stay
     spendable until the instant the build starts (a build can be starved; intended).
  3. At 0, **emit one asset idle at the dockyard's system** (into `guild.assets`) and advance.
- **Cancel** (`cancelCommission`): remove any commission that **has not started** — a pending one,
  or the head still waiting for parts (nothing consumed -> free). A build that **has started**
  (parts consumed, ticking) is stopped only by **tearing down the dockyard**.
- **Teardown = all lost:** decommissioning a dockyard discards its queue and any in-progress build;
  consumed modules do not return.

## 4. Outputs, ids, cost, landing
- **Outputs this slice:** miner + factory. **Cost:** parts only (modules). Syndicate-commission for
  credits is the separate 2.1d slice; the open market is 2.1e.
- **Built-asset ids:** the starter grant uses `asset_<guild>_<kind>_01..15`. Built assets continue
  a **per-(guild,kind) counter beyond the starter range**, so ids stay stable, unique, and
  deterministic (invariant 9) with no collision against the founding gift.
- **Landing:** the emitted asset is idle at the dockyard's `systemId` (design.md §4) -> appears in
  the OPERATIONS hub IDLE section (`operations-hub.md §5`), ready to deploy.

## 5. GP/RP — the Dockyard is a full Tier-4 venture (RULED 13-09-26)
The dockyard interacts with the mean-line economy as the **Tier-4 counterpart of the deuterium
mine**, but not identically — the deuterium mine's 0-GP is its *unique* advantage:

- **GP: a Tier-4 gain (a size increase).** Unlike the deuterium mine (which is *skipped* -> 0 GP),
  a dockyard is a **special-COUNT**: `guildPoints` counts it at **Tier 4** (the existing
  `TIER_WEIGHT[4]`, `[FIRST-CUT]`), the mirror of the deuterium special-skip and keyed the same way
  (`isDockyard(v)`). A dockyard produces no *good*, so without this it would score 0 by default; the
  explicit count states the ruled intent. It reflects real footprint and **raises the guild's bar**.
- **RP: a held Tier-4 bump.** On establish the dockyard venture is granted a **Tier-4 RP signing
  bump** (`[FIRST-CUT]`, **below** the deuterium mine's 1000), reusing the deuterium bump machinery
  (`signingBump`/`ventureTierWeight` special-cased on `isDockyard`), landing on `venture.reputation`
  / `guildReputation` so `checkGuildReputationSum` + `checkReputationBand` cover it. **Held while it
  stands, removed on teardown** (like all venture RP) -> **not farmable** (you can't establish/tear
  down to bank it). **NO per-cycle accrual** — per-cycle is the deuterium mine's reward for *ongoing
  contribution*; a dockyard doesn't contribute per cycle, it *exists*, so its reputation is a fixed
  standing value that offsets its standing GP.
- **The tuning invariant (not a lone number):** the GP weight and the RP bump are set **together**
  so the net benefit orders **deuterium mine (0 GP + big RP) > dockyard (Tier-4 GP + Tier-4 RP,
  net-positive) > a Tier-1/2/3 production venture**. Recorded as the relation the `[FIRST-CUT]`
  numbers must satisfy, so none is invented in isolation.
- **No double-count:** this rewards the dockyard's *existence* (holding Tier-4 capability). The
  miners/factories it builds earn their **own** RP (once deployed + licensed) and GP (footprint) —
  a separate channel.

## 6. Failure modes logged on paper (survival rule 7)
- **Head-of-queue stall** — bill never arrives -> the queue sits. Intended, escapable by cancelling
  the (unstarted) head; no auto-skip.
- **Starvation** — no reservation, so the guild can spend/sell the modules a waiting head needs.
  Intended (the cost of not reserving).
- **Teardown / cancel must not leak goods** — consumed modules are *gone*, never refunded or
  duplicated; non-negativity (invariant 3) holds because consume is all-or-nothing.
- **RP bump not farmable** — held on the venture, removed on teardown; establish/teardown loops bank
  nothing.
- **Determinism (invariant 9)** — one active build per dockyard; multiple dockyards processed in a
  stable order; queue is an ordered list; fixed scenario builds byte-identically.
- **GP/RP sums stay exact** — the dockyard's Tier-4 GP count and RP bump keep `checkGuildReputationSum`
  and the galactic-supply/GP derivations consistent.

## 7. Suggested slicing (readable at merge)
1. **Engine — the Tier-4 build core.** `sim/asset-recipes.js` catalog; the dockyard establish path;
   `commissionBuild` / `cancelCommission`; the reserve-and-wait build step; emit miner/factory
   idle-at-system; teardown drops the queue. Dockyard is **GP/RP-neutral in this slice** (0/0 by the
   recipe-less default) — no points change yet.
2. **Points — the Tier-4 GP/RP treatment (§5).** `isDockyard` special-COUNT for GP; the held Tier-4
   RP bump; the net-benefit ordering tuned in `phase-1-tuning.md`. Its own slice because it touches a
   different module (`points.js`/`licence.js`/mean line) and carries the tuning invariant.
3. **Client — the commission menu + queue** in the OPERATIONS hub (a later client slice).

Then, out of this arc: Syndicate-commission for credits (2.1d), the open market (2.1e), and the
ship/droid/installation outputs (their entity slices).
