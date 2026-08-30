# The licence entity + the fee math — what was built (licence Slice 3b-i, 27-08-26)

The build note for **3b-i** of `docs/licence-and-price-system.md` Part 4. The contract is `design.md`
§5's **"LICENCE FEE MECHANICS — RULED"** note and the four-corner grid it discounts with. This slice
computes and **locks** the fee; **3b-iii charges it** (the fee charge was renumbered when 3b-ii became
the mid-window pro-rate) — **and 3b-iii is now BUILT: see [The charge](#the-charge--licence-slice-3b-iii-28-08-26)
at the foot of this note.** Companion notes: `docs/commitment-sale.md` (3a, the sale),
`docs/price-engine.md` (the posted price the fee locks against),
`docs/licence-distribution.md` (the per-venture verdicts the charge reads),
`docs/mid-window-pro-rate.md` (the fraction that scales a first, partial window's fee).

## What it does

A mining venture is granted a licence by a new **`applyForLicence`** action. The player offers two
terms — a share of the venture's **droidless baseline** output, and a renegotiation window in days —
and the Syndicate does not negotiate: everything else is computed from those terms plus the market as
it stands, and stored.

```
basicFee      = round( FEE_RATE × baseline-per-tick × N × posted price at signing )
discountedFee = round( basicFee × feeFraction(c, oNorm) )
feeFraction   = [ 100(1−c)(1−o′) + 75·c(1−o′) + 75(1−c)o′ + 0·c·o′ ] / 100,   o′ = oNorm^k
```

- **The basis is the BASELINE**, never `productionRate` (§5). Throttling the mine cannot shrink the
  fee and droids cannot inflate it — the Syndicate prices the licence off what the venture's *type* can
  make. A test pins this: a rate-1 mine owes exactly what a rate-5 mine of the same type owes.
- **`c`** is the commitment axis normalised against the **0% floor**; **`oNorm`** is the equity offer
  normalised against the **49% ceiling**. The equity axis is shaped by `o′ = oNorm^k`, so toe-dipping
  buys proportionally little and the payoff **accelerates** toward the ceiling; commitment stays linear.
  The corners are untouched by the shaping (`0^k = 0`, `1^k = 1`), so §5's table still states them
  exactly.
- **Both figures are computed once and stored.** That is what "terms locked at issuance" means, and it
  is why *when* you sign is a real decision (§5: "rewards reading the market and timing your lock"). A
  test moves the posted price 9× up and 4× down afterwards; the stored fees do not budge.

**Nothing is charged *by 3b-i*.** No debit, no breach penalty, no credit movement of any kind beyond
3a's commitment sale — which this slice is what *switches on*, because the licence is now what sets
`syndicateCommitment`. *(**Superseded by 3b-iii, 28-08-26** — the fees this slice locks are now debited
at the window boundary. Kept as the record of what 3b-i shipped; the charge is documented below.)*

## `venture.licence` — the reserved socket, filled

```js
venture.licence = {
  committedOutputPct,  // the share of BASELINE output promised, a fraction ≥ the floor
  windowDays,          // §5's renegotiation window, in days — stored, inert until renegotiation
  signedTick,          // when the terms were struck (§15.2: every mutation records its tick)
  lockedPrice,         // the POSTED price at signing — what the fee is priced off
  basicFee,            // integer credits: the full fee, the maximum ever payable
  discountedFee,       // integer credits: after the four-corner grid
}
```

**Omitted when absent** — an unlicensed venture carries no `licence` key at all, the same discipline
`equityPct` and `syndicateWindows` use, so an unlicensed galaxy's serialized state stays byte-identical
and the golden-hash no-op proof still means something.

**Embedded, not a separate entity.** §15.4 originally sketched a `Licence` entity referenced by
`Venture.licenceId`; the 27-08-26 ruling pins it as an **embedded object on the venture**, and a
pointer at §15.4 now says so. `shareholders` (the Slice 5 cap-table) stays documented-not-stubbed.

## `applyForLicence` — what it validates, locks, and sets

**Refused, not clamped** (as with 3a's equity offer — a silently-adjusted term would be the engine
rewriting a contract the player agreed to): the guild must own the venture; the venture must be
**unlicensed** (a second application is *renegotiation*, which is not built — so it is refused rather
than quietly re-locking at today's price); it must be a **mine**; its good must be **non-fuel** (§8);
`committedOutputPct` must be a fraction in `[floor, 1]`; `windowDays` a whole number in `[7, 42]`; and
the good must have a **posted price** and a **baseline** to price the fee against.

On apply it locks `lockedPrice` = the posted price *now*, computes both fees, stamps `signedTick`, and
sets

```
venture.syndicateCommitment = round( committedOutputPct × baseline-per-tick × N )
```

— the operative per-window quantity the §5 accrual sums into `Q` and that 3a's sale is paid on. **The
licence is what turns the sale on.**

**`setWindowN` is now also refused once any licence exists.** A locked fee and a locked commitment are
both measured *over one window*; moving `N` afterwards would silently make them describe a window that
no longer exists. Set the window length first, then license. (It was already tick-0-only.)

**`windowFraction` stays pinned.** `applyForLicence` deliberately does **not** set `committedFromTick`,
so `sim/windows.js`'s pro-rate tripwire stays green — see the flag below. *(**Superseded — Slice
3b-ii:** the stamp is now written and the `fraction == 1` deferral tripwire is retired. Kept as the
record of what 3b-i shipped.)*

## ⚠️ Flag for the fee charge (3b-iii): a mid-window licence breaches its first window

> **RESOLVED — licence Slice 3b-ii (27-08-26), `docs/mid-window-pro-rate.md`.** The pro-rate was built:
> `applyForLicence` now stamps `committedFromTick`, so the run below meets its pro-rated `Q` instead of
> breaching. The section stands as the record of the failure and of why the fix was a prerequisite.
> What is *still* open for the fee slice (now **3b-iii**) is the other half: whether a partial first
> window's **fee** is pro-rated, free, or full.

Because `windowFraction` is pinned at 1, a venture licensed **partway through** a window owes the
**whole** window's `Q` but has only the remaining ticks to deliver it. Observed, with `N = 4`, a
rate-5 mine licensed at tick 2 at 100% commitment (`Q` = 20):

```
tick 3  delivered  5   window 1   status breach   <- the tick-4 boundary is already lost
tick 4  delivered 10   window 1                   <- 10 of 20: breached, unavoidably
tick 5  delivered  5   window 5   status accruing <- from here on it is winnable
```

Harmless **today** — nothing is charged, so a first-window breach is a status flag and no more. It is
**not** harmless the moment 3b-iii debits the full basic fee on breach: a player who signs mid-window
would pay a penalty they never had a chance to avoid, for a contract they had just agreed to.

**Prerequisite for the fee charge (3b-iii) — one of:** the **mid-window pro-rate** (unpin `windowFraction`, owe only the
share of the window you were present for — §5's join ruling, Option A, whose deferral this tripwire is
already guarding), or a **first-window grace** (the window in which a licence is signed is judged but
never charged). Both are rulings, not build details, so neither is invented here. *(**Answered:** the
pro-rate, built in 3b-ii.)*

## Constants — all `[FIRST-CUT]`, all in `docs/phase-1-tuning.md`

`FEE_RATE` (0.10) · the corner values 100/75/75/0 · the equity shaping exponent `k` (2) · the
commitment floor (0%) · the renegotiation-window bounds (7–42 days). The 49% equity ceiling is a
**design** number, not a dial (§5: the owner keeps control by retaining 51%).

## Out of scope *(as of 3b-i — the fee charge has since landed, below)*

Charging the fee (3b-iii) · ~~**factory/refinery licensing** — the §5 accrual sums `Q` over mines only
(`production.js`), so a factory's commitment would never accrue, never be delivered and never be
judged; licensing one needs the accrual extended first, so it is refused at intake rather than sold as
terms that cannot be honoured~~ *(**DONE — the factory-commitment slice, 28-08-26; see "Factory output
commits" below.** The accrual was extended, so the refusal is gone.)* · renegotiation, Syndicate-initiated term changes, the 75% investor vote
(§5, #57) · reputation (Slice 4) · the investor market and dividends (Slice 5) · removing the
`setSyndicateCommitment` scaffold, which stays for tests, scenarios and the bot.

## Tripwires (`sim/tests/licence-fee.test.js`, 24 tests)

The four corners are exact · an interior point matches the shaped bilinear formula · `discountedFee ≤
basicFee` across a spread of terms · the fee is priced off the baseline, not the rate · mid equity buys
less than linear and the relief accelerates · a grant stores the licence, locks both fees and sets the
commitment · the licence reads the equity offered at establishment · every invalid application is
refused and leaves state byte-identical · a factory, fuel, a second application, an unowned and a
missing venture are each refused · the fees do not move when the market does · signing at a different
price is a different contract · `setWindowN` is refused after signing · licensing switches the sale on
with invariant 2 exact · **across 30 ticks the credit change is the sale on every tick and the sale
MINUS the fee on the one boundary** (this assertion read "equals the sale exactly, every tick" until
3b-iii; the flip is that slice's headline) ·
the unlicensed no-op/determinism proof · the snapshot surface (and that it cannot alias into state) ·
five corrupted-licence tripwire cases · the validators are the ones §5 names · establish-then-license
end to end, landing on §5's zero-fee deep-entanglement corner.

---

# The charge — licence Slice 3b-iii (28-08-26)

The build note for **3b-iii**, the last bullet of `docs/licence-and-price-system.md` Part 4's fee
sequence. The contract is the same `design.md` §5 **"LICENCE FEE MECHANICS — RULED"** note this file
opens with: it ruled every rule and every constant the charge needs, so this slice **authors no new
mechanic and no new `[FIRST-CUT]` number**. It is the socket, not a new circuit.

Everything it moves was computed by a slice that shipped before it:

| what it reads | where it came from |
| --- | --- |
| `basicFee` / `discountedFee` | locked at signing — 3b-i, above |
| the per-venture `met`/`breach` verdict | the pursue-order fill — `docs/licence-distribution.md` |
| `windowFraction` | the mid-window join pro-rate — `docs/mid-window-pro-rate.md` |
| the anchored boundary | the day anchor — `docs/cycle-and-calendar.md` §2 |

## The one line

At each anchored window boundary, every licensed venture owes
`round((met ? discountedFee : basicFee) × windowFraction)` — its verdict read from the fill that just
computed it — and a guild's oweds across **all** its systems and goods sum into one lump debited from
`guild.credits` and credited to `state.syndicate.ledger`.

## Two layers, and the trap between them

- **Layer 1 — the verdict and the owed amount are per `(system, good)`, per VENTURE.** A venture's
  met/breach is decided inside its own `(system, good)` window, because the Syndicate pile it is judged
  against belongs to a system and cannot be shared across them. The arithmetic is one small pure
  function, `feeOwed(licence, status, fraction)` (`sim/licence.js`), so it is unit-testable off a
  server. **Breach voids the discount and it is binary:** a venture one unit short of its target pays
  the full basic fee, exactly as one that delivered nothing does.
- **Layer 2 — the CHARGE is guild-level and system/good-agnostic.** A guild has exactly one credit
  pool, and every window in the galaxy closes on the same global boundary, so the oweds all fall due
  together and move once: one debit, one ledger transfer, one receipt.
- **The trap:** the total is **DERIVED from the individual licensed ventures**. Each venture computes
  what *it* owes from *its own* verdict and rounds there (§5's `round(…)` is per venture); the guild
  total is the sum of those whole numbers. There is no `(system, good)` fee *pot* to split among
  ventures — building one and dividing it would round a pooled total and hand ventures shares of a
  number nobody owed.

## The mechanism, and why this one

`applyProduction` (`sim/tick.js`) is called once per `(guild, system)` and already holds that system's
boundary verdicts, so it computes the per-venture oweds there and **returns** the accrual;
`stepProduction` sums a guild's systems and applies the single debit after its inner loop. Because
guild credits are one pool, debiting per venture and debiting one summed lump land on the same number —
so Layer 2 is as much about the record and the conceptual model as the arithmetic, and the ruled model
is what is built.

The tempting alternative — re-deriving the verdicts in a separate post-production pass — is worse and
was rejected: `status` is **derived telemetry that reaches no stored byte** (§5), so a second pass would
have to reconstruct the pursue fill from the stored `delivered`, against a window that is on the cusp of
rolling. Read the verdict where it is computed, on the one tick it is true for.

**One departure from the obvious loop, and it is load-bearing.** The charge iterates the guild's stored
**licences** and looks the verdict *up*, rather than iterating the report's `perVenture` rows. §5's **0%
commitment floor** is why: a venture that committed nothing has no `Q`, so its good may carry no window
block and appear in no `perVenture` row at all — yet it is licensed, it is `met` (it owed zero units and
delivered zero), and it **pays**, which at the `c = 0` / no-equity corner is 100% of the basic fee.
Looping over rows would give every 0% licence a silent free ride. An absent row therefore means "owed no
units this window" ⇒ `met`, which is the same verdict the fill itself would produce (`0 ≥ 0`).

**And that reading is guarded, not assumed.** `resolveProduction` routes every good whose aggregate `Q`
is positive and emits a target row for every venture with a positive contribution to it — so a
**committed** licence *always* has a real boundary verdict, and an absent row for one that owed units is
a broken state, not a free window. Charging it as `met` would apply the **discount** to a contract that
was never judged: an undercharge that moves a real balance and shows up in no assertion anywhere — the
quietest failure this slice could have. So the charge **halts** instead, naming the tick and the owed
quantity (§15.5: a silent violation is worse than a crash). The predicate is `committedContribution`,
the **same** function the resolver builds its targets from, so the guard cannot disagree with the thing
it guards about which ventures were owed a row.

## The edge cases, and how each is handled

| case | behaviour |
| --- | --- |
| a commitment with **no** stored `licence` (the `setSyndicateCommitment` dev scaffold) | **skipped** — no locked fee to charge. This is what keeps the scaffold's goldens byte-identical. |
| a **licensed, committed** venture with no boundary verdict | **halts.** Absent rows are legal only where zero units were owed; anything else is a committed licence about to be charged the discount unjudged |
| **breach** | the **full** `basicFee`, even at 99% delivered — binary, no partial credit |
| **`accruing`** | never charged. Charging happens only at a boundary, where every verdict is met or breach; `feeOwed` **throws** on any other status rather than silently returning 0 |
| the **0% floor** | licensed, always `met`, pays its `discountedFee` — a real charge (100% of basic at no equity, 75% at max equity) |
| a **mid-window** licence | `round(fee × windowFraction)` at its first boundary, the whole fee at every one after — the SAME `curWindowStart`/`N` the verdict used |
| a guild licensed across **several systems** | all its ventures' oweds sum into the one guild lump |
| the debit exceeding the guild's balance | **credits go negative — intended.** See the invariant change below |
| the per-tick **sale** (3a) | untouched. It runs every tick, boundary included; two independent internal transfers, neither folded into the other |

## The record — so the verdict survives the roll

```js
guild.lastLicenceFee = {
  tick,        // the PRODUCING tick — the boundary (recordSale's convention)
  charged,     // the guild-wide lump actually debited
  ventures: { [ventureId]: { status, owed, basicFee, discountedFee } },
};
```

Written **lazily**, only at a boundary where the guild really holds a licensed venture — so an
unlicensed guild, and every non-boundary tick, carries no key and stays byte-identical (the same
discipline as `guild.syndicateWindows` and `guild.lastSyndicateSale`). It **replaces**, never
accumulates.

It exists for the same reason `recordSale` does (invariant 5): the verdict is **momentary**. The instant
the boundary tick ends the window rolls, the delivered pile resets, and the met/breach that priced the
fee is gone from everywhere else — so this is not a second copy of a derivable fact, it is the only copy
there will ever be. Surfaced additively as the snapshot's per-guild **`licenceFee`**
(`{ tick, thisTick, charged, ventures }`, schema stays **7**), so a later client slice can show the
charge without recomputing a thing (§5's display rule).

## The invariant change — a doc contradiction reconciled

§5 already ruled that **"a breach fee may drive a guild's credits negative — guild credits join the
Syndicate ledger as exempt from the non-negativity invariant (invariant 2 stays exact: guild −X,
ledger +X)"**. The code and invariant 3's own text had not caught up, and by the time this slice opened
they contradicted §5 outright. Both are fixed in this commit:

- **`sim/invariants.js`** — `guild.credits` is now checked with `{ nonNegative: false }`, exactly as
  `state.syndicate.ledger` already was. The **integer** check is untouched: a fractional credit is still
  a bug, and a test pins that the carve-out freed the *sign* and not the *type*.
- **`design.md` §15.5, invariant 3** — carves guild credits out beside the ledger and says **why**: the
  fee is charged in full whether or not the guild can pay, because refusing it (or flooring it at zero)
  would let a guild escape the cost of a contract it broke by being poor — the opposite of what the fee
  is for. A guild in debt is a deferred **pressure state** (§5), not a broken ledger.

Invariant 2 is untouched and still exact through the debt: one integer, both legs, so nothing about the
movement goes unchecked.

## Proof — the "charges nothing" assertions flip, and the goldens do not

Three slices each shipped a *"the only credit movement is the sale"* proof. Those are now **false at the
boundary tick**, and the flip is the headline evidence. Every one was **updated, not deleted**:

- `licence-fee.test.js` — across 30 ticks the credit change is the sale on every ordinary tick and the
  sale **minus** the fee on the one boundary, with the fee asserted **> 0** there and **0** everywhere
  else. Renamed to say so.
- `mid-window-prorate.test.js` — the same walk, plus a new test that the first, partial window is
  charged `round(fee × ½)` and every window after it the whole fee.
- `multi-venture-commitment.test.js` (F-A) — the per-tick sale figure is now checked with the boundary
  fee added back, so the sale's own attribution stays pinned and the two movements stay separable.
- `licence-distribution.test.js` and `commitment-scaffold.test.js` still assert *no charge* — and now do
  so as the **licence-less skip**: every venture in them is scaffold-committed, so it is judged and
  charged nothing. Renamed to say what they now prove.

**The committed goldens are byte-identical, and that is a result, not an omission.** Neither pinned
golden run holds a `venture.licence` — the committed one (`commitment-scaffold.test.js`) is
dev-scaffold shape and `persist.test.js`'s is unlicensed — so nothing in either is charged and the
boundary-only debit plus the lazy record leave both untouched:

```
GOLDEN_UNLICENSED             682e42e0…   unchanged
GOLDEN_UNLICENSED_WITH_PRICES ee6856cc…   unchanged
GOLDEN_UNLICENSED_WITH_HISTORY fa63aaf4…  unchanged
GOLDEN_COMMITTED_WITH_PRICES  e0255c73…   unchanged
GOLDEN_COMMITTED_WITH_HISTORY e145b142…   unchanged
persist GOLDEN_HASH*          564010…/53c4f4…/170bed…   unchanged
```

So a **strip-and-prove** was written for a run that *is* licensed, which is the stronger statement a
re-pinned number could not make. The same fixture is run twice over three windows — once with the
licence stored (charged) and once with the `licence` object deleted after signing, which is exactly the
pre-3b-iii engine's behaviour for that run, since every other stored field is untouched:

```
charged                          1b62d5ef…    credits 614   ledger −614
uncharged (pre-charge behaviour) 6e8ce686…    credits 659   ledger −659
expectedLump = discountedFee 15 × 3 boundaries = 45         614 = 659 − 45 ✓
charged, with lastLicenceFee + licence stripped and the 45 put back:
                                 6e8ce686…    == uncharged, byte for byte ✓
```

If this slice moved one other byte — a good, a pool, a window accumulator, a carry, a history sample,
the sale record — that last line goes red.

## Determinism (invariant 9)

The debit order is fixed: guilds in array order, systems in the sorted order `stepProduction` already
uses, ventures in establishment order. The charge reads no clock and the lump is a sum, so order does
not reach the number anyway. The twice-run check is green.

## Out of scope — deferred, not invented

Renegotiation and the `windowDays` deadline (#64) — the charge reads the **locked** fees and re-prices
nothing · reputation, breach marks, forced closure, investor dividends (§5 / #61 / Slice 5) — a breach
charges the full fee **and nothing else** · any change to the sale (3a), the verdict computation
(`pursueFill`), the pro-rate (`windowFraction`) or `Q` — this slice READS their outputs · a fee-preview
endpoint · an atomic `establishAndLicence`. *(**The client copy caught up in the next commit on this
branch** — `console.html`'s Syndicate footer and `game.html`'s licence receipt now say the fee is
charged at each cycle boundary, discounted on met and full on breach, and the footer reports the guild's
last charge off the snapshot's `licenceFee` record. Client-only; the roadmap entry has the detail.)*. Flagged here rather
than fixed, because a client slice is a client slice.

## Tripwires (`sim/tests/licence-fee-charge.test.js`, 16 tests)

met pays the discount at the boundary · breach pays the **full** basic fee · **one unit short of
twenty** breaches and pays full, with no partial credit · a **0%-commitment** licence is met every
window and pays its (undiscounted) fee, three boundaries running · a scaffold-committed venture beside a
licensed one is **not on the bill** · a **committed** licence with no boundary verdict **halts** rather
than reading `met`, naming the owed quantity and the tick — and halts only at the boundary (asserted red
with the guard removed) · a guild licensed in **two systems** is debited **one lump equal to
the sum** of its ventures' oweds, one met and one breached so the sum is the only arithmetic that
produces it · the fee drives credits **negative** with invariant 3 green and invariant 2 exact · the
counterfactual: a **fractional** credit balance still trips the integer rule, naming the field ·
the boundary tick runs **both** the sale and the fee, conserving on every tick · the record exists only
at a charging boundary, survives the window roll, and is **replaced** at the next one · an unlicensed
guild never grows the key · the snapshot surface, `thisTick` included · `feeOwed` is §5's formula and
**throws** on a non-verdict status · determinism · **strip-and-prove**. Plus the pro-rated first-window
charge in `mid-window-prorate.test.js`, where the pro-rate's fixtures live.

**535 tests (+17), zero failures.**


---

# Factory output commits — the accrual goes producer-general (28-08-26)

**Design:** `design.md` §5 "LICENCE FEE MECHANICS — RULED", the factory-commitment note.
**Code:** `sim/production.js`, `sim/baseline.js`, `sim/licence.js`, `sim/actions.js`, `sim/tick.js`.
**Tests:** `sim/tests/factory-commitment.test.js` (14).

## What was actually wrong

Everything downstream of the commitment — the licence, the per-tick sale, the pursue fill, the boundary
fee — was already good-agnostic. One gate upstream of all of it was not: the resolver's target loop
opened `if (!v.resourceType) continue` and keyed every target on `v.resourceType`. So a refinery's
output could carry no commitment, no licence, no Syndicate-tab row and no fee, and `applyForLicence`
refused a factory outright — **for that mechanical reason, never a design one**.

## The three touches

**1 — one identity, four readers.** `producedGoodFor(venture)` (`sim/baseline.js`) is the single answer
to "what does this venture make": a mine's `resourceType`, a factory's recipe **output** good.
`baselineOutputFor` delegates its `good` half to it, so the two can never drift. Four sites read it and
they MUST agree, or a factory's commitment accrues under one key and is paid out or judged under
another: the resolver's `Q`, `ownerFraction`'s equity split (`sim/licence.js` — it matched on
`resourceType` too, and a committed factory would have matched nothing, summed weight 0, and silently
handed the owner 100% of a sale its equity terms had already sold a share of), the licence intake
(`sim/actions.js`) and the boundary charge's verdict lookup (`sim/tick.js`).

**2 — the seam with teeth: a refined good's fresh IS its `minted`.** The Syndicate fork is FRESH-ONLY
(§5) and for a refined good the mines' `fresh` is 0 — its real fresh is the sum of its factories'
`minted`, which does not exist until AFTER the routing pass, because a line's rate is
`min(throttleCap, inputCap)`. So the fork's fresh cap (and the good's `pot`, since minted lands in the
pool at apply *before* the fork's delivery is subtracted) is completed in the **finalize pass**, from a
`mintedByGood` aggregate built in the refinery loop. A good is mined XOR refined, so one of the two is
always 0 and every mined good is byte-identical; if that ever stops being true the resolver **halts**
rather than assemble one cap from two sources.

**3 — intake opens.** `applyForLicence` prices the fee from `baselineOutputFor(venture)` — batches/tick
× the recipe's output qty — against the **output good's** posted price (the price engine publishes one
for every processed good), and sets `syndicateCommitment = commitmentUnitsFor(pct, units, N)`. The
four-corner grid, the lock-at-signing and the stored `venture.licence` are untouched. The
`setSyndicateCommitment` dev scaffold drops its "no `resourceType`" rejection and keeps the fail-loud
for a venture that produces nothing identifiable (a dangling recipeId). **No number was authored**:
`baselineOutputFor` already held the factory baseline.

`applyProduction` needed **no change** to deliver, sell or charge: it already mints into the pool, then
subtracts each good's `fork.syndicate` generically, and the sale and the fee read the report. Only the
verdict *lookup* key moved off `v.resourceType`.

## The cascade is the ruling

The fresh cap now reads the factory's REAL output, so starvation propagates on its own: commit the
titanium, and the alloy factory that needed it runs slower → mints less → the cap drops → the window
under-delivers → **breach → the FULL fee**. There is **no double-commit prevention, no input
reservation and no starvation forgiveness** (§5, RULED 28-08-26). Nothing codes the cascade; it is what
an honest cap does. The test pins it with the fed counterfactual beside it — same fixture, same
licence, only the titanium licence differs — so it cannot pass for another reason.

## Deferred, flagged, not guessed

**`percent`-of-fresh send mode on a REFINED good.** The percent control is resolved in the routing
pass, where a refined good's fresh is still 0; threading `minted` there would mean resolving one good's
window in two different places depending on how it is produced. So the paced (default) and absolute
paths are exact for a factory, and `percent` on a refined good intends 0 every tick and will breach.
Pinned by a test that says so in as many words, and on `docs/roadmap.md`'s decision checklist.

## Tripwires (`sim/tests/factory-commitment.test.js`, 14 tests)

A committed factory contributes `Q` under the good it PRODUCES, not its inputs, with a real per-licence
row · an **uncommitted** factory triggers none of the new paths (no window state, no routing, no
credits — the mechanism keeping every golden byte-identical) · the fork's fresh cap **is** the minted
total, and a starved tick delivers only what was made · a good mined **and** minted halts · **the
headline**: a licensed factory sells its output every tick (invariant 2 exact each tick) and **meets**
at the boundary for the discounted fee · an under-sending licence **breaches** for the full fee · **the
CASCADE**, with its counterfactual · two factories on one good fill in pursue order for per-venture
met/breach · the equity split reads a factory (the `ownerFraction` regression) · the snapshot carries
the roster row with no reshaping and no schema bump · the dev scaffold commits a factory and charges
nothing · the **deferred** percent-mode gap, pinned · determinism over three windows, sorted-good order.

**558 tests (+16 net), zero failures.**

---

# The fee becomes visible before signing — `feeQuote` *(31-08-26, engine-only)*

Everything above prices a licence **at signing**. Nothing published the figure **before** it,
so the Establish-Venture panel could speak only in **% of basic**: the credit number is
`FEE_RATE × the good's droidless baseline × windowN × the posted price`, and the client holds
none of those pieces — by design, which is why the hardcoded `P.BASIC_FEE` mock was deleted
rather than corrected.

The snapshot now carries **`feeQuote`**: `{ good → basicFee }` in integer credits, over the
priced goods, at the **posted** price and the window in force. Three things make it safe:

1. **It is `licenceFee`'s own output, not a second copy of the formula.** `sim/snapshot.js`
   calls the function this document specifies, over `baselineUnitsForGood` (the per-good
   inverse of `baselineOutputFor`, which delegates to it rather than re-reading the tables).
   The tripwire is an equality, not a recomputation: `feeQuote[G]` **equals** the `basicFee`
   `applyForLicence` locks for a venture producing `G` at the same tick and price — pinned for
   a mine and for a factory, so if this fee's math ever changes the quote fails unless it
   follows.
2. **Basic only.** The four-corner relief is a function of the player's live slider values; a
   snapshot that guessed them would publish a fee nobody agreed to. The client applies the
   relief to the published basic — it already draws that curve.
3. **Live, not locked.** A signed licence keeps its fee whatever the market does (that is the
   whole point of locking it); `feeQuote` is the cost of the *next* signature and moves with
   the posted price. Both behaviours are pinned in one test, since blurring them is exactly
   what a panel showing both would do wrong.

A good with no producible baseline, or no price row, is **omitted** — never quoted at zero,
which would read as a free licence. Additive; **schema stays 7**; no golden moved (derived
telemetry, no serialized byte). **657 tests (+11), zero failures.**
