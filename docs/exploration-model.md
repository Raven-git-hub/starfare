# The exploration & fog model — per-guild visibility

**DESIGN-AHEAD, 05-10-26 (the design room).** The computational model for fog of war:
how the galaxy flips from "one snapshot, everyone sees everything" to a per-guild
filtered view, what each guild learns and how, and the Deep Scan Array's discovery
function. `design.md` §2 ("Fog of war — per-guild visibility") holds the narrative and the
headline rulings; **this file is the model**, the same split `territory-model.md` runs under.

Status by part: the **visibility model (§1–§3)**, the **per-guild snapshot + exploration
record (§7)**, and the **Deep Scan Array's discovery scan (§5)** are the current build
(roadmap 2.5, the exploration slice). **Monitoring (§5, the deferred half), L3 espionage,
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
  that carries a licensed venture**: that node, its planet's archetype, and the venture *type* —
  **never the stockpile** (the §405 rule; this also closes the old rival-stockpile leak). A
  rival's **un-licensed** nodes stay fogged until L3. A craft sent to a rival system reveals
  **nothing new** — the archetypes are already on the public record and it cannot survey nodes.
- **Rival structures.** Outposts and toll gates are **always** visible; transports and deep-scan
  arrays are **never** (until L3).
- **Syndicate.** Waystations always; your **own** buy-order deliveries visible (already built and
  ruled — out of scope, untouched here); rivals' deliveries not.

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

**Discovery — the scan (IN SCOPE).** The throttle, now that distance is removed, is **time +
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
- **The L1→L2 chain.** You cannot queue an L2 scan on a planet until you already know its system
  at **L1** (archetypes). This keeps a human in the loop — survey broadly, look, then spend the
  expensive per-planet L2 on what is worth it — rather than the array becoming an automatic
  all-mapper.
- **Targets are unclaimed systems only.** The queue refuses a rival-controlled target (that is
  L3, deferred); your own systems you already know. **Revalidate at completion** — the same
  "legal to schedule, re-checked on arrival" shape `sim/claims.js` uses for buy deliveries: if a
  system you are scanning becomes rival-held before the job finishes, the job **completes to
  nothing** (no partial reveal). An array **torn down or destroyed mid-job loses the job**; any
  geography already banked persists (learn-once, §3).

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
- **One source-agnostic reveal.** A single `reveal` writes geography into a guild's record,
  whatever the source — a scan completing, a craft visit, a claim, founding, and (later) a
  Prefecture scan. Ruling 1 already forces this (a scan and a rival's licensed venture both
  write the record), so it is not speculative generality.
  **⤳ AS-BUILT 05-10-26:** `reveal(guild, fact, tick)` in `sim/exploration.js`, where `fact` is
  `{ planetId }` (L1) or `{ nodeId }` (L2 — which also reveals the node's planet). It returns how many
  NEW facts it learned (0 = a no-op), refuses an id the seed does not hold, and records what and
  when, never how. Its callers this slice: `revealSystem` (founding) and `observePublicRegister` (a
  rival's licensed venture). The Deep Scan Array (slice (b)) and the Prefecture become callers later.
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

## 8. The claim-gate coupling — "you can't claim an unexplored system"

The one new ruling this slice **records** for the next slice to **enforce**: a guild may plant a
Prefecture on a system **only on a planet that is in its exploration record at ≥ 1 node** (§4
ruling 7) — however the fact entered the record (its own scan, or the public record of a rival's
lapsed venture). This coupling is **not** in the repo's Prefecture model today (`design.md` §2,
`territory-model.md` §4). **This slice does not build the Prefecture** — it records the gate so
the Prefecture / claims slice (next) reads the real ruling, and so the exploration record is
already the gate's data source from birth.

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
