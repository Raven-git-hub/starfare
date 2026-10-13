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
array; AS-BUILT note in §5.)* **Monitoring (§5, the deferred half), L3 espionage, and
the semi-controlled corridors are design-ahead and NOT built here** — recorded so the slices that
build them read the real ruling, not a paraphrase.
*(⤳ 08-10-26 — the simplification, §4 ruling 11: control ⇒ full L2 live, partial surface knowledge
removed, the rival-licensed-venture source (`observePublicRegister`) retired, and rulings 6 & 9
(bounded no, Prefecture self-scan) retired.)* *(⤳ 08-10-26 — the cleanup slice is BUILT (roadmap 2.5, the
ruling-11 cleanup): `observePublicRegister` is **removed**, so the record is written only by founding and the
guild's own Deep Scan Array scans; and the per-guild view projects **every controlled system** (own or rival)
at full L2, live — every planet's archetype and every resource node; settlement slots follow with the
settlement-surface slice. AS-BUILT notes in §3 and §7.)* *(⤳ 09-10-26 — the **settlement-surface** engine slice is
BUILT (roadmap 2.5; §4 ruling 12, slice 1): the record carries a `slots` track beside `nodes`, founding and the
L2 survey reveal a planet's whole surface — nodes **and** slots — together, and `geography.known` projects slots
for every controlled system and every surveyed planet. AS-BUILT notes in §4 ruling 10 and §7. The claim gate
(§8) is still recorded, not enforced.)* *(⤳ 09-10-26 — the **L0-board** engine slice is BUILT (roadmap 2.5; §4
ruling 12, slice 2): the galaxy's static L0 — every system's position and orbital layout — is served once at a
**new** route, `GET /board`, and the per-guild view drops its per-tick `geography.systems` block (`geography` is
`{ known }`; the controller is read from `claims`). **`GET /galaxy` is unchanged and still serves the whole
seed**, so the `/galaxy` leak stays open until the client flip (slice 3). AS-BUILT notes in §4 ruling 12 and §7.)*
*(⤳ 13-10-26 — the **board-widening** engine slice is BUILT (roadmap 2.5; §4 ruling 12's 13-10-26 note): the
board is now the whole static public galaxy — an object, `{ seed, galaxyParams, citadel, outposts, stats,
systems }`, each system row gaining its `claimRadius` — and still carries no fogged planet detail and no Terran
pointer. `GET /galaxy` is **still unchanged**; its cutover and the leak's closure remain the client flip (slice
3). AS-BUILT notes in §4 ruling 12 and §7.)*
*(⤳ 13-10-26 — the client flip (slice 3) runs as three slices (split by the slice-3a build prompt): **3a** the
fog flip, read-only; **3b** the survey flow; **3c** the leak closure (`GET /galaxy`, `GET /starters`). **3a is
BUILT** (roadmap 2.5): the client reads the **board** and the **per-guild poll** instead of `/galaxy` and the
god's-eye `/snapshot`, and renders the map's ownership colour and both manifests **per level** (§10). The survey
affordances are drawn but do nothing (3b). `GET /galaxy` and `GET /starters` are **unchanged — the leak is still
OPEN** until 3c. AS-BUILT notes in §7 and §10.)*
*(⤳ 13-10-26 — **3b, the survey flow, is BUILT** (roadmap 2.5; client only): `SURVEY SYSTEM` and an L1 tab's
`Survey` open the confirm popup, the player picks a deployed Deep Scan Array and Confirm sends `queueScan`; a running
job reads "Surveying · <eta>" on its tag / tab and turns the map's radar on its system. The **completion notice is
DEFERRED** (ruled 13-10-26, the design room) — it needs an engine event the scan does not emit yet. 3c (the leak
closure) remains: the `/galaxy` leak is **still OPEN**. AS-BUILT note in §10.)*

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

- **L0 — never fogged, for every system:** position + the system's **orbital layout** (each planet's stable id and
  orbital order, I/II/III…) + controlling guild. The layout is a geometric fact
  — how many bodies orbit and in what order — and carries no archetype, no nodes
  and no slots; those are L1/L2. *(⤳ 09-10-26, §4 ruling 12: “planet count” is
  specifically each planet's id + order — the datum the client's L0 board carries
  so a planet tab can render, and the join key L1/L2 detail slots onto.)* Plus
  **every Syndicate waystation is always visible.** Nothing cuts L0 because nothing hides it.
  *(⤳ AS-BUILT 09-10-26, §4 ruling 12 slice 2: L0 reaches a viewer by **two transports**, split by whether
  the fact can move. The **static** half — position + orbital layout — is the **board** (`GET /board`, sent
  once). The **dynamic** half — the controlling guild — rides the snapshot's **`claims`** (every claim row is
  public; no system claim = unclaimed). Together they are this bullet's L0, unchanged: a split of where each
  fact travels, not a change to what L0 is.)* *(⤳ AS-BUILT 13-10-26, the board-widening slice: the board also
  carries every Syndicate waystation and the Citadel — §4 ruling 12's 13-10-26 note — so the "always visible"
  waystations above reach a viewer on the board too.)*
- **L1 — a system's planet archetypes.** Cut by **either**: a transport sitting idle in the
  system (instant, but costs the trip — fuel + travel time), **or** a Deep Scan Array L1 scan
  of the system (no trip, but takes time). The player picks whichever is cheaper for the case.
- **L2 — a planet's whole *surface*: its resource nodes (count + type) *and* its settlement
  slots (count), per planet.** Known **two ways, and two only** (*RULED 08-10-26, §4 ruling 11 —
  all-or-nothing, no partial*): you **survey** it yourself with a Deep Scan Array (frontier systems,
  one planet at a time, time-based — a transport cannot, it has only orbital observation, so a visit
  gives L1 not L2); **or** the system is **controlled** by any guild, in which case its whole surface
  is shown to everyone **live** (control is public, so a settled system's geography is too). A planet
  is at L1 or at full L2 — never "some nodes known."
- **L3 — espionage. DEFERRED.** A rival-controlled system's hidden interior: its **un-licensed
  ventures**, stockpiles, transports, and deep-scan arrays. The surface itself is no longer fogged
  (control ⇒ L2, ruling 11), so L3 is now exactly "what they are *doing* that they have not
  declared." Cut **only** by a spycraft deployed to the rival system. Not this slice.

## 2. Who sees what — situation × method

- **Your own systems.** A system you control is shown to you at **full L2** — every planet's whole
  surface — from the moment you claim it (control ⇒ live L2, §4 ruling 11; this **retires** the old
  "bounded no"). Your **home system is known from founding** (§6). A frontier system you do not
  control shows only what you have surveyed yourself.
- **Unclaimed / frontier systems.** L0 always. L1 by a craft visit or an array L1 scan; L2 by
  an array per-planet scan. These are the only systems you *scan* — rival systems are read off
  the public record, not scanned (scanning a rival is L3, deferred).
- **Rival-controlled systems.** Shown at **full L2** — position, planet count, controller, and the
  whole surface of every planet (all archetypes, all nodes, all settlement slots), **live** (control
  is public, so a settled system's geography is too; §4 ruling 11). Plus every **licensed** venture:
  its node, the venture *type*, and *(RULED 06-10-26)* its **reputation** — `design.md` §5: ventures
  carry a "**fully visible** reputation score", the investment-risk signal and takeover trigger a
  rival watches — but **never the stockpile**, never its **licence terms**, and never a refinery's
  **recipe / produced good** (the §405 rule: types are visible so a rival *infers* the inputs, it is
  not told them). A rival's **un-licensed** ventures, stockpiles, transports and deep-scan arrays stay
  hidden until **L3** — that is now espionage's whole job. A craft sent to a rival system reveals
  nothing new.
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
  settlement slot is not a node, so a slot's lockout shows only on ground the guild controls. *(⤳ 09-10-26:
  the record now carries a `slots` track (the settlement-surface slice, §7), but this ruling reads nodes and
  is built unchanged — whether a slot the record knows should show its lockout is on the roadmap's decision
  checklist.)*

## 3. The two sources — the architecture

Every guild's view is the **union of two things**, and keeping them distinct is what keeps the
model honest:

1. **The per-guild exploration RECORD** — static geography (planet archetypes, resource nodes and
   settlement slots) you have **surveyed yourself**, **learn-once / known-forever**. Its sources are
   your own Deep Scan Array survey and founding (your home). A survey reveals a planet's **whole
   surface** at once, so the record is never partial — a planet is recorded at L1 or at full L2
   (*RULED 08-10-26, §4 ruling 11*). This record is OWNED guild state (§7) and it is **what the claim
   gate reads** (§8). *(Ruling 11 **removes** the old second record source — banking a rival's
   licensed-venture nodes; rival geography is a live rule now, not remembered.)*
2. **The live RULES** — dynamic facts recomputed from current state every tick: **a controlled
   system's whole surface** (own or rival — control ⇒ L2, §4 ruling 11), controllers, rival
   **licensed** ventures, rival structures, Syndicate waystations, your own deliveries. These lift
   and re-fog on their own as the world changes; nothing about them is remembered — if a rival
   abandons a system, your view of its surface drops back to whatever you surveyed yourself.

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
> *(⤳ REMOVED 08-10-26 — AS-BUILT, §4 ruling 11 (roadmap 2.5, the ruling-11 cleanup).* The note above
> is **history**: `observePublicRegister` and its helper `publicRegisterFacts` are **deleted**
> (`sim/exploration.js`), and so is their end-of-tick call (`sim/tick.js`). The record's writers are now
> founding (`revealSystem`) and the guild's own Deep Scan Array scan completions (`stepScanCompletions`,
> the end-of-tick block's one remaining record writer) — **no guild's record is written from a rival**.
> The record's **shape is unchanged**; it simply stops growing from rivals. A rival's surface is shown
> live instead (§7's AS-BUILT note on the controlled-system projection). `isOnPublicRegister` stays: it is
> still the one "licensed = public" predicate, now read only by the view to pick which rival ventures it
> shows. The 07-10 slot-leak extension was never built and is dropped. **Proved** byte for byte against
> `main` at 41fe84c (`tests/rival-leak-removed.test.js`): the god's-eye lens did not move at all (it never
> carried the record); a one-guild galaxy is byte-identical in state, god's-eye and view; a two-guild
> state moved by **exactly** the leaked facts (main's state with every record fact in a rival-held system
> stripped hashes to the new state, and an in-test replay of the removed step rebuilds main exactly). A
> tripwire checks every tick that no record gains a fact while a rival runs a licensed mine and a licensed
> refinery.)*

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

6. **~~The claim reveal is bounded ("bounded no")~~ — RETIRED 08-10-26 (ruling 11).** A controlled
   system is shown at full L2 the moment it is claimed (control ⇒ live L2), so there are no "far
   planets fogged at L2" to earn back. *(Original ruling: planting a Prefecture revealed the whole
   system to L1 and only the settled planet to full L2, leaving the other planets fogged until
   surveyed. Retired because you cannot sensibly see a rival's whole system but not your own.)*
7. **The claim gate is per-planet: you must have surveyed the planet.** A guild may plant a
   Prefecture on a planet **iff that planet is in its exploration record at full L2** — i.e. it has
   **surveyed the planet's surface**, which includes the **settlement slot** the flag plants on.
   Surveying is whole-surface and all-or-nothing (ruling 11), so "knows a settlement slot of P" and
   "has surveyed P to L2" are one and the same. Knowing P lets you settle P, not a different planet Q
   in the same system. (See §8 for the coupling the Prefecture slice enforces.)
8. **A transport reveals L1 only.** A craft sitting **idle in an unclaimed system** reveals that
   system's archetypes (all planets) instantly, for the price of the trip. It never reveals nodes
   (no survey equipment). **Passing through** a system's hexes reveals nothing — only coming to
   rest on the system counts. A craft at a **rival** system reveals nothing new.
9. **~~The Prefecture self-scans its own system~~ — RETIRED 08-10-26 (ruling 11).** No longer
   needed: claiming a system shows its whole surface at full L2 at once (control ⇒ live L2), so
   there are no far planets left to self-survey. *(Original ruling: a deployed Prefecture could run
   an in-system L2 scan faster than the array, to fill in a claimed system's far planets. Retired
   with the "bounded no", ruling 6, it existed to serve.)*

**Settled 07-10-26:**

10. **Settlements are learnable *surface* — the L2 survey maps the whole surface at once.
    *(RULED 07-10-26.)*** A planet's **settlement slots** are not a free archetype fact; they are
    discovered the same way its resource nodes are — by surveying the surface. Narratively, an L2
    survey walks the ground for both the ore (resource nodes) **and** the buildable sites for
    factories (settlement slots). Consequences — each **design-ahead, NONE built in roadmap 2.5
    (a)/(b); built by the *settlement-surface* slice and the *Prefecture / claims* slice**:
    - **One reveal covers the whole surface.** A per-planet L2 scan reveals every resource node
      **and** every settlement slot of that planet together (§1). L1 (archetype) still shows no
      surface. Founding's `revealSystem` likewise seeds the home system's slots, not only its nodes.
    - **The record gains a `slots` track** beside `nodes` (§7), so a known settlement slot becomes
      representable — the datum the claim gate reads.
    - **~~The public-register leak extends to slots~~ — RETIRED 08-10-26 (ruling 11).** Earlier this
      ruling banked a rival's licensed factory's slot (and a miner's node) into your record. That is
      **gone** — no rival geography is banked at all now; a controlled system is shown at full L2 live
      (§4 ruling 11). Your record holds only what **you** surveyed.
    - **The claim gate is "planet surveyed to L2"** (rulings 7 & §8; mirrored in `territory-model.md`
      §4): the Prefecture lands on a settlement slot, and surveying reveals the whole surface, so
      "you know a settlement slot of P" = "you have surveyed P." You earn the claim by surveying the
      planet you mean to settle — there is no rival-leak shortcut (ruling 11).
    None of this is built by the exploration slice; it is recorded so the settlement-surface and
    Prefecture slices read the real ruling, not a paraphrase (the seam rule).
    *(⤳ AS-BUILT 09-10-26 — the settlement-surface slice (roadmap 2.5; ruling 12 slice 1) builds the first
    two consequences: **one reveal covers the whole surface** — the L2 scan's per-planet reveal (renamed
    `revealPlanetSurface`) and founding's `revealSystem` both reveal every node **and** every settlement
    slot, through one shared loop, while L1 (`revealSystemArchetypes`) still reveals no surface; and **the
    record's `slots` track** exists (§7's AS-BUILT note). The third (the retired leak) stays retired. The
    fourth — **the claim gate** — is still **recorded, not enforced**: no gate reads a slot yet, and there
    is no slot read (`knowsSlot`) until the Prefecture / claims slice adds what its gate needs (§8).)*

**Settled 08-10-26 — the simplification:**

11. **Control ⇒ full L2, live; no partial knowledge; the rival-venture leak is removed.**
    *(RULED 08-10-26.)* The fog model collapses to two clean states and one clean source rule:
    - **A planet's surface is all-or-nothing.** You know a planet at L1 (archetype) or at full L2
      (every node + every slot) — never a partial set. This kills the one thing that ever produced a
      partial set: the rival-licensed-venture leak.
    - **Any controlled system is shown at full L2, live, to everyone** — its own guild and every
      rival alike (control is public, so a settled system's geography is public). Not banked: it is
      recomputed each tick from the seed + the claims, and it drops out of your view if control lapses
      (you keep only what you surveyed yourself).
    - **The record holds only your own surveys** (Deep Scan Array + founding). The old second source —
      `observePublicRegister` banking a rival's licensed-venture nodes — is **removed**.
    - **Espionage (L3) becomes "the undeclared interior"**: a rival system's **un-licensed** ventures
      and transport movements (its surface is already visible). A narrower, cleaner L3.
    - **Retires ruling 6 (bounded no) and ruling 9 (Prefecture self-scan)** — both existed only to
      ration a claimed system's far planets, which now light up at once on claim.
    **Build impact (a Claude Code cleanup slice — doc + code together):** delete `observePublicRegister`
    and its end-of-tick call (`sim/tick.js`, `sim/exploration.js`); make the per-guild view project a
    **controlled** system (own or rival) at full L2 from the seed, beside the existing licensed-venture
    rows; re-pin the fog / god's-eye hashes. The exploration **record** structure is unchanged (archetypes
    + nodes/slots keyed per planet) — it is simply no longer written from rivals.

**Settled 09-10-26 — the client fog boundary (Option B):**

12. **The client holds only what it can see; orbital layout is L0.** *(RULED 09-10-26.)* The
    browser stops downloading the whole galaxy. Its geography comes from **two leak-free inputs**,
    and it can render nothing it was not sent — which is what finally closes the `/galaxy` leak
    (§7) for real, rather than trusting a raw client not to peek:
    - **A one-time L0 board.** One static document — served once, cacheable, identical for every
      viewer, carrying **no guild ids and no fogged detail** — gives the whole galaxy at **L0
      only**: per system `{ id, name, coords, ring, planets: [ { id, order } ] }`. That is the
      orbital layout, plus — widened 13-10-26 (the note below) — the galaxy's static public map
      facts, but still **no archetype, no resource nodes, no settlement slots, no resource
      types.** Static for the galaxy's life (a new galaxy ⇒ a new board), so it
      caches; it is the map's geometry source and the L0 planet-tab source.
    - **The polled per-guild snapshot**, which already carries the earned detail in `geography.known`
      (the record ∪ every controlled system at full L2, §7) and controllers in `claims`. This is
      the only per-guild, per-tick payload, and it grows with **what the guild has explored**, not
      with the galaxy's size — which is the scaling point of the split.
    - **Orbital layout is L0 (the sub-ruling §1 now states).** A planet's **stable id and order**
      are known for every system from the start; its **archetype is L1**, its **nodes + slots are
      L2**. The id is the join key the board and `known` share; order gives the Roman designation.
      The board derives both from the seed's own planet array exactly as the record keys by id
      (order = array index + 1) — **no new numbering** — so the board and `known` can never
      disagree about a planet.
    - **The poll slims.** `geography.systems` (the per-tick L0-for-every-system block, §7's
      AS-BUILT note) is **removed**: its static facts move to the board, and its one dynamic fact
      — the controller — is already in `claims` (ownership is public; a system with no claim row
      is unclaimed). The poll carries `geography.known` and the viewer id; the client reads
      controllers from `claims` and layout from the board.
    **Failure modes hunted on paper (design.md §18, practice 7):** (a) a `known` planet absent from
    the board is impossible when both derive from one seed, and is a build tripwire; (b) the board
    must cache-bust on a new galaxy (carry a galaxy id / etag) so a `POST /admin/galaxy/new` or
    `/reset` never serves a stale layout; (c) the client must treat an absent `claims` row as
    *unclaimed*, not *unknown*, and must no longer read a `planetCount` field from the poll (gone —
    the count is the board's `planets.length`). **Build impact — three slices, doc + code each
    (see §7, §10):** (1) the **settlement-surface** engine slice (the `slots` track in the record
    and in the controlled-system projection — already design-ahead in §7 / §4 ruling 10); (2) the
    **L0-board** engine slice (serve the board; slim the poll); (3) the **client flip** (drop the
    `/galaxy` download; render L0 from the board and L1/L2 from `known`, per §10). Slices 1 and 2
    are independent; the client flip is last. *(⤳ 09-10-26: slice (1), the settlement-surface engine
    slice, is BUILT — §7's AS-BUILT notes. Slices (2) and (3) remain.)* *(⤳ 09-10-26: slice (2) is
    BUILT — the AS-BUILT note below. The board-widening engine slice (the 13-10-26 note below)
    and then the client flip (slice 3) remain.)* *(⤳ 13-10-26: the board-widening slice is BUILT — the
    AS-BUILT note closing the 13-10-26 note below. The client flip (slice 3) remains.)* *(⤳ 13-10-26: slice
    (3) is split **3a / 3b / 3c**; **3a**, the read-only fog flip, is BUILT — §10's AS-BUILT note. It meets
    failure mode (c): an absent `claims` row reads as *unclaimed* (UNCLAIMED or SURVEY SYSTEM, never
    "unknown"), and the client reads no `planetCount` — a body count is the board's `planets.length`. 3b (the
    survey flow) and 3c (the `/galaxy` cutover, the leak's closure, `/starters`) remain.)* *(⤳ 13-10-26: **3b**,
    the survey flow, is BUILT — §10's AS-BUILT note (its completion notice deferred). 3c remains.)*

    > **⤳ SEQUENCING, RULED 09-10-26 (the design room) — refines the build impact above.** Read literally,
    > slice (2) would make `GET /galaxy` stop serving the seed. That would break the running client, which
    > still downloads the whole seed from `/galaxy` and renders planet detail from it until slice (3). So:
    > **slice (2) serves the board at a NEW route, `GET /board`, and leaves `GET /galaxy` exactly as it
    > was** (the whole seed). The **`/galaxy` cutover and the leak's closure move to slice (3)**, the client
    > flip — the moment the client stops needing the seed. Until then the `/galaxy` leak stays open,
    > knowingly. (§7's `/galaxy` note says the same.)
    >
    > **⤳ AS-BUILT 09-10-26 — slice (2), the L0-board engine slice (roadmap 2.5).** Engine + server; no
    > client, and nothing live reads either half yet. **No new number.**
    > - **The board** — `getBoard()` (`sim/seed.js`; it **replaces** `getL0Systems()`, whose
    >   `{ id, name, coords, planetCount }` rows only the per-guild view read): one row per system, **sorted
    >   by id**, exactly `{ id, name, coords: { q, r }, ring, planets: [ { id, order } ] }`. `ring` is the
    >   seed's `sys.ring || null` (as `getSystemLayout` reads it). `planets` is the seed's own planet array, in
    >   its own order, each cut to its stable `id` and `order` = array index + 1 — the **same ordinal** the
    >   site names' Roman numeral already uses (`siteName`), so there is no new numbering. **Nothing else per
    >   planet** — no archetype, nodes, slots or resource types. Built once in the cached seed index, like
    >   the other indexes; `planetCount` is gone (it is `planets.length`).
    > - **The route** — `GET /board` (`sim/server.js`) serves a **pre-serialised buffer** built beside the
    >   `/galaxy` one, by `refreshBoard()`, every time the seed buffer changes (`setActiveSeed`, and the
    >   no-volume boot) — so `POST /admin/galaxy/new` and `/admin/galaxy/delete` refresh it for free, and
    >   `/reset` (same seed) keeps it. `404 NO_GALAXY` exactly when `/galaxy` is. **Cacheable** — failure mode
    >   (b): it sends an **`ETag`** — `"board-<seed number>-<sha256 of the board bytes>"` — and a matching
    >   `If-None-Match` gets a **304** with no body. The seed number makes the tag readable; the hash is what
    >   makes it safe, since one seed number could name two layouts if the generator ever changed. It keeps
    >   `Cache-Control: no-cache` (revalidate before every use, rather than a `max-age`), so a browser always
    >   asks and a new galaxy is never served stale. Same CORS headers as `/galaxy`. On the committed seed the
    >   board is **283,008 bytes against `/galaxy`'s 8,693,128 (3.3%)**.
    > - **The slim** — `geographyFor` (`sim/fog.js`) returns **`{ known }`**: the `systems` block is removed,
    >   and with it the view's last use of the L0 accessor. `known` is unchanged byte for byte. The
    >   controller — the block's one live fact — was already in `claims`, which keeps every row. Observable
    >   only on `GET /snapshot?guild=<id>`; the live client reads plain `GET /snapshot` (god's-eye), which
    >   builds no `geography`, so nothing live moved. The block was ~155 KB of a ~195 KB two-guild view —
    >   about 80% of every per-guild poll.
    > - **The split, not a contradiction with §1:** the board carries L0's **static** half (layout), the
    >   view's `claims` its **dynamic** half (controller); together they are §1's L0.
    > - **Proved** (`tests/l0-board.test.js`, `tests/systems-block.js`): the board's shape for every system,
    >   its planet ids and orders equal to `getSystemLayout`'s (order = seed index + 1) and to the site names'
    >   numerals; the serialized board holds none of `archetype`, `resourceType`, `resourceNodes`,
    >   `settlementSlots` (asserted on the JSON text) and no site id; the same seed gives the same board bytes,
    >   a different seed different bytes; every planet in `known` is on the board in its own system (failure
    >   mode (a)); the route's ETag/304, its 404 with no galaxy, and a new galaxy's new board and new ETag.
    >   **The slim is a removal and nothing more:** every per-guild view golden still holds once
    >   `geography.systems` is **put back**, rebuilt from the board and the view's own `claims` alone — so the
    >   board plus the slim view lose nothing the old view carried; the new view pins were recorded on `main`
    >   (348e0fc) by deleting `geography.systems` from each old view; `known` hashes to slice 1's.
    >   **The god's-eye lens did not move** (no god's-eye pin was touched).
    >
    > **⤳ 13-10-26 — RULED, and now AS-BUILT (the note closing this one): the board widens to the whole
    > static public galaxy.** *(Written DESIGN-AHEAD; built the same day.)* Slice 2
    > built the board as a systems-only array (above). Grounding the client flip (slice 3) surfaced
    > that the running client reads more than systems off `/galaxy`: `galaxyParams` (the hex grid, in
    > every map calculation), the Syndicate **waystations** and the **Citadel** (both drawn on the
    > map), each system's **`claimRadius`** (the claim-extent overlay), the **seed** number (the
    > starfield RNG) and the seed's **`stats`** (the HUD). All are static and unfogged, so the board
    > must carry them — otherwise the client could never stop reading `/galaxy`. The board's TARGET
    > shape is therefore an OBJECT — the seed with its fogged per-planet surface taken out:
    >
    >     { seed, galaxyParams, citadel, outposts, stats,
    >       systems: [ { id, name, coords, ring, claimRadius, planets: [ { id, order } ] } ] }
    >
    > **In** — every field above: static, public, and read by the client today (per-system L0 plus
    > the galaxy's global public config; the latter is not a §1 fog level, just never-fogged galaxy
    > config). **Out, and why:** a planet's `archetype` / `resourceNodes` / `settlementSlots` /
    > resource types (FOGGED — L1/L2, reached through `geography.known`); `terranHomeworldId` (it
    > names which planet is Terran — an L1 fact, a leak — so the home-picker reads it from the
    > hardened `GET /starters`, not the board); `starterEligible` (only the picker needs it —
    > `/starters`); and the seed's `validation` block (a gen-time self-check, unread). The leak-free
    > guarantee is unchanged and widened: the served board holds none of the fogged fields AND no
    > `terranHomeworldId`, asserted on the JSON text. This is the board's TARGET shape and supersedes
    > the systems-only shape in the 09-10 ruling bullet and the slice-2 AS-BUILT note above. **A small
    > board-widening engine slice builds it** — reshape `getBoard()` to the object, re-pin `/board`'s
    > bytes + ETag and the board tests, and extend the leak-free assertion to `terranHomeworldId` —
    > still engine-only and non-breaking, since nothing reads `/board` until the client flip.
    > *(⤳ BUILT 13-10-26 — the AS-BUILT note below.)* **Then**
    > slice (3), the client flip, reads the board (already the shape the client's `loadGalaxy()`
    > expects, minus planet detail) + `known` + `claims`, drops the `/galaxy` download, closing the leak.
    > **Not built (slice (3)):** the `/galaxy` cutover and the leak's closure, `GET /starters`' hardening
    > (ruled into "the same slice" as `/galaxy`'s — so it follows `/galaxy` to slice (3); flagged on the
    > roadmap's decision checklist), and every client change.
    >
    > **⤳ AS-BUILT 13-10-26 — the board-widening engine slice (roadmap 2.5).** Engine + server; no client,
    > no `/galaxy` or `/starters` change, no per-guild view change, and nothing live reads `/board` yet.
    > **No new number.**
    > - **The board** — `getBoard()` (`sim/seed.js`) returns the **object** above, keys in that order, built
    >   once in the cached seed index. `seed` is the seed number. `galaxyParams` and `stats` are deep copies of
    >   the seed's own blocks. `citadel` is the seed's own `{ coords: { q, r }, radius }`, taken from the
    >   Citadel the index already resolves but **not** that landmark's shape (no `id: 'citadel'`, no `kind`),
    >   so the board reads like the seed it was cut from (on the roadmap's decision checklist). `outposts` is
    >   every Syndicate waystation as the seed's own row, `{ id, coords: { q, r }, name }`, sorted by id (no
    >   landmark `kind`). `systems` is slice 2's rows, sorted by id, each gaining **`claimRadius`** — the seed
    >   system's own number — between `ring` and `planets`. Planets are unchanged: `[ { id, order } ]`. A seed
    >   missing a block (a bare test fixture) gets `null` for it — `[]` for the waystations, `null` for a
    >   system's absent `claimRadius` — so no row or block ever loses a key. **Copied, never aliased:** every
    >   object in the board is new, so nothing holding the board can reach into the seed.
    > - **Left out, as ruled:** each planet's archetype, nodes, slots and resource types; `terranHomeworldId`;
    >   `starterEligible`; `validation`. `stats` is carried whole, as ruled, so it includes galaxy-wide
    >   **counts** (`totalResourceNodes`, `totalSettlementSlots`, `starterSystems`, …) — the HUD's numbers. A
    >   count says how many, never where (on the decision checklist).
    > - **The route** — `GET /board` is unchanged in mechanics: `refreshBoard()`'s pre-serialised buffer,
    >   `404 NO_GALAXY`, the `ETag` + `304`, `Cache-Control: no-cache`, the CORS headers. Its bytes changed, so
    >   its ETag did. On the committed seed the board is **313,702 bytes against `/galaxy`'s 8,693,128 (3.6%)**
    >   (slice 2's systems-only board was 283,008, 3.3%).
    > - **Proved** (`tests/l0-board.test.js`): the object's keys; `seed`, `galaxyParams`, `citadel`,
    >   `outposts` and `stats` each equal to the seed's; the waystations id-sorted and each exactly `{ id,
    >   coords, name }`; every system row's `claimRadius` equal to its seed system's and to `getClaimRadius`;
    >   `systems` id-sorted, with `planets` equal to `getSystemLayout`'s (order = seed index + 1); the whole
    >   board byte-equal to a second spelling straight off the raw seed. **The leak-free tripwire is widened**:
    >   the board's JSON text — asserted on the served bytes too — holds none of the four fogged words **nor
    >   `terranHomeworldId`, `starterEligible` or `validation`**, and the check is proven to bite: each
    >   forbidden word, on a system row or at the top level, fails it. **Copy, never alias:** no object in the
    >   board is an object of the seed. **Pinned:** the committed seed's board bytes (size + sha256), which
    >   `/board`'s ETag names. Determinism, the 404, a new galaxy's new board and ETag, and the 304 hold as in
    >   slice 2. **Nothing else moved:** the per-guild view goldens (`tests/rival-leak-removed.test.js`,
    >   `tests/deep-scan-job.test.js`) pass unchanged — `tests/systems-block.js` now reads
    >   `getBoard().systems`, and putting the block back still reproduces them byte for byte — and no god's-eye
    >   pin was touched.

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
>   `sim/tick.js`'s **end-of-tick observation block** right after `observePublicRegister` *(⤳ removed 08-10-26,
>   ruling 11 — the scan completion is now that block's only record writer)*: observation, not
>   economy (no step reads a job or the record, so the eight-step order is untouched), after the steps so it
>   reads the claims as the tick leaves them, and stamped with the tick just built, so its order against the
>   register observation changes no value. Arrays in id order; a job is due when `completeTick <= tick`, so
>   one queued at tick T reveals at the end of tick T + 720 (L1) or T + 480 (L2). **Re-validated:** if a
>   **rival** now controls the target's system the job **completes to nothing**; unclaimed, or now held by
>   the scanning guild itself, both reveal. **L1** → `revealSystemArchetypes` (every planet's archetype, **no
>   node** — unlike founding's `revealSystem`); **L2** → `revealPlanetNodes` (every resource node of the one
>   planet). Both are loops over `reveal` (`sim/exploration.js`), so learn-once holds: a known fact is a
>   no-op and keeps its first tick. The job clears either way. *(⤳ 09-10-26, the settlement-surface slice:
>   the L2 reveal is renamed **`revealPlanetSurface`** and reveals the planet's whole surface — every
>   resource node **and** every settlement slot (§4 ruling 10). L1 still reveals no surface: no node, no
>   slot.)*
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
> the client. *(⤳ 13-10-26: the client's survey flow is BUILT — the client flip's slice 3b, §10 — reading the
> job off this row exactly as it is. The **completion notice** is still not built, and is **DEFERRED** (ruled
> 13-10-26, the design room): every notice in the game is an engine event and a scan emits none yet, so it is its
> own later slice — an engine `scan_complete` / `scan_voided` event (`sim/events.js`, `docs/event-log.md`) and
> then the client's render of it.)*

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
> *(⤳ 09-10-26, the settlement-surface slice: `revealSystem` now also reveals every **settlement slot** of
> each home planet (the whole surface, §4 ruling 10), stamped with the founding tick. The founding goldens
> moved by exactly those slot facts plus each entry's `slots` map — each re-pin carries a strip-and-prove of
> the previous hash, `tests/slot-strip.js`.)*
> *(⤳ 09-10-26, the L0-board slice (§4 ruling 12): L0 is still not stored, but it is no longer computed in
> the view either — its static half is the board (`GET /board`), the same for every guild, and the
> controller is the view's `claims`. Founding is unchanged.)*

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
  **⤳ DESIGN-AHEAD 07-10-26 (§4 ruling 10, NOT built):** the shape grows a per-planet **`slots`**
  track beside `nodes` — `{ [planetId]: { tick, nodes: {…}, slots: { [slotId]: tick } } }` — so a
  known settlement slot is representable (the claim gate reads it; §8). Revealed with its node
  siblings by a surface survey, or one slot at a time by a rival's licensed factory (the
  public-register leak, §3) *(⤳ that second source is RETIRED by §4 ruling 11 and its code removed
  08-10-26 — a slot enters the record only by your own survey or founding)*. `checkExplorationRecord`
  extends to guard real slots on their own planet. The settlement-surface slice builds it; until then
  the record is nodes-only, as above.
  **⤳ AS-BUILT 09-10-26 (the settlement-surface slice; roadmap 2.5, §4 ruling 12 slice 1) — the shape
  is now `guild.exploration = { [planetId]: { tick, nodes: { [nodeId]: tick }, slots: { [slotId]: tick }
  } }`.** A slot key = the guild knows that settlement slot is there (L2); its value is the tick it was
  learned. A slot has no type, so the key is the whole fact — ids only, as before. **`slots` is always
  present**, exactly as `nodes` is: `{}` for an L1-only planet, and `{}` on a surveyed planet of a
  zero-slot archetype (gas giant, molten, irradiated). `reveal` takes a third fact, **`{ slotId }`** (it
  must be a `settlement` site, and it also reveals its planet), learn-once like the others. A slot enters
  the record only through `reveal`, from founding or the guild's own L2 survey — both of which reveal the
  whole surface (§4 ruling 10's AS-BUILT note). `cloneExploration` copies `slots` two levels deep beside
  `nodes`. `checkExplorationRecord` guards it as it guards `nodes`: an object, every key a real
  **settlement** slot on **this** planet, every tick in `[planet tick, now]`. No slot **read** exists yet —
  the claim gate's read is the Prefecture slice's (§8).
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
    predicate the record observation used; *⤳ that observation is removed, 08-10-26*), each cut to `id`, `ownerGuildId`, `type`, `siteId`,
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
    rival's venture row, so the two sources stay distinct. *(⤳ 08-10-26, ruling 11: `known` is now the
    record **∪ every controlled system at full L2** — see the AS-BUILT note below.)* *(⤳ 09-10-26, the
    settlement-surface slice: each entry is now `{ archetype, nodes: { [nodeId]: resourceType }, slots:
    { [slotId]: true } }` — see the slots note below.)* *(⤳ 09-10-26, the L0-board slice (§4 ruling 12,
    slice 2): **`systems` is REMOVED** — `geography` is now `{ known }`. Its static facts are the board's
    (`GET /board`) and its controller is the `claims` row; see the board note below.)*
  Every rival row is an **allow-list**, and every top-level god's-eye key must be classified public
  or filtered in `fog.js` `TOP_LEVEL` — an unclassified key throws, and a test fails on a new one —
  so nothing new reaches a player by default. The view is pure (it reads the record, writes
  nothing). `GET /snapshot?guild=<id>` serves it for headless proof (404 for an unknown guild);
  plain `GET /snapshot` is unchanged. The client wiring is slice (c). *(⤳ WIRED 13-10-26 — the client
  flip, slice 3a: once a guild is seated, every snapshot the client reads is this view; the AS-BUILT note
  closing the board note below.)*
  **⤳ AS-BUILT 08-10-26 — the controlled-system projection (§4 ruling 11; roadmap 2.5, the ruling-11
  cleanup; `sim/fog.js` `geographyFor`).** `geography.known` is now the **union** of the two sources
  (§3): (1) the guild's **record**, resolved through the seed as before; and (2) **every controlled
  system** — `systemControllers(state)`, so the viewer's own systems and every rival's alike — at **full
  L2**: for each planet of the system (the seed's own `getSystemLayout`; no new accessor), its archetype
  and **every** resource node → its `resourceType`. Computed **live** on every view from the seed + the
  claims, **never banked**: it shows while the system is held and is gone the moment control lapses,
  leaving only what the viewer surveyed itself. **Merged, not clobbered** — a planet named by both
  sources is one entry; the record's facts for it are the same seed facts, so the overlay only adds. Keys
  are sorted at all three levels (system, planet, node) so the bytes never depend on which source met a
  key first (invariant 9). The entry shape is unchanged, `{ archetype, nodes }`. **Not yet: settlement
  slots** — ruling 11's end state is "every node **and every slot**"; the slots arrive with the
  settlement-surface slice, which adds a `slots` track to the record and to this projection together.
  *(⤳ AS-BUILT 09-10-26 — the settlement-surface slice, below: the slots are projected now.)* A
  rival's licensed-venture rows are unchanged (type + reputation, "plus every licensed venture"). The view
  stays pure — it computes no game number and writes nothing. **What moved:** a multi-guild view gains
  each rival's held system(s) in `known` (and, for an own system, nothing new — the home is already in the
  record in full); a one-guild view is byte-identical. Strip the rival-held ground from a view and it is
  `main`'s byte for byte (`tests/rival-leak-removed.test.js`; the 2.5 (b2) idle-array view pins re-pinned
  the same way, `tests/deep-scan-job.test.js`). **One consequence, left as ruled and flagged:** a node
  lockout still shows only on a node the viewer's **record** knows or ground it holds (§2, ruling 3 of
  06-10-26), so with the leak gone a lockout on a rival's ground shows only to that rival — although `known`
  now shows the node itself. Whether "knows" should follow the live projection is on the roadmap's decision
  checklist (ruling-11 cleanup items).
  **⤳ AS-BUILT 09-10-26 — settlement slots in `known` (the settlement-surface slice; roadmap 2.5, §4
  ruling 12 slice 1; `sim/fog.js` `geographyFor`).** Each `known` entry is now **`{ archetype, nodes: {
  [nodeId]: resourceType }, slots: { [slotId]: true } }`**. A slot has no type, so its value is `true` —
  presence: the id list a client's Settlements tab renders. Entries are **uniform**: every one carries
  `slots`, `{}` when none is known, whichever source named the planet. Both sources fill it: (1) the
  **record**'s `slots` (what the guild surveyed or was founded on), and (2) **every controlled system**,
  live — every planet's `settlementSlots` from the seed's own layout — so a controlled system (own or
  rival) is now at ruling 11's full L2, "every node **and every slot**". Merged, not clobbered, exactly as
  nodes are, and `sortedKnown` sorts the slot keys too, so the bytes never depend on which source met a key
  first (invariant 9). The god's-eye lens is untouched: it carries no record and builds no `geography`.
  **What moved:** every per-guild view, by exactly the `slots` maps (strip them and each view is its
  08-10-26 bytes — `tests/slot-strip.js`, re-pinned in `tests/rival-leak-removed.test.js` and
  `tests/deep-scan-job.test.js`); every god's-eye hash held. The client does not read `known` yet (ruling
  12's slice 3). One rule left as ruled: a settlement slot's **lockout** still shows only on ground the
  viewer controls (§2) — `isLockoutVisible` reads nodes, not the new slot track; flagged on the roadmap's
  decision checklist.
  **⤳ AS-BUILT 09-10-26 — the L0 board and the slim poll (the L0-board engine slice; roadmap 2.5, §4 ruling
  12 slice 2; `sim/seed.js` `getBoard`, `sim/server.js` `GET /board`, `sim/fog.js` `geographyFor`).** The
  per-guild view's `geography` is now **`{ known }`**: the `systems` block — L0 for all 1,500 systems,
  rebuilt on every view — is removed. Its static facts (identity, position and now the orbital layout) are
  the **board**, `getBoard()` → `[ { id, name, coords, ring, planets: [ { id, order } ] } ]` sorted by id,
  served once at **`GET /board`** with an ETag (§4 ruling 12's AS-BUILT note has the details); its one live
  fact, the controller, is the system's row in `claims`, which the view already keeps whole. `known` is
  untouched, and a planet id in `known` is the join key onto the board's `planets`. The god's-eye lens is
  untouched: it builds no `geography`. **What moved:** every per-guild view, by exactly the `systems` block
  — put it back (rebuilt from the board and the view's own claims, `tests/systems-block.js`) and each view is
  its settlement-surface bytes, re-pinned in `tests/rival-leak-removed.test.js` and
  `tests/deep-scan-job.test.js`. Nothing live reads either half yet: the client still loads `GET /galaxy`
  and plain `GET /snapshot` until the client flip (slice 3). *(⤳ AS-BUILT 13-10-26 — the client flip,
  slice 3a: **the client now reads both halves.** It fetches `GET /board` once at connect (the map's whole
  geometry; it no longer fetches `GET /galaxy` at all) and, once a guild is seated, polls **`GET
  /snapshot?guild=<id>`** — the poll, the post-action re-read and entering the game. It reads `known` for every
  planet's level and detail and `claims` for every controller (§10's AS-BUILT note). Plain `GET /snapshot` is
  read only at connect — to learn whether, and which, guild is seated — and when founding, to pick a free guild
  id; a guild cannot be asked for before it is known. Still god's-eye, and slice 3c's: that discovery read, the
  embedded Production Console (`client/console.html`, which polls plain `/snapshot` on its own), and `POST
  /action`'s reply, which carries the god's-eye snapshot.)*
  *(⤳ AS-BUILT 13-10-26 — the board-widening slice: the board's shape WIDENED to the whole static
  public galaxy. `getBoard()` now returns an object, `{ seed, galaxyParams, citadel, outposts, stats,
  systems }`, whose `systems` are the rows above, each gaining its `claimRadius`; still no fogged planet
  detail and no `terranHomeworldId` (§4 ruling 12's 13-10-26 note has the details). The view is untouched,
  and a planet id in `known` now joins onto `board.systems[].planets`.)*
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
  *(⤳ REMOVED 08-10-26 — AS-BUILT, §4 ruling 11: `observePublicRegister` is deleted, so the `reveal`
  callers are `revealSystem` (founding) and the Deep Scan Array's two loops only — a rival's surface is
  shown live in the view (the projection note above), never revealed into the record.)*
  *(⤳ 09-10-26, the settlement-surface slice: `fact` may also be **`{ slotId }`** (L2 — a settlement slot,
  which also reveals its planet), and the L2 loop is renamed **`revealPlanetSurface`**. Founding and the
  L2 loop share one inner loop, `revealSurface`, the one place "a planet's whole surface — every node and
  every slot" is spelled out.)*
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
  *(⤳ 09-10-26, §4 ruling 12 — the client fog boundary (the design room's “Option B”):
  this **is** the “later backend slice.” `GET /galaxy` stops serving the seed and serves
  the **L0 board** instead — per system `{ id, name, coords, ring, planets: [ { id, order } ] }`,
  L0 only, no guild ids, no archetype/node/slot, static and cacheable (a new galaxy ⇒ a new
  board; carry a galaxy id / etag). The browser then holds L0 for the whole galaxy and L1/L2
  only from `geography.known`, so it **cannot** display what it was never sent — the leak is
  closed by construction, not by trust. `GET /starters` is the same class of leak and is
  hardened in the same slice (its exact shape left to that slice). Design-ahead; built by the
  L0-board engine slice, ruling 12 slice 2.)*
  *(⤳ CORRECTED 09-10-26 — the design room's sequencing of ruling 12 (§4): the note above is the end
  state, not slice 2. **The board is served at a NEW route, `GET /board` (slice 2, AS-BUILT — §4 ruling
  12's note). `GET /galaxy` is UNCHANGED and still serves the whole seed; its cutover and the leak's
  closure are the client flip, slice 3**, because the running client still reads the seed from `/galaxy`
  until then. **The `/galaxy` leak is therefore still OPEN.** `GET /starters` is untouched too; its
  hardening was ruled into "the same slice" as `/galaxy`'s, so it follows `/galaxy` to slice 3 —
  flagged on the roadmap's decision checklist to confirm.)*
  *(⤳ DESIGN-AHEAD 13-10-26 — §4 ruling 12 slice 3c, the leak closure (the design room's “Option
  1”, 13-10-26): the client flip's last slice. The dev rig has **no auth**, so the leak splits in two.
  **Closed by 3c — every path the PLAYER CLIENT uses:** **`GET /galaxy` is retired** (nothing reads it
  since the client flip moved the map to `/board`, §10 — so the full-seed route is removed, the
  Option-B leak gone rather than merely unused); **`GET /starters` drops `terranHomeworldId`** and
  returns `{ id, name, ring }` (the client sends only `homeSystemId` at founding and the engine resolves
  the Terran homeworld server-side, revealing it to that guild as its own home, §6 — so the field was
  pure leak, “which planet is Terran” being L1, and no caller used it); **`POST /action` replies with the
  fogged per-guild view** (`buildSnapshot(next, action.guildId)`), not the god's-eye lens; and **the
  embedded Production Console polls per-guild** — `client/console.html` run embedded (`embed=1&guild=<id>`)
  reads `GET /snapshot?guild=<id>`, which loses nothing since it only mounts for a system the player
  controls (`__isMine`), while the standalone operator console keeps plain `/snapshot`. **Deferred to
  Phase-2 auth** (a recorded decision, not an oversight): plain `GET /snapshot` (god's-eye) still serves
  the operator/debug pages (`inspect.html`, `state_inspector.html`, the standalone console) and the CLI
  tools, and `GET /snapshot?guild=<any>` lets a caller name any guild — both closable only once real
  guild **authentication** binds a request to its guild (Phase-2: PostgreSQL + auth); the connect-time
  discovery read also stays plain `/snapshot` (it reads only public fields — guild ids/names and
  `claims`). That residual is the “no-auth, client-picks-its-own-guild dev rig” §7 has flagged from the
  start — 3c closes every path the player client uses, and the rest waits for auth. Built by slice 3c.)*
  *(⤳ 13-10-26: the board at `GET /board` is now the widened object — §4 ruling 12's 13-10-26 note, AS-BUILT
  — so it carries the static, unfogged blocks the ruling found the client reading off `/galaxy` (`galaxyParams`,
  the waystations, the Citadel, each `claimRadius`, the seed number, `stats`). `GET /galaxy` and `GET /starters`
  are still untouched: **the leak is still OPEN** until slice 3.)*
  *(⤳ 13-10-26 — the client flip, slice 3a: the client **no longer reads** `GET /galaxy` — it renders only
  from the board and `geography.known` — but the route is unchanged and still serves the whole seed to anyone
  who asks, and `GET /starters` still names every starter's `terranHomeworldId`. **The leak is still OPEN**;
  its closure is slice 3c.)*

## 8. The claim-gate coupling — "you can't claim an unexplored system"

The one new ruling this slice **records** for the next slice to **enforce**: a guild may plant a
Prefecture on a planet **only on a planet it has surveyed to full L2** — the planet is in its
exploration record with its surface known, including the **settlement slot** the flag plants on (§4
rulings 7, 10 & 11). Surveying is whole-surface and all-or-nothing (ruling 11), so there is one way
in: survey the planet first — no rival-leak shortcut. This coupling is **not** in the repo's
Prefecture model today (`design.md` §2,
`territory-model.md` §4). **This slice does not build the Prefecture** — it records the gate so
the Prefecture / claims slice (next) reads the real ruling, and so the exploration record is
already the gate's data source from birth.

> **⤳ AS-BUILT 05-10-26 (roadmap 2.5 (a)) — RECORDED, NOT ENFORCED.** The record this gate reads
> now exists from founding, keyed per planet exactly as ruling 7 needs it, and `knowsNode(guild,
> nodeId)` / `exploration[planetId].nodes` (`sim/exploration.js`) is the read the Prefecture slice
> will gate on ("knows ≥ 1 node of planet P"). Nothing calls it as a gate yet: the claim and
> establish validations are untouched. *(⤳ REVISED 08-10-26, §4 rulings 7 & 11: the gate becomes
> "planet surveyed to full L2" — under all-or-nothing, knowing a settlement slot of P and having
> surveyed P are the same thing. No rival-leak factory source (ruling 11 removes it); the Prefecture
> slice gates on the surveyed record.)* *(⤳ 09-10-26, the settlement-surface slice: the record now carries
> each surveyed planet's **settlement slots** (§7), so the datum the gate reads — "knows a settlement slot of
> P" — is representable and populated, by founding and by the guild's own L2 survey. Still **recorded, not
> enforced**: no claim or establish validation reads it, and no slot read (`knowsSlot`) is added until the
> Prefecture / claims slice needs one.)*

## 9. Scope & the vertical split

**In (roadmap 2.5, the exploration slice):** the fog flip (per-guild filtered snapshot to the full
L0/L1/L2 model); the per-guild exploration record; the Deep Scan Array's remote-scan discovery
(queued jobs, no fuel/craft, revealing L1/L2 into the record over time); the two sources (§3); the
"can't claim unexplored" ruling recorded (§8).

**Out (designed-but-deferred, or built elsewhere):** monitoring (§5, deferred half → detection/L3
+ corridors + catch/fine); L3 espionage (rival interiors with discovery-chance + fine; rival
stockpiles / transports / scanners); the semi-controlled corridors (need claims); the Prefecture /
claims slice (next; its self-scan, §4 ruling 9, is **retired** — ruling 11); squatting (deferred
until its punishment exists); buy-only transport visibility (already built).

**Likely build order (sequential vertical slices — survival rule 3):** (a) **engine** — the
per-guild snapshot filter + the exploration record + the two sources + founding state + the §8
coupling recorded; then (b) **the Deep Scan Array** — the entity + deploy + the scan-job queue +
reveal-to-record + completion revalidation; then (c) **client** — the fog UI (the galaxy map shows
L0, scanned/known systems reveal L1/L2, rival systems show the public record). Keep the tick
central: the client renders its guild's snapshot and computes no game number. Never invent a
number.

## 10. How the levels render — the manifests, per level *(design for slice (c), 08-10-26)*

Two player views share the fog state. The **system manifest** is an index of planet tabs down the
left and a main panel. The **planet manifest** (the redesign) is a **left panel that is the
archetype** — artwork + a fixed per-archetype blurb — and a **main split into two equal columns**:
the Resources/Settlements surface lists on the left, a venture stat panel (blank this pass) on the
right. A guild's level on each planet *is* what renders.

> **⤳ AS-BUILT 08-10-26 — the planet-manifest LAYOUT only (roadmap 2.5 (c1); client only).** The two
> zones above are built in `client/game.html` to `docs/mockups/planet-manifest.html`: the left panel
> is the title, the archetype blurb (`ARCHETYPE_BLURB`, one fixed text per archetype) and the hero
> art; the main is the two equal columns, with the venture panel blank. The rows behave exactly as
> before. Nothing per-level is built yet: every planet still renders its full surface from the
> current snapshot. The L0/L1/L2 states, "No Survey Data", the survey flow and the system manifest's
> tag below are still to come. *(⤳ 13-10-26: the L0/L1/L2 states, "No Survey Data", the tag's three
> states and the map's ownership colour are BUILT by the client flip's slice 3a — the AS-BUILT note
> closing this section. The survey flow is slice 3b. The blank venture panel's copy now reads "Select a
> site to establish or manage a venture.")* *(⤳ 13-10-26: the survey flow is BUILT by slice 3b — the last
> AS-BUILT note in this section; its completion notice is deferred.)*

**System manifest — the tag and the index tabs.**
- The `UNCLAIMED` tag by the system id has **three states**: a **`SURVEY SYSTEM`** button when the
  system is unclaimed and you do not yet know its archetypes (L0); a plain **`UNCLAIMED`** label once
  you know them (≥ L1) but no one holds it; the **controlling guild's name** once claimed (a claimed
  system is shown at full L2 to everyone — ruling 11).
- **L0 tab:** blank, no art, labelled "Unknown Archetype". Clicking opens a planet manifest with a
  blank hero and a main reading "No Survey Data" where the surface lists would be.
- **L1 tab:** its archetype art + label, but the pip columns (resource squares / settlement
  triangles) are **replaced by a `Survey` button**. Clicking the tab opens the planet manifest with
  the hero populated (art + blurb) and the main still "No Survey Data".
- **L2 tab:** the pip columns return with real counts; the tab opens the full planet manifest.

**The survey flow (L0→L1 and L1→L2).** `SURVEY SYSTEM` queues the whole-system **L1** archetype scan;
a tab's `Survey` button queues that planet's **L2** surface scan (the L1→L2 chain, §5). Both open the
**standard confirm popup** with a character hero on the right (`assets/characters/spy.jpg` — a scout,
not called "spy" in the copy) and a short brief, and both let the player **pick which deployed array**
runs the job (disabled / "no array" when the guild owns none; an array already running a job is
unselectable — one job per array, §5). Confirm enqueues the job on the chosen array. While a job runs,
the tag/button reads **"Surveying · <eta>"** with the map's rotating-radar indicator (eta
engine-computed, §5); on completion the archetypes (system scan) or pips (planet scan) appear and a
notice fires — scan-complete, or the **voided** notice if a rival claimed the target first.
*(⤳ AS-BUILT 13-10-26 — slice 3b, the last note in this section — **except the notice**, which is
**DEFERRED** (ruled 13-10-26, the design room): every notice in the game is an engine event, and a scan emits
none yet. Until that later slice (an engine `scan_complete` / `scan_voided` event, then its client render), a
scan reveals into `known` silently and the result appears when the manifest re-renders on the next poll; the
"Surveying" label clears itself, so a voided scan simply returns its tag / tab to the state it now has.)*

**Planet manifest — the surface rows (L2).** Both lists render in full. **Resource-node rows are
inert until you control the system** (establishing a mine needs control — Gate 3, `territory-model.md`
§4). **Settlement-slot rows are clickable**: in a system you control they open the existing Establish /
Manage flow; in an unclaimed system you have surveyed, the click is the **hook the Prefecture / claims
slice wires to the plant-and-claim action** — that action is *out of scope for the fog-UI slice*, the
rows are simply made clickable so the claim slice fills them in (the §8 gate is satisfied because you
have surveyed the planet). A **rival-controlled** system's planet manifest shows the full surface
(ruling 11) plus its licensed ventures, read-only — you neither establish nor claim there.

**On the galaxy map (unchanged by fog — RULED 05-10-26).** The map geometry never changes with a
system's level. The only map change is **ownership colour** — the player's systems in the current
cyan, **any** rival's in a single bright pink (no per-rival distinction), unclaimed neutral — plus a
**slowly-rotating radar indicator** on a hex carrying an active scan. All level detail lives in the
manifests, never on the map. *(⤳ AS-BUILT 13-10-26: the ownership colour by slice 3a, the radar by slice 3b —
the two notes below.)*

> **⤳ DESIGN-AHEAD 09-10-26 (§4 ruling 12 — the client flip, slice 3) — AS-BUILT 13-10-26 for slices 3a
> and 3b (the two notes below this one); slice 3c is still to come.** The
> per-level render above no longer reads a full-seed download (`window.__galaxy`). Its inputs
> become the **L0 board** (the orbital layout — which planet tabs exist, in what order, for
> every system) and the **polled `geography.known`** (the archetype that lifts a tab to L1,
> the nodes + slots that lift it to L2). `adaptSeedSystem` is reworked to merge board-layout +
> known-detail: a planet with no `known` entry is the L0 tab (“Unknown Archetype” / “No
> Survey Data”); its archetype present is L1; its nodes/slots present is L2. Controllers come
> from `claims`, the map geometry from the board. Nothing in the render's *appearance* (§10
> above) changes — only where the data comes from, and that the browser no longer holds any
> planet's detail until the guild has earned it.
> *(⤳ 09-10-26: both inputs now exist server-side — the board at **`GET /board`** (ETag'd; slice 2) and
> the slim per-guild view at `GET /snapshot?guild=<id>` (`geography = { known }`, controllers in `claims`).
> Per the design room's sequencing (§4 ruling 12), the client flip is also where **`GET /galaxy` stops
> serving the seed** — the step that closes the `/galaxy` leak.)*
>
> **⤳ AS-BUILT 13-10-26 — the client flip, slice 3a: the fog flip, read-only (roadmap 2.5; client only —
> `client/game.html`; no engine, server, view, board or golden change).** The render above, built, with its
> inputs flipped. **No new number.**
> - **The inputs.** At connect the client fetches **`GET /board`** into `GAME.galaxy` instead of `GET /galaxy`.
>   The board is the shape `loadGalaxy` already read, so the map's geometry, starfield, waystations, Citadel,
>   claim disks and HUD stats are unchanged; nothing reads a planet's archetype, nodes or slots off it any more.
>   Once a guild is seated every snapshot read — the 1 s poll, the post-action re-read (`__refreshNow`) and
>   entering the game — is **`GET /snapshot?guild=<id>`**, and `applySnapshot` keeps its `geography.known`
>   beside `claims`. Plain `/snapshot` remains for the connect-time discovery read and founding's free-id pick
>   (3c hardens both); the home picker before founding is unchanged (`/starters` + the board).
> - **The levels, read off `known`, never worked out.** `adaptSeedSystem` → **`adaptBoardSystem`**: the board
>   row gives the planets (`id`, `order` — the numeral), `known[systemId]` the per-planet detail, `claims` the
>   controller. **No entry = L0; an archetype with empty `nodes` and `slots` = L1; any node or slot = L2.** Node
>   and slot rows are `known`'s keys in their sorted order — on the committed seed that is the seed's own order
>   (no planet's list is out of order), so the rows read "Resource Node 1, 2, …" exactly as before.
>   - **The tag:** a disabled **`SURVEY SYSTEM`** button when the system is unclaimed and none of its planets is
>     known; plain **`UNCLAIMED`** when one is (≥ L1) and nobody holds it; the **controller's name** when held
>     (own, rival or bot — a held system is full L2 to everyone). No claim row reads as unclaimed.
>   - **The tabs:** L0 is blank — the flat chip colour, a dashed edge, no art — labelled "Unknown Archetype";
>     L1 shows its archetype art and label with a **`Survey`** control where the pip columns sit; L2 is the c1
>     tab, pips from `known`'s counts. The system sub-line now says "N bodies" (the count is the board's L0
>     layout; "surveyed" was untrue of an unsurveyed system).
>   - **The planet manifest:** L0 — a blank hero, no blurb, and **"No Survey Data"** where the surface lists go
>     (no Resources / Settlements tabs, no rows, no stamp); L1 — the hero art + blurb, and "No Survey Data"; L2 —
>     the c1 layout, its rows from `known`. Every row behaves exactly as c1 left it (settlement rows clickable;
>     no claim gate wired).
>   - **Live:** an open detail screen re-renders when occupancy, `known` or a controller moves (it was occupancy
>     only), so a survey landing or a claim lifts the screen in place.
> - **The survey affordances are inert** (3b wires them to `queueScan`): `SURVEY SYSTEM` is a disabled button; a
>   tab's `Survey` is a span — a button may not nest inside the tab's own button — that swallows its own click.
>   No confirm popup, array picker, eta, radar or notice. *(⤳ 13-10-26: wired by slice 3b — the next note.)*
> - **The map's ownership colour:** the player's systems and outposts in the current cyan, **every** rival's in
>   one bright pink (`--rival` / `RIVAL_RGB`, `#ff5caa` — presentation, not a game number), unclaimed the
>   neutral system blue. The per-rival hue (`guildColor`) is removed, and the map key gains a "Rival Guild" row.
>   No radar indicator (3b). *(⤳ 13-10-26: the radar is built by slice 3b — the next note.)*
> - **The fogged poll is tolerated:** a rival's outpost panel reads "—" for the capacity and docks its fogged row
>   does not carry (it would have thrown on the fogged row), and OPEN DETAILS opens the Outpost Manager for the player's own outposts
>   only; Venture Management's art resolves a planet's archetype from `known` (it read the seed); a 404 on the
>   per-guild poll — the guild no longer exists, e.g. after `/reset` — returns to the connect screen ("GUILD NOT
>   FOUND") instead of freezing as LINK LOST. Every other screen already read only the player's own rows.
> - **Not built:** slice **3b** (the survey flow, the radar, the scan notices) and slice **3c** (`GET /galaxy`'s
>   cutover and the leak's closure, `GET /starters`' hardening, the connect-time god's-eye read, the embedded
>   console's plain `/snapshot` poll, `POST /action`'s god's-eye reply). **The `/galaxy` leak is still OPEN.**
>   *(⤳ 13-10-26: 3b is BUILT — the next note — bar the scan notices, which are deferred.)*
> - **Proved** headless (Playwright) against a live `node sim/server.js`, the player founded through the connect
>   screen and a rival, a bot and real Deep Scan Array surveys seated through `tools/admin.js` and `POST /action`
>   — 56 checks: every level state (L0, L1, an L1/L2 mix lifted live on the open screen, own / rival / bot held
>   at full L2 with the controller's name, the rival's unlicensed mine fogged to VACANT), the map colour by
>   sampled pixels (own cyan, both rivals the same pink, unclaimed neither), the network (`/board` fetched,
>   `/snapshot?guild=` polled, **no `/galaxy` from any frame**, plain `/snapshot` only before seating), the HUD,
>   map, outposts, TRADE, Guild Hall, Deuterium, Operations and the production console with one guild and with
>   three — **zero console errors**; and a `/reset` under the running client lands it back on the connect screen,
>   no longer polling. The same script against `main`'s client fails the level checks, and against
>   this client with the old sources restored fails all four network checks.
>
> **⤳ AS-BUILT 13-10-26 — the client flip, slice 3b: the survey flow (roadmap 2.5; client only —
> `client/game.html`; no engine, server, view, board or golden change; no `/galaxy` or `/starters` change).**
> "The survey flow" and the map's radar above, built on the engine's existing `queueScan` (§5, (b2)) and the
> own-guild `deepScanArrays` rows the per-guild view already carries. **No new number:** the client states no
> scan duration (the `[FIRST-CUT]` `SCAN_TICKS` are engine config the snapshot does not carry), so a job's eta
> appears only once it runs — `completeTick − tick`, both published.
> - **The arrays.** `applySnapshot` keeps the view's own `deepScanArrays` verbatim as `LIVE.myArrays` (idle = no
>   `scan` key; busy = a `scan` with its target and `completeTick`), read through `window.__myArrays` and
>   `window.__scanFor(level, target)` (the array whose job targets that system / planet, the earliest-finishing
>   if two do). An L2 job's system is the planet's on the **board** (`systemOfPlanet`) — the client never parses
>   an id for it.
> - **The confirm popup** — `#survey-overlay`, `window.openSurvey({ level, systemId, systemName, planetId?,
>   planetName? })`: the standard reel card (`docs/popup-standard.md`) as its own element, eyebrow "Guild
>   Scout", the scout's portrait (`assets/characters/spy.jpg`) on the right, a brief in the scout's voice naming
>   the target (the system for L1 — "what kind of world each one is"; the planet for L2 — "its whole surface"),
>   and the **array picker**: one row per deployed array, labelled "Deep Scan Array NN" (the id's serial). An
>   **idle** array is selectable ("idle · anchored to <system>") and the first idle one is picked on open; a
>   **busy** one is shown but not selectable ("· surveying <target>"); with **none** the picker reads "No Deep
>   Scan Array deployed". Confirm is off whenever no idle array is picked, and the foot line says why. No
>   range check — an array reaches the whole galaxy (§5). **Confirm** POSTs exactly `{ type:'queueScan',
>   guildId, arrayId, level, targetSystemId }` (L1) or `{ …, targetPlanetId }` (L2) through `__sendAction`, then
>   `__refreshNow`, then closes. A **refusal** (the engine re-validates: the array idle, the target unclaimed,
>   the L1→L2 chain) shows its reason in red in the popup's foot, the popup left open and its picker re-read.
>   The popup re-reads the arrays on every poll while open; Escape closes it alone, not the manifest beneath.
> - **The affordances, live.** The tag's `SURVEY SYSTEM` (L0) → `openSurvey` L1; an L1 tab's `Survey` →
>   `openSurvey` L2 (it still stops its own click, so the planet behind does not open). The chain needs no client
>   check: `Survey` is drawn only on an L1 tab, and the engine re-checks anyway. While an array of ours runs that
>   job the affordance reads **"Surveying · <eta>"** in the player's accent instead (a plain label; on a tab a
>   click opens the planet). The eta is formatted by the map's `fmtETA` (`__fmtETA`, 1 tick = 1 minute). The
>   detail screen's re-render signature now includes the arrays' jobs, so an array starting or finishing a job
>   redraws the open screen; between those, each poll re-reads every label's eta **in place** off its
>   `data-scan-complete`, so the scroll position is kept.
> - **The radar.** The shell feeds the map a new door, `window.__setLiveScans(systemIds)` — the system of every
>   running job of ours — and the map's render loop draws a ring in the player's accent with a sweep turning
>   once every 4 s on each (`drawRadar`, in the map's tilted plane, at least 12 px across). `RADAR_PERIOD_MS`
>   and the trail width are look, not game numbers. Own arrays only: a rival's array never reaches the view.
> - **No completion notice** (deferred, the survey-flow note above): the reveal lands in `known` silently and the
>   manifest re-renders on the next poll; the "Surveying" label and the radar clear themselves when the job does.
> - **Proved** headless (Playwright) against a live `node sim/server.js`, the player founded through the connect
>   screen and a Deep Scan Array deployed through the real kit pipeline (`tools/admin.js` grant-kit → load-kit →
>   a `@deploy:deepScan` route) — 51 checks, **zero console errors**: the popup with no array (picker "No Deep
>   Scan Array deployed", Confirm off), idle (preselected, Confirm on) and busy ("· surveying FEN-4949",
>   unselectable, Confirm off); a **refusal** — a rival founded on the target while the popup was open, Confirm
>   pressed, the engine's "held by guild …" reason shown in the popup, the array still idle; an **L1** survey
>   end to end (the exact POST, accepted, the job on the array, the tag "Surveying · 12h 00m", the eta re-read
>   in place 61 ticks later, the radar painting and turning on the target's hex by sampled canvas pixels and
>   absent elsewhere, then ticked to `completeTick`: all six archetypes known, the tag UNCLAIMED, every tab L1
>   with a live Survey, the radar gone); and an **L2** survey from a tab's `Survey` the same way (the planet not
>   opened by the press, the exact POST, the tab "Surveying · 8h 00m", the radar on the planet's system, then
>   the planet at L2 — 15 node and 15 slot pips, 15 resource rows). The same script against the pre-slice client
>   fails at the first survey check (the disabled button). Sim **2,163** and tools unchanged. The harness lives
>   outside the repo, as 3a's does (3a checklist item 8(c)).
