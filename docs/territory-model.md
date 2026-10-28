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
retreat rule — is BUILT too (the slice-2 AS-BUILT note). Everything else here stays design-ahead.)* *(⤳ 16-10-26: §4's
claim action — the Prefecture kit, its ferry into unheld ground with the arrival retreat, and the plant that writes the
claim — is BUILT, engine + operator CLI (§4's "AS-BUILT — engine PR 1"). §2's seniority map is next, engine PR 2.)* *(⤳ 16-10-26:
§2's seniority control map is BUILT in the engine and carried by the snapshot (§2's "AS-BUILT — engine PR 2"); the client
render is the next PR.)* *(⤳ 16-10-26: the client render is BUILT too: the galaxy map paints the engine's `controlMap` and
resolves nothing (§2's "AS-BUILT — client PR A").)* *(⤳ 27-10-26: the cross-system ferry now carries
an existing GROUND machine too — the salvage run, losing ground's engine PR 2 (§5's "AS-BUILT — losing ground, engine PR 2").)*
*(⤳ 28-10-26: a rival's claim of a fallow system now SWEEPS the machines still stranded there — they change hands to the
claimant — losing ground's engine PR 4 (§4's "AS-BUILT — losing ground, engine PR 4").)*

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
exists — not before. *(⤳ 16-10-26: its first consumer exists — the map paint, through the snapshot — so §2's
controlled / uncontrolled half is BUILT, derived exactly as above and storing nothing (§2's "AS-BUILT — engine PR
2"). §3's semi-controlled half waits for detection.)*

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

**AS-BUILT — engine PR 2: the seniority control map (16-10-26; roadmap 2.5, the first Prefecture / claims slice; engine
+ snapshot, no client).** Built to the four bullets above, no design change and **no new number** (the rule is the
claims' own ticks and ids over the seed's `claimRadius`).
- **The resolver** is `sim/claims.js`, built ON `controlNear` — the coverage question ("which footprints cover this
  hex?") is still asked there and nowhere else; a held system's footprint now also names its claim row (`claimId`,
  `claimedAtTick`). One private rule, `controllingFootprint`, applies the bullets in order: the hex's held-system
  footprints are the candidates; if the hex is a held system's own centre, that system's holder wins (asked of
  `systemHolder`, so the two can never disagree); otherwise the oldest `claimedAtTick` wins, ties to the lower `claimId`
  (byte order). Two exports read off that one rule: **`controlledBy(state, coords)`** → the controlling guild's id, or
  `null` when no held system's footprint covers the hex; **`resolveControl(state)`** → the whole map. The map only
  decides WHERE TO ASK (a net of every hex in a held disk) and puts each hex to the same rule, so a map row and
  `controlledBy` for that hex are one answer.
- **Derived, never stored.** Both are pure reads of `state.claims` and the seed, recomputed on every call: a claim added
  or removed changes the answer with nothing to reconcile (tested by deleting the senior claim — the junior expands to
  its full footprint). No state key, no serialized byte, no determinism hash.
- **The snapshot shape.** A top-level **`controlMap: [ { q, r, guildId, claimId } ]`** — one row per controlled hex,
  naming the ONE guild that controls it and the claim that won it, sorted by q then r (invariant 9), emitted right after
  `claims`. ALWAYS EMITTED (`[]` when no system is held; in a live galaxy every guild's home is held, so it is never
  empty). The engine resolves seniority and the client only paints the rows (`design.md` §18 — the `deployRange`
  precedent). **Public L0:** every row is a function of the public claim board and the seed, so `sim/fog.js` classifies
  it `public` and every guild's view carries the same whole map. No schema bump.
- **Scope — the SYSTEM layer.** The rule above is ruled for claimed systems; an Outpost writes no claim row (no
  `claimedAtTick`), so its one-hex footprint is not in the map (it stays in `outposts`, and `controlNear` still lists it).
  A Deep Scan Array's hex could not be anyway: a rival's array is never visible. How an Outpost hex inside a rival's disk
  resolves is on the roadmap's decision checklist. Hexes are listed as the footprint covers them, the galaxy's rim
  included, as the client paints a disk today.
- **The tripwires.** `checkClaimIntegrity` now also asserts the two facts seniority needs: every `claimedAtTick` a whole
  tick in [0, now] (§15.2) and every `claimId` unique (§15.4) — and the resolver HALTS, naming the claim, on a covering
  claim with no whole tick. `sim/tests/control-map.test.js` pins each bullet on a real plant (the PR 1 fixture: g2's
  Prefecture 2 hexes from g1's home) and on two ADJACENT seed systems (the own-centre override; the senior takes 3 of the
  4 contested hexes), the tie-break both ways, the recompute, determinism, the views, and an ORACLE — the rule written
  out again in the test and asked of every hex around a dense cluster of claims, ties included.
- **What moved.** Every snapshot and every per-guild view gained the `controlMap` key and nothing else: each pinned
  snapshot golden is still asserted against its pre-PR hash through `sim/tests/control-map-strip.js` (which refuses to
  be vacuous). No state golden moved. Not built: the client render (`client/game.html` `computeTerritoryMap` still
  paints raw disks; next PR — *⤳ BUILT 16-10-26, "AS-BUILT — client PR A" below*), §3's corridors, and the Deep Scan
  Array rule's switch to seniority (`exploration-model.md` §5 — still "refused for both"; on the decision checklist).

**AS-BUILT — client PR A: the control map render (16-10-26; roadmap 2.5, the Prefecture / claims slice; `client/game.html`
only, no engine).** Built to the bullets above and `design.md` §18. No design change, no new number.
- **The map paints the engine's answer.** `computeTerritoryMap`'s system layer is the snapshot's `controlMap`, threaded
  verbatim (`applySnapshot` → `LIVE.controlMap` → `__setLiveTerritory` → `loadClaims`): one map entry per row, in its
  guild's colour (the player's accent, every rival the one rival colour) and labelled with its name. The client no longer
  expands each claimed system's disk, and no longer paints the player's own disks last. So **overlap renders by
  seniority**: a contested hex the engine gave to an older rival claim paints rival even where the player's own disk
  reaches it, and a junior system keeps its own centre in its holder's colour. There is no seniority logic in the
  client.
- **The contract is unchanged.** The map is still `"q,r"` → `{ r, g, b, label }` (`isGate` on a toll gate), so the flat
  fill, the high-zoom hex layer and `pickHex`'s `territory` click read it as before.
- **The single-hex tiles are as they were.** Syndicate waystations paint under the system layer; guild Outposts and toll
  gates paint over it, each from its own source (an Outpost is not in `controlMap`, per the scope bullet above). One
  visible change follows from dropping the own-last pass: a RIVAL's Outpost inside the player's disk now shows the rival
  on its hex, where the player's accent used to cover it. Who controls such a hex is still on the decision checklist.
- **Bounds.** Painted as sent, rim hexes included: the full disks the client painted before (the rim-hex checklist item,
  ruled 16-10-26).
- **Not changed:** the deploy map's refusal words still read a rival's whole disk (`inRivalTerritory`), because the
  engine's Deep Scan Array placement still refuses any hex a rival footprint covers (above). They move to seniority with
  that rule.
- **Proved** by `sim/tests/control-map-client.test.js` (the page's own code in a `node:vm` sandbox over real engine
  snapshots) and headless against a live server (the roadmap's 2.5 as-built entry).

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
**home system is exempt** (a guild can never be evicted from its homeworld). *(⤳ CORRECTED 17-10-26, `design.md` §2 /
§19 #67: there is no orbital-limbo state and no lease-recovery path — the machines become **stranded, system-scoped idle
assets** in the lost system, the goods are forfeit, and recovery is a heavy-haul salvage run. The destroyed path is
BUILT — "AS-BUILT — losing ground, engine PR 1" at the end of this section.)*

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
planted only on a **planet the guild has surveyed to full L2** in its record (*REVISED 08-10-26 —
the flag plants **on** a settlement slot, and a survey reveals the whole surface all-or-nothing, so
"knows a settlement slot of P" = "has surveyed P"; `exploration-model.md` §4 rulings 7, 10 & 11*). A
surveyed planet P opens the gate for P, not for a different planet in the same system. Control then
shows the whole system at L2 anyway (ruling 11), so no far planets are left to reveal. This is
**recorded here by the
exploration slice (roadmap 2.5) and ENFORCED by the Prefecture / claims slice that follows it** —
the gate's data source (the record) exists from birth so the claim action is never retrofitted
onto a fully-visible galaxy. It does not change the claim *row* (still `landmarkKind: 'system'`,
§4 above); it adds a precondition on the deploy-onto-a-settlement-slot step.

**⤳ RULED 16-10-26 — the claim action, the first Prefecture / claims slice (roadmap 2.5).** The claim action is now ruled and being built; the model above (§2's seniority footprint, §4's one-per-system flag, the exploration-coupling gate) is unchanged — this fills in the ACTION that writes the claim and the ferry that positions it. It is the **two-step ground flow** of §5, NOT a deploy-onto-the-slot: the ferry positions the kit, then a separate plant claims.

- **The plant action (the claim act).** From an idle `prefecture` kit sitting in a system's idle list, the player plants it on a **settlement slot** of a planet the guild has **surveyed to full L2** (the gate `exploration-model.md` §8 recorded — `knowsSlot`, enforced here for the first time). It writes the one `landmarkKind: 'system'` claim row with `claimedAtTick`, consumes the kit, and marks the slot occupied — so `sim/occupancy.js` must learn a **non-venture occupant** (`design.md` §2), or a factory will deploy on top of it. It is **exempt from Gate 3** (it is what CREATES the hold). It re-validates at apply: the **slot is free**, the **survey-L2 gate still holds**, and **no guild already holds the system** (a rival who planted first wins — first-to-plant, the seniority spirit of §2). A guild cannot plant in a system it already holds (one-per-system; the home claim has no Prefecture).
- **The ferry — the unheld-system unload exception (§5).** `loadKit` → route → `unload` carries the kit, unchanged, with ONE exception: `unloadKit`'s held-system gate is lifted for a `prefecture` kit, so it may unload into a system the guild does **not** hold. It may unload into an **unclaimed** system (the intended case) or one the guild already holds, but **never into a system a rival holds** — refused up-front at dispatch and re-checked at arrival.
- **Arrival retreat (RULED 16-10-26 — the outpost's logic and messages).** If a rival has claimed the target system in flight, the ferry does not strand the craft in rival space: it **RETREATS exactly as a failed outpost deploy does** — `retreatLanding` toward the nearest held system (always exists, §4), kit aboard, the `deployFailed` flag, and the `deploy_failed` pilot's notice with its Redeploy / Return forks (`event-log.md` §10) — adding ONE new `DEPLOY_FAILED_REASONS` entry for "target system already claimed". The mid-flight un-settle HALT (§8) does **not** apply: a ground asset has no range anchor and the target is unheld by design, so there is nothing to lose but the system to a faster rival.
- **One residual edge (working rule 7, on paper).** A rival claiming the target in the gap between a clean unload and the plant leaves the kit idle in now-rival ground; the plant then refuses ("already claimed") and the player hauls the kit out. Benign until hostile mechanics exist; the plant's unclaimed-system check is the guard.
- **Acquire — BUILD-ONLY.** The Prefecture is dockyard-built, **not Syndicate-sold** (`docs/asset-recipes.md`, `docs/phase-1-tuning.md`) — the deliberate throttle on rapid expansion. Otherwise it rides the solved kit pipeline (`BUILDABLE_INSTALLATION_KINDS`, `mintKitAsset`, `KIT_KIND_FOR_BILL`) exactly as the array does.
- **The seniority control map (§2) is BUILT in this slice** — the 7-hex footprint with overlap resolved by `claimedAtTick` (own-centre override, tie-break lower `claimId`), derived and recomputed on change, extending `controlNear` / the client's `computeTerritoryMap`. (It was ruled-not-built; `controlNear` already hands back every overlapping footprint for the resolver to decide.) *(⤳ Engine half BUILT 16-10-26, engine PR 2 — §2's AS-BUILT note; the client's `computeTerritoryMap` is the next PR.)* *(⤳ Client half BUILT 16-10-26, client PR A: `computeTerritoryMap` paints the engine's `controlMap` — §2's "AS-BUILT — client PR A".)*
- **Scope — claim-only.** Teardown / un-claim / eviction (and so its goods question, §19 #67), hostile removal (§19 #69), the semi-controlled corridors (§3), squatting (Gate 3 stays hard), and the Prefecture's design-ahead **in-system planet-scan** function are all **OUT** of this first slice. It is the solo claim lever: survey → build → ferry → plant → claim → the seniority map. Losing ground comes later.

**AS-BUILT — engine PR 1: acquire + the claim action (16-10-26; roadmap 2.5, the first Prefecture / claims slice; engine
+ operator CLI, no client).** Built to the ruling above, no design change and no new number. The slice is split in two
engine PRs: this one builds everything above **except §2's seniority control map**, which is engine PR 2 (nothing
consumes resolved control yet, and the client's footprint render is untouched); the client is its own PR.
- **Acquire.** The Prefecture is the tenth FINAL bill and a BUILD-ONLY kit (`docs/asset-recipes.md`, AS-BUILT note): a
  finished dockyard build mints one idle `prefecture` kit (good `prefecture_kit`) through the existing kit mint; the
  Syndicate refuses to sell it. `claim_beacon` / `habitation_module` take sub-tiers 3-2 / 3-3 (`docs/phase-1-tuning.md`).
- **The vocabulary** is `sim/prefectures.js` (the `outposts.js` mirror): `PREFECTURE_KIT_KIND` ('prefecture' — the one
  GROUND kit), the ids `prefecture_<guild>_NN` and `claim_prefecture_<guild>_NN` (ONE stored serial,
  `guild.prefectureSerial`, numbers both, so a Prefecture and its claim share NN and neither is ever reissued). The
  space-lane deploy rule refuses the ground kit by name (`deployCheck`, and a `deploy` waypoint naming it), so it can
  never reach the space lane.
- **The ferry exception.** `unloadKitCheck` lifts its held-system gate for a Prefecture kit only: it may drop into an
  **unclaimed** system (or one its guild holds), never a rival's — that refusal is `failure: 'system-claimed'`, asked up
  front by the dispatch (a doomed trip is never flown) and again on arrival. Every other kit keeps the gate word for word.
  `systemHolder(state, systemId)` (`sim/claims.js`, on the same `isSystemClaim` match as `guildHolds`) tells the three
  cases apart.
- **The arrival retreat.** If a rival claimed the target in flight, `resolveRouteArrival` retreats the craft through the
  ONE kit retreat, `retreatKitCraft` — the deploy's retreat, moved out of `resolveDeployArrival` unchanged and now
  shared by both triggers: `retreatLanding` toward the nearest held system, the kit aboard, `deployFailed = { reason:
  'system-claimed', tick }`, and the `deploy_failed` notice (`cause: 'system-claimed'`, `kind: 'prefecture'`). One new
  `DEPLOY_FAILED_REASONS` entry, `system-claimed`. The Return / Redeploy forks work from there (engine side).
- **The plant.** `plantPrefecture { guildId, assetId, slotId }` (`sim/actions.js`; operator `POST
  /admin/guild/plant-prefecture`, `tools/admin.js plant-prefecture`; a player sends the same action through `POST
  /action`). Exempt from Gate 3. Refused, in order: the asset is not an idle Prefecture kit of this guild; the slot is
  not a real settlement slot in the kit's own system; the guild has not surveyed the slot's planet (`knowsSlot` —
  `exploration-model.md` §8, ENFORCED here); the slot is occupied (a venture or a Prefecture); any guild holds the system
  (a rival, or itself — home included). The apply consumes the kit, writes the claim row (`landmarkKind: 'system'`,
  `claimedAtTick` this tick, not contested — `foundGuild`'s shape) and mints the Prefecture row into
  `state.prefectures` (omit-when-empty): `{ id, ownerGuildId, systemId, planetId, slotId, claimId, plantedAtTick }`.
  First to plant wins within a batch (state-as-it-stands).
- **Occupancy** learned its non-venture occupant (`sim/occupancy.js`): `computeOccupancy` maps a Prefecture's slot to
  its id, and `siteOccupantOf` is the one "is this site free?" question all three establishes and the plant ask.
- **Plumbing.** Snapshot: an omit-when-empty `prefectures` block (sorted by id), and the slot in `occupancy`. Fog: a
  Prefecture is a public structure — a rival sees it, cut to `RIVAL_PREFECTURE_FIELDS` (today every field: each is
  already public through the claim row and ruling 11's live L2). State/persist: plain JSON, covered by the hash; a save
  restores it. Invariant: `checkPrefectureIntegrity` (shape, the slot, the claim link — exactly one matching claim row —
  one per system, one occupant per slot, the survey still in the record, the serial).
- **Proved** by `sim/tests/prefecture-ferry.test.js` and `prefecture-plant.test.js` (the round trip: dockyard build →
  a real Deep Scan Array survey → load → ferry → plant → claim → Gate 3 open, ledger balanced), and live through
  `tools/admin.js` on a `seat-demo --seed 42` galaxy, surviving a restart. No pre-existing path moved a byte apart from
  the two re-banded goods' price rows (`sim/tests/rebanded-goods-delta.test.js`).
- **Not built (design-ahead):** §2's seniority map (engine PR 2 — *⤳ BUILT 16-10-26, §2's AS-BUILT note; its client
  render too, client PR A*); the client (the plant affordance, the kit's row, the `system-claimed` label — pinned as awaited in `kit-kinds-client.test.js` /
  `deploy-failed-notice-client.test.js`; *⤳ the kit's row, its ferry and the label BUILT 16-10-26, client PR B1 —
  "AS-BUILT — client PR B1" below; the plant affordance is client PR B2* — *⤳ BUILT 16-10-26, "AS-BUILT — client PR
B2" below*); teardown / eviction (§19 #67), hostile
  removal (§19 #69), corridors (§3), squatting, and the in-system planet-scan.

**⤳ RULED 16-10-26 — a planted Prefecture is a PUBLICLY VISIBLE structure.** A rival sees its row, cut to
`RIVAL_PREFECTURE_FIELDS` (`sim/fog.js`), as it sees a rival Outpost's. Grounds: the claim it wrote is public (ownership
is public, §1 / `exploration-model.md` §1), a controlled system's whole surface is public (`exploration-model.md` §4
ruling 11), and `design.md` §2 calls the Prefecture "a single, visible, destructible anchor". This **ratifies the as-built
engine PR 1 behaviour** (the fog classification PR 1 made in code only; its decision-checklist item 3) — no code change.
A field added to the row later stays hidden from rivals until it is ruled public (the allow-list).

**AS-BUILT — client PR B1: ferry a Prefecture kit to an unheld system (16-10-26; roadmap 2.5, the Prefecture / claims
slice; `client/game.html`, one label in `client/console.html`; no engine change).** The player can now do step 1 of the
two-step ground flow above — the FERRY — from the page; the plant (step 2) is client PR B2, and until it lands a ferried
kit is planted with the operator CLI (`tools/admin.js plant-prefecture`). *(⤳ BUILT 16-10-26 — "AS-BUILT — client PR
B2" below.)* Built to the ruling above and `design.md` §18:
the client mirrors the engine's gate as guidance, and the engine re-checks at dispatch and on arrival. No new number.
- **The kit-kinds row.** The client's one kit table gains `prefecture` (`good: 'prefecture_kit'`, `bill: 'prefecture'`,
  "Prefecture kit" / "Prefecture") marked **`ground: true`** — the engine's one kit with no `DEPLOYABLE_STRUCTURES` row. A
  ground row carries no deploy-map words and no art (none drawn: the popup shows its plain panel). Every screen that asks
  "is this a ground kit?" asks the row, never a list of its own; a sim test holds the flag to `PREFECTURE_KIT_KIND`.
- **The ferry.** The idle kit's row reads **Ferry**, and opens the kit's existing popup: the same carrier pick
  (`carriersFor` — idle, empty heavies berthed at the kit's system) and the same commit (`loadKit`, then the dispatch,
  only if the load was accepted). Only the planner differs: Plan Route opens the planner's **unload mode** for a kit still
  in inventory (`__planFerry`; Finalise returns to the popup), so the route ends `{ type: 'unload' }` at a system, never
  the hex-deploy map. The deploy map is never offered for a ground kit: asked for one, the planner throws.
- **The gate.** `unloadRefusal` mirrors `unloadKitCheck`'s exception: a ground kit may end on a system its guild holds
  or one **nobody** holds; a rival-held system reads "Held by a rival guild", a non-system "Not a system", and Finalise
  holds. Unload mode learns the kit's kind from the popup, or — for a kit already aboard (the Return fork, the Dispatch
  popup's Edit Route) — off the hold, as the engine does. Outpost and Deep Scan Array kits are unchanged: held-only.
- **The ferry's failure.** A retreated Prefecture kit's `deploy_failed` notice now reads "Deployment Failed — Prefecture",
  Reason "System claimed", and offers **Return** only — no Redeploy, which would open the hex-deploy map. Its Return plans
  the unload, which (read off the kit aboard) may end on an unclaimed system, as the ferry may.
- **Proved** by `sim/tests/prefecture-ferry-client.test.js` (the gate held against the engine's own dispatch for every
  kit kind and class of target, the planner, Finalise, the popup's commit order on a stub DOM, the idle row) and the
  extended `kit-kinds-client` / `deploy-failed-notice-client` tests; and headless against a live server (roadmap 2.5).

**AS-BUILT — client PR B2: plant a Prefecture from a settlement slot (16-10-26; roadmap 2.5, the Prefecture / claims
slice; `client/game.html` only; no engine change).** The player can now do step 2 of the two-step ground flow — the
PLANT — from the page, so **the first Prefecture / claims slice is COMPLETE: the claim loop runs end to end from the
client** (survey → build → ferry → plant → claim). Built to the ruling above and `design.md` §18: the page offers the
plant only where `plantPrefecture` would take it, as guidance, and the engine re-checks every gate at the click. No new
number.
- **The offer.** On a planet's Settlements tab, a VACANT slot reads **Plant Prefecture** when the system is held by
  **nobody** and an idle Prefecture kit of the guild's sits **in that system**. That is the engine's gate, read from
  what the page already has: the kit off the guild's idle assets (the kit-kinds row's `ground` flag, as every ground-kit
  branch asks, and the kit's `systemId`); "nobody holds it" off the claims (a system the guild holds — its home, or
  an earlier Prefecture — takes no second one, so there the slot keeps the factory Establish flow); the free slot off
  occupancy; and the survey for free — the tab is drawn only at L2, and in a system nobody holds a slot is listed only
  from the guild's own survey record (`sim/fog.js`), which is `knowsSlot`. Every other slot keeps its old click,
  unchanged: Establish (gated off where the guild holds nothing), Venture Management, the read-only overlay.
- **The confirm and the send.** The slot's click opens a light confirm on the Guild Adviser's card (the shared
  one-page confirm), not the factory Establish popup — a plant has no asset to pick and no licence terms. It names the
  kit (`#NN`), the slot and the planet, says the Prefecture claims the **whole system** for the guild, and that it
  cannot yet be taken down (teardown is deferred, `design.md` §19 #67). Confirm sends `plantPrefecture { guildId,
  assetId, slotId }` and re-reads the snapshot. A refusal — a rival planting first, between the offer and the click —
  is shown in the engine's own words, and nothing is pretended; one plant is sent however often the player confirms.
- **After the plant** nothing is kept by hand: the re-read snapshot repaints the slot, the map (the new claim's
  `controlMap` rows) and Gate 3 (the slot beside it now opens Establish inside held territory). The planted slot reads
  as the guild's own **PREFECTURE** — the page now files the snapshot's `prefectures` rows under their slots, so the
  player's own reads as its own, and a rival's as taken **by that guild's name** (it read "another guild" before, the
  occupancy map naming no owner). An open manifest re-renders when an idle Prefecture kit lands in or leaves a system,
  so the offer appears with the kit.
- **Proved** by `sim/tests/prefecture-plant-client.test.js` (the page's own code in `node:vm` over real engine views:
  an ORACLE holding the offer to the engine's own `plantPrefecture` verdict on every slot of every case — unclaimed with
  the kit there; a rival planted first; held by the guild; the kit elsewhere; a space kit there; the guild's home — the
  row's click, the confirm's words, the exact action sent, the rival-race refusal, an unreachable server, the
  double-confirm guard, and the repaint); and headless against a live server, the whole loop clicked in the page
  (roadmap 2.5).
- **Still not built (the contest-by-force half):** teardown / un-claim / eviction (§19 #67), hostile removal (§19 #69),
  corridors (§3), squatting, and the Prefecture's in-system planet-scan.

**AS-BUILT — client PR C: the claim-pending beacon (16-10-26; roadmap 2.5, the Prefecture / claims slice;
`client/game.html` only; no engine change).** The galaxy map now marks the "ready to plant" state, so a ferried kit is
easy to find again: on the centre hex of every system where an idle Prefecture kit of the guild's lies and **no guild
holds the system**, three hollow rings in the player's accent flow inward from a rim to the centre, tagged `<SYSTEM> /
CLAIM PENDING` at the label zoom. It is pure presentation (`design.md` §18): no game number, no new snapshot field. The
ring count, the 1.5 s fall, the rim (0.85 of the hex, never under 14 px) and the tag's words are a look.
- **The read.** One pure selector, `pendingPrefectures(kits, systemClaims, systems)` (`window.__pendingPrefectures`), over
  what the page already had: the guild's OWN idle ground kits (`myIdleGroundKits`, the plant offer's own read), the claims,
  and the board's centre hexes. One row per system. A rival's kit can never reach it, and a kit aboard a heavy is a hold
  good, not an asset, so it shows nothing until it lands idle.
- **Nothing kept by hand.** The map re-reads the selector every frame, so the beacon appears with the snapshot that lands
  the kit, and goes with the one that plants it (the solid claim fill takes its place) or that shows the system taken.
- **A marker only.** It is not territory (`computeTerritoryMap` never sees it) and adds no click target: a click on the
  hex picks the system as before, and the plant is still made from the Settlements tab (client PR B2).
- **Not marked (RULED 16-10-26, v1 marks the plantable state only):** a **stranded** kit — idle in a system a rival
  claimed first (the residual edge above). It shows only in the fleet list for now; there is no second marker style.
- **Proved** by `sim/tests/prefecture-beacon-client.test.js` (the selector against the engine's own state on every
  system a kit or claim names, both guilds' views; the rings over a stub canvas) and headless against a live server
  (roadmap 2.5).

**AS-BUILT — losing ground, engine PR 1: the destroyed path (eviction) (17-10-26; engine + operator CLI, no client).**
Built to `design.md` §2 ("Losing it evicts the system", corrected 17-10-26) and §19 **#67** / **#69** (RULED 17-10-26) —
the ruling lives there and is not restated here. This is the computational model of the **destroyed** fate only: the
owner abandons a Prefecture and the system goes fallow. The salvage run, the rival-claim sweep, capture / takeover and the
storyteller trigger are later slices. No new number. *(⤳ The salvage run is BUILT 27-10-26 (§5) and the sweep 28-10-26
("AS-BUILT — losing ground, engine PR 4" at the end of this section).)*
- **The abandon action.** `abandonPrefecture { guildId, prefectureId }` (`sim/actions.js`; operator `POST
  /admin/guild/abandon-prefecture`, `tools/admin.js abandon-prefecture --guild ID --id PREFECTURE_ID`; a player sends the
  same action through `POST /action`). Refused, each with its own reason, in order: no such guild; no `prefectureId`; no
  such Prefecture; a Prefecture of another guild's (named — a Prefecture is public); a Prefecture standing in its owner's
  **home** (unreachable — founding claims a home without one and a plant refuses a held system — but asserted, not
  assumed); and one of the guild's craft **flying a Deep Scan Array to deploy on the system's centre** (that deploy
  re-checks on arrival that the system is held, and a centre nobody holds fails `not-bare-hex`, which halts — so the
  abandon waits for the craft to land or be re-dispatched). There is **no reclaim-to-kit**: nothing returns to inventory.
- **The eviction — one shared helper.** The consequence is `evictSystem(state, guild, prefecture, cause, tick)`
  (`sim/eviction.js`), so the storyteller (§9) can later call the same eviction; today the one cause is `abandoned`
  (`SYSTEM_LOST_CAUSES`; an unknown cause halts). In order, failing loud: (0) the home exemption, again — the helper
  halts rather than unclaim a homeworld; (1) **unclaim** — the Prefecture row goes (`state.prefectures` omitted once
  empty) and so does its claim row, so `guildHolds` is false, the seniority map drops the footprint, and the slot is
  free (occupancy is derived from the row); `prefectureSerial` never goes back; (2) **uproot** — every venture the guild
  has in the system is closed through THE shared closure, `applyVentureClosure` (`sim/licence.js`), with a new cause
  **`evicted`**: its RP leaves the guild sum, its node lockout is written when its licence has term left, its
  `venture_closed` notice is recorded, and its machine drops to idle; **no settlement fee** is charged (the closure's
  caller charges it, and forced closure charges none either). Then **every asset the guild has in the system** — the
  machines just freed, any already idle there, and idle kits — is flagged **`stranded = { tick }`**, keeping its
  `systemId` and its condition; (3) **forfeit** — the guild's pool in that system is dropped whole (`forfeitSystemPool`,
  `sim/stock.js`: the positive cells are returned for the notice, the system's key leaves `guild.stockpiles`); goods carry
  no conservation ledger, so this is a plain delete, and the action refreshes the Galactic Supply cache, which falls by
  exactly those goods. Goods aboard the guild's craft are not the pool and are untouched; (4) **intel kept** —
  `guild.exploration` is never touched (the survey record stays byte-for-byte; the live control surface of exploration
  ruling 11 lapses with control, so planets the guild saw only by holding the system leave its view); (5) **one notice** —
  a single `system_lost` event (`docs/event-log.md` §14).
- **The stranded asset.** An additive field on the asset, `stranded: { tick }` — the `{ ..., tick }` shape of a craft's
  `deployFailed` / `laneEnded`, carrying the tick the per-asset salvage timer will need. **Omitted** on every other asset
  (so a galaxy that never abandons is byte-identical — pinned against `main`'s hashes), copied by `createAsset` (a
  `createState` hand-in keeps it) and emitted on the guild's **own** asset rows in the snapshot (a rival's guild row
  carries no assets). It is the first mutation of an asset after its creation, hence its own tick. A stranded machine is
  inspectable and persists; nothing lapses it in this slice (the timer's rate is unset, `phase-1-tuning.md`).
- **The invariant.** `checkStrandedAssets` (`sim/invariants.js`): the flag is exactly `{ tick }` with a whole tick in
  [0, now]; a stranded asset is idle; and it sits **only in a system nobody holds** — the new allowed state (an asset in a
  system its owner does not hold) is allowed only as long as nobody holds that system.
- **The TEMPORARY re-claim guard.** The ruled answer to a rival claiming a fallow system is the **sweep** (the claim takes
  the un-salvaged machines, §19 #67), which is a later slice. Until it lands, `plantPrefecture` refuses — as its new last
  gate — to claim a system that still holds **another guild's** stranded assets ("awaiting salvage"; the reason names
  neither the owner nor the machines). The planter's **own** stranded machines do not block it: re-claiming its own
  fallow system **recovers** them (`plantKit` clears their flags — the sweep applied to oneself), which keeps the
  invariant. The sweep slice replaces the refusal with the transfer; the gate and its comment say so. *(⤳ **AS-BUILT
  28-10-26 — the refusal is gone, the transfer is in** (losing ground, engine PR 4): `plantPrefecture` no longer has this
  gate, so a rival's plant over another guild's stranded machines is legal, and the plant hands them to the planter —
  "AS-BUILT — losing ground, engine PR 4" at the end of this section. The owner's own re-plant still just recovers its
  machines.)*
- **Seams a lost system now reaches.** (a) A kit flying home to unload into the system its guild then abandons: the
  arrival re-check fails and the lane ENDS `target-gone`, the kit still aboard — the path the unload always reserved for
  "a system lost", no halt. (b) An array bound for the centre: refused at the abandon, above. (c) A Syndicate BUY
  delivery in flight to the lost system is lost on arrival by its existing `guildHolds` vanish check. (d) Standing
  structures (an Outpost or a Deep Scan Array anchored on or standing in the lost system) are not machines in the
  system's inventory and are untouched; their placement is not re-checked after the fact, as before. (e) A running lane
  that loads or unloads at the lost system keeps doing so — a transfer at a system has never required holding it — and
  §11.6's "a system lost ends the lane" needs a rule for which lanes it ends (decision checklist).

*(⤳ **SETTLED 19-10-26 — (d) and (e) are now ruled** (design.md §19 #67; an eviction-v2 build, not yet in the code): **every** guild's lane with a stop at the lost system ENDS (§11.6, all guilds, a mere transit excepted); the evicting guild's **Deep Scan Arrays** go **dark** when the eviction pulls the §5 attachment they needed to deploy (the running scan voids, no new scans until re-attached, the structure surviving); **Outposts** stay untouched and reclaimable. The computational detail lands with that build.)* *(⤳ **AS-BUILT 27-10-26** — losing ground, engine PR 3: both are in the code; the detail is "AS-BUILT — losing ground, engine PR 3" at the end of this section. (a)'s kit flying home now has its lane ended by the eviction itself, `system-lost`, rather than on arrival; (b)'s gate is kept, though the eviction now ends that lane too.)*
- **Proved** by `sim/tests/prefecture-abandon.test.js` (the eviction field by field; the refusals; the home, refused and
  halting the helper; no kit returned; the guard refusing a rival, the invariant red when the plant is forced past it,
  an empty fallow system open to anyone, the owner's re-claim recovering its machines; every invariant rule; the
  snapshot; the no-abandon goldens pinned from `main`; persistence and determinism, including an abandon racing a plant
  in one batch; the seams — the centre one halting without its gate, the kit flying home, the BUY in flight; and the
  operator CLI against a real server
  process — exit 0 on an abandon, exit 1 on a refusal).
- **Not built (later slices):** the salvage run and its timer (next), the sweep (after it), capture / takeover and the
  salvage waiver (the investment arc), the storyteller trigger (§9), and any client (the stranded display, the salvage
  UI, the `system_lost` message). *(⤳ 27-10-26: the salvage run is BUILT, without its timer (the rate is still
  unset) — §5's "AS-BUILT — losing ground, engine PR 2".)* *(⤳ 28-10-26: the sweep is BUILT — "AS-BUILT — losing
  ground, engine PR 4" below.)* *(⤳ 28-10-26: the `system_lost` message is BUILT — losing ground client slice 1, the
  notices; `docs/event-log.md` §14's client AS-BUILT. The stranded display and the salvage UI are still to come.)*

**AS-BUILT — losing ground, engine PR 3: the eviction's reach — lanes end, arrays go dark (27-10-26; engine only, no
client).** Built to `design.md` §19 **#67** (SETTLED 19-10-26, "the eviction's reach") — the ruling lives there and is
not restated here. It extends the shared eviction above; nothing of PR 1 was rebuilt. No new number: it reuses
`controlNear`, `endLane` and the scan's own notice.
- **Two new steps in `evictSystem`**, after the forfeit and before the notice (so the intel and the notice are now
  steps 6 and 7; the `system_lost` notice is still written last, the newest in the log):
  - **(4) End the lanes — every guild's.** Each craft, of ANY guild, whose route has a waypoint anchored AT the lost
    system (`{ landmarkKind: 'system', landmarkId }`) has its lane ended through the one `endLane` (moved to
    `sim/routes.js`, beside the reasons, so the eviction reaches it without a require cycle): the route is dropped, the
    craft flagged `laneEnded = { reason: 'system-lost', tick }` — a new `LANE_END_REASONS` entry, distinct from
    `target-gone` because the system still exists — and stamped `updatedAtTick`. Nothing else about the craft changes,
    so it is left where it stopped: idle at its berth; in flight, it finishes its current leg and lands idle at its end;
    in an Outpost dock, it finishes its turnaround and stays parked. Its hold — goods, a kit, a machine aboard — is
    untouched. A waypoint counts whether or not it carries an action (a slice-local reading; checklist). A leg that
    only crosses the footprint is not a stop, nor is a bare hex inside the disk: neither names the system.
  - **(5) Darken the arrays — the evicting guild's.** Each of its Deep Scan Arrays that is running a scan and no longer
    satisfies the §5 attachment — its hex in or beside the guild's OWN control, `attachmentFootprints`
    (`sim/deep-scan-arrays.js`, the same predicate `attachedPlacement` places one by) — has its scan voided by
    `voidDetachedScans`: the job is cleared, nothing is revealed, a `scan_voided` notice is written with
    `reason: 'anchor-lost'` (`docs/event-log.md` §13), and the row is stamped `updatedAtTick`. The array stands. One still
    touching other ground the guild holds keeps its scan; a rival's arrays touch the rival's control, which an
    eviction does not change, and are not asked.
- **Outposts are untouched** — no code: an Outpost stands on its own hex, independent of the system claim, and stays
  reclaimable (tested).
- **Dark is derived, not stored.** `queueScan` gains a gate after its ownership check: an array that does not satisfy
  the attachment is refused ("is dark … takes no scan until the guild's control reaches it again"). So a dark array
  takes no job, and takes one again the moment friendly control abuts it (a re-plant of the system, a new Outpost
  beside it) — nothing to clear.
- **The Outpost path (RATIFIED 28-10-26 by the human — one rule, one code path for eviction and teardown).** An Outpost is control too (its own hex,
  `controlNear`), and an array may hang off one alone, so packing an Outpost up (`reclaimOutpost`) or the operator
  removing it (`removeOutpost`) can detach an array exactly as an eviction can. Both now call the same
  `voidDetachedScans` after the row goes (the reclaim before its `outpost_packed` notice). Without it the new invariant
  would halt on a legal reclaim.
- **The tripwire.** `checkDeepScanArrayIntegrity` now asserts that **a running scan means an attached array**, so an
  eviction (or an Outpost removal) that failed to void a job, or a `queueScan` that slipped its gate, fails loud; and
  that an array's `updatedAtTick`, when present, is a whole tick in [createdAtTick, now]. Placement is still not
  re-asserted of an idle array (it may stand dark), nor of rival control over its hex. `endLane` halts on a reason it
  does not know.
- **Seams.** (a) PR 1's kit flying home to the lost system no longer reaches its arrival's `target-gone` branch: the
  eviction ends its lane first (the branch stays as the defensive end). (b) PR 1's centre-deploy gate is kept, but is
  now belt-and-braces: forced past it, the eviction ends the array's lane and the craft lands with its kit — the halt
  it guarded is unreachable (checklist: retire it?). (c) `routeStoreAt` is unchanged: a lane launched AFTER the loss to
  the fallow system still acts there, as a transfer at any system always has.
- **Byte-identical where it should be.** A galaxy with lanes, scanning arrays and an Outpost around a held system that
  never abandons hashes exactly as on `main` at 291df19 — state and the god's-eye, own and rival views, on the launch
  tick and 760 ticks on (`sim/tests/eviction-reach.test.js`, pinned). No snapshot field was added.
- **Proved** by `sim/tests/eviction-reach.test.js` (16) over the galaxy in `sim/tests/eviction-reach-script.js`; two
  PR 1 seam tests in `prefecture-abandon.test.js` were updated to the new behaviour (above, (a) and (b)).
- **Not built:** the client (the `system-lost` lane notice's words, a dark array's display, the `anchor-lost` card's
  words), the salvage window, the sweep. *(⤳ 28-10-26: the sweep is BUILT — the next note.)* *(⤳ 28-10-26: the
  `anchor-lost` card's words are BUILT — losing ground client slice 1, the notices; `docs/event-log.md` §13. The lane
  notice's words and a dark array's display are still to come, with the map + Operations slice.)*

**AS-BUILT — losing ground, engine PR 4: the sweep — a rival's claim inherits the stranded machines (28-10-26; engine
only, no client).** Built to `design.md` §19 **#67** (SETTLED 28-10-26, the sweep) — the ruling lives there and is not
restated here. It replaces PR 1's TEMPORARY re-claim guard (above) with the transfer the guard stood in for. No new
number: it reuses `deleteAsset`, `nextAssetNumber`, the kit serial, `createAsset` and `recordEvent`.
- **The guard is gone.** `plantPrefecture`'s validate loses its last gate; every other plant gate is unchanged (an idle
  Prefecture kit in the slot's system, a surveyed-to-L2 free settlement slot, the system unclaimed). A plant into a
  fallow system with another guild's stranded machines in it is legal.
- **The sweep, in the plant.** `plantKit` (`sim/actions.js`) calls `sweepStrandedAssets` (`sim/eviction.js`) right after
  `recoverStrandedAssets` — the planter's own machines are recovered first (flag cleared, id kept, no notice), so what is
  left stranded in the system is other guilds'. For each, in `strandedAssetsIn`'s guild-then-asset order (invariant 9):
  its `kind` and `maintenanceCondition` are read; it is retired from its former owner through `deleteAsset` (now in
  `sim/assets.js`, moved from `sim/actions.js` so `sim/eviction.js` can call it without a require cycle — PR 3's `endLane`
  move), which records the former owner's `removedAssetHighWater` so the number is never reissued to it (§15.4 — the
  sweep is the game's first owner change, so this is the first time play needs that record), and the former owner's
  `assets` key goes if that was its last; and a fresh asset is minted under the planter — `assetId(planter, kind, NN)`,
  same kind, same system (now the planter's), the SAME `maintenanceCondition` (inert, so it simply rides along — no
  maintenance built), `updatedAtTick` = this tick, and **no `stranded` flag**: an ordinary idle asset. Each is pushed
  before the next is minted, so `nextAssetNumber` sees it and two never collide. A machine's NN continues the planter's
  per-kind sequence (`nextAssetNumber`); a **kit's** NN is the planter's kit serial, bumped (the kit's own numbering —
  below).
- **Kits too — a reading beyond the brief (checklist).** The brief said "machines" and expected the sweep to move only
  miners and factories. But PR 1 strands a guild's idle **kits** in the system too, and §19 #67 (SETTLED 19-10-26) puts
  every stranded asset — "machines recovered by the salvage run, kits by `loadKit`" — in the one window that "a rival's
  claim → the sweep" closes; and a stranded kit left in a system the claim now holds would halt the tick
  (`checkStrandedAssets`). So a stranded kit changes hands the same way, numbered from the planter's `kitAssetSerial`
  (minting it with `nextAssetNumber`, as the brief's recipe read, would break `kit-asset-serial-monotonic` and could
  reissue a loaded kit's id). Its former owner's kit serial never goes back, so its old id is never reissued either.
- **Both guilds are told** (ruled 28-10-26): one `assets_swept` notice to each former owner, in guild order — the ids it
  lost, and the new holder by name — and one `assets_inherited` to the planter — its new ids, and the Prefecture that
  swept them, naming no former owner (`docs/event-log.md` §15). A plant that sweeps nothing writes neither.
- **What the sweep cannot reach**, by construction (tested): a machine aboard a heavy (the load cleared its flag — it is
  in the hold, not the system; it stays its salvager's, and still cannot be unloaded in a system its guild does not hold)
  and a machine already unloaded elsewhere. Goods were destroyed at the eviction. **Spoiled ground:** the eviction's node
  lockouts are galaxy-scoped and the plant clears none, so the planter inherits machines it cannot at once put on those
  nodes (tested: refused on the locked node, established on a clean one). No code.
- **The tripwires.** `checkStrandedAssets` is unchanged and now fails loud on a claim that missed one (a stranded asset
  in a held system). New, in `checkAssetOccupancy`: **an asset's id names its current owner**
  (`asset-id-names-its-owner`) — every asset's id rebuilds exactly as `assetId(owner, kind, its own NN)`. It covers
  every kind, kits included, unscoped: every engine mint (the founding grant, `grantAsset`, a dockyard build or Syndicate
  delivery, the kit mint) already builds the id that way, and the only ids in the whole suite that failed it were three
  hand-written placeholders in one `sim/tests/assets.test.js` fixture, renamed to the engine's scheme. A sweep that moved a
  row instead of re-minting it trips it at once.
- **Byte-identical where it should be.** Two galaxies that never sweep — an owner re-claiming its own fallow system, and a
  rival claiming an empty one — hash exactly as on `main` at 6b20d2e (state + god's-eye, own and rival views, pinned in
  `sim/tests/sweep.test.js`); no field was added to any existing record, and new asset rows appear only on a sweep.
- **Proved** by `sim/tests/sweep.test.js` (16) over the galaxy in `sim/tests/sweep-script.js`. Four guard-era tests were
  updated to the ruled behaviour, counts unchanged: three in `prefecture-abandon.test.js` (the guard's refusal → the
  plant is legal and sweeps; the forced-past-the-guard invariant → a claim that skipped the sweep; the abandon racing a
  plant → both accepted, the plant sweeping) and the salvage-race seam in `asset-ferry.test.js` (the machine in hand stays
  the salvager's; the one still stranded is swept).
- **Not built:** the salvage window / timer (its rate is unset, `phase-1-tuning.md`; a stranded machine persists until
  salvaged or swept), capture / takeover and the salvage waiver (the investment arc), general redeploy between held
  systems, the operator CLI's printout of a sweep (`plant-prefecture` prints the claim only), and the client (the two
  notices' words, the inherited machines' display). *(⤳ 28-10-26: the two notices' words are BUILT — losing ground
  client slice 1, the notices; `docs/event-log.md` §15's client AS-BUILT. The inherited machines already list as ordinary
  idle rows in Operations; a display that marks them as inherited is not built.)*

## 5. The deployment pipeline — the cross-system asset ferry

Deploying an asset is: **haul a Tier-4 kit on a transport to a target, and place it on
arrival.** This is the deferred cross-system ferry (`design.md` §4), and building it is
what unblocks the Prefecture. Kits are already cargo-modelled
(`ASSET_CARGO_VOLUME = HEAVY_HOLD`, `design.md` §4), so a kit rides as cargo and deploy
consumes it — no bespoke payload path, and no mutation of an existing asset's immutable
`systemId` (a fresh structure is placed). *(⤳ 27-10-26: a GROUND machine now rides the ferry too — the salvage run carries an
existing miner or factory BY NAME, and its unload is the one sanctioned move of `systemId` (`design.md` §4). "AS-BUILT —
losing ground, engine PR 2" at the end of this section.)*

**The player flow.** An idle deployable asset in the Operations panel carries a **Manage**
button → a Manage popup (like the dispatch popup) with a **Deploy** action → a galaxy-map
picker (like BUILD ROUTE mode). The engine highlights the hexes in legal range; the player
picks a hex (deploy → confirm, then a top-left **confirm deployment**), returns to the
popup, picks the **heavy transport** to carry it (fuel + travel-time quoted to the hex),
and clicks **Deploy**. **On arrival, deployment is instant — no build time** (the kit was
built earlier at the dockyard).

**Two lanes.**

- **Space infrastructure** — outpost, toll gate, deep-scan array. Deploy to a **bare hex**
  within range; **instant, usable** on arrival. *(⤳ AMENDED 15-10-26, `exploration-model.md` §5: ONE exception —
  a deep-scan array may also go on the centre hex of a system its guild holds, the craft berthed AT that system.
  BUILT 15-10-26, roadmap 2.5 slice 16 — "AS-BUILT — the centre-hex leg" at the end of this section.)*
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
when their lanes are built (their anchors add outposts) — no reshape. *(⤳ 15-10-26, roadmap 2.5 slice 14b: the
**`deepScan` lane is BUILT** as a sibling key, but in a different SHAPE — `deepScan: { hexes: [ { q, r } ] }`, the
hexes themselves rather than a radius and anchors — because the array's placement is "attached", not a range: one
hex outside a held system's control disk, or beside one of the guild's Outposts. *(⤳ REVISED 15-10-26, slice 15: the
hexes are those in or beside the guild's OWN control — inside a held system's disk, one hex outside it, or beside one
of its Outposts — and never inside a rival's control (`exploration-model.md` §5, REVISED). The shape is unchanged.)*
*(⤳ slice 16: and the centre hex of each system the guild holds — the one landmark hex a lane ever lists; a deploy
there ends berthed AT the system.)* Each lane is omitted when empty, and
`deployRange` when both are. The outpost lane keeps its thin shape unchanged. "AS-BUILT — the `deepScan` paint lane"
at the end of this section.)*

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
tick }`** (`occupied` / `out-of-range`; *⤳ and for a Deep Scan Array `not-attached`, 2.5 (b1), and
`rival-territory`, slice 15 — `DEPLOY_FAILED_REASONS`, `sim/outposts.js`; ⤳ and for a Prefecture kit's unload,
`system-claimed`, 16-10-26 — §4's AS-BUILT note*), the `laneEnded` pattern, so the player can see why; the next
dispatch clears it. *(⤳ 02-10-26: so does unloading the kit — `unloadKit`, "AS-BUILT — asset-initiated slice 1"
below.)* *(Deferred, not built: guaranteeing the landing hex is not itself rival or contested
space. Pulling toward the nearest held system is the ruled behaviour; refining the landing needs the
§1–§3 control map, and lands with it.)*

**The reverse — pickup from orbit.** An evicted or torn-down asset sits in **orbital limbo**
around its planet (`design.md` §5). Recovering it is an ordinary transport haul: fly to the
limbo coordinates, load the asset, haul it home — the deploy pipeline run backwards. *(Built
with the eviction / limbo slice, not this one.)* *(⤳ CORRECTED 17-10-26, `design.md` §19 #67: no limbo coordinates —
an evicted machine is a **stranded** idle asset still keyed by its `systemId` (§4, "AS-BUILT — losing ground, engine
PR 1"), and the pickup is the **salvage run**: a route ending in a load-on-arrival of one stranded machine per heavy hold,
open only while the system is uncontrolled, bounded by a per-asset pooled timer whose rate is unset. The salvage run is
the NEXT engine slice; this lane's shape (a heavy berthed at the asset's own system loads it) is what it extends. A
stranded **kit** is already loadable today by the ordinary `loadKit`, which never asked whether its system is held.)* *(⤳ **BUILT 27-10-26** — the salvage run, as the manual load / dispatch / unload
pair: "AS-BUILT — losing ground, engine PR 2" at the end of this section.)*

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
or the constant. Not built: the paint itself (the client, next), and the `tollGate` / `deepScan` lanes. *(⤳ The
`deepScan` lane is BUILT 15-10-26, slice 14b — "AS-BUILT — the `deepScan` paint lane" below.)*

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
dockyard build path for any installation, teardown / removal of an array, and the scan (2.5 (b2)). *(⤳ 15-10-26: the
dockyard build path and the Syndicate buy are BUILT (slice 14a, `asset-purchase.md` §"Installation kits"); the paint
lane and the client deploy are BUILT (slice 14b — the next note but one).)*
*(⤳ 06-10-26, 2.5 (b2): the scan is built, and an operator `removeDeepScanArray`; a player teardown /
reclaim of an array is still not — `docs/exploration-model.md` §5.)*

**AS-BUILT — the `deepScan` paint lane + the array's client deploy (15-10-26; roadmap 2.5 slice 14b — engine read-path
+ `client/game.html` / `client/console.html`).** Built to "Painting the range" above and to the asset-initiated flow,
generalised from the Outpost to every kit kind. **No new number:** "attached" is geometry and `claimRadius` is seed data.
- **The lane (the one engine change).** `deployRangeFor` (`sim/snapshot.js`) gains a sibling key, `deepScan: { hexes }`:
  the in-bounds hexes with no seed landmark on them that **`attachedPlacement` itself accepts** for the guild, sorted by
  q then r and deduped (invariant 9). The rule is not copied: `attachedHexes` only decides WHERE TO ASK — a "net" of the
  disk within `claimRadius + 1` of each held system's centre and within 1 of each Outpost the guild owns — and puts
  every hex in it to `attachedPlacement` (now exported from `sim/actions.js`, read-only). The net holds every hex the rule
  can accept today, and would still hold them if the rule were widened to the inside of the disk (decision checklist,
  2.5 (b1) item 1). *(⤳ It was widened, slice 15, and the net needed no change — the next note.)* Asking all ~100,000 hexes of the galaxy on every poll would be too slow; a test asks all of them
  instead and requires the two lists to be equal (`tests/attached-hexes-oracle.js`). Like the outpost lane it is
  **GUIDANCE**: guild structures (Outposts, arrays) are not filtered out, and `deployCheck` stays the authority. **Omit
  per lane:** `outpost` when the guild holds no system, `deepScan` when no hex is attached (holding nothing), and
  `deployRange` when both are. A guild holding no system but owning an Outpost (an operator `spawnOutpost` can make one)
  carries the `deepScan` lane alone. A held system with no `claimRadius` HALTS the snapshot, as it halts the rule.
  Derived telemetry: no serialized byte, no determinism hash, no schema bump. The per-guild view keeps the viewer's own
  row whole and a rival's at four fields (`sim/fog.js`, unchanged), so a guild sees only its own lane.
- **What moved.** Every guild row that holds a system gained the lane, so every golden that hashes a god's-eye snapshot
  or a guild's own view with such a guild in it moved by exactly that: `fog`, `deep-scan-array`, `deep-scan-job`,
  `rival-leak-removed` and `scan-notice`. Each is still asserted against its pre-slice hash through a strip,
  `tests/deep-scan-lane-strip.js`, which removes the lane and refuses to be vacuous (a row with an `outpost` lane must
  carry a `deepScan` lane to strip). Every state and persist golden is unchanged.
- **The client's kit vocabulary.** The engine's `DEPLOYABLE_KITS` and `KIT_KIND_FOR_BILL` are not published, so
  `client/game.html` keeps ONE copy, the `kit-kinds` script (`window.__kitKind(kind)`, `window.__kitLabelForBill(bill)`):
  per kit kind its good, its bill kind, the player label ("Deep Scan Array kit" / "Outpost kit"), the structure name,
  the popup art (none drawn yet for the array — *⤳ slice 15: `deepscan.jpg`*) and the deploy map's two phrases
  (*⤳ slice 15: three for the array — a `rival` refusal joins*). A test (`tests/kit-kinds-client.test.js`)
  runs that script and checks it row for row against the engine's tables, and checks `client/console.html`'s two dockyard
  labels against it.
- **The deploy.** OPERATIONS → IDLE gives every kit kind a **Deploy** button (`machineHtml` asks the table). The deploy
  popup (formerly "Deploy Outpost") names the kind in its eyebrow, title, summary and footer. The deploy map follows the
  lane's SHAPE, not its kind: `deployReach` turns `{ radius, anchors }` into the union of disks and `{ hexes }` into
  those hexes, and the dashed-border paint and the refusal read that one set. For an array the border is a band around
  the ring of attached hexes. A hex outside it is flagged "can't deploy here — not attached to your territory" (*⤳ slice
  15: "not in or beside your territory", or "inside rival territory" in a rival's disk*); the
  banner and the empty-route hint name the kind. The map also refuses a hex one of the guild's own arrays stands on. The
  plan list's action reads "deploy · deep scan array".
- **The failed deploy.** The `deploy_failed` forks find the kit aboard through the table's `good`, so Redeploy and Return
  reach a retreated array kit. The Reason fact labels `not-attached` "Not attached", and the title and inbox row name the
  structure ("Deployment failed — Deep Scan Array"; it read the raw kind). *(⤳ slice 15: "Deployment Failed — Deep Scan
  Array", title case, as ruled 15-10-26.)*
- **Proved** headless (Playwright, preinstalled Chromium) against a live `node sim/server.js`, the guild founded through
  the connect screen: 58 checks, zero console errors (`docs/roadmap.md`, slice 14b). Not built: an array on the galaxy map.
  *(⤳ built, slice 15 — the next note.)*

**AS-BUILT — the array's placement REVISED, and its map marker (15-10-26; roadmap 2.5 slice 15 — engine + client).**
Built to `exploration-model.md` §5 "Deploy placement" (REVISED 15-10-26) and "Map visibility"; the detail is §5's
AS-BUILT note there. What this section's pipeline gained:
- **A fourth retreatable reason, `rival-territory`** (`DEPLOY_FAILED_REASONS`, `sim/outposts.js`, beside `occupied` /
  `out-of-range` / `not-attached`): the array's target became a RIVAL's control while the craft flew — today, only a
  guild founding on the system whose disk covers it. It retreats by `retreatLanding`, unchanged, the kit aboard, with
  the `deploy_failed` notice (`cause: 'rival-territory'`), and the per-craft flag invariant accepts it through the same
  list. A rival Outpost planted ON the target still reads `occupied`: deployCheck's order is unchanged.
- **The lane contract, revised.** `deployRange.deepScan.hexes` is every in-bounds, landmark-free hex the REVISED rule
  accepts: in or beside the guild's own control (a held system's disk and the ring past it; an owned Outpost's hex and
  its six neighbours), never inside a rival's (a rival-held disk, a rival Outpost's hex). It stays occupancy-blind for
  the guild's own structures. The net (`attachedHexes`) is unchanged: it already covered the whole disk. Both lanes are
  still guidance; `deployCheck` is the authority.
- **What moved.** No serialized byte (`hashState` goldens unchanged). The `deepScan` lane widened on every guild row that
  holds a system (on the deploy-range fixture's home, 11 hexes → 16), so the raw bytes of every god's-eye snapshot and
  every own view moved by exactly that lane — and every pinned snapshot golden already asserts its hash through the 14b
  strip (`tests/deep-scan-lane-strip.js`), which removes the lane, so not one pinned hash changed.
- **The oracle** (`tests/attached-hexes-oracle.js`) no longer calls `attachedPlacement`: it writes the ruling out on its
  own, over every hex of the galaxy, so the lane, the rule and the helper are all checked against it.

**AS-BUILT — the centre-hex leg: an array on its own system's centre (15-10-26; roadmap 2.5 slice 16 — engine +
client).** Built to `exploration-model.md` §5 "AMENDED 15-10-26 — the centre hex too"; the detail is §5's AS-BUILT note
there. What this section's pipeline gained:
- **The leg.** A deploy waypoint may name a SYSTEM — for a Deep Scan Array only (`CENTRE_KIND`) — and the leg to it is
  an ordinary one that ends berthed AT the system (a landmark location), as a dock route's does; nothing in the leg
  changed. The array's `coords` are the system's centre and its `anchorSystemId` that system. The dispatch's up-front
  "a landmark, not a bare hex" refusal is now asked of `deployCheck`'s first check (so the exception lives in one
  place), with its words unchanged for an Outpost. A heavy already berthed at the system acts in place (§11.9 of
  `transport-model.md`): planted on the dispatch tick, no fuel.
- **Arrival** re-runs the same rule. A failed deploy at a centre retreats by `retreatLanding`, unchanged: the nearest
  held system is the one the craft is berthed at, 0 hexes away, so it lands AT it — it stays put, kit aboard, flagged,
  with the `deploy_failed` notice (`targetHex` the centre, now read from the craft's resolved coordinates). Reachable
  as `occupied` (a second array planted there first) and, on the committed seed, as `rival-territory` (a guild
  founding on an adjacent starter — §6's spacing is not built). Losing the system in flight (no play path) would
  fail `not-bare-hex`, which is not retreatable: the arrival HALTS, naming the tick.
- **The lane contract, extended.** `deployRange.deepScan.hexes` also lists the centre of each system the guild holds —
  the net already held it; `attachedHexes` now keeps a landmark hex when the deploy rule's own ground question,
  `claimedCentreAt`, calls it a held centre, and asks `attachedPlacement` as for any hex. Still occupancy-blind; still
  guidance. The client takes a system click as the target only where the lane lists its centre.
- **The invariants**, widened to exactly this case: the route rule lets a `CENTRE_KIND` deploy stop at a system; the
  array rule lets an array share its hex with the one seed landmark it is anchored to.

**AS-BUILT — the attachment is continuous: a detached array goes dark (27-10-26; losing ground, engine PR 3).** The
"attached" rule this pipeline places an array by is no longer judged only at the deploy. Its own-control half — the
array's hex in or beside a footprint its guild holds (`attachmentFootprints`, `sim/deep-scan-arrays.js`, which
`attachedPlacement` now calls for that half) — is asked of every standing array whenever it would scan: an array that
no longer satisfies it is **dark**. `queueScan` refuses a dark array, and whatever takes control away voids a dark
array's running job at once (`voidDetachedScans` — the eviction, `reclaimOutpost`, `removeOutpost`), with a
`scan_voided` notice, reason `anchor-lost`. Nothing is stored: re-holding the ground (a re-plant, an Outpost beside it)
wakes the array. The rival half of the rule (never inside a rival's control) stays a placement check only — an array
whose hex later falls in a rival's control still scans. The structure is never removed by any of this. Detail:
`exploration-model.md` §5, "AS-BUILT — the array goes dark"; the eviction's side, §4 "AS-BUILT — losing ground, engine
PR 3".

> **RULED 05-10-26 — the reclaim (teardown → redeploy); AS-BUILT 05-10-26, engine half.** The inverse of the deploy: a deployed Outpost with an empty stockpile and nothing docked is packed back into an `outpost_kit` aboard the single empty heavy parked on its hex, which then re-enters this section's flow unchanged. It is built as `reclaimOutpost` (`sim/actions.js`), with tripwires in `sim/tests/outpost-teardown.test.js`. The round-trip test runs deploy, reclaim, dispatch and deploy-on-arrival through this section's machinery, untouched; the redeploy takes a new id. The client half (the Outpost Manager's Teardown affordance) is next. Full ruling and AS-BUILT: `docs/outpost-teardown.md` §9; `design.md` §4.

**AS-BUILT — losing ground, engine PR 2: the salvage run — the cross-system asset ferry (27-10-26; engine + operator
CLI, no client).** Built to `design.md` §19 **#67** (SETTLED 19-10-26, the salvage run) and §4 ("Cross-system use requires a
redeploy … a future redeploy ferries one on a heavy Vehicle whose manifest carries the asset and locks out its hold") — the
rulings live there, and the field-by-field as-built is §4's "BUILT — the cross-system asset ferry". This is this section's
pipeline run backwards for a GROUND machine: a kit is turned into a good for the hold and minted afresh on unload, but a
machine is carried BY NAME and keeps its id, so its existing `systemId` is what moves. No new number.
- **The run.** An abandoned Prefecture (§4's eviction) leaves its machines stranded in the fallow system. (1) `loadAsset
  { guildId, vehicleId, assetId }` puts one aboard an empty, idle heavy berthed in that system — one machine per heavy
  hold — and clears its `stranded` flag. (2) The heavy flies to a held system on an ordinary dispatch (`dispatchVehicle`,
  or a one-shot route with no action), burning its own `fuelCostToRun` per hex as any heavy does. (3) `unloadAsset
  { guildId, vehicleId }`, berthed at a system the guild holds, drops it there as an ordinary idle machine, its `systemId`
  moved. Operator: `tools/admin.js salvage-load --guild ID --id VEHICLE_ID --asset ASSET_ID` and `salvage-unload --guild ID
  --id VEHICLE_ID` (`POST /admin/vehicle/load-asset|unload-asset`; a player sends the same actions through `POST /action`).
- **Salvage-only.** The load refuses a machine that is not stranded, which keeps general redeploy (a healthy machine
  moved between held systems) for its own slice. A stranded machine sits only in a system nobody holds
  (`checkStrandedAssets`), so the same gate keeps the pickup to fallow ground — §19 #67's "only while the system is fallow".
- **No window yet.** Its rate is unset (`phase-1-tuning.md`), so nothing lapses: a stranded machine persists until it is
  salvaged (or, once that slice exists, swept). The flag's `tick` stays the clock's start for the window slice.
- **Manual, not on arrival.** §19 #67's "a route ending in a load-on-arrival" is the eventual automation (a waypoint action,
  as the kit's `{ type: 'unload' }` became); this slice ships the standalone pair beneath it, as `loadKit` / `unloadKit`
  shipped before theirs. A laden heavy's route carries no action at all — its hold is locked.
- **Seams.** In transit, a machine keeps the `systemId` it was loaded from. So a guild that re-claims that system while the
  machine is aboard still cannot establish on it (it is not idle), an abandon there again does not strand it (it is in the
  hold, not the system), and unloading it into that system once re-held is legal (a no-move unload). The TEMPORARY plant
  guard reads only stranded machines, so a machine already in hand never blocks a rival's claim of the fallow system — the
  scramble §19 #67 rules is between the salvager's heavy and the rival's Prefecture. *(⤳ 28-10-26: the guard is gone and
  the sweep is in (§4, "AS-BUILT — losing ground, engine PR 4"); the sweep reads only stranded machines too, so a machine
  in hand is out of its reach and stays the salvager's — the scramble is decided machine by machine.)*
- **Proved** by `sim/tests/asset-ferry.test.js` (22 tests), and live through the operator CLI (`docs/cli-runbook.md`,
  "Salvage").
- **Not built (later slices):** the window, the sweep (it takes only machines still stranded — *⤳ BUILT 28-10-26, §4's
  "AS-BUILT — losing ground, engine PR 4"*), general redeploy, the
  route-action form, and any client (a "carrying — salvaging" craft row, the stranded display, a salvage affordance).

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
to meet a guarantee. *(Rule ruled; the repair is a generator build detail.)* *(⤳ 15-10-26, measured in roadmap 2.5
slice 16: **the repair is not built.** `tools/generate_seed.js` has no de-cluster step, and `data/seed.json` (7331)
still has 6 directly adjacent starter pairs and 18 within 2 hexes; `foundGuild` has no spacing gate either. So two
home disks CAN overlap today — `exploration-model.md` §5 "Overlapping disks" assumed they cannot. On the decision
checklist.)* *(⤳ **RULED 15-10-26 — build the repair as specified here**, in the seed generator, so every NEW galaxy
honours the ≥ 3-hex starter spacing; the 3-hex figure (2 × claimRadius + 1) is confirmed. No founding-time gate.
A galaxy already created keeps its persisted seed and is not changed. Roadmap 2.5 slice 17.)*

**⤳ AS-BUILT 15-10-26 — the de-cluster repair (roadmap 2.5 slice 17; generator only).** Built as specified above;
**no new number.** In `tools/generate_seed.js`:
- **The spacing rule, from the seed.** Two starters are too close when their claim footprints would share a hex:
  `hexDist ≤ a.claimRadius + b.claimRadius` (`startersTooClose`). Every system's `claimRadius` is 1, so this is
  "not within 2" — the ruled 3 = 2 × claimRadius + 1, read from the seed rather than written down again.
- **Who is the junior (`repairStarterSpacing`, pipeline step 8b).** It runs right AFTER starter tagging and BEFORE
  the rare-tier repair (step 9). It walks the starter systems in the generator's own system order (`sys_0001`
  upward) and KEEPS one only if no starter already kept is too close; otherwise it demotes it. Only kept starters
  block — a demoted system no longer counts, so in a chain A–B–C where B is 2 from A and C is 1 from B but 3 from
  A, B is demoted and C is kept. Deterministic, and the fewest demotions this greedy order can make.
- **What demotion does.** EVERY Terran planet of the junior is converted to a non-Terran archetype, re-drawn from
  the system's own ring-weighted table with Terran left out (`pickArchetype(rand, ring, 'terran')`), and its
  resource nodes are regenerated — the convert-in-place `repairRareTierGuarantee` uses. The system's
  `starterEligible` is then re-derived from its planets (so false). Nothing is converted TO Terran, and the
  rare-tier repair after it converts only to a rare tier, so it cannot re-make a starter and re-break the spacing.
- **The blast radius — only the converted planets.** The repair draws from its OWN side stream,
  `mulberry32(seed ^ STARTER_SPACING_STREAM)` (a stream label, not a game number), never the main one; and a
  converted planet's settlement slots come from that side stream too. A Terran planet takes no main-stream draw
  for its slots (a fixed 15), so the main stream's draw count — and every other planet's slots — are unchanged.
  Measured: with the repair skipped, the generator's output is byte-identical to the generator before this slice
  (apart from the new validation line and the new stat), so every planet outside a demoted system, and every
  non-Terran planet inside one, is byte-identical. This holds whenever the rare-tier repair fires zero times, as it
  does on every seed measured (7331, 42, 222, 777, 4242, 4343, 9999). On a seed where it fires, a smaller starter
  pool and the converted planets (now rare-tier candidates) can change what it converts, and so the main stream
  after it.
- **Validation (step 10)** gains "no two starters share a footprint", naming the first pair. Its other checks
  stay. If the repair ever left a sector with no starter, the existing sector check fails, naming the sector —
  the repair never quietly un-demotes.
- **`data/seed.json` (7331) regenerated through the CLI:** 335 → **319** starters, **16** systems demoted, **20**
  Terran planets converted; all 16 sectors still covered; validation PASSED. The diff touches only those 20
  planets, the 16 `starterEligible` flags and four `stats` lines (`starterSystems`, `totalResourceNodes`
  51,273 → 51,168, `totalSettlementSlots` 32,706 → 32,509, and the new `starterSpacingDemotions`). Seed 42 (the
  CLI runbook's): 397 → **380**, 17 demoted, 20 converted; its home `sys_0006` and every runbook hex unchanged.
- **A created galaxy is untouched.** The load path reads the volume's `seed.json` (`sim/persist.js` `loadSeed`);
  only Create Galaxy calls the generator. A galaxy created before this slice keeps its side-by-side starters, so
  §2's overlap and the as-built "refused for both" (`exploration-model.md` §5) can still arise there; the engine
  path stays tested on a hand-edited seed.

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
- ~~Starter minimum separation value (3) — confirm as the generation constant.~~ — **CONFIRMED 15-10-26** (3 =
  2 × claimRadius + 1) and **BUILT** the same day, roadmap 2.5 slice 17: §6's de-cluster repair, read from the
  seed's `claimRadius`.
- The deploy map (client slice 2): ~~whether to show the engine's time / fuel quote before Deploy~~ — **RULED yes,
  BUILT 01-10-26:** the Deploy Target panel shows it once a hex is picked (§5). **Still open:** the arrow-key pan
  step (built at 120 screen px) — see the roadmap's decision checklist.
- Squatting enforcement (detection, penalty, report/bounty) — deferred to 2.5 / Phase-6.
- ~~The BUILD-ROUTE / deploy-map pan control — client build detail.~~ — **BUILT 01-10-26:** arrow-key pan in the
  shared planning mode (client slice 2; its step is the item above).
