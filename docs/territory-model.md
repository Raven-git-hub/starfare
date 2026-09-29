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
decision checklist, never fixed here (working rule 5).

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

**Route legality is target-only.** The *path* is legal anywhere — open space is not
illegal, it is merely less safe / tolled — so there is nothing to "route around." Only the
**target** is validated. The player therefore **builds the route themselves** (reusing the
existing planner, not a forked auto-router), which is what gives them control over legal
exposure — crossing rival airspace or a toll route can incur a fine (2.3), so the choice is
theirs to make.

**Arrival re-validates the target** — the same dual-check `sim/claims.js` exists for
(valid at dispatch AND at arrival), hooked to the named "resolve a scheduled arrival" seam
(`design.md` §15). A kit can arrive to find the hex taken, the system claimed by a rival
first, or its range-anchor gone. On a failed arrival the **kit stays aboard and the craft
goes idle at the hex** — nothing lost but the trip and its non-refundable fuel
(`transport-model.md` §11.3). *(Exact failure semantics → decision checklist.)*

**The reverse — pickup from orbit.** An evicted or torn-down asset sits in **orbital limbo**
around its planet (`design.md` §5). Recovering it is an ordinary transport haul: fly to the
limbo coordinates, load the asset, haul it home — the deploy pipeline run backwards. *(Built
with the eviction / limbo slice, not this one.)*

**Client note.** BUILD ROUTE mode currently loses map panning (click places waypoints, so
it cannot also recentre). The deploy-map picker needs **arrow-key pan** (or restored
click-to-centre) added alongside it. *(Small client build detail, not a design blocker.)*

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
- Arrival-revalidation failure semantics (kit stays aboard, craft idles — confirm/pin).
- Starter minimum separation value (3) — confirm as the generation constant.
- Squatting enforcement (detection, penalty, report/bounty) — deferred to 2.5 / Phase-6.
- The BUILD-ROUTE / deploy-map pan control — client build detail.
