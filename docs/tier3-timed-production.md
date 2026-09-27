# Tier-3 Timed Production — the specialist manufacturing model

*RULED 27-09-26. Design record; the build is a later Claude Code slice. This is the
companion the 27-09-26 pricing ruling (design.md §5 / `phase-1-tuning.md` "Tier-3
sub-tiers & specialist parts") named as "deferred to the next design pass" — now
designed. Until it ships, specialist prices are **ruled but NOT safe to run in a live
economy** (the refining pump is unthrottled per tick without it).*

## Why this exists

Specialist parts base high (1M–20M) so the intentional refining pump rewards complex
production. But at ordinary production speed (batches/tick) a factory could refine a
specialist every tick, turning a fair +20M-per-unit reward into a +20M-per-tick printer,
and — separately — the price would go degenerate (see "the price fix" below). The cure
for both is the same: **make specialist production slow and discrete.** Slow production
throttles the pump at its source and lets specialist prices trend upward smoothly instead
of snapping to the ceiling.

## The model — a hybrid of Tier 1/2 and Tier 4

- **Continuous single-good build (like T1/2):** a factory keeps making one good on a loop;
  there is no per-build commission to place (unlike the T4 dockyard).
- **Discrete timed output (like T4):** it completes **one whole unit per `TICKS_PER_UNIT`**,
  a per-venture timer that is the Tier-4 dockyard countdown *without* the commission wrapper.
  Reuses the existing remainder mechanism (`batchCarry`) — progress is a hidden per-venture
  accumulator; **no fractional units are ever stored.** A whole unit mints at completion,
  then the loop restarts.

So: T1/2's constant single-good loop, paced by T4's timer, emitting whole units.

## Income — progress-based per-tick committed payment

Each tick, the **committed share of the progress actually made that tick** is valued at the
current market price and paid to the guild. Smooth when on-pace; less when production lags;
**nothing to claw back**, because payment tracks real work, not a promise.

This **deviates deliberately from T1/2**, which pays on units *delivered* (`gross =
delivered × price`, `sim/licence.js`). Paying a flat committed *rate* regardless of output
would overpay a lagging factory and open a teardown-and-walk exploit; paying on committed
*progress* closes it. This is its own model, not a reuse of the T1/2 sale.

**No double-count:** committed progress *is* the payment. A completed committed unit goes to
the Syndicate **already paid** (bought in installments as it was built). Only **uncommitted**
progress mints whole units into the guild's own stockpile (unpaid until the guild sells them).

## Settlement — weekly, on whole units

A Tier-3 contract settles per **production cycle = 10,080 ticks** (one week = 7 × the 1,440
daily window), via a **per-contract `windowN`**. Because 10,080 = 7 × 1,440, the weekly
boundary always coincides with a daily one, so the two clocks **nest** and never resolve on
conflicting ticks. At the boundary: a **delivered-or-not verdict on whole committed units**
(the existing boundary-verdict machinery); under-delivery → breach → full fee.

## Delivery — Syndicate first (fixed)

Committed units go to the Syndicate **first**; the guild's own units are whatever completes
**beyond** the commitment. No staggering, no player choice. Narratively this is the
Syndicate's risk premium for outsourcing advanced production. Mechanically it makes
commitment a real sacrifice: a guild that commits specialist output waits out the whole
commitment before it sees its *own* units (e.g. to build a heavy transport). **Breach bites
harder on specialists by design** — a bad window leaves the guild with nothing *and*
breached — so guilds commit conservatively. This is intended, not a rough edge.

## Renegotiation — fixed re-offer

At contract end the Syndicate **re-offers identical terms** — same committed unit count, same
10,080-tick window — with the **signing price refreshed to current market**; **no
standing-driven ratchet** up or down (unlike T1/2's `renegotiationTerms`), equity untouched.
The guild accepts (renew) or rejects (lapse to unlicensed), exactly the T1/2 accept/reject
shape, with a fixed offer instead of a computed one.

## Teardown

Forfeit partial progress + consumed ingredients, **pay the remaining contract fee**, forfeit
RP. Mostly existing `decommissionVenture` behaviour (it already forfeits RP and pays the
remaining fee). With progress-based payment there is no overpayment to escape with either, so
tearing down benefits no one.

## The price fix — per-cycle capacity (LOAD-BEARING; do not skip)

The price level is `level = stock ÷ capacity`, capacity in **units per tick**
(`sim/prices.js`, `productionCapacity` / `baselineOutputFor`). A timed good's per-tick rate
is `1 ÷ TICKS_PER_UNIT` — for a once-a-week good, ≈ 0.0000992, a millionth-scale number.
Dividing by it multiplies the level by ~10,080, so **any hoard above zero pins the price at
the ceiling** — a degenerate binary signal (base when nobody holds one, ceiling the instant
anyone does), the opposite of the smooth upward trend this model is for.

**Fix:** a timed good reports its capacity **per production cycle — whole units per week
(≈ one per factory) — NOT per tick.** Then `level` reads as "**cycles of output hoarded**":
holding 1 engine → level ≈ 1 (gentle nudge), 20 → level 20 (price doubles), ~380 → ceiling.
A real gradient, with the **unchanged 0.05 sensitivity and one formula**. Rarity is preserved
(more factories → higher per-cycle capacity → the same hoard gives a lower level), and
throttle-gaming is still impossible (capacity reads the fixed baseline, which for a timed good
is the fixed one-per-cycle). The change lives in `baselineOutputFor` / the capacity sum only.

## Invariants to enforce (mechanical tripwires)

1. **A timed good is NEVER also produced continuously.** The production model is a property of
   the *good*, so every producer of a good is on the same clock. If one weren't, the capacity
   sum would mix per-tick and per-cycle timescales and silently mis-level the price. Fail loud.
2. **No fractional units in any stockpile.** Progress is a hidden per-venture accumulator only;
   stockpiles hold whole units.
3. **Committed progress is paid exactly once** — no double-count between the per-tick payment
   and the completed-unit delivery.

## Open — for the human (not decided here)

- **SCOPE — which goods are timed.** Specialist parts **must** be (they are why this exists).
  Ordinary **3-3** modules are a live candidate too — their refining pump is ~+72M/day per
  factory, non-trivial — so there is a real case for timing 3-3 as well. **3-1 / 3-2 stay
  continuous** regardless (small pumps, and bulk parts cannot be made slow). **A DECISION IS
  REQUIRED before the build.**
- **`TICKS_PER_UNIT` per timed good** — the numbers, paired with the base price (a 20M part
  slow, a 1M part faster). Deferred to `phase-1-tuning.md`.
- **Input model** — continuous draw (T2-style, the remainder default; disruption handled for
  free) vs upfront batch-gating (T4-feel, more state). Lean: continuous. Confirm at build.

## Sequencing

The 27-09-26 specialist prices depend on this model; do not run the specialist bands in a live
economy until the timer ships. New serialized state (the per-venture progress counter,
per-contract `windowN`) is a schema touch → fresh galaxy + omit-when-default discipline.
