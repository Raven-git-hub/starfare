# The event log & MESSAGES notices — the discrete-event record

*Status: **RULED** (the message-delivery ruling), authoritative for the **discrete-event**
half of `docs/design.md` §5 "Message delivery — standing conditions vs discrete events". It
rules the append-only per-guild event log, its writers, acknowledgement, and time-based
retention — the seam §5 named ("append-only, per guild, `{tick, type, payload}`") and left for
its first real writer. The **standing-condition** half — the renegotiation offer / `attention`
derive — is `docs/renegotiation.md`'s and is unaffected.*

> **Provenance note (this build).** This file was **authored in the ENGINE-slice build that
> implemented it**, from the human's build prompt, because the repo did not yet carry the
> ruling doc the slice was told to read — the ruling existed only in the prompt. It records
> exactly what that prompt ruled, invents nothing beyond it, and is flagged on the roadmap
> decision checklist for the human to confirm it matches intent. If it and the prompt ever
> disagree, the human's word wins (CLAUDE.md / §0).

*It **invents no tuning number.** The two retention constants (§4) are the ruled display-life
figures given with the slice; the ids are a per-guild counter, not a tuning value. No
`[FIRST-CUT]`, no new `phase-1-tuning.md` row (retention is display-life, §4).*

## 0. Frame — standing condition vs discrete event

Design.md §5 draws the line the whole delivery model rests on:

- A **standing condition** is *true right now* and re-derivable from state every tick ("this
  venture's window has elapsed; here are the terms"). It is never pushed, stored, or lost — log
  in a week later and it is simply recomputed. The renegotiation offer is purely one of these
  (the derived `renegotiationOffer` / `attention.renegotiations`).
- A **discrete event** *happened at a tick* and cannot be re-derived — a licence lapsed, a
  venture was closed. These need a **recorded event log**.

This document rules that log. The surface is the Guild Hall's MESSAGES panel: it renders a
**union** of the derived open action-items (renegotiation offers, pinned to the top) and the
event-log **notices** below, newest first. The ENGINE half of the notices — the log, the
writers, acknowledgement, retention, and the snapshot surfacing — shipped first (see the
roadmap). The **client Notices panel** that renders them shipped next (§8) and is being **redesigned** into an email-style inbox + per-type popup (§9).

## 1. The log — append-only, per guild

Each guild carries an append-only log of notice rows on `Guild.events`, with a per-guild
monotonic id counter `Guild.eventSeq`. Both are **engine-owned** (only the writers below
mutate them, bar the `readTick` an acknowledge stamps), and both are **created lazily / omitted
when empty** — a guild that has recorded no notice carries neither key, so its serialized state
is byte-identical to pre-slice and every determinism golden that never lapses/closes/tears-down
is unmoved (invariant 9). The shape lives in one module, `sim/events.js`, the way
`sim/resources.js` owns the goods vocabulary.

A row is `{ id, tick, type, payload }` — plus a `readTick` once acknowledged (§3). `id` is the
next `eventSeq` value (a **stable, unique id**, §15.2 — never reused, per-guild). `tick` is the
tick the event happened on (retention and the client's "when" both read it). `payload` is
**self-contained**: it carries what the notice needs to render even after the venture it names
is gone (§2).

## 2. The two types & the four writers

The type vocabulary this slice writes is exactly two, in `sim/events.js` (a third, `deploy_failed`, is written by the 2.2 deploy pipeline's retreat — §10, engine and client halves BUILT; a fourth and fifth, `delivery_space_warning` and `delivery_turned_back`, are written by a Syndicate BUY to an Outpost — §11, engine and client halves BUILT; a sixth, `outpost_packed`, is written by an Outpost reclaim — §12, engine and client halves BUILT; a seventh and eighth, `scan_complete` and `scan_voided`, are written by a Deep Scan Array finishing its job — §13, engine and client halves BUILT; a ninth, `system_lost`, is written by an eviction when a Prefecture is destroyed — §14, engine half BUILT, client not yet):

- **`licence_lapsed`** — an ordinary licence lapsed back to unlicensed.
- **`venture_closed`** — a venture was removed.

They are written by the **two shared licence removers** (`sim/licence.js`), so a chosen and an
automatic outcome cannot diverge on what they record — the same single-source discipline the
mutation itself already runs under:

- **`applyLapse`** writes `licence_lapsed`, from **four causes** across its callers:
  - the `lapseLicence` action (a player REJECT) → cause **`rejected`**;
  - the auto-lapse tick step (the acceptance window timed out) → cause **`timeout`**.
- **`applyVentureClosure`** writes `venture_closed`, from its callers:
  - the `decommissionVenture` action (a player teardown) → cause **`teardown`**;
  - the −500 forced-closure tick path (`docs/forced-closure.md`) → cause **`forced`**;
  - *(⤳ 17-10-26, losing ground engine PR 1)* the eviction (`sim/eviction.js`, §14) — a venture torn down because its
    guild lost the system → cause **`evicted`**. (The operator's `removeVenture` / `removeAsset` lever also calls it,
    cause **`operator`**, `docs/operator-adjust.md`.)

**Renegotiation ACCEPT (`renegotiateLicence`) writes nothing** — an accept is a re-lock, not a
discrete loss. All notices are **born unread** (no `readTick`).

The **payload** is built by the writer, before it forfeits/removes, and is self-contained:

- `cause` — which of the four above.
- `ventureId` + `ventureName` — the venture's id and its **SEED site name** (the same string the
  renegotiation attention entry carries), falling back to the raw `siteId` then the id. Carried
  because the venture may be gone (closure) or unlicensed (lapse) by the time the client reads it.
- `good` — the venture's committed good (`producedGoodFor`).
- `ventureType` — the venture's kind, `v.type` (`'mining'` / `'refining'`), captured at write
  time because the venture is gone/unlicensed by the time the client renders the notice. The
  redesigned popup (§9) builds its title `prettyGood(good) + " Mine"/" Refinery"` from it —
  `ventureName` alone is a *location*, not a kind. A captured entity field, not a tuning number.
- `systemId` — the venture's system.
- `lockoutUntilTick` — **`venture_closed` only, and only when a node lockout was written** (an
  ordinary-licensed venture closed with contract time left, `docs/venture-teardown.md` §3.3).
  Read off the same `teardownSettlement` that writes the lockout, so the notice and the lockout
  cannot disagree.

## 3. Acknowledgement

`acknowledgeEvent { guildId, eventId }` marks one notice **read**. It validates only that the
guild exists; the apply sets that row's `readTick = state.tick` **iff** the id is found and
still unread. A **missing id is a valid no-op** — a notice can age out (retention) between the
tick the client rendered it and the tick the player clicks, and the acknowledge for a
since-pruned notice must not fail. Acknowledging twice is idempotent (it does not re-stamp, so
it never resets the read clock). It is **player-set display state**: the tick never reads
`readTick` to compute a game number, so invariant 8 is untouched — no reputation, credits or
goods move.

## 4. Retention — time-based, keyed on read/unread

Notices are **display state**, not a ledger, so they expire. The shared predicate is
`isEventLive(event, currentTick)` (`sim/events.js`), read by **both** the write-time prune
(`recordEvent` sheds aged rows whenever it appends) **and** the snapshot's read-time filter, so
what the log keeps and what the panel shows can never disagree:

- **unread** (`readTick` absent) ⇒ live while `currentTick − event.tick ≤ RETENTION_UNREAD_TICKS`;
- **read** ⇒ live while `currentTick − event.readTick ≤ RETENTION_READ_TICKS`.

So reading a notice *shortens* its life — "seen it, let it go".

- **`RETENTION_UNREAD_TICKS = 14400`** — **10 real days** at the ruled cadence (1 tick = 1 minute,
  §5): an unread notice lingers long enough that a player logging in weekly still sees what
  happened.
- **`RETENTION_READ_TICKS = 2880`** — **2 real days** once acknowledged.

These are **display-retention**, not economy tuning — they feed no rate, price or commitment — so
they live in `sim/events.js` with that rationale, **not** in `phase-1-tuning.md`, and are not a
`[FIRST-CUT]` economy number.

## 5. Surfacing (engine → snapshot, read-only)

The snapshot publishes each guild's **live-filtered, newest-first** events on the guild row
(`guilds[].events`) — engine-owned state surfaced read-only, the `productionHistory → history`
pattern — and extends `computeAttention` with **`attention.notices`**, the guild's **unread**
live notices, beside `attention.renegotiations` (the join the renegotiation slice left room for).
Both are **derived on read**: no serialized byte beyond `Guild.events` / `Guild.eventSeq`
themselves, no determinism hash, invariant 9 holds.

Each surfaced `guilds[].events` row also carries two **derived calendar days** (the redesign,
§9) beside the copied `{ ...e, payload: cloneEventPayload(e.payload) }` — computed on read over the galaxy's
`windowN` / `dayAnchorTick`, exactly as the renegotiation countdown's `daysToLapse` is:

- **`whenDay`** — `dayOf(e.tick, …)`, the calendar day the notice was written (the popup's
  "Closed" / "Lapsed" date and the inbox row's "when"). On every surfaced row.
- **`unlockDay`** — `dayOf(e.payload.lockoutUntilTick, …)`, the calendar day a node frees, **only
  on a `venture_closed` carrying a `lockoutUntilTick`**; absent on a lapse or an unlicensed
  teardown, which hold no node. These are derived-on-read too — no stored byte, invariant 9
  holds — and `attention.notices` is **unchanged** (it is the unread badge count; the day fields
  ride `guilds[].events`).

## 6. Invariant

`checkEventLog` (`sim/invariants.js`, in `checkInvariants`): when `Guild.events` is present it is
an array; each row has an **id unique within the guild**, an integer **`tick ≥ 0`**, a **`type`
from the vocabulary**, and **`readTick` (if present) an integer `≥ tick`**. The id-uniqueness
row is the tripwire that proves `eventSeq` is doing its job — an acknowledge addresses a notice
by id, so a collision would let one ack hit two.

## 7. Out of scope (the ENGINE slice)

- **No client work** — no Notices rendering, no ACKNOWLEDGE button. That was the following
  slice, now built (§8; mockup `docs/mockups/guild-hall-messages.html`).
- **No storyteller / rival / disaster writers** — future; they add their own types here.
- The `messagesSeenTick` per-guild "unread" flag design.md §5 sketched is **superseded** by the
  per-notice `readTick` and is deliberately **not** added.

## 8. The client Notices panel (the CLIENT slice) — AS BUILT (the §9 redesign)

> **History.** The FIRST client slice rendered inline notice rows with an inline ACKNOWLEDGE
> button. §9 ruled the email-style inbox + per-type popup that replaced it, and this section
> now records **that redesign AS BUILT** — the inline-row version is gone from the client.

The Guild Hall MESSAGES panel (`client/game.html`) is an **email-style inbox**: every row — the
pinned action-items **and** the notices below — is a **clickable subject line**, and the full
detail opens in a **popup** (`docs/mockups/guild-hall-messages.html`). **Client only** — no engine
/ snapshot / `sim/` runtime change; it renders the published rows and dispatches exactly one action
(`acknowledgeEvent`).

- **The inbox rows** are subject lines only (an offer's icon + one-line title + a "when"/status in `.meta`),
  no inline detail. The **offers** keep their standing chip and their engine-derived acceptance
  countdown (`deadlineLabel` off `daysToLapse`) and still open the reneg popup on click. The
  **notices** are the player guild's `guilds[].events` (read + unread) in the snapshot's own
  newest-first order (§5); an unread notice (no `readTick`, §3) shows the amber unread dot, a read
  one is dimmed. "No notices yet." shows only on an empty log.
- **The notice title** (row and popup) is built from real fields:
  `prettyGood(payload.good) + " " + ({ mining:'Mine', refining:'Refinery' }[payload.ventureType] ||
  'Venture')`, prefixed by type — "Venture closed — Gold Mine" / "Licence lapsed — Copper Mine" —
  and degrades gracefully if `good` / `ventureType` is null. The row's **"when"** is the engine's
  `whenDay` ("Day N") — the published field, rendered verbatim; the client computes no game number.
- **The notice popup** is a NEW overlay (`#notice-overlay`) mirroring `#reneg-overlay`'s
  adviser-reel card, with its own single opener (`window.__openNotice(eventId)`, the
  `window.__openRenegotiation` pattern): the eyebrow "Syndicate Notice", the title (above), one
  **static** body line per `type` + `payload.cause` (the four writers, §2, one plain Syndicate tone
  — the domain-character voices stay parked, §5), a **facts** block (`Location` = `payload.ventureName`;
  `Closed` / `Lapsed` = `whenDay`; and, **only when `payload.lockoutUntilTick` is present**, `Node
  held until` = `unlockDay`), a single **Dismiss** (close), and the **uniform** guild-adviser
  portrait `assets/characters/advisor.jpg` — no per-type art accent (§9). The node-held **body
  sentence** is likewise appended only when `lockoutUntilTick` is present, so a lapse or an
  unlicensed teardown never claims a held node. (Design note: the precise unlock day rides the
  facts block only; the body sentence stays static — no game number is typed twice, honouring the
  mockup's FIELD → SOURCE contract, which maps only `Facts · Node held until` to `unlockDay`.) A `deploy_failed`
  notice is one exception to the uniform adviser: it re-dresses this same card with the pilot (§10, client
  AS-BUILT). The two delivery notices are the other: they wear the Trader (§11, client AS-BUILT).
- **Read = opening the message.** Clicking a notice row opens its popup (filled from that row in
  `meGuild().events` by its id) and dispatches the existing `acknowledgeEvent { guildId, eventId }`
  for its id (sent as a Number — the apply matches by `===`), so the row renders read on the next
  poll. There is **no inline ACKNOWLEDGE button**. The engine no-ops an aged-out id (§3), and a
  reopened (already-read) notice re-dispatches nothing (read-on-open fires only while unread).
- **The pip + badge** (the top-level Guild Hall tab and the Messages rail entry) light while any
  offer is open **or** any notice is unread (design.md §5), the count adding the player's own
  `attention.notices` to the open offers — **unchanged** by the redesign.

## 9. The Notices surface, redesigned — an email-style inbox + per-type popup

*Status: **RULED + BUILT** 10-09-26. Supersedes §8's inline notice rows. Built in two slices, both
now shipped — the **engine field-slice** (the three additive fields below) is **BUILT** (the three
fields ship, §2 and §5 folded in above), and the **client slice** (the inbox + per-type popup) is
**BUILT** (the AS-BUILT record is §8, rewritten for the redesign). Each moved doc + code together.
Visual contract: `docs/mockups/guild-hall-messages.html`.*

The MESSAGES panel becomes an **email inbox**. Every row — the pinned action-items **and** the
notices below — is a **clickable subject line**: an icon (an offer only), a one-line title, a "when" (or, for an
offer, its status/countdown), and, for an unread notice, the amber unread dot. The full detail no
longer renders inline; clicking a row opens a **popup**. This replaces §8's fat notice rows
(inline title + detail + inline ACKNOWLEDGE).

**Read = opening the message.** Opening a notice's popup dispatches `acknowledgeEvent` for its id,
so the row renders read on the next poll (dimmed, dot gone). This **supersedes the earlier
"read = the player clicks ACKNOWLEDGE" trigger** — the engine action (§3) is **unchanged**; only
the client's *trigger* moves from a button to the open. A notice popup therefore carries **no
ACKNOWLEDGE button**, only a single **Dismiss** (close). An action-item popup is unchanged — its
Accept / Reject resolve the offer as before.

**The popup wears the adviser-reel card** — the two-column hero card of `client/game.html`'s
`#reneg-overlay` (eyebrow, serif title, body, footer). Its hero panel is the **guild-adviser
portrait** (`assets/characters/advisor.jpg`), **uniform across every Syndicate notice type** (the fleet / ops lane carries its own character — §10 — and so does the trade lane — §11): a
Syndicate-specific portrait is the parked domain-character-advisers decision (§5), and no per-type
art accent is used — one calm Syndicate tone.

**Per-type popup content — every value is read from the surfaced event; the client types none and
computes no game number (§18):**

- **Title** — `Venture closed — {label}` / `Licence lapsed — {label}`, where `{label}` is
  `prettyGood(payload.good)` + the venture kind word (`mining → "Mine"`, `refining → "Refinery"`).
  This is why the payload must carry the kind (below): `ventureName` alone is a *location*, not a
  "{Good} Mine" name.
- **Body** — one static line per `type` + `payload.cause` (the four writers, §2), one plain
  Syndicate tone. The **node-held sentence appears only when `payload.lockoutUntilTick` is
  present** — a forced closure always writes a lockout, an *unlicensed* teardown never does, so the
  popup must not claim a held node where none is held.
- **Facts block** — `Location` = `payload.ventureName` (the seed site name, e.g.
  "Kessic Reach IV · Node 3"); the event day (`Closed` / `Lapsed`) = the new `whenDay`; and, for a
  closure carrying a lockout, `Node held until` = the new `unlockDay`.

**The three additive engine fields this needs** — **BUILT** (the engine field-slice; all additive,
every determinism golden byte-identical, invariant 9 holds):

1. **`payload.ventureType`** — the live venture's `v.type` (`'mining'` / `'refining'`), captured by
   `applyLapse` / `applyVentureClosure` **at write time** (the venture is gone by render), recorded
   in the self-contained payload beside `good` (§2). A captured entity field, not a tuning number.
2. **`event.whenDay`** — a snapshot derive on each surfaced event: `dayOf(event.tick, windowN,
   dayAnchorTick)`, the calendar day the notice was written. Derived on read (the `daysToLapse`
   precedent), no stored byte.
3. **`event.unlockDay`** — a snapshot derive on a `venture_closed` event **that carries a
   `lockoutUntilTick`**: `dayOf(lockoutUntilTick, …)`, the calendar day its node frees. Absent
   otherwise.

Both day fields exist **because the client computes no game number** (§18): a past tick's calendar
day is a derived figure, so — exactly as the renegotiation countdown's `daysToLapse` is — the
engine derives it and the client renders it verbatim.

**The inbox structure and the attention signals are otherwise §8's:** the two sections stay
(design.md §5's union — action-items pinned on top, notices below, newest-first); the top-level
Guild Hall pip and the Messages badge light while any offer is open **or** any notice is unread,
counting the player's own `attention.notices` beside the open offers.

## 10. The `deploy_failed` notice — the fleet / ops lane (2.2 deploy pipeline, RULED 01-10-26)

*Status: **RULED + BUILT.** The **ENGINE half is BUILT** (01-10-26 — the type, the write and the payload) and the
**CLIENT half is BUILT** (01-10-26 — the inbox row, the pilot popup, Show on map); both AS-BUILT records are at the end
of this section. *(⤳ 02-10-26: Show on map is REPLACED by the decision the pilot asks for, the two forks **Redeploy**
and **Return** (`territory-model.md` §5 REVISED); "AS-BUILT — the two forks", the last record below.)* A THIRD event type, written by the deploy pipeline, and the first notice that carries a
**domain character** rather than the uniform Syndicate voice (§9): the parked domain-character advisers
(§5), **un-parked for the fleet / ops lane**. Syndicate ENFORCEMENT notices (`venture_closed` /
`licence_lapsed`) stay uniform; a fleet / ops notice wears its character. Visual contract:
`docs/mockups/guild-hall-messages.html` (the `deploy_failed` entry).*

**The type.** `deploy_failed` — a hauled kit’s on-arrival deploy could not be placed, so the craft
RETREATED (`territory-model.md` §5, the retreat rule). Added to the `sim/events.js` vocabulary (so
`checkEventLog` accepts it); it is exactly the "future writer adds its own type" §7 left room for.

**The writer — the retreat itself.** `resolveDeployArrival` (`sim/actions.js`) is the ONE place a deploy
retreats *(⤳ 16-10-26: the retreat, the flag and this write moved, unchanged, into `retreatKitCraft`, the ONE kit retreat,
which a Prefecture kit's failed unload also calls — `docs/territory-model.md` §4's AS-BUILT note)*; where it already flags the craft `deployFailed = { reason, tick }` (§5), it also records a
`deploy_failed` row through the same shared `recordEvent` the licence removers use (prune + append). One
writer, so the craft flag and the message cannot disagree. Born unread; retention and acknowledge are
§3 / §4’s, unchanged.

**The payload** (self-contained, built at the retreat — all of it already in hand there):
- `cause` — `'occupied'` | `'out-of-range'` | `'not-attached'` (the retreatable reasons; the §5 `deployFailed`
  reason). *(⤳ `'not-attached'` added 06-10-26, roadmap 2.5 (b1): a Deep Scan Array whose attachment to held
  territory was lost in flight. The client's Reason fact has no label for it yet — it reads "—" — client slice.)*
  *(⤳ 15-10-26, roadmap 2.5 slice 14b: labelled **"Not attached"**.)* *(⤳ 15-10-26, slice 15: and
  `'rival-territory'` — the array's target became a rival's control in flight — labelled **"Rival territory"**.)*
  *(⤳ 16-10-26, the Prefecture / claims slice, engine PR 1: and `'system-claimed'` — a Prefecture kit's unload target, an
  unclaimed system, was claimed by a rival in flight. Engine only: the client has no label for it yet (it reads "—"), and
  `sim/tests/deploy-failed-notice-client.test.js` pins that as awaited by the client PR.)* *(⤳ 16-10-26, client PR B1,
  which lets a player ferry a Prefecture kit: labelled **"System claimed"**; the title reads "Deployment Failed —
  Prefecture".)*
- `kind` — the deployable kind, `'outpost'` or (2.5 (b1)) `'deepScan'` — or (16-10-26) `'prefecture'`, for an unload
  that retreated.
- `targetHex` — `{ q, r }`, the hex the deploy could not be placed on.
- `craftId` + `craftClass` — the transport (the facts line, and the lookup for Show on map). *(⤳ Now the forks'
  lookup: Show on map is replaced, below.)*
- `retreatSystemId` + `retreatSystemName` — the nearest held system it pulled back toward (its seed name).

**The surface — the MESSAGES inbox + popup (§8 / §9), but with its OWN character.** The inbox row
reads **"Deployment failed — {Kind}"** ({Kind} from `payload.kind`) *(⤳ RULED 15-10-26, built slice 15: **"Deployment
Failed — {Structure}"**, title case — "Deployment Failed — Deep Scan Array" / "Deployment Failed — Outpost")*, newest-first, with the unread dot as
any notice. The popup is the same adviser-reel card, re-dressed for this type:
- **the hero is the PILOT** (`client/assets/characters/pilot.jpg`), not the uniform adviser;
- **the eyebrow is "Fleet — Dispatch"** (not "Syndicate Notice" / "Syndicate — Enforcement");
- **the body is the pilot’s voice** — a dry, disgruntled report that pushes the Guildmaster for a
  decision, rendered verbatim as two beats:

  > Right, so, we flew the asset out here where you wanted and... well... long story short, it’s going to
  > need to go somewhere else. I pulled back to a safe spot for now.
  >
  > I hate to pester you like this, Guildmaster, but we can’t float around out here forever. We need a
  > decision from you.

- **the facts block**: `Craft` = `craftClass · NN`; `Target` = `hex {q}, {r}`; `Reason` = Hex taken /
  Out of range (from `cause`); `Pulled back to` = `retreatSystemName`; `Failed` = the event `whenDay`. *(⤳ 15-10-26,
  slice 14b: `Reason` = Not attached for `'not-attached'`; and the title's {Kind} is the STRUCTURE's player name from
  the client's kit-kinds table — "Outpost", "Deep Scan Array" — where it printed the raw kind for the array.)*
- **a SHOW ON MAP button** beside Dismiss: closes the popup and flies the map to the **craft’s CURRENT
  hex**, looked up live by `craftId` in the snapshot. A retreated craft sits on its hex INDEFINITELY until
  the player acts on it, so "current" is reliable; if the craft is gone, fall back to `payload.targetHex`.
  *(⤳ SUPERSEDED 02-10-26 by `territory-model.md` §5 REVISED ("Failed deploy — resolved from the message, two forks"):
  the map button is replaced by **Redeploy** and **Return**, which open the planner centred on the craft, so a
  standalone Show on map is subsumed. BUILT, "AS-BUILT — the two forks" below.)*

Opening the message acknowledges it (§8, read-on-open), unchanged. This **replaces** the earlier idea of
an Operations · In-Transit strip notice — the message is the surface.

**AS-BUILT — the engine half (01-10-26; engine only, NO client).** Built to this section, no design change.
`DEPLOY_FAILED = 'deploy_failed'` joins `EVENT_TYPES` in `sim/events.js`, so `checkEventLog` accepts it; the log,
`recordEvent`, retention and acknowledge are untouched and the type rides all of them. The writer is the retreat
branch of `resolveDeployArrival` (`sim/actions.js`): after it snaps the craft and sets `deployFailed` (unchanged), it
records one row through `recordEvent` on the same guild at the same tick (the arrival tick). The payload is built
there: `cause` is the flag's reason; `kind` is the deploy waypoint's `action.kind` (the route is still on the craft
at that point); `targetHex` is a fresh `{ q, r }` copy of the craft's location before the snap (deployCheck has
just proved it a bare hex); `craftId` / `craftClass` are the craft's `id` / `class`; `retreatSystemId` is
`nearestHeldSystem` asked with the same arguments `retreatLanding` uses on the next line, so it names the system the
craft is pulled toward; `retreatSystemName` is that system's seed name, falling back to its id (the `ventureName`
pattern). **No snapshot field:** `guilds[].events` surfaces the row with `whenDay` (no `unlockDay`, no node is
held) and `attention.notices` counts it while unread. **One copy fix:** this is the first payload with a nested
object (`targetHex`), so the one-level `{ ...e.payload }` copies in `createState` and the snapshot would have shared
it with engine state. All three copy sites now go through `cloneEventPayload` (`sim/events.js`, a `structuredClone`
of the payload). The output is byte-identical. Not built: the client surface above (the inbox row "Deployment
failed — {Kind}", the pilot popup, the facts block, Show on map). Until it lands, the current client's notice
renderer treats any type that is not `venture_closed` as a licence lapse, so a `deploy_failed` row would read as
"Licence lapsed — Venture". *⤳ Closed by the client half, next.*

**AS-BUILT — the client half (01-10-26; `client/game.html` only, NO `sim/` change).** Built to this section, no
design change, as a small addition to §8's notice code. `venture_closed` / `licence_lapsed` are untouched: their
popup card is pixel-identical before and after.
- **The row.** `noticeTitle` / `noticeRowTitle` gain a `deploy_failed` branch: "Deployment failed — {Kind}", where
  `{Kind}` is `prettyGood(payload.kind)` ("Outpost"; a missing kind reads "Kit", the engine's word for what was
  hauled). The row has no icon: notice rows dropped the illustrative `NOTICE_ICON` (⚖ / 🔒 / 🚀) on 02-10-26.
  Newest-first order, the unread dot and read dimming are §8's, unchanged.
- **The popup.** `openNotice` re-dresses the shared `#notice-overlay` card on EVERY open. For a `deploy_failed` it
  sets the eyebrow (`#noticeEyebrow`) to "Fleet — Dispatch", the hero (`#noticeArt`) to
  `assets/characters/pilot.jpg`, and shows SHOW ON MAP (`#noticeShowMap`) beside Dismiss. Any other notice is set
  back to "Syndicate Notice", `advisor.jpg` and no SHOW ON MAP, so the shared card never keeps the pilot. The body
  is this section's two beats verbatim (`DEPLOY_FAILED_BODY`), one `<p>` per beat; `#noticeBody` is now a container
  of paragraphs, and a Syndicate notice's one line is one `<p>` with the same layout. The facts
  (`deployFailedFacts`), in order: `Craft` = `prettyClass(craftClass)` + " · #" + the number `craftId` ends on — the
  name the Dispatch popup gives the same craft ("Heavy Transport · #01"; this section writes `craftClass · NN`, so
  the `#` is flagged on the roadmap decision checklist); `Target` = `hex {q}, {r}`; `Reason` = Hex taken / Out of
  range; `Pulled back to` = `retreatSystemName`; `Failed` = `whenDay`.
- **Show on map** (`showNoticeOnMap`) closes the popup and finds the live craft by `payload.craftId` on the player's
  guild row. It resolves the craft's hex through the Dispatch popup's own `coordsOf`, now shared as
  `window.__craftCoords` (a bare hex, or the system a clamped retreat parked it at), and `__flyTo`s it at zoom 9,
  the Dispatch popup's Show on map zoom (`__flyTo` closes the Guild Hall itself). A craft that is gone — or flying
  again, so it has no hex — falls back to `payload.targetHex` (the flying case is flagged on the checklist).
  *(⤳ RETIRED 02-10-26 with `window.__craftCoords`: the two forks replace it, next.)*
- **Read-on-open** is §8's, unchanged: opening dispatches `acknowledgeEvent` by id while unread.
- **One layout fix.** The pilot's two beats + five facts are about 60px taller than the card's fixed
  `min(80vh, 600px)`. The card's text column could not shrink below its content, so the footer and its buttons
  were clipped off the card. `#notice-overlay .reel-text` gains `min-height:0`: `.reel-body` now scrolls, as its
  `overflow-y:auto` intends, and the footer stays on the card. The last fact (`Failed`) sits just below the fold.
  A notice that fits is unaffected (measured identical). Whether this card should be taller instead is on the
  decision checklist.

**AS-BUILT — the two forks (02-10-26; `client/game.html` only, NO `sim/` change; roadmap 2.2 deploy pipeline,
asset-initiated client slice 3b).** Built to `territory-model.md` §5 REVISED, which replaces this section's Show on map.
The full record, the planner's unload mode included, is "AS-BUILT — asset-initiated client slice 3b" there. Here, only
what the notice itself does:
- **The buttons.** `#noticeShowMap` is replaced by `#noticeRedeploy` and `#noticeReturn`, beside Dismiss and in the same
  `btn accept` style. `openNotice` shows both for a `deploy_failed` and hides both for any other notice, on every open,
  as it did Show on map. A `venture_closed` notice still shows Dismiss alone under "Syndicate Notice" (checked in the
  live client).
- **What a fork does.** It finds the live craft by `payload.craftId`, as Show on map did, and acts only while that craft
  is still idle, off any route, with the kit of `payload.kind` aboard. Then it closes the popup and opens the planner for
  that craft (`__flyTo` closes the Guild Hall itself). Redeploy opens the deploy map, Return the planner's unload mode;
  both commit in the craft's own Dispatch popup. *(⤳ 16-10-26, the Prefecture / claims client PR B1: a GROUND kit — a
  retreated Prefecture kit, `kind: 'prefecture'` — is never deployed on a hex, so its notice shows **Return alone**;
  Redeploy, which would open the deploy map, stays hidden, and the deploy fork plans the unload even if asked. Its
  Return's unload mode reads the kind off the kit aboard and, as the engine allows a Prefecture kit, also accepts an
  unclaimed system — `territory-model.md` §4, "AS-BUILT — client PR B1"; the wording is on the decision checklist.)*
- **Nothing to act on.** A craft that has moved on (a fork already taken, flying again, moved by an operator) opens
  nothing. The footer's empty note slot, now `#noticeNote`, reads "Nothing left to resolve." `openNotice` clears it on
  every open.
- **Read-on-open** is §8's, unchanged. The notice stays in the inbox after a fork, like any read notice.
- **The card fit** is as before: the footer now holds three buttons and still fits the card, and the last fact
  (`Failed`) still sits just below the fold.

## 11. The delivery notices — `delivery_space_warning` and `delivery_turned_back` (2.2 trading to/from outposts)

*Status: **RULED** by `syndicate-orders.md` §9.1 / §9.4 (REVISED 04-10-26: warn, don't block; all-or-nothing on
arrival). The **ENGINE half is BUILT** (04-10-26, trading to/from outposts slice 1b): the two types, the two writes and
their payloads. The **CLIENT half is BUILT** (04-10-26, trading to/from outposts, the last client rung): the inbox rows,
the popup and the Trader's voice — "AS-BUILT — the client half", the last record below.
Modelled on §10: a writer that already holds everything the notice needs records one self-contained row through the
shared `recordEvent`; retention, acknowledge and surfacing are §3–§5's, unchanged.*

**Why two notices.** A Syndicate BUY to an Outpost is never refused for want of room (§9.1): the Syndicate takes the
payment and ships, and the Outpost's free space is judged only when the delivery lands, all or nothing (§9.4). The
player needs to hear about that twice — when a buy leaves for an Outpost that cannot hold it now, so they can clear
room in time, and when a delivery is lost.

**The types.** Both join `EVENT_TYPES` in `sim/events.js`, so `checkEventLog` accepts them:
- **`delivery_space_warning`** — a BUY left for an Outpost whose free space at that moment is less than the order needs.
- **`delivery_turned_back`** — a delivery to an Outpost was lost on arrival: no room for the whole consignment, or the
  Outpost is gone.
The names follow the log's `noun_pastparticiple` / `noun_noun` style (`venture_closed`, `deploy_failed`), and share the
`delivery_` prefix so a client can group them.

**The writers.**
- **The warning** — the `buyFromSyndicate` apply (`sim/actions.js`), on the departure tick (the tick the action lands
  on), right after the shipment is scheduled and the fuel burned. Only when the destination is an Outpost and the
  order's space is more than `outpostFreeSpace(outpost)` — exactly equal fits, so no warning. It reads the stockpile as
  it stands and does not count other deliveries already flying there (§9.4's jeopardy: a buy that fits now can still be
  turned back, unwarned, if the guild fills the Outpost in transit).
- **The turn-back** — `landOutpostDelivery` in `stepArrivals` (`sim/tick.js`), on the arrival tick, whenever an
  Outpost delivery is lost. One writer for both causes, so the loss and its notice cannot disagree.
A system is uncapped, so a system delivery writes neither. Both rows are born unread.

**The payloads** (self-contained — the Outpost may be gone, and the shipment is gone, by the time a client reads them;
plain integers and strings, no emoji, the notice-row convention of 02-10-26):
- Both carry **`guildId`**, **`outpostId`** (on a turn-back, the last known id) and the goods summary the shared
  `consignmentSummary` builds (`sim/outposts.js`), so the two describe a consignment the same way: **`cargo`** (a fresh
  `good → qty` copy, keys sorted, never shared with the shipment), **`units`** (Σ qty) and **`space`** (its cargo space).
- **`delivery_space_warning`** adds **`freeSpace`** (the Outpost's free space at departure), **`shortfall`**
  (`space − freeSpace`) and **`arrivalTick`** (when it will land, the shipment's own tick).
- **`delivery_turned_back`** adds **`cause`** — `'full'` | `'outpost-gone'` — and, for `'full'` only, **`freeSpace`**
  (the room it found) and **`shortfall`**. `freeSpace` is carried even though `space − shortfall` gives it, because
  the client computes no game number (§18).

**The surface — today.** No snapshot change was needed: `guilds[].events` carries the rows with their `whenDay`
(no `unlockDay`; no node is held), and `attention.notices` counts them while unread. Until the client half lands, the
live client's notice renderer treats any type it does not know as a licence lapse, so these rows read
"Licence lapsed — Venture" — the same gap `deploy_failed`'s engine half had. Nothing the live client can send writes
one: it only buys to systems. *(⤳ 04-10-26: both gaps are closed. BUY's destination picker (`syndicate-orders.md` §9.1)
lets the live client buy to an Outpost, and the client half below renders both types.)*

**The surface — ruled, not built.** `syndicate-orders.md` §9.1 rules the warning as "an inbox message in the Trader's
voice". The Trader's character, the row titles, the popup body and facts, and any action forks are the client slice's
to build (and, where they need ruling, to rule). *(⤳ 04-10-26: BUILT, below — passive, no action forks, by ruling.)*

**AS-BUILT — the client half (04-10-26; `client/game.html` only, NO `sim/` change; roadmap 2.2 trading to/from
outposts, the last client rung).** Built to this section and the slice's brief, as a small addition beside §10's notice
code. `licence_lapsed`, `venture_closed` and `deploy_failed` keep their code paths unchanged. Driven live, a `venture_closed`
and a `deploy_failed` popup, opened the same way on the page before and after, are pixel-identical.
- **The rows.** `noticeTitle` / `noticeRowTitle` gain a branch per type: "No room at the outpost — {Outpost}" and
  "Delivery turned back — {Outpost}". `{Outpost}` comes from the shell's one outpost resolver (`__outpostName`, "<anchor
  system> Outpost"), via `deliveryOutpostName`. The payload carries only `outpostId`, so an Outpost that is gone from
  the snapshot (always, for an `outpost-gone` turn-back) reads as the fixed neutral phrase "a dismantled outpost",
  never its raw id: the resolver hands back an id it cannot find unchanged, and `deliveryOutpostName` takes that as
  "no live Outpost". A gone Outpost has no name, and no payload field was added to carry one. *(⤳ RULED 04-10-26 and
  built the same day, the client niggles; until then it read as its raw id, e.g. "outpost_seat_demo_02".)* The popup
  titles are the bare "No room at the outpost" / "Delivery turned back"; the facts name the Outpost. Newest-first order, the unread dot and read dimming are §8's, unchanged. No emoji, the 02-10-26 convention.
- **The popup — the Trader.** `openNotice` re-dresses the shared card on every open, as it does for the pilot. For a
  delivery notice (`isDeliveryNotice`): the eyebrow "Trade — Syndicate", the hero `assets/mission/Trader.jpg` (the
  TRADE tab's own hero art, no new asset), framed `right bottom` as the TRADE hero frames it, since the Trader stands at
  the right edge of the picture. Every other notice has the framing handed back to the card's own (`50% 12%`).
  **Dismiss alone:** the Redeploy / Return forks stay hidden, as they are for every notice but `deploy_failed`.
  The notice is passive by ruling; the player clears room through the normal UI (the Outpost Manager's sell, a dispatch).
- **The body — the Trader's voice, verbatim,** static copy keyed on type + cause (`deliveryBody`), one `<p>` per line.
  The warning is its three lines:

  > Guildmaster, I just saw the manifest for your latest order from the Syndicate and I just need to let you know that
  > we don't currently have enough space at the outpost.
  >
  > You'll have to tell me what you want to do with the units we have on hand, otherwise - if the Syndicate can't
  > unload - they'll just turn back with everything with no refund.
  >
  > What would you like me to do?

  The closing question is the Trader's in-character call to action, not a promise of on-screen choices. A turn-back
  is one line by cause. `full`: "Guildmaster — the Syndicate reached the outpost and there still wasn't room for your
  order, so they've turned back with the lot. No refund — the consignment's gone." `outpost-gone`: "Guildmaster — the
  Syndicate carried your order out to the outpost, but it wasn't there to receive it. They've turned back with the
  lot. No refund."
- **The facts** (`deliveryFacts`, mirroring `deployFailedFacts`), in order. Every value is a payload field or the
  engine's `whenDay`, formatted, never derived (§18):
  `Outpost` = the resolver's name; `Consignment` = `units` + " u / " + the number of goods in `cargo` ("2,000 u / 1
  good"); `Reason` (turn-back only) = No room / Outpost gone, from `cause`; `Room short` = `shortfall` and `Free space` =
  `freeSpace`, each followed by "space" (room is cargo space, not units), on every warning and a `full` turn-back; the
  day, `Ordered` (warning) / `Turned back` = `whenDay`. **No Arrives fact:** `arrivalTick` is a tick, and the inbox
  shows only days the engine derives (decision checklist).
- **The card fit.** The warning's three lines and five facts run past the card, so its body scrolls (§10's
  `min-height:0` fix) and the last two facts sit below the fold, as `deploy_failed`'s last fact does.
- **Read-on-open** is §8's, unchanged: opening dispatches `acknowledgeEvent` by id while unread (checked live, id 0
  included).

## 12. The `outpost_packed` notice — the reclaim's success message (2.2 Outpost teardown, RULED 05-10-26)

*Status: **RULED + BUILT.** The **ENGINE half is BUILT** (05-10-26 — the type, the writer and the payload) and the
**CLIENT half is BUILT** (05-10-26 — the inbox row, the pilot popup, Show on map); both AS-BUILT records are at the end
of this section. Spec for the notice `docs/outpost-teardown.md` §8 describes. Modelled on §10:
a writer that already holds everything the notice needs records one self-contained row through the shared
`recordEvent`; retention, acknowledge and surfacing are §3–§5's, unchanged. Like §10 it wears a domain
character (the pilot), not the uniform Syndicate voice.*

**The type.** `outpost_packed` — an Outpost was reclaimed into a kit aboard a heavy. Joins `EVENT_TYPES` in
`sim/events.js` so `checkEventLog` accepts it.

**The writer.** The `reclaimOutpost` apply (`sim/actions.js`), after the gate has passed and before the Outpost
row is removed, on the tick the action lands. Born unread.

**The payload** (self-contained; the Outpost is gone by the time it is read):
- `outpostId` — the reclaimed Outpost's id.
- `anchorSystemId` + `anchorSystemName` — the system it anchored to (its seed name, falling back to the id, the
  way §10's `retreatSystemName` resolves).
- `hex` — `{ q, r }`, where the Outpost stood (copied; `cloneEventPayload` already deep-copies a nested hex).
- `craftId` + `craftClass` — the heavy that now carries the kit.

**The surface — the MESSAGES inbox + popup (§8 / §9), the pilot's character, as §10:**
- the inbox row reads **"Outpost packed up"**, newest-first, with the unread dot as any notice; *(⤳ 05-10-26, the
  client brief: the row carries the Outpost's name too, "Outpost packed up — {anchorSystemName} Outpost", as the
  delivery rows name theirs; the popup title stays the bare "Outpost packed up". Client AS-BUILT below.)*
- the hero is the PILOT (`client/assets/characters/pilot.jpg`), the eyebrow is "Fleet — Dispatch";
- the body is the pilot's voice, verbatim, one beat:

  > The outpost has been packed up, ready to be deployed, Guildmaster. Where do you want me to take it?

- the facts block: `Craft` = `craftClass · NN`; `Packed at` = `anchorSystemName` and hex `{q}, {r}`; `When` = the event
  `whenDay`;
- **one control, SHOW ON MAP**, beside Dismiss. It closes the popup and flies the map to the heavy's CURRENT hex,
  looked up live by `craftId` in the snapshot. A packed heavy sits idle on its hex until the player acts, so
  "current" is normally right; if the heavy is gone, in transit, or not on a hex, fall back to `payload.hex`.
  There is no Deploy or Redeploy button: the message asks the question, and the player answers it through the
  existing dispatch and deploy flow. (§10's Redeploy / Return forks are for a *failed* deploy and are not reused.)

Opening the message acknowledges it (§8, read-on-open), unchanged.

**A NO-OP elsewhere.** A galaxy that never reclaims an Outpost writes no `outpost_packed` row, so every
existing log, snapshot and golden is unchanged.

**AS-BUILT — the engine half (05-10-26; engine only, NO client; roadmap 2.2 Outpost teardown / redeploy).** Built to
this section, no design change. `OUTPOST_PACKED = 'outpost_packed'` joins `EVENT_TYPES` in `sim/events.js` (and its
exports), so `checkEventLog` accepts it. The log, `recordEvent`, retention, acknowledge, `cloneEventPayload` and the
snapshot's events seam are untouched, and the type rides all of them unchanged. The tripwires prove it: the row
surfaces in `guilds[].events` with `whenDay` and no `unlockDay`, counts in `attention.notices` while unread, and is
acknowledged and aged out by the shared predicate. **The writer** is the `reclaimOutpost` apply (`sim/actions.js`)
and nothing else. It calls `recordEvent(guild, next.tick, OUTPOST_PACKED, payload)` on the tick the action lands,
after the gate has passed. Born unread. **The payload as built** is built before the Outpost row is deleted, because
it reads the row:
- `outpostId` — the row's `id`;
- `anchorSystemId` — its `anchorSystemId`;
- `anchorSystemName` — that system's seed name via `getSystem`, falling back to the id, exactly as
  `resolveDeployArrival`'s `retreatSystemName` does;
- `hex` — a fresh `{ q, r }` copy of the row's `coords`;
- `craftId` / `craftClass` — the one parked heavy's `id` / `class`.

A REFUSED reclaim writes nothing. Two reclaims write two rows with ascending ids. Tripwires:
`sim/tests/outpost-teardown.test.js` (the "notice:" tests), and `sim/tests/events.test.js`'s vocabulary test (now six
types). **Interim gap, closed by the client half:** the current client's renderer treats an unknown type as a licence
lapse, so until the client half lands an `outpost_packed` row would read "Licence lapsed — …" in MESSAGES. No client
control issues a reclaim yet, so only an action posted straight to `POST /action` can write one. *(⤳ Closed 05-10-26:
the client half, next, renders the type and the Outpost Manager's Teardown issues the reclaim.)*

**AS-BUILT — the client half (05-10-26; `client/game.html` only, NO `sim/` change; roadmap 2.2 Outpost teardown /
redeploy, client slice).** Built to this section and the slice's brief, as a small addition beside §10's notice code.
The Teardown control that writes the notice is `outpost-teardown.md` §10.
- **The row.** `noticeTitle` gains an `outpost_packed` branch, "Outpost packed up", and `noticeRowTitle` one that
  names the Outpost in the muted `.who` span: "Outpost packed up — AXE-4032 Outpost". The Outpost is gone by the
  time the row is read, so the shell's resolver (`__outpostName`) cannot find it. `packedOutpostName` builds the
  name from the payload instead: `anchorSystemName`, falling back to `anchorSystemId`, + " Outpost" (the
  resolver's own "<anchor system> Outpost" shape). Newest-first order, the unread dot and read dimming are §8's.
- **The type audit.** Every place the client reads notices was checked. `noticeTitle` and `noticeRowTitle` would
  have fallen through to the licence-lapse wording and now branch on the type. `openNotice` dresses the card per
  type (below). The Messages list (`messagesPanel`), the badge and both attention pips (`myUnreadNotices`,
  `paintMessagesRail`, `paintTopLevelAttn`) are type-agnostic, so the new row lists, counts and lights them
  unchanged. `isDeliveryNotice` is correctly false for it. `noticeBody`, `deliveryBody` / `deliveryFacts`
  and the forks' `retreatedCraft` / `noticeFork` are reached only by other types. No other client page reads events.
- **The pilot / fleet split.** `openNotice` used one flag, `fleet` (`deploy_failed`), for both the speaker and the
  forks. It now has two: **`pilot`** (`deploy_failed` or `outpost_packed`) sets the eyebrow "Fleet — Dispatch" and the
  portrait `assets/characters/pilot.jpg`; **`fleet`** still shows Redeploy / Return for a `deploy_failed` only. A new
  `packed` flag shows **`#noticeShowMap`** for an `outpost_packed` only. All three buttons, the note, the eyebrow,
  the portrait and its framing are set on every open, so no notice keeps the last one's.
- **The body** is §12's one beat verbatim, `OUTPOST_PACKED_BODY`, beside `DEPLOY_FAILED_BODY`.
- **The facts** (`outpostPackedFacts`): `Craft` = "Heavy Transport · #01" through `craftLabel`, the helper
  `deployFailedFacts` now shares (its output is unchanged; the `#` is the open checklist item for both notices);
  `Packed at` = "{anchorSystemName} · hex {q}, {r}"; `When` = "Day {whenDay}".
- **Show on map** (`noticeShowMap`), beside Dismiss: it closes the popup and calls `__flyTo(q, r, 9)` (the Dispatch
  popup's zoom; `__flyTo` closes the Guild Hall itself). The hex is `packedCraftHex`'s. It looks the heavy up live by
  `payload.craftId` on the player's guild row. While the heavy is idle with a bare-hex `location`, that hex is used,
  even if it has moved on to another bare hex. Otherwise (gone, in flight, or at a system or waystation) it falls
  back to `payload.hex`, where the Outpost stood. Navigation only; it computes no game number. No Deploy or
  Redeploy button.
- **Read-on-open** is §8's, unchanged.
- **The visual contract.** The brief names the `deploy_failed` entry of `docs/mockups/guild-hall-messages.html` as the
  visual contract, but that mockup has no `deploy_failed` entry (only the four Syndicate notices). The live
  `deploy_failed` popup was followed instead: the same card, eyebrow, portrait, facts and button styles.
- **Tripwires:** `sim/tests/outpost-teardown-client.test.js` runs the page's own notice code in a `node:vm` sandbox
  against a real reclaim's snapshot. It checks the row and title, the unread count, the popup (speaker, verbatim line,
  facts, buttons), the pilot / fleet split across a sequence of opens, read-on-open, and Show on map's target in each
  case: idle on the hex, idle on another hex, really dispatched (in flight), landed at a system, and gone.

## 13. The scan notices — `scan_complete` and `scan_voided` (2.5 Deep Scan Array, RULED 14-10-26)

*Status: **RULED + BUILT** (14-10-26). Ruled by the design room 14-10-26, closing roadmap 2.5's slice-3b checklist
item 9(a) (the notice was DEFERRED 13-10-26 until the engine emitted an event). **Both halves are BUILT in one slice**,
engine and client: "AS-BUILT", the last record below. Modelled on §11: a writer that already holds everything the
notice needs records one self-contained row through the shared `recordEvent`. Retention, acknowledge and surfacing
are §3–§5's, unchanged. The scan itself is `docs/exploration-model.md` §5's and is untouched: the notice only
reports how a job ended.*

**Why.** A Deep Scan Array's job is re-checked when it finishes (`exploration-model.md` §5): unclaimed or own-held
ground reveals; ground a rival now controls "completes to nothing". Either way the job clears. Until this slice no
event was written, so a player learned only from the next poll, when geography appeared or silently did not.

**The types.** Both join `EVENT_TYPES` in `sim/events.js`, so `checkEventLog` accepts them. Both are **passive,
informational** notices, like `delivery_space_warning`: no action-item, no decision.
- **`scan_complete`** — the job finished and revealed its target. Written **always** on the reveal path, **even when
  nothing new was learned** (an already-charted target): the job still finished and the array is free, and the
  notice says so.
- **`scan_voided`** — the job finished to nothing: a rival came to control the target's system first.

**The writer.** `stepScanCompletions` (`sim/deep-scan-arrays.js`), the end-of-tick step that finishes a due job, and
nothing else. On the tick it finishes the job, it writes one row to the **owning** guild's log through `recordEvent`,
stamped with that tick. Born unread. Arrays are finished in id order, so two of a guild's arrays finishing on one tick
write their notices in array-id order (invariant 9). The guild whose claim voided the job is **not** told: the scan
was private.

**The payloads** (self-contained: the array may be gone, and the system may change hands again, by the time the
player reads them):
- Both carry **`arrayId`**, **`level`** (`'L1'` | `'L2'`), the target key the job carried (**`targetSystemId`** for an
  L1, **`targetPlanetId`** for an L2) and **`targetName`**: an L1's system seed name, or an L2's planet
  **designation** — its system's name and its Roman ordinal ("Nyx IV"), the 1-based place in the seed's planet order
  that the board's `order` and the site names already number it by (`scanTargetName`). Falls back to the raw id, as
  `ventureName` does.
- **`scan_complete`** adds **`newFacts`**: the reveal loop's own count of facts that were new
  (`revealSystemArchetypes` / `revealPlanetSurface` return it). An L1 counts each planet archetype; an L2 each
  resource node and settlement slot. `0` means it was all known already.
- **`scan_voided`** adds **`byGuildId`** + **`byGuildName`**: the guild that controls the target's system (from
  `systemControllers`, the same read that voided the job) and its name from the guild row, falling back to the id.
  Who holds a system is L0 and public (`exploration-model.md` §1), so naming it leaks nothing.

**The surface — the MESSAGES inbox + popup (§8 / §9), in the scout's voice:**
- the inbox rows read **"Survey complete — {targetName}"** and **"Survey voided — {targetName}"**, newest-first, with
  the unread dot as any notice; the popup titles are the bare "Survey complete" / "Survey voided";
- the hero is the guild's **scout** (`client/assets/characters/spy.jpg`, never called a spy in the copy), the eyebrow
  "Guild Scout" — the same scout and eyebrow as the survey confirm (`exploration-model.md` §10);
- **Dismiss alone** — passive, no forks, no Show on map;
- the body, one line per paragraph (placeholder copy, to refine at review):
  - complete: "Deep Scan Array 03 — survey of {targetName} complete." then "{newFacts} readings logged." (one: "1
    reading logged."), or, when `newFacts` is 0, "Nothing new — already charted.";
  - voided: "Deep Scan Array 03 — survey of {targetName} voided; {byGuildName} claimed it before it finished."
- the facts block: `Array` (the array's serial, "Deep Scan Array 03", the survey picker's name for it); `Target` =
  `targetName`; `Survey` = "System survey" (L1) / "Planet survey" (L2); then `New readings` = `newFacts` (complete) or
  `Claimed by` = `byGuildName` (voided); then `Completed` / `Voided` = the event `whenDay`.

Opening the message acknowledges it (§8, read-on-open), unchanged.

**A NO-OP elsewhere.** A galaxy in which no scan finishes writes no scan notice, so every log, snapshot and golden
without a finished scan is unchanged.

**AS-BUILT (14-10-26; engine + client; roadmap 2.5, ruling 12 — the scan edges).** Built to this section, no design
change; **no new number** (no constant, no retention change).
- **The engine.** `SCAN_COMPLETE` / `SCAN_VOIDED` join `EVENT_TYPES` and the exports of `sim/events.js`.
  `stepScanCompletions` builds the shared part of the payload once per job (`arrayId`, `level`, the target key,
  `targetName` through the new `scanTargetName`), then on the reveal path keeps the reveal loop's return value as
  `newFacts` and writes `scan_complete`; on the void path it writes `scan_voided` with the controller and its name.
  The reveal, the void condition and the job-clear are unchanged. **No snapshot change:** `guilds[].events` carries
  the rows with their `whenDay` (no `unlockDay`), `attention.notices` counts them while unread, and the per-guild view
  shows a guild only its own (`sim/fog.js` drops a rival's `events`), so a rival's view is byte-identical.
- **The goldens moved only by the notice** (`sim/tests/scan-notice.test.js`, "GOLDENS DELTA"): four scripted
  completions (`sim/tests/scan-notice-script.js` — an L1, an L2, a repeat L1 that learns nothing, and a voided L1)
  were hashed on main at 8b24026, before the slice: state, the god's-eye lens and both guilds' views. On this build,
  strip the scan notices (and wind the guild's `eventSeq` back past them) and the state, the god's-eye lens and the
  owner's view are those bytes exactly; the rival's view is those bytes without any strip.
- **The client** (`client/game.html`, beside §11's notice code): `noticeTitle` / `noticeRowTitle` gain a branch per
  type; `isScanNotice`, `scanArrayLabel`, `scanTargetLabel`, `scanBody` and `scanFacts` build the card from the
  payload; `openNotice` gains a `scan` flag that sets the eyebrow "Guild Scout" and the portrait `spy.jpg`, and hides
  the forks and Show on map, on every open (a scout card hands the pilot's forks back, and the next Syndicate notice
  gets the adviser back). The count of readings is the engine's `newFacts`; the client words it and computes nothing.
- **Tripwires:** `sim/tests/scan-notice.test.js` (the writer on every path, the payloads, the surfacing, the goldens
  delta), `sim/tests/scan-notice-client.test.js` (the page's own notice code in a `node:vm` sandbox against real
  engine output: rows, popups, the re-dress across opens, read-on-open; red against the pre-slice client), and
  `sim/tests/events.test.js`'s vocabulary test (now eight types).

**⤳ AS-BUILT 27-10-26 — a second way to void: the array went dark (`reason: 'anchor-lost'`; losing ground, engine PR 3,
`design.md` §19 #67 — "the running scan voids (`scan_voided`, 'anchor lost')").** A job is now also voided when its
ARRAY loses its attachment mid-job — its hex no longer in or beside its guild's own control, because the system it hung
off was lost (the eviction) or the Outpost it touched was packed up or removed (`exploration-model.md` §5, "AS-BUILT —
the array goes dark"). Same type, **`scan_voided`**; ONE new writer, `voidDetachedScans` (`sim/deep-scan-arrays.js`),
called at the tick the control goes, so the notice is stamped with it — not at the job's `completeTick`. Its payload is
the shared part every scan notice carries (`arrayId`, `level`, the target key, `targetName` — built by the same
`scanNoticeTarget` the completion step now uses) plus **`reason: 'anchor-lost'`**, and no `byGuildId` / `byGuildName`
(no rival is involved). The rival void's payload is **unchanged** and carries no `reason`, so its bytes and every golden
over it stand; a reader tells the two apart by the presence of `reason`. For the eviction it is written before the
`system_lost` notice, and for a reclaim before the `outpost_packed` notice, so the newest-first inbox shows the cause above
it. **Not built: the client.** The live card has no branch for it yet, so it reads "… voided; another guild claimed it
before it finished." with `Claimed by` "—" — wrong words, flagged on the decision checklist with the copy for the design
room.

## 14. The `system_lost` notice — losing ground, the destroyed path (engine half, 17-10-26)

**What it records.** A guild's Prefecture was **destroyed** and the system it claimed went fallow (`design.md` §2
"Losing it evicts the system"; §19 #67 / #69; `docs/territory-model.md` §4 "AS-BUILT — losing ground, engine PR 1").
Discrete and unrecoverable — the Prefecture, its claim and the forfeited goods are gone — so it is an EVENT, not a
standing condition (§0). ONE writer: `evictSystem` (`sim/eviction.js`), the shared eviction, at the tick it happens; it
writes exactly one `system_lost` per eviction, after the uprooted ventures' own `venture_closed` notices (cause
`evicted`, §2), so the newest-first list shows the loss above them. Born unread. *(⤳ 27-10-26, engine PR 3: and after
the `scan_voided` notices (reason `anchor-lost`, §13) of any of the guild's arrays the loss darkened — still the newest.
Its payload is unchanged: it does not list the lanes the eviction ended or the arrays it darkened — roadmap checklist.)*

**The payload, self-contained** (the Prefecture and the claim no longer exist when the player reads it):
- `cause` — what destroyed it: `abandoned` (the owner's voluntary abandon — the only cause built; the storyteller's
  joins `SYSTEM_LOST_CAUSES` with §9);
- `prefectureId`, `claimId` — the destroyed Prefecture and the claim row it wrote;
- `systemId`, `systemName` — the lost system, its seed name (falling back to its id, as the other notices resolve
  names);
- `planetId`, `slotId` — where the flag stood;
- `ventureIds` — the ventures torn down there (sorted; each also has its own `venture_closed`);
- `strandedAssetIds` — the machines left behind, stranded, awaiting salvage (sorted);
- `goodsForfeit` — `{ good: qty }`, the pool lost with the system (positive cells only, keys sorted; `{}` when the
  pool was empty).

**The surface — today.** No snapshot change: `guilds[].events` carries the row with its `whenDay`, `attention.notices`
counts it while unread, and the per-guild view shows a guild only its own. **Not built: the client** — the inbox row,
the card and its voice (the steward's / pilot's — the wording is the design room's, not chosen here). Until it lands the
live client's notice renderer treats any type it does not know as a licence lapse, so a `system_lost` row would read
"Licence lapsed — …" — the same gap `deploy_failed`'s and the delivery notices' engine halves had. Nothing the live
client can send writes one: it has no abandon affordance (the operator CLI and `POST /action` do).

**A NO-OP elsewhere.** A galaxy that never abandons writes no `system_lost` and no `evicted` closure, so every log,
snapshot and golden without one is unchanged (`sim/tests/prefecture-abandon.test.js` pins the no-abandon hashes from
`main`). The vocabulary test (`sim/tests/events.test.js`) now counts nine types.

