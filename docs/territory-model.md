# Territory & Deployment Model *(RULED 29-09-26 — design-ahead, NOT BUILT)*

The authoritative model for the **spatial territory layer** and the **asset-deployment
pipeline** that plants the structures that layer is made of. It is the companion to
`design.md` §2 "Territory and Routes" / "The Prefecture" and §4 "The Guild Outpost", the
way `transport-model.md` is the companion to the transport sections — narrative and the
ruling headline live in `design.md`; the computational model lives here.

**Status.** Design-ahead. NOT BUILT, and sequenced behind the **cross-system asset
ferry** — which, as §5 shows, *is* the deployment pipeline this document specifies, so
building the pipeline is what unblocks claims (the Prefecture, `design.md` §2). Numbers
here marked `[FIRST-CUT]` are placeholders for the tuner (`phase-1-tuning.md`) / the
decision checklist, never fixed here (working rule 5). *(29-09-26: §5's first rung — the deployable
outpost kit and a manual outpost deploy — is now BUILT; see the AS-BUILT note at the end of §5. 30-09-26:
its second rung — the deploy as a dispatch's on-arrival action, with the arrival re-validation and the
retreat rule — is BUILT too (the slice-2 AS-BUILT note). Everything else here stays design-ahead.)*

---

## 1. Two layers — the claim, and the spatial control map

"Control" names two orthogonal things, and conflating them is the trap this document
exists to avoid:

- **The claim (logical, system-scoped, BUILT).** `state.claims` + `sim/claims.js` answer
  "does guild G hold system S?" — a row `{ claimId, ownerGuildId, landmarkId,
  landmarkKind, claimedAtTick, contested }`, one per held system or single-hex structure.
  This is what gates ventures (Gate 3, `design.md` §4), raises the GP bar
  (`points-and-reputation.md`), and enforces exclusivity. **"Claimed vs unclaimed system"
  lives entirely here.** Nothing new is stored to make it work.
- **The spatial control map (new — this document).** A per-hex classification —
  **controlled / semi-controlled / uncontrolled** — used by the *detection* layer (2.5)
  and, later, transit legibility. It is **derived**, never stored, and recomputed from
  `state.claims` whenever a claim changes. It authors no new state.

Everything below §1 is the second layer. It is **design-ahead for detection (2.5)**: no
current system reads it, so it is specified now (while settled) and built when a consumer
exists — not before.

## 2. The control footprint & the first-settled rule

**The footprint.** A **system** controls a **7-hex footprint** — its own hex plus the ring
of 6 (`systemClaimRadius = 1`, already set in the generator and rendered by the client's
`computeTerritoryMap`). A deployed **outpost / toll gate / deep-scan array** controls only
its **single** hex. A transport sitting idle in open space controls **nothing** (it is not
infrastructure).

**Overlap is kept as a feature, resolved by claim age.** Systems are *not* spaced to keep
footprints apart (§6 covers the one exception, starters), so two claimed systems can be
close enough that their footprints overlap. That is deliberate — settling next to a rival
to shave their territory is a real play. A contested hex resolves by **seniority**:

- A hex within `claimRadius` of one or more claimed systems is controlled by the claim
  with the **oldest `claimedAtTick`** among them.
- **Own-centre override:** a system always holds its own centre hex, regardless of
  seniority (it is distance 0 to itself). So the *newer* neighbour keeps its centre and the
  hexes the senior does not already hold — senior takes the majority, junior the remainder.
- **Tie-break:** equal `claimedAtTick` (two guilds settling the same tick) → the lower
  `claimId`, the stable-ordering convention (invariant 9).
- **Derived, recompute on change.** Un-settling the senior (its Prefecture removed, its
  claim row gone) recomputes the map: the junior — now senior/sole — expands to its full
  footprint, and the old senior's system reverts to **unclaimed** (§4). No stored state to
  reconcile.

This is the same "earliest valid wins" spirit as the roadmap's first-valid-wins contest
stub and Gate 3's earliest-established tie-break.

## 3. Semi-controlled space — a detection zone, not a safe zone

Semi-control is a **detection** flavour, explicitly **not** a transit-safety one — that
keeps it clear of the Toll-Path ruling (`design.md` §2), whose whole payoff is collapsing
interruption checks to a **single roll at the gate**, never per-hex. Higher detection in a
guild's traffic corridors makes them *indirectly* safer (things are spotted) without
reintroducing per-hex safety maths.

- **Corridors form only between a guild's OWN two nodes** whose auras overlap. The
  semi-controlled region is the band between the two control cores bounded by their
  connecting tangents — a **trunk** between two systems (fat) or a **feeder** out to an
  outpost (thin). It is rendered as an **outline only** (extremity hex borders), interior
  left blank so the map stays readable.
- **No corridor across a foreign boundary.** Between two rivals, or toward an unclaimed
  system, no corridor forms. (An unclaimed system is not a controlling node, so it never
  participates.)
- **Aura radii `[FIRST-CUT]`** — system **5**, outpost **3**, toll gate / deep scan **2**
  hexes (→ `phase-1-tuning.md` / decision checklist).

## 4. Systems — claimed, unclaimed, and the Prefecture

**Claimed vs unclaimed is just the claim row.** A system is *claimed* iff a
`landmarkKind: 'system'` claim names it — the founding home claim, or a Prefecture's. The
map's `claimRadius` render and Gate 3 both key off that one row, so nothing new is stored.

**The Prefecture is the flag** (`design.md` §2, RULED 29-09-26). It is a **ground asset**
placed on a **settlement slot**; **one anywhere in a system claims the whole system and
every node in it**. It has **no range** — it can be planted in any system, however
distant (range requirements are a *space*-asset concern, §5). Planting it writes the one
claim row; tearing it down removes it and evicts the guild's machines in that system into
**orbital limbo** for pickup (the §5 lease-recovery path — see the pickup lane, §5). The
**home system is exempt** (a guild can never be evicted from its homeworld).

**Settling in an unclaimed system — squatting — is a RULED DIRECTION, deferred.** Today
Gate 3 refuses establishment in **any** system a guild does not hold, unclaimed included.
The intent is to carve unclaimed systems out of that block: settling on unclaimed land
becomes **possible but illegal** — a high-risk, high-reward frontier play, with the
jeopardy of being caught (storyteller / a rival's scan) and the counter-play of a claiming
guild discovering and reporting a squatter. **Not built, and not to be opened until its
punishment exists:** detection, penalties and the report/bounty are 2.5 / Phase-6
machinery, and unclaimed mining with no jeopardy would just be free mining. Until then
**Gate 3 stays hard.** (Rival-held land stays leasing's job — a contract, not squatting.)

## 5. The deployment pipeline — the cross-system asset ferry

Deploying an asset is: **haul a Tier-4 kit on a transport to a target, and place it on
arrival.** This is the deferred cross-system ferry (`design.md` §4), and building it is
what unblocks the Prefecture. Kits are already cargo-modelled
(`ASSET_CARGO_VOLUME = HEAVY_HOLD`, `design.md` §4), so a kit rides as cargo and deploy
consumes it — no bespoke payload path, and no mutation of an existing asset's immutable
`systemId` (a fresh structure is placed).

**The player flow.** An idle deployable asset in the Operations panel carries a **Manage**
button → a Manage popup (like the dispatch popup) with a **Deploy** action → a galaxy-map
picker (like BUILD ROUTE mode). The engine highlights the hexes in legal range; the player
picks a hex (deploy → confirm, then a top-left **confirm deployment**), returns to the
popup, picks the **heavy transport** to carry it (fuel + travel-time quoted to the hex),
and clicks **Deploy**. **On arrival, deployment is instant — no build time** (the kit was
built earlier at the dockyard).

**Two lanes.**

- **Space infrastructure** — outpost, toll gate, deep-scan array. Deploy to a **bare hex**
  within range; **instant, usable** on arrival.
- **Ground assets** — miner, factory, **and the Prefecture**. Haul to a **system**; the
  asset lands in that **system's idle list**; a **second step** deploys it onto a node (the
  existing establish flow). For the Prefecture, that second step onto a settlement slot **is
  the claim action**, and is exempt from Gate 3 (it is what creates the hold), so a system's
  idle list must be able to hold an inbound Prefecture for a system the guild does not yet own.

**Deploy ranges `[FIRST-CUT]`** (space assets only; ground assets have none — narratively,
space assets need supply runs) — outpost ≤ **10** hexes from a **system**; toll gate ≤
**10** from a **system OR outpost**; deep scan ≤ **5** from a **system or outpost** (→
`phase-1-tuning.md` / decision checklist; the gate/outpost figures mirror `design.md` §2).

**Painting the range (the snapshot contract).** The engine tells the client WHERE a
deploy is legal; the client never computes that itself (§18 — the range distance is a game
number). Each guild row carries a lane-keyed `deployRange`. This slice fills the one built
lane: `deployRange.outpost = { radius, anchors }`, where `radius` is `OUTPOST_DEPLOY_RANGE`
and `anchors` is the ids of the systems the guild holds (`heldSystemIds`, sorted — invariant
9), the same set the range is measured to. **Omit-when-empty:** a guild that holds no system
carries no `deployRange` (it can deploy nowhere). The client draws the union of the
`hexDistance ≤ radius` disks around the anchor coordinates it ALREADY renders, and the
structures it already draws on top read as occupied — so the paint is accurate to everything
the client can know. It is guidance, not a verdict: **`deployCheck` re-run at pick-confirm,
at dispatch, and again at arrival (above) is the sole authority on legality** — the only thing
that can catch a rival taking the hex, or the anchor going, between polls. That re-check is
PERMANENT, not a stop-gap; it is the ruled transport-planner split (the client estimates, the
engine is authoritative at apply). Lane-keyed so `tollGate` and `deepScan` slot in additively
when their lanes are built (their anchors add outposts) — no reshape.

**The deploy map (client, as designed — RULED 01-10-26).** The built outpost lane is deployed
from the map, **reusing the transport route builder (planning mode) wholesale** — same chrome, same
formatting, the same components (`#plan-chip`, the planning banner, the waypoint panel, the
`hexesInRadius` territory paint): the deploy map introduces NO new visual language, it re-skins the
one that exists. The flow is **craft-initiated** — the `outpost_kit` rides a specific heavy, so there
is no separate "pick a carrier" step: from the Dispatch popup of a heavy that carries a kit, a
**Deploy** action opens the galaxy map at **4× zoom**, centred on the craft. The legal range is drawn
as a **dashed outer-border RING only** — not every hex filled — the boundary of the union of the
guild's `deployRange` reaches (every system it holds). The player clicks a **bare hex inside the
ring** and an on-tile **DEPLOY / CANCEL** chip appears, exactly as the route builder's **ADD** chip
does (`#plan-chip`). It is the route builder reduced to **one leg with the deploy action appended
automatically**: **DEPLOY** confirms that single leg and dispatches — there is no multi-waypoint and
no separate FINALISE beat, the chip's DEPLOY *is* the finalise — and **CANCEL** clears the selection.
While a hex is selected, clicking another hex does nothing (CANCEL first). On arrival the engine
deploys or retreats (the `deployFailed` rule above), surfaced on the Operations · In-Transit strip
like `laneEnded`. **Arrow-key panning** is added to this map mode (in the shared planning mode, so the
route builder gains it too): clicks place the target so they cannot also recentre the view — arrow
keys close that long-standing click-to-recentre gap (this supersedes the "needs arrow-key pan (or
restored click-to-centre)" note below). This
paragraph is the as-designed client flow for the outpost lane and supersedes the generic "Manage popup
→ pick a transport" wording of **The player flow** above, which describes the later, fuller vision.

**Route legality is target-only.** The *path* is legal anywhere — open space is not
illegal, it is merely less safe / tolled — so there is nothing to "route around." Only the
**target** is validated. The player therefore **builds the route themselves** (reusing the
existing planner, not a forked auto-router), which is what gives them control over legal
exposure — crossing rival airspace or a toll route can incur a fine (2.3), so the choice is
theirs to make.

**Arrival re-validates the target** — the same dual-check `sim/claims.js` exists for
(valid at dispatch AND at arrival), hooked to the named "resolve a scheduled arrival" seam
(`design.md` §15). A kit can arrive to find the hex taken, the system claimed by a rival
first, or its range-anchor gone.

**On a failed arrival the craft RETREATS** *(RULED 30-09-26 — revises the earlier "the craft goes
idle at the hex")*. A craft left idle on a hex it could not deploy on may be sitting in a rival's
space — which can draw a fine (2.3) — so it pulls back instead. Let `T` be the target hex and `S` the
**nearest system the guild holds** (always exists — a guild can never lose its homeworld, §4). The
craft snaps **`DEPLOY_RETREAT_HEXES`** (`[FIRST-CUT]` **3**, `phase-1-tuning.md` "Territory &
deployment") hexes from `T` toward `S` — the cube-round of the point `DEPLOY_RETREAT_HEXES /
hexDistance(T, S)` of the way along the line, so integer, deterministic and replay-identical — and is
**clamped so it never overshoots**: if `S` is that close or closer, it lands **at `S`**, parked at the
system. The **kit stays aboard** and the craft is **idle** there. It is a forced repositioning, **not
travel** — no fuel, no time, no toll or fine, no supply move — so nothing is lost but the trip and its
non-refundable fuel (`transport-model.md` §11.3). The craft is flagged **`deployFailed = { reason,
tick }`** (`occupied` / `out-of-range`), the `laneEnded` pattern, so the player can see why; the next
dispatch clears it. *(Deferred, not built: guaranteeing the landing hex is not itself rival or contested
space. Pulling toward the nearest held system is the ruled behaviour; refining the landing needs the
§1–§3 control map, and lands with it.)*

**The reverse — pickup from orbit.** An evicted or torn-down asset sits in **orbital limbo**
around its planet (`design.md` §5). Recovering it is an ordinary transport haul: fly to the
limbo coordinates, load the asset, haul it home — the deploy pipeline run backwards. *(Built
with the eviction / limbo slice, not this one.)*

**Client note.** BUILD ROUTE mode currently loses map panning (click places waypoints, so
it cannot also recentre). The deploy-map picker needs **arrow-key pan** (or restored
click-to-centre) added alongside it. *(Small client build detail, not a design blocker.)* *(⤳ BUILT 01-10-26:
arrow-key pan in the shared planning mode, client slice 2 below.)*

**AS-BUILT — slice 1, the deployable good + outpost deploy (29-09-26; engine + operator CLI, no client).**
Built to this section, no design change. The kit is a **deployable good** — `outpost_kit`, in
`DEPLOYABLE_GOODS` (`sim/resources.js`), deliberately outside `STOCKPILE_GOODS`, so it is never priced,
never in Galactic Supply, and legal only in a craft's hold. It sizes to `ASSET_CARGO_VOLUME`, so only a heavy
carries one, one at a time. An operator lever, `grantKit`, mints one into an empty heavy (the test seam — the
dockyard and founding-grant sources are later rungs). `deployAsset` is the **space lane** for the outpost: a
craft idle on a bare, unoccupied hex within `OUTPOST_DEPLOY_RANGE` (the ruled `[FIRST-CUT]` 10) of a system
its guild holds places an Outpost there — instantly, through the same mint path as `spawnOutpost` — anchored
to the **nearest** held system (a tie → the lower system id), and the kit is consumed. It is a **standalone
manual action on a craft that has already arrived**: folding it into the dispatch as an on-arrival step, and
so the arrival re-validation above, is the next rung. A kit never rides a repeating lane and is never named
by a manifest. Not built: the client flow, the other kinds, the ground lane, pickup from orbit, and the §1–§3
control layer (a deployed Outpost writes no claim row).

**AS-BUILT — slice 2, auto-deploy on arrival + the retreat rule (30-09-26; engine + operator CLI, no client).**
Built to this section as revised above. A `dispatchRouteWithActions` waypoint may carry a second action type,
`{ type: 'deploy', kind }` (`transport-model.md` §11.1's type tag — `dock` was the first). The dispatch refuses
it whole unless the kind has a kit, it is on the **final** waypoint, that waypoint is a **bare hex**, and — the
up-front pre-check, so a doomed trip is never flown — the deploy would succeed **now**: exactly one matching kit
and nothing else aboard, the hex free, within `OUTPOST_DEPLOY_RANGE` of a held system. It needs no store at its
stop (it is exempt from `routeStoreAt`), and it rides a one-shot route only (a kit never rides a repeating lane —
slice 1's gate, unchanged). A saved route never carries one. On arrival, `resolveRouteArrival` re-validates
through **the one deploy rule** slice 1's manual `deployAsset` now shares (`deployCheck`) and deploys through the
**one deploy apply** (`deployKit`) — one implementation, two triggers. On failure the craft retreats (above),
the geometry being `hexStepToward` (`sim/transport.js`), and is flagged `deployFailed`. **One provisional edge,
on the decision checklist:** near the galaxy's rim the 3-hex step can fall just off the lattice (9 system /
in-range-hex pairs on the live seed), where a craft cannot be left; the build then steps on along the same line
to the first on-lattice hex (at worst `S`). The manual `deployAsset` is unchanged. Not built: the client (the
Manage popup, the deploy-map picker, the painted range, the `deployFailed` message), the retreat-landing
refinement above, the other kinds, and the kit sources.

**AS-BUILT — slice 3, the deploy range in the snapshot (29-09-26; engine + snapshot, no client).**
Built to "Painting the range" above, no design change. Each guild row carries `deployRange = { outpost: { radius,
anchors } }` (`deployRangeFor`, `sim/snapshot.js`): `radius` is `OUTPOST_DEPLOY_RANGE` imported from the engine, and
`anchors` is `heldSystemIds` verbatim — no re-sort, no copy-and-sort. Omitted when the guild holds no system. Pure
derived telemetry: no serialized byte, no determinism hash, and no deploy rule touched — `deployCheck` stays the
authority. A tripwire in `sim/tests/deploy-range.test.js` fails loudly if the field ever drifts from `heldSystemIds`
or the constant. Not built: the paint itself (the client, next), and the `tollGate` / `deepScan` lanes.

**AS-BUILT — client slice 2, the deploy map + on-tile DEPLOY (01-10-26; `client/game.html` only, no engine).**
Built to "The deploy map" above, no design change. A heavy carrying an `outpost_kit` gets a **Deploy** button in its
Dispatch popup, beside Plan Route; it opens the route builder's planning mode in a deploy variant at 4×, centred on
the craft. The legal range is the player guild row's `deployRange.outpost`, drawn as the dashed outer border of the
union of the anchors' `hexesInRadius` disks (the radius is the engine's). The client refuses a click on a hex that
is not bare (a system, a waystation, the Citadel's hex, any guild's Outpost), is off the disc, or is outside the
ring the way the planner refuses a bad candidate: the chip's Deploy is disabled, with the reason as its hint. That
is guidance; `deployCheck` stays the authority. A picked hex shows the one-stage **Deploy / Cancel** chip and locks
the map until Cancel. **Deploy** sends the single waypoint with `{ type: 'deploy', kind: 'outpost' }` appended through
the existing `dispatchActionFor` → `dispatchRouteWithActions` path. An engine refusal shows on the Deploy Target row
and keeps the map open. Arrow-key panning is added to the shared planning mode. Not built: the `deployFailed` notice
(client slice 1, its own slice), a time / fuel quote before Deploy (on the decision checklist, as is the pan step),
the other lanes and the kit sources.

## 6. Generation — starter spacing

The generator sets **no minimum spacing between systems** (systems are shuffled onto
arm-eligible hexes and the first N taken). Measured on the live seeds, the closest system
pair is **1 hex** (directly adjacent) in both seed 42 and seed 7331, with hundreds of pairs
within 2 hexes — so §2's overlap is not a corner case, it is the norm, and §2's seniority
rule handles it.

**One spacing rule is added, for STARTERS only.** Two **starter-eligible (Terran)** systems
must be **≥ 3 hexes apart** (not within 2), so no two *home* footprints overlap and no guild
founds already contesting hexes with a neighbour. Measured today this is violated ~17-18
times per galaxy (starter pairs within 2 hexes; 4-6 directly adjacent), so it is a real fix.
**General systems stay unconstrained** — their overlap is §2's feature. Because
starter-eligibility is decided *after* placement (from the rolled planets), the rule is a
**post-generation de-cluster repair**: for each too-close starter pair, demote the junior by
converting its Terran planet, exactly as `repairRareTierGuarantee` already converts planets
to meet a guarantee. *(Rule ruled; the repair is a generator build detail.)*

## 7. The founding grant

A new guild's founding endowment gains, on top of the existing starter miners/factories:
an **undeployed Outpost kit**, a **Heavy transport** (starting `maintenanceCondition` 0.5 —
inert until the maintenance slice, so cosmetic for now), and **three light transports**.
This makes the opening literally "haul your kit out and plant your first outpost" — it
teaches the deploy loop on turn one, and the Heavy is functionally required (only it has the
hold for a kit). **A deep-scan array is deliberately NOT granted** — exploration/detection is
2.5 and unbuilt, so it would be an inert asset; it joins the grant (or the market) when the
exploration slice lands. *(Lands in the founding-endowment path, `phase-1-tuning.md`.)*

## 8. Open items → decision checklist

- Deploy ranges (outpost / gate / scan = 10 / 10 / 5) and semi-control aura radii (system /
  outpost / gate·scan = 5 / 3 / 2) — `[FIRST-CUT]` numbers for the tuner.
- ~~Arrival-revalidation failure semantics~~ — **RULED 30-09-26:** the craft RETREATS `DEPLOY_RETREAT_HEXES` (3)
  toward the nearest held system, kit aboard, flagged `deployFailed` (§5). **Still open under it:** where a
  retreat lands when that step falls just off the lattice near the rim (built provisionally as "step on along
  the same line to the first on-lattice hex"), and refining the landing to avoid rival / contested space (with
  the §1–§3 control map).
- Starter minimum separation value (3) — confirm as the generation constant.
- The deploy map (client slice 2): whether to show the engine's time / fuel quote before Deploy (today the chip's
  Deploy sends with no quote, as ruled), and the arrow-key pan step (built at 120 screen px) — see the roadmap's
  decision checklist.
- Squatting enforcement (detection, penalty, report/bounty) — deferred to 2.5 / Phase-6.
- ~~The BUILD-ROUTE / deploy-map pan control — client build detail.~~ — **BUILT 01-10-26:** arrow-key pan in the
  shared planning mode (client slice 2; its step is the item above).
