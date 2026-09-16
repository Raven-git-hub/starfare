# Operator adjust -- the dev/steward state levers (design-ahead, RULED 16-09-26)

*A small family of **operator/dev actions** that grant or remove a guild's producible
state -- credits, fuel, goods, and assets -- plus remove a venture. It is a **testbed and
self-host steward tool**, not the storyteller. Every lever is an ordinary engine action:
validated, applied, journaled, and invariant-checked like any other, so it can never leave a
galaxy in a state the tripwires forbid. The repo wins over this doc.*

## 1. What it is (and what it is NOT)

An operator -- running a local rig, a test, or a self-hosted server -- needs to set a guild's
resources by hand: to test a purchase, seed a scenario, or hand-run a beat. This doc rules a
minimal set of actions for that. They add or remove the things the game itself can **produce**:
credits, fuel, goods, and assets (miners/factories today; any future asset kind for free), and
they can tear a venture down.

**This is NOT the storyteller.** The storyteller (design.md sec. 9, Phase 6) is a *director, not
an author*: it "picks when and where pressure lands, and the pressure resolves through existing
systems," and its events "redistribute opportunity, not just delete value." It never reaches in
and sets a field. These operator levers are the same species as the existing dev-scaffold actions
`setSyndicateCommitment` / `setWindowN` -- *"kept for tests, scenarios and the bot"* (design.md).
When the storyteller lands it may **reuse the same primitives underneath**, wrapped as in-world,
audited events (a gifted cache, a seized factory) -- but that is a later slice, and it is the
storyteller's job to make them diegetic, not this tool's.

## 2. The one rule: an adjust keeps the invariants whole

The engine's quantities are conserved, and the tripwires (design.md sec. 15.5) treat a break as
corruption -- a `POST /action` asserts every invariant right after apply and returns a 500 on a
violation. So an operator adjust never just "writes a field." Each does the **conserving
counter-move** its quantity requires, and because each is a normal action it is **journaled and
replayable** (unlike a raw file edit, which vanishes on a replay-from-genesis) and **integer**
(sec. 15.2). A reject leaves state untouched.

## 3. The actions

**AS-BUILT 16-09-26** -- all six actions are BUILT in `sim/actions.js` (validate + apply, exported
constructors) and ride the existing `POST /action` pipeline unchanged; the invariant-safety bar is
`sim/tests/operator-adjust.test.js` (17 tests). Additive only -- no existing action path changed, so
every determinism / persist golden is byte-identical and the suite moved 1,298 -> **1,315 green**.
Each of §3.1--§3.6 below is marked ✅ where it stands.

All take a `guildId` that must name an existing guild; all record their tick; all reject-whole
(state untouched) on any failure. Scalars use a **signed `delta`** -- positive grants, negative
removes -- so one action covers both directions.

### 3.1 `adjustCredits { guildId, delta }` ✅ BUILT

Move credits **against the Syndicate ledger**, exactly as founding does: `guild.credits += delta`,
`syndicate.ledger -= delta`. Net zero, so `expectedCreditTotal` is unchanged and invariant 2
holds. **Reject** a negative `delta` that would drive `guild.credits < 0` (guild credits are
non-negativity-enforced; only the ledger is exempt). `delta` an integer, non-zero.

### 3.2 `adjustFuel { guildId, delta }` ✅ BUILT

The legal hoard, framed as backend production/consumption so it is invisible to the market and
does not perturb the fuel price. Grant: `guild.fuelHoard += delta`, `audit.totalProduced += delta`.
Remove: `guild.fuelHoard += delta` (delta<0), `audit.totalConsumed += -delta`. Either way
invariant 1 (`sum of fuelHoard + deuteriumFuel + reserve + inTransit == totalProduced -
totalConsumed`) stays closed. **Reject** a removal below zero. Targets the **legal** `fuelHoard`,
never contraband `deuteriumFuel` (a contraband lever, if ever wanted, is a separate flag -- not
built here). Integer, non-zero.

### 3.3 `adjustGoods { guildId, systemId, good, delta }` ✅ BUILT

A `(guild, systemId)` stockpile cell, via `addStock(guild, systemId, good, delta)` (`sim/stock.js`).
Goods have **no conservation ledger** (the audit counters are fuel-only), so the only bookkeeping is
to **refresh the `galacticSupply` cache** afterwards (`next.galacticSupply = computeGalacticSupply(next)`,
`sim/supply.js`) so the galactic-supply-consistency invariant passes. **Reject** if the result would
go below zero, if `good` is not a known good, or if `systemId` is not a real system. Integer, non-zero.

### 3.4 `grantAsset { guildId, kind, systemId }` ✅ BUILT

Mint one **idle** machine into `guild.assets`: `{ id, kind, systemId, maintenanceCondition:
ASSET_CONDITION_NEW }`, via `createAsset` (`sim/state.js`). The `id` follows the `sim/assets.js`
scheme `asset_<guildId>_<kind>_NN`, choosing the **next free NN** for that guild+kind (max existing
+ 1) so it is unique and stable. `kind` must satisfy `isAssetKind` (today `miner` / `factory`; a new
kind is covered automatically). `systemId` a real system. Idle -- it attaches to no venture; standing
up a working venture is `establishVenture`'s job (sec. 7), not this. (Removal of an asset is via
`removeAsset`, sec. 3.5 -- `grantAsset` has no negative form; an idle asset is removed by id.)

### 3.5 `removeAsset { guildId, assetId, occupied? }` ✅ BUILT

Remove the named asset. **Always succeeds** (the storyteller ruling), by keeping the state
consistent rather than by refusing:

- **idle** (no venture references it) -> just delete it from `guild.assets`.
- **occupied** (a venture's `assetId` points at it) -> `occupied` decides:
  - **`'detach'`** *(default)* -- set that venture's `assetId = null`, then delete the asset. The
    venture survives, **dormant/unpowered** (an asset-less venture is a legal state -- `checkAssetOccupancy`
    skips `assetId == null`). The build MUST confirm the tick treats an asset-less venture as
    *produces nothing* (it does not deploy a machine) rather than assuming one; if any tick path
    assumes an asset, that is a bug to fix (fail-loud) in this slice, since detach is the default.
  - **`'close'`** -- `applyVentureClosure(next, guild, venture, 'operator', next.tick)` (the shared
    teardown, `sim/licence.js`), then delete the now-idle asset. Both gone; the closure writes its
    `venture_closed` event and clears the node lockout as usual.

**Reject** only if `assetId` names no asset the guild owns.

> **AS-BUILT 16-09-26 -- the detach-production proof, and one deferred decision.** No tick path was
> touched: production (`sim/production.js` `resolveProduction`) and the snapshot NEVER dereference a
> venture's `assetId` -- every read of it in the engine is already null-guarded (`sim/assets.js`,
> `sim/invariants.js`, `sim/snapshot.js`), so a detached venture (`assetId == null`) neither crashes
> the tick nor breaks an invariant. `operator-adjust.test.js` proves it: after a `'detach'`, a full
> tick runs and `checkInvariants` stays clean. So the load-bearing bar -- invariant-safety -- holds
> as ruled, with a clean skip already in place (no `assetId` read to fix). **What this slice does NOT
> do**, and flags rather than invents: make the detached venture actually *produce nothing*. The
> engine's production is deliberately **asset-blind** -- design.md §4 / `sim/assets.js`: "occupying an
> asset changes no game number"; a venture produces from its own `productionRate`, not from a machine
> lookup -- and dozens of existing tests build producing ventures with no `assetId` and rely on it. So
> a detached venture keeps producing at its rate rather than going dormant. Coupling asset-presence to
> production (so detach = unpowered = zero output) is a real, broad new rule that contradicts the
> asset-blind model and would move that whole body of tests; it is a **decision-checklist item** (see
> `docs/roadmap.md`), not something to bolt on inside a steward-tool slice. The invariant tripwires --
> this tool's actual safety net -- are unaffected either way.

### 3.6 `removeVenture { guildId, ventureId, asset? }` ✅ BUILT

Tear a venture down -- the storyteller "destroy" beat -- via the shared `applyVentureClosure`
(cause `'operator'`). `asset` decides its machine's fate:

- **`'keep'`** *(default)* -- close the venture; its asset **drops to idle** inventory (closure frees
  it; nothing to do). Venture gone, machine kept.
- **`'remove'`** -- close the venture **and** delete its asset (same end state as `removeAsset` `'close'`,
  driven from the venture side).

**Reject** if `ventureId` names no venture the guild owns. This action **removes** ventures only;
it does not **create** them -- a working venture needs a site/asset/type/rate and that is
`establishVenture` (sec. 7).

## 4. The removal matrix (the four operator intents)

The asset<->venture pair has two entities; a removal can touch each independently. Three combinations
are invariant-safe and are the three modes above:

| Intent | Action | Result |
|---|---|---|
| Detach -- asset gone, venture idles | `removeAsset` `'detach'` | venture dormant (`assetId=null`), asset removed |
| Cascade -- both gone | `removeAsset` `'close'` *or* `removeVenture` `'remove'` | venture closed, asset removed |
| Destroy venture, keep machine | `removeVenture` `'keep'` | venture closed, asset drops to idle |

The **fourth** intent -- "destroy the asset but leave the venture untouched" -- is deliberately NOT
offered, because "untouched" means leaving `venture.assetId` pointing at a machine that no longer
exists: a **dangling reference** that `checkAssetOccupancy` treats as corruption (the engine 500s on
the next check). Its *fiction* -- "the machine is destroyed but the venture still exists" -- is exactly
what **detach** delivers, with the pointer correctly nulled instead of aimed at a corpse. So it folds
into `'detach'`; a genuinely dangling state is not a feature and would require carving a hole in the
occupancy invariant, which this tool does not do.

## 5. Exposure -- operator surface, not a player affordance

**AS-BUILT 16-09-26** -- the operator surface is BUILT: six `tools/admin.js` subcommands
(`adjust-credits`, `adjust-fuel`, `adjust-goods`, `grant-asset`, `remove-asset`, `remove-venture`),
one per action, over the existing `act()` helper, with readable flags (`--guild`, `--delta`,
`--system`, `--good`, `--kind`, `--asset`, `--venture`, and the two-valued `--close` / `--remove-asset`).
A signed `--delta` (positive grants, negative removes) covers both directions of the scalar levers; a
refused action exits `1`, per the file's convention. The `--help` table lists them. The pure
flags->action mapping (`adjustActionFor`) is unit-tested in `tools/admin.test.js` (arg-parsing +
the action object each subcommand builds), as the other commands are. **No new HTTP endpoint** -- the
levers ride `POST /action`. NOTE on naming: the doc's §5 example spelled the credits lever
`grant-credits`; the CLI ships it as `adjust-credits` (matching the `adjustCredits` action, and honest
about the signed delta doing both grant and remove) -- the removal example `remove-asset` is unchanged.

These are ordinary actions in `sim/actions.js` (validate + apply), so they ride the existing
`POST /action` pipeline and are **journaled and invariant-checked for free** -- the same channel and
posture as `setSyndicateCommitment` / `setWindowN`. The **operator surface is `tools/admin.js`**: a
new subcommand set (over the existing `act()` helper) -- the player client never surfaces them. On the
dev rig `POST /action` is open and **Cloudflare Access is the external gate**; real per-role auth that
would formally fence operator actions off from players is Phase 3 (the same deferral the existing
scaffold actions carry). No new endpoint is required; the levers are the actions plus their CLI.

## 6. Failure modes (hunted on paper -- working practice #7)

- **Below-zero removal** -- credits, fuel, or a goods cell driven negative -> reject-whole, naming the
  shortfall. (The Syndicate ledger is the one credits store allowed to go negative, exactly as
  founding leaves it.)
- **Unknown target** -- a `guildId`, `systemId`, `good`, `assetId`, `ventureId`, or asset `kind` that
  does not exist -> reject-whole. Never mint a placeless or unknown thing.
- **No-op** -- a zero `delta` is refused (nothing to record); an empty action is refused.
- **Determinism / replay** -- every lever is a journaled action recording its tick, so a
  replay-from-genesis reproduces it (invariant 9). A raw state-file edit does not -- which is *why*
  these are actions, not an `/admin` file poke.
- **Asset id collisions** -- `grantAsset` picks max-existing-NN + 1 for the guild+kind, so a granted id
  never collides with a starter or a prior grant, and stays lexicographically ordered.
- **`galacticSupply` staleness after a goods adjust** -- refreshed in the same apply, so the
  consistency invariant sees the cache and the recompute agree (the founding precedent).
- **Detach vs. asset-less production** -- an asset-less venture is invariant-legal; the build proves the
  tick produces nothing for it rather than assuming a machine (sec. 3.5).
- **Occupied-asset removal** -- never leaves a dangling `assetId`; `'detach'` nulls it, `'close'` removes
  the venture through the shared closure.

## 7. Out of scope

- **Creating ventures** -- `establishVenture` is the game's own path (site + asset + type + rate). This
  tool grants an idle asset and removes ventures; it does not stand one up.
- **Owned transports / vehicles** -- guilds owning, building/buying, and flying transports on missions
  is wanted (they will live on `guild.vehicles`, already a field), but the entity, its build/buy paths,
  and missions are their **own** design+build slice -- and its seam with the cargo-space hauler is real
  design work. When the transport asset kind exists it is covered by `grantAsset`/`removeAsset` for
  free; nothing here builds it.
- **The storyteller** -- Phase 6, a director (design.md sec. 9); it may reuse these primitives later as
  in-world events, but it is not this slice.
- **Contraband fuel, per-role auth** -- the fuel lever targets the legal hoard only; Phase-3 auth is the
  real operator/player fence. Both flagged, neither built.
