# The exploration & fog model — per-guild visibility

**DESIGN-AHEAD, 05-10-26 (the design room).** The computational model for fog of war:
how the galaxy flips from "one snapshot, everyone sees everything" to a per-guild
filtered view, what each guild learns and how, and the Deep Scan Array's discovery
function. `design.md` §2 ("Fog of war — per-guild visibility") holds the narrative and the
headline rulings; **this file is the model**, the same split `territory-model.md` runs under.

Status by part: the **visibility model (§1–§3)**, the **per-guild snapshot + exploration
record (§7)**, and the **Deep Scan Array's discovery scan (§5)** are the current build
(roadmap 2.5, the exploration slice). *(⤳ 05-10-26: the ENGINE half of §3/§6/§7 — the record, the
one `reveal`, founding state, the rival-licensed-venture source, and the per-guild
`buildSnapshot(state, guildId)` — is BUILT, roadmap 2.5 (a); see the AS-BUILT notes in §3, §6, §7.
The Deep Scan Array (§5) and the client are the next slices; §8's gate is recorded, not enforced.)*
*(⤳ 06-10-26: the Deep Scan Array's **Form** and **Deploy placement** (§5) are BUILT, roadmap 2.5
(b1) — the array is a deployable structure that sits there; its **scan** is slice (b2), still
design-ahead.)* *(⤳ 06-10-26: the **Discovery — the scan** half of §5 is BUILT, roadmap 2.5 (b2) — one job
per array, L1/L2, the per-planet chain, unclaimed targets, completion re-validated, the job lost with its
array; AS-BUILT note in §5.)* **Monitoring (§5, the deferred half), L3 espionage,
the semi-controlled corridors, and the Prefecture self-scan (§4) are design-ahead and
NOT built here** — recorded so the slices that build them read the real ruling, not a
paraphrase.

## 0. The through-line

The Syndicate is a shared public company; every guild is a shareholder. That fixes what is
public and what is private:

- **Licensed = declared to the Syndicate = public.** A licensed venture's *type* is visible
  to everyone (it is on the public register); its *stockpiles* are not (§405).
- **Ownership = public.** Who controls a system is a shareholder-register fact — never fogged.
- **Geography = learnable, and permanent once learned.** The map is fixed and real; a guild
  simply may not have surveyed a given system yet. What it has surveyed it keeps forever.
- **Operations = private.** Transports, un-licensed interiors, exact holdings — hidden until
  the deferred espionage layer (L3) prises them open.

## 1. The four visibility levels, and how a guild cuts through each

The levels are a depth scale; what matters in play is the *method* that cuts each layer, which
depends on the guild's situation.

- **L0 — never fogged, for every system:** position + planet count + controlling guild. Plus
  **every Syndicate waystation is always visible.** Nothing cuts L0 because nothing hides it.
- **L1 — a system's planet archetypes.** Cut by **either**: a transport sitting idle in the
  system (instant, but costs the trip — fuel + travel time), **or** a Deep Scan Array L1 scan
  of the system (no trip, but takes time). The player picks whichever is cheaper for the case.
- **L2 — a system's resource nodes (count + type), per planet.** Cut **only** by a Deep Scan
  Array, scanning one planet at a time (time-based). A transport cannot do it — it has no
  survey equipment, only orbital observation. *(Later also by a Prefecture's own in-system
  scan, §4, and by L3 espionage — both deferred.)*
- **L3 — espionage. DEFERRED.** A rival-controlled system's hidden interior: un-licensed
  nodes, stockpiles, transports, deep-scan arrays. Cut **only** by a spycraft deployed to the
  rival system — a hybrid of full visibility and L2, keyed to how the rival licenses. Not this
  slice.

## 2. Who sees what — situation × method

- **Your own systems.** Everything you have *learned*. On claiming a system (planting a
  Prefecture) the whole system lifts to L1, and the **settled planet** lifts to full L2; the
  system's **other planets stay at L2-fog until you survey them** (the "bounded no", §4). Your
  **home system is fully known from founding** (§6).
- **Unclaimed / frontier systems.** L0 always. L1 by a craft visit or an array L1 scan; L2 by
  an array per-planet scan. These are the only systems you *scan* — rival systems are read off
  the public record, not scanned (scanning a rival is L3, deferred).
- **Rival-controlled systems.** L0 always (position, planet count, controller). Plus, **per node
  that carries a licensed venture**: that node, its planet's archetype, the venture *type*, and
  *(RULED 06-10-26)* the venture's **reputation** — `design.md` §5: "ventures carry a **fully
  visible** reputation score", the investment-risk signal and takeover trigger a rival watches —
  but **never the stockpile**, never its **licence terms**, and never a refinery's **recipe /
  produced good** (the §405 rule: types are visible so a rival *infers* the inputs, it is not told
  them; this also closes the old rival-stockpile leak). A rival's **un-licensed** nodes stay fogged
  until L3. A craft sent to a rival system reveals **nothing new** — the archetypes are already on
  the public record and it cannot survey nodes.
- **Rival structures.** Outposts and toll gates are **always** visible; transports and deep-scan
  arrays are **never** (until L3).
- **Syndicate.** Waystations always; your **own** buy-order deliveries visible (already built and
  ruled — out of scope, untouched here); rivals' deliveries not.
- **Galaxy-wide aggregates — coarsened to posted values (RULED 06-10-26).** `design.md` §5: "the
  real supply figure is hidden; players see only the value and its history." Public: the posted
  prices and their histories, the fuel price, the Syndicate pool (`reserve` — shared, nobody's
  holding) and the controller's demand signal (`avgDraw`, `targetReserve`). Not public: any
  Σ-of-every-guild total — galactic supply's `resources`, `fuel.guildHeld` / `fuel.total`, and the
  Syndicate `ledger` (by invariant 2 it moves opposite Σ guild credits) — because a guild that
  subtracts its own share from one reads its rivals' holdings, exactly when there is one rival.
- **Node lockouts — filtered (RULED 06-10-26).** A lockout (the Syndicate's bar on re-establishing a
  torn-down licensed venture's site) is shown only on a node the guild **knows** (its record) or on
  ground it **controls** (where the lockout gates its own establish). Otherwise it would name a node
  in a rival system the guild never learned — e.g. one licensed and torn down between two ticks. A
  settlement slot is not a node, so a slot's lockout shows only on ground the guild controls.

## 3. The two sources — the architecture

Every guild's view is the **union of two things**, and keeping them distinct is what keeps the
model honest:

1. **The per-guild exploration RECORD** — static geography (planet archetypes, resource nodes),
   **learn-once / known-forever**. *Any* source that reveals a node's geography writes it into
   your record permanently: your own scan, a craft visit (L1), or a rival's licensed venture
   teaching you one node. A rival later closing that venture drops the *live* fact (the venture
   type disappears) but **never** the *geographic* fact — the node and its type stay in your
   record. This record is OWNED guild state (§7) and it is **what the claim gate reads** (§8).
2. **The live RULES** — dynamic activity, recomputed from current state every tick: controllers,
   rival licensed ventures, rival structures, Syndicate waystations, your own deliveries. These
   lift and re-fog on their own as the world changes; nothing about them is remembered.

A guild's snapshot view = **L0 (always) ∪ its record (permanent) ∪ the live rules (recomputed)**.

> **⤳ AS-BUILT 05-10-26 (roadmap 2.5 (a), engine slice 1 — the record half; `sim/exploration.js`).**
> Source 1 is built as `guild.exploration` (the shape is in §7's AS-BUILT note). The one source this
> slice wires into it besides founding is **a rival's licensed venture**, observed by
> `observePublicRegister` at the **END of every tick** (`sim/tick.js`, after the eight steps, beside
> the fuel-price sample): every guild reads each *rival's* licensed ventures (an ordinary `licence`
> or a `deuteriumLicence`) off the register and `reveal`s what each teaches — on a resource node, that
> node (and with it its planet's archetype); on a settlement slot, only the planet's archetype (a slot
> is not a node). Why there: **not in the view**, which stays pure (a read that wrote state would make
> the record depend on who looked, and when — invariant 9); **not inside a step**, because it is
> observation, not economy — no step reads the record, so its position cannot move any number, and the
> eight-step order is unchanged; **last**, so it reads the register as the tick leaves it. A venture
> licensed by an action is observed at the next tick's end, so one licensed and closed between two
> ticks was never on the register at a tick and teaches nothing. A guild never learns from its own
> ventures. An unlicensed rival venture writes nothing. Closing a licensed venture undoes nothing.

## 4. The rulings

**Settled earlier (carried, authoritative):**

1. **Persistence is learn-once / known-forever, uniformly** — any source → permanent geographic
   fact (§3).
2. **Controller is public at L0**, as are **licensed-venture types** (the shareholder register).
3. **The claim gate reads the record** — see §8.
4. **Scanning a rival's territory is espionage (L3), DEFERRED** — allowed later with a discovery
   chance + fine, not this slice. Scanning here is for unclaimed / frontier geography only.
5. **Buy-only transport visibility** — your own buy deliveries are visible, rivals' are not.
   Already ruled and built; out of scope.

**Settled 05-10-26 (this session):**

6. **The claim reveal is bounded ("bounded no").** Planting a Prefecture reveals the whole
   system to L1 and the **settled planet** to full L2. The system's **other planets stay fogged
   at L2** until surveyed — owning a system does not auto-survey it. (This refines, and is the
   precise form of, §2's "own systems: everything": own systems show everything you have
   *learned*, plus L0/L1 of the whole system on claim; L2 of the far planets is earned.)
7. **The claim gate is per-planet.** A guild may plant a Prefecture on a planet **iff it knows at
   least one of that planet's nodes** in its record — however that one node was learned (a scan,
   or a rival's lapsed licensed venture). Planting then reveals the **rest of that planet's**
   nodes. Knowing a node on planet P lets you settle P, not a different planet Q in the same
   system. (See §8 for the coupling the Prefecture slice enforces.)
8. **A transport reveals L1 only.** A craft sitting **idle in an unclaimed system** reveals that
   system's archetypes (all planets) instantly, for the price of the trip. It never reveals nodes
   (no survey equipment). **Passing through** a system's hexes reveals nothing — only coming to
   rest on the system counts. A craft at a **rival** system reveals nothing new.
9. **The Prefecture self-scans its own system — faster than the array. NEXT-SLICE RULING, not
   built here.** A deployed Prefecture can run an L2 scan on planets *in the system it governs*,
   quicker than a Deep Scan Array surveys the same planet remotely (boots on the ground vs a
   remote ping). It is the reward for planting the flag, and it is how you fill in a claimed
   system's far planets. The *direction* is ruled (prefecture L2 duration < array L2 duration);
   the numbers are `[FIRST-CUT]`, deferred to `phase-1-tuning.md`. **The exploration slice builds
   none of this** — it only keeps the record's write path source-agnostic (§7) so the Prefecture
   slice can add itself as a source.

## 5. The Deep Scan Array

This slice's new asset. Dual-function **by design**; only the first is wired here.

**Form.** A **deployed single-hex structure** riding the built deploy pipeline
(`territory-model.md` §5), exactly as an outpost or toll gate. It gets a position by being
deployed, which is the anchor the deferred monitoring function needs. **No aura this slice** —
the aura is a monitoring concept (`territory-model.md` §3). The array creates no control
footprint and changes no territory.

**Two distances — do not confuse them:**

- **Scan reach = galaxy-wide / unbounded.** The array's defining power: once deployed, it can
  queue a scan against *any* system in the galaxy, with no fuel and no craft travel. This is a
  **ruling** (05-10-26).
- **Deploy placement = "attached".** The array's hex must be **directly adjacent to (sharing an
  edge with) a system or outpost footprint the guild holds** — planted touching its own
  territory, not floating in deep space. It rides the deploy pipeline's arrival-revalidation:
  if the hex is no longer adjacent to a held footprint when the kit arrives, the deploy fails
  and the existing retreat rule fires (`territory-model.md` §5). **This SUPERSEDES the old
  `[FIRST-CUT]` "deep scan ≤ 5 hexes" deploy range** on the territory checklist. Because the
  scan is galaxy-wide, placement does nothing for discovery this slice — its payoff is the
  deferred monitoring aim. Recorded honestly so nobody later wonders why placement is fussy but
  inert.

> **⤳ AS-BUILT 06-10-26 — Form + Deploy placement (roadmap 2.5 (b1); engine + operator, no client, no
> scan).** Built to "Form" and "Deploy placement = attached" above; **no new number** — "attached" is
> geometry, and `claimRadius` is seed data.
> - **The kit.** One new row in `DEPLOYABLE_KITS` (`sim/resources.js`): kind **`deepScan`** (the lane key
>   `territory-model.md` §5 reserved) → good **`deep_scan_array_kit`**. That row alone makes it a kit asset
>   kind, an off-market deployable good taking a whole heavy hold, and lets the existing grant / load /
>   unload / ferry carry it. It is obtained exactly as the outpost kit is — the operator `grantKit` lever.
>   **No dockyard build path** (the installation bills stay data-only, `sim/asset-recipes.js`).
> - **The structure** lives in its OWN top-level list, **`state.deepScanArrays`** — beside, not inside,
>   `state.outposts` (an array has no stockpile, capacity or dock, and every Outpost row stays
>   byte-identical). A row is `{ id, ownerGuildId, coords, anchorSystemId, createdAtTick }`, the id
>   `deepScanArray_<guild>_NN` from a stored per-guild serial (`guild.deepScanArraySerial`, never
>   reused — `sim/deep-scan-arrays.js`). **Omit-when-empty**: a galaxy with no array carries no key. Minted
>   only by a guild's deploy (`mintDeepScanArray`, `sim/actions.js`). No scan or fan fields: nothing reads
>   them yet. Guarded every tick by `checkDeepScanArrayIntegrity` (real owner, an id naming it, a real
>   anchor system, an in-bounds hex, `createdAtTick` in [0, now], one structure per hex across seed
>   landmarks, Outposts and arrays, the serial never below a live id).
> - **The rule — the one deploy rule, generalised by kind.** `deployCheck` now takes the KIND it is
>   placing (the deploy waypoint's `kind`; for the manual `deployAsset`, the kind of the kit aboard). Its
>   first three checks stay shared — `not-bare-hex`, `kit` (now "exactly one kit **of that kind**", so a
>   craft carrying an array kit cannot be sent to plant an Outpost, nor the reverse), `occupied` (ONE
>   STRUCTURE PER HEX: `hexOccupant` now sees arrays too, so no array on an Outpost's hex, no Outpost on an
>   array's) — and the fourth, **placement**, dispatches on the kind (`DEPLOYABLE_STRUCTURES`): the
>   Outpost's range rule, moved verbatim; the array's **attached** predicate. `deployKit` mints by kind.
>   Both triggers (the manual deploy and the on-arrival deploy) get the array at once.
> - **The attached predicate.** The hex must touch a footprint the guild holds: `hexDistance(hex, centre)
>   === claimRadius + 1` for a system it holds (the ring just outside its control disk; `claimRadius` read
>   from the seed by `getClaimRadius`), or `hexDistance(hex, outpostHex) === 1` for an Outpost it owns
>   (an Outpost has no aura, so its footprint is its own hex). A hex **inside** a footprint is not
>   attached: the system's centre is a landmark (`not-bare-hex`), and a bare hex within `claimRadius` is
>   refused by the predicate itself (`not-attached`). A rival's territory never counts.
> - **The anchor.** A held **system** first (the lowest id); else the lowest-id owned **Outpost**, and the
>   array takes *that Outpost's* `anchorSystemId` — so `anchorSystemId` always names a system (a seed id
>   that can never dangle), with the meaning it has on an Outpost.
> - **Arrival.** A deploy that loses its attachment in flight (e.g. the Outpost it touched is packed up)
>   fails with the new retreatable reason **`not-attached`** (`DEPLOY_FAILED_REASONS`) and retreats by the
>   existing rule (`retreatLanding`, unchanged), the kit aboard, with the `deploy_failed` notice. An
>   arrival that must retreat while its guild holds no system (corrupt — a guild never loses its home)
>   HALTS, naming the tick.
> - **The view.** `deepScanArrays` is a god's-eye snapshot block (rows `{ id, ownerGuildId, coords,
>   anchorSystemId }`, omit-when-empty), classified **filtered** in `sim/fog.js`: the per-guild view keeps
>   only the viewer's OWN arrays, and omits the key unless the viewer owns one — a rival's array appears
>   nowhere, not even as an empty list (§2: "deep-scan arrays are never" visible).
> - **Proved:** the outpost deploy path is byte-identical to `main` before the slice (state, god's-eye
>   lens and every refusal, hashes recorded on a60d98e — `tests/deep-scan-array.test.js`), and the five
>   god's-eye hashes of 2.5 (a) still hold.
> **Not built:** the scan (below — slice (b2)), monitoring, teardown or removal of an array, a dockyard
> build path, the client (the deploy map's `deployRange.deepScan` paint lane, the array on the map).
> *(⤳ 06-10-26, 2.5 (b2): the scan is BUILT, and so is an **operator** removal, `removeDeepScanArray` — see
> the scan's AS-BUILT note below. A player teardown / reclaim is still not built.)*

**Discovery — the scan (IN SCOPE).** *(⤳ BUILT 06-10-26, roadmap 2.5 (b2) — the AS-BUILT note
follows the bullets.)* The throttle, now that distance is removed, is **time +
queue depth**:

- **One active scan job per array.** Scale by building more arrays, not by parallelising one.
  First cut: **no backlog** — when a job finishes the array sits idle until the player assigns
  the next (maximally interactive, minimal state; a fillable queue is an easy later add).
- **Two job granularities:** an **L1 system scan** (reveals all the system's archetypes, one
  job) and an **L2 per-planet scan** (reveals one planet's nodes). Durations `[FIRST-CUT]`:
  **L1 = 12 h (720 ticks)**, **L2 = 8 h (480 ticks)** → `phase-1-tuning.md`. A six-planet system
  thus takes 12 + 6×8 = **60 h (2.5 days)** to survey fully — tuned so that for close systems a
  craft-scout (instant L1) or a Prefecture (fast in-system L2) stays competitive with the array
  rather than the array being strictly dominant.
- **The L1→L2 chain — per PLANET.** You cannot queue an L2 scan on a planet until you already know
  **that planet's archetype** (L1). *(REFINED 06-10-26 from "know its system at L1": the gate asks
  about the target planet only, not the whole system. In practice you get there by an L1 scan of the
  system, which reveals every archetype in it at once, or a craft visit — but knowing planet P opens an
  L2 on P, not on its neighbour Q.)* This keeps a human in the loop — survey broadly, look, then spend
  the expensive per-planet L2 on what is worth it — rather than the array becoming an automatic
  all-mapper.
- **Targets are unclaimed systems only.** The queue refuses a rival-controlled target (that is
  L3, deferred); your own systems you already know. **Revalidate at completion** — the same
  "legal to schedule, re-checked on arrival" shape `sim/claims.js` uses for buy deliveries: if a
  system you are scanning becomes rival-held before the job finishes, the job **completes to
  nothing** (no partial reveal). An array **torn down or destroyed mid-job loses the job**; any
  geography already banked persists (learn-once, §3).

> **⤳ AS-BUILT 06-10-26 — Discovery, the scan (roadmap 2.5 (b2); engine + operator/headless, no client, no
> monitoring).** Built to the bullets above. **No new number:** the two durations are the ruled
> `[FIRST-CUT]` ones from `phase-1-tuning.md`, defined once as `SCAN_L1_TICKS` (720) / `SCAN_L2_TICKS` (480)
> in `sim/deep-scan-arrays.js` (`SCAN_TICKS`). The scan is a new **source** for the existing record — it
> writes only through the one `reveal`, never a second writer.
> - **The job** is one optional field on the array row, **`scan`**: `{ level: 'L1', targetSystemId,
>   startedTick, completeTick }` or `{ level: 'L2', targetPlanetId, startedTick, completeTick }`, with
>   `completeTick = startedTick + SCAN_TICKS[level]`. **Omit-when-idle** — an idle array carries no key, so it
>   is byte-identical to a b1 row, and a finished job deletes the key. Serialized (invariant 9); no
>   monitoring field.
> - **`queueScan`** (`sim/actions.js`) — `{ guildId, arrayId, level, targetSystemId | targetPlanetId }`.
>   Refused whole, in this order: the guild is real; the array is real **and this guild's**; the array is
>   **idle** (one job, no backlog — the throttle is building more arrays; there is no cancel); `level` is L1
>   or L2 and the action names **exactly** that level's target, which the seed holds (an L1 a system, an L2
>   a planet); the target's system is **unclaimed** (`systemControllers` has no row for it — a rival's is
>   refused as L3 espionage, your own as ground you already know); for an L2, **the chain**:
>   `knowsPlanet(guild, targetPlanetId)`. **No reach check** — any system in the galaxy is a target. The
>   apply stamps the job from the current tick. A scan costs no fuel and no credits (no price is ruled).
> - **Completion — a due-tick reveal**, `stepScanCompletions` (`sim/deep-scan-arrays.js`), run in
>   `sim/tick.js`'s **end-of-tick observation block** right after `observePublicRegister`: observation, not
>   economy (no step reads a job or the record, so the eight-step order is untouched), after the steps so it
>   reads the claims as the tick leaves them, and stamped with the tick just built, so its order against the
>   register observation changes no value. Arrays in id order; a job is due when `completeTick <= tick`, so
>   one queued at tick T reveals at the end of tick T + 720 (L1) or T + 480 (L2). **Re-validated:** if a
>   **rival** now controls the target's system the job **completes to nothing**; unclaimed, or now held by
>   the scanning guild itself, both reveal. **L1** → `revealSystemArchetypes` (every planet's archetype, **no
>   node** — unlike founding's `revealSystem`); **L2** → `revealPlanetNodes` (every resource node of the one
>   planet). Both are loops over `reveal` (`sim/exploration.js`), so learn-once holds: a known fact is a
>   no-op and keeps its first tick. The job clears either way.
> - **Array lost mid-job.** The operator lever **`removeDeepScanArray`** (`{ guildId, arrayId }`) mirrors
>   `removeOutpost`: an owner-checked delete of the row, the per-guild serial untouched (ids never repeat),
>   the list dropped when it empties. The job lives on the row, so it goes with it and its reveal never
>   fires; banked geography stays. Not a player teardown — that is a later slice.
> - **The view.** `snapshotDeepScanArrayRow` carries the job (a fresh copy, omitted when idle) so slice (c)
>   can show it. `sim/fog.js` is unchanged: arrays are own-only, so the job rides the owner's row and never
>   reaches a rival — a rival's scan, queued or completed, moves not one byte of the viewer's view.
> - **Tripwire** (`checkDeepScanArrayIntegrity` → `checkScanJob`, `sim/invariants.js`): a present job is an
>   object (omit-when-idle), of a ruled level, naming exactly its level's real target; `startedTick` in
>   [the array's `createdAtTick`, now]; `completeTick` exactly the ruled duration on; **never overdue**
>   (`completeTick > now` — a due job is cleared on its tick); and an L2's planet is still in the owner's
>   record (the chain, kept true by learn-once). The completion step halts, naming the tick, on a job of an
>   unknown level or an array with no owning guild.
> - **Proved:** a galaxy whose arrays are idle is byte-identical to `main` before the slice (state, the
>   god's-eye lens and both guilds' views, hashes recorded on 52e5e3f — `tests/idle-array-script.js`,
>   `tests/deep-scan-job.test.js`), and the five god's-eye hashes of 2.5 (a) and the outpost-path hashes of
>   (b1) still hold.
> **Kit kind — RULED 06-10-26:** the array's kit kind stays **`deepScan`** (it matches the deploy-lane
> convention `tollGate` / `deepScan`). Its correspondence with the installation bill's kind
> `deep_scan_array` (`sim/asset-recipes.js`) is a **deliberate seam**: the future slice that gives
> installations a dockyard build path bridges it, for the array and the toll gate together.
> **Not built:** monitoring, L3 espionage, a scan cancel, a player teardown / reclaim, a completion notice,
> the client.

**Monitoring — the watch (DEFERRED; design-ahead, NOT built).** A continuous watch that surfaces
dynamic activity (rival transports, anomalies) — the counter-play to "operations are private",
the feeder for the semi-controlled corridors (which need claims), and the home of the catch/fine
machinery ruling 4 defers. Shape as designed 05-10-26: **proximity-bound and directional** — the
player picks one face of the array; the watch covers a **fan/wedge in that single direction**,
array at the apex, reach about **4 hexes**, roughly a 16-hex wedge aimed outward. *(The exact hex
tiling is intentionally left open: "forward 4" and "forks of 4 per side" describe two different
depths on a hex grid — a 4-per-side diamond actually reaches 6 hexes at its far point. The intent
is a short directional fan; the precise cell set — and the 4-vs-6 reconciliation — is pinned, with
a diagram, when the monitoring slice is built.)* Specify the array's entity as dual-function from
birth so monitoring slots in, but **do not add fan/direction fields this slice** — nothing reads
them yet and dead fields only muddy the determinism hash; the monitoring slice adds them.

## 6. Founding state

A newly founded guild knows:

- its **home system fully** — L1 + L2, every planet (it has lived there);
- **L0 of the whole galaxy** (position, planet count, controller — always public);
- **nothing else** until it scans or visits.

The home-system knowledge is seeded into the guild's exploration record at founding, by the same
source-agnostic reveal path (§7) everything else uses.

> **⤳ AS-BUILT 05-10-26 (roadmap 2.5 (a)).** The `foundGuild` apply (`sim/actions.js`), right after
> the home claim, calls `revealSystem(guild, homeSystemId, tick)` — every planet of the home system
> (L1) and every resource node on each (L2), read from the seed's own layout and stamped with the
> founding tick. **Every** founding, bot or human (knowing your home is not part of the human starter
> package). L0 is **not** stored — it is computed for every system in the view. The founding flow is
> otherwise untouched: no credits, fuel or goods move for it (invariants 1/2/3), and the founding
> goldens moved by exactly the added `exploration` key (each re-pin carries a strip-and-prove of the
> pre-slice hash).

## 7. The per-guild snapshot architecture

The keystone. This is the architectural end of "one snapshot, everyone sees everything," and the
foundation every later hidden-information layer (espionage, monitoring, the rival-stockpile hide)
stands on.

- **The seed stays one shared, immutable map.** `data/seed.json` holds the whole galaxy's
  geography and carries **no guild ids**. Fog is never applied to the seed; it is derived.
- **The exploration record is OWNED guild state.** It nests on the Guild entity (`design.md`
  §15.4) exactly as `assets` / `ventures` / `stockpiles` do — holding the row *is* knowing the
  fact. It is **serialized and covered by the determinism hash** (invariant 9), and it only ever
  grows (learn-once / known-forever, §3), like `lifetimeProduced`. Shape to confirm at build: a
  per-planet / per-node granularity sufficient for the per-planet claim gate (§8).
  **⤳ AS-BUILT 05-10-26 — the shape:** `guild.exploration = { [planetId]: { tick, nodes: { [nodeId]:
  tick } } }`. A planet key = its archetype is known (L1); a node key under it = that node and its
  resource type are known (L2); `nodes` is `{}` for an L1-only planet. **Ids only** — the archetype
  and the node type are NOT copied in; the seed stays the one map (`design.md` §15.3 "link by
  reference only", invariant 5) and the view resolves each id through `getPlanet` / `getSite`. Each
  fact carries the **tick it was learned** (§15.2), and a re-reveal keeps the first. Keyed flat by
  planet because that is the gate's granularity (§8: "knows ≥ 1 node of planet P" is
  `Object.keys(exploration[P].nodes).length ≥ 1`); the system a planet sits in is the seed's fact.
  **Omit-when-empty**: a guild that knows nothing carries no key. Guarded every tick by
  `checkExplorationRecord` (`sim/invariants.js`: real planets, real resource nodes on their own
  planet, ticks in `[0, now]` with a node never before its planet, no empty record). Learn-once is a
  two-tick property, so it is pinned across scripted runs in `tests/exploration.test.js`.
- **`buildSnapshot` becomes per-guild.** Today `buildSnapshot(state)` (`sim/snapshot.js`) is PURE
  and sees every guild's data, producing one shared view. It becomes **`buildSnapshot(state,
  guildId)`**, producing that guild's filtered view = L0 ∪ record ∪ live rules (§3). The
  god's-eye lens is **preserved for operator / debug** via an explicit all-seeing mode (no guild,
  or a sentinel), so `/inspect` and the operator tools keep their full view; the **player** path
  passes its guild.
  **⤳ AS-BUILT 05-10-26 (roadmap 2.5 (a), part 2 — `sim/snapshot.js`, `sim/fog.js`).**
  `buildSnapshot(state)` (or a null/undefined guild) is the **god's-eye lens, byte-identical to
  before**: the old body is renamed `buildGodsEyeSnapshot`, unedited, and `tests/fog.test.js` pins
  its output to hashes recorded on `main` (8c248d6) before the slice. `buildSnapshot(state,
  guildId)` builds that same object and passes it through `fogForGuild`, which only **subtracts**
  rival facts and **adds** two keys — so the two lenses can only differ by what fog.js does:
  - **own data in full** — the viewer's guild row, ventures, outposts, deliveries, builds,
    production preview and notices, byte-for-byte the god's-eye rows;
  - **rival guild rows** cut to an **allow-list**: `id`, `name`, `isBot`, `homeSystemId` (the
    controller fact). Credits, fuel, stockpiles, reputation, points, assets, **vehicles**, orders,
    events — gone; `homePlanetId` too (a planet inside a rival system is L1 not yet learned);
  - **rival ventures**: only those on the public register (`isOnPublicRegister` — the same
    predicate the record observation uses), each cut to `id`, `ownerGuildId`, `type`, `siteId`,
    `systemId`, `ventureName`, `reputation` *(⤳ added 06-10-26, §2)*, `site` (the node: kind,
    planet, system, resource type, name) plus `planetArchetype` from the seed — no licence terms,
    no recipe. An **unlicensed** rival venture is absent everywhere (`ventures`, `occupancy`) —
    fogged until L3;
  - **rival outposts** cut to `id`, `ownerGuildId`, `coords`, `anchorSystemId` (stockpile, used
    space, capacities and the dock — which names rival craft — dropped);
  - **rival deliveries, pending Syndicate builds, production preview and notices** removed
    (your own deliveries stay — ruling 5);
  - **claims**: every row kept — ownership is public (controllers, waystations, the Citadel) — but
    a **rival's system claim** has its resolved seed landmark cut to L0 (`id`, `kind`, `name`,
    `coords`): the god's-eye landmark also carries `terranHomeworldId` / `starterEligible`, which
    name and type a planet inside the rival system (L1 not learned);
  - **galaxy-wide aggregates** *(⤳ coarsened 06-10-26, §2)*: `galacticSupply` keeps only
    `fuel.{reserve, fuelPrice, avgDraw, targetReserve}` (`resources`, `guildHeld`, `total` dropped);
    `syndicate` is `{}` (the `ledger` dropped; the row carries no other field). Coarsened for EVERY
    viewer, so the view's shape never depends on how many rivals there are — which is why even a
    one-guild galaxy's view differs from the god's-eye in exactly these two blocks;
  - **`nodeLockouts`** *(⤳ filtered 06-10-26, §2)*: only a lockout on a node the viewer `knowsNode`
    or in a system it holds (`guildHolds`); each shown row is the god's-eye row, unchanged;
  - **public, passed through untouched:** prices and their histories, fee/contract/asset quotes, the
    calendar;
  - **added:** `viewerGuildId`, and `geography = { systems, known }` — `systems` is **L0 for every
    system** (`id`, `name` (position-derived), `coords`, `planetCount`, `controllerGuildId` from the
    claims — never fogged, computed, never stored); `known` is the guild's **record**, resolved
    through the seed, grouped `{ [systemId]: { [planetId]: { archetype, nodes: { [nodeId]:
    resourceType } } } }`. The live half (a rival's licensed node + archetype) rides on that
    rival's venture row, so the two sources stay distinct.
  Every rival row is an **allow-list**, and every top-level god's-eye key must be classified public
  or filtered in `fog.js` `TOP_LEVEL` — an unclassified key throws, and a test fails on a new one —
  so nothing new reaches a player by default. The view is pure (it reads the record, writes
  nothing). `GET /snapshot?guild=<id>` serves it for headless proof (404 for an unknown guild);
  plain `GET /snapshot` is unchanged. The client wiring is slice (c).
- **One source-agnostic reveal.** A single `reveal` writes geography into a guild's record,
  whatever the source — a scan completing, a craft visit, a claim, founding, and (later) a
  Prefecture scan. Ruling 1 already forces this (a scan and a rival's licensed venture both
  write the record), so it is not speculative generality.
  **⤳ AS-BUILT 05-10-26:** `reveal(guild, fact, tick)` in `sim/exploration.js`, where `fact` is
  `{ planetId }` (L1) or `{ nodeId }` (L2 — which also reveals the node's planet). It returns how many
  NEW facts it learned (0 = a no-op), refuses an id the seed does not hold, and records what and
  when, never how. Its callers this slice: `revealSystem` (founding) and `observePublicRegister` (a
  rival's licensed venture). The Deep Scan Array (slice (b)) and the Prefecture become callers later.
  *(⤳ 06-10-26, 2.5 (b2): the Deep Scan Array is now a caller — its scan completion reveals through
  `revealSystemArchetypes` (L1) and `revealPlanetNodes` (L2), two loops over `reveal`.)*
- **Determinism & goldens.** A per-guild snapshot is deterministic given `(state, guildId)`. The
  snapshot shape changing to per-guild is a **large but intended goldens change** that must be
  proven **deliberate, not accidental**: where a guild sees everything (a single-guild galaxy, or
  a guild's own space), prove the view is byte-identical to the old god's-eye output; the
  fog-driven differences are enumerated and expected.
- **The `/galaxy` leak — noted, deferred.** `GET /galaxy` (`sim/server.js`) serves the entire
  `data/seed.json` verbatim, unfiltered, so a raw client can still read all geography regardless
  of the snapshot filter. The **engine's per-guild view is the authority** and the tripwires test
  *it*; hardening the HTTP route (and the no-auth, client-picks-its-own-guild dev rig) is a
  **later backend slice**, recorded here so it is not silently forgotten.
  *(⤳ 05-10-26, found while building (a): `GET /starters` — the home-system picker's seed route — is
  the same kind of leak in miniature: it lists every starter system with its `terranHomeworldId`.
  Same deferral, same later slice; the per-guild view itself does not carry it.)*

## 8. The claim-gate coupling — "you can't claim an unexplored system"

The one new ruling this slice **records** for the next slice to **enforce**: a guild may plant a
Prefecture on a system **only on a planet that is in its exploration record at ≥ 1 node** (§4
ruling 7) — however the fact entered the record (its own scan, or the public record of a rival's
lapsed venture). This coupling is **not** in the repo's Prefecture model today (`design.md` §2,
`territory-model.md` §4). **This slice does not build the Prefecture** — it records the gate so
the Prefecture / claims slice (next) reads the real ruling, and so the exploration record is
already the gate's data source from birth.

> **⤳ AS-BUILT 05-10-26 (roadmap 2.5 (a)) — RECORDED, NOT ENFORCED.** The record this gate reads
> now exists from founding, keyed per planet exactly as ruling 7 needs it, and `knowsNode(guild,
> nodeId)` / `exploration[planetId].nodes` (`sim/exploration.js`) is the read the Prefecture slice
> will gate on ("knows ≥ 1 node of planet P"). Nothing calls it as a gate yet: the claim and
> establish validations are untouched.

## 9. Scope & the vertical split

**In (roadmap 2.5, the exploration slice):** the fog flip (per-guild filtered snapshot to the full
L0/L1/L2 model); the per-guild exploration record; the Deep Scan Array's remote-scan discovery
(queued jobs, no fuel/craft, revealing L1/L2 into the record over time); the two sources (§3); the
"can't claim unexplored" ruling recorded (§8).

**Out (designed-but-deferred, or built elsewhere):** monitoring (§5, deferred half → detection/L3
+ corridors + catch/fine); L3 espionage (rival interiors with discovery-chance + fine; rival
stockpiles / transports / scanners); the semi-controlled corridors (need claims); the Prefecture /
claims slice (next) and its self-scan (§4 ruling 9); squatting (deferred until its punishment
exists); buy-only transport visibility (already built).

**Likely build order (sequential vertical slices — survival rule 3):** (a) **engine** — the
per-guild snapshot filter + the exploration record + the two sources + founding state + the §8
coupling recorded; then (b) **the Deep Scan Array** — the entity + deploy + the scan-job queue +
reveal-to-record + completion revalidation; then (c) **client** — the fog UI (the galaxy map shows
L0, scanned/known systems reveal L1/L2, rival systems show the public record). Keep the tick
central: the client renders its guild's snapshot and computes no game number. Never invent a
number.
