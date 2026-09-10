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

The type vocabulary this slice writes is exactly two, in `sim/events.js`:

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
  - the −500 forced-closure tick path (`docs/forced-closure.md`) → cause **`forced`**.

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
§9) beside the copied `{ ...e, payload: { ...e.payload } }` — computed on read over the galaxy's
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

## 8. The client Notices panel (the CLIENT slice) — AS BUILT

> **⤳ SUPERSEDED by §9 (the Notices redesign, ruled 10-09-26).** This section
> records the FIRST client slice — inline notice rows with an inline ACKNOWLEDGE. §9 rules
> the email-style inbox + per-type popup that replaces it; the client-rebuild slice rewrites
> this section AS-BUILT when it ships.

The Guild Hall MESSAGES panel (`client/game.html`) now renders the notices below the pinned
open offers, to the mockup's `.msg.note` style (`docs/mockups/guild-hall-messages.html`).
**Client only** — no engine / snapshot / `sim/` runtime change; it renders the published rows
and dispatches exactly one new action (`acknowledgeEvent`).

- **The list** is the player guild's `guilds[].events` (read + unread), rendered in the
  snapshot's own newest-first order (§5). "No notices yet." shows only on an empty log.
- **The copy** is keyed on `type` + `payload.cause` (§2), in one plain Syndicate-liaison tone
  (the domain-character adviser voices are parked, §5). It names `ventureName` and `good`; the
  node-held line is **qualitative** — no lockout duration is derived from `payload.lockoutUntilTick`
  (§18: the client computes no game number; a precise "unlock in N days" would need a snapshot
  derive and is out of scope). The row's **"when"** is the notice's own recorded `tick` — the
  published field, not a derived calendar day, for the same reason.
- **Read / unread** follows the mockup: an unread notice (no `readTick`, §3) shows the unread
  dot and an **ACKNOWLEDGE** control; a read one is dimmed with neither.
- **ACKNOWLEDGE** dispatches the existing `acknowledgeEvent { guildId, eventId }` for that
  notice's id (sent as a Number — the apply matches by `===`); on the next poll the row renders
  read. The engine already no-ops an aged-out id (§3), so a stale click is harmless.
- **The pip + badge** (the top-level Guild Hall tab and the Messages rail entry) light while any
  offer is open **or** any notice is unread (design.md §5), the count adding the player's own
  `attention.notices` to the open offers.

## 9. The Notices surface, redesigned — an email-style inbox + per-type popup

*Status: **RULED** 10-09-26. Supersedes §8's inline notice rows. Built in two slices — the
**engine field-slice** (the three additive fields below) is **BUILT** (the three fields ship, §2
and §5 folded in above); the **client slice** (the inbox + popups) stays **pending**. Each moves
doc + code together; §2 / §5 / §8 fold in the new fields / AS-BUILT as their slice ships. Visual
contract: `docs/mockups/guild-hall-messages.html` (updated to the redesign).*

The MESSAGES panel becomes an **email inbox**. Every row — the pinned action-items **and** the
notices below — is a **clickable subject line**: an icon, a one-line title, a "when" (or, for an
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
portrait** (`assets/characters/advisor.jpg`), **uniform across every notice type**: a
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
