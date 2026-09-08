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

### Deferred (Slice 2, per §5), not invented here

Timers / the fixed acceptance window / auto-lapse to unlicensed; the variable grace window;
window as a demand lever; equity changes; the −300 forced-lease / −500 closure consequences;
the #57 investor vote; dividends; counter-offers; the resource-sale premium/discount; and
the client button + the ad-hoc-events presentation of the offer. Deuterium stays exempt.
