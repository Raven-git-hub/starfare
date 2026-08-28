# Licence distribution — per-venture met/breach (the licence-distribution slice, 27-08-26)

The build note for the **licence-distribution** slice. Not a new decision: `design.md` §5's
*"**Breach is judged PER VENTURE, not per good** (RULING UPDATED 27-08-26)"* and *"**the pursue
fill draws on the whole window's delivered pile — no fencing by arrival time** (RULED 27-08-26)"*
are the contract, and `docs/production-console-model.md`'s *"Per-venture licence outcome — the
REAL met/breach"* section is the data-point spec this builds to. Companion notes:
`docs/licence-fee.md` (3b-i, the entity + fee math), `docs/mid-window-pro-rate.md` (3b-ii),
`docs/licence-hardening.md` (the sale's mis-payment).

**It charges nothing.** The per-venture verdict is computed and surfaced; the fee that reads it is
Slice 3b-iii. The per-tick **sale** is untouched — that is the other clock (see §5, and the
two-attributions note in `sim/licence.js`), and this slice deliberately does not make it follow the
pursue order.

## The gap it closes

The engine tracked ONE aggregate window per `(guild, system, good)` and judged met/breach on it:

```
status = delivered >= Q ? 'met' : 'breach'      // one verdict for the whole good
```

But a licence is a per-venture contract, and the fee is per venture. On a good with two licensed
mines, an aggregate breach says *someone* fell short without saying *who* — and "who" is exactly
what 3b-iii has to charge. §5 ruled the answer: at the boundary the good's delivered pile fills its
licensed ventures in the player's **pursue order**, each to its full target before the next is fed;
a venture filled to its **entire** target is `met`, one unit short is `breach`. The good-level
status becomes a **rollup** of those verdicts.

## What changed — four edits

### 1. `pursue` — a per-good ranking (STORED)

`productionProfile[systemId].goods[good].pursue`: an ordered array of venture ids, threaded exactly
like `order` — read by `getGoodPolicy`, merged by `setEntry`/`applyField` (tri-state: a value sets,
absent leaves, `null` clears), deep-copied by `cloneProfile`, validated by `setProductionProfile`
(an array of non-empty strings, or `null`). Sparse in the way `syndicate` is: the key is present
only when the player has stored one, because ABSENT is meaningful — it means establishment order.

Deliberately **not** checked against the current ventures, mirroring `throttles`: the profile is
standing intent, reconciled at read time, so ranking a venture you are about to establish is legal.

### 2. `Q = Σ qᵢ` — the rounding fix

The per-venture target `qᵢ = round(committedContribution(v, windowStart, N))` is rounded **first**,
and `Q` is the sum of the rounded targets. It used to be `round(Σ contribution)`.

Those are different integers whenever the window fractions don't round the same way, and the
difference is load-bearing now: the boundary fill hands each venture its own `qᵢ` while the
Syndicate fork self-terminates at `Q`. If `Q < Σ qᵢ`, the last venture in the order can never be
filled — it breaches on a window whose pile was never *allowed* to reach its target, a **phantom
breach** from an arithmetic disagreement alone. If `Q > Σ qᵢ`, a unit arrives that no verdict
accounts for. Summing the rounded targets makes the pile cap and the verdicts the same integers by
construction, not by luck.

`qᵢ` is the ONE per-venture target: the `Q` sum and the fill both read it — the same single-source
discipline `committedContribution` itself exists for. The paced `requiredRate` already reads
`plan.Q`, so it re-derives for free.

**Byte-identical where it must be.** A full-window venture has `fraction = 1`, so `qᵢ` is its
integer commitment and `Σ round = round(Σ)` exactly. `GOLDEN_COMMITTED_WITH_PRICES` is
single-venture/full-window and its hash is unmoved (`e0255c73…`); the unlicensed goldens are
untouched.

### 3. The boundary fill → per-venture met/breach (DERIVED)

On the read path, for each good carrying commitment (`pursueFill` in `sim/production.js`):

1. **Reconcile the order.** Start from the stored `pursue`; DROP any id that is not committing the
   good this window; APPEND every committing venture the list omits, in **establishment order** —
   the same stable tie-break Gate 3's FCFS default uses, not a new one. A duplicate is honoured
   once. Absent ⇒ pure establishment order.
2. **Fill top-down.** Each venture takes `min(qᵢ, remaining)`; `remaining` decrements by integer
   subtraction. No rounding here — `qᵢ` and `delivered` are already whole units.
3. **Judge, binary.** `met` iff the venture got its ENTIRE target; one short is `breach`, no partial
   credit (the fee it drives is a lump, so a half-met licence is not a thing the model can charge
   for). Mid-window a row still SHORT of its target reads `accruing`, with `delivered` a projection
   off the pile so far — the ranking is editable until the boundary, so calling a shortfall a breach
   early would be a guess presented as a fact.
   **Refined 28-08-26 (console legibility pass): `met` is reported EARLY, `breach` is not.** A row
   already at or past its target reads `met` the moment it is full, mid-window included. The
   asymmetry is sound rather than convenient: within a window `delivered` only grows, and the fill
   hands a licence its full `qᵢ` before feeding the next, so a licence at its target cannot fall
   back below it — no later re-ranking can take units off a row that is already full. `breach`
   stays boundary-only, because that one really is a fact about the window's END. This is a
   STATUS-ONLY refinement: no credit moves, no delivery moves, `Q` is unchanged, and status is
   derived telemetry that reaches no stored byte (the committed golden hash is unmoved).

**No arrival-time fencing (N-4).** The fill is over the window's *whole* pile. A mid-window joiner
ranked first draws on units delivered before its licence existed, and the venture that actually sent
them then breaches. That is the ruling, not a bug — pursue is the lever for steering the goods you
have onto the licences that cost you least, the Syndicate receives the same total goods either way,
and only *which* licence pays discounted vs full moves. A test asserts the behaviour (with the
unranked counterfactual beside it) so it cannot be quietly "fixed".

### 4. The rollup, and the stale-pursue flag

`window.status` is now `rollupStatus(perVenture, isBoundary)`: `met` only if every row is met, else
`breach` at the boundary and `accruing` while the window runs — carrying the same early-`met`
asymmetry as the rows (28-08-26), so the good's pill can never disagree with the dots beneath it. The aggregate is derived from the individuals, never the reverse.
With `Q = Σ qᵢ` and a greedy fill this is the same verdict `delivered >= Q` gave — which is why the
change is byte-identical — but it is now *composed* the way the design says it is, so a future
per-venture rule cannot silently disagree with the dot the console shows.

`reviewSystem` gains a fourth trigger, `stale_pursue` — a ranking naming a venture that no longer
produces that good in the system, the same class as a stale throttle. It is checked against
PRODUCERS, not licence-holders: ranking an unlicensed producer ahead of time is legitimate (it goes
live the moment the licence is granted), while a venture that has stopped producing the good never
will. The issue sorter's key widened to `(kind, good, ventureId)` — `stale_pursue` carries both
halves and the other three kinds carry exactly one, so their ordering is unchanged.

## The surface

`…goods[good].window.perVenture = { [ventureId]: { commitment, delivered, status } }`, additive,
**schema stays 7**. Keyed by ventureId, one row per licence — the shape `client/console.html`'s
`synResolve`/`licRow` already want, so the follow-up client slice is pure wiring (its roster is a
row per producing venture with a `commitment`, and today it prints the GOOD's dot on every row
because there was nothing else to print). The good-level `window` block is unchanged for the
thermometer. All of it DERIVED — recomputed by the same resolver the tick applies, in no serialized
state and in no determinism hash.

## What this slice did NOT do

- **The fee (3b-iii).** Nothing is debited. Proven per tick over two whole windows: the guild's only
  credit movement is 3a's sale.
- **The console rewire.** The client still renders the good-level dot; the snapshot is shaped for it.
- **The window-end reserve-backfill** — still a later, separately-designed option (§5).
- **The `delivered ≤ Q` invariant.** `invariants.js` notes it was "left to the distribution slice";
  it is deliberately still deferred, and the reason is now sharper rather than vaguer — see the
  decision checklist. Recomputing `Q` inside the sweep is easy; deciding what a *legitimately*
  over-delivered window means (a commitment reduced or a venture removed mid-window leaves real
  units in a pile against a smaller recomputed `Q`) is a ruling, and a wrong guess halts the galaxy
  on a state that is not actually broken.

## Proof

`sim/tests/licence-distribution.test.js` (+19, plus 2 accessor guards in `profile.test.js`): the priority fill and the same run with the ranking
reversed (same pile, same commitments, flipped verdicts); one unit short reading `breach`;
`Σ perVenture.delivered = window.delivered`; the F-C rounding case where `Σ round = 4` and
`round(Σ) = 3`, with full delivery meeting everyone and the phantom breach the old arithmetic would
have produced stated explicitly; the N-4 fill drawing on units delivered before the joiner existed,
with the unranked counterfactual; the rollup in both directions; read-time reconciliation (a dead id
ignored AND flagged, an omitted venture appended last in establishment order); the control's
round-trip and `null` clear; six malformed rankings refused with the state byte-identical; the
snapshot shape; the charges-nothing proof; and determinism.

**437 tests (+21), zero failures.**

By hand — two mines on one good, `Q = 10`, a pinned send delivering a pile of 8, and
nothing changing between the runs but the ranking:

```
pursue = (none — establishment order)      pursue = mine-B > mine-A
  good: Q=10 delivered=8  status=breach      good: Q=10 delivered=8  status=breach
   mine-A    6/6  met                         mine-B    4/4  met
   mine-B    2/4  breach                      mine-A    4/6  breach
```

Same goods delivered, same credits earned, same ledger — only *which contract was
honoured* moves. That is the whole mechanic, and (from 3b-iii) the difference between a
discounted fee and a full one.
