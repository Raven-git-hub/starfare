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

**You can't claim an unexplored system *(the exploration coupling, 05-10-26)*.** The claim gate
now reads the guild's **exploration record** (`docs/exploration-model.md` §8): a Prefecture may be
planted only on a **planet the guild knows at ≥ 1 resource node** in its record — however that
fact was learned (its own Deep Scan Array survey, or the public record of a rival's lapsed
licensed venture). Knowing a node on planet P opens the gate for P, not for a different planet in
the same system; planting then reveals the rest of P's nodes. This is **recorded here by the
exploration slice (roadmap 2.5) and ENFORCED by the Prefecture / claims slice that follows it** —
the gate's data source (the record) exists from birth so the claim action is never retrofitted
onto a fully-visible galaxy. It does not change the claim *row* (still `landmarkKind: 'system'`,
§4 above); it adds a precondition on the deploy-onto-a-settlement-slot step.

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
`phase-1-tuning.md` / decision checklist; the gate/outpost figures mirror `design.md` §2). *(⤳
**The deep-scan array's 5-hex deploy range is SUPERSEDED 05-10-26** (`docs/exploration-model.md`
§5). The array is **deploy-placed "attached"** — its hex directly adjacent to a system or outpost
footprint the guild holds — not placed within a 5-hex range. Its *scan* reach is galaxy-wide, so
placement is a flavour / future-monitoring concern, not a scan concern. The toll-gate 10-hex range
is unchanged and still open.)* *(⤳ **BUILT 06-10-26, roadmap 2.5 (b1):** the array rides this pipeline
with the attached rule — "AS-BUILT — the Deep Scan Array rides the pipeline" at the end of this section.)*

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
Once a hex is picked, the **Deploy Target** panel shows the engine's **time / fuel quote** for that leg
(`POST /vehicle/quote`, the figures the route builder's Finalise view shows before Dispatch) *(RULED
01-10-26)*. It is informational: DEPLOY never waits on it, and the engine re-checks and re-costs at dispatch.
While a hex is selected, clicking another hex does nothing (CANCEL first). On arrival the engine
deploys or retreats (the `deployFailed` rule above), surfaced as a `deploy_failed` message in the Guild Hall (`event-log.md` §10 — the pilot’s report). **Arrow-key panning** is added to this map mode (in the shared planning mode, so the
route builder gains it too): clicks place the target so they cannot also recentre the view — arrow
keys close that long-standing click-to-recentre gap (this supersedes the "needs arrow-key pan (or
restored click-to-centre)" note below). This
paragraph is the as-designed client flow for the outpost lane and supersedes the generic "Manage popup
→ pick a transport" wording of **The player flow** above, which describes the later, fuller vision.

**The deploy flow, REVISED — asset-initiated (RULED 02-10-26).** Playtest of the
craft-initiated flow above showed it backwards: a deployment should begin from the *outpost*, not
from the *carrier*. This block supersedes the **craft-initiated** framing of **The deploy map** and
the Manage-popup wording of **The player flow** — the as-built client (the Deploy button on a
heavy's Dispatch popup; the one-leg, commit-on-tile map) is revised to the flow below. The merged
ENGINE is untouched by the multi-leg change: `dispatchRouteWithActions` already accepts a deploy on
the **final waypoint of a route of any length** (slice 2 above), so lifting the one-leg limit is
client-only. The range paint, the pre-deploy quote, and the arrival deploy/retreat all carry over.

- **The kit is an idle asset, not a hold-only good.** An undeployed `outpost_kit` now lives as a
  **system-scoped idle asset** in a system's idle-asset list — the `Asset.systemId` /
  `deployedToVentureId == null` model miners and factories already use (`design.md` §4, revised
  there) — presented to the player as an **idle outpost**. It reaches a system's inventory
  through a source (the dockyard / founding grant / the repointed `grantKit` test seam); it is no
  longer minted straight into a hold. *(⤳ BUILT 02-10-26, engine half — "AS-BUILT — asset-initiated slice 1"
  below.)*

- **Initiate — from the asset, pick the carrier.** In the system's idle-asset list the idle
  outpost carries a **Deploy** button → an **outpost-subject dispatch popup** (the existing
  `#dispatch-overlay` chrome, reused — no new visual language) with a **carrier dropdown**. The
  dropdown offers only heavy transports that are **empty, idle, and in the same system as the kit**;
  none → it reads **"No Available Transport"** and Deploy is unavailable. (Same-system is the
  ruled constraint — `design.md` §4's per-system inventory — and it forces the player
  to position a hauler first, which is the point.) The old **heavy-first entry** (a Deploy action on
  a heavy's own Dispatch popup) is **removed**: a heavy only ever holds a kit mid-deployment or after
  a retreat, and both are reached otherwise (below). *(⤳ BUILT 02-10-26 — the Deploy button, the popup, the
  carrier dropdown, and the heavy-first entry removed: "AS-BUILT — asset-initiated client slice 2a" below.)*

- **Plan — the normal route planner, reused whole.** Once a carrier is chosen the player plans
  with the **full multi-leg transport route planner** — same chrome, same confirm, same quote
  — not a reduced one-leg map. The legal **range ring** is shown as the guide for where the
  **final** waypoint may land, and a **deploy** action is auto-appended to that final waypoint when
  it is a bare hex in range. Intermediate stops are plain turning-points: the kit fills the whole
  heavy hold, so no cargo action can ride them. *(⤳ Corrected 02-10-26, asset-initiated slice 3a: this read "the
  engine refuses a dock there regardless", but it does not. A dispatch accepts a dock on an earlier stop of a kit
  route and the dock moves nothing, because the hold is full. The client offers no Action there. Whether the
  engine should refuse it outright is on the decision checklist.)* *(⤳ BUILT
  02-10-26 — client slice 2b: the deploy map is now the full multi-leg planner; "AS-BUILT — asset-initiated
  client slice 2b" below.)*

- **Commit — in the popup.** The planner's own **Finalise → Dispatch** is the commit (this
  replaces the built map's on-tile DEPLOY-as-finalise). On commit the kit **loads** onto the chosen
  carrier — **instant, because carrier and kit sit in the same system** — and the lane
  launches as an ordinary route in Operations. *(⤳ BUILT 02-10-26 — client slice 2b: the deploy map's Finalise
  hands the route back to the Deploy Outpost popup, whose **Deploy** sends `loadKit` and then, only if the load is
  accepted, the dispatch — this ruled order. The map's on-tile DEPLOY is retired. "AS-BUILT — asset-initiated
  client slice 2b" below.)* *(⤳ 02-10-26, client slice 3b: the popup's Deploy is now gated on that route's quote, as
  the Dispatch popup's Dispatch is — an unquotable or unaffordable route holds it, so the kit is never loaded for a trip
  the dispatch would refuse.)*

- **Arrival — unchanged.** The deploy is instant and the carrier is left **parked on the new
  Outpost** (the derived `dockStatus: parked`, already built and test-locked).

- **Failed deploy — resolved from the message, two forks.** The retreat rule above is unchanged
  (instant pull-back to the nearest held system, kit aboard, `deploy_failed` recorded). Because the
  kit is now *aboard* a heavy and no longer in inventory, the asset-initiated entry cannot re-reach
  it, so resolution moves to the `deploy_failed` notice (`event-log.md` §10): its map button
  (replacing *Show on map*) offers **Redeploy** — the deploy planner with the carrier **already
  fixed** to the retreated heavy (no carrier pick), pick a new hex and go — or **Return** —
  plan a route to **any held system** with an **unload** action auto-appended, dropping the kit back
  into that system's idle list as an idle outpost. Until one fork resolves it, the kit waits aboard
  the heavy. *(⤳ The Return fork's ENGINE half — the route-arrival unload — is BUILT 02-10-26: "AS-BUILT —
  asset-initiated slice 3a" below. The message's two forks and the planner's unload mode are client slice 3b.)* *(⤳ BUILT 02-10-26 — client
  slice 3b: the popup's Redeploy / Return, each planning for the retreated heavy and committing in its Dispatch popup,
  and the planner's unload mode. "AS-BUILT — asset-initiated client slice 3b" below.)*

- **Load / unload are kit-specific actions** (`design.md` §4), inverses of each other and
  distinct from the goods dock/manifest: **load** moves a kit inventory → hold (instant,
  same-system, at commit); **unload** moves it hold → a fresh idle outpost in a held system's
  inventory (on arrival, the Return fork). *(⤳ BUILT 02-10-26 as standalone engine actions, `loadKit` /
  `unloadKit`; the on-arrival unload of the Return fork is a later slice. ⤳ That on-arrival unload is BUILT
  02-10-26 too, as the `{ type: 'unload' }` route action: "AS-BUILT — asset-initiated slice 3a" below.)*

- **Sequencing.** The kit-as-idle-asset plus a source that mints one into a system (the repointed
  `grantKit`, with the load/unload actions) is the **prerequisite rung** — it lands before the
  asset-initiated popup, the planner reuse, and the message rewire can be driven. *(⤳ This rung is BUILT
  02-10-26 — below.)*

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
dispatch clears it. *(⤳ 02-10-26: so does unloading the kit — `unloadKit`, "AS-BUILT — asset-initiated slice 1"
below.)* *(Deferred, not built: guaranteeing the landing hex is not itself rival or contested
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
dockyard and founding-grant sources are later rungs). *(⤳ Repointed 02-10-26: `grantKit` now mints an idle kit
asset into a system's inventory, and a kit reaches a hold through `loadKit` — "AS-BUILT — asset-initiated
slice 1" below.)* `deployAsset` is the **space lane** for the outpost: a
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
the craft. *(⤳ That entry is REMOVED 02-10-26 — the map now opens from the idle outpost, for a carrier picked in the
Deploy Outpost popup: "AS-BUILT — asset-initiated client slice 2a" below. The map itself is unchanged.)* The legal range is the player guild row's `deployRange.outpost`, drawn as the dashed outer border of the
union of the anchors' `hexesInRadius` disks (the radius is the engine's). The client refuses a click on a hex that
is not bare (a system, a waystation, the Citadel's hex, any guild's Outpost), is off the disc, or is outside the
ring the way the planner refuses a bad candidate: the chip's Deploy is disabled, with the reason as its hint. That
is guidance; `deployCheck` stays the authority. A picked hex shows the one-stage **Deploy / Cancel** chip and locks
the map until Cancel. **Deploy** sends the single waypoint with `{ type: 'deploy', kind: 'outpost' }` appended through
the existing `dispatchActionFor` → `dispatchRouteWithActions` path. An engine refusal shows on the Deploy Target row
and keeps the map open. *(⤳ The one-stage chip and the commit on the tile are RETIRED 02-10-26: the map is now
the full multi-leg planner, and the commit is in the Deploy Outpost popup — "AS-BUILT — asset-initiated client slice
2b" below. The range ring, the refusal rules, the quote and arrow-key pan carry over.)* Arrow-key panning is added to the shared planning mode. Not built: the `deployFailed` notice
(client slice 1, its own slice), a time / fuel quote before Deploy (on the decision checklist, as is the pan step;
*⤳ the quote is ruled and BUILT 01-10-26, below*), the other lanes and the kit sources.

**AS-BUILT — the `deploy_failed` notice, engine half (01-10-26; engine only, no client).** Built to `event-log.md` §10,
no design change, and the retreat itself is untouched. Where `resolveDeployArrival` sets `deployFailed`, it also
records a `deploy_failed` row on the guild's event log at the same tick: `cause`, `kind`, `targetHex`, `craftId` /
`craftClass`, and `retreatSystemId` / `retreatSystemName` (the nearest held system the retreat pulls toward). The
`deployFailed` flag stays as it was. A successful deploy writes nothing. Not built: the Guild Hall message that
renders it (the client slice).

**AS-BUILT — the pre-deploy quote on the deploy map (01-10-26; `client/game.html` only, no engine).** Built to "The
deploy map" above, closing the decision-checklist question it left open. When a **valid** target is selected, the
map asks the engine for the leg's quote through the route builder's own `fetchQuote` (`POST /vehicle/quote`), given
the same single deploy waypoint DEPLOY sends. The quote endpoint reads anchors only, so the deploy leg is quoted as
its bare flight, the same leg the dispatch burns for. The Deploy Target row reads "Quoting…" while the fetch is out,
then the engine's **Time · Cost**, formatted by the same `quoteFigures` the Finalise view uses. A leg the engine
cannot quote (`{ ok:false }`) shows the engine's reason instead. A refused hex asks nothing. Cancel, or a new target,
drops the old quote, and a late answer for a target since changed is ignored. DEPLOY is not gated on the quote. The
quote is asked once per selection, as Finalise asks once per route, so a poll does not refresh it. *(⤳ 02-10-26,
client slice 2b: the map plans a route of one stop or many, so the quote is now the WHOLE route's. It is asked once
the route ends on a legal target, again after each add / remove / reorder, and shown under the last stop.)*

**AS-BUILT — asset-initiated slice 1, the kit as a system-scoped idle asset (02-10-26; engine + operator CLI, no
client).** Built to the REVISED block above and `design.md` §4's ruling, no design change and no new number. An
undeployed kit now has two representations, one at a time: an idle **asset** of kind `'outpost'` in a system's
inventory (`guild.assets`, the miner/factory model), and the `outpost_kit` **good** in a heavy's hold — the one
`deployCheck` / `deployKit` already read, so the deploy, the retreat and the `deploy_failed` notice are untouched.
`'outpost'` is a kit kind, kept apart from the venture kinds (`ASSET_KINDS` unchanged), so no venture can ever
name a kit. Three operator-journalled actions convert between them: **`grantKit { guildId, systemId, kind }`**
(repointed — mints one idle kit at a system), **`loadKit { guildId, vehicleId, assetId }`** (the named idle kit →
an empty, idle heavy berthed at the kit's own system — the ruled same-system constraint) and **`unloadKit {
guildId, vehicleId }`** (the heavy's one kit → a fresh idle kit in the held system it is berthed at; refused on a
bare hex or at an Outpost). *(⤳ 02-10-26: the unload also clears the craft's `deployFailed` — once a retreated
kit is back in an inventory the failed deploy is over, so the flag would only be stale; the next dispatch still
clears it too. One line in `kitIntoInventory`, the one unload apply, so the Return fork's on-arrival unload
inherits it.)* One kit in, one good out, and back; a deploy is still the only thing that consumes a
kit. Kit ids come from a stored per-guild serial (`asset_<guild>_outpost_NN`), because a loaded kit leaves the
inventory and its number must never return (`design.md` §15.4). The unload's rule and apply take the location
and tick as arguments, as `deployCheck` / `deployKit` do, so the Return fork's on-arrival unload can reuse them.
Snapshot unchanged: an idle kit is already an `assets` row with `kind: 'outpost'` and `deployedToVentureId:
null`, which is what `__myIdleAssets('outpost')` reads. Operator surface: `POST /admin/guild/grant-kit` (was
`/admin/vehicle/grant-kit`) and `POST /admin/vehicle/load-kit|unload-kit`, with `tools/admin.js grant-kit
--system`, `load-kit` and `unload-kit`. Not built: the client (the idle-outpost Deploy button, the
outpost-subject popup and carrier dropdown, the planner reuse, the message's Redeploy / Return), the
route-arrival unload *(⤳ BUILT 02-10-26, "AS-BUILT — asset-initiated slice 3a" below)*, the real kit sources,
storing a kit at an Outpost, the other kinds. *(⤳ The Deploy button,
the popup and the carrier dropdown are BUILT 02-10-26 — client slice 2a, next.)*

**AS-BUILT — asset-initiated client slice 2a, the entry + carrier picker + the `loadKit`-then-dispatch commit
(02-10-26; `client/game.html` only, no engine).** Built to the REVISED block above, no design change and no new
number. **The entry:** in OPERATIONS → IDLE an idle asset row of kind `'outpost'` (an undeployed kit) carries a
**Deploy** button, the Dispatch / Dock button's own style; miner and factory rows are unchanged. **The popup:**
Deploy opens the **Deploy Outpost** popup (`#deploy-overlay`), a small overlay built from the Dispatch popup's
markup and classes. The CSS rules it uses name it beside `#dispatch-overlay` (and beside `#est-overlay` for the
`est-select`), so the two popups share one rule each rather than a copy. It reads eyebrow "Deploy Outpost",
"Outpost Kit · #NN", a summary (Kind / Stored at / Ready) and the outpost art *(⤳ 02-10-26, slice 2b: Ready
dropped — it always read "Yes")*. Its **Carrier** dropdown lists the
player guild's heavy transports that are idle, off any lane, with an empty hold, and berthed at the kit's own
system: exactly what `loadKit` accepts. With none it reads **"No Available Transport"** and Plan Route stays
disabled; picking a carrier enables it. The list is read when the popup opens, and the chosen carrier is re-read
at Plan Route. *(⤳ The **Plan** and **Commit** below were slice 2a's interim; both are SUPERSEDED 02-10-26 by
"AS-BUILT — asset-initiated client slice 2b", next.)* **Plan:** Plan Route opens the existing single-leg deploy map for the chosen carrier, unchanged
(range ring, quote, DEPLOY / CANCEL chip, arrow-key pan), centred on the carrier at the kit's system. The map
needs nothing from the hold, so the carrier starts empty. `startPlanning` carries the kit's id as
`PLAN.deployKitAssetId`. **Commit:** for a plan carrying a kit id, the on-tile DEPLOY sends `loadKit { guildId,
vehicleId, assetId }` through `__sendAction`, and only if it is accepted sends the deploy dispatch through the same
`__dispatchDeploy` path as before. A refused load shows the engine's reason on the Deploy Target row and sends
nothing more, so the kit stays in inventory. Once the load lands the plan drops its kit id. A dispatch refused after
the load therefore leaves the heavy holding its kit (the state a retreat leaves). A retry from the still-open map is
the plain dispatch, never a second load. `loadKit` fires only at DEPLOY, so Cancel, or leaving the map, leaves the
kit in inventory. **The heavy-first entry is removed:** `deployKindOf`, the Dispatch popup's Deploy button and
`onDeploy` are gone. A kit now reaches a hold only through `loadKit` (this commit, or the operator lever).
**Known gap until slice 3:** a heavy holding a kit with no deploy under way (left by a retreat, by a dispatch
refused after its load, or by an operator `load-kit`) has no client deploy path until the `deploy_failed`
message's Redeploy fork lands. It is operator-recoverable (`unload-kit` back into inventory, then Deploy from the
idle row), and a retreat is near-impossible in single-guild play. *(⤳ The retreat case is CLOSED 02-10-26 by client
slice 3b: the `deploy_failed` message's Redeploy / Return reach a retreated kit. A kit left aboard by a refused dispatch
or an operator `load-kit` writes no notice, so no fork reaches it; that part stays open on the decision checklist.)* Not built: the multi-leg planner and the commit in
the popup (slice 2b) *(⤳ BUILT 02-10-26, next)*, the message's Redeploy / Return (slice 3), and the other kinds.

**AS-BUILT — asset-initiated client slice 2b, the multi-leg planner + the commit in the popup (02-10-26;
`client/game.html` only, no engine).** Built to the REVISED block above ("Plan" and "Commit"), no design change and no
new number. It replaces the two interim pieces slice 2a named. **Plan:** the deploy map is now the full route planner.
Plan Route in the Deploy Outpost popup opens it for the chosen carrier, with the normal Add → Confirm chip, the
waypoint list with reorder / remove, and Finalise. The dashed range ring stays drawn as the guide. In deploy mode no
stop carries an action of its own. The `{ type: 'deploy', kind }` action is added to the LAST stop when the route is
handed on (`deployWaypoints`), so it moves when stops are added, removed or reordered, and the list shows it on the
last row. The chip offers no Action (no dock), so every earlier stop is a plain turning point, and it may be any hex.
Load Route stays hidden: a saved lane's stops carry dock actions, and loading one re-plans as an ordinary route.
**The Finalise gate** is the planner's own (at least one stop, no dead leg) plus a last stop the kit can deploy on.
`deployTarget()` now reads the route's last stop through the unchanged `deployRefusal`. A last stop that is not bare,
off the disc, or outside the ring flags its row ("can't deploy here — outside the deploy range") and disables
Finalise, as a dead leg does. **The map's quote** is the whole route's (the pre-deploy quote note above). **Fork 2 —
Finalise lands in the popup.** On the deploy map, `finalisePlanning` hands the route to `__kitDeployFinalise` instead
of the Dispatch popup. The Deploy Outpost popup re-opens in a post-finalise state built from the Dispatch popup's
own: the Planned Route list (Origin, each stop, the deploy action on the last) beside the engine's Time / Fuel credits
(`fetchQuote` / `quoteFigures`), with **Edit Route** and **Deploy**. The summary shows a Carrier row there, in place of
the dropdown. The CSS rules it uses name `#deploy-overlay` beside `#dispatch-overlay`, as slice 2a's did. Edit Route
re-opens the map with the route kept. **Commit:** Deploy sends `loadKit { guildId, vehicleId, assetId }`, and only if
the load is accepted sends the dispatch through the unchanged `__dispatchDeploy` (`dispatchActionFor` →
`dispatchRouteWithActions`, `wireWaypoints`). `loadKit` fires only at Deploy, so the map's Cancel, Edit Route or
closing the popup leaves the kit in inventory. A refused load shows the engine's reason and sends nothing more. Once
the load lands the popup marks the kit aboard: a dispatch refused after it says so ("… — the kit is now aboard Heavy
Transport · #01."), and a retry sends the dispatch alone. Deploy does not wait on the quote, as the map's DEPLOY did
not (still open on the decision checklist). *(⤳ RULED 02-10-26 — gate it — and BUILT in client slice 3b: Deploy is
disabled on an `{ ok:false }` or unaffordable quote, as Dispatch is.)* **Retired:** the one-stage chip (`fillDeployChip`), `confirmDeploy`,
`loadDeployKit`, the "a selected target locks the map" click rule, `PLAN.deployKitAssetId` / `deploySending` /
`deployRefused`, and the CSS rule that hid Finalise in deploy mode. The kit now lives in the popup, which is only
hidden while the map is open. **Ride-along:** the popup's Ready row is dropped (slice 2a's call (1), ruled). Slice 2a's
known gap still holds: closing the popup after a load leaves the kit aboard, with no client path until slice 3. Not
built: the `deploy_failed` message's Redeploy / Return (slice 3), and the other kinds.

**AS-BUILT — asset-initiated slice 3a, the on-arrival unload route action (02-10-26; engine + operator CLI, no
client).** Built to the REVISED block above (the Return fork's engine half, and "Load / unload"), no design change and
no new number. A `dispatchRouteWithActions` waypoint may carry a third action type, **`{ type: 'unload' }`**: "drop the
kit this craft carries into this system's inventory when it lands". It carries nothing but its type, because
`unloadKitCheck` reads the kit's kind off the hold. It is the deploy action's mirror. `routeWaypointError` accepts it
only under the dispatch-only `allowUnload` (a sibling of `allowDeploy`), so a saved route never carries one. **The
dispatch refuses it whole, up front,** when the route also carries a deploy (a route ends in ONE kit action), when it is
not on the **final** waypoint, when that waypoint is not a system (a bare hex, a waystation, a guild Outpost's hex), or
when the unload would fail **now**: slice 1's `unloadKitCheck`, asked of that system with today's hold, wants exactly one
kit and nothing else and a system the guild holds. So a doomed trip is never flown or fuelled. A repeating lane is
refused by slice 1's kit gate, unchanged. **On arrival** `resolveRouteArrival` re-validates through `unloadKitCheck` and
applies through `kitIntoInventory`, the two the standalone `unloadKit` runs: one unload, two triggers. The hold
empties. A fresh idle kit is minted at the system with its number from the stored `kitAssetSerial`, so a returned kit
never reissues an id. Any `deployFailed` clears. Then `advanceRoute` ends the one-shot run, leaving the craft idle at the
system. **A failed arrival re-check** (the system no longer held, or the hold not exactly one kit) cannot happen today:
no path takes a system from a guild, and nothing touches a routed craft's hold. If it ever does, the run ENDS the way a
route action whose target is gone ends (`transport-model.md` §11.6). The craft is idle at its arrival berth, the kit
still aboard and never dropped, the route cleared, and it is flagged `laneEnded = { reason: 'target-gone', tick }`.
There is no new flag or reason, and no halt. This differs from the deploy, whose corrupt-state branch halts (decision
checklist, "Asset-initiated slice 3a"). `copyRouteWaypoint` copies the new shape (the craft's journalled route and the
snapshot), and the
craft-route invariant gains `unloadActionViolation` (final waypoint, a system anchor, a one-shot route), the mirror of
`deployActionViolation`. Operator surface: no new endpoint, since `/action` and `/admin/vehicle/dispatch-route` already
carry any waypoint. `tools/admin.js dispatch-route` takes a last stop `sys:<id>@unload-kit` (named after the `unload-kit`
subcommand, because `@unload:` is the dock manifest's) and prints it as "unload kit". **Client seam:** a craft flying an
unload route publishes `{ type: 'unload' }` in its snapshot route. Today's `actionSummary` shows a blank action line for
it (it returns `''` for a manifest-less action) and does not break. *(⤳ Labelled "unload · kit" 02-10-26, client slice
3b.)* Not built: the `deploy_failed` message's Redeploy /
Return forks and the planner's unload mode (client slice 3b), and the other kinds. *(⤳ BUILT 02-10-26, next.)*

**AS-BUILT — asset-initiated client slice 3b, the `deploy_failed` message's two forks + the Deploy-gating parity
(02-10-26; `client/game.html` only, no engine).** Built to the REVISED block above ("Failed deploy — resolved from the
message, two forks"), no design change and no new number. It closes the retreated-kit gap slice 2a named, and is the
last rung of the asset-initiated pipeline. **The forks.** The pilot's popup (`event-log.md` §10) replaces Show on map
with **Redeploy** and **Return**, beside Dismiss. Each reads the retreated heavy by the notice's `payload.craftId`, and
acts only while the heavy is as the retreat left it: idle, off any route, with the kit of `payload.kind` aboard
(`retreatedCraft`). A heavy that has moved on (a fork already taken, flying again, moved by an operator) opens nothing,
and the popup's footer says "Nothing left to resolve." Otherwise the fork closes the popup and opens the planner for that
heavy, centred on it, through one new bridge, `__planKitRoute(vehicle, action, waypoints)`:
- **Redeploy** opens the deploy map as it is: the ring, `deployTarget` / `deployRefusal`, the map's quote, the deploy on
  the last stop. The carrier is the retreated heavy, so there is no carrier pick.
- **Return** opens the planner's new **unload mode**: the same planner, titled "Returning Kit", with no range ring (an
  unload is not range-bound) and no map quote. Its route must END on a system the guild holds. `unloadRefusal` asks that
  of the last stop, off the snapshot's own claims (`PLAYER_GUILD.ownedSystemIds`, the list the route-action gate already
  reads). A last stop that is not a system, or not a held one, flags its row ("can't unload here — not a system you
  hold") and disables Finalise. `{ type: 'unload' }` is added to the last stop on the way out, as the deploy is.

**Where Finalise goes.** `PLAN` carries `fromInventory`, true only for a fresh deploy (`__planDeploy`, from the Deploy
Outpost popup) and false for the forks. `finalisePlanning` sends a fresh deploy to the Deploy Outpost popup, slice 2b's
path unchanged. Every other route, a kit already aboard included, goes to the heavy's own Dispatch popup: the ordinary
commit, which sends `dispatchRouteWithActions` through `dispatchActionFor` and is already gated on the quote. Nothing
loads, because the kit is in the hold, and the engine (slice 3a) unloads or deploys on arrival. **The Dispatch popup
learns a kit route**, so a route ending in a kit action reads right there:
- `dispatchFinalise` fills the popup's head (`fillHead`, split out of `openDispatch`). A fork reaches Finalise without
  the popup ever having been opened for that heavy.
- A kit route shows no Save Route row, no launch picker and no dock Action control. A kit never rides a saved lane or a
  repeat, and it fills the hold.
- Its Edit Route re-opens the kit mode it came from (`__planKitRoute`), not the ordinary planner.
- The shared route checks learn `isKitAction`. `brokenAt` never flags a kit action: a deploy's stop is open ground, with
  no store by design, which had read as "store gone" and would have blocked Dispatch. `canRepeat` refuses a kit route,
  as the engine does. `actionSummary` labels the unload "unload · kit" (slice 3a's blank line).

**The gating parity.** The Deploy Outpost popup's Deploy is disabled when the engine's quote is `{ ok:false }` (its
reason shown, as before) or `affordable: false`. That is the quote half of the Dispatch popup's `canDispatch`, now one
shared rule, `quoteAllows` (`window.__quoteAllows`), so the kit is never loaded for a trip the dispatch would refuse. The
quote is asked once at Finalise, as Dispatch's is. **Renamed:** `deployAction` / `deployWaypoints` are `kitAction` /
`kitWaypoints` (they serve both kit modes); `#app.deploying` is `#app.kitroute`; `startPlanning`'s fifth argument is a
`kit` object (`{ deploy, fromInventory }` or `{ unload: true }`), not a kind. **Retired:** `showNoticeOnMap`,
`#noticeShowMap`, and the `window.__craftCoords` bridge only it used. **Still a gap:** a kit left aboard by a dispatch
refused after its load (the popup then closed), or by an operator `load-kit`, writes no `deploy_failed` notice, so no
fork reaches it. It stays operator-recoverable (decision checklist). Not built: the kit sources and the other kinds.

**AS-BUILT — the Deep Scan Array rides the pipeline, with the attached rule (06-10-26; roadmap 2.5 (b1);
engine + operator CLI, no client).** The second space-lane kind, built as an ADDITIVE generalisation of the
one deploy rule and apply — not a second pipeline. A `deepScan` kit (`deep_scan_array_kit`, one new
`DEPLOYABLE_KITS` row) is granted, loaded, ferried and unloaded by the existing kit actions unchanged, and is
deployed by the existing triggers: the manual `deployAsset` and a dispatch's final-waypoint `{ type:
'deploy', kind: 'deepScan' }`. **`deployCheck` now takes the kind** it is placing — the waypoint's, or (for
the manual deploy, which names only the craft) the kind of the kit aboard — and keeps its shared checks in
their order: `not-bare-hex`; `kit`, now "exactly one kit **of that kind**" (a waypoint naming the other kind
is refused up front); `occupied` (`hexOccupant` now also sees Deep Scan Arrays — one structure per hex
across both kinds, `spawnOutpost` included). Then the **placement** check dispatches on the kind
(`DEPLOYABLE_STRUCTURES`, `sim/actions.js`): the Outpost's range rule (`outpostPlacement` — the old lines,
moved, not changed) or the array's **attached** rule (`attachedPlacement`: a bare hex exactly `claimRadius
+ 1` from a held system's centre, or 1 from an Outpost the guild owns; `exploration-model.md` §5 has the
detail and the anchor pick). `deployKit` mints by kind — `mintOutpost` or the new `mintDeepScanArray`
into `state.deepScanArrays`. **Arrival** re-validates through the same rule: a lost attachment fails as the
new retreatable reason **`not-attached`** (beside `occupied` / `out-of-range` in `DEPLOY_FAILED_REASONS`)
and retreats by the existing `retreatLanding`, unchanged, with the `deploy_failed` notice (`cause:
'not-attached'`, `kind: 'deepScan'`). **The outpost path is byte-identical** to `main` before the slice —
a scripted run of the manual deploy, the on-arrival deploy, the on-arrival retreat and every outpost
refusal hashes to the bytes recorded on a60d98e (`sim/tests/deep-scan-array.test.js`). One refusal TEXT
moved, outside the outpost path: a manual deploy by a craft carrying **no kit at all** now asks for
"exactly one kit" (with two kinds it can no longer assume the Outpost's). Operator surface: no new
endpoint or command — `tools/admin.js grant-kit --kind deepScan`, `load-kit`, `deploy-asset`, `dispatch-route
"<q>,<r>@deploy:deepScan"` — but the CLI's printouts now list idle kits of every kind and `deploy-asset` names
the structure it placed (`docs/cli-runbook.md`, the Deep Scan Array section). Not built: the `deployRange.deepScan` paint lane and every client piece, a
dockyard build path for any installation, teardown / removal of an array, and the scan (2.5 (b2)).

> **RULED 05-10-26 — the reclaim (teardown → redeploy); AS-BUILT 05-10-26, engine half.** The inverse of the deploy: a deployed Outpost with an empty stockpile and nothing docked is packed back into an `outpost_kit` aboard the single empty heavy parked on its hex, which then re-enters this section's flow unchanged. It is built as `reclaimOutpost` (`sim/actions.js`), with tripwires in `sim/tests/outpost-teardown.test.js`. The round-trip test runs deploy, reclaim, dispatch and deploy-on-arrival through this section's machinery, untouched; the redeploy takes a new id. The client half (the Outpost Manager's Teardown affordance) is next. Full ruling and AS-BUILT: `docs/outpost-teardown.md` §9; `design.md` §4.

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

*(⤳ **RULED again and BUILT 04-10-26 — for HUMAN foundings only** (`design.md` §13 "The human founding
starter package"). The design room restated this grant, restricted it to a guild founded with
`isBot === false`, and added an 8,000,000-credit founding figure for humans. A bot founding gets none of
it. As built: one idle `outpost` kit asset, one Heavy and three lights, all idle at the home system,
minted by the `foundGuild` apply through the same mints `grantKit` / `spawnVehicle` use
(`sim/starter-package.js`, `sim/actions.js` `mintStarterPackage`). The Heavy's 0.5 condition above is
honoured. The 04-10-26 ruling did not restate it, so it is on the roadmap's decision checklist to
confirm.)*

## 8. Open items → decision checklist

- Deploy ranges (outpost / gate / scan = 10 / 10 / 5) and semi-control aura radii (system /
  outpost / gate·scan = 5 / 3 / 2) — `[FIRST-CUT]` numbers for the tuner. *(⤳ **deep-scan deploy
  range SUPERSEDED 05-10-26:** the array is placed **adjacent to ("attached to") a held system or
  outpost**, not within 5 hexes; galaxy-wide scan reach makes placement a monitoring/flavour
  concern (`docs/exploration-model.md` §5). Outpost 10 remains ruled; gate 10 and all aura radii
  remain open.)*
- ~~Arrival-revalidation failure semantics~~ — **RULED 30-09-26:** the craft RETREATS `DEPLOY_RETREAT_HEXES` (3)
  toward the nearest held system, kit aboard, flagged `deployFailed` (§5). **Still open under it:** where a
  retreat lands when that step falls just off the lattice near the rim (built provisionally as "step on along
  the same line to the first on-lattice hex"), and refining the landing to avoid rival / contested space (with
  the §1–§3 control map).
- Starter minimum separation value (3) — confirm as the generation constant.
- The deploy map (client slice 2): ~~whether to show the engine's time / fuel quote before Deploy~~ — **RULED yes,
  BUILT 01-10-26:** the Deploy Target panel shows it once a hex is picked (§5). **Still open:** the arrow-key pan
  step (built at 120 screen px) — see the roadmap's decision checklist.
- Squatting enforcement (detection, penalty, report/bounty) — deferred to 2.5 / Phase-6.
- ~~The BUILD-ROUTE / deploy-map pan control — client build detail.~~ — **BUILT 01-10-26:** arrow-key pan in the
  shared planning mode (client slice 2; its step is the item above).
