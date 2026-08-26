# The licence entity + the fee math — what was built (licence Slice 3b-i, 27-08-26)

The build note for **3b-i** of `docs/licence-and-price-system.md` Part 4. The contract is `design.md`
§5's **"LICENCE FEE MECHANICS — RULED"** note and the four-corner grid it discounts with. This slice
computes and **locks** the fee; **3b-ii charges it**. Companion notes: `docs/commitment-sale.md` (3a,
the sale), `docs/price-engine.md` (the posted price the fee locks against).

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

**Nothing is charged.** No debit, no breach penalty, no credit movement of any kind beyond 3a's
commitment sale — which this slice is what *switches on*, because the licence is now what sets
`syndicateCommitment`.

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
so `sim/windows.js`'s pro-rate tripwire stays green — see the flag below.

## ⚠️ Flag for 3b-ii: a mid-window licence breaches its first window

Because `windowFraction` is pinned at 1, a venture licensed **partway through** a window owes the
**whole** window's `Q` but has only the remaining ticks to deliver it. Observed, with `N = 4`, a
rate-5 mine licensed at tick 2 at 100% commitment (`Q` = 20):

```
tick 3  delivered  5   window 1   status breach   <- the tick-4 boundary is already lost
tick 4  delivered 10   window 1                   <- 10 of 20: breached, unavoidably
tick 5  delivered  5   window 5   status accruing <- from here on it is winnable
```

Harmless **today** — nothing is charged, so a first-window breach is a status flag and no more. It is
**not** harmless the moment 3b-ii debits the full basic fee on breach: a player who signs mid-window
would pay a penalty they never had a chance to avoid, for a contract they had just agreed to.

**Prerequisite for 3b-ii — one of:** the **mid-window pro-rate** (unpin `windowFraction`, owe only the
share of the window you were present for — §5's join ruling, Option A, whose deferral this tripwire is
already guarding), or a **first-window grace** (the window in which a licence is signed is judged but
never charged). Both are rulings, not build details, so neither is invented here.

## Constants — all `[FIRST-CUT]`, all in `docs/phase-1-tuning.md`

`FEE_RATE` (0.10) · the corner values 100/75/75/0 · the equity shaping exponent `k` (2) · the
commitment floor (0%) · the renegotiation-window bounds (7–42 days). The 49% equity ceiling is a
**design** number, not a dial (§5: the owner keeps control by retaining 51%).

## Out of scope

Charging the fee (3b-ii) · **factory/refinery licensing** — the §5 accrual sums `Q` over mines only
(`production.js`), so a factory's commitment would never accrue, never be delivered and never be
judged; licensing one needs the accrual extended first, so it is refused at intake rather than sold as
terms that cannot be honoured · renegotiation, Syndicate-initiated term changes, the 75% investor vote
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
with invariant 2 exact · **across 30 ticks the credit change equals the sale exactly, every tick** ·
the unlicensed no-op/determinism proof · the snapshot surface (and that it cannot alias into state) ·
five corrupted-licence tripwire cases · the validators are the ones §5 names · establish-then-license
end to end, landing on §5's zero-fee deep-entanglement corner.
