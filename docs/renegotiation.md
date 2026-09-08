# Licence renegotiation — build note

**Ruling:** `docs/design.md` §5, "Licence renegotiation — the terms function & venture
standing" (08-09-26). That subsection is authoritative; this note records only what has
been BUILT against it and does not restate the design.

**Numbers:** the four `[FIRST-CUT]` constants come from `docs/phase-1-tuning.md`
§"Licence renegotiation — venture-standing bands & terms function (08-09-26 — #64)".
Nothing here was invented — the build reads named constants (§0 / CLAUDE.md).

---

## Slice 1 (08-09-26) — engine + snapshot derive ✅

**Scope.** At a licensed venture's window-end, classify its standing from its RP, compute
the Syndicate's new terms from that standing, and add a `renegotiateLicence` action that
accepts those terms and re-locks the licence in place. **No timers, no auto-lapse, no
client UI** — those are Slice 2 (and the "how the offer reaches the player" ad-hoc-events
presentation is deliberately deferred with it, §5).

### `sim/licence.js`

- **Named constants**, each citing `phase-1-tuning.md`:
  - band cut-points `STANDING_CUT_AT_RISK = −300`, `STANDING_CUT_STEADY = 0`,
    `STANDING_CUT_STRONG = 500`;
  - `STRONG_FEE_DISCOUNT = 0.10` (the −10% the top band re-locks at — the fee only ever
    *falls*, and only at Strong; this replaces the retired 24-08-26 surcharge);
  - `COMMITMENT_STEP_STEADY = 0.10`, `COMMITMENT_STEP_SUB_PAR = 0.25` (At-risk is a jump
    to full, not a step, so it needs no constant).
- **`ventureStanding(venture)`** — pure classifier → `'atRisk' | 'subPar' | 'steady' |
  'strong'`, read straight off `venture.reputation` (missing = 0). Exact edges: rp ≤ −300
  atRisk; −300 < rp < 0 subPar; 0 ≤ rp < 500 steady; rp ≥ 500 strong.
- **`renegotiationTerms(venture)`** — pure terms function → `{ committedOutputPct,
  windowDays, feeDiscount }`. Commitment stepped up by band (clamped to 1.0; At-risk set
  to full); `windowDays` carried unchanged (window is not a lever this cut); `feeDiscount`
  the Strong discount for strong, else 0. Equity is not a term — it carries from the
  venture, untouched.
- **`renegotiationFee({ venture, baselineUnitsPerTick, windowN, lockedPrice })`** — the ONE
  place a re-locked fee is priced, read by BOTH the action's apply and the snapshot's
  offer preview (the `teardownSettlement` one-source-of-truth pattern). Recomputes the fee
  exactly as `applyForLicence` does (`licenceFee` at the current posted price, the new
  commit, the venture's carried equity), then bakes the Strong-band discount into the
  stored fees (`round(fee × (1 − feeDiscount))`, integer credits, §15.2) — no new licence
  field, so the boundary charge and `teardownSettlement` read `basicFee`/`discountedFee`
  unchanged. Returns `{ committedOutputPct, basicFee, discountedFee, feeDiscountApplied }`.

### `sim/actions.js`

- **`renegotiateLicence`** action `{ type, guildId, ventureId }`, creator
  `createRenegotiateLicenceAction` beside `createApplyForLicenceAction`, both exported —
  the near-mirror of `applyForLicence`.
  - **Validate:** guild exists; `ventureId` a non-empty string; the guild owns the venture;
    it is **not** a deuterium mine (`resourceType === DEUTERIUM` → refused early with the
    windowless-exempt reason, §1.4); it holds an **ordinary licence** (the opposite of
    applyForLicence's "already licensed" refusal); and the committed window has **ELAPSED**
    (`state.tick >= licenceEndTick(licence, windowN)`, `windowN` read the same way
    applyForLicence reads it).
  - **Apply, with three deliberate differences from applyForLicence:** (1) terms via
    `renegotiationFee` (Syndicate-set, from standing); (2) fee re-locked at *today's* posted
    price with the Strong discount baked in; (3) **NO signing bump** — `signingBump` is
    never called, so `venture.reputation` and the guild's cached sum are untouched (§5 "On
    accept": RP carries). The licence is re-locked in place: `committedOutputPct` = new,
    `windowDays` carried, `signedTick = tick` (resets the window), `lockedPrice`/`basicFee`/
    `discountedFee` re-priced; `syndicateCommitment` and `committedFromTick` (= `tick + 1`,
    the new window's first producing tick) recomputed.
- **`applyForLicence`'s "already licensed" refusal message** updated — the "renegotiation is
  not built yet" clause is gone; it now points at `renegotiateLicence`.

### `sim/snapshot.js` (derive only — moves nothing, schema stays 7)

Per **licensed, non-deuterium** venture (spread in, so an unlicensed venture and a
deuterium mine carry NEITHER key):

- **`standing`** — the `ventureStanding` band, always (a read of RP).
- **`renegotiationOffer`** — present (non-null) only when the committed window has elapsed
  (reusing the existing `contractWindow.expired`): `{ committedOutputPct, basicFee,
  discountedFee, feeDiscountApplied }` from the SAME `renegotiationFee` the apply locks, so
  the offer shown and the terms taken cannot disagree. `null` before expiry.

Both are DERIVED on read: no serialized byte, no determinism hash — so no state golden
moves, and invariant 9 still holds. This is the seam the client RENEGOTIATE button will
read (client half, Slice 2).

### Tests

`sim/tests/renegotiation.test.js` (+21): `ventureStanding`'s exact edges; the
`renegotiationTerms` table by band (steps, clamps, Strong discount, window + equity
carried); the action's rejections (before window-end, unlicensed, not-owned, deuterium) and
its accept (re-lock in place, RP + guild sum unmoved, reset `signedTick`, carried
`windowDays`, fee re-priced and discounted only at Strong, recomputed
`syndicateCommitment`/`committedFromTick`, all invariants hold); and the snapshot fields
(licensed carries `standing`; expired carries a matching `renegotiationOffer`; not-yet-
expired carries none; unlicensed and deuterium carry neither).

**Full suite green:** `node --test` from `sim/` — 1094 tests, 0 failures (1073 before +
21). No `renegotiateLicence` appears in any golden run and the new snapshot fields are
derived, so every existing golden (unlicensed and licensed-but-untouched) is byte-identical.

## Tidy (08-09-26) — 2 dp normalisation of renegotiated commitment ✅

**Bug.** `renegotiationTerms` stepped commitment with plain float addition (`current +
COMMITMENT_STEP_*`), so `0.7 + 0.10` yielded `0.7999999999999999`. That creep flowed into
the snapshot offer and, on accept, into the stored `licence.committedOutputPct`, and it
**compounded** across successive renegotiations. Not a correctness break (commitment is a
fraction, not a §15.2 integer, and `commitmentUnitsFor` rounds it to whole units
downstream), but ugly, accumulating, and it would render badly in the client.

**Fix.** `renegotiationTerms` now rounds the returned `committedOutputPct` to 2 dp once,
on the final value (`Math.round(x * 100) / 100`) — covering the Steady/Sub-par steps, the
carried Strong value (self-healing any creep a prior renegotiation left on it), and
At-risk's `1.0` (a no-op). The `Math.min(1, …)` clamps are preserved. **Precision ruling:**
2 dp, chosen because every commitment value and step already lives at 2 dp (`0.5`, the
live `0.51`, `+0.10`, `+0.25`) and the client presents commitment as a whole-number
percentage, so 2 dp is lossless for every legitimate value. Slice-local minor ruling (it
rides this note, §0); not a game-balance number, and `design.md` §5/§15.2 are left to
state (or not) a commitment-precision convention — the note is judged enough.

**Scope.** Renegotiation only. Establishment is NOT touched, so a licence whose
establishment commitment carried finer than 2 dp (e.g. `0.333`, which `isValidCommitmentPct`
permits) is normalised to 2 dp the FIRST time it is renegotiated — acceptable, since
renegotiation re-locks the Syndicate's terms anyway, and called out here rather than left
silent.

**No golden/snapshot-schema/client change.** `renegotiationTerms` appears in no golden run
and the snapshot offer is derived, so no serialized byte moves and determinism (invariant
9) holds. No client change.

**Test.** `sim/tests/renegotiation.test.js` — strict-`===` assertions that a Steady step
`0.7 → 0.8`, a chain `0.5 → 0.6 → 0.7 → 0.8`, and a Sub-par step `0.7 → 0.95` are exact;
that an already-clean value is unchanged; and that At-risk returns exactly `1`.

## Slice 1b (08-09-26) — delivery UI + the lapse action ✅

**Scope.** Deliver the offer Slice 1 derives to the player, and add the REJECT half. The
ruling is design.md §5 ("Accept or lapse" + "Message delivery" + "Slice split (revised)");
no design number is chosen here (there are none — lapse has no constant, and the offer's
figures are Slice 1's `[FIRST-CUT]` constants).

### `sim/actions.js` — the `lapseLicence` action

- **`lapseLicence`** action `{ type, guildId, ventureId }`, creator `createLapseLicenceAction`
  beside `createRenegotiateLicenceAction`, both exported. It is the LAPSE-to-unlicensed
  operation (§5 "Accept or lapse") — the outcome of a player REJECT, and the same action
  Slice 2's acceptance-window timeout will reuse to auto-lapse.
  - **Validate:** the EXACT same gate as `renegotiateLicence` (you can only lapse a licence
    that is up for renegotiation) — guild owns the venture; not a deuterium mine (windowless,
    exempt, refused early); holds an ordinary `licence`; and the committed window has ELAPSED
    (`state.tick >= licenceEndTick(licence, windowN)`, `windowN` read as the other actions read
    it). Same order, same reasons.
  - **Apply:** mirrors `decommissionVenture`'s two licence-shedding moves — the RP forfeit and
    the commitment-clear — but KEEPS the venture in place (decommission removes it). It
    subtracts `venture.reputation` from `guild.guildReputation` and `delete`s the venture's
    reputation (back to the omit-when-0 unlicensed state — invariant 8 stays exact), deletes
    `venture.licence`, sets `syndicateCommitment = 0` and deletes `committedFromTick` (the
    exact shape `establishVenture` leaves). **No fee, no node lockout, no signing bump** — at
    window-end teardown's settlement is only the RP forfeit (§5). The venture, its node and its
    asset all survive; the guild may sign a fresh licence later. Forfeiting a **negative** RP
    RAISES the guild sum — the deliberate asymmetric escape valve (§5), asserted in tests.

### `sim/snapshot.js` — the `attention` derive (read-only, schema stays 7)

- **`attention: { renegotiations: [ { guildId, ventureId, ventureName, standing, offer } ] }`**
  — a top-level, read-only aggregation of the guild's open action-items (§5 "attention derive")
  so the MESSAGES panel and the tab badge read one place. For this slice that is exactly the
  ventures carrying a non-null `renegotiationOffer` (a pure aggregation of `renegotiationFieldsFor`),
  scanned across every guild and tagged with `guildId` (the snapshot is multi-guild; the client
  filters to its own). `offer` is the same `renegotiationOffer` the venture row publishes;
  `ventureName` is the venture's SEED site name (engine-owned display text — the client adds its
  own type label, as it does everywhere). Shaped as a list under `renegotiations` so a later
  slice's event-log notices join the same object. DERIVED on read: no serialized byte, no
  determinism hash, no golden moved, invariant 9 holds.

### `client/game.html` — the MESSAGES panel, the popup, the two entry points

Built to `docs/mockups/guild-hall-messages.html` (see `docs/guild-hall.md` §6). A MESSAGES rail
entry (amber badge + pulsing dot while `attention.renegotiations` is non-empty) and panel (the
pinned "Needs a decision" section from the attention derive; the Notices section is an honest
empty stub — the event log is Slice 2+); the top-level Guild Hall tab lights an amber pip on
every poll while an offer is open. The renegotiation popup (`#reneg-overlay`) is opened from a
Messages row AND from the VM "Renegotiate ▸" button (shown once the window has elapsed) — ACCEPT
→ `renegotiateLicence` (built), REJECT → the shared adviser confirm → `lapseLicence`. Every term
shown is a published snapshot field; the adviser voice is presentation keyed on the emitted
`standing` band (one Syndicate-liaison voice). No countdown — the "respond in N days" grace window
is Slice 2; rows say "window elapsed".

### Tests

`sim/tests/renegotiation.test.js` (+14): `lapseLicence`'s rejections (before window-end,
unlicensed, not-owned, deuterium); its apply (licence gone, RP forfeited and removed, guild sum
dropped by exactly the forfeit — and RAISED for a negative-RP venture, the escape valve —
`syndicateCommitment`/`committedFromTick` cleared, venture still present, no credit moved, no
lockout, all invariants hold); re-licensing the lapsed venture mints a fresh bump; and the
attention derive (an expired venture surfaces, a not-yet-expired / unlicensed / deuterium one does
not, ACCEPT and LAPSE both clear it, the derive is byte-identical read-only).
`sim/tests/server.test.js` (+1 test, tripwire): the served page carries the Messages rail entry,
the panel, the popup, both entry points, and the "window elapsed" marker (no countdown); the
retired "Renegotiation itself is not built yet" caveat flips. **Full suite green:** `node --test`
from `sim/` — 1113 tests, 0 failures. No golden run contains `lapseLicence` and the attention
derive is read-only, so every existing golden is byte-identical. Verified end-to-end in headless
Chromium (real server + real client): the Messages tab highlights and lists both offers, the popup
opens from a Messages row and the VM button, ACCEPT re-locks (0.5→0.6), REJECT → confirm → the
venture goes unlicensed (kept) and drops off the list.

## Slice 2 (08-09-26) — the timers ✅

**Scope.** The final piece of #64: a grace window after the committed window ends (nothing is
offered), then the Syndicate acts (the offer appears with a fixed acceptance countdown), then
auto-lapse to unlicensed if still unanswered. All deadlines day-aligned and derived — no new
stored state. Ruling: design.md §5 "Renegotiation timers — grace, acceptance, auto-lapse";
numbers in `docs/phase-1-tuning.md` §"Licence renegotiation timers". *(Both the §5 subsection and
the phase-1-tuning numbers were **added in this commit** — the ruling and the constants the human
gave for this slice were not yet recorded in the repo; the code reads named constants, invents
nothing, and cites both docs.)*

### `sim/licence.js` — the derived schedule + the shared lapse

- **Named `[FIRST-CUT]` constants**, each citing phase-1-tuning: the grace cutoffs
  `GRACE_CUT_MED/LONG/MAX = 14 / 21 / 28` and values `GRACE_DAYS_MIN/SHORT/MED/LONG = 1 / 3 / 4 / 5`;
  the fixed `ACCEPTANCE_WINDOW_DAYS = 5`.
- **`graceDaysFor(windowDays)`** — pure step function over the cutoffs (`< 14 → 1`, `< 21 → 3`,
  `< 28 → 4`, else `5`); grace is `windowDays`-keyed, NOT band-keyed (§5).
- **`renegotiationSchedule(licence, windowN, dayAnchorTick)`** — the ONE place the timeline is
  computed, returning the three DAY-ALIGNED ticks off the calendar (`dayOf`/`tickAt`) so they
  cannot diverge: `windowEndTick` (the calendar `renegotiationDeadline`), `actsTick` (+ grace
  days), `lapseTick` (+ acceptance days). Read by both the snapshot and the tick — the
  `teardownSettlement`/`renegotiationFee` single-source pattern.
- **`applyLapse(guild, venture)`** — the `lapseLicence` apply body, EXTRACTED to a shared mutating
  helper (RP forfeit + licence drop + commitment clear, keeping the venture). Called by
  `lapseLicence`'s apply (a player REJECT) AND the auto-lapse tick step (the timeout), so a
  chosen lapse and a timed-out one cannot diverge. No behaviour change to the action.

### `sim/snapshot.js` — gate shift + countdown (derived, schema unchanged)

- **`contractWindow`** day-aligns onto `renegotiationSchedule(...).windowEndTick` (was Slice 1's
  raw `licenceEndTick`), so "window elapsed", grace and acceptance share one basis. Field shape
  unchanged; `endTick`/`endCycle`/`cyclesRemaining`/`expired` recomputed off the calendar. It
  coincides with teardown's raw lockout for a day-aligned signing (they diverge only mid-day,
  teardown's own basis to keep — out of scope).
- **`renegotiationFieldsFor`** gates the offer on **`state.tick >= actsTick`** (after grace), not
  window-end — superseding Slice 1b's window-end gate. During grace the venture carries `standing`
  but no offer, so MESSAGES stays quiet and the VM shows CLOSE VENTURE (§5 phase B). The offer now
  carries the countdown: `lapseTick` and a derived `daysToLapse` (whole calendar days to the
  deadline, floored at 0). `computeAttention` follows automatically.

### `sim/tick.js` — the auto-lapse step

- **`stepAutoLapse`**, appended to `STEPS` (now 9) — the FIRST tick-driven licence mutation on a
  TIMER (not a boundary verdict). Runs LAST, after all boundary/accrual/grant work, scanning
  guilds → ventures deterministically; a venture with an ordinary (non-deuterium) licence whose
  `state.tick + 1 >= lapseTick` is lapsed via the shared `applyLapse`. Fires the player's absence
  into the same lapse the REJECT button does; produces no notice (event log is later).

### `client/game.html` — the countdown (small)

The MESSAGES row and the VM RENEGOTIATE control already key off `renegotiationOffer`/`attention`,
so they now appear only after grace with no wiring change beyond one: the VM control keys off the
**offer** (`v.renegotiationOffer`) rather than `cw.expired`, so it stays hidden during grace. The
Slice 1b static "window elapsed" is replaced by the live countdown (`deadlineLabel(offer)` reads
the engine-derived `daysToLapse` → "respond in N days"; the last day is amber). The client
computes no game number.

### Tests

`sim/tests/renegotiation.test.js` (+7): `graceDaysFor` at every cutoff edge (13→1 … 42→5); the
schedule's three day-aligned ticks; the offer gated on `actsTick` (quiet in grace, live after,
`daysToLapse` counting 5→1); and auto-lapse — an unanswered licence lapses at `lapseTick` via the
exact `applyLapse` effect (venture survives, RP forfeited, guild sum exact, off attention), an
ACCEPTED venture never reaches it (the schedule moved), a REJECTED one is already unlicensed, and
a deuterium mine is never touched. The Slice 1b offer/attention tests moved to the grace-shifted
gate (`elapse` now jumps to `actsTick`). `sim/tests/server.test.js` tripwire flipped: the "no
countdown" pin becomes the live-countdown pins, and the VM control pin keys off the offer.
`sim/tests/tick.test.js` pins the 9-step order with `stepAutoLapse` last.

**Existing accrual tests kept engaged.** Auto-lapse is a new global behaviour: a licence left
untouched past its deadline lapses. Four pre-existing RP/modifier tests ran a licence untouched
for dozens of cycles (`reputation.test.js` ×3, `founding-endowment.test.js` ×1) and now model the
player staying engaged — a `keepEngaged` helper ACCEPTs the renegotiation the moment one is
admissible, resetting the schedule; for a full-commitment venture the re-terms keep commitment at
1.0 so the per-cycle RP is unchanged, and it runs the REAL action so every invariant holds.

**Determinism / goldens.** `stepAutoLapse` mutates only at a computed deadline no golden run
reaches, and the schedule/offer/countdown are derived — so every committed golden is
byte-identical and invariant 9 holds (the whole suite, determinism runs included, stays green).
Day-aligning `contractWindow` shifts no pinned golden (the goldens don't exercise an elapsed
licence); the one snapshot-value test that signed at the pre-game tick 0 now signs at a day-
aligned tick so its raw-vs-day-aligned end still coincides. **Full suite: 1120 tests, 0 failures.**
Verified end-to-end in headless Chromium (real server + client): grace is quiet, the offer appears
with the countdown, and an unanswered venture auto-lapses off MESSAGES.

### Still deferred (per §5), not invented here

The **event log / notices** and the `messagesSeenTick` unread mechanic (auto-lapse writes no
notice — the Notices section stays an empty stub); the parked domain-character adviser split;
window as a demand lever; equity changes; the −300 forced-lease / −500 closure consequences; the
#57 investor vote; dividends; counter-offers; the resource-sale premium/discount. Deuterium stays
exempt. With this slice, #64 (licence renegotiation) is complete but for the event log.
