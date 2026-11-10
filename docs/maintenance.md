# Maintenance — droids and spacecraft (roadmap 2.6 maintenance)

> **One-line ruling (RULED 09-11-26, the maintenance design pass).** There are **two maintenance
> streams and only two.** **Droids** wear while deployed, are maintained from their system's
> `droid_components` stock once a week, and are **destroyed** at zero (built — `docs/droids.md` §5;
> this slice **retunes** it). **Spacecraft** wear **only while flying**, are maintained per tick of
> flight from a guild-wide **credit pool** the player funds each cycle, and at zero go into **deep
> maintenance** — free, time only, back to 100% — at a system the guild holds or one of its own
> Outposts. **Miners and factories never wear**, and their condition field is **removed**. Nothing
> here moves GP, RP, the mean line or fuel.

Status: **RULED; slice 1 (the droid retune + the reserve setter) BUILT 09-11-26; slice 2 (remove asset condition) BUILT 10-11-26; the rest not built.** Build order §11. Numbers `[FIRST-CUT]` in `docs/phase-1-tuning.md`
§"Maintenance". This doc is the authority on the *mechanism*; phase-1-tuning is the authority on the
*numbers*; `docs/droids.md` §5 stays the authority on the droid engine except where §1 below retunes it.

---

## 0. What wears, and what doesn't

| Thing | Wears? | Paid with | At zero |
|---|---|---|---|
| **Droid** | while **deployed** | `droid_components`, from its own system's stock, funded weekly | **destroyed** (built, droids.md §5) |
| **Spacecraft** (light / medium / heavy / spycraft) | while **flying** only | **credits**, from the guild's maintenance pool, per tick of flight | **deep maintenance** — out of action for a while, back to 100%, never destroyed by wear |
| **Miner / factory** | **never** — no condition field at all (removed, slice 2 — BUILT 10-11-26) | — | — |
| **Installations** (Outpost, Deep Scan Array, Prefecture, toll gate) | **never** (not this slice, nothing planned) | — | — |

**Why miners and factories never wear (the narrative):** a ground machine sits inside a guild's own
system, always within reach of parts and mechanics. **Why idle craft never wear:** a craft in port
gets routine maintenance constantly. Wear is the cost of *operating away from support* — a droid out
on a venture, a craft out in space.

**Supersedes `design.md` §4 "Condition & maintenance — design-ahead"** (a guild-wide credit spend
slowing *asset* decay, repairing idle assets, a zero-condition asset stopping its venture). Its
ideas survive in a different place: the credit spend and the repair now belong to **spacecraft**
(§3, §4). The asset half is dropped: no asset ever stops for condition, so the "a zero-condition
asset stops" coupling in §4 never arrives. (The asset-less venture — `assetId` null — is still a
real state, reachable by the operator's detach and a future swap-out; it is simply no longer a
maintenance concern. Its open production question stays on the roadmap's decision checklist.)

**Stricken** is not wear — it is a storyteller state (§6), parked.

---

## 1. Droids — the retune

Everything in `docs/droids.md` §5 stands (decay only while deployed, linear and monotonic, the
whole-wear-unit arithmetic, the weekly per-system `droid_components` upkeep, lowest-condition-first
with id tie-break and skip-and-continue, destroy at zero, GP-neutral) **except these three things:**

**(a) One upkeep rate — no split.** Both sources draw **1 `droid_components` per droid-week.** The
Syndicate "red tape" premium (2 per droid-week, droids.md §3) is **dropped**.

*Why:* a Syndicate droid still eats `droid_components`, so a doubled upkeep taxes exactly the guild
that has *not* built a components supply chain — the wrong target. The intended split is: mid-range
guilds take the Syndicate path; large guilds earn the guild-droid payoff by **sustaining a supply
chain of droids and components**. The life gap (b) carries that payoff on its own.

**(b) Maintenance multiplies life by source — ×2 Syndicate, ×4 guild.** The base (unmaintained)
lives are unchanged; the maintained life is the base × the source's multiplier. Still **linear per
tick** — the gap is in the multiplier, not in a curve.

| Source | Unmaintained life | Maintained life | Multiplier | Wear units / tick (unmaint. / maint.) |
|---|---|---|---|---|
| Guild | 4 wk = **40,320** ticks | **16 wk = 161,280** ticks *(was 8 wk)* | ×4 | 4 / 1 |
| Syndicate | 2 wk = **20,160** ticks | 4 wk = **40,320** ticks *(unchanged)* | ×2 | 8 / 4 |

(1 day = 1,440 ticks; 1 week = 10,080.) `DROID_WEAR_SCALE` re-derives itself as the lives' least
common multiple: **161,280** (was 80,640). All four rates are whole numbers, so every droid still
lands on exactly 0 on its ruled tick. **A droid already deployed keeps its condition fraction** —
its wear units simply double at the new scale (exact), so no save needs migrating.

A fully maintained guild droid now uses **16** components over its life; a Syndicate droid **4**.

*Coupling to keep in view:* droids.md §3 ties the **size** of the guild-vs-Syndicate gap to the risk
guild droids will carry later (catastrophic failure, illicit status — roadmap 2.7). This retune
widens the gap, so that 2.7 risk has to weigh correspondingly more. Recorded, not resolved here.

**(c) The reserve floor gets a setter — and stays its own setting.** `guild.droidComponentReserve:
{ [systemId]: whole units }` (absent ⇒ 0, omitted when empty — as built) means **"keep this many for
building"**: weekly droid upkeep never draws a system's `droid_components` below it. It does **not**
guard the other way — a dockyard droid build may still consume components below it (no new build
guard). It is **not** the production console's per-good `reserveLevel` — that setting protects the
production stockpile, and this one splits that stock between building and maintenance. **This
supersedes droids.md §13.3's lean** to reuse `reserveLevel`. A new player action sets it, per
system, whole units ≥ 0 (0 removes the key), from the Maintenance tab (§7).

*(**⤳ AS-BUILT 09-11-26 — maintenance slice 1.** (a)–(c) are in code, no new number. **(a)** `DROID_UPKEEP_PER_WEEK`
(`sim/droids.js`) is one constant, **1**, for both sources — not a table of two equal values; `weeklyUpkeepFor` is the
deployed count × 1; the triage is unchanged (with one rate, skip-and-continue covers exactly what a stop would).
**(b)** `DROID_LIFE_TICKS` guild **40,320 / 161,280**, Syndicate **20,160 / 40,320**; `DROID_WEAR_SCALE` re-derives to
**161,280** (still computed, never typed); wear guild 4 / 1, Syndicate 8 / 4 units a tick; the load-time whole-rate
tripwire passes. No save migration — a droid worn under the old 80,640 scale restores with its fraction, its units
exactly doubled, and reaches 0 on exactly the tick the new rates predict (`sim/tests/droid-decay.test.js`, "retune").
**(c)** The action is **`setDroidComponentReserve { guildId, systemId, reserve }`** (`sim/actions.js`), through the one
validate / journal / apply path (`POST /action`, like every player action — no new route). Refused: an unknown guild;
a system not on the seed, or one the guild does not hold; a reserve that is not a whole number ≥ 0. 0 removes the
system's key and an empty map is omitted, so set-then-clear is byte-identical to never-set. It does not touch
`reserveLevel` or guard the dockyard build. **The tick:** the reserve map has no row to stamp, so — as its sibling
`setProductionProfile` does — the journal line `{ tick, action }` is the record (roadmap decision checklist,
"Maintenance slice 1 calls"). Snapshot: no new field — `droidUpkeep[systemId]` already reports `reserve`, and its
`weeklyUpkeep` / `runwayWeeks` now read the one rate. Tests: `sim/tests/droid-reserve-setter.test.js` (new) and the
retuned `sim/tests/droid-decay.test.js`.)*

---

## 2. Spacecraft — wear

- **A craft wears only while flying** — stored `status` `inTransit`. It does **not** wear `idle`
  (berthed, or waiting in an Outpost dock queue), `loading` (in an Outpost dock slot), or in deep
  maintenance (§4).
- **Wear is measured in flight time, not distance.** A faster craft covers more ground per tick;
  a shorter route saves wear as well as fuel — deliberately another advantage for toll paths later.
- **Linear per tick, two rates per class** (maintained this tick or not, §3), same whole-wear-unit
  arithmetic as droids. Lives (in ticks of flight):

| Class | Unmaintained life | Maintained life (×2) | ≈ hexes flown, unmaint. / maint. | Wear units / tick (unmaint. / maint.) |
|---|---|---|---|---|
| Light | 8 wk = **80,640** | 16 wk = **161,280** | 768 / 1,536 | 6 / 3 |
| Medium | 6 wk = **60,480** | 12 wk = **120,960** | 403 / 806 | 8 / 4 |
| Heavy | 4 wk = **40,320** | 8 wk = **80,640** | 179 / 358 | 12 / 6 |
| Spycraft | 1 wk = **10,080** | 2 wk = **20,160** | 384 / 768 | 48 / 24 |

  Hexes are only a guide (life ÷ the class's ticks-per-hex: 105 / 150 / 225 / 26.25). The spycraft's
  short life makes it the hardest-wearing per hex despite its speed. **`CRAFT_WEAR_SCALE` = 483,840**
  — the least common multiple of the eight lives, *derived* at load like `DROID_WEAR_SCALE`, not a
  tuning number; a load-time tripwire halts if any rate is not whole.
- **The exactness rule (testable):** a flight of **L** ticks costs exactly **L** ticks of wear, each
  tick at that tick's rate (maintained or not). The build pins — and documents — which tick of a
  leg owns its first and last tick of wear; whatever it pins, a leg is never charged L ± 1.
- **Clamped at 0.** A craft at 0% keeps flying and stays at 0% (§4.3). Condition never falls below
  0 or rises except at the end of deep maintenance (→ 100%).
- **Condition changes nothing else.** Speed, fuel burn and capacity are untouched at any condition;
  condition only *gates* (§4). Consistent with "condition never affects rate".
- **The field is the existing `Vehicle.maintenanceCondition`** (a fraction, 1 = new) — kept by name,
  now live. Wear is the tick's ambient process, so it does **not** re-stamp `updatedAtTick` (as
  droids); the discrete events (§4) do.
- **The starter heavy's 0.5 is confirmed** (decision checklist, closed 09-11-26): it starts with
  2 weeks of unmaintained flight (4 maintained) before deep maintenance, which from 50% takes half
  the heavy's full time.

---

## 3. Spacecraft — the maintenance pool (credits)

Credits belong to the guild, not to a system, so the pool is **guild-wide** — no per-system pool,
no per-system reserve.

- **Three player-facing quantities** (the build names the fields; this is their meaning):
  - **budget** — whole credits ≥ 0, set by the player; **default 0**.
  - **pool** — whole credits ≥ 0, the money set aside for maintenance.
  - **spent last cycle** — a readout of what the pool actually paid out over the previous cycle.
- **Refill, once per cycle.** At each **cycle boundary** (1,440 ticks, the same day-anchored
  boundary a commitment cycle uses — `docs/cycle-and-calendar.md`), `min(budget, guild credits)`
  moves from the guild's credits into the pool. **Credits never go negative.** Whatever is unspent
  **carries forward** — no cap.
- **Top-up, any time.** A player action moves any whole amount, 1 … the guild's credits, into the
  pool.
- **No withdrawal.** Once in the pool, credits leave only by paying for maintenance.
- **Drain, every tick.** Every craft **flying this tick** is ordered **lowest condition first, id
  tie-break** (a total order — invariant 9). Each in turn is **covered** if the pool still holds its
  class's rate: the rate is paid and the craft wears at its **maintained** rate this tick. A craft
  the remainder cannot pay for is **skipped** (wears at its unmaintained rate) and a cheaper craft
  after it may still be covered — the same skip-and-continue rule as droid upkeep. An empty pool
  covers nothing: every flying craft wears unmaintained until the next refill or top-up.

| Class | Credits per tick of flight | Per day of continuous flight | One full maintained life |
|---|---|---|---|
| Light | **1** | 1,440 | 161,280 |
| Medium | **2** | 2,880 | 241,920 |
| Heavy | **5** | 7,200 | 403,200 |
| Spycraft | **10** | 14,400 | 201,600 |

- **Where the credits go:** the **Syndicate ledger** — a credit sink like the licence fee. The pool
  is the guild's money held aside, so it **counts in the credit-conservation total** (invariant 2);
  guild credits → pool is an internal move, pool → ledger the one sanctioned transfer.
- **Opt-in.** With the default budget of 0 and an empty pool, every craft wears unmaintained. That
  is the intended start: maintenance is something the player chooses to fund.
- **Omitted when default.** A guild with budget 0, pool 0 and no spend carries **no** pool keys, so
  a galaxy that never touches maintenance hashes byte-identically (§8).
- **The readout (engine-derived; the client computes no number):** pool; budget; **ceiling** = the
  pool cost of every one of the guild's craft flying the whole cycle (Σ rate × 1,440, over all its
  craft); spent last cycle; the next refill tick. Ceiling vs budget vs spent-last-cycle is how a
  player sees over- or under-funding. Per craft: maintained this tick or not; ticks of flight left
  to 0% at the maintained and the unmaintained rate; its deep-maintenance state (§4).

---

## 4. Spacecraft — deep maintenance

### 4.1 Maintenance points

A **maintenance point** is a **system the guild holds** (its home — always — or a system it has
claimed with a Prefecture) or **one of the guild's own Outposts.** Not a toll gate, not a Deep Scan
Array, not a rival's system or Outpost, not a fallow system, not open space.

- A held system has **unlimited** maintenance capacity.
- An Outpost has **5 maintenance slots**, separate from (and not sharing) its 10 dock slots — two
  parts of the same structure. Plus a **queue** (§4.7).

### 4.2 What deep maintenance is

- The craft is **out of action at the point** for a time, then **idle at 100%**. It costs **no
  credits and no goods** — only time.
- **Duration = the class's full time × the fraction missing**, rounded **up** to a whole tick,
  computed in whole wear units: `ceil(missingUnits × fullTicks ÷ CRAFT_WEAR_SCALE)`. Full times:
  **light 720** (12 h) · **medium 720** (12 h) · **heavy 1,440** (24 h) · **spycraft 2,880** (48 h).
  From 0% it takes the full time; from 19% it takes 81% of it.
- On its **ready tick** the craft becomes `idle` at condition 1, at the point, stamped
  `updatedAtTick`.
- A new stored status, **`maintenance`**, joins `idle` / `inTransit` / `loading`. Because every
  dispatch / load / unload path already requires `idle`, a craft in maintenance is locked out — and
  so is its **hold**: the cargo stays aboard, untouchable (no dispatch, load, unload, salvage, kit
  unload, deploy, sale from the hold) until the ready tick. The build adds a tripwire per
  hold-touching action.

### 4.3 At 0% — fly on, stop at the first listed maintenance point

A craft that reaches 0% **keeps flying** its route. It passes any waypoint that is *not* a
maintenance point (a rival's system, a fallow system, a deep-space hex, a toll gate, an array). At
the **first waypoint on its route that is a maintenance point**:

1. that stop's actions run first — load / unload / deploy, including any Outpost dock turnaround;
2. the craft then **enters deep maintenance automatically, whatever it is carrying**;
3. the rest of its route is **dropped** and the craft flagged `laneEnded` with a `maintenance`
   reason (the existing lane-end pattern). A **repeating lane ends** too; the player **redispatches**
   after the ready tick.

Only **listed waypoints** count — flying over a system mid-leg is not stopping there. If the route
holds no maintenance point at all, the craft finishes it and lands idle at 0% wherever it ends. From
there it may be dispatched again — a craft at 0% can fly indefinitely, **so long as it never stops
at a maintenance point** (§4.5).

### 4.4 The one rule that catches every case

**At the end of every tick, any `idle` craft at 0% standing at one of its guild's maintenance points
enters deep maintenance** (or the Outpost queue, §4.7). One sweep covers:

- **arrival** at a maintenance point (after the stop's actions, §4.3);
- a heavy at 0% that **deploys an Outpost** where it stands — the spot becomes the guild's Outpost,
  so the craft goes into maintenance **at the Outpost it just deployed** (it continued its mission
  first; it was not stopped earlier unless an earlier *listed* waypoint was a maintenance point);
- a craft at 0% idle in a system the guild then **plants a Prefecture** in — the system becomes held;
- a craft finishing a dock turnaround (`loading` → `idle`) at its own Outpost at 0%.

Invariant: **no idle craft at 0% sits at its guild's maintenance point outside the queue.**

### 4.5 Dispatching a craft at 0% — the engine rule, mirrored by the route builder

- **Engine:** a craft at 0% may be dispatched (by §4.4 it is never idle at a maintenance point), but
  the route is **refused whole** if **any waypoint before the last** is a maintenance point. It *may*
  end at one — it then enters deep maintenance on arrival.
- **Route builder:** the dispatch quote (`quoteDispatch`) reports this, so the builder stops
  offering stops after the first maintenance point. The client only renders what the quote says.
- A craft **above** 0% has no route restriction; if it reaches 0% mid-route, §4.3 applies at run time.

### 4.6 Going in early

A player action sends an **idle** craft (not `loading`, not queued) into deep maintenance when it is
**at one of its guild's maintenance points** and its condition is **below 20%** (strictly; exactly
20% is refused). At an Outpost with no free maintenance slot it is **refused** — only a craft at 0%
queues. Duration by §4.2.

### 4.7 The Outpost queue

A craft at 0% that reaches an Outpost whose 5 maintenance slots are full **waits** there in a queue —
it cannot fly past (§4.3). It is locked exactly as a craft in maintenance is (status `maintenance`,
hold untouchable), but its clock has not started. When a slot frees, the queue head takes it — **first
in, first served by the tick it queued, id tie-break** — and its ready tick is `that tick + its
duration`. The build chooses the representation and documents it.

### 4.8 When a maintenance point goes away

- **Outpost teardown is refused** while any craft is in maintenance or queued there — the same
  "empty and quiet" gate that already refuses a teardown while a craft is docked or queued
  (`docs/outpost-teardown.md` §1).
- **The operator's `removeOutpost`** (which already turns every craft at the Outpost idle in space)
  also **aborts** deep maintenance there: the craft becomes idle in space, condition unchanged.
- **Losing a system** (eviction) while a craft is in deep maintenance there **aborts** it: the craft
  becomes idle in place, its condition unchanged (deep maintenance credits nothing until the ready
  tick). The system is now fallow — not a maintenance point — so a craft at 0% there may fly on.
  Outposts stand on an eviction, so their bays are unaffected.
- **The home system is never lost** — `evictSystem` halts on a home (code-enforced) — so every guild
  always has at least one reachable maintenance point.
- **The operator's `removeVehicle`** may remove a craft in maintenance or queued; it frees the slot.

### 4.9 Notices

Four new notices (`docs/event-log.md`; names and shapes per its conventions, proposed by the build):
a craft **reached 0%**; a craft **entered deep maintenance** (including entering the queue); a craft
**finished deep maintenance**; the maintenance pool **ran dry** (at most once per guild per cycle).
Fogged from rivals.

---

## 5. Neutral — GP, RP, fuel

Craft maintenance moves **credits only** (guild → pool → Syndicate ledger). Deep maintenance moves
nothing but the craft's own state. Neither moves GP, RP, the mean-line modifier, fuel, a licence or a
fee. The droid retune keeps droids.md §6's neutrality unchanged. A tripwire pins each.

---

## 6. Stricken — design-ahead, parked (storyteller, roadmap 2.7)

**Stricken** is a storyteller lever, not wear: it **freezes a craft in position** (in open space
too) and the craft then needs **rescue**. A rescue can be flown by **any transport class — not a
spycraft**. A craft never becomes stricken by reaching 0%. **Not built in this slice.** Open for
that pass: what a rescue does (tow to a maintenance point? transfer the hold?), whether a stricken
craft wears, and how stricken meets deep maintenance.

---

## 7. Client

All numbers come from the snapshot; the client computes no game number (a "ready in …" countdown is
the published ready tick minus the snapshot tick — the existing countdown pattern).

**7.1 The Maintenance tab** — a new top-level tab **beside Operations** (droids.md §13.3, ruled here).

- **Fleet (top half, guild-wide):**
  - the pool balance; the budget per cycle (editable); a **Top up** control;
  - the three figures: **ceiling** (every craft flying all cycle) · **budget** · **spent last
    cycle**; the next refill;
  - one row per craft: class, where it is, condition %, *maintained* / *wearing fast* right now,
    flight time left to 0%, "in deep maintenance — ready in …" or "queued", and a **Deep
    maintenance** button wherever §4.6 allows it.
- **Droids (bottom half, one block per system with deployed droids):** `droid_components` stock and
  the reserve (editable, §1c); the weekly need; maintained vs wearing fast; runway in weeks; the next
  weekly upkeep. (The `droidUpkeep` readout already publishes most of this.)

**7.2 The craft's Dispatch popup** — its disabled **Maintenance** button becomes the early deep
maintenance action (§4.6), enabled only when the snapshot says it is allowed.

**7.3 The Outpost screen** — its parked **Maintenance Hangar** becomes the 5 slots (who is in each,
ready in …) and the queue.

**7.4 The route builder** — for a craft at 0%, it stops offering waypoints after the first
maintenance point, reading the dispatch quote (§4.5).

**7.5 Operations** — drops the miner / factory condition % (and the deploy picker's); craft cards
keep condition and gain the deep-maintenance state.

---

## 8. Invariants & proof obligations

Follow `design.md` §15.5 / §18; each of these is a tripwire.

- **Range and direction:** craft condition in [0, 1]; non-increasing while flying; unchanged while
  not flying except the ready tick (→ 1).
- **Exact leg wear** (§2): a flight of L ticks wears exactly L ticks at the per-tick rates.
- **Deep maintenance shape:** a craft in `maintenance` stands at a valid maintenance point of its own
  guild, has no trip and no route, and has a ready tick or is queued; at most 5 slotted per Outpost.
- **No idle 0% craft at its own maintenance point** outside the queue (§4.4).
- **Pool:** budget and pool whole and ≥ 0; each tick the pool falls by exactly Σ the covered craft's
  rates; the refill never takes credits below 0; credit conservation (invariant 2) holds with the
  pool counted.
- **Determinism (invariant 9):** the drain order is total (condition, then id); the queue order is
  total (queued tick, then id).
- **GP-neutral** (§5).
- **No-op, byte-identical:** a galaxy where no craft flies and no pool exists (budget 0, pool 0)
  hashes exactly as before, across a cycle boundary. The droid retune and the asset-condition
  removal are *deliberate* changes; each proves exactly what moved and nothing else.
- **Droids:** droids.md §9 / §10 still hold at the new numbers.
- **Assets:** no asset carries `maintenanceCondition` after the removal; a save that still has the
  field restores cleanly (the field dropped on load).

---

## 9. Failure modes hunted on paper (survival rule 7)

- **Budget larger than the guild's credits** at the boundary → the refill takes what is there;
  credits never negative.
- **A craft at 0% with no maintenance point on its route** → finishes, lands idle at 0%; may fly on
  indefinitely so long as it never stops at a point (§4.3 / §4.5).
- **A stale client** submits a route carrying a 0% craft past a point → the engine refuses it whole
  (§4.5); the client is never trusted to enforce it.
- **A full Outpost** → the craft at 0% queues; an early request is refused (§4.6 / §4.7).
- **Teardown with a craft in the bay** → refused (§4.8).
- **Losing the system mid-maintenance** → aborted, condition unchanged (§4.8).
- **Deploying an Outpost / planting a Prefecture at 0%** → the sweep sends the craft into
  maintenance there (§4.4).
- **A repeating lane** → ends at the maintenance stop; redispatch (§4.3).
- **Exactly 20%** → early maintenance refused (strictly below).
- **A heavy with an asset or kit aboard** → the hold is locked for the duration; the asset stays
  "in transit" (derived from the manifest) until the craft is out and unloads.
- **An operator spawn at condition 0 at a maintenance point** → the sweep sends it into maintenance
  at the end of that tick (expected, not a bug).
- **Bots** → their budget is 0, so their craft wear unmaintained; bot maintenance behaviour is a 2.7
  question.
- **A droid deployed before the retune** → keeps its condition fraction; units rescale exactly (§1b).

---

## 10. The numbers → `docs/phase-1-tuning.md` §"Maintenance"

All `[FIRST-CUT]`, ruled by the human 09-11-26: droid lives and the ×4 / ×2 multipliers; droid upkeep
1 / droid-week for both sources; the four craft lives and the ×2 maintained multiplier; the craft
rates 1 / 2 / 5 / 10 credits per tick of flight; the full deep-maintenance times 720 / 720 / 1,440 /
2,880 ticks; the early threshold 20%; the 5 Outpost maintenance slots; the default budget 0; the
droid reserve default 0 (unchanged). Derived, not tuned: `DROID_WEAR_SCALE` 161,280 and
`CRAFT_WEAR_SCALE` 483,840.

---

## 11. Build order (vertical slices — one at a time, each its own PR)

1. **Droid retune** (engine + snapshot): the new lives, one upkeep rate, the reserve setter action.
   *(⤳ **BUILT 09-11-26** — §1's AS-BUILT note.)*
2. **Remove asset condition** (engine + snapshot + client): `Asset.maintenanceCondition` gone from
   `createAsset`, the eviction sweep's re-mint, the operator levers, the invariants, the snapshot and
   the client; old saves restore with the field dropped.
   *(⤳ **BUILT 10-11-26.** The field is gone from `createAsset` and so from every mint, the sweep's
   re-mint included; the snapshot's asset rows and the client's deploy pickers / asset row drop it; the
   invariant `asset-condition-in-range` became the tripwire `asset-has-no-condition`; `sim/persist.js`
   `dropRetiredAssetCondition` drops the key from an old save on load, before the replay. `ASSET_CONDITION_*`
   kept by name as the droid / vehicle scale. Riding along (ruled 10-11-26): losing a system now also
   clears the guild's `droidComponentReserve` for it (`evictSystem` step 2c, `docs/droids.md` §14). The
   goldens that moved are re-pinned with a "main's end state, minus every asset's condition" proof at each.
   Tests: `sim/tests/maintenance-asset-condition.test.js`.)*
3. **Craft wear + the pool** (engine + snapshot): wear in flight, the per-tick drain and triage,
   the cycle refill, budget and top-up actions, the readout, the pool-ran-dry notice.
4. **Deep maintenance** (engine + snapshot): the `maintenance` status, the maintenance points, the
   0% stop rule + the sweep, the dispatch refusal + quote, early maintenance, Outpost slots + queue,
   teardown refusal, eviction abort, the three craft notices.
5. **The Maintenance tab** (client).
6. **The Dispatch popup button, the Outpost Maintenance Hangar, the route-builder limit** (client).
