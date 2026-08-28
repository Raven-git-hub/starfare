# Commitment-as-sale — what was built (licence Slice 3a, 26-08-26)

The build note for **Slice 3a** of `docs/licence-and-price-system.md` Part 4: the credit leg of the
Syndicate fork delivery. Part 2's *"Commitment is a SALE, not a tithe"* bullet and `design.md` §5's
**Output commitment** bullet are the contract; this records what the code does and which calls the
contract left to the build.

## What it does

A committed venture's goods already left the guild's pool for the Syndicate every tick (§5 fork
delivery, 10-08-26). They were taken for **nothing**. Now they are **bought**:

```
gross        = delivered units × posted price
ownerCredits = round( ownerFraction × gross )      // ONE rounding, at the end
guild.credits    += ownerCredits
syndicate.ledger -= ownerCredits                   // the same integer, the other way
```

`ownerFraction` is `(1 − o)` — the owner's keep after the equity it offered. The `o` share is **not
paid to anyone**: no investor exists yet, so §5's *"or, with none, to the Syndicate ledger"* applies and
that share simply never leaves the ledger. Offering equity is therefore a real cost from the first
tick, exactly as §5 requires, without an investor market existing.

**Nothing is charged.** No fee, no breach penalty, no reputation — Slices 3b and 4. A breach today
still costs nothing; note that a breaching guild is *still paid for what it did deliver*, because a
sale is a sale (the tripwire for that lives in `commitment-scaffold.test.js`).

## The two calls the contract left to the build

**1. "Market rate" is the POSTED price** (`state.prices[good].posted`) — the two-ticks-lagged value
already sitting on state when delivery happens at step 1. This is what the publish lag was *for*: the
rate a sale executes at was fixed two ticks before the sale, so it can never be computed from the
delivery it is pricing. The by-hand run shows it plainly — each tick's sale price is the previous
tick's posted value.

**2. The cadence is PER TICK.** §5 says the commitment is auto-sold "each cycle"; Part 2 says "per
tick", and Part 2's own header lists the per-tick sale as *proposed, pending reconciliation at the
licence slice*. **This is that slice, and per tick wins** — because the delivery it pays for is already
per tick (the windowed accrual sends toward `Q` every tick, `sendCarry` and all). Paying per cycle for
goods taken per tick would mean the engine owed the guild money between cycles, which is a debt entity
nothing has designed. Recorded here and in §5 in the same commit, not drifted. *(The **fee** cadence is
untouched by this: it stays the 24h cycle, with breach judged at the boundary — Slice 3b.)*

**A third, smaller one: the split is commitment-weighted.** Delivery is per **good** (the accrual
targets the per-good aggregate `Q` = Σ `Venture.syndicateCommitment`), while equity is per **venture**.
So a good's proceeds split by the same per-venture commitments that built its `Q`. With one venture —
or several sharing an offer — this reduces to plain `(1 − o)`. The weight is the raw commitment, which
equals its `Q` contribution only while `windowFraction` is pinned to 1; that pin already has its own
tripwire, and if a mid-window join is ever wired without the pro-rate, this weight needs the same
fraction.

## Rounding, and why invariant 2 holds to the credit

`Math.round`, **once**, at the end — and the single integer it produces is used for **both** legs.
The guild's gain and the ledger's debit are therefore the same number by construction: there is no
second rounding anywhere for a half-credit to escape through (#43: *`round(qty × price)`, identical
both sides*). The `o` share is never rounded because it never moves — it is just the part of `gross`
that stays in the ledger, so it can carry a fraction without any balance doing so.

## State added

- **`Venture.equityPct`** — the offered equity share `o`, a fraction in `[0, 0.49]` (§5's structural
  ceiling: the owner keeps control by retaining 51%). Set at establishment. **Omitted from the venture
  when 0**, the same discipline `Guild.syndicateWindows` uses, so an unlicensed galaxy's serialized
  state is byte-identical to pre-Slice-3a and the determinism-hash no-op proof still means something.
  It is the venture-level placeholder for §15.4's reserved `Licence.equityOfferedPct`, exactly as
  `syndicateCommitment` is for `committedOutputPct`.
- **`Guild.lastSyndicateSale`** = `{ tick, credited, goods: { good: { units, price, credited } } }` —
  what the Syndicate last bought. A record of an **event**, not a second copy of a derivable fact: once
  the tick is over, neither the price nor the pile it sold from can be recovered from state. Written
  lazily by a real sale only, and stamped with the producing tick so a reader compares it against
  `state.tick` with no off-by-one.

**Refused, not clamped.** An `equityPct` above the ceiling is rejected at intake. A silently-clamped
0.8 would be the engine rewriting the terms the player agreed to, and a licence whose terms are not
what you set is worse than a rejection. A venture built directly (a scenario, an inline founding
venture) bypasses intake, so the tick asserts the range too.

**A missing price halts loudly.** Committed goods with no posted price are not a free delivery, they
are a broken state — taking the goods anyway would be a silent loss (§15.5).

## Reserved, and deliberately not stubbed

Slice 3b needs `licenceId` (→ §15.4's `Licence` entity: fee terms locked at issuance, breach state,
renegotiation window) and Slice 5 needs `shareholders` (the cap-table Part 2 asks to reserve). Those
are **documented in `createVenture`, not written as empty fields** — an empty object on every venture
is not a socket, it is bytes in every save and in the determinism hash for a field nothing reads, and
it would break the byte-identical no-op proof this same slice is required to keep. The
omit-when-default discipline is what makes adding them additive when they have a consumer.

## Out of scope

The fee and the 24h breach check (3b) · the full licence entity and the four-corner grid (3b) ·
reputation (4) · the investor market and real dividends (5) · setting the commitment itself (still the
`setSyndicateCommitment` dev scaffold) · a runtime equity **setter** (§5 makes altering terms a
*renegotiation*, gated by the window and, with investors, a 75% majority — inventing a free setter now
would pre-empt that ruling; equity is set at establishment only).

## Tripwires (`sim/tests/commitment-sale.test.js`, 19 tests)

The sale pays and conservation holds to the credit · the record is stamped with its tick · `o = 0`
keeps all · `o = 0.4` keeps 60% and the ledger keeps the rest · no bystander guild is paid · the
commitment-weighted split across two different offers · an unlicensed venture moves nothing · the
commitment-free boot is hash-identical · the sale uses the **posted** price (pinned) and the price it
paid was fixed two ticks earlier · a missing price throws · determinism over an equity-split run ·
integer credits through 30 ticks of fractional equity · the ceiling is refused not clamped · the
establish action carries and validates the offer · out-of-range equity and a tampered sale record both
trip the tripwire · the snapshot surface.


---

## The sale is producer-general too (28-08-26, factory-commitment slice)

`ownerFraction` weighted the split over ventures matching `v.resourceType === good`. That was right
only while commitment was mines-only: once a **factory** could commit, a committed factory matched
nothing, the weight summed to 0 and the fallback handed the owner **100%** of a sale whose equity terms
had already sold a share of it — invariant 2 still exact, only the line between the owner's keep and
the ledger's `o` share silently in the wrong place. The predicate is now `producedGoodFor`
(`sim/baseline.js`), the SAME identity the resolver keys `Q` on, so the split can never be weighted
over a different set of ventures than the target it is paying for. Everything else about the sale —
per-tick cadence, the posted price, the single rounding used for both legs — is untouched: a refined
good's delivery flows through `applyProduction`'s existing generic loop with no change at all. Pinned
by "the equity split reads a FACTORY too" in `sim/tests/factory-commitment.test.js`; see
`docs/licence-fee.md` §"Factory output commits" for the slice.
